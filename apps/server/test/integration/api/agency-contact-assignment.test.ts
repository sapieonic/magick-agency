import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';

/**
 * ─── Contact assignment through the real app and real Postgres ──────────────────
 *
 * The supervisor's routes (preview, commit, progress, history), the agent's own-contact
 * reads, the roster's `assigned_to` filter and CSV columns, and the unstaff return on all
 * three paths (a supervisor's DELETE, a tenant admin removing a membership, a super admin
 * revoking one). Session middleware with Firebase stubbed, tenant context, RBAC, the flag,
 * the ownership probe through `callCore`, the repositories on real Postgres.
 *
 * Mutation-checked (see the lane report): deleting the owner predicate in
 * `AgencyAssignmentReadRepository.myContacts` reds "an agent sees only their own contacts".
 */

const mocks = vi.hoisted(() => {
  process.env['SUPER_ADMIN_JWT_SECRET'] = 'contact-assignment-secret-0123456789';
  return { verifyIdToken: vi.fn() };
});
vi.mock('../../../src/auth/firebase.js', () => ({ initFirebase: vi.fn(), verifyIdToken: mocks.verifyIdToken }));

import { getTestPool, truncateAll } from '../../../../../packages/db/test/helpers/test-db.js';
import {
  call, drainAudits, expectHealthy, seedFloor, startLoadApp, stopLoadApp, verifyTestToken,
  type Actor, type LoadApp, type TenantFloor,
} from '../load/load-harness.js';

let loaded: LoadApp;
let floors: TenantFloor[];
let floor: TenantFloor;
const app = () => loaded.app;
const sup = () => floor.supervisors[0]!;
const A = () => floor.campaigns[0]!;
const agent = (i: number) => floor.agents[i]!;

async function seedContacts(campaignId: string, n: number, f: TenantFloor, prefix: string): Promise<string[]> {
  const { rows } = await getTestPool().query<{ id: string }>(
    `INSERT INTO agency_contacts (campaign_id, tenant_id, account_id, phone_e164, csv_line_number, context, state)
     SELECT $1, $2, $3, $4 || lpad(i::text, 6, '0'), i, jsonb_build_object('Name', 'Customer ' || i, 'Secret', 'x'), 'pending'
       FROM generate_series(1, $5::int) AS i
     RETURNING id`,
    [campaignId, f.tenant, f.account, prefix, n],
  );
  return rows.map((r) => r.id);
}

async function staff(a: Actor, campaignId = A()): Promise<void> {
  const res = await call(app(), 'POST', `/proxy/agency/campaigns/${campaignId}/agents`, sup(), floor, { user_id: a.id });
  expect(res.statusCode, res.body).toBe(201);
}

async function assign(operation: Record<string, unknown>, campaignId = A()) {
  const preview = await call(app(), 'POST', `/proxy/agency/campaigns/${campaignId}/assignments/preview`, sup(), floor, operation);
  expect(preview.statusCode, preview.body).toBe(200);
  const p = preview.json();
  const commit = await call(app(), 'POST', `/proxy/agency/campaigns/${campaignId}/assignments`, sup(), floor, {
    operation: { ...operation, ...(p.seed ? { seed: p.seed } : {}) },
    preview_token: p.preview_token,
  });
  expectHealthy(commit, 'commit');
  return { preview: p, commit };
}

async function ownedBy(userId: string, campaignId = A()): Promise<number> {
  const { rows } = await getTestPool().query<{ n: number }>(
    'SELECT count(*)::int AS n FROM agency_contacts WHERE campaign_id = $1 AND assigned_user_id = $2', [campaignId, userId]);
  return rows[0]!.n;
}

async function audits(action: string): Promise<Array<{ details: Record<string, unknown>; account_id: string; campaign_id: string; actor_type: string }>> {
  await drainAudits();
  const { rows } = await getTestPool().query(
    'SELECT details, account_id, campaign_id, actor_type FROM platform_audit_log WHERE action = $1 ORDER BY created_at', [action]);
  return rows;
}

let contacts: string[];

beforeAll(async () => {
  mocks.verifyIdToken.mockImplementation(verifyTestToken);
  loaded = await startLoadApp();
  await truncateAll();
  floors = await seedFloor({ tenants: 2, agentsPerTenant: 4, supervisorsPerTenant: 1, campaignsPerTenant: 2 });
  floor = floors[0]!;
  // The flag on tenant 0 only.
  await getTestPool().query(
    `INSERT INTO feature_flag_overrides (flag_key, scope_type, tenant_id, value) VALUES ('agency_contact_assignment_enabled', 'tenant', $1, 'true'::jsonb)`,
    [floor.tenant],
  );
  await getTestPool().query(
    `UPDATE agency_campaigns SET context_display = '{"hero": ["Name", "Secret"], "hidden": ["Secret"]}'::jsonb WHERE id = $1`, [A()]);
  contacts = await seedContacts(A(), 40, floor, '+91900');
  await seedContacts(floors[1]!.campaigns[0]!, 5, floors[1]!, '+91800');
  await staff(agent(0));
  await staff(agent(1));
}, 120_000);

afterAll(async () => {
  await stopLoadApp(loaded);
});

describe('the supervisor\'s assignment routes', () => {
  it('previews and commits a split; one audit row with the batch and per-agent counts', async () => {
    const { preview, commit } = await assign({ kind: 'random_split', agent_user_ids: [agent(0).id, agent(1).id] });
    expect(preview).toMatchObject({ matched: 40, moving: 40, skipped_live: 0 });
    expect(typeof preview.seed).toBe('string');
    expect(commit.statusCode, commit.body).toBe(200);
    expect(commit.json()).toMatchObject({ kind: 'random_split', moved: 40 });
    expect(await ownedBy(agent(0).id)).toBe(20);
    expect(await ownedBy(agent(1).id)).toBe(20);

    const rows = await audits('agency_contacts.assigned');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ account_id: floor.account, campaign_id: A(), actor_type: 'human' });
    expect(rows[0]!.details).toMatchObject({ batch_id: commit.json().batch_id, kind: 'random_split', moved: 40, skipped_live: 0, to_pool: 0 });
    expect(rows[0]!.details['per_agent']).toEqual(commit.json().per_agent);
  });

  it('refuses an unstaffed target, a malformed operation, and a stale preview', async () => {
    const unstaffed = await call(app(), 'POST', `/proxy/agency/campaigns/${A()}/assignments/preview`, sup(), floor,
      { kind: 'count', agent_user_id: agent(2).id, count: 1 });
    expect(unstaffed.statusCode).toBe(400);
    expect(unstaffed.json()).toEqual({
      error: 'Bad Request', code: 'agent_not_staffed', message: expect.any(String), details: { agent_user_ids: [agent(2).id] },
    });

    const bad = await call(app(), 'POST', `/proxy/agency/campaigns/${A()}/assignments/preview`, sup(), floor,
      { kind: 'count', agent_user_id: 'nope', count: 0 });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({ code: 'assignment_invalid', details: { agent_user_id: expect.any(String), count: expect.any(String) } });

    const op = { kind: 'reassign', from_user_id: agent(0).id, to_user_id: agent(1).id, count: 2 };
    const preview = (await call(app(), 'POST', `/proxy/agency/campaigns/${A()}/assignments/preview`, sup(), floor, op)).json();
    // Agent 0's first contact goes on a call before the commit.
    await getTestPool().query(
      `UPDATE agency_contacts SET state = 'in_flight' WHERE id = (
         SELECT id FROM agency_contacts WHERE campaign_id = $1 AND assigned_user_id = $2 ORDER BY csv_line_number LIMIT 1)`,
      [A(), agent(0).id]);
    const stale = await call(app(), 'POST', `/proxy/agency/campaigns/${A()}/assignments`, sup(), floor, { operation: op, preview_token: preview.preview_token });
    expect(stale.statusCode, stale.body).toBe(409);
    expect(stale.json()).toMatchObject({ error: 'Conflict', code: 'preview_stale', preview: { kind: 'reassign', moving: 2 } });
    expect(stale.json().preview.preview_token).not.toBe(preview.preview_token);
    await getTestPool().query(`UPDATE agency_contacts SET state = 'pending' WHERE campaign_id = $1`, [A()]);
  });

  it('refuses an agent (RBAC), a campaign of another tenant (404), and a tenant without the flag (403)', async () => {
    const asAgent = await call(app(), 'POST', `/proxy/agency/campaigns/${A()}/assignments/preview`, agent(0), floor, { kind: 'rebalance', agent_user_ids: [agent(0).id, agent(1).id] });
    expect(asAgent.statusCode).toBe(403);
    expect(asAgent.json().message).toMatch(/^Insufficient permissions/);

    const foreign = await call(app(), 'GET', `/proxy/agency/campaigns/${floors[1]!.campaigns[0]}/assignments/progress`, sup(), floor);
    expect(foreign.statusCode).toBe(404);

    const other = floors[1]!;
    const off = await call(app(), 'GET', `/proxy/agency/campaigns/${other.campaigns[0]}/assignments/progress`, other.supervisors[0]!, other);
    expect(off.statusCode).toBe(403);
    expect(off.json()).toEqual({ error: 'Forbidden', code: 'assignment_disabled', message: expect.any(String) });
    const offAgent = await call(app(), 'GET', `/proxy/agency/my-contacts/summary?campaign_id=${other.campaigns[0]}`, other.agents[0]!, other);
    expect(offAgent.json().code).toBe('assignment_disabled');
  });

  it('progress: per agent counts, presence, names; the pool', async () => {
    const res = await call(app(), 'GET', `/proxy/agency/campaigns/${A()}/assignments/progress`, sup(), floor);
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ campaign_id: A(), assignment_mode: 'pool', absent_after_minutes: 15, unassigned_open: 0 });
    const byId = new Map<string, Record<string, unknown>>(body.agents.map((a: { agent_user_id: string }) => [a.agent_user_id, a]));
    expect(byId.get(agent(0).id)).toMatchObject({
      staffed: true, live: false, assigned: await ownedBy(agent(0).id), agent_name: 'agent 0.0', due_now: await ownedBy(agent(0).id),
    });
    // Away and never seen: everything due counts as due while absent.
    expect(byId.get(agent(0).id)!['due_while_absent']).toBe(byId.get(agent(0).id)!['due_now']);
    expect(body.pool).toMatchObject({ total: 0, due_now: 0 });

    const invalid = await call(app(), 'GET', `/proxy/agency/campaigns/${A()}/assignments/progress?absent_after_minutes=0`, sup(), floor);
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().code).toBe('assignment_invalid');
  });

  it('history: a contact\'s owners, newest first; a contact of another campaign is 404', async () => {
    const res = await call(app(), 'GET', `/proxy/agency/campaigns/${A()}/contacts/${contacts[0]}/assignments`, sup(), floor);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().contact_id).toBe(contacts[0]);
    expect(res.json().events[0]).toMatchObject({ from_user_id: null, reason: 'random_split', actor_user_id: sup().id });

    const other = await call(app(), 'GET', `/proxy/agency/campaigns/${floor.campaigns[1]}/contacts/${contacts[0]}/assignments`, sup(), floor);
    expect(other.statusCode).toBe(404);
    expect(other.json().code).toBe('contact_not_found');
    const malformed = await call(app(), 'GET', `/proxy/agency/campaigns/${A()}/contacts/nope/assignments`, sup(), floor);
    expect(malformed.statusCode).toBe(404);
  });
});

describe('the agent\'s own contacts', () => {
  it('an agent sees only their own contacts, paged in due order, and finds nobody else\'s by phone', async () => {
    const mine = new Set<string>();
    let cursor: string | null = null;
    do {
      const url: string = `/proxy/agency/my-contacts?campaign_id=${A()}&limit=7${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const res = await call(app(), 'GET', url, agent(0), floor);
      expect(res.statusCode, res.body).toBe(200);
      for (const row of res.json().rows) {
        expect(mine.has(row.id)).toBe(false);
        mine.add(row.id);
      }
      cursor = res.json().next_cursor;
    } while (cursor);
    const { rows } = await getTestPool().query<{ id: string }>(
      'SELECT id FROM agency_contacts WHERE campaign_id = $1 AND assigned_user_id = $2', [A(), agent(0).id]);
    expect([...mine].sort()).toEqual(rows.map((r) => r.id).sort());

    const { rows: theirs } = await getTestPool().query<{ phone: string }>(
      'SELECT phone_e164 AS phone FROM agency_contacts WHERE campaign_id = $1 AND assigned_user_id = $2 LIMIT 1', [A(), agent(1).id]);
    const search = await call(app(), 'GET', `/proxy/agency/my-contacts?campaign_id=${A()}&phone=${encodeURIComponent(theirs[0]!.phone)}`, agent(0), floor);
    expect(search.statusCode).toBe(200);
    expect(search.json().rows).toEqual([]);
  });

  it('a row carries the hero columns minus hidden ones, the bucket and the retry block; q searches the hero', async () => {
    const { rows } = await getTestPool().query<{ id: string; name: string }>(
      `SELECT id, context->>'Name' AS name FROM agency_contacts WHERE campaign_id = $1 AND assigned_user_id = $2 ORDER BY csv_line_number LIMIT 1`,
      [A(), agent(0).id]);
    const res = await call(app(), 'GET', `/proxy/agency/my-contacts?campaign_id=${A()}&q=${encodeURIComponent(rows[0]!.name.toUpperCase())}`, agent(0), floor);
    expect(res.statusCode, res.body).toBe(200);
    const row = res.json().rows.find((r: { id: string }) => r.id === rows[0]!.id);
    expect(row).toMatchObject({
      bucket: 'pending', hero: [{ name: 'Name', value: rows[0]!.name }],
      retry: { eligible: false, blocked: 'retry_disabled', rounds_used: 0, available_at: null }, override: null,
    });
    const byBucket = await call(app(), 'GET', `/proxy/agency/my-contacts?campaign_id=${A()}&bucket=reached`, agent(0), floor);
    expect(byBucket.json().rows).toEqual([]);
    const badBucket = await call(app(), 'GET', `/proxy/agency/my-contacts?campaign_id=${A()}&bucket=nope`, agent(0), floor);
    expect(badBucket.statusCode).toBe(400);
  });

  it('the summary counts the caller\'s own contacts; unstaffed is 403, another tenant\'s campaign 404', async () => {
    const res = await call(app(), 'GET', `/proxy/agency/my-contacts/summary?campaign_id=${A()}`, agent(0), floor);
    expect(res.statusCode, res.body).toBe(200);
    const total = await ownedBy(agent(0).id);
    expect(res.json()).toMatchObject({
      campaign_id: A(), assignment_mode: 'pool', total, due_now: total, unassigned_open: 0,
      counts: { pending: total }, queue: { due: true, reason: null },
      retry: { allowed: false, rounds: 1, cooldown_minutes: 30, eligible: 0 },
    });

    const unstaffed = await call(app(), 'GET', `/proxy/agency/my-contacts/summary?campaign_id=${A()}`, agent(2), floor);
    expect(unstaffed.statusCode).toBe(403);
    expect(unstaffed.json().code).toBe('not_staffed');
    // A supervisor-role caller is not special: these are their OWN contacts.
    const asSupervisor = await call(app(), 'GET', `/proxy/agency/my-contacts?campaign_id=${A()}`, sup(), floor);
    expect(asSupervisor.statusCode).toBe(403);
    const foreign = await call(app(), 'GET', `/proxy/agency/my-contacts?campaign_id=${floors[1]!.campaigns[0]}`, agent(0), floor);
    expect(foreign.statusCode).toBe(404);
  });
});

describe('the roster', () => {
  it('filters by owner and the pool; refuses a bad value; the CSV carries the owner', async () => {
    const mine = await call(app(), 'GET', `/proxy/agency/campaigns/${A()}/contacts?assigned_to=${agent(0).id}&limit=500`, sup(), floor);
    expect(mine.statusCode, mine.body).toBe(200);
    expect(mine.json().rows.length).toBe(await ownedBy(agent(0).id));
    expect(mine.json().rows.every((r: { assigned_user_id: string }) => r.assigned_user_id === agent(0).id)).toBe(true);

    const both = await call(app(), 'GET', `/proxy/agency/campaigns/${A()}/contacts?assigned_to=unassigned,${agent(1).id}&limit=500`, sup(), floor);
    expect(both.json().rows.length).toBe(await ownedBy(agent(1).id));

    const bad = await call(app(), 'GET', `/proxy/agency/campaigns/${A()}/contacts?assigned_to=bob`, sup(), floor);
    expect(bad.statusCode).toBe(400);

    const csv = await call(app(), 'GET', `/proxy/agency/campaigns/${A()}/contacts.csv?assigned_to=${agent(0).id}&preamble=false`, sup(), floor);
    expect(csv.statusCode, csv.body.slice(0, 300)).toBe(200);
    const lines = csv.body.trim().split('\n');
    expect(lines[0]!.trim().endsWith('assigned_user_id,assigned_to,assigned_at')).toBe(true);
    expect(lines.length - 1).toBe(await ownedBy(agent(0).id));
    expect(lines[1]).toContain(`${agent(0).id},agent 0.0,`);
  });
});

describe('unstaff (D6) on all three paths', () => {
  async function events(reason: string, userId: string) {
    const { rows } = await getTestPool().query<{ n: number; actor: string | null }>(
      `SELECT count(*)::int AS n, min(actor_user_id::text) AS actor FROM agency_contact_assignment_events
        WHERE reason = $1 AND from_user_id = $2`, [reason, userId]);
    return rows[0]!;
  }

  it('a supervisor\'s DELETE returns the open contacts to the pool, never a live one, audited per campaign', async () => {
    const held = await ownedBy(agent(1).id);
    expect(held).toBeGreaterThan(1);
    await getTestPool().query(
      `UPDATE agency_contacts SET state = 'connected' WHERE id = (
         SELECT id FROM agency_contacts WHERE campaign_id = $1 AND assigned_user_id = $2 ORDER BY csv_line_number LIMIT 1)`,
      [A(), agent(1).id]);
    const res = await call(app(), 'DELETE', `/proxy/agency/campaigns/${A()}/agents/${agent(1).id}`, sup(), floor);
    expect(res.statusCode).toBe(204);
    expect(await ownedBy(agent(1).id)).toBe(1);
    expect(await events('unstaffed', agent(1).id)).toEqual({ n: held - 1, actor: sup().id });
    const rows = await audits('agency_contacts.unassigned_on_unstaff');
    expect(rows.at(-1)).toMatchObject({ campaign_id: A(), account_id: floor.account, actor_type: 'human' });
    expect(rows.at(-1)!.details).toMatchObject({ user_id: agent(1).id, moved: held - 1, skipped_live: 1, kept: false, cause: 'unstaffed' });
  });

  it('a tenant admin removing the membership returns them (keep campaigns keep them, audited kept)', async () => {
    // Agent 2 on campaign A (return_to_pool) and campaign B (keep).
    await staff(agent(2));
    await staff(agent(2), floor.campaigns[1]!);
    await getTestPool().query(`UPDATE agency_campaigns SET on_unstaff = 'keep' WHERE id = $1`, [floor.campaigns[1]]);
    const b = await seedContacts(floor.campaigns[1]!, 3, floor, '+91700');
    await getTestPool().query(`UPDATE agency_contacts SET assigned_user_id = $2, assigned_at = now() WHERE id = ANY($1::uuid[])`, [b, agent(2).id]);
    await assign({ kind: 'count', agent_user_id: agent(2).id, count: 4 });
    expect(await ownedBy(agent(2).id)).toBe(4);

    const admin = await tenantAdmin();
    const res = await call(app(), 'DELETE', `/users/${agent(2).id}/membership`, admin, floor);
    expect(res.statusCode, res.body).toBeLessThan(300);
    expect(await ownedBy(agent(2).id)).toBe(0);
    expect(await ownedBy(agent(2).id, floor.campaigns[1]!)).toBe(3);
    expect(await events('unstaffed', agent(2).id)).toEqual({ n: 4, actor: null });
    const rows = (await audits('agency_contacts.unassigned_on_unstaff')).filter((r) => r.details['user_id'] === agent(2).id);
    expect(rows.map((r) => ({ c: r.campaign_id, moved: r.details['moved'], kept: r.details['kept'], cause: r.details['cause'] })).sort((x, y) => x.c.localeCompare(y.c)))
      .toEqual([
        { c: A(), moved: 4, kept: false, cause: 'membership_removed' },
        { c: floor.campaigns[1]!, moved: 0, kept: true, cause: 'membership_removed' },
      ].sort((x, y) => x.c.localeCompare(y.c)));
  });

  it('a super admin revoking the membership returns them, audited as the system', async () => {
    await staff(agent(3));
    await assign({ kind: 'count', agent_user_id: agent(3).id, count: 2 });
    expect(await ownedBy(agent(3).id)).toBe(2);
    const { rows: m } = await getTestPool().query<{ id: string }>('SELECT id FROM memberships WHERE user_id = $1 AND tenant_id = $2', [agent(3).id, floor.tenant]);
    const token = await superAdminToken();
    const res = await app().inject({
      method: 'DELETE', url: `/super-admin/tenants/${floor.tenant}/memberships/${m[0]!.id}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode, res.body).toBeLessThan(300);
    expect(await ownedBy(agent(3).id)).toBe(0);
    expect(await events('unstaffed', agent(3).id)).toEqual({ n: 2, actor: null });
    const rows = (await audits('agency_contacts.unassigned_on_unstaff')).filter((r) => r.details['user_id'] === agent(3).id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor_type: 'system', account_id: floor.account });
    expect(rows[0]!.details).toMatchObject({ moved: 2, via: 'super_admin', cause: 'membership_removed' });
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
