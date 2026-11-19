import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import type { MembershipRole } from '@magick-agency/contracts/rbac';

/**
 * The Live floor's public layer (`proxy-agency-floor.routes.ts`, decision B28b): the REAL
 * `requirePermission` over the real matrix, every other dependency faked through `deps`. The guard
 * order on both routes (`agency.supervise`, then the account scope, then the dialer flag, then the
 * query's 400 with the route's code), `Cache-Control: no-store` on every answer, refusals included;
 * the floor's shaping (names, the call without a number, listenability by the live calls list's
 * rule only while listening is on, never the floor refused for want of the listening flag), the
 * internal handler's refusals passed through and an unrecognised body as 502; the promises
 * summary's shaping. The SQL is pinned on Postgres (`floor-repository.test.ts`,
 * `promise-summary-repository.test.ts`).
 */

vi.mock('../../../../src/auth/session.middleware.js', () => ({ sessionMiddleware: async () => {} }));
vi.mock('../../../../src/api/middleware/tenant-context.middleware.js', () => ({ tenantContextMiddleware: async () => {} }));

import { proxyAgencyFloorRoutes, type FloorRouteDeps } from '../../../../src/api/routes/proxy-agency-floor.routes.js';
import type { CoreCallRequest, CoreCallResult } from '../../../../src/api/core-dispatch.js';
import type { CoreFloorAgent } from '../../../../src/api/routes/agency/floor.js';

const TENANT = '33333333-3333-4333-8333-333333333333';
const ACCOUNT = '44444444-4444-4444-8444-444444444444';
const ME = '99999999-9999-4999-8999-999999999999';
const AGENT = '88888888-8888-4888-8888-888888888888';
const AWAY = '77777777-7777-4777-8777-777777777777';
const OTHER_LISTENER = '66666666-6666-4666-8666-666666666666';
const CALL = '55555555-5555-4555-8555-555555555555';
const SESSION = '11111111-1111-4111-8111-111111111111';
const NOW = new Date('2026-11-18T10:00:00.000Z');
const FROM = '2026-11-18T00:00:00+05:30';

const json = (status: number, body: unknown): CoreCallResult => ({ status, body, headers: new Headers({ 'content-type': 'application/json' }) });

function onCall(over: Partial<CoreFloorAgent> = {}): CoreFloorAgent {
  return {
    agent_user_id: AGENT, session_id: SESSION, campaign_id: 'c-1', campaign_name: 'Renewals', state: 'on_call',
    state_since: '2026-11-18T09:58:00.000Z', connected: true, client_kind: 'web', break_reason: null, break_label: null,
    on_inbound_call: false, inbound_outcome_owed: false, wrapup_window_seconds: 30, calls_today: 12, left_at: null,
    help: { raised_at: '2026-11-18T09:59:00.000Z', call_id: CALL },
    call: {
      call_id: CALL, origin: 'campaign', correlation_id: 'att-1', customer_name: 'Ada', connected_at: '2026-11-18T09:58:30.000Z',
      aht_seconds: 182.5, recording: true, listener_user_ids: [],
    },
    break_limit_minutes: null,
    ...over,
  };
}

function away(): CoreFloorAgent {
  return {
    agent_user_id: AWAY, session_id: null, campaign_id: null, campaign_name: null, state: 'offline', state_since: null,
    connected: null, client_kind: null, break_reason: null, break_label: null, on_inbound_call: false, inbound_outcome_owed: false,
    wrapup_window_seconds: null, call: null, calls_today: 3, left_at: '2026-11-18T08:10:00.000Z', help: null,
    break_limit_minutes: null,
  };
}

let caller: { role: MembershipRole; accountId?: string | null };
let app: FastifyInstance;
let floor: { agents: CoreFloorAgent[]; totals: { on_shift: number; assigned: number }; as_of: string };
let deps: FloorRouteDeps & { calls: CoreCallRequest[]; coreAnswer: CoreCallResult | null };
/** The account's flags as the snapshot `deps.flags` answers resolves them, by key. */
let flagValues: Record<string, boolean>;

beforeEach(async () => {
  caller = { role: 'account_admin' };
  floor = { agents: [onCall(), away()], totals: { on_shift: 1, assigned: 2 }, as_of: NOW.toISOString() };
  flagValues = { agency_live_listen_enabled: true, agency_live_listen_unrecorded: true, agency_floor_assist_enabled: true };
  const d = {
    calls: [] as CoreCallRequest[],
    coreAnswer: null as CoreCallResult | null,
    callCore: vi.fn(async (req: CoreCallRequest) => { d.calls.push(req); return d.coreAnswer ?? json(200, floor); }),
    names: vi.fn(async () => new Map<string, string | null>([[AGENT, 'Agent Smith']])),
    flags: vi.fn(async () => ({
      isEnabled: (flag: { key: string }) => flagValues[flag.key] ?? false,
      getValue: (flag: { key: string }) => flagValues[flag.key],
    })),
    maxPerCall: () => 2,
    dialerEnabled: vi.fn(async () => true),
    promiseSummary: vi.fn(async () => [
      { campaign_id: 'c-1', promises: 3, with_amount: 2, amount_total: '1500.50' },
      { campaign_id: null, promises: 1, with_amount: 0, amount_total: '0.00' },
    ]),
    promiseCampaignIds: vi.fn(async () => ['c-1']),
    now: () => NOW,
  };
  deps = d as never;
  app = Fastify({ logger: false });
  app.addHook('onRequest', async (request) => {
    const r = request as unknown as Record<string, unknown>;
    r['tenantId'] = TENANT;
    r['accountId'] = caller.accountId === null ? undefined : caller.accountId ?? ACCOUNT;
    r['user'] = { id: ME };
    r['membership'] = { role: caller.role, account_id: ACCOUNT, status: 'active' };
  });
  await app.register(proxyAgencyFloorRoutes, { prefix: '/proxy/agency', deps });
  await app.ready();
});

afterEach(async () => { await app.close(); });

const getFloor = (from: string | null = FROM) =>
  app.inject({ method: 'GET', url: `/proxy/agency/floor${from === null ? '' : `?from=${encodeURIComponent(from)}`}` });
const getPromises = (query = `from=${encodeURIComponent(FROM)}&to=${encodeURIComponent('2026-11-19T00:00:00+05:30')}`) =>
  app.inject({ method: 'GET', url: `/proxy/agency/promises/summary?${query}` });

describe('the guards, in order, on both routes', () => {
  it('agents, operators and viewers are refused by RBAC; nothing else is read', async () => {
    for (const role of ['agent', 'viewer', 'operator'] as MembershipRole[]) {
      caller = { role };
      for (const res of [await getFloor(), await getPromises()]) {
        expect(res.statusCode, role).toBe(403);
        expect(res.json().message).toMatch(/^Insufficient permissions/);
        expect(res.headers['cache-control']).toBe('no-store');
      }
    }
    expect(deps.dialerEnabled).not.toHaveBeenCalled();
    expect(deps.calls).toEqual([]);
    expect(deps.promiseSummary).not.toHaveBeenCalled();
  });

  it('no account: 400 account_scope_required before the dialer flag', async () => {
    caller = { role: 'account_admin', accountId: null };
    for (const res of [await getFloor(), await getPromises()]) {
      expect([res.statusCode, res.json().code]).toEqual([400, 'account_scope_required']);
    }
    expect(deps.dialerEnabled).not.toHaveBeenCalled();
  });

  it('the dialer flag off: its 403, before the query is looked at', async () => {
    (deps.dialerEnabled as ReturnType<typeof vi.fn>).mockImplementation(async (_req: FastifyRequest, reply: FastifyReply) => {
      await reply.code(403).send({ error: 'Feature Not Enabled', code: 'feature_disabled', message: 'off' });
      return false;
    });
    for (const res of [await getFloor('nonsense'), await getPromises('from=x')]) {
      expect([res.statusCode, res.json().code]).toEqual([403, 'feature_disabled']);
      expect(res.headers['cache-control']).toBe('no-store');
    }
    expect(deps.calls).toEqual([]);
  });

  it('a bad floor query: 400 invalid_floor_query, the internal handler not asked', async () => {
    for (const from of [null, 'yesterday', '2026-11-18', '2026-11-16T00:00:00Z', '2026-11-19T00:00:00Z']) {
      const res = await getFloor(from);
      expect([res.statusCode, res.json().code], String(from)).toEqual([400, 'invalid_floor_query']);
    }
    expect(deps.calls).toEqual([]);
  });

  it('a bad promises window: 400 invalid_promises_query, nothing read', async () => {
    for (const q of ['', `from=${encodeURIComponent(FROM)}`, 'from=2026-11-18T00:00:00Z&to=2026-11-18T00:00:00Z',
      'from=2026-10-01T00:00:00Z&to=2026-11-18T00:00:00Z', 'from=a&to=b']) {
      const res = await getPromises(q);
      expect([res.statusCode, res.json().code], q).toEqual([400, 'invalid_promises_query']);
    }
    expect(deps.promiseSummary).not.toHaveBeenCalled();
    expect(deps.promiseCampaignIds).not.toHaveBeenCalled();
  });
});

describe('GET /floor', () => {
  it('asks the internal handler for the account, with `from` as a UTC instant, and serves it named, without a number, never cached', async () => {
    const res = await getFloor();
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(deps.calls).toEqual([{ method: 'GET', path: '/agency/floor', query: { from: '2026-11-17T18:30:00.000Z' }, tenantId: TENANT, accountId: ACCOUNT }]);
    expect(deps.names).toHaveBeenCalledWith([AGENT, AWAY], TENANT);
    const body = res.json();
    expect(body).toEqual({
      agents: [
        {
          agent_user_id: AGENT, agent_name: 'Agent Smith', session_id: SESSION, campaign_id: 'c-1', campaign_name: 'Renewals',
          state: 'on_call', state_since: '2026-11-18T09:58:00.000Z', connected: true, client_kind: 'web',
          break_reason: null, break_label: null, on_inbound_call: false, inbound_outcome_owed: false, wrapup_window_seconds: 30,
          call: {
            call_id: CALL, origin: 'campaign', correlation_id: 'att-1', customer_name: 'Ada', connected_at: '2026-11-18T09:58:30.000Z',
            aht_seconds: 182.5, listenable: true, not_listenable_reason: null,
          },
          calls_today: 12, left_at: null,
          help: { raised_at: '2026-11-18T09:59:00.000Z', call_id: CALL },
          break_limit_minutes: null,
        },
        {
          agent_user_id: AWAY, agent_name: null, session_id: null, campaign_id: null, campaign_name: null, state: 'offline',
          state_since: null, connected: null, client_kind: null, break_reason: null, break_label: null, on_inbound_call: false,
          inbound_outcome_owed: false, wrapup_window_seconds: null, call: null, calls_today: 3, left_at: '2026-11-18T08:10:00.000Z',
          help: null,
          break_limit_minutes: null,
        },
      ],
      totals: { on_shift: 1, assigned: 2 },
      as_of: NOW.toISOString(),
    });
    // The wire never carries the listeners or the recording flag the rule read.
    expect(JSON.stringify(body)).not.toMatch(/listener|recording|phone/);
  });

  it('LF6, LF20: serves the break\'s limit as the internal handler answers it', async () => {
    floor.agents = [onCall({
      state: 'break', break_reason: 'tea', break_label: 'Tea', break_limit_minutes: 15, call: null,
    })];
    const agent = (await getFloor()).json().agents[0];
    expect(agent).toMatchObject({ break_reason: 'tea', break_label: 'Tea', break_limit_minutes: 15 });
  });

  it('listenability is the live calls list\'s rule: the cap, an unrecorded call, the reader\'s own call', async () => {
    floor.agents = [
      onCall({ call: { ...onCall().call!, listener_user_ids: [OTHER_LISTENER, 'x'] } }),
      onCall({ agent_user_id: 'a-2', session_id: 's-2', call: { ...onCall().call!, call_id: 'c2', recording: false } }),
      onCall({ agent_user_id: ME, session_id: 's-3', call: { ...onCall().call!, call_id: 'c3' } }),
      onCall({ agent_user_id: 'a-4', session_id: 's-4', call: { ...onCall().call!, call_id: 'c4', listener_user_ids: [ME, OTHER_LISTENER] } }),
    ];
    flagValues['agency_live_listen_unrecorded'] = false;
    const calls = (await getFloor()).json().agents.map((a: { call: { listenable: boolean; not_listenable_reason: string | null } }) => [a.call.listenable, a.call.not_listenable_reason]);
    expect(calls).toEqual([
      [false, 'listen_limit_call'],
      [false, 'listen_recording_off'],
      [false, 'listen_own_call'],
      // The reader's own open listen does not count against them.
      [true, null],
    ]);
    // One snapshot of the account's flags per poll, for listening and floor assist alike.
    expect(deps.flags).toHaveBeenCalledTimes(1);
    expect(deps.flags).toHaveBeenCalledWith(TENANT, ACCOUNT);
  });

  it('listening off for the account: the floor is served, every call unlistenable with no reason', async () => {
    flagValues['agency_live_listen_enabled'] = false;
    const res = await getFloor();
    expect(res.statusCode).toBe(200);
    expect(res.json().agents[0].call).toMatchObject({ customer_name: 'Ada', listenable: false, not_listenable_reason: null });
  });

  it('the listening flags unreadable: the floor is served (never a 503), every call unlistenable', async () => {
    (deps.flags as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('flag store down'));
    const res = await getFloor();
    expect(res.statusCode).toBe(200);
    expect(res.json().agents[0].call).toMatchObject({ listenable: false, not_listenable_reason: null });
  });

  it('Need help (LF4) only while floor assist is on: off, every row\'s help is null; the flag read for the account', async () => {
    expect((await getFloor()).json().agents[0].help).toEqual({ raised_at: '2026-11-18T09:59:00.000Z', call_id: CALL });
    expect(deps.flags).toHaveBeenCalledWith(TENANT, ACCOUNT);
    flagValues['agency_floor_assist_enabled'] = false;
    const off = await getFloor();
    expect(off.statusCode).toBe(200);
    expect(off.json().agents.map((a: { help: unknown }) => a.help)).toEqual([null, null]);
  });

  it('the floor assist flag unreadable: the floor is served (never a 503), no row carries help', async () => {
    (deps.flags as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('flag store down'));
    const res = await getFloor();
    expect(res.statusCode).toBe(200);
    expect(res.json().agents[0]).toMatchObject({ help: null, calls_today: 12 });
  });

  it('passes the internal handler\'s refusal through; an unrecognised body is a 502', async () => {
    deps.coreAnswer = json(400, { error: 'Bad Request', message: 'no' });
    expect((await getFloor()).statusCode).toBe(400);
    deps.coreAnswer = json(200, { rows: [] });
    const res = await getFloor();
    expect([res.statusCode, res.json().error]).toEqual([502, 'Bad Gateway']);
    expect(deps.names).not.toHaveBeenCalled();
  });
});

describe('GET /promises/summary', () => {
  it('serves the per-campaign counts and exact totals, the promise campaigns, and the window as UTC instants', async () => {
    const res = await getPromises();
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.json()).toEqual({
      campaigns: [
        { campaign_id: 'c-1', promises: 3, with_amount: 2, amount_total: '1500.50' },
        { campaign_id: null, promises: 1, with_amount: 0, amount_total: '0.00' },
      ],
      promise_campaign_ids: ['c-1'],
      from: '2026-11-17T18:30:00.000Z',
      to: '2026-11-18T18:30:00.000Z',
    });
    expect(deps.promiseSummary).toHaveBeenCalledWith(TENANT, ACCOUNT, new Date('2026-11-17T18:30:00.000Z'), new Date('2026-11-18T18:30:00.000Z'));
    expect(deps.promiseCampaignIds).toHaveBeenCalledWith(TENANT, ACCOUNT);
  });
});
