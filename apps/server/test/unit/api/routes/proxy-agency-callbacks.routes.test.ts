import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import type { MembershipRole } from '@magick-agency/contracts/rbac';
import { decodeKeysetCursor, encodeKeysetCursor } from '@magick-agency/domain/keyset-cursor';

/**
 * The account's callbacks list's public layer (`proxy-agency-callbacks.routes.ts`, decisions LF1,
 * LF22): the REAL `requirePermission` over the real matrix, every other dependency faked through
 * `deps`. The guard order (`agency.supervise`, then the account scope, then the dialer flag, then the
 * query's `400 invalid_callbacks_query`), `Cache-Control: no-store` on every answer, the query's
 * rules, each campaign's callback codes and local midnight handed to the read, the page and its
 * cursor, the rows' shaping (the customer's name from the roster, never the number; the owner named
 * and live). The SQL is pinned on Postgres (`test/integration/agency/callbacks-list.test.ts`).
 */

vi.mock('../../../../src/auth/session.middleware.js', () => ({ sessionMiddleware: async () => {} }));
vi.mock('../../../../src/api/middleware/tenant-context.middleware.js', () => ({ tenantContextMiddleware: async () => {} }));

import { proxyAgencyCallbacksRoutes, type CallbacksRouteDeps } from '../../../../src/api/routes/proxy-agency-callbacks.routes.js';
import type { CallbacksPageInput, CallbacksPageRow } from '../../../../src/db/repositories/agency.repository.js';

const TENANT = '33333333-3333-4333-8333-333333333333';
const ACCOUNT = '44444444-4444-4444-8444-444444444444';
const ME = '99999999-9999-4999-8999-999999999999';
const OWNER = '88888888-8888-4888-8888-888888888888';
const C1 = '11111111-1111-4111-8111-111111111111';
const C2 = '22222222-2222-4222-8222-222222222222';
const K1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const K2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const K3 = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const NOW = new Date('2026-11-19T10:00:00.000Z');

const CATALOG = [{ code: 'call_back', label: 'Call back', requires_datetime: true }, { code: 'sale', label: 'Sale' }];

let caller: { role: MembershipRole; accountId?: string | null };
let app: FastifyInstance;
let deps: CallbacksRouteDeps;
let pageRows: CallbacksPageRow[];
let pageCalls: CallbacksPageInput[];

function row(contact: string, campaign: string, over: Partial<CallbacksPageRow> = {}): CallbacksPageRow {
  return {
    contact_id: contact, campaign_id: campaign, context: { name: 'Ada Lovelace', phone: '+919811122233' },
    owner_id: OWNER, owner_live: false, inbound: false,
    due_at: new Date('2026-11-19T09:00:00.000Z'), due_key: '2026-11-19T09:00:00.123456Z', ...over,
  };
}

beforeEach(async () => {
  caller = { role: 'account_admin' };
  pageRows = [];
  pageCalls = [];
  deps = {
    activeCampaigns: vi.fn(async () => [
      { id: C1, name: 'Renewals', assignment_mode: 'strict' as const, disposition_catalog: CATALOG as never, default_timezone: 'Asia/Kolkata' },
      { id: C2, name: 'Winback', assignment_mode: 'pool' as const, disposition_catalog: [] as never, default_timezone: 'Not/AZone' },
    ]),
    page: vi.fn(async (input: CallbacksPageInput) => { pageCalls.push(input); return pageRows.slice(0, input.take); }),
    names: vi.fn(async () => new Map<string, string | null>([[OWNER, 'Naveen G']])),
    dialerEnabled: vi.fn(async () => true),
    now: () => NOW,
  };
  app = Fastify({ logger: false });
  app.addHook('onRequest', async (request) => {
    const r = request as unknown as Record<string, unknown>;
    r['tenantId'] = TENANT;
    r['accountId'] = caller.accountId === null ? undefined : caller.accountId ?? ACCOUNT;
    r['user'] = { id: ME };
    r['membership'] = { role: caller.role, account_id: ACCOUNT, status: 'active' };
  });
  await app.register(proxyAgencyCallbacksRoutes, { prefix: '/proxy/agency', deps });
  await app.ready();
});

afterEach(async () => { await app.close(); });

const get = (query = '') => app.inject({ method: 'GET', url: `/proxy/agency/callbacks${query ? `?${query}` : ''}` });

describe('the guards, in order', () => {
  it('agents, operators and viewers are refused by RBAC; nothing is read', async () => {
    for (const role of ['agent', 'viewer', 'operator'] as MembershipRole[]) {
      caller = { role };
      const res = await get();
      expect(res.statusCode, role).toBe(403);
      expect(res.json().message).toMatch(/^Insufficient permissions/);
      expect(res.headers['cache-control']).toBe('no-store');
    }
    expect(deps.dialerEnabled).not.toHaveBeenCalled();
    expect(deps.activeCampaigns).not.toHaveBeenCalled();
  });

  it('supervisors and up are served', async () => {
    for (const role of ['account_admin', 'tenant_admin', 'tenant_owner'] as MembershipRole[]) {
      caller = { role };
      expect((await get()).statusCode, role).toBe(200);
    }
  });

  it('no account: 400 account_scope_required before the dialer flag', async () => {
    caller = { role: 'account_admin', accountId: null };
    const res = await get();
    expect([res.statusCode, res.json().code]).toEqual([400, 'account_scope_required']);
    expect(deps.dialerEnabled).not.toHaveBeenCalled();
  });

  it('the dialer flag off: its 403, before the query is looked at', async () => {
    (deps.dialerEnabled as ReturnType<typeof vi.fn>).mockImplementation(async (_req: FastifyRequest, reply: FastifyReply) => {
      await reply.code(403).send({ error: 'Feature Not Enabled', code: 'feature_disabled', message: 'off' });
      return false;
    });
    const res = await get('due=never');
    expect([res.statusCode, res.json().code]).toEqual([403, 'feature_disabled']);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(deps.activeCampaigns).not.toHaveBeenCalled();
  });

  it('a bad query: 400 invalid_callbacks_query, nothing read', async () => {
    for (const q of ['due=late', 'due=overdue&due=today', 'campaign_id=c1', 'campaign_id=1%27--', 'cursor=nope',
      `cursor=${encodeKeysetCursor({ at: '2026-02-30T00:00:00.000000Z', id: K1 })}`, 'limit=0', 'limit=201', 'limit=2.5', 'limit=-1', 'limit=ten']) {
      const res = await get(q);
      expect([res.statusCode, res.json().code], q).toEqual([400, 'invalid_callbacks_query']);
      expect(res.json().error).toBe('Bad Request');
    }
    expect(deps.activeCampaigns).not.toHaveBeenCalled();
  });
});

describe('GET /callbacks', () => {
  it('reads the account\'s active campaigns and one page of their overdue callbacks by default, named, never a number, never cached', async () => {
    pageRows = [
      row(K1, C1),
      row(K2, C2, { owner_id: null, inbound: true, context: { full_name: 'Grace Hopper' } }),
      row(K3, C1, { owner_live: true, context: null }),
    ];
    const res = await get();
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(deps.activeCampaigns).toHaveBeenCalledWith(TENANT, ACCOUNT, null);
    expect(pageCalls).toHaveLength(1);
    const input = pageCalls[0]!;
    expect(input).toMatchObject({ tenantId: TENANT, accountId: ACCOUNT, due: 'overdue', now: NOW, after: null, take: 51 });
    // Each campaign's callback codes from its catalog, its "today" ending at its own midnight (a
    // zone that will not read: UTC's).
    expect(input.campaigns).toEqual([
      { id: C1, callbackCodes: ['call_back'], dayEnd: new Date('2026-11-19T18:30:00.000Z') },
      { id: C2, callbackCodes: [], dayEnd: new Date('2026-11-20T00:00:00.000Z') },
    ]);
    const body = res.json();
    expect(body).toEqual({
      rows: [
        {
          contact_id: K1, campaign_id: C1, campaign_name: 'Renewals', assignment_mode: 'strict', customer_name: 'Ada Lovelace',
          due_at: '2026-11-19T09:00:00.000Z', owner: { user_id: OWNER, name: 'Naveen G', live: false }, source: 'outcome',
        },
        {
          contact_id: K2, campaign_id: C2, campaign_name: 'Winback', assignment_mode: 'pool', customer_name: 'Grace Hopper',
          due_at: '2026-11-19T09:00:00.000Z', owner: null, source: 'inbound',
        },
        {
          contact_id: K3, campaign_id: C1, campaign_name: 'Renewals', assignment_mode: 'strict', customer_name: null,
          due_at: '2026-11-19T09:00:00.000Z', owner: { user_id: OWNER, name: 'Naveen G', live: true }, source: 'outcome',
        },
      ],
      next_cursor: null,
      limit: 50,
      due: 'overdue',
      as_of: NOW.toISOString(),
    });
    expect(JSON.stringify(body)).not.toMatch(/9811122233|phone/);
  });

  it('pages: one row more than the limit read, the cursor minted from the last row shown to the microsecond', async () => {
    pageRows = [row(K1, C1), row(K2, C1, { due_key: '2026-11-19T09:00:00.654321Z' }), row(K3, C1)];
    const res = await get('limit=2&due=today');
    expect(pageCalls[0]).toMatchObject({ due: 'today', take: 3 });
    const body = res.json();
    expect(body.rows.map((r: { contact_id: string }) => r.contact_id)).toEqual([K1, K2]);
    expect(body.limit).toBe(2);
    expect(decodeKeysetCursor(body.next_cursor)).toEqual({ at: '2026-11-19T09:00:00.654321Z', id: K2 });
    expect(JSON.stringify(decodeKeysetCursor(body.next_cursor))).not.toMatch(/9811122233/);

    // The next page starts after it.
    await get(`limit=2&due=today&cursor=${body.next_cursor}`);
    expect(pageCalls[1]!.after).toEqual({ at: '2026-11-19T09:00:00.654321Z', id: K2 });
  });

  it('a campaign named: only it, lower-cased, among the account\'s active ones', async () => {
    await get(`campaign_id=${C1.toUpperCase()}`);
    expect(deps.activeCampaigns).toHaveBeenCalledWith(TENANT, ACCOUNT, C1);
  });

  it('a campaign that is not an active one of the account: no rows, no error, no oracle', async () => {
    (deps.activeCampaigns as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    const res = await get(`campaign_id=${C2}`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ rows: [], next_cursor: null });
    expect(pageCalls[0]!.campaigns).toEqual([]);
  });
});
