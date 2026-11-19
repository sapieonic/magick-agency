-- 0052_floor_assist.sql — the Live floor's Phase 3, floor assist (decisions LF4, LF5, LF11 onwards):
-- an agent's Need help on their own session, and a supervisor's messages to an agent's station.
-- 0051 is applied and is not edited.
--
-- ── agency_agent_sessions: the Need help request (new columns) ────────────────
-- help_raised_at   TIMESTAMPTZ  when the agent raised it; NULL: none (never, cancelled, expired, or
--                               ended with the session). Kept after an answer, beside the two below.
-- help_call_id     UUID         the call it was raised on (agency_calls.id, what a listen takes);
--                               NULL in wrap-up. No foreign key: agency_calls rows are purged.
-- help_answered_at TIMESTAMPTZ  when a supervisor answered it (a listen went live, or a message
--                               reached the station); NULL while open.
-- help_answered_by UUID         who answered (users.id). No foreign key, as the session's own
--                               agent_user_id.
-- Open means raised, not answered, and raised less than AGENCY_HELP_EXPIRY_MS (15 minutes) ago; the
-- expiry is read by every read (the floor, the station's ready frame) against now(), and the
-- server's sweep clears the columns of the expired, which is what sends the frame and writes the
-- audit row. Every transition is one conditional UPDATE, so each request ends exactly once
-- (apps/server/src/db/repositories/agency/floor-assist.repository.ts).
--
-- ck_agency_agent_sessions_help (NOT VALID): answered_at and answered_by together; an answer and a
-- call only on a raised request; an answer never before the raise. NOT VALID because it reads only
-- the columns this migration adds, which are NULL on every row already there, so validating it
-- would read the whole table under ACCESS EXCLUSIVE to prove nothing; it is enforced on every
-- insert and update from here on all the same.
--
-- idx_agency_agent_sessions_help_open (tenant_id, account_id, help_raised_at)
--   WHERE help_raised_at IS NOT NULL AND help_answered_at IS NULL: the requests not answered, a
--   handful at any time. The floor reads an account's from it, the sweep the expired ones across the
--   deployment. Its columns are never touched by the heartbeat or a state change, so those updates
--   stay HOT (0038's fillfactor).
--
-- ── agency_supervisor_messages (new) ──────────────────────────────────────────
-- One row per message a supervisor sent to an agent's station (Talk to agent, Send reminder):
-- tenant, account, the agent's session and user, the sender, the text (trimmed, 1 to 500
-- characters: AGENCY_SUPERVISOR_MESSAGE_MAX_CHARS), when it was sent, and whether a station took it
-- (`delivered`: written false, set true once the frame was written to the agent's socket; one left
-- false is a message the route answered 409 agent_not_live). Kept 90 days
-- (AGENCY_SUPERVISOR_MESSAGE_RETENTION_DAYS): the retention purge deletes older rows on every run
-- (apps/server/src/maintenance/retention-purge.ts), on idx_agency_supervisor_messages_sent_at. No
-- foreign keys, as agency_listen_sessions: the record outlives nothing it names here.
--
-- ── Locking ───────────────────────────────────────────────────────────────────
-- The ADD COLUMNs (no default) and the NOT VALID CHECK are catalog-only, no rewrite, but take ACCESS
-- EXCLUSIVE on agency_agent_sessions, which the live server writes; the index build then reads the
-- table once (every help_raised_at is NULL, so it writes an empty index) under that lock. The
-- migration runs at container start, before the server listens, and the sessions table is small (a
-- row per agent per shift). `SET LOCAL lock_timeout = '10s'` first: a lock not granted in 10 s fails
-- the migration (the deploy can be retried) instead of queueing every query behind the wait. The
-- index cannot be built beforehand: its columns are new here.
--
-- ── Down ──────────────────────────────────────────────────────────────────────
-- Drops the table, the index, the CHECK and the four columns: open requests and kept messages go
-- with them (a release before this one has neither).
--
-- Runs as one node-pg-migrate SQL migration in one transaction; split on the up/down marker
-- comments (see 0001_baseline.sql's header for the regex).

-- Up Migration

SET LOCAL lock_timeout = '10s';

ALTER TABLE agency_agent_sessions
  ADD COLUMN IF NOT EXISTS help_raised_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS help_call_id UUID,
  ADD COLUMN IF NOT EXISTS help_answered_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS help_answered_by UUID;

ALTER TABLE agency_agent_sessions
  ADD CONSTRAINT ck_agency_agent_sessions_help CHECK (
    (help_answered_at IS NULL) = (help_answered_by IS NULL)
    AND (help_answered_at IS NULL OR (help_raised_at IS NOT NULL AND help_answered_at >= help_raised_at))
    AND (help_call_id IS NULL OR help_raised_at IS NOT NULL)
  ) NOT VALID;

COMMENT ON COLUMN agency_agent_sessions.help_raised_at IS
  'Need help (LF4): when the agent raised the request; NULL when none (cancelled, expired or ended with the session clear it). Open while not answered and under 15 minutes old.';
COMMENT ON COLUMN agency_agent_sessions.help_call_id IS
  'Need help: the call the request was raised on (agency_calls.id); NULL when raised in wrap-up. No foreign key.';
COMMENT ON COLUMN agency_agent_sessions.help_answered_at IS
  'Need help: when a supervisor answered the request (a listen went live, or a message reached the station); NULL while open.';
COMMENT ON COLUMN agency_agent_sessions.help_answered_by IS
  'Need help: the supervisor who answered (users.id). No foreign key.';

CREATE INDEX IF NOT EXISTS idx_agency_agent_sessions_help_open
  ON agency_agent_sessions (tenant_id, account_id, help_raised_at)
  WHERE help_raised_at IS NOT NULL AND help_answered_at IS NULL;

COMMENT ON INDEX idx_agency_agent_sessions_help_open IS
  'Need help requests not answered: an account''s for the floor read, the expired ones for the sweep (LF4).';

CREATE TABLE agency_supervisor_messages (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL,
  account_id      UUID NOT NULL,
  session_id      UUID NOT NULL,
  agent_user_id   UUID NOT NULL,
  sender_user_id  UUID NOT NULL,
  text            TEXT NOT NULL,
  sent_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  delivered       BOOLEAN NOT NULL DEFAULT false,

  CONSTRAINT ck_agency_supervisor_messages_text CHECK (
    char_length(text) BETWEEN 1 AND 500 AND text = btrim(text, E' \t\r\n')
  )
);

COMMENT ON TABLE agency_supervisor_messages IS
  'Live floor messages (LF5): one row per message a supervisor sent to an agent''s station (Talk to agent, Send reminder). Kept 90 days: the retention purge deletes older rows.';
COMMENT ON COLUMN agency_supervisor_messages.session_id IS
  'The agent''s session (agency_agent_sessions.id) whose station was sent the message. No foreign key.';
COMMENT ON COLUMN agency_supervisor_messages.delivered IS
  'Whether the frame was written to the agent''s station socket. False: the route answered 409 agent_not_live.';

CREATE INDEX idx_agency_supervisor_messages_sent_at
  ON agency_supervisor_messages (sent_at);

COMMENT ON INDEX idx_agency_supervisor_messages_sent_at IS
  'The retention purge''s walk of messages older than 90 days.';

-- Down Migration

SET LOCAL lock_timeout = '10s';

DROP TABLE IF EXISTS agency_supervisor_messages;

DROP INDEX IF EXISTS idx_agency_agent_sessions_help_open;

ALTER TABLE agency_agent_sessions DROP CONSTRAINT IF EXISTS ck_agency_agent_sessions_help;

ALTER TABLE agency_agent_sessions
  DROP COLUMN IF EXISTS help_answered_by,
  DROP COLUMN IF EXISTS help_answered_at,
  DROP COLUMN IF EXISTS help_call_id,
  DROP COLUMN IF EXISTS help_raised_at;
