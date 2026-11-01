import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * ─── The join's staffing check, on the real app and real Postgres ───────────────
 *
 * `POST /proxy/agency/sessions` refuses a campaign the caller is not ACTIVELY staffed on
 * (`agency_campaign_agents`, the rows `GET /proxy/agency/my-assignments` lists) with
 * `403 not_staffed`, unless their ROLE holds `agency.supervise`, which the public API layer
 * reads from the membership. Through the real app: the session middleware (Firebase
 * stubbed), tenant context, RBAC, `callCore` and the internal handler, staffing written
 * through the supervisor's own staffing routes.
 *
 *  1. a staffed agent joins; an unstaffed one is refused with the exact body, and no
 *     session row is written;
 *  2. a supervisor (`account_admin`) joins a campaign nobody staffed them on;
 *  3. staffing is per campaign: staffed on A is not staffed on B, and `/my-assignments`
 *     offers exactly what the join accepts;
 *  4. unassigned MID-SHIFT: the agent's re-bootstrap of their live session (a reload, an
 *     app resume) is still served, the same session; once they leave, the next join is
 *     refused.
 *
 * Mutation-checked: deleting the staffing check in `sessions.ts` reds 1, 3 and 4; sending
 * `supervise: true` for every caller from the public route reds 1 and 3; dropping the
 * rehydrate arm of `mayStartOrResume` reds 4.
 */

const mocks = vi.hoisted(() => {
  process.env['SUPER_ADMIN_JWT_SECRET'] = 'join-staffing-secret-0123456789';
  return { verifyIdToken: vi.fn() };
});
vi.mock('../../../src/auth/firebase.js', () => ({ initFirebase: vi.fn(), verifyIdToken: mocks.verifyIdToken }));

import { truncateAll } from '../../../../../packages/db/test/helpers/test-db.js';
import {
  call, expectHealthy, scalar, seedFloor, startLoadApp, stopLoadApp, verifyTestToken,
  type Actor, type LoadApp, type TenantFloor,
} from '../load/load-harness.js';

const NOT_STAFFED = {
  error: 'Forbidden',
  code: 'not_staffed',
  message: "You're not assigned to this campaign. Ask your supervisor to add you.",
};

let loaded: LoadApp;
let floor: TenantFloor;
const app = () => loaded.app;

beforeAll(async () => {
  mocks.verifyIdToken.mockImplementation(verifyTestToken);
  loaded = await startLoadApp();
  await truncateAll();
  floor = (await seedFloor({ tenants: 1, agentsPerTenant: 5, supervisorsPerTenant: 1, campaignsPerTenant: 2 }))[0]!;
});

afterAll(async () => {
  await stopLoadApp(loaded);
});

const supervisor = () => floor.supervisors[0]!;
const [CAMPAIGN_A, CAMPAIGN_B] = [0, 1].map((i) => () => floor.campaigns[i]!);

async function staff(agent: Actor, campaignId: string): Promise<void> {
  const res = await call(app(), 'POST', `/proxy/agency/campaigns/${campaignId}/agents`, supervisor(), floor, { user_id: agent.id });
  expect(res.statusCode, res.body).toBe(201);
}

async function unstaff(agent: Actor, campaignId: string): Promise<void> {
  const res = await call(app(), 'DELETE', `/proxy/agency/campaigns/${campaignId}/agents/${agent.id}`, supervisor(), floor);
  expect(res.statusCode, res.body).toBeLessThan(300);
}

const join = (actor: Actor, campaignId: string) =>
  call(app(), 'POST', '/proxy/agency/sessions', actor, floor, { campaign_id: campaignId });

const liveSessions = (actor: Actor) =>
  scalar('SELECT count(*)::int AS n FROM agency_agent_sessions WHERE agent_user_id = $1 AND left_at IS NULL', [actor.id]);

describe('POST /proxy/agency/sessions — the staffing check (integration)', () => {
  it('1. a staffed agent joins; an unstaffed agent is refused 403 not_staffed and nothing is written', async () => {
    const staffed = floor.agents[0]!;
    const unstaffed = floor.agents[1]!;
    await staff(staffed, CAMPAIGN_A());

    const ok = await join(staffed, CAMPAIGN_A());
    expectHealthy(ok, 'staffed join');
    expect(ok.statusCode, ok.body).toBe(201);
    expect(ok.json()).toMatchObject({ campaign_id: CAMPAIGN_A(), agent_user_id: staffed.id });

    const refused = await join(unstaffed, CAMPAIGN_A());
    expect(refused.statusCode, refused.body).toBe(403);
    expect(refused.json()).toEqual(NOT_STAFFED);
    expect(await liveSessions(unstaffed)).toBe(0);
  });

  it('2. a supervisor joins a campaign nobody staffed them on', async () => {
    const res = await join(supervisor(), CAMPAIGN_B());
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json()).toMatchObject({ campaign_id: CAMPAIGN_B(), agent_user_id: supervisor().id });
    const left = await call(app(), 'POST', `/proxy/agency/sessions/${res.json().session_id}/leave`, supervisor(), floor, {});
    expect(left.statusCode, left.body).toBeLessThan(300);
  });

  it('3. staffing is per campaign, and /my-assignments offers exactly what the join accepts', async () => {
    const agent = floor.agents[2]!;
    await staff(agent, CAMPAIGN_A());

    const assignments = await call(app(), 'GET', '/proxy/agency/my-assignments', agent, floor);
    expect(assignments.statusCode, assignments.body).toBe(200);
    expect(assignments.json().assignments.map((a: { campaign_id: string }) => a.campaign_id)).toEqual([CAMPAIGN_A()]);

    const other = await join(agent, CAMPAIGN_B());
    expect(other.statusCode, other.body).toBe(403);
    expect(other.json().code).toBe('not_staffed');

    const offered = await join(agent, CAMPAIGN_A());
    expect(offered.statusCode, offered.body).toBe(201);
  });

  it('4. unassigned mid-shift: the live session re-bootstraps; after leaving, the next join is refused', async () => {
    const agent = floor.agents[3]!;
    await staff(agent, CAMPAIGN_A());
    const first = await join(agent, CAMPAIGN_A());
    expect(first.statusCode, first.body).toBe(201);
    const sessionId = first.json().session_id as string;

    await unstaff(agent, CAMPAIGN_A());

    // A reload or an app resume: the same session, still served.
    const resumed = await join(agent, CAMPAIGN_A());
    expect(resumed.statusCode, resumed.body).toBe(201);
    expect(resumed.json().session_id).toBe(sessionId);

    const left = await call(app(), 'POST', `/proxy/agency/sessions/${sessionId}/leave`, agent, floor, {});
    expect(left.statusCode, left.body).toBeLessThan(300);

    const again = await join(agent, CAMPAIGN_A());
    expect(again.statusCode, again.body).toBe(403);
    expect(again.json()).toEqual(NOT_STAFFED);
  });
});
