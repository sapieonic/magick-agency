import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Inbound P2, the last runtime pieces end to end (docs/inbound.md §5.4, §7): the in-flight clash
 * and voicemail, on the mock Plivo carrier through the real server.
 *
 *  1. The clash: pacing dials X and the carrier holds it ringing; X rings in. The dial is
 *     cancelled by its request id, the attempt ends `canceled` with the system code
 *     `inbound_call`, the contact is back `pending` with nothing charged, the agent is told why
 *     (`released`, `inbound_call`) and is put through to the customer's call, never `available`
 *     in between, held through the caller's greeting; pacing does not dial X while they talk.
 *  2. The bridged-first race: the dial to X answered before X rings in: nothing is cancelled and
 *     the caller queues normally (another agent takes them).
 *  3. Voicemail after hours: the closed route's prompt and beep, the caller's audio recorded from
 *     our stream into a WAV in the bucket, the Missed row (`closed`) with the voicemail, played
 *     back through `GET /proxy/agency/inbound/missed/:id/voicemail` (a range too).
 *  4. Voicemail from the queue (over `max_waiting`): the overflow's voicemail (`overflow`).
 *  5. A caller who hangs up at the beep: no voicemail, the ordinary Missed row.
 *
 * Real: Postgres, this lane's Redis, the app on loopback, the voice and agency bootstraps, the
 * bridge and `PlivoAdapter`. Faked: Firebase (a test token) and the bucket (in memory).
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

const bucket = vi.hoisted(() => ({ files: new Map<string, Buffer>() }));
const fb = vi.hoisted(() => ({ verifyIdToken: vi.fn() }));
vi.mock('../../../src/auth/firebase.js', () => ({ initFirebase: vi.fn(), verifyIdToken: fb.verifyIdToken }));
vi.mock('../../../src/storage/s3.js', async (orig) => {
  const actual = await orig<typeof import('../../../src/storage/s3.js')>();
  const { Readable } = await import('node:stream');
  return {
    ...actual,
    isStorageConfigured: () => true,
    uploadFile: async (key: string, body: Buffer) => { bucket.files.set(key, Buffer.from(body)); },
    deleteFile: async (key: string) => { bucket.files.delete(key); },
    getFileStream: async (key: string, opts: { range?: string } = {}) => {
      const file = bucket.files.get(key);
      if (!file) throw Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey', $metadata: { httpStatusCode: 404 } });
      const m = opts.range ? /^bytes=(\d+)-(\d*)$/.exec(opts.range) : null;
      if (!m) return { body: Readable.from([file]), contentLength: file.length, contentType: 'audio/wav' };
      const start = Number(m[1]);
      const end = m[2] ? Math.min(Number(m[2]), file.length - 1) : file.length - 1;
      const part = file.subarray(start, end + 1);
      return { body: Readable.from([part]), contentLength: part.length, contentRange: `bytes ${start}-${end}/${file.length}`, contentType: 'audio/wav' };
    },
  };
});

import { randomUUID } from 'node:crypto';
import { getTestPool } from '../../../../../packages/db/test/helpers/test-db.js';
import { getAgencyRuntime } from '../../../src/bootstrap/agency.js';
import { agencyInboundCallRepository } from '../../../src/db/repositories/agency.repository.js';
import { INBOUND_VOICEMAIL_BUDGET_SECONDS } from '../../../src/agency/inbound/inbound-call-router.js';
import {
  ACCOUNT, PLIVO_E2E_ENV, TENANT, callRow, closePlivoDb, initPlivoDb, startPlivoRig, waitFor, type PlivoRig,
} from './plivo-rig.js';
import {
  CALLER, SPEECH, busyAgent, callerScript, callers, campaign, clip, contact, framesOf, inboundCalls, joinAgent, liveOf, ring,
  setRoute, spineWhen, startInboundWorld, stateFrames, type InboundWorld,
} from './inbound-connect-rig.js';
import type { PlivoCallStep } from '../../mocks/plivo/index.js';

const pool = () => getTestPool();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let rig: PlivoRig | null = null;
let world: InboundWorld;

beforeAll(() => {
  expect(env).toEqual(PLIVO_E2E_ENV);
  initPlivoDb();
  fb.verifyIdToken.mockImplementation(async (token: string) => {
    if (!token.startsWith('tok:')) throw new Error('bad token');
    const uid = token.slice(4);
    return { uid, email: `${uid}@example.test`, email_verified: true };
  });
});
beforeEach(async () => {
  callers.hangUpAll = false;
  bucket.files.clear();
  rig = await startPlivoRig();
  world = await startInboundWorld(rig);
});
afterEach(async () => {
  callers.hangUpAll = true;
  await world?.fleet.closeAll();
  await rig?.carrier.settled();
  await getAgencyRuntime()?.inbound?.drain();
  await rig?.stop();
  rig = null;
});
afterAll(closePlivoDb);

async function attemptsTo(contactId: string) {
  const { rows } = await pool().query<{ id: string; state: string; outcome: string | null; disposition_code: string | null; dispositioned_by_user_id: string | null; webrtc_call_id: string | null }>(
    'SELECT id, state, outcome, disposition_code, dispositioned_by_user_id, webrtc_call_id FROM agency_call_attempts WHERE contact_id = $1 ORDER BY created_at', [contactId]);
  return rows;
}
async function contactRow(id: string) {
  const { rows } = await pool().query<{ state: string; attempt_count: number; our_fault_attempts: number }>(
    'SELECT state, attempt_count, our_fault_attempts FROM agency_contacts WHERE id = $1', [id]);
  return rows[0]!;
}

/** The whole route's clips, the greeting replaced (a long one keeps the caller in the preamble). */
async function withGreeting(ms: number): Promise<void> {
  const greeting = await clip(ms, 330);
  const c = world.clips;
  await setRoute(world, {
    clips: { greeting: greeting.id, hold: c.hold.id, callback: c.callback.id, recording_notice: c.notice.id, closed: c.closed.id, busy: c.busy.id },
  });
}

describe('the in-flight clash (§5.4): a customer ringing while we dial them', () => {
  it('pacing dials X and it rings; X rings in: the dial is cancelled, the attempt canceled / inbound_call, the contact pending uncharged, the same agent gets the call (held through the greeting, never available)', async () => {
    rig!.carrier.setScript(() => ({
      name: 'ringing until cancelled',
      steps: [{ do: 'ring' }, { do: 'waitFor', until: (c) => c.canceledByApi, what: 'our cancel', timeoutMs: 30_000 }],
    }));
    await withGreeting(2500);
    const campaignId = await campaign(world);
    const contactId = await contact(campaignId, { next_attempt_at: new Date(Date.now() - 1000) });
    const before = await contactRow(contactId);
    const agent = await joinAgent(world, campaignId);
    const attempt = await waitFor('the dial to X ringing', async () => {
      const a = (await attemptsTo(contactId))[0];
      return a?.webrtc_call_id && (await callRow(a.webrtc_call_id))?.status === 'ringing' ? a : null;
    });
    const dial = rig!.carrier.callOrder.find((c) => c.request.to === CALLER)!;

    let hangUp = false;
    const call = ring(world, callerScript(() => hangUp));
    // Held through the greeting: reserved for this call while the spine is still greeting.
    const greeting = await spineWhen(call, 'answered, greeting', (r) => r.state === 'greeting');
    await waitFor('held for the call', async () => (await liveOf(agent.sessionId))?.inboundCallId === greeting.id);
    expect((await spineOf(greeting.id)).state).toBe('greeting');
    expect(await liveOf(agent.sessionId)).toMatchObject({ state: 'reserved', inboundCallId: greeting.id });

    // The dial: cancelled by its request id; the attempt the clash's, the contact uncharged.
    expect(rig!.carrier.requestsTo('cancel_request').map((q) => [q.id, q.status])).toEqual([[dial.requestUuid, 204]]);
    expect((await attemptsTo(contactId))[0]).toMatchObject({
      id: attempt.id, state: 'ended', outcome: 'canceled', disposition_code: 'inbound_call', dispositioned_by_user_id: null,
    });
    const after = await contactRow(contactId);
    expect(after).toMatchObject({ state: 'pending', attempt_count: before.attempt_count, our_fault_attempts: before.our_fault_attempts });

    // Put through once the greeting has played; the same agent.
    const connected = await spineWhen(call, 'connected', (r) => r.state === 'connected', 20_000);
    expect(connected).toMatchObject({ session_id: agent.sessionId, answered_by_user_id: agent.agentUserId });
    await waitFor('clash recorded', async () => (await spineOf(connected.id)).clash_attempt_id === attempt.id);
    // The row is written before the frame is sent (`onBridged`): wait for the frame, as the
    // other inbound files do, or a busy machine reads the frames in between.
    await waitFor('the connected frame', () => inboundCalls(agent).some((c) => c['state'] === 'connected'));
    // What the agent saw: the dial's panel released with the reason, then the caller's panel. Never `available`.
    const events = agent.allFrames().map((f) => f.frame?.['event']).filter((e) => e === 'released' || e === 'inbound_call');
    expect(events[0]).toBe('released');
    expect(framesOf(agent, 'released')).toEqual([expect.objectContaining({ attempt_id: attempt.id, reason: 'inbound_call', requires_disposition: false })]);
    expect(inboundCalls(agent).map((c) => c['state'])).toEqual(['offered', 'connected']);
    expect(stateFrames(agent)).not.toContain('available');

    // While the customer is on the line pacing does not dial them again (the busy probe).
    await sleep(1500);
    expect(await attemptsTo(contactId)).toHaveLength(1);
    hangUp = true;
    await spineWhen(call, 'ended', (r) => r.state === 'ended');
    await call.done;
  });

  it('the bridged-first race: the dial to X was answered before X rang in: nothing is cancelled, the caller queues and another agent takes them', async () => {
    let dialDone = false;
    rig!.carrier.setScript(() => ({
      name: 'answered',
      steps: [
        { do: 'ring' }, { do: 'answer' }, { do: 'connect' }, { do: 'start' }, { do: 'mediaBackground', pattern: SPEECH },
        { do: 'waitFor', until: (c) => dialDone || c.hungUpByApi || callers.hangUpAll, what: 'the test', timeoutMs: 60_000 },
        { do: 'hangup', status: 'completed', source: 'Callee' }, { do: 'close' },
      ],
    }));
    // The dialling agent is the caller's sticky agent (last connected) and busy on the call: with
    // sticky routing off the team takes the caller at once (with it on, after the sticky wait).
    await setRoute(world, { sticky_mode: 'off' });
    const campaignId = await campaign(world);
    const contactId = await contact(campaignId, { next_attempt_at: new Date(Date.now() - 1000) });
    const dialler = await joinAgent(world, campaignId);
    await waitFor('the dial to X bridged', async () => (await liveOf(dialler.sessionId))?.state === 'on_call', 10_000,
      async () => JSON.stringify({ live: await liveOf(dialler.sessionId), attempts: await attemptsTo(contactId) }));
    const other = await joinAgent(world, campaignId);

    let hangUp = false;
    const call = ring(world, callerScript(() => hangUp));
    const connected = await spineWhen(call, 'connected to the other agent', (r) => r.state === 'connected');
    expect(connected.session_id).toBe(other.sessionId);
    expect(connected.clash_attempt_id).toBeNull();
    expect(rig!.carrier.requestsTo('cancel_request')).toEqual([]);
    expect((await attemptsTo(contactId))[0]).toMatchObject({ state: 'bridged', disposition_code: null });
    expect(framesOf(dialler, 'released')).toEqual([]);
    hangUp = true;
    dialDone = true;
    await spineWhen(call, 'ended', (r) => r.state === 'ended');
  });
});

describe('voicemail (§7, IB3, IQ14)', () => {
  /** Answer, stream the caller's voice, hang up when `until` holds. */
  const speaker = (until: () => boolean): PlivoCallStep[] => [
    { do: 'answer' }, { do: 'connect' }, { do: 'start' }, { do: 'mediaBackground', pattern: SPEECH },
    { do: 'waitFor', until: (c) => until() || c.hungUpByApi || callers.hangUpAll, what: 'the caller to finish', timeoutMs: 60_000 },
    { do: 'hangup', status: 'completed', source: 'Caller' }, { do: 'close' },
  ];

  it('after hours: the closed message and the beep, the caller recorded from our stream into a WAV, a Missed row `closed` with it, played back through the route (and a range)', async () => {
    await setRoute(world, { weekly_hours: [], after_hours_action: 'voicemail' });
    const supervisor = await supervisorUser();
    let done = false;
    const call = ring(world, speaker(() => done));
    await spineWhen(call, 'answered', (r) => r.state === 'greeting' || r.state === 'arrived');
    // The prompt (greeting 0.2 s + closed 0.2 s), the beep (0.5 s), then about 3 s of the caller.
    await waitFor('the beep and the recording', () => call.receivedFrameCount >= 30);
    await sleep(3500);
    done = true;
    const ended = await spineWhen(call, 'ended with the voicemail', (r) => r.state === 'ended');
    await call.done;
    expect(ended).toMatchObject({ outcome: 'voicemail', follow_up_status: 'open', follow_up_reason: 'closed' });
    expect(ended.voicemail_key).toBe(`inbound-voicemail/${TENANT}/${ACCOUNT}/${ended.id}.wav`);
    expect(ended.voicemail_seconds).toBeGreaterThanOrEqual(2);
    expect(ended.voicemail_seconds).toBeLessThanOrEqual(6);
    const wav = bucket.files.get(ended.voicemail_key!)!;
    expect(wav.subarray(0, 4).toString()).toBe('RIFF');
    expect(wav.readUInt32LE(24)).toBe(16_000);
    expect(Math.round((wav.length - 44) / 32_000)).toBe(ended.voicemail_seconds);
    // The caller's voice is in it: loud and quiet stretches, as they spoke.
    const peaks = rmsPerSecond(wav.subarray(44));
    expect(Math.max(...peaks)).toBeGreaterThan(1000);

    // The Missed list (the public route, as the console reads it).
    const list = await rig!.app.inject({ method: 'GET', url: '/proxy/agency/inbound/missed', headers: authHeaders(supervisor) });
    expect(list.statusCode, list.body).toBe(200);
    const missed = (list.json() as { rows: Array<Record<string, unknown>> }).rows.find((r) => r['id'] === ended.id)!;
    expect(missed).toMatchObject({ reason: 'closed', outcome: 'voicemail', has_voicemail: true, voicemail_url: `/inbound/missed/${ended.id}/voicemail` });

    // Played back through the route the row names, whole and by range.
    const url = `/proxy/agency${missed['voicemail_url'] as string}`;
    const whole = await rig!.app.inject({ method: 'GET', url, headers: authHeaders(supervisor) });
    expect(whole.statusCode).toBe(200);
    expect(whole.headers['content-type']).toBe('audio/wav');
    expect(whole.headers['accept-ranges']).toBe('bytes');
    expect(Buffer.compare(whole.rawPayload, wav)).toBe(0);
    const part = await rig!.app.inject({ method: 'GET', url, headers: { ...authHeaders(supervisor), range: 'bytes=0-43' } });
    expect(part.statusCode).toBe(206);
    expect(part.headers['content-range']).toBe(`bytes 0-43/${wav.length}`);
    expect(part.rawPayload.subarray(0, 4).toString()).toBe('RIFF');
  });

  it('from the queue (over max_waiting): the overflow voicemail, a Missed row `overflow` with it', async () => {
    await setRoute(world, { max_waiting: 0, overflow_action: 'voicemail' });
    // Someone who could take the caller once their call ends: the caller queues (with nobody at
    // all, the router answers with the voicemail at once, before any queue: PM-M6 / SWE-N4).
    await busyAgent(world, await campaign(world));
    let done = false;
    const call = ring(world, speaker(() => done));
    await spineWhen(call, 'queued', (r) => r.state === 'queued' || r.state === 'ended');
    await waitFor('the beep and the recording', () => call.receivedFrameCount >= 40);
    await sleep(2500);
    done = true;
    const ended = await spineWhen(call, 'ended with the voicemail', (r) => r.state === 'ended');
    expect(ended).toMatchObject({ outcome: 'voicemail', follow_up_reason: 'overflow' });
    expect(ended.voicemail_seconds).toBeGreaterThanOrEqual(1);
    expect(bucket.files.has(ended.voicemail_key!)).toBe(true);
  });

  it('a caller who leaves at the beep leaves no voicemail: the ordinary Missed row of the action (`closed`)', async () => {
    await setRoute(world, { weekly_hours: [], after_hours_action: 'voicemail' });
    let done = false;
    const call = ring(world, [
      { do: 'answer' }, { do: 'connect' }, { do: 'start' },
      { do: 'waitFor', until: (c) => done || c.hungUpByApi, what: 'the beep', timeoutMs: 30_000 },
      { do: 'hangup', status: 'completed', source: 'Caller' }, { do: 'close' },
    ]);
    await spineWhen(call, 'answered', (r) => r.state === 'greeting' || r.state === 'arrived');
    await waitFor('the prompt and the beep', () => call.receivedFrameCount >= 40);
    done = true;
    const ended = await spineWhen(call, 'ended', (r) => r.state === 'ended');
    expect(ended).toMatchObject({ outcome: 'closed', follow_up_reason: 'closed', voicemail_key: null, voicemail_seconds: null });
    expect(bucket.files.size).toBe(0);
  });

  it('a voicemail is budgeted its prompt and whole recording whatever the account`s ceiling; one whose row cannot be written is discarded, never left for nothing to name', async () => {
    await setRoute(world, { weekly_hours: [], after_hours_action: 'voicemail' });
    const accept = vi.spyOn(rig!.bridge, 'acceptInboundCall');
    const end = vi.spyOn(agencyInboundCallRepository, 'end').mockRejectedValueOnce(new Error('Connection terminated unexpectedly'));
    try {
      let done = false;
      const call = ring(world, speaker(() => done));
      await spineWhen(call, 'answered', (r) => r.state === 'greeting' || r.state === 'arrived');
      expect(accept.mock.calls[0]![0]).toMatchObject({ connectable: false, parkedSeconds: INBOUND_VOICEMAIL_BUDGET_SECONDS });
      await waitFor('the beep and the recording', () => call.receivedFrameCount >= 30);
      await sleep(2500);
      done = true;
      await call.done;
      // The recording was stored, then the row's write failed: the object is deleted again.
      await waitFor('the settle attempted', () => end.mock.calls.length > 0);
      await getAgencyRuntime()?.inbound?.drain();
      await waitFor('the orphan discarded', () => bucket.files.size === 0);
    } finally {
      accept.mockRestore();
      end.mockRestore();
    }
  });
});

// ─── helpers ──────────────────────────────────────────────────────────────────

async function spineOf(id: string) {
  const { rows } = await pool().query('SELECT * FROM agency_inbound_calls WHERE id = $1', [id]);
  return rows[0] as { state: string; clash_attempt_id: string | null };
}

/** A supervisor of the account (an account admin) the faked Firebase signs in. */
async function supervisorUser(): Promise<string> {
  const id = randomUUID();
  const uid = `fb-sup-${id.slice(0, 8)}`;
  await pool().query('INSERT INTO users (id, firebase_uid, email) VALUES ($1, $2, $3)', [id, uid, `${uid}@example.test`]);
  await pool().query(`INSERT INTO memberships (user_id, tenant_id, account_id, role) VALUES ($1, $2, $3, 'account_admin')`, [id, TENANT, ACCOUNT]);
  return uid;
}

function authHeaders(uid: string): Record<string, string> {
  return { authorization: `Bearer tok:${uid}`, 'x-tenant-id': TENANT, 'x-account-id': ACCOUNT };
}

/** RMS of each second of PCM16 16 kHz audio. */
function rmsPerSecond(pcm: Buffer): number[] {
  const out: number[] = [];
  for (let s = 0; s + 32_000 <= pcm.length; s += 32_000) {
    let e = 0;
    for (let i = s; i < s + 32_000; i += 2) e += pcm.readInt16LE(i) ** 2;
    out.push(Math.sqrt(e / 16_000));
  }
  return out;
}
