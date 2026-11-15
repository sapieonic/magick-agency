-- 0040_drop_duplicate_indexes.sql — seven indexes that repeat a unique index on the same table.
--
-- Each one below is either an exact copy of a unique index or its leading column(s), on a plain
-- btree over the same columns in the same order, and neither side is partial. Postgres answers
-- every lookup the dropped index served (equality or range on its columns) from the unique
-- index, so no plan loses its index; every insert and update stops maintaining a second copy.
--
-- All seven come from 0001. Dropped, then the unique index that covers it:
--   idx_super_admins_email (email)
--     -> super_admins_email_key (email)
--   idx_account_settings_tenant_account (tenant_id, account_id)
--     -> uq_account_settings_tenant_account (tenant_id, account_id)
--   idx_account_settings_tenant (tenant_id)
--     -> uq_account_settings_tenant_account (tenant_id, account_id)
--   idx_account_provider_concurrency_account (tenant_id, account_id)
--     -> uq_account_provider_concurrency (tenant_id, account_id, telephony_provider)
--   idx_memberships_user_id (user_id)
--     -> memberships_user_id_tenant_id_account_id_key (user_id, tenant_id, account_id)
--   idx_tenant_phone_tenant (tenant_id)
--     -> tenant_phone_assignments_tenant_id_phone_number_id_key (tenant_id, phone_number_id)
--   idx_phone_account_tags_assignment (assignment_id)
--     -> phone_account_tags_assignment_id_account_id_key (assignment_id, account_id)
--
-- Not dropped: uq_agency_agent_live_tenant, which 0035 keeps on purpose so a server image from
-- before 0035 still finds its ON CONFLICT arbiter after an image-only rollback.
--
-- ── Locking ───────────────────────────────────────────────────────────────────
-- DROP INDEX takes ACCESS EXCLUSIVE on its table for an instant. Every table here is small
-- configuration (super admins, account settings, memberships, phone assignments), and the server
-- is stopped while migrations run.
-- `SET LOCAL lock_timeout = '10s'` first: a lock not granted within 10 s fails the migration
-- (the deploy can be retried) instead of queueing every other query behind the wait.
--
-- ── Down ──────────────────────────────────────────────────────────────────────
-- Re-creates the seven indexes exactly as 0001 defined them.
--
-- Runs as one node-pg-migrate SQL migration in one transaction; split on the up/down marker
-- comments (see 0001_baseline.sql's header for the regex).

-- Up Migration

-- Fail fast if a straggler connection holds a lock on one of these tables (db-hygiene.md).
SET LOCAL lock_timeout = '10s';

DROP INDEX IF EXISTS idx_super_admins_email;
DROP INDEX IF EXISTS idx_account_settings_tenant_account;
DROP INDEX IF EXISTS idx_account_settings_tenant;
DROP INDEX IF EXISTS idx_account_provider_concurrency_account;
DROP INDEX IF EXISTS idx_memberships_user_id;
DROP INDEX IF EXISTS idx_tenant_phone_tenant;
DROP INDEX IF EXISTS idx_phone_account_tags_assignment;

-- Down Migration

CREATE INDEX IF NOT EXISTS idx_phone_account_tags_assignment ON phone_account_tags (assignment_id);
CREATE INDEX IF NOT EXISTS idx_tenant_phone_tenant ON tenant_phone_assignments (tenant_id);
CREATE INDEX IF NOT EXISTS idx_memberships_user_id ON memberships (user_id);
CREATE INDEX IF NOT EXISTS idx_account_provider_concurrency_account
  ON account_provider_concurrency_allocations (tenant_id, account_id);
CREATE INDEX IF NOT EXISTS idx_account_settings_tenant ON account_settings (tenant_id);
CREATE INDEX IF NOT EXISTS idx_account_settings_tenant_account ON account_settings (tenant_id, account_id);
CREATE INDEX IF NOT EXISTS idx_super_admins_email ON super_admins (email);
