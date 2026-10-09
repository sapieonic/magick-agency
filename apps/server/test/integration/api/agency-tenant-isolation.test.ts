import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

/**
 * Tenant and account isolation across the agency
 * route families, through the REAL app (`buildApp`) on real Postgres (5436).
 *
 * Real: the session middleware (Firebase's token check is the one stub — there is no
 * Firebase here), the tenant-context middleware and RBAC against real `memberships`
 * rows, every public handler, `callCore` and the internal handlers on the private instance,
 * every repository. So the answers below are the production chain's, not a mock's.
 *
 * Properties (tenancy comes from the session context only, never client headers; another
 * tenant's or account's campaign is a 404, never data):
 *  1. `X-Tenant-Id` naming a tenant the caller has no membership in is refused, with no data;
 *  2. the internal identity headers (`x-mgkvc-tenant` / `x-mgkvc-account`) sent by a client
 *     change nothing — the context's tenant is the one the internal handler sees;
 *  3. another tenant's campaign, attempt, DNC entry or analysis profile, named by id under the
 *     caller's own tenant, is a 404 on every family, never its data, and a write leaves it as
 *     it was;
 *  4. a sibling account's campaign is a 404 for an account-scoped caller, and naming the sibling
 *     account in `X-Account-Id` is refused.
 * Mutation-checked: a call site taking its tenant/account from the client's `x-mgkvc-*`
 * headers (tried on the campaign list) reds property 2; `test/unit/api/core-dispatch.test.ts`
 * pins `callCore`'s own half (an extra header never names the tenant or supplies an account).
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
import { insertAgencyAttempt, insertAgencyCampaign, insertAgencyContact } from '../agency/agency-factories.js';
import { buildApp } from '../../../src/app.js';

initDbPool({ url: TEST_DB_URL, poolMin: 0, poolMax: 4 });

let app: FastifyInstance;

interface World {
  tenantA: string; accountA1: string; accountA2: string;
  tenantB: string; accountB1: string;
  user: { id: string; firebase_uid: string };
  campaignA1: string; campaignA2: string; campaignB: string;
  contactB: string; attemptB: string;
  dncB: string; profileB: string;
}
let w: World;

async function enableFlag(flag: string, tenantId: string) {
  await getTestPool().query(
    `INSERT INTO feature_flag_overrides (flag_key, scope_type, tenant_id, value)
     VALUES ($1, 'tenant', $2, 'true'::jsonb)`,
    [flag, tenantId],
  );
}

beforeAll(async () => {
  mocks.verifyIdToken.mockImplementation(async (token: string) => {
    if (token.startsWith('tok:')) return { uid: token.slice(4), email: 'iso@example.com', email_verified: true };
    throw new Error('bad token');
  });
  app = await buildApp({ ctx: null });
  await app.ready();
});

beforeEach(async () => {
  await truncateAll();
  const tA = await insertTenant();
  const a1 = await insertAccount({ tenant_id: tA.id });
  const a2 = await insertAccount({ tenant_id: tA.id });
  const tB = await insertTenant();
  const b1 = await insertAccount({ tenant_id: tB.id });
  const user = await insertUser({ display_name: 'Iso Admin' });
  // Account-scoped admin of A1: the strongest role that is still confined to one account.
  await insertMembership({ user_id: user.id, tenant_id: tA.id, account_id: a1.id, role: 'account_admin' });

  const cA1 = await insertAgencyCampaign({ tenant_id: tA.id, account_id: a1.id, name: 'Alpha-One Renewals' });
  const cA2 = await insertAgencyCampaign({ tenant_id: tA.id, account_id: a2.id, name: 'Alpha-Two SECRET' });
  const cB = await insertAgencyCampaign({ tenant_id: tB.id, account_id: b1.id, name: 'Bravo SECRET' });
  const contactB = await insertAgencyContact(cB.id, { tenant_id: tB.id, account_id: b1.id, phone_e164: '+919811100001' });
  const attemptB = await insertAgencyAttempt(cB.id, contactB.id, { tenant_id: tB.id, account_id: b1.id });
  const dncB = await getTestPool().query<{ id: string }>(
    `INSERT INTO dnc_entries (tenant_id, account_id, phone_e164, source, reason)
     VALUES ($1, $2, '+919822200002', 'api', 'bravo-secret-reason') RETURNING id`,
    [tB.id, b1.id],
  );
  const profileB = await getTestPool().query<{ id: string }>(
    `INSERT INTO call_analysis_profiles (tenant_id, account_id, name, context)
     VALUES ($1, $2, 'Bravo SECRET profile', 'bravo-secret-context') RETURNING id`,
    [tB.id, b1.id],
  );
  for (const t of [tA.id, tB.id]) {
    await enableFlag('agency_dialer_enabled', t);
    await enableFlag('agency_call_analysis', t);
  }
  for (const [t, a] of [[tA.id, a1.id], [tB.id, b1.id]] as const) {
    await getTestPool().query(
      `INSERT INTO account_settings (tenant_id, account_id, analyze_calls) VALUES ($1, $2, true)
       ON CONFLICT DO NOTHING`,
      [t, a],
    );
  }
  w = {
    tenantA: tA.id, accountA1: a1.id, accountA2: a2.id, tenantB: tB.id, accountB1: b1.id,
    user: { id: user.id, firebase_uid: user.firebase_uid },
    campaignA1: cA1.id, campaignA2: cA2.id, campaignB: cB.id,
    contactB: contactB.id, attemptB: attemptB.id,
    dncB: dncB.rows[0]!.id, profileB: profileB.rows[0]!.id,
  };
});

afterAll(async () => {
  await app?.close();
  await closePool();
  await closeTestPool();
});

function headers(extra: Record<string, string> = {}): Record<string, string> {
  return {
    authorization: `Bearer tok:${w.user.firebase_uid}`,
    'x-tenant-id': w.tenantA,
    'x-account-id': w.accountA1,
    ...extra,
  };
}

const SECRETS = ['SECRET', 'bravo-secret', '+919811100001', '+919822200002', '+919811100009'];
function expectNoForeignData(body: string) {
  for (const s of SECRETS) expect(body, `leaked "${s}"`).not.toContain(s);
}

describe('agency API tenant/account isolation through the real app (integration)', () => {
  it("baseline: the caller's own campaign is served (the chain works, so the refusals below mean something)", async () => {
    const res = await app.inject({ method: 'GET', url: `/proxy/agency/campaigns/${w.campaignA1}`, headers: headers() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: w.campaignA1, name: 'Alpha-One Renewals' });
  });

  it('X-Tenant-Id naming a tenant the caller has no membership in is refused, with no data', async () => {
    for (const url of ['/proxy/agency/campaigns', `/proxy/agency/campaigns/${w.campaignB}`, '/dnc', '/phone-numbers']) {
      const res = await app.inject({
        method: 'GET', url, headers: headers({ 'x-tenant-id': w.tenantB, 'x-account-id': w.accountB1 }),
      });
      expect(res.statusCode, url).toBe(403);
      expectNoForeignData(res.body);
    }
  });

  it("the internal identity headers sent by a client change nothing: the context's tenant is the one served", async () => {
    const spoof = { 'x-mgkvc-tenant': w.tenantB, 'x-mgkvc-account': w.accountB1 };
    const list = await app.inject({ method: 'GET', url: '/proxy/agency/campaigns', headers: headers(spoof) });
    expect(list.statusCode).toBe(200);
    const ids = (list.json() as { campaigns?: Array<{ id: string }> }).campaigns?.map((c) => c.id)
      ?? (list.json() as Array<{ id: string }>).map((c) => c.id);
    expect(ids).toEqual([w.campaignA1]);
    expectNoForeignData(list.body);

    const one = await app.inject({ method: 'GET', url: `/proxy/agency/campaigns/${w.campaignB}`, headers: headers(spoof) });
    expect(one.statusCode).toBe(404);
    expectNoForeignData(one.body);
  });

  it.each([
    ['campaign detail', 'GET', (x: World) => `/proxy/agency/campaigns/${x.campaignB}`],
    ['campaign stats', 'GET', (x: World) => `/proxy/agency/campaigns/${x.campaignB}/stats`],
    ['stats series', 'GET', (x: World) => `/proxy/agency/campaigns/${x.campaignB}/stats/series?from=2026-08-01&to=2026-08-02`],
    ['activity', 'GET', (x: World) => `/proxy/agency/campaigns/${x.campaignB}/activity`],
    ['attempt spine', 'GET', (x: World) => `/proxy/agency/campaigns/${x.campaignB}/attempts`],
    ['contact spine', 'GET', (x: World) => `/proxy/agency/campaigns/${x.campaignB}/contacts`],
    ['contact detail', 'GET', (x: World) => `/proxy/agency/campaigns/${x.campaignB}/contacts/${x.contactB}`],
    ['call read', 'GET', (x: World) => `/proxy/agency/campaigns/${x.campaignB}/attempts/${x.attemptB}`],
    ['staffing', 'GET', (x: World) => `/proxy/agency/campaigns/${x.campaignB}/agents`],
    ['retry preview', 'GET', (x: World) => `/proxy/agency/campaigns/${x.campaignB}/retry/preview`],
    ['lineage', 'GET', (x: World) => `/proxy/agency/campaigns/${x.campaignB}/lineage`],
    ['analysis profile', 'GET', (x: World) => `/proxy/call-analysis-profiles/${x.profileB}`],
  ] as const)("another tenant's %s, named under the caller's tenant, is a 404 — never data", async (_family, method, url) => {
    const res = await app.inject({ method, url: url(w), headers: headers() });
    expect(res.statusCode).toBe(404);
    expectNoForeignData(res.body);
  });

  it("writes on another tenant's rows are a 404 and leave them as they were", async () => {
    const patch = await app.inject({
      method: 'PATCH', url: `/proxy/agency/campaigns/${w.campaignB}`,
      headers: { ...headers(), 'content-type': 'application/json' }, payload: JSON.stringify({ name: 'hijacked' }),
    });
    expect(patch.statusCode).toBe(404);
    const del = await app.inject({ method: 'DELETE', url: `/dnc/${w.dncB}`, headers: headers() });
    expect(del.statusCode).toBe(404);
    const start = await app.inject({ method: 'POST', url: `/proxy/agency/campaigns/${w.campaignB}/start`, headers: headers() });
    expect(start.statusCode).toBe(404);

    const camp = await getTestPool().query('SELECT name, status FROM agency_campaigns WHERE id = $1', [w.campaignB]);
    expect(camp.rows[0]).toEqual({ name: 'Bravo SECRET', status: 'draft' });
    const dnc = await getTestPool().query('SELECT count(*)::int AS n FROM dnc_entries WHERE id = $1', [w.dncB]);
    expect(dnc.rows[0].n).toBe(1);
  });

  it("list reads never include another tenant's rows (DNC, profiles)", async () => {
    for (const url of ['/dnc', '/proxy/call-analysis-profiles']) {
      const res = await app.inject({ method: 'GET', url, headers: headers() });
      expect(res.statusCode, url).toBe(200);
      expectNoForeignData(res.body);
    }
  });

  it("a sibling account's campaign is a 404 for an account-scoped caller; naming the sibling account is refused", async () => {
    const res = await app.inject({ method: 'GET', url: `/proxy/agency/campaigns/${w.campaignA2}`, headers: headers() });
    expect(res.statusCode).toBe(404);
    expectNoForeignData(res.body);

    const named = await app.inject({
      method: 'GET', url: `/proxy/agency/campaigns/${w.campaignA2}`, headers: headers({ 'x-account-id': w.accountA2 }),
    });
    expect(named.statusCode).toBe(403);
    expectNoForeignData(named.body);
  });

  it('a malformed id on any family is a 4xx, never a 500 (through the real chain)', async () => {
    for (const url of [
      '/proxy/agency/campaigns/not-a-uuid',
      '/proxy/agency/campaigns/not-a-uuid/stats',
      `/proxy/agency/campaigns/${w.campaignA1}/attempts/not-a-uuid`,
      `/proxy/agency/campaigns/${w.campaignA1}/contacts/not-a-uuid`,
      '/proxy/agency/campaigns/not-a-uuid/agents',
      '/proxy/agency/agents/not-a-uuid/stats',
      '/proxy/call-analysis-profiles/not-a-uuid',
      // ids in the QUERY reach `uuid` / `uuid[]` casts too (tenant, account and agent ids are
      // UUID columns here, so a malformed id must be refused rather than reach the cast).
      '/proxy/agency/agents/stats?campaign_id=not-a-uuid',
      '/proxy/agency/agents/grouped-stats?campaign_id=not-a-uuid&group_by=agent',
      `/proxy/agency/campaigns/${w.campaignA1}/attempts?agent_user_id=not-a-uuid`,
      '/proxy/agency/my-attempts?campaign_id=not-a-uuid',
      '/dnc?campaign_id=not-a-uuid',
    ]) {
      const res = await app.inject({ method: 'GET', url, headers: headers() });
      expect([400, 404], `${url} → ${res.statusCode} ${res.body}`).toContain(res.statusCode);
    }
    const del = await app.inject({ method: 'DELETE', url: '/dnc/not-a-uuid', headers: headers() });
    expect([400, 404]).toContain(del.statusCode);
    const tenantHeader = await app.inject({
      method: 'GET', url: '/proxy/agency/campaigns', headers: headers({ 'x-tenant-id': 'not-a-uuid' }),
    });
    expect(tenantHeader.statusCode).toBe(400);
  });

  it('an unknown well-formed id answers like a foreign one (the id is not an oracle)', async () => {
    const res = await app.inject({ method: 'GET', url: `/proxy/agency/campaigns/${randomUUID()}`, headers: headers() });
    const foreign = await app.inject({ method: 'GET', url: `/proxy/agency/campaigns/${w.campaignB}`, headers: headers() });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual(foreign.json());
  });

  // ── The remaining read families, foreign tenant AND sibling account ──
  describe('ingest jobs, the recording and the CSV exports', () => {
    async function job(tenantId: string, accountId: string | null): Promise<string> {
      const { rows } = await getTestPool().query<{ id: string }>(
        `INSERT INTO agency_ingest_jobs (tenant_id, account_id, s3_key, file_name, phone_column, status)
         VALUES ($1, $2, 'agency-ingest/x/SECRET.csv', 'SECRET.csv', 'Mobile', 'completed') RETURNING id`,
        [tenantId, accountId],
      );
      return rows[0]!.id;
    }

    it.each([
      ['GET', (id: string) => `/proxy/agency/ingest/jobs/${id}`],
      ['POST', (id: string) => `/proxy/agency/ingest/jobs/${id}/cancel`],
      ['GET', (id: string) => `/proxy/agency/ingest/jobs/${id}/rejected.csv`],
    ] as const)("%s an ingest job of another tenant or a sibling account is a 404 — never data", async (method, url) => {
      const foreign = await job(w.tenantB, w.accountB1);
      const sibling = await job(w.tenantA, w.accountA2);
      for (const id of [foreign, sibling]) {
        const res = await app.inject({ method, url: url(id), headers: headers() });
        expect(res.statusCode, `${method} ${url(id)} ${res.body}`).toBe(404);
        expectNoForeignData(res.body);
      }
      const { rows } = await getTestPool().query('SELECT cancel_requested FROM agency_ingest_jobs WHERE id = ANY($1::uuid[])', [[foreign, sibling]]);
      expect(rows.every((r) => r.cancel_requested === false)).toBe(true);
    });

    it.each([
      ['the attempt recording', (c: string, a: string) => `/proxy/agency/campaigns/${c}/attempts/${a}/recording`],
      ['attempts.csv', (c: string) => `/proxy/agency/campaigns/${c}/attempts.csv`],
      ['contacts.csv', (c: string) => `/proxy/agency/campaigns/${c}/contacts.csv`],
      ['activity.csv', (c: string) => `/proxy/agency/campaigns/${c}/activity.csv`],
    ] as const)("%s of another tenant's or a sibling account's campaign is a 404 — never data", async (_label, url) => {
      // Each campaign with an attempt of ITS OWN (delta review 1): the sibling leg must be refused
      // by the account scoping, not by an attempt/campaign mismatch.
      const contactA2 = await insertAgencyContact(w.campaignA2, { tenant_id: w.tenantA, account_id: w.accountA2, phone_e164: '+919811100009' });
      const attemptA2 = (await insertAgencyAttempt(w.campaignA2, contactA2.id, {
        tenant_id: w.tenantA, account_id: w.accountA2, state: 'ended', outcome: 'connected',
        bridged_at: new Date(Date.now() - 60_000), ended_at: new Date(),
      })).id as string;
      for (const [campaign, attempt] of [[w.campaignB, w.attemptB], [w.campaignA2, attemptA2]] as const) {
        const res = await app.inject({ method: 'GET', url: url(campaign, attempt), headers: headers() });
        expect(res.statusCode, `${url(campaign, attempt)} ${res.body}`).toBe(404);
        expectNoForeignData(res.body);
      }
    });

    it("/my-campaigns through the real hop never names another tenant's or account's campaign (tests review 4)", async () => {
      // An agent of A1 staffed (by a bad row) on B's and A2's campaigns.
      const agent = await insertUser();
      await insertMembership({ user_id: agent.id, tenant_id: w.tenantA, account_id: w.accountA1, role: 'agent' });
      for (const c of [w.campaignB, w.campaignA2, w.campaignA1]) {
        await getTestPool().query(
          `INSERT INTO agency_campaign_agents (tenant_id, account_id, campaign_id, user_id) VALUES ($1, $2, $3, $4)`,
          [w.tenantA, w.accountA1, c, agent.id],
        );
      }
      const res = await app.inject({
        method: 'GET', url: '/proxy/agency/my-campaigns',
        headers: { ...headers(), authorization: `Bearer tok:${agent.firebase_uid}` },
      });
      expect(res.statusCode, res.body).toBe(200);
      // The real hop named the agent's own campaign, so the absence below is a refusal, not a stub.
      expect(res.body).toContain('Alpha-One Renewals');
      expectNoForeignData(res.body);
    });
  });
});
