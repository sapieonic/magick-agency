-- 0045_promise_contacts_index.sql — the Contacts list's promise index, built out of 0041's
-- ACCESS EXCLUSIVE (0009 / 0010's split).
--
-- idx_agency_contacts_promise (campaign_id, promise_date) WHERE promise_date IS NOT NULL: the
-- Contacts list's promise filter and the "Promised for" order (PT6) read only contacts holding a
-- promise. Partial, so it is the size of the promises, not the roster.
--
-- ── Why not in 0041 ───────────────────────────────────────────────────────────
-- 0041 adds the promise columns with ALTER TABLE, which holds ACCESS EXCLUSIVE on agency_contacts
-- until its transaction commits. An index built in that transaction would scan the roster with
-- every read and write of it waiting. Here it is its own transaction: the image's runner commits
-- each file on its own (apps/server/src/migrate.ts), so 0041's lock is released before this
-- starts. `pnpm migrate:up` (the CLI) combines pending files into one transaction unless given
-- `--no-single-transaction`.
--
-- ── Locking and cost ──────────────────────────────────────────────────────────
-- A plain CREATE INDEX, not CONCURRENTLY: node-pg-migrate runs a SQL file's Up inside a
-- transaction, where CONCURRENTLY is refused. It holds SHARE on agency_contacts until commit:
-- reads proceed, writes wait while it builds. On the release that adds 0041 every promise_date is
-- NULL (the column is new), so the build is one read of the roster that writes an empty index.
-- Unlike 0039's, it cannot be built beforehand on a database without 0041: the column does not
-- exist yet. Migrations run at container start, before the server listens (docker/entrypoint.sh).
-- `IF NOT EXISTS` all the same, so a database already on 0041 can build it CONCURRENTLY first;
-- the check at the end of Up refuses an invalid index such a failed build leaves under the name
-- (0039's pattern; db-hygiene.md §2) rather than record one the planner never uses.
-- `SET LOCAL lock_timeout = '10s'` first: a lock not granted within 10 s fails the migration (the
-- deploy can be retried) instead of queueing every other query behind the wait.
--
-- ── Down ──────────────────────────────────────────────────────────────────────
-- Drops the index; the promise filter and order go back to reading the campaign's contacts.
--
-- Runs as one node-pg-migrate SQL migration in one transaction; split on the up/down marker
-- comments (see 0001_baseline.sql's header for the regex).

-- Up Migration

-- Fail fast if a straggler connection holds a lock on agency_contacts (db-hygiene.md).
SET LOCAL lock_timeout = '10s';

CREATE INDEX IF NOT EXISTS idx_agency_contacts_promise
  ON agency_contacts (campaign_id, promise_date)
  WHERE promise_date IS NOT NULL;

COMMENT ON INDEX idx_agency_contacts_promise IS
  'Contacts holding a promise to pay, by campaign and promised date: the Contacts list''s promise filter and "Promised for" order (PT6).';

-- An index built with CONCURRENTLY that failed is left invalid under its name, and IF NOT EXISTS
-- would accept it. Fail instead; drop it and build it again (db-hygiene.md §2).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
     WHERE c.relname = 'idx_agency_contacts_promise' AND NOT (i.indisvalid AND i.indisready)
  ) THEN
    RAISE EXCEPTION 'invalid index from an earlier CREATE INDEX CONCURRENTLY: idx_agency_contacts_promise; DROP INDEX CONCURRENTLY and build again';
  END IF;
END
$$;

-- Down Migration

DROP INDEX IF EXISTS idx_agency_contacts_promise;
