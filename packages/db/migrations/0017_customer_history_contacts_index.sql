-- 0017_customer_history_contacts_index.sql — customer history: bound every read to the newest
-- roster rows of the number (docs/customer-history.md, CH9 and CH14).
--
--  1. CREATE idx_agency_contacts_customer_history: a placeholder number pasted down a roster
--     (9999999999 on 200,000 rows) made every customer-history read O(roster rows): the summary
--     was capped at 2,000 rows, but the call aggregates, the newest placed call, the live calls,
--     every timeline page and the export read every roster row of the number, then every attempt
--     of each. The history now covers the number's newest 2,000 roster rows in the visible
--     accounts (CUSTOMER_HISTORY_MAX_CONTACT_ROWS), chosen by walking this index once per visible
--     account, newest first, and stopping at the cap:
--       WHERE tenant_id = $1 AND account_id = <one account> AND phone_e164 = $2
--       ORDER BY created_at DESC, id DESC LIMIT 2000
--     (newestContacts in apps/server/src/db/repositories/agency/customer-history.repository.ts).
--     created_at, id trail the key so each account's slice comes out newest first and the LIMIT
--     stops the walk: no sort of every match. campaign_id is INCLUDEd so the walk, which needs
--     only id, campaign_id and created_at, can be answered from the index where the visibility
--     map allows. idx_agency_contacts_phone (tenant_id, phone_e164) stays: the DNC sweeps and the
--     dialer's cross-campaign lookups use it.
--
-- ── Locking ─────────────────────────────────────────────────────────────────
-- Plain CREATE INDEX, as in 0003, 0004, 0015 and 0016: node-pg-migrate runs each SQL file in one
-- transaction, where CONCURRENTLY is not allowed. The build holds a SHARE lock on
-- agency_contacts (writes wait) while it scans the table once. Migrations run at container
-- start, before the server listens.
--
-- ── Down ────────────────────────────────────────────────────────────────────
-- Drops the index. Nothing else depends on it; the history's contact walk falls back to
-- idx_agency_contacts_phone and a sort of the number's roster rows.
--
-- Runs as one node-pg-migrate SQL migration in one transaction; split on the up/down marker
-- comments (see 0001_baseline.sql's header for the regex).

-- Up Migration

CREATE INDEX idx_agency_contacts_customer_history
  ON agency_contacts (tenant_id, account_id, phone_e164, created_at DESC, id DESC)
  INCLUDE (campaign_id);

COMMENT ON INDEX idx_agency_contacts_customer_history IS
  'Customer history: one number''s newest roster rows per visible account, walked newest first and stopped at the cap (CUSTOMER_HISTORY_MAX_CONTACT_ROWS).';

-- Down Migration

DROP INDEX IF EXISTS idx_agency_contacts_customer_history;
