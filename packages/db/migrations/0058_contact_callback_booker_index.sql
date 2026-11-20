-- 0058_contact_callback_booker_index.sql — the agent's own call-later list's index, and the
-- validation of 0057's CHECK, built out of 0057's ACCESS EXCLUSIVE (0041 / 0045's split, 0009 /
-- 0010's for the CHECK).
--
-- ── Index ─────────────────────────────────────────────────────────────────────
-- idx_agency_contacts_my_callbacks on agency_contacts
--   (campaign_id, callback_booked_by_user_id, next_attempt_at)
--   WHERE state = 'pending' AND callback_booked_by_user_id IS NOT NULL
-- My day's call-later list (`GET /proxy/agency/my-day`, BE-3) reads one agent's pending booked
-- call-laters on one campaign, by due time: an equality on the first two columns and a range on the
-- third. Partial, so it is the size of the open call-laters with a recorded booker, not of the
-- rosters. The read repeats the predicate byte for byte, so the planner proves the index applies.
-- The other half of the list (on `strict` / `preferred`, the call-laters assigned to the agent) is
-- read through the existing owner indexes.
--
-- ── ck_agency_contact_callback_booked ─────────────────────────────────────────
-- VALIDATE CONSTRAINT: every row written since 0057 was already checked, and both columns are NULL
-- on every older row, so validation cannot fail. Afterwards pg_constraint.convalidated is true.
--
-- ── Locking and cost ──────────────────────────────────────────────────────────
-- Its own transaction: the image's runner commits each file on its own (apps/server/src/
-- migrate.ts), so 0057's ACCESS EXCLUSIVE is released before this starts. `pnpm migrate:up` (the
-- CLI) combines pending files into one transaction unless given `--no-single-transaction`.
-- A plain CREATE INDEX, not CONCURRENTLY: node-pg-migrate runs a SQL file's Up inside a transaction,
-- where CONCURRENTLY is refused. It holds SHARE on agency_contacts until commit: reads proceed,
-- writes wait while it builds. On the release that adds 0057 every callback_booked_by_user_id is
-- NULL (the column is new), so the build is one read of the roster that writes an empty index, and
-- VALIDATE reads it once more (SHARE UPDATE EXCLUSIVE, which this transaction's SHARE already
-- covers). Unlike 0053's, it cannot be built beforehand on a database without 0057: the column does
-- not exist yet. `IF NOT EXISTS` all the same, so a database already on 0057 can build it
-- CONCURRENTLY first (db-hygiene.md §2); the check at the end of Up refuses an invalid index such a
-- failed build leaves under the name rather than record one the planner never uses.
-- `SET LOCAL lock_timeout = '10s'` first: a lock not granted within 10 s fails the migration (the
-- deploy can be retried) instead of queueing the dialler's writes behind the wait.
--
-- ── Down ──────────────────────────────────────────────────────────────────────
-- Drops the index; the list falls back to the dialable index (correct, slower). A validated CHECK
-- cannot be marked NOT VALID again, and need not be: 0057's Down drops it. DROP INDEX takes ACCESS
-- EXCLUSIVE on agency_contacts, so the same `SET LOCAL lock_timeout = '10s'` first.
--
-- Runs as one node-pg-migrate SQL migration in one transaction; split on the up/down marker
-- comments (see 0001_baseline.sql's header for the regex).

-- Up Migration

-- Fail fast if a straggler connection holds a lock on agency_contacts (db-hygiene.md).
SET LOCAL lock_timeout = '10s';

CREATE INDEX IF NOT EXISTS idx_agency_contacts_my_callbacks
  ON agency_contacts (campaign_id, callback_booked_by_user_id, next_attempt_at)
  WHERE state = 'pending' AND callback_booked_by_user_id IS NOT NULL;

COMMENT ON INDEX idx_agency_contacts_my_callbacks IS
  'An agent''s pending booked call-laters on a campaign, by due time: My day''s call-later list (agent station BE-3).';

-- An index built beforehand with CONCURRENTLY that failed is left invalid under its name, and
-- IF NOT EXISTS would accept it. Fail instead; drop it and build it again (db-hygiene.md §2).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
     WHERE c.relname = 'idx_agency_contacts_my_callbacks' AND NOT (i.indisvalid AND i.indisready)
  ) THEN
    RAISE EXCEPTION 'invalid index from an earlier CREATE INDEX CONCURRENTLY: idx_agency_contacts_my_callbacks; DROP INDEX CONCURRENTLY and build again';
  END IF;
END
$$;

ALTER TABLE agency_contacts VALIDATE CONSTRAINT ck_agency_contact_callback_booked;

-- Down Migration

SET LOCAL lock_timeout = '10s';

DROP INDEX IF EXISTS idx_agency_contacts_my_callbacks;
