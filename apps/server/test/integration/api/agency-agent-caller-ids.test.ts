import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';

/**
 * ─── Dedicated caller IDs through the real app and real Postgres (DN1–DN10) ─────────
 *
 * The supervisor's routes (list, set, release) with every refusal, the flag (only the PUT is
 * gated; the list and the release work with it off, DN9) and the audit rows; the campaign PATCH's `caller_id_dedicated` through the public route; the agent's
 * My contacts summary `caller_id`; and the release on all three unstaff paths (a supervisor's
 * DELETE, a tenant admin removing a membership, a super admin revoking one), whatever the
 * campaign's `on_unstaff`. Session middleware with Firebase stubbed, tenant context, RBAC, the
 * flag, the ownership probe through `callCore`, the repositories on real Postgres.
 *
 * Mutation-checked: deleting the `rel` CTE from `returnOnUnstaff` reds the three unstaff cases;
 * deleting the PATCH guard's call reds "the campaign PATCH"; dropping the staffing clauses of
 * `EFFECTIVE_DEDICATION_SQL` reds "a dedication left behind".
 */

const mocks = vi.hoisted(() => {
  process.env['SUPER_ADMIN_JWT_SECRET'] = 'agent-caller-ids-secret-0123456789';
  return { verifyIdToken: vi.fn() };
});
vi.mock('../../../src/auth/firebase.js', () => ({ initFirebase: vi.fn(), verifyIdToken: mocks.verifyIdToken }));

import { getTestPool, truncateAll } from '../../../../../packages/db/test/helpers/test-db.js';
import {
  call, drainAudits, seedFloor, startLoadApp, stopLoadApp, verifyTestToken,
  type Actor, type LoadApp, type TenantFloor,
} from '../load/load-harness.js';

let loaded: LoadApp;
let floors: TenantFloor[];
let floor: TenantFloor;
const app = () => loaded.app;
const sup = () => floor.supervisors[0]!;
const A = () => floor.campaigns[0]!;
const B = () => floor.campaigns[1]!;
const agent = (i: number) => floor.agents[i]!;

const X = '+918041000001';
const Y = '+918041000002';
const Z = '+918041000003';
const POOL = [X, Y, Z];

const listUrl = (c = A()) => `/proxy/agency/campaigns/${c}/agent-caller-ids`;
const agentUrl = (userId: string, c = A()) => `/proxy/agency/campaigns/${c}/agents/${userId}/caller-id`;
const put = (userId: string, body: unknown, c = A(), who: Actor = sup()) => call(app(), 'PUT', agentUrl(userId, c), who, floor, body);

async function staff(a: Actor, campaignId = A()): Promise<void> {
  const res = await call(app(), 'POST', `/proxy/agency/campaigns/${campaignId}/agents`, sup(), floor, { user_id: a.id });
  expect(res.statusCode, res.body).toBe(201);
}

async function stored(campaignId = A()): Promise<Record<string, string>> {
  const { rows } = await getTestPool().query<{ user_id: string; caller_id: string }>(
    'SELECT user_id::text AS user_id, caller_id FROM agency_campaign_agent_caller_ids WHERE campaign_id = $1', [campaignId]);
  return Object.fromEntries(rows.map((r) => [r.user_id, r.caller_id]));
}

async function audits(action: string): Promise<Array<{ details: Record<string, unknown>; account_id: string; campaign_id: string; actor_type: string; user_id: string | null }>> {
  await drainAudits();
  const { rows } = await getTestPool().query(
    'SELECT details, account_id, campaign_id, actor_type, user_id FROM platform_audit_log WHERE action = $1 ORDER BY created_at', [action]);
  return rows;
}

beforeAll(async () => {
  mocks.verifyIdToken.mockImplementation(verifyTestToken);
  loaded = await startLoadApp();
  await truncateAll();
  floors = await seedFloor({ tenants: 2, agentsPerTenant: 6, supervisorsPerTenant: 1, campaignsPerTenant: 2 });
  floor = floors[0]!;
  await getTestPool().query(
    `INSERT INTO feature_flag_overrides (flag_key, scope_type, tenant_id, value) VALUES ('agency_contact_assignment_enabled', 'tenant', $1, 'true'::jsonb)`,
    [floor.tenant],
  );
  await getTestPool().query('UPDATE agency_campaigns SET caller_ids = $2 WHERE id = ANY($1::uuid[])', [[A(), B()], POOL]);
  await staff(agent(0));
  await staff(agent(1));
}, 120_000);

afterAll(async () => {
  await stopLoadApp(loaded);
});

describe('the supervisor\'s routes', () => {
  it('GET with nothing dedicated: the pool is the rotation', async () => {
    const res = await call(app(), 'GET', listUrl(), sup(), floor);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ campaign_id: A(), caller_ids: POOL, dedicated: [], rotation: POOL, all_dedicated: false });
  });

  it('PUT dedicates a number (trimmed) and audits it; re-setting the agent replaces their number atomically', async () => {
    const res = await put(agent(0).id, { caller_id: `  ${Y}  ` });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({
      campaign_id: A(), user_id: agent(0).id, agent_name: 'agent 0.0', caller_id: Y, in_campaign: true,
      set_at: expect.any(String), set_by_user_id: sup().id,
    });
    expect(await stored()).toEqual({ [agent(0).id]: Y });

    const replaced = await put(agent(0).id, { caller_id: Z });
    expect(replaced.statusCode, replaced.body).toBe(200);
    expect(replaced.json().caller_id).toBe(Z);
    expect(await stored()).toEqual({ [agent(0).id]: Z });

    // The same number again writes nothing and audits nothing.
    const same = await put(agent(0).id, { caller_id: Z });
    expect(same.statusCode).toBe(200);
    expect(same.json().set_at).toBe(replaced.json().set_at);

    const rows = await audits('agency_campaign.agent_caller_id_set');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ account_id: floor.account, campaign_id: A(), actor_type: 'human', user_id: sup().id });
    expect(rows.map((r) => r.details)).toEqual([
      { campaign_id: A(), user_id: agent(0).id, caller_id: Y, previous_caller_id: null },
      { campaign_id: A(), user_id: agent(0).id, caller_id: Z, previous_caller_id: Y },
    ]);
  });

  it('refuses a number another agent holds (409 caller_id_taken, naming them); the same number on another campaign is free', async () => {
    const taken = await put(agent(1).id, { caller_id: Z });
    expect(taken.statusCode, taken.body).toBe(409);
    expect(taken.json()).toEqual({
      error: 'Conflict', code: 'caller_id_taken', message: expect.any(String),
      details: { caller_id: Z, user_id: agent(0).id, agent_name: 'agent 0.0' },
    });
    expect(await stored()).toEqual({ [agent(0).id]: Z });

    await staff(agent(1), B());
    const elsewhere = await put(agent(1).id, { caller_id: Z }, B());
    expect(elsewhere.statusCode, elsewhere.body).toBe(200);
    expect(await stored(B())).toEqual({ [agent(1).id]: Z });
  });

  it('refuses an unstaffed agent (404), a number not on the campaign (409, with the pool), a malformed body (400)', async () => {
    const unstaffed = await put(agent(5).id, { caller_id: X });
    expect(unstaffed.statusCode).toBe(404);
    expect(unstaffed.json()).toEqual({ error: 'Not Found', code: 'agent_not_staffed', message: expect.any(String) });
    const malformedUser = await put('nope', { caller_id: X });
    expect(malformedUser.statusCode).toBe(404);
    expect(malformedUser.json().code).toBe('agent_not_staffed');
    // A supervisor is not staffed on it either.
    expect((await put(sup().id, { caller_id: X })).json().code).toBe('agent_not_staffed');

    const foreign = await put(agent(1).id, { caller_id: '+919999999999' });
    expect(foreign.statusCode).toBe(409);
    expect(foreign.json()).toEqual({
      error: 'Conflict', code: 'caller_id_not_in_campaign', message: expect.any(String), details: { caller_ids: POOL },
    });

    for (const [body, field] of [[{}, 'caller_id'], [{ caller_id: '   ' }, 'caller_id'], [{ caller_id: 7 }, 'caller_id'],
      [{ caller_id: X, extra: 1 }, 'extra'], [{ caller_id: `+${'1'.repeat(21)}` }, 'caller_id']] as const) {
      const bad = await put(agent(1).id, body);
      expect(bad.statusCode, JSON.stringify(body)).toBe(400);
      expect(bad.json()).toMatchObject({ error: 'Bad Request', code: 'caller_id_invalid', details: { [field]: expect.any(String) } });
    }
    expect(await stored()).toEqual({ [agent(0).id]: Z });
  });

  it('GET lists every dedication by agent name, the rotation without them, and flags all_dedicated', async () => {
    expect((await put(agent(1).id, { caller_id: X })).statusCode).toBe(200);
    let body = (await call(app(), 'GET', listUrl(), sup(), floor)).json();
    expect(body.dedicated.map((d: { user_id: string; caller_id: string; agent_name: string; in_campaign: boolean }) =>
      [d.agent_name, d.caller_id, d.in_campaign])).toEqual([['agent 0.0', Z, true], ['agent 0.1', X, true]]);
    expect(body).toMatchObject({ caller_ids: POOL, rotation: [Y], all_dedicated: false });

    await staff(agent(2));
    expect((await put(agent(2).id, { caller_id: Y })).statusCode).toBe(200);
    body = (await call(app(), 'GET', listUrl(), sup(), floor)).json();
    expect(body).toMatchObject({ rotation: POOL, all_dedicated: true });

    // A number dropped by a direct write: listed, flagged out of the campaign, back in no rotation.
    await getTestPool().query('UPDATE agency_campaigns SET caller_ids = $2 WHERE id = $1', [A(), [X, Y]]);
    body = (await call(app(), 'GET', listUrl(), sup(), floor)).json();
    expect(body.dedicated.find((d: { user_id: string }) => d.user_id === agent(0).id)).toMatchObject({ caller_id: Z, in_campaign: false });
    expect(body).toMatchObject({ caller_ids: [X, Y], rotation: [X, Y], all_dedicated: true });
    await getTestPool().query('UPDATE agency_campaigns SET caller_ids = $2 WHERE id = $1', [A(), POOL]);
  });

  it('DELETE releases the number (204, audited cause supervisor); again is 204 with no row', async () => {
    const res = await call(app(), 'DELETE', agentUrl(agent(2).id), sup(), floor);
    expect(res.statusCode).toBe(204);
    expect((await stored())[agent(2).id]).toBeUndefined();
    const again = await call(app(), 'DELETE', agentUrl(agent(2).id), sup(), floor);
    expect(again.statusCode).toBe(204);
    expect((await call(app(), 'DELETE', agentUrl('nope'), sup(), floor)).statusCode).toBe(204);
    const rows = await audits('agency_campaign.agent_caller_id_cleared');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ account_id: floor.account, campaign_id: A(), actor_type: 'human' });
    expect(rows[0]!.details).toEqual({ campaign_id: A(), user_id: agent(2).id, caller_id: Y, cause: 'supervisor' });
  });

  it('refuses an agent (RBAC), another tenant\'s campaign (404), a malformed campaign id (404), and a PUT in a tenant without the flag (403)', async () => {
    const asAgent = await call(app(), 'GET', listUrl(), agent(0), floor);
    expect(asAgent.statusCode).toBe(403);
    expect(asAgent.json().message).toMatch(/^Insufficient permissions/);
    expect((await put(agent(0).id, { caller_id: X }, A(), agent(0))).statusCode).toBe(403);

    const foreign = await call(app(), 'GET', listUrl(floors[1]!.campaigns[0]!), sup(), floor);
    expect(foreign.statusCode).toBe(404);
    const malformed = await call(app(), 'GET', listUrl('nope'), sup(), floor);
    expect(malformed.statusCode).toBe(404);
    expect(malformed.json().code).toBe('campaign_not_found');

    const other = floors[1]!;
    const otherCampaign = other.campaigns[0]!;
    const asOther = (method: 'GET' | 'PUT' | 'DELETE', url: string, body?: unknown) =>
      call(app(), method, url, other.supervisors[0]!, other, body);
    const res = await asOther('PUT', agentUrl(other.agents[0]!.id, otherCampaign), { caller_id: '+919000000001' });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'Forbidden', code: 'assignment_disabled', message: expect.any(String) });
  });

  it('with the flag off, a dedication made while it was on can still be listed and released (DN9); setting one is 403', async () => {
    const other = floors[1]!;
    const otherCampaign = other.campaigns[0]!;
    const otherSup = other.supervisors[0]!;
    const holder = other.agents[1]!;
    const asOther = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, body?: unknown) =>
      call(app(), method, url, otherSup, other, body);
    await getTestPool().query('UPDATE agency_campaigns SET caller_ids = $2 WHERE id = $1', [otherCampaign, POOL]);
    const staffed = await asOther('POST', `/proxy/agency/campaigns/${otherCampaign}/agents`, { user_id: holder.id });
    expect(staffed.statusCode, staffed.body).toBe(201);
    // Stored while the flag was on (a direct write here: the PUT is gated), after the staffing.
    await getTestPool().query(
      `INSERT INTO agency_campaign_agent_caller_ids (tenant_id, account_id, campaign_id, user_id, caller_id, set_at)
       VALUES ($1, $2, $3, $4, $5, clock_timestamp())`,
      [other.tenant, other.account, otherCampaign, holder.id, Y]);

    const listed = await asOther('GET', listUrl(otherCampaign));
    expect(listed.statusCode, listed.body).toBe(200);
    expect(listed.json()).toMatchObject({
      campaign_id: otherCampaign, caller_ids: POOL, rotation: [X, Z], all_dedicated: false,
      dedicated: [{ user_id: holder.id, caller_id: Y, in_campaign: true }],
    });

    const setting = await asOther('PUT', agentUrl(holder.id, otherCampaign), { caller_id: Z });
    expect(setting.statusCode).toBe(403);
    expect(setting.json()).toMatchObject({ code: 'assignment_disabled' });
    expect(await stored(otherCampaign)).toEqual({ [holder.id]: Y });

    const released = await asOther('DELETE', agentUrl(holder.id, otherCampaign));
    expect(released.statusCode, released.body).toBe(204);
    expect(await stored(otherCampaign)).toEqual({});
    const rows = (await audits('agency_campaign.agent_caller_id_cleared')).filter((r) => r.campaign_id === otherCampaign);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ account_id: other.account, actor_type: 'human', user_id: otherSup.id });
    expect(rows[0]!.details).toEqual({ campaign_id: otherCampaign, user_id: holder.id, caller_id: Y, cause: 'supervisor' });
    // Idempotent, flag or not.
    expect((await asOther('DELETE', agentUrl(holder.id, otherCampaign))).statusCode).toBe(204);
    expect((await asOther('GET', listUrl(otherCampaign))).json()).toMatchObject({ dedicated: [], rotation: POOL });
  });

  it('a unique-violation race is caller_id_taken, never a 500', async () => {
    // Agent 3 is given Y by a transaction that commits only after the route has passed its own
    // "held by another" read: the route's insert waits on the unique index, then trips it.
    await staff(agent(3));
    await staff(agent(4));
    const client = await getTestPool().connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO agency_campaign_agent_caller_ids (tenant_id, account_id, campaign_id, user_id, caller_id) VALUES ($1, $2, $3, $4, $5)`,
        [floor.tenant, floor.account, A(), agent(3).id, Y]);
      const racing = put(agent(4).id, { caller_id: Y });
      // Let the route reach its insert and block on the index.
      await waitForLock();
      await client.query('COMMIT');
      const res = await racing;
      expect(res.statusCode, res.body).toBe(409);
      expect(res.json()).toMatchObject({ code: 'caller_id_taken', details: { caller_id: Y, user_id: agent(3).id, agent_name: 'agent 0.3' } });
    } finally {
      client.release();
    }
    expect((await stored())[agent(4).id]).toBeUndefined();
  });
});

/** Until a backend is waiting on a lock (the route's insert, blocked on the uncommitted row). */
async function waitForLock(): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const { rows } = await getTestPool().query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND datname = current_database()`);
    if (rows[0]!.n > 0) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('the racing PUT never waited on the index');
}

describe('the campaign PATCH (DN6)', () => {
  it('refuses to drop a dedicated number: 409 caller_id_dedicated through the public route; keeping them saves', async () => {
    // Dedicated on A now: agent 0 → Z, agent 1 → X, agent 3 → Y.
    const res = await call(app(), 'PATCH', `/proxy/agency/campaigns/${A()}`, sup(), floor, { caller_ids: [X, Y] });
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json()).toEqual({
      error: 'Conflict', code: 'caller_id_dedicated', message: expect.any(String), details: { caller_ids: [Z] },
    });
    const { rows } = await getTestPool().query<{ caller_ids: string[] }>('SELECT caller_ids FROM agency_campaigns WHERE id = $1', [A()]);
    expect(rows[0]!.caller_ids).toEqual(POOL);

    const kept = await call(app(), 'PATCH', `/proxy/agency/campaigns/${A()}`, sup(), floor, { caller_ids: [...POOL, '+918041000009'] });
    expect(kept.statusCode, kept.body).toBe(200);
    await getTestPool().query('UPDATE agency_campaigns SET caller_ids = $2 WHERE id = $1', [A(), POOL]);
  });
});

describe('the agent\'s My contacts summary', () => {
  it('carries their dedicated number; null without one, or once the campaign no longer has it', async () => {
    const mine = await call(app(), 'GET', `/proxy/agency/my-contacts/summary?campaign_id=${A()}`, agent(0), floor);
    expect(mine.statusCode, mine.body).toBe(200);
    expect(mine.json().caller_id).toBe(Z);
    await staff(agent(5));
    const none = await call(app(), 'GET', `/proxy/agency/my-contacts/summary?campaign_id=${A()}`, agent(5), floor);
    expect(none.json().caller_id).toBeNull();

    await getTestPool().query('UPDATE agency_campaigns SET caller_ids = $2 WHERE id = $1', [A(), [X, Y]]);
    const stale = await call(app(), 'GET', `/proxy/agency/my-contacts/summary?campaign_id=${A()}`, agent(0), floor);
    expect(stale.json().caller_id).toBeNull();
    await getTestPool().query('UPDATE agency_campaigns SET caller_ids = $2 WHERE id = $1', [A(), POOL]);
  });
});

describe('a dedication left behind by an unstaff (DN1: effective only while staffed, and set since)', () => {
  it('is ignored by the GET, the PATCH guard and the summary, stays ignored on re-staff, and does not block a PUT', async () => {
    // Agent 4 gets X on B, then is unstaffed with the row left behind (a release that failed).
    await staff(agent(4), B());
    expect((await put(agent(4).id, { caller_id: X }, B())).statusCode).toBe(200);
    await getTestPool().query(
      'UPDATE agency_campaign_agents SET unassigned_at = now() WHERE campaign_id = $1 AND user_id = $2 AND unassigned_at IS NULL',
      [B(), agent(4).id]);
    expect((await stored(B()))[agent(4).id]).toBe(X);

    const body = (await call(app(), 'GET', listUrl(B()), sup(), floor)).json();
    expect(body.dedicated.map((d: { user_id: string }) => d.user_id)).toEqual([agent(1).id]);
    expect(body).toMatchObject({ rotation: [X, Y], all_dedicated: false });

    // Staffed again: still not theirs.
    await staff(agent(4), B());
    const summary = await call(app(), 'GET', `/proxy/agency/my-contacts/summary?campaign_id=${B()}`, agent(4), floor);
    expect(summary.statusCode, summary.body).toBe(200);
    expect(summary.json().caller_id).toBeNull();
    expect((await call(app(), 'GET', listUrl(B()), sup(), floor)).json().dedicated).toHaveLength(1);

    // The PATCH may drop X: no agent effectively holds it.
    const patched = await call(app(), 'PATCH', `/proxy/agency/campaigns/${B()}`, sup(), floor, { caller_ids: [Y, Z] });
    expect(patched.statusCode, patched.body).toBe(200);
    await getTestPool().query('UPDATE agency_campaigns SET caller_ids = $2 WHERE id = $1', [B(), POOL]);

    // A PUT of X (the stale row's number) to another agent succeeds; the stale row goes.
    await staff(agent(5), B());
    const taken = await put(agent(5).id, { caller_id: X }, B());
    expect(taken.statusCode, taken.body).toBe(200);
    expect(await stored(B())).toEqual({ [agent(1).id]: Z, [agent(5).id]: X });
    expect((await call(app(), 'DELETE', agentUrl(agent(5).id, B()), sup(), floor)).statusCode).toBe(204);
  });
});

describe('unstaff releases the number on all three paths (DN7), whatever on_unstaff says', () => {
  async function cleared(userId: string) {
    return (await audits('agency_campaign.agent_caller_id_cleared')).filter((r) => r.details['user_id'] === userId);
  }

  it('a supervisor removing the agent releases it, audited cause unstaff', async () => {
    expect((await stored())[agent(0).id]).toBe(Z);
    const res = await call(app(), 'DELETE', `/proxy/agency/campaigns/${A()}/agents/${agent(0).id}`, sup(), floor);
    expect(res.statusCode).toBe(204);
    expect((await stored())[agent(0).id]).toBeUndefined();
    const rows = await cleared(agent(0).id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ campaign_id: A(), account_id: floor.account, actor_type: 'human' });
    expect(rows[0]!.details).toMatchObject({ campaign_id: A(), user_id: agent(0).id, caller_id: Z, cause: 'unstaff', unstaff_cause: 'unstaffed' });
    // They held no contacts: no CA6 row.
    expect((await audits('agency_contacts.unassigned_on_unstaff')).filter((r) => r.details['user_id'] === agent(0).id)).toEqual([]);
  });

  it('a tenant admin removing the membership releases it on every campaign, `keep` ones included', async () => {
    // Agent 1: X on A, Z on B; B keeps contacts on unstaff, never numbers.
    await getTestPool().query(`UPDATE agency_campaigns SET on_unstaff = 'keep' WHERE id = $1`, [B()]);
    expect((await stored(A()))[agent(1).id]).toBe(X);
    expect((await stored(B()))[agent(1).id]).toBe(Z);
    const admin = await tenantAdmin();
    const res = await call(app(), 'DELETE', `/users/${agent(1).id}/membership`, admin, floor);
    expect(res.statusCode, res.body).toBeLessThan(300);
    expect((await stored(A()))[agent(1).id]).toBeUndefined();
    expect((await stored(B()))[agent(1).id]).toBeUndefined();
    const rows = await cleared(agent(1).id);
    expect(rows.map((r) => [r.campaign_id, r.details['caller_id'], r.details['cause'], r.actor_type]).sort())
      .toEqual([[A(), X, 'unstaff', 'human'], [B(), Z, 'unstaff', 'human']].sort());
  });

  it('a super admin revoking the membership releases it, audited as the system', async () => {
    expect((await stored())[agent(3).id]).toBe(Y);
    const { rows: m } = await getTestPool().query<{ id: string }>('SELECT id FROM memberships WHERE user_id = $1 AND tenant_id = $2', [agent(3).id, floor.tenant]);
    const token = await superAdminToken();
    const res = await app().inject({
      method: 'DELETE', url: `/super-admin/tenants/${floor.tenant}/memberships/${m[0]!.id}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode, res.body).toBeLessThan(300);
    expect((await stored())[agent(3).id]).toBeUndefined();
    const rows = await cleared(agent(3).id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor_type: 'system', account_id: floor.account });
    expect(rows[0]!.details).toMatchObject({ caller_id: Y, cause: 'unstaff', via: 'super_admin' });
  });

  it('an unstaff with nothing dedicated writes no cleared row', async () => {
    const before = (await audits('agency_campaign.agent_caller_id_cleared')).length;
    const res = await call(app(), 'DELETE', `/proxy/agency/campaigns/${A()}/agents/${agent(5).id}`, sup(), floor);
    expect(res.statusCode).toBe(204);
    expect((await audits('agency_campaign.agent_caller_id_cleared')).length).toBe(before);
  });
});

async function tenantAdmin(): Promise<Actor> {
  const id = randomUUID();
  const uid = `tenant-admin-${id.slice(0, 8)}`;
  await getTestPool().query(
    `INSERT INTO users (id, firebase_uid, email, display_name, status) VALUES ($1, $2, $3, 'Admin', 'active')`,
    [id, uid, `${uid}@load.example.com`]);
  await getTestPool().query(
    `INSERT INTO memberships (id, user_id, tenant_id, account_id, role, status) VALUES ($1, $2, $3, $4, 'tenant_admin', 'active')`,
    [randomUUID(), id, floor.tenant, floor.account]);
  return { id, uid, tok: `tok:${uid}`, role: 'account_admin', ip: '10.1.200.99' };
}

async function superAdminToken(): Promise<string> {
  await getTestPool().query(
    `INSERT INTO super_admins (id, email, password_hash, name, status) VALUES ($1, $2, $3, $4, 'active')`,
    [randomUUID(), 'root@platform.test', await bcrypt.hash('RootPassword123!', 10), 'Root'],
  );
  const res = await app().inject({
    method: 'POST', url: '/super-admin/login', payload: { email: 'root@platform.test', password: 'RootPassword123!' },
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json().token as string;
}

/**
 * A campaign pinned to the tenant's own carrier account (PL13 with DN2): the routes treat its
 * DIALABLE caller IDs as the campaign's, the pool every dial path decides over. A number the
 * account no longer lists (retired by a sync) cannot be dedicated; one dedicated before it was
 * retired is listed `in_campaign: false`, is left out of the rotation and is not the agent's
 * number in My contacts; and removing it from the campaign is refused, naming it (DN6).
 * A campaign of its own: campaign B's row copied under a new id.
 */
describe('a campaign pinned to the tenant\'s carrier account (PL13)', () => {
  it('dedicates only a dialable number, and a dedicated number retired since stops counting', async () => {
    const { phoneNumberRepository } = await import('@magick-agency/db/repositories/phone-number.repository');
    const { invalidateDialableCallerIds } = await import('../../../src/agency/campaign-dialability.js');
    const campaign = randomUUID();
    await getTestPool().query(
      `INSERT INTO agency_campaigns
       SELECT (jsonb_populate_record(NULL::agency_campaigns, to_jsonb(c)
         || jsonb_build_object('id', $2::uuid, 'name', 'Pinned', 'root_campaign_id', NULL, 'parent_campaign_id', NULL))).*
       FROM agency_campaigns c WHERE c.id = $1`,
      [B(), campaign]);
    const holder = agent(2);
    const asOther = (method: 'GET' | 'POST' | 'PUT' | 'PATCH', url: string, actor: Actor = sup(), body?: unknown) =>
      call(app(), method, url, actor, floor, body);
    await getTestPool().query(
      `INSERT INTO telephony_providers (name, display_name, status) VALUES ('plivo', 'Plivo', 'active') ON CONFLICT (name) DO NOTHING`);
    const { rows: [cred] } = await getTestPool().query<{ id: string }>(
      `INSERT INTO telephony_credentials (tenant_id, provider, label, account_ref) VALUES ($1, 'plivo', 'Own', $2) RETURNING id`,
      [floor.tenant, `MA${randomUUID().replace(/-/g, '').slice(0, 18).toUpperCase()}`]);
    const credId = cred!.id;
    // X, Y and Z synced; then Z retired by a sync that no longer lists it.
    await phoneNumberRepository.syncForCredential(credId, POOL.map((n) => ({ phone_number: n, label: null })), null);
    await phoneNumberRepository.syncForCredential(credId, [X, Y].map((n) => ({ phone_number: n, label: null })), null);
    await getTestPool().query(
      `UPDATE agency_campaigns SET caller_ids = $2, telephony_provider = 'plivo', telephony_credential_id = $3 WHERE id = $1`,
      [campaign, POOL, credId]);
    invalidateDialableCallerIds();
    const staffed = await asOther('POST', `/proxy/agency/campaigns/${campaign}/agents`, sup(), { user_id: holder.id });
    expect(staffed.statusCode, staffed.body).toBe(201);

    // The retired number is stored but not dialable: listed out, and not dedicable.
    const listed = await asOther('GET', listUrl(campaign));
    expect(listed.statusCode, listed.body).toBe(200);
    expect(listed.json()).toMatchObject({ caller_ids: [X, Y], rotation: [X, Y], dedicated: [] });
    const retired = await asOther('PUT', agentUrl(holder.id, campaign), sup(), { caller_id: Z });
    expect(retired.statusCode, retired.body).toBe(409);
    expect(retired.json()).toEqual({
      error: 'Conflict', code: 'caller_id_not_in_campaign', message: expect.stringMatching(/carrier account/),
      details: { caller_ids: [X, Y] },
    });

    // A live one is dedicated and is the agent's number.
    const set = await asOther('PUT', agentUrl(holder.id, campaign), sup(), { caller_id: X });
    expect(set.statusCode, set.body).toBe(200);
    const summary = () => asOther('GET', `/proxy/agency/my-contacts/summary?campaign_id=${campaign}`, holder);
    expect((await summary()).json().caller_id).toBe(X);

    // X retired since (a sync that no longer lists it; the sync route clears the dialable cache).
    await phoneNumberRepository.syncForCredential(credId, [{ phone_number: Y, label: null }], null);
    invalidateDialableCallerIds();
    const after = await asOther('GET', listUrl(campaign));
    expect(after.json()).toMatchObject({
      caller_ids: [Y], rotation: [Y], all_dedicated: false,
      dedicated: [{ user_id: holder.id, caller_id: X, in_campaign: false }],
    });
    expect((await summary()).json().caller_id).toBeNull();

    // Removing the retired, still dedicated number is refused with the dedicated-number answer
    // (DN6), which names it, so the supervisor releases it first ("Use shared rotation").
    const drop = await asOther('PATCH', `/proxy/agency/campaigns/${campaign}`, sup(), { caller_ids: [Y, Z] });
    expect(drop.statusCode, drop.body).toBe(409);
    expect(drop.json()).toMatchObject({ code: 'caller_id_dedicated', details: { caller_ids: [X] } });
  });
});
