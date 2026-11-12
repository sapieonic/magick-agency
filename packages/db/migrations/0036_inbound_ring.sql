-- 0036_inbound_ring.sql — Mode B: ring an away agent's phone for inbound calls (docs/inbound.md,
-- decisions IQ58–IQ74). The agent app's push devices, the ring on the inbound spine, and the away
-- break's own state on the session.
--
-- ── agency_push_devices (new) ─────────────────────────────────────────────────
-- One row per (agent, device): `device_id` is the app's station device id (OS3,
-- agency_agent_sessions.station_device_id), so the device that may be rung for a session is the
-- one holding its station (IQ60), joined on (user_id, device_id) = (agent_user_id,
-- station_device_id). Per user, not per tenant: an agent holds one live station across tenants
-- (OS1), and their phone is the same phone in each. `tenant_id` is the tenant the device last
-- registered from (rewritten by every register); it scopes nothing the ring reads.
--  - platform: `android` | `ios` (contract AGENCY_PUSH_PLATFORMS; iOS is contract-only, IQ64).
--  - fcm_token (Android), voip_token (iOS PushKit): device addresses, not secrets. Plain text,
--    never served back by the routes, never logged.
--  - app_build: the app's `version+build` that last registered, for support.
--  - ring_enabled: the agent's opt-in for THIS device (IQ65), off until they turn it on.
--  - last_seen_at: the last register. revoked_at: removed by the agent, or its token reported
--    unregistered by the carrier (FCM UNREGISTERED, APNs 410); a register revives it.
--  - last_failure_at / last_failure_reason: the last failed send (contract
--    AGENCY_PUSH_FAILURE_REASONS), both or neither.
--  The user and tenant are foreign keys ON DELETE CASCADE: a device address is no record to keep
--  once its agent or tenant is gone (unlike the agency tables' actor columns).
--
-- ── agency_inbound_calls: the ring ────────────────────────────────────────────
--  - offer_channel: how the latest offer reached its agent (contract
--    AGENCY_INBOUND_OFFER_CHANNELS): `station` (Mode A) or `push` (the phone rung, IQ66). NULL
--    before any offer; a row offered before this migration's writers (WP5) keeps NULL, which
--    reads as `station`. Not backfilled: nothing reads it until those writers ship.
--  - ringing_at: when the latest ring started (the ring window, AGENCY_INBOUND_RING_MS, counts
--    from it). accepted_at: when that ring was answered (the accept grace counts from it).
--  - ring_result: how the latest ring ended (contract AGENCY_INBOUND_RING_RESULTS).
--  - ring_count: rings this call has had, across requeues (one phone at a time, IQ60).
--
-- ── agency_agent_sessions: the away break ─────────────────────────────────────
--  - ring_misses: missed rings in a row (IQ62); two move the agent `away_ring` → `device_away`.
--    Reset on an answered ring and on `available`.
--  - away_ring_since: when this absence on `away_ring` began, kept across a ring and the return to
--    `away_ring` after it (each of which rewrites state_since), so the reconcile can end it at the
--    maximum age after a restart (IQ67). The reconcile's key (N1): set while the session is on
--    `away_ring` or ringing from it, cleared on every real end (available, device_away, the
--    take-over, leaving).
--
-- ── CHECKs ────────────────────────────────────────────────────────────────────
--  - ck_agency_push_devices_platform, _device_id (non-blank), _tokens (a token, when set, is not
--    empty), _failure (both or neither, from the contract's list).
--  - ck_agency_inbound_calls_offer_channel, ck_agency_inbound_calls_ring_result: the contract's
--    lists (held equal by test/integration/db/inbound-ring-migration.test.ts).
--  - ck_agency_inbound_calls_ring: a `push` offer has its ringing_at; an answer only after a ring;
--    ring_count never negative.
--  - ck_agency_agent_sessions_ring_misses: never negative.
--
-- ── Indexes ───────────────────────────────────────────────────────────────────
--  - uq_agency_push_devices_user_device (user_id, device_id): one row per agent and device, the
--    register's upsert arbiter, and the ring's join from a session.
--  - uq_agency_push_devices_fcm_token / _voip_token, partial on live rows: one live row per push
--    address, so a phone reinstalled under a new device id cannot be rung twice (the register
--    revokes the older row).
--
-- ── Locking ───────────────────────────────────────────────────────────────────
-- A new table, and on agency_inbound_calls and agency_agent_sessions (both small) columns with no
-- default or a constant one (catalog-only) plus CHECKs validated by one scan each under this
-- file's ACCESS EXCLUSIVE. Migrations run at container start, before the server listens.
--
-- ── Down ──────────────────────────────────────────────────────────────────────
-- Drops the CHECKs, the columns and the table. Nothing an agent wrote is lost: devices
-- re-register on the next open, and the ring columns are the connector's own bookkeeping. A
-- session left with break_reason `away_ring` reads as an ordinary break to an older server.
--
-- Runs as one node-pg-migrate SQL migration in one transaction; split on the up/down marker
-- comments (see 0001_baseline.sql's header for the regex).

-- Up Migration

CREATE TABLE agency_push_devices (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id              UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- The app's station device id (OS3): client-generated and opaque, never an identity.
  device_id            VARCHAR(64) NOT NULL,
  platform             VARCHAR(8) NOT NULL,
  fcm_token            TEXT,
  voip_token           TEXT,
  app_build            VARCHAR(64) NOT NULL,
  ring_enabled         BOOLEAN NOT NULL DEFAULT false,
  last_seen_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at           TIMESTAMPTZ,
  last_failure_at      TIMESTAMPTZ,
  last_failure_reason  VARCHAR(16),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT uq_agency_push_devices_user_device UNIQUE (user_id, device_id),
  CONSTRAINT ck_agency_push_devices_platform CHECK (platform IN ('android', 'ios')),
  CONSTRAINT ck_agency_push_devices_device_id CHECK (btrim(device_id) <> ''),
  CONSTRAINT ck_agency_push_devices_tokens CHECK (
    (fcm_token IS NULL OR fcm_token <> '') AND (voip_token IS NULL OR voip_token <> '')
  ),
  CONSTRAINT ck_agency_push_devices_failure CHECK (
    (last_failure_at IS NULL) = (last_failure_reason IS NULL)
    AND (last_failure_reason IS NULL
         OR last_failure_reason IN ('unregistered', 'invalid', 'rate_limited', 'unavailable', 'unconfigured'))
  )
);

COMMENT ON TABLE agency_push_devices IS
  'Mode B (IQ58-IQ74): the agent app''s push devices, one per (agent, station device id). The device rung for a session is the one holding its station (station_device_id, IQ60). Tokens are device addresses: plain text, never served, never logged.';

CREATE UNIQUE INDEX uq_agency_push_devices_fcm_token
  ON agency_push_devices (fcm_token)
  WHERE fcm_token IS NOT NULL AND revoked_at IS NULL;

CREATE UNIQUE INDEX uq_agency_push_devices_voip_token
  ON agency_push_devices (voip_token)
  WHERE voip_token IS NOT NULL AND revoked_at IS NULL;

CREATE TRIGGER trg_agency_push_devices_updated_at
  BEFORE UPDATE ON agency_push_devices
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

ALTER TABLE agency_inbound_calls
  ADD COLUMN offer_channel  VARCHAR(8),
  ADD COLUMN ringing_at     TIMESTAMPTZ,
  ADD COLUMN accepted_at    TIMESTAMPTZ,
  ADD COLUMN ring_result    VARCHAR(24),
  ADD COLUMN ring_count     SMALLINT NOT NULL DEFAULT 0;

ALTER TABLE agency_inbound_calls
  ADD CONSTRAINT ck_agency_inbound_calls_offer_channel CHECK (
    offer_channel IS NULL OR offer_channel IN ('station', 'push')
  ),
  ADD CONSTRAINT ck_agency_inbound_calls_ring_result CHECK (
    ring_result IS NULL OR ring_result IN (
      'answered', 'declined', 'expired', 'accept_lapsed', 'busy_on_phone', 'push_failed', 'caller_left',
      'answered_elsewhere', 'cancelled')
  ),
  ADD CONSTRAINT ck_agency_inbound_calls_ring CHECK (
    (offer_channel IS DISTINCT FROM 'push' OR ringing_at IS NOT NULL)
    AND (accepted_at IS NULL OR ringing_at IS NOT NULL)
    AND ring_count >= 0
  );

COMMENT ON COLUMN agency_inbound_calls.offer_channel IS
  'IQ66: how the latest offer reached its agent: station (Mode A) or push (the away agent''s phone rung). NULL before any offer, or on an offer written before Mode B''s writers (a station offer).';
COMMENT ON COLUMN agency_inbound_calls.ringing_at IS
  'Mode B: when the latest ring started; the ring window (AGENCY_INBOUND_RING_MS) counts from it.';
COMMENT ON COLUMN agency_inbound_calls.accepted_at IS
  'Mode B: when the latest ring was answered; the accept grace (AGENCY_INBOUND_ACCEPT_GRACE_MS) counts from it.';
COMMENT ON COLUMN agency_inbound_calls.ring_result IS
  'Mode B: how the latest ring ended (contract AGENCY_INBOUND_RING_RESULTS).';
COMMENT ON COLUMN agency_inbound_calls.ring_count IS
  'Mode B: rings this call has had, across requeues.';

ALTER TABLE agency_agent_sessions
  ADD COLUMN ring_misses      SMALLINT NOT NULL DEFAULT 0,
  ADD COLUMN away_ring_since  TIMESTAMPTZ;

ALTER TABLE agency_agent_sessions
  ADD CONSTRAINT ck_agency_agent_sessions_ring_misses CHECK (ring_misses >= 0);

COMMENT ON COLUMN agency_agent_sessions.ring_misses IS
  'IQ62: missed rings in a row; AGENCY_INBOUND_RING_MAX_MISSES of them move away_ring to device_away. Reset on an answered ring and on available.';
COMMENT ON COLUMN agency_agent_sessions.away_ring_since IS
  'IQ67, N1: when this absence on away_ring began, kept across rings (which rewrite state_since). The reconcile''s key: set while on away_ring or ringing from it, cleared on every real end.';

-- Down Migration

ALTER TABLE agency_agent_sessions
  DROP CONSTRAINT IF EXISTS ck_agency_agent_sessions_ring_misses,
  DROP COLUMN IF EXISTS away_ring_since,
  DROP COLUMN IF EXISTS ring_misses;

ALTER TABLE agency_inbound_calls
  DROP CONSTRAINT IF EXISTS ck_agency_inbound_calls_ring,
  DROP CONSTRAINT IF EXISTS ck_agency_inbound_calls_ring_result,
  DROP CONSTRAINT IF EXISTS ck_agency_inbound_calls_offer_channel,
  DROP COLUMN IF EXISTS ring_count,
  DROP COLUMN IF EXISTS ring_result,
  DROP COLUMN IF EXISTS accepted_at,
  DROP COLUMN IF EXISTS ringing_at,
  DROP COLUMN IF EXISTS offer_channel;

DROP TABLE IF EXISTS agency_push_devices;
