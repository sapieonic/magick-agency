import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IpcChannel } from '../../../src/cluster/ipc-channel.js';
import { memoryTransportPair, type MemoryTransportPair } from '../../helpers/ipc-memory-transport.js';

/*
 * The child processes' entries (`media-child-main.ts`, `analysis-child-main.ts`) with every
 * dependency faked: what each one starts and flushes around its role's work, and how it
 * answers the primary's `shutdown`. The parent channel is an in-memory pair; the test holds
 * the primary's end.
 *
 *  - PostHog: both children initialise it at boot and flush it on the way out. Without it
 *    the bridge's `webrtc_call_*` and the analysis runner's `dialer_call_*` events, which
 *    run in these processes, are dropped silently.
 *  - A media worker asked to stop while it is still booting answers the request (it is not
 *    refused `unsupported`, which left the primary to wait out its grace and SIGKILL), never
 *    starts its shard or says `ready`, and exits 0.
 */

const h = vi.hoisted(() => ({
  pair: null as unknown as MemoryTransportPair,
  appReady: null as unknown as Promise<unknown>,
  calls: [] as string[],
}));

vi.mock('../../../src/cluster/ipc-channel.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/cluster/ipc-channel.js')>()),
  parentTransport: () => h.pair.b,
}));
vi.mock('@magick-agency/db', () => ({
  initDbPool: vi.fn((opts: { poolMax: number }) => { h.calls.push(`pool:${opts.poolMax}`); return {}; }),
  closePool: vi.fn(async () => { h.calls.push('closePool'); }),
}));
vi.mock('ioredis', () => ({ default: class { quit = vi.fn(async () => 'OK'); } }));
vi.mock('../../../src/config/index.js', () => ({
  config: {
    server: { env: 'test' },
    db: { url: 'postgresql://u:p@localhost:5436/x', poolMax: 30, sslRejectUnauthorized: true },
    redis: { url: 'redis://localhost:6383/9', keyPrefix: '', commandTimeoutMs: 2000, maxRetriesPerRequest: 1, connectTimeoutMs: 2000 },
    processes: { mediaWorkers: 2, mediaWorkerDbPoolMax: 7 },
    voicelinkRecording: { allowedHosts: [] },
  },
}));
vi.mock('../../../src/analytics/posthog.js', () => ({
  initAnalytics: vi.fn(() => { h.calls.push('initAnalytics'); }),
  shutdownAnalytics: vi.fn(async () => { h.calls.push('shutdownAnalytics'); }),
}));
vi.mock('../../../src/audit/audit-logger.js', () => ({ auditLogger: { start: vi.fn(), shutdown: vi.fn(async () => {}) } }));
vi.mock('../../../src/audit/platform/audit-logger.js', () => ({ platformAuditLogger: { start: vi.fn(), shutdown: vi.fn(async () => {}) } }));
vi.mock('../../../src/feature-flags/index.js', () => ({ initFeatureFlagService: vi.fn() }));
vi.mock('../../../src/storage/s3.js', () => ({ initS3Client: vi.fn() }));
vi.mock('../../../src/tts/tts-file-cache.js', () => ({ initTtsFileCache: vi.fn() }));
vi.mock('../../../src/core/telephony-release.js', () => ({ setTelephonyReleaseObserver: vi.fn() }));
vi.mock('../../../src/transcription/index.js', () => ({ createTranscriber: vi.fn(() => null) }));
vi.mock('../../../src/analysis/index.js', () => ({ createAnalysisService: vi.fn(() => null) }));
vi.mock('../../../src/analysis/bridge-analysis-hooks.js', () => ({ createBridgeAnalysisHooks: vi.fn() }));
vi.mock('../../../src/seams/bridge-analysis-hooks.js', () => ({ setBridgeAnalysisHooks: vi.fn() }));
vi.mock('../../../src/core/dialer-analysis-worker-handle.js', () => ({ setDialerAnalysisWorker: vi.fn() }));
vi.mock('../../../src/bootstrap/voice.js', () => ({
  ensureVoiceEngine: vi.fn(() => ({
    guardHost: {
      delegateSelfHeal: vi.fn(), setDegradedShare: vi.fn(),
      gracefulShutdown: vi.fn(async () => { h.calls.push('guardHost.gracefulShutdown'); }),
    },
    bridge: { gracefulShutdown: vi.fn(async () => { h.calls.push('bridge.gracefulShutdown'); }) },
  })),
}));
vi.mock('../../../src/bootstrap/agency.js', () => ({
  ensureAgencyRuntime: vi.fn(() => ({ startShard: vi.fn(() => { h.calls.push('startShard'); }) })),
}));
vi.mock('../../../src/cluster/worker-app.js', () => ({
  buildWorkerApp: vi.fn(async () => {
    await h.appReady;
    return { close: vi.fn(async () => { h.calls.push('app.close'); }) };
  }),
}));
vi.mock('../../../src/api/core-handlers.js', () => ({
  buildCoreHandlers: vi.fn(async () => ({ close: vi.fn(async () => { h.calls.push('core.close'); }) })),
}));
vi.mock('../../../src/cluster/media-child.js', () => ({
  installIpcPacingBus: vi.fn(),
  startMediaChild: vi.fn(() => {
    h.calls.push('startMediaChild');
    return { shutdown: vi.fn(async () => { h.calls.push('child.shutdown'); }), health: vi.fn() };
  }),
}));
vi.mock('../../../src/cluster/analysis-child.js', () => ({
  startAnalysisChild: vi.fn(() => {
    h.calls.push('startAnalysisChild');
    return { shutdown: vi.fn(async () => { h.calls.push('child.shutdown'); }), health: vi.fn() };
  }),
}));

const { runMediaChildProcess } = await import('../../../src/cluster/media-child-main.js');
const { runAnalysisChildProcess } = await import('../../../src/cluster/analysis-child-main.js');

let exited: Promise<number>;
let primary: IpcChannel;
const signalListeners = { SIGTERM: process.listeners('SIGTERM'), SIGINT: process.listeners('SIGINT') };

beforeEach(() => {
  h.pair = memoryTransportPair();
  h.calls = [];
  h.appReady = Promise.resolve();
  primary = new IpcChannel(h.pair.a, { name: 'primary→test' });
  exited = new Promise<number>((resolve) => {
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { resolve(code ?? 0); }) as never);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  h.pair.disconnect();
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    for (const l of process.listeners(signal)) if (!signalListeners[signal].includes(l)) process.off(signal, l);
  }
});

describe('a media worker process', () => {
  it('initialises PostHog at boot, on its own pool; a shutdown stops the worker, flushes PostHog and exits 0', async () => {
    await runMediaChildProcess({ slot: 1 });
    expect(h.calls).toEqual(expect.arrayContaining(['pool:7', 'initAnalytics', 'startShard', 'startMediaChild']));
    expect(h.calls).not.toContain('shutdownAnalytics');

    await expect(primary.request('shutdown', { graceMs: 1_000 }, { deadlineMs: 2_000 })).resolves.toEqual({});
    expect(await exited).toBe(0);
    expect(h.calls).toContain('child.shutdown');
    // Flushed before the pool closes and the process exits.
    expect(h.calls.indexOf('shutdownAnalytics')).toBeGreaterThan(h.calls.indexOf('child.shutdown'));
    expect(h.calls.indexOf('shutdownAnalytics')).toBeLessThan(h.calls.indexOf('closePool'));
  });

  it('asked to stop while still booting: answers, never starts the shard or announces ready, closes what it built, exits 0', async () => {
    let releaseBoot!: () => void;
    h.appReady = new Promise<void>((resolve) => { releaseBoot = resolve; });
    const running = runMediaChildProcess({ slot: 0 });

    const answer = primary.request('shutdown', { graceMs: 1_000 }, { deadlineMs: 2_000 });
    // The request reaches the worker while its boot is parked in buildWorkerApp.
    await new Promise((r) => setTimeout(r, 20));
    releaseBoot();

    await expect(answer).resolves.toEqual({});
    await running;
    expect(await exited).toBe(0);
    expect(h.calls).not.toContain('startShard');
    expect(h.calls).not.toContain('startMediaChild');
    expect(h.calls).toEqual(expect.arrayContaining(['app.close', 'core.close', 'guardHost.gracefulShutdown', 'shutdownAnalytics', 'closePool']));
    expect(h.pair.sentByB.some((m) => (m as { type?: string }).type === 'ready')).toBe(false);
  });
});

describe('an analysis worker process', () => {
  const overrides = {
    transcriber: {} as never,
    analysisService: {} as never,
    config: { enabled: true, concurrency: 4 } as never,
  };

  it('initialises PostHog at boot, on a pool of its slots plus two; a shutdown flushes PostHog before the pool closes, and exits 0', async () => {
    await runAnalysisChildProcess({ slot: 0, overrides });
    expect(h.calls).toEqual(expect.arrayContaining(['pool:6', 'initAnalytics', 'startAnalysisChild']));
    expect(h.calls).not.toContain('shutdownAnalytics');

    await expect(primary.request('shutdown', { graceMs: 1_000 }, { deadlineMs: 2_000 })).resolves.toEqual({});
    expect(await exited).toBe(0);
    expect(h.calls.indexOf('shutdownAnalytics')).toBeGreaterThan(h.calls.indexOf('child.shutdown'));
    expect(h.calls.indexOf('shutdownAnalytics')).toBeLessThan(h.calls.indexOf('closePool'));
  });
});
