import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/*
 * `bootstrap/analysis.ts` wires the dialer analysis worker. Pins: nothing is wired unless dialer analysis is
 * enabled AND a transcriber AND the analysis service can be built; when wired the
 * worker is woken once, the seam hooks are registered, and stop() shuts the worker down
 * and puts the seam back to its no-op; the retention timer exists only with a window
 * (and the parsed default config has one: transcripts at 30 days).
 */
vi.mock('@magick-agency/observability', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
  createChildLogger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const mocks = vi.hoisted(() => ({
  worker: { wake: vi.fn(), gracefulShutdown: vi.fn().mockResolvedValue(undefined) },
  initWorker: vi.fn(),
  setHandle: vi.fn(),
  createTranscriber: vi.fn(),
  createAnalysisService: vi.fn(),
  runPurge: vi.fn().mockResolvedValue({}),
}));
vi.mock('../../../src/core/dialer-analysis-worker.js', () => ({ initDialerAnalysisWorker: mocks.initWorker }));
vi.mock('../../../src/core/dialer-analysis-worker-handle.js', () => ({ setDialerAnalysisWorker: mocks.setHandle }));
vi.mock('../../../src/transcription/index.js', () => ({ createTranscriber: mocks.createTranscriber }));
vi.mock('../../../src/analysis/index.js', () => ({ createAnalysisService: mocks.createAnalysisService }));
vi.mock('../../../src/maintenance/retention-purge.js', () => ({ runRetentionPurge: mocks.runPurge }));

import { BOOT_PURGE_DELAY_MS, startAnalysis } from '../../../src/bootstrap/analysis.js';
import { getBridgeAnalysisHooks, resetBridgeAnalysisHooks } from '../../../src/seams/bridge-analysis-hooks.js';
import type { AppContext } from '../../../src/app-context.js';
import { parseConfig } from '../../../src/config/load.js';

function ctx(over: Record<string, unknown> = {}): AppContext {
  return {
    config: {
      dialerAnalysis: { enabled: true, pollIntervalMs: 60000 },
      voicelinkRecording: { allowedHosts: ['voicelink.test'] },
      retention: { purgeIntervalMs: 1000 },
      ...over,
    },
  } as unknown as AppContext;
}

beforeEach(() => {
  vi.clearAllMocks();
  resetBridgeAnalysisHooks();
  mocks.initWorker.mockReturnValue(mocks.worker);
  mocks.createTranscriber.mockReturnValue({ provider: 'gemini' });
  mocks.createAnalysisService.mockReturnValue({});
});
afterEach(() => { vi.useRealTimers(); resetBridgeAnalysisHooks(); });

describe('startAnalysis', () => {
  it('wires nothing when dialer analysis is not configured', async () => {
    const stop = await startAnalysis(ctx({ dialerAnalysis: undefined }));
    expect(mocks.initWorker).not.toHaveBeenCalled();
    await stop();
  });

  it.each([
    ['disabled', { dialerAnalysis: { enabled: false } }, () => {}],
    ['no transcriber', {}, () => mocks.createTranscriber.mockReturnValue(null)],
    ['no analysis service', {}, () => mocks.createAnalysisService.mockReturnValue(null)],
  ])('wires nothing when %s', async (_l, over, arm) => {
    arm();
    const before = getBridgeAnalysisHooks();
    const stop = await startAnalysis(ctx(over));
    expect(mocks.initWorker).not.toHaveBeenCalled();
    expect(getBridgeAnalysisHooks()).toBe(before);
    await stop();
  });

  it('wires the worker with the recording allow-list, wakes it once, registers the seam; stop undoes it', async () => {
    const before = getBridgeAnalysisHooks();
    const stop = await startAnalysis(ctx());
    expect(mocks.initWorker).toHaveBeenCalledWith(expect.objectContaining({
      recordingHosts: ['voicelink.test'],
      config: expect.objectContaining({ enabled: true }),
    }));
    expect(mocks.worker.wake).toHaveBeenCalledOnce();
    expect(getBridgeAnalysisHooks()).not.toBe(before);

    await stop();
    expect(mocks.worker.gracefulShutdown).toHaveBeenCalledOnce();
    expect(mocks.setHandle).toHaveBeenCalledWith(null);
    expect(getBridgeAnalysisHooks()).toBe(before);
  });

  it('schedules no retention purge without a window, and runs it on the interval with one', async () => {
    vi.useFakeTimers();
    const none = await startAnalysis(ctx({ dialerAnalysis: undefined }));
    await vi.advanceTimersByTimeAsync(5000);
    expect(mocks.runPurge).not.toHaveBeenCalled();
    await none();

    const stop = await startAnalysis(ctx({ dialerAnalysis: undefined, retention: { agencyRetentionDays: 400, purgeIntervalMs: 1000 } }));
    await vi.advanceTimersByTimeAsync(2500);
    expect(mocks.runPurge).toHaveBeenCalledTimes(2);
    expect(mocks.runPurge).toHaveBeenCalledWith({ requestedBy: 'scheduler' });
    await stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(mocks.runPurge).toHaveBeenCalledTimes(2);
  });

  // The transcript window defaults to 30 days, so a deploy that sets
  // no retention env still runs the (transcript half of the) purge.
  it('with the DEFAULT parsed config (no retention env) the purge is scheduled: transcripts 30 days, rows kept', async () => {
    vi.useFakeTimers();
    const parsed = parseConfig({ DATABASE_URL: 'postgresql://u:p@localhost:5436/x', REDIS_URL: 'redis://localhost:6383/0' });
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues));
    expect(parsed.config.retention.agencyTranscriptRetentionDays).toBe(30);
    expect(parsed.config.retention.agencyRetentionDays).toBeUndefined();
    const stop = await startAnalysis(ctx({
      dialerAnalysis: undefined,
      retention: { ...parsed.config.retention, purgeIntervalMs: 1000 },
    }));
    await vi.advanceTimersByTimeAsync(1500);
    expect(mocks.runPurge).toHaveBeenCalledWith({ requestedBy: 'scheduler' });
    await stop();
  });

  it('also runs the purge once BOOT_PURGE_DELAY_MS after boot, so a restart shorter than the interval still purges (lead)', async () => {
    vi.useFakeTimers();
    const stop = await startAnalysis(ctx({ dialerAnalysis: undefined, retention: { agencyRetentionDays: 400, purgeIntervalMs: 24 * 60 * 60 * 1000 } }));
    await vi.advanceTimersByTimeAsync(BOOT_PURGE_DELAY_MS - 1);
    expect(mocks.runPurge).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(mocks.runPurge).toHaveBeenCalledTimes(1);
    expect(mocks.runPurge).toHaveBeenCalledWith({ requestedBy: 'scheduler' });
    await stop();
  });

  it('stopping before the boot run cancels it (lead)', async () => {
    vi.useFakeTimers();
    const stop = await startAnalysis(ctx({ dialerAnalysis: undefined, retention: { agencyRetentionDays: 400, purgeIntervalMs: 24 * 60 * 60 * 1000 } }));
    await stop();
    await vi.advanceTimersByTimeAsync(BOOT_PURGE_DELAY_MS * 2);
    expect(mocks.runPurge).not.toHaveBeenCalled();
  });

  it('a purge that rejects (already running) is logged, not unhandled', async () => {
    vi.useFakeTimers();
    mocks.runPurge.mockRejectedValueOnce(new Error('already running'));
    const stop = await startAnalysis(ctx({ dialerAnalysis: undefined, retention: { agencyTranscriptRetentionDays: 30, purgeIntervalMs: 1000 } }));
    await expect(vi.advanceTimersByTimeAsync(1500)).resolves.toBeDefined();
    await stop();
  });
});
