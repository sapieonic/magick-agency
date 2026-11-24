-- 0074_abandonment_grace_rollup_rebuild.sql — rebuild the Insights rollup for the new
-- abandonment grace (decision AG1, docs/decisions.md).
--
-- `ABANDONMENT_BRIDGE_GRACE_MS` (`packages/domain/src/abandonment-predicate.ts`) went from
-- 1000 ms to 3000 ms: a call bridged up to 3 s after the carrier's answer is no longer abandoned.
-- Every abandonment figure read straight from `agency_call_attempts` (the rolling 24h gauge the
-- auto-pause guardrail reads, `/stats`, the call lists, Compare agents) evaluates
-- `ABANDONED_ATTEMPT_PREDICATE_SQL` at read time and changes with the deploy, history included.
-- The Insights rollup (0012) stores `abandoned` per 15-minute bucket, so its buckets still hold
-- the 1 s count until they are rebuilt; a range read would then mix the two definitions.
--
-- ── Backfill ──────────────────────────────────────────────────────────────────
-- Every bucket the rollup already holds is marked dirty, so the job rebuilds it with the new
-- predicate (recompute, never increment: 0012's header), as 0014 did. A bucket not rolled up yet
-- is marked already. One row per bucket, written to `agency_insights_rollup_dirty` only;
-- `agency_call_attempts` is not touched.
--
-- `agency_call_attempts.abandon_reason` is left as it is: rows settled before the deploy keep
-- `bridge_late` for a bridge between 1 s and 3 s. The column is diagnosis only and nothing reads
-- it (its comment in 0001 says so); the compliance numerator reads the predicate.
--
-- ── Locking ───────────────────────────────────────────────────────────────────
-- One transaction. Reads `agency_insights_rollup_buckets` and appends to the dirty table, which
-- the rollup job claims with SKIP LOCKED; nothing waits on it.
--
-- ── Down ──────────────────────────────────────────────────────────────────────
-- Nothing to undo: the marks are consumed by the job. Reverting the grace in code and running
-- this migration's Up again (a new migration) is how the buckets would be rebuilt the other way.
--
-- Runs as one node-pg-migrate SQL migration in one transaction; split on the up/down marker
-- comments (see 0001_baseline.sql's header for the regex).

-- Up Migration

INSERT INTO agency_insights_rollup_dirty (campaign_id, bucket_start)
SELECT campaign_id, bucket_start FROM agency_insights_rollup_buckets ORDER BY bucket_start, campaign_id;

-- Down Migration

SELECT 1;
