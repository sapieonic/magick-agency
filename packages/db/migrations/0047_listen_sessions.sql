-- 0047_listen_sessions.sql — live call listening (docs/listening.md, decisions LS1–LS14): one row
-- per listen session, a supervisor listening in silently to a call in progress from the console.
--
-- ── agency_listen_sessions (new) ──────────────────────────────────────────────
-- Written by the process that owns the call when a listener socket attaches, and awaited before
-- any audio flows (no row, no audio, LS7); closed when the session ends. The row is the record of
-- who listened: the audit pair (`agency_call.listen_started` / `_ended`) goes through the buffered
-- audit writer, which can lose rows on a crash, and this table does not.
--  - id: the listen id, minted with the grant and named in the socket's path (`ready.listen_id`).
--  - tenant_id, account_id: the call's, every read is scoped by them.
--  - call_id: `agency_calls.id`. No foreign key, as `agency_calls`' own correlations: the two
--    tables purge on their own horizons (this one the audit log's), and a cascade either way
--    would destroy the other's trail.
--  - origin: `agency_calls.origin` (contract AGENCY_CALL_ORIGINS); correlation_id: the call's
--    spine row (`agency_call_attempts.id`, `agency_manual_calls.id` or `agency_inbound_calls.id`);
--    campaign_id: the campaign the call belongs to (a dialler call always has one), so the audit
--    rows and the campaign's History find it.
--  - agent_session_id, agent_user_id: the agent on the call; listener_user_id: the supervisor.
--  - started_at, ended_at, end_reason (contract AGENCY_LISTEN_END_REASONS): ended_at and
--    end_reason are both set or both NULL. An open row is a session in progress, or one whose
--    process died: the next boot (and the primary's reap of a dead media worker) closes those as
--    `server_restarted` by replica_id.
--  - frames_sent, frames_dropped: 20 ms frames sent to the listener (both legs) and dropped under
--    its back-pressure, written at the close.
--  - replica_id: the process that owns the call and the session (`AgencyRuntime.replicaId`, as
--    `agency_agent_sessions.owner_replica`).
-- No foreign keys at all, as the other agency tables' actor columns: the row outlives a removed
-- user or campaign, which is the point of a record.
--
-- ── CHECKs ────────────────────────────────────────────────────────────────────
--  - ck_agency_listen_sessions_origin, _end_reason: the contract's lists (held equal by
--    test/integration/db/listen-sessions-migration.test.ts, with origin equal to
--    ck_agency_calls_origin's list).
--  - _ended: ended_at and end_reason both or neither, and an end never before the start.
--  - _campaign: a dialler call's session names its campaign.
--  - _frames: the counters never negative.
--  - _not_own_call: a supervisor never listens to a call they are the agent on (LS3; the grant
--    refuses it first, `listen_own_call`).
--
-- ── Indexes ───────────────────────────────────────────────────────────────────
--  - idx_agency_listen_sessions_open (tenant_id, account_id) WHERE ended_at IS NULL: the live
--    list's listeners and the caps; partial, so it holds only the sessions open now (a handful),
--    which is also what the boot and worker reaps walk.
--  - idx_agency_listen_sessions_call (call_id): "Listened to by" on the call detail pages.
--  - idx_agency_listen_sessions_listener (tenant_id, listener_user_id, started_at DESC): one
--    supervisor's sessions, newest first (the revocation's lookup, support questions).
-- The retention sweep (`audit/audit-partition-maintenance.ts`, the audit log's horizon,
-- `AUDIT_RETENTION_DAYS`) deletes by started_at with no index of its own: once a day over a table
-- of a few sessions a day per supervisor, a scan is cheaper than an index every insert maintains.
--
-- ── Locking ───────────────────────────────────────────────────────────────────
-- A new table: no lock on anything the live server writes.
--
-- ── Down ──────────────────────────────────────────────────────────────────────
-- Refuses while any session row exists: the rows are the record of who listened to which call,
-- and the audit pair may be missing rows. Export or delete them deliberately, then roll back.
-- Otherwise drops the table (its indexes and CHECKs with it).
--
-- Runs as one node-pg-migrate SQL migration in one transaction; split on the up/down marker
-- comments (see 0001_baseline.sql's header for the regex).

-- Up Migration

CREATE TABLE agency_listen_sessions (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         UUID NOT NULL,
  account_id        UUID NOT NULL,
  call_id           UUID NOT NULL,
  origin            VARCHAR(16) NOT NULL,
  campaign_id       UUID,
  correlation_id    UUID NOT NULL,
  agent_session_id  UUID NOT NULL,
  agent_user_id     UUID NOT NULL,
  listener_user_id  UUID NOT NULL,
  started_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at          TIMESTAMPTZ,
  end_reason        VARCHAR(32),
  frames_sent       INTEGER NOT NULL DEFAULT 0,
  frames_dropped    INTEGER NOT NULL DEFAULT 0,
  replica_id        VARCHAR(100) NOT NULL,

  CONSTRAINT ck_agency_listen_sessions_origin CHECK (origin IN ('campaign', 'manual', 'inbound')),
  CONSTRAINT ck_agency_listen_sessions_end_reason CHECK (
    end_reason IS NULL OR end_reason IN (
      'call_ended', 'listener_stopped', 'listener_disconnected', 'permission_revoked', 'superseded',
      'send_backlog', 'tap_error', 'server_shutdown', 'server_restarted')
  ),
  CONSTRAINT ck_agency_listen_sessions_ended CHECK (
    (ended_at IS NULL) = (end_reason IS NULL)
    AND (ended_at IS NULL OR ended_at >= started_at)
  ),
  CONSTRAINT ck_agency_listen_sessions_campaign CHECK (origin <> 'campaign' OR campaign_id IS NOT NULL),
  CONSTRAINT ck_agency_listen_sessions_frames CHECK (frames_sent >= 0 AND frames_dropped >= 0),
  CONSTRAINT ck_agency_listen_sessions_not_own_call CHECK (listener_user_id <> agent_user_id)
);

COMMENT ON TABLE agency_listen_sessions IS
  'Live call listening (docs/listening.md): one row per listen session, written before any audio flows and closed when it ends; the record of who listened to which call. Purged at the audit log''s horizon.';
COMMENT ON COLUMN agency_listen_sessions.correlation_id IS
  'The call''s spine row: agency_call_attempts.id (origin campaign), agency_manual_calls.id (manual) or agency_inbound_calls.id (inbound). No foreign key.';
COMMENT ON COLUMN agency_listen_sessions.end_reason IS
  'Why the session ended (contract AGENCY_LISTEN_END_REASONS); NULL while open. server_restarted: closed by the boot or worker reap.';
COMMENT ON COLUMN agency_listen_sessions.replica_id IS
  'The process that owns the call and the session (AgencyRuntime.replicaId): the reap closes a dead process''s open rows by it.';

CREATE INDEX idx_agency_listen_sessions_open
  ON agency_listen_sessions (tenant_id, account_id)
  WHERE ended_at IS NULL;

COMMENT ON INDEX idx_agency_listen_sessions_open IS
  'The sessions open now, per account: the live list''s listeners, the caps and the reaps.';

CREATE INDEX idx_agency_listen_sessions_call
  ON agency_listen_sessions (call_id);

COMMENT ON INDEX idx_agency_listen_sessions_call IS
  'A call''s listen sessions: "Listened to by" on the call detail pages.';

CREATE INDEX idx_agency_listen_sessions_listener
  ON agency_listen_sessions (tenant_id, listener_user_id, started_at DESC);

COMMENT ON INDEX idx_agency_listen_sessions_listener IS
  'One supervisor''s listen sessions, newest first.';

-- Down Migration

DO $$
BEGIN
  IF to_regclass('agency_listen_sessions') IS NOT NULL
     AND EXISTS (SELECT 1 FROM agency_listen_sessions) THEN
    RAISE EXCEPTION '0047_listen_sessions down: listen sessions exist (the record of who listened to which call); export or delete them deliberately before rolling back';
  END IF;
END
$$;

DROP TABLE IF EXISTS agency_listen_sessions;
