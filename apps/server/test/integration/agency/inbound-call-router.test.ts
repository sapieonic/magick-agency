import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closePool, initDbPool } from '@magick-agency/db';
import { TEST_DB_URL } from '../../../../../packages/db/test/helpers/test-db.js';
import { getTestPool, truncateAll } from '../setup/test-utils.js';
import { DEFAULTS, OTHER_ACCOUNT, OTHER_TENANT, insertTenant } from '../setup/factories.js';
import { writeTtsFile } from '../../../src/tts/tts-file-cache.js';
import { parseInboundRouteCreate } from '../../../src/agency/inbound/route-config.js';
import { AgencyInboundCallRouter } from '../../../src/agency/inbound/inbound-call-router.js';
import { standardClipHash } from '../../../src/agency/inbound/inbound-standard-clips.js';
import {
  agencyAttemptRepository,
  agencyInboundCallRepository,
  agencyInboundRouteRepository,
  type AgencyInboundCallRecord,
} from '../../../src/db/repositories/agency.repository.js';
import type { InboundCallArrival } from '../../../src/seams/inbound-call-router.js';
import type { WebRtcInboundAcceptance } from '../../../src/core/webrtc-bridge-manager.js';

/**
 * The agency side of an inbound call on real Postgres (docs/inbound.md §3.4, §7), with the bridge
 * faked (what it was asked to do is the assertion; the end-to-end suite drives the real one):
 *
 *  - tenant isolation (M1): an answer on tenant X's credential naming tenant Y's live `CallUUID`
 *    is hung up and writes and changes nothing, whether X's number is linked (the answer path) or
 *    not (the refusal path);
 *  - a route slot with no recording is never silence: the plan's message is spoken by the carrier
 *    and the call is ended at once with its Missed row and callback, no stream taken; a withheld
 *    caller is never promised a callback;
 *  - an answer past its budget (the webhook's abort signal): nothing written before, `failed` with
 *    no follow-up after, whoever ends it;
 *  - a caller the bridge's shared scopes turn away is not admitted (`arrived`), so neither the
 *    route nor the account's live total holds it, and with no busy recording hears our standard one;
 *  - a DNC caller is never promised a callback, spoken or played (the closed words);
 *  - the queue's exits (`overflow`) and the connector's preamble (`clips`): a slot with no
 *    recording plays our standard recording (please hold, the notice, call-back, closed, the
 *    voicemail prompt), never silence.
 *
 * Mutation-checked: dropping the tenant/credential comparison from `insertArrival`'s conflict
 * branch makes the isolation tests hand X Y's row (and end it on the refusal path); removing the
 * `routeClipId` check in `decide` streams a clip-less route; making `settle` ignore `givenUp`
 * writes a Missed row for a caller who heard the fallback; dropping `refuseAdmission` leaves a
 * bridge-refused caller in the account's live total.
 */

const X = DEFAULTS.tenantId;
const XA = DEFAULTS.accountId;
const Y = OTHER_TENANT;
const YA = OTHER_ACCOUNT;
const pool = () => getTestPool();

let plivoId: string;
let credX: string;
let credY: string;
let seq = 0;

/** A number on `cred`, assigned to `tenant`, linked to inbound unless `linked: false`. */
async function number(tenant: string, cred: string, o: { linked?: boolean } = {}): Promise<{ id: string; e164: string }> {
  const e164 = `+1415555${String(1000 + ++seq).padStart(4, '0')}`;
  const { rows } = await pool().query<{ id: string }>(
    `INSERT INTO phone_numbers (phone_number, provider_id, telephony_credential_id, status, inbound_linked_at)
     VALUES ($1, $2, $3, 'active', $4) RETURNING id`,
    [e164, plivoId, cred, o.linked === false ? null : new Date()]);
  await pool().query('INSERT INTO tenant_phone_assignments (tenant_id, phone_number_id) VALUES ($1, $2)', [tenant, rows[0]!.id]);
  return { id: rows[0]!.id, e164 };
}

/** A clip on this replica's cache with its audio_files row in `account`: its id and hash. */
async function clip(tenant: string, account: string): Promise<{ id: string; hash: string }> {
  const hash = randomBytes(20).toString('hex');
  writeTtsFile(hash, Buffer.alloc(1600), 8000, 1);
  const { rows } = await pool().query<{ id: string }>(
    `INSERT INTO audio_files (tenant_id, account_id, name, slug, original_filename, content_type, size_bytes, s3_key,
                              pcm_audio_hash, pcm_sample_rate, pcm_channels)
     VALUES ($1, $2, $3, $3, 'clip.wav', 'audio/wav', 1, $4, $5, 8000, 1) RETURNING id`,
    [tenant, account, `clip-${hash.slice(0, 8)}`, `audio/${hash}.wav`, hash]);
  return { id: rows[0]!.id, hash };
}

const ALWAYS = [1, 2, 3, 4, 5, 6, 7].map((day) => ({ day, start: '00:00', end: '24:00' }));

/** A route of `account` answering `numberId`, open always unless `hours` say otherwise. */
async function route(tenant: string, account: string, numberId: string, o: Record<string, unknown> = {}): Promise<string> {
  const parsed = parseInboundRouteCreate({ name: `Route ${++seq}`, timezone: 'UTC', weekly_hours: ALWAYS, ...o });
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues));
  const created = await agencyInboundRouteRepository.create({ tenantId: tenant, accountId: account, createdBy: null, config: parsed.config });
  if (!created.ok) throw new Error(created.reason);
  const attached = await agencyInboundRouteRepository.attachNumber({ tenantId: tenant, accountId: account, routeId: created.route.id, phoneNumberId: numberId, attachedBy: null });
  if (!attached.ok) throw new Error(attached.reason);
  return created.route.id;
}

const ADMITTED: WebRtcInboundAcceptance = { accepted: true, streamUrl: 'wss://agency.test/stream', maxDurationSeconds: 1800, capacity: 'admitted' };

function harness() {
  const bridge = {
    acceptInboundCall: vi.fn(async (): Promise<WebRtcInboundAcceptance> => ADMITTED),
    playClipSequenceThenHangUp: vi.fn(async () => 'completed' as const),
  };
  const router = new AgencyInboundCallRouter({
    bridge: bridge as never,
    dnc: { check: async () => 'clear', checkEntry: async () => ({ result: 'clear' }) } as never,
  });
  return { bridge, router };
}

const arrival = (tenantId: string, credentialId: string, toE164: string, o: Partial<InboundCallArrival> = {}): InboundCallArrival => ({
  credentialId, tenantId, provider: 'plivo', credentialStatus: 'active',
  carrierCallId: `CA-${randomUUID()}`, fromE164: '+447700900123', toE164, ...o,
});

async function spine(carrierCallId: string): Promise<AgencyInboundCallRecord[]> {
  const { rows } = await pool().query<AgencyInboundCallRecord>(
    'SELECT * FROM agency_inbound_calls WHERE provider_call_id = $1', [carrierCallId]);
  return rows;
}

async function legOf(row: AgencyInboundCallRecord) {
  const { rows } = await pool().query<{ status: string; outcome: string | null; error_code: string | null; ended_at: Date | null }>(
    'SELECT status, outcome, error_code, ended_at FROM agency_calls WHERE id = $1', [row.webrtc_call_id]);
  return rows[0]!;
}

beforeAll(() => {
  initDbPool({ url: TEST_DB_URL, poolMin: 0, poolMax: 6 });
});

beforeEach(async () => {
  await truncateAll();
  const { rows } = await pool().query<{ id: string }>(
    `INSERT INTO telephony_providers (name, display_name) VALUES ('plivo', 'Plivo') RETURNING id`);
  plivoId = rows[0]!.id;
  await insertTenant({ id: X });
  await insertTenant({ id: Y });
  for (const [id, tenant] of [[XA, X], [YA, Y]] as const) {
    await pool().query(`INSERT INTO accounts (id, tenant_id, name, slug) VALUES ($1, $2, 'Acct', $3)`, [id, tenant, `a-${randomUUID()}`]);
  }
  const cred = async (tenant: string, ref: string) => (await pool().query<{ id: string }>(
    `INSERT INTO telephony_credentials (tenant_id, provider, label, account_ref) VALUES ($1, 'plivo', 'Main', $2) RETURNING id`,
    [tenant, ref])).rows[0]!.id;
  credX = await cred(X, 'MAXXXXXXXXXXXXXXXXXX');
  credY = await cred(Y, 'MAYYYYYYYYYYYYYYYYYY');
});

afterAll(async () => {
  // 0024's Down refuses while inbound calls exist: leave none for the down → up suites.
  await truncateAll();
  await closePool();
});

describe('tenant isolation: a carrier call id another tenant holds (M1)', () => {
  /** Tenant Y's call, live and playing its message on Y's route. */
  async function ysLiveCall() {
    const yNumber = await number(Y, credY);
    await route(Y, YA, yNumber.id, { clips: { callback: (await clip(Y, YA)).id } });
    const { bridge, router } = harness();
    // Y's caller is still hearing the message: the sequence never ends here.
    bridge.playClipSequenceThenHangUp.mockImplementation(() => new Promise(() => undefined));
    const a = arrival(Y, credY, yNumber.e164);
    expect(await router.answer(a)).toMatchObject({ kind: 'stream' });
    const [row] = await spine(a.carrierCallId);
    expect(row).toMatchObject({ tenant_id: Y, state: 'greeting' });
    return { carrierCallId: a.carrierCallId, row: row! };
  }

  it('(a) an answer on X\'s credential to X\'s linked number, naming Y\'s live CallUUID: hung up, nothing written, Y untouched', async () => {
    const y = await ysLiveCall();
    const xNumber = await number(X, credX);
    await route(X, XA, xNumber.id, { clips: { callback: (await clip(X, XA)).id } });
    const { bridge, router } = harness();

    expect(await router.answer(arrival(X, credX, xNumber.e164, { carrierCallId: y.carrierCallId }))).toEqual({ kind: 'hangup' });
    expect(bridge.acceptInboundCall).not.toHaveBeenCalled();
    expect(bridge.playClipSequenceThenHangUp).not.toHaveBeenCalled();
    expect(await spine(y.carrierCallId)).toEqual([y.row]);
    const legs = await pool().query('SELECT tenant_id FROM agency_calls WHERE provider_call_id = $1', [y.carrierCallId]);
    expect(legs.rows).toEqual([{ tenant_id: Y }]);
  });

  it('(a) the tenant default (no account) on X naming Y\'s CallUUID: hung up, no Missed row written for X, Y untouched', async () => {
    const y = await ysLiveCall();
    const xNumber = await number(X, credX);
    const { router } = harness();
    expect(await router.answer(arrival(X, credX, xNumber.e164, { carrierCallId: y.carrierCallId }))).toEqual({ kind: 'hangup' });
    expect(await spine(y.carrierCallId)).toEqual([y.row]);
  });

  it('(b) an answer on X\'s credential to a number X has not linked, naming Y\'s live CallUUID: hung up, Y\'s call is not ended', async () => {
    const y = await ysLiveCall();
    const xUnlinked = await number(X, credX, { linked: false });
    const { router } = harness();
    expect(await router.answer(arrival(X, credX, xUnlinked.e164, { carrierCallId: y.carrierCallId }))).toEqual({ kind: 'hangup' });
    expect(await spine(y.carrierCallId)).toEqual([y.row]);
  });

  it('the same refusal on another credential of the same tenant', async () => {
    const y = await ysLiveCall();
    const credY2 = (await pool().query<{ id: string }>(
      `INSERT INTO telephony_credentials (tenant_id, provider, label, account_ref) VALUES ($1, 'plivo', 'Second', 'MAZZZZZZZZZZZZZZZZZZ') RETURNING id`, [Y])).rows[0]!.id;
    const other = await number(Y, credY2, { linked: false });
    const { router } = harness();
    expect(await router.answer(arrival(Y, credY2, other.e164, { carrierCallId: y.carrierCallId }))).toEqual({ kind: 'hangup' });
    expect(await spine(y.carrierCallId)).toEqual([y.row]);
  });
});

describe('a message with no recording is spoken, never silence', () => {
  it('open route, no callback recording: "we\'ll call you back" spoken; ended overflow at once with its Missed row; no stream', async () => {
    const n = await number(X, credX);
    await route(X, XA, n.id, { clips: { greeting: (await clip(X, XA)).id } });
    const { bridge, router } = harness();
    const a = arrival(X, credX, n.e164);
    expect(await router.answer(a)).toEqual({ kind: 'spoken', message: 'callback' });
    expect(bridge.acceptInboundCall).not.toHaveBeenCalled();
    const [row] = await spine(a.carrierCallId);
    expect(row).toMatchObject({ state: 'ended', outcome: 'overflow', follow_up_status: 'open', follow_up_reason: 'overflow' });
    expect(await legOf(row!)).toMatchObject({ status: 'completed', outcome: 'inbound_overflow' });
    expect((await legOf(row!)).ended_at).toBeInstanceOf(Date);
    expect(await agencyAttemptRepository.countLiveForAccount(X, XA)).toBe(0);
    // Its hangup later finds it ended: nothing more.
    expect(await router.ended({ credentialId: credX, tenantId: X, provider: 'plivo', carrierCallId: a.carrierCallId, callStatus: 'completed', hangupSource: 'Caller' }))
      .toEqual({ legId: row!.webrtc_call_id });
    expect((await spine(a.carrierCallId))[0]).toEqual(row);
  });

  it('a withheld caller is never promised a callback: the closed words', async () => {
    const n = await number(X, credX);
    await route(X, XA, n.id);
    const { router } = harness();
    const a = arrival(X, credX, n.e164, { fromE164: null });
    expect(await router.answer(a)).toEqual({ kind: 'spoken', message: 'closed' });
    expect((await spine(a.carrierCallId))[0]).toMatchObject({ outcome: 'overflow', follow_up_reason: 'overflow' });
  });

  it('a route closed now with no closed recording: closed spoken; with one, our stream plays it', async () => {
    const n = await number(X, credX);
    const routeId = await route(X, XA, n.id, { weekly_hours: [] });
    const { bridge, router } = harness();
    const a = arrival(X, credX, n.e164);
    expect(await router.answer(a)).toEqual({ kind: 'spoken', message: 'closed' });
    expect((await spine(a.carrierCallId))[0]).toMatchObject({ outcome: 'closed', follow_up_reason: 'closed' });

    const closed = await clip(X, XA);
    expect((await agencyInboundRouteRepository.update(X, XA, routeId, { clips: { closed: closed.id } }, null)).ok).toBe(true);
    const b = arrival(X, credX, n.e164);
    expect(await router.answer(b)).toMatchObject({ kind: 'stream' });
    await router.drain();
    expect(bridge.playClipSequenceThenHangUp).toHaveBeenCalledWith(expect.any(String), { clipHashes: [closed.hash], outcome: 'inbound_closed' });
  });

  it('over the route\'s max_concurrent with no busy recording: "all lines busy" spoken, and the refused call is never counted live', async () => {
    const n = await number(X, credX);
    await route(X, XA, n.id, { max_concurrent: 1, max_waiting: 1, clips: { callback: (await clip(X, XA)).id } });
    const { bridge, router } = harness();
    bridge.playClipSequenceThenHangUp.mockImplementation(() => new Promise(() => undefined));
    expect(await router.answer(arrival(X, credX, n.e164))).toMatchObject({ kind: 'stream' });
    const second = arrival(X, credX, n.e164);
    expect(await router.answer(second)).toEqual({ kind: 'spoken', message: 'busy' });
    expect((await spine(second.carrierCallId))[0]).toMatchObject({ outcome: 'overflow_no_capacity', follow_up_reason: 'overflow_no_capacity' });
    expect(await agencyAttemptRepository.countLiveForAccount(X, XA)).toBe(1);
  });
});

describe('the bridge\'s shared scopes full (IB5)', () => {
  it('the call is put back to `arrived` (not in the account\'s live total); with no busy recording our standard one plays', async () => {
    const n = await number(X, credX);
    const callback = await clip(X, XA);
    await route(X, XA, n.id, { clips: { callback: callback.id } });
    const { bridge, router } = harness();
    let release!: () => void;
    bridge.acceptInboundCall.mockResolvedValue({ ...ADMITTED, capacity: 'no_capacity' });
    bridge.playClipSequenceThenHangUp.mockImplementation(() => new Promise((resolve) => { release = () => resolve('completed'); }));
    const a = arrival(X, credX, n.e164);
    expect(await router.answer(a)).toMatchObject({ kind: 'stream' });
    expect((await spine(a.carrierCallId))[0]).toMatchObject({ state: 'arrived' });
    expect(await agencyAttemptRepository.countLiveForAccount(X, XA)).toBe(0);
    await vi.waitFor(() => expect(bridge.playClipSequenceThenHangUp).toHaveBeenCalled());
    expect(bridge.playClipSequenceThenHangUp).toHaveBeenCalledWith(expect.any(String), { clipHashes: [await standardClipHash('busy')], outcome: 'inbound_overflow_no_capacity' });
    release();
    await router.drain();
    expect((await spine(a.carrierCallId))[0]).toMatchObject({ state: 'ended', outcome: 'overflow_no_capacity', follow_up_reason: 'overflow_no_capacity' });
  });

  it('with a busy recording, it plays', async () => {
    const n = await number(X, credX);
    const busy = await clip(X, XA);
    await route(X, XA, n.id, { clips: { callback: (await clip(X, XA)).id, busy: busy.id } });
    const { bridge, router } = harness();
    bridge.acceptInboundCall.mockResolvedValue({ ...ADMITTED, capacity: 'no_capacity' });
    expect(await router.answer(arrival(X, credX, n.e164))).toMatchObject({ kind: 'stream' });
    await router.drain();
    expect(bridge.playClipSequenceThenHangUp).toHaveBeenCalledWith(expect.any(String), { clipHashes: [busy.hash], outcome: 'inbound_overflow_no_capacity' });
  });
});

describe('an answer past its budget: the caller heard the fallback (m6)', () => {
  async function openRoute() {
    const n = await number(X, credX);
    await route(X, XA, n.id, { clips: { callback: (await clip(X, XA)).id } });
    return n;
  }

  it('aborted before anything is written: nothing is', async () => {
    const n = await openRoute();
    const { bridge, router } = harness();
    const budget = new AbortController();
    budget.abort();
    const a = arrival(X, credX, n.e164);
    expect(await router.answer(a, { signal: budget.signal })).toEqual({ kind: 'fallback' });
    expect(await spine(a.carrierCallId)).toEqual([]);
    expect(bridge.acceptInboundCall).not.toHaveBeenCalled();
  });

  it('aborted once the row is written: no stream taken; ended `failed` with no Missed row and no callback; the leg failed', async () => {
    const n = await openRoute();
    const { bridge, router } = harness();
    const budget = new AbortController();
    const transition = agencyInboundCallRepository.transition.bind(agencyInboundCallRepository);
    const spy = vi.spyOn(agencyInboundCallRepository, 'transition').mockImplementation(async (...args) => {
      budget.abort();
      return transition(...args);
    });
    try {
      const a = arrival(X, credX, n.e164);
      expect(await router.answer(a, { signal: budget.signal })).toEqual({ kind: 'fallback' });
      expect(bridge.acceptInboundCall).not.toHaveBeenCalled();
      const [row] = await spine(a.carrierCallId);
      expect(row).toMatchObject({ state: 'ended', outcome: 'failed', follow_up_status: null, follow_up_reason: null, callback_due_at: null });
      expect(await legOf(row!)).toMatchObject({ status: 'failed', outcome: 'inbound_answer_timed_out', error_code: 'INBOUND_ANSWER_TIMED_OUT' });
    } finally {
      spy.mockRestore();
    }
  });

  it('aborted after the stream was promised: the play loop settles it `failed` with no follow-up', async () => {
    const n = await openRoute();
    const { bridge, router } = harness();
    const budget = new AbortController();
    bridge.acceptInboundCall.mockImplementation(async () => {
      budget.abort();
      return ADMITTED;
    });
    bridge.playClipSequenceThenHangUp.mockResolvedValue('no_media' as never);
    const a = arrival(X, credX, n.e164);
    expect(await router.answer(a, { signal: budget.signal })).toMatchObject({ kind: 'stream' });
    await router.drain();
    expect((await spine(a.carrierCallId))[0]).toMatchObject({ state: 'ended', outcome: 'failed', follow_up_status: null });
  });

  it('its hangup ends a row the answer left open as `failed` with no follow-up, not abandoned_in_queue', async () => {
    const n = await openRoute();
    const { router } = harness();
    // A first answer wrote the row (and was then lost); the carrier's retry was given up on at once.
    const a = arrival(X, credX, n.e164);
    const row = (await agencyInboundCallRepository.insertArrival({
      tenantId: X, accountId: XA, routeId: null, phoneNumberId: n.id, provider: 'plivo', telephonyCredentialId: credX,
      providerCallId: a.carrierCallId, fromE164: a.fromE164, toE164: a.toE164,
      identification: { match: null, callerDnc: false, sticky: null }, answered: true, recordingRequested: false, analysisProfileId: null,
    })).call!;
    const budget = new AbortController();
    budget.abort();
    expect(await router.answer(a, { signal: budget.signal })).toEqual({ kind: 'fallback' });
    await router.ended({ credentialId: credX, tenantId: X, provider: 'plivo', carrierCallId: a.carrierCallId, callStatus: 'completed', hangupSource: 'Caller' });
    expect((await agencyInboundCallRepository.findByIdAnyTenant(row.id))).toMatchObject({ state: 'ended', outcome: 'failed', follow_up_status: null });
  });

  it('a hangup with no budget trouble still ends an unplayed call abandoned_in_queue with its Missed row', async () => {
    const n = await openRoute();
    const { router } = harness();
    const a = arrival(X, credX, n.e164);
    const row = (await agencyInboundCallRepository.insertArrival({
      tenantId: X, accountId: XA, routeId: null, phoneNumberId: n.id, provider: 'plivo', telephonyCredentialId: credX,
      providerCallId: a.carrierCallId, fromE164: a.fromE164, toE164: a.toE164,
      identification: { match: null, callerDnc: false, sticky: null }, answered: true, recordingRequested: false, analysisProfileId: null,
    })).call!;
    await router.ended({ credentialId: credX, tenantId: X, provider: 'plivo', carrierCallId: a.carrierCallId, callStatus: 'completed', hangupSource: 'Caller' });
    expect((await agencyInboundCallRepository.findByIdAnyTenant(row.id))).toMatchObject({ state: 'ended', outcome: 'abandoned_in_queue', follow_up_status: 'open' });
  });
});

describe('what a caller hears with no recording of the route’s: our standard recordings, never silence', () => {
  /** A router whose bridge records what it was asked to play, with the caller on DNC when `dnc`, and a bucket. */
  function richHarness(o: { dnc?: boolean } = {}) {
    const bridge = {
      acceptInboundCall: vi.fn(async (): Promise<WebRtcInboundAcceptance> => ADMITTED),
      playClipSequenceThenHangUp: vi.fn(async () => 'completed' as const),
      stopInboundHold: vi.fn(),
      recordInboundAudio: vi.fn(async () => ({ result: 'aborted' as const, pcm16: Buffer.alloc(1600), sampleRate: 8000, seconds: 0.1 })),
      forceEndWithOutcome: vi.fn(async () => undefined),
    };
    const router = new AgencyInboundCallRouter({
      bridge: bridge as never,
      dnc: {
        check: async () => (o.dnc ? 'suppressed' : 'clear'),
        checkEntry: async () => ({ result: o.dnc ? 'suppressed' : 'clear' }),
      } as never,
      voicemailStorage: { configured: () => true, upload: vi.fn(async () => undefined), remove: vi.fn(async () => undefined) },
    });
    return { bridge, router };
  }

  /** A written call on `n`'s route, as the connector would hand it to `overflow`. */
  async function heldCall(n: { id: string; e164: string }, routeId: string, o: { fromE164?: string | null; dnc?: boolean } = {}) {
    const call = (await agencyInboundCallRepository.insertArrival({
      tenantId: X, accountId: XA, routeId, phoneNumberId: n.id, provider: 'plivo', telephonyCredentialId: credX,
      providerCallId: `CA-${randomUUID()}`, fromE164: o.fromE164 === undefined ? '+447700900123' : o.fromE164, toE164: n.e164,
      identification: { match: null, callerDnc: o.dnc ?? false, sticky: null }, answered: true, recordingRequested: false, analysisProfileId: null,
    })).call!;
    const routeRecord = (await agencyInboundRouteRepository.findById(X, XA, routeId))!;
    return { call, route: routeRecord };
  }

  it('a DNC caller is never promised a callback: the closed words spoken, or the closed recording played', async () => {
    const n = await number(X, credX);
    const routeId = await route(X, XA, n.id);
    const { bridge, router } = richHarness({ dnc: true });
    const a = arrival(X, credX, n.e164);
    expect(await router.answer(a)).toEqual({ kind: 'spoken', message: 'closed' });
    expect((await spine(a.carrierCallId))[0]).toMatchObject({ caller_dnc: true, outcome: 'overflow', follow_up_reason: 'overflow' });

    // A call-back recording is not for them: still the closed words, spoken.
    const callback = await clip(X, XA);
    expect((await agencyInboundRouteRepository.update(X, XA, routeId, { clips: { callback: callback.id } }, null)).ok).toBe(true);
    expect(await router.answer(arrival(X, credX, n.e164))).toEqual({ kind: 'spoken', message: 'closed' });
    expect(bridge.acceptInboundCall).not.toHaveBeenCalled();
    // With a closed recording too, the call streams and plays the closed one, never the call-back.
    const closed = await clip(X, XA);
    expect((await agencyInboundRouteRepository.update(X, XA, routeId, { clips: { closed: closed.id } }, null)).ok).toBe(true);
    expect(await router.answer(arrival(X, credX, n.e164))).toMatchObject({ kind: 'stream' });
    await router.drain();
    expect(bridge.playClipSequenceThenHangUp).toHaveBeenCalledWith(expect.any(String), { clipHashes: [closed.hash], outcome: 'inbound_overflow' });
  });

  it('the queue’s exit with no call-back recording plays ours, then puts the call down (no silent hang-up)', async () => {
    const n = await number(X, credX);
    const { call, route: r } = await heldCall(n, await route(X, XA, n.id));
    const { bridge, router } = richHarness();
    expect(await router.overflow(call, r)).toEqual({ outcome: 'overflow' });
    expect(bridge.stopInboundHold).toHaveBeenCalledWith(call.id);
    expect(bridge.playClipSequenceThenHangUp).toHaveBeenCalledWith(call.id, { clipHashes: [await standardClipHash('callback')], outcome: 'inbound_overflow' });
  });

  it('the queue’s exit for a withheld or DNC caller: the closed message, the route’s or ours', async () => {
    const n = await number(X, credX);
    const routeId = await route(X, XA, n.id);
    const { bridge, router } = richHarness();
    for (const o of [{ fromE164: null }, { dnc: true }]) {
      bridge.playClipSequenceThenHangUp.mockClear();
      const { call, route: r } = await heldCall(n, routeId, o);
      await router.overflow(call, r);
      expect(bridge.playClipSequenceThenHangUp).toHaveBeenCalledWith(call.id, { clipHashes: [await standardClipHash('closed')], outcome: 'inbound_overflow' });
    }
    const closed = await clip(X, XA);
    expect((await agencyInboundRouteRepository.update(X, XA, routeId, { clips: { closed: closed.id } }, null)).ok).toBe(true);
    const { call, route: r } = await heldCall(n, routeId, { dnc: true });
    bridge.playClipSequenceThenHangUp.mockClear();
    await router.overflow(call, r);
    expect(bridge.playClipSequenceThenHangUp).toHaveBeenCalledWith(call.id, { clipHashes: [closed.hash], outcome: 'inbound_overflow' });
  });

  it('a voicemail from the queue with no recording for its message: our voicemail prompt, then the beep', async () => {
    const n = await number(X, credX);
    const { call, route: r } = await heldCall(n, await route(X, XA, n.id, { overflow_action: 'voicemail' }));
    const { bridge, router } = richHarness();
    // The caller said nothing: no voicemail kept, the case's own outcome.
    expect(await router.overflow(call, r)).toEqual({ outcome: 'overflow' });
    expect(bridge.recordInboundAudio).toHaveBeenCalledWith(call.id, expect.objectContaining({
      promptClipHashes: [await standardClipHash('voicemail_prompt')], beep: true,
    }));
    expect(bridge.playClipSequenceThenHangUp).not.toHaveBeenCalled();
  });

  it('a voicemail from the queue for a DNC caller with no closed recording: no voicemail promising a call back; the closed message', async () => {
    const n = await number(X, credX);
    const { call, route: r } = await heldCall(n, await route(X, XA, n.id, { overflow_action: 'voicemail' }), { dnc: true });
    const { bridge, router } = richHarness();
    expect(await router.overflow(call, r)).toEqual({ outcome: 'overflow' });
    expect(bridge.recordInboundAudio).not.toHaveBeenCalled();
    expect(bridge.playClipSequenceThenHangUp).toHaveBeenCalledWith(call.id, { clipHashes: [await standardClipHash('closed')], outcome: 'inbound_overflow' });
  });

  it('after hours, a voicemail route with no closed recording takes the voicemail on our stream with our prompt; a withheld caller hears closed, spoken', async () => {
    const n = await number(X, credX);
    await route(X, XA, n.id, { weekly_hours: [], after_hours_action: 'voicemail' });
    const { bridge, router } = richHarness();
    const a = arrival(X, credX, n.e164);
    expect(await router.answer(a)).toMatchObject({ kind: 'stream' });
    await router.drain();
    expect(bridge.recordInboundAudio).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      promptClipHashes: [await standardClipHash('voicemail_prompt')],
    }));
    expect((await spine(a.carrierCallId))[0]).toMatchObject({ state: 'ended', outcome: 'closed', follow_up_reason: 'closed' });
    const w = arrival(X, credX, n.e164, { fromE164: null });
    expect(await router.answer(w)).toEqual({ kind: 'spoken', message: 'closed' });
  });

  it('the connector’s preamble: our "please hold" for no greeting, our notice for no notice recording; the hold has none (the built-in tone)', async () => {
    const n = await number(X, credX);
    const routeId = await route(X, XA, n.id);
    const r = (await agencyInboundRouteRepository.findById(X, XA, routeId))!;
    const { router } = richHarness();
    expect(await router.clips(r, ['greeting', 'recording_notice'])).toEqual([await standardClipHash('please_hold'), await standardClipHash('recording_notice')]);
    expect(await router.clips(r, ['greeting'])).toEqual([await standardClipHash('please_hold')]);
    expect(await router.clips(r, ['hold'])).toEqual([]);
    const greeting = await clip(X, XA);
    expect((await agencyInboundRouteRepository.update(X, XA, routeId, { clips: { greeting: greeting.id } }, null)).ok).toBe(true);
    const withGreeting = (await agencyInboundRouteRepository.findById(X, XA, routeId))!;
    expect(await router.clips(withGreeting, ['greeting', 'recording_notice'])).toEqual([greeting.hash, await standardClipHash('recording_notice')]);
  });
});
