-- 0019_carrier_account_unavailable_pause.sql — a campaign whose carrier account went away
-- (decisions B18–B20).
--
-- `agency_campaigns.pause_reason` gains `carrier_account_unavailable`: a campaign pinned to a
-- tenant's carrier credential that was disabled, marked invalid, revoked or could no longer
-- be opened after the campaign started is paused on its first dial refused for that reason
-- (the bridge's `telephony_credential_unavailable`), instead of holding each contact and
-- cycling the roster through refusals. `carrier_auth` (0018) stays the carrier's own 401.
--
-- Runs as one node-pg-migrate SQL migration in one transaction; split on the up/down
-- marker comments (see 0001_baseline.sql's header for the regex).

-- Up Migration

-- agency_campaigns is small (campaigns, not contacts): a plain re-add scans it under the
-- ACCESS EXCLUSIVE lock the DROP takes anyway, in one transaction.
ALTER TABLE agency_campaigns
  DROP CONSTRAINT ck_agency_campaign_pause_reason,
  ADD CONSTRAINT ck_agency_campaign_pause_reason
    CHECK (pause_reason IS NULL OR pause_reason IN ('supervisor', 'abandonment_ceiling', 'carrier_auth', 'carrier_account_unavailable'));

COMMENT ON COLUMN agency_campaigns.pause_reason IS
  'Why the campaign is paused: supervisor action, the abandonment guardrail, the carrier refusing the campaign''s credential (carrier_auth), or the campaign''s carrier credential no longer being active (carrier_account_unavailable). NULL whenever the campaign is not paused.';

-- Down Migration

-- The nearest reason the old CHECK knows: a carrier-account pause, which a supervisor
-- resumes once the credential is active again, as this one asks too.
UPDATE agency_campaigns SET pause_reason = 'carrier_auth' WHERE pause_reason = 'carrier_account_unavailable';
ALTER TABLE agency_campaigns
  DROP CONSTRAINT ck_agency_campaign_pause_reason,
  ADD CONSTRAINT ck_agency_campaign_pause_reason
    CHECK (pause_reason IS NULL OR pause_reason IN ('supervisor', 'abandonment_ceiling', 'carrier_auth'));
COMMENT ON COLUMN agency_campaigns.pause_reason IS
  'Why the campaign is paused: supervisor action, the abandonment guardrail, or the carrier refusing the campaign''s credential (carrier_auth). NULL whenever the campaign is not paused.';
