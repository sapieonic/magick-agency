-- 0066_session_events_break_overrun_index.sql — the events that ended a break over its limit, by
-- campaign and time (docs/compare-agents.md §7; apps/server/src/db/repositories/agency/compare-reads.ts
-- COMPARE_BREAK_OVERRUNS_SQL).
--
-- Compare agents' "Breaks over their limit" counts, per cohort agent, the events of a campaign's
-- sessions in the window that carry 0060's `break_overrun_seconds` (set only on the event that ended
-- a break that ran over). The only index by campaign was `idx_agency_session_events_campaign_at`
-- `(campaign_id, at)` over every state change, so the read walked every state change of the window
-- to find the few that end an overrun. EXPLAIN ANALYZE on a month of 100 agents (1.4M state events,
-- 3,100 overruns): a parallel scan reading 28,000 buffers, 86 ms; on this index 3,100 buffers,
-- 1.8 ms.
--
-- ── Index ─────────────────────────────────────────────────────────────────────
-- idx_agency_session_events_break_overrun (campaign_id, at) WHERE break_overrun_seconds IS NOT NULL:
--   at most one row per break, a sliver of the table. The read's predicate names the same column,
--   so the planner proves the index applies.
--
-- ── Locking ───────────────────────────────────────────────────────────────────
-- A plain CREATE INDEX (node-pg-migrate runs a SQL file's Up inside a transaction, where
-- CONCURRENTLY is refused): SHARE on agency_agent_session_events until commit, reads proceed, writes
-- (every state change) wait while it reads the table once. On a large table a deployment builds it
-- first with CREATE INDEX CONCURRENTLY under the same name (db-hygiene.md, "2. Building an index
-- before a deploy"); IF NOT EXISTS then finds it and the migration adds the comment and records
-- itself. A CONCURRENTLY build that failed leaves an invalid index under the name; the check at the
-- end of Up fails the migration on one. `SET LOCAL lock_timeout = '10s'` first: a lock not granted
-- within 10 s fails the migration (the deploy can be retried) instead of queueing the state changes
-- behind the wait.
--
-- ── Down ──────────────────────────────────────────────────────────────────────
-- Drops the index; the read falls back to the campaign's events by time (correct, slower).
--
-- Runs as one node-pg-migrate SQL migration in one transaction; split on the up/down marker
-- comments (see 0001_baseline.sql's header for the regex).

-- Up Migration

-- Fail fast if a straggler connection holds a lock on agency_agent_session_events (db-hygiene.md).
SET LOCAL lock_timeout = '10s';

CREATE INDEX IF NOT EXISTS idx_agency_session_events_break_overrun
  ON agency_agent_session_events (campaign_id, at)
  WHERE break_overrun_seconds IS NOT NULL;

COMMENT ON INDEX idx_agency_session_events_break_overrun IS
  'The events that ended a break over its limit, by campaign and time: Compare agents'' breaks over their limit (docs/compare-agents.md §7).';

-- An index built beforehand with CONCURRENTLY that failed is left invalid under its name, and
-- IF NOT EXISTS would accept it. Fail instead; drop it and build it again (db-hygiene.md §2).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
     WHERE c.relname = 'idx_agency_session_events_break_overrun' AND NOT (i.indisvalid AND i.indisready)
  ) THEN
    RAISE EXCEPTION 'invalid index from an earlier CREATE INDEX CONCURRENTLY: idx_agency_session_events_break_overrun; DROP INDEX CONCURRENTLY and build again';
  END IF;
END
$$;

-- Down Migration

SET LOCAL lock_timeout = '10s';

DROP INDEX IF EXISTS idx_agency_session_events_break_overrun;
