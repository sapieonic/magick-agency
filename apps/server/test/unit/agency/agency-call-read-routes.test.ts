import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';

// ---------------------------------------------------------------------------
// The agency-native call read —
// `GET /agency-campaigns/:id/attempts/:attemptId{,/recording,/recording-url}`.
//
// This is the surface whose absence made the agency workspace link its attempt
// rows into `/app/calls/dialer/history/:id` — a different shell, gated on
// a different capability.
//
// ── Two assertions this file exists for ────────────────────────────────────
//
// 1. **The middleware actually runs.** Auth is registered PER ROUTE PLUGIN, not
//    globally, and that mistake has already shipped here once (the roster-ingest
//    route). Asserted by spying on the middleware rather than on a status code —
//    a route that does not exist also answers 404, so a status assertion would
//    pass against a route that was never registered.
//
// 2. **A purged call is 200 with a marker, not 404.** The attempt→call link is
//    deliberately un-FK'd (migration 076) and both sides purge on independent
//    windows, so an attempt routinely outlives its call. A 404 there would read
//    as "this attempt never happened", which is false and destroys exactly the
//    agency-side audit trail the un-FK'd link exists to protect.
// ---------------------------------------------------------------------------

vi.mock('@magick-agency/observability', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@magick-agency/observability')>()),
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
  createChildLogger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

// `voicelinkRecording.allowedHosts`: the recording route hands `proxyCallRecording`
// the allow-list from config. Asserted in "streams through the authenticated proxy…".
const { RECORDING_HOSTS } = vi.hoisted(() => ({ RECORDING_HOSTS: ['recordings.voicelink.test'] }));
vi.mock('../../../src/config/index.js', () => ({
  config: { redis: { keyPrefix: '' }, telephony: {}, voicelinkRecording: { allowedHosts: RECORDING_HOSTS } },
}));

const { authSpy } = vi.hoisted(() => ({ authSpy: vi.fn(async () => { /* authenticated */ }) }));
vi.mock('../../../src/api/middleware/auth.middleware.js', () => ({
  authMiddleware: authSpy,
  getTenantId: (req: { headers: Record<string, string> }) => req.headers['x-mgkvc-tenant'] ?? 't1',
  getAccountId: (req: { headers: Record<string, string> }) => req.headers['x-mgkvc-account'] ?? 'a1',
  getOriginator: () => null,
}));

const { flags } = vi.hoisted(() => ({ flags: { isEnabled: vi.fn().mockResolvedValue(true) } }));
vi.mock('../../../src/feature-flags/index.js', () => ({
  getFeatureFlagService: () => flags,
  FLAGS: { agency_dialer_enabled: { default: false } },
}));

vi.mock('../../../src/audit/audit-logger.js', () => ({ auditLogger: { log: vi.fn() } }));

const { campaigns, attempts, contacts, webrtc } = vi.hoisted(() => ({
  campaigns: { findById: vi.fn() },
  attempts: { listForCampaign: vi.fn(), findForCampaign: vi.fn() },
  contacts: { listForCampaign: vi.fn(), findDetailScoped: vi.fn() },
  webrtc: { findByIdScoped: vi.fn() },
}));
vi.mock('../../../src/db/repositories/agency.repository.js', () => ({
  agencyCampaignRepository: campaigns,
  agencyAttemptRepository: attempts,
  agencyContactRepository: contacts,
}));
vi.mock('@magick-agency/db/repositories/agency-call.repository', () => ({
  webrtcCallRepository: webrtc,
}));
vi.mock('@magick-agency/db/repositories/announcement.repository', () => ({
  announcementRepository: { findActiveByIdScoped: vi.fn() },
}));

const { proxySpy, signSpy } = vi.hoisted(() => ({
  proxySpy: vi.fn(async (_call: unknown, _req: unknown, reply: { send: (b: unknown) => unknown }) =>
    reply.send({ streamed: true })),
  // A real Date, because the route formats it: the softphone twin sends
  // `expiresAt.toISOString()` and this route mirrors that twin, so a stand-in
  // string here would let the two shapes drift again unnoticed.
  signSpy: vi.fn(() => ({
    path: '/api/v1/webrtc-recordings/call-1?sig=x',
    expiresAt: new Date('2026-08-24T12:00:00.000Z'),
  })),
}));
vi.mock('../../../src/utils/recording-proxy.js', () => ({ proxyCallRecording: proxySpy }));
vi.mock('../../../src/utils/recording-url.js', () => ({ signRecordingUrl: signSpy }));

import { agencyCampaignRoutes } from '../../../src/api/routes/agency-campaigns.routes.js';

const DEPS = {
  runtime: {
    dnc: { appliedVersion: async () => 1 },
    stations: { connectedBySession: async () => ({}) },
  },
  callManager: {
    accountConcurrencyGuard: {
      getDistributedAccountCount: async () => ({ status: 'unavailable' as const }),
    },
  },
} as unknown as Parameters<typeof agencyCampaignRoutes>[1];

const HEADERS = { 'x-mgkvc-tenant': 't1', 'x-mgkvc-account': 'a1' };
const CAMPAIGN = { id: 'c1', tenant_id: 't1', account_id: 'a1', name: 'Q3', status: 'stopped' };

// Real UUIDs: the routes shape-check `attemptId` before querying, because a
// non-UUID reaches Postgres as 22P02 and would surface as a 500.
const ATTEMPT_ID = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const ATTEMPT_ID_2 = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';

/** An attempt that reached a dial. */
const ATTEMPT = {
  id: ATTEMPT_ID,
  campaign_id: 'c1',
  contact_id: 'ct-1',
  attempt_number: 1,
  phone_e164: '+14155550199',
  caller_id: '+14155550100',
  agent_user_id: 'u-ravi',
  reserved_agent_id: 'sess-1',
  state: 'ended',
  outcome: 'connected',
  disposition_code: 'NOT_INTERESTED',
  notes: 'asked to be called back next quarter',
  callback_at: null,
  dispositioned_by_user_id: 'u-ravi',
  dispositioned_at: '2026-08-01T10:00:00.000Z',
  dispositioned_on_behalf: false,
  webrtc_call_id: 'call-1',
  dialed_at: '2026-08-01T09:59:00.000Z',
  answered_at: '2026-08-01T09:59:10.000Z',
  bridged_at: '2026-08-01T09:59:11.000Z',
  ended_at: '2026-08-01T09:59:50.000Z',
  talk_seconds: 39,
  wrapup_seconds: 10,
  created_at: '2026-08-01T09:58:00.000Z',
};

/** An attempt that never left the building — no call was ever placed. */
const ATTEMPT_NO_CALL = { ...ATTEMPT, id: ATTEMPT_ID_2, webrtc_call_id: null, state: 'failed', outcome: null };

const CALL = {
  id: 'call-1',
  tenant_id: 't1',
  account_id: 'a1',
  caller_id: '+14155550100',
  destination_phone: '+14155550199',
  provider: 'vobiz',
  provider_call_id: 'p-1',
  status: 'completed',
  outcome: 'answered',
  error_code: null,
  error_message: null,
  initiated_by: 'u-ravi',
  metadata: {},
  recording_requested: true,
  recording_url: 'https://carrier/rec.wav',
  recording_duration_seconds: 40,
  analysis_profile_id: null,
  analysis_status: null,
  call_analysis: null,
  conversation_log: null,
  transcript_meta: null,
  campaign_id: 'c1',
  agency_attempt_id: ATTEMPT_ID,
  answered_at: '2026-08-01T09:59:10.000Z',
  ended_at: '2026-08-01T09:59:50.000Z',
  duration_seconds: 50,
  talk_time_seconds: 39,
  created_at: '2026-08-01T09:58:00.000Z',
  updated_at: '2026-08-01T10:00:00.000Z',
};

const BASE = `/api/v1/agency-campaigns/c1/attempts/${ATTEMPT_ID}`;

async function makeApp() {
  const app = Fastify();
  await app.register((a) => agencyCampaignRoutes(a as never, DEPS), { prefix: '/api/v1/agency-campaigns' });
  await app.ready();
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  flags.isEnabled.mockResolvedValue(true);
  campaigns.findById.mockResolvedValue(CAMPAIGN);
  attempts.findForCampaign.mockResolvedValue(ATTEMPT);
  webrtc.findByIdScoped.mockResolvedValue(CALL);
  proxySpy.mockImplementation(async (_call, _req, reply) => reply.send({ streamed: true }));
  signSpy.mockReturnValue({
    path: '/api/v1/webrtc-recordings/call-1?sig=x',
    expiresAt: new Date('2026-08-24T12:00:00.000Z'),
  });
});

describe('agency call read — the plugin actually authenticates', () => {
  /**
   * Not a status assertion, deliberately. A route that was never registered
   * answers 404 too, so a 401/404 expectation would pass against a missing route
   * and hide the failure this test is for.
   */
  it.each([
    ['detail', BASE],
    ['recording', `${BASE}/recording`],
    ['recording-url', `${BASE}/recording-url`],
  ])('runs authMiddleware on the %s route', async (_name, url) => {
    const app = await makeApp();
    await app.inject({ method: 'GET', url, headers: HEADERS });
    expect(authSpy).toHaveBeenCalled();
    await app.close();
  });

  it.each([
    ['detail', BASE],
    ['recording', `${BASE}/recording`],
    ['recording-url', `${BASE}/recording-url`],
  ])('gates the %s route on agency_dialer_enabled', async (_name, url) => {
    flags.isEnabled.mockResolvedValue(false);
    const app = await makeApp();
    const res = await app.inject({ method: 'GET', url, headers: HEADERS });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('feature_disabled');
    await app.close();
  });
});

describe('agency call read — scoping', () => {
  it("404s when the campaign belongs to another tenant", async () => {
    campaigns.findById.mockResolvedValue({ ...CAMPAIGN, tenant_id: 'other' });
    const app = await makeApp();
    const res = await app.inject({ method: 'GET', url: BASE, headers: HEADERS });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('campaign_not_found');
    await app.close();
  });

  it('404s when the attempt is not on this campaign', async () => {
    attempts.findForCampaign.mockResolvedValue(null);
    const app = await makeApp();
    const res = await app.inject({ method: 'GET', url: BASE, headers: HEADERS });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('attempt_not_found');
    await app.close();
  });

  /**
   * A non-UUID attemptId would reach Postgres as `22P02` and surface as a 500 — a
   * bad request that looks like a broken service on a read route. 404 is both the
   * honest status and the one that keeps a malformed id indistinguishable from one
   * on someone else's campaign. The query must not be issued at all.
   */
  it('404s a malformed attempt id without querying', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'GET', url: '/api/v1/agency-campaigns/c1/attempts/not-a-uuid', headers: HEADERS,
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('attempt_not_found');
    expect(attempts.findForCampaign).not.toHaveBeenCalled();
    await app.close();
  });

  it('looks the attempt up campaign-scoped, so a foreign attempt id cannot be substituted', async () => {
    const app = await makeApp();
    await app.inject({ method: 'GET', url: BASE, headers: HEADERS });
    expect(attempts.findForCampaign).toHaveBeenCalledWith('c1', ATTEMPT_ID);
    await app.close();
  });

  /**
   * The whole point of the repository's scope parameter. This surface reads the
   * agency population; the softphone's plugin reads the other one. Asking for
   * 'dialer' here would 404 every agency call — which is what the old cross-shell
   * link effectively did.
   */
  it("reads the call under the 'agency' scope, with tenant and account bound", async () => {
    const app = await makeApp();
    await app.inject({ method: 'GET', url: BASE, headers: HEADERS });
    expect(webrtc.findByIdScoped).toHaveBeenCalledWith('call-1', 't1', 'a1', 'agency');
    await app.close();
  });
});

describe('agency call read — the three availability states', () => {
  it('serves the attempt and the call when the call is there', async () => {
    const app = await makeApp();
    const res = await app.inject({ method: 'GET', url: BASE, headers: HEADERS });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.call_availability).toBe('available');
    expect(body.attempt.id).toBe(ATTEMPT_ID);
    expect(body.call.id).toBe('call-1');
    await app.close();
  });

  /**
   * The requirement this route exists to satisfy. The attempt outlived its call,
   * and the reader must still get the attempt — the disposition, the notes, who
   * dialled and when — with the call reported as gone.
   */
  it('serves the attempt with a purged marker, NOT a 404, when the call row is gone', async () => {
    webrtc.findByIdScoped.mockResolvedValue(null);
    const app = await makeApp();
    const res = await app.inject({ method: 'GET', url: BASE, headers: HEADERS });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.call_availability).toBe('purged');
    expect(body.call).toBeNull();
    // The audit trail the un-FK'd link exists to protect must survive.
    expect(body.attempt.disposition_code).toBe('NOT_INTERESTED');
    expect(body.attempt.notes).toBe('asked to be called back next quarter');
    expect(body.attempt.agent_user_id).toBe('u-ravi');
    await app.close();
  });

  /**
   * Distinct from `purged`, and the distinction is not cosmetic: "we never dialled
   * this number" and "we dialled it and the recording has expired" are different
   * answers to a compliance question.
   */
  it("reports 'never_placed' when the attempt has no call id, without reading the call table", async () => {
    attempts.findForCampaign.mockResolvedValue(ATTEMPT_NO_CALL);
    const app = await makeApp();
    const res = await app.inject({
      method: 'GET', url: `/api/v1/agency-campaigns/c1/attempts/${ATTEMPT_ID_2}`, headers: HEADERS,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().call_availability).toBe('never_placed');
    expect(res.json().call).toBeNull();
    expect(webrtc.findByIdScoped).not.toHaveBeenCalled();
    await app.close();
  });
});

describe('agency call read — the recording path it advertises', () => {
  /**
   * The softphone's path would 404 for an agency leg, because that plugin's reads
   * are pinned to the dialer scope. Handing the console a link into it is the
   * cross-shell bug in miniature.
   */
  it('points recording_url at this campaign attempt, never at /webrtc-call', async () => {
    const app = await makeApp();
    const res = await app.inject({ method: 'GET', url: BASE, headers: HEADERS });

    expect(res.json().call.recording_url)
      .toBe(`/api/v1/agency-campaigns/c1/attempts/${ATTEMPT_ID}/recording`);
    expect(res.json().call.recording_url).not.toContain('/webrtc-call');
    await app.close();
  });

  it('never leaks the raw carrier media URL', async () => {
    const app = await makeApp();
    const res = await app.inject({ method: 'GET', url: BASE, headers: HEADERS });
    expect(JSON.stringify(res.json())).not.toContain('carrier/rec.wav');
    await app.close();
  });

  /**
   * `campaign_id` is the internal scope discriminator. A client that branched on
   * it would be reimplementing a boundary the server already enforces.
   */
  it('does not expose campaign_id on the call', async () => {
    const app = await makeApp();
    const res = await app.inject({ method: 'GET', url: BASE, headers: HEADERS });
    expect(res.json().call).not.toHaveProperty('campaign_id');
    await app.close();
  });
});

describe('agency call read — recording streaming', () => {
  it('streams through the authenticated proxy when the call is there', async () => {
    const app = await makeApp();
    const res = await app.inject({ method: 'GET', url: `${BASE}/recording`, headers: HEADERS });

    expect(res.statusCode).toBe(200);
    expect(proxySpy).toHaveBeenCalledTimes(1);
    expect((proxySpy.mock.calls[0]![0] as { id: string }).id).toBe('call-1');
    // The configured allow-list is the one handed over, by identity — not a copy,
    // not a default (`proxyCallRecording` refuses every host on an empty list).
    expect((proxySpy.mock.calls[0] as unknown[])[3]).toBe(RECORDING_HOSTS);
    await app.close();
  });

  it('404s with call_purged rather than streaming nothing', async () => {
    webrtc.findByIdScoped.mockResolvedValue(null);
    const app = await makeApp();
    const res = await app.inject({ method: 'GET', url: `${BASE}/recording`, headers: HEADERS });

    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('call_purged');
    expect(proxySpy).not.toHaveBeenCalled();
    await app.close();
  });

  it('404s with call_never_placed when no call was ever made', async () => {
    attempts.findForCampaign.mockResolvedValue(ATTEMPT_NO_CALL);
    const app = await makeApp();
    const res = await app.inject({
      method: 'GET', url: `/api/v1/agency-campaigns/c1/attempts/${ATTEMPT_ID_2}/recording`, headers: HEADERS,
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('call_never_placed');
    await app.close();
  });
});

describe('agency call read — signed recording URL', () => {
  /**
   * The shared playback route at /api/v1/webrtc-recordings is deliberately
   * scope-agnostic: the signed token IS the authorization, and every minter is
   * scope-gated. This route is the agency-gated minter.
   */
  it('mints a token against the shared playback proxy', async () => {
    const app = await makeApp();
    const res = await app.inject({ method: 'GET', url: `${BASE}/recording-url`, headers: HEADERS });

    expect(res.statusCode).toBe(200);
    expect(signSpy).toHaveBeenCalledWith({
      callId: 'call-1', tenantId: 't1', accountId: 'a1', basePath: '/api/v1/webrtc-recordings',
    });
    expect(res.json().url).toContain('/api/v1/webrtc-recordings/');
    // Same emitted shape as `/webrtc-call/:id/recording-url` and
    // `/calls/:id/recording-url`: an ISO-8601 string. Worth being exact about what
    // this does and does not catch, because the handler used to send the raw Date
    // and that mutation does NOT fail here — Fastify's default serializer
    // JSON.stringify's a Date to these same characters, so the two surfaces always
    // agreed on the wire and differed only in the handler. What this pins is the
    // wire contract itself: an epoch number, a `Date` under a future response
    // schema, or a formatted local time all break it, and a console reading both
    // products must not have to tell the two fields apart.
    expect(res.json().expires_at).toBe('2026-08-24T12:00:00.000Z');
    await app.close();
  });

  // A VoiceLink leg's recording is a public file on a host our egress cannot
  // reach, so a signed URL — which resolves back through our proxy — would 502 on
  // a file the browser can fetch itself. Same branch as the softphone twin and AI
  // calls; this asserts the agency minter did not get left behind.
  const VOICELINK_URL =
    'https://voiceflowai.elisiontec.com/voiceapp-recordings/client_1150/2026-07-11/abc.mp3';

  it('returns a direct provider URL raw, without minting a token', async () => {
    webrtc.findByIdScoped.mockResolvedValue({
      ...CALL, provider: 'voicelink', recording_url: VOICELINK_URL,
    });
    const app = await makeApp();
    const res = await app.inject({ method: 'GET', url: `${BASE}/recording-url`, headers: HEADERS });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ url: VOICELINK_URL, expires_at: null });
    expect(signSpy).not.toHaveBeenCalled();
    await app.close();
  });

  it('still 404s for a direct provider with no recording (the raw branch is not a bypass)', async () => {
    webrtc.findByIdScoped.mockResolvedValue({ ...CALL, provider: 'voicelink', recording_url: null });
    const app = await makeApp();
    const res = await app.inject({ method: 'GET', url: `${BASE}/recording-url`, headers: HEADERS });

    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('no_recording');
    expect(signSpy).not.toHaveBeenCalled();
    await app.close();
  });

  it('404s when the call carries no recording, without minting a token', async () => {
    webrtc.findByIdScoped.mockResolvedValue({ ...CALL, recording_url: null });
    const app = await makeApp();
    const res = await app.inject({ method: 'GET', url: `${BASE}/recording-url`, headers: HEADERS });

    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('no_recording');
    expect(signSpy).not.toHaveBeenCalled();
    await app.close();
  });

  it('404s with call_purged when the call is gone, without minting a token', async () => {
    webrtc.findByIdScoped.mockResolvedValue(null);
    const app = await makeApp();
    const res = await app.inject({ method: 'GET', url: `${BASE}/recording-url`, headers: HEADERS });

    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('call_purged');
    expect(signSpy).not.toHaveBeenCalled();
    await app.close();
  });
});
