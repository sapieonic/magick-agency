-- 0056_campaign_station_settings.sql — the agent station redesign's campaign settings
-- (docs/agent-station.md: BE-2 / AS6 the daily target, BE-8 the script, AS9 the number display).
-- 0055 is applied and is not edited.
--
-- ── agency_campaigns (new columns) ────────────────────────────────────────────
-- daily_target_calls INTEGER NULL      the day's target for each agent, in connected calls
--                                      (conversations), 1 to 2000
--                                      (AGENCY_DAILY_TARGET_CALLS_MIN / _MAX); NULL: no target
--                                      (My day shows no bar; null is not zero). Served on the
--                                      campaign and in GET /proxy/agency/my-day, not on the
--                                      bootstrap (a supervisor may change it mid-shift).
-- agent_script JSONB NOT NULL '{}'     the campaign's script: { opening?, steps?: [{ text }] }
--                                      (AgencyAgentScript). '{}' is no script. The CHECK holds it
--                                      to an object; the campaign-config write holds the rest
--                                      (at most 12 steps, the lengths, the placeholders). Served on
--                                      the session bootstrap (`script`) when not empty.
-- phone_display VARCHAR(10) NOT NULL   'full' (the default, today's behaviour) or 'masked': how
--   DEFAULT 'full'                     the station shows the customer's number (AgencyPhoneDisplay).
--                                      A display choice: the number is still on the wire.
--
-- ── Locking ───────────────────────────────────────────────────────────────────
-- ADD COLUMN with no default (daily_target_calls) or a constant default (the other two) is
-- catalog-only on Postgres 11+, no rewrite; the CHECKs, validated, read the table once. All under
-- ACCESS EXCLUSIVE on agency_campaigns, which the live server writes, for the moment it takes: the
-- table is small (a row per campaign). The Up starts with a lock timeout (db-hygiene.md).
--
-- ── Down ──────────────────────────────────────────────────────────────────────
-- Drops the three columns with their CHECKs: targets, scripts and the display choice go with them
-- (a release before this one has none).
--
-- Runs as one node-pg-migrate SQL migration in one transaction; split on the up/down marker
-- comments (see 0001_baseline.sql's header for the regex).

-- Up Migration

SET LOCAL lock_timeout = '10s';

ALTER TABLE agency_campaigns
  ADD COLUMN IF NOT EXISTS daily_target_calls INTEGER,
  ADD COLUMN IF NOT EXISTS agent_script JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS phone_display VARCHAR(10) NOT NULL DEFAULT 'full';

ALTER TABLE agency_campaigns
  ADD CONSTRAINT ck_agency_campaign_daily_target_calls
    CHECK (daily_target_calls IS NULL OR daily_target_calls BETWEEN 1 AND 2000),
  ADD CONSTRAINT ck_agency_campaign_agent_script
    CHECK (jsonb_typeof(agent_script) = 'object'),
  ADD CONSTRAINT ck_agency_campaign_phone_display
    CHECK (phone_display IN ('full', 'masked'));

COMMENT ON COLUMN agency_campaigns.daily_target_calls IS
  'Agent station (BE-2, AS6): each agent''s daily target in connected calls (conversations), 1 to 2000. NULL: no target.';
COMMENT ON COLUMN agency_campaigns.agent_script IS
  'Agent station (BE-8): the agents'' script, { opening?, steps?: [{ text }] } (AgencyAgentScript). ''{}'': no script. Served on the session bootstrap.';
COMMENT ON COLUMN agency_campaigns.phone_display IS
  'Agent station (AS9): how the station shows the customer''s number, full or masked. A display choice: the number is still sent.';

-- Down Migration

SET LOCAL lock_timeout = '10s';

ALTER TABLE agency_campaigns
  DROP COLUMN IF EXISTS phone_display,
  DROP COLUMN IF EXISTS agent_script,
  DROP COLUMN IF EXISTS daily_target_calls;
