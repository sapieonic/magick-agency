-- 0022_outcome_dispositions.sql — automatic outcomes for unanswered calls (docs/decisions.md,
-- "Automatic outcomes for unanswered calls", OD1–OD8).
--
-- A campaign maps each outcome a call ends with when nobody spoke to the customer (no answer,
-- busy, failed, invalid number, abandoned) to one code of its own disposition catalog. When an
-- attempt ends with a mapped outcome, the dialer stamps that code on the attempt as its automatic
-- outcome, so agents and supervisors reading the call later see what the campaign wants done
-- with it. A label only (OD1): the contact is still routed by the campaign's retry policy.
--
--  - `agency_campaigns.outcome_dispositions`: JSONB object, outcome -> catalog code. `{}` (the
--    default) maps nothing, so every existing campaign behaves as before. The server validates
--    keys and codes (the outcome list is `AGENCY_AUTO_DISPOSITION_OUTCOMES`; each code names a
--    catalog entry that neither suppresses nor is terminal); the column only refuses a non-object.
--  - `agency_call_attempts.auto_disposition_code`: the code stamped when the attempt ended. Kept
--    apart from `disposition_code`, which keeps meaning "a person recorded this": success rate,
--    connect rate, agent outcome counts, the disposition route's replay rule and the wrap-up
--    sweeps all read `disposition_code` and must not see a code nobody chose (OD4). The CHECK
--    holds the column to the mappable outcomes, so a code cannot ride on a conversation.
--
-- ── Locking ───────────────────────────────────────────────────────────────────
-- ADD COLUMN with a constant default (or none) does not rewrite either table (Postgres 11+).
-- The campaigns CHECK scans agency_campaigns once (hundreds of rows per account). The attempts
-- CHECK is added NOT VALID: every existing row is NULL in the new column, so validating it would
-- scan the largest table in the schema under ACCESS EXCLUSIVE to prove nothing; it is enforced
-- on every row written from now on.
--
-- ── Down ────────────────────────────────────────────────────────────────────
-- Drops both columns: every mapping and every stamped automatic outcome is lost (the attempts'
-- outcomes, dispositions and the contacts are untouched). The server code that reads the
-- columns must be rolled back with it.
--
-- Runs as one node-pg-migrate SQL migration in one transaction; split on the up/down marker
-- comments (see 0001_baseline.sql's header for the regex).

-- Up Migration

ALTER TABLE agency_campaigns
  ADD COLUMN outcome_dispositions JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD CONSTRAINT ck_agency_campaign_outcome_dispositions CHECK (jsonb_typeof(outcome_dispositions) = 'object');

COMMENT ON COLUMN agency_campaigns.outcome_dispositions IS
  'Automatic outcomes for unanswered calls: outcome (no_answer|busy|failed|invalid|abandoned) -> a disposition_catalog code stamped on the attempt as auto_disposition_code. A label only; retry_policy still routes the contact. {} maps nothing.';

ALTER TABLE agency_call_attempts
  ADD COLUMN auto_disposition_code VARCHAR(50),
  ADD CONSTRAINT ck_agency_attempt_auto_disposition CHECK (
    auto_disposition_code IS NULL
    -- `outcome IS NOT NULL` spelled out: `NULL IN (...)` is NULL, which a CHECK passes.
    OR (outcome IS NOT NULL AND outcome IN ('no_answer', 'busy', 'failed', 'invalid', 'abandoned'))
  ) NOT VALID;

COMMENT ON COLUMN agency_call_attempts.auto_disposition_code IS
  'The campaign''s automatic outcome for this unanswered attempt (agency_campaigns.outcome_dispositions at the time it ended). Not a write-up: disposition_code is what a person recorded. NULL: none mapped, or not an unanswered outcome.';

-- Down Migration

ALTER TABLE agency_call_attempts
  DROP CONSTRAINT IF EXISTS ck_agency_attempt_auto_disposition,
  DROP COLUMN IF EXISTS auto_disposition_code;

ALTER TABLE agency_campaigns
  DROP CONSTRAINT IF EXISTS ck_agency_campaign_outcome_dispositions,
  DROP COLUMN IF EXISTS outcome_dispositions;
