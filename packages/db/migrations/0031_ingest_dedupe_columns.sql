-- 0031_ingest_dedupe_columns.sql — a roster upload's duplicate key can combine up to three columns.
--
-- 0007 let the operator name ONE column that decides a duplicate (a loan number). One column is
-- not always enough: a file can repeat a loan number across branches, or carry no single unique
-- column at all, and deduping on any one of them drops rows that are not repeats. The operator
-- can now name up to three columns, and a row is a duplicate only when EVERY one of them matches
-- an earlier accepted row (a row with any of them blank is never a duplicate).
--
-- `dedupe_columns` holds those headers, in the operator's order, as picked from the analysed file.
-- NULL keeps the behaviour `dedupe_phones` decides (the phone number, or no check), as a NULL
-- `dedupe_column` did. The cardinality CHECK mirrors the contract's AGENCY_MAX_DEDUPE_COLUMNS
-- (3) and the request schema's minimum (1): an empty array would be a third way to say NULL.
--
-- `dedupe_column` (0007) is superseded and no longer written. The backfill copies every value it
-- holds into `dedupe_columns`, so every job, old or new, is read from the one column.
--
-- The backfill and the Down's copy run with the `updated_at` trigger disabled: `updated_at` is the
-- running job's heartbeat (`reapStaleJobs`), and a schema copy is not progress.
--
-- ── Locking ───────────────────────────────────────────────────────────────────
-- ADD COLUMN with no default does not rewrite the table, and the CHECK is checked against the
-- rows the backfill writes; agency_ingest_jobs holds one row per upload, not per contact.
-- Migrations run at container start, before the server listens (docker/entrypoint.sh). No
-- index: nothing filters on it.
--
-- Runs as one node-pg-migrate SQL migration in one transaction; split on the up/down marker
-- comments (see 0001_baseline.sql's header for the regex).

-- Up Migration

ALTER TABLE agency_ingest_jobs
  ADD COLUMN dedupe_columns TEXT[],
  ADD CONSTRAINT ck_agency_ingest_jobs_dedupe_columns
    CHECK (dedupe_columns IS NULL OR (
      cardinality(dedupe_columns) BETWEEN 1 AND 3
      AND array_position(dedupe_columns, NULL) IS NULL
      AND array_position(dedupe_columns, '') IS NULL
    ));

ALTER TABLE agency_ingest_jobs DISABLE TRIGGER agency_ingest_jobs_updated_at;
UPDATE agency_ingest_jobs
   SET dedupe_columns = ARRAY[dedupe_column]
 WHERE dedupe_column IS NOT NULL AND dedupe_column <> '';
ALTER TABLE agency_ingest_jobs ENABLE TRIGGER agency_ingest_jobs_updated_at;

COMMENT ON COLUMN agency_ingest_jobs.dedupe_columns IS
  'Headers that together mark a duplicate row in the file, 1 to 3, in the operator''s order: a duplicate only when every one matches an earlier accepted row (each trimmed, case-insensitive; the phone column by its normalised number; a row with any of them blank is never a duplicate). NULL: dedupe_phones decides.';

COMMENT ON COLUMN agency_ingest_jobs.dedupe_column IS
  'Superseded by dedupe_columns (0031), which holds every value written here; no longer written or read.';

-- Down Migration

-- 0007's column can name one header. A single-column key goes back exactly; a combination keeps
-- its first column, which is what the job row can still say about a finished upload (the rule
-- that ran is gone with the column).
ALTER TABLE agency_ingest_jobs DISABLE TRIGGER agency_ingest_jobs_updated_at;
UPDATE agency_ingest_jobs
   SET dedupe_column = dedupe_columns[1]
 WHERE dedupe_column IS NULL AND dedupe_columns IS NOT NULL;
ALTER TABLE agency_ingest_jobs ENABLE TRIGGER agency_ingest_jobs_updated_at;

COMMENT ON COLUMN agency_ingest_jobs.dedupe_column IS
  'Header whose value marks a duplicate row in the file (trimmed, case-insensitive; a blank value is never a duplicate). NULL: dedupe_phones decides.';

ALTER TABLE agency_ingest_jobs
  DROP CONSTRAINT IF EXISTS ck_agency_ingest_jobs_dedupe_columns,
  DROP COLUMN IF EXISTS dedupe_columns;
