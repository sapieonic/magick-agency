-- 0044_promise_checks_validate.sql — the work on existing rows that 0041 kept out of its ACCESS
-- EXCLUSIVE (0009 / 0010's split, as 0025 does for 0024).
--
-- 0041_promise_to_pay.sql adds its four promise CHECKs NOT VALID (its header, "Locking"). This
-- file validates them: ck_agency_attempt_promise, ck_agency_manual_call_promise,
-- ck_agency_inbound_call_promise and ck_agency_contact_promise. Every row written since 0041 was
-- already checked, and the promise columns are NULL on every older row, which satisfies each
-- CHECK, so validation cannot fail. Afterwards pg_constraint.convalidated is true for all four.
--
-- ── Locking ───────────────────────────────────────────────────────────────────
-- Its own transaction: the image's runner commits each file on its own (apps/server/src/
-- migrate.ts), so 0041's ACCESS EXCLUSIVE is released before this starts. `pnpm migrate:up` (the
-- CLI) combines pending files into one transaction unless given `--no-single-transaction`.
-- VALIDATE CONSTRAINT scans its table once per constraint under SHARE UPDATE EXCLUSIVE: reads and
-- writes proceed. Migrations run at container start, before the server listens.
--
-- Runs as one node-pg-migrate SQL migration in one transaction; split on the up/down marker
-- comments (see 0001_baseline.sql's header for the regex).

-- Up Migration

ALTER TABLE agency_call_attempts VALIDATE CONSTRAINT ck_agency_attempt_promise;
ALTER TABLE agency_manual_calls VALIDATE CONSTRAINT ck_agency_manual_call_promise;
ALTER TABLE agency_inbound_calls VALIDATE CONSTRAINT ck_agency_inbound_call_promise;
ALTER TABLE agency_contacts VALIDATE CONSTRAINT ck_agency_contact_promise;

-- Down Migration

-- A validated CHECK cannot be marked NOT VALID again, and need not be: 0041's Down drops all four.
SELECT 1;
