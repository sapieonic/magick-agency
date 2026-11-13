import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Mode B's ring routes over HTTP (IQ71; `proxy-agency-inbound-ring.routes.ts`): the REAL app on
 * loopback, the real session → tenant-context → RBAC chain for `accept` (Firebase's token check is
 * the one stub) and none for the token-only routes, `callCore`, the internal handlers, the runtime
 * over real Redis and Postgres, a fake push sender behind the seam, and an inbound connector over
 * the in-process fake bridge (so a caller can be held without a carrier) put in the runtime in
 * place of the real one.
 *
 * What it pins:
 *  1. `…/ring/answering` and `…/ring/decline` need no session; anything but a live ring's token (an
 *     unknown call, a malformed id, no token, a wrong one, a spent one) is the uniform 404
 *     `ring_not_offered`; a decline's reason is validated; both are rate-limited per IP (429).
 *  2. `…/ring/accept` needs the agent's session (401), is the ring's agent's only (404 for another
 *     agent), and its station's device (409 `station_on_other_device` for another one); it answers
 *     the call and the station bootstrap at `/proxy/agency/station`, and the socket opened there
 *     with `caps=inbound` gets `ready` (reserved), the push `inbound_call` frame (accepted), then
 *     the call bound and connected.
 *  3. The audit rows `agency_inbound_call.ring_declined` and `.ring_accepted`: ids only, never the
 *     offer token.
 *  4. The app's `device_away` during a ring (the away notification's "Stop ringing", IQ79): a ring
 *     not yet answered is declined (not a miss), the absence over as `device_away` keeping its
 *     start, nothing queued, the caller rung on the next phone; an answered ring queues it behind
 *     the call, applied at its release; and a pause queued behind an answered ring that then ends
 *     unbound applies at the ring's end, never at the release after the agent's next call.
 *  5. A station attaching without `caps=inbound` during a ring not yet answered (the app past its
 *     "Stop ringing" bound) ends the ring `cancelled`, never answered: the agent on `device_away`
 *     from the absence's start, the `agent_state` frame before `ready`, both naming it.
 */

const mocks = vi.hoisted(() => {
  process.env['SUPER_ADMIN_JWT_SECRET'] = 'inbound-ring-routes-secret-0123456789';
  process.env['FF_AGENCY_DIALER'] = 'true';
  process.env['FF_AGENCY_INBOUND'] = 'true';
  process.env['FF_AGENCY_INBOUND_RING'] = 'true';
  return { verifyIdToken: vi.fn() };
});

vi.mock('../../../src/auth/firebase.js', () => ({
  initFirebase: vi.fn(),
  verifyIdToken: mocks.verifyIdToken,
}));

import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import type { FastifyInstance } from 'fastify';
import { closePool, getPool, initDbPool } from '@magick-agency/db';
import { TEST_DB_URL, closeTestPool, getTestPool, truncateAll } from '../../../../../packages/db/test/helpers/test-db.js';
import { insertAccount, insertMembership, insertTenant, insertUser } from '../../../../../packages/db/test/integration/setup/platform-factories.js';
import { closeTestRedis, flushTestRedis, getTestRedis } from '../../helpers/test-redis.js';
import { insertAgencyCampaign } from '../agency/agency-factories.js';
import { FakeBridge } from '../agency/inbound-connector-fakes.js';
import { config } from '../../../src/config/index.js';
import { buildApp } from '../../../src/app.js';
import type { AppContext } from '../../../src/app-context.js';
import { getAgencyRuntime, resetAgencyRuntimeForTests, startAgency } from '../../../src/bootstrap/agency.js';
import { resetVoiceEngineForTests, startVoice } from '../../../src/bootstrap/voice.js';
import { platformAuditLogger } from '../../../src/audit/platform/audit-logger.js';
import { resetPushSender, setPushSender } from '../../../src/seams/push-sender.js';
import { InboundConnector } from '../../../src/agency/inbound/inbound-connector.js';
import { AgencyInboundCallRouter } from '../../../src/agency/inbound/inbound-call-router.js';
import { parseInboundRouteCreate } from '../../../src/agency/inbound/route-config.js';
import { agencyInboundCallRepository, agencyInboundRouteRepository, type AgencyInboundRouteRecord } from '../../../src/db/repositories/agency.repository.js';
import { RING_TOKEN_RATE_LIMIT } from '../../../src/api/routes/proxy-agency-inbound-ring.routes.js';
import type { AgencyRuntime } from '../../../src/agency/runtime.js';

async function waitFor<T>(what: string, probe: () => Promise<T | null | undefined | false> | T | null | undefined | false, timeoutMs = 10_000): Promise<T> {
  const started = Date.now();
  for (;;) {
    const v = await probe();
    if (v) return v as T;
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

interface Who { id: string; tok: string }
interface Station { ws: WebSocket; frames: Array<Record<string, any>>; closed: Promise<void> }

const MOBILE = 'magick-agency-mobile/1.4.0+40 (android 15; Pixel 8)';
let phoneSeq = 0;

describe('Mode B ring routes over HTTP (integration)', () => {
  let app: FastifyInstance;
  let port = 0;
  let stopAgency: (() => Promise<void>) | null = null;
  let stopVoice: (() => Promise<void>) | null = null;
  let runtime: AgencyRuntime;
  let ctx: AppContext;
  const sockets: WebSocket[] = [];
  let tenant: string;
  let account: string;
  let credentialId: string;
  let route: AgencyInboundRouteRecord;
  let bridge: FakeBridge;
  let connector: InboundConnector;
  let realConnector: InboundConnector | null = null;
  const sent: Array<{ deviceRowId: string; payload: Record<string, unknown> }> = [];

  async function user(role: string): Promise<Who> {
    const u = await insertUser();
    await insertMembership({ user_id: u.id, tenant_id: tenant, account_id: account, role });
    return { id: u.id as string, tok: `tok:${u.firebase_uid as string}` };
  }
  function headers(who: Who | null, extra: Record<string, string> = {}): Record<string, string> {
    return {
      ...(who ? { authorization: `Bearer ${who.tok}`, 'x-tenant-id': tenant, 'x-account-id': account } : {}),
      'content-type': 'application/json', 'x-client': MOBILE, ...extra,
    };
  }
  const send = (method: 'GET' | 'PUT' | 'PATCH' | 'POST', url: string, who: Who | null, body?: unknown) =>
    app.inject({ method, url, headers: headers(who), ...(body === undefined ? {} : { payload: JSON.stringify(body) }) });
  const ring = (callId: string, action: 'answering' | 'decline' | 'accept', who: Who | null, body: unknown) =>
    send('POST', `/proxy/agency/inbound/calls/${callId}/ring/${action}`, who, body);

  async function connect(stationWsUrl: string, query = '&client=mobile&caps=inbound'): Promise<Station> {
    const frames: Array<Record<string, any>> = [];
    const ws = new WebSocket(`ws://127.0.0.1:${port}${stationWsUrl}${query}`);
    sockets.push(ws);
    const closed = new Promise<void>((r) => ws.on('close', () => r()));
    ws.on('message', (raw) => { try { frames.push(JSON.parse(raw.toString())); } catch { /* media */ } });
    await waitFor('ready', () => frames.find((f) => f['event'] === 'ready'));
    return { ws, frames, closed };
  }

  /** A mobile agent who joined from their phone, registered it to ring, went away ringing and parked the socket. */
  async function awayAgent(): Promise<{ agent: Who; sessionId: string; deviceId: string; campaignId: string }> {
    const agent = await user('agent');
    const deviceId = `phone-route-${String(++phoneSeq).padStart(4, '0')}`;
    const campaign = await insertAgencyCampaign({ tenant_id: tenant, account_id: account, status: 'running' });
    await getTestPool().query(
      `INSERT INTO agency_campaign_agents (id, tenant_id, account_id, campaign_id, user_id, assigned_by, assigned_at)
       VALUES ($1, $2, $3, $4, $5, $5, now())`, [randomUUID(), tenant, account, campaign.id, agent.id]);
    const reg = await send('PUT', `/proxy/agency/push-devices/${deviceId}`, agent, {
      platform: 'android', fcm_token: `fcm-${randomUUID()}`, app_build: '1.4.0+40', ring_enabled: true,
    });
    expect(reg.statusCode, reg.body).toBe(200);
    const join = await send('POST', '/proxy/agency/sessions', agent, { campaign_id: campaign.id, device_id: deviceId });
    expect(join.statusCode, join.body).toBe(201);
    const sessionId = join.json().session_id as string;
    const station = await connect(join.json().station_ws_url as string);
    expect((await send('POST', `/proxy/agency/sessions/${sessionId}/available`, agent, {})).statusCode).toBe(200);
    const away = await send('POST', `/proxy/agency/sessions/${sessionId}/break`, agent, { reason: 'away_ring' });
    expect(away.statusCode, away.body).toBe(200);
    expect(away.json()).toMatchObject({ state: 'break', break_reason: 'away_ring' });
    station.ws.close();
    await station.closed;
    await waitFor('the close handled', async () => !runtime.stations.isLocallyOwned(sessionId));
    await new Promise((r) => setTimeout(r, 100));
    expect(await runtime.agents.get(sessionId)).toMatchObject({ state: 'break', ring: true });
    return { agent, sessionId, deviceId, campaignId: campaign.id as string };
  }

  /** A caller held by the test connector; resolves with the ring's push once the phone is rung. */
  async function caller(): Promise<{ callId: string; token: string }> {
    const { call } = await agencyInboundCallRepository.insertArrival({
      tenantId: tenant, accountId: account, routeId: route.id, phoneNumberId: null, provider: 'plivo', telephonyCredentialId: credentialId,
      providerCallId: `CA-${randomUUID()}`, fromE164: `+4477009${String(Math.floor(Math.random() * 90_000) + 10_000)}`, toE164: '+14155550100',
      identification: { match: null, callerDnc: false, sticky: null }, answered: true, recordingRequested: false, analysisProfileId: null,
    });
    await agencyInboundCallRepository.transition(call!.id, 'greeting');
    bridge.take(call!.id);
    void connector.take({ call: (await agencyInboundCallRepository.findByIdAnyTenant(call!.id))!, route, stickyCandidates: [], recordingNotice: false });
    const push = await waitFor('the ring push', () => sent.find((p) => p.payload['type'] === 'ring' && p.payload['call_id'] === call!.id));
    return { callId: call!.id, token: String(push.payload['offer_token']) };
  }

  async function sessionRow(sessionId: string) {
    return (await getTestPool().query('SELECT * FROM agency_agent_sessions WHERE id = $1', [sessionId])).rows[0];
  }
  const pushesOf = (type: string, callId: string) => sent.filter((p) => p.payload['type'] === type && p.payload['call_id'] === callId).map((p) => p.payload);
  const deviceAway = (who: Who, sessionId: string) => send('POST', `/proxy/agency/sessions/${sessionId}/break`, who, { reason: 'device_away' });

  /** Nobody left on an absence from an earlier case (the next caller would ring them first). */
  async function quietFloor() {
    await getTestPool().query('UPDATE agency_push_devices SET ring_enabled = false WHERE ring_enabled');
    await runtime.awayRing.reconcile();
    await connector.drain();
  }

  async function auditRows(action: string) {
    await platformAuditLogger.shutdown();
    const { rows } = await getTestPool().query('SELECT * FROM platform_audit_log WHERE action = $1 ORDER BY created_at', [action]);
    return rows;
  }

  beforeAll(async () => {
    initDbPool({ url: TEST_DB_URL, poolMin: 0, poolMax: 8 });
    mocks.verifyIdToken.mockImplementation(async (token: string) => {
      if (!token.startsWith('tok:')) throw new Error('bad token');
      return { uid: token.slice(4), email: 'ring@example.com', email_verified: true };
    });
    await truncateAll();
    await flushTestRedis();
    resetVoiceEngineForTests();
    await resetAgencyRuntimeForTests();
    tenant = (await insertTenant()).id as string;
    account = (await insertAccount({ tenant_id: tenant })).id as string;
    await getTestPool().query(`INSERT INTO telephony_providers (name, display_name) VALUES ('voicelink', 'VoiceLink'), ('plivo', 'Plivo') ON CONFLICT DO NOTHING`);
    credentialId = (await getTestPool().query<{ id: string }>(
      `INSERT INTO telephony_credentials (tenant_id, provider, label, account_ref) VALUES ($1, 'plivo', 'Main', 'MA00000000000000RING') RETURNING id`,
      [tenant])).rows[0]!.id;
    const parsed = parseInboundRouteCreate({ name: 'Main', timezone: 'UTC', weekly_hours: [], sticky_mode: 'off' });
    if (!parsed.ok) throw new Error('route');
    const created = await agencyInboundRouteRepository.create({ tenantId: tenant, accountId: account, createdBy: null, config: parsed.config });
    if (!created.ok) throw new Error('route');
    route = created.route;
    ctx = { config, pool: getPool(), redis: getTestRedis() };
    app = await buildApp({ ctx });
    await app.listen({ port: 0, host: '127.0.0.1' });
    port = (app.server.address() as { port: number }).port;
    stopVoice = await startVoice(ctx);
    stopAgency = await startAgency(ctx);
    runtime = getAgencyRuntime()!;
    // The test's connector in place of the runtime's: the same registry, agents, release and away
    // break, over the in-process fake bridge.
    realConnector = runtime.inbound;
    bridge = new FakeBridge();
    const exits = new AgencyInboundCallRouter({
      bridge: bridge as never,
      dnc: { check: async () => 'clear', checkEntry: async () => ({ result: 'clear' }) } as never,
    });
    connector = new InboundConnector({
      bridge: bridge as never,
      stations: runtime.stations,
      agents: runtime.agents,
      releaseAgent: (sessionId) => runtime.dialer.releaseAgent(sessionId),
      exits,
      awayRing: runtime.awayRing,
      publish: () => {},
    });
    connector.start();
    runtime.attachInbound(connector);
    // Someone who could take a caller later (on a call on their console): callers wait.
    const desk = await user('agent');
    const campaign = await insertAgencyCampaign({ tenant_id: tenant, account_id: account, status: 'running' });
    await getTestPool().query(
      `INSERT INTO agency_campaign_agents (id, tenant_id, account_id, campaign_id, user_id, assigned_by, assigned_at)
       VALUES ($1, $2, $3, $4, $5, $5, now())`, [randomUUID(), tenant, account, campaign.id, desk.id]);
    const join = await send('POST', '/proxy/agency/sessions', desk, { campaign_id: campaign.id });
    expect(join.statusCode, join.body).toBe(201);
    await connect(join.json().station_ws_url as string, '');
    await runtime.agents.set(join.json().session_id as string, 'on_call', { leaseMs: 600_000 });
  });

  beforeEach(() => {
    sent.length = 0;
    setPushSender({
      async send(device, payload) {
        sent.push({ deviceRowId: device.id, payload: payload as unknown as Record<string, unknown> });
        return { ok: true };
      },
      configured: () => true,
    });
  });

  afterAll(async () => {
    resetPushSender();
    for (const [id] of bridge.live) bridge.end(id);
    await connector.drain();
    connector.stop();
    runtime.attachInbound(realConnector);
    for (const ws of sockets) if (ws.readyState === WebSocket.OPEN) ws.close();
    await new Promise((r) => setTimeout(r, 200));
    if (stopAgency) await stopAgency();
    if (stopVoice) await stopVoice();
    await app?.close();
    await platformAuditLogger.shutdown();
    await resetAgencyRuntimeForTests();
    resetVoiceEngineForTests();
    await closePool();
    await closeTestPool();
    await closeTestRedis();
  });

  it('the token-only routes need no session; anything but a live ring`s token is the uniform 404', async () => {
    const away = await awayAgent();
    const { callId, token } = await caller();
    const uniform = { error: 'Not Found', code: 'ring_not_offered' };
    const cases: Array<[string, unknown]> = [
      [randomUUID(), { offer_token: token }], // a call nobody holds
      ['not-a-uuid', { offer_token: token }], // a malformed id
      [callId, {}], // no token
      [callId, { offer_token: 'AAAAAAAAAAAAAAAAAAAAAA' }], // a wrong one
      [callId, { offer_token: `${token}x` }],
    ];
    for (const [id, body] of cases) {
      for (const action of ['answering', 'decline'] as const) {
        const res = await ring(id, action, null, action === 'decline' ? { reason: 'declined', ...(body as object) } : body);
        expect(res.statusCode, `${action} ${JSON.stringify(body)}`).toBe(404);
        expect(res.json()).toMatchObject(uniform);
      }
    }
    expect((await ring(callId, 'decline', null, { offer_token: token, reason: 'nope' })).statusCode).toBe(400);

    const answering = await ring(callId, 'answering', null, { offer_token: token });
    expect(answering.statusCode, answering.body).toBe(200);
    expect(answering.json()).toEqual({ call_id: callId, accept_by: expect.any(String) });
    const declined = await ring(callId, 'decline', null, { offer_token: token, reason: 'declined' });
    expect(declined.statusCode, declined.body).toBe(200);
    expect(declined.json()).toEqual({ call_id: callId, ring_result: 'declined' });
    // Spent: the same token again is the uniform 404.
    expect((await ring(callId, 'answering', null, { offer_token: token })).json()).toMatchObject(uniform);
    expect(await runtime.agents.get(away.sessionId)).toMatchObject({ state: 'break', ring: true });

    const rows = await auditRows('agency_inbound_call.ring_declined');
    expect(rows.filter((r) => r.resource_id === callId)).toEqual([expect.objectContaining({
      user_id: away.agent.id, tenant_id: tenant, resource_type: 'agency_inbound_call',
      details: { session_id: away.sessionId, reason: 'declined' },
    })]);
    expect(JSON.stringify(rows)).not.toContain(token);
    // The caller hangs up, and the agent stops ringing: nobody else in this file is offered or rung.
    bridge.end(callId);
    await connector.drain();
    const stop = await send('PATCH', `/proxy/agency/push-devices/${away.deviceId}`, away.agent, { ring_enabled: false });
    expect(stop.statusCode, stop.body).toBe(200);
    expect(await runtime.agents.get(away.sessionId)).toMatchObject({ ring: false });
  });

  it('accept: the agent`s session, their ring only, their station`s device; it answers the bootstrap and the socket binds the call', async () => {
    const away = await awayAgent();
    const { callId, token } = await caller();
    const body = { offer_token: token, device_id: away.deviceId };
    expect((await ring(callId, 'accept', null, body)).statusCode).toBe(401);
    const stranger = await user('agent');
    const notTheirs = await ring(callId, 'accept', stranger, body);
    expect(notTheirs.statusCode).toBe(404);
    expect(notTheirs.json()).toMatchObject({ code: 'ring_not_offered' });
    const otherDevice = await ring(callId, 'accept', away.agent, { offer_token: token, device_id: 'laptop-elsewhere-01' });
    expect(otherDevice.statusCode, otherDevice.body).toBe(409);
    expect(otherDevice.json()).toMatchObject({ code: 'station_on_other_device' });
    expect((await ring(callId, 'accept', away.agent, { offer_token: token })).statusCode).toBe(400);

    const accepted = await ring(callId, 'accept', away.agent, body);
    expect(accepted.statusCode, accepted.body).toBe(200);
    const answer = accepted.json();
    expect(answer).toMatchObject({
      session_id: away.sessionId, campaign_id: away.campaignId,
      call: { id: callId, state: 'offered', offer_channel: 'push', connects_at: null, ring_expires_at: null },
    });
    expect(answer.call.accepted_at).toEqual(expect.any(String));
    expect(answer.station_ws_url).toMatch(new RegExp(`^/proxy/agency/station/${away.sessionId}\\?token=`));
    expect(JSON.stringify(answer)).not.toMatch(/"audit"|offer_token/);
    // A lost answer retried: the same call again, with a fresh station token.
    const again = await ring(callId, 'accept', away.agent, body);
    expect(again.statusCode, again.body).toBe(200);
    expect(again.json().call.id).toBe(callId);
    // Past accept, the token-only routes are `already_accepted` (409).
    const late = await ring(callId, 'decline', null, { offer_token: token, reason: 'declined' });
    expect(late.statusCode).toBe(409);
    expect(late.json()).toMatchObject({ code: 'already_accepted' });

    const station = await connect(again.json().station_ws_url as string);
    await waitFor('connected', async () => (await agencyInboundCallRepository.findByIdAnyTenant(callId))?.state === 'connected');
    const ready = station.frames.find((f) => f['event'] === 'ready')!;
    expect(ready).toMatchObject({ state: 'reserved' });
    const inbound = station.frames.filter((f) => f['event'] === 'inbound_call').map((f) => f['call']);
    expect(inbound[0]).toMatchObject({ id: callId, state: 'offered', offer_channel: 'push', connects_at: null });
    await waitFor('the connected frame', () => station.frames.some((f) => f['event'] === 'inbound_call' && f['call']['state'] === 'connected'));
    expect(station.frames.findIndex((f) => f['event'] === 'ready')).toBeLessThan(station.frames.findIndex((f) => f['event'] === 'inbound_call'));
    expect(await runtime.agents.get(away.sessionId)).toMatchObject({ state: 'on_call', inboundCallId: callId });
    expect((await agencyInboundCallRepository.findByIdAnyTenant(callId))).toMatchObject({ ring_result: 'answered', session_id: away.sessionId });

    const rows = (await auditRows('agency_inbound_call.ring_accepted')).filter((r) => r.resource_id === callId);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ user_id: away.agent.id, details: { session_id: away.sessionId, device_id: away.deviceId } });
    expect(JSON.stringify(rows)).not.toContain(token);
    bridge.end(callId);
    await connector.drain();
  });

  it('accept for a ringing call of another tenant is the uniform 404, even with the right token and an agent signed in there', async () => {
    const away = await awayAgent();
    const { callId, token } = await caller();
    // An agent of another tenant, with their own session and the tenant headers of theirs.
    const otherTenant = (await insertTenant()).id as string;
    const otherAccount = (await insertAccount({ tenant_id: otherTenant })).id as string;
    const u = await insertUser();
    await insertMembership({ user_id: u.id, tenant_id: otherTenant, account_id: otherAccount, role: 'agent' });
    const res = await app.inject({
      method: 'POST', url: `/proxy/agency/inbound/calls/${callId}/ring/accept`,
      headers: {
        authorization: `Bearer tok:${u.firebase_uid as string}`, 'x-tenant-id': otherTenant, 'x-account-id': otherAccount,
        'content-type': 'application/json', 'x-client': MOBILE,
      },
      payload: JSON.stringify({ offer_token: token, device_id: away.deviceId }),
    });
    expect(res.statusCode, res.body).toBe(404);
    expect(res.json()).toMatchObject({ code: 'ring_not_offered' });
    // Indistinguishable from a call that is not ringing at all.
    const unknown = await app.inject({
      method: 'POST', url: `/proxy/agency/inbound/calls/${randomUUID()}/ring/accept`,
      headers: {
        authorization: `Bearer tok:${u.firebase_uid as string}`, 'x-tenant-id': otherTenant, 'x-account-id': otherAccount,
        'content-type': 'application/json', 'x-client': MOBILE,
      },
      payload: JSON.stringify({ offer_token: token, device_id: away.deviceId }),
    });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toEqual(res.json());
    // The ring is untouched: its own agent still accepts it.
    expect(await agencyInboundCallRepository.findByIdAnyTenant(callId)).toMatchObject({ state: 'offered', accepted_at: null });
    const accepted = await ring(callId, 'accept', away.agent, { offer_token: token, device_id: away.deviceId });
    expect(accepted.statusCode, accepted.body).toBe(200);
    bridge.end(callId);
    await connector.drain();
  });

  it('device_away during a ring not yet answered declines it: not a miss, the absence over as device_away keeping its start, nothing queued, the caller rung on the next phone', async () => {
    await quietFloor();
    const first = await awayAgent();
    const second = await awayAgent();
    const absence = ((await sessionRow(first.sessionId)).away_ring_since as Date).toISOString();
    const { callId, token } = await caller();
    // Longest idle first: the first phone rings.
    expect(pushesOf('ring', callId).map((p) => p['session_id'])).toEqual([first.sessionId]);
    expect(await runtime.agents.get(first.sessionId)).toMatchObject({ state: 'reserved', inboundCallId: callId });

    // "Stop ringing" (IQ79): the app asks device_away before its station attaches.
    const stop = await deviceAway(first.agent, first.sessionId);
    expect(stop.statusCode, stop.body).toBe(200);
    expect(stop.json()).toMatchObject({ session_id: first.sessionId, state: 'break', break_reason: 'device_away', since: absence });
    expect(stop.json()).not.toHaveProperty('pending_state');
    expect(runtime.breaks.peek(first.sessionId)).toBeNull();
    expect(await runtime.agents.get(first.sessionId)).toMatchObject({ state: 'break', ring: false, inboundCallId: null, since: Date.parse(absence) });
    expect(await sessionRow(first.sessionId)).toMatchObject({ state: 'break', break_reason: 'device_away', away_ring_since: null, ring_misses: 0 });
    expect(((await sessionRow(first.sessionId)).state_since as Date).toISOString()).toBe(absence);
    // Declined, as the native decline would have: the phone told, the token spent; no ring_off (the app asked).
    expect(await waitFor('ring_cancel', () => pushesOf('ring_cancel', callId)[0])).toEqual({
      type: 'ring_cancel', call_id: callId, session_id: first.sessionId, reason: 'declined',
    });
    expect((await ring(callId, 'answering', null, { offer_token: token })).statusCode).toBe(404);
    expect(sent.filter((p) => p.payload['type'] === 'ring_off' && p.payload['session_id'] === first.sessionId)).toEqual([]);
    // The caller is searched for again: the next phone rings, and this one never again for them.
    await waitFor('the next phone rung', () => pushesOf('ring', callId).find((p) => p['session_id'] === second.sessionId));
    expect(await agencyInboundCallRepository.findByIdAnyTenant(callId)).toMatchObject({ state: 'offered', session_id: second.sessionId, ring_count: 2 });
    expect(pushesOf('ring', callId).filter((p) => p['session_id'] === first.sessionId)).toHaveLength(1);
    // The app's retry of the same ask finds the pause it asked for, and queues nothing.
    const again = await deviceAway(first.agent, first.sessionId);
    expect(again.json()).toMatchObject({ state: 'break', break_reason: 'device_away', since: absence });
    expect(runtime.breaks.peek(first.sessionId)).toBeNull();

    bridge.end(callId);
    await connector.drain();
    expect((await send('PATCH', `/proxy/agency/push-devices/${second.deviceId}`, second.agent, { ring_enabled: false })).statusCode).toBe(200);
  });

  it('device_away during an answered ring queues behind the call (the agent took it) and applies at its release', async () => {
    await quietFloor();
    const away = await awayAgent();
    const { callId, token } = await caller();
    expect((await ring(callId, 'answering', null, { offer_token: token })).statusCode).toBe(200);
    const paused = await deviceAway(away.agent, away.sessionId);
    expect(paused.statusCode, paused.body).toBe(200);
    expect(paused.json()).toMatchObject({ state: 'reserved', pending_state: 'break', break_reason: 'device_away' });
    expect(runtime.breaks.peek(away.sessionId)).toMatchObject({ code: 'device_away' });
    expect(await agencyInboundCallRepository.findByIdAnyTenant(callId)).toMatchObject({ state: 'offered', session_id: away.sessionId });

    // The ring stands: the agent takes the call.
    const accepted = await ring(callId, 'accept', away.agent, { offer_token: token, device_id: away.deviceId });
    expect(accepted.statusCode, accepted.body).toBe(200);
    const station = await connect(accepted.json().station_ws_url as string);
    await waitFor('connected', async () => (await agencyInboundCallRepository.findByIdAnyTenant(callId))?.state === 'connected');
    expect(station.frames.find((f) => f['event'] === 'ready')).toMatchObject({ state: 'reserved', pending_state: 'break', pending_break_reason: 'device_away' });
    expect(await runtime.agents.get(away.sessionId)).toMatchObject({ state: 'on_call', inboundCallId: callId });
    expect(runtime.breaks.peek(away.sessionId)).toMatchObject({ code: 'device_away' });

    // The call ends and its outcome settles: the release (as the outcome's settle runs it) applies the pause.
    bridge.end(callId);
    await connector.drain();
    await runtime.agents.releaseInbound(away.sessionId, callId);
    expect(await runtime.dialer.releaseAgent(away.sessionId)).toMatchObject({ state: 'break' });
    expect(await runtime.agents.get(away.sessionId)).toMatchObject({ state: 'break', ring: false });
    expect(await sessionRow(away.sessionId)).toMatchObject({ state: 'break', break_reason: 'device_away' });
    expect(runtime.breaks.peek(away.sessionId)).toBeNull();
    station.ws.close();
    await station.closed;
  });

  it('a device_away queued behind an answered ring that then ends unbound applies at the ring`s end: after /available, the next call`s release is to available', async () => {
    await quietFloor();
    const away = await awayAgent();
    const absence = ((await sessionRow(away.sessionId)).away_ring_since as Date).toISOString();
    const { callId, token } = await caller();
    expect((await ring(callId, 'answering', null, { offer_token: token })).statusCode).toBe(200);
    const paused = await deviceAway(away.agent, away.sessionId);
    expect(paused.json()).toMatchObject({ state: 'reserved', pending_state: 'break', break_reason: 'device_away' });
    // Declined natively after Answer (N4): the ring ends unbound, and the pause it held queued applies there.
    expect((await ring(callId, 'decline', null, { offer_token: token, reason: 'declined' })).statusCode).toBe(200);
    await connector.drain();
    expect(runtime.breaks.peek(away.sessionId)).toBeNull();
    expect(await runtime.agents.get(away.sessionId)).toMatchObject({ state: 'break', ring: false, inboundCallId: null, since: Date.parse(absence) });
    expect(await sessionRow(away.sessionId)).toMatchObject({ state: 'break', break_reason: 'device_away', away_ring_since: null });
    const again = await deviceAway(away.agent, away.sessionId);
    expect(again.json()).toMatchObject({ state: 'break', break_reason: 'device_away', since: absence });
    bridge.end(callId);
    await connector.drain();

    // Back in the app, back in the pool, then a call: its release returns the agent to the pool,
    // never to a pause nobody asked for since.
    const mint = await send('POST', `/proxy/agency/sessions/${away.sessionId}/station-token`, away.agent, { device_id: away.deviceId });
    expect(mint.statusCode, mint.body).toBe(200);
    const station = await connect(mint.json().station_ws_url as string);
    const ready = station.frames.find((f) => f['event'] === 'ready')!;
    expect(ready).toMatchObject({ state: 'break', break_reason: 'device_away' });
    expect(ready).not.toHaveProperty('pending_state');
    expect((await send('POST', `/proxy/agency/sessions/${away.sessionId}/available`, away.agent, {})).statusCode).toBe(200);
    await runtime.agents.set(away.sessionId, 'on_call', { leaseMs: 60_000 });
    expect(await runtime.dialer.releaseAgent(away.sessionId)).toMatchObject({ state: 'available' });
    expect(await runtime.agents.get(away.sessionId)).toMatchObject({ state: 'available' });
    // Out of the pool again for the later cases' callers.
    expect((await deviceAway(away.agent, away.sessionId)).json()).toMatchObject({ state: 'break', break_reason: 'device_away' });
    station.ws.close();
    await station.closed;
  });

  it('an attach without caps=inbound during a ring not yet answered ends it (cancelled, never answered): device_away keeping the absence`s start, told before ready', async () => {
    await quietFloor();
    const away = await awayAgent();
    const absence = ((await sessionRow(away.sessionId)).away_ring_since as Date).toISOString();
    const { callId } = await caller();
    expect(await runtime.agents.get(away.sessionId)).toMatchObject({ state: 'reserved', inboundCallId: callId });
    // The app past its "Stop ringing" bound (IQ79): its station attaches without declaring inbound.
    const mint = await send('POST', `/proxy/agency/sessions/${away.sessionId}/station-token`, away.agent, { device_id: away.deviceId });
    expect(mint.statusCode, mint.body).toBe(200);
    const station = await connect(mint.json().station_ws_url as string, '&client=mobile');
    await connector.drain();
    expect(await agencyInboundCallRepository.findByIdAnyTenant(callId)).toMatchObject({ state: 'queued', session_id: null, ring_result: 'cancelled', accepted_at: null });
    expect(await waitFor('ring_cancel', () => pushesOf('ring_cancel', callId)[0])).toMatchObject({ reason: 'cancelled' });
    // Off away_ring and out of the pool: device_away, from the absence's start (IQ76).
    expect(await runtime.agents.get(away.sessionId)).toMatchObject({ state: 'break', ring: false, inboundCallId: null, since: Date.parse(absence) });
    expect(await sessionRow(away.sessionId)).toMatchObject({ state: 'break', break_reason: 'device_away', away_ring_since: null, ring_misses: 0 });
    const ready = station.frames.find((f) => f['event'] === 'ready')!;
    expect(ready).toMatchObject({ state: 'break', break_reason: 'device_away' });
    expect(ready).not.toHaveProperty('pending_state');
    const states = station.frames.filter((f) => f['event'] === 'agent_state');
    expect(states[0]).toEqual({ event: 'agent_state', state: 'break', since: absence, break_reason: 'device_away' });
    expect(station.frames.indexOf(states[0]!)).toBeLessThan(station.frames.indexOf(ready));
    expect(station.frames.filter((f) => f['event'] === 'inbound_call')).toEqual([]);
    expect(runtime.breaks.peek(away.sessionId)).toBeNull();
    expect(sent.filter((p) => p.payload['type'] === 'ring_off' && p.payload['session_id'] === away.sessionId)).toEqual([]);
    bridge.end(callId);
    await connector.drain();
    station.ws.close();
    await station.closed;
  });

  it('the token-only routes are rate-limited per IP', async () => {
    const limit = RING_TOKEN_RATE_LIMIT.max;
    let limited = -1;
    for (let i = 0; i < limit + 2 && limited < 0; i++) {
      const res = await ring(randomUUID(), 'answering', null, { offer_token: 'AAAAAAAAAAAAAAAAAAAAAA' });
      if (res.statusCode === 429) limited = i;
      else expect(res.statusCode).toBe(404);
    }
    // Earlier cases in this file spent some of the bucket: the limit is reached at or before `max`.
    expect(limited).toBeGreaterThanOrEqual(0);
    expect(limited).toBeLessThanOrEqual(limit);
  });

  it('a ringing call has a bucket of its own per IP: a phone behind the same NAT still answers and declines its own ring', async () => {
    // The IP's shared bucket (ids it is not ringing) is spent...
    for (let i = 0; i <= RING_TOKEN_RATE_LIMIT.max; i++) await ring(randomUUID(), 'decline', null, { offer_token: 'AAAAAAAAAAAAAAAAAAAAAA', reason: 'declined' });
    expect((await ring(randomUUID(), 'answering', null, { offer_token: 'AAAAAAAAAAAAAAAAAAAAAA' })).statusCode).toBe(429);
    // ...and a ring this process holds is still answered from that IP: a 429 here would let the
    // ring expire, a miss that was not the agent's.
    const away = await awayAgent();
    const { callId, token } = await caller();
    const declined = await ring(callId, 'decline', null, { offer_token: token, reason: 'declined' });
    expect(declined.statusCode, declined.body).toBe(200);
    expect(declined.json()).toEqual({ call_id: callId, ring_result: 'declined' });
    await waitFor('back on away_ring', async () => (await runtime.agents.get(away.sessionId))?.ring === true);
    await connector.drain();
  });
});
