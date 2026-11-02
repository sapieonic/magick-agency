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
 *  - the slot pool: a slot refills the moment its job ends, N slots stay full under a deep
 *    queue, throughput is not bounded by the poll interval, the recording byte budget
 *    holds slots back, shutdown mid-flight requeues exactly the in-flight jobs and starts
 *    nothing, and a vendor rate limit pauses claims (one probe after the pause).
 *    `sweepOnce` no longer waits for the jobs it starts; `idle()` does.
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
    msUntilNextRunnable: vi.fn().mockResolvedValue(null),
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
  setDialerAnalysisSlots: vi.fn(),
  setDialerAnalysisMemoryReserved: vi.fn(),
  dialerAnalysisBudgetWaitsTotal: { inc: vi.fn() },
  dialerAnalysisRateLimitPausesTotal: { inc: vi.fn() },
}));

// ── Worker handle ───────────────────────────────────────────────────────────
const { mockSetHandle } = vi.hoisted(() => ({ mockSetHandle: vi.fn() }));
vi.mock('../../../src/core/dialer-analysis-worker-handle.js', () => ({
  setDialerAnalysisWorker: mockSetHandle,
}));

import { DialerAnalysisWorker, initDialerAnalysisWorker } from '../../../src/core/dialer-analysis-worker.js';
import type { DialerAnalysisConfig, DialerAnalysisRunContext } from '../../../src/core/dialer-analysis-runner.js';
import { VendorRateLimitBreaker } from '../../../src/core/vendor-rate-limit-breaker.js';
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
  mockJobRepo.msUntilNextRunnable.mockResolvedValue(null);
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
    // Once: the slots refill as jobs finish, so a mock that always returns rows never drains.
    mockJobRepo.claimRunnable.mockResolvedValueOnce([makeJob({ id: 'a', claim_generation: 1 }), makeJob({ id: 'b', claim_generation: 2 })]);
    const w = makeWorker();
    await w.sweepOnce();
    await w.idle();
    expect(mockJobRepo.claimRunnable).toHaveBeenNthCalledWith(1, CFG.concurrency);
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

  it('does not mistake ticks during a long job for idle sweeps, and the free slot keeps claiming meanwhile', async () => {
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
    w.wake(); // fills at once: claims slow-1
    await vi.advanceTimersByTimeAsync(0);
    expect(mockRunnerRun).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1000); // the tick fills the free slot: retry-1 runs beside slow-1
    expect(mockRunnerRun).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2000); // empty queue, but slow-1 is in flight: not idle
    expect(w.isArmed()).toBe(true);

    releaseFirst();
    await vi.advanceTimersByTimeAsync(2000); // now two truly idle sweeps
    expect(w.isArmed()).toBe(false);
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

// ── Slot pool ───────────────────────────────────────────────────────────────

/** Settle every pending promise chain without moving the (fake) clock. */
async function flush(): Promise<void> {
  for (let i = 0; i < 50; i++) await Promise.resolve();
}

/** A FIFO queue behind `claimRunnable`, honouring the limit like SKIP LOCKED does. */
function queueOf(n: number): { remaining: () => number; limits: number[] } {
  const ids = Array.from({ length: n }, (_, i) => `j${i}`);
  const limits: number[] = [];
  mockJobRepo.claimRunnable.mockImplementation(async (limit: number) => {
    limits.push(limit);
    return ids.splice(0, limit).map((id) => makeJob({ id, claim_generation: 1 }));
  });
  return { remaining: () => ids.length, limits };
}

/** Runs that end only when the test says so; records each run's context. */
function heldRuns() {
  const pending = new Map<string, (outcome?: string) => void>();
  const contexts = new Map<string, DialerAnalysisRunContext>();
  let maxConcurrent = 0;
  mockRunnerRun.mockImplementation((job: DialerAnalysisJobRecord, ctx: DialerAnalysisRunContext) => {
    contexts.set(job.id, ctx);
    return new Promise((resolve) => {
      pending.set(job.id, resolve);
      maxConcurrent = Math.max(maxConcurrent, pending.size);
    });
  });
  return {
    running: () => [...pending.keys()],
    ctx: (id: string) => contexts.get(id)!,
    maxConcurrent: () => maxConcurrent,
    finish(id: string, outcome = 'completed') {
      const resolve = pending.get(id);
      if (!resolve) throw new Error(`${id} is not running`);
      pending.delete(id);
      resolve(outcome);
    },
  };
}

function poolWorker(over: Partial<DialerAnalysisConfig> = {}, extra: { breaker?: VendorRateLimitBreaker; pollIntervalMs?: number } = {}) {
  return new DialerAnalysisWorker({
    transcriber: { provider: 'gemini' } as never,
    analysisService: {} as never,
    config: { ...CFG, pollIntervalMs: 60_000, ...over } as DialerAnalysisConfig,
    ...extra,
  });
}

describe('slot pool', () => {
  it('a slot refills as soon as its job finishes, without waiting for the interval or its sibling', async () => {
    vi.useFakeTimers();
    queueOf(5);
    const runs = heldRuns();
    const w = poolWorker({ concurrency: 2 });
    w.wake();
    await flush();
    expect(runs.running()).toEqual(['j0', 'j1']);

    runs.finish('j0');
    await flush(); // no timer moved: the refill is driven by the job ending
    expect(runs.running()).toEqual(['j1', 'j2']);
    expect(mockJobRepo.claimRunnable).toHaveBeenLastCalledWith(1);

    runs.finish('j2'); // j1, the older sibling, is still running
    await flush();
    expect(runs.running()).toEqual(['j1', 'j3']);
    await w.gracefulShutdown();
  });

  it('N slots stay full under a deep queue and never claim more than the free slots', async () => {
    vi.useFakeTimers();
    const q = queueOf(60);
    const runs = heldRuns();
    const w = poolWorker({ concurrency: 4 });
    w.wake();
    await flush();
    let finished = 0;
    while (q.remaining() > 0) {
      expect(runs.running()).toHaveLength(4);
      expect(w.inFlightCount).toBe(4);
      // Finish out of order: alternately the newest and the oldest.
      const r = runs.running();
      runs.finish(finished % 2 ? r[0]! : r[r.length - 1]!);
      finished++;
      await flush();
    }
    expect(runs.maxConcurrent()).toBe(4);
    expect(Math.max(...q.limits)).toBeLessThanOrEqual(4);
    expect(mockRunnerRun).toHaveBeenCalledTimes(60);
    await w.gracefulShutdown();
  });

  it('throughput is not bounded by the poll interval: 200 one-second jobs on 8 slots drain in 25 s of a 60 s interval', async () => {
    vi.useFakeTimers();
    const q = queueOf(200);
    mockRunnerRun.mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve('completed'), 1000)));
    const w = poolWorker({ concurrency: 8 });
    w.wake();
    await vi.advanceTimersByTimeAsync(25_000);
    expect(q.remaining()).toBe(0);
    expect(mockRunnerRun).toHaveBeenCalledTimes(200);
    expect(w.inFlightCount).toBe(0);
    // The poll never fired: every claim came from wake() or a finishing job.
    expect(mockJobRepo.promoteRecordingReady).not.toHaveBeenCalled();
    await w.gracefulShutdown();
  });

  it('respects the recording byte budget: slots wait for it without a claim, and a shrunk lease lets the next one start', async () => {
    vi.useFakeTimers();
    queueOf(10);
    const runs = heldRuns();
    // Worst case per slot = 100 × 2 = 200 bytes; the 500-byte budget holds two.
    const w = poolWorker({ concurrency: 4, maxRecordingBytes: 100, memoryBudgetBytes: 500 });
    w.wake();
    await flush();
    expect(runs.running()).toEqual(['j0', 'j1']);
    expect(mockJobRepo.claimRunnable).toHaveBeenCalledTimes(1);
    expect(mockJobRepo.claimRunnable).toHaveBeenCalledWith(2); // never claims a job it has no memory for
    const held = () => runs.running().reduce((sum, id) => sum + runs.ctx(id).lease!.bytes, 0);
    expect(held()).toBe(400);

    // j0 fetched a 30-byte recording: its lease shrinks to 60 (260 held), room for one more slot.
    runs.ctx('j0').lease!.shrinkTo(60);
    await flush();
    expect(runs.running()).toEqual(['j0', 'j1', 'j2']);
    expect(held()).toBe(460);

    // A finishing job hands its whole lease back.
    runs.finish('j1');
    await flush();
    expect(runs.running()).toEqual(['j0', 'j2', 'j3']);
    expect(held()).toBe(460);
    await w.gracefulShutdown();
  });

  it('shutdown mid-flight requeues exactly the in-flight jobs, including a claim that lands during shutdown, and starts nothing new', async () => {
    vi.useFakeTimers();
    const runs = heldRuns();
    let landClaim!: (jobs: DialerAnalysisJobRecord[]) => void;
    mockJobRepo.claimRunnable
      .mockResolvedValueOnce([makeJob({ id: 'a', claim_generation: 4 }), makeJob({ id: 'b', claim_generation: 5 }), makeJob({ id: 'c', claim_generation: 6 })])
      .mockImplementationOnce(() => new Promise((resolve) => { landClaim = resolve; }))
      .mockResolvedValue([makeJob({ id: 'never' })]);
    const w = poolWorker({ concurrency: 3 });
    w.wake();
    await flush();
    expect(runs.running()).toEqual(['a', 'b', 'c']);

    runs.finish('a'); // its slot's refill claim is now on its way to the database
    await flush();
    const shutdown = w.gracefulShutdown();
    landClaim([makeJob({ id: 'd', claim_generation: 9 })]);
    await shutdown;

    expect(mockJobRepo.gracefulRequeue).toHaveBeenCalledOnce();
    const requeued = mockJobRepo.gracefulRequeue.mock.calls[0]![0] as Array<{ id: string; generation: number }>;
    expect([...requeued].sort((x, y) => x.id.localeCompare(y.id))).toEqual([
      { id: 'b', generation: 5 }, { id: 'c', generation: 6 }, { id: 'd', generation: 9 },
    ]);
    expect(runs.running()).toEqual(['b', 'c']); // d was claimed but never started
    expect(w.isArmed()).toBe(false);

    // Jobs finishing after shutdown do not claim again; wake() is a no-op.
    const claims = mockJobRepo.claimRunnable.mock.calls.length;
    runs.finish('b');
    w.wake();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(mockJobRepo.claimRunnable.mock.calls.length).toBe(claims);
    expect(mockRunnerRun).toHaveBeenCalledTimes(3);
  });

  it('dormant after idle sweeps; wake() re-arms the poll and fills free slots at once', async () => {
    vi.useFakeTimers();
    const w = poolWorker({ concurrency: 2 }, { pollIntervalMs: 1000 });
    w.wake();
    await vi.advanceTimersByTimeAsync(2000);
    expect(w.isArmed()).toBe(false);

    queueOf(1);
    const runs = heldRuns();
    w.wake();
    await flush(); // no tick needed
    expect(w.isArmed()).toBe(true);
    expect(runs.running()).toEqual(['j0']);
    await w.gracefulShutdown();
  });

  it('a just-promoted job starts when its settle delay ends, not at the next poll', async () => {
    vi.useFakeTimers();
    mockJobRepo.promoteRecordingReady.mockResolvedValueOnce(1);
    mockJobRepo.claimRunnable.mockResolvedValueOnce([]).mockResolvedValueOnce([makeJob({ id: 'settled' })]).mockResolvedValue([]);
    mockJobRepo.msUntilNextRunnable.mockResolvedValueOnce(15_000).mockResolvedValue(null);
    const w = poolWorker({ concurrency: 2 });
    await w.sweepOnce();
    expect(mockRunnerRun).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(14_999);
    expect(mockRunnerRun).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(mockRunnerRun).toHaveBeenCalledOnce();
    await w.gracefulShutdown();
  });

  it('a rate limit pauses every slot, backs the job off by the pause, then probes one job before filling again', async () => {
    vi.useFakeTimers();
    queueOf(50);
    const runs = heldRuns();
    const breaker = new VendorRateLimitBreaker({ random: () => 0.5 }); // no jitter: 30 s, then 60 s
    const w = poolWorker({ concurrency: 4 }, { breaker });
    w.wake();
    await flush();
    expect(runs.running()).toEqual(['j0', 'j1', 'j2', 'j3']);

    // j0 is rate-limited: the runner asks the breaker for the pause to back the job off by.
    expect(runs.ctx('j0').onRateLimited!()).toBe(30);
    runs.finish('j0', 'rate_limited');
    // Its siblings, already in flight when the limit hit, hit it too: one opening, not four.
    for (const id of ['j1', 'j2', 'j3']) {
      expect(runs.ctx(id).onRateLimited!()).toBeLessThanOrEqual(30);
      runs.finish(id, 'rate_limited');
    }
    await flush();
    expect(breaker.state).toBe('open');
    expect(runs.running()).toEqual([]); // no slot claims while paused
    const claimsWhilePaused = mockJobRepo.claimRunnable.mock.calls.length;
    await vi.advanceTimersByTimeAsync(29_000);
    expect(mockJobRepo.claimRunnable.mock.calls.length).toBe(claimsWhilePaused);

    // Pause over: exactly one probe.
    await vi.advanceTimersByTimeAsync(1000);
    expect(runs.running()).toEqual(['j4']);
    expect(mockJobRepo.claimRunnable).toHaveBeenLastCalledWith(1);

    // The probe is rate-limited too: the pause doubles.
    expect(runs.ctx('j4').onRateLimited!()).toBe(60);
    runs.finish('j4', 'rate_limited');
    await vi.advanceTimersByTimeAsync(59_000);
    expect(runs.running()).toEqual([]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(runs.running()).toEqual(['j5']);

    // The probe completes: the breaker closes and every slot fills.
    runs.finish('j5');
    await flush();
    expect(breaker.state).toBe('closed');
    expect(runs.running()).toEqual(['j6', 'j7', 'j8', 'j9']);
    await w.gracefulShutdown();
  });
});
