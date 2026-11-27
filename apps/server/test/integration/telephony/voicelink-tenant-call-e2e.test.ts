import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A campaign dialling on a tenant's OWN VoiceLink login, end to end (docs/carriers.md CR2–CR5,
 * CR12): the pacing loop dials the campaign's pinned credential through the real bridge, the
 * tenant factory and `VoicelinkAdapter`; the mock VoiceLink carrier (two accounts: the service's
 * and the tenant's) takes the `add_lead`, dials our media socket, streams A-law and posts its
 * status webhooks to the real routes. `voicelink-tenant-rig.ts` says what is real (everything in
 * the call path).
 *
 *  (a) a full call: `add_lead` on the TENANT's login (never the service's), from the tenant's
 *      DID, with the stream URL in it → pstn-stream → the customer heard by the agent → the
 *      status webhooks → `completed`, the row keeping the credential; the recording URL is
 *      persisted, offered to the client as the proxy path (never the raw URL, CR12), and the
 *      proxy, once the credential serves `recording`, redirects the viewer to it (fetching
 *      nothing); once the credential is revoked it refuses, with no redirect;
 *  (b) a login the carrier refuses 401 pauses the campaign `carrier_auth`, audited, and marks
 *      the credential `invalid`; no `add_lead` is sent and the contact is returned uncharged;
 *  (c) a credential disabled while its campaign runs: the dial is refused before the carrier
 *      and the campaign is paused `carrier_account_unavailable`, audited;
 *  (d) a service-account VoiceLink campaign running beside the tenant's dials on the service's
 *      own login, each from its own DID; neither login ever carries the other's dial;
 *  (e) the service's own username is refused as a tenant credential (CR3);
 *  (f) the account ref is the username lower-cased, so the same login typed in another case is
 *      the same account (`duplicate_account`), and the login sends the username as typed;
 *  (g) an account that logs in but cannot dial (API access withdrawn: every `add_lead` 401, a
 *      fresh login accepted each time, CR4): each dial ends `CARRIER_API_REFUSED`, nothing pauses
 *      before the breaker's API threshold, then the campaign is paused `carrier_refusing_calls`,
 *      audited with that cause; the credential stays `active`.
 */

const { env } = vi.hoisted(() => {
  const e = {
    FF_AGENCY_DIALER: 'true',
    VOICELINK_WEBHOOK_BASE_URL: 'https://agency.test/api/v1/webhooks/voicelink',
    VOICELINK_USERNAME: 'mock-vl-user',
    VOICELINK_PASSWORD: 'mock-vl-password',
    VOICELINK_LOGIN_TIMEOUT_MS: '3000',
    VOICELINK_ADD_LEAD_TIMEOUT_MS: '3000',
    MAX_CONCURRENT_CALLS: '100000',
    RATE_LIMIT_WEBHOOK_MAX: '1000000',
    RATE_LIMIT_CARRIER_MEDIA_MAX: '1000000',
    LOG_LEVEL: 'warn',
  };
  Object.assign(process.env, e);
  return { env: e };
});

import { getTestPool } from '../../../../../packages/db/test/helpers/test-db.js';
import { auditLogger } from '../../../src/audit/audit-logger.js';
import { campaignCredentialStartRefusal } from '../../../src/agency/campaign-carrier.js';
import { CARRIER_API_REFUSAL_BREAKER_THRESHOLD } from '../../../src/agency/carrier-refusal-breaker.js';
import { insertAgencyContact } from '../agency/agency-factories.js';
import { signRecordingUrl } from '../../../src/utils/recording-url.js';
import { resolveClientRecordingUrl } from '../../../src/utils/recording-url-resolver.js';
import { bits, carrierScripts, isLoudPcm16, type LeadRequest } from '../../mocks/voicelink/index.js';
import { attemptOf, callRow, campaignRow, joinAgent, waitFor, type Station } from './plivo-rig.js';
import {
  ACCOUNT, ADMIN, SERVICE_DID, SERVICE_USER, TENANT, TENANT_DID, TENANT_PASSWORD, TENANT_USER,
  VOICELINK_TENANT_E2E_ENV, closeVoicelinkTenantDb, initVoicelinkTenantDb, startVoicelinkTenantRig, voicelinkCampaign,
  type VoicelinkTenantRig,
} from './voicelink-tenant-rig.js';

const TERMINAL = new Set(['completed', 'no_answer', 'busy', 'canceled', 'failed']);
const REC_URL = 'https://recording.app.voicelink.co.in/client_77/2026-11-25/tenant-call.mp3';

let rig: VoicelinkTenantRig | null = null;
const stations: Station[] = [];

beforeAll(() => {
  expect(env).toEqual(VOICELINK_TENANT_E2E_ENV); // one source of truth for the env the rig expects
  initVoicelinkTenantDb();
});
beforeEach(async () => { rig = await startVoicelinkTenantRig(); });
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const s of stations.splice(0)) await s.close();
  await rig?.carrier.settled();
  await rig?.stop();
  rig = null;
  vi.restoreAllMocks();
});
afterAll(closeVoicelinkTenantDb);

async function terminalRow(callId: string, extra: (row: NonNullable<Awaited<ReturnType<typeof callRow>>>) => boolean = () => true) {
  return waitFor(`call ${callId} terminal`, async () => {
    const row = await callRow(callId);
    return row && TERMINAL.has(row.status) && row.ended_at && extra(row) ? row : null;
  }, 20_000, async () => JSON.stringify(await callRow(callId)));
}

async function contactReturned(contactId: string) {
  return waitFor('the contact returned', async () => {
    const { rows } = await getTestPool().query<{ state: string; due: boolean; our_fault_attempts: number }>(
      `SELECT state, next_attempt_at <= now() + interval '1 second' AS due, our_fault_attempts
         FROM agency_contacts WHERE id = $1`, [contactId]);
    return rows[0]!.state === 'pending' ? rows[0] : null;
  });
}

describe('a call on the tenant`s own VoiceLink login, through the real server', () => {
  it('(a) dials on the tenant login from its DID; full call; the credential stays on the row; the recording goes through the proxy, which redirects, never raw', async () => {
    const r = rig!;
    const pattern = Array.from({ length: 25 }, (_, i) => i % 3 !== 1);
    r.carrier.setScript(() => carrierScripts.answered({ pattern, recordingUrl: REC_URL }).script);
    const { campaignId } = await voicelinkCampaign(r);
    const station = await joinAgent(r, campaignId);
    stations.push(station);

    const call = await waitFor('the lead reached the carrier', () => r.carrier.callOrder[0]);
    const attempt = await waitFor('the attempt', async () => {
      const a = await attemptOf(campaignId);
      return a?.webrtc_call_id ? a : null;
    });
    expect(attempt.webrtc_call_id).toBe(call.callId);

    // The dial: the tenant's login, the tenant's token, the tenant's DID, our stream URL.
    const [login] = r.carrier.requestsTo('login');
    expect(login).toMatchObject({ account: TENANT_USER, status: 200 });
    expect(login!.body).toEqual({ username: TENANT_USER, password: TENANT_PASSWORD });
    const [lead] = r.carrier.requestsTo('add_lead');
    expect(lead).toMatchObject({ account: TENANT_USER, status: 200 });
    expect(lead!.body).toMatchObject({ did_number: TENANT_DID.slice(1), customer_number: '9812345678', country_code: '91' });
    expect((lead!.body as LeadRequest).websocket_url).toMatch(new RegExp(`^wss://agency\\.test/api/v1/webrtc-call/${call.callId}/pstn-stream\\?token=`));
    expect(r.carrier.requestsAs(SERVICE_USER)).toEqual([]);

    // The customer's audio reached the agent, in order.
    await waitFor('the customer heard by the agent', () => station.media.length >= pattern.length, 20_000,
      () => `${station.media.length} frames`);
    expect(bits(station.media.slice(0, pattern.length).map(isLoudPcm16))).toBe(bits(pattern));
    await r.carrier.settled();

    const row = await terminalRow(call.callId, (x) => x.recording_url !== null);
    expect(row).toMatchObject({
      status: 'completed', provider: 'voicelink', telephony_credential_id: r.credentialId,
      caller_id: TENANT_DID, recording_url: REC_URL,
    });
    expect(row.answered_at).not.toBeNull();
    expect(call.webhookResults.every((w) => w.status === 200)).toBe(true);
    await waitFor('attempt ended connected', async () => (await attemptOf(campaignId))?.outcome === 'connected');

    // CR12: the client is handed the proxy path, never the carrier's URL, though VoiceLink's
    // service-account recordings are public.
    const proxyPath = `/api/v1/webrtc-recordings/${call.callId}`;
    expect(resolveClientRecordingUrl({
      recordingUrl: row.recording_url, provider: row.provider, telephonyCredentialId: row.telephony_credential_id, proxyPath,
    })).toBe(proxyPath);
    expect(resolveClientRecordingUrl({
      recordingUrl: row.recording_url, provider: row.provider, telephonyCredentialId: null, proxyPath,
    })).toBe(REC_URL);

    // Through the proxy, which checks the credential and the host, then sends the viewer to the
    // file itself (our egress cannot reach VoiceLink's recording host): nothing is fetched here.
    const upstream = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      void url; void init;
      return new Response(Buffer.from('ID3 tenant recording'), { status: 200, headers: { 'content-type': 'audio/mpeg' } });
    });
    vi.stubGlobal('fetch', upstream);
    const signed = signRecordingUrl({ callId: call.callId, tenantId: TENANT, accountId: ACCOUNT }).path;
    const played = await r.app.inject({ method: 'GET', url: signed });
    expect(played.statusCode).toBe(302);
    expect(played.headers['location']).toBe(REC_URL);
    expect(played.headers['cache-control']).toBe('no-store');
    expect(played.body).not.toContain(TENANT_PASSWORD.trim());
    expect(upstream).not.toHaveBeenCalled();
    // A script that cannot follow that redirect (the console's blob fetchers) asks for JSON and
    // is told the URL instead: 200 { redirect_url }, no-store, still nothing fetched.
    const JSON_ACCEPT = 'application/json, audio/*;q=0.9, */*;q=0.1';
    const asJson = await r.app.inject({
      method: 'GET', url: signRecordingUrl({ callId: call.callId, tenantId: TENANT, accountId: ACCOUNT }).path,
      headers: { accept: JSON_ACCEPT },
    });
    expect(asJson.statusCode).toBe(200);
    expect(asJson.json()).toEqual({ redirect_url: REC_URL });
    expect(asJson.headers['cache-control']).toBe('no-store');
    expect(asJson.headers['location']).toBeUndefined();
    expect(upstream).not.toHaveBeenCalled();

    // Revoking the credential ends playback (B21): no redirect, nothing fetched.
    await getTestPool().query(`UPDATE agency_campaigns SET status = 'stopped' WHERE id = $1`, [campaignId]);
    const revoked = await r.credentials.revoke(r.credentialId, ADMIN);
    expect(revoked.ok).toBe(true);
    const gone = await r.app.inject({ method: 'GET', url: signRecordingUrl({ callId: call.callId, tenantId: TENANT, accountId: ACCOUNT }).path });
    expect(gone.statusCode).toBe(404);
    expect(gone.json()).toMatchObject({ code: 'recording_unavailable' });
    expect(gone.headers['location']).toBeUndefined();
    const goneJson = await r.app.inject({
      method: 'GET', url: signRecordingUrl({ callId: call.callId, tenantId: TENANT, accountId: ACCOUNT }).path,
      headers: { accept: JSON_ACCEPT },
    });
    expect(goneJson.statusCode).toBe(404);
    expect(goneJson.body).not.toContain(REC_URL);
    expect(upstream).not.toHaveBeenCalled();
    expect(r.bridge.getActiveCount()).toBe(0);
  }, 60_000);

  // The audit calls below follow a row the test has waited for, and are waited for too (the
  // writer audits once its own connection has read Postgres's reply; see plivo-call-e2e.test.ts).
  it('(b) a login VoiceLink refuses 401 pauses the campaign `carrier_auth`, audited, and marks the credential invalid', async () => {
    const r = rig!;
    const audit = vi.spyOn(auditLogger, 'log');
    r.carrier.refuseLogins(TENANT_USER, 401);
    const { campaignId, contactId } = await voicelinkCampaign(r);
    stations.push(await joinAgent(r, campaignId));
    await waitFor('campaign paused', async () => (await campaignRow(campaignId)).status === 'paused');
    expect(await campaignRow(campaignId)).toEqual({ status: 'paused', pause_reason: 'carrier_auth' });
    expect(r.carrier.requestsTo('login').map((l) => [l.account, l.status])).toEqual([[TENANT_USER, 401]]);
    expect(r.carrier.requestsTo('add_lead')).toEqual([]);
    await vi.waitFor(() => expect(audit).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'agency_campaign.auto_paused',
      eventData: expect.objectContaining({ campaign_id: campaignId, reason: 'carrier_auth', telephony_credential_id: r.credentialId }),
    })));
    expect(await contactReturned(contactId)).toEqual({ state: 'pending', due: true, our_fault_attempts: 0 });

    const credential = await waitFor('the credential marked invalid', async () => {
      const row = await r.credentials.get(r.credentialId);
      return row?.status === 'invalid' ? row : null;
    });
    expect(credential).toMatchObject({ secret_version: 1, last_error: 'The carrier refused the credential on a dial (HTTP 401)' });
    await vi.waitFor(() => expect(audit).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'telephony_credential.carrier_refused', actor: 'system:carrier-auth',
      eventData: expect.objectContaining({ telephony_credential_id: r.credentialId, secret_version: 1, status: 'invalid' }),
    })));
    expect(JSON.stringify(audit.mock.calls)).not.toContain(TENANT_PASSWORD.trim());
    expect(await campaignCredentialStartRefusal({ telephony_credential_id: r.credentialId }))
      .toMatchObject({ code: 'telephony_credential_not_active' });
    // Once VoiceLink takes the login again, a verify brings the credential back.
    r.carrier.refuseLogins(TENANT_USER, null);
    const verified = await r.credentials.verify(r.credentialId, ADMIN);
    expect(verified.ok && verified.value).toMatchObject({ status: 'active', last_error: null });
  }, 60_000);

  it('(c) a credential disabled while its campaign runs pauses it `carrier_account_unavailable`; nothing reaches the carrier', async () => {
    const r = rig!;
    const audit = vi.spyOn(auditLogger, 'log');
    const { campaignId, contactId } = await voicelinkCampaign(r);
    expect((await r.credentials.disable(r.credentialId, ADMIN)).ok).toBe(true);
    stations.push(await joinAgent(r, campaignId));
    await waitFor('campaign paused', async () => (await campaignRow(campaignId)).status === 'paused');
    expect(await campaignRow(campaignId)).toEqual({ status: 'paused', pause_reason: 'carrier_account_unavailable' });
    expect(r.carrier.requests).toEqual([]);
    await vi.waitFor(() => expect(audit).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'agency_campaign.auto_paused',
      eventData: expect.objectContaining({ campaign_id: campaignId, reason: 'carrier_account_unavailable', telephony_credential_id: r.credentialId }),
    })));
    expect(await contactReturned(contactId)).toEqual({ state: 'pending', due: true, our_fault_attempts: 0 });
  }, 60_000);

  it('(d) a service-account VoiceLink campaign beside it dials on the service login; each login carries only its own dial', async () => {
    const r = rig!;
    r.carrier.setScript(() => carrierScripts.noAnswer().script);
    const tenant = await voicelinkCampaign(r, { destination: '+919812340001' });
    const service = await voicelinkCampaign(r, { credentialId: null, destination: '+919812340002' });
    stations.push(await joinAgent(r, tenant.campaignId), await joinAgent(r, service.campaignId));
    await r.carrier.waitForCalls(2);
    await r.carrier.settled();

    const leads = r.carrier.requestsTo('add_lead');
    expect(leads.map((l) => l.status)).toEqual([200, 200]);
    const byDid = new Map(leads.map((l) => [(l.body as LeadRequest).did_number, l]));
    expect(byDid.get(TENANT_DID.slice(1))).toMatchObject({ account: TENANT_USER, body: expect.objectContaining({ customer_number: '9812340001' }) });
    expect(byDid.get(SERVICE_DID.slice(1))).toMatchObject({ account: SERVICE_USER, body: expect.objectContaining({ customer_number: '9812340002' }) });
    expect(r.carrier.requestsTo('login').map((l) => l.account).sort()).toEqual([SERVICE_USER, TENANT_USER].sort());

    const calls = await waitFor('both attempts placed', async () => {
      const t = await attemptOf(tenant.campaignId);
      const s = await attemptOf(service.campaignId);
      return t?.webrtc_call_id && s?.webrtc_call_id ? { t: t.webrtc_call_id, s: s.webrtc_call_id } : null;
    });
    expect(await terminalRow(calls.t)).toMatchObject({ status: 'no_answer', telephony_credential_id: r.credentialId, caller_id: TENANT_DID });
    expect(await terminalRow(calls.s)).toMatchObject({ status: 'no_answer', telephony_credential_id: null, caller_id: SERVICE_DID });
  }, 60_000);

  it('(f) a second credential naming the same login in another case is refused as the same account; the login keeps the case typed', async () => {
    const r = rig!;
    const stored = await getTestPool().query<{ account_ref: string; public_config: { username: string } }>(
      'SELECT account_ref, public_config FROM telephony_credentials WHERE id = $1', [r.credentialId]);
    expect(stored.rows[0]).toEqual({ account_ref: TENANT_USER.toLowerCase(), public_config: { username: TENANT_USER } });
    // A carrier that compares usernames without case would accept the login: only our unique
    // account ref can catch it.
    const shouted = TENANT_USER.toUpperCase();
    r.carrier.addAccount(shouted, TENANT_PASSWORD);
    const refused = await r.credentials.create({
      tenantId: TENANT, provider: 'voicelink', label: 'Same login shouted', adminId: ADMIN,
      fields: { username: shouted, password: TENANT_PASSWORD },
    });
    expect(!refused.ok && refused.code).toBe('duplicate_account');
    expect(r.carrier.requestsTo('login').map((l) => (l.body as { username: string }).username)).toEqual([shouted]);
    const count = await getTestPool().query<{ n: string }>(`SELECT count(*)::text AS n FROM telephony_credentials WHERE provider = 'voicelink'`);
    expect(count.rows[0]!.n).toBe('1');
  }, 30_000);

  it('(g) an account that logs in but whose every add_lead is 401 is paused `carrier_refusing_calls` after the API threshold, never `carrier_auth`; the credential stays active', async () => {
    const r = rig!;
    const audit = vi.spyOn(auditLogger, 'log');
    r.carrier.withdrawApiAccess(TENANT_USER, true);
    const { campaignId } = await voicelinkCampaign(r, { destination: '+919812350000' });
    // More contacts than the threshold, so the campaign has a dial for every refusal it counts.
    for (let i = 1; i <= CARRIER_API_REFUSAL_BREAKER_THRESHOLD + 2; i++) {
      await insertAgencyContact(campaignId, {
        tenant_id: TENANT, account_id: ACCOUNT, phone_e164: `+91981235${String(i).padStart(4, '0')}`, source_row_number: i + 1,
      });
    }
    const refusedCalls = async () => Number((await getTestPool().query<{ n: string }>(
      `SELECT count(*)::text AS n FROM agency_calls WHERE telephony_credential_id = $1 AND error_code = 'CARRIER_API_REFUSED'`,
      [r.credentialId])).rows[0]!.n);
    const pauses = () => audit.mock.calls.filter(([e]) => e.eventType === 'agency_campaign.auto_paused');

    stations.push(await joinAgent(r, campaignId));
    // Every refusal before the threshold leaves the campaign running.
    await waitFor('refusals short of the threshold', async () => (await refusedCalls()) >= CARRIER_API_REFUSAL_BREAKER_THRESHOLD - 1, 45_000,
      async () => `${await refusedCalls()} refused, campaign ${JSON.stringify(await campaignRow(campaignId))}`);
    const paused = await waitFor('campaign paused', async () => {
      const row = await campaignRow(campaignId);
      return row.status === 'paused' ? row : null;
    }, 45_000, async () => `${await refusedCalls()} refused`);
    expect(paused).toEqual({ status: 'paused', pause_reason: 'carrier_refusing_calls' });
    expect(await refusedCalls()).toBeGreaterThanOrEqual(CARRIER_API_REFUSAL_BREAKER_THRESHOLD);
    await vi.waitFor(() => expect(pauses()).toHaveLength(1));
    expect(pauses()[0]![0]).toMatchObject({
      actor: 'system:carrier-refusals',
      eventData: expect.objectContaining({
        campaign_id: campaignId, reason: 'carrier_refusing_calls', cause: 'carrier_api_refused', telephony_credential_id: r.credentialId,
      }),
    });

    // Every login was accepted (the credential is good) and every add_lead was refused.
    const logins = r.carrier.requestsTo('login');
    expect(logins.length).toBeGreaterThan(0);
    expect(logins.every((l) => l.account === TENANT_USER && l.status === 200)).toBe(true);
    expect(r.carrier.requestsTo('add_lead').every((l) => l.status === 401)).toBe(true);
    // No verdict on the credential: still active, no carrier_refused audit, start not refused.
    expect(await r.credentials.get(r.credentialId)).toMatchObject({ status: 'active', last_error: null });
    expect(audit.mock.calls.some(([e]) => e.eventType === 'telephony_credential.carrier_refused')).toBe(false);
    expect(await campaignCredentialStartRefusal({ telephony_credential_id: r.credentialId })).toBeNull();
    // What a supervisor is told of a refused call: vendor-free, no raw carrier text.
    const { rows } = await getTestPool().query<{ error_message: string }>(
      `SELECT error_message FROM agency_calls WHERE error_code = 'CARRIER_API_REFUSED' LIMIT 1`);
    expect(rows[0]!.error_message).toMatch(/401/);
    r.carrier.withdrawApiAccess(TENANT_USER, false);
  }, 120_000);

  it('(e) the service`s own VoiceLink username is refused as a tenant credential, before any login', async () => {
    const r = rig!;
    const refused = await r.credentials.create({
      tenantId: TENANT, provider: 'voicelink', label: 'Not ours', adminId: ADMIN,
      fields: { username: SERVICE_USER.toUpperCase(), password: 'anything' },
    });
    expect(!refused.ok && refused.code).toBe('account_ref_reserved');
    expect(r.carrier.requests).toEqual([]);
  }, 30_000);
});
