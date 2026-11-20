-- 0062_session_suspended_break.sql — the start of a break a station drop suspended (agent station
-- redesign, BE-12; docs/agent-station.md AS12). 0061 is applied and is not edited.
--
-- A break that ran past its reason's limit is recorded on the event that ends it (0060). A station
-- that drops mid-break writes the session `offline` (the reason kept), and its reconnect puts the
-- agent back on the same break: judged at each of those writes, one 50-minute lunch split by a drop
-- at 25 minutes read as two short ones, under a 30-minute limit, and was never recorded. So the drop
-- now suspends the break rather than ending it, and this column keeps its start across the drop:
--
-- ── agency_agent_sessions (new column) ────────────────────────────────────────
-- suspended_break_since TIMESTAMPTZ  the start of the break the session was on when its station
--                                    went (`setState`'s reason-keeping `offline` from `break`,
--                                    truncated to the millisecond so the server's clock reads it
--                                    back exactly); kept by another such write, NULL after every
--                                    other write. The rehydrate that restores that same named break
--                                    (under 4 hours old) carries it as `state_since`, and the break
--                                    is judged once, at its real end; a session that moves on any
--                                    other way has the suspended break judged as ended at the drop,
--                                    on the drop's own event. NULL on every row already there.
--
-- No CHECK: every writer of the session's state is in one repository, and a constraint here could
-- only fail a state transition, which must never fail (agent-session.repository.ts). No index: it is
-- read only on the row the transition already locks.
--
-- ── Locking ───────────────────────────────────────────────────────────────────
-- ADD COLUMN with no default is catalog-only, no rewrite, but takes ACCESS EXCLUSIVE on
-- agency_agent_sessions, which the live server writes; the table is small (a row per agent per
-- shift). `SET LOCAL lock_timeout = '10s'` first (db-hygiene.md).
--
-- ── Down ──────────────────────────────────────────────────────────────────────
-- Drops the column: a break suspended at the time comes back as a fresh one, as before 0062.
--
-- Runs as one node-pg-migrate SQL migration in one transaction; split on the up/down marker
-- comments (see 0001_baseline.sql's header for the regex).

-- Up Migration

SET LOCAL lock_timeout = '10s';

ALTER TABLE agency_agent_sessions ADD COLUMN IF NOT EXISTS suspended_break_since TIMESTAMPTZ;

COMMENT ON COLUMN agency_agent_sessions.suspended_break_since IS
  'Agent station (BE-12): the start of the break a station drop suspended (the reason-keeping offline from break), so the rehydrate that restores the same named break carries it and the break is judged once. NULL otherwise.';

-- Down Migration

SET LOCAL lock_timeout = '10s';

ALTER TABLE agency_agent_sessions DROP COLUMN IF EXISTS suspended_break_since;
