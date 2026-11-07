-- 0018_plivo_numbers_and_carrier_pause.sql — the Plivo dial path's schema (decisions B18–B22).
--
-- 1. Activates the `plivo` provider row 0002 seeded inactive: numbers, concurrency
--    allocations and campaigns may now name it.
-- 2. `phone_numbers.telephony_credential_id`: a number synced from a tenant's own carrier
--    account names the credential it was synced from. NULL = a number on the service's
--    own account (every number before this migration).
-- 3. `agency_campaigns.pause_reason` gains `carrier_auth`: a campaign the carrier refused
--    to dial for (its credential was rejected) is paused with that reason.
--
-- Runs as one node-pg-migrate SQL migration in one transaction; split on the up/down
-- marker comments (see 0001_baseline.sql's header for the regex).

-- Up Migration

UPDATE telephony_providers SET status = 'active' WHERE name = 'plivo';

-- A plain FK, not a composite one. `phone_numbers` names its carrier by `provider_id`
-- (the provider row's uuid) while a credential names it by `provider` (the name), and it
-- has no tenant column (tenancy is `tenant_phone_assignments`), so no key of
-- `telephony_credentials` matches a column set of this table without a denormalised copy.
-- The sync writes the number's `provider_id` from the credential's provider in the same
-- statement that pins it, and nothing else writes the column. Credentials are never
-- deleted (revoked only), so RESTRICT never fires in practice.
ALTER TABLE phone_numbers
  ADD COLUMN telephony_credential_id UUID
    CONSTRAINT fk_phone_numbers_telephony_credential
    REFERENCES telephony_credentials (id) ON DELETE RESTRICT;

-- The sync reads a credential's numbers; campaign validation checks a caller ID is one of them.
CREATE INDEX idx_phone_numbers_telephony_credential
  ON phone_numbers (telephony_credential_id)
  WHERE telephony_credential_id IS NOT NULL;

COMMENT ON COLUMN phone_numbers.telephony_credential_id IS
  'The tenant carrier credential this number was synced from (BYOC, B18). NULL = the service''s own account.';

-- agency_campaigns is small (campaigns, not contacts): a plain re-add scans it under the
-- ACCESS EXCLUSIVE lock the DROP takes anyway, in one transaction.
ALTER TABLE agency_campaigns
  DROP CONSTRAINT ck_agency_campaign_pause_reason,
  ADD CONSTRAINT ck_agency_campaign_pause_reason
    CHECK (pause_reason IS NULL OR pause_reason IN ('supervisor', 'abandonment_ceiling', 'carrier_auth'));

COMMENT ON COLUMN agency_campaigns.pause_reason IS
  'Why the campaign is paused: supervisor action, the abandonment guardrail, or the carrier refusing the campaign''s credential (carrier_auth). NULL whenever the campaign is not paused.';

-- Down Migration

-- A carrier-auth pause reads as a supervisor pause under the old CHECK: the campaign
-- stays paused and a supervisor resumes it, which is what carrier_auth asks for too.
UPDATE agency_campaigns SET pause_reason = 'supervisor' WHERE pause_reason = 'carrier_auth';
ALTER TABLE agency_campaigns
  DROP CONSTRAINT ck_agency_campaign_pause_reason,
  ADD CONSTRAINT ck_agency_campaign_pause_reason
    CHECK (pause_reason IS NULL OR pause_reason IN ('supervisor', 'abandonment_ceiling'));
COMMENT ON COLUMN agency_campaigns.pause_reason IS
  'Why the campaign is paused: supervisor action, or the abandonment guardrail. NULL whenever the campaign is not paused.';

-- Synced numbers stay (they may be assigned, and calls name them as caller IDs); they
-- lose only the link to their credential.
DROP INDEX IF EXISTS idx_phone_numbers_telephony_credential;
ALTER TABLE phone_numbers DROP COLUMN IF EXISTS telephony_credential_id;

UPDATE telephony_providers SET status = 'inactive' WHERE name = 'plivo';
