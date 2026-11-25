-- 0077_credential_concurrency_cap.sql — a concurrency cap per carrier account (docs/carriers.md CR13).
--
-- `telephony_credentials.max_concurrent_calls`: at most this many live calls placed on the tenant's
-- carrier account at once, across every account of the tenant (a credential serves every account of
-- its tenant, B20). NULL is no cap of its own. In addition to the global, account and per-account
-- carrier scopes (B22), never instead of them; calls on the service's own account (credential NULL)
-- take no credential scope. The server admits a call against it in the same Redis transaction as the
-- other scopes and reads the cap from here (cached briefly).
--
-- ── Locking ───────────────────────────────────────────────────────────────────
-- ADD COLUMN with no default and a CHECK on a NULL column is a catalog change: no rewrite, no scan
-- beyond the CHECK's (the table holds a few rows per tenant). It still takes ACCESS EXCLUSIVE on
-- a table every tenant dial reads, so the Up and the Down fail fast behind a straggler
-- (`db-hygiene.md`).
--
-- Runs as one node-pg-migrate SQL migration in one transaction; split on the up/down marker
-- comments (see 0001_baseline.sql's header for the regex).

-- Up Migration

SET LOCAL lock_timeout = '10s';

ALTER TABLE telephony_credentials
  ADD COLUMN max_concurrent_calls INTEGER,
  ADD CONSTRAINT chk_telephony_credentials_max_concurrent_calls
    CHECK (max_concurrent_calls IS NULL OR max_concurrent_calls > 0);

COMMENT ON COLUMN telephony_credentials.max_concurrent_calls IS
  'CR13: at most this many live calls on this carrier account at once, across every account of the tenant. NULL: no cap of its own (the global, account and per-account carrier scopes still apply).';

-- Down Migration

SET LOCAL lock_timeout = '10s';

ALTER TABLE telephony_credentials
  DROP CONSTRAINT IF EXISTS chk_telephony_credentials_max_concurrent_calls,
  DROP COLUMN IF EXISTS max_concurrent_calls;
