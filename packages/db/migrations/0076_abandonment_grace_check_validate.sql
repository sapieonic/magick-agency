-- 0076_abandonment_grace_check_validate.sql — the work on existing rows that 0075 kept out of its
-- ACCESS EXCLUSIVE (0041 / 0044's split, as 0025 does for 0024).
--
-- 0075_abandonment_grace_setting.sql adds ck_agency_attempt_bridge_grace NOT VALID (its header,
-- "Locking"). This file validates it. Every row written since 0075 was already checked, and every
-- older row reads 3000 from the column default, which satisfies the CHECK, so validation cannot
-- fail. Afterwards pg_constraint.convalidated is true.
--
-- ── Locking ───────────────────────────────────────────────────────────────────
-- Its own transaction: the image's runner commits each file on its own (apps/server/src/
-- migrate.ts), so 0075's ACCESS EXCLUSIVE is released before this starts. `pnpm migrate:up` (the
-- CLI) combines pending files into one transaction unless given `--no-single-transaction`.
-- VALIDATE CONSTRAINT scans `agency_call_attempts` once under SHARE UPDATE EXCLUSIVE: reads and
-- writes proceed. Migrations run at container start, before the server listens, so on a large
-- table this scan is part of the deploy's outage (DEPLOYMENT.md 12, "Deploying the per-campaign
-- abandonment grace", says how to run it beforehand).
--
-- Runs as one node-pg-migrate SQL migration in one transaction; split on the up/down marker
-- comments (see 0001_baseline.sql's header for the regex).

-- Up Migration

ALTER TABLE agency_call_attempts VALIDATE CONSTRAINT ck_agency_attempt_bridge_grace;

-- Down Migration

-- A validated CHECK cannot be marked NOT VALID again, and need not be: 0075's Down drops it.
SELECT 1;
