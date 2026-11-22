-- 0071_inbound_calls_from_index.sql — inbound calls in customer history (docs/call-log.md §8,
-- docs/customer-history.md): an account's inbound calls from one number, newest first.
--
-- idx_agency_inbound_calls_from on agency_inbound_calls
--   (tenant_id, account_id, from_e164, arrived_at DESC, id DESC) WHERE from_e164 IS NOT NULL
-- The customer history's inbound reads (`CUSTOMER_HISTORY_SQL.pageInboundCalls`, and the
-- inbound arms of `callStats`, `pageCallbacks`): an exact match on the caller's number within
-- each visible account, walked in the timeline's keyset order, as
-- `idx_agency_manual_calls_destination` (0016) is for soft-phone calls. Until now the only
-- index by caller was `idx_agency_inbound_calls_answered_from` (0033), which holds the ANSWERED
-- calls alone (the sticky agent's signal), so a number's missed calls were found by reading
-- every ended call of the account. Measured on 2 million inbound calls in 10 accounts
-- (200,000 an account): a number's first page in one account 242 ms before, 0.1 ms after; in
-- all 10 accounts 2,634 ms before, 1.7 ms after; counting a number's 588 calls 158 ms before,
-- 0.9 ms after; a number that never rang 2,476 ms before, 0.1 ms after.
-- Partial: a withheld number (`from_e164` NULL) can never be searched for.
--
-- ── Cost ──────────────────────────────────────────────────────────────────────
-- One more index written on every inbound arrival (178 MB on the 2 million rows above, built
-- in 5 seconds). 0033's index is a subset of this one and is left as it is.
--
-- ── Locking ───────────────────────────────────────────────────────────────────
-- Plain CREATE INDEX, not CONCURRENTLY (refused inside a transaction): it holds SHARE on
-- agency_inbound_calls until commit, and every arrival writes that table. Where the table
-- holds more than about a million rows, build it CONCURRENTLY before the deploy
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

CREATE INDEX IF NOT EXISTS idx_agency_inbound_calls_from
  ON agency_inbound_calls (tenant_id, account_id, from_e164, arrived_at DESC, id DESC)
  WHERE from_e164 IS NOT NULL;

COMMENT ON INDEX idx_agency_inbound_calls_from IS
  'An account''s inbound calls from one number, newest first: the customer history''s inbound rows (docs/customer-history.md).';

DO $$
DECLARE
  bad TEXT;
BEGIN
  SELECT string_agg(c.relname, ', ') INTO bad
    FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
   WHERE c.relname IN ('idx_agency_inbound_calls_from')
     AND NOT (i.indisvalid AND i.indisready);
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'invalid index from an earlier CREATE INDEX CONCURRENTLY: %; DROP INDEX CONCURRENTLY and build again', bad;
  END IF;
END
$$;

-- Down Migration

SET LOCAL lock_timeout = '10s';

DROP INDEX IF EXISTS idx_agency_inbound_calls_from;
