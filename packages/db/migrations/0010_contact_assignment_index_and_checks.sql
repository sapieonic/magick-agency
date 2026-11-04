-- 0010_contact_assignment_index_and_checks.sql — the work on contact assignment's existing rows,
-- kept out of 0009's ACCESS EXCLUSIVE.
--
-- 0009 changes the catalog only: it adds its agency_contacts and agency_call_attempts CHECKs NOT
-- VALID and leaves the assignee index for this file (0009's header, "Locking"). This file:
--
--  - validates the five NOT VALID CHECKs: ck_agency_contact_assigned_at,
--    ck_agency_contact_agent_retry_rounds_used, ck_agency_contact_override_extra_attempts,
--    ck_agency_attempt_override_applied and ck_agency_attempt_override_note. Every row written
--    since 0009 was already checked; each older row satisfies them through 0009's column
--    defaults, so validation cannot fail. Afterwards pg_constraint.convalidated is true for all;
--  - builds idx_agency_contacts_assignee (the per-agent claim, the preferred-mode pool claim and
--    the per-agent counts; 0009's header).
--
-- ── Locking ───────────────────────────────────────────────────────────────────
-- Its own transaction: the image's runner commits each file on its own (apps/server/src/
-- migrate.ts), so 0009's ACCESS EXCLUSIVE is released before this starts. `pnpm migrate:up` (the
-- CLI) combines pending files into one transaction unless given `--no-single-transaction`.
--
--  - VALIDATE CONSTRAINT scans its table once per constraint under SHARE UPDATE EXCLUSIVE: reads
--    and writes proceed. The agency_contacts ones run first, before the index takes its stronger
--    lock.
--  - CREATE INDEX (not CONCURRENTLY: one transaction, as 0003 and 0004) holds SHARE on
--    agency_contacts until commit: reads proceed, writes wait while it builds.
--
-- Measured on 1M contacts with 1M attempts: ~0.12-0.18 s per VALIDATE, ~0.6 s for the build.
-- Migrations run at container start, before the server listens (docker/entrypoint.sh).
--
-- Runs as one node-pg-migrate SQL migration in one transaction; split on the up/down marker
-- comments (see 0001_baseline.sql's header for the regex).

-- Up Migration

ALTER TABLE agency_contacts VALIDATE CONSTRAINT ck_agency_contact_assigned_at;
ALTER TABLE agency_contacts VALIDATE CONSTRAINT ck_agency_contact_agent_retry_rounds_used;
ALTER TABLE agency_contacts VALIDATE CONSTRAINT ck_agency_contact_override_extra_attempts;

ALTER TABLE agency_call_attempts VALIDATE CONSTRAINT ck_agency_attempt_override_applied;
ALTER TABLE agency_call_attempts VALIDATE CONSTRAINT ck_agency_attempt_override_note;

CREATE INDEX idx_agency_contacts_assignee
  ON agency_contacts (campaign_id, assigned_user_id, state, next_attempt_at);

COMMENT ON INDEX idx_agency_contacts_assignee IS
  'Per-agent claim (strict/preferred), the preferred-mode pool claim (assigned_user_id IS NULL) and per-agent counts.';

-- Down Migration

-- A validated CHECK cannot be marked NOT VALID again, and need not be: 0009's Down drops them.
DROP INDEX IF EXISTS idx_agency_contacts_assignee;
