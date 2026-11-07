-- 0021_carrier_refusing_calls_pause.sql — a campaign whose carrier account keeps refusing its
-- dials (decisions B18–B20, PL11).
--
-- `agency_campaigns.pause_reason` gains `carrier_refusing_calls`: a campaign pinned to a
-- tenant's carrier credential whose dials the carrier refused (any status but 401 and 429), or
-- that could not be sent for the carrier's configuration, several times in a row with no call
-- placed in between, is paused instead of spending the roster on refusals: a destination the
-- account is not enabled for, an account out of credit, a caller ID the carrier rejects.
-- `carrier_auth` (0019) stays the carrier's own 401 and `carrier_account_unavailable` (0020) a
-- credential no longer active.
--
-- Runs as one node-pg-migrate SQL migration in one transaction; split on the up/down
-- marker comments (see 0001_baseline.sql's header for the regex).

-- Up Migration

-- agency_campaigns is small (campaigns, not contacts): a plain re-add scans it under the
-- ACCESS EXCLUSIVE lock the DROP takes anyway, in one transaction.
ALTER TABLE agency_campaigns
  DROP CONSTRAINT ck_agency_campaign_pause_reason,
  ADD CONSTRAINT ck_agency_campaign_pause_reason
    CHECK (pause_reason IS NULL OR pause_reason IN (
      'supervisor', 'abandonment_ceiling', 'carrier_auth', 'carrier_account_unavailable', 'carrier_refusing_calls'
    ));

COMMENT ON COLUMN agency_campaigns.pause_reason IS
  'Why the campaign is paused: supervisor action, the abandonment guardrail, the carrier refusing the campaign''s credential (carrier_auth), the campaign''s carrier credential no longer being active (carrier_account_unavailable), or the carrier refusing the campaign''s dials several times in a row (carrier_refusing_calls). NULL whenever the campaign is not paused.';

-- Down Migration

-- The nearest reason the old CHECK knows: a supervisor pause (still paused; a supervisor
-- resumes it, as this one asks too, and nothing about the credential blocks the resume).
UPDATE agency_campaigns SET pause_reason = 'supervisor' WHERE pause_reason = 'carrier_refusing_calls';
ALTER TABLE agency_campaigns
  DROP CONSTRAINT ck_agency_campaign_pause_reason,
  ADD CONSTRAINT ck_agency_campaign_pause_reason
    CHECK (pause_reason IS NULL OR pause_reason IN ('supervisor', 'abandonment_ceiling', 'carrier_auth', 'carrier_account_unavailable'));
COMMENT ON COLUMN agency_campaigns.pause_reason IS
  'Why the campaign is paused: supervisor action, the abandonment guardrail, the carrier refusing the campaign''s credential (carrier_auth), or the campaign''s carrier credential no longer being active (carrier_account_unavailable). NULL whenever the campaign is not paused.';
