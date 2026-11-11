import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Inbound calls on the mobile app (IQ46; docs/inbound.md §4.3, §5.1, §6), end to end: a customer
 * rings a linked number on the mock Plivo carrier and the real server puts them through to an agent
 * on a real station socket that attached as the app does. A station that declares `caps=inbound`
 * (`client=mobile&media=alaw8&caps=inbound`) is offered callers exactly as a console is, and its
 * audio is A-law binary frames; an older app build (no `caps`) is never offered one and never sent
 * the inbound frames. The phone's own paths: dropped (or silent past its grace) during an offer or
 * a call, reattached by an older build (during an offer, its `ready` never `reserved`; during an
 * inbound wrap-up), and the device-away break during an inbound reservation, a hand-over held
 * through the caller's greeting, a call or a wrap-up. The cases that wait out the 8 s deferred hangup are in the wall-clock lane
 * (`inbound-mobile-wall-clock.test.ts`).
 *
 * Real: Postgres, this lane's Redis, the app on loopback, the voice and agency bootstraps (the
 * router, the connector, pacing), the bridge, the credential service and `PlivoAdapter`.
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

import { getTestPool } from '../../../../../packages/db/test/helpers/test-db.js';
import { callCore } from '../../../src/api/core-dispatch.js';
import { getAgencyRuntime } from '../../../src/bootstrap/agency.js';
import { AGENCY_INBOUND_CONNECT_DELAY_MS, AGENCY_STATION_ALAW8_FRAME_BYTES, AGENCY_STATION_INBOUND_EVENTS } from '@magick-agency/contracts/agency';
import { STATION_INBOUND_LET_GO_WAIT_MS } from '../../../src/agency/station-socket.js';
import { ACCOUNT, PLIVO_E2E_ENV, TENANT, callRow, closePlivoDb, initPlivoDb, startPlivoRig, waitFor, type PlivoRig } from './plivo-rig.js';
import {
  CALLER, CAPABLE_PHONE, CALLER_E164, OLD_PHONE, agentUser, busyAgent, callerScript, callers, campaign, clip, contact, finish,
  framesOf, inboundCalls, joinAgent, liveOf, ring, setRoute, spineOf, spineWhen, startInboundWorld, stateFrames, type InboundWorld,
} from './inbound-connect-rig.js';
import type { FleetAgent, StationLeg } from '../../mocks/station-fleet.js';

const pool = () => getTestPool();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

/** Binary A-law frames the leg received (the caller's audio on an `alaw8` station). */
const alawFrames = (leg: StationLeg) => leg.frames.filter((f) => f.binary);
const INBOUND_EVENTS: ReadonlySet<unknown> = new Set(AGENCY_STATION_INBOUND_EVENTS);
/** Every inbound frame (`AGENCY_STATION_INBOUND_EVENTS`) any of the agent's legs received. */
const inboundFrames = (agent: FleetAgent) => agent.allFrames().filter((f) => INBOUND_EVENTS.has(f.frame?.['event']));
/** The inbound frames one leg received. */
const inboundFramesOn = (leg: StationLeg) => leg.frames.filter((f) => INBOUND_EVENTS.has(f.frame?.['event']));

/**
 * How soon a caller whose offer was cancelled (the station lost, or let go for an older build) is
 * offered to the next agent, measured on the wall clock across a close or an attach, the let-go
 * and a new search. Generous for a loaded runner, and still well below every timer a caller left
 * waiting would otherwise sit out: the 15 s rejoin grace and hand-over backstop, the route's
 * maximum wait. That the cancel was the close's or the attach's own, not the bind's at
 * `connects_at`, is pinned without the wall clock in `inbound-connector-races.test.ts`.
 */
const PROMPT_REOFFER_MS = 5_000;

/** The phone sends `n` 20 ms A-law frames (the agent talking), as the app does: one binary message each. */
function phoneTalks(agent: FleetAgent, n: number): void {
  for (let i = 0; i < n; i++) agent.leg!.sendRaw(Buffer.alloc(AGENCY_STATION_ALAW8_FRAME_BYTES, 0x55), { binary: true });
}

/** Only `who`'s station is silent past its grace, as the sweep sees it: the 10–15 s of a phone's silence, now. */
function sweepSilent(who: FleetAgent): number {
  return getAgencyRuntime()!.sweepSilentStations((e) => ((e as { sessionId?: string }).sessionId === who.sessionId ? -1 : 1e9));
}

/** The device-away break, as the app's `POST /proxy/agency/sessions/:id/break {reason:'device_away'}` reaches the dialer. */
async function deviceAway(agent: FleetAgent): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await callCore({
    method: 'POST', path: `/agency/sessions/${agent.sessionId}/break`,
    body: { reason: 'device_away', agent_user_id: agent.agentUserId }, tenantId: TENANT, accountId: ACCOUNT,
  });
  return { status: res.status, body: res.body as Record<string, unknown> };
}

describe('a phone that declares caps=inbound is put through as a console is (IQ46)', () => {
  it('offered with the inbound_call frame before any audio, bridged to A-law binary frames both ways, the outcome saved, back to available', async () => {
    const campaignId = await campaign(world);
    const phone = await joinAgent(world, campaignId, { station: CAPABLE_PHONE });
    expect(getAgencyRuntime()!.stations.get(phone.sessionId)).toMatchObject({ clientKind: 'mobile', canTakeInbound: true });
    let hangUp = false;
    const call = ring(world, callerScript(() => hangUp));

    const connected = await spineWhen(call, 'connected to the phone', (r) => r.state === 'connected');
    expect(connected).toMatchObject({ session_id: phone.sessionId, answered_by_user_id: phone.agentUserId, offer_count: 1 });
    const leg = phone.leg!;
    // IB1: the offer frame came before any audio.
    const firstOffer = leg.frames.findIndex((f) => f.frame?.['event'] === 'inbound_call');
    const firstAudio = leg.frames.findIndex((f) => f.binary);
    expect(firstOffer).toBeGreaterThanOrEqual(0);
    expect(firstAudio === -1 || firstOffer < firstAudio).toBe(true);
    const offered = inboundCalls(phone)[0]!;
    expect(offered).toMatchObject({ id: connected.id, state: 'offered', session_id: phone.sessionId, from_e164: CALLER_E164 });
    expect(Date.parse(String(offered['connects_at'])) - Date.parse(String(offered['offered_at']))).toBe(AGENCY_INBOUND_CONNECT_DELAY_MS);
    await waitFor('the connected frame', () => inboundCalls(phone).some((c) => c['state'] === 'connected'));

    // The caller's audio reaches the phone as A-law (`media=alaw8`): one 20 ms frame per binary message, no JSON media.
    await waitFor('the phone hears the caller', () => alawFrames(leg).length >= 10);
    expect(new Set(alawFrames(leg).map((f) => f.bytes))).toEqual(new Set([AGENCY_STATION_ALAW8_FRAME_BYTES]));
    expect(framesOf(phone, 'media')).toEqual([]);
    const heard = call.receivedFrameCount;
    phoneTalks(phone, 10);
    await waitFor('the caller hears the phone', () => call.receivedFrameCount >= heard + 5);

    hangUp = true;
    const ended = await spineWhen(call, 'ended', (r) => r.state === 'ended');
    expect(ended).toMatchObject({ outcome: 'answered', settled_at: null });
    await waitFor('the ended frame', () => inboundCalls(phone).some((c) => c['state'] === 'ended'));
    expect(await liveOf(phone.sessionId)).toMatchObject({ state: 'wrapup', inboundCallId: ended.id });
    const saved = await finish('POST', `${ended.id}/disposition`, phone.agentUserId, { code: 'voicemail' });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    await waitFor('available again', async () => (await liveOf(phone.sessionId))?.state === 'available');
    const row = await pool().query('SELECT client_kind FROM agency_agent_sessions WHERE id = $1', [phone.sessionId]);
    expect(row.rows[0].client_kind).toBe('mobile');
  });

  it('an older phone (no caps) is never offered nor sent the frames: alone, the caller is overflowed at once and the tile says nobody can take calls', async () => {
    const campaignId = await campaign(world);
    const old = await joinAgent(world, campaignId, { station: OLD_PHONE });
    expect(getAgencyRuntime()!.stations.get(old.sessionId)).toMatchObject({ clientKind: 'mobile', canTakeInbound: false });
    const [tile] = await getAgencyRuntime()!.inboundCalls.queueTiles(TENANT, ACCOUNT);
    expect(tile).toMatchObject({ eligible_agents: 0, no_agents_available: true });
    const call = ring(world, callerScript(() => false));
    const ended = await spineWhen(call, 'overflowed', (r) => r.state === 'ended');
    expect(ended).toMatchObject({ outcome: 'overflow', offer_count: 0 });
    expect(inboundFrames(old)).toEqual([]);
    expect((await liveOf(old.sessionId))?.state).toBe('available');
  });

  it('beside a capable phone and a console, the older phone is skipped even as the longest idle; a sticky caller of its agent goes to the team', async () => {
    // `strict`: were the older phone taken for its agent's caller, the caller would be offered to it
    // (or wait for it) and never reach the team.
    await setRoute(world, { sticky_mode: 'strict' });
    const owner = await agentUser();
    const campaignId = await campaign(world);
    await contact(campaignId, { assigned_user_id: owner, assigned_at: new Date(), next_attempt_at: new Date(Date.now() + 86_400_000) });
    const old = await joinAgent(world, campaignId, { userId: owner, station: OLD_PHONE });
    await sleep(50);
    const phone = await joinAgent(world, campaignId, { station: CAPABLE_PHONE });
    await busyAgent(world, campaignId); // a console agent on a call: also someone who could take a caller later
    const [tile] = await getAgencyRuntime()!.inboundCalls.queueTiles(TENANT, ACCOUNT);
    expect(tile).toMatchObject({ eligible_agents: 1, no_agents_available: false });
    let hangUp = false;
    const call = ring(world, callerScript(() => hangUp));
    const taken = await spineWhen(call, 'connected to the capable phone', (r) => r.state === 'connected');
    expect(taken).toMatchObject({ session_id: phone.sessionId, sticky_user_id: owner, sticky_reason: 'owner', offer_count: 1 });
    await waitFor('the offer to the capable phone', () => inboundCalls(phone).length > 0);
    expect(inboundCalls(phone)[0]).toMatchObject({ id: taken.id, sticky: { reason: 'owner', is_you: false } });
    expect(inboundFrames(old)).toEqual([]);
    expect((await liveOf(old.sessionId))?.state).toBe('available');
    hangUp = true;
    await spineWhen(call, 'ended', (r) => r.state === 'ended');
  });
});

describe('a phone lost during an offer: the caller back at the head of the queue (§5.1)', () => {
  it('silent past its grace (the sweep terminates it) before the bind: requeued, the next agent gets them, the phone`s agent offline', async () => {
    const campaignId = await campaign(world);
    const phone = await joinAgent(world, campaignId, { station: CAPABLE_PHONE });
    await sleep(50);
    const desk = await joinAgent(world, campaignId);
    let hangUp = false;
    const call = ring(world, callerScript(() => hangUp));
    await waitFor('the offer to the longest idle (the phone)', () => inboundCalls(phone).length > 0);
    // An offer not yet bound is not a live call: the idle arm drops the phone.
    expect(sweepSilent(phone)).toBe(1);
    const taken = await spineWhen(call, 'connected to the desk', (r) => r.state === 'connected');
    expect(taken).toMatchObject({ session_id: desk.sessionId, offer_count: 2 });
    const secondOffer = Date.parse(String(inboundCalls(desk)[0]!['offered_at']));
    expect(secondOffer - Date.parse(String(inboundCalls(phone)[0]!['offered_at']))).toBeLessThan(PROMPT_REOFFER_MS);
    expect(alawFrames(phone.leg!)).toEqual([]);
    await waitFor('the phone`s agent offline', async () => (await liveOf(phone.sessionId))?.state === 'offline');
    expect(await liveOf(phone.sessionId)).toMatchObject({ inboundCallId: null });
    hangUp = true;
  });

  it('reattached during the offer by an older build (no caps): the offer cancelled as a lost station`s, the next agent gets the caller, the agent back in the pool, the old build sent no inbound frame', async () => {
    const campaignId = await campaign(world);
    const phone = await joinAgent(world, campaignId, { station: CAPABLE_PHONE });
    await sleep(50);
    const desk = await joinAgent(world, campaignId);
    let hangUp = false;
    const call = ring(world, callerScript(() => hangUp));
    await waitFor('the offer to the phone', () => inboundCalls(phone).length > 0);
    const capableLeg = phone.leg!;
    phone.caps = null; // the same session, from an app build that does not declare caps=inbound
    const oldLeg = await phone.connectReady();
    await waitFor('the capable leg superseded', () => capableLeg.closed !== null);
    expect(capableLeg.closed!.code).toBe(4409);
    expect(getAgencyRuntime()!.stations.get(phone.sessionId)).toMatchObject({ canTakeInbound: false });
    // The offer was let go before `ready`: the older build is never told `reserved` for a call it cannot show.
    expect(oldLeg.ready).toMatchObject({ state: 'available' });
    expect(oldLeg.ofEvent('agent_state').map((f) => f['state'])).not.toContain('reserved');
    const taken = await spineWhen(call, 'connected to the desk', (r) => r.state === 'connected');
    expect(taken).toMatchObject({ session_id: desk.sessionId, offer_count: 2 });
    // Re-offered promptly (cancelled by the attach itself, `onStationCannotTakeInbound`, or at the
    // latest by the bind's own check): see PROMPT_REOFFER_MS.
    const reOffered = Date.parse(String(inboundCalls(desk)[0]!['offered_at'])) - Date.parse(String(inboundCalls(phone)[0]!['offered_at']));
    expect(reOffered).toBeLessThan(PROMPT_REOFFER_MS);
    expect(inboundFramesOn(oldLeg)).toEqual([]);
    expect(alawFrames(oldLeg)).toEqual([]);
    await waitFor('the phone`s agent back in the pool', async () => (await liveOf(phone.sessionId))?.state === 'available');
    expect(await liveOf(phone.sessionId)).toMatchObject({ inboundCallId: null });
    hangUp = true;
  });
});

describe('an older build reattaching during an inbound wrap-up (IQ46)', () => {
  it('comes back in wrap-up with the outcome still owed (no inbound frame: it cannot show the pad); the saved outcome returns the agent, and no caller is offered to it', async () => {
    const campaignId = await campaign(world);
    const phone = await joinAgent(world, campaignId, { station: CAPABLE_PHONE });
    let hangUp = false;
    const call = ring(world, callerScript(() => hangUp));
    await spineWhen(call, 'connected', (r) => r.state === 'connected');
    hangUp = true;
    const ended = await spineWhen(call, 'ended', (r) => r.state === 'ended');
    await waitFor('wrap-up', async () => (await liveOf(phone.sessionId))?.state === 'wrapup');

    const capableLeg = phone.leg!;
    phone.caps = null;
    const oldLeg = await phone.connectReady();
    await waitFor('the capable leg superseded', () => capableLeg.closed !== null);
    expect(oldLeg.ready).toMatchObject({ state: 'wrapup' });
    expect(await liveOf(phone.sessionId)).toMatchObject({ state: 'wrapup', inboundCallId: ended.id });
    await sleep(300);
    expect(inboundFramesOn(oldLeg)).toEqual([]);
    expect((await spineOf(call))!.settled_at).toBeNull();

    const saved = await finish('POST', `${ended.id}/disposition`, phone.agentUserId, { code: 'voicemail' });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    await waitFor('available again', async () => (await liveOf(phone.sessionId))?.state === 'available');
    expect(await liveOf(phone.sessionId)).toMatchObject({ inboundCallId: null });
    // Alone and unable to take inbound calls: the next caller is overflowed, never offered to it.
    const next = ring(world, callerScript(() => false), '447700900779');
    expect(await spineWhen(next, 'overflowed', (r) => r.state === 'ended')).toMatchObject({ outcome: 'overflow', offer_count: 0 });
    expect(inboundFramesOn(oldLeg)).toEqual([]);
  });
});

describe('a phone dropped mid inbound call: the campaign call`s rule (M1, IQ17)', () => {
  it('silent past its grace on the call: terminated at once (not left on silence), presence kept on the call; back inside 8 s with caps=inbound: resumed on the new socket, the panel restored after `ready`', async () => {
    const campaignId = await campaign(world);
    const phone = await joinAgent(world, campaignId, { station: CAPABLE_PHONE });
    let hangUp = false;
    const call = ring(world, callerScript(() => hangUp));
    const connected = await spineWhen(call, 'connected', (r) => r.state === 'connected');
    await waitFor('audio flowing', () => alawFrames(phone.leg!).length > 5);
    const first = phone.leg!;
    expect(sweepSilent(phone)).toBe(1);
    await waitFor('the silent phone dropped', () => first.closed !== null);
    await sleep(500);
    // The bridge's deferred hangup owns the call: presence stays on it, never `offline`.
    expect(await liveOf(phone.sessionId)).toMatchObject({ state: 'on_call', inboundCallId: connected.id });
    expect((await spineOf(call))!.state).toBe('connected');
    const leg = await phone.connectReady();
    expect(leg.ready).toMatchObject({ state: 'on_call' });
    await waitFor('the inbound_call frame after ready', () => leg.ofEvent('inbound_call').length > 0);
    expect(leg.ofEvent('inbound_call')[0]).toMatchObject({ call: { id: connected.id, state: 'connected' } });
    await waitFor('A-law on the new socket', () => alawFrames(leg).length > 5);
    expect((await spineOf(call))!.state).toBe('connected');
    hangUp = true;
    await spineWhen(call, 'ended answered', (r) => r.state === 'ended' && r.outcome === 'answered');
  });
});

describe('the device-away break and inbound calls: queued behind the call, never stranding the caller', () => {
  it('during the offer: queued (not applied); the call still binds and connects; ending it and saving the outcome applies the break, and the release hook takes no waiting caller for the agent', async () => {
    const campaignId = await campaign(world);
    const phone = await joinAgent(world, campaignId, { station: CAPABLE_PHONE });
    await busyAgent(world, campaignId); // someone who could take the second caller later, so they wait
    let hangUp = false;
    const call = ring(world, callerScript(() => hangUp));
    await waitFor('the offer', () => inboundCalls(phone).length > 0);

    // The app is backgrounded inside the offer, before `connects_at`.
    const away = await deviceAway(phone);
    expect(away.status, JSON.stringify(away.body)).toBe(200);
    expect(away.body).toMatchObject({ state: 'reserved', pending_state: 'break', break_reason: 'device_away' });
    expect(await liveOf(phone.sessionId)).toMatchObject({ state: 'reserved' });
    const connected = await spineWhen(call, 'still connected to the phone', (r) => r.state === 'connected');
    expect(connected.session_id).toBe(phone.sessionId);

    // A second caller waits meanwhile (the phone is on a call: it could take them once it ends).
    const second = ring(world, callerScript(() => false), '447700900777');
    await spineWhen(second, 'second queued', (r) => r.state === 'queued');
    // A repeat while on the call changes nothing.
    expect((await deviceAway(phone)).body).toMatchObject({ state: 'on_call', pending_state: 'break', break_reason: 'device_away' });

    hangUp = true;
    const ended = await spineWhen(call, 'ended', (r) => r.state === 'ended');
    await waitFor('wrap-up', async () => (await liveOf(phone.sessionId))?.state === 'wrapup');
    const saved = await finish('POST', `${ended.id}/disposition`, phone.agentUserId, { code: 'voicemail' });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    await waitFor('on the device-away break', async () => (await liveOf(phone.sessionId))?.state === 'break');
    const row = await pool().query('SELECT state, break_reason FROM agency_agent_sessions WHERE id = $1', [phone.sessionId]);
    expect(row.rows[0]).toMatchObject({ state: 'break', break_reason: 'device_away' });
    // The release applied the break: the waiting caller was never offered to the backgrounded phone.
    await sleep(500);
    expect(inboundCalls(phone).filter((c) => c['id'] !== ended.id)).toEqual([]);
    expect(stateFrames(phone)).not.toContain('available');
    const waiting = await spineOf(second);
    expect(waiting!.session_id).toBeNull();
  });

  it('during a hand-over held through the caller`s greeting (§5.4): queued (the hold is a reservation); the same phone is still put through; the outcome save applies the break', async () => {
    // The clash: pacing dials the customer, the carrier keeps it ringing, and the customer rings in.
    rig!.carrier.setScript(() => ({
      name: 'ringing until cancelled',
      steps: [{ do: 'ring' }, { do: 'waitFor', until: (c) => c.canceledByApi, what: 'our cancel', timeoutMs: 30_000 }],
    }));
    const greetingClip = await clip(2500, 330); // a long greeting keeps the caller in the preamble
    const c = world.clips;
    await setRoute(world, {
      clips: { greeting: greetingClip.id, hold: c.hold.id, callback: c.callback.id, recording_notice: c.notice.id, closed: c.closed.id, busy: c.busy.id },
    });
    const campaignId = await campaign(world);
    const contactId = await contact(campaignId, { next_attempt_at: new Date(Date.now() - 1000) });
    const phone = await joinAgent(world, campaignId, { station: CAPABLE_PHONE });
    await waitFor('the dial to the customer ringing', async () => {
      const { rows } = await getTestPool().query<{ webrtc_call_id: string | null }>(
        'SELECT webrtc_call_id FROM agency_call_attempts WHERE contact_id = $1', [contactId]);
      const id = rows[0]?.webrtc_call_id;
      return id ? (await callRow(id))?.status === 'ringing' : false;
    });
    expect(rig!.carrier.callOrder.some((x) => x.request.to === CALLER)).toBe(true);

    let hangUp = false;
    const call = ring(world, callerScript(() => hangUp));
    const greeting = await spineWhen(call, 'answered, greeting', (r) => r.state === 'greeting');
    await waitFor('held for the call', async () => (await liveOf(phone.sessionId))?.inboundCallId === greeting.id);

    // The app is backgrounded while the caller still hears the greeting.
    const away = await deviceAway(phone);
    expect(away.status, JSON.stringify(away.body)).toBe(200);
    expect(away.body).toMatchObject({ state: 'reserved', pending_state: 'break', break_reason: 'device_away' });
    expect(await liveOf(phone.sessionId)).toMatchObject({ state: 'reserved', inboundCallId: greeting.id });
    expect((await spineOf(call))!.state).toBe('greeting');

    // Put through once the greeting has played, to the same phone: the queued break waits behind the call.
    const connected = await spineWhen(call, 'connected to the phone', (r) => r.state === 'connected', 20_000);
    expect(connected.session_id).toBe(phone.sessionId);
    hangUp = true;
    const ended = await spineWhen(call, 'ended', (r) => r.state === 'ended');
    await waitFor('wrap-up', async () => (await liveOf(phone.sessionId))?.state === 'wrapup');
    const saved = await finish('POST', `${ended.id}/disposition`, phone.agentUserId, { code: 'voicemail' });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    await waitFor('on the device-away break', async () => (await liveOf(phone.sessionId))?.state === 'break');
    const row = await pool().query('SELECT state, break_reason FROM agency_agent_sessions WHERE id = $1', [phone.sessionId]);
    expect(row.rows[0]).toMatchObject({ state: 'break', break_reason: 'device_away' });
    expect(stateFrames(phone)).not.toContain('available');
  });

  it('during an inbound wrap-up: queued; the outcome save applies it (break, not available); an available phone`s device-away applies at once and it is offered nothing', async () => {
    const campaignId = await campaign(world);
    const phone = await joinAgent(world, campaignId, { station: CAPABLE_PHONE });
    let hangUp = false;
    const call = ring(world, callerScript(() => hangUp));
    await spineWhen(call, 'connected', (r) => r.state === 'connected');
    hangUp = true;
    const ended = await spineWhen(call, 'ended', (r) => r.state === 'ended');
    await waitFor('wrap-up', async () => (await liveOf(phone.sessionId))?.state === 'wrapup');
    const away = await deviceAway(phone);
    expect(away.status).toBe(200);
    expect(away.body).toMatchObject({ state: 'wrapup', pending_state: 'break', break_reason: 'device_away' });
    expect(await liveOf(phone.sessionId)).toMatchObject({ state: 'wrapup', inboundCallId: ended.id });
    const saved = await finish('POST', `${ended.id}/disposition`, phone.agentUserId, { code: 'voicemail' });
    expect(saved.status).toBe(200);
    await waitFor('on the break', async () => (await liveOf(phone.sessionId))?.state === 'break');
    expect(stateFrames(phone)).not.toContain('available');

    // A second phone, available, backgrounded: out of the pool at once, and a caller goes elsewhere.
    const other = await joinAgent(world, campaignId, { station: CAPABLE_PHONE });
    expect((await deviceAway(other)).body).toMatchObject({ state: 'break', break_reason: 'device_away' });
    const next = ring(world, callerScript(() => false), '447700900778');
    const overflowed = await spineWhen(next, 'overflowed: nobody could take them', (r) => r.state === 'ended');
    expect(overflowed).toMatchObject({ outcome: 'overflow', offer_count: 0 });
    expect(inboundCalls(other)).toEqual([]);
  });
});

describe('a capable phone reconnecting during an offer (the 1.5 s before connects_at)', () => {
  it('the same build back inside the window: the call still reaches that phone, its audio on the new socket', async () => {
    const campaignId = await campaign(world);
    const phone = await joinAgent(world, campaignId, { station: CAPABLE_PHONE });
    let hangUp = false;
    const call = ring(world, callerScript(() => hangUp));
    await waitFor('the offer', () => inboundCalls(phone).length > 0);
    const first = phone.leg!;
    const leg = await phone.connectReady();
    await waitFor('the first leg superseded', () => first.closed !== null);
    expect(getAgencyRuntime()!.stations.get(phone.sessionId)).toMatchObject({ clientKind: 'mobile', canTakeInbound: true });
    const connected = await spineWhen(call, 'connected to the phone', (r) => r.state === 'connected');
    expect(connected.session_id).toBe(phone.sessionId);
    await waitFor('A-law on the new socket', () => alawFrames(leg).length > 5);
    await waitFor('the connected frame on the new socket',
      () => leg.ofEvent('inbound_call').some((f) => (f['call'] as Record<string, unknown>)['state'] === 'connected'));
    expect(await liveOf(phone.sessionId)).toMatchObject({ state: 'on_call', inboundCallId: connected.id });
    hangUp = true;
    await spineWhen(call, 'ended answered', (r) => r.state === 'ended' && r.outcome === 'answered');
  });
});

describe('two callers sticky to one phone agent, a release, then an older build takes the session over', () => {
  it('nobody is lost: the caller on offer goes back to the head and to the team, the other keeps waiting, and the agent is back in the pool, never reserved', async () => {
    // `strict`: both callers wait for their busy sticky agent; once that agent is on an older build
    // (not someone who can take inbound calls, IQ6 as amended by IQ46) they are the team's.
    await setRoute(world, { sticky_mode: 'strict' });
    const owner = await agentUser();
    const campaignId = await campaign(world);
    const SECOND = '447700900771';
    const later = { assigned_user_id: owner, assigned_at: new Date(), next_attempt_at: new Date(Date.now() + 86_400_000) };
    await contact(campaignId, later);
    await contact(campaignId, { ...later, phone_e164: `+${SECOND}`, source_row_number: 2 });
    const phone = await joinAgent(world, campaignId, { userId: owner, station: CAPABLE_PHONE, available: false });
    await getAgencyRuntime()!.agents.set(phone.sessionId, 'on_call', { leaseMs: 120_000 }); // busy: their callers wait
    const desk = await joinAgent(world, campaignId);
    let hangUp = false;
    const first = ring(world, callerScript(() => hangUp));
    const queuedFirst = await spineWhen(first, 'the first caller waiting', (r) => r.state === 'queued');
    const second = ring(world, callerScript(() => hangUp), SECOND);
    const queuedSecond = await spineWhen(second, 'the second caller waiting', (r) => r.state === 'queued');
    expect([queuedFirst.sticky_user_id, queuedSecond.sticky_user_id]).toEqual([owner, owner]);
    expect(inboundCalls(desk)).toEqual([]);

    // The phone's work ends: the release hook offers it its first caller (no `available` between).
    await getAgencyRuntime()!.dialer.releaseAgent(phone.sessionId);
    await waitFor('the first caller offered to the phone', () => inboundCalls(phone).some((c) => c['id'] === queuedFirst.id));
    expect(await liveOf(phone.sessionId)).toMatchObject({ state: 'reserved', inboundCallId: queuedFirst.id });

    // An older build takes the session over during that offer.
    const capableLeg = phone.leg!;
    phone.caps = null;
    const oldLeg = await phone.connectReady();
    await waitFor('the capable leg superseded', () => capableLeg.closed !== null);
    expect(oldLeg.ready).toMatchObject({ state: 'available' });
    expect(oldLeg.ofEvent('agent_state').map((f) => f['state'])).not.toContain('reserved');

    // The first caller back at the head, now the team's: the desk takes them. The second still waits.
    const taken = await spineWhen(first, 'the first caller connected to the desk', (r) => r.state === 'connected');
    expect(taken).toMatchObject({ session_id: desk.sessionId, offer_count: 2 });
    const waiting = await spineOf(second);
    expect(waiting).toMatchObject({ state: 'queued', session_id: null, outcome: null });
    expect(inboundFramesOn(oldLeg)).toEqual([]);
    expect(await liveOf(phone.sessionId)).toMatchObject({ state: 'available', inboundCallId: null });
    hangUp = true;
    await spineWhen(first, 'the first ended', (r) => r.state === 'ended');
    await spineWhen(second, 'the second ended', (r) => r.state === 'ended');
  });
});

describe('an older build`s ready is held for the let-go no longer than STATION_INBOUND_LET_GO_WAIT_MS', () => {
  it('a let-go that never settles: `ready` still goes out once the bound has passed', async () => {
    const campaignId = await campaign(world);
    const phone = await joinAgent(world, campaignId, { station: CAPABLE_PHONE });
    const spy = vi.spyOn(getAgencyRuntime()!.inbound!, 'onStationCannotTakeInbound').mockImplementation(() => new Promise<void>(() => {}));
    try {
      phone.caps = null;
      const started = Date.now();
      const leg = await phone.connectReady();
      const waited = Date.now() - started;
      expect(spy).toHaveBeenCalledWith(phone.sessionId);
      expect(leg.ready).toMatchObject({ state: 'available' });
      expect(waited).toBeGreaterThanOrEqual(STATION_INBOUND_LET_GO_WAIT_MS - 50);
      // Generous above it: an attach on a loaded runner, not another timer.
      expect(waited).toBeLessThan(STATION_INBOUND_LET_GO_WAIT_MS + 5_000);
    } finally {
      spy.mockRestore();
    }
  });
});
