-- 0011_insights_foundation.sql — the shared schema the campaign insights page builds on
-- (docs/insights.md).
--
--  - agency_call_attempts.agent_reopened: the dial came from an agent-led reopen ("Retry not
--    reached"), placed through pacing. The pacing writer sets it; this file only adds the column.
--  - agency_contacts.dials_placed: every placed dial on the contact (IN6: wrap-up redials and
--    our-fault redials included, one per attempt row with `dialed_at` set). attempt_count is the
--    customer's retry allowance and our_fault_attempts the our-fault ledger; neither counts every
--    dial. Kept by two AFTER triggers on agency_call_attempts, so no writer can forget it, and
--    backfilled here from the attempts already there.
--  - four read indexes: the as-of-now roster buckets (index-only, one campaign), ranged attempt
--    reads by dial time and by callback time, and the per-campaign agent state history.
--
-- ── The counter ───────────────────────────────────────────────────────────────
-- A dial is placed when its attempt's `dialed_at` is set: on INSERT with it set, or on the
-- UPDATE that takes it from NULL to a value (AgencyAttemptRepository.setState 'dialing', whose
-- `COALESCE($5, dialed_at)` never clears it). Each trigger's WHEN clause is evaluated without
-- calling the function, so the attempt updates that do not place a dial (ringing, answered,
-- ended, the disposition) pay one comparison. A second write of `dialed_at` does not count
-- again. A deleted attempt does not decrement: the counter is dials placed, not rows kept. The
-- trigger's UPDATE runs inside the dialing statement (setState, one autocommit statement) and
-- locks the contact row after the attempt row; the contact is in_flight, held by that dial.
--
-- The counter is bookkeeping, not an edit of the contact, so it must not move the contact's
-- updated_at: the reaper's stranded-contact sweep reads it (`ct.updated_at < $1`, "untouched
-- since"), and a dial stamped on a contact must not reset that clock. trg_agency_contacts_updated_at
-- is re-created with a WHEN clause that skips exactly the nested update this file's function
-- issues (pg_trigger_depth() > 0, dials_placed changed); every statement the server sends runs
-- at depth 0 and is stamped as before. The backfill runs between the drop and the re-create, so
-- the contacts it fills keep their updated_at too.
--
-- ── Locking ───────────────────────────────────────────────────────────────────
-- One transaction. ADD COLUMN with a constant default does not rewrite either table (Postgres
-- 11+), but it, the CHECK and the triggers take ACCESS EXCLUSIVE on agency_contacts and
-- agency_call_attempts until commit, and the CHECK, the backfill and the four plain CREATE INDEX
-- builds (not CONCURRENTLY: one transaction, as 0003, 0004 and 0010) all run under it. Production
-- has no data yet (docs/status.md), so this is milliseconds there. On a large roster it is not:
-- measured on 1.2M contacts with 1.2M attempts (800k placed), on a shared dev host, the CHECK
-- took ~0.3 s, the backfill ~115 s (it rewrites every dialled contact), the builds ~4.1 s
-- (contacts), ~1.0 s and ~0.2 s (attempts). Before this runs on a populated database, move the
-- backfill and the builds to a file of their own, as 0009/0010 did. Migrations run at container
-- start, before the server listens (docker/entrypoint.sh).
--
-- Runs as one node-pg-migrate SQL migration in one transaction; split on the up/down marker
-- comments (see 0001_baseline.sql's header for the regex).

-- Up Migration

ALTER TABLE agency_call_attempts
  ADD COLUMN agent_reopened BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN agency_call_attempts.agent_reopened IS
  'True when the dial came from an agent-led reopen ("Retry not reached") placed through pacing. False for every other dial.';

ALTER TABLE agency_contacts
  ADD COLUMN dials_placed INTEGER NOT NULL DEFAULT 0,
  ADD CONSTRAINT ck_agency_contact_dials_placed CHECK (dials_placed >= 0);

COMMENT ON COLUMN agency_contacts.dials_placed IS
  'Every placed dial on this contact (attempt rows with dialed_at set), wrap-up redials and our-fault redials included (IN6). '
  'Maintained by trg_agency_attempts_dial_placed_insert / _update; never written by application code. '
  'Not the retry allowance (attempt_count) nor the our-fault ledger (our_fault_attempts).';

-- The backfill: the dials already placed, with the updated_at trigger off (header).
DROP TRIGGER trg_agency_contacts_updated_at ON agency_contacts;

UPDATE agency_contacts c
   SET dials_placed = d.n
  FROM (SELECT contact_id, count(*)::int AS n
          FROM agency_call_attempts
         WHERE dialed_at IS NOT NULL
         GROUP BY contact_id) d
 WHERE c.id = d.contact_id;

CREATE TRIGGER trg_agency_contacts_updated_at
  BEFORE UPDATE ON agency_contacts
  FOR EACH ROW
  WHEN (pg_trigger_depth() = 0 OR NEW.dials_placed IS NOT DISTINCT FROM OLD.dials_placed)
  EXECUTE FUNCTION update_updated_at();

COMMENT ON TRIGGER trg_agency_contacts_updated_at ON agency_contacts IS
  'Stamps updated_at on every update the server sends. Skips the nested update by '
  'agency_attempt_count_placed_dial() (inside a trigger, dials_placed changed): counting a dial '
  'is not an edit of the contact, and the stranded-contact sweep reads updated_at.';

CREATE OR REPLACE FUNCTION agency_attempt_count_placed_dial() RETURNS TRIGGER AS $$
BEGIN
  UPDATE agency_contacts SET dials_placed = dials_placed + 1 WHERE id = NEW.contact_id;
  RETURN NULL;
END $$ LANGUAGE plpgsql;

COMMENT ON FUNCTION agency_attempt_count_placed_dial() IS
  'Adds one to agency_contacts.dials_placed for the attempt''s contact. Called only by the two '
  'trg_agency_attempts_dial_placed_* triggers, whose WHEN clauses decide that a dial was placed.';

CREATE TRIGGER trg_agency_attempts_dial_placed_insert
  AFTER INSERT ON agency_call_attempts
  FOR EACH ROW WHEN (NEW.dialed_at IS NOT NULL)
  EXECUTE FUNCTION agency_attempt_count_placed_dial();

CREATE TRIGGER trg_agency_attempts_dial_placed_update
  AFTER UPDATE OF dialed_at ON agency_call_attempts
  FOR EACH ROW WHEN (OLD.dialed_at IS NULL AND NEW.dialed_at IS NOT NULL)
  EXECUTE FUNCTION agency_attempt_count_placed_dial();

CREATE INDEX idx_agency_contacts_insights
  ON agency_contacts (campaign_id, state)
  INCLUDE (next_attempt_at, suppressed_reason, attempt_count, dials_placed,
           last_outcome, last_disposition, assigned_user_id);

CREATE INDEX idx_agency_attempts_campaign_dialed
  ON agency_call_attempts (campaign_id, dialed_at)
  WHERE dialed_at IS NOT NULL;

CREATE INDEX idx_agency_attempts_campaign_callback
  ON agency_call_attempts (campaign_id, callback_at)
  WHERE callback_at IS NOT NULL;

CREATE INDEX idx_agency_session_events_campaign_at
  ON agency_agent_session_events (campaign_id, at);

COMMENT ON INDEX idx_agency_contacts_insights IS
  'Insights as-of-now reads: roster bucket counts, allocation and the headline for one campaign, index-only (every column they read is a key or INCLUDE column).';
COMMENT ON INDEX idx_agency_attempts_campaign_dialed IS
  'Insights range reads by dial time within one campaign, and the rollup recompute of one campaign''s dirty buckets.';
COMMENT ON INDEX idx_agency_attempts_campaign_callback IS
  'Insights callback timing (IN4): one campaign''s booked callbacks by callback_at.';
COMMENT ON INDEX idx_agency_session_events_campaign_at IS
  'Insights per-campaign agent state history: one campaign''s transitions over a time range, ordered for lead(at).';

-- Down Migration

DROP INDEX IF EXISTS idx_agency_session_events_campaign_at;
DROP INDEX IF EXISTS idx_agency_attempts_campaign_callback;
DROP INDEX IF EXISTS idx_agency_attempts_campaign_dialed;
DROP INDEX IF EXISTS idx_agency_contacts_insights;

DROP TRIGGER IF EXISTS trg_agency_attempts_dial_placed_update ON agency_call_attempts;
DROP TRIGGER IF EXISTS trg_agency_attempts_dial_placed_insert ON agency_call_attempts;
DROP FUNCTION IF EXISTS agency_attempt_count_placed_dial();

-- Back to 0001's trigger (its WHEN names dials_placed, so it goes before the column).
DROP TRIGGER IF EXISTS trg_agency_contacts_updated_at ON agency_contacts;
CREATE TRIGGER trg_agency_contacts_updated_at
  BEFORE UPDATE ON agency_contacts
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

ALTER TABLE agency_contacts
  DROP CONSTRAINT IF EXISTS ck_agency_contact_dials_placed,
  DROP COLUMN IF EXISTS dials_placed;

ALTER TABLE agency_call_attempts
  DROP COLUMN IF EXISTS agent_reopened;
