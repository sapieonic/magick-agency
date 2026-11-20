import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

/**
 * The agent station's daily target (BE-2, AS6) as a supervisor sets it, and the station settings a
 * campaign is created with and a retry copies, through the REAL app (`buildApp`) on real Postgres:
 * the public `/proxy/agency/campaigns` routes, session middleware (Firebase's token check is the
 * one stub), tenancy, RBAC, `callCore`, the internal handlers and the repositories.
 *
 * Pinned here:
 *  - PATCH `daily_target_calls` on a running campaign: stored, served, audited with `{ from, to }`;
 *    `null` clears it; 0, 2001, 12.5 and a string are 400s naming the field, nothing written.
 *  - POST stores `daily_target_calls`, `phone_display` and `agent_script` (trimmed) when given, the
 *    column defaults when not; a bad display or script is a 400.
 *  - A retry campaign copies all three from its parent.
 */

const mocks = vi.hoisted(() => ({ verifyIdToken: vi.fn() }));

vi.mock('../../../src/auth/firebase.js', () => ({
  initFirebase: vi.fn(),
  verifyIdToken: mocks.verifyIdToken,
}));

import { closePool, initDbPool } from '@magick-agency/db';
import { TEST_DB_URL, closeTestPool, getTestPool, truncateAll } from '../../../../../packages/db/test/helpers/test-db.js';
import {
  insertAccount,
  insertMembership,
  insertTenant,
  insertUser,
} from '../../../../../packages/db/test/integration/setup/platform-factories.js';
import { insertAgencyCampaign, insertAgencyContact } from '../agency/agency-factories.js';
import { buildApp } from '../../../src/app.js';
import { platformAuditLogger } from '../../../src/audit/platform/audit-logger.js';

initDbPool({ url: TEST_DB_URL, poolMin: 0, poolMax: 4 });

let app: FastifyInstance;
let w: { tenant: string; account: string; uid: string };

beforeAll(async () => {
  mocks.verifyIdToken.mockImplementation(async (token: string) => {
    if (token.startsWith('tok:')) return { uid: token.slice(4), email: `${token.slice(4)}@example.com`, email_verified: true };
    throw new Error('bad token');
  });
  app = await buildApp({ ctx: null });
  await app.ready();
});

beforeEach(async () => {
  await truncateAll();
  const tenant = await insertTenant();
  const account = await insertAccount({ tenant_id: tenant.id });
  const user = await insertUser({ display_name: 'Sam Supervisor' });
  await insertMembership({ user_id: user.id, tenant_id: tenant.id, account_id: account.id, role: 'account_admin' });
  await getTestPool().query(
    `INSERT INTO feature_flag_overrides (flag_key, scope_type, tenant_id, value)
     VALUES ('agency_dialer_enabled', 'tenant', $1, 'true'::jsonb)`,
    [tenant.id],
  );
  w = { tenant: tenant.id, account: account.id, uid: user.firebase_uid };
});

afterAll(async () => {
  await app?.close();
  await closePool();
  await closeTestPool();
});

function headers(): Record<string, string> {
  return { authorization: `Bearer tok:${w.uid}`, 'x-tenant-id': w.tenant, 'x-account-id': w.account };
}

const patch = (id: string, payload: Record<string, unknown>) =>
  app.inject({ method: 'PATCH', url: `/proxy/agency/campaigns/${id}`, headers: headers(), payload });
const read = (id: string) => app.inject({ method: 'GET', url: `/proxy/agency/campaigns/${id}`, headers: headers() });
const create = (payload: Record<string, unknown>) =>
  app.inject({ method: 'POST', url: '/proxy/agency/campaigns', headers: headers(), payload: { name: 'Dues', caller_ids: ['+919000000001'], ...payload } });

async function stored(id: string): Promise<{ daily_target_calls: number | null; phone_display: string; agent_script: unknown }> {
  const { rows } = await getTestPool().query('SELECT daily_target_calls, phone_display, agent_script FROM agency_campaigns WHERE id = $1', [id]);
  return rows[0];
}

async function configChanges(campaignId: string): Promise<Array<{ fields: unknown; changes: unknown }>> {
  await platformAuditLogger.shutdown();
  const { rows } = await getTestPool().query<{ details: { fields: unknown; changes: unknown } }>(
    `SELECT details FROM platform_audit_log
      WHERE action = 'agency_campaign.config_changed' AND campaign_id = $1 ORDER BY created_at`,
    [campaignId],
  );
  return rows.map((r) => ({ fields: r.details.fields, changes: r.details.changes }));
}

async function campaignAt(status: string, extra: Record<string, unknown> = {}): Promise<string> {
  const row = await insertAgencyCampaign({ tenant_id: w.tenant, account_id: w.account, status, ...extra });
  return row.id as string;
}

describe('PATCH /proxy/agency/campaigns/:id — daily_target_calls (BE-2)', () => {
  it('sets it on a running campaign, GET serves it, and the change is audited from and to', async () => {
    const id = await campaignAt('running');
    expect((await read(id)).json().daily_target_calls).toBeNull();

    const res = await patch(id, { daily_target_calls: 80 });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ daily_target_calls: 80, status: 'running' });
    expect((await stored(id)).daily_target_calls).toBe(80);
    expect((await read(id)).json().daily_target_calls).toBe(80);
    expect(await configChanges(id)).toEqual([
      { fields: ['daily_target_calls'], changes: { daily_target_calls: { from: null, to: 80 } } },
    ]);
  });

  it('null clears it (no target, not zero)', async () => {
    const id = await campaignAt('paused', { daily_target_calls: 60 });
    const res = await patch(id, { daily_target_calls: null });
    expect(res.statusCode, res.body).toBe(200);
    expect((await stored(id)).daily_target_calls).toBeNull();
    expect(await configChanges(id)).toEqual([
      { fields: ['daily_target_calls'], changes: { daily_target_calls: { from: 60, to: null } } },
    ]);
  });

  it.each([0, 2001, 12.5, '80'])('refuses %j with a 400 naming the field, and writes nothing', async (value) => {
    const id = await campaignAt('running', { daily_target_calls: 40 });
    const res = await patch(id, { daily_target_calls: value });
    expect(res.statusCode, res.body).toBe(400);
    expect(JSON.stringify(res.json())).toContain('daily_target_calls');
    expect((await stored(id)).daily_target_calls).toBe(40);
  });

  it('the bounds are the contract\'s: 1 and 2000 are taken', async () => {
    const id = await campaignAt('running');
    expect((await patch(id, { daily_target_calls: 1 })).statusCode).toBe(200);
    expect((await patch(id, { daily_target_calls: 2000 })).statusCode).toBe(200);
    expect((await stored(id)).daily_target_calls).toBe(2000);
  });
});

describe('POST /proxy/agency/campaigns — the station settings on create', () => {
  it('stores the target, the number display and the script (trimmed) when given', async () => {
    const res = await create({
      daily_target_calls: 120,
      phone_display: 'masked',
      agent_script: { opening: '  Namaste {name}.  ', steps: [{ text: ' Ask when they can pay. ' }] },
    });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json()).toMatchObject({ daily_target_calls: 120, phone_display: 'masked' });
    expect(await stored(res.json().id)).toEqual({
      daily_target_calls: 120, phone_display: 'masked',
      agent_script: { opening: 'Namaste {name}.', steps: [{ text: 'Ask when they can pay.' }] },
    });
  });

  it('the column defaults when not given: no target, the full number, no script', async () => {
    const res = await create({});
    expect(res.statusCode, res.body).toBe(201);
    expect(await stored(res.json().id)).toEqual({ daily_target_calls: null, phone_display: 'full', agent_script: {} });
  });

  it.each([
    ['a target out of bounds', { daily_target_calls: 0 }, 'daily_target_calls'],
    ['an unknown number display', { phone_display: 'hidden' }, 'phone_display'],
    ['a script with an unknown placeholder', { agent_script: { opening: 'Hello {nickname}' } }, 'agent_script'],
  ])('refuses %s with a 400 naming the field, and creates nothing', async (_label, payload, field) => {
    const res = await create(payload);
    expect(res.statusCode, res.body).toBe(400);
    expect(JSON.stringify(res.json())).toContain(field);
    const { rows } = await getTestPool().query('SELECT count(*)::int AS n FROM agency_campaigns WHERE tenant_id = $1', [w.tenant]);
    expect(rows[0].n).toBe(0);
  });
});

describe('POST /proxy/agency/campaigns/:id/retry — the child copies the station settings', () => {
  it('the parent\'s target, number display and script', async () => {
    const script = { opening: 'Namaste {name}.', steps: [{ text: 'Ask when they can pay.' }] };
    const parent = await campaignAt('completed', {
      daily_target_calls: 75, phone_display: 'masked', agent_script: JSON.stringify(script),
    });
    await insertAgencyContact(parent, {
      tenant_id: w.tenant, account_id: w.account, phone_e164: '+919000000002',
      state: 'completed', last_outcome: 'no_answer', attempt_count: 1,
    });
    const res = await app.inject({
      method: 'POST', url: `/proxy/agency/campaigns/${parent}/retry`, headers: headers(),
      payload: { selector: { last_outcome: ['no_answer'] } },
    });
    expect(res.statusCode, res.body).toBe(201);
    const child = (res.json() as { campaign: { id: string } }).campaign.id;
    expect(await stored(child)).toEqual({ daily_target_calls: 75, phone_display: 'masked', agent_script: script });
  });

  it('a parent with none: the child has none', async () => {
    const parent = await campaignAt('completed');
    await insertAgencyContact(parent, {
      tenant_id: w.tenant, account_id: w.account, phone_e164: '+919000000003',
      state: 'completed', last_outcome: 'no_answer', attempt_count: 1,
    });
    const res = await app.inject({
      method: 'POST', url: `/proxy/agency/campaigns/${parent}/retry`, headers: headers(),
      payload: { selector: { last_outcome: ['no_answer'] } },
    });
    expect(res.statusCode, res.body).toBe(201);
    expect(await stored((res.json() as { campaign: { id: string } }).campaign.id))
      .toEqual({ daily_target_calls: null, phone_display: 'full', agent_script: {} });
  });
});
