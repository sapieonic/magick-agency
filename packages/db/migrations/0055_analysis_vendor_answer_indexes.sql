-- 0055_analysis_vendor_answer_indexes.sql — the two partial indexes `analysisDelaySql` reads
-- (decision AD1, `docs/decisions.md`; the rule is that function's JSDoc in
-- `dialer-analysis-job.repository.ts`), built out of 0054's ACCESS EXCLUSIVE (0041 / 0045's split):
--   idx_dialer_analysis_jobs_vendor_refused (vendor_refused_at)
--     WHERE status = 'queued' AND error_code = 'RATE_LIMITED', spelled as the read spells it
--   idx_dialer_analysis_jobs_completed (completed_at) WHERE completed_at IS NOT NULL
-- Each side of the read is then one probe of an index's end (`max(...)`), not a walk of the queue.
--
-- Locking: plain CREATE INDEX (a SQL file's Up runs in a transaction, where CONCURRENTLY is
-- refused) holds SHARE on dialer_analysis_jobs until commit: reads proceed, writes wait. On the
-- release that adds 0054 both columns are new, so each build is one read of the table. The Up
-- starts with a lock timeout (db-hygiene.md). `IF NOT EXISTS`, so a database already on 0054 can
-- build them CONCURRENTLY first; the check at the end of Up refuses an invalid index such a failed
-- build leaves under a name (db-hygiene.md §2).
--
-- Down: drops the two; the delay read still works, reading the jobs without them (slower).
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
