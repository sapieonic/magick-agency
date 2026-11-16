import { describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';

/*
 * The internal grant handler (`api/routes/agency/live-calls.ts`, `POST /listen-grants`, owner
 * `body_session`): the bridge of this process must hold the call, the caps must admit it, and the
 * single-use token carries the grant to the socket. And the list's per-campaign AHT cache: read at
 * most once a minute per campaign, and bounded. Over a stubbed runtime; the list's SQL is
 * pinned on Postgres by the live-listen end-to-end suite.
 */

vi.mock('../../../../src/db/repositories/agency.repository.js', () => ({
  agencyListenSessionRepository: { listOpenForCalls: vi.fn(async () => []) },
  agencyLiveCallRepository: { listLive: vi.fn(async () => []), campaignAhtSeconds: vi.fn(async () => new Map()) },
}));

import {
  LIVE_CALL_AHT_CACHE_MAX,
  LIVE_CALL_AHT_CACHE_MS,
  clearLiveCallAhtCacheForTests,
  liveCallAhtCacheSizeForTests,
  registerLiveCallRoutes,
} from '../../../../src/api/routes/agency/live-calls.js';
import { agencyLiveCallRepository } from '../../../../src/db/repositories/agency.repository.js';
import { ListenTokenUnavailableError } from '../../../../src/agency/listen/listen-token.js';

const TENANT = '33333333-3333-4333-8333-333333333333';
const ACCOUNT = '44444444-4444-4444-8444-444444444444';
const SESSION = '11111111-1111-4111-8111-111111111111';
const BODY = {
  session_id: SESSION, call_id: '55555555-5555-4555-8555-555555555555', origin: 'campaign',
  campaign_id: '66666666-6666-4666-8666-666666666666', correlation_id: '77777777-7777-4777-8777-777777777777',
  agent_user_id: '88888888-8888-4888-8888-888888888888', listener_user_id: '99999999-9999-4999-8999-999999999999', recording: true,
};

async function build(runtime: Record<string, unknown>) {
  const app = Fastify({ logger: false });
  await app.register(async (sub) => registerLiveCallRoutes(sub, runtime as never), { prefix: '/api/v1/agency' });
  await app.ready();
  return app;
}

function runtime(over: Partial<{ holds: boolean; check: string | null; mint: () => Promise<unknown> }> = {}) {
  return {
    holdsCall: vi.fn(() => over.holds ?? true),
    listen: { check: vi.fn(() => over.check ?? null), generation: vi.fn(() => 4) },
    listenTokens: { mint: vi.fn(over.mint ?? (async () => ({ token: 'tok', expiresAt: new Date('2026-11-16T10:01:00Z') }))) },
  };
}

const grant = (app: Awaited<ReturnType<typeof build>>, body: Record<string, unknown> = BODY) => app.inject({
  method: 'POST', url: '/api/v1/agency/listen-grants', payload: body,
  headers: { 'x-mgkvc-tenant': TENANT, 'x-mgkvc-account': ACCOUNT },
});

describe('POST /listen-grants', () => {
  it('mints a grant naming the session and the listen, with the call\'s facts in the token', async () => {
    const rt = runtime();
    const app = await build(rt);
    const res = await grant(app);
    expect(res.statusCode).toBe(201);
    const body = res.json() as { listen_id: string; ws_url: string; expires_at: string };
    expect(body.ws_url).toBe(`/proxy/agency/listen/${SESSION}/${body.listen_id}?token=tok`);
    expect(body.expires_at).toBe('2026-11-16T10:01:00.000Z');
    expect(rt.listenTokens.mint).toHaveBeenCalledWith({
      listenId: body.listen_id, sessionId: SESSION, tenantId: TENANT, accountId: ACCOUNT, callId: BODY.call_id, origin: 'campaign',
      campaignId: BODY.campaign_id, correlationId: BODY.correlation_id, agentUserId: BODY.agent_user_id,
      listenerUserId: BODY.listener_user_id, recording: true, revocationGen: 4,
    });
    // The supervisor's revocation generation here, so a revocation before the upgrade refuses it (LS16 n).
    expect(rt.listen.generation).toHaveBeenCalledWith(TENANT, BODY.listener_user_id);
    expect(rt.listen.check).toHaveBeenCalledWith(BODY.call_id, TENANT, BODY.listener_user_id);
    await app.close();
  });

  it('a call this process does not hold is listen_call_not_live (404), before the caps', async () => {
    const rt = runtime({ holds: false });
    const app = await build(rt);
    const res = await grant(app);
    expect([res.statusCode, res.json().code]).toEqual([404, 'listen_call_not_live']);
    expect(rt.listen.check).not.toHaveBeenCalled();
    expect(rt.listenTokens.mint).not.toHaveBeenCalled();
    await app.close();
  });

  it('the caps (and a stopping process, listen_unavailable) refuse with their codes and statuses; no token is minted', async () => {
    for (const [check, status] of [['listen_limit_call', 409], ['listen_limit_server', 503], ['listen_unavailable', 503]] as const) {
      const rt = runtime({ check });
      const app = await build(rt);
      const res = await grant(app);
      expect([res.statusCode, res.json().code]).toEqual([status, check]);
      expect(rt.listenTokens.mint).not.toHaveBeenCalled();
      await app.close();
    }
  });

  it('a token that cannot be stored is 503 listen_unavailable; a malformed body is 400', async () => {
    const app = await build(runtime({ mint: async () => { throw new ListenTokenUnavailableError('x'); } }));
    const res = await grant(app);
    expect([res.statusCode, res.json().code]).toEqual([503, 'listen_unavailable']);
    expect((await grant(app, { ...BODY, call_id: 'nope' })).statusCode).toBe(400);
    expect((await grant(app, { ...BODY, extra: 1 })).statusCode).toBe(400);
    await app.close();
  });
});

describe('GET /live-calls: the campaigns\' AHT cache', () => {
  const campaign = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
  const liveRow = (campaignId: string) => ({
    call_id: '55555555-5555-4555-8555-555555555555', origin: 'campaign', correlation_id: campaignId, campaign_id: campaignId,
    campaign_name: 'C', inbound_route_name: null, agent_user_id: BODY.agent_user_id, agent_session_id: SESSION, client_kind: 'web',
    customer_phone: '+919812345678', contact_context: null, connected_at: new Date('2026-11-16T10:00:00Z'), recording: true,
  });
  const listLive = agencyLiveCallRepository.listLive as unknown as ReturnType<typeof vi.fn>;
  const ahtRead = agencyLiveCallRepository.campaignAhtSeconds as unknown as ReturnType<typeof vi.fn>;
  const list = (app: Awaited<ReturnType<typeof build>>) => app.inject({
    method: 'GET', url: '/api/v1/agency/live-calls', headers: { 'x-mgkvc-tenant': TENANT, 'x-mgkvc-account': ACCOUNT },
  });

  it('reads each campaign at most once a minute; entries past their minute are dropped; never more than the bound', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      clearLiveCallAhtCacheForTests();
      ahtRead.mockClear();
      const app = await build(runtime());
      listLive.mockResolvedValue([liveRow(campaign(1)), liveRow(campaign(2))]);
      expect((await list(app)).statusCode).toBe(200);
      await list(app);
      expect(ahtRead).toHaveBeenCalledTimes(1);
      expect(liveCallAhtCacheSizeForTests()).toBe(2);
      // A minute on, another campaign's read drops the two that lapsed.
      vi.setSystemTime(Date.now() + LIVE_CALL_AHT_CACHE_MS);
      listLive.mockResolvedValue([liveRow(campaign(3))]);
      await list(app);
      expect(liveCallAhtCacheSizeForTests()).toBe(1);
      // More live campaigns than the bound: the cache keeps at most the bound.
      listLive.mockResolvedValue(Array.from({ length: LIVE_CALL_AHT_CACHE_MAX + 5 }, (_, i) => liveRow(campaign(100 + i))));
      await list(app);
      expect(liveCallAhtCacheSizeForTests()).toBe(LIVE_CALL_AHT_CACHE_MAX);
      await app.close();
    } finally {
      vi.useRealTimers();
      listLive.mockResolvedValue([]);
    }
  });
});
