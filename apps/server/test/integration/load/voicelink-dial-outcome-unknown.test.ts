import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * A dial the carrier refused, through the WHOLE server against the mock VoiceLink carrier:
 * the real app and station socket, the real pacing engine and dialer, the real
 * `WebRtcBridgeManager`, provider registry and `VoicelinkAdapter` (`add_lead` over HTTP),
 * and real Postgres. The carrier's faults are the only script.
 *
 * The bridge ends a refused dial before the dial call rejects: `endCall` emits `ended`
 * (`telephony_init_failed`) and then `createBridgedCall` throws. Each refusal must be
 * settled exactly once:
 *
 *  - **Outcome unknown** (a 200 whose body is not JSON, and an `add_lead` that times out:
 *    the carrier may have queued the lead). The dial's failure path settles it: the
 *    attempt `failed`, NO attempt charged to the contact, and the contact `pending` but
 *    not dialable until `DIAL_OUTCOME_UNKNOWN_REDIAL_DELAY_MS` after `dialed_at`. The
 *    campaign's own `failed` retry delay (1 minute here) must not decide it. Before the
 *    fix the `ended` arm settled it first, through that policy (`attempt_count` 1, next
 *    attempt in a minute), and the hold's `unclaim` then found nothing `in_flight`.
 *  - **Plain refusal** (a 500). The `ended` arm settles it through the retry policy, and
 *    the dial's failure path must find nothing left to abandon. Before the fix it
 *    abandoned again: a second `released` frame and a second release of the agent.
 *
 * Either way the agent is told once, released once, and nothing leaks.
 */

vi.hoisted(() => {
  Object.assign(process.env, {
    FF_AGENCY_DIALER: 'true',
    VOICELINK_WEBHOOK_BASE_URL: 'https://agency.test/api/v1/webhooks/voicelink',
    VOICELINK_USERNAME: 'mock-vl-user',
    VOICELINK_PASSWORD: 'mock-vl-password',
    // The schema's floor: a hung `add_lead` is abandoned after one second.
    VOICELINK_ADD_LEAD_TIMEOUT_MS: '1000',
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
import { agencyAgentSessionRepository } from '../../../src/db/repositories/agency.repository.js';
import { AGENT_LEASE_MS } from '../../../src/agency/agent-state-machine.js';
import { DIAL_OUTCOME_UNKNOWN_REDIAL_DELAY_MS } from '../../../src/telephony/carrier-errors.js';
import { insertAgencyCampaign, insertAgencyContact } from '../agency/agency-factories.js';
import {
  LOAD_ACCOUNT, LOAD_TENANT, assertNoLeaks, closeLoadDb, initLoadDb, startLoadRig, stopLoadRig,
  waitFor, type LoadRig,
} from './voicelink-load-harness.js';

/** A `failed` retry shorter than the hold, so a policy-settled contact is visibly wrong. */
const RETRY_POLICY = {
  failed: { delay_minutes: 1, max_attempts: 5 },
  ...Object.fromEntries(
    ['no_answer', 'busy', 'abandoned', 'agent_disconnected', 'orphaned', 'canceled'].map((o) => [o, { max_attempts: 0 }]),
  ),
};

interface AttemptRow {
  id: string;
  contact_id: string;
  state: string;
  outcome: string | null;
  dialed_at: Date;
  error_code: string | null;
  contact_state: string;
  attempt_count: number;
  our_fault_attempts: number;
  next_attempt_at: Date;
}

describe('a dial the carrier refused is settled once, through the real bridge and the mock carrier', () => {
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

  it('holds an outcome-unknown dial\'s contact for 15 min uncharged, settles a plain refusal by policy, and releases the agent once per dial', async () => {
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
        tenant_id: LOAD_TENANT, account_id: LOAD_ACCOUNT,
        phone_e164: `+9197${String(20_000_000 + i).padStart(8, '0')}`, source_row_number: i + 1,
      });
    }
    // One fault per dial, in dial order: two outcome-unknown, one plain refusal.
    r.carrier.injectFault('add_lead', { kind: 'malformed' });
    r.carrier.injectFault('add_lead', { kind: 'hang' });
    r.carrier.injectFault('add_lead', { kind: 'status', status: 500 });

    const ctx: AppContext = { config, pool: getPool(), redis: getTestRedis() };
    stopVoice = await startVoice(ctx);
    stopAgency = await startAgency(ctx);
    const runtime = getAgencyRuntime()!;
    const port = new URL(r.origin).port;

    const join = await agencyAgentSessionRepository.joinOrRehydrate({
      tenantId: LOAD_TENANT, accountId: LOAD_ACCOUNT, campaignId: campaign.id as string,
      agentUserId: '6c1d0c8e-3d0e-4c7a-8b44-00000000a001', replicaId: runtime.replicaId,
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
      `SELECT a.id, a.contact_id, a.state, a.outcome, a.dialed_at, k.error_code,
              c.state AS contact_state, c.attempt_count, c.our_fault_attempts, c.next_attempt_at
         FROM agency_call_attempts a
         JOIN agency_contacts c ON c.id = a.contact_id
         LEFT JOIN agency_calls k ON k.agency_attempt_id = a.id
        WHERE a.campaign_id = $1
        ORDER BY a.dialed_at`,
      [campaign.id],
    )).rows;

    // The three dials, each refused, settled and the agent back in the pool.
    await waitFor('three refused dials settled', async () => {
      const rows = await readAttempts();
      return rows.length === 3
        && rows.every((a) => a.state === 'ended')
        && runtime.dialer.activeAttemptIds().length === 0
        && (await runtime.agents.get(sessionId))?.state === 'available';
    }, 30_000, async () => JSON.stringify(await readAttempts()));
    // Room for a second settle of any of them to land, had one been started.
    await new Promise((resolve) => setTimeout(resolve, 500));

    const attempts = await readAttempts();
    expect(attempts).toHaveLength(3);
    expect(new Set(attempts.map((a) => a.contact_id)).size, 'a contact was dialled twice').toBe(3);
    expect(attempts.map((a) => a.error_code)).toEqual([
      'TELEPHONY_INIT_OUTCOME_UNKNOWN', 'TELEPHONY_INIT_OUTCOME_UNKNOWN', 'TELEPHONY_INIT_FAILED',
    ]);

    for (const a of attempts.slice(0, 2)) {
      const what = `outcome-unknown attempt ${a.id}`;
      expect({ state: a.state, outcome: a.outcome }, what).toEqual({ state: 'ended', outcome: 'failed' });
      expect({ contact: a.contact_state, charged: a.attempt_count, ourFault: a.our_fault_attempts }, what)
        .toEqual({ contact: 'pending', charged: 0, ourFault: 0 });
      expect(a.next_attempt_at.getTime(), `${what}: dialable before the carrier rule's hold`)
        .toBeGreaterThanOrEqual(a.dialed_at.getTime() + DIAL_OUTCOME_UNKNOWN_REDIAL_DELAY_MS);
    }

    const plain = attempts[2]!;
    expect({ state: plain.state, outcome: plain.outcome }).toEqual({ state: 'ended', outcome: 'failed' });
    expect({ contact: plain.contact_state, charged: plain.attempt_count }).toEqual({ contact: 'pending', charged: 1 });
    // The campaign's own `failed` delay, a minute, not the hold.
    expect(plain.next_attempt_at.getTime()).toBeLessThan(plain.dialed_at.getTime() + DIAL_OUTCOME_UNKNOWN_REDIAL_DELAY_MS);

    // Told once per dial, and nothing held for the reaper.
    const released = frames.filter((f) => f['event'] === 'released').map((f) => f['attempt_id']);
    expect(released.sort()).toEqual(attempts.map((a) => a.id).sort());
    expect(runtime.dialer.unrecordedEndedAttempts()).toEqual([]);
    expect(r.carrier.requests.filter((q) => q.route === 'add_lead')).toHaveLength(3);

    // The agent's own station socket stays open; nothing else may.
    await assertNoLeaks(r, [], 1);
  }, 60_000);
});
