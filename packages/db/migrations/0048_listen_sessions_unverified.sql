-- 0048_listen_sessions_unverified.sql — live call listening (docs/listening.md, LS21, LS22): the
-- session rows learn a listen ended because access could not be checked, and which listens went
-- live. 0047 is applied and is not edited.
--
-- ── end_reason: `access_unverified` (LS21) ───────────────────────────────────
-- The periodic re-check ends a session it could not verify for 2 × AGENCY_LISTEN_RECHECK_MS (the
-- database or the flag store not answering), and a revocation's immediate re-check one it could not
-- read, with a reason of their own rather than `permission_revoked`: nothing said the supervisor
-- may no longer listen. ck_agency_listen_sessions_end_reason is dropped and re-added with the
-- contract's AGENCY_LISTEN_END_REASONS, `access_unverified` appended (held equal by
-- test/integration/db/listen-sessions-migration.test.ts and this migration's test).
--
-- ── live_at (new, LS22) ──────────────────────────────────────────────────────
-- When the session went live: admitted and its `ready` sent, the moment audio may flow. NULL for a
-- row the upgrade wrote and then refused (the call gone before the tap opened, a revocation between
-- the reservation and the admission, the client gone): those listens never heard anything, and
-- "Listened to by" leaves them out. Written by the process that owns the listen as it goes live,
-- and again at the close when that write did not land. CHECK ck_agency_listen_sessions_live: never
-- before the start. Rows written before this migration are backfilled with their start: they were
-- all shown as listens, and nothing on them says which never went live.
--
-- ── Locking ───────────────────────────────────────────────────────────────────
-- ALTER TABLE takes ACCESS EXCLUSIVE on agency_listen_sessions, which the live server writes, so
-- the Up starts with a lock timeout (db-hygiene.md). The table is small (a few sessions a day per
-- supervisor, kept for the audit horizon): the CHECKs validate and the backfill runs in the same
-- short transaction.
--
-- ── Down ──────────────────────────────────────────────────────────────────────
-- Refuses while any row ended `access_unverified` (0047's CHECK cannot hold it, and rewriting the
-- record's reason would falsify it): export or delete those rows deliberately first. Otherwise
-- drops live_at and its CHECK and restores 0047's end reason CHECK.
--
-- Runs as one node-pg-migrate SQL migration in one transaction; split on the up/down marker
-- comments (see 0001_baseline.sql's header for the regex).

-- Up Migration

SET LOCAL lock_timeout = '10s';

ALTER TABLE agency_listen_sessions
  DROP CONSTRAINT ck_agency_listen_sessions_end_reason,
  ADD CONSTRAINT ck_agency_listen_sessions_end_reason CHECK (
    end_reason IS NULL OR end_reason IN (
      'call_ended', 'listener_stopped', 'listener_disconnected', 'permission_revoked', 'superseded',
      'send_backlog', 'tap_error', 'server_shutdown', 'server_restarted', 'access_unverified')
  ),
  ADD COLUMN live_at TIMESTAMPTZ;

UPDATE agency_listen_sessions SET live_at = started_at;

ALTER TABLE agency_listen_sessions
  ADD CONSTRAINT ck_agency_listen_sessions_live CHECK (live_at IS NULL OR live_at >= started_at);

COMMENT ON COLUMN agency_listen_sessions.end_reason IS
  'Why the session ended (contract AGENCY_LISTEN_END_REASONS); NULL while open. server_restarted: closed by the boot or worker reap. access_unverified: the access re-check could not be made for too long.';
COMMENT ON COLUMN agency_listen_sessions.live_at IS
  'When the session went live (admitted, ready sent); NULL for a row the upgrade wrote and then refused, which never carried audio. "Listened to by" reads only live rows.';

-- Down Migration

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM agency_listen_sessions WHERE end_reason = 'access_unverified') THEN
    RAISE EXCEPTION '0048_listen_sessions_unverified down: listen sessions ended access_unverified exist (0047''s CHECK cannot hold them); export or delete them deliberately before rolling back';
  END IF;
END
$$;

SET LOCAL lock_timeout = '10s';

ALTER TABLE agency_listen_sessions
  DROP CONSTRAINT IF EXISTS ck_agency_listen_sessions_live,
  DROP COLUMN IF EXISTS live_at,
  DROP CONSTRAINT ck_agency_listen_sessions_end_reason,
  ADD CONSTRAINT ck_agency_listen_sessions_end_reason CHECK (
    end_reason IS NULL OR end_reason IN (
      'call_ended', 'listener_stopped', 'listener_disconnected', 'permission_revoked', 'superseded',
      'send_backlog', 'tap_error', 'server_shutdown', 'server_restarted')
  );

COMMENT ON COLUMN agency_listen_sessions.end_reason IS
  'Why the session ended (contract AGENCY_LISTEN_END_REASONS); NULL while open. server_restarted: closed by the boot or worker reap.';
