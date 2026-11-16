import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/*
 * Live call listening with media workers (docs/listening.md §2 "Where it runs", LS5, LS10): the
 * real server entry as a process tree (a primary and two forked media workers) against the mock
 * VoiceLink carrier, a supervisor signed in through a stand-in Firebase emulator, everything else
 * real. Pinned:
 *  - the grant is forwarded to the worker that owns the agent's session (`body_session`), and the
 *    listener socket is handed to that same worker (`wsOwner: { by: 'session' }`): the session row
 *    names its replica, and both legs reach the listener tagged — no audio crossed IPC;
 *  - a supervisor's listen on one worker is superseded by their listen on the other (the
 *    supersede relayed as `listen.revoke` through the primary);
 *  - a role change through the real route reaches the worker as `listen.revoke` and ends the
 *    listen `permission_revoked` (4403), with the periodic re-check held off (5 min), so it is the
 *    immediate path; and a grant whose supervisor is demoted before its upgrade is refused 4403 by
 *    the owning worker, with no row.
 */

import WebSocket from 'ws';
import { closePool, initDbPool } from '@magick-agency/db';
import { TEST_DB_URL, closeTestPool, getTestPool, truncateAll } from '../../../../../packages/db/test/helpers/test-db.js';
import { insertAccount, insertMembership, insertTenant, insertUser } from '../../../../../packages/db/test/integration/setup/platform-factories.js';
import { flushTestRedis } from '../../helpers/test-redis.js';
import { insertAgencyCampaign, insertAgencyContact } from '../agency/agency-factories.js';
import { MockVoicelinkCarrier, carrierScripts, type CallStep, type LeadRequest } from '../../mocks/voicelink/index.js';
import { startClusterServer, type ClusterServer } from '../../helpers/cluster-server.js';
import { FakeFirebaseEmulator } from '../../helpers/cluster-mobile.js';
import Redis from 'ioredis';
import { TEST_REDIS_URL } from '../../helpers/test-redis.js';
import { config } from '../../../src/config/index.js';
import { StationTokenStore } from '../../../src/agency/station-token.js';
import { AgentStateMachine, AGENT_LEASE_MS } from '../../../src/agency/agent-state-machine.js';
import { agencyAgentSessionRepository } from '../../../src/db/repositories/agency.repository.js';
import { alawFrame } from '../../mocks/voicelink/audio-pattern.js';
import { slotFor } from '../../../src/cluster/roles.js';

const PROJECT = 'magick-agency-cluster-listen';
const NO_RETRY = Object.fromEntries(
  ['no_answer', 'busy', 'failed', 'abandoned', 'agent_disconnected', 'orphaned', 'canceled'].map((o) => [o, { max_attempts: 0 }]),
);

let carrier: MockVoicelinkCarrier;
let emulator: FakeFirebaseEmulator;
let server: ClusterServer;
let redis: Redis;
let tenantId: string;
let accountId: string;
let hangUpAll = false;

/** The carrier answers, streams the customer for a while, and holds until the suite ends. */
function held(): CallStep[] {
  const answeredAt = new Date().toISOString();
  return [
    { do: 'webhook', spec: carrierScripts.webhooks.initiated() },
    { do: 'webhook', spec: carrierScripts.webhooks.ringing() },
    { do: 'connect' },
    { do: 'webhook', spec: carrierScripts.webhooks.answered(answeredAt) },
    { do: 'start' },
    { do: 'media', pattern: Array.from({ length: 1500 }, (_, i) => i % 2 === 0), frameMs: 20 },
    { do: 'waitFor', until: () => hangUpAll, timeoutMs: 120_000, what: 'the suite to end' },
    { do: 'webhooks', specs: [carrierScripts.webhooks.endedAnswered(answeredAt, 30)] },
    { do: 'close', code: 1000 },
  ];
}

interface Supervisor { id: string; uid: string }

async function supervisor(): Promise<Supervisor> {
  const u = await insertUser();
  await insertMembership({ user_id: u.id, tenant_id: tenantId, account_id: accountId, role: 'account_admin' });
  return { id: u.id as string, uid: u.firebase_uid as string };
}

async function api(who: Supervisor, method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${server.origin}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${emulator.tokenFor(who.uid)}`, 'x-tenant-id': tenantId, 'x-account-id': accountId,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

interface Listener { ws: WebSocket; frames: Array<Record<string, unknown>>; legs: { customer: number; agent: number }; closed: { code: number; reason: string } | null; listenId: string }

async function listen(who: Supervisor, callId: string): Promise<Listener> {
  const res = await api(who, 'POST', `/proxy/agency/live-calls/${callId}/listen`);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  const l: Listener = { ws: new WebSocket(`${server.origin.replace('http', 'ws')}${res.body.ws_url}`), frames: [], legs: { customer: 0, agent: 0 }, closed: null, listenId: res.body.listen_id };
  l.ws.on('message', (raw: Buffer, isBinary) => {
    if (!isBinary) { l.frames.push(JSON.parse(raw.toString()) as Record<string, unknown>); return; }
    if (raw.length === 161 && raw[0] === 1) l.legs.customer++;
    if (raw.length === 161 && raw[0] === 2) l.legs.agent++;
  });
  l.ws.on('close', (code, reason) => { l.closed = { code, reason: reason.toString() }; });
  l.ws.on('error', () => undefined);
  await until('ready', 15_000, () => l.frames.some((f) => f['event'] === 'ready'));
  return l;
}

async function until(what: string, ms: number, check: () => Promise<boolean> | boolean): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function row(listenId: string) {
  const { rows } = await getTestPool().query('SELECT replica_id, end_reason, ended_at FROM agency_listen_sessions WHERE id = $1', [listenId]);
  return rows[0] as { replica_id: string; end_reason: string | null; ended_at: Date | null } | undefined;
}

/** The live call of each slot: one agent on each worker, each bridged to its own customer. */
const calls = new Map<number, { callId: string; agent: Station }>();

interface Station { sessionId: string; ws: WebSocket; timer: NodeJS.Timeout }
const stations: Station[] = [];

/**
 * A real `alaw8` station upgrade through the primary (handed to the session's worker), made
 * available; it pings like the console and talks (one A-law frame every 20 ms).
 */
async function openStation(sessionId: string): Promise<Station> {
  const { token } = await new StationTokenStore(redis, config.redis.keyPrefix).mint(sessionId);
  const ws = new WebSocket(`${server.origin.replace('http', 'ws')}/proxy/agency/station/${sessionId}?token=${token}&media=alaw8`);
  const frames: Array<Record<string, unknown>> = [];
  ws.on('message', (raw, isBinary) => { if (!isBinary) frames.push(JSON.parse(raw.toString()) as Record<string, unknown>); });
  ws.on('error', () => undefined);
  await until(`station ${sessionId} ready`, 20_000, () => frames.some((f) => f['event'] === 'ready'));
  await new AgentStateMachine(redis, config.redis.keyPrefix).set(sessionId, 'available', { leaseMs: AGENT_LEASE_MS.available });
  await agencyAgentSessionRepository.setState(sessionId, 'available');
  let n = 0;
  const timer = setInterval(() => {
    if (ws.readyState !== WebSocket.OPEN) return;
    const i = n++;
    ws.send(alawFrame(i, i % 2 === 0));
    if (i % 250 === 0) ws.send(JSON.stringify({ event: 'ping', ts: Date.now() }));
  }, 20);
  const st = { sessionId, ws, timer };
  stations.push(st);
  return st;
}

beforeAll(async () => {
  initDbPool({ url: TEST_DB_URL, poolMin: 0, poolMax: 8 });
  await truncateAll();
  await flushTestRedis();
  tenantId = (await insertTenant()).id as string;
  accountId = (await insertAccount({ tenant_id: tenantId })).id as string;
  await getTestPool().query(
    `INSERT INTO feature_flag_overrides (flag_key, scope_type, tenant_id, value) VALUES
       ('agency_dialer_enabled', 'tenant', $1, 'true'::jsonb), ('agency_live_listen_enabled', 'tenant', $1, 'true'::jsonb)`,
    [tenantId],
  );
  await getTestPool().query(
    'INSERT INTO account_settings (tenant_id, account_id, max_concurrent_calls, allow_recording) VALUES ($1, $2, 10000, true)',
    [tenantId, accountId],
  );
  let origin = '';
  carrier = new MockVoicelinkCarrier({ targetOrigin: () => origin });
  carrier.setScript((_lead: LeadRequest) => ({ name: 'held', steps: held() }));
  await carrier.start();
  emulator = new FakeFirebaseEmulator(PROJECT);
  await emulator.start();
  server = await startClusterServer({
    MEDIA_WORKERS: '2',
    FF_AGENCY_DIALER: 'true',
    FIREBASE_PROJECT_ID: PROJECT,
    FIREBASE_AUTH_EMULATOR_HOST: emulator.host,
    TELEPHONY_ENABLED_PROVIDERS: 'voicelink',
    VOICELINK_BASE_URL: carrier.baseUrl,
    VOICELINK_USERNAME: carrier.username,
    VOICELINK_PASSWORD: carrier.password,
    VOICELINK_WEBHOOK_BASE_URL: 'https://agency.test/api/v1/webhooks/voicelink',
    MAX_CONCURRENT_CALLS: '100000',
    RATE_LIMIT_WEBHOOK_MAX: '1000000',
    RATE_LIMIT_CARRIER_MEDIA_MAX: '1000000',
    RATE_LIMIT_STATION_MAX: '1000000',
    // The periodic re-check out of the way: a revocation that ends a listen within seconds came
    // through the immediate path (`listen.revoke` over IPC), not a pass.
    AGENCY_LISTEN_RECHECK_MS: '300000',
    LOG_LEVEL: process.env['CLUSTER_TEST_LOG_LEVEL'] ?? 'warn',
  });
  origin = server.origin;
  redis = new Redis(TEST_REDIS_URL, { maxRetriesPerRequest: 1 });

  // One campaign per slot, one contact each, and an agent joined on that slot.
  for (const slot of [0, 1]) {
    const campaign = await insertAgencyCampaign({
      tenant_id: tenantId, account_id: accountId, status: 'running', wrapup_seconds: 0, record_calls: true,
      disposition_catalog: JSON.stringify([]), retry_policy: JSON.stringify(NO_RETRY),
    });
    await insertAgencyContact(campaign.id as string, {
      tenant_id: tenantId, account_id: accountId, phone_e164: `+91961000000${slot}`, source_row_number: 1,
    });
    let agent: Station | null = null;
    for (let i = 0; i < 40 && !agent; i++) {
      const user = await insertUser();
      await insertMembership({ user_id: user.id, tenant_id: tenantId, account_id: accountId, role: 'agent' });
      const join = await agencyAgentSessionRepository.joinOrRehydrate({
        tenantId, accountId, campaignId: campaign.id as string, agentUserId: user.id as string, replicaId: 'test-floor',
      });
      if (!join.ok) throw new Error('join refused');
      // Only a session that hashes to `slot` gets a station (the others are never dialable).
      if (slotFor(join.session.id, 2) === slot) agent = await openStation(join.session.id);
    }
    if (!agent) throw new Error(`no session hashed to slot ${slot}`);
    const a = agent;
    await until(`slot ${slot} bridged`, 30_000, async () => {
      const { rows } = await getTestPool().query<{ webrtc_call_id: string | null; state: string }>(
        `SELECT webrtc_call_id, state FROM agency_call_attempts WHERE reserved_agent_id = $1`, [a.sessionId]);
      if (rows[0]?.state === 'bridged' && rows[0].webrtc_call_id) calls.set(slot, { callId: rows[0].webrtc_call_id, agent: a });
      return calls.has(slot);
    });
  }
}, 180_000);

afterAll(async () => {
  hangUpAll = true;
  for (const st of stations) { clearInterval(st.timer); st.ws.close(); }
  if (server && server.child.exitCode === null) await server.stop();
  await carrier?.stop?.();
  await emulator?.stop();
  await redis?.quit().catch(() => undefined);
  await closePool();
  await closeTestPool();
}, 120_000);

describe('listening with media workers', () => {
  it('the grant and the socket reach the worker that owns the call; both legs arrive; a listen on the other worker supersedes it', async () => {
    const sup = await supervisor();
    const list = await api(sup, 'GET', '/proxy/agency/live-calls');
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    expect(list.body.calls.map((c: { call_id: string }) => c.call_id).sort()).toEqual([calls.get(0)!.callId, calls.get(1)!.callId].sort());

    const first = await listen(sup, calls.get(0)!.callId);
    expect((await row(first.listenId))?.replica_id).toMatch(/:mw0:/);
    await until('both legs on slot 0', 15_000, () => first.legs.customer >= 10 && first.legs.agent >= 10);

    const second = await listen(sup, calls.get(1)!.callId);
    expect((await row(second.listenId))?.replica_id).toMatch(/:mw1:/);
    await until('both legs on slot 1', 15_000, () => second.legs.customer >= 10 && second.legs.agent >= 10);
    // One listen per supervisor, across workers: the first ends `superseded`.
    await until('the first superseded', 10_000, () => first.closed !== null);
    expect(first.closed).toEqual({ code: 4409, reason: 'superseded' });
    await until('its row closed', 10_000, async () => (await row(first.listenId))?.end_reason === 'superseded');
    expect(second.closed).toBeNull();
    second.ws.close();
    await until('second row closed', 10_000, async () => (await row(second.listenId))?.ended_at != null);
  }, 90_000);

  it('a role change through the real route reaches the worker as `listen.revoke`: 4403 permission_revoked', async () => {
    const sup = await supervisor();
    const owner = await insertUser();
    await insertMembership({ user_id: owner.id, tenant_id: tenantId, account_id: null, role: 'tenant_owner' });
    const l = await listen(sup, calls.get(1)!.callId);
    const changed = await api({ id: owner.id as string, uid: owner.firebase_uid as string }, 'PUT', `/users/${sup.id}/role`, { role: 'operator' });
    expect(changed.status, JSON.stringify(changed.body)).toBe(200);
    await until('revoked', 10_000, () => l.closed !== null);
    expect(l.closed).toEqual({ code: 4403, reason: 'permission_revoked' });
    await until('row closed', 10_000, async () => (await row(l.listenId))?.end_reason === 'permission_revoked');
  }, 60_000);

  it('a grant whose supervisor is demoted before the upgrade is refused 4403 by the owning worker, with no row', async () => {
    const sup = await supervisor();
    const owner = await insertUser();
    await insertMembership({ user_id: owner.id, tenant_id: tenantId, account_id: null, role: 'tenant_owner' });
    const res = await api(sup, 'POST', `/proxy/agency/live-calls/${calls.get(0)!.callId}/listen`);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const changed = await api({ id: owner.id as string, uid: owner.firebase_uid as string }, 'PUT', `/users/${sup.id}/role`, { role: 'operator' });
    expect(changed.status, JSON.stringify(changed.body)).toBe(200);
    const ws = new WebSocket(`${server.origin.replace('http', 'ws')}${res.body.ws_url}`);
    ws.on('error', () => undefined);
    const closed = await new Promise<{ code: number; reason: string }>((resolve) => ws.on('close', (code, reason) => resolve({ code, reason: reason.toString() })));
    expect(closed).toEqual({ code: 4403, reason: 'permission_revoked' });
    expect(await row(res.body.listen_id)).toBeUndefined();
  }, 60_000);
});
