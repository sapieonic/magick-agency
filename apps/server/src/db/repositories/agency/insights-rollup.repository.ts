/**
 * The campaign insights rollup (migration 0012, `docs/insights.md` "Shape"): the job's batch
 * (claim marks, recompute their buckets, commit) and the page's range reads. The SQL is in
 * `insights-rollup-sql.ts`; the reads delegate to `insights-rollup-reads.ts` (rollup) and
 * `insights-range-reads.ts` (agent state time, online peak, callback timing).
 */
import { getPool } from '@magick-agency/db';
import { withTransaction } from '@magick-agency/db/utils/transaction';
import type { PoolClient } from 'pg';
import {
  INSIGHTS_BACKLOG_SQL,
  INSIGHTS_CLAIM_SQL,
  INSIGHTS_CLEAR_SQL,
  INSIGHTS_LOCK_HEADERS_SQL,
  INSIGHTS_RECOMPUTE_SQL,
} from './insights-rollup-sql.js';
import {
  insightsAbandonmentTrend,
  insightsActivity,
  insightsAsOf,
  insightsCallerIds,
  insightsCarrierFailures,
  insightsRecording,
  insightsTrends,
} from './insights-rollup-reads.js';
import { insightsAgentStateSeconds, insightsAgentsOnlinePeak, insightsCallbackTiming } from './insights-range-reads.js';

/** What one batch did. */
export interface InsightsRollupBatchResult {
  /** Marks picked, oldest first (at most the batch size; fewer means the backlog is empty). */
  picked: number;
  /** Distinct buckets claimed (at most `picked`). */
  claimed: number;
  /** Marks deleted: the picked ones and every other unlocked mark of the same buckets. */
  marks: number;
  /** Buckets recomputed (claimed buckets of campaigns that still exist). */
  buckets: number;
  /** Attempts read by the recompute. */
  attempts: number;
}

export class AgencyInsightsRollupRepository {
  /**
   * One batch, in one transaction: claim up to `limit` dirty buckets oldest first (deleting
   * their marks), lock their headers in key order, delete their breakdown rows and rebuild every
   * table from the attempts. A throw rolls the whole batch back, marks included, so a failed
   * batch is retried by the next pass and never loses a bucket.
   *
   * Statements in order, each a new snapshot under READ COMMITTED: the recompute's snapshot is
   * taken after the claim, so every write behind a claimed mark is visible to it; a write that
   * commits later left a mark the claim did not see, which survives this batch.
   *
   * `client` joins a caller's transaction (tests); otherwise the batch checks out its own.
   */
  async recomputeBatch(limit: number, client?: PoolClient): Promise<InsightsRollupBatchResult> {
    return withTransaction(async (c) => {
      const claimed = await c.query<{ campaign_id: string; bucket_start: Date; picked: number; marks: number }>(INSIGHTS_CLAIM_SQL, [limit]);
      if (claimed.rows.length === 0) return { picked: 0, claimed: 0, marks: 0, buckets: 0, attempts: 0 };
      const { picked, marks } = claimed.rows[0]!;
      const locked = await c.query<{ campaign_id: string; bucket_start: Date }>(INSIGHTS_LOCK_HEADERS_SQL, [
        claimed.rows.map((r) => r.campaign_id), claimed.rows.map((r) => r.bucket_start),
      ]);
      if (locked.rows.length === 0) return { picked, claimed: claimed.rows.length, marks, buckets: 0, attempts: 0 };
      const keys = [locked.rows.map((r) => r.campaign_id), locked.rows.map((r) => r.bucket_start)];
      await c.query(INSIGHTS_CLEAR_SQL, keys);
      const done = await c.query<{ attempts: number; buckets: number }>(INSIGHTS_RECOMPUTE_SQL, keys);
      return {
        picked,
        claimed: claimed.rows.length,
        marks,
        buckets: done.rows[0]?.buckets ?? 0,
        attempts: done.rows[0]?.attempts ?? 0,
      };
    }, { pool: getPool(), client });
  }

  /** Distinct dirty buckets and the oldest mark's age in seconds (0 when none). */
  async backlog(): Promise<{ buckets: number; oldestSeconds: number }> {
    const { rows } = await getPool().query<{ buckets: number; oldest_seconds: number }>(INSIGHTS_BACKLOG_SQL);
    return { buckets: rows[0]?.buckets ?? 0, oldestSeconds: Number(rows[0]?.oldest_seconds ?? 0) };
  }

  /** Calls, outcomes, overrides, no-outcome and per-agent activity; see {@link insightsActivity}. */
  async activity(...args: Parameters<typeof insightsActivity>): ReturnType<typeof insightsActivity> {
    return insightsActivity(...args);
  }

  /** The zero-filled trend series and best hours; see {@link insightsTrends}. */
  async trends(...args: Parameters<typeof insightsTrends>): ReturnType<typeof insightsTrends> {
    return insightsTrends(...args);
  }

  /** Abandoned and answered per trend bucket; see {@link insightsAbandonmentTrend}. */
  async abandonmentTrend(...args: Parameters<typeof insightsAbandonmentTrend>): ReturnType<typeof insightsAbandonmentTrend> {
    return insightsAbandonmentTrend(...args);
  }

  /** Dials and connected per caller ID; see {@link insightsCallerIds}. */
  async callerIds(...args: Parameters<typeof insightsCallerIds>): ReturnType<typeof insightsCallerIds> {
    return insightsCallerIds(...args);
  }

  /** Connected and recorded; see {@link insightsRecording}. */
  async recording(...args: Parameters<typeof insightsRecording>): ReturnType<typeof insightsRecording> {
    return insightsRecording(...args);
  }

  /** Dials with outcome `failed`; see {@link insightsCarrierFailures}. */
  async carrierFailures(...args: Parameters<typeof insightsCarrierFailures>): ReturnType<typeof insightsCarrierFailures> {
    return insightsCarrierFailures(...args);
  }

  /** The rollup's freshness; see {@link insightsAsOf}. */
  async asOf(...args: Parameters<typeof insightsAsOf>): ReturnType<typeof insightsAsOf> {
    return insightsAsOf(...args);
  }

  /** Seconds per state per agent; see {@link insightsAgentStateSeconds}. */
  async agentStateSeconds(...args: Parameters<typeof insightsAgentStateSeconds>): ReturnType<typeof insightsAgentStateSeconds> {
    return insightsAgentStateSeconds(...args);
  }

  /** Peak agents online per trend bucket; see {@link insightsAgentsOnlinePeak}. */
  async agentsOnlinePeak(...args: Parameters<typeof insightsAgentsOnlinePeak>): ReturnType<typeof insightsAgentsOnlinePeak> {
    return insightsAgentsOnlinePeak(...args);
  }

  /** Callback timing (IN4); see {@link insightsCallbackTiming}. */
  async callbackTiming(...args: Parameters<typeof insightsCallbackTiming>): ReturnType<typeof insightsCallbackTiming> {
    return insightsCallbackTiming(...args);
  }
}

export const agencyInsightsRollupRepository = new AgencyInsightsRollupRepository();
