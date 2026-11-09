import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, initDbPool } from '@magick-agency/db';
import { AGENCY_INBOUND_ROUTE_LIMITS } from '@magick-agency/contracts/agency';
import { TEST_DB_URL } from '../../../../../packages/db/test/helpers/test-db.js';
import { getTestPool, truncateAll } from '../setup/test-utils.js';
import { DEFAULTS, insertTenant } from '../setup/factories.js';
import {
  AgencyInboundCallRouter,
  INBOUND_MAX_PARKED_SECONDS,
  INBOUND_VOICEMAIL_BUDGET_SECONDS,
  parkedSecondsFor,
} from '../../../src/agency/inbound/inbound-call-router.js';
import { INBOUND_SWEEP_STALE_AFTER_MS } from '../../../src/agency/inbound/start.js';
import { WEBRTC_MAX_DURATION_SECONDS } from '../../../src/config/call-duration-limits.js';
import { agencyInboundCallRepository as repo, type AgencyInboundCallRecord } from '../../../src/db/repositories/agency.repository.js';

/**
 * The periodic stale sweep never ends a live call (SWE-m1, docs/inbound.md §10). A call can live
 * its parked budget (the queue's maximum wait, the preamble and the exit: at most
 * {@link INBOUND_MAX_PARKED_SECONDS}) before the bind, then the whole max duration the bind
 * re-arms. So the sweep picks on the call's latest start (`COALESCE(bridged_at, arrived_at)`) and
 * its cutoff is past the longest parked budget plus the max duration. Before, it picked on the
 * arrival alone at the max duration + 10 minutes, and ended a caller who waited 15 minutes and then
 * talked toward the ceiling mid-call (the row `answered`, the agent's Hang up a no-op after).
 *
 * Mutation-checked: `sweepStale` on `arrived_at` alone sweeps the long-parked live call of the
 * repository test (red); `INBOUND_SWEEP_STALE_AFTER_MS` back to the max duration + 10 minutes
 * fails the bound (red).
 */

const T = DEFAULTS.tenantId;
const A = DEFAULTS.accountId;
const pool = () => getTestPool();
let credentialId: string;

async function connected(arrivedAgoS: number, bridgedAgoS: number): Promise<AgencyInboundCallRecord> {
  const { call } = await repo.insertArrival({
    tenantId: T, accountId: A, routeId: null, phoneNumberId: null, provider: 'plivo', telephonyCredentialId: credentialId,
    providerCallId: `CA-${randomUUID()}`, fromE164: '+447700900777', toE164: '+14155550100',
    identification: { match: null, callerDnc: false, sticky: null }, answered: true, recordingRequested: false, analysisProfileId: null,
  });
  const session = randomUUID();
  await repo.transition(call!.id, 'queued');
  await repo.offer(call!.id, session);
  await repo.connect(call!.id, { sessionId: session, answeredByUserId: randomUUID() });
  await pool().query(
    `UPDATE agency_inbound_calls SET arrived_at = now() - make_interval(secs => $2), offered_at = now() - make_interval(secs => $3),
            queued_at = now() - make_interval(secs => $2), bridged_at = now() - make_interval(secs => $3) WHERE id = $1`,
    [call!.id, arrivedAgoS, bridgedAgoS]);
  return call!;
}

async function waiting(arrivedAgoS: number): Promise<AgencyInboundCallRecord> {
  const { call } = await repo.insertArrival({
    tenantId: T, accountId: A, routeId: null, phoneNumberId: null, provider: 'plivo', telephonyCredentialId: credentialId,
    providerCallId: `CA-${randomUUID()}`, fromE164: '+447700900778', toE164: '+14155550100',
    identification: { match: null, callerDnc: false, sticky: null }, answered: true, recordingRequested: false, analysisProfileId: null,
  });
  await repo.transition(call!.id, 'queued');
  await pool().query(`UPDATE agency_inbound_calls SET arrived_at = now() - make_interval(secs => $2), queued_at = now() - make_interval(secs => $2) WHERE id = $1`, [call!.id, arrivedAgoS]);
  return call!;
}

const state = async (id: string) => (await repo.findByIdAnyTenant(id))!;

beforeAll(() => { initDbPool({ url: TEST_DB_URL, poolMin: 0, poolMax: 4 }); });
beforeEach(async () => {
  await truncateAll();
  await pool().query(`INSERT INTO telephony_providers (name, display_name) VALUES ('plivo', 'Plivo')`);
  await insertTenant({ id: T });
  credentialId = (await pool().query<{ id: string }>(
    `INSERT INTO telephony_credentials (tenant_id, provider, label, account_ref) VALUES ($1, 'plivo', 'Main', 'MA000000000000000002') RETURNING id`, [T])).rows[0]!.id;
});
afterAll(async () => { await truncateAll(); await closePool(); });

describe('the periodic stale sweep never ends a live call (SWE-m1)', () => {
  it('its cutoff is past the longest parked budget plus the max duration (any call ends before it)', () => {
    expect(INBOUND_MAX_PARKED_SECONDS).toBe(parkedSecondsFor({ queue_max_wait_seconds: AGENCY_INBOUND_ROUTE_LIMITS.QUEUE_MAX_WAIT_SECONDS.max }));
    expect(INBOUND_MAX_PARKED_SECONDS).toBeGreaterThanOrEqual(INBOUND_VOICEMAIL_BUDGET_SECONDS);
    expect(INBOUND_SWEEP_STALE_AFTER_MS).toBeGreaterThan((WEBRTC_MAX_DURATION_SECONDS + INBOUND_MAX_PARKED_SECONDS) * 1000);
  });

  it('sweepStale picks on the latest start: a call that arrived before the cutoff but bridged after it is live', async () => {
    const live = await connected(3600, 600);
    const stale = await connected(3600, 3500);
    const swept = await repo.sweepStale(new Date(Date.now() - 1800_000), 100);
    expect(swept.map((r) => r.id)).toEqual([stale.id]);
    expect(await state(live.id)).toMatchObject({ state: 'connected' });
  });

  it('a caller parked the longest, then talking toward the ceiling, is left alone; past every budget, the sweep ends them', async () => {
    const router = new AgencyInboundCallRouter({ bridge: {} as never, dnc: { check: async () => 'clear', checkEntry: async () => ({ result: 'clear' }) } as never });
    const cutoff = () => new Date(Date.now() - INBOUND_SWEEP_STALE_AFTER_MS);
    const talking = await connected(INBOUND_MAX_PARKED_SECONDS + WEBRTC_MAX_DURATION_SECONDS - 60, WEBRTC_MAX_DURATION_SECONDS - 60);
    const parkedWaiting = await waiting(INBOUND_MAX_PARKED_SECONDS - 60);
    const pastBridged = await connected(INBOUND_SWEEP_STALE_AFTER_MS / 1000 + 120, INBOUND_SWEEP_STALE_AFTER_MS / 1000 + 60);
    const pastWaiting = await waiting(INBOUND_SWEEP_STALE_AFTER_MS / 1000 + 60);

    expect(await router.sweep(cutoff())).toBe(2);
    expect(await state(talking.id)).toMatchObject({ state: 'connected', ended_at: null });
    expect(await state(parkedWaiting.id)).toMatchObject({ state: 'queued' });
    expect(await state(pastBridged.id)).toMatchObject({ state: 'ended', outcome: 'answered', settled_at: null });
    expect(await state(pastWaiting.id)).toMatchObject({ state: 'ended', outcome: 'failed', follow_up_reason: 'failed' });
  });
});
