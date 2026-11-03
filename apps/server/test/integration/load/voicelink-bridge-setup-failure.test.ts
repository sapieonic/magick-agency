import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * A dial that fails inside the bridge after its session is registered and before the carrier
 * is asked, through the WHOLE server: the real app and station socket, the real pacing
 * engine and dialer, the real `WebRtcBridgeManager` and `VoicelinkAdapter` against the mock
 * VoiceLink carrier, real Postgres and Redis. Two failures in that window, each injected on
 * the real class:
 *
 *  - the carrier-token store (`BridgeWsTokens`), the awaited step in it;
 *  - what the carrier request is built from (`WebhookUrlBuilder.baseUrl`: a missing webhook
 *    base). That step sat inside the carrier request's `try`, so its throw was reported as
 *    the carrier refusing the dial (`TELEPHONY_INIT_FAILED`, with an `ended`), and the
 *    dialer charged the contact's `failed` allowance for a dial the carrier never saw.
 *
 * Before the teardown fix a throw escaped `placeOutboundLeg` with the session still
 * registered: its concurrency slots and their Redis locks, its lease entry, its carrier
 * tokens, its 30-minute max-duration timer and its listeners on the agent's station socket
 * all stayed until the timer fired.
 *
 * The leg was never placed, so the failure is the dial's to settle, once, as any other dial
 * that never reached the carrier: the attempt `failed`, the contact back in the queue with
 * NO attempt charged, the agent told once and released. The bridge emits no `ended` for it:
 * the dialer's `ended` arm would settle it as a placed call, on the contact's own `failed`
 * allowance. The contact's next dial (refused by the carrier here, which IS charged) shows
 * the queue moved on, with one request to the carrier in all.
 */

vi.hoisted(() => {
  Object.assign(process.env, {
    FF_AGENCY_DIALER: 'true',
    VOICELINK_WEBHOOK_BASE_URL: 'https://agency.test/api/v1/webhooks/voicelink',
    VOICELINK_USERNAME: 'mock-vl-user',
    VOICELINK_PASSWORD: 'mock-vl-password',
    MAX_CONCURRENT_CALLS: '100000',
    RATE_LIMIT_WEBHOOK_MAX: '1000000',
    RATE_LIMIT_CARRIER_MEDIA_MAX: '1000000',
    LOG_LEVEL: 'error',
  });
});

import WebSocket from 'ws';
import { getPool } from '@magick-agency/db';
import { getTestPool } from '../../../../../packages/db/test/helpers/test-db.js';
import { getTestRedis } from '../../helpers/test-redis.js';
import { config } from '../../../src/config/index.js';
import type { AppContext } from '../../../src/app-context.js';
import { getAgencyRuntime, resetAgencyRuntimeForTests, startAgency } from '../../../src/bootstrap/agency.js';
import { startVoice } from '../../../src/bootstrap/voice.js';
import { BridgeWsTokens } from '../../../src/core/bridge/ws-tokens.js';
import { WebhookUrlBuilder } from '../../../src/core/webhook-url-builder.js';
import { webrtcCallRepository } from '@magick-agency/db/repositories/agency-call.repository';
import { agencyAgentSessionRepository } from '../../../src/db/repositories/agency.repository.js';
import { AGENT_LEASE_MS } from '../../../src/agency/agent-state-machine.js';
import { PRE_CARRIER_FAILURE_REDIAL_DELAY_MS } from '../../../src/agency/agency-dialer.js';
import { insertAgencyCampaign, insertAgencyContact } from '../agency/agency-factories.js';
import {
  LOAD_ACCOUNT, LOAD_TENANT, assertNoLeaks, closeLoadDb, initLoadDb, startLoadRig, stopLoadRig,
  waitFor, type LoadRig,
} from './voicelink-load-harness.js';

/** The carrier's refusal of the second dial is charged and held off for an hour. */
const RETRY_POLICY = {
  failed: { delay_minutes: 60, max_attempts: 5 },
  ...Object.fromEntries(
    ['no_answer', 'busy', 'abandoned', 'agent_disconnected', 'orphaned', 'canceled'].map((o) => [o, { max_attempts: 0 }]),
  ),
};

interface AttemptRow {
  id: string;
  contact_id: string;
  state: string;
  outcome: string | null;
  call_id: string | null;
  call_status: string | null;
  error_code: string | null;
  contact_state: string;
  attempt_count: number;
  our_fault_attempts: number;
}

type Failure = 'token store' | 'webhook base';

describe('a dial that fails in the bridge before the carrier is asked releases everything and is settled once', () => {
  let rig: LoadRig | null = null;
  let stopVoice: (() => Promise<void>) | null = null;
  let stopAgency: (() => Promise<void>) | null = null;
  let station: WebSocket | null = null;
  let pinger: NodeJS.Timeout | null = null;

  beforeAll(async () => {
    initLoadDb(8);
    await resetAgencyRuntimeForTests();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (pinger) clearInterval(pinger);
    pinger = null;
    if (station && station.readyState !== WebSocket.CLOSED) {
      const ws = station;
      await new Promise<void>((resolve) => { ws.once('close', () => resolve()); ws.close(); });
    }
    station = null;
    if (stopAgency) await stopAgency();
    stopAgency = null;
    if (stopVoice) await stopVoice();
    stopVoice = null;
    await stopLoadRig(rig);
    rig = null;
    await resetAgencyRuntimeForTests();
  });

  afterAll(async () => {
    await closeLoadDb();
  });

  /** Fail the first dial at `failure`, inside the registered-session window; returns its call id and session. */
  function injectFailure(r: LoadRig, failure: Failure) {
    const failedCalls = new Map<string, { maxDurationTimer: unknown } | undefined>();
    const realStore = BridgeWsTokens.prototype.storeWsToken;
    if (failure === 'token store') {
      // The provider-token store throws; its webhook token is stored, so teardown has a
      // real key to deal with.
      vi.spyOn(BridgeWsTokens.prototype, 'storeWsToken').mockImplementation(async function (
        this: BridgeWsTokens, callId, token, ttl, purpose,
      ) {
        if (failedCalls.size === 0 || failedCalls.has(callId)) {
          failedCalls.set(callId, r.bridge.getSession(callId) as unknown as { maxDurationTimer: unknown });
          if (purpose === 'provider') throw new Error('token store failed');
        }
        return realStore.call(this, callId, token, ttl, purpose);
      });
    } else {
      // Both tokens are stored (the call's id is learnt there); then the webhook base is
      // asked for, and the first time it throws (no base configured).
      vi.spyOn(BridgeWsTokens.prototype, 'storeWsToken').mockImplementation(async function (
        this: BridgeWsTokens, callId, token, ttl, purpose,
      ) {
        if (failedCalls.size === 0) failedCalls.set(callId, r.bridge.getSession(callId) as unknown as { maxDurationTimer: unknown });
        return realStore.call(this, callId, token, ttl, purpose);
      });
      const realBase = WebhookUrlBuilder.prototype.baseUrl;
      let thrown = false;
      vi.spyOn(WebhookUrlBuilder.prototype, 'baseUrl').mockImplementation(function (this: WebhookUrlBuilder, provider) {
        if (!thrown) {
          thrown = true;
          throw new Error('no webhook base configured');
        }
        return realBase.call(this, provider);
      });
    }
    return failedCalls;
  }

  it.each<[Failure]>([['token store'], ['webhook base']])(
    'a %s failure: no session, slots, lease, timer or media token left; the attempt failed uncharged; one release per dial',
    async (failure) => {
      rig = await startLoadRig();
      const r = rig;
      const campaign = await insertAgencyCampaign({
        tenant_id: LOAD_TENANT,
        account_id: LOAD_ACCOUNT,
        status: 'running',
        wrapup_seconds: 0,
        disposition_catalog: JSON.stringify([]),
        retry_policy: JSON.stringify(RETRY_POLICY),
      });
      await insertAgencyContact(campaign.id as string, {
        tenant_id: LOAD_TENANT, account_id: LOAD_ACCOUNT, phone_e164: '+919730000001', source_row_number: 1,
      });
      // The contact's second dial reaches the carrier, which refuses it.
      r.carrier.injectFault('add_lead', { kind: 'status', status: 500 });
      const failedCalls = injectFailure(r, failure);

      const ctx: AppContext = { config, pool: getPool(), redis: getTestRedis() };
      stopVoice = await startVoice(ctx);
      stopAgency = await startAgency(ctx);
      const runtime = getAgencyRuntime()!;
      const port = new URL(r.origin).port;

      const join = await agencyAgentSessionRepository.joinOrRehydrate({
        tenantId: LOAD_TENANT, accountId: LOAD_ACCOUNT, campaignId: campaign.id as string,
        agentUserId: '6c1d0c8e-3d0e-4c7a-8b44-00000000a002', replicaId: runtime.replicaId,
      });
      if (!join.ok) throw new Error('join refused');
      const sessionId = join.session.id;
      const { token } = await runtime.tokens.mint(sessionId);
      const frames: Array<Record<string, unknown>> = [];
      station = new WebSocket(`ws://127.0.0.1:${port}/proxy/agency/station/${sessionId}?token=${token}`);
      station.on('message', (raw) => frames.push(JSON.parse(raw.toString()) as Record<string, unknown>));
      await waitFor('station ready', () => frames.some((f) => f['event'] === 'ready'));
      runtime.wrapup.cancel(sessionId, 'agent_returned');
      await runtime.agents.set(sessionId, 'available', { leaseMs: AGENT_LEASE_MS.available });
      await agencyAgentSessionRepository.setState(sessionId, 'available');
      const ws = station;
      pinger = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ event: 'ping', ts: Date.now() }));
      }, 5_000);

      const readAttempts = async (): Promise<AttemptRow[]> => (await getTestPool().query<AttemptRow>(
        `SELECT a.id, a.contact_id, a.state, a.outcome, k.id AS call_id, k.status AS call_status, k.error_code,
                c.state AS contact_state, c.attempt_count, c.our_fault_attempts
           FROM agency_call_attempts a
           JOIN agency_contacts c ON c.id = a.contact_id
           LEFT JOIN agency_calls k ON k.agency_attempt_id = a.id
          WHERE a.campaign_id = $1
          ORDER BY a.dialed_at`,
        [campaign.id],
      )).rows;

      // The failed dial gives the contact back uncharged but not at once: a failure that
      // repeats would redial it on every tick (`PRE_CARRIER_FAILURE_REDIAL_DELAY_MS`).
      await waitFor('the setup failure settled', async () => {
        const rows = await readAttempts();
        return rows.length === 1 && rows[0]!.state === 'ended' && rows[0]!.contact_state === 'pending'
          && runtime.dialer.activeAttemptIds().length === 0
          && (await runtime.agents.get(sessionId))?.state === 'available';
      }, 30_000, async () => JSON.stringify(await readAttempts()));
      const { rows: [held] } = await getTestPool().query<{ attempt_count: number; our_fault_attempts: number; wait: number }>(
        `SELECT c.attempt_count, c.our_fault_attempts,
                EXTRACT(EPOCH FROM c.next_attempt_at - a.ended_at)::float8 AS wait
           FROM agency_contacts c JOIN agency_call_attempts a ON a.contact_id = c.id
          WHERE c.campaign_id = $1`,
        [campaign.id],
      );
      expect({ charged: held!.attempt_count, ourFault: held!.our_fault_attempts }).toEqual({ charged: 0, ourFault: 0 });
      expect(held!.wait, 'dialable again on the next tick').toBeCloseTo(PRE_CARRIER_FAILURE_REDIAL_DELAY_MS / 1000, -1);
      // Two safety ticks with the agent free and the contact the only one: not redialled.
      await new Promise((resolve) => setTimeout(resolve, 2_500));
      expect(await readAttempts()).toHaveLength(1);
      // The delay runs out (moved here, not waited for): the contact's next dial goes out.
      await getTestPool().query('UPDATE agency_contacts SET next_attempt_at = now() WHERE campaign_id = $1', [campaign.id]);

      await waitFor('both dials settled', async () => {
        const rows = await readAttempts();
        return rows.length === 2
          && rows.every((a) => a.state === 'ended')
          && runtime.dialer.activeAttemptIds().length === 0
          && (await runtime.agents.get(sessionId))?.state === 'available';
      }, 30_000, async () => JSON.stringify(await readAttempts()));
      // Room for a second settle of either dial to land, had one been started.
      await new Promise((resolve) => setTimeout(resolve, 500));

      const [setupFailed, refused] = await readAttempts() as [AttemptRow, AttemptRow];
      expect(failedCalls.size).toBe(1);
      const [failedCallId, failedSession] = [...failedCalls][0]!;
      expect(failedSession, 'the failure was inside the registered-session window').toBeDefined();
      expect(setupFailed.call_id).toBe(failedCallId);

      // The setup failure: its row terminal and saying why, the attempt `failed`.
      expect({ state: setupFailed.state, outcome: setupFailed.outcome, call: setupFailed.call_status, error: setupFailed.error_code })
        .toEqual({ state: 'ended', outcome: 'failed', call: 'failed', error: 'BRIDGE_SETUP_FAILED' });
      // The carrier's refusal of the next dial.
      expect({ state: refused.state, outcome: refused.outcome, call: refused.call_status, error: refused.error_code })
        .toEqual({ state: 'ended', outcome: 'failed', call: 'failed', error: 'TELEPHONY_INIT_FAILED' });
      // Charged once, for the dial the carrier refused; the one that never left this process is not.
      expect({ contact: refused.contact_state, charged: refused.attempt_count, ourFault: refused.our_fault_attempts })
        .toEqual({ contact: 'pending', charged: 1, ourFault: 0 });
      expect(r.carrier.requests.filter((q) => q.route === 'add_lead')).toHaveLength(1);

      // No `ended` for the dial that was never placed; one for the refused one.
      const endedFor = (callId: string | null) => r.lifecycle.filter((e) => e.phase === 'ended' && e.callId === callId);
      expect(endedFor(failedCallId)).toEqual([]);
      expect(endedFor(refused.call_id)).toHaveLength(1);

      // Told once per dial, released once, nothing left for the reaper.
      const released = frames.filter((f) => f['event'] === 'released').map((f) => f['attempt_id']);
      expect(released.sort()).toEqual([setupFailed.id, refused.id].sort());
      expect(runtime.dialer.unrecordedEndedAttempts()).toEqual([]);

      // Everything the failed setup took is given back: lease entry, timer, slots and their
      // locks, the media token (`assertNoLeaks`). Its webhook token is kept only for the
      // post-end grace (Q6), as for any ended call.
      expect(r.bridge.heldLeases()).toEqual([]);
      expect(failedSession!.maxDurationTimer).toBeNull();
      const webhookTtl = await getTestRedis().ttl(`webrtc:ws-token:webhook:${failedCallId}`);
      expect(webhookTtl).toBeGreaterThan(0);
      expect(webhookTtl).toBeLessThanOrEqual(2 * 60 * 60);
      await assertNoLeaks(r, [], 1);
    },
    60_000,
  );

  /**
   * A failure that does not clear: every call row INSERT refused (a database fault, say),
   * with four agents on a short list. Each dial fails in milliseconds and frees its agent at
   * once, so before the delay the same contacts were redialled on every tick, without
   * bound. The delay caps each contact at one dial in the window, and, because nothing is
   * charged, a fault that never clears retires nobody: the list is intact when it is fixed.
   */
  it('a failure that repeats: each contact dialled once in the window, nothing charged, nobody retired', async () => {
    rig = await startLoadRig();
    const r = rig;
    const campaign = await insertAgencyCampaign({
      tenant_id: LOAD_TENANT,
      account_id: LOAD_ACCOUNT,
      status: 'running',
      wrapup_seconds: 0,
      disposition_catalog: JSON.stringify([]),
      retry_policy: JSON.stringify(RETRY_POLICY),
    });
    for (let i = 0; i < 3; i++) {
      await insertAgencyContact(campaign.id as string, {
        tenant_id: LOAD_TENANT, account_id: LOAD_ACCOUNT, phone_e164: `+91973000010${i}`, source_row_number: i + 1,
      });
    }
    const inserts = vi.spyOn(webrtcCallRepository, 'create').mockRejectedValue(new Error('insert refused'));

    const ctx: AppContext = { config, pool: getPool(), redis: getTestRedis() };
    stopVoice = await startVoice(ctx);
    stopAgency = await startAgency(ctx);
    const runtime = getAgencyRuntime()!;
    const port = new URL(r.origin).port;
    const sockets: WebSocket[] = [];
    for (let i = 0; i < 4; i++) {
      const join = await agencyAgentSessionRepository.joinOrRehydrate({
        tenantId: LOAD_TENANT, accountId: LOAD_ACCOUNT, campaignId: campaign.id as string,
        agentUserId: `6c1d0c8e-3d0e-4c7a-8b44-00000000b00${i}`, replicaId: runtime.replicaId,
      });
      if (!join.ok) throw new Error('join refused');
      const sessionId = join.session.id;
      const { token } = await runtime.tokens.mint(sessionId);
      const frames: Array<Record<string, unknown>> = [];
      const ws = new WebSocket(`ws://127.0.0.1:${port}/proxy/agency/station/${sessionId}?token=${token}`);
      ws.on('message', (raw) => frames.push(JSON.parse(raw.toString()) as Record<string, unknown>));
      await waitFor('station ready', () => frames.some((f) => f['event'] === 'ready'));
      runtime.wrapup.cancel(sessionId, 'agent_returned');
      await runtime.agents.set(sessionId, 'available', { leaseMs: AGENT_LEASE_MS.available });
      await agencyAgentSessionRepository.setState(sessionId, 'available');
      sockets.push(ws);
    }
    try {
      await waitFor('every contact dialled', async () => (await getTestPool().query(
        'SELECT DISTINCT contact_id FROM agency_call_attempts WHERE campaign_id = $1', [campaign.id])).rowCount === 3);
      // Several safety ticks with free agents and nothing else to dial.
      await new Promise((resolve) => setTimeout(resolve, 4_000));

      const { rows: perContact } = await getTestPool().query<{ dials: number; state: string; attempt_count: number; our_fault_attempts: number }>(
        `SELECT count(a.id)::int AS dials, c.state, c.attempt_count, c.our_fault_attempts
           FROM agency_contacts c LEFT JOIN agency_call_attempts a ON a.contact_id = c.id
          WHERE c.campaign_id = $1
          GROUP BY c.id`,
        [campaign.id],
      );
      expect(perContact.map((c) => c.dials), 'a contact redialled while its dials keep failing before the carrier')
        .toEqual([1, 1, 1]);
      expect(perContact.every((c) => c.state === 'pending' && c.attempt_count === 0 && c.our_fault_attempts === 0)).toBe(true);
      expect(inserts).toHaveBeenCalledTimes(3);
      expect(r.carrier.requests.filter((q) => q.route === 'add_lead')).toHaveLength(0);
    } finally {
      for (const ws of sockets) {
        if (ws.readyState !== WebSocket.CLOSED) {
          await new Promise<void>((resolve) => { ws.once('close', () => resolve()); ws.close(); });
        }
      }
    }
  }, 60_000);
});
