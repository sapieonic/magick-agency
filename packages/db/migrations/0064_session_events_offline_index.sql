-- 0064_session_events_offline_index.sql — the events where a session goes offline or comes back from
-- it, by session (docs/compare-agents.md §7; apps/server/src/db/repositories/agency/compare-reads.ts
-- COMPARE_LOGGED_IN_DAYS_SQL). 0063 is applied and is not edited.
--
-- Compare agents' trend needs each agent's local days with logged-in time on a campaign. A session
-- row is not one stretch of it: a live session goes `offline` without `left_at` (the station closed
-- or its heartbeat lapsed, a restart's markAllOffline, the dialler releasing it) and the agent's
-- next join reuses the row (`offline → break`, `joined_at` unchanged), so a row can span a week of
-- nights off. The read finds the online spans from the session's start and its offline boundaries
-- only. No index served those by session (`idx_agency_session_events_agent` is `(agent_user_id,
-- at)` over every state change, `session_id` is deliberately not indexed in general), so the read
-- would scan every state change of the cohort's sessions (1.4M on a month of 100 agents) to find a
-- few thousand boundaries.
--
-- ── Index ─────────────────────────────────────────────────────────────────────
-- idx_agency_session_events_offline (session_id, at) WHERE to_state = 'offline' OR from_state =
--   'offline': two or three rows per session per day (the join's return from offline, the close),
--   a sliver of the table. The read's predicate repeats this one byte for byte
--   (OFFLINE_BOUNDARY_EVENT_SQL), so the planner proves the index applies.
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
-- Drops the index; the read falls back to the events by session through a scan (correct, slower).
--
-- Runs as one node-pg-migrate SQL migration in one transaction; split on the up/down marker
-- comments (see 0001_baseline.sql's header for the regex).

-- Up Migration

-- Fail fast if a straggler connection holds a lock on agency_agent_session_events (db-hygiene.md).
SET LOCAL lock_timeout = '10s';

CREATE INDEX IF NOT EXISTS idx_agency_session_events_offline
  ON agency_agent_session_events (session_id, at)
  WHERE to_state = 'offline' OR from_state = 'offline';

COMMENT ON INDEX idx_agency_session_events_offline IS
  'A session''s offline boundaries (going offline, coming back): Compare agents'' trend days (docs/compare-agents.md §7).';

-- An index built beforehand with CONCURRENTLY that failed is left invalid under its name, and
-- IF NOT EXISTS would accept it. Fail instead; drop it and build it again (db-hygiene.md §2).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
     WHERE c.relname = 'idx_agency_session_events_offline' AND NOT (i.indisvalid AND i.indisready)
  ) THEN
    RAISE EXCEPTION 'invalid index from an earlier CREATE INDEX CONCURRENTLY: idx_agency_session_events_offline; DROP INDEX CONCURRENTLY and build again';
  END IF;
END
$$;

-- Down Migration

SET LOCAL lock_timeout = '10s';

DROP INDEX IF EXISTS idx_agency_session_events_offline;
