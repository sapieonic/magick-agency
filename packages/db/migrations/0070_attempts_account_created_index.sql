-- 0070_attempts_account_created_index.sql — the account's All calls and the agent's My calls
-- (docs/call-log.md §7): an account's dialler attempts, newest first.
--
-- idx_agency_attempts_account_created on agency_call_attempts
--   (tenant_id, account_id, created_at DESC, id DESC)
-- The dialler branch of the call log read at the account's and at an agent's scope
-- (`listCallLog`): a keyset range on `(created_at, id)` within one account, as
-- `idx_agency_attempts_keyset` is within one campaign and `idx_agency_manual_calls_account` /
-- `idx_agency_inbound_calls_account_arrived` are for the other two types. Until now the only
-- account-leading attempt index was the partial `idx_agency_attempts_account_live` (live
-- attempts), so an account's page was a scan of the whole table and a sort. Measured on 2.2
-- million attempts, 2 million of them one account's: the first page 1,421 ms before, 0.5 ms
-- after; a week's window 251 ms before, 10 ms after; a day's count 242 ms before, 2 ms after.
-- Not partial: an attempt that never dialled is still a row of the list.
--
-- ── Cost ──────────────────────────────────────────────────────────────────────
-- One more index written on every dial (four uuid/timestamp keys, the size of
-- idx_agency_attempts_keyset: 163 MB on the 2.2 million rows above).
--
-- ── Locking ───────────────────────────────────────────────────────────────────
-- Plain CREATE INDEX, not CONCURRENTLY (refused inside a transaction): it holds SHARE on
-- agency_call_attempts until commit, and the dialer writes that table on every dial. Where the
-- table holds more than about a million rows, build it CONCURRENTLY before the deploy
-- (db-hygiene.md §2 has the statement); `IF NOT EXISTS` then finds it. The check at the end of
-- Up refuses an invalid index a failed concurrent build leaves under the name.
-- `SET LOCAL lock_timeout = '10s'` first.
--
-- ── Down ──────────────────────────────────────────────────────────────────────
-- Drops the index; the reads fall back to other plans (correct, slower).
--
-- Runs as one node-pg-migrate SQL migration in one transaction; split on the up/down marker
-- comments (see 0001_baseline.sql's header for the regex).

-- Up Migration

SET LOCAL lock_timeout = '10s';

CREATE INDEX IF NOT EXISTS idx_agency_attempts_account_created
  ON agency_call_attempts (tenant_id, account_id, created_at DESC, id DESC);

COMMENT ON INDEX idx_agency_attempts_account_created IS
  'An account''s dialler attempts, newest first: the dialler branch of All calls and My calls (docs/call-log.md).';

DO $$
DECLARE
  bad TEXT;
BEGIN
  SELECT string_agg(c.relname, ', ') INTO bad
    FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
   WHERE c.relname IN ('idx_agency_attempts_account_created')
     AND NOT (i.indisvalid AND i.indisready);
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'invalid index from an earlier CREATE INDEX CONCURRENTLY: %; DROP INDEX CONCURRENTLY and build again', bad;
  END IF;
END
$$;

-- Down Migration

SET LOCAL lock_timeout = '10s';

DROP INDEX IF EXISTS idx_agency_attempts_account_created;
