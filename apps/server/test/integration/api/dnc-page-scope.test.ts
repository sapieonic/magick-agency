import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

/**
 * The Do Not Call page's scope choice (DS1–DS7), through the REAL app on real Postgres.
 *
 * `POST /dnc`, `GET /dnc` and `DELETE /dnc/:id` with the real session (Firebase's token check is
 * the one stub), tenant-context and RBAC middleware against real `memberships` rows, the real
 * repository, and then the real dial-time check (`DncRegistry.check`, B8) on the rows that landed.
 * So "added for one campaign" is shown to stop exactly that campaign's dials, not just to have
 * written a row with the right columns.
 *
 * The world: tenant T with accounts A1 and A2; campaigns C1 and C1done (completed) in A1, C2 in
 * A2; tenant U with campaign CU. Two people in T: a member of the whole organisation (`tenant`,
 * `tenant_admin` with no account) and an admin of A1 only (`a1admin`, `account_admin`).
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
import { insertAgencyCampaign } from '../agency/agency-factories.js';
import { buildApp } from '../../../src/app.js';
import { DncRegistry } from '../../../src/agency/dnc-registry.js';
import { platformAuditLogger } from '../../../src/audit/platform/audit-logger.js';

initDbPool({ url: TEST_DB_URL, poolMin: 0, poolMax: 4 });

let app: FastifyInstance;
const registry = new DncRegistry();

interface World {
  t: string; a1: string; a2: string; u: string;
  c1: string; c1done: string; c2: string; cu: string;
  tenantUid: string; a1adminUid: string; tenantUserId: string;
}
let w: World;

const PHONE = '+919811100001';
const PHONE2 = '+919811100002';

beforeAll(async () => {
  mocks.verifyIdToken.mockImplementation(async (token: string) => {
    if (token.startsWith('tok:')) return { uid: token.slice(4), email: 'dnc@example.com', email_verified: true };
    throw new Error('bad token');
  });
  app = await buildApp({ ctx: null });
  await app.ready();
});

beforeEach(async () => {
  await truncateAll();
  const t = await insertTenant();
  const a1 = await insertAccount({ tenant_id: t.id, name: 'North' });
  const a2 = await insertAccount({ tenant_id: t.id, name: 'South' });
  const u = await insertTenant();
  const ua = await insertAccount({ tenant_id: u.id });
  const tenantUser = await insertUser({ display_name: 'Org Admin' });
  const a1admin = await insertUser({ display_name: 'North Admin' });
  await insertMembership({ user_id: tenantUser.id, tenant_id: t.id, account_id: null, role: 'tenant_admin' });
  await insertMembership({ user_id: a1admin.id, tenant_id: t.id, account_id: a1.id, role: 'account_admin' });
  const c1 = await insertAgencyCampaign({ tenant_id: t.id, account_id: a1.id, name: 'Q4 Renewals' });
  const c1done = await insertAgencyCampaign({ tenant_id: t.id, account_id: a1.id, name: 'Q3 Renewals', status: 'completed' });
  const c2 = await insertAgencyCampaign({ tenant_id: t.id, account_id: a2.id, name: 'South SECRET' });
  const cu = await insertAgencyCampaign({ tenant_id: u.id, account_id: ua.id, name: 'Other tenant SECRET' });
  w = {
    t: t.id, a1: a1.id, a2: a2.id, u: u.id,
    c1: c1.id, c1done: c1done.id, c2: c2.id, cu: cu.id,
    tenantUid: tenantUser.firebase_uid, a1adminUid: a1admin.firebase_uid, tenantUserId: tenantUser.id,
  };
});

afterAll(async () => {
  await app?.close();
  await closePool();
  await closeTestPool();
});

type Who = 'tenant' | 'a1admin';

function headers(who: Who): Record<string, string> {
  return {
    authorization: `Bearer tok:${who === 'tenant' ? w.tenantUid : w.a1adminUid}`,
    'x-tenant-id': w.t,
    'x-account-id': w.a1,
  };
}

async function add(who: Who, body: Record<string, unknown>) {
  return app.inject({
    method: 'POST', url: '/dnc', headers: { ...headers(who), 'content-type': 'application/json' },
    payload: JSON.stringify({ phone_numbers: [PHONE], ...body }),
  });
}

async function list(who: Who, query = '') {
  const res = await app.inject({ method: 'GET', url: `/dnc${query}`, headers: headers(who) });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as { entries: Array<Record<string, unknown>>; total: number };
}

async function rows(): Promise<Array<{ id: string; account_id: string | null; campaign_id: string | null; phone_e164: string }>> {
  const { rows: r } = await getTestPool().query(
    `SELECT id, account_id, campaign_id, phone_e164 FROM dnc_entries WHERE tenant_id = $1 ORDER BY created_at, id`, [w.t],
  );
  return r;
}

/** Would a dial of `phone` on campaign `campaignId` (in `accountId`) be refused? The pacing gate's own call. */
async function blocked(campaignId: string, accountId: string, phone = PHONE): Promise<boolean> {
  return (await registry.check(w.t, phone, { accountId, campaignId })) === 'suppressed';
}

describe('adding for one campaign (DS2)', () => {
  it('an account admin adds for their campaign: one campaign row, named, and only that campaign stops dialling', async () => {
    const res = await add('a1admin', { scope: 'campaign', campaign_id: w.c1, reason: 'asked on a Q4 call' });

    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ added: 1, already_present: 0, already_covered: 0, invalid: 0 });
    expect(res.json().results[0]).toMatchObject({ outcome: 'added', campaign_id: w.c1, scope: 'campaign' });
    // Stored as the station's mark is: the campaign, no account.
    expect(await rows()).toMatchObject([{ account_id: null, campaign_id: w.c1, phone_e164: PHONE }]);

    expect(await blocked(w.c1, w.a1)).toBe(true);
    expect(await blocked(w.c1done, w.a1)).toBe(false);
    expect(await blocked(w.c2, w.a2)).toBe(false);

    // The list names it, for the person who added it and for the whole organisation.
    for (const who of ['a1admin', 'tenant'] as const) {
      const { entries } = await list(who);
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        scope: 'campaign', campaign_name: 'Q4 Renewals', account_name: 'North', scope_account_id: w.a1,
      });
    }
  });

  it('accepts a completed campaign: a number blocked there stays blocked if it runs again', async () => {
    const res = await add('a1admin', { scope: 'campaign', campaign_id: w.c1done });
    expect(res.statusCode).toBe(200);
    expect(await blocked(w.c1done, w.a1)).toBe(true);
    expect(await blocked(w.c1, w.a1)).toBe(false);
  });

  it("refuses another account's campaign, another tenant's and one that does not exist with one answer, writing nothing", async () => {
    const bodies = new Set<string>();
    for (const campaign of [w.c2, w.cu, '77777777-7777-4777-8777-777777777777']) {
      const res = await add('a1admin', { scope: 'campaign', campaign_id: campaign });
      expect(res.statusCode, campaign).toBe(404);
      expect(res.body).not.toContain('SECRET');
      bodies.add(res.body);
    }
    expect(bodies.size).toBe(1);
    // A member of the whole organisation reaches every account's campaigns, still not another tenant's.
    expect((await add('tenant', { scope: 'campaign', campaign_id: w.cu })).statusCode).toBe(404);
    expect(await rows()).toEqual([]);
  });

  it('the same number in two campaigns is two rows, each stopping its own campaign', async () => {
    expect((await add('a1admin', { scope: 'campaign', campaign_id: w.c1 })).statusCode).toBe(200);
    expect((await add('tenant', { scope: 'campaign', campaign_id: w.c2 })).statusCode).toBe(200);

    expect(await rows()).toHaveLength(2);
    expect(await blocked(w.c1, w.a1)).toBe(true);
    expect(await blocked(w.c2, w.a2)).toBe(true);
    expect(await blocked(w.c1done, w.a1)).toBe(false);
  });

  it('numbers written several ways are one number: one row, the copies already there, a local form refused', async () => {
    const res = await app.inject({
      method: 'POST', url: '/dnc', headers: { ...headers('a1admin'), 'content-type': 'application/json' },
      payload: JSON.stringify({
        scope: 'campaign', campaign_id: w.c1,
        phone_numbers: ['+91 98111 00001', '+91-98111-00001', '(+91) 9811100001', '+91.9811100001', '09811100001'],
      }),
    });
    expect(res.json()).toMatchObject({ added: 1, already_present: 3, already_covered: 0, invalid: 1 });
    expect(await rows()).toHaveLength(1);
  });

  it('audits the add on the campaign and its account, with no number in it', async () => {
    await add('a1admin', { scope: 'campaign', campaign_id: w.c1 });
    // The audit logger buffers; flush it as shutdown does.
    await platformAuditLogger.shutdown();
    await vi.waitFor(async () => {
      const { rows: audit } = await getTestPool().query(
        `SELECT account_id, campaign_id, details FROM platform_audit_log WHERE action = 'dnc_entry.created' AND tenant_id = $1`, [w.t],
      );
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ account_id: w.a1, campaign_id: w.c1 });
      expect(audit[0].details).toMatchObject({ scope: 'campaign', added: 1, already_covered: 0 });
      expect(JSON.stringify(audit[0])).not.toContain('9811100001');
    });
  });
});

describe('every campaign, and who may ask for it (DS3)', () => {
  it('an account admin is refused every campaign, stated or implied; the organisation admin is not', async () => {
    expect((await add('a1admin', { scope: 'tenant' })).statusCode).toBe(403);
    expect((await add('a1admin', {})).statusCode).toBe(403);
    expect(await rows()).toEqual([]);

    expect((await add('tenant', { scope: 'tenant' })).statusCode).toBe(200);
    expect(await blocked(w.c1, w.a1)).toBe(true);
    expect(await blocked(w.c2, w.a2)).toBe(true);
  });

  it('an account admin adds for their own account: every campaign of it stops, the other account\'s do not', async () => {
    const res = await add('a1admin', { scope: 'account', account_id: w.a1 });
    expect(res.statusCode).toBe(200);
    expect(await rows()).toMatchObject([{ account_id: w.a1, campaign_id: null }]);
    expect(await blocked(w.c1, w.a1)).toBe(true);
    expect(await blocked(w.c1done, w.a1)).toBe(true);
    expect(await blocked(w.c2, w.a2)).toBe(false);
    expect((await add('a1admin', { scope: 'account', account_id: w.a2 })).statusCode).toBe(403);
  });
});

describe('a narrower add where a wider entry already blocks the number (DS4)', () => {
  it('reports "already blocked in every campaign" and writes no second row', async () => {
    await add('tenant', { scope: 'tenant' });
    const res = await add('a1admin', { scope: 'campaign', campaign_id: w.c1, phone_numbers: [PHONE, PHONE2] });

    expect(res.json()).toMatchObject({ added: 1, already_present: 0, already_covered: 1 });
    expect(res.json().results[0]).toMatchObject({ outcome: 'already_covered', scope: 'tenant', campaign_id: null });
    expect((await rows()).filter((r) => r.phone_e164 === PHONE)).toHaveLength(1);
  });

  it('an account entry covers its campaigns and nothing in another account', async () => {
    await add('tenant', { scope: 'account', account_id: w.a1 });

    const mine = await add('tenant', { scope: 'campaign', campaign_id: w.c1 });
    expect(mine.json().results[0]).toMatchObject({ outcome: 'already_covered', scope: 'account' });
    const theirs = await add('tenant', { scope: 'campaign', campaign_id: w.c2 });
    expect(theirs.json().results[0]).toMatchObject({ outcome: 'added', scope: 'campaign' });
    // And an account add under an every-campaign entry is covered too.
    await add('tenant', { scope: 'tenant' });
    expect((await add('tenant', { scope: 'account', account_id: w.a2 })).json().results[0])
      .toMatchObject({ outcome: 'already_covered', scope: 'tenant' });
  });

  it('the same scope again is already there, not covered, even under a wider entry', async () => {
    await add('a1admin', { scope: 'campaign', campaign_id: w.c1 });
    await add('tenant', { scope: 'tenant' });
    expect((await add('a1admin', { scope: 'campaign', campaign_id: w.c1 })).json().results[0])
      .toMatchObject({ outcome: 'already_present', scope: 'campaign' });
  });

  it('every campaign added over campaign entries is written beside them, and removing it leaves them blocking', async () => {
    await add('a1admin', { scope: 'campaign', campaign_id: w.c1 });
    const wide = await add('tenant', { scope: 'tenant' });
    expect(wide.json().results[0]).toMatchObject({ outcome: 'added', scope: 'tenant' });
    expect(await rows()).toHaveLength(2);

    const del = await app.inject({ method: 'DELETE', url: `/dnc/${wide.json().results[0].entry_id}`, headers: headers('tenant') });
    expect(del.statusCode).toBe(200);
    expect(await blocked(w.c1, w.a1)).toBe(true);
    expect(await blocked(w.c2, w.a2)).toBe(false);
  });
});

describe("an account admin's list and removals: what belongs to their account (DS6)", () => {
  beforeEach(async () => {
    await add('tenant', { scope: 'tenant', phone_numbers: ['+919811100010'] });
    await add('tenant', { scope: 'account', account_id: w.a1, phone_numbers: ['+919811100011'] });
    await add('tenant', { scope: 'campaign', campaign_id: w.c1, phone_numbers: ['+919811100012'] });
    await add('tenant', { scope: 'account', account_id: w.a2, phone_numbers: ['+919811100013'] });
    await add('tenant', { scope: 'campaign', campaign_id: w.c2, phone_numbers: ['+919811100014'] });
  });

  it('lists its account entry and its campaign entry, never the every-campaign one or the other account\'s', async () => {
    const { entries, total } = await list('a1admin');
    expect(total).toBe(2);
    expect(entries.map((e) => e['phone_e164']).sort()).toEqual(['+919811100011', '+919811100012']);
    expect(JSON.stringify(entries)).not.toContain('SECRET');

    expect((await list('a1admin', '?scope=campaign')).entries.map((e) => e['phone_e164'])).toEqual(['+919811100012']);
    expect((await list('a1admin', `?campaign_id=${w.c2}`)).total).toBe(0);
    expect((await app.inject({ method: 'GET', url: '/dnc?scope=tenant', headers: headers('a1admin') })).statusCode).toBe(403);
  });

  it('the organisation admin lists all five and filters by scope and campaign', async () => {
    expect((await list('tenant')).total).toBe(5);
    expect((await list('tenant', '?scope=tenant')).entries.map((e) => e['phone_e164'])).toEqual(['+919811100010']);
    expect((await list('tenant', '?scope=account')).total).toBe(2);
    expect((await list('tenant', `?campaign_id=${w.c2}`)).entries).toMatchObject([
      { phone_e164: '+919811100014', scope: 'campaign', campaign_name: 'South SECRET', account_name: 'South' },
    ]);
  });

  it('removes a mark on its own campaign, and is told nothing exists for the others', async () => {
    const all = await rows();
    const id = (phone: string) => all.find((r) => r.phone_e164 === phone)!.id;

    const own = await app.inject({ method: 'DELETE', url: `/dnc/${id('+919811100012')}`, headers: headers('a1admin') });
    expect(own.statusCode).toBe(200);
    for (const phone of ['+919811100010', '+919811100013', '+919811100014']) {
      const res = await app.inject({ method: 'DELETE', url: `/dnc/${id(phone)}`, headers: headers('a1admin') });
      expect(res.statusCode, phone).toBe(404);
    }
    expect((await rows()).map((r) => r.phone_e164).sort())
      .toEqual(['+919811100010', '+919811100011', '+919811100013', '+919811100014']);
  });
});
