import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * Wrap-up redial end to end: the real app over HTTP (the public route, through the
 * internal handler), the real runtime, bridge, Redis and Postgres; only the carrier is
 * faked (as `runtime-e2e.test.ts` and `softphone-routes.test.ts` do).
 *
 * One agent, one customer, the whole chain the ticket's acceptance names:
 *   call connects → wrap-up offers 2 redials → redial #1 rings out → wrap-up on the
 *   redial (1 left), customer still held, retry budget untouched → DNC refuses a redial
 *   and the agent stays in wrap-up → redial #2 connects → wrap-up with 0 left → the 3rd
 *   is refused → the outcome is saved on the last call → the agent is available, and
 *   the history reads original (`redialed`) → redial 1 (`redialed`) → redial 2 (outcome).
 */

const mocks = vi.hoisted(() => {
  process.env['SUPER_ADMIN_JWT_SECRET'] = 'wrapup-redial-e2e-secret-0123456789';
  process.env['FF_AGENCY_DIALER'] = 'true';
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
import { insertAgencyCampaign, insertAgencyContact } from './agency-factories.js';
import { config } from '../../../src/config/index.js';
import { buildApp } from '../../../src/app.js';
import type { AppContext } from '../../../src/app-context.js';
import { getAgencyRuntime, resetAgencyRuntimeForTests, startAgency } from '../../../src/bootstrap/agency.js';
import { getVoiceEngine, resetVoiceEngineForTests, startVoice } from '../../../src/bootstrap/voice.js';
import type { AgencyRuntime } from '../../../src/agency/runtime.js';
import { agencyAttemptRepository } from '../../../src/db/repositories/agency.repository.js';
import { publishPacingInvalidation } from '../../../src/agency/pacing/invalidation-bus.js';

const CATALOG = JSON.stringify([
  { code: 'interested', label: 'Interested', is_success: true, terminal: true },
]);
const PHONE = '+919812340001';

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

describe('wrap-up redial — real app, real runtime, fake carrier (integration)', () => {
  let app: FastifyInstance;
  let port = 0;
  let stopAgency: (() => Promise<void>) | null = null;
  let stopVoice: (() => Promise<void>) | null = null;
  let runtime: AgencyRuntime;
  let station: WebSocket | null = null;
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
  const contactRow = async (id: string) => (await getTestPool().query<{ state: string; attempt_count: number; last_outcome: string | null }>(
    'SELECT state, attempt_count, last_outcome FROM agency_contacts WHERE id = $1', [id])).rows[0]!;

  beforeAll(async () => {
    initDbPool({ url: TEST_DB_URL, poolMin: 0, poolMax: 8 });
    mocks.verifyIdToken.mockImplementation(async (token: string) => {
      if (!token.startsWith('tok:')) throw new Error('bad token');
      return { uid: token.slice(4), email: 'redial@example.com', email_verified: true };
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
    if (station && station.readyState !== WebSocket.CLOSED) {
      const closed = new Promise<void>((resolve) => station!.once('close', () => resolve()));
      station.close();
      await closed;
      await new Promise((r) => setTimeout(r, 200));
    }
    if (stopAgency) await stopAgency();
    if (stopVoice) await stopVoice();
    await app?.close();
    await resetAgencyRuntimeForTests();
    resetVoiceEngineForTests();
    await closePool();
    await closeTestPool();
    await closeTestRedis();
  });

  it('redials the same customer to the same agent, twice at most, and keeps the outcome owed', async () => {
    const campaign = await insertAgencyCampaign({
      tenant_id: tenant, account_id: account, status: 'running',
      wrapup_seconds: 60, wrapup_auto_return: true, disposition_catalog: CATALOG,
      allow_wrapup_redial: true,
    });
    const contact = await insertAgencyContact(campaign.id, { tenant_id: tenant, account_id: account, phone_e164: PHONE });
    await getTestPool().query(
      `INSERT INTO agency_campaign_agents (tenant_id, account_id, campaign_id, user_id) VALUES ($1, $2, $3, $4)`,
      [tenant, account, campaign.id, agent.id],
    );

    // ── Join (the bootstrap says redial is on), station, available. ──────────────
    const joined = await post('/proxy/agency/sessions', agent, { campaign_id: campaign.id });
    expect(joined.statusCode, joined.body).toBeLessThan(300);
    const boot = joined.json();
    expect(boot.allow_wrapup_redial).toBe(true);
    const sessionId = boot.session_id as string;
    const frames: Frame[] = [];
    station = new WebSocket(`ws://127.0.0.1:${port}${boot.station_ws_url}`);
    station.on('message', (raw, isBinary) => { if (!isBinary) frames.push(JSON.parse(raw.toString())); });
    await waitFor('ready', () => frames.find((f) => f['event'] === 'ready'));
    const avail = await post(`/proxy/agency/sessions/${sessionId}/available`, agent);
    expect(avail.statusCode, avail.body).toBe(200);

    const lastOf = (event: string) => [...frames].reverse().find((f) => f['event'] === event);
    const wrapupFor = (attemptId: string) => waitFor(`wrap-up on ${attemptId}`, () =>
      [...frames].reverse().find((f) => f['event'] === 'wrapup' && f['wrapup'].attempt_id === attemptId)?.['wrapup']);
    const reservedFor = (n: number) => waitFor(`reserved #${n}`, () =>
      frames.filter((f) => f['event'] === 'reserved')[n - 1]?.['attempt']);
    const redial = (attemptId: string) => post(`/proxy/agency/sessions/${sessionId}/redial`, agent, { attempt_id: attemptId });

    // ── 1. The paced call connects, the customer hangs up: wrap-up offers 2 redials. ─
    const first = await reservedFor(1);
    expect(first.redial).toBeUndefined();
    const firstId = first.attempt_id as string;
    const firstLeg = await legOf(firstId);
    answer(firstLeg);
    await waitFor('bridged', () => lastOf('bridged'));
    await customerHangsUp(firstLeg);
    const w1 = await wrapupFor(firstId);
    expect(w1.redial_remaining).toBe(2);
    expect(w1.requires_disposition).toBe(true);
    expect((await runtime.agents.get(sessionId))?.state).toBe('wrapup');
    const charged = (await contactRow(contact.id)).attempt_count;

    // Notes typed so far travel with the conversation onto the redial.
    const noted = await post(`/proxy/agency/attempts/${firstId}/notes`, agent, { notes: 'line dropped mid-sentence' });
    expect(noted.statusCode, noted.body).toBe(200);

    // ── 2. Redial #1: the countdown stops, the original closes `redialed`. ────────
    const r1 = await redial(firstId);
    expect(r1.statusCode, r1.body).toBe(200);
    expect(r1.json()).toMatchObject({ session_id: sessionId, redial_of_attempt_id: firstId, redial_number: 1, redial_remaining: 1 });
    const secondId = r1.json().attempt_id as string;
    expect(runtime.wrapup.stateFor(sessionId)).toBeNull();
    const second = await reservedFor(2);
    expect(second.attempt_id).toBe(secondId);
    expect(second.contact_id).toBe(contact.id);
    expect(second.redial).toEqual({ of_attempt_id: firstId, number: 1, remaining: 1 });
    await waitFor('second carrier dial', () => mocks.fakeAdapter.initiateCall.mock.calls.length >= 2);
    expect((mocks.fakeAdapter.initiateCall.mock.calls[1]![0] as unknown as { to: string }).to).toBe(PHONE);
    const original = await waitFor('original closed', async () => {
      const a = await agencyAttemptRepository.findById(firstId);
      return a?.wrapup_resolution ? a : null;
    });
    expect(original).toMatchObject({ outcome: 'connected', disposition_code: 'redialed', wrapup_resolution: 'redialed' });
    // A second press on the same wrap-up is refused: its outcome is now `redialed`.
    expect((await redial(firstId)).json().code).toBe('disposition_already_submitted');

    // ── 3. Redial #1 rings out: back in wrap-up ON THE REDIAL, customer still held. ─
    ringOut(await legOf(secondId));
    const w2 = await wrapupFor(secondId);
    expect(w2.redial_remaining).toBe(1);
    expect(w2.requires_disposition).toBe(true);
    const released2 = await waitFor('released for redial #1', () =>
      frames.find((f) => f['event'] === 'released' && f['attempt_id'] === secondId));
    expect(released2['requires_disposition']).toBe(true);
    expect((await runtime.agents.get(sessionId))?.state).toBe('wrapup');
    const held = await contactRow(contact.id);
    expect(held.state).toBe('connected');
    expect(held.attempt_count).toBe(charged); // a redial does not spend the retry budget
    const secondRow = await agencyAttemptRepository.findById(secondId);
    expect(secondRow).toMatchObject({
      redial_of_attempt_id: firstId, redial_number: 1, state: 'ended', notes: 'line dropped mid-sentence',
    });
    expect(secondRow!.bridged_at).toBeNull();

    // ── 4. DNC refuses the redial; the agent stays in wrap-up and can still save. ──
    const { rows: [dnc] } = await getTestPool().query<{ id: string }>(
      `INSERT INTO dnc_entries (tenant_id, account_id, campaign_id, phone_e164, source)
       VALUES ($1, $2, $3, $4, 'agent') RETURNING id`,
      [tenant, account, campaign.id, PHONE],
    );
    const blocked = await redial(secondId);
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().code).toBe('redial_blocked_dnc');
    expect(runtime.wrapup.stateFor(sessionId)?.attempt_id).toBe(secondId);
    expect((await runtime.agents.get(sessionId))?.state).toBe('wrapup');
    expect((await contactRow(contact.id)).state).toBe('connected');
    await getTestPool().query('DELETE FROM dnc_entries WHERE id = $1', [dnc!.id]);

    // ── 5. Redial #2 connects to the same agent; wrap-up then offers none. ────────
    const r2 = await redial(secondId);
    expect(r2.statusCode, r2.body).toBe(200);
    expect(r2.json()).toMatchObject({ redial_number: 2, redial_remaining: 0 });
    const thirdId = r2.json().attempt_id as string;
    const third = await reservedFor(3);
    expect(third.redial).toEqual({ of_attempt_id: secondId, number: 2, remaining: 0 });
    const thirdLeg = await legOf(thirdId);
    answer(thirdLeg);
    await waitFor('redial #2 bridged', async () => (await agencyAttemptRepository.findById(thirdId))?.bridged_at);
    expect((await runtime.agents.get(sessionId))?.state).toBe('on_call');
    await customerHangsUp(thirdLeg);
    const w3 = await wrapupFor(thirdId);
    expect(w3.redial_remaining).toBe(0);

    // ── 6. The 3rd redial is refused. ────────────────────────────────────────────
    const third3 = await redial(thirdId);
    expect(third3.statusCode).toBe(409);
    expect(third3.json().code).toBe('redial_limit_reached');
    expect((await runtime.agents.get(sessionId))?.state).toBe('wrapup');
    // Recorded in the campaign's pacing history (IN2): one refusal at the limit, nothing else.
    const { rows: refused } = await getTestPool().query<{ n: number }>(
      `SELECT COALESCE(sum(redials_refused_at_limit), 0)::int AS n
         FROM agency_campaign_pacing_minutes WHERE campaign_id = $1`, [campaign.id]);
    expect(refused[0]!.n).toBe(1);

    // ── 7. The outcome is saved on the last call; the agent goes back to the pool. ─
    const saved = await post(`/proxy/agency/attempts/${thirdId}/disposition`, agent, { disposition_code: 'interested' });
    expect(saved.statusCode, saved.body).toBe(200);
    await waitFor('available', async () => (await runtime.agents.get(sessionId))?.state === 'available');
    expect((await contactRow(contact.id)).state).toBe('completed');
    expect((await contactRow(contact.id)).attempt_count).toBe(charged);

    // ── 8. The history is the chain. ─────────────────────────────────────────────
    const { rows: chain } = await getTestPool().query<{
      id: string; outcome: string; disposition_code: string; redial_of_attempt_id: string | null; redial_number: number;
    }>(
      `SELECT id, outcome, disposition_code, redial_of_attempt_id, redial_number
         FROM agency_call_attempts WHERE contact_id = $1 ORDER BY attempt_number`,
      [contact.id],
    );
    expect(chain).toEqual([
      { id: firstId, outcome: 'connected', disposition_code: 'redialed', redial_of_attempt_id: null, redial_number: 0 },
      { id: secondId, outcome: expect.any(String), disposition_code: 'redialed', redial_of_attempt_id: firstId, redial_number: 1 },
      { id: thirdId, outcome: 'connected', disposition_code: 'interested', redial_of_attempt_id: secondId, redial_number: 2 },
    ]);
    expect(chain[1]!.outcome).not.toBe('connected');
  }, 60_000);

  it('a reconnect mid-wrap-up restores the redial; a ringing redial holds the outcome and the pool shut; a mid-call outcome is not re-parked', async () => {
    await getTestPool().query(
      "UPDATE agency_campaigns SET status = 'completed' WHERE account_id = $1 AND status = 'running'", [account]);
    const { rows: live } = await getTestPool().query<{ id: string }>(
      'SELECT id FROM agency_agent_sessions WHERE agent_user_id = $1 AND left_at IS NULL', [agent.id]);
    for (const s of live) await post(`/proxy/agency/sessions/${s.id}/leave`, agent);
    const campaign = await insertAgencyCampaign({
      tenant_id: tenant, account_id: account, status: 'running',
      wrapup_seconds: 60, wrapup_auto_return: true, disposition_catalog: CATALOG,
      allow_wrapup_redial: true,
    });
    const contact = await insertAgencyContact(campaign.id, { tenant_id: tenant, account_id: account, phone_e164: '+919812340003' });
    await getTestPool().query(
      `INSERT INTO agency_campaign_agents (tenant_id, account_id, campaign_id, user_id) VALUES ($1, $2, $3, $4)`,
      [tenant, account, campaign.id, agent.id],
    );

    // A station: join (or re-join, as a page reload does), open the socket, wait for `ready`.
    const sockets: WebSocket[] = [];
    const connect = async (): Promise<{ sessionId: string; frames: Frame[]; ready: Frame }> => {
      const joined = await post('/proxy/agency/sessions', agent, { campaign_id: campaign.id });
      expect(joined.statusCode, joined.body).toBeLessThan(300);
      const boot = joined.json();
      const frames: Frame[] = [];
      const ws = new WebSocket(`ws://127.0.0.1:${port}${boot.station_ws_url}`);
      sockets.push(ws);
      ws.on('message', (raw, isBinary) => { if (!isBinary) frames.push(JSON.parse(raw.toString())); });
      const ready = await waitFor('ready', () => frames.find((f) => f['event'] === 'ready'));
      return { sessionId: boot.session_id as string, frames, ready };
    };
    const drop = async (ws: WebSocket) => {
      const closed = new Promise<void>((resolve) => ws.once('close', () => resolve()));
      ws.close();
      await closed;
    };

    try {
      let { sessionId, frames } = await connect();
      const avail = await post(`/proxy/agency/sessions/${sessionId}/available`, agent);
      expect(avail.statusCode, avail.body).toBe(200);
      const lastOf = (event: string) => [...frames].reverse().find((f) => f['event'] === event);

      // ── 1. A connected call ends: wrap-up offers 2 redials. ────────────────────
      const first = await waitFor('reserved', () => frames.find((f) => f['event'] === 'reserved')?.['attempt']);
      const firstId = first.attempt_id as string;
      const firstLeg = await legOf(firstId);
      answer(firstLeg);
      await waitFor('bridged', () => lastOf('bridged'));
      await customerHangsUp(firstLeg);
      await waitFor('wrap-up', () => [...frames].reverse().find((f) => f['event'] === 'wrapup' && f['wrapup'].attempt_id === firstId));

      // ── 2. The station drops and comes back (a page reload) mid-wrap-up. ─────────
      await drop(sockets.at(-1)!);
      await waitFor('offline on close', async () => (await runtime.agents.get(sessionId))?.state === 'offline');
      const back = await connect();
      expect(back.sessionId).toBe(sessionId);
      frames = back.frames;
      // Restored as `wrapup` (not `offline`/`break`), with the redial still on offer.
      expect(back.ready['state']).toBe('wrapup');
      expect(back.ready['active_wrapup']).toMatchObject({ attempt_id: firstId, redial_remaining: 2, requires_disposition: true });
      expect((await runtime.agents.get(sessionId))?.state).toBe('wrapup');

      // ── 3. The FIRST Redial after the reconnect is accepted. ─────────────────────
      const r1 = await post(`/proxy/agency/sessions/${sessionId}/redial`, agent, { attempt_id: firstId });
      expect(r1.statusCode, r1.body).toBe(200);
      const redialId = r1.json().attempt_id as string;
      const redialLeg = await legOf(redialId);

      // ── 4. While it rings: no outcome on it, no way into the pool, no leaving. ───
      const early = await post(`/proxy/agency/attempts/${redialId}/disposition`, agent, { disposition_code: 'interested' });
      expect(early.statusCode).toBe(409);
      expect(early.json().code).toBe('attempt_not_dispositionable');
      const availRinging = await post(`/proxy/agency/sessions/${sessionId}/available`, agent);
      expect(availRinging.statusCode).toBe(409);
      expect(availRinging.json().code).toBe('agent_on_live_call');
      expect((await contactRow(contact.id)).state).toBe('in_flight');

      // ── 5. It connects; a reconnect mid-call is told it is a redial. ─────────────
      answer(redialLeg);
      await waitFor('redial bridged', async () => (await agencyAttemptRepository.findById(redialId))?.bridged_at);
      await drop(sockets.at(-1)!);
      const midCall = await connect();
      frames = midCall.frames;
      expect(midCall.ready['active_attempt']).toMatchObject({ attempt_id: redialId });
      expect(midCall.ready['active_attempt']['redial']).toEqual({ of_attempt_id: firstId, number: 1, remaining: 1 });

      // ── 6. The outcome is saved mid-call; the call's end does not re-park the customer. ─
      const saved = await post(`/proxy/agency/attempts/${redialId}/disposition`, agent, { disposition_code: 'interested' });
      expect(saved.statusCode, saved.body).toBe(200);
      expect((await contactRow(contact.id)).state).toBe('completed');
      await customerHangsUp(redialLeg);
      await waitFor('redial ended', async () => (await agencyAttemptRepository.findById(redialId))?.state === 'ended');
      await waitFor('available', async () => (await runtime.agents.get(sessionId))?.state === 'available');
      // Give any late settle write its chance to land, then: still completed.
      await new Promise((r) => setTimeout(r, 300));
      expect((await contactRow(contact.id)).state).toBe('completed');
    } finally {
      for (const ws of sockets) {
        if (ws.readyState !== WebSocket.CLOSED) await drop(ws);
      }
    }
  }, 60_000);

  it('refuses when the campaign has redial off (the bootstrap says so too), and a malformed attempt id at the edge', async () => {
    // Reuses the running app: a second campaign with the setting off. The first one is
    // closed so the case has one running campaign, as written (it was forced while
    // `uq_agency_campaign_running` allowed one per account; migration 0015 dropped it).
    await getTestPool().query(
      "UPDATE agency_campaigns SET status = 'completed' WHERE account_id = $1 AND status = 'running'", [account]);
    const campaign = await insertAgencyCampaign({
      tenant_id: tenant, account_id: account, status: 'running',
      wrapup_seconds: 60, wrapup_auto_return: true, disposition_catalog: CATALOG,
    });
    const contact = await insertAgencyContact(campaign.id, { tenant_id: tenant, account_id: account, phone_e164: '+919812340002' });
    // Self-contained: leave any session the first case left live, then join this campaign.
    const { rows: live } = await getTestPool().query<{ id: string }>(
      'SELECT id FROM agency_agent_sessions WHERE agent_user_id = $1 AND left_at IS NULL', [agent.id]);
    for (const s of live) await post(`/proxy/agency/sessions/${s.id}/leave`, agent);
    await getTestPool().query(
      `INSERT INTO agency_campaign_agents (tenant_id, account_id, campaign_id, user_id) VALUES ($1, $2, $3, $4)`,
      [tenant, account, campaign.id, agent.id],
    );
    const joined = await post('/proxy/agency/sessions', agent, { campaign_id: campaign.id });
    expect(joined.statusCode, joined.body).toBeLessThan(300);
    expect(joined.json().allow_wrapup_redial).toBe(false);
    const session = { id: joined.json().session_id as string };
    const { rows: [att] } = await getTestPool().query<{ id: string }>(
      `INSERT INTO agency_call_attempts (campaign_id, contact_id, tenant_id, account_id, attempt_number, caller_id,
                                         reserved_agent_id, state, outcome, bridged_at, ended_at)
       VALUES ($1, $2, $3, $4, 1, '+919000000001', $5, 'ended', 'connected', now(), now()) RETURNING id`,
      [campaign.id, contact.id, tenant, account, session.id],
    );
    const res = await post(`/proxy/agency/sessions/${session.id}/redial`, agent, { attempt_id: att!.id });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('redial_not_allowed');
    // A malformed attempt id is a 400 at the edge, never a 22P02.
    const bad = await post(`/proxy/agency/sessions/${session.id}/redial`, agent, { attempt_id: 'nope' });
    expect(bad.statusCode).toBe(400);
  });

  it('DN4: a redial of an owned contact goes out from the owner\'s dedicated number; an unowned contact\'s, never from a number since dedicated to another agent', async () => {
    await getTestPool().query(
      "UPDATE agency_campaigns SET status = 'completed' WHERE account_id = $1 AND status = 'running'", [account]);
    const { rows: live } = await getTestPool().query<{ id: string }>(
      'SELECT id FROM agency_agent_sessions WHERE agent_user_id = $1 AND left_at IS NULL', [agent.id]);
    for (const s of live) await post(`/proxy/agency/sessions/${s.id}/leave`, agent);
    const R1 = '+919000000021';
    const R2 = '+919000000022';
    const OWN = '+919000000023';
    const campaign = await insertAgencyCampaign({
      tenant_id: tenant, account_id: account, status: 'running',
      wrapup_seconds: 60, wrapup_auto_return: true, disposition_catalog: CATALOG,
      allow_wrapup_redial: true, caller_ids: [R1, R2, OWN],
    });
    const other = (await insertUser()).id as string;
    await insertMembership({ user_id: other, tenant_id: tenant, account_id: account, role: 'agent' });
    await getTestPool().query(
      `INSERT INTO agency_campaign_agents (tenant_id, account_id, campaign_id, user_id) VALUES ($1, $2, $3, $4), ($1, $2, $3, $5)`,
      [tenant, account, campaign.id, agent.id, other],
    );
    // The agent's number, set after the staffing began (effective, DN1).
    await getTestPool().query(
      `INSERT INTO agency_campaign_agent_caller_ids (tenant_id, account_id, campaign_id, user_id, caller_id, set_at)
       VALUES ($1, $2, $3, $4, $5, clock_timestamp())`,
      [tenant, account, campaign.id, agent.id, OWN],
    );
    const owned = await insertAgencyContact(campaign.id, {
      tenant_id: tenant, account_id: account, phone_e164: '+919812340021', assigned_user_id: agent.id, assigned_at: new Date(),
    });
    // Not due until the owned contact is done, so the order of the paced dials is fixed (and
    // the campaign has work outstanding meanwhile, so it does not complete in between).
    const unowned = await insertAgencyContact(campaign.id, {
      tenant_id: tenant, account_id: account, phone_e164: '+919812340022', next_attempt_at: new Date(Date.now() + 3_600_000),
    });

    const joined = await post('/proxy/agency/sessions', agent, { campaign_id: campaign.id });
    expect(joined.statusCode, joined.body).toBeLessThan(300);
    const sessionId = joined.json().session_id as string;
    const frames: Frame[] = [];
    const ws = new WebSocket(`ws://127.0.0.1:${port}${joined.json().station_ws_url}`);
    ws.on('message', (raw, isBinary) => { if (!isBinary) frames.push(JSON.parse(raw.toString())); });
    try {
      await waitFor('ready', () => frames.find((f) => f['event'] === 'ready'));
      expect((await post(`/proxy/agency/sessions/${sessionId}/available`, agent)).statusCode).toBe(200);

      const reservedFor = (n: number) => waitFor(`reserved #${n}`, () =>
        frames.filter((f) => f['event'] === 'reserved')[n - 1]?.['attempt']);
      const wrapupFor = (attemptId: string) => waitFor(`wrap-up on ${attemptId}`, () =>
        [...frames].reverse().find((f) => f['event'] === 'wrapup' && f['wrapup'].attempt_id === attemptId)?.['wrapup']);
      const callerIdOf = async (attemptId: string) => (await agencyAttemptRepository.findById(attemptId))!.caller_id;
      const dialledFrom = async (attemptId: string) => {
        const leg = await legOf(attemptId);
        const call = mocks.fakeAdapter.initiateCall.mock.calls
          .map((c) => c[0] as unknown as { callId: string; from: string })
          .find((c) => c.callId === leg);
        return call?.from;
      };

      /** The paced call connects and ends; redial it; the redial rings out; save the outcome. */
      async function pacedThenRedial(n: number, contactId: string, beforeRedial?: (pacedFrom: string) => Promise<void>) {
        const paced = await reservedFor(n);
        expect(paced.contact_id).toBe(contactId);
        const pacedId = paced.attempt_id as string;
        const pacedFrom = await callerIdOf(pacedId);
        const leg = await legOf(pacedId);
        answer(leg);
        await waitFor('bridged', async () => (await agencyAttemptRepository.findById(pacedId))?.bridged_at);
        await customerHangsUp(leg);
        await wrapupFor(pacedId);
        await beforeRedial?.(pacedFrom);
        const res = await post(`/proxy/agency/sessions/${sessionId}/redial`, agent, { attempt_id: pacedId });
        expect(res.statusCode, res.body).toBe(200);
        const redialId = res.json().attempt_id as string;
        expect((await reservedFor(n + 1)).attempt_id).toBe(redialId);
        const redialFrom = await callerIdOf(redialId);
        expect(await dialledFrom(redialId)).toBe(redialFrom);
        ringOut(await legOf(redialId));
        await wrapupFor(redialId);
        const saved = await post(`/proxy/agency/attempts/${redialId}/disposition`, agent, { disposition_code: 'interested' });
        expect(saved.statusCode, saved.body).toBe(200);
        await waitFor('available', async () => (await runtime.agents.get(sessionId))?.state === 'available');
        return { pacedFrom, redialFrom };
      }

      // ── The owned contact: paced and redialled from the owner's number. ──────────
      const ownedCalls = await pacedThenRedial(1, owned.id as string);
      expect(ownedCalls).toEqual({ pacedFrom: OWN, redialFrom: OWN });

      // ── An unowned contact: paced from the rotation; that number is then dedicated to
      // another agent during the wrap-up, so the redial takes the rest of the rotation. ──
      await getTestPool().query('UPDATE agency_contacts SET next_attempt_at = now() WHERE id = $1', [unowned.id]);
      const unownedCalls = await pacedThenRedial(3, unowned.id as string, async (pacedFrom) => {
        expect([R1, R2]).toContain(pacedFrom);
        await getTestPool().query(
          `INSERT INTO agency_campaign_agent_caller_ids (tenant_id, account_id, campaign_id, user_id, caller_id, set_at)
           VALUES ($1, $2, $3, $4, $5, clock_timestamp())`,
          [tenant, account, campaign.id, other, pacedFrom],
        );
        // What the PUT publishes after its commit (a raw write publishes nothing, and the dial
        // paths' cached map would keep the old one until its TTL: `dedicated-caller-ids.ts`).
        publishPacingInvalidation({ type: 'dedications_changed', campaignId: campaign.id });
      });
      expect(unownedCalls.redialFrom).toBe(unownedCalls.pacedFrom === R1 ? R2 : R1);
    } finally {
      await post(`/proxy/agency/sessions/${sessionId}/leave`, agent);
      if (ws.readyState !== WebSocket.CLOSED) {
        const closed = new Promise<void>((resolve) => ws.once('close', () => resolve()));
        ws.close();
        await closed;
      }
    }
  }, 60_000);
});
