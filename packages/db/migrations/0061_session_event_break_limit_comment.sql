-- 0061_session_event_break_limit_comment.sql — 0060's column comment said the wrong limit. No schema
-- change: one COMMENT. 0060 is applied and is not edited (agent station redesign, BE-12; AS12).
--
-- 0060 described agency_agent_session_events.break_limit_minutes as the reason's limit "when the
-- break began". The server writes the limit as the campaign's break catalog stands when the break
-- ENDS (the session transition that leaves `break` reads the catalog in the same statement, and
-- packages/domain/src/break-manager.ts judges the overrun against it): a supervisor who changes a
-- reason's limit during a break changes the limit that break is judged by. That reading was
-- accepted (it needs no limit stored at the break's start, and the alert on the floor reads the
-- catalog as it stands too); this migration makes the column's comment say so.
--
-- ── Locking ───────────────────────────────────────────────────────────────────
-- COMMENT ON COLUMN writes pg_description only: no rewrite, no scan, a brief lock on the event log
-- (which every state change writes) until commit. `SET LOCAL lock_timeout = '10s'` first
-- (db-hygiene.md), so a straggler holding the table fails the migration fast instead of queueing
-- every transition behind it.
--
-- ── Down ──────────────────────────────────────────────────────────────────────
-- Puts 0060's comment back, word for word.
--
-- Runs as one node-pg-migrate SQL migration in one transaction; split on the up/down marker
-- comments (see 0001_baseline.sql's header for the regex).

-- Up Migration

SET LOCAL lock_timeout = '10s';

COMMENT ON COLUMN agency_agent_session_events.break_limit_minutes IS
  'Agent station (BE-12): on the event that ended a break that ran over, its reason''s limit in minutes as the campaign''s break catalog stood when the break ended (a limit changed during the break is the one judged). NULL otherwise.';

-- Down Migration

SET LOCAL lock_timeout = '10s';

COMMENT ON COLUMN agency_agent_session_events.break_limit_minutes IS
  'Agent station (BE-12): on the event that ended a break that ran over, its reason''s limit in minutes when the break began. NULL otherwise.';
