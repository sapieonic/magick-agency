import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * ─── The morning rush: a full floor signs in at once ────────────────────────────
 *
 * Every agent of every tenant (default 3 × 30, `LOAD_SCALE` multiplies) does what a console
 * does at shift start, all at the same moment, while each tenant's supervisors staff the
 * floor and then poll the dashboard:
 *
 *   sign in (`POST /auth/session`, first-timers from TWO tabs at once, adopting their invite
 *   stub) → `/auth/me` → `my-assignment` → join (`POST /sessions`) → open the station socket →
 *   go available → poll `my-stats`, `my-attempts`, `my-campaigns`, `my-assignments`.
 *
 * Through the real app, the production pool size (`DB_POOL_MAX` default) and the production
 * rate-limit ceilings, each browser on its own client address.
 *
 * What it pins:
 *  1. Every request succeeds with the agent's OWN result (their session, their campaign,
 *     their identity) and no 5xx anywhere.
 *  2. **Tenant isolation under concurrency**: no response body — not one — carries an id
 *     owned by another tenant (tenant, account, campaign or person), including the answers
 *     to a seeded fifth of the floor trying another tenant's campaign on the way in and the
 *     supervisors reading another tenant's dashboard. Mutation-checked: dropping the
 *     tenant/account check on the internal join (`sessions.ts`) reds cases 2 and 3.
 *  3. Postgres afterwards: exactly one live session per agent, on their tenant's campaign
 *     and account, `available` in the row and in Redis; the transition log holds exactly
 *     join + available per agent; the audit trail holds exactly one `agency_session.joined`
 *     and one `agency_campaign_agent.assigned` per agent; invite stubs adopted once each.
 *  4. The floor leaves concurrently and nothing live is left behind (no orphaned session,
 *     no lease in Redis).
 */

const mocks = vi.hoisted(() => ({ verifyIdToken: vi.fn() }));
vi.mock('../../../src/auth/firebase.js', () => ({ initFirebase: vi.fn(), verifyIdToken: mocks.verifyIdToken }));

import type { LightMyRequestResponse } from 'fastify';
import { getTestPool, truncateAll } from '../../../../../packages/db/test/helpers/test-db.js';
import { createRng, scaled } from '../../helpers/load-scale.js';
import { getAgencyRuntime } from '../../../src/bootstrap/agency.js';
import {
  call, closeStation, deadlockCount, drainAudits, expectHealthy, foreignIdsIn, foreignIdsOf, mapLimit, openStation,
  scalar, seedFloor, startLoadApp, stopLoadApp, verifyTestToken,
  type Actor, type LoadApp, type StationSocket, type TenantFloor,
} from './load-harness.js';

const TENANTS = 3;
const AGENTS = scaled(30);
const SUPERVISORS = 2;
const rng = createRng();
/** The performance surfaces' required window: the last week. */
const WINDOW = `from=${new Date(Date.now() - 7 * 86_400_000).toISOString()}&to=${new Date(Date.now() + 86_400_000).toISOString()}`;

let loaded: LoadApp;
let floors: TenantFloor[];
/** Agents whose user row is an invite stub until their first sign-in. */
const firstTimers = new Set<string>();
const sessions = new Map<string, string>(); // agent id → session id
const sockets: StationSocket[] = [];
let deadlocksBefore = 0;

/** Every response of the run, with who made it, for the isolation sweep. */
const seen: Array<{ floor: TenantFloor; label: string; res: LightMyRequestResponse }> = [];
function record(floor: TenantFloor, label: string, res: LightMyRequestResponse): LightMyRequestResponse {
  seen.push({ floor, label, res });
  expectHealthy(res, label);
  return res;
}

beforeAll(async () => {
  console.log(`[floor-morning-rush] seed=${rng.seed} tenants=${TENANTS} agents/tenant=${AGENTS}`);
  mocks.verifyIdToken.mockImplementation(verifyTestToken);
  loaded = await startLoadApp();
  await truncateAll();
  floors = await seedFloor({ tenants: TENANTS, agentsPerTenant: AGENTS, supervisorsPerTenant: SUPERVISORS });
  // A seeded half of each floor was invited and has never signed in: their row carries
  // the pending stub uid until `POST /auth/session` adopts the Firebase identity.
  const stubs = floors.flatMap((f) => f.agents.filter(() => rng.chance(0.5)));
  for (const a of stubs) firstTimers.add(a.id);
  await getTestPool().query(`UPDATE users SET firebase_uid = 'pending_' || id WHERE id = ANY($1::uuid[])`, [[...firstTimers]]);
  deadlocksBefore = await deadlockCount();
}, 60_000);

afterAll(async () => {
  for (const ws of sockets) await closeStation(ws).catch(() => undefined);
  await stopLoadApp(loaded);
});

const app = () => loaded.app;
const floorOf = (a: Actor) => floors.find((f) => f.agents.includes(a) || f.supervisors.includes(a))!;
const allAgents = () => rng.shuffle(floors.flatMap((f) => f.agents));

describe('the morning rush, a full floor at once (integration, load)', () => {
  it('1. supervisors staff the floor concurrently: one assignment per agent, every one audited once', async () => {
    // Each tenant's supervisors split their agents and assign them all at once.
    const work = floors.flatMap((f) => f.agents.map((a, i) => ({ f, a, sup: f.supervisors[i % SUPERVISORS]! })));
    const results = await Promise.all(rng.shuffle(work).map(({ f, a, sup }) =>
      call(app(), 'POST', `/proxy/agency/campaigns/${f.campaigns[0]}/agents`, sup, f, { user_id: a.id })
        .then((res) => record(f, `assign ${a.id}`, res))));
    for (const res of results) expect(res.statusCode, res.body).toBe(201);
    expect(await scalar('SELECT count(*)::int AS n FROM agency_campaign_agents WHERE unassigned_at IS NULL'))
      .toBe(TENANTS * AGENTS);
  });

  it('2. every agent signs in, joins, opens the station and goes available at once; every answer is their own', async () => {
    const started = Date.now();
    await Promise.all(allAgents().map(async (agent) => {
      const f = floorOf(agent);
      const label = (s: string) => `${s} (${agent.id})`;

      // Sign-in. A first-timer's console signs in from two tabs at once.
      const tabs = firstTimers.has(agent.id) ? 2 : 1;
      const signIns = await Promise.all(Array.from({ length: tabs }, () =>
        app().inject({
          method: 'POST', url: '/auth/session',
          headers: { 'content-type': 'application/json', 'x-forwarded-for': agent.ip },
          payload: JSON.stringify({ id_token: agent.tok }),
        }).then((res) => record(f, label('sign-in'), res))));
      for (const res of signIns) {
        expect(res.statusCode, res.body).toBe(200);
        const body = res.json();
        expect(body.user.id).toBe(agent.id);
        expect(body.memberships.map((m: { tenant_id: string }) => m.tenant_id)).toEqual([f.tenant]);
        expect(body.tenants.map((t: { id: string }) => t.id)).toEqual([f.tenant]);
      }

      const me = record(f, label('me'), await call(app(), 'GET', '/auth/me', agent, f));
      expect(me.statusCode, me.body).toBe(200);

      const assignment = record(f, label('my-assignment'), await call(app(), 'GET', '/proxy/agency/my-assignment', agent, f));
      expect(assignment.statusCode, assignment.body).toBe(200);
      expect(assignment.json().campaign_id).toBe(f.campaigns[0]);

      // A seeded fifth of the floor is hostile on the way in: it tries another tenant's
      // campaign first, exactly as a crafted request would. A 404, and no data.
      if (rng.chance(0.2)) {
        const other = floors[(f.index + 1) % floors.length]!;
        const probe = record(f, label('foreign join'), await call(app(), 'POST', '/proxy/agency/sessions', agent, f, { campaign_id: other.campaigns[0] }));
        expect(probe.statusCode, probe.body).toBe(404);
      }

      const join = record(f, label('join'), await call(app(), 'POST', '/proxy/agency/sessions', agent, f, { campaign_id: f.campaigns[0] }));
      expect(join.statusCode, join.body).toBe(201);
      const boot = join.json();
      expect(boot).toMatchObject({ campaign_id: f.campaigns[0], agent_user_id: agent.id });
      sessions.set(agent.id, boot.session_id);

      sockets.push(await openStation(app(), boot.station_ws_url, agent.ip));

      const ready = record(f, label('available'), await call(app(), 'POST', `/proxy/agency/sessions/${boot.session_id}/available`, agent, f, {}));
      expect(ready.statusCode, ready.body).toBe(200);
      expect(ready.json()).toMatchObject({ session_id: boot.session_id, state: 'available' });

      for (const surface of [`my-stats?${WINDOW}`, `my-attempts?${WINDOW}`, 'my-campaigns', 'my-assignments']) {
        const res = record(f, label(surface), await call(app(), 'GET', `/proxy/agency/${surface}`, agent, f));
        expect(res.statusCode, `${surface}: ${res.body}`).toBe(200);
      }
    }).concat(
      // The supervisors watch the dashboard fill while the floor joins.
      floors.flatMap((f) => f.supervisors.map(async (sup) => {
        const other = floors[(f.index + 1) % floors.length]!;
        for (const url of [`/proxy/agency/campaigns/${other.campaigns[0]}/stats`, `/proxy/agency/campaigns/${other.campaigns[0]}/agents`]) {
          const probe = record(f, `supervisor foreign ${url}`, await call(app(), 'GET', url, sup, f));
          expect(probe.statusCode, `${url}: ${probe.body}`).toBe(404);
        }
        for (let i = 0; i < 8; i++) {
          for (const url of [`/proxy/agency/campaigns/${f.campaigns[0]}/stats`, `/proxy/agency/campaigns/${f.campaigns[0]}/agents`, '/proxy/agency/campaigns']) {
            const res = record(f, `supervisor ${url}`, await call(app(), 'GET', url, sup, f));
            expect(res.statusCode, `${url}: ${res.body}`).toBe(200);
          }
        }
      })),
    ));
    // A deadlock bound, not a speed budget: the whole rush must finish.
    expect(Date.now() - started).toBeLessThan(55_000);
  }, 60_000);

  it('3. no response of the whole rush carries another tenant\'s data', () => {
    const leaks: string[] = [];
    for (const { floor, label, res } of seen) {
      const foreign = foreignIdsIn(res.body, foreignIdsOf(floors, floor));
      if (foreign.length > 0) leaks.push(`${label}: ${foreign.join(', ')}`);
    }
    expect(leaks).toEqual([]);
    // And the sweep covered the whole rush, not a prefix of it.
    expect(seen.length).toBeGreaterThan(TENANTS * AGENTS * 8);
  });

  it('4. Postgres and Redis agree: one live available session per agent, logged and audited exactly once', async () => {
    const { rows } = await getTestPool().query<{
      agent_user_id: string; tenant_id: string; account_id: string; campaign_id: string; state: string; id: string;
    }>('SELECT id, agent_user_id, tenant_id, account_id, campaign_id, state FROM agency_agent_sessions WHERE left_at IS NULL');
    expect(rows).toHaveLength(TENANTS * AGENTS);
    const runtime = getAgencyRuntime()!;
    for (const f of floors) {
      for (const a of f.agents) {
        const row = rows.find((r) => r.agent_user_id === a.id);
        expect(row, `${a.id}: ${JSON.stringify(row)} want ${sessions.get(a.id)}`).toMatchObject({ id: sessions.get(a.id), tenant_id: f.tenant, account_id: f.account, campaign_id: f.campaigns[0], state: 'available' });
        expect((await runtime.agents.get(row!.id))?.state).toBe('available');
      }
    }
    // join (NULL → break) and break → available, nothing else.
    expect(await scalar(`SELECT count(*)::int AS n FROM agency_agent_session_events WHERE from_state IS NULL AND to_state = 'break'`)).toBe(TENANTS * AGENTS);
    expect(await scalar(`SELECT count(*)::int AS n FROM agency_agent_session_events WHERE from_state = 'break' AND to_state = 'available'`)).toBe(TENANTS * AGENTS);
    expect(await scalar('SELECT count(*)::int AS n FROM agency_agent_session_events')).toBe(2 * TENANTS * AGENTS);

    // Every first-timer's stub was adopted (once: one row, the Firebase uid), however many tabs raced.
    expect(await scalar(`SELECT count(*)::int AS n FROM users WHERE firebase_uid LIKE 'pending\\_%'`)).toBe(0);
    expect(await scalar('SELECT count(*)::int AS n FROM users')).toBe(TENANTS * (AGENTS + SUPERVISORS));

    await drainAudits();
    for (const f of floors) {
      const audited = await getTestPool().query<{ action: string; n: number }>(
        `SELECT action, count(*)::int AS n FROM platform_audit_log WHERE tenant_id = $1 GROUP BY action ORDER BY action`, [f.tenant]);
      expect(audited.rows).toEqual([
        { action: 'agency_campaign_agent.assigned', n: AGENTS },
        { action: 'agency_session.joined', n: AGENTS },
      ]);
      // Each joined row names its own session, on its own campaign.
      expect(await scalar(
        `SELECT count(DISTINCT resource_id)::int AS n FROM platform_audit_log
          WHERE tenant_id = $1 AND action = 'agency_session.joined' AND campaign_id = $2`, [f.tenant, f.campaigns[0]])).toBe(AGENTS);
    }
    expect(await deadlockCount()).toBe(deadlocksBefore);
  });

  it('5. the floor leaves at once: every leave lands, nothing live is left behind', async () => {
    const results = await mapLimit(allAgents(), 200, async (agent) => {
      const f = floorOf(agent);
      return record(f, `leave ${agent.id}`, await call(app(), 'POST', `/proxy/agency/sessions/${sessions.get(agent.id)}/leave`, agent, f, {}));
    });
    for (const res of results) expect(res.statusCode, res.body).toBe(200);
    for (const ws of sockets.splice(0)) await closeStation(ws);
    expect(await scalar('SELECT count(*)::int AS n FROM agency_agent_sessions WHERE left_at IS NULL')).toBe(0);
    const runtime = getAgencyRuntime()!;
    for (const id of sessions.values()) expect(await runtime.agents.get(id)).toBeNull();
    expect(await deadlockCount()).toBe(deadlocksBefore);
  });
});
