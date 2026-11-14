-- 0039_retention_purge_indexes.sql — indexes for the daily retention purge (retention-purge.ts).
--
-- The purge finds old rows by time, and none of these reads had an index to do it with, so each
-- read the whole table even on a day with nothing to remove:
--   - the transcript step (on by default, `AGENCY_TRANSCRIPT_RETENTION_DAYS`): agency_calls
--     `WHERE created_at < $1 AND (conversation_log IS NOT NULL OR transcript_meta IS NOT NULL)`;
--     the only index on agency_calls.created_at (idx_agency_calls_active) holds non-terminal
--     calls only;
--   - the row purge (`AGENCY_RETENTION_DAYS`, off until a window is agreed): dialer_analysis_jobs
--     and agency_calls `WHERE created_at < $1`, and the inbound voicemail walk
--     `WHERE voicemail_key IS NOT NULL AND arrived_at < $1 ORDER BY arrived_at, id`.
--
-- ── Indexes ───────────────────────────────────────────────────────────────────
-- idx_agency_calls_transcript_pending (created_at) WHERE conversation_log IS NOT NULL OR
--   transcript_meta IS NOT NULL: partial, so it holds only the calls that still carry a
--   transcript (the window's worth); a nulled row leaves it. The predicate is spelled exactly as
--   the purge's `hasTranscript` so the planner can prove the read implies it.
-- idx_agency_calls_created (created_at): the row purge's count and batched delete.
-- idx_dialer_analysis_jobs_created (created_at): the same for the analysis jobs.
-- idx_agency_inbound_calls_voicemail (arrived_at, id) WHERE voicemail_key IS NOT NULL: the
--   voicemail walk's keyset order; partial, so it holds only calls that still name a voicemail.
-- created_at and arrived_at are never updated, so the plain indexes do not stop a HOT update.
--
-- ── Locking ───────────────────────────────────────────────────────────────────
-- A plain CREATE INDEX, as every index here is: the server is one replica and migrations run at
-- container start, before it listens. Each build reads its table once. On a production database
-- where agency_calls is already large, build these first with CREATE INDEX CONCURRENTLY under the
-- same names (db-hygiene.md, "Building an index before a deploy"); IF NOT EXISTS then finds them
-- and this migration only records itself.
-- `SET LOCAL lock_timeout = '10s'` first: a lock not granted within 10 s fails the migration
-- (the deploy can be retried) instead of queueing every other query behind the wait.
--
-- ── Down ──────────────────────────────────────────────────────────────────────
-- Drops the four indexes; the purge reads go back to scanning.
--
-- Runs as one node-pg-migrate SQL migration in one transaction; split on the up/down marker
-- comments (see 0001_baseline.sql's header for the regex).

-- Up Migration

-- Fail fast if a straggler connection holds a lock on one of these tables (db-hygiene.md).
SET LOCAL lock_timeout = '10s';

CREATE INDEX IF NOT EXISTS idx_agency_calls_transcript_pending
  ON agency_calls (created_at)
  WHERE conversation_log IS NOT NULL OR transcript_meta IS NOT NULL;

COMMENT ON INDEX idx_agency_calls_transcript_pending IS
  'Calls that still carry a transcript, by age: the retention purge''s transcript step (purgeAgencyTranscripts).';

CREATE INDEX IF NOT EXISTS idx_agency_calls_created
  ON agency_calls (created_at);

COMMENT ON INDEX idx_agency_calls_created IS
  'Calls by age: the retention row purge (PURGE_TARGETS, AGENCY_RETENTION_DAYS).';

CREATE INDEX IF NOT EXISTS idx_dialer_analysis_jobs_created
  ON dialer_analysis_jobs (created_at);

COMMENT ON INDEX idx_dialer_analysis_jobs_created IS
  'Analysis jobs by age: the retention row purge (PURGE_TARGETS, AGENCY_RETENTION_DAYS).';

CREATE INDEX IF NOT EXISTS idx_agency_inbound_calls_voicemail
  ON agency_inbound_calls (arrived_at, id)
  WHERE voicemail_key IS NOT NULL;

COMMENT ON INDEX idx_agency_inbound_calls_voicemail IS
  'Inbound calls that still name a voicemail, oldest first: the retention purge''s voicemail walk (purgeInboundVoicemails).';

-- Down Migration

DROP INDEX IF EXISTS idx_agency_inbound_calls_voicemail;
DROP INDEX IF EXISTS idx_dialer_analysis_jobs_created;
DROP INDEX IF EXISTS idx_agency_calls_created;
DROP INDEX IF EXISTS idx_agency_calls_transcript_pending;
