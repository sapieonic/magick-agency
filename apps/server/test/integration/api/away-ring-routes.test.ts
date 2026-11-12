import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Mode B's routes over HTTP (IQ58–IQ74): the REAL app on loopback, the real session →
 * tenant-context → RBAC chain (Firebase's token check is the one stub), the public routes,
 * `callCore`, the internal handlers and the runtime over real Redis 6383 and Postgres 5436, with
 * a fake push sender behind the seam.
 *
 * What it pins:
 *  1. `/proxy/agency/push-devices/:deviceId`: register (the token never answered), opt in and out,
 *     revoke (204), the status; own devices only (another agent's same device id is theirs); a
 *     malformed id is a 404; the test ring sends `test_ring` and is limited to one per 10 s; the
 *     audit rows (opt-in changed, revoked) carry no token.
 *  2. `POST /sessions/:id/break {reason:'away_ring'}`: the typed 409s (`no_push_device`,
 *     `ring_disabled`, `push_unavailable`); applied from `available`, and switched from
 *     `device_away`; `device_away` asked on it switches back.
 *  3. The "no socket means offline" paths on a phone that has gone away ringing: the station close
 *     keeps it; the silent-station sweep drops a phone's socket and the close keeps it; the
 *     supervisor's force-available is refused `agent_away_ring`; "Stop ringing" (PATCH) ends it
 *     (`device_away`, then `offline` with no socket, a `ring_off` push); the agent's return (a
 *     station attaching) ends it as `device_away`; another device taking the station over ends it
 *     (`ring_off`, `taken_over`, to the old device).
 */

const mocks = vi.hoisted(() => {
  process.env['SUPER_ADMIN_JWT_SECRET'] = 'away-ring-routes-secret-0123456789';
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
import { config } from '../../../src/config/index.js';
import { buildApp } from '../../../src/app.js';
import type { AppContext } from '../../../src/app-context.js';
import { getAgencyRuntime, resetAgencyRuntimeForTests, startAgency } from '../../../src/bootstrap/agency.js';
import { resetVoiceEngineForTests, startVoice } from '../../../src/bootstrap/voice.js';
import { platformAuditLogger } from '../../../src/audit/platform/audit-logger.js';
import { resetPushSender, setPushSender } from '../../../src/seams/push-sender.js';
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
const PHONE = 'phone-aaaa-0001';
const LAPTOP = 'laptop-bbbb-0002';

describe('Mode B routes over HTTP: push devices, away_ring and its ends (integration)', () => {
  let app: FastifyInstance;
  let port = 0;
  let stopAgency: (() => Promise<void>) | null = null;
  let stopVoice: (() => Promise<void>) | null = null;
  let runtime: AgencyRuntime;
  let ctx: AppContext;
  const sockets: WebSocket[] = [];
  let tenant: string;
  let account: string;
  let supervisor: Who;
  const sent: Array<{ deviceRowId: string; payload: Record<string, unknown> }> = [];
  let senderConfigured = true;

  async function user(role: string): Promise<Who> {
    const u = await insertUser();
    await insertMembership({ user_id: u.id, tenant_id: tenant, account_id: account, role });
    return { id: u.id as string, tok: `tok:${u.firebase_uid as string}` };
  }
  function headers(who: Who, extra: Record<string, string> = {}): Record<string, string> {
    return {
      authorization: `Bearer ${who.tok}`, 'x-tenant-id': tenant, 'x-account-id': account,
      'content-type': 'application/json', 'x-client': MOBILE, ...extra,
    };
  }
  const send = (method: 'GET' | 'PUT' | 'PATCH' | 'DELETE' | 'POST', url: string, who: Who, body?: unknown) => {
    const h = headers(who);
    if (body === undefined) delete h['content-type'];
    return app.inject({ method, url, headers: h, ...(body === undefined ? {} : { payload: JSON.stringify(body) }) });
  };

  async function connect(stationWsUrl: string): Promise<Station> {
    const frames: Array<Record<string, any>> = [];
    const ws = new WebSocket(`ws://127.0.0.1:${port}${stationWsUrl}&client=mobile&caps=inbound`);
    sockets.push(ws);
    const closed = new Promise<void>((r) => ws.on('close', () => r()));
    ws.on('message', (raw) => { try { frames.push(JSON.parse(raw.toString())); } catch { /* media */ } });
    await waitFor('ready', () => frames.find((f) => f['event'] === 'ready'));
    return { ws, frames, closed };
  }

  async function staff(campaignId: string, userId: string) {
    await getTestPool().query(
      `INSERT INTO agency_campaign_agents (id, tenant_id, account_id, campaign_id, user_id, assigned_by, assigned_at)
       VALUES ($1, $2, $3, $4, $5, $5, now())`,
      [randomUUID(), tenant, account, campaignId, userId],
    );
  }

  async function register(who: Who, deviceId = PHONE, ringEnabled = true) {
    const res = await send('PUT', `/proxy/agency/push-devices/${deviceId}`, who, {
      platform: 'android', fcm_token: `fcm-${randomUUID()}`, app_build: '1.4.0+40', ring_enabled: ringEnabled,
    });
    expect(res.statusCode, res.body).toBe(200);
    return res.json();
  }

  /** A mobile agent on a running campaign, joined from `PHONE`, its station open, available. */
  async function onDuty(opts: { register?: boolean } = {}) {
    const agent = await user('agent');
    const campaign = await insertAgencyCampaign({ tenant_id: tenant, account_id: account, status: 'running' });
    await staff(campaign.id as string, agent.id);
    if (opts.register !== false) await register(agent);
    const join = await send('POST', '/proxy/agency/sessions', agent, { campaign_id: campaign.id, device_id: PHONE });
    expect(join.statusCode, join.body).toBe(201);
    const sessionId = join.json().session_id as string;
    const station = await connect(join.json().station_ws_url as string);
    const avail = await send('POST', `/proxy/agency/sessions/${sessionId}/available`, agent, {});
    expect(avail.statusCode, avail.body).toBe(200);
    return { agent, campaignId: campaign.id as string, sessionId, station };
  }

  async function goAwayRinging(agent: Who, sessionId: string, station: Station) {
    const res = await send('POST', `/proxy/agency/sessions/${sessionId}/break`, agent, { reason: 'away_ring' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ state: 'break', break_reason: 'away_ring' });
    // The app parks its socket once the break lands (IQ67).
    station.ws.close();
    await station.closed;
    await waitFor('the close handled', async () => !runtime.stations.isLocallyOwned(sessionId));
    await new Promise((r) => setTimeout(r, 100));
  }

  async function row(sid: string) {
    const { rows } = await getTestPool().query('SELECT * FROM agency_agent_sessions WHERE id = $1', [sid]);
    return rows[0];
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
      return { uid: token.slice(4), email: 'ar@example.com', email_verified: true };
    });
    await truncateAll();
    await flushTestRedis();
    resetVoiceEngineForTests();
    await resetAgencyRuntimeForTests();
    tenant = (await insertTenant()).id as string;
    account = (await insertAccount({ tenant_id: tenant })).id as string;
    await getTestPool().query(
      `INSERT INTO account_settings (tenant_id, account_id, allow_recording, analyze_calls, max_concurrent_calls)
       VALUES ($1, $2, true, true, 20)`, [tenant, account]);
    supervisor = await user('account_admin');
    ctx = { config, pool: getPool(), redis: getTestRedis() };
    app = await buildApp({ ctx });
    await app.listen({ port: 0, host: '127.0.0.1' });
    port = (app.server.address() as { port: number }).port;
    stopVoice = await startVoice(ctx);
    stopAgency = await startAgency(ctx);
    runtime = getAgencyRuntime()!;
  });

  beforeEach(() => {
    sent.length = 0;
    senderConfigured = true;
    setPushSender({
      async send(device, payload) {
        sent.push({ deviceRowId: device.id, payload: payload as unknown as Record<string, unknown> });
        return { ok: true };
      },
      configured: () => senderConfigured,
    });
  });

  afterAll(async () => {
    resetPushSender();
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

  // ── 1. The push-device routes ───────────────────────────────────────────────

  it('registers, opts in and out, reads and revokes the agent\'s own device; tokens never answered; audited', async () => {
    const agent = await user('agent');
    const none = await send('GET', `/proxy/agency/push-devices/${PHONE}`, agent);
    expect(none.statusCode, none.body).toBe(200);
    expect(none.json()).toEqual({ device: null, account_allows_ring: true, push_configured: true });

    const bad = await send('PUT', `/proxy/agency/push-devices/${PHONE}`, agent, { platform: 'android', app_build: '1.0+1' });
    expect(bad.statusCode).toBe(400);

    const put = await register(agent, PHONE, false);
    expect(put.device).toMatchObject({ device_id: PHONE, platform: 'android', push_registered: true, ring_enabled: false, revoked_at: null });
    expect(JSON.stringify(put)).not.toMatch(/fcm-|fcm_token|voip_token|push_device_audit/);

    const on = await send('PATCH', `/proxy/agency/push-devices/${PHONE}`, agent, { ring_enabled: true });
    expect(on.statusCode, on.body).toBe(200);
    expect(on.json().device).toMatchObject({ ring_enabled: true });
    expect(JSON.stringify(on.json())).not.toMatch(/push_device_audit/);
    expect((await send('PATCH', `/proxy/agency/push-devices/${PHONE}`, agent, { ring_enabled: 'yes' })).statusCode).toBe(400);

    // Own devices only: the same device id is another agent's own (none), and a body naming
    // another user changes nothing.
    const other = await user('agent');
    expect((await send('GET', `/proxy/agency/push-devices/${PHONE}`, other)).json().device).toBeNull();
    expect((await send('PATCH', `/proxy/agency/push-devices/${PHONE}`, other, { ring_enabled: false, agent_user_id: agent.id })).statusCode).toBe(404);
    expect((await send('GET', `/proxy/agency/push-devices/${PHONE}`, agent)).json().device).toMatchObject({ ring_enabled: true });

    expect((await send('GET', '/proxy/agency/push-devices/short', agent)).statusCode).toBe(404);

    const del = await send('DELETE', `/proxy/agency/push-devices/${PHONE}`, agent);
    expect(del.statusCode, del.body).toBe(204);
    expect((await send('DELETE', `/proxy/agency/push-devices/${PHONE}`, agent)).statusCode).toBe(204);
    expect((await send('GET', `/proxy/agency/push-devices/${PHONE}`, agent)).json().device.revoked_at).not.toBeNull();

    const optIns = (await auditRows('agency_push_device.ring_opt_in_changed')).filter((r) => r.user_id === agent.id);
    expect(optIns.map((r) => r.details)).toEqual([{ device_id: PHONE, ring_enabled: true }]);
    const revoked = (await auditRows('agency_push_device.revoked')).filter((r) => r.user_id === agent.id);
    expect(revoked).toHaveLength(1);
    expect(revoked[0]).toMatchObject({ resource_type: 'agency_push_device', details: { device_id: PHONE } });
    expect(JSON.stringify([...optIns, ...revoked])).not.toMatch(/fcm-/);
  });

  it('the test ring sends test_ring, once per 10 s; a phone that cannot be pushed to is refused', async () => {
    const agent = await user('agent');
    // Never registered (its own bucket: the limit is per agent and device).
    expect((await send('POST', '/proxy/agency/push-devices/phone-none-0009/test-ring', agent, {})).json()).toMatchObject({ code: 'no_push_device' });
    await register(agent);
    sent.length = 0;
    const first = await send('POST', `/proxy/agency/push-devices/${PHONE}/test-ring`, agent, {});
    expect(first.statusCode, first.body).toBe(202);
    expect(sent.map((s) => s.payload)).toEqual([{ type: 'test_ring' }]);
    expect((await send('POST', `/proxy/agency/push-devices/${PHONE}/test-ring`, agent, {})).statusCode).toBe(429);

    const other = await user('agent');
    await register(other, 'phone-cccc-0003');
    senderConfigured = false;
    const refused = await send('POST', '/proxy/agency/push-devices/phone-cccc-0003/test-ring', other, {});
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ code: 'push_unavailable' });
  });

  // ── 2. Entering away_ring ───────────────────────────────────────────────────

  it('away_ring is refused with a typed 409 until the phone can be rung', async () => {
    const { agent, sessionId } = await onDuty({ register: false });
    const ask = () => send('POST', `/proxy/agency/sessions/${sessionId}/break`, agent, { reason: 'away_ring' });
    expect((await ask()).json()).toMatchObject({ code: 'no_push_device' });
    await register(agent, PHONE, false);
    expect((await ask()).json()).toMatchObject({ code: 'ring_disabled' });
    await send('PATCH', `/proxy/agency/push-devices/${PHONE}`, agent, { ring_enabled: true });
    senderConfigured = false;
    const refused = await ask();
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ error: 'Conflict', code: 'push_unavailable' });
    expect(await runtime.agents.get(sessionId)).toMatchObject({ state: 'available', ring: false });
  });

  it('device_away ↔ away_ring is a break-to-break switch', async () => {
    const { agent, sessionId } = await onDuty();
    const away = await send('POST', `/proxy/agency/sessions/${sessionId}/break`, agent, { reason: 'device_away' });
    expect(away.json()).toMatchObject({ state: 'break', break_reason: 'device_away' });
    const ringing = await send('POST', `/proxy/agency/sessions/${sessionId}/break`, agent, { reason: 'away_ring' });
    expect(ringing.json()).toMatchObject({ state: 'break', break_reason: 'away_ring' });
    expect(await runtime.agents.get(sessionId)).toMatchObject({ state: 'break', ring: true });
    expect((await row(sessionId)).away_ring_since).toBeInstanceOf(Date);
    const back = await send('POST', `/proxy/agency/sessions/${sessionId}/break`, agent, { reason: 'device_away' });
    expect(back.json()).toMatchObject({ state: 'break', break_reason: 'device_away' });
    expect(await runtime.agents.get(sessionId)).toMatchObject({ state: 'break', ring: false });
    expect(await row(sessionId)).toMatchObject({ break_reason: 'device_away', away_ring_since: null });
  });

  // ── 3. Away ringing: the paths that used to mean offline ───────────────────

  it('the station close keeps away_ring; force-available is refused; "Stop ringing" ends it with ring_off', async () => {
    const { agent, sessionId, station } = await onDuty();
    await goAwayRinging(agent, sessionId, station);
    expect(await runtime.agents.get(sessionId)).toMatchObject({ state: 'break', ring: true });
    expect(await row(sessionId)).toMatchObject({ state: 'break', break_reason: 'away_ring' });
    expect(await getTestRedis().pttl(`agency:agent:${sessionId}:state`)).toBeGreaterThan(60_000);

    const forced = await send('POST', `/proxy/agency/sessions/${sessionId}/force-available`, supervisor, {});
    expect(forced.statusCode).toBe(409);
    expect(forced.json()).toMatchObject({ code: 'agent_away_ring', message: 'They\'re away from the app; their phone rings for inbound calls.' });
    expect(await runtime.agents.get(sessionId)).toMatchObject({ state: 'break', ring: true });

    const stop = await send('PATCH', `/proxy/agency/push-devices/${PHONE}`, agent, { ring_enabled: false });
    expect(stop.statusCode, stop.body).toBe(200);
    expect(await runtime.agents.get(sessionId)).toMatchObject({ state: 'offline', ring: false });
    expect(await row(sessionId)).toMatchObject({ state: 'offline', break_reason: 'device_away', away_ring_since: null });
    await waitFor('ring_off', () => sent.find((s) => s.payload['type'] === 'ring_off'));
    expect(sent.find((s) => s.payload['type'] === 'ring_off')!.payload).toEqual({ type: 'ring_off', session_id: sessionId, reason: 'opted_out' });
  });

  it('the silent-station sweep drops a phone still attached on away_ring, and the close keeps it', async () => {
    const { agent, sessionId } = await onDuty();
    const res = await send('POST', `/proxy/agency/sessions/${sessionId}/break`, agent, { reason: 'away_ring' });
    expect(res.json()).toMatchObject({ break_reason: 'away_ring' });
    // The app has not parked its socket yet, and stops answering: the sweep terminates it.
    expect(runtime.sweepSilentStations(() => -1)).toBeGreaterThan(0);
    await waitFor('detached', async () => !runtime.stations.isLocallyOwned(sessionId));
    await new Promise((r) => setTimeout(r, 100));
    expect(await runtime.agents.get(sessionId)).toMatchObject({ state: 'break', ring: true });
  });

  it('the agent\'s return (a station attaching) ends away_ring as device_away, and ready says so', async () => {
    const { agent, sessionId, station } = await onDuty();
    await goAwayRinging(agent, sessionId, station);
    const mint = await send('POST', `/proxy/agency/sessions/${sessionId}/station-token`, agent, { device_id: PHONE });
    expect(mint.statusCode, mint.body).toBe(200);
    const back = await connect(mint.json().station_ws_url as string);
    expect(back.frames.find((f) => f['event'] === 'ready')).toMatchObject({ state: 'break', break_reason: 'device_away' });
    expect(await runtime.agents.get(sessionId)).toMatchObject({ state: 'break', ring: false });
    expect(await row(sessionId)).toMatchObject({ break_reason: 'device_away', away_ring_since: null });
    // No ring_off: the app is on screen.
    expect(sent.filter((s) => s.payload['type'] === 'ring_off')).toEqual([]);
    const avail = await send('POST', `/proxy/agency/sessions/${sessionId}/available`, agent, {});
    expect(avail.statusCode).toBe(200);
  });

  it('another device taking the station over ends away_ring and tells the old device taken_over', async () => {
    const { agent, campaignId, sessionId, station } = await onDuty();
    await goAwayRinging(agent, sessionId, station);
    const take = await app.inject({
      method: 'POST', url: '/proxy/agency/sessions',
      headers: headers(agent, { 'x-client': 'web' }),
      payload: JSON.stringify({ campaign_id: campaignId, device_id: LAPTOP, take_over: true }),
    });
    expect(take.statusCode, take.body).toBe(201);
    expect(take.json()).toMatchObject({ session_id: sessionId, state: 'break', break_reason: 'device_away' });
    expect(await runtime.agents.get(sessionId)).toMatchObject({ state: 'break', ring: false });
    expect(await row(sessionId)).toMatchObject({ station_device_id: LAPTOP, break_reason: 'device_away', away_ring_since: null });
    await waitFor('ring_off', () => sent.find((s) => s.payload['type'] === 'ring_off'));
    expect(sent.filter((s) => s.payload['type'] === 'ring_off').map((s) => s.payload))
      .toEqual([{ type: 'ring_off', session_id: sessionId, reason: 'taken_over' }]);
  });
});
