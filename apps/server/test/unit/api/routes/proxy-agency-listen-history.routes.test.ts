import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type { MembershipRole } from '@magick-agency/contracts/rbac';

/**
 * The listening history's public layer (`proxy-agency-listen-history.routes.ts`,
 * docs/listening.md §12): the REAL `requirePermission` over the real matrix and the app-wide error
 * mask, every dependency faked through `deps`. The guard order (permission, then the consent
 * flag's `403 feature_disabled`, a flag store outage `503 listen_unavailable` that keeps its code
 * through the mask), the query refused at the edge (malformed ids, unknown keys, an inverted
 * range) before anything is read, the scope and filters forwarded, names and masking, the CSV's
 * drain across pages, its row ceiling and its audit row, and a refused page answering its own
 * status with no file and no audit row. The SQL is pinned on Postgres by
 * `test/integration/agency/listen-history.test.ts`.
 */

vi.mock('../../../../src/auth/session.middleware.js', () => ({ sessionMiddleware: async () => {} }));
vi.mock('../../../../src/api/middleware/tenant-context.middleware.js', () => ({ tenantContextMiddleware: async () => {} }));
vi.mock('@magick-agency/contracts/api/agency/listen-history', async (orig) => ({
  ...(await orig<typeof import('@magick-agency/contracts/api/agency/listen-history')>()),
  // A small ceiling, so the truncation case drains a few pages, not ten thousand rows.
  AGENCY_LISTEN_HISTORY_EXPORT_MAX_ROWS: 5,
}));

import {
  listenHistoryCsvRow,
  proxyAgencyListenHistoryRoutes,
  type ListenHistoryRouteDeps,
} from '../../../../src/api/routes/proxy-agency-listen-history.routes.js';
import type { CoreCallRequest, CoreCallResult } from '../../../../src/api/core-dispatch.js';
import { errorMaskHook } from '../../../../src/api/middleware/error-mask.middleware.js';
import type { CoreListenHistoryEntry } from '../../../../src/api/routes/agency/listen-history.js';

const TENANT = '33333333-3333-4333-8333-333333333333';
const ACCOUNT = '44444444-4444-4444-8444-444444444444';
const ME = '99999999-9999-4999-8999-999999999999';
const AGENT = '88888888-8888-4888-8888-888888888888';

function entry(over: Partial<CoreListenHistoryEntry> = {}): CoreListenHistoryEntry {
  return {
    id: '11111111-1111-4111-8111-111111111111', listen_ids: ['11111111-1111-4111-8111-111111111111'],
    call_id: '55555555-5555-4555-8555-555555555555', origin: 'inbound', correlation_id: '77777777-7777-4777-8777-777777777777',
    campaign_id: null, campaign_name: null, inbound_route_name: 'Main line', listener_user_id: ME, agent_user_id: AGENT,
    customer_name: 'Asha', customer_phone: '+919812345678', started_at: '2026-11-16T10:00:00.000Z',
    ended_at: '2026-11-16T10:02:10.000Z', listened_seconds: 130, end_reason: 'listener_stopped', ...over,
  };
}

const json = (status: number, body: unknown): CoreCallResult => ({ status, body, headers: new Headers({ 'content-type': 'application/json' }) });

let role: MembershipRole;
let app: FastifyInstance;
let calls: CoreCallRequest[];
let pages: CoreCallResult[];
let deps: ListenHistoryRouteDeps & { audit: ReturnType<typeof vi.fn>; listenFlags: ReturnType<typeof vi.fn> };

beforeEach(async () => {
  role = 'account_admin';
  calls = [];
  pages = [json(200, { entries: [entry()], next_cursor: null })];
  deps = {
    listenFlags: vi.fn(async () => ({ enabled: true, unrecordedAllowed: true })),
    callCore: vi.fn(async (req: CoreCallRequest) => {
      calls.push(req);
      return pages.length > 1 ? pages.shift()! : pages[0]!;
    }),
    names: vi.fn(async () => new Map([[ME, 'Meera S'], [AGENT, 'Ravi K']])),
    audit: vi.fn(),
  } as never;
  app = Fastify({ logger: false });
  app.addHook('onSend', errorMaskHook);
  app.addHook('onRequest', async (request) => {
    const r = request as unknown as Record<string, unknown>;
    r['tenantId'] = TENANT;
    r['accountId'] = ACCOUNT;
    r['user'] = { id: ME };
    r['membership'] = { role, account_id: ACCOUNT, status: 'active' };
  });
  await app.register(proxyAgencyListenHistoryRoutes, { prefix: '/proxy/agency', deps });
  await app.ready();
});

afterEach(async () => { await app.close(); });

const get = (url: string) => app.inject({ method: 'GET', url });
const BOTH = ['/proxy/agency/listen-history', '/proxy/agency/listen-history.csv'];

describe('the guards', () => {
  it('agents, operators and viewers are refused by RBAC; the flag is not read', async () => {
    for (const r of ['agent', 'operator', 'viewer'] as MembershipRole[]) {
      role = r;
      for (const url of BOTH) {
        const res = await get(url);
        expect(res.statusCode, `${r} ${url}`).toBe(403);
        expect(res.json().message).toMatch(/^Insufficient permissions/);
      }
    }
    expect(deps.listenFlags).not.toHaveBeenCalled();
  });

  it('the consent flag off: 403 feature_disabled; nothing read', async () => {
    deps.listenFlags.mockResolvedValue({ enabled: false, unrecordedAllowed: true });
    for (const url of BOTH) expect((await get(url)).json().code).toBe('feature_disabled');
    expect(calls).toEqual([]);
  });

  it('the flags cannot be read: 503 listen_unavailable through the mask (the console retries), nothing read', async () => {
    deps.listenFlags.mockRejectedValue(new Error('flag store down'));
    for (const url of BOTH) {
      const res = await get(url);
      expect([res.statusCode, res.json().code]).toEqual([503, 'listen_unavailable']);
    }
    expect(calls).toEqual([]);
  });

  it('a malformed id, an unknown key, an inverted range or an oversize page is a 400 before anything is read', async () => {
    for (const q of [
      'listener_user_id=nope', 'agent_user_id=1', 'from=yesterday', 'listener=x',
      'from=2026-11-02T00:00:00Z&to=2026-11-01T00:00:00Z', 'limit=101', 'limit=0',
    ]) {
      const res = await get(`/proxy/agency/listen-history?${q}`);
      expect(res.statusCode, q).toBe(400);
    }
    // The export takes no paging.
    expect((await get('/proxy/agency/listen-history.csv?limit=10')).statusCode).toBe(400);
    expect(calls).toEqual([]);
  });
});

describe('GET /listen-history', () => {
  it('forwards the scope and the filters, adds the names and masks the number', async () => {
    const res = await get(`/proxy/agency/listen-history?listener_user_id=${ME.toUpperCase()}&agent_user_id=${AGENT}&from=2026-11-01T00:00:00Z&to=2026-11-17T00:00:00%2B05:30&limit=20&cursor=abc`);
    expect(res.statusCode).toBe(200);
    expect(calls[0]).toMatchObject({
      method: 'GET', path: '/agency/listen-history', tenantId: TENANT, accountId: ACCOUNT,
      query: { listener_user_id: ME, agent_user_id: AGENT, from: '2026-11-01T00:00:00Z', to: '2026-11-17T00:00:00+05:30', limit: '20', cursor: 'abc' },
    });
    expect(res.body).not.toContain('9812345678');
    // It names customers (masked) and supervisors: never cached, as the export is not.
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.json()).toEqual({
      next_cursor: null,
      entries: [expect.objectContaining({
        listener_name: 'Meera S', agent_name: 'Ravi K', customer_phone_masked: '****5678', customer_phone_withheld: false,
        inbound_route_name: 'Main line', listened_seconds: 130, end_reason: 'listener_stopped',
      })],
    });
    expect(res.json().entries[0]).not.toHaveProperty('customer_phone');
  });

  it('a withheld caller is "withheld" with no mask, by the live list\'s rule (no digit at all); a purged call row neither', async () => {
    pages = [json(200, {
      entries: [entry({ customer_phone: '' }), entry({ customer_phone: 'anonymous' }), entry({ customer_phone: null })],
      next_cursor: null,
    })];
    const body = (await get('/proxy/agency/listen-history')).json();
    expect(body.entries.map((e: Record<string, unknown>) => [e['customer_phone_masked'], e['customer_phone_withheld']]))
      .toEqual([[null, true], [null, true], [null, false]]);
  });

  it('the internal handler\'s refusal keeps its status and body', async () => {
    pages = [json(400, { error: 'Validation failed', code: 'malformed_cursor', details: { cursor: 'not a cursor this API issued' } })];
    const res = await get('/proxy/agency/listen-history?cursor=zzz');
    expect([res.statusCode, res.json().code]).toEqual([400, 'malformed_cursor']);
  });
});

describe('GET /listen-history.csv', () => {
  it('drains every page, masked numbers only, words for the ending, and writes one audit row', async () => {
    pages = [
      json(200, { entries: [entry(), entry({ customer_phone: '', end_reason: null, ended_at: null, listened_seconds: null })], next_cursor: 'c1' }),
      json(200, { entries: [entry({ origin: 'campaign', campaign_name: '=HYPERLINK("x")', end_reason: 'permission_revoked' })], next_cursor: null }),
    ];
    const res = await get(`/proxy/agency/listen-history.csv?agent_user_id=${AGENT}`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-disposition']).toMatch(/listening-history-\d{4}-\d{2}-\d{2}\.csv/);
    expect(res.headers['x-export-rows']).toBe('3');
    expect(calls.map((c) => c.query)).toEqual([
      { agent_user_id: AGENT, limit: '100' },
      { agent_user_id: AGENT, limit: '100', cursor: 'c1' },
    ]);
    const lines = res.body.trim().split('\n');
    expect(lines).toHaveLength(4);
    expect(res.body).not.toContain('9812345678');
    expect(lines[1]).toContain('****5678');
    expect(lines[1]).toContain('Stopped by the supervisor');
    expect(lines[2]).toContain('Withheld');
    expect(lines[2]).toContain('Listening now');
    expect(lines[3]).toContain('Access to listen was removed');
    // The formula guard: a campaign name that starts a formula is never a live cell.
    expect(lines[3]).not.toMatch(/,=HYPERLINK/);
    expect(deps.audit).toHaveBeenCalledTimes(1);
    expect(deps.audit.mock.calls[0]![0]).toMatchObject({
      tenant_id: TENANT, account_id: ACCOUNT, action: 'agency_listen_sessions.exported', resource_type: 'account',
      resource_id: ACCOUNT, details: { rows: 3, filters: { agent_user_id: AGENT } },
    });
    expect(deps.audit.mock.calls[0]![0].details).not.toHaveProperty('truncated');
  });

  it('past the row ceiling the file is cut and says so, in its headers and its audit row', async () => {
    pages = [
      json(200, { entries: [entry(), entry(), entry()], next_cursor: 'c1' }),
      json(200, { entries: [entry(), entry(), entry()], next_cursor: 'c2' }),
    ];
    const res = await get('/proxy/agency/listen-history.csv');
    expect(res.headers['x-export-rows']).toBe('5');
    expect(res.headers['x-export-truncated']).toBe('true');
    expect(res.headers['x-export-truncated-reason']).toBe('row_limit');
    expect(res.headers['x-export-row-limit']).toBe('5');
    expect(deps.audit.mock.calls[0]![0].details).toMatchObject({ rows: 5, truncated: 'row_limit' });
  });

  it('a page refused mid-export answers its status: no file, no audit row', async () => {
    pages = [
      json(200, { entries: [entry()], next_cursor: 'c1' }),
      json(500, { error: 'Internal Server Error', message: 'boom' }),
    ];
    const res = await get('/proxy/agency/listen-history.csv');
    expect(res.statusCode).toBe(500);
    expect(res.headers['content-type']).not.toContain('text/csv');
    expect(deps.audit).not.toHaveBeenCalled();
  });

  it('a row never carries a full number', () => {
    const line = listenHistoryCsvRow({
      ...entry(), listener_name: null, agent_name: null, customer_phone_masked: '****5678', customer_phone_withheld: false,
    } as never);
    expect(line).not.toContain('9812345678');
  });
});
