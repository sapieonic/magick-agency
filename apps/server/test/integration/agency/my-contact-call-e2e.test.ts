import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * The agent's dial of one of their own contacts, end to end: the real app over HTTP (the public
 * route, `callCore`, the internal handler), the real runtime, bridge, Redis and Postgres; only
 * the carrier is faked (as `wrapup-redial-e2e.test.ts` does).
 *
 *  1. An exhausted contact the agent did not reach is dialled from their list: a round is spent,
 *     the call arrives on the station as a paced one does (`reserved`, `bridged`, wrap-up), the
 *     outcome is saved on it, and the attempt says `agent_manual`. Audited.
 *  2. Outside the calling window: a contact holding a calling-hours override is refused without
 *     a note (`override_note_invalid`), dialled with one (both overrides spent, the note on the
 *     attempt), and can never spend it twice; a DNC-listed contact holding EVERY override is
 *     refused `dnc_listed` and nothing is written.
 *
 * Mutation-checked: making the gate option skip the DNC check (the `callingHoursOverridden`
 * arm returning `dial` before DNC) reds the `dnc_listed` assertion here and in
 * `pre-dial-gates-hours-override.test.ts`.
 */

const mocks = vi.hoisted(() => {
  process.env['SUPER_ADMIN_JWT_SECRET'] = 'my-contact-call-e2e-secret-0123456789';
  process.env['FF_AGENCY_DIALER'] = 'true';
  process.env['FF_AGENCY_CONTACT_ASSIGNMENT'] = 'true';
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
import WebSocket from 'ws';
import type { FastifyInstance } from 'fastify';
import { closePool, getPool, initDbPool } from '@magick-agency/db';
import { TEST_DB_URL, closeTestPool, getTestPool, truncateAll } from '../../../../../packages/db/test/helpers/test-db.js';
import {
  insertAccount,
  insertMembership,
  insertTenant,
  insertUser,
} from '../../../../../packages/db/test/integration/setup/platform-factories.js';
import { closeTestRedis, flushTestRedis, getTestRedis } from '../../helpers/test-redis.js';
import { insertAgencyAttempt, insertAgencyCampaign, insertAgencyContact } from './agency-factories.js';
import { config } from '../../../src/config/index.js';
import { buildApp } from '../../../src/app.js';
import type { AppContext } from '../../../src/app-context.js';
import { getAgencyRuntime, resetAgencyRuntimeForTests, startAgency } from '../../../src/bootstrap/agency.js';
import { getVoiceEngine, resetVoiceEngineForTests, startVoice } from '../../../src/bootstrap/voice.js';
import type { AgencyRuntime } from '../../../src/agency/runtime.js';
import { agencyAttemptRepository } from '../../../src/db/repositories/agency.repository.js';
import { platformAuditLogger } from '../../../src/audit/platform/audit-logger.js';

const CATALOG = JSON.stringify([
  { code: 'interested', label: 'Interested', is_success: true, terminal: true },
  { code: 'callback', label: 'Call back', requires_datetime: true },
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
type Frame = Record<string, any>;

describe('an agent dials one of their own contacts — real app, real runtime, fake carrier (integration)', () => {
  let app: FastifyInstance;
  let port = 0;
  let stopAgency: (() => Promise<void>) | null = null;
  let stopVoice: (() => Promise<void>) | null = null;
  let runtime: AgencyRuntime;
  const sockets: WebSocket[] = [];
  let tenant: string;
  let account: string;
  let agent: Who;

  function headers(who: Who): Record<string, string> {
    return { authorization: `Bearer ${who.tok}`, 'x-tenant-id': tenant, 'x-account-id': account, 'content-type': 'application/json' };
  }
  const post = (url: string, who: Who, body: unknown = {}) =>
    app.inject({ method: 'POST', url, headers: headers(who), payload: JSON.stringify(body) });

  function answer(callId: string): void {
    const pstn = new FakePstnSocket();
    expect(getVoiceEngine()!.bridge.attachPstnLeg(callId, pstn as never)).toBe(true);
    pstn.emit('message', JSON.stringify({
      event: 'start',
      start: { call_sid: `carrier-${callId}`, stream_sid: 's1', media_format: { encoding: 'audio/alaw', sample_rate: '8000' } },
    }));
  }
  async function customerHangsUp(callId: string): Promise<void> {
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
  const legOf = (attemptId: string) => waitFor('media leg', async () =>
    (await agencyAttemptRepository.findById(attemptId))?.webrtc_call_id ?? null);
  const contactRow = async (id: string) => (await getTestPool().query<{
    state: string; attempt_count: number; agent_retry_rounds_used: number;
    override_retry_delay: boolean; override_calling_hours: boolean; override_extra_attempts: number;
  }>(
    `SELECT state, attempt_count, agent_retry_rounds_used, override_retry_delay, override_calling_hours, override_extra_attempts
       FROM agency_contacts WHERE id = $1`, [id])).rows[0]!;

  /** Close the running campaign and every live session, so a new one can run. */
  async function reset(): Promise<void> {
    await getTestPool().query("UPDATE agency_campaigns SET status = 'completed' WHERE account_id = $1 AND status = 'running'", [account]);
    for (const ws of sockets.splice(0)) {
      if (ws.readyState !== WebSocket.CLOSED) {
        const closed = new Promise<void>((resolve) => ws.once('close', () => resolve()));
        ws.close();
        await closed;
      }
    }
    const { rows: live } = await getTestPool().query<{ id: string }>(
      'SELECT id FROM agency_agent_sessions WHERE agent_user_id = $1 AND left_at IS NULL', [agent.id]);
    for (const s of live) await post(`/proxy/agency/sessions/${s.id}/leave`, agent);
  }

  /** Join, open the station, go available. */
  async function station(campaignId: string): Promise<{ sessionId: string; frames: Frame[] }> {
    await getTestPool().query(
      `INSERT INTO agency_campaign_agents (tenant_id, account_id, campaign_id, user_id) VALUES ($1, $2, $3, $4)`,
      [tenant, account, campaignId, agent.id],
    );
    const joined = await post('/proxy/agency/sessions', agent, { campaign_id: campaignId });
    expect(joined.statusCode, joined.body).toBeLessThan(300);
    const boot = joined.json();
    const frames: Frame[] = [];
    const ws = new WebSocket(`ws://127.0.0.1:${port}${boot.station_ws_url}`);
    sockets.push(ws);
    ws.on('message', (raw, isBinary) => { if (!isBinary) frames.push(JSON.parse(raw.toString())); });
    await waitFor('ready', () => frames.find((f) => f['event'] === 'ready'));
    const avail = await post(`/proxy/agency/sessions/${boot.session_id}/available`, agent);
    expect(avail.statusCode, avail.body).toBe(200);
    return { sessionId: boot.session_id as string, frames };
  }

  beforeAll(async () => {
    initDbPool({ url: TEST_DB_URL, poolMin: 0, poolMax: 8 });
    mocks.verifyIdToken.mockImplementation(async (token: string) => {
      if (!token.startsWith('tok:')) throw new Error('bad token');
      return { uid: token.slice(4), email: 'mycall@example.com', email_verified: true };
    });
    await truncateAll();
    await flushTestRedis();
    resetVoiceEngineForTests();
    await resetAgencyRuntimeForTests();

    tenant = (await insertTenant()).id as string;
    account = (await insertAccount({ tenant_id: tenant })).id as string;
    await getTestPool().query(
      `INSERT INTO account_settings (tenant_id, account_id, allow_recording, analyze_calls, max_concurrent_calls)
       VALUES ($1, $2, false, false, 20)`,
      [tenant, account],
    );
    const u = await insertUser();
    await insertMembership({ user_id: u.id, tenant_id: tenant, account_id: account, role: 'agent' });
    agent = { id: u.id as string, tok: `tok:${u.firebase_uid as string}` };

    const ctx: AppContext = { config, pool: getPool(), redis: getTestRedis() };
    app = await buildApp({ ctx });
    await app.listen({ port: 0, host: '127.0.0.1' });
    port = (app.server.address() as { port: number }).port;
    stopVoice = await startVoice(ctx);
    stopAgency = await startAgency(ctx);
    runtime = getAgencyRuntime()!;
  });

  afterAll(async () => {
    await reset().catch(() => undefined);
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

  it('1. dials a not-reached contact on the campaign path: a round spent, the call like a paced one, the outcome saved, audited', async () => {
    const campaign = await insertAgencyCampaign({
      tenant_id: tenant, account_id: account, status: 'running',
      wrapup_seconds: 60, wrapup_auto_return: true, disposition_catalog: CATALOG,
      allow_agent_retry: true, agent_retry_rounds: 1, agent_retry_cooldown_minutes: 30,
    });
    const phone = '+919812350001';
    const contact = await insertAgencyContact(campaign.id, {
      tenant_id: tenant, account_id: account, phone_e164: phone,
      state: 'exhausted', attempt_count: 3, last_outcome: 'no_answer',
      assigned_user_id: agent.id, assigned_at: new Date(),
    });
    // Scheduled work keeps the campaign running. Without it the campaign's only contact is
    // exhausted, `countOutstanding` is 0, and the pacing leader completes the campaign on its
    // first idle tick: the call below then raced that tick and lost with 409
    // `campaign_not_running` whenever the leader picked the campaign up first. Due tomorrow,
    // so pacing has nothing to dial now either.
    await insertAgencyContact(campaign.id, {
      tenant_id: tenant, account_id: account, phone_e164: '+919812350009',
      state: 'pending', next_attempt_at: new Date(Date.now() + 86_400_000),
    });
    const hourAgo = new Date(Date.now() - 3_600_000);
    await insertAgencyAttempt(campaign.id, contact.id, {
      tenant_id: tenant, account_id: account, attempt_number: 3, state: 'ended', outcome: 'no_answer',
      created_at: hourAgo, ended_at: hourAgo,
    });
    const { sessionId, frames } = await station(campaign.id);
    // Pacing has nothing to dial: the contact is exhausted.
    await new Promise((r) => setTimeout(r, 400));
    expect(frames.find((f) => f['event'] === 'reserved')).toBeUndefined();

    const res = await post(`/proxy/agency/my-contacts/${contact.id}/call`, agent, { campaign_id: campaign.id, session_id: sessionId });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(body).toEqual({ attempt_id: expect.any(String), contact_id: contact.id, override_applied: [], retry_round_spent: true });
    const attemptId = body.attempt_id as string;

    // The station sees a call as it sees a paced one.
    const reserved = await waitFor('reserved', () => frames.find((f) => f['event'] === 'reserved')?.['attempt']);
    expect(reserved).toMatchObject({ attempt_id: attemptId, contact_id: contact.id });
    await waitFor('carrier dial', () => mocks.fakeAdapter.initiateCall.mock.calls.length >= 1);
    expect((mocks.fakeAdapter.initiateCall.mock.calls.at(-1)![0] as unknown as { to: string }).to).toBe(phone);
    expect(await contactRow(contact.id)).toMatchObject({ state: 'in_flight', agent_retry_rounds_used: 1 });
    const att = await agencyAttemptRepository.findById(attemptId);
    expect(att).toMatchObject({ reserved_agent_id: sessionId, attempt_number: 4 });
    const { rows: [flags] } = await getTestPool().query(
      'SELECT agent_manual, override_applied, override_note FROM agency_call_attempts WHERE id = $1', [attemptId]);
    expect(flags).toEqual({ agent_manual: true, override_applied: [], override_note: null });

    // A second dial while it is live is refused.
    const again = await post(`/proxy/agency/my-contacts/${contact.id}/call`, agent, { campaign_id: campaign.id, session_id: sessionId });
    expect(again.statusCode).toBe(409);

    const leg = await legOf(attemptId);
    answer(leg);
    await waitFor('bridged', () => frames.find((f) => f['event'] === 'bridged'));
    await customerHangsUp(leg);
    await waitFor('wrap-up', () => frames.find((f) => f['event'] === 'wrapup' && f['wrapup'].attempt_id === attemptId));
    const saved = await post(`/proxy/agency/attempts/${attemptId}/disposition`, agent, { disposition_code: 'interested' });
    expect(saved.statusCode, saved.body).toBe(200);
    await waitFor('available', async () => (await runtime.agents.get(sessionId))?.state === 'available');
    expect(await contactRow(contact.id)).toMatchObject({ state: 'completed', attempt_count: 4 });

    // One audit row, ids only.
    await platformAuditLogger.shutdown(); // flushes the buffer
    const audit = await waitFor('audit row', async () => (await getTestPool().query(
      `SELECT user_id, resource_type, resource_id, campaign_id, details FROM platform_audit_log
        WHERE action = 'agency_contact.agent_dialed'`)).rows[0]);
    expect(audit).toMatchObject({
      user_id: agent.id, resource_type: 'agency_contact', resource_id: contact.id, campaign_id: campaign.id,
      details: { attempt_id: attemptId, session_id: sessionId, basis: 'retry_round', override_applied: [], retry_round_spent: true },
    });
  }, 60_000);

  it('2. outside calling hours: the override needs a note and is spent once; DNC is refused whatever the contact holds', async () => {
    await reset();
    // Closed all day today: the window's days leave out today (ISO weekday, UTC).
    const today = ((new Date().getUTCDay() + 6) % 7) + 1;
    const campaign = await insertAgencyCampaign({
      tenant_id: tenant, account_id: account, status: 'running',
      wrapup_seconds: 0, wrapup_auto_return: true, disposition_catalog: CATALOG,
      calling_days: [1, 2, 3, 4, 5, 6, 7].filter((d) => d !== today), default_timezone: 'UTC',
    });
    const later = new Date(Date.now() + 86_400_000);
    // A callback booked for tomorrow, granted a retry-delay and a calling-hours override:
    // not due, so pacing never takes it.
    const granted = await insertAgencyContact(campaign.id, {
      tenant_id: tenant, account_id: account, phone_e164: '+919812350002',
      state: 'pending', attempt_count: 1, last_outcome: 'connected', last_disposition: 'callback', next_attempt_at: later,
      assigned_user_id: agent.id, assigned_at: new Date(),
      override_disposition: 'callback', override_retry_delay: true, override_calling_hours: true, override_granted_at: new Date(),
    });
    const dncPhone = '+919812350003';
    const listed = await insertAgencyContact(campaign.id, {
      tenant_id: tenant, account_id: account, phone_e164: dncPhone,
      state: 'pending', attempt_count: 1, last_outcome: 'connected', last_disposition: 'callback', next_attempt_at: later,
      assigned_user_id: agent.id, assigned_at: new Date(),
      override_disposition: 'callback', override_retry_delay: true, override_calling_hours: true, override_extra_attempts: 5,
    });
    await getTestPool().query(
      `INSERT INTO dnc_entries (tenant_id, account_id, campaign_id, phone_e164, source) VALUES ($1, $2, $3, $4, 'agent')`,
      [tenant, account, campaign.id, dncPhone],
    );
    const { sessionId, frames } = await station(campaign.id);
    const callIt = (id: string, note?: string) => post(`/proxy/agency/my-contacts/${id}/call`, agent, {
      campaign_id: campaign.id, session_id: sessionId, ...(note ? { override_note: note } : {}),
    });
    const NOTE = 'Customer asked for a call after hours today.';

    // ── DNC wins over every override, with the note. Nothing written, agent untouched. ──
    const dnc = await callIt(listed.id, NOTE);
    expect(dnc.statusCode, dnc.body).toBe(409);
    expect(dnc.json().code).toBe('dnc_listed');
    expect(await contactRow(listed.id)).toMatchObject({
      state: 'pending', override_calling_hours: true, override_retry_delay: true, override_extra_attempts: 5,
    });
    expect((await getTestPool().query('SELECT count(*)::int AS n FROM agency_call_attempts WHERE contact_id = $1', [listed.id])).rows[0].n).toBe(0);
    expect((await runtime.agents.get(sessionId))?.state).toBe('available');

    // ── No note: the override is there, but not without the agent's reason. ──
    const noNote = await callIt(granted.id);
    expect(noNote.statusCode, noNote.body).toBe(400);
    expect(noNote.json()).toMatchObject({ code: 'override_note_invalid', details: { min: 10, max: 500 } });
    expect(await contactRow(granted.id)).toMatchObject({ state: 'pending', override_calling_hours: true });

    // ── With a note: dialled, both overrides spent, the note on the attempt. ──
    const ok = await callIt(granted.id, `  ${NOTE}  `);
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json()).toMatchObject({ override_applied: ['retry_delay', 'calling_hours'], retry_round_spent: false });
    const attemptId = ok.json().attempt_id as string;
    const { rows: [att] } = await getTestPool().query(
      'SELECT agent_manual, override_applied, override_note FROM agency_call_attempts WHERE id = $1', [attemptId]);
    expect(att).toEqual({ agent_manual: true, override_applied: ['retry_delay', 'calling_hours'], override_note: NOTE });
    expect(await contactRow(granted.id)).toMatchObject({ state: 'in_flight', override_calling_hours: false, override_retry_delay: false });

    // Not answered: settled by the retry policy like any dial, the agent back in the pool.
    await waitFor('reserved', () => frames.find((f) => f['event'] === 'reserved' && f['attempt'].attempt_id === attemptId));
    ringOut(await legOf(attemptId));
    await waitFor('ended', async () => (await agencyAttemptRepository.findById(attemptId))?.state === 'ended');
    await waitFor('available', async () => (await runtime.agents.get(sessionId))?.state === 'available');
    expect((await contactRow(granted.id)).state).not.toBe('in_flight');

    // ── Spent once: a second closed-window dial has nothing to spend. ──
    await getTestPool().query(`UPDATE agency_contacts SET state = 'pending', next_attempt_at = now() WHERE id = $1`, [granted.id]);
    const twice = await callIt(granted.id, NOTE);
    expect(twice.statusCode, twice.body).toBe(409);
    expect(twice.json()).toMatchObject({ code: 'outside_calling_hours', details: { next_open_at: expect.any(String) } });
  }, 60_000);
});
