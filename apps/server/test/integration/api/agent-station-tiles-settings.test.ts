import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The agent station's tile pictures (BE-13) and number display (AS9) as a supervisor sets them and
 * an agent is sent them, through the REAL app (`buildApp` with a real context: the agency runtime,
 * Redis, Postgres; Firebase's token check is the one stub): the public `/proxy/agency/campaigns`
 * routes and the session bootstrap (`POST /proxy/agency/sessions`), `callCore`, the internal
 * handlers and the repositories.
 *
 * Pinned here:
 *  - `phone_display`: `full` by default; PATCH stores `masked` on a running campaign, GET serves it,
 *    the change is audited with its values; a create can set it; anything else is a 400 naming the
 *    field, at the public layer and the internal handler alike, and nothing is written.
 *  - icons: an outcome's and a break reason's `icon` from the contract's list is stored and served;
 *    an unknown one, or `null`, is a 400 naming the entry, nothing written.
 *  - the bootstrap: `phone_display` as the campaign has it, and every icon it carries known (a
 *    stray stored icon dropped from the outcome and the break reason, the known ones kept).
 */

const mocks = vi.hoisted(() => {
  process.env['SUPER_ADMIN_JWT_SECRET'] = 'station-tiles-settings-secret-0123456789';
  return { verifyIdToken: vi.fn() };
});

vi.mock('../../../src/auth/firebase.js', () => ({
  initFirebase: vi.fn(),
  verifyIdToken: mocks.verifyIdToken,
}));

import type { FastifyInstance } from 'fastify';
import { closePool, getPool, initDbPool } from '@magick-agency/db';
import { TEST_DB_URL, closeTestPool, getTestPool, truncateAll } from '../../../../../packages/db/test/helpers/test-db.js';
import {
  insertAccount,
  insertMembership,
  insertTenant,
  insertUser,
} from '../../../../../packages/db/test/integration/setup/platform-factories.js';
import { closeTestRedis, flushTestRedis, getTestRedis } from '../../helpers/test-redis.js';
import { insertAgencyCampaign } from '../agency/agency-factories.js';
import { config } from '../../../src/config/index.js';
import { buildApp } from '../../../src/app.js';
import type { AppContext } from '../../../src/app-context.js';
import { resetAgencyRuntimeForTests } from '../../../src/bootstrap/agency.js';
import { resetVoiceEngineForTests } from '../../../src/bootstrap/voice.js';
import { platformAuditLogger } from '../../../src/audit/platform/audit-logger.js';
import { callCore } from '../../../src/api/core-dispatch.js';

let app: FastifyInstance;
let w: { tenant: string; account: string; supervisor: string; agent: { id: string; tok: string } };

beforeAll(async () => {
  initDbPool({ url: TEST_DB_URL, poolMin: 0, poolMax: 6 });
  mocks.verifyIdToken.mockImplementation(async (token: string) => {
    if (!token.startsWith('tok:')) throw new Error('bad token');
    return { uid: token.slice(4), email: `${token.slice(4)}@example.com`, email_verified: true };
  });
  await flushTestRedis();
  resetVoiceEngineForTests();
  await resetAgencyRuntimeForTests();
  const ctx: AppContext = { config, pool: getPool(), redis: getTestRedis() };
  app = await buildApp({ ctx });
  await app.ready();
});

beforeEach(async () => {
  await truncateAll();
  const tenant = (await insertTenant()).id as string;
  const account = (await insertAccount({ tenant_id: tenant })).id as string;
  await getTestPool().query(
    `INSERT INTO feature_flag_overrides (flag_key, scope_type, tenant_id, value) VALUES ('agency_dialer_enabled', 'tenant', $1, 'true'::jsonb)`,
    [tenant],
  );
  const sup = await insertUser({ display_name: 'Sam Supervisor' });
  await insertMembership({ user_id: sup.id, tenant_id: tenant, account_id: account, role: 'account_admin' });
  const agent = await insertUser();
  await insertMembership({ user_id: agent.id, tenant_id: tenant, account_id: account, role: 'agent' });
  w = { tenant, account, supervisor: `tok:${sup.firebase_uid as string}`, agent: { id: agent.id as string, tok: `tok:${agent.firebase_uid as string}` } };
});

afterAll(async () => {
  await app?.close();
  await resetAgencyRuntimeForTests();
  resetVoiceEngineForTests();
  await closePool();
  await closeTestPool();
  await closeTestRedis();
});

const headers = (tok = w.supervisor) => ({
  authorization: `Bearer ${tok}`, 'x-tenant-id': w.tenant, 'x-account-id': w.account, 'content-type': 'application/json',
});
const patch = (id: string, payload: Record<string, unknown>) =>
  app.inject({ method: 'PATCH', url: `/proxy/agency/campaigns/${id}`, headers: headers(), payload: JSON.stringify(payload) });
const read = (id: string) => app.inject({ method: 'GET', url: `/proxy/agency/campaigns/${id}`, headers: headers() });

async function campaign(extra: Record<string, unknown> = {}): Promise<string> {
  return (await insertAgencyCampaign({ tenant_id: w.tenant, account_id: w.account, status: 'running', ...extra })).id as string;
}

async function stored(id: string): Promise<{ phone_display: string; disposition_catalog: unknown; break_reasons: unknown }> {
  const { rows } = await getTestPool().query(
    'SELECT phone_display, disposition_catalog, break_reasons FROM agency_campaigns WHERE id = $1', [id]);
  return rows[0];
}

async function configChanges(campaignId: string): Promise<unknown[]> {
  await platformAuditLogger.flush();
  const { rows } = await getTestPool().query<{ details: unknown }>(
    `SELECT details FROM platform_audit_log WHERE action = 'agency_campaign.config_changed' AND campaign_id = $1 ORDER BY created_at`,
    [campaignId]);
  return rows.map((r) => r.details);
}

const CATALOG = [
  { code: 'will_pay', label: 'Will pay', is_success: true, icon: 'rupee' },
  { code: 'refused', label: 'Refused', terminal: true },
];
const BREAKS = [{ code: 'tea', label: 'Tea', limit_minutes: 15, icon: 'tea' }, { code: 'namaz', label: 'Prayer', icon: 'prayer' }];

describe('phone_display (AS9)', () => {
  it('full by default; PATCH stores masked on a running campaign, GET serves it, and the change is audited with its values', async () => {
    const id = await campaign();
    expect((await read(id)).json().phone_display).toBe('full');
    const res = await patch(id, { phone_display: 'masked' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ phone_display: 'masked', status: 'running' });
    expect((await stored(id)).phone_display).toBe('masked');
    expect((await read(id)).json().phone_display).toBe('masked');
    expect(await configChanges(id)).toEqual([
      expect.objectContaining({ fields: ['phone_display'], changes: { phone_display: { from: 'full', to: 'masked' } } }),
    ]);
  });

  it('a create sets it; omitted, it is full', async () => {
    for (const [sent, want] of [['masked', 'masked'], [undefined, 'full']] as const) {
      const res = await app.inject({
        method: 'POST', url: '/proxy/agency/campaigns', headers: headers(),
        payload: JSON.stringify({ name: `Dues ${want}`, caller_ids: ['+919000000001'], ...(sent ? { phone_display: sent } : {}) }),
      });
      expect(res.statusCode, res.body).toBe(201);
      expect(res.json().phone_display).toBe(want);
      expect((await stored(res.json().id)).phone_display).toBe(want);
    }
  });

  it('anything else is a 400 naming the field, at the public layer and the internal handler; nothing written', async () => {
    // FALSIFIED: with `phoneDisplayIssues` out of both validators, the column's CHECK refuses the
    // write instead (a 500 or a bare 400 without the field) and this reds.
    const id = await campaign();
    for (const value of ['hidden', null, 1, 'MASKED']) {
      const res = await patch(id, { phone_display: value });
      expect([res.statusCode, Object.keys(res.json().details ?? {})], JSON.stringify(value)).toEqual([400, ['phone_display']]);
      const internal = await callCore({
        method: 'PATCH', path: `/agency-campaigns/${id}`, tenantId: w.tenant, accountId: w.account, body: { phone_display: value },
      });
      expect([internal.status, Object.keys((internal.body as { details?: object }).details ?? {})], `internal ${JSON.stringify(value)}`)
        .toEqual([400, ['phone_display']]);
    }
    expect((await stored(id)).phone_display).toBe('full');
  });
});

describe('tile icons (BE-13)', () => {
  it('an outcome\'s and a break reason\'s icon from the list is stored and served', async () => {
    const id = await campaign();
    const res = await patch(id, { disposition_catalog: CATALOG, break_reasons: BREAKS });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ disposition_catalog: CATALOG, break_reasons: BREAKS });
    expect(await stored(id)).toMatchObject({ disposition_catalog: CATALOG, break_reasons: BREAKS });
  });

  it('an unknown icon, or null, is a 400 naming the entry; nothing written', async () => {
    // FALSIFIED: with `tileIconIssues` out of the validators, these PATCHes store the icon (200).
    const id = await campaign();
    const before = await stored(id);
    for (const [body, field] of [
      [{ disposition_catalog: [CATALOG[0], { ...CATALOG[1], icon: 'skull' }] }, 'disposition_catalog[1].icon'],
      [{ disposition_catalog: [{ ...CATALOG[0], icon: null }] }, 'disposition_catalog[0].icon'],
      [{ break_reasons: [{ code: 'tea', label: 'Tea', icon: 'coffee' }] }, 'break_reasons[0].icon'],
    ] as const) {
      const res = await patch(id, body as Record<string, unknown>);
      expect(res.statusCode, field).toBe(400);
      expect(res.json().details, field).toHaveProperty([field]);
      const internal = await callCore({
        method: 'PATCH', path: `/agency-campaigns/${id}`, tenantId: w.tenant, accountId: w.account, body,
      });
      expect(internal.status, `internal ${field}`).toBe(400);
      expect((internal.body as { details: object }).details, `internal ${field}`).toHaveProperty([field]);
    }
    expect(await stored(id)).toEqual(before);
  });
});

describe('the session bootstrap', () => {
  async function join(campaignId: string) {
    await getTestPool().query(
      'INSERT INTO agency_campaign_agents (tenant_id, account_id, campaign_id, user_id) VALUES ($1, $2, $3, $4)',
      [w.tenant, w.account, campaignId, w.agent.id]);
    const res = await app.inject({
      method: 'POST', url: '/proxy/agency/sessions', headers: headers(w.agent.tok), payload: JSON.stringify({ campaign_id: campaignId }),
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json();
  }

  it('carries phone_display as the campaign has it, and only icons the contract lists (a stray stored one dropped)', async () => {
    // FALSIFIED: with the bootstrap sending the catalog as stored, the stray `skull` reaches the
    // agent and this reds; with `withKnownIcon` out of `resolveBreakReasons`, the `coffee` does.
    const id = await campaign({
      phone_display: 'masked',
      // As a catalog written before the rule could hold them: stored straight into the row.
      disposition_catalog: JSON.stringify([CATALOG[0], { ...CATALOG[1], icon: 'skull' }]),
      break_reasons: JSON.stringify([BREAKS[0], { code: 'namaz', label: 'Prayer', icon: 'coffee' }]),
    });
    const body = await join(id);
    expect(body.phone_display).toBe('masked');
    expect(body.disposition_catalog).toEqual([CATALOG[0], CATALOG[1]]);
    expect(body.break_reasons).toEqual([BREAKS[0], { code: 'namaz', label: 'Prayer' }]);
  });

  it('a campaign that never set it: full', async () => {
    const body = await join(await campaign());
    expect(body.phone_display).toBe('full');
  });
});
