import Fastify, { type FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import Redis from 'ioredis';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { getTestPool } from '../setup/test-utils.js';
import { TEST_REDIS_URL } from '../../helpers/test-redis.js';
import { insertAgencyCampaign } from '../agency/agency-factories.js';
import { ScriptedBridge } from '../agency/chaos/harness.js';
import { StationFleet, type FleetAgent } from '../../mocks/station-fleet.js';
import { createRng, type Rng } from '../../helpers/load-scale.js';

/**
 * ─── THE FULL-FLOOR WORLD: REAL POSTGRES, REAL REDIS, REAL ROUTES ───────────
 *
 * One process holding what production holds for the station path, with only the
 * carrier faked:
 *
 *  - the real `AgencyRuntime` (registry, token store, agent state machine,
 *    dialer, wrap-up, pacing engine, sweep) over this worktree's test Redis and
 *    real Postgres;
 *  - the real HTTP handlers (`agencyRoutes`, the internal handler instance's
 *    session and attempt routes, behind their header-only `authMiddleware`) for
 *    join, token re-mint, available, break and disposition — so every agent action
 *    the fleet takes is the request the console makes;
 *  - the real station route (`proxyAgencyStationRoutes` → `handleStationSocket`) on
 *    a real listening port, reached by a {@link StationFleet} of real `ws` clients
 *    authenticating with tokens minted by `POST /sessions/:id/station-token`;
 *  - `ScriptedBridge` from the chaos harness in place of the carrier, so a pacing
 *    tick's dials answer, bridge and end on a queue the test drains (`tick()`),
 *    never on a wall-clock timer.
 *
 * The pacing supervisor's own interval is never started: ticks are driven, as the
 * chaos suites drive them, so a run is reproducible from the seed.
 *
 * Import after the caller's `vi.mock` calls (pool, config, logger): `src/` is
 * loaded dynamically inside {@link createFloorWorld}.
 */

/** This file's own key prefix inside the worktree's test Redis db. */
export const KEY_PREFIX = 'loadst:';

export interface FloorTenant {
  tenantId: string;
  accountId: string;
  campaignId: string;
  breakReason: string;
}

export interface FloorWorldOptions {
  tenants: number;
  agentsPerTenant: number;
  contactsPerCampaign: number;
  campaign?: Record<string, unknown>;
  heartbeatMs: number;
  rng?: Rng;
}

export interface FloorWorld {
  app: FastifyInstance;
  redis: Redis;
  bridge: ScriptedBridge;
  runtime: import('../../../src/agency/runtime.js').AgencyRuntime;
  fleet: StationFleet;
  rng: Rng;
  tenants: FloorTenant[];
  /** The tenant an agent belongs to. */
  tenantOf(agent: FleetAgent): FloorTenant;
  post(path: string, tenant: FloorTenant, body?: Record<string, unknown>): Promise<{ statusCode: number; json: () => any }>;
  /** One pacing pass for every campaign, then drain the scripted carrier. */
  tickAll(): Promise<void>;
  /** Every key in this world's keyspace, unprefixed and sorted. */
  keys(pattern?: string): Promise<string[]>;
  teardown(): Promise<void>;
}

export async function createFloorWorld(opts: FloorWorldOptions): Promise<FloorWorld> {
  const { AgencyRuntime } = await import('../../../src/agency/runtime.js');
  const { agencyRoutes } = await import('../../../src/api/routes/agency.routes.js');
  const { proxyAgencyStationRoutes } = await import('../../../src/api/routes/proxy-agency-station.routes.js');

  const rng = opts.rng ?? createRng();
  const redis = new Redis(TEST_REDIS_URL, { keyPrefix: KEY_PREFIX, maxRetriesPerRequest: 3 });
  await redis.flushdb();

  const bridge = new ScriptedBridge();
  const runtime = new AgencyRuntime(bridge as never, redis, '');
  runtime.dialer.start();

  const pool = getTestPool();
  const tenants: FloorTenant[] = [];
  for (let t = 0; t < opts.tenants; t++) {
    const tenantId = randomUUID();
    const accountId = randomUUID();
    const campaign = await insertAgencyCampaign({
      tenant_id: tenantId, account_id: accountId, status: 'running', ...opts.campaign,
    });
    await pool.query(
      `INSERT INTO account_settings (tenant_id, account_id, max_concurrent_calls) VALUES ($1, $2, $3)`,
      [tenantId, accountId, opts.agentsPerTenant],
    );
    // A real override row against the real flag service: the join route's gate.
    await pool.query(
      `INSERT INTO feature_flag_overrides (flag_key, scope_type, tenant_id, account_id, value)
       VALUES ('agency_dialer_enabled', 'account', $1, $2, 'true'::jsonb)`,
      [tenantId, accountId],
    );
    // One statement for the whole roster: a floor's worth of row-by-row inserts
    // would be most of this file's runtime.
    await pool.query(
      `INSERT INTO agency_contacts (id, campaign_id, tenant_id, account_id, phone_e164, context, state, source_row_number)
       SELECT gen_random_uuid(), $1, $2, $3, '+9197' || lpad(($5 * 1000000 + g)::text, 8, '0'),
              '{"name":"Load Person"}'::jsonb, 'pending', g
         FROM generate_series(1, $4::int) AS g`,
      [campaign.id, tenantId, accountId, opts.contactsPerCampaign, t],
    );
    const reasons = (campaign.break_reasons ?? null) as Array<{ code: string }> | null;
    tenants.push({ tenantId, accountId, campaignId: campaign.id as string, breakReason: reasons?.[0]?.code ?? '' });
  }

  const app = Fastify({ logger: false });
  await app.register(websocket);
  await app.register(async (scope) => agencyRoutes(scope, runtime), { prefix: '/api/v1/agency' });
  await app.register(proxyAgencyStationRoutes, { prefix: '/proxy/agency/station', getRuntime: () => runtime });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const { port } = app.server.address() as AddressInfo;

  async function post(path: string, tenant: FloorTenant, body?: Record<string, unknown>) {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/agency${path}`,
      headers: {
        'x-mgkvc-tenant': tenant.tenantId,
        'x-mgkvc-account': tenant.accountId,
        // Only with a body: an empty JSON body is a 400 before any handler runs.
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
    });
    return { statusCode: res.statusCode, json: () => res.json() };
  }

  const tenantBySession = new Map<string, FloorTenant>();
  const tenantOf = (a: FleetAgent): FloorTenant => tenantBySession.get(a.sessionId)!;

  const fleet = new StationFleet({
    origin: `ws://127.0.0.1:${port}`,
    heartbeatMs: opts.heartbeatMs,
    rng,
    // The console's reconnect path: re-mint over authenticated HTTP.
    mintToken: async (a) => {
      const res = await post(`/sessions/${a.sessionId}/station-token`, tenantOf(a), { agent_user_id: a.agentUserId });
      if (res.statusCode !== 200) throw new Error(`station-token for ${a.label}: ${res.statusCode}`);
      const url = new URL(res.json().station_ws_url as string, 'http://x');
      return url.searchParams.get('token')!;
    },
    actions: {
      available: async (a) => (await post(`/sessions/${a.sessionId}/available`, tenantOf(a), { agent_user_id: a.agentUserId })).statusCode,
      break: async (a, reason) => (await post(`/sessions/${a.sessionId}/break`, tenantOf(a), { agent_user_id: a.agentUserId, reason })).statusCode,
      disposition: async (a, attemptId, code) =>
        (await post(`/attempts/${attemptId}/disposition`, tenantOf(a), { agent_user_id: a.agentUserId, disposition_code: code })).statusCode,
    },
  });

  // ── The join storm: every agent joins over HTTP at once ──────────────────
  const joins = tenants.flatMap((tenant, t) => Array.from({ length: opts.agentsPerTenant }, (_, i) => ({ tenant, label: `t${t}-agent-${i}` })));
  const joined = await Promise.all(joins.map(async ({ tenant, label }) => {
    const agentUserId = randomUUID();
    const res = await post('/sessions', tenant, { campaign_id: tenant.campaignId, agent_user_id: agentUserId });
    if (res.statusCode !== 201) throw new Error(`join ${label}: ${res.statusCode} ${JSON.stringify(res.json())}`);
    const bootstrap = res.json();
    // The catalog the bootstrap advertises is the one the break route validates.
    if (!tenant.breakReason) tenant.breakReason = bootstrap.break_reasons?.[0]?.code ?? '';
    return { tenant, label, agentUserId, sessionId: bootstrap.session_id as string };
  }));
  for (const j of joined) {
    tenantBySession.set(j.sessionId, j.tenant);
    fleet.add({
      sessionId: j.sessionId, tenantId: j.tenant.tenantId, accountId: j.tenant.accountId,
      campaignId: j.tenant.campaignId, agentUserId: j.agentUserId, label: j.label,
    });
  }

  return {
    app, redis, bridge, runtime, fleet, rng, tenants, tenantOf, post,
    async tickAll() {
      for (const t of tenants) await runtime.pacing.tickOnce(t.campaignId);
      await bridge.flush();
    },
    async keys(pattern = 'agency:*') {
      const raw = await redis.keys(`${KEY_PREFIX}${pattern}`);
      return raw.map((k) => k.slice(KEY_PREFIX.length)).sort();
    },
    async teardown() {
      await fleet.closeAll().catch(() => { /* the leak checks report what is left */ });
      // Let the close handlers' Redis/DB writes land before anything is torn down.
      await fleet.waitFor(() => runtime.stations.size() === 0, 'registry to drain at teardown').catch(() => {});
      runtime.stopStationSweep();
      runtime.wrapup.stop();
      runtime.dialer.stop();
      runtime.reaper.stop();
      await runtime.pacing.stop().catch(() => { /* never started */ });
      await app.close();
      await redis.flushdb().catch(() => {});
      redis.disconnect();
    },
  };
}

/** `agency_agent_sessions` rows for these sessions, by id. */
export async function sessionRows(ids: readonly string[]): Promise<Map<string, { state: string; left_at: Date | null; campaign_id: string; tenant_id: string }>> {
  const { rows } = await getTestPool().query(
    `SELECT id, state, left_at, campaign_id, tenant_id FROM agency_agent_sessions WHERE id = ANY($1::uuid[])`,
    [ids],
  );
  return new Map(rows.map((r) => [r.id as string, r]));
}
