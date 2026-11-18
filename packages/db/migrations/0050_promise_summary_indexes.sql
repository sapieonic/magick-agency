-- 0050_promise_summary_indexes.sql — the indexes the promises summary walks (decision B28b;
-- apps/server/src/db/repositories/agency/promise-summary.repository.ts).
--
-- The Live floor's "Will pay" counts the promises to pay (PT1–PT14) recorded in an account over a
-- window, by when the outcome carrying them was written (`dispositioned_at`), on all three call
-- tables that can carry one. No index served an account's outcomes by time on any of them: the
-- read would scan each table (every call the deployment has made) once a minute per open Live
-- floor. Each index holds only the calls with a promise (0041's `promise_date`), so it is the size
-- of the promises, not of the calls.
--
-- ── Indexes ───────────────────────────────────────────────────────────────────
-- idx_agency_attempts_promise_written     on agency_call_attempts
-- idx_agency_manual_calls_promise_written on agency_manual_calls
-- idx_agency_inbound_calls_promise_written on agency_inbound_calls
--   each (tenant_id, account_id, dispositioned_at) WHERE promise_date IS NOT NULL: an account's
--   promises in a window is one range of each.
--
-- ── Locking ───────────────────────────────────────────────────────────────────
-- Plain CREATE INDEX (node-pg-migrate runs a SQL file's Up inside a transaction, where
-- CONCURRENTLY is refused): SHARE on each table until commit, reads proceed, writes wait while
-- each table is read once. agency_call_attempts is large: a deployment that wants them built
-- first can CREATE INDEX CONCURRENTLY under the same names (db-hygiene.md, "2. Building an index
-- before a deploy"); IF NOT EXISTS then finds them and the migration adds the comments and records
-- itself. A CONCURRENTLY build that failed leaves an invalid index under its name; the check at the
-- end of Up fails the migration on one. `SET LOCAL lock_timeout = '10s'` first: a lock not granted
-- within 10 s fails the migration (the deploy can be retried) instead of queueing the dialler's
-- writes behind the wait.
--
-- ── Down ──────────────────────────────────────────────────────────────────────
-- Drops the three; the summary falls back to scanning the tables (correct, slower).
--
-- Runs as one node-pg-migrate SQL migration in one transaction; split on the up/down marker
-- comments (see 0001_baseline.sql's header for the regex).

-- Up Migration

-- Fail fast if a straggler connection holds a lock on one of these tables (db-hygiene.md).
SET LOCAL lock_timeout = '10s';

CREATE INDEX IF NOT EXISTS idx_agency_attempts_promise_written
  ON agency_call_attempts (tenant_id, account_id, dispositioned_at)
  WHERE promise_date IS NOT NULL;

COMMENT ON INDEX idx_agency_attempts_promise_written IS
  'An account''s dialler promises to pay by when their outcome was written: the promises summary (B28b).';

CREATE INDEX IF NOT EXISTS idx_agency_manual_calls_promise_written
  ON agency_manual_calls (tenant_id, account_id, dispositioned_at)
  WHERE promise_date IS NOT NULL;

COMMENT ON INDEX idx_agency_manual_calls_promise_written IS
  'An account''s soft-phone promises to pay by when their outcome was written: the promises summary (B28b).';

CREATE INDEX IF NOT EXISTS idx_agency_inbound_calls_promise_written
  ON agency_inbound_calls (tenant_id, account_id, dispositioned_at)
  WHERE promise_date IS NOT NULL;

COMMENT ON INDEX idx_agency_inbound_calls_promise_written IS
  'An account''s inbound promises to pay by when their outcome was written: the promises summary (B28b).';

-- An index built beforehand with CONCURRENTLY that failed is left invalid under its name, and
-- IF NOT EXISTS would accept it. Fail instead; drop it and build it again (db-hygiene.md §2).
DO $$
DECLARE
  bad text;
BEGIN
  SELECT string_agg(c.relname, ', ') INTO bad
    FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
   WHERE c.relname IN ('idx_agency_attempts_promise_written', 'idx_agency_manual_calls_promise_written',
                       'idx_agency_inbound_calls_promise_written')
     AND NOT (i.indisvalid AND i.indisready);
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'invalid index from an earlier CREATE INDEX CONCURRENTLY: %; DROP INDEX CONCURRENTLY and build again', bad;
  END IF;
END
$$;

-- Down Migration

DROP INDEX IF EXISTS idx_agency_inbound_calls_promise_written;
DROP INDEX IF EXISTS idx_agency_manual_calls_promise_written;
DROP INDEX IF EXISTS idx_agency_attempts_promise_written;
