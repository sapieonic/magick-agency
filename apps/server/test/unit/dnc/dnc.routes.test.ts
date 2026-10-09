import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type { MembershipRole } from '@magick-agency/contracts/rbac';

/**
 * **`/dnc` — the route table, and the two RBAC floors, asserted by execution.**
 *
 * ── Why the permissions are checked through the REAL matrix ──────────────────
 * The sibling agency route-table suite stubs RBAC open on purpose: it asks "does
 * the router know this path", and a 403 answers that as well as a 200. This file
 * asks a different question — **can an agent delete a DNC entry** — and that is
 * not answerable with RBAC stubbed. So `requirePermission` here is the real
 * factory over the real `PERMISSION_MATRIX`, and the role is set per request.
 *
 * §16.6's second check is the reason: the property that matters is true at the
 * point of CONSUMPTION (this route, with this role) and not merely in the matrix.
 * `test/unit/rbac/roles.agent.test.ts` already pins the matrix; a floor pinned
 * there and then wired to the wrong permission string in the route is exactly the
 * gap that leaves an agent able to un-suppress numbers with both suites green.
 */

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  add: vi.fn(),
  remove: vi.fn(),
  auditLog: vi.fn(),
  findAccountByIdInTenant: vi.fn(),
}));

vi.mock('../../../src/dnc/dnc.service.js', () => ({
  dncService: { list: mocks.list, add: mocks.add, remove: mocks.remove },
  DNC_ADD_MAX_NUMBERS: 1_000,
}));
vi.mock('@magick-agency/db/repositories/account.repository', () => ({
  accountRepository: { findByIdInTenant: mocks.findAccountByIdInTenant },
}));
vi.mock('../../../src/audit/platform/audit-logger.js', () => ({ platformAuditLogger: { log: mocks.auditLog } }));
vi.mock('@magick-agency/observability', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@magick-agency/observability')>()),
  createChildLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../../../src/auth/session.middleware.js', () => ({ sessionMiddleware: async () => {} }));
vi.mock('../../../src/api/middleware/tenant-context.middleware.js', () => ({
  tenantContextMiddleware: async () => {},
}));
// PORT NOTE (magick-agency): master's `requireCapability('agency')` stub is gone with the
// governance gate it stubbed (the route no longer registers it; see the route's header).

import { dncRoutes } from '../../../src/api/routes/dnc.routes.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const ACCOUNT = '22222222-2222-4222-8222-222222222222';
/** A sibling account in the same tenant — never the caller's own scope below. */
const ACCOUNT_B = '44444444-4444-4444-8444-444444444444';
/** The literal `uq_dnc_scope` COALESCEs a NULL scope column to (`050_dnc.sql`). */
const NIL_UUID = '00000000-0000-0000-0000-000000000000';
const USER = 'user-supervisor-1';

/**
 * `accountId` defaults to `undefined` (tenant-wide membership, matching every
 * pre-existing test in this file) — pass a uuid to simulate an account-scoped
 * membership for the account-scope-enforcement suite below.
 */
async function buildApp(
  role: MembershipRole = 'account_admin',
  accountId?: string | null,
): Promise<{
  app: FastifyInstance;
  routes: string[];
}> {
  const app = Fastify({ logger: false });
  const routes: string[] = [];
  app.addHook('onRoute', (route) => {
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    for (const method of methods) {
      if (method === 'HEAD') continue;
      routes.push(`${method} ${route.url}`);
    }
  });
  app.addHook('onRequest', async (request) => {
    // Double cast: `lint:test` rejects the single `FastifyRequest as
    // Record<string, unknown>` form under TS2352 — see the note in
    // `test/unit/agency/proxy-agency-route-table.test.ts`.
    const r = request as unknown as Record<string, unknown>;
    r['tenantId'] = TENANT;
    r['accountId'] = ACCOUNT;
    r['user'] = { id: USER };
    r['membership'] = accountId !== undefined ? { role, account_id: accountId } : { role };
  });
  await app.register(dncRoutes, { prefix: '/dnc' });
  await app.ready();
  return { app, routes };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.list.mockResolvedValue({ entries: [], total: 0 });
  mocks.add.mockResolvedValue({ added: 1, already_present: 0, invalid: 0, results: [] });
  mocks.remove.mockResolvedValue({ id: 'e1', phone_e164: '+15551230001' });
  // Default: any named account_id genuinely belongs to this tenant. Tests
  // for the new cross-tenant-account guard override this per-case.
  mocks.findAccountByIdInTenant.mockResolvedValue({ id: ACCOUNT, tenant_id: TENANT });
});

describe('the route table', () => {
  it('registers exactly these three routes', async () => {
    const { app, routes } = await buildApp();

    // A sorted set comparison, not a count: a route swapped for a different one
    // is the change most likely to happen by accident.
    expect([...routes].sort()).toEqual(['DELETE /dnc/:id', 'GET /dnc', 'POST /dnc']);
    await app.close();
  });

  it('serves the collection with AND without a trailing slash', async () => {
    const { app } = await buildApp();

    // Fastify reports the registration as `/dnc` while a client may well send
    // `/dnc/`; asserting the table alone would leave "which one does the browser
    // get a 404 on" unanswered — the gap the agency route-table test was written
    // for. 404 is the only failure that matters here.
    for (const url of ['/dnc', '/dnc/']) {
      expect((await app.inject({ method: 'GET', url })).statusCode, url).not.toBe(404);
    }
    await app.close();
  });
});

describe('RBAC floors, exercised through the real permission matrix', () => {
  it('an AGENT cannot read the list', async () => {
    const { app } = await buildApp('agent');

    // The list is every customer who asked not to be contacted. D6 gives an
    // agent four permissions and this is not one of them.
    const res = await app.inject({ method: 'GET', url: '/dnc/' });
    expect(res.statusCode).toBe(403);
    expect(mocks.list).not.toHaveBeenCalled();
    await app.close();
  });

  it('an AGENT cannot add arbitrary numbers', async () => {
    const { app } = await buildApp('agent');

    // An agent's DNC power is attempt-scoped — `POST /proxy/agency/attempts/:id/dnc`,
    // where core verifies they are that attempt's reserved agent. `agency.dnc.write`
    // must not also open a route that takes any number the caller names.
    const res = await app.inject({
      method: 'POST',
      url: '/dnc/',
      payload: { phone_numbers: ['+15551230001'] },
    });
    expect(res.statusCode).toBe(403);
    expect(mocks.add).not.toHaveBeenCalled();
    await app.close();
  });

  it('an AGENT cannot DELETE — the direction that un-suppresses a number', async () => {
    const { app } = await buildApp('agent');

    const res = await app.inject({ method: 'DELETE', url: '/dnc/entry-1' });
    expect(res.statusCode).toBe(403);
    expect(mocks.remove).not.toHaveBeenCalled();
    await app.close();
  });

  it('a VIEWER can read but cannot add or delete', async () => {
    const { app } = await buildApp('viewer');

    expect((await app.inject({ method: 'GET', url: '/dnc/' })).statusCode).toBe(200);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/dnc/',
          payload: { phone_numbers: ['+15551230001'] },
        })
      ).statusCode,
    ).toBe(403);
    expect((await app.inject({ method: 'DELETE', url: '/dnc/e1' })).statusCode).toBe(403);
    await app.close();
  });

  it('an OPERATOR cannot add or delete either — manage floors at account_admin', async () => {
    const { app } = await buildApp('operator');

    // Deliberate: removing an entry is a compliance decision, not a campaign
    // operation. `operator` (20) is below `account_admin` (30).
    expect((await app.inject({ method: 'DELETE', url: '/dnc/e1' })).statusCode).toBe(403);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/dnc/',
          payload: { phone_numbers: ['+15551230001'] },
        })
      ).statusCode,
    ).toBe(403);
    await app.close();
  });

  it('an ACCOUNT_ADMIN can do all three', async () => {
    const { app } = await buildApp('account_admin');

    expect((await app.inject({ method: 'GET', url: '/dnc/' })).statusCode).toBe(200);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/dnc/',
          payload: { phone_numbers: ['+15551230001'] },
        })
      ).statusCode,
    ).toBe(200);
    expect((await app.inject({ method: 'DELETE', url: '/dnc/e1' })).statusCode).toBe(200);
    await app.close();
  });
});

describe('POST /dnc — attribution and scope', () => {
  it('derives added_by from the SESSION and ignores a client-supplied one', async () => {
    const { app } = await buildApp();

    await app.inject({
      method: 'POST',
      url: '/dnc/',
      payload: {
        phone_numbers: ['+15551230001'],
        added_by: 'somebody-else',
        tenant_id: 'another-tenant',
      },
    });

    const arg = mocks.add.mock.calls[0]![0] as Record<string, unknown>;
    // Who suppressed a number is the audit trail; self-reported attribution is
    // not an audit trail. Same rule as the attempt actions (`agency-actor.ts`).
    expect(arg['addedBy']).toBe(USER);
    expect(arg['tenantId']).toBe(TENANT);
    await app.close();
  });

  it('defaults to a TENANT-WIDE scope, not the request\'s account', async () => {
    const { app } = await buildApp();

    await app.inject({ method: 'POST', url: '/dnc/', payload: { phone_numbers: ['+15551230001'] } });

    const arg = mocks.add.mock.calls[0]![0] as Record<string, unknown>;
    /**
     * The request carries `X-Account-Id`, so scoping to it would be the obvious
     * reading — and it would mean nothing an operator adds ever reaches core's
     * flat `dnc:{tenantId}` set (§2.3: tenant-wide rows only). Numbers would sit
     * on the list and keep being dialed by the dial-time check.
     */
    expect(arg['accountId']).toBeUndefined();
    expect(arg['campaignId']).toBeUndefined();
    await app.close();
  });

  it('honours an explicit account/campaign scope when one is asked for', async () => {
    const { app } = await buildApp();

    await app.inject({
      method: 'POST',
      url: '/dnc/',
      payload: {
        phone_numbers: ['+15551230001'],
        account_id: ACCOUNT,
        campaign_id: '33333333-3333-4333-8333-333333333333',
      },
    });

    const arg = mocks.add.mock.calls[0]![0] as Record<string, unknown>;
    expect(arg['accountId']).toBe(ACCOUNT);
    expect(arg['campaignId']).toBe('33333333-3333-4333-8333-333333333333');
    await app.close();
  });

  it('400s the NIL UUID in EITHER scope field — both are COALESCEd to it', async () => {
    const { app } = await buildApp();

    /**
     * ── Both halves, because `uq_dnc_scope` COALESCEs both ──────────────────
     * `z.string().uuid()` accepts the nil UUID, and the index maps a NULL
     * `account_id` AND a NULL `campaign_id` to that same literal. So either field
     * spelled as the nil UUID yields an index key identical to a tenant-wide
     * row's while the row is not tenant-wide — and a later genuine tenant-wide
     * add for that number collides with it, writes nothing, publishes nothing,
     * and is reported as an idempotent success.
     *
     * This is also the BULK path (`phone_numbers` takes up to
     * `DNC_ADD_MAX_NUMBERS`), so one sentinel scope on one regulator-list import
     * buries every number in it at a scope the dial-time check never consults.
     *
     * Testing only `campaign_id` would pass against a guard applied to one field,
     * leaving the other open — the exact half-fix shape.
     */
    for (const field of ['account_id', 'campaign_id']) {
      const res = await app.inject({
        method: 'POST',
        url: '/dnc/',
        payload: { phone_numbers: ['+15551230001'], [field]: NIL_UUID },
      });

      expect(res.statusCode, field).toBe(400);
      expect(JSON.stringify(res.json()), field).toMatch(/reserved/i);
    }

    // Nothing was written for either. A guard that 400s after the insert would
    // pass a status-only assertion and close nothing.
    expect(mocks.add).not.toHaveBeenCalled();
    await app.close();
  });

  it('still accepts an explicit NULL in either scope field, which means tenant-wide', async () => {
    // The rejection is of one reserved VALUE, not of the fields. `null` is the
    // supported way to say "no scope" and a serialiser emitting nulls for absent
    // fields is ordinary — turning that into a 400 would break real callers.
    const { app } = await buildApp();

    const res = await app.inject({
      method: 'POST',
      url: '/dnc/',
      payload: { phone_numbers: ['+15551230001'], account_id: null, campaign_id: null },
    });

    expect(res.statusCode).toBe(200);
    const arg = mocks.add.mock.calls[0]![0] as Record<string, unknown>;
    expect(arg['accountId']).toBeUndefined();
    expect(arg['campaignId']).toBeUndefined();
    await app.close();
  });

  describe('account-scope enforcement (sibling-account / tenant-wide IDOR)', () => {
    it('refuses an account-scoped caller who OMITS account_id — the write would be tenant-wide', async () => {
      // requirePermission proves the ROLE only; without this, an account_admin
      // scoped to ACCOUNT could silently blast a tenant-wide suppression that
      // blocks dialing for every account, not just their own.
      const { app } = await buildApp('account_admin', ACCOUNT);

      const res = await app.inject({
        method: 'POST',
        url: '/dnc/',
        payload: { phone_numbers: ['+15551230001'] },
      });

      expect(res.statusCode).toBe(403);
      expect(mocks.add).not.toHaveBeenCalled();
      await app.close();
    });

    it('refuses an account-scoped caller naming an explicit tenant-wide scope', async () => {
      const { app } = await buildApp('account_admin', ACCOUNT);

      const res = await app.inject({
        method: 'POST',
        url: '/dnc/',
        payload: { phone_numbers: ['+15551230001'], account_id: null },
      });

      expect(res.statusCode).toBe(403);
      expect(mocks.add).not.toHaveBeenCalled();
      await app.close();
    });

    it('refuses an account-scoped caller naming a SIBLING account', async () => {
      const { app } = await buildApp('account_admin', ACCOUNT);

      const res = await app.inject({
        method: 'POST',
        url: '/dnc/',
        payload: { phone_numbers: ['+15551230001'], account_id: ACCOUNT_B },
      });

      expect(res.statusCode).toBe(403);
      expect(mocks.add).not.toHaveBeenCalled();
      await app.close();
    });

    it('allows an account-scoped caller naming their OWN account', async () => {
      const { app } = await buildApp('account_admin', ACCOUNT);

      const res = await app.inject({
        method: 'POST',
        url: '/dnc/',
        payload: { phone_numbers: ['+15551230001'], account_id: ACCOUNT },
      });

      expect(res.statusCode).toBe(200);
      // Not just "was called" — the scope that actually reached the service.
      expect((mocks.add.mock.calls[0]![0] as Record<string, unknown>)['accountId']).toBe(ACCOUNT);
      await app.close();
    });

    it('a TENANT-WIDE membership may still write any scope, including none', async () => {
      mocks.findAccountByIdInTenant.mockResolvedValue({ id: ACCOUNT_B, tenant_id: TENANT });
      const { app } = await buildApp('account_admin'); // no account_id ⇒ tenant-wide

      const res = await app.inject({
        method: 'POST',
        url: '/dnc/',
        payload: { phone_numbers: ['+15551230001'], account_id: ACCOUNT_B },
      });

      expect(res.statusCode).toBe(200);
      expect((mocks.add.mock.calls[0]![0] as Record<string, unknown>)['accountId']).toBe(ACCOUNT_B);
      await app.close();
    });

    it('404s when account_id does not belong to this tenant (cross-tenant write guard)', async () => {
      // `dnc_entries.account_id` has no composite FK back to `tenant_id`
      // (migration 050) — same shape as invite/credits-allocate/phone-tags.
      mocks.findAccountByIdInTenant.mockResolvedValue(null);
      const { app } = await buildApp('account_admin'); // tenant-wide, so scope alone would allow it

      const res = await app.inject({
        method: 'POST',
        url: '/dnc/',
        payload: { phone_numbers: ['+15551230001'], account_id: ACCOUNT_B },
      });

      expect(res.statusCode).toBe(404);
      expect(mocks.add).not.toHaveBeenCalled();
      expect(mocks.findAccountByIdInTenant).toHaveBeenCalledWith(ACCOUNT_B, TENANT);
      await app.close();
    });
  });

  it('defaults source to `api`, and accepts the four catalogued sources', async () => {
    const { app } = await buildApp();

    await app.inject({ method: 'POST', url: '/dnc/', payload: { phone_numbers: ['+15551230001'] } });
    expect((mocks.add.mock.calls[0]![0] as Record<string, unknown>)['source']).toBe('api');

    for (const source of ['agent', 'import', 'api', 'regulator']) {
      const res = await app.inject({
        method: 'POST',
        url: '/dnc/',
        payload: { phone_numbers: ['+15551230001'], source },
      });
      expect(res.statusCode, source).toBe(200);
    }
    await app.close();
  });

  it('400s an unknown source rather than storing it', async () => {
    const { app } = await buildApp();

    // `ck_dnc_entries_source` would raise a 23514 inside the insert otherwise,
    // surfacing as a masked 500 with no field feedback.
    const res = await app.inject({
      method: 'POST',
      url: '/dnc/',
      payload: { phone_numbers: ['+15551230001'], source: 'guesswork' },
    });
    expect(res.statusCode).toBe(400);
    expect(mocks.add).not.toHaveBeenCalled();
    await app.close();
  });

  it('400s an empty list and a list past the cap', async () => {
    const { app } = await buildApp();

    expect(
      (await app.inject({ method: 'POST', url: '/dnc/', payload: { phone_numbers: [] } })).statusCode,
    ).toBe(400);

    const tooMany = Array.from({ length: 1001 }, (_, i) => `+1555123${String(i).padStart(4, '0')}`);
    expect(
      (await app.inject({ method: 'POST', url: '/dnc/', payload: { phone_numbers: tooMany } }))
        .statusCode,
    ).toBe(400);
    await app.close();
  });

  it('answers 200 with the per-number breakdown, not a bare 201', async () => {
    mocks.add.mockResolvedValue({
      added: 412,
      already_present: 88,
      invalid: 3,
      results: [{ input: '+15551230001', outcome: 'added', phone_e164: '+15551230001', entry_id: 'e1' }],
    });
    const { app } = await buildApp();

    const res = await app.inject({
      method: 'POST',
      url: '/dnc/',
      payload: { phone_numbers: ['+15551230001'] },
    });

    // A re-uploaded regulator list is normally mostly redundant; a 201 with no
    // body tells the operator nothing about the rows that did not change.
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ added: 412, already_present: 88, invalid: 3 });
    await app.close();
  });
});

describe('GET /dnc — filters', () => {
  it("maps account_id=tenant to a NULL-scope filter, not to the literal string", async () => {
    const { app } = await buildApp();

    await app.inject({ method: 'GET', url: '/dnc/?account_id=tenant' });

    const arg = mocks.list.mock.calls[0]![0] as Record<string, unknown>;
    // `'tenant'` reaching the repository as a value would be compared against a
    // uuid column: a 22P02, i.e. a masked 500 on the most useful filter here.
    expect(arg['accountId']).toBeNull();
    await app.close();
  });

  it('omits a scope filter entirely when none was supplied', async () => {
    const { app } = await buildApp();

    await app.inject({ method: 'GET', url: '/dnc/' });

    const arg = mocks.list.mock.calls[0]![0] as Record<string, unknown>;
    // Absent must NOT collapse to `null`: that would silently hide every
    // account- and campaign-scoped row from an unfiltered list.
    expect('accountId' in arg).toBe(false);
    expect('campaignId' in arg).toBe(false);
    await app.close();
  });

  it('passes a uuid scope through as itself', async () => {
    const { app } = await buildApp();

    await app.inject({ method: 'GET', url: `/dnc/?account_id=${ACCOUNT}` });

    expect((mocks.list.mock.calls[0]![0] as Record<string, unknown>)['accountId']).toBe(ACCOUNT);
    await app.close();
  });

  it('always scopes the query to the request tenant', async () => {
    const { app } = await buildApp();

    await app.inject({ method: 'GET', url: '/dnc/?phone=%2B15551230001' });

    const arg = mocks.list.mock.calls[0]![0] as Record<string, unknown>;
    expect(arg['tenantId']).toBe(TENANT);
    expect(arg['phone']).toBe('+15551230001');
    await app.close();
  });

  it('defaults and bounds paging', async () => {
    const { app } = await buildApp();

    await app.inject({ method: 'GET', url: '/dnc/' });
    const arg = mocks.list.mock.calls[0]![0] as Record<string, unknown>;
    expect(arg['limit']).toBe(50);
    expect(arg['offset']).toBe(0);

    // An unbounded limit on a list that can hold a whole regulator file is a
    // way to ask master to serialise millions of rows into one response.
    expect((await app.inject({ method: 'GET', url: '/dnc/?limit=500' })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/dnc/?offset=-1' })).statusCode).toBe(400);
    await app.close();
  });
});

describe('GET /dnc — account-scope enforcement (sibling-account IDOR)', () => {
  it("FORCES the filter to the caller's own account when none was supplied", async () => {
    // A plain unfiltered `GET /dnc` from an account-scoped viewer must not
    // return every account's (or the tenant-wide) compliance rows.
    const { app } = await buildApp('viewer', ACCOUNT);

    const res = await app.inject({ method: 'GET', url: '/dnc/' });

    expect(res.statusCode).toBe(200);
    expect((mocks.list.mock.calls[0]![0] as Record<string, unknown>)['accountId']).toBe(ACCOUNT);
    await app.close();
  });

  it('allows an account-scoped caller to name their own account explicitly', async () => {
    const { app } = await buildApp('viewer', ACCOUNT);

    const res = await app.inject({ method: 'GET', url: `/dnc/?account_id=${ACCOUNT}` });

    expect(res.statusCode).toBe(200);
    expect((mocks.list.mock.calls[0]![0] as Record<string, unknown>)['accountId']).toBe(ACCOUNT);
    await app.close();
  });

  it('403s an account-scoped caller naming a SIBLING account', async () => {
    const { app } = await buildApp('viewer', ACCOUNT);

    const res = await app.inject({ method: 'GET', url: `/dnc/?account_id=${ACCOUNT_B}` });

    expect(res.statusCode).toBe(403);
    expect(mocks.list).not.toHaveBeenCalled();
    await app.close();
  });

  it('403s an account-scoped caller asking for the raw tenant-wide set', async () => {
    const { app } = await buildApp('viewer', ACCOUNT);

    const res = await app.inject({ method: 'GET', url: '/dnc/?account_id=tenant' });

    expect(res.statusCode).toBe(403);
    expect(mocks.list).not.toHaveBeenCalled();
    await app.close();
  });

  it('a TENANT-WIDE membership is unaffected — no filter forced, any scope allowed', async () => {
    const { app } = await buildApp('viewer'); // no account_id ⇒ tenant-wide

    await app.inject({ method: 'GET', url: '/dnc/' });
    expect('accountId' in (mocks.list.mock.calls[0]![0] as Record<string, unknown>)).toBe(false);

    mocks.list.mockClear();
    await app.inject({ method: 'GET', url: `/dnc/?account_id=${ACCOUNT_B}` });
    expect((mocks.list.mock.calls[0]![0] as Record<string, unknown>)['accountId']).toBe(ACCOUNT_B);
    await app.close();
  });
});

describe('DELETE /dnc/:id', () => {
  it('404s an id this tenant does not own, and does not leak its existence', async () => {
    mocks.remove.mockResolvedValue(null);
    const { app } = await buildApp();

    const res = await app.inject({ method: 'DELETE', url: '/dnc/someone-elses-entry' });

    // 404 rather than 403: the id is not a capability, and whether an entry
    // exists in another tenant's list is not this caller's business to learn.
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('is tenant-scoped at the call, not just in the SQL', async () => {
    const { app } = await buildApp();

    await app.inject({ method: 'DELETE', url: '/dnc/e1' });

    // Tenant-wide caller: exactly two arguments, no third `accountScope` at
    // all — asserted via `toHaveBeenCalledWith` so an explicit `undefined`
    // third argument (which would change nothing about the query but would
    // change this assertion) is also caught.
    expect(mocks.remove).toHaveBeenCalledWith('e1', TENANT);
    await app.close();
  });

  it('an account-scoped caller\'s delete is additionally scoped to their OWN account', async () => {
    const { app } = await buildApp('account_admin', ACCOUNT);

    await app.inject({ method: 'DELETE', url: '/dnc/e1' });

    // Forwarding the caller's own account closes the hole where an
    // account-scoped `account_admin` could un-suppress a tenant-wide or
    // sibling-account entry — `dncRepository.deleteById` refuses the delete
    // (returns null) when `account_id` does not match, which this route
    // reports as an ordinary 404.
    expect(mocks.remove).toHaveBeenCalledWith('e1', TENANT, ACCOUNT);
    await app.close();
  });

  it('404s (not the removed row) when an account-scoped caller\'s delete does not own the entry', async () => {
    mocks.remove.mockResolvedValue(null);
    const { app } = await buildApp('account_admin', ACCOUNT);

    const res = await app.inject({ method: 'DELETE', url: '/dnc/e1' });

    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('returns the removed row so a caller can report what became dialable', async () => {
    const { app } = await buildApp();

    const res = await app.inject({ method: 'DELETE', url: '/dnc/e1' });

    expect(res.json()).toMatchObject({ removed: { phone_e164: '+15551230001' } });
    await app.close();
  });
});

describe('platform audit trail (`MAG-70`)', () => {
  it('POST /dnc audits the add with counts and scope, and NO phone numbers', async () => {
    mocks.add.mockResolvedValue({
      added: 1,
      already_present: 0,
      invalid: 0,
      results: [{ input: '+15551230001', outcome: 'added', phone_e164: '+15551230001', entry_id: 'e1' }],
    });
    const { app } = await buildApp();

    const res = await app.inject({
      method: 'POST',
      url: '/dnc/',
      payload: { phone_numbers: ['+15551230001'], source: 'regulator' },
    });

    expect(res.statusCode).toBe(200);
    expect(mocks.auditLog).toHaveBeenCalledTimes(1);
    expect(mocks.auditLog).toHaveBeenCalledWith({
      tenant_id: TENANT,
      account_id: ACCOUNT,
      actor_type: 'human',
      user_id: USER,
      action: 'dnc_entry.created',
      resource_type: 'dnc_entry',
      details: {
        scope: 'tenant',
        source: 'regulator',
        requested: 1,
        added: 1,
        already_present: 0,
        invalid: 0,
      },
    });
    // The raw number must never reach the audit row, only the counts above.
    expect(JSON.stringify(mocks.auditLog.mock.calls[0]![0])).not.toContain('+15551230001');
    await app.close();
  });

  it('POST /dnc labels a dual-scope entry as the NARROW scope it actually is', async () => {
    // `findSuppressed` ANDs the two columns, so account+campaign matches strictly
    // less than account-wide. This assertion used to read `'account'` — the audit
    // row claimed a suppression reached the whole account when it reached one
    // campaign inside it, which is the opposite direction from the one a
    // compliance review can absorb.
    mocks.add.mockResolvedValue({ added: 1, already_present: 0, invalid: 0, results: [] });
    const { app } = await buildApp();

    await app.inject({
      method: 'POST',
      url: '/dnc/',
      payload: {
        phone_numbers: ['+15551230001'],
        account_id: ACCOUNT,
        campaign_id: '33333333-3333-4333-8333-333333333333',
      },
    });

    expect((mocks.auditLog.mock.calls[0]![0] as { details: { scope: string } }).details.scope).toBe(
      'account_campaign',
    );
    await app.close();
  });

  it('POST /dnc labels each single-column scope on its own', async () => {
    for (const [payload, expected] of [
      [{ account_id: ACCOUNT }, 'account'],
      [{ campaign_id: '33333333-3333-4333-8333-333333333333' }, 'campaign'],
    ] as const) {
      mocks.auditLog.mockClear();
      mocks.add.mockResolvedValue({ added: 1, already_present: 0, invalid: 0, results: [] });
      const { app } = await buildApp();

      await app.inject({
        method: 'POST',
        url: '/dnc/',
        payload: { phone_numbers: ['+15551230001'], ...payload },
      });

      expect((mocks.auditLog.mock.calls[0]![0] as { details: { scope: string } }).details.scope)
        .toBe(expected);
      await app.close();
    }
  });

  it('does NOT audit a bulk add that never reached the RBAC floor (403)', async () => {
    const { app } = await buildApp('agent');

    const res = await app.inject({
      method: 'POST',
      url: '/dnc/',
      payload: { phone_numbers: ['+15551230001'] },
    });

    expect(res.statusCode).toBe(403);
    expect(mocks.auditLog).not.toHaveBeenCalled();
    await app.close();
  });

  it('does NOT audit a validation failure (400)', async () => {
    const { app } = await buildApp();

    const res = await app.inject({ method: 'POST', url: '/dnc/', payload: { phone_numbers: [] } });

    expect(res.statusCode).toBe(400);
    expect(mocks.auditLog).not.toHaveBeenCalled();
    expect(mocks.add).not.toHaveBeenCalled();
    await app.close();
  });

  it('DELETE /dnc/:id audits the removal with scope, and NO phone number', async () => {
    mocks.remove.mockResolvedValue({
      id: 'e1',
      account_id: null,
      campaign_id: '33333333-3333-4333-8333-333333333333',
      source: 'agent',
      phone_e164: '+15551230001',
    });
    const { app } = await buildApp();

    const res = await app.inject({ method: 'DELETE', url: '/dnc/e1' });

    expect(res.statusCode).toBe(200);
    expect(mocks.auditLog).toHaveBeenCalledTimes(1);
    expect(mocks.auditLog).toHaveBeenCalledWith({
      tenant_id: TENANT,
      account_id: ACCOUNT,
      actor_type: 'human',
      user_id: USER,
      action: 'dnc_entry.deleted',
      resource_type: 'dnc_entry',
      resource_id: 'e1',
      campaign_id: '33333333-3333-4333-8333-333333333333',
      details: {
        scope: 'campaign',
        source: 'agent',
        campaign_id: '33333333-3333-4333-8333-333333333333',
      },
    });
    expect(JSON.stringify(mocks.auditLog.mock.calls[0]![0])).not.toContain('+15551230001');
    await app.close();
  });

  it('DELETE /dnc/:id reverses a dual-scope entry at the same reach it was added', async () => {
    // The add and the delete had the identical ternary written twice. If one is
    // fixed and the other is not, the trail shows a number suppressed at one reach
    // and un-suppressed at another, and reconciling the two becomes guesswork.
    mocks.remove.mockResolvedValue({
      id: 'e2',
      account_id: ACCOUNT,
      campaign_id: '33333333-3333-4333-8333-333333333333',
      source: 'agent',
      phone_e164: '+15551230001',
    });
    const { app } = await buildApp();

    await app.inject({ method: 'DELETE', url: '/dnc/e2' });

    expect((mocks.auditLog.mock.calls[0]![0] as { details: { scope: string } }).details.scope)
      .toBe('account_campaign');
    await app.close();
  });

  it('does NOT audit a delete for an id this tenant does not own (404)', async () => {
    mocks.remove.mockResolvedValue(null);
    const { app } = await buildApp();

    const res = await app.inject({ method: 'DELETE', url: '/dnc/someone-elses-entry' });

    expect(res.statusCode).toBe(404);
    expect(mocks.auditLog).not.toHaveBeenCalled();
    await app.close();
  });
});
