-- 0046_unrequested_recordings_index.sql — the index the retention purge's recording step reads
-- (RC5, apps/server/src/maintenance/retention-purge.ts `purgeUnrequestedRecordings`).
--
-- Every retention run clears `recording_url` and `recording_duration_seconds` on each call that
-- holds a recording link it did not ask for (`recording_url IS NOT NULL AND NOT
-- recording_requested`). No index covered that predicate, so every batch read the whole of
-- agency_calls, and so did every later run, which finds nothing (since RC1 no such link is
-- stored).
--
-- ── Index ─────────────────────────────────────────────────────────────────────
-- idx_agency_calls_recording_unrequested (id) WHERE recording_url IS NOT NULL AND NOT
--   recording_requested: partial, so it holds only the calls still carrying such a link: the
--   rows from before RC1 until the first run clears them, then none. Keyed on id, the purge's
--   keyset order. The predicate is spelled exactly as the purge's `unrequested` so the planner
--   can prove the read implies it. Clearing the link takes a row out of it.
--
-- ── Locking ───────────────────────────────────────────────────────────────────
-- A plain CREATE INDEX (node-pg-migrate runs a SQL file's Up inside a transaction, where
-- CONCURRENTLY is refused): SHARE on agency_calls until commit, reads proceed, writes wait while
-- it reads the table once. Migrations run at container start, before the server listens. On a
-- production database where agency_calls is already large, build it first with CREATE INDEX
-- CONCURRENTLY under the same name (db-hygiene.md, "2. Building an index before a deploy");
-- IF NOT EXISTS then finds it (still taking a brief SHARE lock) and the migration adds the comment
-- and records itself. A CONCURRENTLY build that failed leaves an invalid index under the name; the
-- check at the end of Up fails the migration on one, rather than record an index the planner will
-- never use. `SET LOCAL lock_timeout = '10s'` first: a lock not granted within 10 s fails the
-- migration (the deploy can be retried) instead of queueing every other query behind the wait.
--
-- ── Down ──────────────────────────────────────────────────────────────────────
-- Drops the index; the recording step goes back to scanning.
--
-- Runs as one node-pg-migrate SQL migration in one transaction; split on the up/down marker
-- comments (see 0001_baseline.sql's header for the regex).

-- Up Migration

-- Fail fast if a straggler connection holds a lock on agency_calls (db-hygiene.md).
SET LOCAL lock_timeout = '10s';

CREATE INDEX IF NOT EXISTS idx_agency_calls_recording_unrequested
  ON agency_calls (id)
  WHERE recording_url IS NOT NULL AND NOT recording_requested;

COMMENT ON INDEX idx_agency_calls_recording_unrequested IS
  'Calls holding a recording link they did not ask for, by id: the retention purge''s recording step (purgeUnrequestedRecordings, RC5).';

-- An index built beforehand with CONCURRENTLY that failed is left invalid under its name, and
-- IF NOT EXISTS would accept it. Fail instead; drop it and build it again (db-hygiene.md §2).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
     WHERE c.relname = 'idx_agency_calls_recording_unrequested' AND NOT (i.indisvalid AND i.indisready)
  ) THEN
    RAISE EXCEPTION 'invalid index from an earlier CREATE INDEX CONCURRENTLY: idx_agency_calls_recording_unrequested; DROP INDEX CONCURRENTLY and build again';
  END IF;
END
$$;

-- Down Migration

DROP INDEX IF EXISTS idx_agency_calls_recording_unrequested;
