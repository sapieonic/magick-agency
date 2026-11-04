/**
 * The insights rollup job (migration 0012, `docs/insights.md` "Shape"): every `intervalMs`, a
 * pass recomputes the dirty 15-minute buckets the attempt triggers marked, `batchSize` at a
 * time, and publishes the backlog.
 *
 * ── Once per deployment ─────────────────────────────────────────────────────
 * Started by `startAgency` (`bootstrap/agency.ts`), which runs only in the main process: a
 * media worker starts its runtime shard and an analysis worker its slots, never the agency
 * bootstrap (`docs/scaling.md` §1.3, "Reaper ... leader-only sweeps": primary). Within the
 * process a pass never overlaps the previous one (`running`). Correctness does not rest on
 * either: two batches anywhere claim disjoint marks (`FOR UPDATE SKIP LOCKED`) and two
 * recomputes of one bucket serialize on its header row, so a second job would only share the
 * work (`insights-rollup-job.test.ts`, "two concurrent job runs never double count").
 *
 * ── A pass ──────────────────────────────────────────────────────────────────
 * Batches until one picks fewer than `batchSize` marks (the backlog is drained), the pass has run
 * half an interval (a backfill is worked off over several passes, never in one long hold), or
 * the job is stopping. A failed batch rolls back (its marks stay), counts a failure and ends
 * the pass; the next pass retries it.
 *
 * ── Stop ────────────────────────────────────────────────────────────────────
 * `stop()` clears the timer, lets the batch in flight commit or roll back, and resolves. It
 * runs in agency's stop, after pacing has halted (`cluster/shutdown-order.ts`), before the pool
 * closes.
 */
import { createChildLogger } from '@magick-agency/observability';
import {
  agencyInsightsRollupBucketsTotal,
  agencyInsightsRollupDirtyBuckets,
  agencyInsightsRollupFailuresTotal,
  agencyInsightsRollupOldestDirtySeconds,
  agencyInsightsRollupRecomputeSeconds,
} from '@magick-agency/observability/metrics/agency';
import { agencyInsightsRollupRepository, type InsightsRollupBatchResult } from '../db/repositories/agency.repository.js';

const log = createChildLogger({ component: 'agency-insights-rollup' });

export interface InsightsRollupJobOptions {
  intervalMs: number;
  batchSize: number;
}

/** What the job needs from the repository (a seam for unit tests). */
export interface InsightsRollupJobRepo {
  recomputeBatch(limit: number): Promise<InsightsRollupBatchResult>;
  backlog(): Promise<{ buckets: number; oldestSeconds: number }>;
}

export interface InsightsRollupPassResult {
  batches: number;
  buckets: number;
  attempts: number;
  failed: boolean;
}

export interface InsightsRollupJob {
  /** One pass now (the timer's body). Resolves to null when a pass is already running. */
  runPass(): Promise<InsightsRollupPassResult | null>;
  stop(): Promise<void>;
}

export function startInsightsRollupJob(
  options: InsightsRollupJobOptions,
  repo: InsightsRollupJobRepo = agencyInsightsRollupRepository,
): InsightsRollupJob {
  let stopping = false;
  let running: Promise<InsightsRollupPassResult> | null = null;

  const pass = async (): Promise<InsightsRollupPassResult> => {
    const result: InsightsRollupPassResult = { batches: 0, buckets: 0, attempts: 0, failed: false };
    const budgetEnds = Date.now() + options.intervalMs / 2;
    while (!stopping) {
      const started = process.hrtime.bigint();
      let batch: InsightsRollupBatchResult;
      try {
        batch = await repo.recomputeBatch(options.batchSize);
      } catch (err) {
        result.failed = true;
        agencyInsightsRollupFailuresTotal.inc();
        log.error({ err }, 'Insights rollup batch failed; its buckets stay dirty for the next pass');
        break;
      }
      // Every committed batch, an empty one included, on purpose: the stalled-job alert
      // (`agy-insights-rollup-stalled`) reads this histogram's count as the job's heartbeat, and
      // an idle pass's empty batch is what keeps it beating on a healthy idle system.
      agencyInsightsRollupRecomputeSeconds.observe(Number(process.hrtime.bigint() - started) / 1e9);
      if (batch.claimed === 0) break;
      result.batches += 1;
      result.buckets += batch.buckets;
      result.attempts += batch.attempts;
      agencyInsightsRollupBucketsTotal.inc(batch.buckets);
      if (batch.picked < options.batchSize || Date.now() >= budgetEnds) break;
    }
    try {
      const backlog = await repo.backlog();
      agencyInsightsRollupDirtyBuckets.set(backlog.buckets);
      agencyInsightsRollupOldestDirtySeconds.set(backlog.oldestSeconds);
    } catch (err) {
      log.warn({ err }, 'Insights rollup backlog read failed');
    }
    return result;
  };

  const runPass = async (): Promise<InsightsRollupPassResult | null> => {
    if (running || stopping) return null;
    running = pass();
    try {
      return await running;
    } finally {
      running = null;
    }
  };

  const timer = setInterval(() => { void runPass(); }, options.intervalMs);
  timer.unref?.();
  // The first pass now, so a boot (or the migration's backfill) does not wait a whole interval.
  void runPass();
  log.info({ intervalMs: options.intervalMs, batchSize: options.batchSize }, 'Insights rollup job started');

  return {
    runPass,
    async stop() {
      stopping = true;
      clearInterval(timer);
      if (running) await running.catch(() => undefined);
      log.info('Insights rollup job stopped');
    },
  };
}
