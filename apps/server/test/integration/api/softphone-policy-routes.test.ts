import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * The soft phone's policy and compliance rules over HTTP (docs/softphone.md §4.1, §6): the
 * REAL app on loopback, the real session → tenant-context → RBAC chain (Firebase's token
 * check is the one stub), the public routes, `callCore`, the internal handlers and
 * `runtime.softphone` over real Redis 6383 and Postgres 5436, with a fake carrier — the
 * harness of `softphone-routes.test.ts`, in its own file so each runs its own app.
 *
 * What it pins:
 *  1. an UNTAGGED dial meets the account's campaign-scoped DNC entries and its live
 *     contacts (`dnc_listed` with the entry, `contact_in_flight` with the campaign);
 *  2. an untagged Mark DNC / `suppress` outcome writes an ACCOUNT-scoped row (never a
 *     tenant-wide one), read by the untagged pre-dial and by the account's campaign dials,
 *     and lands on the DNC audit trail (`dnc_entry.created`) once;
 *  3. `agency_softphone_enabled` switched off mid-call: the agent can still finish
 *     (details, hang up, outcome, return) and bootstrap says `softphone_enabled: false`;
 *     dialling, opening a session and switching are refused;
 *  4. only `running` / `paused` campaigns can be tagged, staffing is filtered before the
 *     cap, and a call whose campaign completes mid-call keeps its catalog (`call_campaign`);
 *  5. a same-code outcome replay propagates a corrected callback time to the contact and
 *     repeats nothing else (no DNC mark, no claim release, no second settling audit).
 */

const mocks = vi.hoisted(() => {
  process.env['SUPER_ADMIN_JWT_SECRET'] = 'softphone-policy-secret-0123456789';
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
import { getFeatureFlagService } from '../../../src/feature-flags/index.js';
import { DncRegistry } from '../../../src/agency/dnc-registry.js';
import { markDnc } from '../../../src/agency/dnc-mark.js';
import type { AgencyRuntime } from '../../../src/agency/runtime.js';
import { agencyCampaignRepository } from '../../../src/db/repositories/agency.repository.js';

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

const NOTE = 'The customer rang in and asked us to call back.';
const CATALOG = JSON.stringify([
  { code: 'renewed', label: 'Renewed', is_success: true, terminal: true },
  { code: 'call_back', label: 'Call back', requires_datetime: true },
]);

describe('soft-phone policy over HTTP — real app, real runtime, fake carrier (integration)', () => {
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
  let supervisor: Who;

  async function user(t: string, a: string, role: string): Promise<Who> {
    const u = await insertUser();
    await insertMembership({ user_id: u.id, tenant_id: t, account_id: a, role });
    homeOf.set(u.id as string, a);
    return { id: u.id as string, tok: `tok:${u.firebase_uid as string}` };
  }

  /** The account a user's requests name (their membership's). */
  const homeOf = new Map<string, string>();
  function headers(who: Who): Record<string, string> {
    const acct = homeOf.get(who.id) ?? account;
    return { authorization: `Bearer ${who.tok}`, 'x-tenant-id': tenant, 'x-account-id': acct, 'content-type': 'application/json' };
  }
  const post = (url: string, who: Who, body: unknown = {}) =>
    app.inject({ method: 'POST', url, headers: headers(who), payload: JSON.stringify(body) });
  const patch = (url: string, who: Who, body: unknown) =>
    app.inject({ method: 'PATCH', url, headers: headers(who), payload: JSON.stringify(body) });
  const get = (url: string, who: Who) => {
    const { 'content-type': _ct, ...h } = headers(who);
    return app.inject({ method: 'GET', url, headers: h });
  };

  async function connect(stationWsUrl: string): Promise<Station> {
    const frames: Array<Record<string, any>> = [];
    const ws = new WebSocket(`ws://127.0.0.1:${port}${stationWsUrl}`);
    sockets.push(ws);
    ws.on('message', (raw) => { try { frames.push(JSON.parse(raw.toString())); } catch { /* media */ } });
    await waitFor('ready', () => frames.find((f) => f['event'] === 'ready'));
    return { ws, frames };
  }

  async function openSoftphone(who: Who): Promise<{ sessionId: string; station: Station }> {
    const res = await post('/proxy/agency/softphone/sessions', who);
    expect(res.statusCode, res.body).toBe(201);
    const body = res.json();
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

  /** Place an untagged call and let it ring out unanswered (it settles at once). */
  async function placeAndRingOut(who: Who, sessionId: string, station: Station, to: string, body: Record<string, unknown> = {}) {
    const placed = await post('/proxy/agency/softphone/calls', who, { session_id: sessionId, to, ...body });
    expect(placed.statusCode, placed.body).toBe(201);
    const callId = placed.json().id as string;
    ringOut(await legOf(callId));
    await waitFor('settled', async () => (await manualRow(callId)).settled_at);
    await waitFor('settled frame', () => lastCall(station)?.id === callId && lastCall(station)?.settled_at);
    return callId;
  }

  /** Place, answer, hang up and end a call, leaving it awaiting its outcome. */
  async function placeOwingAnOutcome(who: Who, sessionId: string, station: Station, to: string, body: Record<string, unknown> = {}) {
    const placed = await post('/proxy/agency/softphone/calls', who, { session_id: sessionId, to, ...body });
    expect(placed.statusCode, placed.body).toBe(201);
    const callId = placed.json().id as string;
    const leg = await legOf(callId);
    answer(leg);
    await waitFor('bridged', () => lastCall(station)?.state === 'bridged');
    expect((await post(`/proxy/agency/softphone/calls/${callId}/hangup`, who)).statusCode).toBe(200);
    await carrierEnded(leg);
    await waitFor('awaiting outcome', () => lastCall(station)?.requires_disposition);
    return callId;
  }

  /** An account of its own, for a test that needs a running campaign (one per account). */
  async function freshAccount(): Promise<string> {
    const acct = (await insertAccount({ tenant_id: tenant })).id as string;
    await getTestPool().query(
      `INSERT INTO account_settings (tenant_id, account_id, allow_recording, analyze_calls, max_concurrent_calls)
       VALUES ($1, $2, true, true, 20)`, [tenant, acct]);
    return acct;
  }

  async function staff(campaignId: string, userId: string, acct = account) {
    await getTestPool().query(
      `INSERT INTO agency_campaign_agents (id, tenant_id, account_id, campaign_id, user_id, assigned_by, assigned_at)
       VALUES ($1, $2, $3, $4, $5, $5, now())`,
      [randomUUID(), tenant, acct, campaignId, userId],
    );
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

  async function dncRows(phone: string) {
    const { rows } = await getTestPool().query(
      'SELECT id, account_id, campaign_id, source, added_by FROM dnc_entries WHERE tenant_id = $1 AND phone_e164 = $2 ORDER BY created_at',
      [tenant, phone],
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
    await getTestPool().query(
      `INSERT INTO account_settings (tenant_id, account_id, allow_recording, analyze_calls, max_concurrent_calls)
       VALUES ($1, $2, true, true, 20), ($1, $3, true, true, 20)`,
      [tenant, account, sibling],
    );
    const provider = await insertTelephonyProvider();
    const number = await insertPhoneNumber({ provider_id: provider.id, phone_number: '+919000000098' });
    await insertPhoneAssignment({ tenant_id: tenant, phone_number_id: number.id, is_default: true });
    supervisor = await user(tenant, account, 'account_admin');

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

  // ── 1. The untagged pre-dial (§4.1 step 2) ──────────────────────────────────────────
  it('an untagged dial is refused by a campaign DNC entry of the account, and by a contact live on its campaigns', async () => {
    const agent = await user(tenant, account, 'agent');
    const campaign = await insertAgencyCampaign({ tenant_id: tenant, account_id: account });
    const elsewhere = await insertAgencyCampaign({ tenant_id: tenant, account_id: sibling });
    const { sessionId, station } = await openSoftphone(agent);

    // The row an agent's station mark writes by default: campaign scope, account_id NULL.
    await markDnc({ tenantId: tenant, campaignId: campaign.id as string, phoneE164: '+919811300001', reason: 'asked on a campaign call' });
    const refused = await post('/proxy/agency/softphone/calls', agent, { session_id: sessionId, to: '+919811300001' });
    expect(refused.statusCode, refused.body).toBe(409);
    const [entry] = await dncRows('+919811300001');
    expect(refused.json()).toMatchObject({ code: 'dnc_listed', entry: { id: entry.id, scope: 'campaign', reason: 'asked on a campaign call' } });
    // SP1 holds: the agent may override it with a note, which is stored against that entry.
    const overridden = await placeAndRingOut(agent, sessionId, station, '+919811300001', { overrides: { dnc_note: NOTE } });
    expect(await manualRow(overridden)).toMatchObject({ dnc_override_note: NOTE, dnc_override_entry_id: entry.id });

    // Another account's campaign entry does not reach this account's untagged dial.
    await markDnc({ tenantId: tenant, campaignId: elsewhere.id as string, phoneE164: '+919811300002' });
    await placeAndRingOut(agent, sessionId, station, '+919811300002');

    // A contact live on one of the account's campaigns: contact_in_flight, naming it; not claimed.
    const live = await insertAgencyContact(campaign.id as string, {
      tenant_id: tenant, account_id: account, phone_e164: '+919811300003', state: 'in_flight',
    });
    const busy = await post('/proxy/agency/softphone/calls', agent, { session_id: sessionId, to: '9811300003' });
    expect(busy.statusCode, busy.body).toBe(409);
    expect(busy.json()).toMatchObject({ code: 'contact_in_flight', campaign_id: campaign.id, contact_id: live.id });
    // On a sibling account's campaign it is not this account's customer call.
    await getTestPool().query('UPDATE agency_contacts SET state = $2 WHERE id = $1', [live.id, 'pending']);
    await insertAgencyContact(elsewhere.id as string, {
      tenant_id: tenant, account_id: sibling, phone_e164: '+919811300003', state: 'in_flight',
    });
    const placed = await placeAndRingOut(agent, sessionId, station, '9811300003');
    // Untagged: nothing claimed or linked.
    expect(await manualRow(placed)).toMatchObject({ contact_id: null, contact_claimed: false });
    const { rows: [after] } = await getTestPool().query('SELECT state FROM agency_contacts WHERE id = $1', [live.id]);
    expect(after.state).toBe('pending');

    expect((await post(`/proxy/agency/sessions/${sessionId}/leave`, agent)).statusCode).toBe(200);
  }, 40_000);

  // ── 2. The untagged mark is ACCOUNT-scoped, and audited on the DNC trail ─────────────
  it('Mark DNC on an untagged call writes an account row the account\'s dials read; dnc_entry.created once', async () => {
    const agent = await user(tenant, account, 'agent');
    const campaign = await insertAgencyCampaign({ tenant_id: tenant, account_id: account });
    const { sessionId, station } = await openSoftphone(agent);
    const phone = '+919811300010';

    const placed = await post('/proxy/agency/softphone/calls', agent, { session_id: sessionId, to: phone });
    expect(placed.statusCode, placed.body).toBe(201);
    const callId = placed.json().id as string;
    const marked = await post(`/proxy/agency/softphone/calls/${callId}/dnc`, agent, { reason: 'asked' });
    expect(marked.statusCode, marked.body).toBe(200);
    expect(marked.json()).toMatchObject({ call_id: callId, scope: 'account', dnc_recorded: true });
    const rows = await dncRows(phone);
    // Never tenant-wide (that is `agency.dnc.manage`'s): the call's account, no campaign.
    expect(rows).toEqual([expect.objectContaining({ account_id: account, campaign_id: null, source: 'agent', added_by: agent.id })]);

    // A second press finds it listed: recorded, but nothing new on the DNC trail.
    expect((await post(`/proxy/agency/softphone/calls/${callId}/dnc`, agent)).json()).toMatchObject({ scope: 'account', dnc_recorded: true });
    const trail = await auditRows('dnc_entry.created', rows[0].id);
    expect(trail).toHaveLength(1);
    expect(trail[0]).toMatchObject({
      tenant_id: tenant, account_id: account, user_id: agent.id, resource_type: 'dnc_entry', campaign_id: null,
    });
    expect(trail[0].details).toEqual({ manual_call_id: callId, scope: 'account' });
    const marks = await auditRows('agency_manual_call.dnc_marked', callId);
    expect(marks.map((r) => r.details)).toEqual([
      { scope: 'account', dnc_recorded: true }, { scope: 'account', dnc_recorded: true },
    ]);

    ringOut(await legOf(callId));
    await waitFor('settled frame', () => lastCall(station)?.settled_at);

    // The untagged pre-dial reads it…
    const again = await post('/proxy/agency/softphone/calls', agent, { session_id: sessionId, to: phone });
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ code: 'dnc_listed', entry: { id: rows[0].id, scope: 'account' } });
    // …and so does every campaign dial of the account (`pre-dial-gates`' scope), never another account's.
    const registry = new DncRegistry();
    expect(await registry.check(tenant, phone, { accountId: account, campaignId: campaign.id as string })).toBe('suppressed');
    expect(await registry.check(tenant, phone, { accountId: sibling, campaignId: null })).toBe('clear');

    expect((await post(`/proxy/agency/sessions/${sessionId}/leave`, agent)).statusCode).toBe(200);
  }, 40_000);

  it('a suppress outcome on an untagged call writes the account row and its DNC-trail row once; a replay writes neither again', async () => {
    const agent = await user(tenant, account, 'agent');
    const { sessionId, station } = await openSoftphone(agent);
    const phone = '+919811300020';
    const callId = await placeOwingAnOutcome(agent, sessionId, station, phone);

    const saved = await post(`/proxy/agency/softphone/calls/${callId}/disposition`, agent, { code: 'do_not_call' });
    expect(saved.statusCode, saved.body).toBe(200);
    const rows = await dncRows(phone);
    expect(rows).toEqual([expect.objectContaining({ account_id: account, campaign_id: null, source: 'agent' })]);
    const replay = await post(`/proxy/agency/softphone/calls/${callId}/disposition`, agent, { code: 'do_not_call' });
    expect(replay.statusCode, replay.body).toBe(200);
    expect(await dncRows(phone)).toHaveLength(1);

    const trail = await auditRows('dnc_entry.created', rows[0].id);
    expect(trail).toHaveLength(1);
    expect(trail[0].details).toEqual({ manual_call_id: callId, scope: 'account', disposition_code: 'do_not_call' });
    expect((await post(`/proxy/agency/sessions/${sessionId}/leave`, agent)).statusCode).toBe(200);
  }, 40_000);

  // ── 3. The flag switched off under an agent mid-call (§6) ──────────────────────────
  it('the flag off mid-call: details, hang-up, outcome and return still work; dial, open and switch are refused', async () => {
    const dimmed = (await insertAccount({ tenant_id: tenant })).id as string;
    await getTestPool().query(
      `INSERT INTO account_settings (tenant_id, account_id, allow_recording, analyze_calls, max_concurrent_calls)
       VALUES ($1, $2, true, true, 20)`, [tenant, dimmed]);
    const agent = await user(tenant, dimmed, 'agent');
    const campaign = await insertAgencyCampaign({ tenant_id: tenant, account_id: dimmed });
    const joined = await post('/proxy/agency/sessions', agent, { campaign_id: campaign.id });
    expect(joined.statusCode, joined.body).toBe(201);
    const sessionId = joined.json().session_id as string;
    const station = await connect(joined.json().station_ws_url);
    expect((await post(`/proxy/agency/sessions/${sessionId}/softphone`, agent)).statusCode).toBe(200);
    const placed = await post('/proxy/agency/softphone/calls', agent, { session_id: sessionId, to: '+919811300030' });
    expect(placed.statusCode, placed.body).toBe(201);
    const callId = placed.json().id as string;
    const leg = await legOf(callId);
    answer(leg);
    await waitFor('bridged', () => lastCall(station)?.state === 'bridged');

    // Mid-call, the flag goes off for the account.
    await getTestPool().query(
      `INSERT INTO feature_flag_overrides (flag_key, scope_type, tenant_id, account_id, value)
       VALUES ('agency_softphone_enabled', 'account', $1, $2, 'false'::jsonb)`, [tenant, dimmed]);
    await getFeatureFlagService().invalidate({ tenantId: tenant });

    // Starting anything new is refused…
    const dial = await post('/proxy/agency/softphone/calls', agent, { session_id: sessionId, to: '+919811300031' });
    expect(dial.statusCode).toBe(403);
    expect(dial.json().code).toBe('softphone_disabled');
    expect((await post('/proxy/agency/softphone/sessions', agent)).json().code).toBe('softphone_disabled');
    expect((await post(`/proxy/agency/sessions/${sessionId}/softphone`, agent)).json().code).toBe('softphone_disabled');
    // …and the console learns why, with the call it still has to finish.
    const boot = await get('/proxy/agency/softphone/bootstrap', agent);
    expect(boot.statusCode, boot.body).toBe(200);
    expect(boot.json()).toMatchObject({ softphone_enabled: false, session: { session_id: sessionId, on_softphone: true }, call: { id: callId } });

    // Finishing the call: details, hang-up, the reads, the outcome, Mark DNC, the return.
    expect((await patch(`/proxy/agency/softphone/calls/${callId}`, agent, { notes: 'Wrapping up' })).statusCode).toBe(200);
    expect((await post(`/proxy/agency/softphone/calls/${callId}/hangup`, agent)).statusCode).toBe(200);
    await carrierEnded(leg);
    await waitFor('awaiting outcome', () => lastCall(station)?.requires_disposition);
    expect((await get(`/proxy/agency/softphone/calls/${callId}`, agent)).statusCode).toBe(200);
    expect((await get('/proxy/agency/softphone/calls', agent)).json().rows.map((r: { id: string }) => r.id)).toEqual([callId]);
    const outcome = await post(`/proxy/agency/softphone/calls/${callId}/disposition`, agent, { code: 'voicemail' });
    expect(outcome.statusCode, outcome.body).toBe(200);
    expect((await post(`/proxy/agency/softphone/calls/${callId}/dnc`, agent)).statusCode).toBe(200);
    const back = await post(`/proxy/agency/sessions/${sessionId}/softphone/return`, agent);
    expect(back.statusCode, back.body).toBe(200);
    expect(back.json()).toMatchObject({ state: 'available', campaign_id: campaign.id });
    await runtime.agents.set(sessionId, 'break');
    expect((await post(`/proxy/agency/sessions/${sessionId}/leave`, agent)).statusCode).toBe(200);
  }, 40_000);

  // ── 4. Taggable campaigns (§6 bootstrap, `SoftphoneService.taggable`) ──────────────
  it('listSoftphoneTaggable: running and paused only, the staffing filter before the cap', async () => {
    const acct = (await insertAccount({ tenant_id: tenant })).id as string;
    const agentId = (await user(tenant, acct, 'agent')).id;
    const mk = async (status: string, staffed: boolean, minutesAgo: number) => {
      const c = await insertAgencyCampaign({
        tenant_id: tenant, account_id: acct, status, created_at: new Date(Date.now() - minutesAgo * 60_000),
      });
      if (staffed) await staff(c.id as string, agentId, acct);
      return c.id as string;
    };
    const oldRunning = await mk('running', true, 50);
    const paused = await mk('paused', true, 40);
    await mk('completed', true, 30);
    await mk('draft', true, 25);
    await mk('stopped', true, 22);
    // Newer than every staffed one, and not the agent's: under the old take-then-filter
    // these filled the cap first. (One running campaign per account: `uq_agency_campaign_running`.)
    const unstaffed = [await mk('paused', false, 10), await mk('paused', false, 5)];
    const ask = (staffedUserId: string | null, limit: number) => agencyCampaignRepository
      .listSoftphoneTaggable(tenant, acct, { statuses: ['running', 'paused'], staffedUserId, limit })
      .then((rows) => rows.map((r) => r.id));
    expect(await ask(agentId, 500)).toEqual([paused, oldRunning]);
    expect(await ask(agentId, 2)).toEqual([paused, oldRunning]);
    expect(await ask(agentId, 1)).toEqual([paused]);
    expect(await ask(null, 500)).toEqual([...unstaffed].reverse().concat([paused, oldRunning]));
  });

  it('a draft or completed campaign cannot be tagged; a paused one can; bootstrap lists the same', async () => {
    const acct = await freshAccount();
    const agent = await user(tenant, acct, 'agent');
    const sup = await user(tenant, acct, 'account_admin');
    const running = await insertAgencyCampaign({ tenant_id: tenant, account_id: acct, status: 'running' });
    const paused = await insertAgencyCampaign({ tenant_id: tenant, account_id: acct, status: 'paused' });
    const completed = await insertAgencyCampaign({ tenant_id: tenant, account_id: acct, status: 'completed' });
    const draft = await insertAgencyCampaign({ tenant_id: tenant, account_id: acct, status: 'draft' });
    for (const c of [running, paused, completed, draft]) await staff(c.id as string, agent.id, acct);
    const { sessionId, station } = await openSoftphone(agent);

    const boot = await get('/proxy/agency/softphone/bootstrap', agent);
    expect(boot.json().taggable_campaigns.map((c: { campaign_id: string }) => c.campaign_id).sort())
      .toEqual([running.id, paused.id].sort());
    for (const c of [completed, draft]) {
      const refused = await post('/proxy/agency/softphone/calls', agent, { session_id: sessionId, to: '+919811300040', campaign_id: c.id });
      expect(refused.statusCode, `${c.status as string}`).toBe(403);
      expect(refused.json().code).toBe('campaign_not_taggable');
    }
    // A supervisor's whole-account reach does not widen the status rule.
    const supBoot = await get('/proxy/agency/softphone/bootstrap', sup);
    const supIds = supBoot.json().taggable_campaigns.map((c: { campaign_id: string }) => c.campaign_id);
    expect(supIds).toEqual(expect.arrayContaining([running.id, paused.id]));
    expect(supIds).not.toContain(completed.id);
    expect(supIds).not.toContain(draft.id);

    await placeAndRingOut(agent, sessionId, station, '+919811300041', { campaign_id: paused.id });
    expect((await post(`/proxy/agency/sessions/${sessionId}/leave`, agent)).statusCode).toBe(200);
  }, 40_000);

  it('a tagged call whose campaign completes mid-call: bootstrap still describes it, and the outcome saves', async () => {
    const acct = await freshAccount();
    const agent = await user(tenant, acct, 'agent');
    const campaign = await insertAgencyCampaign({
      tenant_id: tenant, account_id: acct, status: 'running', disposition_catalog: CATALOG,
    });
    await staff(campaign.id as string, agent.id, acct);
    const { sessionId, station } = await openSoftphone(agent);
    const callId = await placeOwingAnOutcome(agent, sessionId, station, '+919811300050', { campaign_id: campaign.id });

    await getTestPool().query(`UPDATE agency_campaigns SET status = 'completed' WHERE id = $1`, [campaign.id]);
    // The console reloads: the campaign is no longer a tag to choose, but it is the call's.
    const boot = await get('/proxy/agency/softphone/bootstrap', agent);
    expect(boot.json().taggable_campaigns.map((c: { campaign_id: string }) => c.campaign_id)).not.toContain(campaign.id);
    expect(boot.json().call).toMatchObject({ id: callId, tag: { campaign_id: campaign.id } });
    expect(boot.json().call_campaign).toMatchObject({
      campaign_id: campaign.id, status: 'completed',
      disposition_catalog: [expect.objectContaining({ code: 'renewed' }), expect.objectContaining({ code: 'call_back' })],
    });
    const saved = await post(`/proxy/agency/softphone/calls/${callId}/disposition`, agent, { code: 'renewed' });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json().call).toMatchObject({ disposition_code: 'renewed', disposition_source: 'campaign' });
    expect((await get('/proxy/agency/softphone/bootstrap', agent)).json()).toMatchObject({ call: null, call_campaign: null });
    expect((await post(`/proxy/agency/sessions/${sessionId}/leave`, agent)).statusCode).toBe(200);
  }, 40_000);

  // ── A7: an override note's length is counted in characters, as the CHECK counts it ──
  it('an override note is counted in characters: 9 + an emoji is refused cleanly, 499 + an emoji is stored', async () => {
    const agent = await user(tenant, account, 'agent');
    const { sessionId, station } = await openSoftphone(agent);
    await getTestPool().query(
      `INSERT INTO dnc_entries (tenant_id, phone_e164, source, reason) VALUES ($1, '+919811300060', 'import', 'listed')`, [tenant]);
    // Ten UTF-16 units, nine characters: the database CHECK would refuse it (a 500), so
    // the pre-dial does, with its own 400.
    const short = await post('/proxy/agency/softphone/calls', agent, {
      session_id: sessionId, to: '+919811300060', overrides: { dnc_note: '12345678😀' },
    });
    expect(short.statusCode, short.body).toBe(400);
    expect(short.json().code).toBe('override_note_invalid');
    // 501 units, 500 characters: within the CHECK, so placed and stored as written.
    const long = `${'x'.repeat(499)}😀`;
    const callId = await placeAndRingOut(agent, sessionId, station, '+919811300060', { overrides: { dnc_note: long } });
    const { rows: [stored] } = await getTestPool().query(
      'SELECT dnc_override_note, char_length(dnc_override_note) AS n FROM agency_manual_calls WHERE id = $1', [callId]);
    expect(stored).toEqual({ dnc_override_note: long, n: 500 });
    expect((await post(`/proxy/agency/sessions/${sessionId}/leave`, agent)).statusCode).toBe(200);
  }, 40_000);

  it('PUT /settings refuses a reserved call-field key with settings_invalid on its path', async () => {
    const res = await app.inject({
      method: 'PUT', url: '/proxy/agency/softphone/settings', headers: headers(supervisor),
      payload: JSON.stringify({
        disposition_catalog: [], analysis_profile_id: null, record_calls: false, default_caller_id: null,
        call_fields: [{ key: 'constructor', label: 'Constructor', type: 'text', required: true }],
      }),
    });
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json()).toMatchObject({ code: 'settings_invalid', details: [{ path: 'call_fields[0].key' }] });
  });

  // ── 5. The outcome replay (A9) ─────────────────────────────────────────────────────
  it('a replay with a corrected callback moves the contact\'s next attempt; nothing else runs twice', async () => {
    const acct = await freshAccount();
    const agent = await user(tenant, acct, 'agent');
    const campaign = await insertAgencyCampaign({ tenant_id: tenant, account_id: acct, status: 'running', disposition_catalog: CATALOG });
    await staff(campaign.id as string, agent.id, acct);
    const contact = await insertAgencyContact(campaign.id as string, { tenant_id: tenant, account_id: acct, phone_e164: '+919811300070' });
    const { sessionId, station } = await openSoftphone(agent);
    const callId = await placeOwingAnOutcome(agent, sessionId, station, '+919811300070', { campaign_id: campaign.id });

    const first = new Date(Date.now() + 2 * 3600_000).toISOString();
    const saved = await post(`/proxy/agency/softphone/calls/${callId}/disposition`, agent, { code: 'call_back', callback_at: first });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json()).toMatchObject({ contact_state: 'pending', next_attempt_at: first });
    const contactRow = async () => (await getTestPool().query(
      'SELECT state, next_attempt_at, attempt_count, last_disposition FROM agency_contacts WHERE id = $1', [contact.id])).rows[0];
    const afterFirst = await contactRow();
    expect(afterFirst).toMatchObject({ state: 'pending', attempt_count: 1, last_disposition: 'call_back' });
    expect(afterFirst.next_attempt_at.toISOString()).toBe(first);

    const release = vi.spyOn(runtime.agents, 'releaseManual');
    const corrected = new Date(Date.now() + 26 * 3600_000).toISOString();
    const replay = await post(`/proxy/agency/softphone/calls/${callId}/disposition`, agent, { code: 'call_back', callback_at: corrected, notes: 'Tomorrow instead' });
    expect(replay.statusCode, replay.body).toBe(200);
    expect(replay.json()).toMatchObject({
      contact_state: 'pending', next_attempt_at: corrected, callback_requested_at: corrected,
      call: { callback_at: corrected, notes: 'Tomorrow instead', disposition_code: 'call_back' },
    });
    // The callback time reached the roster contact; the attempt was not charged again.
    const afterReplay = await contactRow();
    expect(afterReplay).toMatchObject({ state: 'pending', attempt_count: 1 });
    expect(afterReplay.next_attempt_at.toISOString()).toBe(corrected);
    expect((await manualRow(callId)).callback_at.toISOString()).toBe(corrected);
    // No second claim release, and the settling audit row is written once (the replay's
    // own row says it is one).
    expect(release.mock.calls.filter(([, id]) => id === callId)).toHaveLength(0);
    release.mockRestore();
    const rows = await auditRows('agency_manual_call.dispositioned', callId);
    expect(rows.map((r) => r.details.replay ?? false)).toEqual([false, true]);
    expect(await auditRows('dnc_entry.created')).toEqual(expect.not.arrayContaining([
      expect.objectContaining({ details: expect.objectContaining({ manual_call_id: callId }) }),
    ]));

    // A contact pacing has claimed since is left alone by a later correction.
    await getTestPool().query(`UPDATE agency_contacts SET state = 'in_flight' WHERE id = $1`, [contact.id]);
    const late = new Date(Date.now() + 50 * 3600_000).toISOString();
    expect((await post(`/proxy/agency/softphone/calls/${callId}/disposition`, agent, { code: 'call_back', callback_at: late })).statusCode).toBe(200);
    expect((await contactRow()).next_attempt_at.toISOString()).toBe(corrected);
    await getTestPool().query(`UPDATE agency_contacts SET state = 'pending' WHERE id = $1`, [contact.id]);
    expect((await post(`/proxy/agency/sessions/${sessionId}/leave`, agent)).statusCode).toBe(200);
  }, 40_000);

  it('a supervisor reads it on the DNC list as an account entry', async () => {
    const list = await get('/dnc?phone=%2B919811300010', supervisor);
    expect(list.statusCode, list.body).toBe(200);
    const entries = list.json().entries as Array<{ account_id: string | null; campaign_id: string | null }>;
    expect(entries).toEqual([expect.objectContaining({ account_id: account, campaign_id: null })]);
  });
});
