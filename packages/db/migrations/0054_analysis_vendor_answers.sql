-- 0054_analysis_vendor_answers.sql — two nullable TIMESTAMPTZ columns on dialer_analysis_jobs, the
-- two sides of the summary delay (decision AD1, `docs/decisions.md`; the rule is
-- `analysisDelaySql`'s JSDoc in `dialer-analysis-job.repository.ts`):
--   vendor_refused_at  when the AI vendor last refused the job (`requeueRateLimited`)
--   completed_at       when the job completed with a summary (`completeWithAnalysis`)
-- No default, no backfill: a job refused or completed before this migration has NULL, and the
-- next refusal or completion writes one. 0055 indexes both, out of this file's lock.
--
-- Locking: ADD COLUMN with no default is catalog-only (no rewrite) but takes ACCESS EXCLUSIVE on
-- dialer_analysis_jobs, which the live server writes, so the Up starts with a lock timeout
-- (db-hygiene.md).
--
-- Down: drops both columns (and with them 0055's indexes, were they still there).
--
-- Runs as one node-pg-migrate SQL migration in one transaction; split on the up/down marker
-- comments (see 0001_baseline.sql's header for the regex).

-- Up Migration

SET LOCAL lock_timeout = '10s';

ALTER TABLE dialer_analysis_jobs ADD COLUMN IF NOT EXISTS vendor_refused_at TIMESTAMPTZ;

ALTER TABLE dialer_analysis_jobs ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;

COMMENT ON COLUMN dialer_analysis_jobs.vendor_refused_at IS
  'When the AI vendor last refused this job (requeueRateLimited, with error_code RATE_LIMITED); kept by a graceful requeue or stale recovery, cleared on completion and manual retry. NULL for a job never refused, or refused before 0054 (decision AD1).';

COMMENT ON COLUMN dialer_analysis_jobs.completed_at IS
  'When the job completed with a summary (completeWithAnalysis). NULL for a job not completed, or completed before 0054 (decision AD1).';

-- Down Migration

SET LOCAL lock_timeout = '10s';

ALTER TABLE dialer_analysis_jobs DROP COLUMN IF EXISTS completed_at;

ALTER TABLE dialer_analysis_jobs DROP COLUMN IF EXISTS vendor_refused_at;
