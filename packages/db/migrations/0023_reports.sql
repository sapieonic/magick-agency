-- 0023_reports.sql — agent, campaign and account reports: runs, subscriptions and the agent-first
-- sessions index the agent review needs (docs/reports.md, decisions RP1–RP16).
--
-- ── report_runs ─────────────────────────────────────────────────────────────
-- One row per report run: a PDF and/or an Excel workbook about one SUBJECT (the agent's user id,
-- the campaign id or the account id, by `kind`) over one window, built outside the request.
-- Written and read by `apps/server/src/db/repositories/agency/report-run.repository.ts`.
--
--  - Lifecycle (`status`): queued → assembling (the server builds the dataset) → rendering (the
--    renderer builds the files) → ready | failed; a ready run turns expired at `expires_at`
--    (RP8). The row is kept after expiry as a record; only the files go (S3 lifecycle).
--  - The window is stored twice: the local dates the request named (`local_from`, `local_to`,
--    both inclusive, in `timezone`) and the half-open instant window the server reads
--    (`range_from`, `range_to`) = [local midnight of local_from, local midnight after local_to).
--    `ck_report_runs_window` holds the instant window to 31 days plus one hour (RP2: a 31-day
--    month in a zone whose clocks go back in it is 31 × 24 + 1 hours long); the request rule is
--    the tighter, calendar one and always fits inside it.
--  - `claim_generation`, `claimed_at`: the assembler's claim (MATERIALIZED + SKIP LOCKED). Every
--    write the assembler makes after its claim is fenced on the generation it claimed, so an
--    assembler that stalled past the stale cutoff and was reclaimed cannot write over the new
--    owner's result.
--  - `render_attempt`, `sent_at`: each send to the renderer bumps the attempt; the render
--    callback is applied only when its attempt is the row's current one and the row is still
--    rendering (RP13 fencing), so a late callback from a superseded send is acknowledged and
--    ignored.
--  - `dataset_key`, `detail_files` (JSONB array of ReportDetailFile), `files` (JSONB array of
--    {format, key, bytes}, empty until ready), `truncated` (RP12), `renderer_version` (the
--    callback's, for diagnosis), `error_code` / `error_message` (failed only).
--  - `subscription_id`, `period_start`: set together for a subscription's run, NULL for an ad
--    hoc one. No FK: deleting a subscription keeps the runs it produced, and they still name it
--    (the history filters by it). `uq_report_runs_subscription_period` is the backstop that
--    makes one run per (subscription, period) (RP14) whatever the tick does.
--  - `requested_by` (and `report_subscriptions.created_by`): user ids with no FK, as the agency
--    tables' actor columns: the record outlives the user, whose name then resolves to null.
--  - `account_id`: the request's context account, no FK, as `agency_campaigns.account_id`.
--    Nullable for a run not scoped to one account; v1 never writes one.
--  - `notified_at`: the "report ready" email was handled. Only runs that email anyone are
--    waited on (`email_me`, or a subscription's run), so the partial index holds just those.
--
-- ── report_subscriptions ────────────────────────────────────────────────────
-- A schedule that produces one run per period (RP14): daily, weekly on `send_weekday` (ISO,
-- Monday 1), monthly on `send_monthday` (1–28, so every month has the day), at
-- `send_local_time` in `timezone`. `next_run_at` is the next send, NULL exactly when disabled
-- (`ck_report_subscriptions_enabled`); the server computes it (`agency/reports/schedule.ts`).
-- `recipient_user_ids`: 1–20 tenant members, re-checked against RBAC at send time (RP4).
-- No `updated_at` trigger: the repository's one UPDATE sets it.
--
-- ── Agent-first read index ──────────────────────────────────────────────────
-- The agent review reads one agent's sessions across every campaign of the account;
-- agency_agent_sessions was indexed for live sessions only (left_at IS NULL), so that read scanned
-- every session: idx_agency_agent_sessions_agent (agent_user_id, joined_at). No agent-first index
-- on agency_insights_rollup_agents: the review takes its call figures from the agent record's
-- attempt reads, not the rollup, and such an index draws the allocation counters' plan
-- (campaign-first by design, insights-reads.test.ts) off the unique index.
--
-- ── Locking ─────────────────────────────────────────────────────────────────
-- Two new, empty tables. The sessions index is a plain CREATE INDEX, as in 0003, 0004, 0015, 0016
-- and 0017: node-pg-migrate runs each SQL file in one transaction, where CONCURRENTLY is not
-- allowed. The build holds a SHARE lock on the table (writes wait) while it scans it once.
-- Migrations run at container start, before the server listens.
--
-- ── Down ────────────────────────────────────────────────────────────────────
-- Drops the index and both tables: every run record and subscription is lost (rendered files
-- stay in S3 until their lifecycle expires them). The server code that reads the tables must be
-- rolled back with it.
--
-- Runs as one node-pg-migrate SQL migration in one transaction; split on the up/down marker
-- comments (see 0001_baseline.sql's header for the regex).

-- Up Migration

CREATE TABLE report_subscriptions (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  account_id          UUID,
  kind                VARCHAR(16) NOT NULL,
  subject_id          UUID NOT NULL,
  cadence             VARCHAR(16) NOT NULL,
  send_local_time     TIME(0) NOT NULL,
  send_weekday        SMALLINT,
  send_monthday       SMALLINT,
  timezone            TEXT NOT NULL,
  formats             TEXT[] NOT NULL,
  recipient_user_ids  UUID[] NOT NULL,
  enabled             BOOLEAN NOT NULL DEFAULT true,
  next_run_at         TIMESTAMPTZ,
  created_by          UUID NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ck_report_subscriptions_kind CHECK (kind IN ('agent', 'campaign', 'account')),
  CONSTRAINT ck_report_subscriptions_cadence CHECK (cadence IN ('daily', 'weekly', 'monthly')),
  -- The day field of its cadence, and only that one.
  CONSTRAINT ck_report_subscriptions_days CHECK (
    (send_weekday IS NOT NULL) = (cadence = 'weekly')
    AND (send_monthday IS NOT NULL) = (cadence = 'monthly')
    AND (send_weekday IS NULL OR send_weekday BETWEEN 1 AND 7)
    AND (send_monthday IS NULL OR send_monthday BETWEEN 1 AND 28)
  ),
  CONSTRAINT ck_report_subscriptions_formats CHECK (
    cardinality(formats) >= 1 AND formats <@ ARRAY['pdf', 'xlsx']::text[]
  ),
  CONSTRAINT ck_report_subscriptions_recipients CHECK (cardinality(recipient_user_ids) BETWEEN 1 AND 20),
  CONSTRAINT ck_report_subscriptions_timezone CHECK (timezone <> '' AND timezone = btrim(timezone)),
  CONSTRAINT ck_report_subscriptions_enabled CHECK (enabled = (next_run_at IS NOT NULL))
);

-- The tick's due read: WHERE enabled AND next_run_at <= now() ORDER BY next_run_at.
CREATE INDEX idx_report_subscriptions_due
  ON report_subscriptions (next_run_at)
  WHERE enabled;

-- The account's subscriptions, newest first.
CREATE INDEX idx_report_subscriptions_account
  ON report_subscriptions (tenant_id, account_id, created_at DESC, id DESC);

COMMENT ON TABLE report_subscriptions IS
  'Report schedules (RP14): one report_runs row per (subscription, period), daily, weekly or monthly at send_local_time in timezone, emailed to recipient_user_ids as a console link (RP6).';
COMMENT ON COLUMN report_subscriptions.subject_id IS
  'The agent user id, campaign id or account id, by kind. No FK.';
COMMENT ON COLUMN report_subscriptions.next_run_at IS
  'The next send instant (agency/reports/schedule.ts nextRunAt); NULL exactly when disabled.';
COMMENT ON COLUMN report_subscriptions.recipient_user_ids IS
  'Tenant members with agency.supervise on the account, checked at create and again at send (RP4).';

CREATE TABLE report_runs (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  account_id        UUID,
  kind              VARCHAR(16) NOT NULL,
  subject_id        UUID NOT NULL,
  campaign_ids      UUID[],
  range_from        TIMESTAMPTZ NOT NULL,
  range_to          TIMESTAMPTZ NOT NULL,
  local_from        DATE NOT NULL,
  local_to          DATE NOT NULL,
  timezone          TEXT NOT NULL,
  formats           TEXT[] NOT NULL,
  audience          VARCHAR(16) NOT NULL,
  requested_by      UUID,
  email_me          BOOLEAN NOT NULL DEFAULT false,
  subscription_id   UUID,
  period_start      DATE,
  status            VARCHAR(16) NOT NULL DEFAULT 'queued',
  claim_generation  INTEGER NOT NULL DEFAULT 0,
  claimed_at        TIMESTAMPTZ,
  render_attempt    INTEGER NOT NULL DEFAULT 0,
  sent_at           TIMESTAMPTZ,
  dataset_key       TEXT,
  detail_files      JSONB NOT NULL DEFAULT '[]'::jsonb,
  files             JSONB NOT NULL DEFAULT '[]'::jsonb,
  truncated         BOOLEAN NOT NULL DEFAULT false,
  renderer_version  TEXT,
  error_code        VARCHAR(40),
  error_message     TEXT,
  notified_at       TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at       TIMESTAMPTZ,
  expires_at        TIMESTAMPTZ,
  CONSTRAINT ck_report_runs_kind CHECK (kind IN ('agent', 'campaign', 'account')),
  CONSTRAINT ck_report_runs_status CHECK (
    status IN ('queued', 'assembling', 'rendering', 'ready', 'failed', 'expired')
  ),
  -- Only an agent's own review is `self` (RP5).
  CONSTRAINT ck_report_runs_audience CHECK (
    audience IN ('supervisor', 'self') AND (audience = 'supervisor' OR kind = 'agent')
  ),
  -- `campaign_ids` narrows an account report only; NULL is every campaign of the account.
  CONSTRAINT ck_report_runs_campaign_ids CHECK (
    campaign_ids IS NULL OR (kind = 'account' AND cardinality(campaign_ids) >= 1)
  ),
  -- RP2: at most 31 days plus the hour a clock change adds (REPORT_MAX_STORED_WINDOW_MS).
  CONSTRAINT ck_report_runs_window CHECK (
    range_to > range_from AND range_to - range_from <= INTERVAL '745 hours' AND local_to >= local_from
  ),
  CONSTRAINT ck_report_runs_formats CHECK (
    cardinality(formats) >= 1 AND formats <@ ARRAY['pdf', 'xlsx']::text[]
  ),
  CONSTRAINT ck_report_runs_timezone CHECK (timezone <> '' AND timezone = btrim(timezone)),
  CONSTRAINT ck_report_runs_subscription CHECK ((subscription_id IS NULL) = (period_start IS NULL)),
  CONSTRAINT ck_report_runs_counters CHECK (claim_generation >= 0 AND render_attempt >= 0),
  CONSTRAINT ck_report_runs_json CHECK (
    jsonb_typeof(detail_files) = 'array' AND jsonb_typeof(files) = 'array'
  ),
  -- A failure carries its code (ReportFailureCode) and message; nothing else does.
  CONSTRAINT ck_report_runs_error CHECK (
    (status = 'failed') = (error_code IS NOT NULL)
    AND (error_code IS NULL) = (error_message IS NULL)
    AND (error_code IS NULL OR error_code IN (
      'assembly_failed', 'subject_unavailable', 'subject_changed', 'dataset_unreadable', 'dataset_version_unsupported',
      'render_failed', 'upload_failed', 'render_timed_out'
    ))
  ),
  -- finished_at once terminal; expires_at on a ready (or expired) run only.
  CONSTRAINT ck_report_runs_finished CHECK (
    (finished_at IS NOT NULL) = (status IN ('ready', 'failed', 'expired'))
    AND (expires_at IS NOT NULL) = (status IN ('ready', 'expired'))
  )
);

-- RP14: one run per subscription period. The tick's insert is ON CONFLICT DO NOTHING on it, and
-- the subscription's newest run (`last_run`) is one backward step of it.
CREATE UNIQUE INDEX uq_report_runs_subscription_period
  ON report_runs (subscription_id, period_start)
  WHERE subscription_id IS NOT NULL;

-- The pipeline's work: the assembler's claim (queued oldest first, and stale assembling claims),
-- the tick's reconcile (assembled unsent, rendering sent long ago), the per-tenant pending limit
-- and the pending gauges. Holds only runs in flight, a handful per tenant.
CREATE INDEX idx_report_runs_pending
  ON report_runs (status, created_at)
  WHERE status IN ('queued', 'assembling', 'rendering');

-- The history page: one account's runs (or a tenant's unscoped ones), newest first, keyset on
-- (created_at, id).
CREATE INDEX idx_report_runs_history
  ON report_runs (tenant_id, account_id, created_at DESC, id DESC);

-- A caller's own runs (an agent without agency.supervise sees only those) and the per-user
-- request rate (AGENCY_REPORTS_USER_PER_MINUTE).
CREATE INDEX idx_report_runs_requester
  ON report_runs (requested_by, created_at DESC, id DESC)
  WHERE requested_by IS NOT NULL;

-- The "report ready" email: finished runs that email someone and have not been handled.
CREATE INDEX idx_report_runs_unnotified
  ON report_runs (finished_at)
  WHERE notified_at IS NULL AND status IN ('ready', 'failed') AND (email_me OR subscription_id IS NOT NULL);

-- RP8: ready runs by expiry.
CREATE INDEX idx_report_runs_expiry
  ON report_runs (expires_at)
  WHERE status = 'ready';

COMMENT ON TABLE report_runs IS
  'Report runs (docs/reports.md): one PDF and/or workbook about one subject over one window. queued -> assembling -> rendering -> ready | failed; ready -> expired at expires_at (RP8).';
COMMENT ON COLUMN report_runs.subject_id IS
  'The agent user id, campaign id or account id, by kind. No FK.';
COMMENT ON COLUMN report_runs.range_from IS
  'Local midnight of local_from in timezone: the read window''s inclusive start.';
COMMENT ON COLUMN report_runs.range_to IS
  'Local midnight after local_to in timezone: the read window''s exclusive end. range_to - range_from <= 745 hours (RP2).';
COMMENT ON COLUMN report_runs.claim_generation IS
  'Bumped by every assembler claim; the assembler''s later writes are fenced on the generation it claimed.';
COMMENT ON COLUMN report_runs.render_attempt IS
  'Bumped by every send to the renderer; a render callback is applied only for the current attempt while rendering (RP13).';
COMMENT ON COLUMN report_runs.files IS
  'The rendered files, [{format, key, bytes}]; empty until ready, kept on an expired run as a record.';
COMMENT ON COLUMN report_runs.subscription_id IS
  'The report_subscriptions id that produced the run (no FK: the run outlives the subscription); NULL for an ad hoc run.';
COMMENT ON COLUMN report_runs.period_start IS
  'The subscription period''s first local day (local_from); NULL for an ad hoc run.';

CREATE INDEX idx_agency_agent_sessions_agent
  ON agency_agent_sessions (agent_user_id, joined_at);

COMMENT ON INDEX idx_agency_agent_sessions_agent IS
  'Reports: one agent''s sessions (campaign and soft phone) overlapping a window, across every campaign (the agent review).';

-- Down Migration

DROP INDEX IF EXISTS idx_agency_agent_sessions_agent;
DROP TABLE IF EXISTS report_runs;
DROP TABLE IF EXISTS report_subscriptions;
