-- 0006_agent_session_client_kind.sql — which app an agent session's station is attached from.
--
-- The agent mobile app (agent-only, Flutter) joins campaigns through the same session and station
-- socket as the browser console. `client_kind` records which app the session's station socket last
-- attached from: `web` (the console) or `mobile`. It is written by every station attach (the
-- upgrade's `client=` query), so a session continued on another device ("Continue on this phone"
-- rehydrates the same session) follows the device. The supervisor's floor reads it to mark agents
-- working from the app; liveness itself reads the in-memory station entry, never this column.
--
-- Client-declared and never verified: nothing security-relevant may read it.
--
-- ── Locking ───────────────────────────────────────────────────────────────────
-- ADD COLUMN with a constant DEFAULT does not rewrite the table (PG 11+); the CHECK scans it once
-- under the ACCESS EXCLUSIVE lock the ALTER takes. Migrations run at container start, before the
-- server listens (docker/entrypoint.sh), so nothing is writing the table meanwhile. No index:
-- nothing filters on it (the floor reads it per live session it already selected).
--
-- Runs as one node-pg-migrate SQL migration in one transaction; split on the up/down marker
-- comments (see 0001_baseline.sql's header for the regex).

-- Up Migration

-- `web` for every existing row: every session before this migration was the console's.
ALTER TABLE agency_agent_sessions
  ADD COLUMN client_kind VARCHAR(16) NOT NULL DEFAULT 'web',
  ADD CONSTRAINT ck_agency_agent_session_client_kind CHECK (client_kind IN ('web', 'mobile'));

COMMENT ON COLUMN agency_agent_sessions.client_kind IS
  'web | mobile: the app this session''s station socket last attached from, written by every attach. Client-declared; display only.';

-- Down Migration

ALTER TABLE agency_agent_sessions
  DROP CONSTRAINT IF EXISTS ck_agency_agent_session_client_kind,
  DROP COLUMN IF EXISTS client_kind;
