import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Inbound calls, P1 (docs/inbound.md §3, §7, §10), end to end through the real server against the
 * mock Plivo carrier: a customer rings a number linked to the credential's inbound Application,
 * Plivo posts the signed answer callback to the URL stored on the credential, our answer XML
 * streams the call to our pstn-stream, the bridge plays the route's clips and hangs up by REST,
 * Plivo posts the hangup, and the spine ends with its outcome, its Missed row and (for a matched
 * contact) the callback the dialer's real claim then dials.
 *
 * Real: Postgres, this lane's Redis, the app listening on loopback, the voice and agency
 * bootstraps (the inbound router registered by `startAgency`), the bridge, the credential service
 * and `PlivoAdapter` (the plivo rig, `plivo-rig.ts`). The clips are real decoded PCM on this
 * replica's clip cache, as `ensurePcmClip` leaves them.
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
import { usageCountsRepository } from '@magick-agency/db/repositories/usage-counts.repository';
import { PLIVO_HANGUP_XML } from '../../../src/telephony/plivo/plivo.adapter.js';
import { PLIVO_INBOUND_CALLBACK_XML, PLIVO_INBOUND_CLOSED_XML } from '../../../src/telephony/plivo/plivo-inbound.webhook.js';
import { mintInboundToken } from '../../../src/telephony/plivo/inbound-token.js';
import {
  plivoInboundAnswerUrl, plivoInboundFallbackUrl, plivoInboundStatusUrl, withInboundToken,
} from '../../../src/telephony/plivo/inbound-urls.js';
import { writeTtsFile } from '../../../src/tts/tts-file-cache.js';
import { parseInboundRouteCreate } from '../../../src/agency/inbound/route-config.js';
import { startInboundCalls } from '../../../src/agency/inbound/start.js';
import { DncRegistry } from '../../../src/agency/dnc-registry.js';
import {
  agencyContactRepository,
  agencyInboundCallRepository,
  agencyInboundRouteRepository,
  agencyAttemptRepository,
  type AgencyInboundCallRecord,
} from '../../../src/db/repositories/agency.repository.js';
import { getInboundCallRouter, setInboundCallRouter } from '../../../src/seams/inbound-call-router.js';
import type { PlivoCall, PlivoCallStep } from '../../mocks/plivo/index.js';
import {
  ACCOUNT, ADMIN, CALLER_ID, NO_RETRY, PLIVO_E2E_ENV, PLIVO_NUMBER, TENANT,
  closePlivoDb, initPlivoDb, startPlivoRig, waitFor, type PlivoRig,
} from './plivo-rig.js';
import { insertAgencyCampaign, insertAgencyContact } from '../agency/agency-factories.js';

const pool = () => getTestPool();
const BASE = 'https://agency.test/api/v1/webhooks/plivo';
const CALLER = '919812345678';
const CALLER_E164 = `+${CALLER}`;
const AGENT = '8b1d0c8e-3d0e-4c7a-8b44-1f6b0a0000a1';

let rig: PlivoRig | null = null;
/** The P1 router these tests answer with, and the bootstrap's, put back after each. */
let p1: Awaited<ReturnType<typeof startInboundCalls>> | null = null;
let bootRouter: ReturnType<typeof getInboundCallRouter> | null = null;
let token = '';
let phoneNumberId = '';
let routeId = '';

/** A clip on this replica's cache, as `ensurePcmClip` leaves an uploaded one, with its audio_files row. */
async function clip(ms: number): Promise<{ id: string; bytes: number }> {
  const hash = randomBytes(20).toString('hex');
  const samples = Math.round((8000 * ms) / 1000);
  const pcm = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) pcm.writeInt16LE(Math.round(8000 * Math.sin((2 * Math.PI * 440 * i) / 8000)), i * 2);
  writeTtsFile(hash, pcm, 8000, 1);
  const { rows } = await pool().query<{ id: string }>(
    `INSERT INTO audio_files (tenant_id, account_id, name, slug, original_filename, content_type, size_bytes, s3_key,
                              pcm_audio_hash, pcm_sample_rate, pcm_channels)
     VALUES ($1, $2, $3, $3, 'clip.wav', 'audio/wav', 1, $4, $5, 8000, 1) RETURNING id`,
    [TENANT, ACCOUNT, `clip-${hash.slice(0, 8)}`, `audio/${hash}.wav`, hash]);
  return { id: rows[0]!.id, bytes: samples };
}

/** Every day, all day, in UTC. */
const ALWAYS = [1, 2, 3, 4, 5, 6, 7].map((day) => ({ day, start: '00:00', end: '24:00' }));
/** Open only tomorrow (UTC), 09:00–17:00: closed now, its next opening tomorrow at 09:00. */
function tomorrowOnly(): { hours: Array<{ day: number; start: string; end: string }>; opening: Date } {
  const now = new Date();
  const isoToday = ((now.getUTCDay() + 6) % 7) + 1;
  const tomorrow = (isoToday % 7) + 1;
  const opening = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 9, 0, 0));
  return { hours: [{ day: tomorrow, start: '09:00', end: '17:00' }], opening };
}

interface RouteClips { greeting: { id: string; bytes: number }; callback: { id: string; bytes: number }; closed: { id: string; bytes: number }; busy: { id: string; bytes: number } }
let clips: RouteClips;

async function setRoute(over: Record<string, unknown>): Promise<void> {
  const current = (await agencyInboundRouteRepository.findById(TENANT, ACCOUNT, routeId))!;
  const res = await agencyInboundRouteRepository.update(TENANT, ACCOUNT, routeId, over, null);
  if (!res.ok) throw new Error(`route update refused: ${res.reason} (${current.name})`);
}

/** The tenant's number linked to inbound and answered by an open route with four clips. */
async function linkInbound(r: PlivoRig): Promise<void> {
  const pn = await pool().query<{ id: string }>('SELECT id FROM phone_numbers WHERE phone_number = $1', [CALLER_ID]);
  phoneNumberId = pn.rows[0]!.id;
  const assigned = await pool().query('SELECT 1 FROM tenant_phone_assignments WHERE phone_number_id = $1 AND tenant_id = $2', [phoneNumberId, TENANT]);
  if (assigned.rowCount === 0) {
    await pool().query('INSERT INTO tenant_phone_assignments (tenant_id, phone_number_id, assigned_by) VALUES ($1, $2, $3)', [TENANT, phoneNumberId, ADMIN]);
  }
  await pool().query(`UPDATE phone_numbers SET inbound_linked_at = now() WHERE id = $1`, [phoneNumberId]);
  const minted = mintInboundToken();
  token = minted.token;
  const enabled = await telephonyCredentialRepository.enableInbound(r.credentialId, {
    appId: 'app-inbound-e2e',
    answerUrl: plivoInboundAnswerUrl(BASE, r.credentialId),
    hangupUrl: plivoInboundStatusUrl(BASE, r.credentialId),
    fallbackAnswerUrl: plivoInboundFallbackUrl(BASE),
    tokenHash: minted.tokenHash,
  }, ADMIN);
  if (!enabled) throw new Error('enableInbound refused');
  clips = { greeting: await clip(300), callback: await clip(400), closed: await clip(350), busy: await clip(250) };
  const parsed = parseInboundRouteCreate({
    name: 'Main line', timezone: 'UTC', weekly_hours: ALWAYS,
    clips: { greeting: clips.greeting.id, callback: clips.callback.id, closed: clips.closed.id, busy: clips.busy.id },
  });
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues));
  const created = await agencyInboundRouteRepository.create({ tenantId: TENANT, accountId: ACCOUNT, createdBy: null, config: parsed.config });
  if (!created.ok) throw new Error('route create refused');
  routeId = created.route.id;
  const attached = await agencyInboundRouteRepository.attachNumber({ tenantId: TENANT, accountId: ACCOUNT, routeId, phoneNumberId, attachedBy: null });
  if (!attached.ok) throw new Error(`attach refused: ${attached.reason}`);
}

/** A pool campaign on the tenant's credential and one contact on the caller's number. */
async function campaignWithCaller(contact: Record<string, unknown> = {}, campaign: Record<string, unknown> = {}) {
  const c = await insertAgencyCampaign({
    tenant_id: TENANT, account_id: ACCOUNT, status: 'running', wrapup_seconds: 0,
    disposition_catalog: JSON.stringify([]), retry_policy: JSON.stringify(NO_RETRY),
    telephony_provider: 'plivo', telephony_credential_id: rig!.credentialId, caller_ids: [CALLER_ID],
    ...campaign,
  });
  const ct = await insertAgencyContact(c.id as string, {
    tenant_id: TENANT, account_id: ACCOUNT, phone_e164: CALLER_E164, source_row_number: 1, ...contact,
  });
  // The rig runs the real pacing tick, which completes a `running` campaign with no outstanding
  // contact (`maybeFinalize`), and an inbound callback books only on a running or paused
  // campaign. A caller who is the roster's only contact and `exhausted` left nothing
  // outstanding, so a tick landing mid-test completed the campaign and the call booked no
  // callback (`callback_due_at` null, on a busy CI runner). Another contact, pending but due
  // tomorrow, keeps the campaign open; no claim takes it before then.
  if ((c.status as string) === 'running') {
    await insertAgencyContact(c.id as string, {
      tenant_id: TENANT, account_id: ACCOUNT, phone_e164: '+919811299999', source_row_number: 2,
      next_attempt_at: new Date(Date.now() + 86_400_000),
    });
  }
  return { campaignId: c.id as string, contactId: ct.id as string };
}

/** A customer rings the linked number; the carrier streams until our REST hangup (or `steps`). */
function ring(r: PlivoRig, o: { from?: string; steps?: PlivoCallStep[]; sign?: PlivoCallStep } = {}): PlivoCall {
  return r.carrier.ringInbound({
    from: o.from ?? CALLER,
    to: PLIVO_NUMBER,
    answerUrl: withInboundToken(plivoInboundAnswerUrl(BASE, r.credentialId), token),
    hangupUrl: withInboundToken(plivoInboundStatusUrl(BASE, r.credentialId), token),
    script: {
      name: 'inbound',
      steps: o.steps ?? [
        { do: 'answer' },
        { do: 'connect' },
        { do: 'start' },
        { do: 'waitFor', until: (c) => c.hungUpByApi, what: 'our REST hangup', timeoutMs: 20_000 },
        { do: 'waitFor', until: (c) => c.callbacks.some((cb) => cb.to === 'hangup'), what: 'the hangup callback' },
      ],
    },
  });
}

async function spineOf(call: PlivoCall): Promise<AgencyInboundCallRecord | null> {
  return agencyInboundCallRepository.findByProviderCallId('plivo', call.callUuid);
}

async function ended(call: PlivoCall): Promise<AgencyInboundCallRecord> {
  return waitFor(`inbound call ${call.callUuid} ended`, async () => {
    const row = await spineOf(call);
    return row?.state === 'ended' ? row : null;
  }, 20_000, async () => JSON.stringify({ spine: await spineOf(call), callbacks: call.callbacks, errors: call.errors }));
}

async function contactRow(id: string) {
  const { rows } = await pool().query<{
    state: string; next_attempt_at: Date; callback_source: string | null; callback_due_at: Date | null; attempt_count: number;
  }>('SELECT state, next_attempt_at, callback_source, callback_due_at, attempt_count FROM agency_contacts WHERE id = $1', [id]);
  return rows[0]!;
}

async function legOf(row: AgencyInboundCallRecord) {
  const { rows } = await pool().query<{ status: string; outcome: string | null; origin: string; inbound_call_id: string; caller_id: string; destination_phone: string; ended_at: Date | null }>(
    'SELECT status, outcome, origin, inbound_call_id, caller_id, destination_phone, ended_at FROM agency_calls WHERE id = $1', [row.webrtc_call_id]);
  return rows[0]!;
}

const played = (call: PlivoCall): number => call.playAudio.reduce((n, b) => n + b.length, 0);

beforeAll(() => {
  expect(env).toEqual(PLIVO_E2E_ENV);
  initPlivoDb();
});
beforeEach(async () => {
  rig = await startPlivoRig();
  await pool().query(`INSERT INTO accounts (id, tenant_id, name, slug) VALUES ($1, $2, 'Main', 'main') ON CONFLICT (id) DO NOTHING`, [ACCOUNT, TENANT]);
  await pool().query(`INSERT INTO users (id, firebase_uid, email) VALUES ($1, 'fb-inbound-agent', 'inbound-agent@example.test') ON CONFLICT (id) DO NOTHING`, [AGENT]);
  await pool().query(`INSERT INTO memberships (user_id, tenant_id, account_id, role) VALUES ($1, $2, $3, 'agent') ON CONFLICT DO NOTHING`, [AGENT, TENANT, ACCOUNT]);
  await linkInbound(rig);
  // P1's answer: the router without the P2 gate (no `connect`), so nobody is put through and the
  // account's `agency_inbound_enabled` is not read, as on a deployment whose agents cannot be
  // connected. The bootstrap's router reads the flag, which is off here: it would answer every
  // caller with the closed message (the kill switch, `inbound-kill-switch.test.ts`).
  bootRouter = getInboundCallRouter();
  p1 = await startInboundCalls({ bridge: rig.bridge, dnc: new DncRegistry() });
});
afterEach(async () => {
  await rig?.carrier.settled();
  await p1?.stop();
  p1 = null;
  if (bootRouter) setInboundCallRouter(bootRouter);
  bootRouter = null;
  await rig?.stop();
  rig = null;
});
afterAll(closePlivoDb);

describe('an inbound call on a linked Plivo number, P1 (nobody is connected)', () => {
  it('open: signed answer → our stream → greeting + "we will call you back" → REST hangup; overflow, Missed row to the owner, callback the claim dials', async () => {
    const r = rig!;
    const { campaignId, contactId } = await campaignWithCaller({ assigned_user_id: AGENT, assigned_at: new Date(), state: 'exhausted', attempt_count: 3, next_attempt_at: new Date(Date.now() + 86_400_000) });
    const call = ring(r);
    const row = await ended(call);
    await call.done;

    // The answer: our bidirectional stream, kept alive, to our pstn-stream; nothing recorded.
    expect(call.answerXml).toContain('<Stream bidirectional="true"');
    expect(call.answerXml).toContain('keepCallAlive="true"');
    expect(call.answerXml).not.toContain('<Record');
    expect(call.streamUrl).toMatch(new RegExp(`^wss://agency\\.test/api/v1/webrtc-call/${row.webrtc_call_id}/pstn-stream\\?token=`));
    expect(call.statusesFor('answer')).toEqual([200]);
    expect(call.statusesFor('hangup')).toEqual([200]);
    expect(call.hungUpByApi).toBe(true);
    // Both clips played, in full (μ-law: a byte a sample).
    expect(played(call)).toBe(clips.greeting.bytes + clips.callback.bytes);

    expect(row).toMatchObject({
      tenant_id: TENANT, account_id: ACCOUNT, route_id: routeId, phone_number_id: phoneNumberId, telephony_credential_id: r.credentialId,
      from_e164: CALLER_E164, to_e164: CALLER_ID, matched_contact_id: contactId, matched_campaign_id: campaignId, caller_dnc: false,
      sticky_user_id: AGENT, sticky_reason: 'owner', outcome: 'overflow', follow_up_status: 'open', follow_up_reason: 'overflow',
      follow_up_assignee_user_id: AGENT, talk_seconds: null,
    });
    expect(row.answered_at).not.toBeNull();
    expect(row.callback_due_at).not.toBeNull();
    expect(await legOf(row)).toMatchObject({ status: 'completed', origin: 'inbound', inbound_call_id: row.id, caller_id: CALLER_ID, destination_phone: CALLER_E164 });

    // IB4: the exhausted contact is reopened as an inbound callback, due now (the route is open).
    const contact = await contactRow(contactId);
    expect(contact).toMatchObject({ state: 'pending', callback_source: 'inbound' });
    expect(contact.callback_due_at!.getTime()).toBe(row.callback_due_at!.getTime());
    expect(contact.next_attempt_at.getTime()).toBe(row.callback_due_at!.getTime());
    // The dialer's own claim takes it (the pool claim, as pacing runs it).
    const claimed = await agencyContactRepository.claimDialable(campaignId, 5);
    expect(claimed.map((c) => c.id)).toEqual([contactId]);
    // Its next placed call settles the callback.
    await agencyContactRepository.chargeAttempt(contactId, 'no_answer');
    expect(await contactRow(contactId)).toMatchObject({ callback_source: null, callback_due_at: null });

    // Usage: the call counts as an inbound call of the account, answered, with its carrier time; never as a dial.
    const usage = await usageCountsRepository.countByAccount({
      from: new Date(Date.now() - 3_600_000), to: new Date(Date.now() + 60_000), tenantId: TENANT, accountId: ACCOUNT,
    });
    expect(usage.map((u) => [u.dials, u.answered_calls, u.inbound_calls, u.inbound_answered_calls, u.inbound_connected_calls])).toEqual([[0, 0, 1, 1, 0]]);
    expect(usage[0]!.inbound_seconds).toBe(Math.round((row.ended_at!.getTime() - row.answered_at!.getTime()) / 1000));
  });

  it('closed: greeting + closed message; Missed row `closed`, callback due at the route`s next opening (not claimable before)', async () => {
    const r = rig!;
    const { hours, opening } = tomorrowOnly();
    await setRoute({ weekly_hours: hours });
    const { campaignId, contactId } = await campaignWithCaller({ assigned_user_id: AGENT, assigned_at: new Date() });
    const call = ring(r);
    const row = await ended(call);
    await call.done;
    expect(played(call)).toBe(clips.greeting.bytes + clips.closed.bytes);
    expect(row).toMatchObject({ outcome: 'closed', follow_up_reason: 'closed', follow_up_status: 'open' });
    expect(row.callback_due_at!.toISOString()).toBe(opening.toISOString());
    const contact = await contactRow(contactId);
    expect(contact.callback_source).toBe('inbound');
    // A pending contact due sooner would keep its time; this one was due at its insert, now, so it keeps now.
    expect(contact.next_attempt_at.getTime()).toBeLessThanOrEqual(Date.now());
    expect((await agencyContactRepository.claimDialable(campaignId, 5)).map((c) => c.id)).toEqual([contactId]);
  });

  it('closed: an exhausted contact reopens due at the next opening, and the claim leaves it until then', async () => {
    const r = rig!;
    const { hours, opening } = tomorrowOnly();
    await setRoute({ weekly_hours: hours });
    const { campaignId, contactId } = await campaignWithCaller({ state: 'exhausted', attempt_count: 3 });
    const row = await ended(ring(r));
    expect(row.outcome).toBe('closed');
    const contact = await contactRow(contactId);
    expect(contact).toMatchObject({ state: 'pending', callback_source: 'inbound' });
    expect(contact.next_attempt_at.toISOString()).toBe(opening.toISOString());
    expect(await agencyContactRepository.claimDialable(campaignId, 5)).toEqual([]);
  });

  it('an unknown caller: Missed row with no match and no assignee; nothing booked', async () => {
    const row = await ended(ring(rig!, { from: '447700900123' }));
    expect(row).toMatchObject({
      from_e164: '+447700900123', matched_contact_id: null, sticky_user_id: null, outcome: 'overflow',
      follow_up_status: 'open', follow_up_assignee_user_id: null, callback_due_at: null,
    });
  });

  it('a withheld caller: Missed row with no number', async () => {
    const call = ring(rig!, { from: 'anonymous' });
    const row = await ended(call);
    expect(row).toMatchObject({ from_e164: null, matched_contact_id: null, outcome: 'overflow', follow_up_status: 'open' });
    expect((await legOf(row)).destination_phone).toBe('');
  });

  it('a DNC caller: the Missed row is flagged and the contact is never booked (B8)', async () => {
    const { contactId } = await campaignWithCaller({ state: 'exhausted', attempt_count: 3 });
    await pool().query(`INSERT INTO dnc_entries (tenant_id, phone_e164, source) VALUES ($1, $2, 'agent')`, [TENANT, CALLER_E164]);
    const row = await ended(ring(rig!));
    expect(row).toMatchObject({ caller_dnc: true, matched_contact_id: contactId, follow_up_status: 'open', callback_due_at: null });
    expect(await contactRow(contactId)).toMatchObject({ state: 'exhausted', callback_source: null });
  });

  it('a terminal contact (completed) is never reopened: Missed row only', async () => {
    const { contactId } = await campaignWithCaller({ state: 'completed', last_outcome: 'connected' });
    const row = await ended(ring(rig!));
    expect(row).toMatchObject({ matched_contact_id: contactId, follow_up_status: 'open', callback_due_at: null });
    expect(await contactRow(contactId)).toMatchObject({ state: 'completed', callback_source: null });
  });

  it('a contact on a completed campaign gets no callback', async () => {
    const { contactId } = await campaignWithCaller({ state: 'exhausted', attempt_count: 3, created_at: new Date() }, { status: 'completed' });
    // Its campaign is not live and it was never called inside the lookback: not the caller.
    const row = await ended(ring(rig!));
    expect(row.matched_contact_id).toBeNull();
    expect(await contactRow(contactId)).toMatchObject({ state: 'exhausted', callback_source: null });
  });

  it('a disabled credential that still verifies: answered closed (closed message), Missed row', async () => {
    const r = rig!;
    await pool().query(`UPDATE telephony_credentials SET status = 'disabled' WHERE id = $1`, [r.credentialId]);
    const call = ring(r);
    const row = await ended(call);
    await call.done;
    expect(played(call)).toBe(clips.greeting.bytes + clips.closed.bytes);
    expect(row).toMatchObject({ outcome: 'closed', follow_up_reason: 'closed' });
    expect(call.hungUpByApi).toBe(true);
  });

  it('a number not linked to inbound (unlinked) is hung up: a `rejected` row, no Missed row, nothing streamed', async () => {
    await pool().query('UPDATE phone_numbers SET inbound_linked_at = NULL WHERE id = $1', [phoneNumberId]);
    const call = ring(rig!, { steps: [{ do: 'answer' }] });
    await call.done;
    expect(call.answerXml).toBe(PLIVO_HANGUP_XML);
    expect(await spineOf(call)).toMatchObject({
      state: 'ended', outcome: 'rejected', account_id: null, answered_at: null, follow_up_status: null, webrtc_call_id: null,
    });
  });

  it('the tenant default (no route, no matched contact): the closed message spoken by the carrier, a Missed row with no account', async () => {
    await agencyInboundRouteRepository.setNumbers({ tenantId: TENANT, accountId: ACCOUNT, routeId, phoneNumberIds: [], userId: null });
    const call = ring(rig!, { steps: [{ do: 'answer' }] });
    await call.done;
    expect(call.answerXml).toBe(PLIVO_INBOUND_CLOSED_XML);
    expect(await spineOf(call)).toMatchObject({
      state: 'ended', outcome: 'closed', account_id: null, route_id: null, webrtc_call_id: null,
      follow_up_status: 'open', follow_up_reason: 'closed',
    });
  });

  it('a route with no "we will call you back" recording: the carrier speaks it, nothing streams; overflow, Missed row and callback as ever', async () => {
    const { contactId } = await campaignWithCaller({ assigned_user_id: AGENT, assigned_at: new Date() });
    await setRoute({ clips: { callback: null } });
    const call = ring(rig!, { steps: [{ do: 'answer' }] });
    await call.done;
    expect(call.answerXml).toBe(PLIVO_INBOUND_CALLBACK_XML);
    expect(call.answerXml).not.toContain('<Stream');
    expect(call.hungUpByApi).toBe(false);
    const row = await ended(call);
    expect(row).toMatchObject({ outcome: 'overflow', follow_up_status: 'open', follow_up_reason: 'overflow', follow_up_assignee_user_id: AGENT });
    expect(await legOf(row)).toMatchObject({ status: 'completed', outcome: 'inbound_overflow', origin: 'inbound' });
    expect(await contactRow(contactId)).toMatchObject({ state: 'pending', callback_source: 'inbound' });
  });

  it('a bad signature (another account`s token) is hung up and writes nothing', async () => {
    const call = ring(rig!, { steps: [{ do: 'answer', sign: { token: 'not-this-accounts-token' } }] });
    await call.done;
    expect(call.answerXml).toBe(PLIVO_HANGUP_XML);
    expect(await spineOf(call)).toBeNull();
  });

  it('a signature over env`s URL rather than the stored one is refused', async () => {
    const call = ring(rig!, { steps: [{ do: 'answer', sign: { url: `https://elsewhere.test/api/v1/webhooks/plivo/inbound-answer/${rig!.credentialId}?token=${token}` } }] });
    await call.done;
    expect(call.answerXml).toBe(PLIVO_HANGUP_XML);
  });

  it('a replayed answer (same nonce) is hung up; the call is taken in once', async () => {
    const call = ring(rig!, {
      steps: [
        { do: 'answer' },
        { do: 'replay' },
        { do: 'connect' },
        { do: 'start' },
        { do: 'waitFor', until: (c) => c.hungUpByApi, what: 'our REST hangup', timeoutMs: 20_000 },
      ],
    });
    await ended(call);
    await call.done;
    const answers = call.callbacks.filter((c) => c.to === 'answer');
    expect(answers[0]!.body).toContain('<Stream');
    expect(answers[1]!.body).toBe(PLIVO_HANGUP_XML);
    const { rows } = await pool().query('SELECT count(*)::int AS n FROM agency_inbound_calls WHERE provider_call_id = $1', [call.callUuid]);
    expect(rows[0].n).toBe(1);
  });

  it('over the route`s max_concurrent: the next caller hears "all lines are busy" (overflow_no_capacity); the live one counts in the account`s live total', async () => {
    const r = rig!;
    await setRoute({ max_concurrent: 1, max_waiting: 0 });
    const long = await clip(4000);
    await setRoute({ clips: { callback: long.id } });
    const first = ring(r);
    await waitFor('the first call admitted', async () => (await spineOf(first))?.state === 'greeting');
    // IB5: the live inbound call is in the account's live-call total pacing reads.
    expect(await agencyAttemptRepository.countLiveForAccount(TENANT, ACCOUNT)).toBe(1);
    const second = ring(r);
    const busy = await ended(second);
    await second.done;
    expect(busy).toMatchObject({ outcome: 'overflow_no_capacity', follow_up_reason: 'overflow_no_capacity' });
    expect(played(second)).toBe(clips.greeting.bytes + clips.busy.bytes);
    expect((await ended(first)).outcome).toBe('overflow');
    expect(await agencyAttemptRepository.countLiveForAccount(TENANT, ACCOUNT)).toBe(0);
  });

  it('the caller hangs up mid-message: abandoned_in_queue, Missed row and callback; no REST hangup of ours', async () => {
    const r = rig!;
    const long = await clip(4000);
    await setRoute({ clips: { callback: long.id } });
    const { contactId } = await campaignWithCaller();
    const call = ring(r, {
      steps: [
        { do: 'answer' },
        { do: 'connect' },
        { do: 'start' },
        { do: 'waitFor', until: (c) => c.playAudio.length > 20, what: 'the messages playing' },
        { do: 'hangup', status: 'completed', source: 'Caller' },
        { do: 'close' },
      ],
    });
    const row = await ended(call);
    await call.done;
    expect(row).toMatchObject({ outcome: 'abandoned_in_queue', follow_up_reason: 'abandoned_in_queue', follow_up_status: 'open' });
    expect(played(call)).toBeLessThan(clips.greeting.bytes + long.bytes);
    expect(call.hungUpByApi).toBe(false);
    expect((await contactRow(contactId)).callback_source).toBe('inbound');
    await waitFor('the leg ended', async () => (await legOf(row)).ended_at !== null);
  });

  it('restart: the startup sweep ends a call a restart left open as failed (we lost the caller, QA-F9), with its follow-up and callback', async () => {
    const { campaignId, contactId } = await campaignWithCaller({ state: 'exhausted', attempt_count: 3 });
    const call = (await agencyInboundCallRepository.insertArrival({
      tenantId: TENANT, accountId: ACCOUNT, routeId, phoneNumberId, provider: 'plivo', telephonyCredentialId: rig!.credentialId,
      providerCallId: `CA-${randomUUID()}`, fromE164: CALLER_E164, toE164: CALLER_ID,
      identification: { match: { contactId, campaignId }, callerDnc: false, sticky: { userId: AGENT, reason: 'owner' } },
      answered: true, recordingRequested: false, analysisProfileId: null,
    })).call!;
    await agencyInboundCallRepository.transition(call.id, 'greeting');
    const running = getInboundCallRouter();
    const restarted = await startInboundCalls({ bridge: rig!.bridge, dnc: new DncRegistry() });
    try {
      const row = (await agencyInboundCallRepository.findByIdAnyTenant(call.id))!;
      expect(row).toMatchObject({ state: 'ended', outcome: 'failed', follow_up_status: 'open', follow_up_reason: 'failed', follow_up_assignee_user_id: AGENT });
      expect(row.callback_due_at).not.toBeNull();
      expect(await contactRow(contactId)).toMatchObject({ state: 'pending', callback_source: 'inbound' });
    } finally {
      await restarted.stop();
      setInboundCallRouter(running);
    }
  });
});
