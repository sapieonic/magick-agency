import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The mobile app's presence through the REAL app (`buildApp` with a real context: the agency
 * runtime, real Redis on this worktree's db, real Postgres), with the real session →
 * tenant-context → RBAC chain (Firebase's token check is the one stub), the public
 * `proxy-agency-agent.routes.ts` handlers and the internal handlers behind `callCore`.
 *
 * What it pins:
 *  1. **Client kind.** A join whose `X-Client` is the mobile app is served the mobile
 *     heartbeat grace; the station attach writes `agency_agent_sessions.client_kind` from
 *     the upgrade's `client=` on EVERY attach (a "continue on this phone" moves it back and
 *     forth on one session), writes nothing when it is unchanged, and the supervisor's
 *     floor serves it. An unknown `client=` / `media=` is refused 1008 before attach.
 *  2. **The device-away break** (`POST /proxy/agency/sessions/:id/break {reason:'device_away'}`)
 *     on every state that matters: applied from `available` (Redis, the row, the audit row),
 *     idempotent, never over a break the agent chose, queued behind a call and withdrawn by
 *     `break/cancel`, a no-op when offline and on a soft-phone session; `/available` returns.
 */

const mocks = vi.hoisted(() => {
  process.env['SUPER_ADMIN_JWT_SECRET'] = 'mobile-presence-secret-0123456789';
  return { verifyIdToken: vi.fn() };
});

vi.mock('../../../src/auth/firebase.js', () => ({
  initFirebase: vi.fn(),
  verifyIdToken: mocks.verifyIdToken,
}));

import type { FastifyInstance } from 'fastify';
import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import { closePool, getPool, initDbPool } from '@magick-agency/db';
import { TEST_DB_URL, closeTestPool, getTestPool, truncateAll } from '../../../../../packages/db/test/helpers/test-db.js';
import {
  insertAccount,
  insertMembership,
  insertTenant,
  insertUser,
} from '../../../../../packages/db/test/integration/setup/platform-factories.js';
import { closeTestRedis, flushTestRedis, getTestRedis } from '../../helpers/test-redis.js';
import { insertAgencyCampaign, insertAgentSession } from '../agency/agency-factories.js';
import { config } from '../../../src/config/index.js';
import { buildApp } from '../../../src/app.js';
import type { AppContext } from '../../../src/app-context.js';
import { getAgencyRuntime, resetAgencyRuntimeForTests } from '../../../src/bootstrap/agency.js';
import { resetVoiceEngineForTests } from '../../../src/bootstrap/voice.js';
import { platformAuditLogger } from '../../../src/audit/platform/audit-logger.js';
import { AGENT_LEASE_MS } from '../../../src/agency/agent-state-machine.js';
import { MOBILE_STATION_HEARTBEAT_GRACE_MS, STATION_HEARTBEAT_GRACE_MS } from '@magick-agency/domain/timers';

const MOBILE_UA = 'magick-agency-mobile/1.4.0+212 (android 14; Pixel 8)';

let app: FastifyInstance;
/** The app listens: station sockets are real `ws` connections, so a client close reaches the server. */
let port = 0;

interface W {
  tenant: string; account: string;
  agent: { id: string; tok: string };
  supervisor: { id: string; tok: string };
  campaign: string;
}
let w: W;

async function user(tenant: string, account: string, role: string) {
  const u = await insertUser();
  await insertMembership({ user_id: u.id, tenant_id: tenant, account_id: account, role });
  return { id: u.id as string, tok: `tok:${u.firebase_uid as string}` };
}

beforeAll(async () => {
  initDbPool({ url: TEST_DB_URL, poolMin: 0, poolMax: 6 });
  mocks.verifyIdToken.mockImplementation(async (token: string) => {
    if (!token.startsWith('tok:')) throw new Error('bad token');
    return { uid: token.slice(4), email: 'mp@example.com', email_verified: true };
  });
  await flushTestRedis();
  resetVoiceEngineForTests();
  await resetAgencyRuntimeForTests();
  const ctx: AppContext = { config, pool: getPool(), redis: getTestRedis() };
  app = await buildApp({ ctx });
  await app.listen({ port: 0, host: '127.0.0.1' });
  port = (app.server.address() as AddressInfo).port;
});

beforeEach(async () => {
  await truncateAll();
  await flushTestRedis();
  const tenant = (await insertTenant()).id as string;
  const account = (await insertAccount({ tenant_id: tenant })).id as string;
  await getTestPool().query(
    `INSERT INTO feature_flag_overrides (flag_key, scope_type, tenant_id, value)
     VALUES ('agency_dialer_enabled', 'tenant', $1, 'true'::jsonb)`,
    [tenant],
  );
  const agent = await user(tenant, account, 'agent');
  const supervisor = await user(tenant, account, 'account_admin');
  // `break_reasons` lists none: the built-ins (`lunch` among them) apply.
  const campaign = (await insertAgencyCampaign({ status: 'running', tenant_id: tenant, account_id: account })).id as string;
  // Staffed, so the join passes the staffing check (`not_staffed`, `agency/sessions.ts`).
  await getTestPool().query(
    `INSERT INTO agency_campaign_agents (tenant_id, account_id, campaign_id, user_id) VALUES ($1, $2, $3, $4)`,
    [tenant, account, campaign, agent.id],
  );
  w = { tenant, account, agent, supervisor, campaign };
});

afterAll(async () => {
  await app?.close();
  await resetAgencyRuntimeForTests();
  resetVoiceEngineForTests();
  await closePool();
  await closeTestPool();
  await closeTestRedis();
});

function headers(who: { tok: string }, extra: Record<string, string> = {}) {
  return {
    authorization: `Bearer ${who.tok}`,
    'x-tenant-id': w.tenant,
    'x-account-id': w.account,
    'content-type': 'application/json',
    ...extra,
  };
}

function post(url: string, who: { tok: string }, body: unknown = {}, extra: Record<string, string> = {}) {
  return app.inject({ method: 'POST', url, headers: headers(who, extra), payload: JSON.stringify(body) });
}

const runtime = () => getAgencyRuntime()!;

async function sessionRow(id: string) {
  const { rows } = await getTestPool().query<{ state: string; break_reason: string | null; client_kind: string; updated_at: Date }>(
    'SELECT state, break_reason, client_kind, updated_at FROM agency_agent_sessions WHERE id = $1', [id],
  );
  return rows[0]!;
}

type Ws = WebSocket;

/** Open the station at `url` (a path) and resolve once `ready` arrives (or with the close code). */
async function openStation(url: string): Promise<{ ws: Ws; ready: Record<string, unknown> | null; code: number | null }> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${url}`);
  return new Promise((resolve) => {
    ws.on('message', (raw: Buffer) => {
      const frame = JSON.parse(raw.toString()) as Record<string, unknown>;
      if (frame['event'] === 'ready') resolve({ ws, ready: frame, code: null });
    });
    ws.on('close', (code: number) => resolve({ ws, ready: null, code }));
  });
}

async function stationUrl(sessionId: string, query = ''): Promise<string> {
  const res = await post(`/proxy/agency/sessions/${sessionId}/station-token`, w.agent);
  expect(res.statusCode, res.body).toBe(200);
  return `${res.json().station_ws_url as string}${query}`;
}

/** Close a station and wait for the server to settle it (detach + the offline write). */
async function closeStation(ws: Ws, sessionId: string): Promise<void> {
  if (ws.readyState !== WebSocket.CLOSED) {
    const closed = new Promise<void>((resolve) => ws.once('close', () => resolve()));
    ws.close();
    await closed;
  }
  await vi.waitFor(() => expect(runtime().stations.isLocallyOwned(sessionId)).toBe(false), { timeout: 5_000 });
  await vi.waitFor(async () => expect((await sessionRow(sessionId)).state).toBe('offline'), { timeout: 5_000 });
}

/** Join as the mobile app, open its station and go available. */
async function availableOnMobile(): Promise<{ sessionId: string; ws: Ws }> {
  const join = await post('/proxy/agency/sessions', w.agent, { campaign_id: w.campaign }, { 'x-client': MOBILE_UA });
  expect(join.statusCode, join.body).toBe(201);
  const sessionId = join.json().session_id as string;
  const { ws, ready } = await openStation(`${join.json().station_ws_url as string}&client=mobile`);
  expect(ready).not.toBeNull();
  const res = await post(`/proxy/agency/sessions/${sessionId}/available`, w.agent);
  expect(res.statusCode, res.body).toBe(200);
  return { sessionId, ws };
}

function breakAudits(sessionId: string) {
  return (vi.mocked(platformAuditLogger.log).mock.calls as Array<[Record<string, unknown>]>)
    .map(([e]) => e)
    .filter((e) => e['action'] === 'agency_session.break_started' && e['resource_id'] === sessionId);
}

describe('client kind on the session (0006)', () => {
  it('a mobile join is served the mobile grace; a web one the web grace', async () => {
    const mobile = await post('/proxy/agency/sessions', w.agent, { campaign_id: w.campaign }, { 'x-client': MOBILE_UA });
    expect(mobile.statusCode, mobile.body).toBe(201);
    expect(mobile.json().intervals.heartbeat_grace_ms).toBe(MOBILE_STATION_HEARTBEAT_GRACE_MS);
    // A rehydrate of the same session from the browser is served the web's.
    const web = await post('/proxy/agency/sessions', w.agent, { campaign_id: w.campaign });
    expect(web.statusCode, web.body).toBe(201);
    expect(web.json().session_id).toBe(mobile.json().session_id);
    expect(web.json().intervals.heartbeat_grace_ms).toBe(STATION_HEARTBEAT_GRACE_MS);
  });

  it('every attach writes the attaching app (continue on this phone, and back), and only when it changes', async () => {
    const join = await post('/proxy/agency/sessions', w.agent, { campaign_id: w.campaign });
    const sessionId = join.json().session_id as string;
    expect((await sessionRow(sessionId)).client_kind).toBe('web');

    const phone = await openStation(`${join.json().station_ws_url as string}&client=mobile&media=pcm16`);
    expect(phone.ready).not.toBeNull();
    expect((await sessionRow(sessionId)).client_kind).toBe('mobile');
    expect(runtime().stations.get(sessionId)?.clientKind).toBe('mobile');
    expect(runtime().stations.probeCount()).toBe(1);
    await closeStation(phone.ws, sessionId);
    expect(runtime().stations.probeCount()).toBe(0);

    // The same app again: nothing written (the row's updated_at does not move).
    const before = await sessionRow(sessionId);
    const again = await openStation(await stationUrl(sessionId, '&client=mobile'));
    expect(again.ready).not.toBeNull();
    const after = await sessionRow(sessionId);
    expect(after.client_kind).toBe('mobile');
    await closeStation(again.ws, sessionId);
    // `closeStation`'s offline write moves updated_at, so compare with what the attach left.
    expect(after.updated_at.getTime()).toBe(before.updated_at.getTime());

    // Back to the browser (no `client=`: web).
    const browser = await openStation(await stationUrl(sessionId));
    expect(browser.ready).not.toBeNull();
    expect((await sessionRow(sessionId)).client_kind).toBe('web');
    expect(runtime().stations.get(sessionId)?.clientKind).toBe('web');
    expect(runtime().stations.probeCount()).toBe(0);
    await closeStation(browser.ws, sessionId);
  });

  it('the supervisor\'s floor serves client_kind', async () => {
    const { sessionId, ws } = await availableOnMobile();
    const res = await app.inject({ method: 'GET', url: `/proxy/agency/campaigns/${w.campaign}/stats`, headers: headers(w.supervisor) });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().agents).toEqual([expect.objectContaining({ session_id: sessionId, client_kind: 'mobile', state: 'available' })]);
    await closeStation(ws, sessionId);
  });

  it.each([['&client=ios', 'invalid_client'], ['&media=opus', 'invalid_media']])(
    'an unknown %s is refused 1008 before attach, and writes nothing',
    async (query, _reason) => {
      const join = await post('/proxy/agency/sessions', w.agent, { campaign_id: w.campaign });
      const sessionId = join.json().session_id as string;
      const { code } = await openStation(`${join.json().station_ws_url as string}${query}`);
      expect(code).toBe(1008);
      expect(runtime().stations.isLocallyOwned(sessionId)).toBe(false);
      expect((await sessionRow(sessionId)).client_kind).toBe('web');
      // The token was not consumed by the refusal: the corrected upgrade attaches.
      const ok = await openStation(join.json().station_ws_url as string);
      expect(ok.ready).not.toBeNull();
      await closeStation(ok.ws, sessionId);
    },
  );
});

describe('the device-away break', () => {
  beforeEach(() => {
    vi.spyOn(platformAuditLogger, 'log');
  });

  it('available → break/device_away in Redis and on the row, audited once; a repeat changes nothing; /available returns', async () => {
    const { sessionId, ws } = await availableOnMobile();

    const res = await post(`/proxy/agency/sessions/${sessionId}/break`, w.agent, { reason: 'device_away' }, { 'x-client': MOBILE_UA });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ session_id: sessionId, kind: 'campaign', campaign_id: w.campaign, state: 'break', break_reason: 'device_away' });
    expect(res.json()).not.toHaveProperty('break_unchanged');
    expect((await runtime().agents.get(sessionId))?.state).toBe('break');
    expect(await sessionRow(sessionId)).toMatchObject({ state: 'break', break_reason: 'device_away' });
    expect(breakAudits(sessionId)).toEqual([
      expect.objectContaining({ details: { reason: 'device_away', campaign_id: w.campaign }, campaign_id: w.campaign }),
    ]);

    const repeat = await post(`/proxy/agency/sessions/${sessionId}/break`, w.agent, { reason: 'device_away' });
    expect(repeat.statusCode, repeat.body).toBe(200);
    expect(repeat.json()).toMatchObject({ state: 'break', break_reason: 'device_away' });
    expect(repeat.json()).not.toHaveProperty('break_unchanged');
    expect(breakAudits(sessionId)).toHaveLength(1);

    const back = await post(`/proxy/agency/sessions/${sessionId}/available`, w.agent);
    expect(back.statusCode, back.body).toBe(200);
    expect((await runtime().agents.get(sessionId))?.state).toBe('available');
    await closeStation(ws, sessionId);
  });

  it('never overrides a break the agent chose', async () => {
    const { sessionId, ws } = await availableOnMobile();
    expect((await post(`/proxy/agency/sessions/${sessionId}/break`, w.agent, { reason: 'lunch' })).statusCode).toBe(200);

    const res = await post(`/proxy/agency/sessions/${sessionId}/break`, w.agent, { reason: 'device_away' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ state: 'break', break_reason: 'lunch' });
    expect(await sessionRow(sessionId)).toMatchObject({ state: 'break', break_reason: 'lunch' });
    expect(breakAudits(sessionId).map((e) => (e['details'] as { reason: string }).reason)).toEqual(['lunch']);
    await closeStation(ws, sessionId);
  });

  it('on a call: queued (pending_state), the call untouched; break/cancel withdraws it', async () => {
    const { sessionId, ws } = await availableOnMobile();
    await runtime().agents.set(sessionId, 'on_call', { leaseMs: AGENT_LEASE_MS.on_call });

    const res = await post(`/proxy/agency/sessions/${sessionId}/break`, w.agent, { reason: 'device_away' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ state: 'on_call', pending_state: 'break', break_reason: 'device_away' });
    expect((await runtime().agents.get(sessionId))?.state).toBe('on_call');
    expect(runtime().breaks.peek(sessionId)?.code).toBe('device_away');
    expect(breakAudits(sessionId)).toHaveLength(1);

    const cancel = await post(`/proxy/agency/sessions/${sessionId}/break/cancel`, w.agent);
    expect(cancel.statusCode, cancel.body).toBe(200);
    expect(runtime().breaks.peek(sessionId)).toBeNull();

    await runtime().agents.set(sessionId, 'available', { leaseMs: AGENT_LEASE_MS.available });
    await closeStation(ws, sessionId);
  });

  it('offline (no station, no lease): nothing changes, answered offline, nothing audited', async () => {
    const session = await insertAgentSession(w.campaign, {
      tenant_id: w.tenant, account_id: w.account, agent_user_id: w.agent.id, state: 'offline',
    });
    const res = await post(`/proxy/agency/sessions/${session.id}/break`, w.agent, { reason: 'device_away' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ session_id: session.id, state: 'offline' });
    expect(res.json()).not.toHaveProperty('break_reason');
    expect(await runtime().agents.get(session.id as string)).toBeNull();
    expect(await sessionRow(session.id as string)).toMatchObject({ state: 'offline', break_reason: null });
    expect(breakAudits(session.id as string)).toHaveLength(0);
  });

  it('a soft-phone session: 200 with its current state (any other reason is still 409 wrong_session_kind)', async () => {
    const session = await insertAgentSession(null as unknown as string, {
      tenant_id: w.tenant, account_id: w.account, agent_user_id: w.agent.id,
      kind: 'softphone', campaign_id: null, state: 'break', break_reason: 'soft_phone',
    });
    await runtime().agents.set(session.id as string, 'break', { leaseMs: AGENT_LEASE_MS.break });

    const res = await post(`/proxy/agency/sessions/${session.id}/break`, w.agent, { reason: 'device_away' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ session_id: session.id, kind: 'softphone', campaign_id: null, state: 'break', break_reason: 'soft_phone' });
    expect(await sessionRow(session.id as string)).toMatchObject({ state: 'break', break_reason: 'soft_phone' });
    expect(breakAudits(session.id as string)).toHaveLength(0);

    const lunch = await post(`/proxy/agency/sessions/${session.id}/break`, w.agent, { reason: 'lunch' });
    expect(lunch.statusCode).toBe(409);
    expect(lunch.json().code).toBe('wrong_session_kind');
    // Leave nothing behind for 0005's Down (the db suite's down → up).
    await getTestPool().query('DELETE FROM agency_agent_sessions WHERE id = $1', [session.id]);
  });

  it('a campaign\'s break_reasons may not list it (400, nothing written)', async () => {
    const res = await app.inject({
      method: 'PATCH', url: `/proxy/agency/campaigns/${w.campaign}`, headers: headers(w.supervisor),
      payload: JSON.stringify({ break_reasons: [{ code: 'device_away', label: 'Away' }] }),
    });
    expect(res.statusCode, res.body).toBe(400);
    expect(res.body).toContain('device_away');
    const { rows } = await getTestPool().query('SELECT break_reasons FROM agency_campaigns WHERE id = $1', [w.campaign]);
    expect(rows[0].break_reasons).toEqual([]);
  });
});
