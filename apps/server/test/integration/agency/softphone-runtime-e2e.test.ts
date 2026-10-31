import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * The soft phone's runtime end to end (docs/softphone.md §4, §5): the real app on
 * loopback (real station WebSocket upgrades), the real bridge and guard host over
 * real Redis and Postgres, the real `AgencyRuntime` with its `ManualDialer`,
 * `SoftphoneService`, reaper and pacing engine. Only the carrier is faked, as in
 * `runtime-e2e.test.ts`: a stub VoiceLink adapter, with the PSTN leg and the
 * carrier webhook driven through the bridge's own entry points.
 *
 * The HTTP routes are the API layer's (not built here): each step calls the
 * `runtime.softphone` method the route will call.
 *
 * Every test uses its own agent (one live session per agent per tenant) and its
 * own campaign; campaigns that only tag manual calls stay `draft`, so the pacing
 * engine never dials their rosters.
 */

vi.hoisted(() => {
  process.env['FF_AGENCY_DIALER'] = 'true';
  process.env['MAX_CONCURRENT_CALLS'] = '20';
  process.env['VOICELINK_WEBHOOK_BASE_URL'] = 'https://agency.test/api/v1/webhooks/voicelink';
});

const { fakeAdapter } = vi.hoisted(() => ({
  fakeAdapter: {
    name: 'voicelink',
    capabilities: { cancelRinging: false, queuesOutboundDials: true },
    initiateCall: vi.fn(async (req: { callId: string }) => ({ providerCallId: `carrier-${req.callId}` })),
    endCall: vi.fn(async () => undefined),
  },
}));
vi.mock('../../../src/telephony/factory.js', () => ({
  TelephonyProviderRegistry: class {
    get() { return fakeAdapter; }
  },
}));

import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import type { FastifyInstance } from 'fastify';
import { closePool, getPool, initDbPool } from '@magick-agency/db';
import { TEST_DB_URL, closeTestPool, getTestPool, truncateAll } from '../../../../../packages/db/test/helpers/test-db.js';
import { insertTenant, uuidFor } from '../../../../../packages/db/test/integration/setup/factories.js';
import { closeTestRedis, flushTestRedis, getTestRedis } from '../../helpers/test-redis.js';
import { insertAgencyCampaign, insertAgencyContact } from './agency-factories.js';
import { config } from '../../../src/config/index.js';
import { buildApp } from '../../../src/app.js';
import type { AppContext } from '../../../src/app-context.js';
import { getAgencyRuntime, resetAgencyRuntimeForTests, startAgency } from '../../../src/bootstrap/agency.js';
import { getVoiceEngine, resetVoiceEngineForTests, startVoice } from '../../../src/bootstrap/voice.js';
import { agencyAgentSessionRepository, agencyContactRepository, agencyManualCallRepository } from '../../../src/db/repositories/agency.repository.js';
import type { AgencyRuntime } from '../../../src/agency/runtime.js';
import type { SoftphoneActor } from '../../../src/agency/softphone/types.js';
import { setAvailableGuarded } from '../../../src/agency/softphone/session-guard.js';
import { AGENT_LEASE_MS } from '../../../src/agency/agent-state-machine.js';
import { WebRtcCallError } from '../../../src/core/webrtc-bridge-manager.js';

const TENANT = uuidFor('softphone-e2e-tenant');
const ACCOUNT = uuidFor('softphone-e2e-account');
/** A second account whose ceiling is ONE call, for the headroom test. */
const NARROW_ACCOUNT = uuidFor('softphone-e2e-narrow-account');

const CATALOG = JSON.stringify([
  { code: 'interested', label: 'Interested', is_success: true, terminal: true },
  { code: 'call_back', label: 'Call back', requires_datetime: true },
  { code: 'do_not_call', label: 'Do not call', suppress: true },
]);

/** The carrier's media socket: records what the bridge sends it, emits what VoiceLink would. */
class FakePstnSocket extends EventEmitter {
  readyState = 1;
  OPEN = 1;
  readonly sent: Array<Record<string, unknown>> = [];
  send(raw: string): void { this.sent.push(JSON.parse(raw) as Record<string, unknown>); }
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Station {
  ws: WebSocket;
  frames: Array<Record<string, any>>;
  close: () => Promise<void>;
}

describe('soft phone runtime end to end — real app, real bridge, fake carrier (integration)', () => {
  let app: FastifyInstance;
  let port = 0;
  let stopAgency: (() => Promise<void>) | null = null;
  let stopVoice: (() => Promise<void>) | null = null;
  let runtime: AgencyRuntime;
  const stations: Station[] = [];

  const actor = (userId: string, opts: { supervise?: boolean; accountId?: string } = {}): SoftphoneActor => ({
    tenantId: TENANT, accountId: opts.accountId ?? ACCOUNT, userId, supervise: opts.supervise ?? true,
  });

  async function openStation(sessionId: string): Promise<Station> {
    const { token } = await runtime.tokens.mint(sessionId);
    const frames: Array<Record<string, any>> = [];
    const ws = new WebSocket(`ws://127.0.0.1:${port}/proxy/agency/station/${sessionId}?token=${token}`);
    ws.on('message', (raw) => { try { frames.push(JSON.parse(raw.toString())); } catch { /* media */ } });
    await waitFor('ready', () => frames.find((f) => f['event'] === 'ready'));
    const station: Station = {
      ws, frames,
      close: async () => {
        if (ws.readyState === WebSocket.CLOSED) return;
        const closed = new Promise<void>((resolve) => ws.once('close', () => resolve()));
        ws.close();
        await closed;
      },
    };
    stations.push(station);
    return station;
  }

  async function softphoneSession(agentUserId: string, accountId = ACCOUNT) {
    const join = await agencyAgentSessionRepository.joinSoftphone({
      tenantId: TENANT, accountId, agentUserId, replicaId: runtime.replicaId,
    });
    if (!join.ok) throw new Error('soft-phone join refused');
    return join.session;
  }

  /** A campaign session, joined and switched to the soft phone. */
  async function campaignSession(campaignId: string, agentUserId: string, accountId = ACCOUNT) {
    const join = await agencyAgentSessionRepository.joinOrRehydrate({
      tenantId: TENANT, accountId, campaignId, agentUserId, replicaId: runtime.replicaId,
    });
    if (!join.ok) throw new Error('join refused');
    return join.session;
  }

  const lastCall = (s: Station) => [...s.frames].reverse().find((f) => f['event'] === 'manual_call')?.['call'];

  async function webrtcCallIdOf(manualCallId: string): Promise<string> {
    return waitFor('media leg', async () => {
      const { rows } = await getTestPool().query<{ webrtc_call_id: string | null }>(
        'SELECT webrtc_call_id FROM agency_manual_calls WHERE id = $1', [manualCallId]);
      return rows[0]?.webrtc_call_id ?? null;
    });
  }

  function answer(callId: string): FakePstnSocket {
    const pstn = new FakePstnSocket();
    expect(getVoiceEngine()!.bridge.attachPstnLeg(callId, pstn as never)).toBe(true);
    pstn.emit('message', JSON.stringify({
      event: 'start',
      start: { call_sid: `carrier-${callId}`, stream_sid: 's1', media_format: { encoding: 'audio/alaw', sample_rate: '8000' } },
    }));
    return pstn;
  }

  async function carrierEnded(callId: string): Promise<void> {
    await getVoiceEngine()!.bridge.handleVoicelinkStatus(callId, {
      providerCallId: `carrier-${callId}`, callId, eventType: 'hangup', timestamp: new Date(),
      metadata: { event: 'call.ended', call: { id: `carrier-${callId}`, status: 'ended' } },
    } as never);
  }

  /** VoiceLink's `stop` before any `start`: the customer never answered. */
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
  async function contactRow(id: string) {
    const { rows } = await getTestPool().query('SELECT * FROM agency_contacts WHERE id = $1', [id]);
    return rows[0];
  }

  beforeAll(async () => {
    initDbPool({ url: TEST_DB_URL, poolMin: 0, poolMax: 8 });
    await truncateAll();
    await flushTestRedis();
    resetVoiceEngineForTests();
    await resetAgencyRuntimeForTests();
    // `dnc_entries` keys on a real tenant.
    await insertTenant({ id: TENANT });
    await getTestPool().query(
      `INSERT INTO account_settings (tenant_id, account_id, allow_recording, max_concurrent_calls)
       VALUES ($1, $2, true, 20), ($1, $3, true, 1)`,
      [TENANT, ACCOUNT, NARROW_ACCOUNT],
    );
    const ctx: AppContext = { config, pool: getPool(), redis: getTestRedis() };
    app = await buildApp({ ctx });
    await app.listen({ port: 0, host: '127.0.0.1' });
    port = (app.server.address() as { port: number }).port;
    stopVoice = await startVoice(ctx);
    stopAgency = await startAgency(ctx);
    runtime = getAgencyRuntime()!;
  });

  afterAll(async () => {
    for (const s of stations) await s.close().catch(() => undefined);
    await sleep(200);
    if (stopAgency) await stopAgency();
    if (stopVoice) await stopVoice();
    await app?.close();
    await resetAgencyRuntimeForTests();
    resetVoiceEngineForTests();
    await closePool();
    await closeTestPool();
    await closeTestRedis();
  });

  it('a tagged call: ring → answer → bridge → hang up → outcome → contact settled, Redis released', async () => {
    const agent = randomUUID();
    const campaign = await insertAgencyCampaign({
      tenant_id: TENANT, account_id: ACCOUNT, record_calls: true, disposition_catalog: CATALOG,
      caller_ids: ['+919000000001', '+919000000002'],
    });
    const contact = await insertAgencyContact(campaign.id, {
      tenant_id: TENANT, account_id: ACCOUNT, phone_e164: '+919811100001',
    });
    const session = await softphoneSession(agent);
    const station = await openStation(session.id);
    expect(station.frames.find((f) => f['event'] === 'ready')!['state']).toBe('break');

    const placed = await runtime.softphone.placeCall(actor(agent), {
      sessionId: session.id, to: '9811100001', campaignId: campaign.id, callerId: '+919000000002',
    });
    if (!placed.ok) throw new Error(`refused: ${placed.refusal.code}`);
    const callId = placed.call.id;
    expect(placed.call.destination_e164).toBe('+919811100001');
    expect(placed.call.caller_id).toBe('+919000000002');
    expect(placed.call.tag?.campaign_id).toBe(campaign.id);
    expect(placed.call.contact).toMatchObject({ contact_id: contact.id, claimed: true, state: 'in_flight' });
    expect(placed.call.recording_requested).toBe(true);
    expect(await runtime.agents.manualCallOf(session.id)).toBe(callId);
    expect(fakeAdapter.initiateCall).toHaveBeenCalled();

    const webrtcCallId = await webrtcCallIdOf(callId);
    const { rows: [leg] } = await getTestPool().query(
      'SELECT origin, manual_call_id, campaign_id, agency_attempt_id FROM agency_calls WHERE id = $1', [webrtcCallId]);
    expect(leg).toEqual({ origin: 'manual', manual_call_id: callId, campaign_id: null, agency_attempt_id: null });
    await waitFor('ringing frame', () => lastCall(station)?.state === 'ringing');

    answer(webrtcCallId);
    await waitFor('bridged frame', () => lastCall(station)?.state === 'bridged' && lastCall(station)?.bridged_at);
    // While a call is live the session cannot go available.
    expect(await runtime.agents.set(session.id, 'available')).toBe('manual_call_live');

    const hung = await runtime.softphone.hangup(actor(agent), callId);
    expect(hung.ok).toBe(true);
    await carrierEnded(webrtcCallId); // VoiceLink confirms an answered call's hangup
    const awaiting = await waitFor('awaiting outcome', () => {
      const c = lastCall(station);
      return c?.state === 'ended' && c.requires_disposition ? c : null;
    });
    expect(awaiting.outcome).toBe('connected');
    expect(awaiting.end_reason).toBe('agent_hangup');
    expect(awaiting.outcome_due_at).not.toBeNull();
    expect(await runtime.agents.manualCallOf(session.id)).toBe(callId); // kept until the outcome

    // A second dial is refused while the outcome is owed.
    const again = await runtime.softphone.placeCall(actor(agent), { sessionId: session.id, to: '9811100099' });
    expect(again.ok ? null : again.refusal.code).toBe('outcome_pending');

    const outcome = await runtime.softphone.submitDisposition(actor(agent), callId, { code: 'interested', notes: 'Keen' });
    if (!outcome.ok) throw new Error(`disposition refused: ${outcome.refusal.code}`);
    expect(outcome.replay).toBe(false);
    expect(outcome.response.contact_state).toBe('completed');
    expect(outcome.response.call.settled_at).not.toBeNull();
    expect(outcome.response.call.disposition_source).toBe('campaign');
    const settledContact = await contactRow(contact.id);
    expect(settledContact.state).toBe('completed');
    expect(settledContact.attempt_count).toBe(1);
    expect(settledContact.last_disposition).toBe('interested');
    expect(await runtime.agents.manualCallOf(session.id)).toBeNull();
    await waitFor('settled frame', () => lastCall(station)?.settled_at);

    // The same code again is a replay; a different code is refused.
    const replay = await runtime.softphone.submitDisposition(actor(agent), callId, { code: 'interested', notes: 'Very keen' });
    expect(replay.ok && replay.replay).toBe(true);
    const different = await runtime.softphone.submitDisposition(actor(agent), callId, { code: 'do_not_call' });
    expect(different.ok ? null : different.refusal.code).toBe('call_settled');
  });

  it('an unanswered call settles at once: one attempt charged, the retry policy\'s delay before pacing redials, claim released', async () => {
    const agent = randomUUID();
    const campaign = await insertAgencyCampaign({ tenant_id: TENANT, account_id: ACCOUNT, disposition_catalog: CATALOG });
    const contact = await insertAgencyContact(campaign.id, { tenant_id: TENANT, account_id: ACCOUNT, phone_e164: '+919811100002' });
    const session = await softphoneSession(agent);
    const station = await openStation(session.id);

    const placed = await runtime.softphone.placeCall(actor(agent), { sessionId: session.id, to: '+919811100002', campaignId: campaign.id });
    if (!placed.ok) throw new Error(placed.refusal.code);
    ringOut(await webrtcCallIdOf(placed.call.id));

    const settled = await waitFor('settled frame', () => (lastCall(station)?.settled_at ? lastCall(station) : null));
    expect(settled.outcome).toBe('no_answer');
    expect(settled.end_reason).toBe('no_answer');
    expect(settled.requires_disposition).toBe(false);
    const c = await contactRow(contact.id);
    expect(c.state).toBe('pending');
    expect(c.attempt_count).toBe(1);
    // The default policy's `no_answer` delay (60 min), not "dialable now": pacing must
    // not ring the customer the agent just rang.
    expect(Math.abs(c.next_attempt_at.getTime() - (Date.now() + 60 * 60_000))).toBeLessThan(60_000);
    expect(await runtime.agents.manualCallOf(session.id)).toBeNull();
    // An unanswered call owes nothing: no outcome can be saved for it.
    const refused = await runtime.softphone.submitDisposition(actor(agent), placed.call.id, { code: 'interested' });
    expect(refused.ok ? null : refused.refusal.code).toBe('call_settled');
    // And the session can dial again.
    const next = await runtime.softphone.placeCall(actor(agent), { sessionId: session.id, to: '+919811100003', campaignId: campaign.id });
    expect(next.ok).toBe(true);
    if (next.ok) {
      await runtime.softphone.hangup(actor(agent), next.call.id);
      await waitFor('second call settled', async () => (await manualRow(next.call.id)).settled_at);
    }
  });

  it('a database fault before the bridge ends the call failed, releases the contact and the claim, and the session dials again', async () => {
    const agent = randomUUID();
    const campaign = await insertAgencyCampaign({ tenant_id: TENANT, account_id: ACCOUNT, disposition_catalog: CATALOG });
    const contact = await insertAgencyContact(campaign.id, { tenant_id: TENANT, account_id: ACCOUNT, phone_e164: '+919811100090' });
    const session = await softphoneSession(agent);
    await openStation(session.id);
    const dials = fakeAdapter.initiateCall.mock.calls.length;

    // The `dialing` write fails once (a DB fault after the row committed and Redis was claimed).
    const real = agencyManualCallRepository.advanceState.bind(agencyManualCallRepository);
    const fault = vi.spyOn(agencyManualCallRepository, 'advanceState').mockImplementation(async (id, state, ...rest) => {
      if (state === 'dialing') throw new Error('connection terminated unexpectedly');
      return real(id, state, ...rest);
    });
    let thrown: unknown = null;
    try {
      await runtime.softphone.placeCall(actor(agent), { sessionId: session.id, to: '+919811100090', campaignId: campaign.id });
    } catch (err) {
      thrown = err;
    } finally {
      fault.mockRestore();
    }
    expect((thrown as Error | null)?.message).toBe('connection terminated unexpectedly');
    expect(fakeAdapter.initiateCall.mock.calls.length).toBe(dials); // the carrier never saw it

    const { rows: [row] } = await getTestPool().query('SELECT * FROM agency_manual_calls WHERE session_id = $1', [session.id]);
    expect(row).toMatchObject({ state: 'ended', outcome: 'failed', end_reason: 'failed' });
    expect(row.settled_at).not.toBeNull();
    const c = await contactRow(contact.id);
    expect(c.state).toBe('pending');
    expect(c.attempt_count).toBe(0);
    expect(await runtime.agents.manualCallOf(session.id)).toBeNull();
    expect(runtime.manualDialer.activeManualCallIds()).not.toContain(row.id);

    // Nothing is stranded: the session dials again.
    const next = await runtime.softphone.placeCall(actor(agent), { sessionId: session.id, to: '+919811100090', campaignId: campaign.id });
    if (!next.ok) throw new Error(next.refusal.code);
    await runtime.softphone.hangup(actor(agent), next.call.id);
    await waitFor('second call settled', async () => (await manualRow(next.call.id)).settled_at);
  });

  it('refusals before a line is up answer what happened: the carrier refusal ended, Redis down and an unknown bridge refusal dial_failed', async () => {
    const agent = randomUUID();
    const campaign = await insertAgencyCampaign({ tenant_id: TENANT, account_id: ACCOUNT, disposition_catalog: CATALOG });
    const contact = await insertAgencyContact(campaign.id, { tenant_id: TENANT, account_id: ACCOUNT, phone_e164: '+919811100095' });
    const session = await softphoneSession(agent);
    await openStation(session.id);

    // The carrier refuses the dial outright: placed (201), and the body is the row as it
    // ended — never `dialing` for a call that is already over.
    fakeAdapter.initiateCall.mockRejectedValueOnce(new Error('carrier said no'));
    const refusedByCarrier = await runtime.softphone.placeCall(actor(agent), {
      sessionId: session.id, to: '+919811100095', campaignId: campaign.id,
    });
    if (!refusedByCarrier.ok) throw new Error(refusedByCarrier.refusal.code);
    expect(refusedByCarrier.call).toMatchObject({ state: 'ended', outcome: 'failed', requires_disposition: false });
    expect(refusedByCarrier.call.settled_at).not.toBeNull();
    expect(await runtime.agents.manualCallOf(session.id)).toBeNull();
    // Not a placed dial: no attempt charged, and no dial in the usage counts (SP5).
    expect(await contactRow(contact.id)).toMatchObject({ state: 'pending', attempt_count: 0 });
    expect((await manualRow(refusedByCarrier.call.id)).dialed_at).toBeNull();

    // Redis cannot answer the session claim: dial_failed (retry), not "not on the soft phone".
    const claim = vi.spyOn(runtime.agents, 'claimManual').mockResolvedValueOnce({ ok: false, reason: 'unavailable' });
    const redisDown = await runtime.softphone.placeCall(actor(agent), { sessionId: session.id, to: '+919811100096', campaignId: campaign.id });
    claim.mockRestore();
    expect(redisDown.ok ? null : redisDown.refusal.code).toBe('dial_failed');

    // A bridge refusal this code does not know is dial_failed too, not station_unavailable.
    const bridge = getVoiceEngine()!.bridge;
    const unknown = vi.spyOn(bridge, 'createBridgedCall').mockRejectedValueOnce(
      new WebRtcCallError('something new', 'some_new_reason' as never, 500));
    const unknownRefusal = await runtime.softphone.placeCall(actor(agent), { sessionId: session.id, to: '+919811100097', campaignId: campaign.id });
    unknown.mockRestore();
    expect(unknownRefusal.ok ? null : unknownRefusal.refusal.code).toBe('dial_failed');

    // Each closed its row: nothing holds the session.
    const { rows } = await getTestPool().query(
      'SELECT count(*)::int AS n FROM agency_manual_calls WHERE session_id = $1 AND settled_at IS NULL', [session.id]);
    expect(rows[0].n).toBe(0);
    expect(await runtime.agents.manualCallOf(session.id)).toBeNull();
  });

  it('call fields: omitted keeps them, {} keeps them once the account has no call fields, {} clears while it has', async () => {
    const agent = randomUUID();
    const campaign = await insertAgencyCampaign({ tenant_id: TENANT, account_id: ACCOUNT, disposition_catalog: CATALOG });
    const setFields = (fields: unknown[]) => getTestPool().query(
      `INSERT INTO agency_softphone_settings (tenant_id, account_id, call_fields) VALUES ($1, $2, $3::jsonb)
       ON CONFLICT (tenant_id, account_id) DO UPDATE SET call_fields = EXCLUDED.call_fields`,
      [TENANT, ACCOUNT, JSON.stringify(fields)]);
    await setFields([{ key: 'policy_no', label: 'Policy number', type: 'text' }]);
    const session = await softphoneSession(agent);
    const station = await openStation(session.id);
    try {
      const placed = await runtime.softphone.placeCall(actor(agent), {
        sessionId: session.id, to: '+919811100098', campaignId: campaign.id, fields: { policy_no: 'P-1' },
      });
      if (!placed.ok) throw new Error(placed.refusal.code);
      const callId = placed.call.id;
      const leg = await webrtcCallIdOf(callId);
      answer(leg);
      await waitFor('bridged', () => lastCall(station)?.state === 'bridged');

      // Notes only: the fields are untouched.
      const notesOnly = await runtime.softphone.updateDetails(actor(agent), callId, { notes: 'Asked about renewal' });
      expect(notesOnly.ok && notesOnly.call.fields).toEqual({ policy_no: 'P-1' });

      // The admin removes every call field mid-call. A client with no field set sends {}:
      // not a clear — nothing it could have entered — so the stored value stays.
      await setFields([]);
      const emptyPatch = await runtime.softphone.updateDetails(actor(agent), callId, { fields: {} });
      expect(emptyPatch.ok && emptyPatch.call.fields).toEqual({ policy_no: 'P-1' });

      await runtime.softphone.hangup(actor(agent), callId);
      await carrierEnded(leg);
      await waitFor('awaiting outcome', () => lastCall(station)?.requires_disposition);
      // The outcome with fields omitted: the stored value (of a field no longer in force)
      // neither refuses it nor is wiped.
      const outcome = await runtime.softphone.submitDisposition(actor(agent), callId, { code: 'interested' });
      if (!outcome.ok) throw new Error(outcome.refusal.code);
      expect((await manualRow(callId)).fields).toEqual({ policy_no: 'P-1' });

      // With call fields in force, {} is the agent clearing them.
      await setFields([{ key: 'policy_no', label: 'Policy number', type: 'text' }]);
      const second = await runtime.softphone.placeCall(actor(agent), {
        sessionId: session.id, to: '+919811100099', campaignId: campaign.id, fields: { policy_no: 'P-2' },
      });
      if (!second.ok) throw new Error(second.refusal.code);
      const cleared = await runtime.softphone.updateDetails(actor(agent), second.call.id, { fields: {} });
      expect(cleared.ok && cleared.call.fields).toEqual({});
      expect((await manualRow(second.call.id)).fields).toEqual({});
      await runtime.softphone.hangup(actor(agent), second.call.id);
      await waitFor('second call settled', async () => (await manualRow(second.call.id)).settled_at);
    } finally {
      await getTestPool().query('DELETE FROM agency_softphone_settings WHERE tenant_id = $1 AND account_id = $2', [TENANT, ACCOUNT]);
    }
  });

  it('DNC: refused with the entry, overridable with a note (stored); a bad note and a failed lookup are not', async () => {
    const agent = randomUUID();
    const campaign = await insertAgencyCampaign({ tenant_id: TENANT, account_id: ACCOUNT, disposition_catalog: CATALOG });
    const { rows: [entry] } = await getTestPool().query(
      `INSERT INTO dnc_entries (tenant_id, account_id, campaign_id, phone_e164, source, reason)
       VALUES ($1, NULL, NULL, '+919811100010', 'import', 'asked twice') RETURNING id`, [TENANT]);
    const session = await softphoneSession(agent);
    await openStation(session.id);

    const refused = await runtime.softphone.placeCall(actor(agent), { sessionId: session.id, to: '+919811100010', campaignId: campaign.id });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.refusal).toMatchObject({ code: 'dnc_listed', entry: { id: entry.id, scope: 'tenant', reason: 'asked twice' } });

    const shortNote = await runtime.softphone.placeCall(actor(agent), {
      sessionId: session.id, to: '+919811100010', campaignId: campaign.id, overrides: { dnc_note: 'ok' },
    });
    expect(shortNote.ok ? null : shortNote.refusal.code).toBe('override_note_invalid');

    const overridden = await runtime.softphone.placeCall(actor(agent), {
      sessionId: session.id, to: '+919811100010', campaignId: campaign.id,
      overrides: { dnc_note: '  Customer called in and asked us to ring back today.  ' },
    });
    if (!overridden.ok) throw new Error(overridden.refusal.code);
    expect(overridden.call.dnc_overridden).toBe(true);
    expect(overridden.dncOverride).toEqual({ note: 'Customer called in and asked us to ring back today.', entryId: entry.id });
    const row = await manualRow(overridden.call.id);
    expect(row.dnc_override_entry_id).toBe(entry.id);
    expect(row.dnc_override_note).toBe('Customer called in and asked us to ring back today.');
    await runtime.softphone.hangup(actor(agent), overridden.call.id);
    await waitFor('settled', async () => (await manualRow(overridden.call.id)).settled_at);

    // A lookup that fails is refused and cannot be overridden (SP1).
    const failing = vi.spyOn(runtime.dnc, 'checkEntry').mockResolvedValueOnce({ result: 'unavailable' });
    const unavailable = await runtime.softphone.placeCall(actor(agent), {
      sessionId: session.id, to: '+919811100011', campaignId: campaign.id,
      overrides: { dnc_note: 'A perfectly long enough override note.' },
    });
    failing.mockRestore();
    expect(unavailable.ok ? null : unavailable.refusal.code).toBe('dnc_unavailable');
  });

  it('outside calling hours: refused with the window, placed with an hours note', async () => {
    const agent = randomUUID();
    // A window that is never open (start = end).
    const campaign = await insertAgencyCampaign({
      tenant_id: TENANT, account_id: ACCOUNT, disposition_catalog: CATALOG,
      calling_window_start: '09:00:00', calling_window_end: '09:00:00', default_timezone: 'Asia/Kolkata',
    });
    const session = await softphoneSession(agent);
    await openStation(session.id);

    const refused = await runtime.softphone.placeCall(actor(agent), { sessionId: session.id, to: '+919811100020', campaignId: campaign.id });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.refusal).toMatchObject({
      code: 'outside_calling_hours', timezone_source: 'campaign_default', next_open_at: null,
      window: { timezone: 'Asia/Kolkata' },
    });

    const placed = await runtime.softphone.placeCall(actor(agent), {
      sessionId: session.id, to: '+919811100020', campaignId: campaign.id,
      overrides: { hours_note: 'Customer asked for an evening call.' },
    });
    if (!placed.ok) throw new Error(placed.refusal.code);
    expect(placed.call.hours_overridden).toBe(true);
    expect(placed.hoursOverrideNote).toBe('Customer asked for an evening call.');
    // Untagged calls have no window at all.
    await runtime.softphone.hangup(actor(agent), placed.call.id);
    await waitFor('settled', async () => (await manualRow(placed.call.id)).settled_at);
  });

  it('contact_in_flight: a live campaign attempt on the roster contact refuses the dial, no override', async () => {
    const agent = randomUUID();
    const campaign = await insertAgencyCampaign({ tenant_id: TENANT, account_id: ACCOUNT, disposition_catalog: CATALOG });
    const contact = await insertAgencyContact(campaign.id, {
      tenant_id: TENANT, account_id: ACCOUNT, phone_e164: '+919811100030', state: 'in_flight',
    });
    const session = await softphoneSession(agent);
    await openStation(session.id);
    const refused = await runtime.softphone.placeCall(actor(agent), {
      sessionId: session.id, to: '+919811100030', campaignId: campaign.id,
      overrides: { dnc_note: 'This note cannot override an in-flight contact.' },
    });
    expect(refused.ok ? null : refused.refusal).toEqual({ code: 'contact_in_flight', campaign_id: campaign.id, contact_id: contact.id });
    expect(await runtime.agents.manualCallOf(session.id)).toBeNull();
    const { rows } = await getTestPool().query('SELECT count(*)::int AS n FROM agency_manual_calls WHERE session_id = $1', [session.id]);
    expect(rows[0].n).toBe(0);
  });

  it('a campaign the agent is not staffed on is not taggable', async () => {
    const agent = randomUUID();
    const campaign = await insertAgencyCampaign({ tenant_id: TENANT, account_id: ACCOUNT });
    const session = await softphoneSession(agent);
    await openStation(session.id);
    const refused = await runtime.softphone.placeCall(actor(agent, { supervise: false }), {
      sessionId: session.id, to: '+919811100040', campaignId: campaign.id,
    });
    expect(refused.ok ? null : refused.refusal.code).toBe('campaign_not_taggable');
  });

  it('concurrent placeCall on one session: exactly one wins, the other sees its call', async () => {
    const agent = randomUUID();
    const campaign = await insertAgencyCampaign({ tenant_id: TENANT, account_id: ACCOUNT, disposition_catalog: CATALOG });
    await insertAgencyContact(campaign.id, { tenant_id: TENANT, account_id: ACCOUNT, phone_e164: '+919811100050' });
    const session = await softphoneSession(agent);
    await openStation(session.id);
    const results = await Promise.all(Array.from({ length: 5 }, () => runtime.softphone.placeCall(actor(agent), {
      sessionId: session.id, to: '+919811100050', campaignId: campaign.id,
    })));
    const won = results.filter((r) => r.ok);
    expect(won).toHaveLength(1);
    const winner = won[0]!;
    for (const r of results) {
      if (r.ok) continue;
      expect(r.refusal.code).toBe('manual_call_live');
      expect((r.refusal as { call: { id: string } }).call.id).toBe(winner.ok ? winner.call.id : '');
    }
    const { rows } = await getTestPool().query('SELECT count(*)::int AS n FROM agency_manual_calls WHERE session_id = $1', [session.id]);
    expect(rows[0].n).toBe(1);
    if (winner.ok) {
      await runtime.softphone.hangup(actor(agent), winner.call.id);
      await waitFor('settled', async () => (await manualRow(winner.call.id)).settled_at);
    }
  });

  it('a dial whose roster match runs after its own session\'s other dial committed sees that call, not contact_in_flight', async () => {
    // The interleaving the concurrent case above hits only by chance, forced: B passes
    // the session's unsettled-call check before A commits, and reads the roster after
    // A claimed the contact. The contact is `in_flight` because of B's OWN session.
    const agent = randomUUID();
    const campaign = await insertAgencyCampaign({ tenant_id: TENANT, account_id: ACCOUNT, disposition_catalog: CATALOG });
    await insertAgencyContact(campaign.id, { tenant_id: TENANT, account_id: ACCOUNT, phone_e164: '+919811100055' });
    const session = await softphoneSession(agent);
    await openStation(session.id);

    const real = agencyContactRepository.findForManualMatch.bind(agencyContactRepository);
    let releaseA!: () => void;
    let releaseB!: () => void;
    const gateA = new Promise<void>((r) => { releaseA = r; });
    const gateB = new Promise<void>((r) => { releaseB = r; });
    let calls = 0;
    const match = vi.spyOn(agencyContactRepository, 'findForManualMatch').mockImplementation(async (...args) => {
      const nth = ++calls;
      // A holds at its roster read until B is past the session check; B holds at its
      // own until A has committed its row and claimed the contact.
      await (nth === 1 ? gateA : gateB);
      return real(...args);
    });
    try {
      const a = runtime.softphone.placeCall(actor(agent), { sessionId: session.id, to: '+919811100055', campaignId: campaign.id });
      await waitFor('A at the roster read', () => calls >= 1);
      const b = runtime.softphone.placeCall(actor(agent), { sessionId: session.id, to: '+919811100055', campaignId: campaign.id });
      await waitFor('B at the roster read', () => calls >= 2);
      releaseA();
      const won = await a;
      if (!won.ok) throw new Error(won.refusal.code);
      releaseB();
      const lost = await b;
      expect(lost.ok ? null : lost.refusal.code).toBe('manual_call_live');
      expect((lost.ok ? null : (lost.refusal as { call: { id: string } }).call.id)).toBe(won.call.id);
      await runtime.softphone.hangup(actor(agent), won.call.id);
      await waitFor('settled', async () => (await manualRow(won.call.id)).settled_at);
    } finally {
      releaseA();
      releaseB();
      match.mockRestore();
    }
  });

  it('a reconnect mid-call re-attaches the media leg and restores the call after ready', async () => {
    const agent = randomUUID();
    const session = await softphoneSession(agent);
    const first = await openStation(session.id);
    const placed = await runtime.softphone.placeCall(actor(agent), {
      sessionId: session.id, to: '+919811100060', campaignId: (await insertAgencyCampaign({ tenant_id: TENANT, account_id: ACCOUNT })).id,
    });
    if (!placed.ok) throw new Error(placed.refusal.code);
    const webrtcCallId = await webrtcCallIdOf(placed.call.id);
    answer(webrtcCallId);
    await waitFor('bridged', () => lastCall(first)?.state === 'bridged');

    // The wifi drops: the bridge holds the answered call for a re-attach.
    await first.close();
    await waitFor('grace armed', () => getVoiceEngine()!.bridge.getSession(webrtcCallId)?.browserLegGraceArmed);
    expect((await runtime.agents.get(session.id))?.state).toBe('break');

    const second = await openStation(session.id);
    const restored = await waitFor('manual_call after ready', () => lastCall(second));
    const readyAt = second.frames.findIndex((f) => f['event'] === 'ready');
    const callAt = second.frames.findIndex((f) => f['event'] === 'manual_call');
    expect(callAt).toBeGreaterThan(readyAt);
    expect(restored.id).toBe(placed.call.id);
    expect(restored.state).toBe('bridged');
    expect(getVoiceEngine()!.bridge.getSession(webrtcCallId)?.browserLegGraceArmed).toBe(false);

    await runtime.softphone.hangup(actor(agent), placed.call.id);
    await carrierEnded(webrtcCallId);
    await waitFor('awaiting outcome', () => lastCall(second)?.requires_disposition);
    // A reload while the outcome is owed restores it too.
    await second.close();
    await sleep(100);
    const third = await openStation(session.id);
    const owed = await waitFor('owed call after ready', () => lastCall(third));
    expect(owed.requires_disposition).toBe(true);
    expect(await runtime.agents.manualCallOf(session.id)).toBe(placed.call.id);
    const done = await runtime.softphone.submitDisposition(actor(agent), placed.call.id, { code: 'voicemail' });
    expect(done.ok).toBe(true);
  });

  it('switch from a live campaign call is queued, applied at its end; return refused while a call is unsettled', async () => {
    const agent = randomUUID();
    const campaign = await insertAgencyCampaign({
      tenant_id: TENANT, account_id: ACCOUNT, status: 'running', wrapup_seconds: 0,
      disposition_catalog: JSON.stringify([]),
    });
    await insertAgencyContact(campaign.id, { tenant_id: TENANT, account_id: ACCOUNT, phone_e164: '+919811100070' });
    const session = await campaignSession(campaign.id, agent);
    const station = await openStation(session.id);
    await runtime.agents.set(session.id, 'available', { leaseMs: AGENT_LEASE_MS.available });
    await agencyAgentSessionRepository.setState(session.id, 'available');

    const reserved = await waitFor('campaign reservation', () => station.frames.find((f) => f['event'] === 'reserved'), 15_000);
    const attemptId = reserved['attempt'].attempt_id as string;
    const campaignLeg = await waitFor('campaign leg', async () => {
      const { rows } = await getTestPool().query('SELECT webrtc_call_id FROM agency_call_attempts WHERE id = $1', [attemptId]);
      return rows[0]?.webrtc_call_id ?? null;
    });
    answer(campaignLeg);
    await waitFor('on_call', async () => (await runtime.agents.get(session.id))?.state === 'on_call');

    // Mid-call: the switch is queued, not applied.
    const switched = await runtime.softphone.switchToSoftphone(session.id, actor(agent));
    if (!switched.ok) throw new Error(switched.refusal.code);
    expect(switched.queued).toBe(true);
    expect(switched.response).toMatchObject({ state: 'on_call', pending_state: 'break', break_reason: 'soft_phone' });
    expect(switched.fromState).toBe('on_call');
    expect(switched.unchanged).toBe(false);
    // Pressed again while queued: an idempotent repeat, not a second switch to audit.
    const again = await runtime.softphone.switchToSoftphone(session.id, actor(agent));
    expect(again.ok && again.unchanged).toBe(true);

    await carrierEnded(campaignLeg);
    await waitFor('soft_phone break applied', () => station.frames.some((f) =>
      f['event'] === 'agent_state' && f['state'] === 'break' && f['break_reason'] === 'soft_phone'));
    expect((await runtime.agents.get(session.id))?.state).toBe('break');

    // On the soft phone now: pacing must never reserve this agent.
    await insertAgencyContact(campaign.id, { tenant_id: TENANT, account_id: ACCOUNT, phone_e164: '+919811100071' });
    await sleep(1_200);
    expect(station.frames.filter((f) => f['event'] === 'reserved')).toHaveLength(1);

    const placed = await runtime.softphone.placeCall(actor(agent), { sessionId: session.id, to: '+919811100072', campaignId: campaign.id });
    if (!placed.ok) throw new Error(placed.refusal.code);
    const leg = await webrtcCallIdOf(placed.call.id);
    answer(leg);
    await waitFor('bridged', () => lastCall(station)?.state === 'bridged');

    const whileLive = await runtime.softphone.returnFromSoftphone(session.id, actor(agent));
    expect(whileLive.ok ? null : whileLive.refusal.code).toBe('manual_call_live');
    await runtime.softphone.hangup(actor(agent), placed.call.id);
    await carrierEnded(leg);
    await waitFor('awaiting outcome', () => lastCall(station)?.requires_disposition);
    const whileOwed = await runtime.softphone.returnFromSoftphone(session.id, actor(agent));
    expect(whileOwed.ok ? null : whileOwed.refusal.code).toBe('manual_call_live');
    // The available route's write is refused too (the Lua guard).
    const avail = await setAvailableGuarded(runtime.agents, session.id);
    expect(avail.ok ? null : avail.refusal.code).toBe('manual_call_live');
    expect((await runtime.agents.get(session.id))?.state).toBe('break');

    const outcome = await runtime.softphone.submitDisposition(actor(agent), placed.call.id, { code: 'voicemail' });
    expect(outcome.ok).toBe(true);
    const back = await runtime.softphone.returnFromSoftphone(session.id, actor(agent));
    if (!back.ok) throw new Error(back.refusal.code);
    expect(back.response.state).toBe('available');
    expect((await runtime.agents.get(session.id))?.state).toBe('available');
    // Off the pool again before the next test.
    await runtime.agents.set(session.id, 'break');
  }, 40_000);

  it('pacing headroom shrinks by a live manual call on the account', async () => {
    const campaignAgent = randomUUID();
    const phoneAgent = randomUUID();
    const campaign = await insertAgencyCampaign({
      tenant_id: TENANT, account_id: NARROW_ACCOUNT, status: 'running', wrapup_seconds: 0,
      disposition_catalog: JSON.stringify([]),
    });
    const tag = await insertAgencyCampaign({ tenant_id: TENANT, account_id: NARROW_ACCOUNT });
    await insertAgencyContact(campaign.id, { tenant_id: TENANT, account_id: NARROW_ACCOUNT, phone_e164: '+919811100080' });

    // The soft-phone call takes the account's only slot first.
    const phoneSession = await softphoneSession(phoneAgent, NARROW_ACCOUNT);
    const phoneStation = await openStation(phoneSession.id);
    const placed = await runtime.softphone.placeCall(actor(phoneAgent, { accountId: NARROW_ACCOUNT }), {
      sessionId: phoneSession.id, to: '+919811100081', campaignId: tag.id,
    });
    if (!placed.ok) throw new Error(placed.refusal.code);
    const leg = await webrtcCallIdOf(placed.call.id);

    const session = await campaignSession(campaign.id, campaignAgent, NARROW_ACCOUNT);
    const station = await openStation(session.id);
    await runtime.agents.set(session.id, 'available', { leaseMs: AGENT_LEASE_MS.available });
    await agencyAgentSessionRepository.setState(session.id, 'available');
    await sleep(2_500);
    expect(station.frames.some((f) => f['event'] === 'reserved')).toBe(false);

    // The manual call ends unanswered: the slot frees and pacing dials.
    ringOut(leg);
    await waitFor('manual call settled', () => lastCall(phoneStation)?.settled_at);
    const reserved = await waitFor('reservation after the slot frees', () =>
      station.frames.find((f) => f['event'] === 'reserved'), 15_000);
    const attemptId = reserved['attempt'].attempt_id as string;
    const campaignLeg = await waitFor('campaign leg', async () => {
      const { rows } = await getTestPool().query('SELECT webrtc_call_id FROM agency_call_attempts WHERE id = $1', [attemptId]);
      return rows[0]?.webrtc_call_id ?? null;
    });
    ringOut(campaignLeg);
    await waitFor('attempt ended', async () => {
      const { rows } = await getTestPool().query('SELECT state FROM agency_call_attempts WHERE id = $1', [attemptId]);
      return rows[0]?.state === 'ended';
    });
    await runtime.agents.set(session.id, 'break');
  }, 40_000);
});
