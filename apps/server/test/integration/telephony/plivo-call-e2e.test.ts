import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A campaign dialling on a tenant's OWN Plivo account, end to end (B18–B22): the pacing
 * loop dials the campaign's pinned credential through the real bridge and `PlivoAdapter`;
 * the mock Plivo carrier rings, answers (fetching our answer XML and streaming to the
 * `<Stream>` it names), posts its signed callbacks to the real routes, and takes our REST
 * hangups. `plivo-rig.ts` says what is real (everything in the call path).
 *
 *  (a) a full call: ring → answer XML → stream start / μ-law media / playAudio → the agent
 *      hangs up → REST `DELETE Call/{call_uuid}` → the row is `completed` with the request
 *      id, the carrier's call id and the credential; the recording callback persists the URL;
 *  (b) the agent dismisses while it rings → REST `DELETE Request/{request_uuid}`, never a
 *      call hangup; a late answer is answered with the hangup XML;
 *  (c) a callback signed with no, a forged, or ANOTHER tenant's Plivo token is refused and
 *      changes nothing; a valid one after them still works;
 *  (d) a dial Plivo refuses 401 pauses the campaign `carrier_auth`, audited, and marks the
 *      credential `invalid` (a resume is refused until a verify or rotation clears it);
 *  (e) after a rotation, a callback signed with the previous token inside the grace is
 *      accepted, and the REST hangup goes out on the new token;
 *  (g) a credential disabled while its campaign runs: the dial is refused before the carrier
 *      and the campaign is paused `carrier_account_unavailable`, audited, the contact
 *      returned uncharged (not held and cycled).
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
import { getAgencyRuntime } from '../../../src/bootstrap/agency.js';
import { auditLogger } from '../../../src/audit/audit-logger.js';
import { campaignCredentialStartRefusal } from '../../../src/agency/campaign-carrier.js';
import { PLIVO_HANGUP_XML } from '../../../src/telephony/plivo/plivo.adapter.js';
import { bits, isLoudMulaw, isLoudPcm16 } from '../../mocks/voicelink/audio-pattern.js';
import type { PlivoCall, PlivoCallScript } from '../../mocks/plivo/index.js';
import {
  ADMIN, CALLER_ID, PLIVO_E2E_ENV, attemptOf, callRow, campaignRow, closePlivoDb, initPlivoDb, joinAgent, plivoCampaign,
  startPlivoRig, waitFor, type PlivoRig, type Station,
} from './plivo-rig.js';

const TERMINAL = new Set(['completed', 'no_answer', 'busy', 'canceled', 'failed']);

let rig: PlivoRig | null = null;
let station: Station | null = null;

beforeAll(() => {
  expect(env).toEqual(PLIVO_E2E_ENV); // one source of truth for the env the rig expects
  initPlivoDb();
});
beforeEach(async () => { rig = await startPlivoRig(); });
afterEach(async () => {
  await station?.close();
  station = null;
  await rig?.carrier.settled();
  await rig?.stop();
  rig = null;
  vi.restoreAllMocks();
});
afterAll(closePlivoDb);

/** The one call the mock placed, and the attempt and row behind it. */
async function placed(r: PlivoRig, campaignId: string): Promise<{ call: PlivoCall; attemptId: string; callId: string }> {
  const call = await waitFor('the dial reached the carrier', () => r.carrier.callOrder[0]);
  const attempt = await waitFor('the attempt', async () => {
    const a = await attemptOf(campaignId);
    return a?.webrtc_call_id ? a : null;
  });
  expect(attempt.webrtc_call_id).toBe(call.callId);
  return { call, attemptId: attempt.id, callId: call.callId };
}

async function terminalRow(callId: string, extra: (row: NonNullable<Awaited<ReturnType<typeof callRow>>>) => boolean = () => true) {
  return waitFor(`call ${callId} terminal`, async () => {
    const row = await callRow(callId);
    return row && TERMINAL.has(row.status) && row.ended_at && extra(row) ? row : null;
  }, 20_000, async () => JSON.stringify(await callRow(callId)));
}

describe('a call on the tenant`s own Plivo account, through the real server', () => {
  it('(a) dial → ring → answer XML → stream → agent hangup → REST hangup by call id → completed; the recording URL is persisted', async () => {
    const r = rig!;
    const pattern = Array.from({ length: 25 }, (_, i) => i % 3 !== 1);
    r.carrier.setScript(() => ({
      name: 'answered',
      steps: [
        { do: 'ring' },
        { do: 'answer' },
        { do: 'connect' },
        { do: 'start' },
        { do: 'media', pattern },
        { do: 'waitFor', until: (c) => c.hungUpByApi, what: 'our REST hangup', timeoutMs: 20_000 },
        { do: 'waitFor', until: (c) => c.callbacks.some((cb) => cb.to === 'hangup'), what: 'the hangup callback' },
        { do: 'recording', recordingId: 'rec-e2e-a' },
      ],
    }));
    const { campaignId } = await plivoCampaign(r);
    station = await joinAgent(r, campaignId);
    const { call, attemptId, callId } = await placed(r, campaignId);

    // The dial: on the tenant's account, from its synced number, no stream URL in it.
    const [dial] = r.carrier.requestsTo('create_call');
    expect(dial).toMatchObject({ status: 201, authorized: true });
    expect(dial!.body).toMatchObject({ from: CALLER_ID.slice(1), to: '919812345678', answer_method: 'POST' });
    expect(JSON.stringify(dial!.body)).not.toContain('pstn-stream');

    // The customer's audio reached the agent, in order; the agent's reached the customer.
    await waitFor('the customer heard by the agent', () => station!.media.length >= pattern.length, 20_000,
      () => `${station!.media.length} frames, carrier errors ${JSON.stringify(call.errors)}`);
    expect(bits(station!.media.slice(0, pattern.length).map(isLoudPcm16))).toBe(bits(pattern));
    station!.talk(25, true);
    await waitFor('the agent heard by the customer (playAudio)', () => call.playAudio.length >= 20);
    expect(call.playAudio.filter(isLoudMulaw).length).toBeGreaterThan(10);
    expect(call.received.filter((f) => f['event'] === 'playAudio').every((f) =>
      (f['media'] as { contentType: string; sampleRate: number }).contentType === 'audio/x-mulaw')).toBe(true);

    // The agent hangs up (the hangup route's own entry).
    expect(await getAgencyRuntime()!.dialer.hangupAttempt(attemptId)).toBe(true);
    await r.carrier.settled();

    expect(call.errors).toEqual([]);
    expect(call.statusesFor('ring')).toEqual([200]);
    expect(call.statusesFor('answer')).toEqual([200]);
    expect(call.callbacks.find((c) => c.to === 'answer')!.contentType).toMatch(/^text\/xml/);
    expect(call.answerXml).toContain('<Record recordSession="true"');
    expect(call.streamUrl).toMatch(new RegExp(`^wss://agency\\.test/api/v1/webrtc-call/${callId}/pstn-stream\\?token=`));
    expect(call.statusesFor('hangup')).toEqual([200]);
    expect(call.statusesFor('recording')).toEqual([200]);
    // Hung up by Plivo's call id, never cancelled by request (it was answered).
    expect(r.carrier.requestsTo('hangup_call').map((q) => q.id)).toEqual([call.callUuid]);
    expect(r.carrier.requestsTo('cancel_request')).toEqual([]);

    const row = await terminalRow(callId, (x) => x.recording_url !== null);
    expect(row).toMatchObject({
      status: 'completed',
      provider: 'plivo',
      provider_request_id: call.requestUuid,
      provider_call_id: call.callUuid,
      telephony_credential_id: r.credentialId,
      caller_id: CALLER_ID,
      recording_url: `https://media.plivo.com/v1/Account/${r.carrier.authId}/Recording/rec-e2e-a.mp3`,
    });
    expect(row.answered_at).not.toBeNull();
    await waitFor('attempt ended connected', async () => (await attemptOf(campaignId))?.outcome === 'connected');
    expect(r.carrier.offHost).toEqual([]);
    expect(r.bridge.getActiveCount()).toBe(0);
  }, 60_000);

  it('(b) the agent dismisses while it rings: cancelled by request id, no call hangup; a late answer gets the hangup XML', async () => {
    const r = rig!;
    r.carrier.setScript(() => ({
      name: 'dismissed while ringing',
      steps: [
        { do: 'ring' },
        { do: 'waitFor', until: (c) => c.canceledByApi, what: 'our REST cancel', timeoutMs: 20_000 },
        { do: 'waitFor', until: (c) => c.callbacks.some((cb) => cb.to === 'hangup'), what: 'the cancel callback' },
        // Plivo connected the callee anyway, a moment after: its answer reaches us late.
        { do: 'post', to: 'answer', params: { CallStatus: 'in-progress' } },
      ],
    }));
    const { campaignId } = await plivoCampaign(r);
    station = await joinAgent(r, campaignId);
    const { call, attemptId, callId } = await placed(r, campaignId);
    await waitFor('ringing', async () => (await callRow(callId))?.status === 'ringing');

    expect(await getAgencyRuntime()!.dialer.hangupAttempt(attemptId)).toBe(true);
    await r.carrier.settled();

    expect(call.errors).toEqual([]);
    expect(r.carrier.requestsTo('cancel_request').map((q) => [q.id, q.status])).toEqual([[call.requestUuid, 204]]);
    expect(r.carrier.requestsTo('hangup_call')).toEqual([]);
    // The cancel callback (late, after teardown) was accepted; the late answer hung up.
    expect(call.statusesFor('hangup')).toEqual([200]);
    const late = call.callbacks.find((c) => c.to === 'answer')!;
    expect(late.status).toBe(200);
    expect(late.body).toBe(PLIVO_HANGUP_XML);
    const row = await terminalRow(callId);
    expect(row).toMatchObject({ provider_request_id: call.requestUuid, telephony_credential_id: r.credentialId });
    expect(row.answered_at).toBeNull();
    expect(row.status).not.toBe('completed');
    expect(r.bridge.getActiveCount()).toBe(0);
  }, 60_000);

  it('(c) a callback unsigned, forged, or signed by ANOTHER tenant`s Plivo account is refused and changes nothing', async () => {
    const r = rig!;
    let checked = false;
    r.carrier.setScript((): PlivoCallScript => ({
      name: 'forged callbacks, then a real no-answer',
      steps: [
        { do: 'post', to: 'ring', params: { CallStatus: 'ringing' }, sign: 'none' },
        { do: 'post', to: 'ring', params: { CallStatus: 'ringing' }, sign: { token: 'forgedTokenNotOnTheAccount01' } },
        { do: 'post', to: 'ring', params: { CallStatus: 'ringing' }, sign: { token: r.otherCarrier.authToken } },
        { do: 'post', to: 'answer', params: { CallStatus: 'in-progress' }, sign: { token: r.otherCarrier.authToken } },
        { do: 'post', to: 'hangup', params: { CallStatus: 'completed', Duration: '30' }, sign: { token: r.otherCarrier.authToken } },
        // Signed by this account, but over another URL (a token swapped in the query).
        { do: 'post', to: 'ring', params: { CallStatus: 'ringing' }, sign: { url: 'https://agency.test/api/v1/webhooks/plivo/webrtc-status/x?token=y' } },
        { do: 'waitFor', until: () => checked, what: 'the test to check nothing changed' },
        { do: 'hangup', status: 'no-answer' },
      ],
    }));
    const { campaignId } = await plivoCampaign(r);
    station = await joinAgent(r, campaignId);
    const { call, callId } = await placed(r, campaignId);
    await waitFor('the forged callbacks posted', () => call.callbacks.length === 6);

    expect(call.callbacks.map((c) => [c.to, c.status])).toEqual([
      ['ring', 403], ['ring', 403], ['ring', 403], ['answer', 200], ['hangup', 403], ['ring', 403],
    ]);
    expect(call.callbacks[3]!.body).toBe(PLIVO_HANGUP_XML);
    const row = await callRow(callId);
    expect(row).toMatchObject({ status: 'initiating', provider_call_id: null, answered_at: null, ended_at: null });
    expect(r.bridge.getSession(callId)?.carrierCallId ?? null).toBeNull();
    expect(r.carrier.requestsTo('hangup_call')).toEqual([]);
    checked = true;

    await r.carrier.settled();
    expect(call.statusesFor('hangup')).toEqual([403, 200]);
    const after = await terminalRow(callId);
    expect(after.status).toBe('no_answer');
  }, 60_000);

  it('(d) a dial Plivo refuses 401 pauses the campaign `carrier_auth`, audited; nothing else is dialled', async () => {
    const r = rig!;
    const audit = vi.spyOn(auditLogger, 'log');
    r.carrier.injectFault('create_call', { kind: 'status', status: 401 }, Infinity);
    const { campaignId, contactId } = await plivoCampaign(r);
    station = await joinAgent(r, campaignId);
    await waitFor('campaign paused', async () => (await campaignRow(campaignId)).status === 'paused');
    expect(await campaignRow(campaignId)).toEqual({ status: 'paused', pause_reason: 'carrier_auth' });
    expect(r.carrier.requestsTo('create_call')).toHaveLength(1);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'agency_campaign.auto_paused',
      eventData: expect.objectContaining({ campaign_id: campaignId, reason: 'carrier_auth', telephony_credential_id: r.credentialId }),
    }));
    // The contact is not charged a carrier refusal: it is back in the roster at once.
    const contact = await waitFor('the contact returned', async () => {
      const { rows } = await getTestPool().query<{ state: string; due: boolean; our_fault_attempts: number }>(
        `SELECT state, next_attempt_at <= now() + interval '1 second' AS due, our_fault_attempts
           FROM agency_contacts WHERE id = $1`, [contactId]);
      return rows[0]!.state === 'pending' ? rows[0] : null;
    });
    expect(contact).toEqual({ state: 'pending', due: true, our_fault_attempts: 0 });
    expect(r.carrier.callOrder).toHaveLength(0);

    // The carrier's verdict is on the credential too: `invalid`, so a resume is refused
    // until a super-admin verifies or rotates it, rather than dialling into the same 401.
    const credential = await waitFor('the credential marked invalid', async () => {
      const row = await r.credentials.get(r.credentialId);
      return row?.status === 'invalid' ? row : null;
    });
    expect(credential).toMatchObject({ secret_version: 1, last_error: 'The carrier refused the credential on a dial (HTTP 401)' });
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'telephony_credential.carrier_refused', actor: 'system:carrier-auth',
      eventData: expect.objectContaining({ telephony_credential_id: r.credentialId, secret_version: 1, status: 'invalid' }),
    }));
    expect(JSON.stringify(audit.mock.calls)).not.toContain(r.carrier.authToken);
    expect(await campaignCredentialStartRefusal({ telephony_credential_id: r.credentialId }))
      .toMatchObject({ code: 'telephony_credential_not_active' });
    // A verify the carrier accepts brings it back.
    const verified = await r.credentials.verify(r.credentialId, ADMIN);
    expect(verified.ok && verified.value).toMatchObject({ status: 'active', last_error: null });
    expect(await campaignCredentialStartRefusal({ telephony_credential_id: r.credentialId })).toBeNull();
  }, 60_000);

  it('(g) a credential disabled while its campaign runs pauses it `carrier_account_unavailable`; nothing reaches the carrier', async () => {
    const r = rig!;
    const audit = vi.spyOn(auditLogger, 'log');
    const { campaignId, contactId } = await plivoCampaign(r);
    const disabled = await r.credentials.disable(r.credentialId, ADMIN);
    expect(disabled.ok).toBe(true);
    station = await joinAgent(r, campaignId);
    await waitFor('campaign paused', async () => (await campaignRow(campaignId)).status === 'paused');
    expect(await campaignRow(campaignId)).toEqual({ status: 'paused', pause_reason: 'carrier_account_unavailable' });
    expect(r.carrier.requestsTo('create_call')).toEqual([]);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'agency_campaign.auto_paused',
      eventData: expect.objectContaining({ campaign_id: campaignId, reason: 'carrier_account_unavailable', telephony_credential_id: r.credentialId }),
    }));
    const contact = await waitFor('the contact returned', async () => {
      const { rows } = await getTestPool().query<{ state: string; due: boolean; our_fault_attempts: number }>(
        `SELECT state, next_attempt_at <= now() + interval '1 second' AS due, our_fault_attempts
           FROM agency_contacts WHERE id = $1`, [contactId]);
      return rows[0]!.state === 'pending' ? rows[0] : null;
    });
    expect(contact).toEqual({ state: 'pending', due: true, our_fault_attempts: 0 });
    // One refused attempt, not a roster cycled through refusals.
    const { rows } = await getTestPool().query<{ n: number }>('SELECT count(*)::int AS n FROM agency_call_attempts WHERE campaign_id = $1', [campaignId]);
    expect(rows[0]!.n).toBe(1);
  }, 60_000);

  it('(e) after a rotation, a callback signed with the previous token inside the grace is accepted; the hangup uses the new token', async () => {
    const r = rig!;
    const oldToken = r.carrier.authToken;
    const newToken = 'tenantAuthToken-rotated-0002';
    let rotated = false;
    r.carrier.setScript(() => ({
      name: 'rotated mid-call',
      steps: [
        { do: 'waitFor', until: () => rotated, what: 'the rotation' },
        // In flight from before the rotation: signed with the previous token.
        { do: 'ring', sign: { token: oldToken } },
        { do: 'answer' },
        { do: 'waitFor', until: (c) => c.hungUpByApi, what: 'our REST hangup', timeoutMs: 20_000 },
      ],
    }));
    const { campaignId } = await plivoCampaign(r);
    station = await joinAgent(r, campaignId);
    const { call, attemptId, callId } = await placed(r, campaignId);

    r.carrier.rotateAuthToken(newToken);
    const rot = await r.credentials.rotate(r.credentialId, { fields: { auth_token: newToken }, expectedVersion: 1, adminId: ADMIN });
    expect(rot.ok).toBe(true);
    rotated = true;

    await waitFor('answered', async () => (await callRow(callId))?.status === 'in_progress');
    expect(call.statusesFor('ring')).toEqual([200]);
    expect(call.answerXml).toContain('<Stream');
    expect(await getAgencyRuntime()!.dialer.hangupAttempt(attemptId)).toBe(true);
    await r.carrier.settled();
    // The hangup went out on the NEW token (the carrier refuses the old one now).
    const [hangup] = r.carrier.requestsTo('hangup_call');
    expect(hangup).toMatchObject({ id: call.callUuid, authorized: true, status: 204 });
    const row = await terminalRow(callId);
    expect(row.status).toBe('completed');
  }, 60_000);
});
