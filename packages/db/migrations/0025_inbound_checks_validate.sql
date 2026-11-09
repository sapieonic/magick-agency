-- 0025_inbound_checks_validate.sql — the work on existing rows that 0024 kept out of its ACCESS
-- EXCLUSIVE (0009 / 0010's split).
--
-- 0024 adds its agency_calls and agency_contacts CHECKs NOT VALID (its header, "Locking"). This
-- file validates the three: ck_agency_calls_origin (rewritten to take `inbound`),
-- ck_agency_calls_inbound_correlation and ck_agency_contact_callback_source. Every row written
-- since 0024 was already checked; each older row satisfies them (the old origin CHECK implies the
-- new one, and the new columns are NULL on every older row), so validation cannot fail.
-- Afterwards pg_constraint.convalidated is true for all three.
--
-- ── Locking ───────────────────────────────────────────────────────────────────
-- Its own transaction: the image's runner commits each file on its own (apps/server/src/
-- migrate.ts), so 0024's ACCESS EXCLUSIVE is released before this starts. `pnpm migrate:up` (the
-- CLI) combines pending files into one transaction unless given `--no-single-transaction`.
-- VALIDATE CONSTRAINT scans its table once per constraint under SHARE UPDATE EXCLUSIVE: reads and
-- writes proceed. Migrations run at container start, before the server listens.
--
-- Runs as one node-pg-migrate SQL migration in one transaction; split on the up/down marker
-- comments (see 0001_baseline.sql's header for the regex).

-- Up Migration

ALTER TABLE agency_calls VALIDATE CONSTRAINT ck_agency_calls_origin;
ALTER TABLE agency_calls VALIDATE CONSTRAINT ck_agency_calls_inbound_correlation;
ALTER TABLE agency_contacts VALIDATE CONSTRAINT ck_agency_contact_callback_source;

-- Down Migration

-- A validated CHECK cannot be marked NOT VALID again, and need not be: 0024's Down drops or
-- replaces all three.
SELECT 1;
