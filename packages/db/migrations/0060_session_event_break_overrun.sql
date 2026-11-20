-- 0060_session_event_break_overrun.sql — a break that ran past its reason's limit, recorded on the
-- session event that ended it (agent station redesign, BE-12; docs/agent-station.md AS12). 0059 is
-- applied and is not edited.
--
-- The agent and the floor already see a break run over (LF6, LF20, the floor's
-- `break_limit_minutes`); nothing recorded it. When a break ends, the server compares its length
-- with the reason's `limit_minutes` (the pure rule in packages/domain/src/break-manager.ts) and,
-- when it is over, writes the overrun on the transition row that ends it (from_state = 'break'),
-- counts `agency_break_overruns_total`, and the agent report sums it
-- (`AgentReviewPresence.break_overruns`). A reserved break (`soft_phone`, `device_away`,
-- `phone_call`, `away_ring`) never counts; a break that ends because the session ended is measured
-- to the session's end; a break with no recorded reason (a rehydrate after a restart) does not count.
--
-- ── agency_agent_session_events (new columns) ─────────────────────────────────
-- break_limit_minutes   SMALLINT  the reason's limit when the break began, 1 to 240 (a supervisor
--                                 may change the catalog during the break; the limit the agent
--                                 counted down from is the one judged).
-- break_overrun_seconds INTEGER   how far past it the break ran, in whole seconds, > 0.
-- Both set on the event that ends a break that ran over, both NULL on every other event.
-- ck_agency_session_event_break_overrun (NOT VALID): set together, only on a transition out of
-- `break`, the limit in 1–240, the overrun positive. NOT VALID because it reads only the columns
-- this migration adds, NULL on every row already there; validating it would read the whole event
-- log (one row per transition, a large table) under ACCESS EXCLUSIVE to prove nothing. It is
-- enforced on every insert from here on.
--
-- No index: the agent report reads the events by (agent_user_id, at)
-- (idx_agency_session_events_agent) and the campaign's by (campaign_id, at) already.
--
-- ── Locking ───────────────────────────────────────────────────────────────────
-- ADD COLUMN with no default and the NOT VALID CHECK are catalog-only, no rewrite, but take ACCESS
-- EXCLUSIVE on agency_agent_session_events, which every state change writes, until commit: a short
-- transaction. `SET LOCAL lock_timeout = '10s'` first (db-hygiene.md).
--
-- ── Down ──────────────────────────────────────────────────────────────────────
-- Drops the CHECK and the columns: the recorded overruns are lost; the events themselves stay.
--
-- Runs as one node-pg-migrate SQL migration in one transaction; split on the up/down marker
-- comments (see 0001_baseline.sql's header for the regex).

-- Up Migration

SET LOCAL lock_timeout = '10s';

ALTER TABLE agency_agent_session_events
  ADD COLUMN IF NOT EXISTS break_limit_minutes SMALLINT,
  ADD COLUMN IF NOT EXISTS break_overrun_seconds INTEGER;

ALTER TABLE agency_agent_session_events
  ADD CONSTRAINT ck_agency_session_event_break_overrun CHECK (
    (break_limit_minutes IS NULL) = (break_overrun_seconds IS NULL)
    AND (break_overrun_seconds IS NULL
         OR (from_state = 'break' AND break_limit_minutes BETWEEN 1 AND 240 AND break_overrun_seconds > 0))
  ) NOT VALID;

COMMENT ON COLUMN agency_agent_session_events.break_limit_minutes IS
  'Agent station (BE-12): on the event that ended a break that ran over, its reason''s limit in minutes when the break began. NULL otherwise.';
COMMENT ON COLUMN agency_agent_session_events.break_overrun_seconds IS
  'Agent station (BE-12): on the event that ended a break that ran over, how far past its limit, in whole seconds (> 0). NULL otherwise.';

-- Down Migration

SET LOCAL lock_timeout = '10s';

ALTER TABLE agency_agent_session_events DROP CONSTRAINT IF EXISTS ck_agency_session_event_break_overrun;

ALTER TABLE agency_agent_session_events
  DROP COLUMN IF EXISTS break_overrun_seconds,
  DROP COLUMN IF EXISTS break_limit_minutes;
