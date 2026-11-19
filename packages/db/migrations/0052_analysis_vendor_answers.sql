-- 0052_analysis_vendor_answers.sql — when the AI vendor last refused an analysis job, and when a
-- job last completed (decision AD1: "Summary delayed: the AI service is not available right now").
--
-- A call's summary reads delayed (`analysis_delay: 'vendor_unavailable'`) when its job is queued
-- and the vendor's most recent answer was a refusal: the newest refusal of a queued job is newer
-- than the newest completion (`analysisDelaySql`, `dialer-analysis-job.repository.ts`). Before this,
-- any queued job carrying `error_code = 'RATE_LIMITED'` turned it on. Refused jobs are requeued
-- with the longest backoff and claimed last, so after an outage the notice stayed on through the
-- whole drain while summaries were being written; and no column could say when the refusal
-- happened: `updated_at` moves on every write (heartbeats, a graceful requeue, stale recovery).
--
-- ── vendor_refused_at (new) ───────────────────────────────────────────────────
-- Written only by `requeueRateLimited` (now(), with `error_code = 'RATE_LIMITED'`), cleared by
-- `completeWithAnalysis` and `requeueForManualRetry`. `gracefulRequeue` and `recoverStale` keep it
-- as it was, so a deploy that requeues an old refused job does not make the refusal new again.
--
-- ── completed_at (new) ────────────────────────────────────────────────────────
-- Written only by `completeWithAnalysis` (now()): when the vendor last answered with a summary.
--
-- Both nullable, no default, no backfill. A job refused before this migration has no
-- `vendor_refused_at` and does not count as a refusal: the breaker's state is in memory, so after
-- the deploy the worker claims at once and a vendor still refusing is recorded again within
-- seconds. A job completed before it has no `completed_at`; the first completion after the deploy
-- writes one. 0053 indexes both (built out of this file's ACCESS EXCLUSIVE, 0041 / 0045's split).
--
-- ── Locking ───────────────────────────────────────────────────────────────────
-- ADD COLUMN with no default is catalog-only (no rewrite), but takes ACCESS EXCLUSIVE on
-- dialer_analysis_jobs, which the live server writes: the Up starts with a lock timeout
-- (db-hygiene.md).
--
-- ── Down ──────────────────────────────────────────────────────────────────────
-- Drops both columns (and with them 0053's indexes, were they still there); a release before this
-- one reads the delay from `error_code` alone again.
--
-- Runs as one node-pg-migrate SQL migration in one transaction; split on the up/down marker
-- comments (see 0001_baseline.sql's header for the regex).

-- Up Migration

SET LOCAL lock_timeout = '10s';

ALTER TABLE dialer_analysis_jobs ADD COLUMN IF NOT EXISTS vendor_refused_at TIMESTAMPTZ;

ALTER TABLE dialer_analysis_jobs ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;

COMMENT ON COLUMN dialer_analysis_jobs.vendor_refused_at IS
  'When the AI vendor last refused this job (requeueRateLimited, with error_code RATE_LIMITED); kept by a graceful requeue or stale recovery, cleared on completion and manual retry. NULL for a job never refused, or refused before 0052 (decision AD1).';

COMMENT ON COLUMN dialer_analysis_jobs.completed_at IS
  'When the job completed with a summary (completeWithAnalysis). NULL for a job not completed, or completed before 0052 (decision AD1).';

-- Down Migration

SET LOCAL lock_timeout = '10s';

ALTER TABLE dialer_analysis_jobs DROP COLUMN IF EXISTS completed_at;

ALTER TABLE dialer_analysis_jobs DROP COLUMN IF EXISTS vendor_refused_at;
