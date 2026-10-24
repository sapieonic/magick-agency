import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ─── One agent, many joins at once ──────────────────────────────────────────────
 *
 * The join (`POST /proxy/agency/sessions`) is one `INSERT … ON CONFLICT` on the agent's one
 * live session per tenant (`uq_agency_agent_live_tenant`): a double-click, two console
 * tabs, a reconnect racing a fresh join. This suite fires those races through the real
 * route, many agents at once, and checks the answers and the rows.
 *
 * What it pins:
 *  1. K joins of the SAME campaign at once are one session: every answer is a 201 with the
 *     same `session_id`, and Postgres holds one live row with ONE first transition. This
 *     case found a defect: each racing loser logged its own `NULL → break` "session
 *     started" event (its `prev` CTE snapshot predates the winner's insert), ~1.8 per
 *     session at K = 6. Fixed in `joinOrRehydrate`; reverting that reds case 1.
 *  2. K joins of K DIFFERENT campaigns at once: exactly one wins (201); every other answer is
 *     the documented `409 session_on_other_campaign` naming the WINNER's campaign and name.
 *     Postgres holds one live row, on that campaign. Run for a whole floor at once.
 *     Mutation-checked: making the upsert's `DO UPDATE` unconditional (dropping
 *     `WHERE campaign_id = EXCLUDED.campaign_id`, `agent-session.repository.ts`) reds it.
 *  3. Join / leave flapping from several tabs at once never 5xxs, never leaves two live
 *     sessions, and every answer is one of the documented ones.
 *  4. Every accepted join is audited once, and only accepted ones are.
 */

const mocks = vi.hoisted(() => ({ verifyIdToken: vi.fn() }));
vi.mock('../../../src/auth/firebase.js', () => ({ initFirebase: vi.fn(), verifyIdToken: mocks.verifyIdToken }));

import { getTestPool, truncateAll } from '../../../../../packages/db/test/helpers/test-db.js';
import { createRng, scaled } from '../../helpers/load-scale.js';
import {
  call, drainAudits, expectHealthy, scalar, seedFloor, startLoadApp, stopLoadApp, verifyTestToken,
  type LoadApp, type TenantFloor,
} from './load-harness.js';

const AGENTS = scaled(40);
const K = 6;
const rng = createRng();

let loaded: LoadApp;
let floor: TenantFloor;
const app = () => loaded.app;

beforeAll(async () => {
  console.log(`[session-join-races] seed=${rng.seed} agents=${AGENTS} k=${K}`);
  mocks.verifyIdToken.mockImplementation(verifyTestToken);
  loaded = await startLoadApp();
});

beforeEach(async () => {
  await truncateAll();
  floor = (await seedFloor({ tenants: 1, agentsPerTenant: AGENTS, campaignsPerTenant: K }))[0]!;
});

afterAll(async () => {
  await stopLoadApp(loaded);
});

const join = (agent: TenantFloor['agents'][number], campaign: string) =>
  call(app(), 'POST', '/proxy/agency/sessions', agent, floor, { campaign_id: campaign });

async function liveRows(agentId: string) {
  const { rows } = await getTestPool().query<{ id: string; campaign_id: string }>(
    'SELECT id, campaign_id FROM agency_agent_sessions WHERE agent_user_id = $1 AND left_at IS NULL', [agentId]);
  return rows;
}

async function auditedJoins(): Promise<number> {
  await drainAudits();
  return scalar(`SELECT count(*)::int AS n FROM platform_audit_log WHERE action = 'agency_session.joined'`);
}

describe('concurrent session joins for one agent (integration, load)', () => {
  it('1. K joins of the same campaign at once are ONE session, for every agent of the floor at once', async () => {
    const results = await Promise.all(floor.agents.map(async (agent) => {
      const answers = await Promise.all(Array.from({ length: K }, () => join(agent, floor.campaigns[0]!)));
      return { agent, answers };
    }));
    for (const { agent, answers } of results) {
      for (const res of answers) {
        expectHealthy(res, `join ${agent.id}`);
        expect(res.statusCode, res.body).toBe(201);
      }
      const ids = new Set(answers.map((r) => r.json().session_id as string));
      expect(ids.size, `${agent.id} got ${[...ids].join(', ')}`).toBe(1);
      const rows = await liveRows(agent.id);
      expect(rows).toEqual([{ id: [...ids][0], campaign_id: floor.campaigns[0] }]);
    }
    expect(await scalar('SELECT count(*)::int AS n FROM agency_agent_sessions')).toBe(AGENTS);
    // One first transition per session, however many joins raced it.
    expect(await scalar('SELECT count(*)::int AS n FROM agency_agent_session_events WHERE from_state IS NULL')).toBe(AGENTS);
    expect(await auditedJoins()).toBe(AGENTS * K);
  });

  it('2. K joins of K different campaigns at once: one 201, the rest 409 naming the winner — for the whole floor at once', async () => {
    const { rows: names } = await getTestPool().query<{ id: string; name: string }>('SELECT id, name FROM agency_campaigns');
    const nameOf = new Map(names.map((r) => [r.id, r.name]));
    const results = await Promise.all(floor.agents.map(async (agent) => {
      const order = rng.shuffle(floor.campaigns);
      const answers = await Promise.all(order.map((c) => join(agent, c).then((res) => ({ c, res }))));
      return { agent, answers };
    }));
    let accepted = 0;
    for (const { agent, answers } of results) {
      for (const { res } of answers) expectHealthy(res, `join ${agent.id}`);
      const winners = answers.filter(({ res }) => res.statusCode === 201);
      expect(winners, `${agent.id}: ${answers.map(({ res }) => res.statusCode).join(',')}`).toHaveLength(1);
      accepted++;
      const won = winners[0]!;
      const sessionId = won.res.json().session_id as string;
      expect(won.res.json().campaign_id).toBe(won.c);
      for (const { c, res } of answers) {
        if (c === won.c) continue;
        expect(res.statusCode, res.body).toBe(409);
        expect(res.json()).toMatchObject({
          code: 'session_on_other_campaign', campaign_id: won.c, campaign_name: nameOf.get(won.c),
        });
      }
      expect(await liveRows(agent.id)).toEqual([{ id: sessionId, campaign_id: won.c }]);
    }
    expect(accepted).toBe(AGENTS);
    expect(await scalar('SELECT count(*)::int AS n FROM agency_agent_sessions')).toBe(AGENTS);
    expect(await auditedJoins()).toBe(AGENTS);
  });

  it('3. join / leave flapping from several tabs never 5xxs and never leaves two live sessions', async () => {
    const KNOWN_409 = new Set(['session_on_other_campaign', 'session_ended', 'agent_on_live_call']);
    let joined201 = 0;
    await Promise.all(floor.agents.map(async (agent) => {
      const first = await join(agent, floor.campaigns[0]!);
      expect(first.statusCode, first.body).toBe(201);
      joined201++;
      const sessionId = first.json().session_id as string;
      const leave = () => call(app(), 'POST', `/proxy/agency/sessions/${sessionId}/leave`, agent, floor, {});
      const burst = rng.shuffle([
        () => leave(), () => leave(),
        () => join(agent, floor.campaigns[0]!), () => join(agent, floor.campaigns[0]!),
        () => join(agent, floor.campaigns[1]!),
      ]);
      const answers = await Promise.all(burst.map((f) => f()));
      for (const res of answers) {
        expectHealthy(res, `flap ${agent.id}`);
        expect([200, 201, 404, 409], res.body).toContain(res.statusCode);
        if (res.statusCode === 409) expect(KNOWN_409, res.body).toContain(res.json().code);
        if (res.statusCode === 201) joined201++;
      }
      expect((await liveRows(agent.id)).length).toBeLessThanOrEqual(1);
      // And the station is still reachable afterwards: a fresh join either lands or names the live one.
      const after = await join(agent, floor.campaigns[0]!);
      expectHealthy(after, `after ${agent.id}`);
      if (after.statusCode === 201) joined201++;
      else expect(after.json()).toMatchObject({ code: 'session_on_other_campaign', campaign_id: floor.campaigns[1] });
      expect(await liveRows(agent.id)).toHaveLength(1);
    }));
    expect(await scalar(
      `SELECT count(*)::int AS n FROM (SELECT agent_user_id FROM agency_agent_sessions WHERE left_at IS NULL
         GROUP BY agent_user_id HAVING count(*) > 1) d`)).toBe(0);
    expect(await auditedJoins()).toBe(joined201);
  });
});
