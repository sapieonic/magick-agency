-- 0001_baseline.sql — Magick Agency squashed baseline schema.
--
-- The complete schema, with every ALTER folded into the CREATE it modifies.
-- In-table comments, constraint comments and COMMENT ON text carry each object's
-- rationale.
--
-- The schema's notable choices (UUID typing of tenant/account/user ids, dropped
-- columns, renamed objects, the one added column) are inventoried in
-- packages/db/BASELINE.md. Read it before changing anything here.
--
-- This file runs as ONE node-pg-migrate SQL migration inside one transaction.
-- node-pg-migrate splits the file on the up/down marker comments with the regex
-- /^\s*--[\s-]*(up|down)\s+migration/im — no other comment line in this file may
-- begin with those two words, or the split moves. The integration suite asserts
-- there is exactly one of each marker.

-- Up Migration

-- ════════════════════════════════════════════════════════════════════════════
-- 0. Extensions and shared functions
-- ════════════════════════════════════════════════════════════════════════════

-- Needed for the uuid_generate_v4() defaults that audit_logs, audio_files and
-- announcements declare. gen_random_uuid() is built in (PG 13+), so pgcrypto is
-- not installed.
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ════════════════════════════════════════════════════════════════════════════
-- 1. Identity and tenancy
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE tenants (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  slug        TEXT NOT NULL UNIQUE,
  settings    JSONB NOT NULL DEFAULT '{}',
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'deleted')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER tenants_updated_at
  BEFORE UPDATE ON tenants
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- UNIQUE(tenant_id, slug) is a partial unique index over non-deleted rows (below).
CREATE TABLE accounts (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  slug        TEXT NOT NULL,
  settings    JSONB NOT NULL DEFAULT '{}',
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'deleted')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_accounts_tenant_id ON accounts(tenant_id);

-- Allow reuse of deleted account slugs — uniqueness only among
-- non-deleted rows.
CREATE UNIQUE INDEX idx_accounts_tenant_slug_active
  ON accounts(tenant_id, slug)
  WHERE status != 'deleted';

CREATE TRIGGER accounts_updated_at
  BEFORE UPDATE ON accounts
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TABLE users (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  firebase_uid      TEXT NOT NULL UNIQUE,
  email             TEXT NOT NULL,
  display_name      TEXT,
  avatar_url        TEXT,
  status            TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'deleted')),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  phone_number      TEXT NOT NULL DEFAULT '0000000000',
  email_unverified  BOOLEAN NOT NULL DEFAULT false
);

CREATE INDEX idx_users_email ON users(email);

CREATE TRIGGER users_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

COMMENT ON COLUMN users.email_unverified IS
  'TRUE when an invite claim bound an identity to this row without proving its email address. Such a row must never be reused by address (POST /users/invite, super-admin create/add-user); /auth/session clears it when the bound identity presents a verified token for the address (path 1), or when a verified sign-in adopts the row (path 2).';

-- Value ORDER matters: the first five values were created first and 'agent' was
-- appended with ALTER TYPE ... ADD VALUE (no BEFORE/AFTER), so it sorts LAST.
-- The role hierarchy (agent = 5, below viewer) lives in code (src/rbac/roles.ts), never in this ordering — do not compare
-- membership_role values with < or >.
CREATE TYPE membership_role AS ENUM (
  'tenant_owner',
  'tenant_admin',
  'account_admin',
  'operator',
  'viewer',
  'agent'
);

-- Revoked rows are retained (status = 'revoked').
CREATE TABLE memberships (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  account_id  UUID REFERENCES accounts(id) ON DELETE CASCADE,
  role        membership_role NOT NULL DEFAULT 'viewer',
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'revoked')),
  invited_by  UUID REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Full uniqueness: one role per user per tenant per account
  UNIQUE(user_id, tenant_id, account_id)
);

-- Partial unique index for tenant-level memberships (account_id IS NULL)
CREATE UNIQUE INDEX idx_memberships_user_tenant_level
  ON memberships(user_id, tenant_id)
  WHERE account_id IS NULL;

CREATE INDEX idx_memberships_tenant_id ON memberships(tenant_id);
CREATE INDEX idx_memberships_user_id ON memberships(user_id);
CREATE INDEX idx_memberships_account_id ON memberships(account_id) WHERE account_id IS NOT NULL;

CREATE TRIGGER memberships_updated_at
  BEFORE UPDATE ON memberships
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TABLE membership_invites (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- CASCADE, unlike most FKs here. An invite is meaningless without the
  -- membership it activates: if the membership row is ever hard-deleted, a
  -- surviving invite would be a token that binds an identity to nothing.
  -- (Offboarding does not hit this path -- `DELETE /users/:id/membership` sets
  -- `status = 'revoked'` and the row stays. The claim path checks that status
  -- itself and refuses a revoked membership.)
  membership_id       UUID NOT NULL REFERENCES memberships(id) ON DELETE CASCADE,
  -- Carried, not joined.
  tenant_id           UUID NOT NULL,
  email               TEXT NOT NULL,
  -- The Postgres ENUM `membership_role`, including `agent` -- NOT a
  -- CHECK constraint and NOT text. Typing it as the enum means a role this platform does not have cannot be stored, and it keeps the
  -- three mirrors (this column, `src/db/models/membership.model.ts`,
  -- `src/rbac/roles.ts`) moving together.
  role                membership_role NOT NULL,
  -- **The hash, never the token.** `sha256(token)` hex, 64 characters. The raw
  -- token exists exactly once, in the email; a database dump therefore cannot be
  -- replayed into account access. UNIQUE both because a collision would be a
  -- correctness disaster (two invites resolving to one lookup) and because the
  -- claim path's lookup is by this column alone and wants an index behind it.
  token_hash          TEXT NOT NULL UNIQUE,
  expires_at          TIMESTAMPTZ NOT NULL,
  -- NULL while outstanding. This is the predicate of the conditional UPDATE that
  -- makes claiming atomic (`WHERE claimed_at IS NULL`), so it is the one column
  -- that must never be set to anything but a timestamp: a second concurrent
  -- claim has to LOSE, not double-bind an identity.
  claimed_at          TIMESTAMPTZ,
  -- Who actually claimed it, which is not necessarily who it was addressed to --
  -- the token is the authority, and a claim from a different Firebase address
  -- still binds (and is recorded as a mismatch in `platform_audit_log`). No FK:
  -- see `invited_by` below for the same argument, plus the fact that this column
  -- is forensic and must survive the user row it names.
  claimed_by_user_id  UUID,
  -- Set by `POST /invites/resend`, which revokes every outstanding token for a
  -- membership before minting a new one. Rows are revoked rather than deleted so
  -- "this link stopped working because a newer one was sent" stays answerable to
  -- a recipient holding the old mail -- `GET /invites/:token` answers `revoked`
  -- for it instead of `not_found`, which is the difference between a useful
  -- message and a dead end.
  revoked_at          TIMESTAMPTZ,
  -- The supervisor who issued it. Deliberately UNCONSTRAINED, matching
  -- `memberships.invited_by`, whose column this mirrors: an invite record
  -- is history, and losing the row because an admin left would destroy the
  -- attribution the record exists for.
  invited_by          UUID,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- `POST /invites/resend` and the outstanding-token lookup both key on the
-- membership. Not partial on `claimed_at IS NULL`: the resend path revokes
-- OUTSTANDING rows but the same index serves "every invite ever issued for this
-- membership", which is the support question ("we sent it three times").
CREATE INDEX idx_membership_invites_membership
  ON membership_invites (membership_id);

-- ONE LIVE TOKEN PER MEMBERSHIP, stated in the schema. This index is what refuses
-- the second row of two racing resends, so the invariant holds against any caller,
-- including one written later that forgets the revoke entirely. The loser gets
-- `23505`, which the repository turns into `LiveInviteConflictError` and the route
-- into a 409 naming what happened. PARTIAL on the live predicate, deliberately:
-- claimed and revoked rows are kept forever, so a plain unique index on
-- `membership_id` would refuse the second invitation any membership ever receives.
CREATE UNIQUE INDEX uq_membership_invites_live
  ON membership_invites (membership_id)
  WHERE claimed_at IS NULL AND revoked_at IS NULL;

COMMENT ON TABLE membership_invites IS
  'Token-bound invitation claims. The TOKEN, not an email match, is what binds a '
  'Firebase identity to a pre-created stub membership, which removes the "signed up '
  'with a different address, landed in a private empty tenant" defect. Rows are never deleted: revoked and claimed invites are the record of '
  'what a recipient holding an old link is entitled to be told.';
COMMENT ON COLUMN membership_invites.token_hash IS
  'sha256(token) as hex. The raw token exists exactly once, in the email that carried '
  'it, and is never stored -- a database dump cannot be replayed into account access. '
  'Lookup is BY this column, which is why no constant-time comparison is needed: the '
  'index does an equality match on a value the attacker would have to guess in full.';
COMMENT ON COLUMN membership_invites.claimed_at IS
  'NULL while outstanding. The predicate of the conditional UPDATE that makes claiming '
  'atomic -- a second concurrent claim must lose cleanly with 409, never double-bind an '
  'identity onto the membership. With revoked_at it also defines the partial unique index '
  'uq_membership_invites_live, i.e. what "one live token per membership" means.';
COMMENT ON COLUMN membership_invites.expires_at IS
  'Checked in the claim UPDATE itself (expires_at > NOW()), not only by the route before '
  'it. Expiry is the one refusal that arrives with nobody acting, so a TTL lapsing between '
  'the route read and the write -- across a Firebase verification -- would otherwise still '
  'bind.';
COMMENT ON COLUMN membership_invites.email IS
  'The address the invitation was ISSUED for, copied rather than joined. It is what an '
  'unauthenticated reader of GET /invites/:token is shown, and it must describe the '
  'invitation as sent. It is NOT the claim key -- the claim resolves through '
  'membership_id, because users.email carries only a non-unique index.';

-- No default super-admin is seeded: super-admins are created fresh
-- (docs/decisions.md).
CREATE TABLE super_admins (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  is_system BOOLEAN NOT NULL DEFAULT false
);

CREATE INDEX idx_super_admins_email ON super_admins (email);

-- Super admin audit log (the super-admin audit trail).
CREATE TABLE super_admin_audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id UUID NOT NULL REFERENCES super_admins(id),
  admin_email TEXT NOT NULL,
  action TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT,
  details JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_sa_audit_created ON super_admin_audit_log (created_at DESC);
CREATE INDEX idx_sa_audit_admin ON super_admin_audit_log (admin_id);

-- ════════════════════════════════════════════════════════════════════════════
-- 2. Phone inventory
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE telephony_providers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(50) UNIQUE NOT NULL,
  display_name VARCHAR(100) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'inactive')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER trg_telephony_providers_updated
  BEFORE UPDATE ON telephony_providers
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- Reference row. Agency dials on VoiceLink only, so no other carriers
-- (vobiz, twilio, plivo, exotel, telnyx, z99) are seeded.
INSERT INTO telephony_providers (name, display_name)
  VALUES ('voicelink', 'VoiceLink')
  ON CONFLICT (name) DO NOTHING;

-- No ownership / owner_tenant_id columns, and no seed number.
CREATE TABLE phone_numbers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_number VARCHAR(20) UNIQUE NOT NULL,
  provider_id UUID NOT NULL REFERENCES telephony_providers(id),
  label VARCHAR(255),
  capabilities TEXT[] NOT NULL DEFAULT '{voice}',
  region VARCHAR(10),
  max_concurrent_calls INTEGER NOT NULL DEFAULT 1,
  status VARCHAR(20) NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'retired', 'deleted')),
  notes TEXT,
  created_by UUID REFERENCES super_admins(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  pool_eligible BOOLEAN NOT NULL DEFAULT false
);

CREATE TRIGGER trg_phone_numbers_updated
  BEFORE UPDATE ON phone_numbers
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE INDEX idx_phone_numbers_provider ON phone_numbers (provider_id);
CREATE INDEX idx_phone_numbers_status ON phone_numbers (status) WHERE status = 'active';
CREATE INDEX idx_phone_numbers_pool
  ON phone_numbers (pool_eligible)
  WHERE status = 'active' AND pool_eligible = true;

CREATE TABLE tenant_phone_assignments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  phone_number_id UUID NOT NULL REFERENCES phone_numbers(id),
  is_default BOOLEAN NOT NULL DEFAULT false,
  assigned_by UUID REFERENCES super_admins(id),
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(tenant_id, phone_number_id)
);

-- Only one default per tenant
CREATE UNIQUE INDEX idx_tenant_phone_default
  ON tenant_phone_assignments(tenant_id) WHERE is_default = true;

CREATE INDEX idx_tenant_phone_tenant ON tenant_phone_assignments (tenant_id);
CREATE INDEX idx_tenant_phone_number ON tenant_phone_assignments (phone_number_id);

CREATE TABLE phone_account_tags (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  assignment_id UUID NOT NULL REFERENCES tenant_phone_assignments(id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  is_default BOOLEAN NOT NULL DEFAULT false,
  tagged_by UUID REFERENCES users(id),
  tagged_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(assignment_id, account_id)
);

-- Only one default phone number per account
CREATE UNIQUE INDEX idx_phone_account_default
  ON phone_account_tags(account_id) WHERE is_default = true;

CREATE INDEX idx_phone_account_tags_assignment ON phone_account_tags (assignment_id);
CREATE INDEX idx_phone_account_tags_account ON phone_account_tags (account_id);

-- ════════════════════════════════════════════════════════════════════════════
-- 3. Notifications
-- ════════════════════════════════════════════════════════════════════════════

-- SPARSE overrides: the catalog in code holds the default for
-- every event, and a row here exists only where somebody has expressed a preference.
CREATE TABLE user_notification_preferences (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id)   ON DELETE CASCADE,
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  event_key   TEXT NOT NULL,
  channel     TEXT NOT NULL DEFAULT 'email',
  enabled     BOOLEAN NOT NULL,
  frequency   TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT user_notification_preferences_frequency_check
    CHECK (frequency IS NULL OR frequency IN ('daily', 'weekly')),
  CONSTRAINT uq_user_notification_preferences
    UNIQUE (user_id, tenant_id, event_key, channel)
);

CREATE TRIGGER user_notification_preferences_updated_at
  BEFORE UPDATE ON user_notification_preferences
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- The audience-side read: "for these users in this tenant, what did they choose
-- for this event". The unique constraint's index leads on `user_id`, which
-- serves `user_id = ANY($3)` directly, so no second index is created here.

-- The idempotency record that makes a scheduled send safe to re-run.
CREATE TABLE notification_deliveries (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_key   TEXT NOT NULL,
  -- Opaque to this table. The engine builds it; see `buildDedupeKey`.
  dedupe_key  TEXT NOT NULL,
  -- The address, lower-cased by the engine before it gets here so that two
  -- spellings of one inbox cannot both claim.
  recipient   TEXT NOT NULL,
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  -- NULL means the delivery was tenant-wide rather than about one account.
  -- No FK action beyond SET NULL: a delivery record must outlive the account it
  -- described, the same argument `platform_audit_log.api_key_id` makes.
  account_id  UUID REFERENCES accounts(id) ON DELETE SET NULL,
  status      TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'sent', 'failed', 'skipped')),
  -- Why a `failed` row failed. Free text from the transport, truncated by the
  -- engine; the one thing support has to work from, since nothing retries.
  error       TEXT,
  sent_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- THE claim. Everything about this table's usefulness is this index.
CREATE UNIQUE INDEX uq_notification_deliveries_claim
  ON notification_deliveries (event_key, tenant_id, dedupe_key, recipient);

-- The purge's predicate, and support's "what did we send this workspace".
CREATE INDEX idx_notification_deliveries_created
  ON notification_deliveries (created_at);

CREATE INDEX idx_notification_deliveries_tenant
  ON notification_deliveries (tenant_id, created_at DESC);

-- ════════════════════════════════════════════════════════════════════════════
-- 4. Audit — platform_audit_log ("Console") and audit_logs
--    ("Dialer"), both range-partitioned by month.
--
--    Partitions here cover 2026-01 through 2027-12 plus a DEFAULT safety net.
--    Creating months beyond 2027-12 (and dropping aged months for retention) is a
--    RUNTIME job owned by the server — this migration does not maintain partitions.
-- ════════════════════════════════════════════════════════════════════════════

-- No api_key_id column or index (no API keys).
CREATE TABLE platform_audit_log (
  id            UUID NOT NULL DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL,
  user_id       UUID,
  action        TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id   TEXT,
  details       JSONB NOT NULL DEFAULT '{}',
  ip_address    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  account_id    UUID,
  campaign_id   TEXT,
  actor_type    TEXT,
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

CREATE INDEX idx_audit_log_tenant_created ON platform_audit_log(tenant_id, created_at DESC);
CREATE INDEX idx_audit_log_action ON platform_audit_log(action);

-- Indexes include `created_at` because it is the partition key.
CREATE INDEX idx_audit_log_tenant_resource
  ON platform_audit_log (tenant_id, resource_id, created_at DESC);

CREATE INDEX idx_audit_log_tenant_campaign
  ON platform_audit_log (tenant_id, campaign_id, created_at DESC);

CREATE INDEX idx_audit_log_tenant_account
  ON platform_audit_log (tenant_id, account_id, created_at DESC);

COMMENT ON COLUMN platform_audit_log.actor_type IS
  'What KIND of principal performed this action: ''human'' (a signed-in user), '
  '''api_key'' (a platform API key — see api_key_id), or ''system'' (a background '
  'write with no caller). NULL means the row predates this column and the '
  'distinction is not recoverable — it is NOT a fourth value.';

COMMENT ON COLUMN platform_audit_log.user_id IS
  'The human who performed this action. Written ONLY when actor_type = ''human''. '
  'Before actor_type existed this also carried the CREATOR of an authenticating API '
  'key, which is why rows with a NULL actor_type cannot be read as "a person did '
  'this".';

DO $$
DECLARE
  start_date DATE;
  end_date DATE;
  partition_name TEXT;
BEGIN
  -- 2026-01 through 2027-12 (24 months), fixed rather than relative to NOW() so the
  -- baseline is deterministic.
  FOR i IN 0..23 LOOP
    start_date := (DATE '2026-01-01' + (i || ' months')::INTERVAL)::date;
    end_date := (start_date + INTERVAL '1 month')::date;
    partition_name := 'platform_audit_log_' || TO_CHAR(start_date, 'YYYY_MM');
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS %I PARTITION OF platform_audit_log FOR VALUES FROM (%L) TO (%L)',
      partition_name, start_date, end_date
    );
  END LOOP;
END $$;

-- Permanent safety net for any timestamp outside the explicit ranges.
CREATE TABLE IF NOT EXISTS platform_audit_log_default PARTITION OF platform_audit_log DEFAULT;

-- The campaign activity trail merges these rows ("Dialer") with platform_audit_log
-- ("Console") (decision B7). `call_id` has no FK.
CREATE TABLE audit_logs (
  id              UUID DEFAULT uuid_generate_v4(),
  call_id         UUID,
  tenant_id       UUID NOT NULL,
  event_type      VARCHAR(100) NOT NULL,
  event_category  VARCHAR(50) NOT NULL,
  severity        VARCHAR(10) NOT NULL DEFAULT 'info',
  event_data      JSONB NOT NULL DEFAULT '{}',
  request_id      VARCHAR(100),
  actor           VARCHAR(255),
  ip_address      INET,
  timestamp       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  duration_ms     INTEGER,
  account_id      UUID NOT NULL,
  PRIMARY KEY (id, timestamp)
) PARTITION BY RANGE (timestamp);

CREATE INDEX idx_audit_call_id ON audit_logs (call_id, timestamp DESC);
CREATE INDEX idx_audit_tenant ON audit_logs (tenant_id, account_id, timestamp DESC);
CREATE INDEX idx_audit_event_type ON audit_logs (event_type, timestamp DESC);
CREATE INDEX idx_audit_severity ON audit_logs (severity, timestamp DESC)
  WHERE severity IN ('warn', 'error');

-- Expression index so agency audit rows are queryable by campaign. Agency
-- writes put the campaign id in `event_data.campaign_id`, not in a column.
-- Non-agency rows (no campaign_id key) store NULL in the index expression and drop
-- out of an equality lookup.
CREATE INDEX IF NOT EXISTS idx_audit_logs_campaign_id
  ON audit_logs (tenant_id, account_id, ((event_data->>'campaign_id')), timestamp DESC);

DO $$
DECLARE
  start_date DATE;
  end_date DATE;
  partition_name TEXT;
BEGIN
  -- 2026-01 through 2027-12 (24 months). 2026-01 is the first month, so the
  -- two audit tables share one window.
  FOR i IN 0..23 LOOP
    start_date := (DATE '2026-01-01' + (i || ' months')::INTERVAL)::date;
    end_date := (start_date + INTERVAL '1 month')::date;
    partition_name := 'audit_logs_' || TO_CHAR(start_date, 'YYYY_MM');
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS %I PARTITION OF audit_logs FOR VALUES FROM (%L) TO (%L)',
      partition_name, start_date, end_date
    );
  END LOOP;
END $$;

-- Permanent safety net for any timestamp outside the explicit ranges.
CREATE TABLE IF NOT EXISTS audit_logs_default PARTITION OF audit_logs DEFAULT;

-- ════════════════════════════════════════════════════════════════════════════
-- 5. DNC, ingest jobs and staffing
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE dnc_entries (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  account_id   UUID REFERENCES accounts(id) ON DELETE CASCADE,  -- NULL ⇒ tenant-wide
  campaign_id  UUID,                                            -- NULL ⇒ all campaigns
  phone_e164   VARCHAR(20) NOT NULL,
  source       VARCHAR(30) NOT NULL,
  reason       TEXT,
  added_by     VARCHAR(100),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT ck_dnc_entries_source CHECK (source IN ('agent', 'import', 'api', 'regulator'))
);

-- `campaign_id` deliberately has NO foreign key here: it names an
-- `agency_campaigns` row, and DNC records must outlive the campaign.

-- One row per (scope, number). NULL never equals NULL in a unique index, so the
-- scope columns are COALESCEd to a sentinel; without that the index is vacuous
-- for every tenant-wide row and duplicates accumulate silently.
CREATE UNIQUE INDEX uq_dnc_scope
  ON dnc_entries (
    tenant_id,
    COALESCE(account_id,  '00000000-0000-0000-0000-000000000000'::uuid),
    COALESCE(campaign_id, '00000000-0000-0000-0000-000000000000'::uuid),
    phone_e164
  );

-- The COALESCE index above cannot serve a plain per-number lookup, which is
-- exactly what the ingest sweep ("is this contact suppressed for this tenant?")
-- performs once per CSV row.
CREATE INDEX idx_dnc_entries_tenant_phone
  ON dnc_entries (tenant_id, phone_e164);

-- Feeds the tenant-wide delta the dialer runtime subscribes to, newest first.
CREATE INDEX idx_dnc_entries_tenant_created
  ON dnc_entries (tenant_id, created_at DESC);

-- There is no `dnc_sync_state` table (decision B8): the DNC collapse removes the
-- Redis DNC sync that its watermark served.

CREATE TABLE agency_ingest_jobs (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  account_id            UUID REFERENCES accounts(id) ON DELETE CASCADE,
  -- The campaign id. Deliberately no FK.
  -- NULL while a dry run validates a file before any campaign is committed to.
  campaign_id           UUID,
  -- ── The file ──
  s3_key                TEXT NOT NULL,
  file_name             TEXT NOT NULL,
  file_size_bytes       BIGINT,
  -- ── The operator's column mapping ──
  phone_column          TEXT NOT NULL,
  timezone_column       TEXT,
  -- Columns marked `Ignore`: excluded from `context` entirely, never merely
  -- hidden at render time. Persisted so a re-run reproduces the same roster.
  ignore_columns        TEXT[] NOT NULL DEFAULT '{}',
  -- Per-CAMPAIGN default country code for local-format numbers, NOT the
  -- platform-wide one. Without it a US campaign's local numbers silently
  -- normalise to +91 and get dialed. It lives here rather than on the
  -- campaign row because it is an INGEST-time parameter only: once the roster
  -- holds E.164, nothing downstream needs it again.
  default_country_code  VARCHAR(4),
  -- In-file duplicate suppression. A product judgement, not an idempotency
  -- guarantee — two people can legitimately share one number, so the operator
  -- decides. Roster idempotency is separate: (campaign_id, source_row_number).
  dedupe_phones         BOOLEAN NOT NULL DEFAULT TRUE,
  -- ── Lifecycle ──
  -- A dry run does everything except send anything to the dialer runtime, so the wizard can
  -- say "95% of your rows are valid" before the operator commits.
  dry_run               BOOLEAN NOT NULL DEFAULT FALSE,
  status                VARCHAR(20) NOT NULL DEFAULT 'pending',
  -- Set by the cancel route; the ingest loop checks it between chunks. A flag
  -- rather than a kill, because a chunk already in flight must be allowed to
  -- finish or its idempotency key is left in an unknown state.
  cancel_requested      BOOLEAN NOT NULL DEFAULT FALSE,
  -- ── Progress and results ──
  rows_read             BIGINT NOT NULL DEFAULT 0,
  accepted              BIGINT NOT NULL DEFAULT 0,
  -- `duplicates` is a BREAKDOWN of `rejected`, never a fourth addend:
  -- accepted + rejected = rows_read, exactly, so an operator can reconcile
  -- against their spreadsheet.
  rejected              BIGINT NOT NULL DEFAULT 0,
  duplicates            BIGINT NOT NULL DEFAULT 0,
  rejected_by_reason    JSONB NOT NULL DEFAULT '{}'::jsonb,
  bytes_read            BIGINT NOT NULL DEFAULT 0,
  chunks_sent           INTEGER NOT NULL DEFAULT 0,
  chunks_total          INTEGER,
  -- Headers, and the subset written into `context`, as resolved at ingest
  -- (de-duplicated with (2)/(3) suffixes). The rejected-rows export reproduces
  -- exactly these columns.
  headers               TEXT[],
  context_columns       TEXT[],
  -- ── The rejected-rows export ──
  rejected_s3_key       TEXT,
  rejected_row_count    INTEGER NOT NULL DEFAULT 0,
  -- True when the export hit its row ceiling and does not contain every
  -- rejection. Surfaced rather than silently short — an operator fixing a file
  -- from a truncated export would re-upload a file that still fails.
  rejected_truncated    BOOLEAN NOT NULL DEFAULT FALSE,
  -- ── Failure ──
  error_code            VARCHAR(40),
  error_message         TEXT,
  created_by            VARCHAR(100),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at            TIMESTAMPTZ,
  finished_at           TIMESTAMPTZ,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Rejections reported by the dialer runtime, threaded back.
  core_rejected_duplicate_rows                BIGINT NOT NULL DEFAULT 0,
  core_duplicate_source_rows                  INTEGER[] NOT NULL DEFAULT '{}',
  core_rejected_duplicate_rows_may_undercount BOOLEAN NOT NULL DEFAULT FALSE,
  mode                                        VARCHAR(20) NOT NULL DEFAULT 'append',
  replace_superseded_contacts                 BIGINT,
  replace_superseded_uncertain                BOOLEAN NOT NULL DEFAULT FALSE,
  CONSTRAINT ck_agency_ingest_job_status CHECK (status IN
    ('pending', 'running', 'completed', 'failed', 'cancelled')),
  CONSTRAINT ck_agency_ingest_mode CHECK (mode IN ('append', 'replace'))
);

-- The wizard's poll: "the newest job for this campaign".
CREATE INDEX idx_agency_ingest_jobs_campaign
  ON agency_ingest_jobs (campaign_id, created_at DESC)
  WHERE campaign_id IS NOT NULL;

CREATE INDEX idx_agency_ingest_jobs_tenant
  ON agency_ingest_jobs (tenant_id, created_at DESC);

-- Startup recovery: a server restart mid-ingest strands jobs in `running`, and
-- they are invisible to the wizard's poll otherwise. Partial index because live
-- jobs are a vanishing fraction of the table over time.
CREATE INDEX idx_agency_ingest_jobs_live
  ON agency_ingest_jobs (status)
  WHERE status IN ('pending', 'running');

CREATE TRIGGER agency_ingest_jobs_updated_at
  BEFORE UPDATE ON agency_ingest_jobs
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

COMMENT ON COLUMN agency_ingest_jobs.core_rejected_duplicate_rows_may_undercount IS
  'TRUE when at least one chunk of this ingest could not report what it refused, so '
  'core_rejected_duplicate_rows is a LOWER BOUND rather than an exact figure. Set from '
  'the dialer runtime''s rejection_counts_unavailable (a replay of a chunk whose '
  'rejection counts were never recorded). FALSE means the '
  'total is exact — including an exact zero — and is the default for newly recorded jobs.';
COMMENT ON COLUMN agency_ingest_jobs.mode IS
  'append (default, today''s behaviour: new rows are merged into the roster) or '
  'replace (the campaign''s existing contacts are retired first, by the dialer runtime, '
  'and only this import''s rows remain dialable). Recorded per import because only the '
  'upload holds the operator''s intent — the roster cannot tell a correction from a top-up.';
COMMENT ON COLUMN agency_ingest_jobs.replace_superseded_contacts IS
  'For mode=replace: how many contacts the dialer runtime retired for this job. NULL when the '
  'question does not apply. Non-NULL on a FAILED job is the state that matters — '
  'the roster was already retired when the import died.';
COMMENT ON COLUMN agency_ingest_jobs.replace_superseded_uncertain IS
  'TRUE when a replace may have retired this campaign''s roster but the ingest could not '
  'confirm it — a retry whose earlier attempt might have committed, or the dialer runtime reporting '
  'already_applied. Read WITH replace_superseded_contacts: (N, false) = exactly N '
  'retired; (NULL, false) = nothing retired; (NULL, true) = the roster may be gone and '
  'the count is unknown. Never inferred — only set from a live answer of the dialer runtime.';

CREATE TABLE agency_campaign_agents (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  -- The account the assignment was made in, for attribution and for the
  -- account-scoped views. Nullable because a tenant-level membership
  -- (`account_id IS NULL`) reaches every account in the tenant and has no single
  -- account to record.
  --
  -- **Attribution only — never an authorization predicate.** An earlier version
  -- of this comment justified the column by "the account-scoped views", which did
  -- not exist and still do not. Two things make it unusable as an ownership
  -- check, and both are worth knowing before someone reaches for it:
  --   * it is the acting supervisor's account CONTEXT, not the campaign's owning
  --     account — those can differ, and only the dialer runtime knows the second one;
  --   * a tenant-level membership writes NULL here (see above), so a predicate on
  --     it would either refuse legitimate rows or match everything.
  -- Campaign ownership is therefore established by asking the campaign
  -- itself (`assertCampaignInScope` in `proxy-agency-staffing.routes.ts`), whose
  -- `requireOwned` compares tenant AND account. One rule, one mechanism.
  --
  -- Deliberately NOT part of the uniqueness rule either: the rule is one campaign
  -- per person per TENANT, and including the account here would let the same
  -- person hold two live assignments under two accounts, which is the exact shape
  -- the rule exists to forbid.
  account_id     UUID REFERENCES accounts(id) ON DELETE CASCADE,
  -- The `agency_campaigns` id.
  -- Deliberately no FK, and no campaign copy is kept here.
  -- A campaign since deleted leaves a row pointing at nothing; the read
  -- path resolves the name through the proxy and reports what it finds rather
  -- than pretending the assignment is gone.
  campaign_id    UUID NOT NULL,
  -- The person. FK'd, unlike `campaign_id`, because users are this schema's own table —
  -- and CASCADE because an assignment to a deleted user is not a record worth
  -- keeping, it is a dangling pointer that would surface as a nameless row on a
  -- supervisor's screen.
  user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Who staffed them. `SET NULL` rather than CASCADE: the assignment outlives the
  -- supervisor who made it, and losing the whole row because an admin left would
  -- unstaff a working agent.
  assigned_by    UUID REFERENCES users(id) ON DELETE SET NULL,
  assigned_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- NULL = active. This column IS the partial index's predicate, so it is the
  -- one field that must never be updated to anything other than a timestamp.
  unassigned_at  TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- one active assignment per user per CAMPAIGN per tenant. Staffing is
-- not occupancy — being live on one campaign at a time is the session index
-- (uq_agency_agent_live_tenant), not this table.
CREATE UNIQUE INDEX uq_agency_campaign_agent_active_campaign
  ON agency_campaign_agents (tenant_id, user_id, campaign_id)
  WHERE unassigned_at IS NULL;

-- The supervisor's read: "who is staffed on this campaign". Partial for the same
-- reason the uniqueness is — closed rows accumulate forever and are never the
-- answer to this question.
CREATE INDEX idx_agency_campaign_agents_campaign_active
  ON agency_campaign_agents (campaign_id)
  WHERE unassigned_at IS NULL;

CREATE TRIGGER agency_campaign_agents_updated_at
  BEFORE UPDATE ON agency_campaign_agents
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

COMMENT ON TABLE agency_campaign_agents IS
  'Supervisor-set agent-to-campaign staffing for the Agency Dialer. STAFFING ONLY: '
  'nothing consults this table to authorize a station join — that is agency.station.connect '
  'in src/rbac/roles.ts — it only decides which campaigns an agent may be sent to. An agent '
  'may hold several active assignments; being LIVE on one campaign at a time '
  'is the session index, not this table.';
COMMENT ON COLUMN agency_campaign_agents.campaign_id IS
  'The agency_campaigns id. Deliberately no FK, and no campaign copy is kept here.';
COMMENT ON COLUMN agency_campaign_agents.unassigned_at IS
  'NULL while the assignment is active; this is the predicate of '
  'uq_agency_campaign_agent_active_campaign (one active assignment per user per CAMPAIGN '
  'per tenant, because staffing is not occupancy: being live on one campaign at a time '
  'is enforced by the session index, not here) and of the campaign roster index. Rows are closed rather than '
  'deleted so "who was staffed here in March" stays answerable.';

-- ════════════════════════════════════════════════════════════════════════════
-- 6. Per-account settings, the concurrency guard's tables, feature flags
-- ════════════════════════════════════════════════════════════════════════════

-- Per-account settings, including the concurrency allocation mode/version. There
-- is no analyze_dialer_calls (decision Q3b: its only reader was the bridge's
-- softphone-only gate) and no default_ai_pipeline (AI only).
-- webrtc_max_duration_seconds is a per-account row (not a global feature flag).
-- NULL = inherit the process default.
CREATE TABLE account_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  account_id UUID NOT NULL,
  max_concurrent_calls INTEGER NOT NULL DEFAULT 5,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- dumb, pre-resolved per-account call toggles.
  --   analyze_calls   NULL = inherit the POST_CALL_ANALYSIS_ENABLED default
  --   allow_recording NULL = inherit the call recording default (true)
  analyze_calls   BOOLEAN,
  allow_recording BOOLEAN,
  -- existing accounts remain in legacy_total mode. Provider-specific rows
  -- are authoritative only after an account is explicitly switched to
  -- provider_breakdown mode.
  concurrency_allocation_mode VARCHAR(32) NOT NULL DEFAULT 'legacy_total',
  concurrency_allocation_version INTEGER NOT NULL DEFAULT 1,
  -- Per-account cap on a bridged call's length.
  webrtc_max_duration_seconds INTEGER,
  CONSTRAINT uq_account_settings_tenant_account UNIQUE (tenant_id, account_id),
  CONSTRAINT chk_account_settings_concurrency_allocation_mode
    CHECK (concurrency_allocation_mode IN ('legacy_total', 'provider_breakdown')),
  CONSTRAINT chk_account_settings_concurrency_allocation_version
    CHECK (concurrency_allocation_version >= 1),
  CONSTRAINT chk_account_settings_webrtc_max_duration_seconds
    CHECK (webrtc_max_duration_seconds IS NULL OR webrtc_max_duration_seconds > 0)
);

CREATE INDEX idx_account_settings_tenant ON account_settings (tenant_id);
CREATE INDEX idx_account_settings_tenant_account ON account_settings (tenant_id, account_id);

COMMENT ON COLUMN account_settings.webrtc_max_duration_seconds IS
  'Per-account maximum duration of a bridged call, in seconds. NULL = the '
  'process default applies.';

CREATE TABLE account_provider_concurrency_allocations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  account_id UUID NOT NULL,
  telephony_provider VARCHAR(100) NOT NULL,
  max_concurrent_calls INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_account_provider_concurrency
    UNIQUE (tenant_id, account_id, telephony_provider),
  CONSTRAINT fk_account_provider_concurrency_settings
    FOREIGN KEY (tenant_id, account_id)
    REFERENCES account_settings (tenant_id, account_id)
    ON DELETE RESTRICT,
  CONSTRAINT chk_account_provider_concurrency_provider
    CHECK (telephony_provider = LOWER(telephony_provider) AND telephony_provider ~ '^[a-z0-9][a-z0-9_-]{0,99}$'),
  CONSTRAINT chk_account_provider_concurrency_limit
    CHECK (max_concurrent_calls >= 0 AND max_concurrent_calls <= 1000)
);

CREATE INDEX idx_account_provider_concurrency_account
  ON account_provider_concurrency_allocations (tenant_id, account_id);

-- Generic feature-flag subsystem — sparse
-- per-(flag, scope) override rows; the catalog of which flags exist lives in code.
CREATE TABLE feature_flag_overrides (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  flag_key      VARCHAR(100) NOT NULL,            -- must exist in the code registry
  scope_type    VARCHAR(20)  NOT NULL,            -- 'global' | 'tenant' | 'account'
  tenant_id     UUID,                             -- NULL for global scope
  account_id    UUID,                             -- non-NULL only for account scope
  value         JSONB        NOT NULL,            -- typed: boolean | number | string | object
  reason        TEXT,                             -- super-admin note (why this override)
  expires_at    TIMESTAMPTZ,                      -- optional lazy auto-revert
  created_by    VARCHAR(100),
  updated_by    VARCHAR(100),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT ck_ff_scope CHECK (scope_type IN ('global','tenant','account')),
  CONSTRAINT ck_ff_scope_cols CHECK (
    (scope_type = 'global'  AND tenant_id IS NULL AND account_id IS NULL) OR
    (scope_type = 'tenant'  AND tenant_id IS NOT NULL AND account_id IS NULL) OR
    (scope_type = 'account' AND tenant_id IS NOT NULL AND account_id IS NOT NULL)
  )
);

-- One override per (flag, scope target). Partial unique indexes handle the NULL
-- dimensions cleanly (plain UNIQUE treats NULLs as distinct). These also serve as
-- the ON CONFLICT inference targets.
CREATE UNIQUE INDEX uq_ff_global  ON feature_flag_overrides (flag_key)
  WHERE scope_type = 'global';
CREATE UNIQUE INDEX uq_ff_tenant  ON feature_flag_overrides (flag_key, tenant_id)
  WHERE scope_type = 'tenant';
CREATE UNIQUE INDEX uq_ff_account ON feature_flag_overrides (flag_key, tenant_id, account_id)
  WHERE scope_type = 'account';

-- Hot read: all overrides relevant to a tenant (tenant + account rows).
CREATE INDEX idx_ff_tenant ON feature_flag_overrides (tenant_id)
  WHERE scope_type IN ('tenant','account');

CREATE TRIGGER set_feature_flag_overrides_updated_at
  BEFORE UPDATE ON feature_flag_overrides
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ════════════════════════════════════════════════════════════════════════════
-- 7. Clips — the abandon-announcement path 
--    Uploaded audio only: no TTS columns.
-- ════════════════════════════════════════════════════════════════════════════

-- Includes decoded-PCM bookkeeping.
CREATE TABLE audio_files (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id UUID NOT NULL,
  name VARCHAR(255) NOT NULL,
  slug VARCHAR(255) NOT NULL,
  original_filename VARCHAR(500) NOT NULL,
  content_type VARCHAR(100) NOT NULL,
  size_bytes BIGINT NOT NULL,
  s3_key VARCHAR(1000) NOT NULL,
  duration_seconds NUMERIC(10,2),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  account_id UUID NOT NULL,
  -- Cache key of the decoded mono PCM16 clip. NULL = never decoded (a legacy row,
  -- or one whose only use so far has been a `<Play>` carrier). 40 hex chars today
  -- (sha256 sliced, matching the TTS clip hashes that share the cache directory);
  -- VARCHAR(64) leaves room for a full digest without another migration.
  pcm_audio_hash VARCHAR(64),
  -- The clip's NATIVE rate — deliberately not resampled at decode time. The
  -- playback path (`pcmToAlaw`) resamples to 8 kHz through the windowed-sinc
  -- resampler, so storing the native rate keeps one resample step rather than two.
  pcm_sample_rate INTEGER,
  -- Channel count of the CACHED clip, which is always 1 — the decode path
  -- downmixes (mpg123 `-m`, or averaging in JS for sndfile output, which has no
  -- `-mono` option). Recorded rather than assumed so a future multi-channel clip
  -- cannot be silently misread as mono at half speed.
  pcm_channels SMALLINT,
  CONSTRAINT audio_files_tenant_account_name_key UNIQUE (tenant_id, account_id, name)
);

CREATE INDEX idx_audio_files_tenant ON audio_files (tenant_id, account_id, created_at DESC);

CREATE TRIGGER audio_files_updated_at
  BEFORE UPDATE ON audio_files
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- No TTS columns (tts_text, tts_voice, tts_language) or announcements_tts_check,
-- and `type` is 'audio' only — see BASELINE.md.
CREATE TABLE announcements (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id UUID NOT NULL,
  name VARCHAR(255) NOT NULL,
  type VARCHAR(20) NOT NULL CONSTRAINT announcements_type_check CHECK (type IN ('audio')),
  audio_file_id UUID,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  account_id UUID NOT NULL,
  -- allow deleting audio files referenced by inactive announcements.
  CONSTRAINT announcements_audio_file_id_fkey
    FOREIGN KEY (audio_file_id) REFERENCES audio_files(id) ON DELETE SET NULL,
  -- only require audio_file_id for active audio announcements.
  CONSTRAINT announcements_audio_check
    CHECK (is_active = false OR type != 'audio' OR audio_file_id IS NOT NULL)
);

CREATE UNIQUE INDEX idx_announcements_tenant_name_active
  ON announcements (tenant_id, account_id, name) WHERE is_active = true;

CREATE INDEX idx_announcements_tenant ON announcements (tenant_id, account_id, created_at DESC);

CREATE TRIGGER announcements_updated_at
  BEFORE UPDATE ON announcements
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ════════════════════════════════════════════════════════════════════════════
-- 8. Analysis profiles
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE call_analysis_profiles (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         UUID NOT NULL,
  account_id        UUID NOT NULL,
  name              VARCHAR(120) NOT NULL,
  description       TEXT,
  -- Free-text business context prepended to the analysis prompt, e.g.
  -- "Outbound collections calls by human agents to overdue borrowers."
  -- Materially improves summary quality on human↔human audio.
  context           TEXT,
  -- Same shape as prompt_templates.analytics_config.custom_dimensions.
  custom_dimensions JSONB NOT NULL DEFAULT '[]',
  -- Optional BCP-47 hint for the transcriber. NULL = auto-detect.
  language_hint     VARCHAR(20),
  is_default        BOOLEAN NOT NULL DEFAULT FALSE,
  is_active         BOOLEAN NOT NULL DEFAULT TRUE,
  version           INTEGER NOT NULL DEFAULT 1,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Unique active name per (tenant, account); a soft-deleted name frees up.
CREATE UNIQUE INDEX uq_analysis_profiles_name
  ON call_analysis_profiles (tenant_id, account_id, name) WHERE is_active;

-- At most one default per (tenant, account).
CREATE UNIQUE INDEX uq_analysis_profiles_default
  ON call_analysis_profiles (tenant_id, account_id) WHERE is_default AND is_active;

CREATE INDEX idx_analysis_profiles_scope
  ON call_analysis_profiles (tenant_id, account_id, created_at DESC);

CREATE TRIGGER trg_analysis_profiles_updated_at
  BEFORE UPDATE ON call_analysis_profiles
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ════════════════════════════════════════════════════════════════════════════
-- 9. Agency execution tables
-- ════════════════════════════════════════════════════════════════════════════

-- No sip_connection_id (no SIP / BYO trunk egress).
--
-- Two columns are deliberately ABSENT: there is no `concurrency` and no
-- `overdial_ratio`. The dialing ceiling is the account's existing
-- `account_settings.max_concurrent_calls`.
CREATE TABLE agency_campaigns (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             UUID NOT NULL,
  account_id            UUID NOT NULL,
  name                  VARCHAR(255) NOT NULL,

  -- Dialing
  caller_ids            TEXT[] NOT NULL,          -- rotated round-robin; all one provider
  telephony_provider    VARCHAR(20) NOT NULL DEFAULT 'voicelink',

  -- Windows (IANA tz; contact tz overrides where derivable)
  calling_window_start  TIME NOT NULL DEFAULT '09:00',
  calling_window_end    TIME NOT NULL DEFAULT '20:00',
  calling_days          SMALLINT[] NOT NULL DEFAULT '{1,2,3,4,5}',
  default_timezone      VARCHAR(64) NOT NULL DEFAULT 'UTC',

  -- Behaviour
  wrapup_seconds        INTEGER NOT NULL DEFAULT 30,   -- 0 = no wrap-up
  wrapup_auto_return    BOOLEAN NOT NULL DEFAULT true,
  retry_policy          JSONB NOT NULL DEFAULT '{}'::jsonb,   -- keyed by outcome
  -- [{code,label,is_success,requires_note,retry,terminal,suppress}] — a disposition's
  -- retry/terminal/suppress ALWAYS overrides the outcome policy.
  disposition_catalog   JSONB NOT NULL DEFAULT '[]'::jsonb,
  record_calls          BOOLEAN NOT NULL DEFAULT false,
  analysis_profile_id   UUID,                          -- reuses call_analysis_profiles

  -- Which of a contact's arbitrary CSV columns matter, and in what order:
  -- {hero: [], order: [], hidden: []}. See AgencyContextDisplay in
  -- src/agency/contracts.ts for the resolution rules both clients implement.
  --
  -- agency_contacts.context is deliberately schemaless — right for ingest,
  -- useless for rendering: a 41-column export gives the agent a 41-row table with
  -- no signal about which four rows decide the call. This is the operator's
  -- answer, set at campaign build time. '{}' means "no opinion" ⇒ render every
  -- column in the CSV's original header order.
  context_display       JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- draft → running → paused → stopping → completed | stopped
  status                VARCHAR(20) NOT NULL DEFAULT 'draft',
  contacts_total        INTEGER NOT NULL DEFAULT 0,
  created_by            VARCHAR(100),
  started_at            TIMESTAMPTZ,
  completed_at          TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- the campaign's break-reason catalog. '[]' means "the operator has no
  -- opinion", not "breaks are disabled" — the dialer then serves a small built-in default
  -- list (see `resolveBreakReasons`).
  break_reasons         JSONB NOT NULL DEFAULT '[]'::jsonb,

  -- the apology clip an abandoned call plays. NULLABLE, and null means
  -- hang up without a clip. NO FK: a dangling id resolves to no clip and takes the
  -- same path as NULL.
  abandon_announcement_id UUID,

  -- the abandonment ceiling.
  abandonment_ceiling_pct    DOUBLE PRECISION NOT NULL DEFAULT 3,
  pause_reason               VARCHAR(32),
  paused_at                  TIMESTAMPTZ,
  pause_abandonment_rate_pct DOUBLE PRECISION,

  -- campaign lifecycle.
  ended_at                   TIMESTAMPTZ,
  last_transition_by_user_id UUID,
  last_transition_by_name    VARCHAR(255),

  -- retry lineage.
  parent_campaign_id    UUID REFERENCES agency_campaigns(id) ON DELETE SET NULL,
  root_campaign_id      UUID,
  retry_generation      SMALLINT NOT NULL DEFAULT 0,
  retry_selector        JSONB,

  -- retry idempotency.
  retry_idempotency_key VARCHAR(64),

  CONSTRAINT ck_agency_campaign_status CHECK (status IN
    ('draft','running','paused','stopping','completed','stopped')),
  CONSTRAINT ck_agency_campaign_retry_policy CHECK (jsonb_typeof(retry_policy) = 'object'),
  CONSTRAINT ck_agency_campaign_dispositions CHECK (jsonb_typeof(disposition_catalog) = 'array'),
  CONSTRAINT ck_agency_campaign_context_display CHECK (jsonb_typeof(context_display) = 'object'),
  -- Same guard `disposition_catalog` carries. Without it a `{}` or a bare
  -- string parses as valid JSONB and every break request 500s on an array method,
  -- which reads as a server bug rather than a bad campaign config.
  CONSTRAINT ck_agency_campaign_break_reasons CHECK (jsonb_typeof(break_reasons) = 'array'),
  CONSTRAINT ck_agency_campaign_abandonment_ceiling
    CHECK (abandonment_ceiling_pct > 0 AND abandonment_ceiling_pct <= 100),
  CONSTRAINT ck_agency_campaign_pause_reason
    CHECK (pause_reason IS NULL OR pause_reason IN ('supervisor', 'abandonment_ceiling'))
);

-- ONE running campaign per account in v1. Two campaigns sharing one
-- account's concurrency pool would need fair-share arbitration between two
-- independent pacing leaders — real work for a case nobody has asked for. The
-- constraint is this one index and is trivially lifted later.
CREATE UNIQUE INDEX uq_agency_campaign_running
  ON agency_campaigns (tenant_id, account_id)
  WHERE status = 'running';

-- Tenant/account scoped list, newest first (mirrors idx_webrtc_calls_tenant).
CREATE INDEX idx_agency_campaigns_tenant
  ON agency_campaigns (tenant_id, account_id, created_at DESC);

-- The pacing supervisor's boot/tick scan: "which campaigns need a leader".
CREATE INDEX idx_agency_campaigns_active
  ON agency_campaigns (status)
  WHERE status IN ('running','stopping');

CREATE INDEX idx_agency_campaigns_parent
  ON agency_campaigns (parent_campaign_id)
  WHERE parent_campaign_id IS NOT NULL;

CREATE UNIQUE INDEX uq_agency_campaign_retry_idempotency
  ON agency_campaigns (tenant_id, account_id, retry_idempotency_key)
  WHERE retry_idempotency_key IS NOT NULL;

CREATE TRIGGER trg_agency_campaigns_updated_at
  BEFORE UPDATE ON agency_campaigns
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

COMMENT ON TABLE agency_campaigns IS
  'Agency dialer campaign, execution side: what the dialer runtime reads to place calls.';
COMMENT ON COLUMN agency_campaigns.caller_ids IS
  'Caller-ID pool rotated round-robin at dial time; all entries must belong to telephony_provider.';
COMMENT ON COLUMN agency_campaigns.abandon_announcement_id IS
  'Announcement played to a customer on an abandoned call before hangup. NULL = hang up silently; the attempt is recorded abandoned either way.';
COMMENT ON COLUMN agency_campaigns.abandonment_ceiling_pct IS
  'Rolling-24h abandonment rate (percent) at which this campaign auto-pauses. Defaults to DEFAULT_ABANDONMENT_CEILING_PCT.';
COMMENT ON COLUMN agency_campaigns.pause_reason IS
  'Why the campaign is paused: supervisor action, or the abandonment guardrail. NULL whenever the campaign is not paused.';
COMMENT ON COLUMN agency_campaigns.paused_at IS
  'When the current pause began. Cleared on resume/start, so it never describes an earlier pause.';
COMMENT ON COLUMN agency_campaigns.pause_abandonment_rate_pct IS
  'The abandonment rate as measured at the moment of an auto-pause, frozen. NULL for a supervisor pause. Never recomputed — the 24h window slides while the campaign is paused.';
COMMENT ON COLUMN agency_campaigns.started_at IS
  'FIRST transition into running, ever — first-write-wins in transitionStatus (COALESCE(started_at, now())). Never overwritten by a resume.';
COMMENT ON COLUMN agency_campaigns.ended_at IS
  'Entry into a terminal status (completed or stopped). NULL = still live. Supersedes completed_at, which holds the same instant under a name that is wrong for a stopped campaign.';
COMMENT ON COLUMN agency_campaigns.completed_at IS
  'LEGACY spelling of ended_at, written in lockstep with it. Retained only because it is already on a shipped payload; read ended_at.';
COMMENT ON COLUMN agency_campaigns.last_transition_by_user_id IS
  'User id that caused the CURRENT status, or NULL for an automatic/unattributed transition (opaque to the dialer runtime). Written unconditionally by every transition.';
COMMENT ON COLUMN agency_campaigns.last_transition_by_name IS
  'Display name as the public API layer knew it AT the transition — a snapshot, never refreshed and never joined. NULL beside a non-null id means an id-only actor.';
COMMENT ON COLUMN agency_campaigns.parent_campaign_id IS
  'The campaign this one was retried FROM, or NULL when it is not a retry. A '
  'pointer, one hop — ON DELETE SET NULL, because a pointer to a deleted row '
  'should become NULL rather than lie. Use root_campaign_id, not a walk of this, '
  'to read the whole chain.';
COMMENT ON COLUMN agency_campaigns.root_campaign_id IS
  'The FIRST campaign in this retry chain — a denormalised grouping key so the '
  'lineage strip is one indexed read rather than a recursive walk. Carries NO '
  'foreign key (it is a grouping key, not a reference) and is deliberately NULL '
  'on generation-0 campaigns, so every reader must spell it '
  'COALESCE(root_campaign_id, id).';
COMMENT ON COLUMN agency_campaigns.retry_generation IS
  '0 = not a retry (the default). 1 = a '
  'retry of an ordinary campaign, 2 = a retry of that, and so on. Bounded at the '
  'route by RETRY_MAX_GENERATION rather than by a CHECK, because the ceiling is a '
  'product rule that will be tuned and a CHECK would make tuning it a migration.';
COMMENT ON COLUMN agency_campaigns.retry_selector IS
  'The contact filter that produced this campaign''s roster, frozen as sent. A '
  'RECORD, NEVER RE-EXECUTED: the parent keeps moving if it is resumed, so '
  're-running it later would produce a different set and make this roster '
  'non-reproducible from its own row. NULL when retry_generation = 0. Also the '
  'source of the agent console''s retry banner copy, rendered server-side so the '
  'copy and the query cannot disagree.';
COMMENT ON COLUMN agency_campaigns.retry_idempotency_key IS
  'Client-minted key making POST /retry at-most-once per (tenant, account, key). Minted by the browser when the retry dialog opens and forwarded unchanged — a key generated per request protects nothing. NULL = an unkeyed create, which has no replay protection.';

-- One definition of row identity, used by the INSERT in
-- `agency.repository.ts#applyIngestChunk`, so the callers cannot drift into
-- disagreeing about which rows are the same row.
--
-- NOT `STRICT`: `timezone` is NULL on most rows, and a STRICT function would
-- return NULL for all of them — leaving them out of the partial index and
-- silently switching idempotency off for the common case.
--
-- `jsonb` (not `json`) canonicalises key order, whitespace and duplicate keys on
-- input, so `context::text` is stable for equal values regardless of the column
-- order the CSV happened to have.
--
-- **STABLE, not IMMUTABLE.** The body calls `jsonb_build_object`, which Postgres
-- declares STABLE, and a function may not claim a stricter volatility than what it
-- calls. The unique index is on the stored `row_fingerprint` COLUMN, not on this
-- expression, so no index ever caches a value derived from it.
CREATE OR REPLACE FUNCTION agency_contact_row_fingerprint(
  p_phone    VARCHAR,
  p_context  JSONB,
  p_timezone VARCHAR
) RETURNS VARCHAR AS $$
  SELECT md5(
    jsonb_build_object(
      'p',  p_phone,
      'c',  COALESCE(p_context, '{}'::jsonb),
      'tz', p_timezone
    )::text
  );
$$ LANGUAGE sql STABLE;

COMMENT ON FUNCTION agency_contact_row_fingerprint(VARCHAR, JSONB, VARCHAR) IS
  'Roster-row identity: md5 of phone + context + timezone. The one definition, '
  'shared by the ingest INSERT and any backfill of row_fingerprint.';

CREATE TABLE agency_contacts (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id       UUID NOT NULL REFERENCES agency_campaigns(id) ON DELETE CASCADE,
  tenant_id         UUID NOT NULL,
  account_id        UUID NOT NULL,

  phone_e164        VARCHAR(20) NOT NULL,
  -- Every non-phone CSV column, as uploaded, original headers as keys. This is what
  -- the agent screen renders. Deliberately schemaless: arbitrary columns is a
  -- hard requirement and we will not migrate per customer.
  context           JSONB NOT NULL DEFAULT '{}'::jsonb,
  source_row_number INTEGER,
  -- Derived at ingest from a mapped column only — NEVER inferred from the area
  -- code (NANP prefixes cross timezone boundaries and portability has
  -- decoupled prefix from location). NULL ⇒ the campaign default applies.
  timezone          VARCHAR(64),

  -- pending → in_flight → connected → completed | exhausted | suppressed
  state             VARCHAR(20) NOT NULL DEFAULT 'pending',
  attempt_count     INTEGER NOT NULL DEFAULT 0,
  last_outcome      VARCHAR(30),
  last_disposition  VARCHAR(50),
  next_attempt_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  suppressed_reason VARCHAR(40),   -- dnc | invalid | max_attempts | manual

  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- the our-fault redial ledger. No index: only ever read on a row
  -- already fetched by primary key or already being UPDATEd by id.
  our_fault_attempts INTEGER NOT NULL DEFAULT 0,

  -- nullable on purpose — the unique index below is partial on NOT NULL.
  row_fingerprint   VARCHAR(32),

  -- provenance only, never identity. Never indexed.
  csv_line_number   INTEGER,

  -- retry lineage.
  source_contact_id UUID REFERENCES agency_contacts(id) ON DELETE SET NULL,
  root_contact_id   UUID,

  CONSTRAINT ck_agency_contact_state CHECK (state IN
    ('pending','in_flight','connected','completed','exhausted','suppressed')),
  CONSTRAINT ck_agency_contact_context CHECK (jsonb_typeof(context) = 'object')
);

-- THE hot query: "next dialable contact for this campaign". The partial index
-- keeps it O(log n) as completed rows accumulate into the millions, and it is the
-- reason anything not dialable RIGHT NOW must not satisfy the predicate — an
-- unclaimed contact outside its calling window is pushed forward to the next
-- window-open instant rather than returned with next_attempt_at = now().
CREATE INDEX idx_agency_contacts_dialable
  ON agency_contacts (campaign_id, next_attempt_at)
  WHERE state = 'pending';

-- DNC sweeps and cross-campaign "have we called this number" lookups.
CREATE INDEX idx_agency_contacts_phone
  ON agency_contacts (tenant_id, phone_e164);

-- Roster-ingest idempotency, at the row level. LEGACY —
-- nothing writes source_row_number any more; dropping this index and the column is
-- the final cleanup step. Partial, so a non-CSV
-- insert path with a NULL row number never conflicts.
CREATE UNIQUE INDEX uq_agency_contacts_source_row
  ON agency_contacts (campaign_id, source_row_number)
  WHERE source_row_number IS NOT NULL;

-- THE constraint. Partial, so the legacy ambiguous rows — and any
-- non-CSV insert path that writes no fingerprint — never conflict.
--
-- ⚠️ THE INDEX IS NOT PARTIAL ON LIVENESS, AND IT MUST BECOME SO BEFORE ANY
-- ROSTER-REPLACE / SUPERSEDE FEATURE LANDS. A fingerprint occupies its
-- `(campaign_id, row_fingerprint)` slot forever, whether or not the contact is
-- still live.
CREATE UNIQUE INDEX uq_agency_contacts_row_fingerprint
  ON agency_contacts (campaign_id, row_fingerprint)
  WHERE row_fingerprint IS NOT NULL;

-- Keep the spelling byte-identical to `CONTACT_PHONE_DIGITS_SQL` in
-- `agency.repository.ts` — Postgres matches expression indexes structurally.
CREATE INDEX idx_agency_contacts_campaign_phone_digits
  ON agency_contacts (campaign_id, regexp_replace(phone_e164, '[^0-9]', '', 'g'));

CREATE INDEX idx_agency_contacts_reporting
  ON agency_contacts (campaign_id, created_at DESC, id DESC);

CREATE INDEX idx_agency_contacts_phone_suffix
  ON agency_contacts (
    campaign_id,
    reverse(regexp_replace(phone_e164, '[^0-9]', '', 'g')) text_pattern_ops
  );

CREATE INDEX idx_agency_contacts_root
  ON agency_contacts (root_contact_id);

CREATE TRIGGER trg_agency_contacts_updated_at
  BEFORE UPDATE ON agency_contacts
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE OR REPLACE FUNCTION agency_contact_stamp_root() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.root_contact_id IS NULL THEN
    NEW.root_contact_id := NEW.id;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

COMMENT ON FUNCTION agency_contact_stamp_root() IS
  'Stamps root_contact_id := id on any roster row inserted without one, so the '
  'agent''s lineage-scoped prior-attempt read is a single indexed equality with no '
  'branch for the (overwhelmingly common) non-retry case. Fires for rows written '
  'by pre-112 code too, which is what lets a later release tighten the column to '
  'NOT NULL without a second backfill.';

CREATE TRIGGER trg_agency_contacts_root
  BEFORE INSERT ON agency_contacts
  FOR EACH ROW EXECUTE FUNCTION agency_contact_stamp_root();

COMMENT ON TABLE agency_contacts IS
  'Agency dialer execution roster — one row per accepted CSV row. Claimed with FOR UPDATE SKIP LOCKED by the pacing tick.';
COMMENT ON COLUMN agency_contacts.context IS
  'Every non-phone CSV column as uploaded, original headers as keys — what the agent screen renders.';
COMMENT ON COLUMN agency_contacts.our_fault_attempts IS
  'Redials caused by OUR faults (agent socket drop before bridge, '
  'reaper requeue after a crash). Deliberately separate from attempt_count, which '
  'is the customer''s retry allowance and must never be spent on our own failures. '
  'Bounded by OUR_FAULT_REDIAL_BOUND in src/agency/retry-policy.ts — a regulated '
  'repeat-dial limit, which is why the bound lives below the retry policy and no '
  'operator config can raise it.';
COMMENT ON COLUMN agency_contacts.row_fingerprint IS
  'Content identity of the roster row (phone + context + timezone), via '
  'agency_contact_row_fingerprint(). Replaces (campaign_id, source_row_number) '
  'as the ingest-replay guard so a SECOND CSV can top up a live campaign while a '
  're-upload of the SAME file after a server restart still refuses the rows that '
  'already landed. NULL on any row whose content was already ambiguous — those sit '
  'outside the unique index.';
COMMENT ON COLUMN agency_contacts.csv_line_number IS
  'The row''s line number in the uploaded CSV (the ingest''s `startLine`) — provenance '
  'only, never identity: row identity is `row_fingerprint`. It lives here '
  'rather than in `source_row_number` because the unique index on '
  '(campaign_id, source_row_number) is PARTIAL on NOT NULL, so new rows leave that '
  'column NULL to sit outside it and let a second CSV top up a live campaign. '
  'Never indexed.';
COMMENT ON COLUMN agency_contacts.source_row_number IS
  'LEGACY, no longer written. Superseded by `csv_line_number` for provenance and by '
  '`row_fingerprint` for identity. NULL on every row the current ingest writes; '
  'uq_agency_contacts_source_row still enforces it where it is set. A candidate to '
  'drop, with that index.';
COMMENT ON COLUMN agency_contacts.source_contact_id IS
  'The parent campaign''s roster row this one was copied from when a retry '
  'campaign was created, or NULL for an ordinary ingested row. Provenance, '
  'one hop — ON DELETE SET NULL, because a pointer to a deleted row should become '
  'NULL rather than lie. Do NOT walk this to build history; that is what '
  'root_contact_id exists to avoid (the read is on the dial hot path).';
COMMENT ON COLUMN agency_contacts.root_contact_id IS
  'The FIRST roster row in this contact''s retry chain — its own id for every '
  'ordinary contact, stamped by trg_agency_contacts_root. The agent''s prior '
  'attempts are read as `WHERE root_contact_id = $1` across the whole lineage, '
  'which keeps that read (synchronous, before the dial) one indexed equality '
  'rather than a recursive walk. Carries NO foreign key on purpose: it is a '
  'grouping key, and campaign_id is ON DELETE CASCADE, so an FK here would either '
  'cascade a parent''s deletion into a live child campaign or block the delete. A '
  'dangling root returns fewer history rows, which is the honest answer. Nullable '
  'at the column level; the BEFORE INSERT trigger is what fills it.';
COMMENT ON INDEX idx_agency_contacts_campaign_phone_digits IS
  'Prefilter for AgencyContactRepository.suppressByPhone: every row in one campaign carrying one number, whatever formatting the roster stored. A deliberately LOOSER projection than normalizeE164 — never use it as the normalizer.';
COMMENT ON INDEX idx_agency_contacts_reporting IS
  'Supervisor roster read — keyset on (created_at DESC, id DESC) within one campaign.';
COMMENT ON INDEX idx_agency_contacts_phone_suffix IS
  'Trailing-digit contact search — suffix on the number is prefix on its reverse.';
COMMENT ON INDEX idx_agency_contacts_root IS
  'Serves the agent panel''s lineage-scoped prior-attempt read '
  '(findPriorForContactLineage), which runs synchronously inside the dial tick '
  'BEFORE the dial. Not partial and not covering. A deployment with a large '
  'agency_contacts should build this CONCURRENTLY out of band before running migrate:up.';

-- The live-session uniqueness is per TENANT (uq_agency_agent_live_tenant).
--
-- Liveness does NOT come from this table. The authority is the Redis
-- ownership key `agency:station:{sessionId}`, renewed by the station socket's
-- own heartbeat; `state`/`last_heartbeat` here are a durable mirror written by a
-- sweeper, and are what a reconnecting agent is REHYDRATED from after a restart
-- (landing in `break`, never `available`, so the engine cannot dial into a
-- pool that has not demonstrably re-attached).
CREATE TABLE agency_agent_sessions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL,
  account_id      UUID NOT NULL,
  campaign_id     UUID NOT NULL REFERENCES agency_campaigns(id) ON DELETE CASCADE,
  agent_user_id   UUID NOT NULL,   -- the user id, opaque to the dialer runtime

  -- offline → available → reserved → on_call → wrapup → available | break
  state           VARCHAR(20) NOT NULL DEFAULT 'offline',
  break_reason    VARCHAR(50),
  state_since     TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Which replica owns this agent's media socket. Written and read from
  -- day one even though the dialer runs single-replica, so the invariant "dial only
  -- on the owning replica" is exercised continuously rather than being dead code.
  owner_replica   VARCHAR(100),
  last_heartbeat  TIMESTAMPTZ NOT NULL DEFAULT now(),

  joined_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  left_at         TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT ck_agency_agent_state CHECK (state IN
    ('offline','available','reserved','on_call','wrapup','break'))
);

-- one LIVE session per agent per TENANT. The reservation CAS key is per
-- SESSION, so two live sessions for one human are two independently reservable
-- agents and two calls bridged into one headset. `account_id` is deliberately NOT
-- in the key: an agent moving between two accounts of the same tenant is exactly
-- the double-bridge case, so the constraint must span accounts. `joinOrRehydrate`
-- names this arbiter in its ON CONFLICT.
CREATE UNIQUE INDEX uq_agency_agent_live_tenant
  ON agency_agent_sessions (tenant_id, agent_user_id)
  WHERE left_at IS NULL;

-- The tick's `available` count and the supervisor's agents-by-state panel.
CREATE INDEX idx_agency_agent_sessions_live
  ON agency_agent_sessions (campaign_id, state)
  WHERE left_at IS NULL;

CREATE TRIGGER trg_agency_agent_sessions_updated_at
  BEFORE UPDATE ON agency_agent_sessions
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

COMMENT ON TABLE agency_agent_sessions IS
  'An agent''s durable session on a campaign. Liveness is the Redis ownership key, not this row.';
COMMENT ON COLUMN agency_agent_sessions.agent_user_id IS
  'The agent''s user id — opaque to the dialer runtime, which keeps no identity model of its own.';
COMMENT ON INDEX uq_agency_agent_live_tenant IS
  'One live session per agent per tenant, rather than per campaign: the reservation CAS key in agent-state-machine.ts is per SESSION, so two live sessions for one human are two independently reservable agents and one pair of ears.';

CREATE TABLE agency_agent_session_events (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- CASCADE, unlike `agency_call_attempts.webrtc_call_id`, which is deliberately
  -- un-FK'd so the audit spine outlives a purged call. This is not an audit
  -- spine: an event whose session row is gone has no campaign, no agent and no
  -- neighbouring events, so it cannot contribute an interval to anything. It is
  -- an occupancy input, and an orphan is only noise.
  session_id      UUID NOT NULL REFERENCES agency_agent_sessions(id) ON DELETE CASCADE,

  tenant_id       UUID NOT NULL,
  account_id      UUID NOT NULL,

  -- Denormalised from the session. Immutable on the session row, so the copy
  -- cannot drift.
  campaign_id     UUID NOT NULL,
  agent_user_id   UUID NOT NULL,   -- the user id, opaque to the dialer runtime

  -- NULL for the first transition into a session.
  from_state      VARCHAR(20),
  to_state        VARCHAR(20) NOT NULL,

  -- Carried only when `to_state = 'break'`, and carried at the moment of the
  -- transition rather than read from the session later: the session column keeps
  -- the LAST reason after the agent returns, so a later read of it would label a
  -- historic interval with a reason chosen after it ended.
  break_reason    VARCHAR(50),

  -- Supplied EXPLICITLY by the writer, which projects `clock_timestamp()` from the
  -- UPDATE that performed the transition. The DEFAULT is a backstop, not the
  -- normal path: because the insert is a second statement (see below), defaulting
  -- would stamp the event when the LOG write ran, and two transitions on one
  -- session racing from two replicas can reach that insert in the opposite order
  -- to the order the database applied them — after which `lead(at)` differences
  -- the wrong pairs and reports the states in the wrong sequence.
  at              TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT ck_agency_session_event_to_state CHECK (to_state IN
    ('offline','available','reserved','on_call','wrapup','break')),
  CONSTRAINT ck_agency_session_event_from_state CHECK (from_state IS NULL OR from_state IN
    ('offline','available','reserved','on_call','wrapup','break'))
);

-- THE occupancy read: one agent, one time range, ordered so consecutive events
-- can be differenced with `lead(at)` without a sort. `agent_user_id` leads
-- because the question is always about a person — a session-keyed index would make
-- an agent's shift history N index scans instead of one range scan.
-- (`session_id` is deliberately NOT indexed.)
CREATE INDEX idx_agency_session_events_agent
  ON agency_agent_session_events (agent_user_id, at);

COMMENT ON TABLE agency_agent_session_events IS
  'One row per agent state transition. The only durable record of time-in-state — agency_agent_sessions.state/state_since are a snapshot every transition overwrites. Occupancy is only meaningful from this migration forward: earlier sessions have no events and must read as zero, never as inferred.';
COMMENT ON COLUMN agency_agent_session_events.agent_user_id IS
  'Denormalised from agency_agent_sessions so an occupancy query needs no join back to the session (the user id, opaque to the dialer runtime).';
COMMENT ON COLUMN agency_agent_session_events.from_state IS
  'NULL for the first transition into a session — the join upsert creates the row in break and there is no prior state to name.';

-- One row per dial. `webrtc_call_id` is the back-reference to the media leg, an
-- `agency_calls.id` (the column keeps its older name).
CREATE TABLE agency_call_attempts (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id         UUID NOT NULL REFERENCES agency_campaigns(id) ON DELETE CASCADE,
  contact_id          UUID NOT NULL REFERENCES agency_contacts(id) ON DELETE CASCADE,
  tenant_id           UUID NOT NULL,
  account_id          UUID NOT NULL,
  attempt_number      INTEGER NOT NULL,

  -- The media leg. NULL until the dial is placed. Deliberately no FK: the
  -- attempt row is the audit spine and must outlive a purged call row.
  webrtc_call_id      UUID,
  caller_id           VARCHAR(20) NOT NULL,
  reserved_agent_id   UUID REFERENCES agency_agent_sessions(id),

  -- queued → dialing → ringing → answered → bridged → ended
  state               VARCHAR(20) NOT NULL DEFAULT 'queued',
  outcome             VARCHAR(30),  -- connected|no_answer|busy|failed|machine|invalid|abandoned
  disposition_code    VARCHAR(50),
  notes               TEXT,
  callback_at         TIMESTAMPTZ,

  dialed_at           TIMESTAMPTZ,
  answered_at         TIMESTAMPTZ,
  bridged_at          TIMESTAMPTZ,
  ended_at            TIMESTAMPTZ,
  talk_seconds        INTEGER,
  wrapup_seconds      INTEGER,

  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- who recorded the disposition, SEPARATELY from the reserved agent.
  dispositioned_by_user_id UUID,
  dispositioned_at         TIMESTAMPTZ,
  dispositioned_on_behalf  BOOLEAN NOT NULL DEFAULT false,

  -- wrap-up measurement.
  wrapup_started_at   TIMESTAMPTZ,
  wrapup_ended_at     TIMESTAMPTZ,
  wrapup_resolution   VARCHAR(30),

  abandon_reason      VARCHAR(30),

  CONSTRAINT ck_agency_attempt_state CHECK (state IN
    ('queued','dialing','ringing','answered','bridged','ended')),
  CONSTRAINT ck_agency_wrapup_resolution CHECK (
    wrapup_resolution IS NULL OR wrapup_resolution IN (
      'auto_return', 'disposition_submitted', 'agent_returned',
      'forced', 'agent_left', 'campaign_stopped'
    )
  )
);

CREATE UNIQUE INDEX uq_agency_attempt_number
  ON agency_call_attempts (contact_id, attempt_number);

-- THE duplicate-dial backstop: at most ONE non-terminal attempt per contact,
-- enforced by the database regardless of what any pacing loop believes. The
-- leader lease is the efficiency mechanism; this index plus the contact claim's
-- FOR UPDATE SKIP LOCKED is the correctness mechanism, and it holds through a GC
-- pause, a network partition or clock skew. Do not weaken the predicate — an
-- earlier draft indexed a column that made this vacuous.
CREATE UNIQUE INDEX uq_agency_attempt_live
  ON agency_call_attempts (contact_id)
  WHERE state <> 'ended';

CREATE INDEX idx_agency_attempts_live
  ON agency_call_attempts (campaign_id)
  WHERE state IN ('queued','dialing','ringing','answered','bridged');

CREATE INDEX idx_agency_attempts_reporting
  ON agency_call_attempts (campaign_id, created_at DESC);

-- Webhook/settlement → attempt correlation (every carrier event carries the
-- webrtc call id, never the attempt id).
CREATE INDEX idx_agency_attempts_webrtc
  ON agency_call_attempts (webrtc_call_id)
  WHERE webrtc_call_id IS NOT NULL;

-- "What is this agent currently on" — station reconnect + supervisor views.
CREATE INDEX idx_agency_attempts_agent
  ON agency_call_attempts (reserved_agent_id)
  WHERE state <> 'ended';

-- supervisor-activity review — "which write-ups on this campaign were not
-- done by the agent who took the call". Partial, because it is a rare flag.
CREATE INDEX idx_agency_attempts_on_behalf
  ON agency_call_attempts (campaign_id, dispositioned_at DESC)
  WHERE dispositioned_on_behalf;

-- `dialed_at` MUST lead (a time range across all campaigns). Kept as the metering
-- read, although v1 has no billing sweep.
CREATE INDEX idx_agency_attempts_billing
  ON agency_call_attempts (dialed_at, campaign_id)
  WHERE dialed_at IS NOT NULL;

CREATE INDEX idx_agency_attempts_wrapup
  ON agency_call_attempts (campaign_id)
  INCLUDE (wrapup_started_at, wrapup_ended_at, wrapup_resolution)
  WHERE wrapup_ended_at IS NOT NULL;

CREATE INDEX idx_agency_attempts_agent_bridged
  ON agency_call_attempts (reserved_agent_id)
  INCLUDE (id)
  WHERE bridged_at IS NOT NULL;

CREATE INDEX idx_agency_attempts_keyset
  ON agency_call_attempts (campaign_id, created_at DESC, id DESC);

CREATE INDEX idx_agency_attempts_agent_dialed
  ON agency_call_attempts (reserved_agent_id, dialed_at DESC)
  WHERE dialed_at IS NOT NULL;

CREATE TRIGGER trg_agency_call_attempts_updated_at
  BEFORE UPDATE ON agency_call_attempts
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

COMMENT ON TABLE agency_call_attempts IS
  'One row per dial — the agency dialer audit spine. uq_agency_attempt_live is the duplicate-dial backstop.';
COMMENT ON COLUMN agency_call_attempts.dispositioned_by_user_id IS
  'User id that recorded the disposition — NOT necessarily the reserved agent.';
COMMENT ON COLUMN agency_call_attempts.wrapup_started_at IS
  'When wrap-up actually began, stamped by WrapupManager. Deliberately not inferred from ended_at.';
COMMENT ON COLUMN agency_call_attempts.wrapup_ended_at IS
  'When wrap-up actually ended. NULL = never concluded on an observed path.';
COMMENT ON COLUMN agency_call_attempts.wrapup_resolution IS
  'How wrap-up ended (WrapupResolution). The measured wrap-up average reads disposition_submitted, auto_return and agent_returned.';
COMMENT ON COLUMN agency_call_attempts.abandon_reason IS
  'Why an abandoned attempt reached no agent: station_lost | bind_failed | bridge_late | unattributed. NULL = not an abandoned attempt. AgencyAbandonReason also declares no_agent_available, which nothing can produce while pacing is 1:1. Diagnosis only — the compliance numerator reads ABANDONED_ATTEMPT_PREDICATE_SQL, never this column.';
COMMENT ON INDEX idx_agency_attempts_billing IS
  'Hourly dial-attempt billing sweep. dialed_at MUST lead: the 60s sweep is a time range across all campaigns and has no campaign_id to filter on.';
COMMENT ON INDEX idx_agency_attempts_agent_bridged IS
  'Supervisor roster calls_handled roll-up. Matches supervisorAgents()''s join predicate exactly — reserved_agent_id filtered on bridged_at IS NOT NULL, with no state filter, so it is deliberately NOT a widening of idx_agency_attempts_agent, which serves a different, state-scoped caller.';
COMMENT ON INDEX idx_agency_attempts_keyset IS
  'Supervisor attempt read — keyset on (created_at DESC, id DESC) within one campaign.';
COMMENT ON INDEX idx_agency_attempts_agent_dialed IS
  'The agent stats aggregate (GET /agency-agents/:id/stats): (reserved_agent_id, dialed_at DESC) over dialled attempts only. Not used by the sibling /attempts spine, which bounds created_at and must return attempts with a NULL dialed_at. Deliberately NOT a widening of idx_agency_attempts_agent (live-only) or idx_agency_attempts_agent_bridged (no time key) — a date-ranged historical aggregate is a third shape and gets its own index.';

CREATE TABLE agency_ingest_chunks (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id     UUID NOT NULL REFERENCES agency_campaigns(id) ON DELETE CASCADE,

  -- The ingest job id, stable across every retry of one upload.
  ingest_job_id   VARCHAR(100) NOT NULL,
  -- 0-based, stable per chunk. (job, index) is what makes a retry recognisable.
  chunk_index     INTEGER NOT NULL,
  -- Denormalized `{ingest_job_id}-{chunk_index}`. VARCHAR(128) matches the width
  -- used by every other idempotency key in the schema.
  idempotency_key VARCHAR(128) NOT NULL,
  -- Total chunks the uploader intends to send. Lets the dialer runtime answer "is the
  -- roster complete" without the uploader having to make a separate finalize call it might
  -- lose — a lost final chunk would otherwise leave a campaign permanently
  -- un-startable with nothing to diagnose it by.
  chunk_count     INTEGER,
  row_count       INTEGER NOT NULL DEFAULT 0,

  applied_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- NULLABLE WITH NO DEFAULT — NULL means "we never recorded this".
  rejected_duplicate_rows INTEGER,
  -- The CAPPED sample, never the full set. `MAX_REPORTED_DUPLICATE_ROWS` (20) in
  -- `agency.repository.ts` bounds both what we return and what we store, so a
  -- 500-row chunk that collides entirely stores 20 integers, not 500. Storing the
  -- unbounded set would put an arbitrarily large array on a table that already
  -- carries one row per 500-row chunk of every roster ever uploaded.
  duplicate_source_rows INTEGER[]
);

-- THE idempotency constraint. A replay is one cheap conflict, not 500 upserts.
CREATE UNIQUE INDEX uq_agency_ingest_chunk
  ON agency_ingest_chunks (campaign_id, idempotency_key);

-- "Which chunks of this job have landed" — serves the completeness check and the
-- missing_chunks[] response that lets the uploader re-send precisely the gap.
CREATE INDEX idx_agency_ingest_chunks_job
  ON agency_ingest_chunks (campaign_id, ingest_job_id, chunk_index);

COMMENT ON TABLE agency_ingest_chunks IS
  'Roster-ingest idempotency markers. Inserted in the same transaction as their contact rows, so a chunk is all-or-nothing.';
COMMENT ON COLUMN agency_ingest_chunks.rejected_duplicate_rows IS
  'Rows this chunk carried that the roster already held unchanged, recorded at apply '
  'time so a REPLAY of the chunk can report the same number the original response '
  'did. NULL means the count was never recorded — deliberately NOT 0, because a '
  'replay must be able to say "unknown" rather than silently undercount.';
COMMENT ON COLUMN agency_ingest_chunks.duplicate_source_rows IS
  'Capped sample (MAX_REPORTED_DUPLICATE_ROWS = 20) of the source_row_numbers behind '
  'rejected_duplicate_rows, for the same replay-fidelity reason. A sample, not the '
  'set, exactly as the API field of the same name. NULL means not recorded.';

CREATE TABLE agency_dnc_outbox (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL,
  -- Already normalized by `normalizeE164` at enqueue — the SAME function
  -- `DncRegistry.check` runs on both sides of its comparison. A row is never
  -- written for a phone that does not normalize, because the DNC registry would 400 it
  -- identically forever and an un-landable row is not durability, it is a leak.
  phone_e164      VARCHAR(20) NOT NULL,
  reason          TEXT,
  -- The actor AS GIVEN. Nullable, and never derived: a supervisor acting on
  -- another agent's behalf must not be recorded as that agent so a
  -- missing actor stays missing rather than becoming a confidently-wrong one.
  added_by        VARCHAR(100),
  status          VARCHAR(16) NOT NULL DEFAULT 'pending',
  -- attempts = forwards actually spent, and what the bounded-retry ceiling gates
  -- on. Infra churn (a deploy, a crash recovery) does NOT increment it;
  -- attempts_total is the lifetime ceiling that stops a job resurrecting forever.
  attempts        INTEGER NOT NULL DEFAULT 0,
  attempts_total  INTEGER NOT NULL DEFAULT 0,
  -- Claim fencing: a recovered row gets a new generation, so a resurrected
  -- original sender's write is rejected rather than stomping the recovery.
  claim_generation INTEGER NOT NULL DEFAULT 0,
  claimed_at      TIMESTAMPTZ,
  heartbeat_at    TIMESTAMPTZ,
  next_attempt_at TIMESTAMPTZ,
  -- Stamped ONCE at insert and never touched again. This is what the age gauge
  -- reads, NOT updated_at — the sweep re-UPDATEs every unlanded row on each
  -- tick and the BEFORE UPDATE trigger resets updated_at, so a wedged row
  -- would forever look one sweep old and the "unpropagated for > N minutes"
  -- alert could never fire. The same trap applies to any
  -- "pending since" stamp that the sweep would otherwise reset.
  pending_since   TIMESTAMPTZ NOT NULL DEFAULT now(),
  landed_at       TIMESTAMPTZ,
  error_code      VARCHAR(48),
  error_message   TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- the SCOPE, as a value. NULL = tenant-wide. Never backfill this column.
  -- No FK to `agency_campaigns`: the outbox outlives the campaign on purpose.
  campaign_id     UUID,

  -- 'pending'   — written, not yet accepted by the DNC registry. THE state that answers
  --               "are there customers who asked not to be called whose request
  --               has not propagated".
  -- 'sending'   — claimed by a replica, forward in flight.
  -- 'landed'    — the DNC registry reported the tenant-wide entry recorded.
  -- 'abandoned' — the bounded retry is exhausted. Deliberately NOT a delete and
  --               deliberately NOT silent: it is the alertable state, and the row
  --               stays so a human can see what was lost and repost it.
  CONSTRAINT ck_agency_dnc_outbox_status CHECK (status IN (
    'pending', 'sending', 'landed', 'abandoned'
  ))
);

-- The claim query: unlanded work whose backoff is due, oldest first.
CREATE INDEX idx_agency_dnc_outbox_runnable
  ON agency_dnc_outbox (next_attempt_at, pending_since)
  WHERE status = 'pending';

-- Crash recovery: rows a dead replica left mid-forward.
CREATE INDEX idx_agency_dnc_outbox_stale
  ON agency_dnc_outbox (heartbeat_at)
  WHERE status = 'sending';

-- The operator question, per tenant: "is anything still unpropagated, and for
-- how long". Partial so it stays small — a healthy fleet lands rows and this
-- index holds almost nothing.
CREATE INDEX idx_agency_dnc_outbox_unlanded
  ON agency_dnc_outbox (tenant_id, pending_since)
  WHERE status IN ('pending', 'sending', 'abandoned');

CREATE TRIGGER trg_agency_dnc_outbox_updated_at
  BEFORE UPDATE ON agency_dnc_outbox
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

COMMENT ON COLUMN agency_dnc_outbox.campaign_id IS
  'The SCOPE of this DNC record, as a value. An id = campaign-scoped: forwarded to the DNC registry, which names the campaign; the row does not enter the flat dnc:{tenant} set. NULL = tenant-wide: the field is omitted on the forward, the DNC registry writes the unscoped entry, it reaches the flat set and blocks the number in every campaign. NULL is never "unknown" — it is an explicit tenant-wide escalation, or a row enqueued before campaign scoping shipped, which was created tenant-wide. Never backfill this column.';

-- ════════════════════════════════════════════════════════════════════════════
-- 10. agency_calls — the browser↔PSTN media leg (formerly `webrtc_calls`)
-- ════════════════════════════════════════════════════════════════════════════

-- No sip_connection_id (SIP), telephony_credential_id (BYOC credentials) or
-- idx_webrtc_calls_tenant_dialer (softphone-only list).
-- Column names keep their older `webrtc_` spelling where they had it; object
-- names that embedded `webrtc_calls` are named for `agency_calls` (BASELINE.md).
CREATE TABLE agency_calls (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           UUID NOT NULL,
  account_id          UUID NOT NULL,

  -- The tenant's allocated DID used as the outbound caller ID (from), and the
  -- dialed PSTN number (to), both E.164.
  caller_id           VARCHAR(20) NOT NULL,
  destination_phone   VARCHAR(20) NOT NULL,

  provider            VARCHAR(20) NOT NULL DEFAULT 'voicelink',
  provider_call_id    VARCHAR(100),

  -- initiating → ringing → in_progress → completed | failed | no_answer | busy | canceled
  status              VARCHAR(20) NOT NULL DEFAULT 'initiating',
  outcome             VARCHAR(255),
  error_code          VARCHAR(50),
  error_message       TEXT,

  -- Opaque caller/user reference to the user (who placed the call); optional.
  initiated_by        VARCHAR(100),
  metadata            JSONB NOT NULL DEFAULT '{}',

  -- duration_seconds = created→end (broad metric); talk_time_seconds = answer→end
  -- (answer-anchored, what billing rounds to minutes — mirrors calls.talk_time_seconds).
  answered_at         TIMESTAMPTZ,
  ended_at            TIMESTAMPTZ,
  duration_seconds    INTEGER,
  talk_time_seconds   INTEGER,

  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- opt-in call recording.
  recording_requested        BOOLEAN NOT NULL DEFAULT FALSE,
  recording_url              TEXT,
  recording_duration_seconds INTEGER,

  -- analysis columns.
  -- Provenance only (never re-read at run time — the job snapshots dimensions).
  -- Immutable after insert, like recording_requested / sip_connection_id.
  analysis_profile_id UUID,
  -- Per-call override of the profile's language_hint (bilingual team, one profile).
  analysis_language   VARCHAR(20),
  -- Mirrors the job status for read convenience. 'deleted' is the DSAR erasure state.
  analysis_status     VARCHAR(24) DEFAULT NULL,
  call_analysis       JSONB       DEFAULT NULL,
  conversation_log    JSONB       DEFAULT NULL,
  -- Transcript provenance (incl. source_url actually consumed), so support can
  -- answer "where did this summary come from".
  transcript_meta     JSONB       DEFAULT NULL,
  -- Durable consent record. Immutable after insert.
  analysis_consent    BOOLEAN,
  analysis_consent_at TIMESTAMPTZ,

  -- correlation ids, deliberately NO foreign keys — this table is on the
  -- retention purge and a campaign may be deleted long after its calls were purged
  -- (or vice versa); a cascade in either direction would destroy the other side's
  -- audit trail.
  campaign_id         UUID,
  agency_attempt_id   UUID,

  CONSTRAINT ck_webrtc_status CHECK (
    status IN ('initiating','ringing','in_progress','completed','failed','no_answer','busy','canceled')
  ),
  CONSTRAINT ck_webrtc_analysis_status CHECK (
    analysis_status IS NULL OR analysis_status IN (
      'awaiting_recording','pending','completed','failed','skipped','expired','deleted'
    )
  )
);

CREATE TRIGGER trg_agency_calls_updated_at
  BEFORE UPDATE ON agency_calls
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- Hot list/usage read: tenant/account scoped, newest first.
CREATE INDEX idx_agency_calls_tenant
  ON agency_calls (tenant_id, account_id, created_at DESC);

-- Stale-call sweep: only non-terminal rows.
CREATE INDEX idx_agency_calls_active
  ON agency_calls (created_at)
  WHERE status IN ('initiating','ringing','in_progress');

CREATE INDEX idx_agency_calls_provider_call_id
  ON agency_calls (provider_call_id)
  WHERE provider_call_id IS NOT NULL;

CREATE INDEX idx_agency_calls_analysis_status
  ON agency_calls (analysis_status) WHERE analysis_status IS NOT NULL;

COMMENT ON COLUMN agency_calls.campaign_id IS
  'Agency campaign this media leg belongs to (NULL = an ordinary browser dialer call). Presence selects the agency billing rate.';
COMMENT ON COLUMN agency_calls.agency_attempt_id IS
  'agency_call_attempts.id this media leg was placed for. Correlation only — no FK, both sides purge independently.';

-- ════════════════════════════════════════════════════════════════════════════
-- 11. The durable analysis job (no settlement step)
-- ════════════════════════════════════════════════════════════════════════════

-- No settlement_* columns, constraint or index. `call_id` is NOT NULL,
-- ON DELETE CASCADE, onto agency_calls.
CREATE TABLE dialer_analysis_jobs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- FK to the dialer call; cascade so a purged call takes its job with it. The
  -- retention purge still deletes jobs explicitly first (FK-safe order).
  call_id         UUID NOT NULL REFERENCES agency_calls(id) ON DELETE CASCADE,
  tenant_id       UUID NOT NULL,
  account_id      UUID NOT NULL,
  -- Provenance only, and may reference a deactivated/deleted profile — no FK.
  profile_id      UUID,
  -- SNAPSHOT of the profile's dimensions + context at enqueue. The job is
  -- self-contained: a profile PUT (copy-on-write, deactivates the old row) or
  -- DELETE mid-flight cannot change or break what this job measures, and a retry
  -- months later still analyses against the profile as it was at call time.
  profile_snapshot JSONB,
  -- Snapshotted transcription language hint (per-call override wins over the
  -- profile's). Snapshotted so the runner never re-reads mutable call state.
  analysis_language VARCHAR(20),
  status          VARCHAR(24) NOT NULL DEFAULT 'awaiting_recording',
  -- attempts = provider calls actually spent. Infra churn (deploy, crash) does
  -- NOT increment it; attempts_total is the lifetime cap incl. manual retries.
  attempts        INTEGER NOT NULL DEFAULT 0,
  attempts_total  INTEGER NOT NULL DEFAULT 0,
  -- Claim fencing: a recovered job gets a new generation; a resurrected original
  -- runner's writes are rejected on mismatch.
  claim_generation INTEGER NOT NULL DEFAULT 0,
  -- Heartbeat for the crash-recovery sweep (KbIngestRecovery pattern).
  claimed_at      TIMESTAMPTZ,
  heartbeat_at    TIMESTAMPTZ,
  next_attempt_at TIMESTAMPTZ,
  -- Kept for metering: audio seconds the analysis consumed.
  analysis_audio_seconds INTEGER,
  error_code      VARCHAR(48),
  error_message   TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ck_dialer_analysis_job_status CHECK (status IN (
    'awaiting_recording','queued','transcribing','analyzing',
    'completed','failed','skipped','expired'
  ))
);

-- Idempotent enqueue: the (unauthenticated) recording webhook may fire repeatedly.
CREATE UNIQUE INDEX uq_dialer_analysis_jobs_call
  ON dialer_analysis_jobs (call_id);

-- Claim query: runnable work, oldest first.
CREATE INDEX idx_dialer_analysis_jobs_runnable
  ON dialer_analysis_jobs (status, next_attempt_at)
  WHERE status IN ('awaiting_recording','queued');

-- Crash-recovery sweep: stale in-flight rows.
CREATE INDEX idx_dialer_analysis_jobs_stale
  ON dialer_analysis_jobs (heartbeat_at)
  WHERE status IN ('transcribing','analyzing');

CREATE TRIGGER trg_dialer_analysis_jobs_updated_at
  BEFORE UPDATE ON dialer_analysis_jobs
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();


-- Down Migration
--
-- Drops everything the up section creates, dependents first. Tables are dropped
-- without CASCADE on purpose: an unexpected dependent (an object some later
-- migration added on top of the baseline) must fail this loudly rather than be
-- dropped silently. Dropping a partitioned parent drops its partitions.

DROP TABLE IF EXISTS dialer_analysis_jobs;
DROP TABLE IF EXISTS agency_calls;
DROP TABLE IF EXISTS agency_dnc_outbox;
DROP TABLE IF EXISTS agency_ingest_chunks;
DROP TABLE IF EXISTS agency_call_attempts;
DROP TABLE IF EXISTS agency_agent_session_events;
DROP TABLE IF EXISTS agency_agent_sessions;
DROP TABLE IF EXISTS agency_contacts;
DROP FUNCTION IF EXISTS agency_contact_stamp_root();
DROP FUNCTION IF EXISTS agency_contact_row_fingerprint(VARCHAR, JSONB, VARCHAR);
DROP TABLE IF EXISTS agency_campaigns;
DROP TABLE IF EXISTS call_analysis_profiles;
DROP TABLE IF EXISTS announcements;
DROP TABLE IF EXISTS audio_files;
DROP TABLE IF EXISTS feature_flag_overrides;
DROP TABLE IF EXISTS account_provider_concurrency_allocations;
DROP TABLE IF EXISTS account_settings;
DROP TABLE IF EXISTS agency_campaign_agents;
DROP TABLE IF EXISTS agency_ingest_jobs;
DROP TABLE IF EXISTS dnc_entries;
DROP TABLE IF EXISTS audit_logs;
DROP TABLE IF EXISTS platform_audit_log;
DROP TABLE IF EXISTS notification_deliveries;
DROP TABLE IF EXISTS user_notification_preferences;
DROP TABLE IF EXISTS phone_account_tags;
DROP TABLE IF EXISTS tenant_phone_assignments;
DROP TABLE IF EXISTS phone_numbers;
DROP TABLE IF EXISTS telephony_providers;
DROP TABLE IF EXISTS super_admin_audit_log;
DROP TABLE IF EXISTS super_admins;
DROP TABLE IF EXISTS membership_invites;
DROP TABLE IF EXISTS memberships;
DROP TYPE IF EXISTS membership_role;
DROP TABLE IF EXISTS users;
DROP TABLE IF EXISTS accounts;
DROP TABLE IF EXISTS tenants;
DROP FUNCTION IF EXISTS update_updated_at();
DROP EXTENSION IF EXISTS "uuid-ossp";
