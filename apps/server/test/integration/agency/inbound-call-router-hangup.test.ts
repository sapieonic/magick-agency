import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closePool, initDbPool } from '@magick-agency/db';
import { TEST_DB_URL } from '../../../../../packages/db/test/helpers/test-db.js';
import { getTestPool, truncateAll } from '../setup/test-utils.js';
import { DEFAULTS, OTHER_ACCOUNT, OTHER_TENANT, insertTenant } from '../setup/factories.js';
import { writeTtsFile } from '../../../src/tts/tts-file-cache.js';
import { parseInboundRouteCreate } from '../../../src/agency/inbound/route-config.js';
import { AgencyInboundCallRouter, INBOUND_EARLY_HANGUP_MS } from '../../../src/agency/inbound/inbound-call-router.js';
import { agencyInboundRouteRepository, type AgencyInboundCallRecord } from '../../../src/db/repositories/agency.repository.js';
import type { InboundCallArrival, InboundCallHangup } from '../../../src/seams/inbound-call-router.js';
import type { WebRtcInboundAcceptance } from '../../../src/core/webrtc-bridge-manager.js';

/**
 * The carrier's hangup webhook in the router (`AgencyInboundCallRouter.ended`) on real Postgres,
 * the bridge faked:
 *
 *  - QA-F1, tenant isolation on the hangup path (docs/inbound.md §3.4): a hangup verified on
 *    tenant X's credential naming tenant Y's live `CallUUID`, or on a second credential of Y
 *    itself, is ignored: no leg named, Y's row unchanged. Only the row's own credential ends it.
 *  - QA-F4, a hangup that lands while the answer is still deciding (the caller gave up during our
 *    answer-URL work): it finds no row and is remembered, under the credential and tenant that
 *    verified it, for {@link INBOUND_EARLY_HANGUP_MS}; the answer then ends its freshly written
 *    row at once as the caller who left (an open route's `abandoned_in_queue`, its Missed row; a
 *    closed route's reason kept) and answers a hangup: no stream taken. A hangup that finds the row
 *    while the answer is still taking the stream lets that stream go at once. Another credential's
 *    hangup, or one remembered too long ago, changes nothing.
 *
 * Mutation-checked: dropping the tenant/credential comparison in `ended()` hands the X hangup Y's
 * leg and ends Y's call (F1 red); dropping the remembered hangup's check in `decide` promises a
 * stream to the caller who left (F4 red); dropping the credential/tenant match in
 * `tookEarlyHangup` lets X's hangup end Y's answer (red).
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

async function number(tenant: string, cred: string): Promise<{ id: string; e164: string }> {
  const e164 = `+1415555${String(1000 + ++seq).padStart(4, '0')}`;
  const { rows } = await pool().query<{ id: string }>(
    `INSERT INTO phone_numbers (phone_number, provider_id, telephony_credential_id, status, inbound_linked_at)
     VALUES ($1, $2, $3, 'active', now()) RETURNING id`,
    [e164, plivoId, cred]);
  await pool().query('INSERT INTO tenant_phone_assignments (tenant_id, phone_number_id) VALUES ($1, $2)', [tenant, rows[0]!.id]);
  return { id: rows[0]!.id, e164 };
}

async function clip(tenant: string, account: string): Promise<string> {
  const hash = randomBytes(20).toString('hex');
  writeTtsFile(hash, Buffer.alloc(1600), 8000, 1);
  const { rows } = await pool().query<{ id: string }>(
    `INSERT INTO audio_files (tenant_id, account_id, name, slug, original_filename, content_type, size_bytes, s3_key, pcm_audio_hash, pcm_sample_rate, pcm_channels)
     VALUES ($1, $2, $3, $3, 'clip.wav', 'audio/wav', 1, $4, $5, 8000, 1) RETURNING id`,
    [tenant, account, `clip-${hash.slice(0, 8)}`, `audio/${hash}.wav`, hash]);
  return rows[0]!.id;
}

const ALWAYS = [1, 2, 3, 4, 5, 6, 7].map((day) => ({ day, start: '00:00', end: '24:00' }));

async function route(tenant: string, account: string, numberId: string, o: Record<string, unknown> = {}): Promise<void> {
  const parsed = parseInboundRouteCreate({ name: `Route ${++seq}`, timezone: 'UTC', weekly_hours: ALWAYS, ...o });
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues));
  const created = await agencyInboundRouteRepository.create({ tenantId: tenant, accountId: account, createdBy: null, config: parsed.config });
  if (!created.ok) throw new Error(created.reason);
  const attached = await agencyInboundRouteRepository.attachNumber({ tenantId: tenant, accountId: account, routeId: created.route.id, phoneNumberId: numberId, attachedBy: null });
  if (!attached.ok) throw new Error(attached.reason);
}

const ADMITTED: WebRtcInboundAcceptance = { accepted: true, streamUrl: 'wss://agency.test/stream', maxDurationSeconds: 1800, capacity: 'admitted' };

function harness() {
  const bridge = {
    acceptInboundCall: vi.fn(async (): Promise<WebRtcInboundAcceptance> => ADMITTED),
    // Playing never ends on its own here: the call stays the play loop's.
    playClipSequenceThenHangUp: vi.fn(() => new Promise<never>(() => undefined)),
    forceEndWithOutcome: vi.fn(async () => true),
  };
  const router = new AgencyInboundCallRouter({
    bridge: bridge as never,
    dnc: { check: async () => 'clear', checkEntry: async () => ({ result: 'clear' }) } as never,
  });
  return { bridge, router };
}

const arrival = (tenantId: string, credentialId: string, toE164: string, carrierCallId = `CA-${randomUUID()}`): InboundCallArrival => ({
  credentialId, tenantId, provider: 'plivo', credentialStatus: 'active', carrierCallId, fromE164: '+447700900123', toE164,
});

const hangupOf = (tenantId: string, credentialId: string, carrierCallId: string): InboundCallHangup => ({
  credentialId, tenantId, provider: 'plivo', carrierCallId, callStatus: 'completed', hangupSource: 'Caller',
});

async function spine(carrierCallId: string): Promise<AgencyInboundCallRecord[]> {
  return (await pool().query<AgencyInboundCallRecord>('SELECT * FROM agency_inbound_calls WHERE provider_call_id = $1', [carrierCallId])).rows;
}

beforeAll(() => { initDbPool({ url: TEST_DB_URL, poolMin: 0, poolMax: 6 }); });

beforeEach(async () => {
  await truncateAll();
  plivoId = (await pool().query<{ id: string }>(`INSERT INTO telephony_providers (name, display_name) VALUES ('plivo', 'Plivo') RETURNING id`)).rows[0]!.id;
  await insertTenant({ id: X });
  await insertTenant({ id: Y });
  for (const [id, tenant] of [[XA, X], [YA, Y]] as const) {
    await pool().query(`INSERT INTO accounts (id, tenant_id, name, slug) VALUES ($1, $2, 'Acct', $3)`, [id, tenant, `a-${randomUUID()}`]);
  }
  const cred = async (tenant: string, ref: string) => (await pool().query<{ id: string }>(
    `INSERT INTO telephony_credentials (tenant_id, provider, label, account_ref) VALUES ($1, 'plivo', 'Main', $2) RETURNING id`, [tenant, ref])).rows[0]!.id;
  credX = await cred(X, 'MAXXXXXXXXXXXXXXXXXX');
  credY = await cred(Y, 'MAYYYYYYYYYYYYYYYYYY');
});

afterEach(() => { vi.restoreAllMocks(); });
afterAll(async () => { await truncateAll(); await closePool(); });

describe('the hangup webhook names another tenant`s or credential`s call (QA-F1, §3.4)', () => {
  it('is ignored: no leg named, the row unchanged; only the row`s own credential ends it', async () => {
    const yNumber = await number(Y, credY);
    await route(Y, YA, yNumber.id, { clips: { callback: await clip(Y, YA) } });
    const { router } = harness();
    const a = arrival(Y, credY, yNumber.e164);
    expect(await router.answer(a)).toMatchObject({ kind: 'stream' });
    const [before] = await spine(a.carrierCallId);
    expect(before).toMatchObject({ tenant_id: Y, state: 'greeting' });

    // X's credential, verified by X's own token, posts a hangup for Y's CallUUID.
    expect(await router.ended(hangupOf(X, credX, a.carrierCallId))).toEqual({ legId: null });
    expect(await spine(a.carrierCallId)).toEqual([before]);

    // A second credential of Y itself: the row's credential is the subject, so also ignored.
    const credY2 = (await pool().query<{ id: string }>(
      `INSERT INTO telephony_credentials (tenant_id, provider, label, account_ref) VALUES ($1, 'plivo', 'Second', 'MAZZZZZZZZZZZZZZZZZZ') RETURNING id`, [Y])).rows[0]!.id;
    expect(await router.ended(hangupOf(Y, credY2, a.carrierCallId))).toEqual({ legId: null });
    expect(await spine(a.carrierCallId)).toEqual([before]);

    // Y's own credential: the leg is named (the play loop holds the call, so it ends it).
    expect((await router.ended(hangupOf(Y, credY, a.carrierCallId))).legId).toBe(before!.webrtc_call_id);
  });

  it('a call nobody plays to: X`s hangup leaves it live; Y`s own ends it as the caller who left', async () => {
    const yNumber = await number(Y, credY);
    await route(Y, YA, yNumber.id, { clips: { callback: await clip(Y, YA) } });
    const { bridge, router } = harness();
    // A written row nothing plays to: the bridge answers the stream as already `ended`, so the
    // router hangs up and starts no sequence.
    bridge.acceptInboundCall.mockResolvedValueOnce({ accepted: false, reason: 'ended' } as never);
    const a = arrival(Y, credY, yNumber.e164);
    expect(await router.answer(a)).toEqual({ kind: 'hangup' });
    const [row] = await spine(a.carrierCallId);
    expect(row).toMatchObject({ state: 'greeting' });

    expect(await router.ended(hangupOf(X, credX, a.carrierCallId))).toEqual({ legId: null });
    expect((await spine(a.carrierCallId))[0]).toMatchObject({ state: 'greeting' });

    expect((await router.ended(hangupOf(Y, credY, a.carrierCallId))).legId).toBe(row!.webrtc_call_id);
    expect((await spine(a.carrierCallId))[0]).toMatchObject({
      state: 'ended', outcome: 'abandoned_in_queue', follow_up_status: 'open', follow_up_reason: 'abandoned_in_queue',
    });
  });
});

describe('the hangup lands before the answer writes the call (QA-F4)', () => {
  it('the answer ends the new row at once as the caller who left, and answers a hangup: no stream taken', async () => {
    const yNumber = await number(Y, credY);
    await route(Y, YA, yNumber.id, { clips: { callback: await clip(Y, YA) } });
    const { bridge, router } = harness();
    const a = arrival(Y, credY, yNumber.e164);

    expect(await router.ended(hangupOf(Y, credY, a.carrierCallId))).toEqual({ legId: null });
    expect(await spine(a.carrierCallId)).toEqual([]);

    expect(await router.answer(a)).toEqual({ kind: 'hangup' });
    expect(bridge.acceptInboundCall).not.toHaveBeenCalled();
    expect(bridge.playClipSequenceThenHangUp).not.toHaveBeenCalled();
    const [row] = await spine(a.carrierCallId);
    expect(row).toMatchObject({
      state: 'ended', outcome: 'abandoned_in_queue', follow_up_status: 'open', follow_up_reason: 'abandoned_in_queue',
      settled_at: expect.any(Date),
    });
    const { rows: leg } = await pool().query<{ status: string; outcome: string }>('SELECT status, outcome FROM agency_calls WHERE id = $1', [row!.webrtc_call_id]);
    expect(leg[0]).toMatchObject({ status: 'completed', outcome: 'inbound_caller_hung_up' });
    expect(router.liveCallIds()).toEqual([]);
  });

  it('a closed route keeps its reason: the after-hours caller who left rang after hours', async () => {
    const yNumber = await number(Y, credY);
    await route(Y, YA, yNumber.id, { weekly_hours: [] });
    const { bridge, router } = harness();
    const a = arrival(Y, credY, yNumber.e164);
    await router.ended(hangupOf(Y, credY, a.carrierCallId));
    expect(await router.answer(a)).toEqual({ kind: 'hangup' });
    expect(bridge.acceptInboundCall).not.toHaveBeenCalled();
    expect((await spine(a.carrierCallId))[0]).toMatchObject({ state: 'ended', outcome: 'closed', follow_up_reason: 'closed' });
  });

  it('another tenant`s or credential`s hangup for the CallUUID changes nothing: the answer streams as usual', async () => {
    const yNumber = await number(Y, credY);
    await route(Y, YA, yNumber.id, { clips: { callback: await clip(Y, YA) } });
    const { bridge, router } = harness();
    const a = arrival(Y, credY, yNumber.e164);
    await router.ended(hangupOf(X, credX, a.carrierCallId));
    expect(await router.answer(a)).toMatchObject({ kind: 'stream' });
    expect(bridge.acceptInboundCall).toHaveBeenCalledTimes(1);
    expect((await spine(a.carrierCallId))[0]).toMatchObject({ state: 'greeting' });
  });

  it('a hangup remembered longer ago than the window is forgotten: the answer streams as usual', async () => {
    const yNumber = await number(Y, credY);
    await route(Y, YA, yNumber.id, { clips: { callback: await clip(Y, YA) } });
    const { router } = harness();
    const a = arrival(Y, credY, yNumber.e164);
    const t0 = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(t0);
    await router.ended(hangupOf(Y, credY, a.carrierCallId));
    clock.mockReturnValue(t0 + INBOUND_EARLY_HANGUP_MS + 1);
    expect(await router.answer(a)).toMatchObject({ kind: 'stream' });
  });

  it('a hangup that finds the row while the answer is taking its stream: the call ends as the caller who left and the stream is let go at once', async () => {
    const yNumber = await number(Y, credY);
    await route(Y, YA, yNumber.id, { clips: { callback: await clip(Y, YA) } });
    const { bridge, router } = harness();
    const a = arrival(Y, credY, yNumber.e164);
    // The hangup webhook runs while the bridge is taking the stream.
    bridge.acceptInboundCall.mockImplementationOnce(async () => {
      await router.ended(hangupOf(Y, credY, a.carrierCallId));
      return ADMITTED;
    });
    expect(await router.answer(a)).toEqual({ kind: 'hangup' });
    const [row] = await spine(a.carrierCallId);
    expect(row).toMatchObject({ state: 'ended', outcome: 'abandoned_in_queue', follow_up_reason: 'abandoned_in_queue' });
    expect(bridge.forceEndWithOutcome).toHaveBeenCalledWith(row!.id, 'inbound_caller_hung_up');
    expect(bridge.playClipSequenceThenHangUp).not.toHaveBeenCalled();
    expect(router.liveCallIds()).toEqual([]);
  });
});
