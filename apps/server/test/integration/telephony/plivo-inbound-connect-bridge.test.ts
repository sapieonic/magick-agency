import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The bridge half of connecting an inbound caller (docs/inbound.md §5, P2), end to end through the
 * real server against the mock Plivo carrier: the signed answer callback, our answer XML (its
 * stream timeout is the parked budget), the carrier's real media socket, the agent's real station
 * socket, Plivo's Record API and its recording callback through our verified webhook.
 *
 * What decides WHEN to hold, bind, record or hang up is the agency's (WP-C's connector); here a
 * test router stands in for it behind the inbound router seam, so the bridge members are driven
 * directly: `acceptInboundCall` (connectable), `playInboundHold`, `bindBorrowedBrowserLeg`,
 * `stopInboundHold`, `recordInboundAudio`, `forceEndWithOutcome`.
 *
 * Real: Postgres, this lane's Redis, the app listening on loopback, the voice and agency
 * bootstraps, the bridge, the credential service and `PlivoAdapter` (the plivo rig).
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

import { randomBytes, randomUUID } from 'node:crypto';
import { getTestPool } from '../../../../../packages/db/test/helpers/test-db.js';
import { telephonyCredentialRepository } from '@magick-agency/db/repositories/telephony-credential.repository';
import { mintInboundToken } from '../../../src/telephony/plivo/inbound-token.js';
import {
  plivoInboundAnswerUrl, plivoInboundFallbackUrl, plivoInboundStatusUrl, withInboundToken,
} from '../../../src/telephony/plivo/inbound-urls.js';
import { writeTtsFile } from '../../../src/tts/tts-file-cache.js';
import { setInboundCallRouter, type InboundCallRouter } from '../../../src/seams/inbound-call-router.js';
import { getAgencyRuntime } from '../../../src/bootstrap/agency.js';
import type {
  InboundAudioRecording, InboundHoldResult, WebRtcLifecycleEvent,
} from '../../../src/core/webrtc-bridge-manager.js';
import type { PlivoCall, PlivoCallStep } from '../../mocks/plivo/index.js';
import {
  ACCOUNT, ADMIN, NO_RETRY, PLIVO_E2E_ENV, PLIVO_NUMBER, TENANT, CALLER_ID,
  closePlivoDb, initPlivoDb, joinAgent, startPlivoRig, waitFor, type PlivoRig,
} from './plivo-rig.js';
import { insertAgencyCampaign } from '../agency/agency-factories.js';

const pool = () => getTestPool();
const BASE = 'https://agency.test/api/v1/webhooks/plivo';
const CALLER = '919812345678';
/** The parked budget the test router gives every call. */
const PARKED = 120;
/** The account's max duration (no account setting: the bridge default). */
const MAX = 1800;

let rig: PlivoRig | null = null;
let token = '';

/** A clip on this replica's cache (8 kHz PCM16, a 440 Hz tone); its hash. */
function clip(ms: number): { hash: string; bytes: number } {
  const hash = randomBytes(20).toString('hex');
  const samples = Math.round((8000 * ms) / 1000);
  const pcm = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) pcm.writeInt16LE(Math.round(8000 * Math.sin((2 * Math.PI * 440 * i) / 8000)), i * 2);
  writeTtsFile(hash, pcm, 8000, 1);
  return { hash, bytes: samples };
}

/** What the test router does with a call once it is taken in. */
type Plan =
  | { kind: 'hold'; record: boolean; preamble: string[]; hold: string | null }
  | { kind: 'voicemail'; preamble: string[]; prompt: string[]; maxSeconds: number };

interface LiveCall {
  inboundId: string;
  legId: string;
  carrierCallId: string;
  hold: Promise<InboundHoldResult> | null;
  recording: Promise<InboundAudioRecording> | null;
}

/**
 * The stand-in for WP-C's connector, behind the inbound router seam: writes the media leg as the
 * real router does, takes the call in as connectable, and starts what `plan` says.
 */
function testRouter(r: PlivoRig, plan: () => Plan, calls: LiveCall[]): InboundCallRouter {
  return {
    async answer(arrival) {
      const inboundId = randomUUID();
      const p = plan();
      const { rows } = await pool().query<{ id: string }>(
        `INSERT INTO agency_calls (tenant_id, account_id, caller_id, destination_phone, provider, provider_call_id,
                                   telephony_credential_id, status, answered_at, recording_requested, origin, inbound_call_id)
         VALUES ($1, $2, $3, $4, 'plivo', $5, $6, 'in_progress', now(), $7, 'inbound', $8) RETURNING id`,
        [arrival.tenantId, ACCOUNT, arrival.toE164, arrival.fromE164 ?? '', arrival.carrierCallId, arrival.credentialId,
          p.kind === 'hold' && p.record, inboundId],
      );
      const legId = rows[0]!.id;
      const accepted = await r.bridge.acceptInboundCall({
        callId: legId, correlationId: inboundId, tenantId: arrival.tenantId, accountId: ACCOUNT, provider: 'plivo',
        telephonyCredentialId: arrival.credentialId, callerId: arrival.toE164, destinationPhone: arrival.fromE164 ?? '',
        carrierCallId: arrival.carrierCallId, takeSlots: true,
        connectable: true, browserCloseGraceMs: 8000, parkedSeconds: PARKED, record: p.kind === 'hold' && p.record,
      });
      if (!accepted.accepted) return { kind: 'fallback' };
      const live: LiveCall = { inboundId, legId, carrierCallId: arrival.carrierCallId, hold: null, recording: null };
      calls.push(live);
      live.hold = r.bridge.playInboundHold(inboundId, {
        preambleClipHashes: p.preamble, holdClipHash: p.kind === 'hold' ? p.hold : null,
      });
      return { kind: 'stream', callId: legId, streamUrl: accepted.streamUrl, maxDurationSeconds: accepted.maxDurationSeconds };
    },
    async ended(hangup) {
      return { legId: calls.find((c) => c.carrierCallId === hangup.carrierCallId)?.legId ?? null };
    },
  };
}

/** The tenant's credential linked for inbound (its answer and hangup URLs, the token). */
async function enableInbound(r: PlivoRig): Promise<void> {
  const minted = mintInboundToken();
  token = minted.token;
  const enabled = await telephonyCredentialRepository.enableInbound(r.credentialId, {
    appId: 'app-inbound-connect',
    answerUrl: plivoInboundAnswerUrl(BASE, r.credentialId),
    hangupUrl: plivoInboundStatusUrl(BASE, r.credentialId),
    fallbackAnswerUrl: plivoInboundFallbackUrl(BASE),
    tokenHash: minted.tokenHash,
  }, ADMIN);
  if (!enabled) throw new Error('enableInbound refused');
}

/** A customer rings; the carrier runs `steps`. */
function ring(r: PlivoRig, steps: PlivoCallStep[]): PlivoCall {
  return r.carrier.ringInbound({
    from: CALLER,
    to: PLIVO_NUMBER,
    answerUrl: withInboundToken(plivoInboundAnswerUrl(BASE, r.credentialId), token),
    hangupUrl: withInboundToken(plivoInboundStatusUrl(BASE, r.credentialId), token),
    script: { name: 'inbound-connect', steps },
  });
}

/** A loud second then a quiet one, as 20 ms frames. */
const SPEECH = [...Array(50).fill(true), ...Array(50).fill(false)] as boolean[];

async function legRow(id: string) {
  const { rows } = await pool().query<{ status: string; outcome: string | null; talk_time_seconds: number | null; duration_seconds: number | null; recording_url: string | null }>(
    'SELECT status, outcome, talk_time_seconds, duration_seconds, recording_url FROM agency_calls WHERE id = $1', [id]);
  return rows[0]!;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let calls: LiveCall[] = [];
let lifecycle: WebRtcLifecycleEvent[] = [];
let plan: Plan;

beforeAll(() => {
  expect(env).toEqual(PLIVO_E2E_ENV);
  initPlivoDb();
});
beforeEach(async () => {
  rig = await startPlivoRig();
  await pool().query(`INSERT INTO accounts (id, tenant_id, name, slug) VALUES ($1, $2, 'Main', 'main') ON CONFLICT (id) DO NOTHING`, [ACCOUNT, TENANT]);
  await enableInbound(rig);
  calls = [];
  lifecycle = [];
  rig.bridge.onLifecycle((e) => lifecycle.push(e));
  setInboundCallRouter(testRouter(rig, () => plan, calls));
});
afterEach(async () => {
  setInboundCallRouter(null);
  await rig?.carrier.settled();
  await rig?.stop();
  rig = null;
});
afterAll(closePlivoDb);

describe('a connectable inbound call through the bridge (P2)', () => {
  it('held (preamble once, then the hold), the agent bound: no hold frame after the bind, audio both ways, recorded from the bind through the Record API, talk time from the bind', async () => {
    const r = rig!;
    const greeting = clip(300);
    const hold = clip(200);
    plan = { kind: 'hold', record: true, preamble: [greeting.hash], hold: hold.hash };
    // A running campaign with no contacts: the agent's session, and nothing for pacing to dial.
    const campaign = await insertAgencyCampaign({
      tenant_id: TENANT, account_id: ACCOUNT, status: 'running', wrapup_seconds: 0,
      disposition_catalog: JSON.stringify([]), retry_policy: JSON.stringify(NO_RETRY),
      telephony_provider: 'plivo', telephony_credential_id: r.credentialId, caller_ids: [CALLER_ID],
    });
    const station = await joinAgent(r, campaign.id as string);

    const call = ring(r, [
      { do: 'answer' },
      { do: 'connect' },
      { do: 'start' },
      { do: 'mediaBackground', pattern: SPEECH },
      { do: 'waitFor', until: (c) => c.hungUpByApi, what: 'our REST hangup', timeoutMs: 30_000 },
    ]);
    const live = await waitFor('the call taken in', () => calls[0] ?? null);

    // The answer XML: our stream, its timeout the whole budget (parked + max duration); no <Record>:
    // a connectable call is recorded from the bind, never its hold.
    await waitFor('the stream open', () => call.opened);
    expect(call.answerXml).toContain(`streamTimeout="${PARKED + MAX}"`);
    expect(call.answerXml).not.toContain('<Record');

    // The preamble once, then the hold clip on a loop.
    await waitFor('two passes of the hold', () => call.playAudio.reduce((n, b) => n + b.length, 0) >= greeting.bytes + 2 * hold.bytes, 10_000);
    expect(r.carrier.requestsTo('record_call')).toHaveLength(0); // nothing recorded on hold
    expect(station.media).toHaveLength(0); // and the agent hears nothing of the caller yet
    await sleep(1000); // a second more on hold: none of it is talk time

    const ws = getAgencyRuntime()!.stations.socketFor(station.sessionId)!;
    expect(r.bridge.bindBorrowedBrowserLeg(live.inboundId, ws)).toBe(true);
    const framesAtBind = call.receivedFrameCount;
    const boundAt = Date.now();
    expect(await live.hold).toBe('released');
    expect(lifecycle.filter((e) => e.correlationId === live.inboundId).map((e) => e.phase)).toEqual(['answered', 'bridged']);

    // No hold frame after the bind: allow the frames already on the wire (sent before it), then none.
    await sleep(300);
    const settled = call.receivedFrameCount;
    expect(settled - framesAtBind).toBeLessThanOrEqual(2);
    await sleep(400);
    expect(call.receivedFrameCount).toBe(settled);

    // Audio both ways: the caller to the agent, the agent to the caller.
    await waitFor('the agent hears the caller', () => station.media.length >= 10);
    station.talk(5);
    await waitFor('the caller hears the agent', () => call.receivedFrameCount >= settled + 5);

    // Recorded from the bind: Plivo's Record API on the call, its callback to our recording route with a webhook token.
    await waitFor('the Record API request', () => r.carrier.requestsTo('record_call').length === 1 || null);
    const rec = r.carrier.requestsTo('record_call')[0]!;
    expect(rec).toMatchObject({ status: 202, authorized: true, path: `/v1/Account/${r.carrier.authId}/Call/${call.callUuid}/Record/` });
    expect(rec.body).toMatchObject({
      time_limit: MAX, file_format: 'mp3', callback_method: 'POST',
      callback_url: expect.stringMatching(new RegExp(`^https://agency\\.test/api/v1/webhooks/plivo/webrtc-recording/${live.legId}\\?token=[0-9a-f-]{36}$`)),
    });
    expect(call.apiRecordings).toHaveLength(1);

    await sleep(1200);
    expect(await r.bridge.forceEndWithOutcome(live.inboundId, 'agent_hangup')).toBe(true);
    await call.done;
    // The recording callback Plivo posts once the call ends is verified (token, signature) and lands on the leg.
    await waitFor('the recording callback', () => call.apiRecordings[0]!.posted);
    expect(call.apiRecordings[0]!.posted).toMatchObject({ status: 200 });
    const leg = await waitFor('the recording on the leg', async () => {
      const row = await legRow(live.legId);
      return row.recording_url ? row : null;
    });
    expect(leg.recording_url).toBe(`https://media.plivo.com/v1/Account/${r.carrier.authId}/Recording/${call.apiRecordings[0]!.recordingId}.mp3`);
    expect(leg).toMatchObject({ status: 'completed', outcome: 'agent_hangup' });
    // Talk time from the bind (about 1-2 s), never the hold before it (about 2 s more of duration).
    const talked = Math.round((Date.now() - boundAt) / 1000);
    expect(leg.talk_time_seconds!).toBeLessThanOrEqual(talked);
    expect(leg.duration_seconds! - leg.talk_time_seconds!).toBeGreaterThanOrEqual(1);
    expect(call.hungUpByApi).toBe(true);
    await station.close();
  });

  it('a caller who hangs up on hold: aborted, the call ended by its own path, nothing hung up by us', async () => {
    const r = rig!;
    plan = { kind: 'hold', record: false, preamble: [], hold: null };
    const call = ring(r, [
      { do: 'answer' },
      { do: 'connect' },
      { do: 'start' },
      { do: 'waitFor', until: (c) => c.receivedFrameCount >= 20, what: 'the built-in hold tone' },
      { do: 'hangup', status: 'completed', source: 'Caller' },
      { do: 'close' },
    ]);
    const live = await waitFor('the call taken in', () => calls[0] ?? null);
    expect(await live.hold).toBe('aborted');
    await call.done;
    const leg = await waitFor('the leg ended', async () => {
      const row = await legRow(live.legId);
      return row.status === 'completed' ? row : null;
    });
    expect(leg.talk_time_seconds).toBe(0); // nobody was put through
    expect(call.hungUpByApi).toBe(false);
    expect(r.carrier.requestsTo('hangup_call')).toHaveLength(0);
  });

  it('a voicemail: the hold stopped, the prompt and the beep, then the caller recorded with nobody bound; a silence (paused media) is ended by the wall clock', async () => {
    const r = rig!;
    const greeting = clip(200);
    const prompt = clip(300);
    plan = { kind: 'voicemail', preamble: [greeting.hash], prompt: [prompt.hash], maxSeconds: 2 };
    let pause = false;
    const call = ring(r, [
      { do: 'answer' },
      { do: 'connect' },
      { do: 'start' },
      // 100 ms loud, 100 ms quiet: whatever stretch is recorded has the caller's voice in it.
      { do: 'mediaBackground', pattern: [...Array(5).fill(true), ...Array(5).fill(false)] as boolean[] },
      { do: 'waitFor', until: () => pause, what: 'the test to pause the caller' },
      { do: 'pauseMedia' },
      { do: 'waitFor', until: (c) => c.hungUpByApi, what: 'our REST hangup', timeoutMs: 30_000 },
    ]);
    const live = await waitFor('the call taken in', () => calls[0] ?? null);
    await waitFor('the greeting played', () => call.playAudio.reduce((n, b) => n + b.length, 0) >= greeting.bytes);

    // The connector's voicemail path: the recording stops the hold itself.
    const framesBefore = call.receivedFrameCount;
    live.recording = r.bridge.recordInboundAudio(live.inboundId, { maxSeconds: plan.maxSeconds, promptClipHashes: [prompt.hash], beep: true });
    expect(await live.hold).toBe('released');
    // The prompt (300 ms) and the beep (500 ms with its lead-in): 40 frames, then the recording.
    await waitFor('the prompt and beep played', () => call.receivedFrameCount >= framesBefore + 40);
    await sleep(700); // ~0.7 s of the caller's speech recorded
    pause = true; // then a silence: the carrier sends nothing
    const startedAt = Date.now();
    const recording = await live.recording;
    expect(recording.result).toBe('completed');
    expect(recording.sampleRate).toBe(16_000);
    // Less than the 2 s maximum (the carrier went quiet), but more than nothing.
    expect(recording.seconds).toBeGreaterThan(0.3);
    expect(recording.seconds).toBeLessThan(1.9);
    expect(Date.now() - startedAt).toBeLessThan(2500);
    // The caller's loud frames came through as audio.
    const peak = Math.max(...Array.from({ length: recording.pcm16.length / 2 }, (_, i) => Math.abs(recording.pcm16.readInt16LE(i * 2))));
    expect(peak).toBeGreaterThan(1000);
    // Nothing more was played to the caller after the beep: the recording never plays.
    const afterBeep = call.receivedFrameCount;
    await sleep(200);
    expect(call.receivedFrameCount).toBe(afterBeep);
    // Never hung up by the recording: the caller is still on until the connector ends it.
    expect(call.hungUpByApi).toBe(false);
    await r.bridge.forceEndWithOutcome(live.inboundId, 'inbound_voicemail');
    await call.done;
    expect((await legRow(live.legId)).outcome).toBe('inbound_voicemail');
  });
});
