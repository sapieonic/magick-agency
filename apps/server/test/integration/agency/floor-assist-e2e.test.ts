import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Floor assist end to end (the Live floor's Phase 3; LF4 Need help, LF5 Talk to agent and Send
 * reminder, LF11 the flag), through the WHOLE server against the mock VoiceLink carrier: the real app
 * on loopback, the voice and agency bootstraps (pacing dials a held call to the agent), real station
 * sockets, the real public routes (Firebase stood in for, every other guard real: the session, the
 * tenant context, RBAC, the flag), a real listener socket, Postgres and Redis.
 *
 * Covered: raising Need help on a call (the call it was raised on), again (idempotent), in wrap-up
 * (no call), refused when not on a call; the floor read's `help` (on, cleared, the flag off); every
 * clearing path with the frames it sends the agent's station and exactly one audit row: a listen
 * going live, a message, the agent's cancel, the session ending, the 15-minute expiry (the raise
 * backdated on the database's clock, the sweep run); messages delivered and stored, `409
 * agent_not_live` with no station or a left session; permission and isolation on every route (a
 * colleague's session, a supervisor's raise for an agent, another account's and another tenant's
 * supervisors, agents and operators sending messages); the flag off on every route.
 */

const env = vi.hoisted(() => {
  const e: Record<string, string> = {
    FF_AGENCY_DIALER: 'true',
    VOICELINK_WEBHOOK_BASE_URL: 'https://agency.test/api/v1/webhooks/voicelink',
    VOICELINK_USERNAME: 'mock-vl-user',
    VOICELINK_PASSWORD: 'mock-vl-password',
    MAX_CONCURRENT_CALLS: '100000',
    RATE_LIMIT_WEBHOOK_MAX: '1000000',
    RATE_LIMIT_CARRIER_MEDIA_MAX: '1000000',
    RATE_LIMIT_STATION_MAX: '1000000',
    RATE_LIMIT_MAX: '1000000',
    RATE_LIMIT_USER_MAX: '1000000',
    AGENCY_LISTEN_RECHECK_MS: '300000',
    LOG_LEVEL: 'error',
  };
  Object.assign(process.env, e);
  return e;
});
const fb = vi.hoisted(() => ({ verifyIdToken: vi.fn() }));
vi.mock('../../../src/auth/firebase.js', () => ({ initFirebase: vi.fn(), verifyIdToken: fb.verifyIdToken }));

import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { getPool } from '@magick-agency/db';
import { getTestPool } from '../../../../../packages/db/test/helpers/test-db.js';
import { getTestRedis } from '../../helpers/test-redis.js';
import { openListener, type ListenClient } from '../../helpers/listen-client.js';
import { config } from '../../../src/config/index.js';
import type { AppContext } from '../../../src/app-context.js';
import { getAgencyRuntime, resetAgencyRuntimeForTests, startAgency } from '../../../src/bootstrap/agency.js';
import { startVoice } from '../../../src/bootstrap/voice.js';
import { getFeatureFlagService } from '../../../src/feature-flags/index.js';
import { platformAuditLogger } from '../../../src/audit/platform/audit-logger.js';
import { agencyAgentSessionRepository } from '../../../src/db/repositories/agency.repository.js';
import { AGENT_LEASE_MS } from '../../../src/agency/agent-state-machine.js';
import { insertAgencyCampaign, insertAgencyContact } from './agency-factories.js';
import { carrierScripts, type CallStep, type LeadRequest } from '../../mocks/voicelink/index.js';
import {
  LOAD_ACCOUNT as ACCOUNT, LOAD_TENANT as TENANT, closeLoadDb, initLoadDb, startLoadRig, stopLoadRig, waitFor, type LoadRig,
} from '../load/voicelink-load-harness.js';

const OTHER_ACCOUNT = '6c1d0c8e-3d0e-4c7a-8b44-1f6b0a0000b2';
const OTHER_TENANT = '6c1d0c8e-3d0e-4c7a-8b44-1f6b0a0000c1';
const OTHER_TENANT_ACCOUNT = '6c1d0c8e-3d0e-4c7a-8b44-1f6b0a0000c2';
const FLAG = 'agency_floor_assist_enabled';

const pool = () => getTestPool();

// ─── The world ──────────────────────────────────────────────────────────────

interface User { id: string; uid: string; name: string }

async function user(role: string, opts: { account?: string | null; tenant?: string } = {}): Promise<User> {
  const id = randomUUID();
  const uid = `fb-${role}-${id.slice(0, 8)}`;
  const name = `${role} ${id.slice(0, 4)}`;
  await pool().query('INSERT INTO users (id, firebase_uid, email, display_name) VALUES ($1, $2, $3, $4)', [id, uid, `${uid}@example.test`, name]);
  await pool().query('INSERT INTO memberships (user_id, tenant_id, account_id, role) VALUES ($1, $2, $3, $4)',
    [id, opts.tenant ?? TENANT, opts.account === undefined ? ACCOUNT : opts.account, role]);
  return { id, uid, name };
}

async function setFlag(key: string, on: boolean, tenant = TENANT, account = ACCOUNT): Promise<void> {
  await pool().query('DELETE FROM feature_flag_overrides WHERE flag_key = $1 AND tenant_id = $2 AND account_id = $3', [key, tenant, account]);
  await pool().query(
    `INSERT INTO feature_flag_overrides (flag_key, scope_type, tenant_id, account_id, value) VALUES ($1, 'account', $2, $3, $4::jsonb)`,
    [key, tenant, account, on ? 'true' : 'false']);
  await getFeatureFlagService().invalidate({ tenantId: tenant });
}

function http(who: User, method: 'GET' | 'POST' | 'DELETE', url: string, body?: unknown, scope: { tenant?: string; account?: string } = {}) {
  return rig!.app.inject({
    method, url,
    headers: {
      authorization: `Bearer tok:${who.uid}`, 'x-tenant-id': scope.tenant ?? TENANT, 'x-account-id': scope.account ?? ACCOUNT,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
  });
}

interface CallControl { hangUp: boolean }
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
    { do: 'waitFor', until: () => ctl.hangUp, timeoutMs: 60_000, what: 'the test to hang the customer up' },
    { do: 'webhooks', specs: [carrierScripts.webhooks.endedAnswered(answeredAt, 3)] },
    { do: 'close', code: 1000 },
  ];
}

interface Station { sessionId: string; ws: WebSocket; frames: Array<Record<string, unknown>> }
const stations: Station[] = [];

/** An agent joins `campaignId` on a real station socket (`web`, so it can receive the floor assist frames) and goes available. */
async function stationFor(campaignId: string, agent: User): Promise<Station> {
  const runtime = getAgencyRuntime()!;
  const join = await agencyAgentSessionRepository.joinOrRehydrate({
    tenantId: TENANT, accountId: ACCOUNT, campaignId, agentUserId: agent.id, replicaId: runtime.replicaId,
  });
  if (!join.ok) throw new Error('join refused');
  const { token } = await runtime.tokens.mint(join.session.id);
  const port = new URL(rig!.origin).port;
  const st: Station = {
    sessionId: join.session.id, frames: [],
    ws: new WebSocket(`ws://127.0.0.1:${port}/proxy/agency/station/${join.session.id}?token=${token}&media=alaw8`),
  };
  st.ws.on('message', (raw, isBinary) => { if (!isBinary) st.frames.push(JSON.parse(raw.toString()) as Record<string, unknown>); });
  stations.push(st);
  await waitFor('station ready', () => st.frames.some((f) => f['event'] === 'ready'));
  runtime.wrapup.cancel(st.sessionId, 'agent_returned');
  await runtime.agents.set(st.sessionId, 'available', { leaseMs: AGENT_LEASE_MS.available });
  await agencyAgentSessionRepository.setState(st.sessionId, 'available');
  return st;
}

const NO_RETRY = Object.fromEntries(
  ['no_answer', 'busy', 'failed', 'abandoned', 'agent_disconnected', 'orphaned', 'canceled'].map((o) => [o, { max_attempts: 0 }]),
);

interface Live { campaignId: string; callId: string; agent: User; station: Station; ctl: CallControl }

let numberSeq = 0;
/** A running campaign with one contact the carrier answers and holds; its agent bridged to it. */
async function liveCall(opts: { campaign?: Record<string, unknown> } = {}): Promise<Live> {
  const national = `97${String(30_000_000 + ++numberSeq).padStart(8, '0')}`;
  const ctl: CallControl = { hangUp: false };
  controls.push(ctl);
  scripts.set(national, [{ steps: heldCall(ctl) }]);
  const campaign = await insertAgencyCampaign({
    tenant_id: TENANT, account_id: ACCOUNT, status: 'running', wrapup_seconds: 0, record_calls: true,
    disposition_catalog: JSON.stringify([]), retry_policy: JSON.stringify(NO_RETRY), ...opts.campaign,
  });
  await insertAgencyContact(campaign.id as string, {
    tenant_id: TENANT, account_id: ACCOUNT, phone_e164: `+91${national}`, source_row_number: 1, context: JSON.stringify({ name: 'Ada Lovelace' }),
  });
  const agent = await user('agent');
  const station = await stationFor(campaign.id as string, agent);
  const attempt = await waitFor('the attempt bridged', async () => {
    const { rows } = await pool().query<{ webrtc_call_id: string | null; state: string }>(
      'SELECT webrtc_call_id, state FROM agency_call_attempts WHERE campaign_id = $1 ORDER BY created_at DESC LIMIT 1', [campaign.id]);
    return rows[0]?.state === 'bridged' && rows[0].webrtc_call_id ? rows[0] : null;
  }, 30_000);
  await waitFor('the agent on the call', async () => (await getAgencyRuntime()!.agents.get(station.sessionId))?.state === 'on_call');
  return { campaignId: campaign.id as string, callId: attempt.webrtc_call_id!, agent, station, ctl };
}

/** The customer hangs up: the agent is released into wrap-up (the campaign has no timer). */
async function hangUp(call: Live): Promise<void> {
  call.ctl.hangUp = true;
  await waitFor('released', () => call.station.frames.some((f) => f['event'] === 'released'), 15_000,
    () => JSON.stringify(call.station.frames.map((f) => f['event'])));
  await waitFor('the agent in wrap-up', async () => (await getAgencyRuntime()!.agents.get(call.station.sessionId))?.state === 'wrapup', 5_000,
    async () => JSON.stringify(await getAgencyRuntime()!.agents.get(call.station.sessionId)));
}

const helpFrames = (st: Station) => st.frames.filter((f) => ['help_answered', 'help_cleared', 'supervisor_message'].includes(f['event'] as string));

async function auditActions(sessionId: string): Promise<string[]> {
  await platformAuditLogger.flush();
  const { rows } = await pool().query<{ action: string }>(
    `SELECT action FROM platform_audit_log
      WHERE resource_type = 'agency_session' AND resource_id = $1 AND (action LIKE 'agency_session.help%' OR action = 'agency_session.message_sent')
      ORDER BY action`, [sessionId]);
  // Sorted: one flush writes a batch with one timestamp, so the order of the rows is not the point; their count is.
  return rows.map((r) => r.action);
}

async function floorHelp(who: User, sessionId: string): Promise<unknown> {
  const res = await http(who, 'GET', `/proxy/agency/floor?from=${encodeURIComponent(new Date(Date.now() - 3_600_000).toISOString())}`);
  expect(res.statusCode, res.body).toBe(200);
  const row = (res.json().agents as Array<{ session_id: string | null; help: unknown }>).find((a) => a.session_id === sessionId);
  expect(row, 'the agent is on the floor').toBeDefined();
  return row!.help;
}

async function listen(who: User, callId: string): Promise<ListenClient> {
  const res = await http(who, 'POST', `/proxy/agency/live-calls/${callId}/listen`);
  expect(res.statusCode, res.body).toBe(201);
  const l = openListener(rig!.origin, res.json() as { listen_id: string; ws_url: string });
  await waitFor('listener ready', () => l.frames.some((f) => f['event'] === 'ready') || l.closed, 10_000);
  listeners.push(l);
  return l;
}
const listeners: ListenClient[] = [];

// ─── Lifecycle ──────────────────────────────────────────────────────────────

let rig: LoadRig | null = null;
let stopVoice: (() => Promise<void>) | null = null;
let stopAgency: (() => Promise<void>) | null = null;
let supervisor: User;

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
    const next = scripts.get(lead.customer_number)?.shift();
    return next ? { name: 'held', steps: next.steps } : null;
  });
  await pool().query(`INSERT INTO tenants (id, name, slug) VALUES ($1, 'Assist tenant', 'assist-e2e'), ($2, 'Other tenant', 'assist-e2e-other')`, [TENANT, OTHER_TENANT]);
  await pool().query(`INSERT INTO accounts (id, tenant_id, name, slug) VALUES ($1, $2, 'Main', 'main'), ($3, $2, 'Other', 'other'), ($4, $5, 'Theirs', 'theirs')`,
    [ACCOUNT, TENANT, OTHER_ACCOUNT, OTHER_TENANT_ACCOUNT, OTHER_TENANT]);
  await setFlag(FLAG, true);
  await setFlag('agency_live_listen_enabled', true);
  supervisor = await user('account_admin');
  const ctx: AppContext = { config, pool: getPool(), redis: getTestRedis() };
  stopVoice = await startVoice(ctx);
  stopAgency = await startAgency(ctx);
});

afterEach(async () => {
  for (const c of controls) c.hangUp = true;
  for (const l of listeners.splice(0)) if (l.ws.readyState === WebSocket.OPEN) l.ws.close();
  for (const st of stations.splice(0)) if (st.ws.readyState === WebSocket.OPEN) st.ws.close();
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

describe('Need help, end to end', () => {
  it('raised on a call (with the call), again (idempotent), on the floor; a listen going live answers it: help_answered then help_cleared, once', async () => {
    const call = await liveCall();
    const sid = call.station.sessionId;
    const first = await http(call.agent, 'POST', `/proxy/agency/sessions/${sid}/help`);
    expect(first.statusCode, first.body).toBe(200);
    const help = first.json().help as { raised_at: string; call_id: string };
    expect(first.json()).toEqual({ session_id: sid, help: { raised_at: expect.any(String), call_id: call.callId } });
    const again = await http(call.agent, 'POST', `/proxy/agency/sessions/${sid}/help`);
    expect(again.json()).toEqual(first.json());
    expect(await floorHelp(supervisor, sid)).toEqual(help);

    await listen(supervisor, call.callId);
    await waitFor('help cleared on the station', () => helpFrames(call.station).length >= 2);
    expect(helpFrames(call.station)).toEqual([
      { event: 'help_answered', raised_at: help.raised_at, by_name: supervisor.name, how: 'listen' },
      { event: 'help_cleared', raised_at: help.raised_at, reason: 'answered' },
    ]);
    expect(await floorHelp(supervisor, sid)).toBeNull();
    expect(await auditActions(sid)).toEqual(['agency_session.help_answered', 'agency_session.help_raised']);
    const { rows } = await pool().query('SELECT help_answered_by FROM agency_agent_sessions WHERE id = $1', [sid]);
    expect(rows[0]).toEqual({ help_answered_by: supervisor.id });
  });

  it('a message answers it: supervisor_message, help_answered (message), help_cleared; the message stored delivered, one audit row each', async () => {
    const call = await liveCall();
    const sid = call.station.sessionId;
    const help = (await http(call.agent, 'POST', `/proxy/agency/sessions/${sid}/help`)).json().help as { raised_at: string };
    const res = await http(supervisor, 'POST', `/proxy/agency/sessions/${sid}/messages`, { text: '  Offer the 3-month plan, the waiver is approved.  ' });
    expect(res.statusCode, res.body).toBe(201);
    const sent = res.json() as { id: string; sent_at: string };
    expect(res.json()).toEqual({ id: expect.any(String), session_id: sid, sent_at: expect.any(String), delivered: true });
    await waitFor('the three frames', () => helpFrames(call.station).length >= 3);
    expect(helpFrames(call.station)).toEqual([
      { event: 'supervisor_message', id: sent.id, text: 'Offer the 3-month plan, the waiver is approved.', from_name: supervisor.name, sent_at: sent.sent_at },
      { event: 'help_answered', raised_at: help.raised_at, by_name: supervisor.name, how: 'message' },
      { event: 'help_cleared', raised_at: help.raised_at, reason: 'answered' },
    ]);
    const { rows } = await pool().query('SELECT session_id, agent_user_id, sender_user_id, text, delivered FROM agency_supervisor_messages WHERE id = $1', [sent.id]);
    expect(rows).toEqual([{ session_id: sid, agent_user_id: call.agent.id, sender_user_id: supervisor.id, text: 'Offer the 3-month plan, the waiver is approved.', delivered: true }]);
    expect(await auditActions(sid)).toEqual(['agency_session.help_answered', 'agency_session.help_raised', 'agency_session.message_sent']);
    // A second message (Send reminder) with nothing open: delivered, no help frames.
    const reminder = await http(supervisor, 'POST', `/proxy/agency/sessions/${sid}/messages`, { text: 'Wrap up this call' });
    expect(reminder.statusCode).toBe(201);
    await waitFor('the reminder', () => helpFrames(call.station).length >= 4);
    expect(helpFrames(call.station).map((f) => f['event'])).toEqual(['supervisor_message', 'help_answered', 'help_cleared', 'supervisor_message']);
  });

  it('the agent cancels: help_cleared cancelled, once; a second cancel changes nothing', async () => {
    const call = await liveCall();
    const sid = call.station.sessionId;
    const help = (await http(call.agent, 'POST', `/proxy/agency/sessions/${sid}/help`)).json().help as { raised_at: string };
    const res = await http(call.agent, 'DELETE', `/proxy/agency/sessions/${sid}/help`);
    expect([res.statusCode, res.json()]).toEqual([200, { session_id: sid, help: null }]);
    await waitFor('cleared', () => helpFrames(call.station).length >= 1);
    expect(helpFrames(call.station)).toEqual([{ event: 'help_cleared', raised_at: help.raised_at, reason: 'cancelled' }]);
    expect((await http(call.agent, 'DELETE', `/proxy/agency/sessions/${sid}/help`)).statusCode).toBe(200);
    expect(await floorHelp(supervisor, sid)).toBeNull();
    expect(await auditActions(sid)).toEqual(['agency_session.help_cancelled', 'agency_session.help_raised']);
    expect(helpFrames(call.station)).toHaveLength(1);
  });

  it('raised in wrap-up (no call); the session ending clears it: help_cleared session_ended, once', async () => {
    // A minute's wrap-up after the call: the agent is in it when they ask.
    const call = await liveCall({ campaign: { wrapup_seconds: 60 } });
    const sid = call.station.sessionId;
    await hangUp(call);
    const raised = await http(call.agent, 'POST', `/proxy/agency/sessions/${sid}/help`);
    expect(raised.statusCode, raised.body).toBe(200);
    expect(raised.json().help).toEqual({ raised_at: expect.any(String), call_id: null });
    const left = await http(call.agent, 'POST', `/proxy/agency/sessions/${sid}/leave`);
    expect(left.statusCode, left.body).toBe(200);
    await waitFor('cleared', () => helpFrames(call.station).length >= 1);
    expect(helpFrames(call.station)).toEqual([{ event: 'help_cleared', raised_at: raised.json().help.raised_at, reason: 'session_ended' }]);
    expect(await auditActions(sid)).toEqual(['agency_session.help_raised', 'agency_session.help_session_ended']);
    const { rows } = await pool().query('SELECT help_raised_at, left_at IS NOT NULL AS left FROM agency_agent_sessions WHERE id = $1', [sid]);
    expect(rows[0]).toEqual({ help_raised_at: null, left: true });
  });

  it('15 minutes unanswered (the raise backdated on the database clock): the floor drops it at once; the sweep sends help_cleared expired and audits it, once', async () => {
    const call = await liveCall();
    const sid = call.station.sessionId;
    await http(call.agent, 'POST', `/proxy/agency/sessions/${sid}/help`);
    const { rows } = await pool().query<{ help_raised_at: Date }>(
      `UPDATE agency_agent_sessions SET help_raised_at = now() - interval '15 minutes 1 second' WHERE id = $1 RETURNING help_raised_at`, [sid]);
    expect(await floorHelp(supervisor, sid)).toBeNull();
    expect(await getAgencyRuntime()!.floorAssist.sweep()).toBe(1);
    await waitFor('expired', () => helpFrames(call.station).length >= 1);
    expect(helpFrames(call.station)).toEqual([{ event: 'help_cleared', raised_at: rows[0]!.help_raised_at.toISOString(), reason: 'expired' }]);
    expect(await getAgencyRuntime()!.floorAssist.sweep()).toBe(0);
    // A listen now answers nothing.
    await listen(supervisor, call.callId);
    expect(await auditActions(sid)).toEqual(['agency_session.help_expired', 'agency_session.help_raised']);
    expect(helpFrames(call.station)).toHaveLength(1);
  });

  it('refused when not on a call or in wrap-up (409 help_not_on_call); nothing written', async () => {
    const campaign = await insertAgencyCampaign({ tenant_id: TENANT, account_id: ACCOUNT, status: 'running', disposition_catalog: JSON.stringify([]) });
    const agent = await user('agent');
    const st = await stationFor(campaign.id as string, agent);
    const res = await http(agent, 'POST', `/proxy/agency/sessions/${st.sessionId}/help`);
    expect([res.statusCode, res.json().code]).toEqual([409, 'help_not_on_call']);
    expect(await auditActions(st.sessionId)).toEqual([]);
  });

  it('only on the caller\'s own session: a colleague and the supervisor get the uniform 404 on raise and cancel; nothing written', async () => {
    const call = await liveCall();
    const sid = call.station.sessionId;
    const colleague = await user('agent');
    for (const who of [colleague, supervisor]) {
      for (const method of ['POST', 'DELETE'] as const) {
        const res = await http(who, method, `/proxy/agency/sessions/${sid}/help`);
        expect([res.statusCode, res.json()], `${who.name} ${method}`).toEqual([404, { error: 'Not Found', message: 'Session not found' }]);
      }
    }
    // Another account's agent, and a malformed id, the same.
    const elsewhere = await user('agent', { account: OTHER_ACCOUNT });
    await setFlag(FLAG, true, TENANT, OTHER_ACCOUNT);
    expect((await http(elsewhere, 'POST', `/proxy/agency/sessions/${sid}/help`, undefined, { account: OTHER_ACCOUNT })).statusCode).toBe(404);
    expect((await http(call.agent, 'POST', '/proxy/agency/sessions/not-a-uuid/help')).statusCode).toBe(404);
    expect(await auditActions(sid)).toEqual([]);
  });
});

describe('messages, end to end', () => {
  it('agents and operators are refused (403); another account\'s and another tenant\'s supervisors get the uniform 404; nothing stored or sent', async () => {
    const call = await liveCall();
    const sid = call.station.sessionId;
    for (const role of ['agent', 'operator']) {
      const who = await user(role);
      const res = await http(who, 'POST', `/proxy/agency/sessions/${sid}/messages`, { text: 'hello' });
      expect(res.statusCode, `${role}: ${res.body}`).toBe(403);
    }
    // The agent on the call cannot message their own station either.
    expect((await http(call.agent, 'POST', `/proxy/agency/sessions/${sid}/messages`, { text: 'hello' })).statusCode).toBe(403);
    const otherAccount = await user('account_admin', { account: OTHER_ACCOUNT });
    const otherTenant = await user('account_admin', { account: OTHER_TENANT_ACCOUNT, tenant: OTHER_TENANT });
    await setFlag(FLAG, true, TENANT, OTHER_ACCOUNT);
    await setFlag(FLAG, true, OTHER_TENANT, OTHER_TENANT_ACCOUNT);
    for (const { who, scope } of [
      { who: otherAccount, scope: { account: OTHER_ACCOUNT } },
      { who: otherTenant, scope: { tenant: OTHER_TENANT, account: OTHER_TENANT_ACCOUNT } },
    ]) {
      const res = await http(who, 'POST', `/proxy/agency/sessions/${sid}/messages`, { text: 'hello' }, scope);
      expect([res.statusCode, res.json()]).toEqual([404, { error: 'Not Found', message: 'Session not found' }]);
    }
    const stored = await pool().query('SELECT count(*)::int AS n FROM agency_supervisor_messages');
    expect(stored.rows[0]).toEqual({ n: 0 });
    expect(helpFrames(call.station)).toEqual([]);
    expect(await auditActions(sid)).toEqual([]);
  });

  it('400 message_invalid on an empty or too long text', async () => {
    const call = await liveCall();
    for (const text of ['   ', 'x'.repeat(501)]) {
      const res = await http(supervisor, 'POST', `/proxy/agency/sessions/${call.station.sessionId}/messages`, { text });
      expect([res.statusCode, res.json().code]).toEqual([400, 'message_invalid']);
    }
  });

  it('409 agent_not_live with no station attached, and on a session that has left; nothing stored', async () => {
    const campaign = await insertAgencyCampaign({ tenant_id: TENANT, account_id: ACCOUNT, status: 'running', disposition_catalog: JSON.stringify([]) });
    const agent = await user('agent');
    const st = await stationFor(campaign.id as string, agent);
    st.ws.close();
    await waitFor('the station detached', () => !getAgencyRuntime()!.stations.canReceiveFloorAssist(st.sessionId));
    const res = await http(supervisor, 'POST', `/proxy/agency/sessions/${st.sessionId}/messages`, { text: 'Your Tea break is over, please come back' });
    expect([res.statusCode, res.json()]).toEqual([409, {
      error: 'Conflict', code: 'agent_not_live',
      message: 'This agent is not connected to their station, so the message could not be shown. Try again when they are back.',
    }]);
    await pool().query(`UPDATE agency_agent_sessions SET left_at = now(), state = 'offline' WHERE id = $1`, [st.sessionId]);
    const left = await http(supervisor, 'POST', `/proxy/agency/sessions/${st.sessionId}/messages`, { text: 'hello' });
    expect([left.statusCode, left.json().code]).toEqual([409, 'agent_not_live']);
    expect((await pool().query('SELECT count(*)::int AS n FROM agency_supervisor_messages')).rows[0]).toEqual({ n: 0 });
  });
});

describe('the flag off (LF11)', () => {
  it('refuses Need help and messages with 403 floor_assist_disabled, and the floor carries no help, though one is open', async () => {
    const call = await liveCall();
    const sid = call.station.sessionId;
    const help = (await http(call.agent, 'POST', `/proxy/agency/sessions/${sid}/help`)).json().help;
    expect(await floorHelp(supervisor, sid)).toEqual(help);
    await setFlag(FLAG, false);
    for (const res of [
      await http(call.agent, 'POST', `/proxy/agency/sessions/${sid}/help`),
      await http(call.agent, 'DELETE', `/proxy/agency/sessions/${sid}/help`),
      await http(supervisor, 'POST', `/proxy/agency/sessions/${sid}/messages`, { text: 'hello' }),
    ]) {
      expect([res.statusCode, res.json().code], res.body).toEqual([403, 'floor_assist_disabled']);
    }
    expect(await floorHelp(supervisor, sid)).toBeNull();
    expect(await auditActions(sid)).toEqual(['agency_session.help_raised']);
    expect(helpFrames(call.station)).toEqual([]);
  });
});
