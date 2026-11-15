-- 0043_ingest_check_and_skipped.sql — a roster import's check-then-import, and the rows it skips.
--
-- Rulings IM1–IM7 (docs/decisions.md, "Rulings of 2026-11-15: contact import check and
-- re-import (IM)"). On `agency_ingest_jobs`:
--
--   skipped            BIGINT  rows the campaign already held, skipped rather than rejected
--                              (IM3): accepted + skipped + rejected = rows_read. 0 on every
--                              job before this, which skipped nothing.
--   skipped_s3_key     TEXT    the skipped-rows download (`…/{job}/skipped-rows.csv`), NULL when
--                              none; `skipped_row_count`, `skipped_truncated` as for the
--                              rejected-rows download.
--   dnc_by_scope       JSONB   Do Not Call rejections by the widest scope that suppressed them
--                              ({"tenant": n, "account": n, "campaign": n, "unknown": n}), a
--                              breakdown of rejected_by_reason.dnc_suppressed (IM5).
--   rejected_sample    JSONB   the first rejected rows (line, column, the phone cell, code,
--                              reason; at most 20), for the review screen (IM2).
--   check_job_id       UUID    the check (a completed dry run) an import was started from (IM2).
--                              `uq_agency_ingest_jobs_check_job` makes one check one import: a
--                              second commit finds the first instead of importing again.
--
-- The JSONB columns carry shape CHECKs (an object, an array) so a reader can trust the shape.
--
-- ── Locking ───────────────────────────────────────────────────────────────────
-- ADD COLUMN with a constant default is a catalogue change (no rewrite), and the unique index is
-- on a column that is NULL on every existing row, so it builds over nothing. The table holds one
-- row per upload. `SET LOCAL lock_timeout = '10s'` first: a lock not granted within 10 s fails the
-- migration (the deploy can be retried) instead of queueing every other query behind the wait.
--
-- ── Rollback ──────────────────────────────────────────────────────────────────
-- A server from before this migration names none of these columns, so it runs on this schema
-- unchanged. This server writes them only through the widest tier of its write ladders
-- (`agency-ingest-job.repository.ts`), so it also runs on a schema without them (skipped stays
-- unrecorded until the migration lands).
--
-- ── Down ──────────────────────────────────────────────────────────────────────
-- Drops the index and the columns. A finished job loses its skipped count and its download link
-- (the S3 object stays); nothing a server before this reads is touched.
--
-- Runs as one node-pg-migrate SQL migration in one transaction; split on the up/down marker
-- comments (see 0001_baseline.sql's header for the regex).

-- Up Migration
SET LOCAL lock_timeout = '10s';

ALTER TABLE agency_ingest_jobs
  ADD COLUMN skipped           BIGINT  NOT NULL DEFAULT 0,
  ADD COLUMN skipped_s3_key    TEXT,
  ADD COLUMN skipped_row_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN skipped_truncated BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN dnc_by_scope      JSONB   NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN rejected_sample   JSONB   NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN check_job_id      UUID REFERENCES agency_ingest_jobs(id) ON DELETE SET NULL,
  ADD CONSTRAINT ck_agency_ingest_jobs_skipped CHECK (skipped >= 0 AND skipped_row_count >= 0),
  ADD CONSTRAINT ck_agency_ingest_jobs_dnc_by_scope CHECK (jsonb_typeof(dnc_by_scope) = 'object'),
  ADD CONSTRAINT ck_agency_ingest_jobs_rejected_sample CHECK (jsonb_typeof(rejected_sample) = 'array');

CREATE UNIQUE INDEX IF NOT EXISTS uq_agency_ingest_jobs_check_job
  ON agency_ingest_jobs (check_job_id)
  WHERE check_job_id IS NOT NULL;

COMMENT ON COLUMN agency_ingest_jobs.skipped IS
  'Rows the campaign already held (its duplicate key, or an exact copy), skipped rather than rejected: accepted + skipped + rejected = rows_read. Nothing about the existing contact changes (B15).';
COMMENT ON COLUMN agency_ingest_jobs.dnc_by_scope IS
  'Do Not Call rejections by the widest scope that suppressed them (tenant, account, campaign, unknown): a breakdown of rejected_by_reason.dnc_suppressed.';
COMMENT ON COLUMN agency_ingest_jobs.rejected_sample IS
  'The first rejected rows in file order (row_number, column, raw_value, reason_code, reason), at most 20, for the review screen. Never the other columns: those are in the download.';
COMMENT ON COLUMN agency_ingest_jobs.check_job_id IS
  'The check (a completed dry run) this import was started from. Unique: one check, one import.';

-- Down Migration
SET LOCAL lock_timeout = '10s';

DROP INDEX IF EXISTS uq_agency_ingest_jobs_check_job;

ALTER TABLE agency_ingest_jobs
  DROP CONSTRAINT IF EXISTS ck_agency_ingest_jobs_rejected_sample,
  DROP CONSTRAINT IF EXISTS ck_agency_ingest_jobs_dnc_by_scope,
  DROP CONSTRAINT IF EXISTS ck_agency_ingest_jobs_skipped,
  DROP COLUMN IF EXISTS check_job_id,
  DROP COLUMN IF EXISTS rejected_sample,
  DROP COLUMN IF EXISTS dnc_by_scope,
  DROP COLUMN IF EXISTS skipped_truncated,
  DROP COLUMN IF EXISTS skipped_row_count,
  DROP COLUMN IF EXISTS skipped_s3_key,
  DROP COLUMN IF EXISTS skipped;
