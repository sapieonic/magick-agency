-- 0071_call_settings.sql — one call log per campaign, P3 (docs/call-log.md §5, rulings CL2–CL6,
-- CL8, CL17–CL23): the account's setting "Every call must belong to a campaign", and the campaign
-- an inbound route files its unknown callers under. 0070 is applied and is not edited.
--
-- ── agency_call_settings ────────────────────────────────────────────────────
-- One optional row per (tenant, account) (`uq_agency_call_settings_account`): an account with no
-- row reads as the defaults (the setting off), as agency_softphone_settings does. Its own table, not a column of
-- agency_softphone_settings or account_settings (docs/call-log.md §5 "Where the setting lives"):
-- the rule governs inbound calls as much as the soft phone, and an account may have inbound on
-- with the soft phone off; account_settings is the operator's row (limits, toggles a super admin
-- sets), read through a 60-second cache and written with a concurrency version, and this is an
-- account admin's own switch that every dial reads fresh.
--
--  - `require_campaign` (wire `require_campaign`): the switch. Default false.
--  - `require_campaign_since`: when it was last switched on; NULL while it is off. The server
--    lets a call that began before it finish as it is (CL19), so it is set with the switch and
--    cleared with it (`ck_agency_call_settings_since`).
--  - `updated_by`: the user who last wrote the row. No FK, as the agency tables' actor columns.
--  - No FK to tenants / accounts, as agency_softphone_settings and account_settings have none
--    (BASELINE.md, open question 2).
--
-- ── agency_inbound_routes.default_campaign_id ───────────────────────────────
-- The campaign a caller whose number is on no list is filed under at arrival
-- (`agency_inbound_calls.campaign_id`, `campaign_source = 'route'`; wire "Campaign for unknown
-- callers"). Nullable; the server requires it on a route's create and update while the account's
-- setting is on. No FK, as `pool_campaign_ids` and `analysis_profile_id` on this table: the server
-- checks it names a campaign of the route's account that is not archived.
--
-- `idx_agency_inbound_routes_default_campaign` (default_campaign_id) WHERE it is set on a live
-- route: "is this campaign some route's default" is asked by the pacing leader before it
-- completes a campaign whose list ran out (CL8), by Start on an empty roster, and by the console
-- before a campaign is stopped or archived.
--
-- ── Locking ─────────────────────────────────────────────────────────────────
-- A new, empty table; one ADD COLUMN with no default (no rewrite) and one index on
-- agency_inbound_routes, a table of a few rows per account that the live server reads on every
-- inbound arrival. `SET LOCAL lock_timeout = '10s'` first (db-hygiene.md), so a migration blocked
-- by a straggler fails fast instead of queueing arrivals behind it.
--
-- ── Down ────────────────────────────────────────────────────────────────────
-- Drops the index, the column and the table: the setting and every route's default campaign are
-- lost. Calls already filed keep their `campaign_id` (0069's column). The server code that reads
-- them must be rolled back with it.
--
-- Runs as one node-pg-migrate SQL migration in one transaction; split on the up/down marker
-- comments (see 0001_baseline.sql's header for the regex).

-- Up Migration

SET LOCAL lock_timeout = '10s';

CREATE TABLE agency_call_settings (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               UUID NOT NULL,
  account_id              UUID NOT NULL,
  require_campaign        BOOLEAN NOT NULL DEFAULT false,
  require_campaign_since  TIMESTAMPTZ,
  updated_by              UUID,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT uq_agency_call_settings_account UNIQUE (tenant_id, account_id),
  CONSTRAINT ck_agency_call_settings_since CHECK (require_campaign = (require_campaign_since IS NOT NULL))
);

CREATE TRIGGER trg_agency_call_settings_updated_at
  BEFORE UPDATE ON agency_call_settings
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

COMMENT ON TABLE agency_call_settings IS
  'Per-account call settings (docs/call-log.md §5): whether every call must belong to a campaign. No row = defaults (off).';
COMMENT ON COLUMN agency_call_settings.require_campaign IS
  'Every call must belong to a campaign: the soft phone refuses a dial with none, and an inbound outcome is refused until the call is filed under one.';
COMMENT ON COLUMN agency_call_settings.require_campaign_since IS
  'When require_campaign was last switched on; NULL while off. A call that began before it may finish as it is.';

ALTER TABLE agency_inbound_routes ADD COLUMN default_campaign_id UUID;

COMMENT ON COLUMN agency_inbound_routes.default_campaign_id IS
  'The campaign a caller whose number is on no list is filed under at arrival (agency_inbound_calls.campaign_id, campaign_source = route). NULL: none. No FK; the server checks it is a campaign of the account.';

CREATE INDEX idx_agency_inbound_routes_default_campaign
  ON agency_inbound_routes (default_campaign_id)
  WHERE default_campaign_id IS NOT NULL AND deleted_at IS NULL;

COMMENT ON INDEX idx_agency_inbound_routes_default_campaign IS
  'The live routes that file unknown callers under a campaign: asked before that campaign completes itself, is started empty, stopped or archived (docs/call-log.md §5).';

-- Down Migration

SET LOCAL lock_timeout = '10s';

DROP INDEX IF EXISTS idx_agency_inbound_routes_default_campaign;
ALTER TABLE agency_inbound_routes DROP COLUMN IF EXISTS default_campaign_id;
DROP TABLE IF EXISTS agency_call_settings;
