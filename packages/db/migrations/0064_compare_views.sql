-- 0064_compare_views.sql — Compare agents' saved views (docs/compare-agents.md, rulings CP1–CP18;
-- wire shape `AgencyCompareView`, packages/contracts/src/api/agency/compare.ts). 0063 is applied and
-- is not edited.
--
-- ── agency_compare_views ────────────────────────────────────────────────────
-- One row per saved comparison set-up: a lens, 1 to 6 metric refs and an optional per-day trend
-- ref, personal or shared with the account's supervisors, optionally tied to one campaign and
-- optionally that campaign's default. A view never names agents or a window (those stay in the
-- page's URL), so it holds no personal data beyond its owner's id.
--
--  - `metrics` (JSONB array of AgencyCompareMetricRef: `{kind:'builtin',key}` or
--    `{kind:'outcomes',codes,better,label?}`) and `trend` (one such object, or NULL). Validated by
--    the server against the contract (`compareMetricRefProblem`) and, for a view with a campaign,
--    against that campaign's catalog when written; the CHECKs here hold only the outer shape (an
--    array of 1 to 6 objects; an object or NULL), so a later metric key needs no migration.
--  - `campaign_id`: FK to agency_campaigns ON DELETE CASCADE, the house rule for a campaign's
--    satellite rows (0009, 0012, 0013). Not SET NULL: a view's outcome sets name codes of THAT
--    campaign's catalog, meaningless once it is gone, and a campaign default with no campaign
--    would break `ck_agency_compare_views_default` mid-delete. No code path deletes a campaign
--    today; the cascade states what a delete would mean.
--  - `is_campaign_default`: the page opens the campaign on it. Needs `campaign_id` and `shared`
--    (`ck_agency_compare_views_default`: a default every supervisor lands on must be one they can
--    see). At most one per campaign (`uq_agency_compare_views_campaign_default`); the server clears
--    the old default in the same transaction as it sets the new one, whoever owns the old one.
--  - `owner_user_id`: no FK, as the agency tables' actor columns (`report_subscriptions.created_by`):
--    the row outlives the user, whose name then resolves to null. Only the owner edits or deletes.
--  - `account_id`: the request's context account, no FK, as `agency_campaigns.account_id`. Views
--    are per account; a supervisor sees their own and the account's shared ones.
--  - `updated_at`: no trigger; the repository's one UPDATE sets it (as report_subscriptions).
--  - The per-owner limit (`COMPARE_VIEWS_PER_USER_MAX`, 50) is the server's, checked in the
--    create's transaction; it is a product limit, not an invariant, so no trigger enforces it.
--
-- Indexes: `idx_agency_compare_views_owner` (tenant_id, account_id, owner_user_id, updated_at DESC)
-- for the caller's own views and the limit's count; `idx_agency_compare_views_shared` (tenant_id,
-- account_id, updated_at DESC) WHERE shared for the account's shared ones;
-- `idx_agency_compare_views_campaign` (campaign_id) for the list filtered by campaign and the
-- cascade; the partial unique index above. A small table (a few views per supervisor).
--
-- ── Locking ─────────────────────────────────────────────────────────────────
-- A new, empty table. Its FK takes SHARE ROW EXCLUSIVE on agency_campaigns (which the live server
-- writes) until commit, and its tenant FK the same on tenants: a short transaction, so
-- `SET LOCAL lock_timeout = '10s'` first (db-hygiene.md).
--
-- ── Down ────────────────────────────────────────────────────────────────────
-- Drops the table: every saved view is lost. The server code that reads it must be rolled back
-- with it.
--
-- Runs as one node-pg-migrate SQL migration in one transaction; split on the up/down marker
-- comments (see 0001_baseline.sql's header for the regex).

-- Up Migration

SET LOCAL lock_timeout = '10s';

CREATE TABLE agency_compare_views (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  account_id           UUID NOT NULL,
  owner_user_id        UUID NOT NULL,
  name                 TEXT NOT NULL,
  lens                 VARCHAR(16) NOT NULL,
  metrics              JSONB NOT NULL,
  trend                JSONB,
  campaign_id          UUID REFERENCES agency_campaigns(id) ON DELETE CASCADE,
  shared               BOOLEAN NOT NULL DEFAULT false,
  is_campaign_default  BOOLEAN NOT NULL DEFAULT false,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- COMPARE_VIEW_NAME_MAX (80), already trimmed.
  CONSTRAINT ck_agency_compare_views_name CHECK (
    name = btrim(name) AND char_length(name) BETWEEN 1 AND 80
  ),
  CONSTRAINT ck_agency_compare_views_lens CHECK (lens IN ('collections', 'sales', 'verification')),
  -- COMPARE_MAX_METRICS (6); each element an object. A CASE, not AND: Postgres does not promise to
  -- evaluate AND left to right, and jsonb_array_length raises on a non-array.
  CONSTRAINT ck_agency_compare_views_metrics CHECK (
    CASE WHEN jsonb_typeof(metrics) = 'array'
      THEN jsonb_array_length(metrics) BETWEEN 1 AND 6
           AND NOT jsonb_path_exists(metrics, 'strict $[*] ? (@.type() != "object")')
      ELSE false
    END
  ),
  CONSTRAINT ck_agency_compare_views_trend CHECK (trend IS NULL OR jsonb_typeof(trend) = 'object'),
  CONSTRAINT ck_agency_compare_views_default CHECK (
    NOT is_campaign_default OR (campaign_id IS NOT NULL AND shared)
  )
);

-- At most one default view per campaign.
CREATE UNIQUE INDEX uq_agency_compare_views_campaign_default
  ON agency_compare_views (campaign_id)
  WHERE is_campaign_default;

-- The caller's own views, newest first, and the per-owner limit's count.
CREATE INDEX idx_agency_compare_views_owner
  ON agency_compare_views (tenant_id, account_id, owner_user_id, updated_at DESC);

-- The account's shared views, newest first.
CREATE INDEX idx_agency_compare_views_shared
  ON agency_compare_views (tenant_id, account_id, updated_at DESC)
  WHERE shared;

-- The list filtered by campaign, and the campaign FK's cascade.
CREATE INDEX idx_agency_compare_views_campaign
  ON agency_compare_views (campaign_id)
  WHERE campaign_id IS NOT NULL;

COMMENT ON TABLE agency_compare_views IS
  'Compare agents: saved views (lens, metric refs, trend ref), personal or shared with the account''s supervisors, optionally a campaign''s default (docs/compare-agents.md).';
COMMENT ON COLUMN agency_compare_views.metrics IS
  'JSONB array of 1 to 6 AgencyCompareMetricRef objects (packages/contracts/src/api/agency/compare.ts), validated by the server when written.';
COMMENT ON COLUMN agency_compare_views.trend IS
  'One countable AgencyCompareMetricRef (an outcome set or promises_rate), or NULL for no per-day trend.';
COMMENT ON COLUMN agency_compare_views.is_campaign_default IS
  'The campaign''s default view: needs campaign_id and shared; at most one per campaign (uq_agency_compare_views_campaign_default).';
COMMENT ON COLUMN agency_compare_views.owner_user_id IS
  'The supervisor who saved it; the only one who may edit or delete it. No FK.';

-- Down Migration

SET LOCAL lock_timeout = '10s';

DROP TABLE IF EXISTS agency_compare_views;
