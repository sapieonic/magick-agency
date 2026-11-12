-- 0035_one_station_per_agent.sql — an agent holds one live station, on one device, across every
-- tenant (decisions OS1–OS6, docs/decisions.md §"One station per agent").
--
-- ── One live session per agent, not per (tenant, agent) ───────────────────────
-- uq_agency_agent_live_tenant allowed an agent who belongs to two tenants one live session in
-- each: two independently reservable agents attached to one pair of ears, the case the per-tenant
-- index already refused within one tenant. uq_agency_agent_live_agent, keyed on the agent alone
-- (WHERE left_at IS NULL), is the join upsert's new arbiter (`upsertLiveSession`). A join refused
-- by a live session in ANOTHER tenant answers `session_in_other_tenant` (OS2).
--
-- uq_agency_agent_live_tenant is KEPT, redundant but harmless (every row it admits the new index
-- also judges): the server image before this migration names it as its ON CONFLICT arbiter, and
-- Postgres refuses an arbiter no index matches, so dropping it would make an image-only rollback
-- answer 500 on every join until `migrate down` ran. A later migration drops it once no image
-- that names it can be deployed.
--
-- Rows that would break the new index (an agent live in two tenants when this runs) are ended
-- before it is built: every live session of such an agent except the one with the newest
-- heartbeat (ties: newest join, then id) is left (`state = 'offline'`, `left_at = now()`), as
-- `leave` would, with the transition logged for one that was not already offline, so occupancy
-- does not run on. Migrations run at container start, before the server listens and after the
-- previous process has gone, so no station is attached to any session then and the startup reaper
-- would mark every one offline anyway: the media of any call on such a session is already gone.
-- Unlike `leave`, nothing here checks for an unsettled soft-phone or inbound call on the ended
-- session; its outcome is then closed by the lapse sweeps, as for any session that left with one
-- owed. Only an agent live in two tenants at that moment is affected.
--
-- ── The device that holds the station ─────────────────────────────────────────
-- `station_device_id` (OS3): the id of the device (one console tab, one phone install) the
-- session's station belongs to. Set by the join, the soft-phone open and the station-token mint
-- that the client sends a `device_id` on; a mint or join from ANOTHER device is refused
-- `station_on_other_device` unless it asks to take the station over (`take_over`), so a device that
-- lost its socket can never reconnect onto a station the agent moved elsewhere. NULL: no device
-- known (a session from before this migration, or a client that sends none), and then any device
-- may claim it. Client-generated and opaque; never an identity or a security input (the session is
-- still the authenticated agent's own, Q8).
--
-- ── Locking ───────────────────────────────────────────────────────────────────
-- A plain CREATE UNIQUE INDEX and an ADD COLUMN with no default: agency_agent_sessions holds one
-- row per join (small), and migrations run at container start, before the server listens.
--
-- Runs as one node-pg-migrate SQL migration in one transaction; split on the up/down marker
-- comments (see 0001_baseline.sql's header for the regex).

-- Up Migration

WITH ranked AS (
  SELECT id, state, row_number() OVER (
           PARTITION BY agent_user_id
           ORDER BY last_heartbeat DESC NULLS LAST, joined_at DESC, id DESC) AS rank
    FROM agency_agent_sessions
   WHERE left_at IS NULL
), ended AS (
  UPDATE agency_agent_sessions s
     SET state = 'offline', left_at = now(), updated_at = now()
    FROM ranked
   WHERE s.id = ranked.id AND ranked.rank > 1
  RETURNING s.id, s.tenant_id, s.account_id, s.campaign_id, s.agent_user_id, ranked.state AS from_state
)
INSERT INTO agency_agent_session_events
  (session_id, tenant_id, account_id, campaign_id, agent_user_id, from_state, to_state, at)
SELECT id, tenant_id, account_id, campaign_id, agent_user_id, from_state, 'offline', now()
  FROM ended
 WHERE from_state IS DISTINCT FROM 'offline';

CREATE UNIQUE INDEX uq_agency_agent_live_agent
  ON agency_agent_sessions (agent_user_id)
  WHERE left_at IS NULL;

COMMENT ON INDEX uq_agency_agent_live_agent IS
  'One live session per agent across every tenant (OS1): the reservation CAS key is per SESSION, so two live sessions for one human, in one tenant or two, are two independently reservable agents and one pair of ears.';

ALTER TABLE agency_agent_sessions
  ADD COLUMN station_device_id VARCHAR(64);

COMMENT ON COLUMN agency_agent_sessions.station_device_id IS
  'OS3: the client-generated id of the device (console tab, phone install) this session''s station belongs to. A join or token mint from another device is refused unless it takes the station over. NULL: none known, any device may claim it. Opaque; never an identity.';

-- Down Migration

ALTER TABLE agency_agent_sessions
  DROP COLUMN IF EXISTS station_device_id;

DROP INDEX IF EXISTS uq_agency_agent_live_agent;

-- uq_agency_agent_live_tenant was kept by the up; created only if something dropped it since
-- (always buildable: one live row per agent implies one per (tenant, agent)).
CREATE UNIQUE INDEX IF NOT EXISTS uq_agency_agent_live_tenant
  ON agency_agent_sessions (tenant_id, agent_user_id)
  WHERE left_at IS NULL;
