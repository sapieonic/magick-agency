import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Live call listening end to end (docs/listening.md §4), through the WHOLE server against the mock
 * VoiceLink carrier: the real app listening on loopback, the voice and agency bootstraps (the
 * pacing loop dials), the real bridge and its tap, real station sockets, the real public routes
 * (Firebase stood in for, every other guard real: the session, the tenant context, RBAC, the flag),
 * real listener socket upgrades, Postgres and Redis. Each call is a campaign contact the carrier
 * answers and holds until the test hangs it up; the customer talks only once the test says so, so
 * a listener that joined mid-call hears both legs.
 *
 * Covered: joining mid-call with both legs tagged; the call ending (`ended { call_ended }`, the row
 * closed, the audit pair); a listener dropping (the call unaffected); the per-call cap; supersede;
 * a role change through the real route (the periodic re-check held off, so it is the immediate
 * path), and one between a grant and its upgrade (refused at the upgrade, no row); LS4 both ways; the own-call rule; another account and
 * another tenant (404, absent from the list); agents and operators (403); the flag off (403); the
 * number reveal; the call detail's `listen_sessions`; a soft-phone call; a wrap-up redial (a new
 * call listened to by its own id); the boot sweep of a dead process's rows; an agent's own hangup
 * (nothing of the agent's after `ended`); a grant whose call ended before its upgrade (no
 * "Listened to by"); an agent reading their own soft-phone call (no `listen_sessions`); a
 * super-admin's session (no reach). The Plivo and inbound
 * variants are `test/integration/telephony/live-listen-plivo-e2e.test.ts`.
 */

const env = vi.hoisted(() => {
  const e: Record<string, string> = {
    FF_AGENCY_DIALER: 'true',
    FF_AGENCY_SOFTPHONE: 'true',
    VOICELINK_WEBHOOK_BASE_URL: 'https://agency.test/api/v1/webhooks/voicelink',
    VOICELINK_USERNAME: 'mock-vl-user',
    VOICELINK_PASSWORD: 'mock-vl-password',
    MAX_CONCURRENT_CALLS: '100000',
    RATE_LIMIT_WEBHOOK_MAX: '1000000',
    RATE_LIMIT_CARRIER_MEDIA_MAX: '1000000',
    RATE_LIMIT_STATION_MAX: '1000000',
    RATE_LIMIT_MAX: '1000000',
    RATE_LIMIT_USER_MAX: '1000000',
    // The periodic re-check (LS10's backstop) out of the way: a revocation that ends a listen here
    // within seconds went through the immediate path (`membershipRevoked`'s subscriber), not a pass.
    AGENCY_LISTEN_RECHECK_MS: '300000',
    SUPER_ADMIN_JWT_SECRET: 'listen-e2e-super-admin-secret',
    LOG_LEVEL: 'error',
  };
  Object.assign(process.env, e);
  return e;
});
const fb = vi.hoisted(() => ({ verifyIdToken: vi.fn() }));
vi.mock('../../../src/auth/firebase.js', () => ({ initFirebase: vi.fn(), verifyIdToken: fb.verifyIdToken }));

import { randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import WebSocket from 'ws';
import { getPool } from '@magick-agency/db';
import { getTestPool } from '../../../../../packages/db/test/helpers/test-db.js';
import { getTestRedis } from '../../helpers/test-redis.js';
import { closedRow as waitClosedRow, listenRow as readListenRow, openListener, type ListenClient } from '../../helpers/listen-client.js';
import { config } from '../../../src/config/index.js';
import type { AppContext } from '../../../src/app-context.js';
import { getAgencyRuntime, resetAgencyRuntimeForTests, startAgency } from '../../../src/bootstrap/agency.js';
import { startVoice } from '../../../src/bootstrap/voice.js';
import { callCore } from '../../../src/api/core-dispatch.js';
import { getFeatureFlagService } from '../../../src/feature-flags/index.js';
import { platformAuditLogger } from '../../../src/audit/platform/audit-logger.js';
import { agencyAgentSessionRepository } from '../../../src/db/repositories/agency.repository.js';
import { AGENT_LEASE_MS } from '../../../src/agency/agent-state-machine.js';
import { insertAgencyCampaign, insertAgencyContact } from './agency-factories.js';
import { carrierScripts, type CallStep, type LeadRequest } from '../../mocks/voicelink/index.js';
import { alawFrame } from '../../mocks/voicelink/audio-pattern.js';
import {
  LOAD_ACCOUNT as ACCOUNT, LOAD_TENANT as TENANT, closeLoadDb, initLoadDb, startLoadRig, stopLoadRig, waitFor, type LoadRig,
} from '../load/voicelink-load-harness.js';

const OTHER_ACCOUNT = '6c1d0c8e-3d0e-4c7a-8b44-1f6b0a0000a2';
const OTHER_TENANT = '6c1d0c8e-3d0e-4c7a-8b44-1f6b0a0000f1';
const OTHER_TENANT_ACCOUNT = '6c1d0c8e-3d0e-4c7a-8b44-1f6b0a0000f2';
/** A process that is gone: its open listen row is closed by the boot sweep. */
const DEAD_REPLICA = 'dead-replica:mw0:1';
const ORPHAN_LISTEN = '6c1d0c8e-3d0e-4c7a-8b44-1f6b0a00dead';

const pool = () => getTestPool();

// ─── The world ──────────────────────────────────────────────────────────────

interface User { id: string; uid: string }

async function user(role: string, opts: { account?: string | null; tenant?: string } = {}): Promise<User> {
  const id = randomUUID();
  const uid = `fb-${role}-${id.slice(0, 8)}`;
  await pool().query('INSERT INTO users (id, firebase_uid, email, display_name) VALUES ($1, $2, $3, $4)', [id, uid, `${uid}@example.test`, `${role} ${id.slice(0, 4)}`]);
  await pool().query('INSERT INTO memberships (user_id, tenant_id, account_id, role) VALUES ($1, $2, $3, $4)',
    [id, opts.tenant ?? TENANT, opts.account === undefined ? ACCOUNT : opts.account, role]);
  return { id, uid };
}

async function setFlag(key: string, on: boolean, tenant = TENANT, account = ACCOUNT): Promise<void> {
  await pool().query('DELETE FROM feature_flag_overrides WHERE flag_key = $1 AND tenant_id = $2 AND account_id = $3', [key, tenant, account]);
  await pool().query(
    `INSERT INTO feature_flag_overrides (flag_key, scope_type, tenant_id, account_id, value) VALUES ($1, 'account', $2, $3, $4::jsonb)`,
    [key, tenant, account, on ? 'true' : 'false']);
  await getFeatureFlagService().invalidate({ tenantId: tenant });
}

function http(who: User, method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, body?: unknown, scope: { tenant?: string; account?: string } = {}) {
  return rig!.app.inject({
    method, url,
    headers: {
      authorization: `Bearer tok:${who.uid}`, 'x-tenant-id': scope.tenant ?? TENANT, 'x-account-id': scope.account ?? ACCOUNT,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
  });
}

/** How the carrier holds a call: answers, waits for `talk` to stream the customer, waits for `hangUp`. */
interface CallControl { talk: boolean; hangUp: boolean }

const scripts = new Map<string, Array<{ steps: CallStep[] }>>();
const controls: CallControl[] = [];

function heldCall(ctl: CallControl): CallStep[] {
  const answeredAt = new Date().toISOString();
  return [
    { do: 'webhook', spec: carrierScripts.webhooks.initiated() },
    { do: 'webhook', spec: carrierScripts.webhooks.ringing() },
    { do: 'connect' },
    { do: 'webhook', spec: carrierScripts.webhooks.answered(answeredAt) },
    { do: 'start' },
    { do: 'waitFor', until: () => ctl.talk || ctl.hangUp, timeoutMs: 60_000, what: 'the test to let the customer talk' },
    { do: 'media', pattern: Array.from({ length: 50 }, (_, i) => i % 2 === 0), frameMs: 20 },
    { do: 'waitFor', until: () => ctl.hangUp, timeoutMs: 60_000, what: 'the test to hang the customer up' },
    { do: 'webhooks', specs: [carrierScripts.webhooks.endedAnswered(answeredAt, 3)] },
    { do: 'close', code: 1000 },
  ];
}

/** The carrier holds the next call to `national` under `ctl` (calls to it in order). */
function carrierHolds(national: string, ctl: CallControl): void {
  controls.push(ctl);
  const queue = scripts.get(national) ?? [];
  queue.push({ steps: heldCall(ctl) });
  scripts.set(national, queue);
}

interface Station { sessionId: string; ws: WebSocket; frames: Array<Record<string, unknown>>; heard: number; talker: NodeJS.Timeout | null }
const stations: Station[] = [];

/** An agent joins `campaignId` on a real `alaw8` station socket and goes available. */
async function stationFor(campaignId: string | null, agent: User, opts: { softphone?: boolean } = {}): Promise<Station> {
  const runtime = getAgencyRuntime()!;
  const join = opts.softphone
    ? await agencyAgentSessionRepository.joinSoftphone({ tenantId: TENANT, accountId: ACCOUNT, agentUserId: agent.id, replicaId: runtime.replicaId })
    : await agencyAgentSessionRepository.joinOrRehydrate({ tenantId: TENANT, accountId: ACCOUNT, campaignId: campaignId!, agentUserId: agent.id, replicaId: runtime.replicaId });
  if (!join.ok) throw new Error('join refused');
  const { token } = await runtime.tokens.mint(join.session.id);
  const port = new URL(rig!.origin).port;
  const st: Station = {
    sessionId: join.session.id, frames: [], heard: 0, talker: null,
    ws: new WebSocket(`ws://127.0.0.1:${port}/proxy/agency/station/${join.session.id}?token=${token}&media=alaw8`),
  };
  st.ws.on('message', (raw, isBinary) => {
    if (isBinary) { st.heard++; return; }
    st.frames.push(JSON.parse(raw.toString()) as Record<string, unknown>);
  });
  stations.push(st);
  await waitFor('station ready', () => st.frames.some((f) => f['event'] === 'ready'));
  if (!opts.softphone) {
    runtime.wrapup.cancel(st.sessionId, 'agent_returned');
    await runtime.agents.set(st.sessionId, 'available', { leaseMs: AGENT_LEASE_MS.available });
    await agencyAgentSessionRepository.setState(st.sessionId, 'available');
  }
  return st;
}

/** The agent talks: one 160-byte A-law frame every 20 ms. */
function talk(st: Station): void {
  if (st.talker) return;
  let i = 0;
  st.talker = setInterval(() => { if (st.ws.readyState === WebSocket.OPEN) { const n = i++; st.ws.send(alawFrame(n, n % 2 === 0)); }; }, 20);
}

interface Live { campaignId: string; callId: string; attemptId: string; agent: User; station: Station; ctl: CallControl; national: string }

let numberSeq = 0;
/** A running campaign with one contact the carrier answers and holds; its agent bridged to it. */
async function liveCall(opts: { record?: boolean; agent?: User; campaign?: Record<string, unknown> } = {}): Promise<Live> {
  const national = `96${String(20_000_000 + ++numberSeq).padStart(8, '0')}`;
  const ctl: CallControl = { talk: false, hangUp: false };
  carrierHolds(national, ctl);
  const campaign = await insertAgencyCampaign({
    tenant_id: TENANT, account_id: ACCOUNT, status: 'running', wrapup_seconds: 0, record_calls: opts.record ?? true,
    disposition_catalog: JSON.stringify([]), retry_policy: JSON.stringify(NO_RETRY), ...opts.campaign,
  });
  await insertAgencyContact(campaign.id as string, {
    tenant_id: TENANT, account_id: ACCOUNT, phone_e164: `+91${national}`, source_row_number: 1, context: JSON.stringify({ name: 'Ada Lovelace' }),
  });
  const agent = opts.agent ?? await user('agent');
  const station = await stationFor(campaign.id as string, agent);
  const attempt = await waitFor('the attempt bridged', async () => {
    const { rows } = await pool().query<{ id: string; webrtc_call_id: string | null; state: string }>(
      'SELECT id, webrtc_call_id, state FROM agency_call_attempts WHERE campaign_id = $1 ORDER BY created_at DESC LIMIT 1', [campaign.id]);
    return rows[0]?.state === 'bridged' && rows[0].webrtc_call_id ? rows[0] : null;
  }, 30_000);
  return { campaignId: campaign.id as string, callId: attempt.webrtc_call_id!, attemptId: attempt.id, agent, station, ctl, national };
}

const NO_RETRY = Object.fromEntries(
  ['no_answer', 'busy', 'failed', 'abandoned', 'agent_disconnected', 'orphaned', 'canceled'].map((o) => [o, { max_attempts: 0 }]),
);

// ─── A listener ─────────────────────────────────────────────────────────────

async function listen(who: User, callId: string): Promise<ListenClient> {
  const res = await http(who, 'POST', `/proxy/agency/live-calls/${callId}/listen`);
  expect(res.statusCode, res.body).toBe(201);
  const l = openListener(rig!.origin, res.json() as { listen_id: string; ws_url: string });
  await waitFor('ready', () => l.frames.some((f) => f['event'] === 'ready') || l.closed, 10_000);
  return l;
}

const listenRow = (listenId: string) => readListenRow(pool(), { listenId });
const closedRow = (listenId: string, reason: string) => waitClosedRow(pool(), { listenId }, reason);

async function auditActions(callId: string): Promise<string[]> {
  // Flushed, not shut down: the logger keeps running for the rest of the file (`platformAuditLogger.flush`).
  await platformAuditLogger.flush();
  const { rows } = await pool().query<{ action: string }>(
    `SELECT action FROM platform_audit_log WHERE resource_type = 'agency_call' AND resource_id = $1 ORDER BY created_at, action DESC`, [callId]);
  return rows.map((r) => r.action);
}

// ─── Lifecycle ──────────────────────────────────────────────────────────────

let rig: LoadRig | null = null;
let stopVoice: (() => Promise<void>) | null = null;
let stopAgency: (() => Promise<void>) | null = null;
let supervisor: User;
let owner: User;

beforeAll(() => {
  expect(process.env['FF_AGENCY_DIALER']).toBe(env['FF_AGENCY_DIALER']);
  initLoadDb(16);
  fb.verifyIdToken.mockImplementation(async (token: string) => {
    if (!token.startsWith('tok:')) throw new Error('bad token');
    const uid = token.slice(4);
    return { uid, email: `${uid}@example.test`, email_verified: true };
  });
});

beforeEach(async () => {
  scripts.clear();
  controls.length = 0;
  await resetAgencyRuntimeForTests();
  rig = await startLoadRig();
  rig.carrier.setScript((lead: LeadRequest) => {
    const queue = scripts.get(lead.customer_number);
    const next = queue?.shift();
    return next ? { name: 'held', steps: next.steps } : null;
  });
  await pool().query(`INSERT INTO tenants (id, name, slug) VALUES ($1, 'Listen tenant', 'listen-e2e'), ($2, 'Other tenant', 'listen-e2e-other')`, [TENANT, OTHER_TENANT]);
  await pool().query(`INSERT INTO accounts (id, tenant_id, name, slug) VALUES ($1, $2, 'Main', 'main'), ($3, $2, 'Other', 'other'), ($4, $5, 'Theirs', 'theirs')`,
    [ACCOUNT, TENANT, OTHER_ACCOUNT, OTHER_TENANT_ACCOUNT, OTHER_TENANT]);
  await setFlag('agency_live_listen_enabled', true);
  supervisor = await user('account_admin');
  owner = await user('tenant_owner', { account: null });
  // A row a dead process left open: the boot sweep must close it.
  await pool().query(
    `INSERT INTO agency_listen_sessions (id, tenant_id, account_id, call_id, origin, campaign_id, correlation_id, agent_session_id,
       agent_user_id, listener_user_id, replica_id)
     VALUES ($1, $2, $3, $4, 'manual', NULL, $5, $6, $7, $8, $9)`,
    [ORPHAN_LISTEN, TENANT, ACCOUNT, randomUUID(), randomUUID(), randomUUID(), randomUUID(), supervisor.id, DEAD_REPLICA]);
  const ctx: AppContext = { config, pool: getPool(), redis: getTestRedis() };
  stopVoice = await startVoice(ctx);
  stopAgency = await startAgency(ctx);
});

afterEach(async () => {
  for (const c of controls) c.hangUp = true;
  for (const st of stations.splice(0)) {
    if (st.talker) clearInterval(st.talker);
    if (st.ws.readyState === WebSocket.OPEN) st.ws.close();
  }
  await rig?.carrier.settled().catch(() => undefined);
  if (stopAgency) await stopAgency();
  if (stopVoice) await stopVoice();
  stopAgency = null;
  stopVoice = null;
  await stopLoadRig(rig);
  rig = null;
  await resetAgencyRuntimeForTests();
}, 60_000);

afterAll(async () => { await closeLoadDb(); });

// ─── The suite ──────────────────────────────────────────────────────────────

describe('live call listening, end to end on VoiceLink', () => {
  it('joins mid-call: the list, both legs tagged, then the call ends: ended { call_ended }, the row and the audit pair', async () => {
    const call = await liveCall();

    // The list: one row, masked, listenable, nobody listening yet.
    const list = await http(supervisor, 'GET', '/proxy/agency/live-calls');
    expect(list.statusCode, list.body).toBe(200);
    const rows = list.json().calls as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      call_id: call.callId, origin: 'campaign', correlation_id: call.attemptId, campaign_id: call.campaignId,
      agent_user_id: call.agent.id, agent_session_id: call.station.sessionId, client_kind: 'web',
      customer_name: 'Ada Lovelace', customer_phone_masked: `****${call.national.slice(-4)}`,
      recording: true, listenable: true, not_listenable_reason: null, listeners: [], aht_seconds: null,
    });
    expect(list.body).not.toContain(call.national);
    const byCampaign = await http(supervisor, 'GET', `/proxy/agency/live-calls?campaign_id=${call.campaignId}`);
    expect(byCampaign.json().calls).toHaveLength(1);
    const elsewhere = await http(supervisor, 'GET', `/proxy/agency/live-calls?campaign_id=${randomUUID()}`);
    expect(elsewhere.json().calls).toEqual([]);

    // Join mid-call; then the customer and the agent talk.
    const l = await listen(supervisor, call.callId);
    expect(l.frames[0]).toEqual({ event: 'ready', listen_id: l.listenId, call_id: call.callId, format: 'alaw8', frame_bytes: 160 });
    const open = await listenRow(l.listenId);
    expect(open).toMatchObject({
      ended_at: null, origin: 'campaign', correlation_id: call.attemptId, campaign_id: call.campaignId,
      listener_user_id: supervisor.id, agent_user_id: call.agent.id,
    });
    call.ctl.talk = true;
    talk(call.station);
    await waitFor('both legs heard', () => l.legs.customer >= 20 && l.legs.agent >= 20, 15_000, () => JSON.stringify(l.legs));
    expect(l.legs.odd).toBe(0);
    // The agent still hears the customer: the tap took nothing from the call.
    expect(call.station.heard).toBeGreaterThan(0);

    // The list names the listener.
    const listening = (await http(supervisor, 'GET', '/proxy/agency/live-calls')).json().calls[0];
    expect(listening.listeners).toEqual([expect.objectContaining({ user_id: supervisor.id, name: expect.any(String) })]);

    // A ping is answered.
    l.ws.send(JSON.stringify({ event: 'ping', ts: 7 }));
    await waitFor('pong', () => l.frames.some((f) => f['event'] === 'pong' && f['ts'] === 7));

    // The customer hangs up.
    call.ctl.hangUp = true;
    await waitFor('listener closed', () => l.closed, 20_000);
    expect(l.closed).toEqual({ code: 1000, reason: 'call_ended' });
    expect(l.frames.at(-1)).toEqual({ event: 'ended', reason: 'call_ended' });
    const closed = await closedRow(l.listenId, 'call_ended');
    expect(closed.frames_sent).toBeGreaterThan(0);
    expect(await auditActions(call.callId)).toEqual(['agency_call.listen_started', 'agency_call.listen_ended']);
    // Gone from the list.
    await waitFor('the list empty', async () => (await http(supervisor, 'GET', '/proxy/agency/live-calls')).json().calls.length === 0);

    // The call detail answers who listened (agency.supervise).
    const detail = await http(supervisor, 'GET', `/proxy/agency/campaigns/${call.campaignId}/attempts/${call.attemptId}`);
    expect(detail.statusCode, detail.body).toBe(200);
    expect(detail.json().listen_sessions).toEqual([expect.objectContaining({
      listen_id: l.listenId, listener_user_id: supervisor.id, end_reason: 'call_ended', duration_seconds: expect.any(Number),
      ended_at: expect.any(String), started_at: expect.any(String),
    })]);
    // It names the supervisors who listened: never cached.
    expect(detail.headers['cache-control']).toBe('no-store');
  });

  it('a listener that drops ends `listener_disconnected`; the call carries on, and it can listen again', async () => {
    const call = await liveCall();
    call.ctl.talk = true;
    talk(call.station);
    const l = await listen(supervisor, call.callId);
    await waitFor('agent leg heard', () => l.legs.agent > 5);
    l.ws.terminate();
    await closedRow(l.listenId, 'listener_disconnected');
    const heardBefore = call.station.heard;
    const { rows } = await pool().query('SELECT state FROM agency_call_attempts WHERE id = $1', [call.attemptId]);
    expect(rows[0].state).toBe('bridged');
    expect(rig!.bridge.getSession(call.callId)).toBeDefined();
    // Stop: the supervisor's own stop is `listener_stopped`, 1000.
    const again = await listen(supervisor, call.callId);
    again.ws.send(JSON.stringify({ event: 'stop' }));
    await waitFor('closed', () => again.closed);
    expect(again.closed).toEqual({ code: 1000, reason: 'listener_stopped' });
    await closedRow(again.listenId, 'listener_stopped');
    await waitFor('the agent still hears the customer', () => call.station.heard > heardBefore);
  });

  it('two supervisors listen; a third is refused listen_limit_call; a supervisor\'s second listen supersedes the first', async () => {
    const a = await liveCall();
    const b = await liveCall();
    const second = await user('account_admin');
    const third = await user('account_admin');
    const l1 = await listen(supervisor, a.callId);
    const l2 = await listen(second, a.callId);
    const refused = await http(third, 'POST', `/proxy/agency/live-calls/${a.callId}/listen`);
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ code: 'listen_limit_call' });
    const row = (await http(third, 'GET', '/proxy/agency/live-calls')).json().calls.find((c: { call_id: string }) => c.call_id === a.callId);
    expect(row).toMatchObject({ listenable: false, not_listenable_reason: 'listen_limit_call' });
    // One of the two listening is not refused by the cap: their own listen does not count.
    expect((await http(second, 'GET', '/proxy/agency/live-calls')).json().calls.find((c: { call_id: string }) => c.call_id === a.callId).listenable).toBe(true);

    // The first supervisor moves to call B: their listen on A ends `superseded` (4409).
    const moved = await listen(supervisor, b.callId);
    expect(moved.frames[0]).toMatchObject({ event: 'ready', call_id: b.callId });
    await waitFor('l1 closed', () => l1.closed);
    expect(l1.closed).toEqual({ code: 4409, reason: 'superseded' });
    await closedRow(l1.listenId, 'superseded');
    expect(l2.closed).toBeNull();
    // Now the third may listen to A.
    const l3 = await listen(third, a.callId);
    expect(l3.frames[0]).toMatchObject({ event: 'ready' });
  });

  it('a role change and a member\'s removal through the real routes end the listen `permission_revoked` (4403) at once', async () => {
    // At once: the periodic pass cannot be what ends it within the wait below.
    expect(getAgencyRuntime()!.listen.limits.recheckMs).toBe(300_000);
    const call = await liveCall();
    const target = await user('account_admin');
    const l = await listen(target, call.callId);
    const res = await http(owner, 'PUT', `/users/${target.id}/role`, { role: 'operator' });
    expect(res.statusCode, res.body).toBe(200);
    await waitFor('revoked', () => l.closed, 10_000);
    expect(l.closed).toEqual({ code: 4403, reason: 'permission_revoked' });
    await closedRow(l.listenId, 'permission_revoked');
    expect((await http(target, 'POST', `/proxy/agency/live-calls/${call.callId}/listen`)).statusCode).toBe(403);

    // A member's removal through the real route: the same, at once.
    const removed = await user('account_admin');
    const l2 = await listen(removed, call.callId);
    const del = await http(owner, 'DELETE', `/users/${removed.id}/membership`);
    expect(del.statusCode, del.body).toBe(200);
    await waitFor('removed member revoked', () => l2.closed, 10_000);
    expect(l2.closed).toEqual({ code: 4403, reason: 'permission_revoked' });
    await closedRow(l2.listenId, 'permission_revoked');
  });

  it('LS16 n: a grant whose supervisor is demoted before the upgrade is refused 4403 at the upgrade, with no row', async () => {
    const call = await liveCall();
    const target = await user('account_admin');
    const res = await http(target, 'POST', `/proxy/agency/live-calls/${call.callId}/listen`);
    expect(res.statusCode, res.body).toBe(201);
    const grant = res.json() as { listen_id: string; ws_url: string };
    // Demoted between the grant and the upgrade, through the real route.
    expect((await http(owner, 'PUT', `/users/${target.id}/role`, { role: 'operator' })).statusCode).toBe(200);
    const ws = new WebSocket(`${rig!.origin.replace('http', 'ws')}${grant.ws_url}`);
    const frames: string[] = [];
    ws.on('message', (raw: Buffer, isBinary) => { if (!isBinary) frames.push(raw.toString()); });
    ws.on('error', () => { /* the close follows */ });
    const closed = await new Promise<{ code: number; reason: string }>((resolve) => ws.on('close', (code, reason) => resolve({ code, reason: reason.toString() })));
    expect(closed).toEqual({ code: 4403, reason: 'permission_revoked' });
    expect(frames.some((f) => f.includes('"ready"'))).toBe(false);
    expect(await listenRow(grant.listen_id)).toBeUndefined();
    expect(getAgencyRuntime()!.listen.held().has(grant.listen_id)).toBe(false);
  });

  it('LS4: an unrecorded call is listenable by default; with the flag off the row says why and the grant is 409', async () => {
    const call = await liveCall({ record: false });
    const row = (await http(supervisor, 'GET', '/proxy/agency/live-calls')).json().calls[0];
    expect(row).toMatchObject({ recording: false, listenable: true });
    const l = await listen(supervisor, call.callId);
    expect(l.frames[0]).toMatchObject({ event: 'ready' });
    await setFlag('agency_live_listen_unrecorded', false);
    const off = (await http(supervisor, 'GET', '/proxy/agency/live-calls')).json().calls[0];
    expect(off).toMatchObject({ recording: false, listenable: false, not_listenable_reason: 'listen_recording_off' });
    const other = await user('account_admin');
    const refused = await http(other, 'POST', `/proxy/agency/live-calls/${call.callId}/listen`);
    expect([refused.statusCode, refused.json().code]).toEqual([409, 'listen_recording_off']);
    // The re-check ends the listen already open (the immediate path is the same check).
    expect(await getAgencyRuntime()!.listen.recheck()).toBe(1);
    await closedRow(l.listenId, 'permission_revoked');
  });

  it('the agent on the call cannot listen to it (listen_own_call), even as an account admin', async () => {
    const agentAdmin = await user('account_admin');
    const call = await liveCall({ agent: agentAdmin });
    const row = (await http(agentAdmin, 'GET', '/proxy/agency/live-calls')).json().calls[0];
    expect(row).toMatchObject({ listenable: false, not_listenable_reason: 'listen_own_call' });
    const refused = await http(agentAdmin, 'POST', `/proxy/agency/live-calls/${call.callId}/listen`);
    expect([refused.statusCode, refused.json().code]).toEqual([409, 'listen_own_call']);
  });

  it('another account\'s and another tenant\'s supervisors: absent from their lists, 404 on the number and the grant', async () => {
    const call = await liveCall();
    const otherAccount = await user('account_admin', { account: OTHER_ACCOUNT });
    const otherTenant = await user('account_admin', { account: OTHER_TENANT_ACCOUNT, tenant: OTHER_TENANT });
    await setFlag('agency_live_listen_enabled', true, TENANT, OTHER_ACCOUNT);
    await setFlag('agency_live_listen_enabled', true, OTHER_TENANT, OTHER_TENANT_ACCOUNT);
    const scopes = [
      { who: otherAccount, scope: { account: OTHER_ACCOUNT } },
      { who: otherTenant, scope: { tenant: OTHER_TENANT, account: OTHER_TENANT_ACCOUNT } },
    ];
    for (const { who, scope } of scopes) {
      const list = await http(who, 'GET', '/proxy/agency/live-calls', undefined, scope);
      expect(list.statusCode, list.body).toBe(200);
      expect(list.json().calls).toEqual([]);
      const number = await http(who, 'GET', `/proxy/agency/live-calls/${call.callId}/number`, undefined, scope);
      expect([number.statusCode, number.json().code]).toEqual([404, 'listen_call_not_live']);
      const grant = await http(who, 'POST', `/proxy/agency/live-calls/${call.callId}/listen`, undefined, scope);
      expect([grant.statusCode, grant.json().code]).toEqual([404, 'listen_call_not_live']);
    }
    // The supervisor of the account reveals the full number.
    const number = await http(supervisor, 'GET', `/proxy/agency/live-calls/${call.callId}/number`);
    expect(number.json()).toEqual({ call_id: call.callId, customer_phone: `+91${call.national}` });
  });

  it('agents and operators are refused (403); the flag off refuses everyone (403 feature_disabled)', async () => {
    const call = await liveCall();
    for (const role of ['agent', 'operator']) {
      const who = await user(role);
      for (const res of [
        await http(who, 'GET', '/proxy/agency/live-calls'),
        await http(who, 'GET', `/proxy/agency/live-calls/${call.callId}/number`),
        await http(who, 'POST', `/proxy/agency/live-calls/${call.callId}/listen`),
      ]) expect(res.statusCode, `${role}: ${res.body}`).toBe(403);
    }
    const l = await listen(supervisor, call.callId);
    await setFlag('agency_live_listen_enabled', false);
    for (const res of [
      await http(supervisor, 'GET', '/proxy/agency/live-calls'),
      await http(supervisor, 'POST', `/proxy/agency/live-calls/${call.callId}/listen`),
    ]) expect([res.statusCode, res.json().code]).toEqual([403, 'feature_disabled']);
    // The re-check ends the open listen (LS1).
    await getAgencyRuntime()!.listen.recheck();
    await closedRow(l.listenId, 'permission_revoked');
  });

  it('a soft-phone call is listenable by its own call id, origin `manual`, both legs', async () => {
    const national = `96${String(30_000_000 + ++numberSeq).padStart(8, '0')}`;
    const ctl: CallControl = { talk: false, hangUp: false };
    carrierHolds(national, ctl);
    const campaign = await insertAgencyCampaign({
      tenant_id: TENANT, account_id: ACCOUNT, status: 'paused', record_calls: true, disposition_catalog: JSON.stringify([]),
    });
    const agent = await user('agent');
    const st = await stationFor(null, agent, { softphone: true });
    const placed = await getAgencyRuntime()!.softphone.placeCall(
      { tenantId: TENANT, accountId: ACCOUNT, userId: agent.id, supervise: true },
      { sessionId: st.sessionId, to: `+91${national}`, campaignId: campaign.id as string, callerId: '+919000000001' },
    );
    if (!placed.ok) throw new Error(`placeCall refused: ${placed.refusal.code}`);
    const callId = await waitFor('the manual call bridged', async () => {
      const { rows } = await pool().query<{ webrtc_call_id: string | null; state: string }>(
        'SELECT webrtc_call_id, state FROM agency_manual_calls WHERE id = $1', [placed.call.id]);
      return rows[0]?.state === 'bridged' ? rows[0].webrtc_call_id : null;
    }, 30_000);
    const row = (await http(supervisor, 'GET', '/proxy/agency/live-calls')).json().calls[0];
    expect(row).toMatchObject({ call_id: callId, origin: 'manual', correlation_id: placed.call.id, campaign_id: campaign.id, listenable: true });
    const l = await listen(supervisor, callId!);
    ctl.talk = true;
    talk(st);
    await waitFor('both legs', () => l.legs.customer > 5 && l.legs.agent > 5, 15_000, () => JSON.stringify(l.legs));
    expect(await listenRow(l.listenId)).toMatchObject({ origin: 'manual', correlation_id: placed.call.id });
    ctl.hangUp = true;
    await closedRow(l.listenId, 'call_ended');
    // The soft-phone call detail answers who listened.
    const detail = await http(supervisor, 'GET', `/proxy/agency/softphone/calls/${placed.call.id}`);
    expect(detail.statusCode, detail.body).toBe(200);
    expect(detail.json().listen_sessions).toEqual([expect.objectContaining({ listen_id: l.listenId, end_reason: 'call_ended' })]);
    expect(detail.headers['cache-control']).toBe('no-store');
    // LS16 k: the agent reads their own call, without agency.supervise: no `listen_sessions`.
    const own = await http(agent, 'GET', `/proxy/agency/softphone/calls/${placed.call.id}`);
    expect(own.statusCode, own.body).toBe(200);
    expect(own.json()).not.toHaveProperty('listen_sessions');
  });

  it('a wrap-up redial is a new call: listened to by its own id, the first call\'s listen ended `call_ended`', async () => {
    const call = await liveCall({
      campaign: {
        wrapup_seconds: 120, allow_wrapup_redial: true,
        disposition_catalog: JSON.stringify([{ code: 'interested', label: 'Interested', is_success: true, terminal: true }]),
      },
    });
    // A second contact keeps the campaign running (a redial needs it), never dialled here: the
    // agent stays in wrap-up.
    await insertAgencyContact(call.campaignId, { tenant_id: TENANT, account_id: ACCOUNT, phone_e164: '+919699999999', source_row_number: 2 });
    carrierHolds(call.national, { talk: true, hangUp: false });
    const first = await listen(supervisor, call.callId);
    call.ctl.hangUp = true;
    await closedRow(first.listenId, 'call_ended');
    await waitFor('wrap-up', async () => (await getAgencyRuntime()!.agents.get(call.station.sessionId))?.state === 'wrapup');
    const redial = await callCore({
      method: 'POST', path: `/agency/sessions/${call.station.sessionId}/redial`,
      body: { attempt_id: call.attemptId, agent_user_id: call.agent.id }, tenantId: TENANT, accountId: ACCOUNT,
    });
    expect(redial.status, JSON.stringify(redial.body)).toBeLessThan(300);
    const next = await waitFor('the redial bridged', async () => {
      const { rows } = await pool().query<{ id: string; webrtc_call_id: string | null; state: string }>(
        `SELECT id, webrtc_call_id, state FROM agency_call_attempts WHERE campaign_id = $1 AND id <> $2 ORDER BY created_at DESC LIMIT 1`,
        [call.campaignId, call.attemptId]);
      return rows[0]?.state === 'bridged' && rows[0].webrtc_call_id ? rows[0] : null;
    }, 30_000);
    expect(next.webrtc_call_id).not.toBe(call.callId);
    const row = (await http(supervisor, 'GET', '/proxy/agency/live-calls')).json().calls[0];
    expect(row).toMatchObject({ call_id: next.webrtc_call_id, correlation_id: next.id });
    const second = await listen(supervisor, next.webrtc_call_id!);
    expect(second.frames[0]).toMatchObject({ event: 'ready', call_id: next.webrtc_call_id });
    // The ended call is not live any more: its grant is refused.
    expect((await http(supervisor, 'POST', `/proxy/agency/live-calls/${call.callId}/listen`)).json().code).toBe('listen_call_not_live');
  });

  it('LS15 f: the agent hangs up: the listener is ended `call_ended` and hears nothing of the agent after `ended`', async () => {
    const call = await liveCall();
    call.ctl.talk = true;
    talk(call.station);
    const l = await listen(supervisor, call.callId);
    // Count the agent's frames that arrive after the `ended` frame, in the socket's own order.
    let endedSeen = false;
    let agentAfterEnded = 0;
    l.ws.on('message', (raw: Buffer, isBinary) => {
      if (!isBinary) { if (raw.toString().includes('"ended"')) endedSeen = true; return; }
      if (endedSeen && raw[0] === 2) agentAfterEnded++;
    });
    await waitFor('agent leg heard', () => l.legs.agent > 10, 15_000, () => JSON.stringify(l.legs));
    const hung = await http(call.agent, 'POST', `/proxy/agency/attempts/${call.attemptId}/hangup`, {});
    expect(hung.statusCode, hung.body).toBeLessThan(300);
    await waitFor('listener closed', () => l.closed, 20_000);
    expect(l.closed).toEqual({ code: 1000, reason: 'call_ended' });
    expect(l.frames.at(-1)).toEqual({ event: 'ended', reason: 'call_ended' });
    // The agent keeps talking into the socket while the carrier confirms (`ending`): none of it is heard.
    const heard = l.legs.agent;
    await new Promise((r) => setTimeout(r, 500));
    expect(agentAfterEnded).toBe(0);
    expect(l.legs.agent).toBe(heard);
    await closedRow(l.listenId, 'call_ended');
  });

  it('LS22 c: a grant whose call ended before its upgrade is refused 4404; its row is not "Listened to by"', async () => {
    const call = await liveCall();
    const res = await http(supervisor, 'POST', `/proxy/agency/live-calls/${call.callId}/listen`);
    expect(res.statusCode, res.body).toBe(201);
    const grant = res.json() as { listen_id: string; ws_url: string };
    call.ctl.hangUp = true;
    await waitFor('the call gone from the bridge', () => !rig!.bridge.getSession(call.callId), 20_000);
    const ws = new WebSocket(`${rig!.origin.replace('http', 'ws')}${grant.ws_url}`);
    ws.on('error', () => { /* the close follows */ });
    const closed = await new Promise<{ code: number; reason: string }>((resolve) => ws.on('close', (code, reason) => resolve({ code, reason: reason.toString() })));
    expect(closed).toEqual({ code: 4404, reason: 'listen_call_not_live' });
    // The row was written (no row, no audio) and closed, never live.
    expect(await listenRow(grant.listen_id)).toMatchObject({ end_reason: 'call_ended', live_at: null });
    const detail = await http(supervisor, 'GET', `/proxy/agency/campaigns/${call.campaignId}/attempts/${call.attemptId}`);
    expect(detail.statusCode, detail.body).toBe(200);
    expect(detail.json().listen_sessions).toEqual([]);
  });

  it('LS3: a super-admin\'s session reaches no live-call route', async () => {
    const call = await liveCall();
    // A super-admin session token as its login signs one (`super-admin/login.ts`), for a real admin.
    const adminId = randomUUID();
    await pool().query(
      `INSERT INTO super_admins (id, email, password_hash, name, status) VALUES ($1, $2, 'x', 'Root', 'active')`,
      [adminId, 'root@listen.test']);
    const token = jwt.sign({ sub: adminId, email: 'root@listen.test', type: 'super_admin' }, env['SUPER_ADMIN_JWT_SECRET']!, { expiresIn: '1h' });
    // Its token is no Firebase session: every live-call route refuses it, nothing read, no grant.
    for (const [method, url] of [
      ['GET', '/proxy/agency/live-calls'], ['GET', `/proxy/agency/live-calls/${call.callId}/number`],
      ['POST', `/proxy/agency/live-calls/${call.callId}/listen`],
    ] as const) {
      const r = await rig!.app.inject({ method, url, headers: { authorization: `Bearer ${token}`, 'x-tenant-id': TENANT, 'x-account-id': ACCOUNT } });
      expect(r.statusCode, `${method} ${url}: ${r.body}`).toBe(401);
    }
    const { rows } = await pool().query('SELECT count(*)::int AS n FROM agency_listen_sessions WHERE call_id = $1', [call.callId]);
    expect(rows[0].n).toBe(0);
  });

  it('HTTP closing ends the open listens `server_shutdown`, their rows closed, before the close completes', async () => {
    const call = await liveCall();
    const l = await listen(supervisor, call.callId);
    await rig!.app.close();
    expect(await listenRow(l.listenId)).toMatchObject({ end_reason: 'server_shutdown' });
    await waitFor('the listener closed', () => l.closed);
  });

  it('the boot sweep closed the dead process\'s open row `server_restarted`', async () => {
    const row = await listenRow(ORPHAN_LISTEN);
    expect(row).toMatchObject({ end_reason: 'server_restarted' });
    expect(row?.ended_at).not.toBeNull();
  });

  it('a token is spent once: a replayed grant URL is refused 4401, and a foreign session in the URL too', async () => {
    const call = await liveCall();
    const res = await http(supervisor, 'POST', `/proxy/agency/live-calls/${call.callId}/listen`);
    const grant = res.json() as { ws_url: string };
    const base = rig!.origin.replace('http', 'ws');
    const swapped = grant.ws_url.replace(call.station.sessionId, randomUUID());
    const closeOf = (url: string) => new Promise<{ code: number; reason: string }>((resolve) => {
      const ws = new WebSocket(`${base}${url}`);
      ws.on('error', () => undefined);
      ws.on('close', (code, reason) => resolve({ code, reason: reason.toString() }));
    });
    // The foreign session spends the token too (single use whatever the outcome)…
    expect(await closeOf(swapped)).toEqual({ code: 4401, reason: 'listen_token_invalid' });
    // …so the genuine URL, replayed, is refused as well.
    expect(await closeOf(grant.ws_url)).toEqual({ code: 4401, reason: 'listen_token_invalid' });
    const { rows } = await pool().query('SELECT count(*)::int AS n FROM agency_listen_sessions WHERE call_id = $1', [call.callId]);
    expect(rows[0].n).toBe(0);
  });
});
