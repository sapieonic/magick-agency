-- 0039_retention_purge_indexes.sql — indexes for the daily retention purge (retention-purge.ts).
--
-- The purge finds old rows by time, and these two reads had no index to do it with, so each read
-- the whole table even on a day with nothing to remove:
--   - the transcript step (on by default, `AGENCY_TRANSCRIPT_RETENTION_DAYS`): agency_calls
--     `WHERE created_at < $1 AND (conversation_log IS NOT NULL OR transcript_meta IS NOT NULL)`;
--     the only index led by agency_calls.created_at (idx_agency_calls_active) holds non-terminal
--     calls only;
--   - the inbound voicemail walk of the row purge (`AGENCY_RETENTION_DAYS`, off until a window is
--     agreed): `WHERE voicemail_key IS NOT NULL AND arrived_at < $1 ORDER BY arrived_at, id`.
--
-- Deliberately NOT here: a plain (created_at) index on agency_calls or dialer_analysis_jobs for
-- the row purge's `WHERE created_at < $1`. Reads such as the analysis sweeps
-- (`WHERE status = 'awaiting_recording' ORDER BY created_at LIMIT n`) and the newest-first call
-- lists could switch to walking such an index in order and filtering, which reads most of the
-- table whenever the matching rows are few. The row purge is off; when a window is agreed, its
-- index (BRIN on created_at cannot supply an ORDER BY, so it cannot cause that switch) comes with
-- it (db-hygiene.md, "7. What to measure for phase 2").
--
-- ── Indexes ───────────────────────────────────────────────────────────────────
-- idx_agency_calls_transcript_pending (created_at) WHERE conversation_log IS NOT NULL OR
--   transcript_meta IS NOT NULL: partial, so it holds only the calls that still carry a
--   transcript (the window's worth); a nulled row leaves it. The predicate is spelled exactly as
--   the purge's `hasTranscript` so the planner can prove the read implies it.
-- idx_agency_inbound_calls_voicemail (arrived_at, id) WHERE voicemail_key IS NOT NULL: the
--   voicemail walk's keyset order; partial, so it holds only calls that still name a voicemail.
-- An update that sets or clears conversation_log, transcript_meta or voicemail_key is no longer
-- a HOT update (the row enters or leaves a partial index): about one such update per call.
--
-- ── Locking ───────────────────────────────────────────────────────────────────
-- A plain CREATE INDEX, as every index here is: the server is one replica and migrations run at
-- container start, before it listens. Each build reads its table once. On a production database
-- where agency_calls is already large, build these first with CREATE INDEX CONCURRENTLY under the
-- same names (db-hygiene.md, "2. Building an index before a deploy"); IF NOT EXISTS then finds
-- them (still taking a brief SHARE lock) and the migration adds the comments and records itself.
-- A CONCURRENTLY build that failed leaves an invalid index under the name; the check at the end
-- of Up fails the migration on one, rather than record an index the planner will never use.
-- `SET LOCAL lock_timeout = '10s'` first: a lock not granted within 10 s fails the migration
-- (the deploy can be retried) instead of queueing every other query behind the wait.
--
-- ── Down ──────────────────────────────────────────────────────────────────────
-- Drops the two indexes; the purge reads go back to scanning.
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

CREATE INDEX IF NOT EXISTS idx_agency_inbound_calls_voicemail
  ON agency_inbound_calls (arrived_at, id)
  WHERE voicemail_key IS NOT NULL;

COMMENT ON INDEX idx_agency_inbound_calls_voicemail IS
  'Inbound calls that still name a voicemail, oldest first: the retention purge''s voicemail walk (purgeInboundVoicemails).';

-- An index built beforehand with CONCURRENTLY that failed is left invalid under its name, and
-- IF NOT EXISTS would accept it. Fail instead; drop it and build it again (db-hygiene.md §2).
DO $$
DECLARE
  bad text;
BEGIN
  SELECT string_agg(c.relname, ', ') INTO bad
    FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
   WHERE c.relname IN ('idx_agency_calls_transcript_pending', 'idx_agency_inbound_calls_voicemail')
     AND NOT (i.indisvalid AND i.indisready);
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'invalid index(es) from an earlier CREATE INDEX CONCURRENTLY: %; DROP INDEX CONCURRENTLY and build again', bad;
  END IF;
END
$$;

-- Down Migration

DROP INDEX IF EXISTS idx_agency_inbound_calls_voicemail;
DROP INDEX IF EXISTS idx_agency_calls_transcript_pending;
