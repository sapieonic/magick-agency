-- 0055_analysis_vendor_answer_indexes.sql — the two indexes `analysisDelaySql` reads (decision AD1),
-- built out of 0054's ACCESS EXCLUSIVE (0041 / 0045's split).
--
-- The delay read compares the newest refusal of a queued job with the newest completion. It runs
-- on every pending call's detail read and every soft-phone list page, so each side is one probe of
-- the end of a partial index rather than a walk of the queue or of every job:
--
-- ── Indexes ───────────────────────────────────────────────────────────────────
-- idx_dialer_analysis_jobs_vendor_refused (vendor_refused_at)
--   WHERE status = 'queued' AND error_code = 'RATE_LIMITED': the queued jobs the vendor refused,
--   the size of an outage's backlog and empty otherwise. `max(vendor_refused_at)` reads its end.
--   The predicate is spelled as the read spells it, so the planner can prove the read implies it.
-- idx_dialer_analysis_jobs_completed (completed_at) WHERE completed_at IS NOT NULL: one entry per
--   job completed since 0054. `max(completed_at)` reads its end. No other read filters on
--   `completed_at`, so no sweep can switch to walking it.
--
-- ── Locking and cost ──────────────────────────────────────────────────────────
-- Plain CREATE INDEX, not CONCURRENTLY: node-pg-migrate runs a SQL file's Up inside a transaction,
-- where CONCURRENTLY is refused. It holds SHARE on dialer_analysis_jobs until commit: reads
-- proceed, writes wait while it is read once. On the release that adds 0054 both columns are NULL
-- everywhere (they are new), so each build is one read of the table that writes an empty index. It
-- cannot be built beforehand on a database without 0054 (the columns do not exist). `IF NOT EXISTS`
-- all the same, so a database already on 0054 can build them CONCURRENTLY first; the check at the
-- end of Up refuses an invalid index such a failed build leaves under a name (db-hygiene.md §2).
-- `SET LOCAL lock_timeout = '10s'` first: a lock not granted within 10 s fails the migration (the
-- deploy can be retried) instead of queueing the analysis worker's writes behind the wait.
--
-- ── Down ──────────────────────────────────────────────────────────────────────
-- Drops the two; the delay read falls back to reading the queued refusals and the completed jobs
-- (correct, slower).
--
-- Runs as one node-pg-migrate SQL migration in one transaction; split on the up/down marker
-- comments (see 0001_baseline.sql's header for the regex).

-- Up Migration

-- Fail fast if a straggler connection holds a lock on dialer_analysis_jobs (db-hygiene.md).
SET LOCAL lock_timeout = '10s';

CREATE INDEX IF NOT EXISTS idx_dialer_analysis_jobs_vendor_refused
  ON dialer_analysis_jobs (vendor_refused_at)
  WHERE status = 'queued' AND error_code = 'RATE_LIMITED';

COMMENT ON INDEX idx_dialer_analysis_jobs_vendor_refused IS
  'The newest refusal of a queued analysis job by the AI vendor: one side of the summary delay (analysisDelaySql, AD1).';

CREATE INDEX IF NOT EXISTS idx_dialer_analysis_jobs_completed
  ON dialer_analysis_jobs (completed_at)
  WHERE completed_at IS NOT NULL;

COMMENT ON INDEX idx_dialer_analysis_jobs_completed IS
  'The newest completed analysis job: the other side of the summary delay (analysisDelaySql, AD1).';

-- An index built beforehand with CONCURRENTLY that failed is left invalid under its name, and
-- IF NOT EXISTS would accept it. Fail instead; drop it and build it again (db-hygiene.md §2).
DO $$
DECLARE
  bad text;
BEGIN
  SELECT string_agg(c.relname, ', ') INTO bad
    FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
   WHERE c.relname IN ('idx_dialer_analysis_jobs_vendor_refused', 'idx_dialer_analysis_jobs_completed')
     AND NOT (i.indisvalid AND i.indisready);
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'invalid index from an earlier CREATE INDEX CONCURRENTLY: %; DROP INDEX CONCURRENTLY and build again', bad;
  END IF;
END
$$;

-- Down Migration

DROP INDEX IF EXISTS idx_dialer_analysis_jobs_completed;
DROP INDEX IF EXISTS idx_dialer_analysis_jobs_vendor_refused;
