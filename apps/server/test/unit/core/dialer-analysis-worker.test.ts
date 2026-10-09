/**
 * DialerAnalysisWorker unit test.
 *
 * Drives the worker's `sweepOnce` + poll lifecycle against a mocked job repo and
 * runner, asserting ordering + durability:
 *  - each tick runs promote → expire → claim → recover IN ORDER.
 *  - promotion runs before expiry (a lost-wake job is rescued, not expired).
 *  - claim uses SKIP LOCKED (repo) and each claimed job goes through the runner.
 *  - crash recovery via stale heartbeat does NOT consume an attempt (repo does it; we
 *    assert recoverStale is called with the attempts_total ceiling).
 *  - graceful shutdown re-queues in-flight claims (decrement) and stops the poll.
 *  - dormancy after N empty sweeps + re-arm on wake.
 *  - registers itself through the worker handle.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/*
 * There is no settle step: the ordering case ends at `recover`, and the
 * step-failure case asserts `recover` (the last step) still ran.
 */
vi.mock('@magick-agency/observability', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
  createChildLogger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

// ── Job repo ────────────────────────────────────────────────────────────────
const { mockJobRepo } = vi.hoisted(() => ({
  mockJobRepo: {
    promoteRecordingReady: vi.fn().mockResolvedValue(0),
    expireAwaitingRecording: vi.fn().mockResolvedValue([]),
    claimRunnable: vi.fn().mockResolvedValue([]),
    recoverStale: vi.fn().mockResolvedValue([]),
    gracefulRequeue: vi.fn().mockResolvedValue(0),
    queueDepthByStatus: vi.fn().mockResolvedValue([]),
  },
}));
vi.mock('@magick-agency/db/repositories/dialer-analysis-job.repository', () => ({
  dialerAnalysisJobRepository: mockJobRepo,
}));

// ── Runner (stub — assert it's invoked per claimed job) ─────────────────────
const { mockRunnerRun } = vi.hoisted(() => ({ mockRunnerRun: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../src/core/dialer-analysis-runner.js', () => ({
  DialerAnalysisRunner: class {
    transcriberProvider = 'gemini' as const;
    run = mockRunnerRun;
  },
}));

// ── Metrics ─────────────────────────────────────────────────────────────────
const { mockSetQueueDepth } = vi.hoisted(() => ({ mockSetQueueDepth: vi.fn() }));
vi.mock('@magick-agency/observability/metrics/analysis', () => ({
  dialerAnalysisTotal: { inc: vi.fn() },
  dialerAnalysisDurationSeconds: { observe: vi.fn() },
  dialerTranscriptionAudioSeconds: { observe: vi.fn() },
  setDialerAnalysisQueueDepth: mockSetQueueDepth,
}));

// ── Worker handle ───────────────────────────────────────────────────────────
const { mockSetHandle } = vi.hoisted(() => ({ mockSetHandle: vi.fn() }));
vi.mock('../../../src/core/dialer-analysis-worker-handle.js', () => ({
  setDialerAnalysisWorker: mockSetHandle,
}));

import { DialerAnalysisWorker, initDialerAnalysisWorker } from '../../../src/core/dialer-analysis-worker.js';
import type { DialerAnalysisConfig } from '../../../src/core/dialer-analysis-runner.js';
import type { DialerAnalysisJobRecord } from '@magick-agency/db/models/dialer-analysis-job.model';

const CFG: DialerAnalysisConfig = {
  enabled: true, transcriber: 'gemini', geminiModel: 'g', geminiApiKey: 'k',
  transcribeTimeoutMs: 180000, transcribeWindowSeconds: 600, transcribeMaxOutputTokens: 16384, maxRecordingBytes: 1000,
  minTalkTimeSeconds: 10, recordingWaitMinutes: 30, maxAttempts: 3, maxAttemptsTotal: 8,
  concurrency: 2, pollIntervalMs: 1000, settleSeconds: 15,
} as DialerAnalysisConfig;

function makeJob(over: Partial<DialerAnalysisJobRecord> = {}): DialerAnalysisJobRecord {
  return {
    id: 'job-1', call_id: 'call-1', tenant_id: 'ten-1', account_id: 'acc-1',
    profile_id: null, profile_snapshot: null, analysis_language: null,
    status: 'queued', attempts: 1, attempts_total: 1, claim_generation: 3,
    claimed_at: new Date(), heartbeat_at: new Date(), next_attempt_at: null,
    analysis_audio_seconds: 95,
    error_code: null, error_message: null, created_at: new Date(), updated_at: new Date(),
    ...over,
  };
}

function makeWorker(over: Partial<{ transcriber: unknown; analysisService: unknown }> = {}) {
  return new DialerAnalysisWorker({
    transcriber: over.transcriber as never ?? ({ provider: 'gemini' } as never),
    analysisService: over.analysisService as never ?? ({} as never),
    config: CFG,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockJobRepo.promoteRecordingReady.mockResolvedValue(0);
  mockJobRepo.expireAwaitingRecording.mockResolvedValue([]);
  mockJobRepo.claimRunnable.mockResolvedValue([]);
  mockJobRepo.recoverStale.mockResolvedValue([]);
  mockJobRepo.queueDepthByStatus.mockResolvedValue([]);
  mockRunnerRun.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('DialerAnalysisWorker.sweepOnce ordering', () => {
  it('runs promote → expire → claim → recover IN ORDER', async () => {
    const order: string[] = [];
    mockJobRepo.promoteRecordingReady.mockImplementation(async () => { order.push('promote'); return 0; });
    mockJobRepo.expireAwaitingRecording.mockImplementation(async () => { order.push('expire'); return []; });
    mockJobRepo.claimRunnable.mockImplementation(async () => { order.push('claim'); return []; });
    mockJobRepo.recoverStale.mockImplementation(async () => { order.push('recover'); return []; });

    await makeWorker().sweepOnce();

    expect(order).toEqual(['promote', 'expire', 'claim', 'recover']);
  });

  it('promotion runs before expiry (rescues a lost-wake job)', async () => {
    const calls: string[] = [];
    mockJobRepo.promoteRecordingReady.mockImplementation(async () => { calls.push('promote'); return 1; });
    mockJobRepo.expireAwaitingRecording.mockImplementation(async () => { calls.push('expire'); return []; });

    await makeWorker().sweepOnce();

    expect(calls.indexOf('promote')).toBeLessThan(calls.indexOf('expire'));
    expect(mockJobRepo.promoteRecordingReady).toHaveBeenCalledWith(CFG.settleSeconds);
  });

  it('expiry passes a cutoff derived from recordingWaitMinutes', async () => {
    await makeWorker().sweepOnce();
    const cutoff = mockJobRepo.expireAwaitingRecording.mock.calls[0]![0] as Date;
    const ageMs = Date.now() - cutoff.getTime();
    // ~30 min ± a little.
    expect(ageMs).toBeGreaterThan(29 * 60_000);
    expect(ageMs).toBeLessThan(31 * 60_000);
  });

  it('claims runnable jobs and runs each through the runner', async () => {
    mockJobRepo.claimRunnable.mockResolvedValue([makeJob({ id: 'a', claim_generation: 1 }), makeJob({ id: 'b', claim_generation: 2 })]);
    await makeWorker().sweepOnce();
    expect(mockJobRepo.claimRunnable).toHaveBeenCalledWith(CFG.concurrency);
    expect(mockRunnerRun).toHaveBeenCalledTimes(2);
  });

  it('recovery passes the attempts_total ceiling (repo decrements attempts)', async () => {
    await makeWorker().sweepOnce();
    expect(mockJobRepo.recoverStale).toHaveBeenCalledWith(expect.any(Date), CFG.maxAttemptsTotal);
  });

  it('feeds the queue-depth gauge', async () => {
    mockJobRepo.queueDepthByStatus.mockResolvedValue([{ status: 'queued', count: 3 }]);
    await makeWorker().sweepOnce();
    expect(mockSetQueueDepth).toHaveBeenCalledWith('queued', 3);
  });

  it('a step failure does not abort the rest of the sweep (never throws)', async () => {
    mockJobRepo.claimRunnable.mockRejectedValue(new Error('claim boom'));
    const w = makeWorker();
    await expect(w.sweepOnce()).resolves.toBeTypeOf('boolean');
    expect(mockJobRepo.recoverStale).toHaveBeenCalled(); // recover (the last step) still ran
  });
});

describe('poll lifecycle', () => {
  it('goes dormant after N consecutive empty sweeps, re-arms on wake', async () => {
    vi.useFakeTimers();
    const w = makeWorker(); // emptySweepsBeforeDormant defaults to 2
    w.wake();
    expect(w.isArmed()).toBe(true);

    // Two empty sweeps → dormant. Each tick fires an async sweepOnce; flush between.
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(w.isArmed()).toBe(false);

    w.wake();
    expect(w.isArmed()).toBe(true);
    w.stop();
  });

  it('stays armed while there is backlog', async () => {
    vi.useFakeTimers();
    mockJobRepo.queueDepthByStatus.mockResolvedValue([{ status: 'queued', count: 5 }]);
    const w = makeWorker();
    w.wake();
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(w.isArmed()).toBe(true);
    w.stop();
  });

  it('does not mistake overlapping ticks during a long job for idle sweeps', async () => {
    vi.useFakeTimers();
    let releaseFirst!: () => void;
    mockRunnerRun
      .mockImplementationOnce(() => new Promise<void>((resolve) => { releaseFirst = resolve; }))
      .mockResolvedValueOnce(undefined);
    mockJobRepo.claimRunnable
      .mockResolvedValueOnce([makeJob({ id: 'slow-1' })])
      .mockResolvedValueOnce([makeJob({ id: 'retry-1' })])
      .mockResolvedValue([]);

    const w = makeWorker();
    w.wake();
    await vi.advanceTimersByTimeAsync(1000); // claim slow-1
    await vi.advanceTimersByTimeAsync(2000); // two overlapping ticks
    expect(w.isArmed()).toBe(true);
    expect(mockRunnerRun).toHaveBeenCalledTimes(1);

    releaseFirst();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(1000); // the next tick can claim queued retry-1
    expect(mockRunnerRun).toHaveBeenCalledTimes(2);
    w.stop();
  });
});

describe('graceful shutdown', () => {
  it('re-queues in-flight claims (generation-matched) and stops the poll', async () => {
    // A claim that never resolves keeps the job "in-flight" while we shut down.
    let release: () => void = () => {};
    mockRunnerRun.mockImplementation(() => new Promise<void>((r) => { release = r; }));
    mockJobRepo.claimRunnable.mockResolvedValue([makeJob({ id: 'inflight-1', claim_generation: 7 })]);

    const w = makeWorker();
    const sweepPromise = w.sweepOnce();
    // Let the sweep progress through promote/expire/claim so inFlight is populated.
    await new Promise((r) => setTimeout(r, 0));

    await w.gracefulShutdown();
    expect(mockJobRepo.gracefulRequeue).toHaveBeenCalledWith([{ id: 'inflight-1', generation: 7 }]);
    expect(w.isArmed()).toBe(false);

    release();
    await sweepPromise;
  });

  it('wake() is a no-op after shutdown', async () => {
    const w = makeWorker();
    await w.gracefulShutdown();
    w.wake();
    expect(w.isArmed()).toBe(false);
  });
});

describe('initDialerAnalysisWorker', () => {
  it('registers the worker through the handle', () => {
    const w = initDialerAnalysisWorker({ transcriber: { provider: 'gemini' } as never, analysisService: {} as never, config: CFG });
    expect(mockSetHandle).toHaveBeenCalledWith(w);
  });
});
