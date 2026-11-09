import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The `wrapup` lease outlives a real write-up (docs/inbound.md §4.3, §6): the station heartbeat
 * renews it while this process vouches for the wrap-up (`heartbeatLeaseMs`), so the end of a
 * wrap-up longer than any one lease still finds the agent `wrapup` in Redis. Before, nothing renewed
 * it: 15 s after a wrap-up began the agent had no key, the inbound release hook declined (`live:
 * null`), the agent went `available` before reaching the caller who waited for them, and a `/break`
 * asked for during the write-up was applied at once and undone by the outcome save.
 *
 * Wall-clock lane: these wait on real Redis TTLs and the console's real 10 s ping. Each proof is
 * longer than a lease: a real 20 s write-up (past the 15 s lease the wrap-up had), and leases cut to
 * a second and a half (as if all but that of their 45 s had passed) that the next ping must restore.
 *
 * Real: Postgres, this lane's Redis, the app on loopback, the voice and agency bootstraps, the
 * station sockets (the simulated fleet), the mock Plivo carrier.
 */

const { env } = vi.hoisted(() => {
  const e = {
    FF_AGENCY_DIALER: 'true',
    PLIVO_WEBHOOK_BASE_URL: 'https://agency.test/api/v1/webhooks/plivo',
    VOICELINK_WEBHOOK_BASE_URL: 'https://agency.test/api/v1/webhooks/voicelink',
    PLIVO_REQUEST_TIMEOUT_MS: '3000',
    MAX_CONCURRENT_CALLS: '100000',
    RATE_LIMIT_WEBHOOK_MAX: '1000000',
    RATE_LIMIT_CARRIER_MEDIA_MAX: '1000000',
    LOG_LEVEL: 'warn',
  };
  Object.assign(process.env, e);
  return { env: e };
});

import { callCore } from '../../../src/api/core-dispatch.js';
import { getAgencyRuntime } from '../../../src/bootstrap/agency.js';
import { AGENT_LEASE_MS } from '../../../src/agency/agent-state-machine.js';
import { getTestRedis } from '../../helpers/test-redis.js';
import { insertAgencyAttempt } from '../agency/agency-factories.js';
import {
  ACCOUNT, PLIVO_E2E_ENV, TENANT, closePlivoDb, initPlivoDb, startPlivoRig, waitFor, type PlivoRig,
} from './plivo-rig.js';
import {
  agentUser, callerScript, callers, campaign, contact, finish, framesOf, joinAgent, liveOf, ring, setRoute, spineWhen,
  startInboundWorld, stateFrames, type InboundWorld,
} from './inbound-connect-rig.js';
import type { FleetAgent } from '../../mocks/station-fleet.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const LATER = () => new Date(Date.now() + 86_400_000);

let rig: PlivoRig | null = null;
let world: InboundWorld;

beforeAll(() => {
  expect(env).toEqual(PLIVO_E2E_ENV);
  initPlivoDb();
});
beforeEach(async () => {
  callers.hangUpAll = false;
  rig = await startPlivoRig();
  world = await startInboundWorld(rig);
  // Only the owner may take their caller, and nobody overflows while a write-up runs.
  await setRoute(world, { sticky_mode: 'strict', queue_max_wait_seconds: 180 });
});
afterEach(async () => {
  callers.hangUpAll = true;
  await world?.fleet.closeAll();
  await rig?.carrier.settled();
  await rig?.stop();
  rig = null;
});
afterAll(closePlivoDb);

/** The agent's lease key in Redis (whatever the runtime's prefix). */
async function leaseKey(sessionId: string): Promise<string> {
  const keys = await getTestRedis().keys(`*agency:agent:${sessionId}:state`);
  expect(keys).toHaveLength(1);
  return keys[0]!;
}

/** All but `ms` of the lease's life has passed: the next renewal must restore it, or it lapses. */
async function cutLease(sessionId: string, ms = 1500): Promise<string> {
  const key = await leaseKey(sessionId);
  expect(await getTestRedis().pexpire(key, ms)).toBe(1);
  return key;
}

/** One console ping, then past the cut lease's end: it is alive only if that ping renewed it. */
async function pingPastTheCut(agent: FleetAgent, key: string): Promise<void> {
  agent.leg!.ping();
  await sleep(2500);
  expect(await getTestRedis().pttl(key), 'the lease after the ping').toBeGreaterThan(30_000);
}

/** A campaign wrap-up owing its outcome, as the dialer enters one after a conversation. */
async function campaignWrapup(agent: FleetAgent, campaignId: string, contactId: string): Promise<string> {
  const now = new Date();
  const attempt = await insertAgencyAttempt(campaignId, contactId, {
    tenant_id: TENANT, account_id: ACCOUNT, state: 'ended', outcome: 'connected', reserved_agent_id: agent.sessionId,
    dialed_at: new Date(now.getTime() - 60_000), answered_at: new Date(now.getTime() - 55_000), bridged_at: new Date(now.getTime() - 55_000), ended_at: now,
  });
  const entered = await getAgencyRuntime()!.wrapup.enter({
    sessionId: agent.sessionId, attemptId: attempt.id as string, campaignId, tenantId: TENANT,
    wrapupSeconds: 0, autoReturn: false, requiresDisposition: true,
  });
  expect(entered).toBe(true);
  return attempt.id as string;
}

/** The owner on an inbound call from another number, connected. */
async function busyWithCaller(agent: FleetAgent, from: string): Promise<{ release: () => void; id: string }> {
  let done = false;
  const call = ring(world, callerScript(() => done, { timeoutMs: 120_000 }), from);
  const row = await spineWhen(call, `the first caller connected to ${agent.label}`, (r) => r.state === 'connected' && r.session_id === agent.sessionId);
  return { release: () => { done = true; }, id: row.id };
}

describe('the wrap-up lease outlives the write-up (the heartbeat renews it while a wrap-up is vouched for)', () => {
  it('a campaign wrap-up longer than the old 15 s lease: still `wrapup` at its end, and the waiting sticky caller takes the agent straight from it (no `available` between)', async () => {
    const owner = await agentUser();
    const campaignId = await campaign(world);
    const contactId = await contact(campaignId, { assigned_user_id: owner, assigned_at: new Date(), next_attempt_at: LATER() });
    const a = await joinAgent(world, campaignId, { userId: owner });
    a.leg!.startHeartbeat(10_000); // the console's cadence
    const attemptId = await campaignWrapup(a, campaignId, contactId);

    let hangUp = false;
    const call = ring(world, callerScript(() => hangUp, { timeoutMs: 120_000 }));
    const queued = await spineWhen(call, 'queued for the owner', (r) => r.state === 'queued');
    expect(queued.sticky_user_id).toBe(owner);
    await waitFor('customer_waiting to the owner', () => framesOf(a, 'customer_waiting').length > 0);

    // A real write-up: 20 s, past the 15 s the lease used to give it.
    await sleep(20_000);
    expect(await liveOf(a.sessionId)).toMatchObject({ state: 'wrapup', attemptId });
    // Renewed, not merely long: cut to its last 1.5 s, the next ping restores it.
    await pingPastTheCut(a, await cutLease(a.sessionId));
    expect(await liveOf(a.sessionId)).toMatchObject({ state: 'wrapup', attemptId });

    // The outcome is saved: the release hook takes the owner for their caller from `wrapup`.
    const statesBefore = stateFrames(a).length;
    expect(await getAgencyRuntime()!.wrapup.noteDisposition(a.sessionId, attemptId)).toBe(true);
    const taken = await spineWhen(call, 'connected to the owner', (r) => r.state === 'connected');
    expect(taken.session_id).toBe(a.sessionId);
    expect(stateFrames(a).slice(statesBefore)).toEqual(['reserved', 'on_call']);
    a.leg!.stopHeartbeat();
    hangUp = true;
  }, 60_000);

  it('an inbound wrap-up past its lease keeps its `inbound` claim; the outcome saved hands the owner the caller who waited, with no `available` instant', async () => {
    const owner = await agentUser();
    const campaignId = await campaign(world);
    await contact(campaignId, { assigned_user_id: owner, assigned_at: new Date(), next_attempt_at: LATER() });
    const a = await joinAgent(world, campaignId, { userId: owner });
    const first = await busyWithCaller(a, '447700900311');

    let hangUp = false;
    const call = ring(world, callerScript(() => hangUp, { timeoutMs: 120_000 }));
    await spineWhen(call, 'queued for the owner', (r) => r.state === 'queued');
    await waitFor('customer_waiting to the owner', () => framesOf(a, 'customer_waiting').length > 0);
    first.release();
    await waitFor('owner in the inbound wrap-up', async () => (await liveOf(a.sessionId))?.state === 'wrapup');

    await pingPastTheCut(a, await cutLease(a.sessionId));
    expect(await liveOf(a.sessionId)).toMatchObject({ state: 'wrapup', inboundCallId: first.id });

    const statesBefore = stateFrames(a).length;
    const saved = await finish('POST', `${first.id}/disposition`, owner, { code: 'voicemail' });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    const taken = await spineWhen(call, 'connected to the owner', (r) => r.state === 'connected');
    expect(taken.session_id).toBe(a.sessionId);
    expect(stateFrames(a).slice(statesBefore)).toEqual(['reserved', 'on_call']);
    hangUp = true;
  }, 60_000);

  it('`/break` during an inbound wrap-up past its lease is queued (not applied), and the outcome save applies it: the agent goes on break, not back to the pool', async () => {
    const owner = await agentUser();
    const campaignId = await campaign(world);
    const a = await joinAgent(world, campaignId, { userId: owner });
    const first = await busyWithCaller(a, '447700900312');
    first.release();
    await waitFor('owner in the inbound wrap-up', async () => (await liveOf(a.sessionId))?.state === 'wrapup');
    await pingPastTheCut(a, await cutLease(a.sessionId));

    const asked = await callCore({
      method: 'POST', path: `/agency/sessions/${a.sessionId}/break`, body: { reason: 'lunch', agent_user_id: owner }, tenantId: TENANT, accountId: ACCOUNT,
    });
    expect(asked.status, JSON.stringify(asked.body)).toBe(200);
    expect(asked.body).toMatchObject({ state: 'wrapup', pending_state: 'break', break_reason: 'lunch' });
    expect(await liveOf(a.sessionId)).toMatchObject({ state: 'wrapup', inboundCallId: first.id });

    const saved = await finish('POST', `${first.id}/disposition`, owner, { code: 'voicemail' });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    await waitFor('on the break they asked for', async () => (await liveOf(a.sessionId))?.state === 'break');
    expect(await liveOf(a.sessionId)).toMatchObject({ inboundCallId: null });
    expect(stateFrames(a)).not.toContain('available');
  }, 60_000);

  it('a `wrapup` lease nothing here vouches for (a previous process left it) is not renewed: it lapses', async () => {
    const campaignId = await campaign(world);
    const b = await joinAgent(world, campaignId, { available: false });
    // No wrap-up in this process, no inbound outcome owed: a key a crashed process left behind.
    await getAgencyRuntime()!.agents.set(b.sessionId, 'wrapup', { leaseMs: AGENT_LEASE_MS.wrapup });
    const key = await cutLease(b.sessionId);
    b.leg!.ping();
    await sleep(2500);
    expect(await getTestRedis().exists(key)).toBe(0);
    expect(await liveOf(b.sessionId)).toBeNull();
  }, 30_000);
});
