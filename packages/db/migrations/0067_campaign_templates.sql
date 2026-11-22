-- 0067_campaign_templates.sql — campaign templates (docs/campaign-templates.md, rulings CT1–CT18; wire
-- shapes in packages/contracts/src/api/agency/campaign-templates.ts, the section map in
-- packages/contracts/src/agency/campaign-template-sections.ts). 0066 is applied and is not edited.
--
-- ── agency_campaign_templates (new) ─────────────────────────────────────────
-- One row per named template: an ORGANISATION template (`account_id` NULL), shared by every account
-- of the tenant, or one ACCOUNT's. Several per scope (CT10), at most one live default per scope.
--
--  - `tenant_id`, `account_id`: no foreign key, as `account_settings` and
--    `agency_softphone_settings` (BASELINE.md open question 2). Every statement names the tenant, and
--    an account template's account.
--  - `name` (1–80, trimmed, no control or invisible format characters: the server's rule, CT13) and
--    `description` (at most 280). Unique among the scope's LIVE templates ignoring case and repeated
--    spaces: checked by the write's transaction under a lock on the scope, not by an index, because
--    the rule folds case and spaces the way the server's account-name rule does (CT13).
--  - `based_on_template_id`: an account template may follow one organisation template (CT10); NULL
--    follows the organisation's default, whichever that is when a campaign is made. Self-reference
--    with no cascade: templates are archived, never deleted (CT14). An organisation template is never
--    based on another (`ck_agency_campaign_templates_based_on`); that it names an organisation
--    template of the same tenant is the server's check.
--  - `sections`: JSONB object keyed by section (`AGENCY_CAMPAIGN_TEMPLATE_SECTIONS`); an absent key
--    is a section the template leaves to the next level of the chain (CT2). Each section is checked
--    as a campaign create checks it before it is written (CT4); the CHECK holds only the outer shape,
--    so a new section needs no migration.
--  - `is_default`: the scope's default template, at most one LIVE one per scope
--    (`uq_agency_campaign_templates_default`, NULLS NOT DISTINCT so the organisation scope, whose
--    account_id is NULL, is one scope). Archiving the default clears it (CT14).
--  - `version`: bumped by every save of the content, in the same transaction as its
--    `agency_campaign_template_versions` row (CT6). A save sends the version it read; another save in
--    between is refused.
--  - `created_by`, `updated_by`, `archived_by`: the public layer's user ids, no FK (as the agency
--    tables' actor columns). `updated_at`: no trigger; the repository's content writes set it, so a
--    default or archive change does not read as an edit.
--  - `archived_at`: a template is archived, never deleted (CT14), so a campaign's `template_source`
--    still opens it and its versions.
--
-- Indexes: `uq_agency_campaign_templates_default` above; `idx_agency_campaign_templates_scope`
-- (tenant_id, account_id) WHERE live: the list, the name check and the in-use check (CT14), which
-- reads the tenant's live templates. A small table: a few templates per account.
--
-- ── agency_campaign_template_versions (new) ─────────────────────────────────
-- Every saved state of a template (CT6): its name, based-on and sections at `version`, who saved it
-- and when. Written in the transaction that bumps the template's version, version 1 included.
-- Primary key (template_id, version). ON DELETE CASCADE with the template, though templates are not
-- deleted.
--
-- ── agency_campaigns.template_source (new) ──────────────────────────────────
-- The template a campaign was made from, as it was then, and where each section came from (CT9,
-- `AgencyCampaignTemplateSource`): a record, never read at run time (CT1). NULL: made without a
-- template (before the feature, with it off, or a retry campaign, CT7).
--
-- ── Locking ─────────────────────────────────────────────────────────────────
-- The two tables are new and empty. ADD COLUMN with no default is catalog-only, but takes ACCESS
-- EXCLUSIVE on agency_campaigns, which the live server writes: the Up starts with a lock timeout
-- (db-hygiene.md).
--
-- ── Down ────────────────────────────────────────────────────────────────────
-- Drops the column and both tables: every template, its history and every campaign's record of the
-- template it was made from are lost (the campaigns' own settings are not: they are copies, CT1). The
-- server code that reads them must be rolled back with it.
--
-- Runs as one node-pg-migrate SQL migration in one transaction; split on the up/down marker
-- comments (see 0001_baseline.sql's header for the regex).

-- Up Migration

SET LOCAL lock_timeout = '10s';

CREATE TABLE agency_campaign_templates (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             UUID NOT NULL,
  account_id            UUID,
  name                  VARCHAR(80) NOT NULL,
  description           VARCHAR(280),
  based_on_template_id  UUID REFERENCES agency_campaign_templates(id),
  sections              JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_default            BOOLEAN NOT NULL DEFAULT false,
  version               INTEGER NOT NULL DEFAULT 1,
  created_by            UUID,
  updated_by            UUID,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived_at           TIMESTAMPTZ,
  archived_by           UUID,
  CONSTRAINT ck_agency_campaign_templates_sections CHECK (jsonb_typeof(sections) = 'object'),
  CONSTRAINT ck_agency_campaign_templates_based_on CHECK (account_id IS NOT NULL OR based_on_template_id IS NULL)
);

-- One live default per scope; the organisation scope (account_id NULL) is one scope.
CREATE UNIQUE INDEX uq_agency_campaign_templates_default
  ON agency_campaign_templates (tenant_id, account_id) NULLS NOT DISTINCT
  WHERE is_default AND archived_at IS NULL;

-- A scope's live templates: the list and the name check.
CREATE INDEX idx_agency_campaign_templates_scope
  ON agency_campaign_templates (tenant_id, account_id)
  WHERE archived_at IS NULL;

COMMENT ON TABLE agency_campaign_templates IS
  'Campaign templates: named organisation (account_id NULL) and account templates that fill in New campaign, section by section (docs/campaign-templates.md).';
COMMENT ON COLUMN agency_campaign_templates.account_id IS
  'The account of an account template; NULL for an organisation template, shared by every account of the tenant. No FK.';
COMMENT ON COLUMN agency_campaign_templates.based_on_template_id IS
  'Account templates only: the organisation template it follows (CT10). NULL follows the organisation''s default.';
COMMENT ON COLUMN agency_campaign_templates.sections IS
  'JSONB object keyed by section (AGENCY_CAMPAIGN_TEMPLATE_SECTIONS, packages/contracts); an absent key follows the next level (CT2). Checked by the server as a campaign create checks it.';
COMMENT ON COLUMN agency_campaign_templates.is_default IS
  'The scope''s default template: at most one live one per scope (uq_agency_campaign_templates_default). Cleared on archive.';
COMMENT ON COLUMN agency_campaign_templates.version IS
  'Bumped by every content save, with its agency_campaign_template_versions row in the same transaction (CT6).';
COMMENT ON COLUMN agency_campaign_templates.archived_at IS
  'When it was archived (CT14), or NULL. Archived templates are kept with their versions; never deleted.';

CREATE TABLE agency_campaign_template_versions (
  template_id           UUID NOT NULL REFERENCES agency_campaign_templates(id) ON DELETE CASCADE,
  version               INTEGER NOT NULL,
  name                  VARCHAR(80) NOT NULL,
  based_on_template_id  UUID,
  sections              JSONB NOT NULL,
  saved_by              UUID,
  saved_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (template_id, version)
);

COMMENT ON TABLE agency_campaign_template_versions IS
  'Every saved state of a campaign template (CT6): name, based-on and sections at that version, who saved it and when.';

ALTER TABLE agency_campaigns ADD COLUMN IF NOT EXISTS template_source JSONB;

COMMENT ON COLUMN agency_campaigns.template_source IS
  'The template it was made from and where each section came from (CT9, AgencyCampaignTemplateSource). A record, never read at run time. NULL: made without a template.';

-- Down Migration

SET LOCAL lock_timeout = '10s';

ALTER TABLE agency_campaigns DROP COLUMN IF EXISTS template_source;
DROP TABLE IF EXISTS agency_campaign_template_versions;
DROP TABLE IF EXISTS agency_campaign_templates;
