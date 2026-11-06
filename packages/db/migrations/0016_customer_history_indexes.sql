-- 0016_customer_history_indexes.sql — customer history: search one number across the tenant's
-- campaigns (docs/customer-history.md, decisions CH1–CH12).
--
--  1. CREATE idx_agency_manual_calls_destination: a soft-phone call NOT logged to a campaign has
--     no contact, only destination_e164, and nothing indexed it. The history reads every
--     soft-phone call to the number in the accounts the caller can see, newest first, paged by
--     (created_at, id):
--       WHERE tenant_id = $1 AND account_id = ANY($2) AND destination_e164 = $3
--       ORDER BY created_at DESC, id DESC
--     destination_e164 is written by the soft phone's pre-dial already normalised to E.164
--     (normalizeDialledNumber), the same form the search produces, so an exact match on the
--     column is the match. created_at, id trail the key so each account's slice comes out in
--     keyset order with no sort.
--
-- ── Locking ─────────────────────────────────────────────────────────────────
-- Plain CREATE INDEX, as in 0003, 0004 and 0015: node-pg-migrate runs each SQL file in one
-- transaction, where CONCURRENTLY is not allowed. The build holds a SHARE lock on
-- agency_manual_calls (writes wait) while it scans the table once. Migrations run at container
-- start, before the server listens.
--
-- ── Down ────────────────────────────────────────────────────────────────────
-- Drops the index. Nothing else depends on it; the history's soft-phone read falls back to a
-- scan of the account's soft-phone calls.
--
-- Runs as one node-pg-migrate SQL migration in one transaction; split on the up/down marker
-- comments (see 0001_baseline.sql's header for the regex).

-- Up Migration

CREATE INDEX idx_agency_manual_calls_destination
  ON agency_manual_calls (tenant_id, account_id, destination_e164, created_at DESC, id DESC);

COMMENT ON INDEX idx_agency_manual_calls_destination IS
  'Customer history: every soft-phone call to one number in the accounts the caller can see, logged to a campaign or not, newest first (keyset on created_at, id).';

-- Down Migration

DROP INDEX IF EXISTS idx_agency_manual_calls_destination;
