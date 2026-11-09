import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Inbound P2, end to end (docs/inbound.md §2, §4, §5): a customer rings a linked number on the
 * mock Plivo carrier, the real server answers, holds and queues them, and puts them through to an
 * agent on a real station socket (the simulated fleet). The scenarios: the
 * auto-connect with the panel before any media; sticky routing (loose taken from wrap-up with no
 * `available` instant, the sticky wait lapsing, strict); the queue's order and limits and pacing
 * yielding; a caller who hangs up on offer; a station lost during the offer and after the bind; a
 * restart with an answered call owing its outcome; recording from the bind; concurrency.
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

import { randomUUID } from 'node:crypto';
import { getTestPool } from '../../../../../packages/db/test/helpers/test-db.js';
import { callCore } from '../../../src/api/core-dispatch.js';
import { DncRegistry } from '../../../src/agency/dnc-registry.js';
import { startInboundCalls } from '../../../src/agency/inbound/inbound-call-router.js';
import { getInboundCallRouter, setInboundCallRouter } from '../../../src/seams/inbound-call-router.js';
import { getConcurrencyControl } from '../../../src/seams/concurrency-control.js';
import { agencyInboundCallRepository } from '../../../src/db/repositories/agency.repository.js';
import { getAgencyRuntime } from '../../../src/bootstrap/agency.js';
import { AGENCY_INBOUND_CONNECT_DELAY_MS } from '@magick-agency/contracts/agency';
import {
  ACCOUNT, CALLER_ID, PLIVO_E2E_ENV, TENANT, closePlivoDb, initPlivoDb, startPlivoRig, waitFor, type PlivoRig,
} from './plivo-rig.js';
import {
  CALLER_E164, agentTalks, agentUser, callerScript, callers, campaign, contact, finish, framesOf, goAvailable, inboundCalls, joinAgent,
  liveOf, ring, setRoute, spineOf, spineWhen, startInboundWorld, stateFrames, type InboundWorld,
} from './inbound-connect-rig.js';
import type { PlivoCall } from '../../mocks/plivo/index.js';
import type { FleetAgent } from '../../mocks/station-fleet.js';

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

describe('inbound P2: a caller put through to an agent', () => {
  it('1. auto-connect: the panel (offered) before any media, then bridged, audio both ways, the end owes an outcome, saved over HTTP, the agent back to available', async () => {
    const campaignId = await campaign(world);
    const agent = await joinAgent(world, campaignId);
    let hangUp = false;
    const call = ring(world, callerScript(() => hangUp));

    // Offered, then connected.
    const connected = await spineWhen(call, 'connected', (r) => r.state === 'connected');
    expect(connected).toMatchObject({ session_id: agent.sessionId, answered_by_user_id: agent.agentUserId, offer_count: 1 });
    expect(connected.queued_at).not.toBeNull();
    // IB1: the `inbound_call` (offered) frame came before any media frame on the station.
    const frames = agent.allFrames();
    const firstOffer = frames.findIndex((f) => f.frame?.['event'] === 'inbound_call');
    const firstMedia = frames.findIndex((f) => f.frame?.['event'] === 'media');
    expect(firstOffer).toBeGreaterThanOrEqual(0);
    expect(firstMedia === -1 || firstOffer < firstMedia).toBe(true);
    const offered = inboundCalls(agent)[0]!;
    expect(offered).toMatchObject({ id: connected.id, state: 'offered', session_id: agent.sessionId, from_e164: CALLER_E164, recording: false });
    expect(Date.parse(String(offered['connects_at'])) - Date.parse(String(offered['offered_at']))).toBe(AGENCY_INBOUND_CONNECT_DELAY_MS);
    // `reserved` is announced with the offer, then `on_call` at the bridge.
    await waitFor('the connected frame', () => inboundCalls(agent).some((c) => c['state'] === 'connected'));
    expect(stateFrames(agent).slice(-2)).toEqual(['reserved', 'on_call']);
    expect((await liveOf(agent.sessionId))).toMatchObject({ state: 'on_call', inboundCallId: connected.id });

    // The station cannot be left while a call is connected to it.
    const leave = await callCore({ method: 'POST', path: `/agency/sessions/${agent.sessionId}/leave`, body: { agent_user_id: agent.agentUserId }, tenantId: TENANT, accountId: ACCOUNT });
    expect(leave.status).toBe(409);
    expect(leave.body).toMatchObject({ code: 'agent_on_live_call' });

    // Audio both ways.
    await waitFor('the agent hears the caller', () => framesOf(agent, 'media').length >= 10);
    const heard = call.receivedFrameCount;
    agentTalks(agent, 10);
    await waitFor('the caller hears the agent', () => call.receivedFrameCount >= heard + 5);

    // The caller hangs up: answered, owed (no Missed row), the agent in wrap-up with the field kept.
    await sleep(1100);
    hangUp = true;
    const ended = await spineWhen(call, 'ended', (r) => r.state === 'ended');
    await call.done;
    expect(ended).toMatchObject({ outcome: 'answered', follow_up_status: null, settled_at: null });
    expect(ended.talk_seconds).toBeGreaterThanOrEqual(1);
    await waitFor('the ended frame', () => inboundCalls(agent).some((c) => c['state'] === 'ended'));
    const endedFrame = inboundCalls(agent).at(-1)!;
    expect(endedFrame['outcome_due_at']).not.toBeNull();
    expect(await liveOf(agent.sessionId)).toMatchObject({ state: 'wrapup', inboundCallId: ended.id });
    // `available` is refused while the outcome is owed.
    const refused = await getAgencyRuntime()!.dialer.releaseAgent(agent.sessionId);
    expect(refused.result).toBe('inbound_call_owed');

    // The outcome over HTTP (the internal handler, as the public route sends it).
    const saved = await finish('POST', `${ended.id}/disposition`, agent.agentUserId, { code: 'voicemail', notes: 'rang about the invoice' });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(saved.body).toMatchObject({ call: { id: ended.id, disposition_code: 'voicemail', catalog_source: 'builtin' }, contact_state: null });
    await waitFor('available again', async () => (await liveOf(agent.sessionId))?.state === 'available');
    expect(await liveOf(agent.sessionId)).toMatchObject({ inboundCallId: null });
    expect(stateFrames(agent).at(-1)).toBe('available');
    const row = (await pool().query('SELECT settled_at, notes, disposition_source FROM agency_inbound_calls WHERE id = $1', [ended.id])).rows[0];
    expect(row).toMatchObject({ notes: 'rang about the invoice', disposition_source: 'route' });
    expect(row.settled_at).not.toBeNull();
  });
});

/** Attempts pacing reserved onto these sessions (any state). */
async function attemptsOnto(sessionIds: string[]): Promise<number> {
  const { rows } = await pool().query<{ n: number }>(
    'SELECT count(*)::int AS n FROM agency_call_attempts WHERE reserved_agent_id = ANY($1::uuid[])', [sessionIds]);
  return rows[0]!.n;
}

/** `n` dialable contacts on `campaignId` (numbers unlike the caller's): pacing would dial them. */
async function dialable(campaignId: string, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    await contact(campaignId, { phone_e164: `+4477009${String(10000 + i)}`, source_row_number: 100 + i, next_attempt_at: new Date(Date.now() - 1000) });
  }
}

/** A first caller (an unknown number) put through to `agent`, held connected until `release()`. */
async function busyWithCaller(agent: FleetAgent, from: string): Promise<{ call: PlivoCall; release: () => void; id: string }> {
  let done = false;
  const call = ring(world, callerScript(() => done), from);
  const row = await spineWhen(call, `the first caller connected to ${agent.label}`, (r) => r.state === 'connected' && r.session_id === agent.sessionId);
  return { call, release: () => { done = true; }, id: row.id };
}

describe('inbound P2: sticky routing (§4.2, §4.3)', () => {
  it('2. loose: the owner on a call gets "your customer is waiting"; the team is not offered the caller; the owner is taken from wrap-up straight to the caller (no `available` between, no attempt reserved meanwhile)', async () => {
    const owner = await agentUser();
    const campaignId = await campaign(world);
    await contact(campaignId, { assigned_user_id: owner, assigned_at: new Date(), next_attempt_at: new Date(Date.now() + 86_400_000) });
    const a = await joinAgent(world, campaignId, { userId: owner });
    const b = await joinAgent(world, campaignId, { available: false });
    const first = await busyWithCaller(a, '447700900111');
    await dialable(campaignId, 3); // nobody to dial yet: A is on a call, B on a break

    let hangUp = false;
    const call = ring(world, callerScript(() => hangUp));
    const queued = await spineWhen(call, 'queued for the owner', (r) => r.state === 'queued');
    expect(queued).toMatchObject({ sticky_user_id: owner, sticky_reason: 'owner' });
    // B goes available while the caller waits: pacing would dial them, were it not for the caller.
    await goAvailable(b);
    await waitFor('customer_waiting to the owner', () => framesOf(a, 'customer_waiting').length > 0);
    expect(framesOf(a, 'customer_waiting')[0]).toMatchObject({ inbound_call_id: queued.id, from_e164: CALLER_E164 });
    // Held: hold audio flows; B (available, longest idle of the team) is neither offered the caller nor dialled.
    const atQueue = call.receivedFrameCount;
    await sleep(2500);
    expect(call.receivedFrameCount).toBeGreaterThan(atQueue + 50);
    expect(inboundCalls(b)).toEqual([]);
    expect(await attemptsOnto([a.sessionId, b.sessionId])).toBe(0);
    expect((await liveOf(b.sessionId))?.state).toBe('available');

    // The owner's first call ends: wrap-up, outcome owed. Saving it hands them the waiting caller.
    first.release();
    await spineWhen(first.call, 'the first call ended', (r) => r.state === 'ended');
    await waitFor('owner in wrap-up', async () => (await liveOf(a.sessionId))?.state === 'wrapup' && stateFrames(a).at(-1) === 'wrapup');
    const statesBefore = stateFrames(a).length;
    const saved = await finish('POST', `${first.id}/disposition`, owner, { code: 'voicemail' });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    const taken = await spineWhen(call, 'connected to the owner', (r) => r.state === 'connected');
    expect(taken.session_id).toBe(a.sessionId);
    expect(stateFrames(a).slice(statesBefore)).toEqual(['reserved', 'on_call']); // never `available` between
    const offer = inboundCalls(a).find((c) => c['id'] === queued.id && c['state'] === 'offered')!;
    expect(offer['sticky']).toEqual({ reason: 'owner', is_you: true });
    expect(framesOf(a, 'customer_waiting').at(-1)).toMatchObject({ inbound_call_id: queued.id, cleared: true });
    expect(await attemptsOnto([a.sessionId])).toBe(0);
    expect(inboundCalls(b)).toEqual([]);
    hangUp = true;
    await spineWhen(call, 'ended', (r) => r.state === 'ended');
  });

  it('2b. loose: the sticky wait lapses with the owner still busy, and the team takes the caller', async () => {
    await setRoute(world, { sticky_wait_seconds: 5 });
    const owner = await agentUser();
    const campaignId = await campaign(world);
    await contact(campaignId, { assigned_user_id: owner, assigned_at: new Date(), next_attempt_at: new Date(Date.now() + 86_400_000) });
    const a = await joinAgent(world, campaignId, { userId: owner });
    const first = await busyWithCaller(a, '447700900112');
    const b = await joinAgent(world, campaignId);
    let hangUp = false;
    const call = ring(world, callerScript(() => hangUp));
    const queued = await spineWhen(call, 'queued', (r) => r.state === 'queued');
    const queuedAt = Date.now();
    const toTeam = await spineWhen(call, 'offered to the team', (r) => r.state === 'offered' || r.state === 'connected', 15_000);
    expect(toTeam.session_id).toBe(b.sessionId);
    expect(Date.now() - queuedAt).toBeGreaterThanOrEqual(4000);
    // The spine is committed before the connector sends the frames (and A's socket carries the
    // first call's audio ahead of its notice): the frames are waited for, never read at the instant
    // the row is seen.
    await waitFor('the offer to B', () => inboundCalls(b).length > 0, 5000);
    expect(inboundCalls(b)[0]).toMatchObject({ id: queued.id, sticky: { reason: 'owner', is_you: false } });
    await waitFor('the owner\'s notice cleared', () => framesOf(a, 'customer_waiting').at(-1)?.['cleared'] === true, 5000);
    hangUp = true;
    first.release();
    await spineWhen(call, 'ended', (r) => r.state === 'ended');
    // The owner was told once and cleared once, in that order, and never told again after it.
    expect(framesOf(a, 'customer_waiting').map((f) => [f['inbound_call_id'], f['cleared'] ?? false]))
      .toEqual([[queued.id, false], [queued.id, true]]);
  });

  it('3. strict: only the owner; the maximum wait overflows the caller (the callback message), the Missed row assigned to the owner, the callback booked', async () => {
    await setRoute(world, { sticky_mode: 'strict', queue_max_wait_seconds: 10, sticky_wait_seconds: 5 });
    const owner = await agentUser();
    const campaignId = await campaign(world);
    const contactId = await contact(campaignId, { assigned_user_id: owner, assigned_at: new Date(), next_attempt_at: new Date(Date.now() + 86_400_000) });
    const a = await joinAgent(world, campaignId, { userId: owner });
    const first = await busyWithCaller(a, '447700900113');
    const b = await joinAgent(world, campaignId);
    const call = ring(world, callerScript(() => false));
    const ended = await spineWhen(call, 'overflowed', (r) => r.state === 'ended', 25_000);
    await call.done;
    expect(ended).toMatchObject({
      outcome: 'overflow', follow_up_reason: 'overflow', follow_up_status: 'open', follow_up_assignee_user_id: owner, offer_count: 0,
    });
    expect(ended.callback_due_at).not.toBeNull();
    expect(call.hungUpByApi).toBe(true);
    expect(inboundCalls(b)).toEqual([]);
    const { rows } = await pool().query('SELECT callback_source FROM agency_contacts WHERE id = $1', [contactId]);
    expect(rows[0].callback_source).toBe('inbound');
    first.release();
  });
});

describe('inbound P2: the queue (§5.1, §5.2)', () => {
  it('4a. longest idle first; callers FIFO; the agent who frees takes the next caller from wrap-up', async () => {
    const campaignId = await campaign(world);
    const old = await joinAgent(world, campaignId);
    await sleep(50);
    const young = await joinAgent(world, campaignId, { available: false });
    await goAvailable(young);
    let done1 = false;
    const one = ring(world, callerScript(() => done1), '447700900201');
    const r1 = await spineWhen(one, 'first connected', (r) => r.state === 'connected');
    expect(r1.session_id).toBe(old.sessionId);

    // One agent left: two callers, FIFO.
    let done2 = false;
    let done3 = false;
    const two = ring(world, callerScript(() => done2), '447700900202');
    const r2 = await spineWhen(two, 'second connected', (r) => r.state === 'connected');
    expect(r2.session_id).toBe(young.sessionId);
    const three = ring(world, callerScript(() => done3), '447700900203');
    await spineWhen(three, 'third queued', (r) => r.state === 'queued');
    const four = ring(world, callerScript(() => false), '447700900204');
    await spineWhen(four, 'fourth queued', (r) => r.state === 'queued');
    // The supervisor's tile: two waiting, two with an agent, nobody free.
    const [tile] = await getAgencyRuntime()!.inboundCalls.queueTiles(TENANT, ACCOUNT);
    expect(tile).toMatchObject({ route_id: world.routeId, route_name: 'Main line', open_now: true, waiting: 2, connected: 2, eligible_agents: 0 });
    expect(tile!.longest_wait_seconds).toBeGreaterThanOrEqual(0);
    done2 = true;
    const ended2 = await spineWhen(two, 'second ended', (r) => r.state === 'ended');
    const saved = await finish('POST', `${ended2.id}/disposition`, young.agentUserId, { code: 'voicemail' });
    expect(saved.status).toBe(200);
    const r3 = await spineWhen(three, 'third (queued first) to the agent who freed', (r) => r.state === 'connected');
    expect(r3.session_id).toBe(young.sessionId);
    expect((await spineWhen(four, 'fourth still waiting', (r) => r.state === 'queued')).session_id).toBeNull();
    done1 = true;
    done3 = true;
  });

  it('4b. max_waiting: a caller over it with nobody free overflows at once; 4c. the maximum wait overflows a waiting caller', async () => {
    await setRoute(world, { max_waiting: 1, queue_max_wait_seconds: 10, sticky_wait_seconds: 5 });
    const waiting = ring(world, callerScript(() => false), '447700900301');
    await spineWhen(waiting, 'first queued', (r) => r.state === 'queued');
    const over = ring(world, callerScript(() => false), '447700900302');
    const overflowed = await spineWhen(over, 'second overflowed', (r) => r.state === 'ended');
    expect(overflowed).toMatchObject({ outcome: 'overflow', follow_up_reason: 'overflow' });
    await over.done;
    // The callback message played after the hold.
    expect(over.playAudio.length).toBeGreaterThan(0);
    const lapsed = await spineWhen(waiting, 'first overflowed at its maximum wait', (r) => r.state === 'ended', 20_000);
    expect(lapsed).toMatchObject({ outcome: 'overflow', follow_up_reason: 'overflow' });
    expect(lapsed.ended_at!.getTime() - lapsed.queued_at!.getTime()).toBeGreaterThanOrEqual(10_000);
  });

  it('4d. pacing yields: with dialable contacts, agents who go available while callers wait are reserved for the callers, never by an attempt', async () => {
    const campaignId = await campaign(world);
    const a = await joinAgent(world, campaignId, { available: false });
    const b = await joinAgent(world, campaignId, { available: false });
    await dialable(campaignId, 5);
    const calls = [ring(world, callerScript(() => false), '447700900401'), ring(world, callerScript(() => false), '447700900402')];
    for (const c of calls) await spineWhen(c, 'queued', (r) => r.state === 'queued');
    await Promise.all([goAvailable(a), goAvailable(b)]);
    for (const c of calls) await spineWhen(c, 'connected', (r) => r.state === 'connected');
    expect(await attemptsOnto([a.sessionId, b.sessionId])).toBe(0);
    const sessions = await Promise.all(calls.map(async (c) => (await spineOf(c))!.session_id));
    expect(new Set(sessions)).toEqual(new Set([a.sessionId, b.sessionId]));
  });
});

describe('inbound P2: a caller who hangs up on offer, a station lost (§2 races)', () => {
  it('5. the caller hangs up while offered: abandoned_in_queue with its Missed row and callback, the panel cleared, the agent back to the pool, nothing bound', async () => {
    const campaignId = await campaign(world);
    const contactId = await contact(campaignId, { next_attempt_at: new Date(Date.now() + 86_400_000) });
    const agent = await joinAgent(world, campaignId);
    const call = ring(world, [
      { do: 'answer' }, { do: 'connect' }, { do: 'start' },
      { do: 'waitFor', until: () => inboundCalls(agent).length > 0, what: 'the offer' },
      { do: 'hangup', status: 'completed', source: 'Caller' },
      { do: 'close' },
    ]);
    const ended = await spineWhen(call, 'ended', (r) => r.state === 'ended');
    expect(ended).toMatchObject({
      outcome: 'abandoned_in_queue', follow_up_reason: 'abandoned_in_queue', session_id: agent.sessionId, bridged_at: null, offer_count: 1,
    });
    expect(ended.settled_at).not.toBeNull();
    expect(ended.callback_due_at).not.toBeNull();
    await waitFor('the panel cleared', () => inboundCalls(agent).some((c) => c['state'] === 'ended'));
    expect(inboundCalls(agent).at(-1)).toMatchObject({ outcome: 'abandoned_in_queue', outcome_due_at: null });
    await waitFor('back to available', async () => (await liveOf(agent.sessionId))?.state === 'available');
    expect(await liveOf(agent.sessionId)).toMatchObject({ inboundCallId: null });
    expect(framesOf(agent, 'media')).toEqual([]);
    const { rows } = await pool().query('SELECT callback_source FROM agency_contacts WHERE id = $1', [contactId]);
    expect(rows[0].callback_source).toBe('inbound');
  });

  it('6a. the station dropped during the offer: the caller back at the head, the next agent gets them', async () => {
    const campaignId = await campaign(world);
    const first = await joinAgent(world, campaignId);
    await sleep(50);
    const second = await joinAgent(world, campaignId);
    let hangUp = false;
    const call = ring(world, callerScript(() => hangUp));
    await waitFor('the offer to the longest idle', () => inboundCalls(first).length > 0);
    first.leg!.terminate();
    const taken = await spineWhen(call, 'connected to the next agent', (r) => r.state === 'connected');
    expect(taken).toMatchObject({ session_id: second.sessionId, offer_count: 2 });
    // Cancelled by the close itself, well before the first offer's bind would have found the socket gone.
    const firstOffer = Date.parse(String(inboundCalls(first)[0]!['offered_at']));
    const secondOffer = Date.parse(String(inboundCalls(second)[0]!['offered_at']));
    expect(secondOffer - firstOffer).toBeLessThan(AGENCY_INBOUND_CONNECT_DELAY_MS);
    expect(taken.queued_at).not.toBeNull();
    expect(await liveOf(first.sessionId)).toMatchObject({ state: 'offline', inboundCallId: null });
    hangUp = true;
  });

  it('6b. the station dropped after the bind and back inside 8 s: the call resumes on the new socket, the panel restored after `ready`', async () => {
    const campaignId = await campaign(world);
    const agent = await joinAgent(world, campaignId);
    let hangUp = false;
    const call = ring(world, callerScript(() => hangUp));
    const connected = await spineWhen(call, 'connected', (r) => r.state === 'connected');
    await waitFor('media flowing', () => framesOf(agent, 'media').length > 5);
    agent.leg!.terminate();
    await sleep(1500);
    // The bridge's grace owns the call: presence is left on the call, never written offline.
    expect(await liveOf(agent.sessionId)).toMatchObject({ state: 'on_call', inboundCallId: connected.id });
    const leg = await agent.connectReady();
    expect(leg.ready).toMatchObject({ state: 'on_call' });
    await waitFor('the inbound_call frame after ready', () => leg.ofEvent('inbound_call').length > 0);
    expect(leg.ofEvent('inbound_call')[0]).toMatchObject({ call: { id: connected.id, state: 'connected' } });
    const readyAt = leg.frames.findIndex((f) => f.frame?.['event'] === 'ready');
    const frameAt = leg.frames.findIndex((f) => f.frame?.['event'] === 'inbound_call');
    expect(readyAt).toBeLessThan(frameAt);
    await waitFor('media on the new socket', () => leg.ofEvent('media').length > 5);
    expect((await spineOf(call))!.state).toBe('connected');
    hangUp = true;
    await spineWhen(call, 'ended answered', (r) => r.state === 'ended' && r.outcome === 'answered');
  });
});

describe('inbound P2: restart, recording, concurrency', () => {
  it('8. restart: the startup sweep writes a queued caller`s Missed row and callback; an agent with an answered call owing its outcome comes back on break with the guard; the outcome; then available', async () => {
    const runtime = getAgencyRuntime()!;
    const campaignId = await campaign(world);
    const contactId = await contact(campaignId, { next_attempt_at: new Date(Date.now() + 86_400_000) });
    const agent = await joinAgent(world, campaignId, { available: false });
    const arrival = (from: string, match: boolean) => agencyInboundCallRepository.insertArrival({
      tenantId: TENANT, accountId: ACCOUNT, routeId: world.routeId, phoneNumberId: world.phoneNumberId, provider: 'plivo',
      telephonyCredentialId: world.rig.credentialId, providerCallId: `CA-${randomUUID()}`, fromE164: from, toE164: CALLER_ID,
      identification: { match: match ? { contactId, campaignId } : null, callerDnc: false, sticky: null },
      answered: true, recordingRequested: false, analysisProfileId: null,
    });
    // What a crash left: one caller queued, one answered and connected to the agent (its lease lapsed).
    const queued = (await arrival(CALLER_E164, true)).call!;
    await agencyInboundCallRepository.transition(queued.id, 'queued');
    const owed = (await arrival('+447700900801', false)).call!;
    await agencyInboundCallRepository.transition(owed.id, 'queued');
    expect((await agencyInboundCallRepository.offer(owed.id, agent.sessionId)).ok).toBe(true);
    expect(await agencyInboundCallRepository.connect(owed.id, { sessionId: agent.sessionId, answeredByUserId: agent.agentUserId })).not.toBeNull();
    await runtime.agents.clear(agent.sessionId);

    // The restart's inbound start: the sweep, then the router (this suite's own is put back after).
    const running = getInboundCallRouter();
    const connector = runtime.inbound;
    const restarted = await startInboundCalls({
      bridge: world.rig.bridge, dnc: new DncRegistry(),
      connect: { runtime, enabled: async () => true, mediaWorkers: 0 },
    });
    try {
      const swept = (await agencyInboundCallRepository.findByIdAnyTenant(queued.id))!;
      // We lost this caller (QA-F9): `failed`, not a caller who hung up; still followed up.
      expect(swept).toMatchObject({ state: 'ended', outcome: 'failed', follow_up_status: 'open', follow_up_reason: 'failed', settled_at: expect.any(Date) });
      expect(swept.callback_due_at).not.toBeNull();
      expect((await pool().query('SELECT callback_source FROM agency_contacts WHERE id = $1', [contactId])).rows[0].callback_source).toBe('inbound');
      const answered = (await agencyInboundCallRepository.findByIdAnyTenant(owed.id))!;
      expect(answered).toMatchObject({ state: 'ended', outcome: 'answered', settled_at: null, follow_up_status: null });

      // The agent's console reconnects: `break` with the call re-claimed, its panel after `ready`.
      agent.leg!.terminate();
      const leg = await agent.connectReady();
      expect(leg.ready).toMatchObject({ state: 'break' });
      await waitFor('the owed call after ready', () => leg.ofEvent('inbound_call').length > 0);
      expect(leg.ofEvent('inbound_call')[0]).toMatchObject({ call: { id: owed.id, state: 'ended', outcome: 'answered' } });
      expect((leg.ofEvent('inbound_call')[0]!['call'] as Record<string, unknown>)['outcome_due_at']).not.toBeNull();
      expect(await liveOf(agent.sessionId)).toMatchObject({ state: 'break', inboundCallId: owed.id });
      // `available` is refused while the outcome is owed.
      const refused = await callCore({ method: 'POST', path: `/agency/sessions/${agent.sessionId}/available`, body: { agent_user_id: agent.agentUserId }, tenantId: TENANT, accountId: ACCOUNT });
      expect(refused.status).toBe(409);
      expect(refused.body).toMatchObject({ code: 'inbound_call_live', inbound_call_id: owed.id });
      // The outcome: the call settled and the claim cleared, but the agent stays on the break the
      // restart left them on (SWE-M1: a settle never lifts a break); their own Go available does.
      const saved = await finish('POST', `${owed.id}/disposition`, agent.agentUserId, { code: 'voicemail' });
      expect(saved.status, JSON.stringify(saved.body)).toBe(200);
      expect(await liveOf(agent.sessionId)).toMatchObject({ state: 'break', inboundCallId: null });
      const available = await callCore({ method: 'POST', path: `/agency/sessions/${agent.sessionId}/available`, body: { agent_user_id: agent.agentUserId }, tenantId: TENANT, accountId: ACCOUNT });
      expect(available.status, JSON.stringify(available.body)).toBe(200);
      expect(await liveOf(agent.sessionId)).toMatchObject({ state: 'available', inboundCallId: null });
    } finally {
      await restarted.stop();
      runtime.attachInbound(connector);
      setInboundCallRouter(running);
    }
  });

  it('10. recording: the notice plays in the preamble before the agent is offered; the Record API after `bridged`; the recording lands on the leg', async () => {
    await setRoute(world, { record_calls: true, recording_notice: true });
    const campaignId = await campaign(world);
    const agent = await joinAgent(world, campaignId);
    let hangUp = false;
    const call = ring(world, callerScript(() => hangUp));
    const connected = await spineWhen(call, 'connected', (r) => r.state === 'connected');
    expect(connected.recording_requested).toBe(true);
    expect(inboundCalls(agent)[0]).toMatchObject({ recording: true });
    // The greeting and the notice were played whole before the offer (Q5, IB7).
    const preambleFrames = Math.ceil(world.clips.greeting.bytes / 160) + Math.ceil(world.clips.notice.bytes / 160);
    const beforeOffer = call.receivedFrameCount - call.framesReceivedAfter(connected.offered_at!.getTime());
    expect(beforeOffer).toBeGreaterThanOrEqual(preambleFrames);
    await waitFor('the Record API request', () => call.apiRecordings.length === 1 || null);
    expect(call.apiRecordings[0]!.startedAt).toBeGreaterThanOrEqual(connected.bridged_at!.getTime());
    await sleep(500);
    hangUp = true;
    const ended = await spineWhen(call, 'ended', (r) => r.state === 'ended');
    await call.done;
    const leg = await waitFor('the recording on the leg', async () => {
      const { rows } = await pool().query('SELECT recording_url FROM agency_calls WHERE id = $1', [ended.webrtc_call_id]);
      return rows[0]?.recording_url ? rows[0] : null;
    });
    expect(leg.recording_url).toContain('/Recording/');
  });

  it('11. concurrency: over the route`s max_concurrent the caller hears busy (overflow_no_capacity); a caller over the ACCOUNT`s limit is still put through (IB5)', async () => {
    await setRoute(world, { max_concurrent: 1, max_waiting: 1, record_calls: true });
    const first = ring(world, callerScript(() => false), '447700901101');
    const queued = await spineWhen(first, 'first queued', (r) => r.state === 'queued');
    expect(queued.recording_requested).toBe(true);
    const busy = ring(world, callerScript(() => false), '447700901102');
    const refused = await spineWhen(busy, 'busy', (r) => r.state === 'ended');
    expect(refused).toMatchObject({ outcome: 'overflow_no_capacity', follow_up_reason: 'overflow_no_capacity', session_id: null });
    // Turned away, so never recorded: the arrival asks for no recording, on the spine or its leg.
    expect(refused.recording_requested).toBe(false);
    const refusedLeg = await pool().query('SELECT recording_requested FROM agency_calls WHERE id = $1', [refused.webrtc_call_id]);
    expect(refusedLeg.rows[0].recording_requested).toBe(false);
    await setRoute(world, { record_calls: false });

    // The account's own limit is full (one live call, a limit of one): the next caller is admitted anyway and connects.
    await setRoute(world, { max_concurrent: 5, max_waiting: 5 });
    await pool().query('UPDATE account_settings SET max_concurrent_calls = 1 WHERE tenant_id = $1 AND account_id = $2', [TENANT, ACCOUNT]);
    await getConcurrencyControl().invalidateAccountLimit(TENANT, ACCOUNT);
    let hangUp = false;
    const accept = vi.spyOn(world.rig.bridge, 'acceptInboundCall');
    const third = ring(world, callerScript(() => hangUp), '447700901103');
    await spineWhen(third, 'third queued', (r) => r.state === 'queued');
    expect(await accept.mock.results.at(-1)!.value).toMatchObject({ accepted: true, capacity: 'account_full' });
    accept.mockRestore();
    const campaignId = await campaign(world);
    const a = await joinAgent(world, campaignId);
    const b = await joinAgent(world, campaignId);
    const connected = await spineWhen(third, 'third connected', (r) => r.state === 'connected');
    expect([a.sessionId, b.sessionId]).toContain(connected.session_id);
    hangUp = true;
  });

  it('12. a graceful shutdown: the inbound stop ends the calls it holds (service_shutdown) and has settled them (failed, the Missed row, Q18) by the time it returns', async () => {
    const runtime = getAgencyRuntime()!;
    const running = getInboundCallRouter();
    const connector = runtime.inbound;
    // A second start, as test 8's restart, so its stop can be driven without stopping the agency.
    const restarted = await startInboundCalls({
      bridge: world.rig.bridge, dnc: new DncRegistry(),
      connect: { runtime, enabled: async () => true, mediaWorkers: 0 },
    });
    try {
      const call = ring(world, callerScript(() => false), '447700901201');
      const queued = await spineWhen(call, 'queued', (r) => r.state === 'queued');
      expect(restarted.router.liveCallIds()).toEqual([queued.id]);
      await restarted.stop();
      // Settled before the stop returned: nothing is left for the next start's sweep.
      expect((await agencyInboundCallRepository.findByIdAnyTenant(queued.id))!).toMatchObject({
        state: 'ended', outcome: 'failed', follow_up_reason: 'failed', follow_up_status: 'open', settled_at: expect.any(Date),
      });
      expect(restarted.router.liveCallIds()).toEqual([]);
    } finally {
      await restarted.stop();
      runtime.attachInbound(connector);
      setInboundCallRouter(running);
    }
  });
});
