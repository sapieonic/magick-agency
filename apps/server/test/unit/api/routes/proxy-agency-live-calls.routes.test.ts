import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type { MembershipRole } from '@magick-agency/contracts/rbac';

/**
 * The live-call routes' public layer (`proxy-agency-live-calls.routes.ts`, docs/listening.md §4):
 * the REAL `requirePermission` over the real matrix, every dependency faked through `deps`. The
 * guard order (permission, then the consent flag's `403 feature_disabled`), the UUID check at the
 * edge (a malformed call id is the uniform 404), the masking and the per-caller `listenable`, the
 * number reveal, and the grant's own refusals (own call, LS4) before `callCore` and its mapping of
 * the owning process's answer, through the app-wide error mask (a 503 refusal keeps its code). The SQL is pinned on Postgres by the live-listen end-to-end suite.
 */

vi.mock('../../../../src/auth/session.middleware.js', () => ({ sessionMiddleware: async () => {} }));
vi.mock('../../../../src/api/middleware/tenant-context.middleware.js', () => ({ tenantContextMiddleware: async () => {} }));

import { notListenableReason, proxyAgencyLiveCallsRoutes, type LiveCallRouteDeps } from '../../../../src/api/routes/proxy-agency-live-calls.routes.js';
import type { CoreCallRequest, CoreCallResult } from '../../../../src/api/core-dispatch.js';
import { errorMaskHook } from '../../../../src/api/middleware/error-mask.middleware.js';

const TENANT = '33333333-3333-4333-8333-333333333333';
const ACCOUNT = '44444444-4444-4444-8444-444444444444';
const ME = '99999999-9999-4999-8999-999999999999';
const AGENT = '88888888-8888-4888-8888-888888888888';
const CALL = '55555555-5555-4555-8555-555555555555';
const SESSION = '11111111-1111-4111-8111-111111111111';

function coreCall(over: Record<string, unknown> = {}) {
  return {
    call_id: CALL, origin: 'campaign', correlation_id: '77777777-7777-4777-8777-777777777777',
    campaign_id: '66666666-6666-4666-8666-666666666666', campaign_name: 'Renewals', inbound_route_name: null,
    agent_user_id: AGENT, agent_session_id: SESSION, client_kind: 'web', customer_name: 'Ada', customer_phone: '+919812345678',
    connected_at: '2026-11-16T10:00:00.000Z', recording: true, aht_seconds: 182.5, listeners: [], ...over,
  };
}

let caller: { userId: string; role: MembershipRole; accountId?: string | null };
let app: FastifyInstance;
let deps: LiveCallRouteDeps & { calls: CoreCallRequest[]; live: Array<Record<string, unknown>>; grantAnswer: CoreCallResult };

const json = (status: number, body: unknown): CoreCallResult => ({ status, body, headers: new Headers({ 'content-type': 'application/json' }) });

beforeEach(async () => {
  caller = { userId: ME, role: 'account_admin' };
  const d = {
    calls: [] as CoreCallRequest[],
    live: [coreCall()],
    grantAnswer: json(201, { listen_id: 'L', ws_url: `/proxy/agency/listen/${SESSION}/L?token=t`, expires_at: '2026-11-16T10:01:00.000Z' }),
    listenFlags: vi.fn(async () => ({ enabled: true, unrecordedAllowed: true })),
    callCore: vi.fn(async (req: CoreCallRequest) => {
      d.calls.push(req);
      if (req.path === '/agency/live-calls') {
        const callId = req.query?.['call_id'];
        return json(200, { calls: d.live.filter((c) => !callId || c['call_id'] === callId), as_of: '2026-11-16T10:05:00.000Z' });
      }
      return d.grantAnswer;
    }),
    names: vi.fn(async () => new Map([[AGENT, 'Agent Smith'], [ME, 'Me Supervisor']])),
    maxPerCall: () => 2,
    trackGrant: vi.fn(),
  };
  deps = d as never;
  app = Fastify({ logger: false });
  // The app-wide error mask (`app.ts`): the grant's 503 refusals must reach the console with their code.
  app.addHook('onSend', errorMaskHook);
  app.addHook('onRequest', async (request) => {
    const r = request as unknown as Record<string, unknown>;
    r['tenantId'] = TENANT;
    r['accountId'] = caller.accountId === null ? undefined : caller.accountId ?? ACCOUNT;
    r['user'] = { id: caller.userId };
    r['membership'] = { role: caller.role, account_id: ACCOUNT, status: 'active' };
  });
  await app.register(proxyAgencyLiveCallsRoutes, { prefix: '/proxy/agency', deps });
  await app.ready();
});

afterEach(async () => { await app.close(); });

const get = (url: string) => app.inject({ method: 'GET', url });
const listen = (callId = CALL) => app.inject({ method: 'POST', url: `/proxy/agency/live-calls/${callId}/listen` });

describe('the guards', () => {
  it('agents and operators are refused by RBAC on every route; the flag is not read', async () => {
    for (const role of ['agent', 'operator', 'viewer'] as MembershipRole[]) {
      caller = { userId: ME, role };
      for (const res of [await get('/proxy/agency/live-calls'), await get(`/proxy/agency/live-calls/${CALL}/number`), await listen()]) {
        expect(res.statusCode, role).toBe(403);
        expect(res.json().message).toMatch(/^Insufficient permissions/);
      }
    }
    expect(deps.listenFlags).not.toHaveBeenCalled();
  });

  it('the consent flag off: 403 feature_disabled on every route, nothing read', async () => {
    (deps.listenFlags as ReturnType<typeof vi.fn>).mockResolvedValue({ enabled: false, unrecordedAllowed: true });
    for (const res of [await get('/proxy/agency/live-calls'), await get(`/proxy/agency/live-calls/${CALL}/number`), await listen()]) {
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('feature_disabled');
    }
    expect(deps.calls).toEqual([]);
    expect(deps.listenFlags).toHaveBeenCalledWith(TENANT, ACCOUNT);
  });

  it('the flags cannot be read: the grant is 503 listen_unavailable (counted), the list and the number the flag\'s default 403', async () => {
    (deps.listenFlags as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('flag store down'));
    const grant = await listen();
    expect([grant.statusCode, grant.json().code]).toEqual([503, 'listen_unavailable']);
    expect(deps.trackGrant).toHaveBeenCalledWith('listen_unavailable');
    for (const res of [await get('/proxy/agency/live-calls'), await get(`/proxy/agency/live-calls/${CALL}/number`)]) {
      expect([res.statusCode, res.json().code]).toEqual([403, 'feature_disabled']);
    }
    expect(deps.calls).toEqual([]);
  });

  it('needs an account; a malformed campaign id is a 400, a malformed call id the uniform 404', async () => {
    caller.accountId = null;
    expect((await get('/proxy/agency/live-calls')).statusCode).toBe(400);
    caller.accountId = ACCOUNT;
    expect((await get('/proxy/agency/live-calls?campaign_id=nope')).statusCode).toBe(400);
    const number = await get('/proxy/agency/live-calls/not-a-uuid/number');
    expect(number.statusCode).toBe(404);
    expect(number.json().code).toBe('listen_call_not_live');
    const grant = await listen('not-a-uuid');
    expect(grant.statusCode).toBe(404);
    expect(deps.calls).toEqual([]);
  });
});

describe('GET /live-calls', () => {
  it('masks the number, adds the names, passes the campaign filter and the account scope', async () => {
    deps.live = [coreCall({ listeners: [{ listen_id: 'x', user_id: ME, started_at: '2026-11-16T10:01:00.000Z' }] })];
    const res = await get('/proxy/agency/live-calls?campaign_id=66666666-6666-4666-8666-666666666666');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(JSON.stringify(body)).not.toContain('9812345678');
    expect(body.calls[0]).toMatchObject({
      call_id: CALL, correlation_id: '77777777-7777-4777-8777-777777777777', customer_phone_masked: '****5678',
      agent_name: 'Agent Smith', aht_seconds: 182.5, listenable: true, not_listenable_reason: null,
      listeners: [{ user_id: ME, name: 'Me Supervisor', started_at: '2026-11-16T10:01:00.000Z' }],
    });
    expect(body.calls[0]).not.toHaveProperty('customer_phone');
    expect(deps.calls[0]).toMatchObject({ method: 'GET', path: '/agency/live-calls', tenantId: TENANT, accountId: ACCOUNT, query: { campaign_id: '66666666-6666-4666-8666-666666666666' } });
  });

  it('listenable for the caller: own call, LS4, the per-call cap (the caller\'s own listen not counted)', () => {
    const two = [{ listen_id: 'a', user_id: 'u1', started_at: '' }, { listen_id: 'b', user_id: 'u2', started_at: '' }];
    expect(notListenableReason({ agent_user_id: ME, recording: true, listeners: [] }, ME, true, 2)).toBe('listen_own_call');
    expect(notListenableReason({ agent_user_id: AGENT, recording: false, listeners: [] }, ME, false, 2)).toBe('listen_recording_off');
    expect(notListenableReason({ agent_user_id: AGENT, recording: false, listeners: [] }, ME, true, 2)).toBeNull();
    expect(notListenableReason({ agent_user_id: AGENT, recording: true, listeners: two }, ME, true, 2)).toBe('listen_limit_call');
    expect(notListenableReason({ agent_user_id: AGENT, recording: true, listeners: [two[0]!, { ...two[1]!, user_id: ME }] }, ME, true, 2)).toBeNull();
  });

  it('the unrecorded flag off: the row says why', async () => {
    (deps.listenFlags as ReturnType<typeof vi.fn>).mockResolvedValue({ enabled: true, unrecordedAllowed: false });
    deps.live = [coreCall({ recording: false })];
    const body = (await get('/proxy/agency/live-calls')).json();
    expect(body.calls[0]).toMatchObject({ recording: false, listenable: false, not_listenable_reason: 'listen_recording_off' });
  });
});

describe('GET /live-calls/:callId/number', () => {
  it('answers the full number of a live call in scope, and 404 for anything else', async () => {
    const res = await get(`/proxy/agency/live-calls/${CALL.toUpperCase()}/number`);
    expect(res.json()).toEqual({ call_id: CALL, customer_phone: '+919812345678' });
    expect(deps.calls[0]!.query).toEqual({ call_id: CALL });
    deps.live = [];
    const gone = await get(`/proxy/agency/live-calls/${CALL}/number`);
    expect(gone.statusCode).toBe(404);
    expect(gone.json()).toEqual({ error: 'Not Found', code: 'listen_call_not_live', message: 'That call is not in progress.' });
  });
});

describe('POST /live-calls/:callId/listen', () => {
  it('grants through the owning process, with the call\'s facts from the scoped read, and counts it', async () => {
    const res = await listen();
    expect(res.statusCode).toBe(201);
    expect(res.json().ws_url).toContain('/proxy/agency/listen/');
    expect(deps.calls[1]).toMatchObject({
      method: 'POST', path: '/agency/listen-grants', tenantId: TENANT, accountId: ACCOUNT,
      body: {
        session_id: SESSION, call_id: CALL, origin: 'campaign', campaign_id: '66666666-6666-4666-8666-666666666666',
        correlation_id: '77777777-7777-4777-8777-777777777777', agent_user_id: AGENT, listener_user_id: ME, recording: true,
      },
    });
    expect(deps.trackGrant).toHaveBeenCalledWith('granted');
  });

  it('refuses before callCore: not live (404), own call (409), recording off with the flag off (409)', async () => {
    deps.live = [];
    expect((await listen()).json().code).toBe('listen_call_not_live');
    deps.live = [coreCall({ agent_user_id: ME })];
    const own = await listen();
    expect([own.statusCode, own.json().code]).toEqual([409, 'listen_own_call']);
    deps.live = [coreCall({ recording: false })];
    (deps.listenFlags as ReturnType<typeof vi.fn>).mockResolvedValue({ enabled: true, unrecordedAllowed: false });
    const off = await listen();
    expect([off.statusCode, off.json().code]).toEqual([409, 'listen_recording_off']);
    expect(deps.calls.filter((c) => c.method === 'POST')).toEqual([]);
    expect((deps.trackGrant as ReturnType<typeof vi.fn>).mock.calls.map(([r]) => r)).toEqual(['listen_call_not_live', 'listen_own_call', 'listen_recording_off']);
  });

  it('the unrecorded flag on (default): an unrecorded call is granted', async () => {
    deps.live = [coreCall({ recording: false })];
    expect((await listen()).statusCode).toBe(201);
  });

  it('passes the owning process\'s refusal on with its status; anything else, or no answer, is 503 listen_unavailable', async () => {
    deps.grantAnswer = json(409, { error: 'Conflict', code: 'listen_limit_call', message: 'x' });
    const cap = await listen();
    expect([cap.statusCode, cap.json().code]).toEqual([409, 'listen_limit_call']);
    deps.grantAnswer = json(503, { error: 'Service Unavailable', code: 'listen_limit_server', message: 'x' });
    expect((await listen()).json().code).toBe('listen_limit_server');
    deps.grantAnswer = json(500, { error: 'Internal Server Error' });
    const broken = await listen();
    expect([broken.statusCode, broken.json().code]).toEqual([503, 'listen_unavailable']);
    (deps.callCore as ReturnType<typeof vi.fn>).mockImplementation(async (req: CoreCallRequest) => {
      if (req.method === 'POST') throw new Error('ipc gone');
      return json(200, { calls: [coreCall()], as_of: 'x' });
    });
    expect((await listen()).json().code).toBe('listen_unavailable');
  });
});
