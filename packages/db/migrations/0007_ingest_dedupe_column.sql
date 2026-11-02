-- 0007_ingest_dedupe_column.sql — which column a roster upload checks for duplicate rows.
--
-- A loan collection file can carry one borrower twice: the same phone number on two rows with
-- different loan numbers. Deduping on the phone drops the second loan, so the operator can now
-- name the column that decides a duplicate. `dedupe_column` is that header, as the operator picked
-- it from the analysed file. NULL keeps the earlier behaviour, which `dedupe_phones` still
-- decides: dedupe on the normalised phone (true) or not at all (false).
--
-- ── Locking ───────────────────────────────────────────────────────────────────
-- ADD COLUMN with no default does not rewrite the table. Migrations run at container start,
-- before the server listens (docker/entrypoint.sh). No index: nothing filters on it.
--
-- Runs as one node-pg-migrate SQL migration in one transaction; split on the up/down marker
-- comments (see 0001_baseline.sql's header for the regex).

-- Up Migration

ALTER TABLE agency_ingest_jobs
  ADD COLUMN dedupe_column TEXT;

COMMENT ON COLUMN agency_ingest_jobs.dedupe_column IS
  'Header whose value marks a duplicate row in the file (trimmed, case-insensitive; a blank value is never a duplicate). NULL: dedupe_phones decides.';

-- Down Migration

ALTER TABLE agency_ingest_jobs
  DROP COLUMN IF EXISTS dedupe_column;
