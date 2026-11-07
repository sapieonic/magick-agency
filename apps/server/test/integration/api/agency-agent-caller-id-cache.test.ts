import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';

/**
 * ─── The dial paths' cached dedications, invalidated by the real writes (DN4) ──────────
 *
 * The runtime's `DedicatedCallerIdCache` (`agency/pacing/dedicated-caller-ids.ts`), armed as
 * its pacing engine arms it when it leads a campaign (subscribed to the process's invalidation
 * bus), is the one every dial path in the process reads. Each write that changes the effective
 * map must publish `dedications_changed` after it commits, or a dial uses a released number (or
 * misses a new one) for up to the TTL. Driven through the real app and real Postgres: the
 * supervisor's PUT and DELETE, and every staffing close (`EFFECTIVE_DEDICATION_SQL`: a
 * dedication stops counting when its staffing row closes): a supervisor removing the agent, a
 * tenant admin removing the membership (every campaign at once), a super admin revoking it.
 *
 * Each case first proves the map is CACHED (a raw write, which publishes nothing, is not seen),
 * so a fresh answer after a route is the event's doing and not a read-through.
 *
 * Mutation-checked: removing the publish from `AgencyAgentCallerIdRepository.set` reds "a PUT";
 * from `.clear` reds "a DELETE"; from `returnContactsOnUnstaff` reds the three staffing closes.
 */

const mocks = vi.hoisted(() => {
  process.env['SUPER_ADMIN_JWT_SECRET'] = 'agent-caller-id-cache-secret-0123456789';
  return { verifyIdToken: vi.fn() };
});
vi.mock('../../../src/auth/firebase.js', () => ({ initFirebase: vi.fn(), verifyIdToken: mocks.verifyIdToken }));

import { getTestPool, truncateAll } from '../../../../../packages/db/test/helpers/test-db.js';
import {
  call, seedFloor, startLoadApp, stopLoadApp, verifyTestToken,
  type Actor, type LoadApp, type TenantFloor,
} from '../load/load-harness.js';
import { getAgencyRuntime } from '../../../src/bootstrap/agency.js';
import type { DedicatedCallerIdCache } from '../../../src/agency/pacing/dedicated-caller-ids.js';
import type { PacingEngine } from '../../../src/agency/pacing-engine.js';

let loaded: LoadApp;
let floor: TenantFloor;
let engine: PacingEngine;
let cache: DedicatedCallerIdCache;
const app = () => loaded.app;
const sup = () => floor.supervisors[0]!;
const A = () => floor.campaigns[0]!;
const B = () => floor.campaigns[1]!;
const agent = (i: number) => floor.agents[i]!;

const X = '+918041000001';
const Y = '+918041000002';
const Z = '+918041000003';
const POOL = [X, Y, Z];

const agentUrl = (userId: string, c = A()) => `/proxy/agency/campaigns/${c}/agents/${userId}/caller-id`;

async function put(userId: string, callerId: string, c = A()): Promise<void> {
  const res = await call(app(), 'PUT', agentUrl(userId, c), sup(), floor, { caller_id: callerId });
  expect(res.statusCode, res.body).toBe(200);
}

async function staff(a: Actor, campaignId = A()): Promise<void> {
  const res = await call(app(), 'POST', `/proxy/agency/campaigns/${campaignId}/agents`, sup(), floor, { user_id: a.id });
  expect(res.statusCode, res.body).toBe(201);
}

/** What a dial path would use now: the runtime's cached map. */
async function cached(campaignId = A()): Promise<Record<string, string>> {
  return Object.fromEntries(await cache.read(campaignId));
}

/**
 * Proves `campaignId`'s map is served from the cache: a dedication written raw (no event) is
 * not seen, then removed raw again. Returns what the cache held.
 */
async function expectCached(campaignId = A()): Promise<Record<string, string>> {
  const before = await cached(campaignId);
  const ghost = floor.agents[5]!;
  await getTestPool().query(
    `INSERT INTO agency_campaign_agents (tenant_id, account_id, campaign_id, user_id, assigned_at)
     VALUES ($1, $2, $3, $4, now() - interval '1 minute')`,
    [floor.tenant, floor.account, campaignId, ghost.id]);
  await getTestPool().query(
    `INSERT INTO agency_campaign_agent_caller_ids (tenant_id, account_id, campaign_id, user_id, caller_id, set_at)
     VALUES ($1, $2, $3, $4, '+918041009999', clock_timestamp())`,
    [floor.tenant, floor.account, campaignId, ghost.id]);
  try {
    expect(await cached(campaignId)).toEqual(before);
  } finally {
    await getTestPool().query('DELETE FROM agency_campaign_agent_caller_ids WHERE campaign_id = $1 AND user_id = $2', [campaignId, ghost.id]);
    await getTestPool().query('DELETE FROM agency_campaign_agents WHERE campaign_id = $1 AND user_id = $2', [campaignId, ghost.id]);
  }
  return before;
}

beforeAll(async () => {
  mocks.verifyIdToken.mockImplementation(verifyTestToken);
  loaded = await startLoadApp();
  await truncateAll();
  floor = (await seedFloor({ tenants: 1, agentsPerTenant: 6, supervisorsPerTenant: 1, campaignsPerTenant: 2 }))[0]!;
  await getTestPool().query(
    `INSERT INTO feature_flag_overrides (flag_key, scope_type, tenant_id, value) VALUES ('agency_contact_assignment_enabled', 'tenant', $1, 'true'::jsonb)`,
    [floor.tenant],
  );
  await getTestPool().query('UPDATE agency_campaigns SET caller_ids = $2 WHERE id = ANY($1::uuid[])', [[A(), B()], POOL]);
  for (const i of [0, 1, 2, 3]) await staff(agent(i));
  await staff(agent(1), B());

  // The runtime's engine, armed as when it leads a campaign: subscribed to the process bus, its
  // cache (shared with the runtime's other dial paths) serving reads. No round timer.
  const runtime = getAgencyRuntime()!;
  engine = runtime.pacing;
  cache = runtime.dedications;
  expect(engine.dedications).toBe(cache);
  engine.setAutoRounds(false);
  (engine as unknown as { armRounds(): void }).armRounds();
  expect(cache.isArmed).toBe(true);
}, 120_000);

afterAll(async () => {
  (engine as unknown as { disarmRounds(): void } | undefined)?.disarmRounds();
  await stopLoadApp(loaded);
});

describe('the supervisor\'s writes', () => {
  it('a PUT is seen by the next read, and by the dial paths\' helper', async () => {
    expect(await expectCached()).toEqual({});
    await put(agent(0).id, X);
    expect(await cached()).toEqual({ [agent(0).id]: X });
    expect(await cache.callerIdForContact({ id: A(), caller_ids: POOL, tenant_id: 't', account_id: 'a', telephony_credential_id: null }, agent(0).id)).toBe(X);

    // Replacing the number: the same.
    expect(await expectCached()).toEqual({ [agent(0).id]: X });
    await put(agent(0).id, Z);
    expect(await cached()).toEqual({ [agent(0).id]: Z });
  });

  it('a DELETE is seen by the next read', async () => {
    expect(await expectCached()).toEqual({ [agent(0).id]: Z });
    const res = await call(app(), 'DELETE', agentUrl(agent(0).id), sup(), floor);
    expect(res.statusCode).toBe(204);
    expect(await cached()).toEqual({});
    expect(POOL).toContain(await cache.callerIdForContact({ id: A(), caller_ids: POOL, tenant_id: 't', account_id: 'a', telephony_credential_id: null }, agent(0).id));
  });
});

describe('every staffing close drops the agent\'s dedication from the cached map', () => {
  it('a supervisor removing the agent from the campaign', async () => {
    await put(agent(0).id, Z);
    await put(agent(2).id, Y);
    expect(await expectCached()).toEqual({ [agent(0).id]: Z, [agent(2).id]: Y });
    const res = await call(app(), 'DELETE', `/proxy/agency/campaigns/${A()}/agents/${agent(0).id}`, sup(), floor);
    expect(res.statusCode).toBe(204);
    expect(await cached()).toEqual({ [agent(2).id]: Y });
  });

  it('a tenant admin removing the membership: every campaign it closed', async () => {
    await put(agent(1).id, X);
    await put(agent(1).id, Z, B());
    expect(await expectCached()).toEqual({ [agent(1).id]: X, [agent(2).id]: Y });
    expect(await expectCached(B())).toEqual({ [agent(1).id]: Z });
    const admin = await tenantAdmin();
    const res = await call(app(), 'DELETE', `/users/${agent(1).id}/membership`, admin, floor);
    expect(res.statusCode, res.body).toBeLessThan(300);
    expect(await cached()).toEqual({ [agent(2).id]: Y });
    expect(await cached(B())).toEqual({});
  });

  it('a super admin revoking the membership', async () => {
    await put(agent(3).id, X);
    expect(await expectCached()).toEqual({ [agent(2).id]: Y, [agent(3).id]: X });
    const { rows: m } = await getTestPool().query<{ id: string }>(
      'SELECT id FROM memberships WHERE user_id = $1 AND tenant_id = $2', [agent(3).id, floor.tenant]);
    const token = await superAdminToken();
    const res = await app().inject({
      method: 'DELETE', url: `/super-admin/tenants/${floor.tenant}/memberships/${m[0]!.id}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode, res.body).toBeLessThan(300);
    expect(await cached()).toEqual({ [agent(2).id]: Y });
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
