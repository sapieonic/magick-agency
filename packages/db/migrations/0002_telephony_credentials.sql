-- 0002_telephony_credentials.sql — per-tenant carrier credentials (bring-your-own-carrier).
--
-- Decisions B18–B22 (docs/decisions.md): Plivo joins VoiceLink as a carrier, dialled on
-- the tenant's OWN Plivo account. The credential that dials it is stored here, sealed;
-- calls and campaigns pin the credential they dial on.
--
-- Runs as one node-pg-migrate SQL migration in one transaction; split on the up/down
-- marker comments (see 0001_baseline.sql's header for the regex).

-- Up Migration

INSERT INTO telephony_providers (name, display_name)
  VALUES ('plivo', 'Plivo')
  ON CONFLICT (name) DO NOTHING;

-- One row per carrier account a tenant dials on. The secret part (Plivo: auth_token)
-- lives in `telephony_credential_secrets`, sealed by the server; nothing in SQL can
-- read it. Rows are never hard-deleted (calls pin them); revoking keeps the row and,
-- once no call can need it, deletes its secrets (crypto-shred).
CREATE TABLE telephony_credentials (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  provider           VARCHAR(50) NOT NULL REFERENCES telephony_providers(name),
  label              VARCHAR(100) NOT NULL,
  status             VARCHAR(20) NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'disabled', 'invalid', 'revoked')),
  -- The carrier's public account identifier (Plivo: auth_id). Not secret; shown in
  -- the console and used to stop two tenants registering one carrier account.
  account_ref        VARCHAR(100) NOT NULL,
  -- Non-secret, provider-validated settings. Never a URL or host: carrier API hosts
  -- and our webhook base are fixed in code and env (SSRF, call hijack).
  public_config      JSONB NOT NULL DEFAULT '{}',
  -- The CURRENT secret version (`telephony_credential_secrets`). Bumped on every
  -- rotation; part of the seal's AAD and of the in-process cache key, so a rotated
  -- secret can never be served from a stale cache entry.
  secret_version     INTEGER NOT NULL DEFAULT 1 CHECK (secret_version >= 1),
  -- Last four characters of the current secret, for the console. Never more.
  secret_hint        VARCHAR(4),
  verified_at        TIMESTAMPTZ,
  -- A short, carrier-reported reason; never request or response bodies.
  last_error         VARCHAR(500),
  created_by         UUID REFERENCES super_admins(id),
  updated_by         UUID REFERENCES super_admins(id),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at         TIMESTAMPTZ,
  shredded_at        TIMESTAMPTZ,

  CONSTRAINT chk_telephony_credentials_revoked_at CHECK (
    (status = 'revoked') = (revoked_at IS NOT NULL)
  ),
  CONSTRAINT chk_telephony_credentials_shredded CHECK (
    shredded_at IS NULL OR (status = 'revoked' AND secret_hint IS NULL)
  ),
  CONSTRAINT chk_telephony_credentials_label CHECK (length(btrim(label)) > 0),
  CONSTRAINT chk_telephony_credentials_account_ref CHECK (length(btrim(account_ref)) > 0),
  CONSTRAINT chk_telephony_credentials_public_config CHECK (jsonb_typeof(public_config) = 'object'),
  -- Target of the composite FKs below: a call or campaign can only pin a credential
  -- of ITS OWN tenant and ITS OWN provider, enforced by Postgres, not just the code.
  CONSTRAINT uq_telephony_credentials_scope UNIQUE (id, tenant_id, provider)
);

-- The sealed secrets, one row per version. Each blob is nonce ‖ ciphertext ‖ tag
-- (AES-256-GCM; apps/server/src/telephony/credentials), bound to (tenant, credential,
-- provider, version). `kek_id` is scheme-prefixed (`env:v1`; a KMS key later), so the
-- wrap scheme can change without a schema change.
--
-- The current version has `retired_at IS NULL`. A rotation retires the previous one
-- instead of deleting it: the carrier may still sign webhooks for calls placed before
-- the rotation with the old secret, so it stays openable for a grace window and is
-- then deleted.
CREATE TABLE telephony_credential_secrets (
  credential_id      UUID NOT NULL REFERENCES telephony_credentials(id) ON DELETE CASCADE,
  secret_version     INTEGER NOT NULL CHECK (secret_version >= 1),
  secret_ciphertext  BYTEA NOT NULL,
  wrapped_dek        BYTEA NOT NULL,
  kek_id             VARCHAR(200) NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  retired_at         TIMESTAMPTZ,
  PRIMARY KEY (credential_id, secret_version)
);

CREATE UNIQUE INDEX uq_telephony_credential_secrets_current
  ON telephony_credential_secrets (credential_id)
  WHERE retired_at IS NULL;

-- Re-wrapping after a master-key rotation finds rows by key id.
CREATE INDEX idx_telephony_credential_secrets_kek ON telephony_credential_secrets (kek_id);

CREATE TRIGGER trg_telephony_credentials_updated
  BEFORE UPDATE ON telephony_credentials
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- One live registration per carrier account, across all tenants.
CREATE UNIQUE INDEX uq_telephony_credentials_account
  ON telephony_credentials (provider, account_ref)
  WHERE status <> 'revoked';

CREATE UNIQUE INDEX uq_telephony_credentials_label
  ON telephony_credentials (tenant_id, lower(label))
  WHERE status <> 'revoked';

CREATE INDEX idx_telephony_credentials_tenant ON telephony_credentials (tenant_id);

COMMENT ON TABLE telephony_credentials IS
  'Per-tenant carrier credentials (BYOC, decisions B18-B22). The secret is sealed by the server and never readable in SQL.';

-- A campaign dials on the service's own VoiceLink account (NULL) or on one tenant credential.
ALTER TABLE agency_campaigns
  ADD COLUMN telephony_credential_id UUID,
  ADD CONSTRAINT fk_agency_campaigns_telephony_credential
    FOREIGN KEY (telephony_credential_id, tenant_id, telephony_provider)
    REFERENCES telephony_credentials (id, tenant_id, provider)
    ON DELETE RESTRICT;

CREATE INDEX idx_agency_campaigns_telephony_credential
  ON agency_campaigns (telephony_credential_id)
  WHERE telephony_credential_id IS NOT NULL;

-- A call is pinned at dial time to the credential it was placed on; hangup, webhook
-- verification and recording fetches resolve through this column, never through the
-- campaign's current value. NULL = the service's own VoiceLink account.
--
-- Unlike `campaign_id`, this one has a foreign key. The baseline keeps FKs off this
-- table so a cascade cannot destroy an audit trail; here nothing cascades (RESTRICT)
-- and credentials are never deleted, only revoked, so the retention purge is
-- unaffected, and the key is what makes Postgres refuse a call pinned to another
-- tenant's or another provider's credential.
ALTER TABLE agency_calls
  ADD COLUMN telephony_credential_id UUID,
  -- The carrier's id for the dial REQUEST, when it differs from the call id (Plivo:
  -- request_uuid, the only handle before answer and the only id that cancels a
  -- ringing call).
  ADD COLUMN provider_request_id VARCHAR(100),
  ADD CONSTRAINT fk_agency_calls_telephony_credential
    FOREIGN KEY (telephony_credential_id, tenant_id, provider)
    REFERENCES telephony_credentials (id, tenant_id, provider)
    ON DELETE RESTRICT;

CREATE INDEX idx_agency_calls_telephony_credential
  ON agency_calls (telephony_credential_id)
  WHERE telephony_credential_id IS NOT NULL;

-- Down Migration

DROP INDEX IF EXISTS idx_agency_calls_telephony_credential;
ALTER TABLE agency_calls
  DROP CONSTRAINT IF EXISTS fk_agency_calls_telephony_credential,
  DROP COLUMN IF EXISTS provider_request_id,
  DROP COLUMN IF EXISTS telephony_credential_id;

DROP INDEX IF EXISTS idx_agency_campaigns_telephony_credential;
ALTER TABLE agency_campaigns
  DROP CONSTRAINT IF EXISTS fk_agency_campaigns_telephony_credential,
  DROP COLUMN IF EXISTS telephony_credential_id;

DROP TABLE IF EXISTS telephony_credential_secrets;
DROP TABLE IF EXISTS telephony_credentials;

-- Kept when a phone number still references it (phone_numbers.provider_id).
DELETE FROM telephony_providers t
 WHERE t.name = 'plivo'
   AND NOT EXISTS (SELECT 1 FROM phone_numbers p WHERE p.provider_id = t.id);
