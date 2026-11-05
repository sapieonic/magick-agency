// The insights rollup job's loop, over a scripted repository: a pass batches while batches come
// back full, stops at an empty or short one, at its time budget and on a failure (counted,
// marks left for the next pass); passes never overlap; stop waits for the batch in flight.
// The SQL is pinned on Postgres by test/integration/agency/insights-rollup-job.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const metrics = vi.hoisted(() => ({
  failures: vi.fn(), buckets: vi.fn(), seconds: vi.fn(), dirty: vi.fn(), oldest: vi.fn(),
}));
vi.mock('@magick-agency/observability/metrics/agency', () => ({
  agencyInsightsRollupFailuresTotal: { inc: metrics.failures },
  agencyInsightsRollupBucketsTotal: { inc: metrics.buckets },
  agencyInsightsRollupRecomputeSeconds: { observe: metrics.seconds },
  agencyInsightsRollupDirtyBuckets: { set: metrics.dirty },
  agencyInsightsRollupOldestDirtySeconds: { set: metrics.oldest },
}));
vi.mock('@magick-agency/observability', () => ({
  createChildLogger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../../../src/db/repositories/agency.repository.js', () => ({ agencyInsightsRollupRepository: {} }));

const { startInsightsRollupJob } = await import('../../../src/agency/insights-rollup-job.js');

const batch = (picked: number, buckets = picked) => ({ picked, claimed: buckets, marks: picked, buckets, attempts: buckets * 3 });

function scripted(results: Array<ReturnType<typeof batch> | Error>, backlog = { buckets: 0, oldestSeconds: 0 }) {
  const queue = [...results];
  return {
    recomputeBatch: vi.fn(async (_limit: number) => {
      const next = queue.shift() ?? batch(0);
      if (next instanceof Error) throw next;
      return next;
    }),
    backlog: vi.fn(async () => backlog),
  };
}

beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => { vi.useRealTimers(); });

describe('insights rollup job', () => {
  it('batches while they come back full and stops at a short one, then publishes the backlog', async () => {
    const repo = scripted([batch(10), batch(10, 4), batch(3)], { buckets: 7, oldestSeconds: 42 });
    const job = startInsightsRollupJob({ intervalMs: 60_000, batchSize: 10 }, repo);
    await vi.waitFor(() => expect(metrics.dirty).toHaveBeenCalled());
    expect(repo.recomputeBatch).toHaveBeenCalledTimes(3);
    expect(repo.recomputeBatch).toHaveBeenCalledWith(10);
    expect(metrics.buckets.mock.calls.map((c) => c[0])).toEqual([10, 4, 3]);
    expect(metrics.seconds).toHaveBeenCalledTimes(3);
    expect(metrics.dirty).toHaveBeenCalledWith(7);
    expect(metrics.oldest).toHaveBeenCalledWith(42);
    expect(await job.runPass()).toEqual({ batches: 0, buckets: 0, attempts: 0, failed: false });
    await job.stop();
  });

  it('a failed batch ends the pass, counts a failure, and the next pass carries on', async () => {
    const repo = scripted([batch(10), new Error('db down'), batch(2)]);
    const job = startInsightsRollupJob({ intervalMs: 60_000, batchSize: 10 }, repo);
    await vi.waitFor(() => expect(metrics.failures).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(metrics.dirty).toHaveBeenCalled());
    expect(repo.recomputeBatch).toHaveBeenCalledTimes(2);
    expect(await job.runPass()).toEqual({ batches: 1, buckets: 2, attempts: 6, failed: false });
    await job.stop();
  });

  it('never overlaps two passes, and stop waits for the batch in flight', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const repo = {
      recomputeBatch: vi.fn(async () => { await gate; return batch(1); }),
      backlog: vi.fn(async () => ({ buckets: 0, oldestSeconds: 0 })),
    };
    const job = startInsightsRollupJob({ intervalMs: 60_000, batchSize: 10 }, repo);
    expect(await job.runPass()).toBeNull();
    let stopped = false;
    const stopping = job.stop().then(() => { stopped = true; });
    await new Promise((r) => setTimeout(r, 10));
    expect(stopped).toBe(false);
    release();
    await stopping;
    expect(repo.recomputeBatch).toHaveBeenCalledTimes(1);
    expect(await job.runPass()).toBeNull();
  });

  it('a pass yields after half an interval even while batches come back full', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    const repo = {
      recomputeBatch: vi.fn(async () => { vi.setSystemTime(Date.now() + 2_000); return batch(10); }),
      backlog: vi.fn(async () => ({ buckets: 99, oldestSeconds: 1 })),
    };
    const job = startInsightsRollupJob({ intervalMs: 10_000, batchSize: 10 }, repo);
    await vi.waitFor(() => expect(metrics.dirty).toHaveBeenCalledWith(99));
    // 5 s budget at 2 s a batch: the third batch crosses it.
    expect(repo.recomputeBatch).toHaveBeenCalledTimes(3);
    await job.stop();
  });
});
