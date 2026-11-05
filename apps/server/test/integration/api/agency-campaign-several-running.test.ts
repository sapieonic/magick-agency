import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

/**
 * Several running campaigns per account (docs/decisions.md, MC6), through the REAL app
 * (`buildApp`) on real Postgres, the way the console sends it: the public
 * `/proxy/agency/campaigns/:id/{start,pause,resume}` routes, session middleware (Firebase's
 * token check is the one stub), tenancy, RBAC, `callCore` and the internal lifecycle handler.
 *
 * Pinned here:
 *  - Start of a second campaign of an account while the first is `running` is a 200, and both
 *    are `running` (migration 0015 dropped `uq_agency_campaign_running`; Start no longer
 *    answers 409 `another_campaign_running`);
 *  - Resume of a paused campaign while another of the account runs is a 200 too;
 *  - the status guard still refuses what it refused: a second Start of a running campaign is
 *    409 `invalid_campaign_transition`.
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
  // account_admin holds `agency.supervise`, the lifecycle routes' permission.
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

const control = (id: string, op: 'start' | 'pause' | 'resume') =>
  app.inject({ method: 'POST', url: `/proxy/agency/campaigns/${id}/${op}`, headers: headers(), payload: {} });

/** A campaign of this account at `status`, with a dialable roster so `/start` is not refused for want of one. */
async function campaignAt(status: string, name: string): Promise<string> {
  const row = await insertAgencyCampaign({ tenant_id: w.tenant, account_id: w.account, status, name });
  await insertAgencyContact(row.id as string, { tenant_id: w.tenant, account_id: w.account });
  return row.id as string;
}

async function runningOnAccount(): Promise<string[]> {
  const { rows } = await getTestPool().query<{ name: string }>(
    `SELECT name FROM agency_campaigns WHERE tenant_id = $1 AND account_id = $2 AND status = 'running' ORDER BY name`,
    [w.tenant, w.account]);
  return rows.map((r) => r.name);
}

describe('several running campaigns on one account (MC6)', () => {
  it('Start of a second campaign while the first runs: 200, both running', async () => {
    const first = await campaignAt('draft', 'A first');
    const second = await campaignAt('draft', 'B second');

    const a = await control(first, 'start');
    expect(a.statusCode, a.body).toBe(200);
    expect(a.json().status).toBe('running');

    const b = await control(second, 'start');
    expect(b.statusCode, b.body).toBe(200);
    expect(b.json().status).toBe('running');

    expect(await runningOnAccount()).toEqual(['A first', 'B second']);
  });

  it('Resume of a paused campaign while another runs: 200, both running', async () => {
    await campaignAt('running', 'A running');
    const paused = await campaignAt('draft', 'B paused');
    expect((await control(paused, 'start')).statusCode).toBe(200);
    const pause = await control(paused, 'pause');
    expect(pause.statusCode, pause.body).toBe(200);
    expect(await runningOnAccount()).toEqual(['A running']);

    const resume = await control(paused, 'resume');
    expect(resume.statusCode, resume.body).toBe(200);
    expect(resume.json().status).toBe('running');
    expect(await runningOnAccount()).toEqual(['A running', 'B paused']);
  });

  it('the status guard still answers: a second Start of a running campaign is 409 invalid_campaign_transition', async () => {
    await campaignAt('running', 'A running');
    const b = await campaignAt('running', 'B running');
    const again = await control(b, 'start');
    expect(again.statusCode, again.body).toBe(409);
    expect(again.json()).toMatchObject({ code: 'invalid_campaign_transition', current_status: 'running' });
    expect(await runningOnAccount()).toEqual(['A running', 'B running']);
  });
});
