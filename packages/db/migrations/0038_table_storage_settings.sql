-- 0038_table_storage_settings.sql — per-table autovacuum thresholds and fillfactor (db-hygiene.md).
--
-- No table or column changes: storage parameters only, so no query, index or row changes shape.
--
-- ── Autovacuum ────────────────────────────────────────────────────────────────
-- Postgres's default waits until about 20% of a table is dead row versions before vacuuming it,
-- and until 10% has changed before re-analysing it. That suits small tables, but on the tables
-- that grow with every call it means millions of dead rows before the first clean-up, and a
-- stale visibility map (index-only scans that still visit the table) in between.
--   agency_call_attempts, agency_contacts — 2% dead to vacuum, 2% changed to analyse: the two
--     largest tables, each row rewritten several times per dial;
--   agency_calls, agency_agent_sessions — 5% to vacuum: every bridged call / every join, and
--     sessions' live rows are rewritten by the heartbeat;
--   agency_insights_rollup_agents / _codes / _facets — 5% to vacuum: a live bucket's breakdown
--     rows are deleted and re-inserted on every recompute (insights-rollup-sql.ts).
-- The small, churning queue `agency_insights_rollup_dirty` keeps the default: on a table of a
-- few hundred rows the default threshold (50 + 20%) is already eager.
--
-- ── Fillfactor ────────────────────────────────────────────────────────────────
-- A row update that changes no indexed column, and finds room on the same page, is a HOT
-- (heap-only tuple) update: no index is written. Leaving room in each page makes that likely.
--   agency_agent_sessions 80 — the heartbeat (`last_heartbeat`, `updated_at`) touches no
--     indexed column and runs every few seconds per live agent;
--   agency_campaign_pacing_minutes 85 — the per-minute counter upserts touch only non-key
--     columns of a table whose one index is its primary key.
-- agency_call_attempts and agency_contacts are left at 100: most of their updates change an
-- indexed column (state, timestamps, the covering insights index), so free space buys little
-- until the HOT ratio has been measured (db-hygiene.md, "7. What to measure for phase 2").
-- Fillfactor applies to pages written from now on; existing pages are not rewritten.
--
-- ── Locking ───────────────────────────────────────────────────────────────────
-- ALTER TABLE ... SET / RESET of these parameters takes SHARE UPDATE EXCLUSIVE: reads and writes
-- go on, only another vacuum, analyse or schema change waits. Catalog-only, no rewrite, instant.
-- `SET LOCAL lock_timeout = '10s'` first: a lock not granted within 10 s fails the migration
-- (the deploy can be retried) instead of queueing every other query behind the wait.
--
-- ── Down ──────────────────────────────────────────────────────────────────────
-- RESET every parameter set here: the tables go back to the server-wide defaults.
--
-- Runs as one node-pg-migrate SQL migration in one transaction; split on the up/down marker
-- comments (see 0001_baseline.sql's header for the regex).

-- Up Migration

-- Fail fast if a straggler connection holds a lock on one of these tables (db-hygiene.md).
SET LOCAL lock_timeout = '10s';

ALTER TABLE agency_call_attempts SET (autovacuum_vacuum_scale_factor = 0.02, autovacuum_analyze_scale_factor = 0.02);
ALTER TABLE agency_contacts      SET (autovacuum_vacuum_scale_factor = 0.02, autovacuum_analyze_scale_factor = 0.02);
ALTER TABLE agency_calls         SET (autovacuum_vacuum_scale_factor = 0.05);
ALTER TABLE agency_agent_sessions SET (autovacuum_vacuum_scale_factor = 0.05, fillfactor = 80);
ALTER TABLE agency_insights_rollup_agents SET (autovacuum_vacuum_scale_factor = 0.05);
ALTER TABLE agency_insights_rollup_codes  SET (autovacuum_vacuum_scale_factor = 0.05);
ALTER TABLE agency_insights_rollup_facets SET (autovacuum_vacuum_scale_factor = 0.05);
ALTER TABLE agency_campaign_pacing_minutes SET (fillfactor = 85);

-- Down Migration

ALTER TABLE agency_campaign_pacing_minutes RESET (fillfactor);
ALTER TABLE agency_insights_rollup_facets RESET (autovacuum_vacuum_scale_factor);
ALTER TABLE agency_insights_rollup_codes  RESET (autovacuum_vacuum_scale_factor);
ALTER TABLE agency_insights_rollup_agents RESET (autovacuum_vacuum_scale_factor);
ALTER TABLE agency_agent_sessions RESET (autovacuum_vacuum_scale_factor, fillfactor);
ALTER TABLE agency_calls         RESET (autovacuum_vacuum_scale_factor);
ALTER TABLE agency_contacts      RESET (autovacuum_vacuum_scale_factor, autovacuum_analyze_scale_factor);
ALTER TABLE agency_call_attempts RESET (autovacuum_vacuum_scale_factor, autovacuum_analyze_scale_factor);
