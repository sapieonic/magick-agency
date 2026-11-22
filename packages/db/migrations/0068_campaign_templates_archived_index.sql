-- 0068_campaign_templates_archived_index.sql — a scope's archived campaign templates (the
-- organisation's and an account's; docs/campaign-templates.md §4, CT14;
-- apps/server/src/db/repositories/agency/campaign-template.repository.ts `list` with `archived`).
--
-- 0067's only scope index, `idx_agency_campaign_templates_scope`, is partial on the LIVE templates
-- (`WHERE archived_at IS NULL`), so Settings › Campaign templates' Archived list
-- (`GET /proxy/agency/campaign-templates?archived=true`) could use no index and scanned every
-- tenant's templates, a scan that grows with every tenant's archive.
--
-- ── Index ─────────────────────────────────────────────────────────────────────
-- idx_agency_campaign_templates_archived (tenant_id, account_id) WHERE archived_at IS NOT NULL: the
--   twin of the live index. The list names `archived_at IS NOT NULL` in its statement, so the
--   planner proves the index applies; the live list keeps 0067's index.
--
-- ── Locking ───────────────────────────────────────────────────────────────────
-- A plain CREATE INDEX (node-pg-migrate runs a SQL file's Up inside a transaction, where
-- CONCURRENTLY is refused): SHARE on agency_campaign_templates until commit, reads proceed, template
-- writes wait while it reads the table once (a small table: a few templates per account). A
-- deployment may build it first with CREATE INDEX CONCURRENTLY under the same name (db-hygiene.md,
-- "2. Building an index before a deploy"); IF NOT EXISTS then finds it. A CONCURRENTLY build that
-- failed leaves an invalid index under the name; the check at the end of Up fails the migration on
-- one. `SET LOCAL lock_timeout = '10s'` first: a lock not granted within 10 s fails the migration
-- (the deploy can be retried) instead of queueing the template writes behind the wait.
--
-- ── Down ──────────────────────────────────────────────────────────────────────
-- Drops the index; the Archived list falls back to the scan (correct, slower).
--
-- Runs as one node-pg-migrate SQL migration in one transaction; split on the up/down marker
-- comments (see 0001_baseline.sql's header for the regex).

-- Up Migration

-- Fail fast if a straggler connection holds a lock on agency_campaign_templates (db-hygiene.md).
SET LOCAL lock_timeout = '10s';

CREATE INDEX IF NOT EXISTS idx_agency_campaign_templates_archived
  ON agency_campaign_templates (tenant_id, account_id)
  WHERE archived_at IS NOT NULL;

COMMENT ON INDEX idx_agency_campaign_templates_archived IS
  'A scope''s archived campaign templates: the Archived list (docs/campaign-templates.md CT14).';

-- An index built beforehand with CONCURRENTLY that failed is left invalid under its name, and
-- IF NOT EXISTS would accept it. Fail instead; drop it and build it again (db-hygiene.md §2).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
     WHERE c.relname = 'idx_agency_campaign_templates_archived' AND NOT (i.indisvalid AND i.indisready)
  ) THEN
    RAISE EXCEPTION 'invalid index from an earlier CREATE INDEX CONCURRENTLY: idx_agency_campaign_templates_archived; DROP INDEX CONCURRENTLY and build again';
  END IF;
END
$$;

-- Down Migration

SET LOCAL lock_timeout = '10s';

DROP INDEX IF EXISTS idx_agency_campaign_templates_archived;
