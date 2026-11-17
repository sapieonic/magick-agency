-- 0049_listen_history_index.sql — the index the account's listening history walks
-- (docs/listening.md §12, LS19, LS22 t; apps/server/src/db/repositories/agency/listen-history.repository.ts).
--
-- The history pages an account's listen visits newest first. No index served the account and the
-- start together (0047's `idx_agency_listen_sessions_listener` leads with the supervisor), so every
-- page windowed every session the account had kept for the audit horizon (85 days by default),
-- and without a supervisor filter read the whole tenant's to find them; the CSV export drains up
-- to 100 pages, so up to 100 times over. The statement now walks this index newest first and
-- stops at the page's visits.
--
-- ── Index ─────────────────────────────────────────────────────────────────────
-- idx_agency_listen_sessions_account_started (tenant_id, account_id, started_at DESC, id DESC)
--   WHERE live_at IS NOT NULL: the history reads only the sessions that went live (LS22 c), in
--   its keyset order (the start, then the id, both descending), so the cursor's row comparison
--   is an index condition and the walk needs no sort of its own.
--
-- ── Locking ───────────────────────────────────────────────────────────────────
-- A plain CREATE INDEX (node-pg-migrate runs a SQL file's Up inside a transaction, where
-- CONCURRENTLY is refused): SHARE on agency_listen_sessions until commit, reads proceed, writes
-- wait while it reads the table once. The table is small (a few rows a day per supervisor, purged
-- at the audit horizon) and migrations run at container start, before the server listens. A
-- deployment that wants it built first can CREATE INDEX CONCURRENTLY under the same name
-- (db-hygiene.md, "2. Building an index before a deploy"); IF NOT EXISTS then finds it and the
-- migration adds the comment and records itself. A CONCURRENTLY build that failed leaves an invalid
-- index under the name; the check at the end of Up fails the migration on one. `SET LOCAL
-- lock_timeout = '10s'` first: a lock not granted within 10 s fails the migration (the deploy can
-- be retried) instead of queueing the listen writes behind the wait.
--
-- ── Down ──────────────────────────────────────────────────────────────────────
-- Drops the index; the history's walk falls back to the table (correct, slower).
--
-- Runs as one node-pg-migrate SQL migration in one transaction; split on the up/down marker
-- comments (see 0001_baseline.sql's header for the regex).

-- Up Migration

-- Fail fast if a straggler connection holds a lock on agency_listen_sessions (db-hygiene.md).
SET LOCAL lock_timeout = '10s';

CREATE INDEX IF NOT EXISTS idx_agency_listen_sessions_account_started
  ON agency_listen_sessions (tenant_id, account_id, started_at DESC, id DESC)
  WHERE live_at IS NOT NULL;

COMMENT ON INDEX idx_agency_listen_sessions_account_started IS
  'An account''s live listen sessions, newest first: the listening history''s walk (LS19, LS22 t).';

-- An index built beforehand with CONCURRENTLY that failed is left invalid under its name, and
-- IF NOT EXISTS would accept it. Fail instead; drop it and build it again (db-hygiene.md §2).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
     WHERE c.relname = 'idx_agency_listen_sessions_account_started' AND NOT (i.indisvalid AND i.indisready)
  ) THEN
    RAISE EXCEPTION 'invalid index from an earlier CREATE INDEX CONCURRENTLY: idx_agency_listen_sessions_account_started; DROP INDEX CONCURRENTLY and build again';
  END IF;
END
$$;

-- Down Migration

DROP INDEX IF EXISTS idx_agency_listen_sessions_account_started;
