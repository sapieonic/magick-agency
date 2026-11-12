import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Ringing an away agent's phone for an inbound caller (Mode B, IQ58–IQ74; docs/inbound.md
 * "Ringing an away phone"), end to end: a customer rings a linked number on the mock Plivo carrier,
 * the real server's connector finds the only agent on `away_ring` and rings their phone through the
 * REAL FCM sender on the mock push carrier; the phone answers on the token-only route over HTTP
 * (as native Android does), accepts (as Dart does, through the internal handler the public route
 * calls), attaches a real station socket with the bootstrap's token and `caps=inbound`, and is put
 * through; the call is talked, ended, its outcome saved, and the agent is back to `available`.
 * Then a declined ring, and a ring that expires (the real 20 s window: this file is in the
 * wall-clock lane).
 *
 * Real: Postgres, Redis, the app on loopback, the voice and agency bootstraps (the router, the
 * connector, the away break), the bridge, `PlivoAdapter`, the FCM sender and its OAuth.
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
import { AGENCY_INBOUND_RING_MS, AGENCY_STATION_ALAW8_FRAME_BYTES } from '@magick-agency/contracts/agency';
import { callCore } from '../../../src/api/core-dispatch.js';
import { getAgencyRuntime } from '../../../src/bootstrap/agency.js';
import { getFeatureFlagService } from '../../../src/feature-flags/index.js';
import { resetPushSender, setPushSender } from '../../../src/seams/push-sender.js';
import { agencyPushDeviceRepository } from '../../../src/db/repositories/agency.repository.js';
import { ACCOUNT, PLIVO_E2E_ENV, TENANT, closePlivoDb, initPlivoDb, startPlivoRig, waitFor, type PlivoRig } from './plivo-rig.js';
import {
  CAPABLE_PHONE, callerScript, callers, campaign, finish, inboundCalls, joinAgent, liveOf, ring, spineWhen, startInboundWorld,
  type InboundWorld,
} from './inbound-connect-rig.js';
import { MockPushCarrier } from '../../mocks/push/index.js';
import type { FleetAgent } from '../../mocks/station-fleet.js';

const pool = () => getTestPool();

let rig: PlivoRig | null = null;
let world: InboundWorld;
let carrier: MockPushCarrier;

beforeAll(async () => {
  expect(env).toEqual(PLIVO_E2E_ENV);
  initPlivoDb();
  carrier = await MockPushCarrier.start();
});
beforeEach(async () => {
  callers.hangUpAll = false;
  rig = await startPlivoRig();
  world = await startInboundWorld(rig);
  carrier.reset();
  setPushSender(carrier.sender());
  await setRingFlag(true);
});
afterEach(async () => {
  callers.hangUpAll = true;
  resetPushSender();
  await world?.fleet.closeAll();
  await rig?.carrier.settled();
  await rig?.stop();
  rig = null;
});
afterAll(async () => {
  await carrier.stop();
  await closePlivoDb();
});

/** `agency_inbound_ring_enabled` for the account (beside `agency_inbound_enabled`, which the world turns on). */
async function setRingFlag(on: boolean): Promise<void> {
  await pool().query(`DELETE FROM feature_flag_overrides WHERE flag_key = 'agency_inbound_ring_enabled' AND tenant_id = $1`, [TENANT]);
  await pool().query(
    `INSERT INTO feature_flag_overrides (flag_key, scope_type, tenant_id, account_id, value)
     VALUES ('agency_inbound_ring_enabled', 'account', $1, $2, $3::jsonb)`, [TENANT, ACCOUNT, on ? 'true' : 'false']);
  await getFeatureFlagService().invalidate({ tenantId: TENANT });
}

/**
 * A phone on duty (`caps=inbound`), its push device registered and opted in on the mock carrier,
 * gone away ringing (`POST /sessions/:id/break {reason:'away_ring'}`), its socket parked.
 */
async function awayPhone(): Promise<{ phone: FleetAgent; deviceId: string; fcmToken: string }> {
  const campaignId = await campaign(world);
  const phone = await joinAgent(world, campaignId, { station: CAPABLE_PHONE });
  const deviceId = `phone-e2e-${randomUUID().slice(0, 8)}`;
  const fcmToken = MockPushCarrier.device('android').fcm_token!;
  await pool().query('UPDATE agency_agent_sessions SET station_device_id = $2 WHERE id = $1', [phone.sessionId, deviceId]);
  await agencyPushDeviceRepository.register({
    tenantId: TENANT, userId: phone.agentUserId, deviceId, platform: 'android', token: fcmToken, appBuild: '1.4.0+40', ringEnabled: true,
  });
  const away = await callCore({
    method: 'POST', path: `/agency/sessions/${phone.sessionId}/break`,
    body: { reason: 'away_ring', agent_user_id: phone.agentUserId }, tenantId: TENANT, accountId: ACCOUNT,
  });
  expect(away.status, JSON.stringify(away.body)).toBe(200);
  expect(away.body).toMatchObject({ state: 'break', break_reason: 'away_ring' });
  // The app parks its socket once the break lands (IQ67).
  phone.leg!.close();
  await waitFor('the socket parked', () => !getAgencyRuntime()!.stations.isLocallyOwned(phone.sessionId));
  await waitFor('still on away_ring', async () => {
    const live = await liveOf(phone.sessionId);
    return live?.state === 'break' && live.ring;
  });
  return { phone, deviceId, fcmToken };
}

/** The ring push the carrier received for this phone. */
async function ringOf(fcmToken: string): Promise<Record<string, string>> {
  await waitFor('the ring push', () => carrier.sendsTo(fcmToken).some((s) => s.data['type'] === 'ring'), 20_000);
  return carrier.sendsTo(fcmToken).find((s) => s.data['type'] === 'ring')!.data;
}

/** A token-only ring route, as native Android posts it: no Bearer, no tenant header. */
async function tokenOnly(callId: string, action: 'answering' | 'decline', body: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${rig!.origin}/proxy/agency/inbound/calls/${callId}/ring/${action}`, {
    method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}

describe('ringing an away phone end to end (Mode B)', () => {
  it('away_ring → a caller → the push → answering → accept → the socket attaches → bound → talk → outcome → available', async () => {
    const { phone, deviceId, fcmToken } = await awayPhone();
    let hangUp = false;
    const call = ring(world, callerScript(() => hangUp));

    const push = await ringOf(fcmToken);
    expect(Object.keys(push).sort()).toEqual(['call_id', 'offer_token', 'ring_expires_at', 'session_id', 'type']);
    expect(push).toMatchObject({ type: 'ring', session_id: phone.sessionId });
    const rung = await spineWhen(call, 'rung', (r) => r.state === 'offered');
    expect(rung).toMatchObject({ id: push['call_id'], session_id: phone.sessionId, offer_channel: 'push', ring_count: 1 });
    expect(await liveOf(phone.sessionId)).toMatchObject({ state: 'reserved', inboundCallId: rung.id, pushOffer: true });

    // Native posts `answering` at the tap.
    const answering = await tokenOnly(rung.id, 'answering', { offer_token: push['offer_token'] });
    expect(answering.status, JSON.stringify(answering.body)).toBe(200);
    expect(answering.body).toMatchObject({ call_id: rung.id });

    // Dart accepts (the public route's internal handler) and attaches with the bootstrap's token.
    const accepted = await callCore({
      method: 'POST', path: `/agency/inbound/calls/${rung.id}/ring/accept`,
      body: { offer_token: push['offer_token'], device_id: deviceId, agent_user_id: phone.agentUserId }, tenantId: TENANT, accountId: ACCOUNT,
    });
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    const answer = (accepted.body as { answer: Record<string, unknown> }).answer;
    expect(answer).toMatchObject({ session_id: phone.sessionId, call: { id: rung.id, offer_channel: 'push', connects_at: null } });
    const token = new URL(String(answer['station_ws_url']), 'http://x').searchParams.get('token')!;
    const leg = phone.openWithToken(token);
    const connected = await spineWhen(call, 'connected to the phone', (r) => r.state === 'connected');
    expect(connected).toMatchObject({ session_id: phone.sessionId, ring_result: 'answered', answered_by_user_id: phone.agentUserId });
    expect(leg.ready).toMatchObject({ state: 'reserved' });
    const offered = inboundCalls(phone).find((c) => c['state'] === 'offered')!;
    expect(offered).toMatchObject({ id: rung.id, offer_channel: 'push', connects_at: null });
    expect(offered['accepted_at']).toEqual(expect.any(String));
    await waitFor('the connected frame', () => inboundCalls(phone).some((c) => c['state'] === 'connected'));

    // Audio both ways on the phone's A-law leg.
    await waitFor('the phone hears the caller', () => leg.frames.filter((f) => f.binary).length >= 10);
    const heard = call.receivedFrameCount;
    for (let i = 0; i < 10; i++) leg.sendRaw(Buffer.alloc(AGENCY_STATION_ALAW8_FRAME_BYTES, 0x55), { binary: true });
    await waitFor('the caller hears the phone', () => call.receivedFrameCount >= heard + 5);

    hangUp = true;
    const ended = await spineWhen(call, 'ended', (r) => r.state === 'ended');
    expect(ended).toMatchObject({ outcome: 'answered', settled_at: null });
    const saved = await finish('POST', `${ended.id}/disposition`, phone.agentUserId, { code: 'voicemail' });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    await waitFor('available again', async () => (await liveOf(phone.sessionId))?.state === 'available');
    const row = (await pool().query('SELECT ring_misses, away_ring_since FROM agency_agent_sessions WHERE id = $1', [phone.sessionId])).rows[0];
    expect(row).toMatchObject({ ring_misses: 0, away_ring_since: null });
    expect(carrier.offHost).toEqual([]);
    expect(carrier.sendsTo(fcmToken).every((s) => s.authorized)).toBe(true);
  });

  it('declined on the phone: not a miss; the agent back on away_ring; nobody else could take the caller, who is overflowed at once', async () => {
    const { phone, fcmToken } = await awayPhone();
    const call = ring(world, callerScript(() => false));
    const push = await ringOf(fcmToken);
    const declined = await tokenOnly(push['call_id']!, 'decline', { offer_token: push['offer_token'], reason: 'declined' });
    expect(declined.status, JSON.stringify(declined.body)).toBe(200);
    expect(declined.body).toEqual({ call_id: push['call_id'], ring_result: 'declined' });
    const ended = await spineWhen(call, 'overflowed', (r) => r.state === 'ended');
    expect(ended).toMatchObject({ outcome: 'overflow', ring_result: 'declined', ring_count: 1 });
    expect(await liveOf(phone.sessionId)).toMatchObject({ state: 'break', ring: true, inboundCallId: null });
    const row = (await pool().query('SELECT state, break_reason, ring_misses FROM agency_agent_sessions WHERE id = $1', [phone.sessionId])).rows[0];
    expect(row).toEqual({ state: 'break', break_reason: 'away_ring', ring_misses: 0 });
    await waitFor('ring_cancel', () => carrier.sendsTo(fcmToken).some((s) => s.data['type'] === 'ring_cancel'));
    expect(carrier.sendsTo(fcmToken).find((s) => s.data['type'] === 'ring_cancel')!.data).toMatchObject({ call_id: ended.id, reason: 'declined' });
  });

  it(`a ring nobody answers expires after ${AGENCY_INBOUND_RING_MS / 1000} s: a miss, ring_cancel, back on away_ring`, async () => {
    const { phone, fcmToken } = await awayPhone();
    const call = ring(world, callerScript(() => false, { timeoutMs: 90_000 }));
    const push = await ringOf(fcmToken);
    const started = Date.now();
    const ended = await spineWhen(call, 'expired and overflowed', (r) => r.state === 'ended', AGENCY_INBOUND_RING_MS + 15_000);
    expect(Date.now() - started).toBeGreaterThanOrEqual(AGENCY_INBOUND_RING_MS - 1_500);
    expect(ended).toMatchObject({ id: push['call_id'], ring_result: 'expired', outcome: 'overflow' });
    const row = (await pool().query('SELECT state, break_reason, ring_misses FROM agency_agent_sessions WHERE id = $1', [phone.sessionId])).rows[0];
    expect(row).toEqual({ state: 'break', break_reason: 'away_ring', ring_misses: 1 });
    expect(await liveOf(phone.sessionId)).toMatchObject({ state: 'break', ring: true });
    await waitFor('ring_cancel', () => carrier.sendsTo(fcmToken).some((s) => s.data['type'] === 'ring_cancel'));
    expect(carrier.sendsTo(fcmToken).find((s) => s.data['type'] === 'ring_cancel')!.data).toMatchObject({ reason: 'expired' });
    // The token is spent: a late answer is the uniform 404.
    expect((await tokenOnly(ended.id, 'answering', { offer_token: push['offer_token'] })).status).toBe(404);
  }, AGENCY_INBOUND_RING_MS + 40_000);
});
