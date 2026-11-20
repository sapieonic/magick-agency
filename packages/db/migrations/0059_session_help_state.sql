-- 0059_session_help_state.sql — the agent's state when they raised Need help (agent station
-- redesign, BE-9; docs/agent-station.md AS5: Need help on every working screen). 0058 is applied
-- and is not edited.
--
-- ── agency_agent_sessions (new column) ────────────────────────────────────────
-- help_state VARCHAR(20)  the session's state when the open request was raised (`offline`,
--                         `available`, `reserved`, `on_call`, `wrapup`, `break`: the agent states),
--                         served as `AgencySessionHelp.state_at_raise` on the floor, the station's
--                         `ready.help`, the raise's answer and the supervisor alerts. Written by the
--                         raise with help_raised_at and cleared with it (the cancel, the expiry
--                         sweep, the session's end), so it is never left behind a cleared request.
--                         NULL on a request raised before this migration, and when none is open.
-- ck_agency_agent_sessions_help_state (NOT VALID): a state only on a raised request, and one of the
-- six. NOT VALID because it reads only the column this migration adds, NULL on every row already
-- there, so validating it would read the whole table under ACCESS EXCLUSIVE to prove nothing (0052's
-- reasoning for its help CHECK); it is enforced on every insert and update from here on.
--
-- ── Locking ───────────────────────────────────────────────────────────────────
-- ADD COLUMN with no default and the NOT VALID CHECK are catalog-only, no rewrite, but take ACCESS
-- EXCLUSIVE on agency_agent_sessions, which the live server writes; the table is small (a row per
-- agent per shift). `SET LOCAL lock_timeout = '10s'` first (db-hygiene.md).
--
-- ── Down ──────────────────────────────────────────────────────────────────────
-- Drops the CHECK and the column; open requests stay open, without their state.
--
-- Runs as one node-pg-migrate SQL migration in one transaction; split on the up/down marker
-- comments (see 0001_baseline.sql's header for the regex).

-- Up Migration

SET LOCAL lock_timeout = '10s';

ALTER TABLE agency_agent_sessions ADD COLUMN IF NOT EXISTS help_state VARCHAR(20);

ALTER TABLE agency_agent_sessions
  ADD CONSTRAINT ck_agency_agent_sessions_help_state CHECK (
    help_state IS NULL
    OR (help_raised_at IS NOT NULL
        AND help_state IN ('offline', 'available', 'reserved', 'on_call', 'wrapup', 'break'))
  ) NOT VALID;

COMMENT ON COLUMN agency_agent_sessions.help_state IS
  'Need help (agent station BE-9): the agent''s state when the open request was raised (state_at_raise); cleared with help_raised_at. NULL when none, or raised before 0059.';

-- Down Migration

SET LOCAL lock_timeout = '10s';

ALTER TABLE agency_agent_sessions DROP CONSTRAINT IF EXISTS ck_agency_agent_sessions_help_state;

ALTER TABLE agency_agent_sessions DROP COLUMN IF EXISTS help_state;
