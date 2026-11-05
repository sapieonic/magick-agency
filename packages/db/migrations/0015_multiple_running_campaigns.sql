-- 0015_multiple_running_campaigns.sql — several running campaigns per account (docs/decisions.md
-- "Several running campaigns per account", MC4 and MC6).
--
--  1. DROP uq_agency_campaign_running (the baseline's "one running campaign per account"). The
--     account's max_concurrent_calls is shared between its running campaigns by the pacing round
--     (MC1, MC2), and Start / Resume no longer answer 409 another_campaign_running (MC6). Agent
--     exclusivity is unchanged: uq_agency_agent_live_tenant still holds an agent to one live
--     session per tenant.
--
--  2. CREATE idx_agency_contacts_account_live_digits: the claims' busy probe (numberLiveSql in
--     apps/server/src/db/repositories/agency/assignment-sql.ts) now asks "is this number on a
--     call on ANY campaign of the account" (MC4), so a retry child and its parent, or two rosters
--     sharing a number, never ring one customer at once. The probe is
--       live.tenant_id = c.tenant_id AND live.account_id = c.account_id
--       AND <digits of live> = <digits of c> AND live.state IN ('in_flight', 'connected')
--     The key expression is CONTACT_PHONE_DIGITS_SQL (sql-fragments.ts) byte for byte, as
--     idx_agency_contacts_campaign_phone_digits' is: Postgres matches expression indexes
--     structurally, so another spelling of the regex silently costs the index. The predicate is
--     LIVE_STATES_SQL's list, so the probe's `state IN …` implies it. Partial on the two live
--     states, the index holds one entry per live call (plus contacts parked for a write-up), not
--     one per roster row: small whatever the account's rosters hold, and the campaign-scoped
--     digits index cannot serve an account-wide probe.
--
-- ── Locking ─────────────────────────────────────────────────────────────────
-- Plain CREATE INDEX, as in 0003 and 0004: node-pg-migrate runs each SQL file in one transaction,
-- where CONCURRENTLY is not allowed. The build holds a SHARE lock on agency_contacts (writes
-- wait) while it scans the table once; it writes only the few live rows. DROP INDEX takes ACCESS
-- EXCLUSIVE on agency_campaigns, a small table, for a catalog change. Migrations run at container
-- start, before the server listens.
--
-- ── Down ────────────────────────────────────────────────────────────────────
-- Restores the unique index, so it refuses (RAISE, nothing altered: one transaction) while any
-- account has two or more running campaigns; pause or stop all but one of each account's running
-- campaigns first. Then drops the live-digits index. The server code that relies on several
-- running campaigns must be rolled back with it.
--
-- Runs as one node-pg-migrate SQL migration in one transaction; split on the up/down marker
-- comments (see 0001_baseline.sql's header for the regex).

-- Up Migration

DROP INDEX IF EXISTS uq_agency_campaign_running;

CREATE INDEX idx_agency_contacts_account_live_digits
  ON agency_contacts (tenant_id, account_id, regexp_replace(phone_e164, '[^0-9]', '', 'g'))
  WHERE state IN ('in_flight', 'connected');

COMMENT ON INDEX idx_agency_contacts_account_live_digits IS
  'The claims'' busy probe (numberLiveSql): is this number in_flight or connected on any campaign of the account. Key expression byte-identical to CONTACT_PHONE_DIGITS_SQL; predicate equal to LIVE_STATES_SQL.';

-- Down Migration

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM agency_campaigns
     WHERE status = 'running'
     GROUP BY tenant_id, account_id
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION '0015_multiple_running_campaigns down: an account has more than one running campaign; pause or stop all but one per account before rolling back';
  END IF;
END $$;

DROP INDEX IF EXISTS idx_agency_contacts_account_live_digits;

CREATE UNIQUE INDEX uq_agency_campaign_running
  ON agency_campaigns (tenant_id, account_id)
  WHERE status = 'running';
