import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Inbound calls on the mobile app (IQ46), the cases that wait out the bridge's 8 s deferred hangup
 * (`DEFERRED_HANGUP_MS`, no override): in the wall-clock lane (`vitest.config.integration.ts`).
 * The rest are `inbound-mobile-e2e.test.ts`.
 *
 *  - A phone that took an inbound call and went silent (the sweep terminates it, M1) and does not
 *    come back: the call ends `answered` with its outcome owed (IQ17), the agent `offline`; their
 *    next station (caps=inbound) comes back on `break` with the call restored to write up.
 *  - An older app build (no `caps`) reattaching during a connected inbound call: the caller's audio
 *    is never re-adopted onto it and it is sent no inbound frame; the deferred hangup ends the call
 *    `answered`, owed, and the agent owes it in `wrapup` on that station.
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

import { getAgencyRuntime } from '../../../src/bootstrap/agency.js';
import { DEFERRED_HANGUP_MS } from '@magick-agency/domain/timers';
import { PLIVO_E2E_ENV, closePlivoDb, initPlivoDb, startPlivoRig, waitFor, type PlivoRig } from './plivo-rig.js';
import {
  CAPABLE_PHONE, callerScript, callers, campaign, finish, joinAgent, liveOf, ring, spineOf, spineWhen,
  startInboundWorld, type InboundWorld,
} from './inbound-connect-rig.js';
import type { FleetAgent, StationLeg } from '../../mocks/station-fleet.js';

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
});
afterEach(async () => {
  callers.hangUpAll = true;
  await world?.fleet.closeAll();
  await rig?.carrier.settled();
  await rig?.stop();
  rig = null;
});
afterAll(closePlivoDb);

const alawFrames = (leg: StationLeg) => leg.frames.filter((f) => f.binary);

function sweepSilent(who: FleetAgent): number {
  return getAgencyRuntime()!.sweepSilentStations((e) => ((e as { sessionId?: string }).sessionId === who.sessionId ? -1 : 1e9));
}

describe('a phone lost after the bind, past the deferred hangup (IQ17)', () => {
  it('silent on the call and not back: the call ends answered with its outcome owed, the agent offline; the next station (caps=inbound) comes back on break with the call to write up', async () => {
    const campaignId = await campaign(world);
    const phone = await joinAgent(world, campaignId, { station: CAPABLE_PHONE });
    const call = ring(world, callerScript(() => false));
    const connected = await spineWhen(call, 'connected', (r) => r.state === 'connected');
    await waitFor('audio flowing', () => alawFrames(phone.leg!).length > 5);
    const droppedAt = Date.now();
    expect(sweepSilent(phone)).toBe(1);
    const ended = await spineWhen(call, 'ended by the deferred hangup', (r) => r.state === 'ended', DEFERRED_HANGUP_MS + 10_000);
    expect(Date.now() - droppedAt).toBeGreaterThanOrEqual(DEFERRED_HANGUP_MS - 500);
    expect(ended).toMatchObject({ id: connected.id, outcome: 'answered', settled_at: null });
    await waitFor('the agent offline', async () => (await liveOf(phone.sessionId))?.state === 'offline');

    const leg = await phone.connectReady();
    expect(leg.ready).toMatchObject({ state: 'break' });
    await waitFor('the owed call restored after ready', () => leg.ofEvent('inbound_call').length > 0);
    expect(leg.ofEvent('inbound_call')[0]).toMatchObject({ call: { id: ended.id, state: 'ended' } });
    const saved = await finish('POST', `${ended.id}/disposition`, phone.agentUserId, { code: 'voicemail' });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
  }, 40_000);
});

describe('an older app build reattaching during a connected inbound call (IQ46)', () => {
  it('the leg is not re-adopted onto it and it is sent no inbound frame; the deferred hangup ends the call answered, owed; the agent owes it in wrap-up', async () => {
    const campaignId = await campaign(world);
    const phone = await joinAgent(world, campaignId, { station: CAPABLE_PHONE });
    const call = ring(world, callerScript(() => false));
    const connected = await spineWhen(call, 'connected', (r) => r.state === 'connected');
    await waitFor('audio flowing', () => alawFrames(phone.leg!).length > 5);
    const capableLeg = phone.leg!;
    phone.caps = null;
    const oldLeg = await phone.connectReady();
    await waitFor('the capable leg superseded', () => capableLeg.closed !== null);
    expect(capableLeg.closed!.code).toBe(4409);
    const supersededAt = Date.now();

    const ended = await spineWhen(call, 'ended by the deferred hangup', (r) => r.state === 'ended', DEFERRED_HANGUP_MS + 10_000);
    expect(Date.now() - supersededAt).toBeGreaterThanOrEqual(DEFERRED_HANGUP_MS - 1_000);
    expect(ended).toMatchObject({ id: connected.id, outcome: 'answered', settled_at: null });
    // Never re-adopted: no caller audio, and no inbound frame, on the older build's socket.
    expect(alawFrames(oldLeg)).toEqual([]);
    expect(oldLeg.frames.filter((f) => f.frame?.['event'] === 'inbound_call' || f.frame?.['event'] === 'customer_waiting')).toEqual([]);
    await waitFor('the agent owes the outcome in wrap-up', async () => (await liveOf(phone.sessionId))?.state === 'wrapup');
    expect(await liveOf(phone.sessionId)).toMatchObject({ inboundCallId: ended.id });
    expect((await spineOf(call))!.bridged_at).not.toBeNull();
  }, 40_000);
});
