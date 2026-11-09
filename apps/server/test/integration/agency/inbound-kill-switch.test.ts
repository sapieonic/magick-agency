import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closePool, initDbPool } from '@magick-agency/db';
import { TEST_DB_URL } from '../../../../../packages/db/test/helpers/test-db.js';
import { getTestPool, truncateAll } from '../setup/test-utils.js';
import { DEFAULTS, insertTenant } from '../setup/factories.js';
import { writeTtsFile } from '../../../src/tts/tts-file-cache.js';
import { parseInboundRouteCreate } from '../../../src/agency/inbound/route-config.js';
import { AgencyInboundCallRouter } from '../../../src/agency/inbound/inbound-call-router.js';
import { agencyInboundRouteRepository, type AgencyInboundCallRecord } from '../../../src/db/repositories/agency.repository.js';
import type { InboundCallArrival } from '../../../src/seams/inbound-call-router.js';
import type { WebRtcInboundAcceptance } from '../../../src/core/webrtc-bridge-manager.js';

/**
 * The inbound kill switch (docs/inbound.md §8.1) on real Postgres, the bridge faked: with the
 * account's `agency_inbound_enabled` off, a caller to an open route that has every recording is
 * answered with the closed message spoken by the carrier (no stream, no queue, no voicemail),
 * ended `closed` with its Missed row. With the flag on, the same call is answered as before (here
 * with no connector: the open route's call-back recording over our stream). A flag read that fails
 * is not "off".
 *
 * Mutation-checked: dropping `switchedOff` from the plan in `decide` streams the call-back
 * recording with the flag off (the first test goes red); dropping it from the spoken-message
 * condition streams the closed recording instead of speaking it (red as well).
 */

const X = DEFAULTS.tenantId;
const XA = DEFAULTS.accountId;
const pool = () => getTestPool();

let plivoId: string;
let cred: string;
let seq = 0;

async function linkedNumber(): Promise<{ id: string; e164: string }> {
  const e164 = `+1415556${String(1000 + ++seq).padStart(4, '0')}`;
  const { rows } = await pool().query<{ id: string }>(
    `INSERT INTO phone_numbers (phone_number, provider_id, telephony_credential_id, status, inbound_linked_at)
     VALUES ($1, $2, $3, 'active', now()) RETURNING id`,
    [e164, plivoId, cred]);
  await pool().query('INSERT INTO tenant_phone_assignments (tenant_id, phone_number_id) VALUES ($1, $2)', [X, rows[0]!.id]);
  return { id: rows[0]!.id, e164 };
}

async function clip(): Promise<{ id: string; hash: string }> {
  const hash = randomBytes(20).toString('hex');
  writeTtsFile(hash, Buffer.alloc(1600), 8000, 1);
  const { rows } = await pool().query<{ id: string }>(
    `INSERT INTO audio_files (tenant_id, account_id, name, slug, original_filename, content_type, size_bytes, s3_key,
                              pcm_audio_hash, pcm_sample_rate, pcm_channels)
     VALUES ($1, $2, $3, $3, 'clip.wav', 'audio/wav', 1, $4, $5, 8000, 1) RETURNING id`,
    [X, XA, `clip-${hash.slice(0, 8)}`, `audio/${hash}.wav`, hash]);
  return { id: rows[0]!.id, hash };
}

const ALWAYS = [1, 2, 3, 4, 5, 6, 7].map((day) => ({ day, start: '00:00', end: '24:00' }));

/** An open route answering a fresh linked number, with a recording in every message slot. */
async function openRouteWithEveryRecording(): Promise<{ e164: string; callback: string }> {
  const n = await linkedNumber();
  const [greeting, callback, closed, busy] = [await clip(), await clip(), await clip(), await clip()];
  const parsed = parseInboundRouteCreate({
    name: `Route ${++seq}`, timezone: 'UTC', weekly_hours: ALWAYS,
    clips: { greeting: greeting.id, callback: callback.id, closed: closed.id, busy: busy.id },
  });
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues));
  const created = await agencyInboundRouteRepository.create({ tenantId: X, accountId: XA, createdBy: null, config: parsed.config });
  if (!created.ok) throw new Error(created.reason);
  const attached = await agencyInboundRouteRepository.attachNumber({ tenantId: X, accountId: XA, routeId: created.route.id, phoneNumberId: n.id, attachedBy: null });
  if (!attached.ok) throw new Error(attached.reason);
  return { e164: n.e164, callback: callback.hash };
}

const ADMITTED: WebRtcInboundAcceptance = { accepted: true, streamUrl: 'wss://agency.test/stream', maxDurationSeconds: 1800, capacity: 'admitted' };

function harness(enabled: () => Promise<boolean>) {
  const bridge = {
    acceptInboundCall: vi.fn(async (): Promise<WebRtcInboundAcceptance> => ADMITTED),
    playClipSequenceThenHangUp: vi.fn(async () => 'completed' as const),
  };
  const flag = vi.fn(enabled);
  const router = new AgencyInboundCallRouter({
    bridge: bridge as never,
    dnc: { check: async () => 'clear', checkEntry: async () => ({ result: 'clear' }) } as never,
    // The P2 gate as `startInboundCalls` wires it, with no connector: nobody is put through.
    connect: { connector: null, enabled: flag, mediaWorkers: 0 },
  });
  return { bridge, router, flag };
}

const arrival = (toE164: string): InboundCallArrival => ({
  credentialId: cred, tenantId: X, provider: 'plivo', credentialStatus: 'active',
  carrierCallId: `CA-${randomUUID()}`, fromE164: '+447700900123', toE164,
});

async function spine(carrierCallId: string): Promise<AgencyInboundCallRecord> {
  const { rows } = await pool().query<AgencyInboundCallRecord>('SELECT * FROM agency_inbound_calls WHERE provider_call_id = $1', [carrierCallId]);
  return rows[0]!;
}

beforeAll(() => {
  initDbPool({ url: TEST_DB_URL, poolMin: 0, poolMax: 4 });
});

beforeEach(async () => {
  await truncateAll();
  plivoId = (await pool().query<{ id: string }>(`INSERT INTO telephony_providers (name, display_name) VALUES ('plivo', 'Plivo') RETURNING id`)).rows[0]!.id;
  await insertTenant({ id: X });
  await pool().query(`INSERT INTO accounts (id, tenant_id, name, slug) VALUES ($1, $2, 'Acct', $3)`, [XA, X, `a-${randomUUID()}`]);
  cred = (await pool().query<{ id: string }>(
    `INSERT INTO telephony_credentials (tenant_id, provider, label, account_ref) VALUES ($1, 'plivo', 'Main', 'MAKKKKKKKKKKKKKKKKKK') RETURNING id`, [X])).rows[0]!.id;
});

afterAll(async () => {
  // 0024's Down refuses while inbound calls exist: leave none for the down → up suites.
  await truncateAll();
  await closePool();
});

describe('the inbound kill switch: agency_inbound_enabled off (§8.1)', () => {
  it('an open route`s caller hears the closed message, spoken by the carrier: no stream, no queue; ended closed with its Missed row', async () => {
    const route = await openRouteWithEveryRecording();
    const { bridge, router, flag } = harness(async () => false);
    const a = arrival(route.e164);

    expect(await router.answer(a)).toEqual({ kind: 'spoken', message: 'closed' });
    expect(flag).toHaveBeenCalledWith(X, XA);
    expect(bridge.acceptInboundCall).not.toHaveBeenCalled();
    expect(bridge.playClipSequenceThenHangUp).not.toHaveBeenCalled();
    const row = await spine(a.carrierCallId);
    expect(row).toMatchObject({ state: 'ended', outcome: 'closed', follow_up_status: 'open', follow_up_reason: 'closed', queued_at: null, recording_requested: false });
    const { rows: [leg] } = await pool().query<{ status: string; outcome: string }>('SELECT status, outcome FROM agency_calls WHERE id = $1', [row.webrtc_call_id]);
    expect(leg).toEqual({ status: 'completed', outcome: 'inbound_closed' });
  });

  it('with the flag on, the same route answers as before (with nobody to connect: the call-back recording over our stream)', async () => {
    const route = await openRouteWithEveryRecording();
    const { bridge, router } = harness(async () => true);
    const a = arrival(route.e164);
    expect(await router.answer(a)).toMatchObject({ kind: 'stream' });
    await router.drain();
    expect(bridge.playClipSequenceThenHangUp).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ outcome: 'inbound_overflow' }));
    expect((bridge.playClipSequenceThenHangUp.mock.calls[0] as unknown as [string, { clipHashes: string[] }])[1].clipHashes).toContain(route.callback);
    expect(await spine(a.carrierCallId)).toMatchObject({ outcome: 'overflow' });
  });

  it('a flag read that fails is not "off": the call is answered as if inbound were on', async () => {
    const route = await openRouteWithEveryRecording();
    const { router } = harness(async () => { throw new Error('redis down'); });
    const a = arrival(route.e164);
    expect(await router.answer(a)).toMatchObject({ kind: 'stream' });
    await router.drain();
    expect(await spine(a.carrierCallId)).toMatchObject({ outcome: 'overflow' });
  });
});
