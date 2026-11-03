import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * A dial that fails inside the bridge after its session is registered and before the carrier
 * is asked, through the WHOLE server: the real app and station socket, the real pacing
 * engine and dialer, the real `WebRtcBridgeManager` and `VoicelinkAdapter` against the mock
 * VoiceLink carrier, real Postgres and Redis. The carrier-token store is the failure (it is
 * the awaited step in that window); it is injected on the real `BridgeWsTokens`.
 *
 * Before the fix the throw escaped `placeOutboundLeg` with the session still registered: its
 * concurrency slots and their Redis locks, its lease entry, its carrier tokens, its 30-minute
 * max-duration timer and its listeners on the agent's station socket all stayed until the
 * timer fired.
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
import { agencyAgentSessionRepository } from '../../../src/db/repositories/agency.repository.js';
import { AGENT_LEASE_MS } from '../../../src/agency/agent-state-machine.js';
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

  afterAll(async () => {
    vi.restoreAllMocks();
    if (pinger) clearInterval(pinger);
    if (station && station.readyState !== WebSocket.CLOSED) {
      const ws = station;
      await new Promise<void>((resolve) => { ws.once('close', () => resolve()); ws.close(); });
    }
    if (stopAgency) await stopAgency();
    if (stopVoice) await stopVoice();
    await stopLoadRig(rig);
    await resetAgencyRuntimeForTests();
    await closeLoadDb();
  });

  it('a token-store failure: no session, slots, lease, timer or media token left; the attempt failed uncharged; one release per dial', async () => {
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

    // The first dial's provider-token store throws with its session registered; its webhook
    // token is stored, so teardown has a real key to deal with.
    const failedCalls = new Map<string, { maxDurationTimer: unknown } | undefined>();
    const realStore = BridgeWsTokens.prototype.storeWsToken;
    vi.spyOn(BridgeWsTokens.prototype, 'storeWsToken').mockImplementation(async function (
      this: BridgeWsTokens, callId, token, ttl, purpose,
    ) {
      if (failedCalls.size === 0 || failedCalls.has(callId)) {
        failedCalls.set(callId, r.bridge.getSession(callId) as unknown as { maxDurationTimer: unknown });
        if (purpose === 'provider') throw new Error('token store failed');
      }
      return realStore.call(this, callId, token, ttl, purpose);
    });

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
  }, 60_000);
});
