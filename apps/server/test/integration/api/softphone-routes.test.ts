import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * The soft phone's HTTP API end to end (docs/softphone.md §6): the REAL app on loopback
 * (`buildApp` with a real context, real station WebSocket upgrades), the real session →
 * tenant-context → RBAC chain (Firebase's token check is the one stub), the public
 * `proxy-agency-softphone` routes, `callCore`, the internal handlers, `runtime.softphone`,
 * the bridge and guard host over real Redis 6383 and Postgres 5436. Only the carrier is
 * faked, as in `softphone-runtime-e2e.test.ts`.
 *
 * What it pins, each through HTTP:
 *  1. a tagged call: open the soft-phone session → station token → place → answer → hang
 *     up → outcome → list / detail (with names) → the audit rows, actor and campaign;
 *  2. an agent cannot read another agent's call; a supervisor can (on behalf);
 *  3. DNC: 409 `dnc_listed` with the entry, then placed with an override note, audited
 *     with the note and the entry id;
 *  4. the switch from a campaign session: queued behind wrap-up, applied, return refused
 *     while a call is unsettled, return; the audit rows and the campaign's activity trail;
 *  5. cancel of a queued switch through `break/cancel`;
 *  6. `PUT /settings`: RBAC, `settings_invalid` paths, a valid write audited;
 *  7. tenant and account isolation: another tenant's / account's call id is a 404;
 *  8. the recording route's gates; the flag (`softphone_disabled`).
 */

const mocks = vi.hoisted(() => {
  process.env['SUPER_ADMIN_JWT_SECRET'] = 'softphone-routes-secret-0123456789';
  process.env['FF_AGENCY_DIALER'] = 'true';
  process.env['FF_AGENCY_SOFTPHONE'] = 'true';
  process.env['MAX_CONCURRENT_CALLS'] = '20';
  process.env['VOICELINK_WEBHOOK_BASE_URL'] = 'https://agency.test/api/v1/webhooks/voicelink';
  return {
    verifyIdToken: vi.fn(),
    fakeAdapter: {
      name: 'voicelink',
      capabilities: { cancelRinging: false, queuesOutboundDials: true },
      initiateCall: vi.fn(async (req: { callId: string }) => ({ providerCallId: `carrier-${req.callId}` })),
      endCall: vi.fn(async () => undefined),
    },
  };
});

vi.mock('../../../src/auth/firebase.js', () => ({
  initFirebase: vi.fn(),
  verifyIdToken: mocks.verifyIdToken,
}));
vi.mock('../../../src/telephony/factory.js', () => ({
  TelephonyProviderRegistry: class {
    get() { return mocks.fakeAdapter; }
  },
}));

import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import type { FastifyInstance } from 'fastify';
import { closePool, getPool, initDbPool } from '@magick-agency/db';
import { TEST_DB_URL, closeTestPool, getTestPool, truncateAll } from '../../../../../packages/db/test/helpers/test-db.js';
import {
  insertAccount,
  insertMembership,
  insertPhoneAssignment,
  insertPhoneNumber,
  insertTelephonyProvider,
  insertTenant,
  insertUser,
} from '../../../../../packages/db/test/integration/setup/platform-factories.js';
import { closeTestRedis, flushTestRedis, getTestRedis } from '../../helpers/test-redis.js';
import { insertAgencyCampaign, insertAgencyContact } from '../agency/agency-factories.js';
import { config } from '../../../src/config/index.js';
import { buildApp } from '../../../src/app.js';
import type { AppContext } from '../../../src/app-context.js';
import { getAgencyRuntime, resetAgencyRuntimeForTests, startAgency } from '../../../src/bootstrap/agency.js';
import { getVoiceEngine, resetVoiceEngineForTests, startVoice } from '../../../src/bootstrap/voice.js';
import { platformAuditLogger } from '../../../src/audit/platform/audit-logger.js';
import { AGENT_LEASE_MS } from '../../../src/agency/agent-state-machine.js';
import type { AgencyRuntime } from '../../../src/agency/runtime.js';

const CATALOG = JSON.stringify([
  { code: 'interested', label: 'Interested', is_success: true, terminal: true },
  { code: 'call_back', label: 'Call back', requires_datetime: true },
]);

class FakePstnSocket extends EventEmitter {
  readyState = 1;
  OPEN = 1;
  send(): void { /* media */ }
  close(): void { this.readyState = 3; this.emit('close'); }
}

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
interface Station { ws: WebSocket; frames: Array<Record<string, any>> }

describe('soft-phone HTTP routes — real app, real runtime, fake carrier (integration)', () => {
  let app: FastifyInstance;
  let port = 0;
  let stopAgency: (() => Promise<void>) | null = null;
  let stopVoice: (() => Promise<void>) | null = null;
  let runtime: AgencyRuntime;
  let ctx: AppContext;
  const sockets: WebSocket[] = [];

  let tenant: string;
  let account: string;
  let sibling: string;
  let dark: string;
  let otherTenant: string;
  let otherAccount: string;
  let supervisor: Who;
  let darkAgent: Who;
  let siblingSupervisor: Who;
  let foreignSupervisor: Who;
  let accountNumber: string;

  async function user(t: string, a: string, role: string): Promise<Who> {
    const u = await insertUser();
    await insertMembership({ user_id: u.id, tenant_id: t, account_id: a, role });
    return { id: u.id as string, tok: `tok:${u.firebase_uid as string}` };
  }

  function headers(who: Who, acct = account, t = tenant): Record<string, string> {
    return { authorization: `Bearer ${who.tok}`, 'x-tenant-id': t, 'x-account-id': acct, 'content-type': 'application/json' };
  }
  const post = (url: string, who: Who, body: unknown = {}, acct?: string, t?: string) =>
    app.inject({ method: 'POST', url, headers: headers(who, acct, t), payload: JSON.stringify(body) });
  const patch = (url: string, who: Who, body: unknown) =>
    app.inject({ method: 'PATCH', url, headers: headers(who), payload: JSON.stringify(body) });
  const put = (url: string, who: Who, body: unknown) =>
    app.inject({ method: 'PUT', url, headers: headers(who), payload: JSON.stringify(body) });
  const get = (url: string, who: Who, acct?: string, t?: string) => {
    const { 'content-type': _ct, ...h } = headers(who, acct, t);
    return app.inject({ method: 'GET', url, headers: h });
  };

  async function staff(campaignId: string, userId: string) {
    await getTestPool().query(
      `INSERT INTO agency_campaign_agents (id, tenant_id, account_id, campaign_id, user_id, assigned_by, assigned_at)
       VALUES ($1, $2, $3, $4, $5, $5, now())`,
      [randomUUID(), tenant, account, campaignId, userId],
    );
  }

  async function connect(stationWsUrl: string): Promise<Station> {
    const frames: Array<Record<string, any>> = [];
    const ws = new WebSocket(`ws://127.0.0.1:${port}${stationWsUrl}`);
    sockets.push(ws);
    ws.on('message', (raw) => { try { frames.push(JSON.parse(raw.toString())); } catch { /* media */ } });
    await waitFor('ready', () => frames.find((f) => f['event'] === 'ready'));
    return { ws, frames };
  }

  /** Open the agent's soft-phone session over HTTP and connect its station. */
  async function openSoftphone(who: Who): Promise<{ sessionId: string; station: Station }> {
    const res = await post('/proxy/agency/softphone/sessions', who);
    expect(res.statusCode, res.body).toBe(201);
    const body = res.json();
    expect(body.station_ws_url).toMatch(new RegExp(`^/proxy/agency/station/${body.session_id}\\?token=`));
    return { sessionId: body.session_id, station: await connect(body.station_ws_url) };
  }

  const lastCall = (s: Station) => [...s.frames].reverse().find((f) => f['event'] === 'manual_call')?.['call'];

  async function legOf(manualCallId: string): Promise<string> {
    return waitFor('media leg', async () => {
      const { rows } = await getTestPool().query<{ webrtc_call_id: string | null }>(
        'SELECT webrtc_call_id FROM agency_manual_calls WHERE id = $1', [manualCallId]);
      return rows[0]?.webrtc_call_id ?? null;
    });
  }
  function answer(callId: string): void {
    const pstn = new FakePstnSocket();
    expect(getVoiceEngine()!.bridge.attachPstnLeg(callId, pstn as never)).toBe(true);
    pstn.emit('message', JSON.stringify({
      event: 'start',
      start: { call_sid: `carrier-${callId}`, stream_sid: 's1', media_format: { encoding: 'audio/alaw', sample_rate: '8000' } },
    }));
  }
  async function carrierEnded(callId: string): Promise<void> {
    await getVoiceEngine()!.bridge.handleVoicelinkStatus(callId, {
      providerCallId: `carrier-${callId}`, callId, eventType: 'hangup', timestamp: new Date(),
      metadata: { event: 'call.ended', call: { id: `carrier-${callId}`, status: 'ended' } },
    } as never);
  }
  function ringOut(callId: string): void {
    const pstn = new FakePstnSocket();
    getVoiceEngine()!.bridge.attachPstnLeg(callId, pstn as never);
    pstn.emit('message', JSON.stringify({
      event: 'stop', sequenceNumber: '2', streamSid: 's1',
      stop: { accountSid: '1', call_sid: `carrier-${callId}`, outboundQueueId: 1 },
    }));
  }
  async function manualRow(id: string) {
    const { rows } = await getTestPool().query('SELECT * FROM agency_manual_calls WHERE id = $1', [id]);
    return rows[0];
  }

  /** The station socket's own close, awaited. */
  async function drop(station: Station): Promise<void> {
    if (station.ws.readyState === WebSocket.CLOSED) return;
    const closed = new Promise<void>((resolve) => station.ws.once('close', () => resolve()));
    station.ws.close();
    await closed;
  }

  /** The agent's Redis lease, as `AgentStateMachine` keys it. */
  const leaseKey = (sessionId: string) => `${config.redis.keyPrefix}agency:agent:${sessionId}:state`;

  async function sessionRow(id: string) {
    const { rows } = await getTestPool().query('SELECT state, break_reason FROM agency_agent_sessions WHERE id = $1', [id]);
    return rows[0];
  }

  /**
   * A campaign session switched to the soft phone, holding a bridged-then-hung-up call that
   * owes its outcome (docs/softphone.md §4.1 steps 6–7): the state finding 1 is about.
   */
  async function campaignSessionOwingAnOutcome(agent: Who, campaignId: string, to: string) {
    const joined = await post('/proxy/agency/sessions', agent, { campaign_id: campaignId });
    expect(joined.statusCode, joined.body).toBe(201);
    const sessionId = joined.json().session_id as string;
    const station = await connect(joined.json().station_ws_url);
    const switched = await post(`/proxy/agency/sessions/${sessionId}/softphone`, agent);
    expect(switched.statusCode, switched.body).toBe(200);
    expect(switched.json()).toMatchObject({ state: 'break', break_reason: 'soft_phone' });

    const placed = await post('/proxy/agency/softphone/calls', agent, { session_id: sessionId, to });
    expect(placed.statusCode, placed.body).toBe(201);
    const callId = placed.json().id as string;
    const leg = await legOf(callId);
    answer(leg);
    await waitFor('bridged frame', () => lastCall(station)?.state === 'bridged');
    expect((await post(`/proxy/agency/softphone/calls/${callId}/hangup`, agent)).statusCode).toBe(200);
    await carrierEnded(leg);
    await waitFor('awaiting outcome', () => lastCall(station)?.requires_disposition);
    expect(await runtime.agents.manualCallOf(sessionId)).toBe(callId);
    return { sessionId, station, callId };
  }

  /** The buffered audit logger writes on flush. */
  async function auditRows(action: string, resourceId?: string) {
    await platformAuditLogger.shutdown();
    const { rows } = await getTestPool().query(
      `SELECT * FROM platform_audit_log WHERE action = $1 AND ($2::text IS NULL OR resource_id::text = $2)
        ORDER BY created_at ASC`,
      [action, resourceId ?? null],
    );
    return rows;
  }

  beforeAll(async () => {
    initDbPool({ url: TEST_DB_URL, poolMin: 0, poolMax: 8 });
    mocks.verifyIdToken.mockImplementation(async (token: string) => {
      if (!token.startsWith('tok:')) throw new Error('bad token');
      return { uid: token.slice(4), email: 'sp@example.com', email_verified: true };
    });
    await truncateAll();
    await flushTestRedis();
    resetVoiceEngineForTests();
    await resetAgencyRuntimeForTests();

    tenant = (await insertTenant()).id as string;
    account = (await insertAccount({ tenant_id: tenant })).id as string;
    sibling = (await insertAccount({ tenant_id: tenant })).id as string;
    dark = (await insertAccount({ tenant_id: tenant })).id as string;
    otherTenant = (await insertTenant()).id as string;
    otherAccount = (await insertAccount({ tenant_id: otherTenant })).id as string;
    await getTestPool().query(
      `INSERT INTO account_settings (tenant_id, account_id, allow_recording, analyze_calls, max_concurrent_calls)
       VALUES ($1, $2, true, true, 20), ($1, $3, false, false, 20), ($1, $4, true, true, 20)`,
      [tenant, account, sibling, dark],
    );
    // The soft phone is on everywhere (FF_AGENCY_SOFTPHONE) except this one account.
    await getTestPool().query(
      `INSERT INTO feature_flag_overrides (flag_key, scope_type, tenant_id, account_id, value)
       VALUES ('agency_softphone_enabled', 'account', $1, $2, 'false'::jsonb)`,
      [tenant, dark],
    );
    const provider = await insertTelephonyProvider();
    const number = await insertPhoneNumber({ provider_id: provider.id, phone_number: '+919000000099' });
    await insertPhoneAssignment({ tenant_id: tenant, phone_number_id: number.id, is_default: true });
    accountNumber = '+919000000099';

    supervisor = await user(tenant, account, 'account_admin');
    darkAgent = await user(tenant, dark, 'agent');
    siblingSupervisor = await user(tenant, sibling, 'account_admin');
    foreignSupervisor = await user(otherTenant, otherAccount, 'account_admin');

    ctx = { config, pool: getPool(), redis: getTestRedis() };
    app = await buildApp({ ctx });
    await app.listen({ port: 0, host: '127.0.0.1' });
    port = (app.server.address() as { port: number }).port;
    stopVoice = await startVoice(ctx);
    stopAgency = await startAgency(ctx);
    runtime = getAgencyRuntime()!;
  });

  afterAll(async () => {
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

  it('a tagged call over HTTP: session → place → answer → hang up → outcome → list/detail → audit', async () => {
    const agent = await user(tenant, account, 'agent');
    const colleague = await user(tenant, account, 'agent');
    const campaign = await insertAgencyCampaign({
      status: 'paused',
      tenant_id: tenant, account_id: account, name: 'Renewals', disposition_catalog: CATALOG,
      caller_ids: ['+919000000001'], record_calls: true,
    });
    const contact = await insertAgencyContact(campaign.id, { tenant_id: tenant, account_id: account, phone_e164: '+919811200001' });
    await staff(campaign.id, agent.id);

    const { sessionId, station } = await openSoftphone(agent);
    // A second open rehydrates the same session (200), never a second one.
    const again = await post('/proxy/agency/softphone/sessions', agent);
    expect(again.statusCode).toBe(200);
    expect(again.json().session_id).toBe(sessionId);
    // The station token route works for a soft-phone session too.
    const token = await post(`/proxy/agency/sessions/${sessionId}/station-token`, agent);
    expect(token.statusCode).toBe(200);
    expect(token.json().station_ws_url).toMatch(/^\/proxy\/agency\/station\//);

    const boot = await get('/proxy/agency/softphone/bootstrap', agent);
    expect(boot.statusCode).toBe(200);
    expect(boot.json()).toMatchObject({
      session: { session_id: sessionId, kind: 'softphone', state: 'break', on_softphone: true, campaign_id: null },
      call: null,
      default_country_code: '+91',
      untagged: { caller_ids: [accountNumber], default_caller_id: accountNumber },
    });
    expect(boot.json().taggable_campaigns.map((c: { campaign_id: string }) => c.campaign_id)).toEqual([campaign.id]);

    const placed = await post('/proxy/agency/softphone/calls', agent, {
      session_id: sessionId, to: '9811200001', campaign_id: campaign.id,
      // A client cannot assert supervision or another agent.
      on_behalf: true, agent_user_id: colleague.id,
    });
    expect(placed.statusCode, placed.body).toBe(201);
    const call = placed.json();
    expect(call).toMatchObject({
      agent_user_id: agent.id, destination_e164: '+919811200001', tag: { campaign_id: campaign.id, campaign_name: 'Renewals' },
      contact: { contact_id: contact.id, claimed: true },
    });
    expect(call.audit).toBeUndefined(); // the internal envelope never reaches the browser
    const leg = await legOf(call.id);
    answer(leg);
    await waitFor('bridged', () => lastCall(station)?.state === 'bridged');

    // A colleague cannot see, hang up or write up the call.
    expect((await get(`/proxy/agency/softphone/calls/${call.id}`, colleague)).statusCode).toBe(404);
    const foreignHangup = await post(`/proxy/agency/softphone/calls/${call.id}/hangup`, colleague);
    expect(foreignHangup.statusCode).toBe(404);
    expect(foreignHangup.json().code).toBe('call_not_found');
    expect((await get(`/proxy/agency/softphone/calls?agent_user_id=${agent.id}`, colleague)).statusCode).toBe(403);

    const details = await patch(`/proxy/agency/softphone/calls/${call.id}`, agent, { notes: 'Wants the annual plan', fields: {} });
    expect(details.statusCode, details.body).toBe(200);
    expect(details.json().notes).toBe('Wants the annual plan');

    const hung = await post(`/proxy/agency/softphone/calls/${call.id}/hangup`, agent);
    expect(hung.statusCode, hung.body).toBe(200);
    await carrierEnded(leg);
    await waitFor('awaiting outcome', () => lastCall(station)?.requires_disposition);

    // While the outcome is owed the session cannot dial again.
    const second = await post('/proxy/agency/softphone/calls', agent, { session_id: sessionId, to: '9811200099' });
    expect(second.statusCode).toBe(409);
    expect(second.json()).toMatchObject({ code: 'outcome_pending', call: { id: call.id } });

    const bad = await post(`/proxy/agency/softphone/calls/${call.id}/disposition`, agent, { code: 'nope', fields: {} });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({ code: 'disposition_invalid', allowed_codes: ['interested', 'call_back'] });

    const outcome = await post(`/proxy/agency/softphone/calls/${call.id}/disposition`, agent, { code: 'interested', fields: {} });
    expect(outcome.statusCode, outcome.body).toBe(200);
    expect(outcome.json()).toMatchObject({ contact_state: 'completed', call: { disposition_code: 'interested' } });

    const list = await get(`/proxy/agency/softphone/calls?limit=8&agent_user_id=${agent.id}`, agent);
    expect(list.statusCode, list.body).toBe(200);
    const rows = list.json().rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: call.id, agent_name: expect.any(String) });
    expect(rows[0]).toHaveProperty('analysis_status');
    expect(rows[0].contact).not.toHaveProperty('context');
    // Filters: the console's own query shapes.
    expect((await get(`/proxy/agency/softphone/calls?campaign_id=untagged`, agent)).json().rows).toHaveLength(0);
    expect((await get(`/proxy/agency/softphone/calls?campaign_id=${campaign.id}&phone=200001`, agent)).json().rows).toHaveLength(1);
    expect((await get(`/proxy/agency/softphone/calls?phone=12ab`, agent)).statusCode).toBe(400);
    expect((await get(`/proxy/agency/softphone/calls?campaign_id=not-a-uuid`, agent)).statusCode).toBe(400);

    // The agent reads their own call's record; its media leg (recording, transcript,
    // analysis) is supervise-only, as a campaign call's is.
    const detail = await get(`/proxy/agency/softphone/calls/${call.id}`, agent);
    expect(detail.statusCode, detail.body).toBe(200);
    expect(detail.json()).toMatchObject({
      call: { id: call.id, agent_name: expect.any(String), contact: { contact_id: contact.id } },
      dispositioned_by_name: expect.any(String),
      overrides: { dnc_note: null, dnc_entry_id: null, dnc_entry: null, hours_note: null },
      call_availability: 'available',
      media: null,
    });

    // A supervisor reads every call in the account, with its media leg.
    const supList = await get(`/proxy/agency/softphone/calls?agent_user_id=${agent.id}`, supervisor);
    expect(supList.json().rows.map((r: { id: string }) => r.id)).toEqual([call.id]);
    const supDetail = await get(`/proxy/agency/softphone/calls/${call.id}`, supervisor);
    expect(supDetail.statusCode).toBe(200);
    expect(supDetail.json().media).toMatchObject({ id: leg, recording_url: null });

    const [placedRow] = await auditRows('agency_manual_call.placed', call.id);
    expect(placedRow).toMatchObject({
      tenant_id: tenant, account_id: account, actor_type: 'human', user_id: agent.id,
      resource_type: 'agency_manual_call', campaign_id: campaign.id,
    });
    expect(placedRow.details).toEqual({ session_id: sessionId, campaign_id: campaign.id });
    const [hungRow] = await auditRows('agency_manual_call.hung_up', call.id);
    expect(hungRow).toMatchObject({ user_id: agent.id, campaign_id: campaign.id });
    const [disposed] = await auditRows('agency_manual_call.dispositioned', call.id);
    expect(disposed).toMatchObject({ user_id: agent.id, campaign_id: campaign.id });
    expect(disposed.details).toEqual({ disposition_code: 'interested', campaign_id: campaign.id });
    const joined = (await auditRows('agency_session.joined', sessionId));
    expect(joined[0]).toMatchObject({ user_id: agent.id });
    expect(joined[0].details).toMatchObject({ kind: 'softphone' });

    // Close the soft phone ("leave") — it works on a soft-phone session.
    const left = await post(`/proxy/agency/sessions/${sessionId}/leave`, agent);
    expect(left.statusCode, left.body).toBe(200);
    expect(left.json()).toMatchObject({ kind: 'softphone', campaign_id: null, state: 'offline' });
  }, 40_000);

  it('a supervisor saves an agent\'s outcome on behalf; the audit row says so', async () => {
    const agent = await user(tenant, account, 'agent');
    const { sessionId, station } = await openSoftphone(agent);
    const placed = await post('/proxy/agency/softphone/calls', agent, { session_id: sessionId, to: '+919811200010', campaign_id: null });
    expect(placed.statusCode, placed.body).toBe(201);
    const call = placed.json();
    expect(call.caller_id).toBe(accountNumber);
    const leg = await legOf(call.id);
    answer(leg);
    await waitFor('bridged', () => lastCall(station)?.state === 'bridged');
    const hung = await post(`/proxy/agency/softphone/calls/${call.id}/hangup`, supervisor);
    expect(hung.statusCode).toBe(200);
    await carrierEnded(leg);
    await waitFor('awaiting outcome', () => lastCall(station)?.requires_disposition);
    const outcome = await post(`/proxy/agency/softphone/calls/${call.id}/disposition`, supervisor, { code: 'voicemail', fields: {} });
    expect(outcome.statusCode, outcome.body).toBe(200);
    expect(outcome.json().call).toMatchObject({ dispositioned_on_behalf: true, dispositioned_by_user_id: supervisor.id, disposition_source: 'softphone' });
    const [row] = await auditRows('agency_manual_call.dispositioned', call.id);
    expect(row).toMatchObject({ user_id: supervisor.id, campaign_id: null });
    expect(row.details).toEqual({ disposition_code: 'voicemail', on_behalf: true });
    const [hungRow] = await auditRows('agency_manual_call.hung_up', call.id);
    expect(hungRow.details).toEqual({ on_behalf: true });
    expect((await post(`/proxy/agency/sessions/${sessionId}/leave`, agent)).statusCode).toBe(200);
  }, 30_000);

  it('DNC over HTTP: 409 dnc_listed with the entry, then placed with an override note, audited with note and entry', async () => {
    const agent = await user(tenant, account, 'agent');
    const campaign = await insertAgencyCampaign({ status: 'paused', tenant_id: tenant, account_id: account, disposition_catalog: CATALOG });
    await staff(campaign.id, agent.id);
    const { rows: [entry] } = await getTestPool().query(
      `INSERT INTO dnc_entries (tenant_id, account_id, campaign_id, phone_e164, source, reason)
       VALUES ($1, NULL, NULL, '+919811200020', 'import', 'asked twice') RETURNING id`, [tenant]);
    const { sessionId, station } = await openSoftphone(agent);

    const refused = await post('/proxy/agency/softphone/calls', agent, { session_id: sessionId, to: '+919811200020', campaign_id: campaign.id });
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({
      error: 'Conflict', code: 'dnc_listed', message: expect.any(String),
      entry: { id: entry.id, scope: 'tenant', reason: 'asked twice' },
    });
    const short = await post('/proxy/agency/softphone/calls', agent, {
      session_id: sessionId, to: '+919811200020', campaign_id: campaign.id, overrides: { dnc_note: 'ok' },
    });
    expect(short.statusCode).toBe(400);
    expect(short.json().code).toBe('override_note_invalid');

    const note = 'Customer called in and asked for a callback today.';
    const placed = await post('/proxy/agency/softphone/calls', agent, {
      session_id: sessionId, to: '+919811200020', campaign_id: campaign.id, overrides: { dnc_note: note },
    });
    expect(placed.statusCode, placed.body).toBe(201);
    expect(placed.json().dnc_overridden).toBe(true);
    const callId = placed.json().id as string;
    const detail = await get(`/proxy/agency/softphone/calls/${callId}`, supervisor);
    // The entry as the refusal showed it, not just its id (A12).
    expect(detail.json().overrides).toEqual({
      dnc_note: note, dnc_entry_id: entry.id, hours_note: null,
      dnc_entry: { id: entry.id, scope: 'tenant', reason: 'asked twice', created_at: expect.any(String), campaign_id: null },
    });

    const [override] = await auditRows('agency_manual_call.dnc_overridden', callId);
    expect(override).toMatchObject({ user_id: agent.id, campaign_id: campaign.id, resource_type: 'agency_manual_call' });
    expect(override.details).toEqual({ note, dnc_entry_id: entry.id, campaign_id: campaign.id });
    const [placedRow] = await auditRows('agency_manual_call.placed', callId);
    expect(placedRow.details).toMatchObject({ dnc_overridden: true });

    // Mark DNC on the call: campaign scope (tagged), audited without the number.
    const marked = await post(`/proxy/agency/softphone/calls/${callId}/dnc`, agent, { reason: 'asked again' });
    expect(marked.statusCode, marked.body).toBe(200);
    expect(marked.json()).toMatchObject({ call_id: callId, scope: 'campaign', dnc_recorded: true });
    const [dncRow] = await auditRows('agency_manual_call.dnc_marked', callId);
    expect(dncRow.details).toEqual({ scope: 'campaign', dnc_recorded: true, campaign_id: campaign.id });

    ringOut(await legOf(callId));
    await waitFor('settled', async () => (await manualRow(callId)).settled_at);
    await waitFor('settled frame', () => lastCall(station)?.settled_at);
    expect((await post(`/proxy/agency/sessions/${sessionId}/leave`, agent)).statusCode).toBe(200);
  }, 30_000);

  it('the switch from a campaign session: queued, applied, return refused while unsettled, return — audited and on the campaign trail', async () => {
    const agent = await user(tenant, account, 'agent');
    const campaign = await insertAgencyCampaign({ status: 'paused', tenant_id: tenant, account_id: account, disposition_catalog: CATALOG });
    const joined = await post('/proxy/agency/sessions', agent, { campaign_id: campaign.id });
    expect(joined.statusCode, joined.body).toBe(201);
    const sessionId = joined.json().session_id as string;
    const station = await connect(joined.json().station_ws_url);

    // A soft-phone session cannot be opened while live on the campaign.
    const conflict = await post('/proxy/agency/softphone/sessions', agent);
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({
      code: 'session_on_campaign', session_id: sessionId, campaign_id: campaign.id,
      campaign_name: campaign.name, state: 'break',
    });

    // In wrap-up: the switch is queued, not applied.
    await runtime.agents.set(sessionId, 'wrapup', { leaseMs: AGENT_LEASE_MS.wrapup });
    const queued = await post(`/proxy/agency/sessions/${sessionId}/softphone`, agent);
    expect(queued.statusCode, queued.body).toBe(200);
    expect(queued.json()).toMatchObject({ state: 'wrapup', pending_state: 'break', break_reason: 'soft_phone', kind: 'campaign' });
    const boot = await get('/proxy/agency/softphone/bootstrap', agent);
    expect(boot.json().session).toMatchObject({
      session_id: sessionId, kind: 'campaign', on_softphone: false, pending_state: 'break', pending_break_reason: 'soft_phone',
      campaign_name: campaign.name,
    });

    // Wrap-up ends: the queued break lands on the soft phone.
    await runtime.dialer.releaseAgent(sessionId);
    await waitFor('soft_phone break', () => station.frames.some((f) =>
      f['event'] === 'agent_state' && f['state'] === 'break' && f['break_reason'] === 'soft_phone'));

    const placed = await post('/proxy/agency/softphone/calls', agent, { session_id: sessionId, to: '+919811200030', campaign_id: campaign.id });
    // The agent is not staffed on this campaign: they joined it, but tagging follows staffing.
    expect(placed.statusCode).toBe(403);
    expect(placed.json().code).toBe('campaign_not_taggable');
    const untagged = await post('/proxy/agency/softphone/calls', agent, { session_id: sessionId, to: '+919811200030' });
    expect(untagged.statusCode, untagged.body).toBe(201);
    const callId = untagged.json().id as string;
    const leg = await legOf(callId);

    const whileLive = await post(`/proxy/agency/sessions/${sessionId}/softphone/return`, agent);
    expect(whileLive.statusCode).toBe(409);
    expect(whileLive.json()).toMatchObject({ code: 'manual_call_live', call: { id: callId } });
    // `leave` is refused while the call is live.
    expect((await post(`/proxy/agency/sessions/${sessionId}/leave`, agent)).statusCode).toBe(409);

    ringOut(leg);
    await waitFor('settled', async () => (await manualRow(callId)).settled_at);
    const back = await post(`/proxy/agency/sessions/${sessionId}/softphone/return`, agent);
    expect(back.statusCode, back.body).toBe(200);
    expect(back.json()).toMatchObject({ state: 'available', campaign_id: campaign.id });
    await runtime.agents.set(sessionId, 'break');

    // Two rows for the one switch: the agent queueing it, and the instant it applied
    // (the end of wrap-up), which nobody pressed.
    const [started, applied, ...more] = await auditRows('agency_session.softphone_started', sessionId);
    expect(more).toEqual([]);
    expect(started).toMatchObject({ user_id: agent.id, actor_type: 'human', campaign_id: campaign.id, resource_type: 'agency_session' });
    expect(started.details).toEqual({ campaign_id: campaign.id, from_state: 'wrapup', queued: true });
    expect(applied).toMatchObject({ user_id: null, actor_type: 'system', campaign_id: campaign.id, resource_type: 'agency_session' });
    expect(applied.details).toEqual({ campaign_id: campaign.id, from_state: 'wrapup', queued: true, applied: true });
    const [ended] = await auditRows('agency_session.softphone_ended', sessionId);
    expect(ended.details).toEqual({ campaign_id: campaign.id, from_state: 'break', withdrawn: false, via: 'return' });

    // The supervisor sees the switch and the return on the campaign's activity trail.
    const trail = await get(`/proxy/agency/campaigns/${campaign.id}/activity?limit=50`, supervisor);
    expect(trail.statusCode, trail.body).toBe(200);
    const actions = trail.json().rows.map((r: { action: string }) => r.action);
    expect(actions).toEqual(expect.arrayContaining(['agency_session.softphone_started', 'agency_session.softphone_ended']));
    const offered = trail.json().available_actions.map((a: { value: string }) => a.value);
    expect(offered).toEqual(expect.arrayContaining(['agency_session.softphone_started', 'agency_manual_call.lapsed']));

    expect((await post(`/proxy/agency/sessions/${sessionId}/leave`, agent)).statusCode).toBe(200);
  }, 40_000);

  // ── Finding 1: an agent owing a soft-phone outcome never becomes available ──────────
  //
  // A campaign session on the soft phone, a call that bridged and ended, its outcome owed.
  // Each step below is a way the guard on `available` (the Redis `manual` field) could be
  // lost — the station dropping (presence written `offline`), the lease lapsing (the hash
  // and its `manual` field gone), the reconnect rehydrating it — and the route must still
  // answer 409 `manual_call_live` until the outcome is saved.
  it('a station drop, a lapsed lease and a reconnect keep an agent owing a soft-phone outcome out of the pool', async () => {
    const agent = await user(tenant, account, 'agent');
    const campaign = await insertAgencyCampaign({ status: 'paused', tenant_id: tenant, account_id: account, disposition_catalog: CATALOG });
    const { sessionId, station, callId } = await campaignSessionOwingAnOutcome(agent, campaign.id, '+919811200060');

    // The lid closes: presence goes `offline`, and the row keeps the soft-phone break reason.
    await drop(station);
    await waitFor('offline', async () => (await runtime.agents.get(sessionId))?.state === 'offline');
    expect(await sessionRow(sessionId)).toEqual({ state: 'offline', break_reason: 'soft_phone' });
    // …and the 45 s lease lapses, taking the `manual` field with it.
    await getTestRedis().del(leaseKey(sessionId));

    // The agent reloads: the campaign join rehydrates the session onto the soft phone.
    const rejoined = await post('/proxy/agency/sessions', agent, { campaign_id: campaign.id });
    expect(rejoined.statusCode, rejoined.body).toBe(201); // the campaign join is always 201
    expect(rejoined.json()).toMatchObject({ session_id: sessionId, state: 'break' });
    expect(await runtime.agents.manualCallOf(sessionId)).toBe(callId);
    expect(await sessionRow(sessionId)).toEqual({ state: 'break', break_reason: 'soft_phone' });
    const back = await connect(rejoined.json().station_ws_url);
    const owed = await waitFor('the owed call after ready', () => lastCall(back));
    expect(owed).toMatchObject({ id: callId, requires_disposition: true });

    const available = await post(`/proxy/agency/sessions/${sessionId}/available`, agent);
    expect(available.statusCode, available.body).toBe(409);
    expect(available.json()).toMatchObject({ code: 'manual_call_live', call: { id: callId } });
    expect((await runtime.agents.get(sessionId))?.state).toBe('break');
    // Another break would leave the soft phone with the call still on it: refused too.
    const lunch = await post(`/proxy/agency/sessions/${sessionId}/break`, agent, { reason: 'lunch' });
    expect(lunch.statusCode, lunch.body).toBe(409);
    expect(lunch.json()).toMatchObject({ code: 'manual_call_live', call: { id: callId } });
    expect(await sessionRow(sessionId)).toEqual({ state: 'break', break_reason: 'soft_phone' });
    const boot = await get('/proxy/agency/softphone/bootstrap', agent);
    expect(boot.json().session).toMatchObject({ session_id: sessionId, on_softphone: true });
    expect(boot.json().call).toMatchObject({ id: callId });
    // The soft phone still dials from it (it is still on the soft phone): refused only
    // because the outcome is owed.
    const again = await post('/proxy/agency/softphone/calls', agent, { session_id: sessionId, to: '+919811200061' });
    expect(again.json().code).toBe('outcome_pending');

    // (a) A row whose break reason was nulled (an older build's offline write) still
    // rehydrates onto the soft phone: the unsettled call alone makes it soft-phone flavoured.
    await drop(back);
    await waitFor('offline again', async () => (await runtime.agents.get(sessionId))?.state === 'offline');
    await getTestPool().query('UPDATE agency_agent_sessions SET break_reason = NULL WHERE id = $1', [sessionId]);
    await getTestRedis().del(leaseKey(sessionId));
    const minted = await post(`/proxy/agency/sessions/${sessionId}/station-token`, agent);
    expect(minted.statusCode, minted.body).toBe(200);
    const third = await connect(minted.json().station_ws_url);
    expect(third.frames.find((f) => f['event'] === 'ready')!['state']).toBe('break');
    expect(await runtime.agents.manualCallOf(sessionId)).toBe(callId);
    expect(await sessionRow(sessionId)).toEqual({ state: 'break', break_reason: 'soft_phone' });

    // (c) Redis holding `break` with no `manual` field at all (any write that lost it):
    // the route reads the database first, refuses, and re-claims the field.
    await getTestRedis().hdel(leaseKey(sessionId), 'manual');
    const stillOwed = await post(`/proxy/agency/sessions/${sessionId}/available`, agent);
    expect(stillOwed.statusCode, stillOwed.body).toBe(409);
    expect(stillOwed.json()).toMatchObject({ code: 'manual_call_live', call: { id: callId } });
    expect(await runtime.agents.manualCallOf(sessionId)).toBe(callId);
    expect((await runtime.agents.get(sessionId))?.state).toBe('break');

    // The outcome lifts the guard.
    const outcome = await post(`/proxy/agency/softphone/calls/${callId}/disposition`, agent, { code: 'voicemail' });
    expect(outcome.statusCode, outcome.body).toBe(200);
    const nowAvailable = await post(`/proxy/agency/sessions/${sessionId}/available`, agent);
    expect(nowAvailable.statusCode, nowAvailable.body).toBe(200);
    await runtime.agents.set(sessionId, 'break');
    await waitFor('third station sees it', () => third.frames.some((f) => f['event'] === 'agent_state' && f['state'] === 'available'));
    expect((await post(`/proxy/agency/sessions/${sessionId}/leave`, agent)).statusCode).toBe(200);
  }, 40_000);

  it('break/cancel withdraws a queued switch; a soft-phone session refuses break/cancel and force-available', async () => {
    const agent = await user(tenant, account, 'agent');
    const campaign = await insertAgencyCampaign({ status: 'paused', tenant_id: tenant, account_id: account });
    const joined = await post('/proxy/agency/sessions', agent, { campaign_id: campaign.id });
    const sessionId = joined.json().session_id as string;
    const station = await connect(joined.json().station_ws_url);
    await runtime.agents.set(sessionId, 'wrapup', { leaseMs: AGENT_LEASE_MS.wrapup });
    expect((await post(`/proxy/agency/sessions/${sessionId}/softphone`, agent)).json().pending_state).toBe('break');

    const cancelled = await post(`/proxy/agency/sessions/${sessionId}/break/cancel`, agent);
    expect(cancelled.statusCode, cancelled.body).toBe(200);
    expect(cancelled.json().pending_state).toBeUndefined();
    expect(cancelled.json()).not.toHaveProperty('softphone_audit');
    expect(runtime.breaks.peek(sessionId)).toBeNull();
    // Audited as a withdrawn switch (SP7), not as a plain break cancel.
    const [withdrawn] = await auditRows('agency_session.softphone_ended', sessionId);
    expect(withdrawn).toMatchObject({ user_id: agent.id, campaign_id: campaign.id });
    expect(withdrawn.details).toEqual({ campaign_id: campaign.id, from_state: 'wrapup', withdrawn: true, via: 'break_cancel' });
    expect(await auditRows('agency_session.break_cancelled', sessionId)).toEqual([]);
    await runtime.dialer.releaseAgent(sessionId);
    expect((await runtime.agents.get(sessionId))?.state).toBe('available');
    expect(station.frames.some((f) => f['event'] === 'agent_state' && f['break_reason'] === 'soft_phone')).toBe(false);
    await runtime.agents.set(sessionId, 'break');
    expect((await post(`/proxy/agency/sessions/${sessionId}/leave`, agent)).statusCode).toBe(200);

    const { sessionId: spSession } = await openSoftphone(agent);
    const spCancel = await post(`/proxy/agency/sessions/${spSession}/break/cancel`, agent);
    expect(spCancel.statusCode).toBe(409);
    expect(spCancel.json().code).toBe('wrong_session_kind');
    const forced = await post(`/proxy/agency/sessions/${spSession}/force-available`, supervisor);
    expect(forced.statusCode).toBe(409);
    expect(forced.json().code).toBe('wrong_session_kind');
    const switched = await post(`/proxy/agency/sessions/${spSession}/softphone`, agent);
    expect(switched.statusCode).toBe(409);
    expect(switched.json().code).toBe('wrong_session_kind');
    // The campaign join names the soft-phone session.
    const join = await post('/proxy/agency/sessions', agent, { campaign_id: campaign.id });
    expect(join.statusCode).toBe(409);
    expect(join.json()).toMatchObject({ code: 'session_on_softphone', session_id: spSession });
    expect((await post(`/proxy/agency/sessions/${spSession}/leave`, agent)).statusCode).toBe(200);
  }, 30_000);

  it('every way off the soft phone is audited once, with how; a repeated switch is not audited again', async () => {
    const agent = await user(tenant, account, 'agent');
    const campaign = await insertAgencyCampaign({ tenant_id: tenant, account_id: account });
    const joined = await post('/proxy/agency/sessions', agent, { campaign_id: campaign.id });
    const sessionId = joined.json().session_id as string;
    await connect(joined.json().station_ws_url);
    const switchNow = async () => {
      const r = await post(`/proxy/agency/sessions/${sessionId}/softphone`, agent);
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json()).toMatchObject({ state: 'break', break_reason: 'soft_phone' });
    };
    const noAuditKey = (body: Record<string, unknown>) => expect(body).not.toHaveProperty('softphone_audit');

    // Switched (applied at once), then pressed again: one row.
    await switchNow();
    await switchNow();
    expect(await auditRows('agency_session.softphone_started', sessionId)).toHaveLength(1);

    // 1. Available.
    const available = await post(`/proxy/agency/sessions/${sessionId}/available`, agent);
    expect(available.statusCode, available.body).toBe(200);
    noAuditKey(available.json());
    // 2. A break with another reason.
    await switchNow();
    const lunch = await post(`/proxy/agency/sessions/${sessionId}/break`, agent, { reason: 'lunch' });
    expect(lunch.statusCode, lunch.body).toBe(200);
    noAuditKey(lunch.json());
    // Available from lunch is not a soft-phone exit.
    expect((await post(`/proxy/agency/sessions/${sessionId}/available`, agent)).statusCode).toBe(200);
    // 3. The supervisor's force-available.
    await switchNow();
    const forced = await post(`/proxy/agency/sessions/${sessionId}/force-available`, supervisor);
    expect(forced.statusCode, forced.body).toBe(200);
    expect(forced.json().state).toBe('available');
    noAuditKey(forced.json());

    const ended = await auditRows('agency_session.softphone_ended', sessionId);
    expect(ended.map((r) => [r.user_id, r.details])).toEqual([
      [agent.id, { campaign_id: campaign.id, from_state: 'break', withdrawn: false, via: 'available' }],
      [agent.id, { campaign_id: campaign.id, from_state: 'break', withdrawn: false, via: 'break', break_reason: 'lunch' }],
      [supervisor.id, { campaign_id: campaign.id, from_state: 'break', withdrawn: false, via: 'force_available' }],
    ]);
    expect(await auditRows('agency_session.softphone_started', sessionId)).toHaveLength(3);

    await runtime.agents.set(sessionId, 'break');
    expect((await post(`/proxy/agency/sessions/${sessionId}/leave`, agent)).statusCode).toBe(200);
  }, 30_000);

  it('PUT /settings: manage only, settings_invalid with the console\'s paths, a valid write audited', async () => {
    const agent = await user(tenant, account, 'agent');
    const valid = {
      disposition_catalog: [{ code: 'sold', label: 'Sold', is_success: true, terminal: true }],
      call_fields: [{ key: 'policy_no', label: 'Policy number', type: 'text', required: true }],
      analysis_profile_id: null,
      record_calls: true,
      default_caller_id: accountNumber,
    };
    const byAgent = await put('/proxy/agency/softphone/settings', agent, valid);
    expect(byAgent.statusCode).toBe(403);
    expect(byAgent.json().message).toMatch(/Insufficient permissions/);
    expect((await get('/proxy/agency/softphone/settings', agent)).statusCode).toBe(200);

    const badCaller = await put('/proxy/agency/softphone/settings', supervisor, { ...valid, default_caller_id: '+919999999999' });
    expect(badCaller.statusCode).toBe(400);
    expect(badCaller.json()).toMatchObject({ code: 'settings_invalid', details: [{ path: 'default_caller_id' }] });
    const badProfile = await put('/proxy/agency/softphone/settings', supervisor, { ...valid, analysis_profile_id: randomUUID() });
    expect(badProfile.json()).toMatchObject({ code: 'settings_invalid', details: [{ path: 'analysis_profile_id' }] });
    const badField = await put('/proxy/agency/softphone/settings', supervisor, {
      ...valid, call_fields: [{ key: 'Bad Key', label: 'x', type: 'text' }],
    });
    expect(badField.json().details.map((d: { path: string }) => d.path)).toContain('call_fields[0].key');
    const badCatalog = await put('/proxy/agency/softphone/settings', supervisor, { ...valid, disposition_catalog: [{ label: 'no code' }] });
    expect(badCatalog.json().details.map((d: { path: string }) => d.path).some((p: string) => p.startsWith('disposition_catalog[0]'))).toBe(true);

    const saved = await put('/proxy/agency/softphone/settings', supervisor, { ...valid, updated_at: 'ignored' });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json().settings).toMatchObject({ ...valid, updated_at: expect.any(String) });
    const read = await get('/proxy/agency/softphone/settings', agent);
    expect(read.json().settings.call_fields).toEqual(valid.call_fields);
    const [row] = await auditRows('agency_softphone_settings.updated');
    expect(row).toMatchObject({ user_id: supervisor.id, resource_type: 'agency_softphone_settings', campaign_id: null });
    expect(row.details.changed).toEqual(['disposition_catalog', 'call_fields', 'record_calls', 'default_caller_id']);

    // The field set is now in force on a dial: an unknown key is refused, through HTTP.
    const sp = await openSoftphone(agent);
    const placed = await post('/proxy/agency/softphone/calls', agent, { session_id: sp.sessionId, to: '+919811200040', fields: { nope: 1 } });
    expect(placed.statusCode).toBe(400);
    expect(placed.json()).toMatchObject({ code: 'fields_invalid', details: [{ path: expect.stringContaining('nope') }] });
    // Back to defaults for the other tests.
    await put('/proxy/agency/softphone/settings', supervisor, {
      disposition_catalog: [], call_fields: [], analysis_profile_id: null, record_calls: false, default_caller_id: null,
    });
    expect((await post(`/proxy/agency/sessions/${sp.sessionId}/leave`, agent)).statusCode).toBe(200);
  }, 30_000);

  it('isolation, the recording route\'s gates and the flag', async () => {
    const agent = await user(tenant, account, 'agent');
    const colleague = await user(tenant, account, 'agent');
    const { sessionId, station } = await openSoftphone(agent);
    const placed = await post('/proxy/agency/softphone/calls', agent, { session_id: sessionId, to: '+919811200050' });
    expect(placed.statusCode, placed.body).toBe(201);
    const callId = placed.json().id as string;
    const leg = await legOf(callId);

    // Another tenant's supervisor, and a sibling account's: the call does not exist for them.
    const foreign = await get(`/proxy/agency/softphone/calls/${callId}`, foreignSupervisor, otherAccount, otherTenant);
    expect(foreign.statusCode).toBe(404);
    expect(foreign.json().code).toBe('call_not_found');
    expect((await get(`/proxy/agency/softphone/calls/${callId}`, siblingSupervisor, sibling)).statusCode).toBe(404);
    expect((await post(`/proxy/agency/softphone/calls/${callId}/hangup`, foreignSupervisor, {}, otherAccount, otherTenant)).statusCode).toBe(404);
    // A malformed id is the same not-found, never a 22P02.
    const malformed = await get('/proxy/agency/softphone/calls/not-a-uuid', agent);
    expect(malformed.statusCode).toBe(404);
    expect(malformed.json().code).toBe('call_not_found');

    // Recording: supervise-only, the agent's own call included (RBAC 403); a supervisor →
    // past the gates (no recording on a fake carrier: 404 without a code); an account
    // without allow_recording → 403.
    const own = await get(`/proxy/agency/softphone/calls/${callId}/recording`, agent);
    expect(own.statusCode).toBe(403);
    expect(own.json().message).toMatch(/Insufficient permissions/);
    expect((await get(`/proxy/agency/softphone/calls/${callId}/recording`, colleague)).statusCode).toBe(403);
    const sup = await get(`/proxy/agency/softphone/calls/${callId}/recording`, supervisor);
    expect(sup.statusCode).toBe(404);
    expect(sup.headers['content-type']).toMatch(/json/);
    expect(sup.json().code).toBeUndefined();
    const noRecording = await get(`/proxy/agency/softphone/calls/${callId}/recording`, siblingSupervisor, sibling);
    expect(noRecording.statusCode).toBe(403);
    expect(noRecording.json()).toEqual({ error: 'capability_disabled', capability: 'agency.recording' });

    // The flag, off for one account: starting work answers softphone_disabled; bootstrap
    // answers, saying so (the routes that finish a call are not gated, §6).
    const off = await get('/proxy/agency/softphone/bootstrap', darkAgent, dark);
    expect(off.statusCode).toBe(200);
    expect(off.json()).toMatchObject({ softphone_enabled: false, session: null, call: null });
    const dial = await post('/proxy/agency/softphone/sessions', darkAgent, {}, dark);
    expect(dial.statusCode).toBe(403);
    expect(dial.json().code).toBe('softphone_disabled');
    expect((await get('/proxy/agency/softphone/bootstrap', agent)).json().softphone_enabled).toBe(true);

    ringOut(leg);
    await waitFor('settled frame', () => lastCall(station)?.settled_at);
    expect((await post(`/proxy/agency/sessions/${sessionId}/leave`, agent)).statusCode).toBe(200);
  }, 30_000);

  // ── Finding 1, the restart variant: last in the file, because it restarts the runtime ──
  //
  // The same owed outcome across a server restart: the old process's station closes, the
  // runtime stops, the lease lapses while it is down, and the new runtime's startup reaper
  // writes every session `offline` (`markAllOffline`). The voice engine is kept: an ended
  // call holds nothing in the bridge. The reconnect must land on the soft phone with the
  // claim re-taken, and `available` must refuse.
  it('a server restart with the lease lapsed keeps an agent owing a soft-phone outcome out of the pool', async () => {
    const agent = await user(tenant, account, 'agent');
    const campaign = await insertAgencyCampaign({ status: 'paused', tenant_id: tenant, account_id: account, disposition_catalog: CATALOG });
    const { sessionId, station, callId } = await campaignSessionOwingAnOutcome(agent, campaign.id, '+919811200070');

    await drop(station);
    await waitFor('offline', async () => (await runtime.agents.get(sessionId))?.state === 'offline');
    if (stopAgency) await stopAgency();
    stopAgency = null;
    await resetAgencyRuntimeForTests();
    await getTestRedis().del(leaseKey(sessionId));
    stopAgency = await startAgency(ctx);
    runtime = getAgencyRuntime()!;
    expect((await sessionRow(sessionId)).state).toBe('offline');
    expect(await runtime.agents.get(sessionId)).toBeNull();

    const rejoined = await post('/proxy/agency/sessions', agent, { campaign_id: campaign.id });
    expect(rejoined.statusCode, rejoined.body).toBe(201); // the campaign join is always 201
    expect(rejoined.json()).toMatchObject({ session_id: sessionId, state: 'break' });
    const back = await connect(rejoined.json().station_ws_url);
    expect(await waitFor('the owed call after ready', () => lastCall(back))).toMatchObject({ id: callId, requires_disposition: true });
    expect(await runtime.agents.manualCallOf(sessionId)).toBe(callId);

    const available = await post(`/proxy/agency/sessions/${sessionId}/available`, agent);
    expect(available.statusCode, available.body).toBe(409);
    expect(available.json()).toMatchObject({ code: 'manual_call_live', call: { id: callId } });
    const forced = await post(`/proxy/agency/sessions/${sessionId}/force-available`, supervisor);
    expect(forced.statusCode, forced.body).toBe(409);
    expect(forced.json()).toMatchObject({ code: 'manual_call_live', call: { id: callId } });
    expect((await runtime.agents.get(sessionId))?.state).toBe('break');
    expect((await get('/proxy/agency/softphone/bootstrap', agent)).json().session).toMatchObject({ on_softphone: true });

    expect((await post(`/proxy/agency/softphone/calls/${callId}/disposition`, agent, { code: 'voicemail' })).statusCode).toBe(200);
    const nowAvailable = await post(`/proxy/agency/sessions/${sessionId}/available`, agent);
    expect(nowAvailable.statusCode, nowAvailable.body).toBe(200);
    await runtime.agents.set(sessionId, 'break');
    expect((await post(`/proxy/agency/sessions/${sessionId}/leave`, agent)).statusCode).toBe(200);
  }, 40_000);
});
