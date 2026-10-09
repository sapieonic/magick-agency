import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';

// ---------------------------------------------------------------------------
// Recording + analysis opt-in, at the campaign route.
//
// Two properties, and only one of them was already true.
//
// (c) recording is off by default. The column DEFAULT is `false` and
//     `AgencyCampaignRepository.create` COALESCEs to `false`; what is asserted
//     here is the ROUTE half — that an omitted `record_calls` reaches the
//     repository as "unset" rather than being coerced to anything truthy.
//
// (b) an agency call's analysis job must be identical in shape to a dialer
//     call's. `POST /api/v1/webrtc-call` preflights its `analysis_profile_id`
//     (flag on, profile owned + active) but the campaign — the SECOND writer of
//     the same `webrtc_calls.analysis_profile_id` column, via the dial-time
//     stamp in `agency-dialer` — did not. The end-of-call gate then resolves it
//     with the UNSCOPED `callAnalysisProfileRepository.findById`, so a foreign
//     id snapshotted another tenant's `context` and `custom_dimensions` into
//     this campaign's job. Same helper on both writers now, which is the only
//     thing that stops them drifting again.
//
// NOT tested here, and deliberately: the `agency.recording` / `agency.analytics`
// GOVERNANCE capabilities. The voice engine cannot evaluate one (see contracts.ts:1230) —
// the public API layer owns that gate, and a guard with both operands in one place would
// prove nothing about the contract.
// ---------------------------------------------------------------------------

vi.mock('@magick-agency/observability', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@magick-agency/observability')>()),
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
  createChildLogger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('../../../src/config/index.js', () => ({
  config: {
    redis: { keyPrefix: '' },
    telephony: { vobiz: { webhookBaseUrl: 'https://server.test/api/v1/webhooks/vobiz' } },
  },
}));

vi.mock('../../../src/api/middleware/auth.middleware.js', () => ({
  authMiddleware: vi.fn(async () => { /* authenticated */ }),
  getTenantId: (req: any) => req.headers['x-mgkvc-tenant'] ?? 't1',
  getAccountId: (req: any) => req.headers['x-mgkvc-account'] ?? 'a1',
  getOriginator: () => null,
}));

// THREE different flags run through one service here — `agency_dialer_enabled`
// gates the route, `agency_call_analysis` gates the profile on this (agency)
// surface, and a `dialer_call_analysis` flag is present so a test can prove a
// non-agency flag is NOT what gates it. The mock must answer per flag or the cases below
// would be indistinguishable.
const { flagState, flags, FLAGS } = vi.hoisted(() => {
  const FLAGS = {
    agency_dialer_enabled: { key: 'agency_dialer_enabled', default: false },
    dialer_call_analysis: { key: 'dialer_call_analysis', default: false },
    agency_call_analysis: { key: 'agency_call_analysis', default: false },
  };
  const flagState: Record<string, boolean> = {
    agency_dialer_enabled: true,
    dialer_call_analysis: true,
    agency_call_analysis: true,
  };
  return {
    FLAGS,
    flagState,
    flags: {
      isEnabled: vi.fn(async (flag: { key: string }) => flagState[flag.key] ?? false),
    },
  };
});
vi.mock('../../../src/feature-flags/index.js', () => ({
  getFeatureFlagService: () => flags,
  FLAGS,
}));

vi.mock('../../../src/audit/audit-logger.js', () => ({ auditLogger: { log: vi.fn() } }));

const { campaigns, announcementRepo, profileRepo } = vi.hoisted(() => ({
  campaigns: { create: vi.fn(), update: vi.fn(), findById: vi.fn() },
  announcementRepo: { findActiveByIdScoped: vi.fn() },
  profileRepo: { findByIdScoped: vi.fn() },
}));
vi.mock('../../../src/db/repositories/agency.repository.js', () => ({
  agencyCampaignRepository: campaigns,
}));
vi.mock('@magick-agency/db/repositories/announcement.repository', () => ({
  announcementRepository: announcementRepo,
}));
vi.mock('@magick-agency/db/repositories/call-analysis-profile.repository', () => ({
  callAnalysisProfileRepository: profileRepo,
}));

import { agencyCampaignRoutes } from '../../../src/api/routes/agency-campaigns.routes.js';

/** Stats-route dependencies only; no test here exercises that surface. */
const HEALTH_DEPS = {
  runtime: { dnc: { appliedVersion: async () => 1 } },
  callManager: {
    accountConcurrencyGuard: {
      getDistributedAccountCount: async () => ({ status: 'unavailable' as const }),
    },
  },
} as unknown as Parameters<typeof agencyCampaignRoutes>[1];

const HEADERS = { 'x-mgkvc-tenant': 't1', 'x-mgkvc-account': 'a1' };

const CAMPAIGN_ROW = {
  id: 'camp-1', tenant_id: 't1', account_id: 'a1', name: 'Q3 Renewals',
  caller_ids: ['+14155550100'], record_calls: false, analysis_profile_id: null,
};

async function makeApp() {
  const app = Fastify();
  await app.register((a) => agencyCampaignRoutes(a as never, HEALTH_DEPS), { prefix: '/api/v1/agency-campaigns' });
  await app.ready();
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  flagState.agency_dialer_enabled = true;
  flagState.dialer_call_analysis = true;
  flagState.agency_call_analysis = true;
  campaigns.findById.mockResolvedValue(CAMPAIGN_ROW);
  campaigns.create.mockImplementation(async (i: any) => ({ ...CAMPAIGN_ROW, ...i }));
  campaigns.update.mockImplementation(async (_id: string, p: any) => ({ ...CAMPAIGN_ROW, ...p }));
  announcementRepo.findActiveByIdScoped.mockResolvedValue({ id: 'ann-1', tenant_id: 't1', account_id: 'a1' });
  profileRepo.findByIdScoped.mockResolvedValue({ id: 'prof-1', tenant_id: 't1', account_id: 'a1', is_active: true });
});

describe('POST /agency-campaigns · recording is off by default (c)', () => {
  it('an omitted record_calls is passed through as unset, never coerced true', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST', url: '/api/v1/agency-campaigns', headers: HEADERS,
      payload: { name: 'Q3', caller_ids: ['+14155550100'] },
    });

    expect(res.statusCode).toBe(201);
    // `undefined`, so the repository's `?? null` reaches `COALESCE($17,false)`
    // and the column DEFAULT applies. Anything else here — `false` included
    // — would be the route inventing a value the operator did not send.
    expect(campaigns.create.mock.calls[0]![0].record_calls).toBeUndefined();
  });

  it('an explicit record_calls: true is honoured', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST', url: '/api/v1/agency-campaigns', headers: HEADERS,
      payload: { name: 'Q3', caller_ids: ['+14155550100'], record_calls: true },
    });

    expect(res.statusCode).toBe(201);
    expect(campaigns.create.mock.calls[0]![0].record_calls).toBe(true);
  });
});

describe('POST /agency-campaigns · the analysis profile is preflighted (b)', () => {
  it('persists a profile the account owns', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST', url: '/api/v1/agency-campaigns', headers: HEADERS,
      payload: { name: 'Q3', caller_ids: ['+14155550100'], analysis_profile_id: 'prof-1' },
    });

    expect(res.statusCode).toBe(201);
    expect(profileRepo.findByIdScoped).toHaveBeenCalledWith('prof-1', 't1', 'a1');
    expect(campaigns.create).toHaveBeenCalledWith(
      expect.objectContaining({ analysis_profile_id: 'prof-1' }),
    );
  });

  it('no profile ⇒ no lookup, and the campaign still creates', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST', url: '/api/v1/agency-campaigns', headers: HEADERS,
      payload: { name: 'Q3', caller_ids: ['+14155550100'] },
    });

    expect(res.statusCode).toBe(201);
    expect(campaigns.create.mock.calls[0]![0].analysis_profile_id).toBeNull();
    expect(profileRepo.findByIdScoped).not.toHaveBeenCalled();
    // Not analysis-gated either — a campaign that does not analyse must not need
    // either analysis flag to exist.
    expect(flags.isEnabled).not.toHaveBeenCalledWith(
      expect.objectContaining({ key: 'agency_call_analysis' }), expect.anything(),
    );
    expect(flags.isEnabled).not.toHaveBeenCalledWith(
      expect.objectContaining({ key: 'dialer_call_analysis' }), expect.anything(),
    );
  });

  it('REFUSES a profile belonging to another account (404, nothing written)', async () => {
    // The end-of-call gate resolves this id with an UNSCOPED findById, so an
    // unchecked id here leaks another tenant's analysis context and custom
    // dimensions into this campaign's job. 404 rather than 403 — the same
    // reasoning as the apology: do not confirm someone else's profile exists.
    profileRepo.findByIdScoped.mockResolvedValue(null);
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST', url: '/api/v1/agency-campaigns', headers: HEADERS,
      payload: { name: 'Q3', caller_ids: ['+14155550100'], analysis_profile_id: 'someone-elses' },
    });

    expect(res.statusCode).toBe(404);
    expect(campaigns.create).not.toHaveBeenCalled();
    expect(profileRepo.findByIdScoped).toHaveBeenCalledWith('someone-elses', 't1', 'a1');
    // The `code` is what carries this refusal past the public API layer's error mask.
    // Without it the body is unstructured — no code, no allow-listed label, no
    // `details` — and the mask rewrites it to "contact support and quote this
    // request id". That would lose the ONE refusal here an operator can fix in a
    // single click (pick a different profile), while preserving the ones they
    // cannot act on. Asserting the code, not just the status, is the point.
    expect(res.json().code).toBe('analysis_profile_not_found');
  });

  it('REFUSES a profile when agency_call_analysis is off (403), as the dialer does on its own flag', async () => {
    flagState.agency_call_analysis = false;
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST', url: '/api/v1/agency-campaigns', headers: HEADERS,
      payload: { name: 'Q3', caller_ids: ['+14155550100'], analysis_profile_id: 'prof-1' },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('Feature Not Enabled');
    expect(res.json().code).toBe('analysis_not_enabled');
    // Named for what the operator is editing. "Dialer call analysis is not
    // enabled" on an agency campaign sends them looking for a switch that is not
    // where this one is.
    expect(res.json().message).toBe('Agency call analysis is not enabled for this account.');
    expect(campaigns.create).not.toHaveBeenCalled();
    // The flag decided it — no point spending the lookup.
    expect(profileRepo.findByIdScoped).not.toHaveBeenCalled();
  });

  /**
   * The C2 defect, from the other side. Analysis EXECUTION for an agency leg is
   * gated on `agency_call_analysis` (`webrtc-bridge-manager.ts`), and this preflight
   * asked `dialer_call_analysis` — so an agency-only tenant, the one the sibling
   * flag exists to serve, had analysis running on every campaign call while every
   * edit that named a profile 403'd. Asserted as a permitted write rather than as
   * "the flag was not consulted", because the shape that must not come back is the
   * refusal.
   */
  it('does NOT consult the dialer_call_analysis flag: agency analysis on, dialer analysis off, campaign saves', async () => {
    flagState.agency_call_analysis = true;
    flagState.dialer_call_analysis = false;
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST', url: '/api/v1/agency-campaigns', headers: HEADERS,
      payload: { name: 'Q3', caller_ids: ['+14155550100'], analysis_profile_id: 'prof-1' },
    });

    expect(res.statusCode).toBe(201);
    expect(campaigns.create.mock.calls[0]![0].analysis_profile_id).toBe('prof-1');
    expect(flags.isEnabled).not.toHaveBeenCalledWith(
      expect.objectContaining({ key: 'dialer_call_analysis' }), expect.anything(),
    );
  });

  /** And the PATCH, which is the surface an operator actually re-points a live campaign from. */
  it('does not consult the dialer_call_analysis flag on the PATCH either', async () => {
    flagState.agency_call_analysis = true;
    flagState.dialer_call_analysis = false;
    const app = await makeApp();
    const res = await app.inject({
      method: 'PATCH', url: '/api/v1/agency-campaigns/camp-1', headers: HEADERS,
      payload: { analysis_profile_id: 'prof-1' },
    });

    expect(res.statusCode).toBe(200);
    expect(campaigns.update).toHaveBeenCalled();
  });

  it('rejects a non-string, non-null value as a 400', async () => {
    const app = await makeApp();
    for (const analysis_profile_id of [42, true, {}, '', '   ']) {
      campaigns.create.mockClear();
      const res = await app.inject({
        method: 'POST', url: '/api/v1/agency-campaigns', headers: HEADERS,
        payload: { name: 'Q3', caller_ids: ['+14155550100'], analysis_profile_id },
      });
      expect(res.statusCode, `value ${JSON.stringify(analysis_profile_id)}`).toBe(400);
      expect(campaigns.create).not.toHaveBeenCalled();
    }
  });
});

describe('PATCH /agency-campaigns/:id · the same check, after the fact', () => {
  it('accepts a profile the account owns', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'PATCH', url: '/api/v1/agency-campaigns/camp-1', headers: HEADERS,
      payload: { analysis_profile_id: 'prof-1' },
    });

    expect(res.statusCode).toBe(200);
    expect(campaigns.update).toHaveBeenCalledWith('camp-1', { analysis_profile_id: 'prof-1' });
  });

  it('REFUSES a foreign profile on the PATCH too — config is edited, not just created', async () => {
    profileRepo.findByIdScoped.mockResolvedValue(null);
    const app = await makeApp();
    const res = await app.inject({
      method: 'PATCH', url: '/api/v1/agency-campaigns/camp-1', headers: HEADERS,
      payload: { analysis_profile_id: 'someone-elses' },
    });

    expect(res.statusCode).toBe(404);
    expect(campaigns.update).not.toHaveBeenCalled();
  });

  it('accepts null to clear it, without a lookup or a flag check', async () => {
    flagState.dialer_call_analysis = false;
    const app = await makeApp();
    const res = await app.inject({
      method: 'PATCH', url: '/api/v1/agency-campaigns/camp-1', headers: HEADERS,
      payload: { analysis_profile_id: null },
    });

    // Turning analysis OFF must never require analysis to be enabled — otherwise
    // flipping the flag off strands every campaign with a profile set.
    expect(res.statusCode).toBe(200);
    expect(campaigns.update).toHaveBeenCalledWith('camp-1', { analysis_profile_id: null });
    expect(profileRepo.findByIdScoped).not.toHaveBeenCalled();
  });

  it('leaves the field alone when the PATCH does not mention it', async () => {
    flagState.dialer_call_analysis = false;
    const app = await makeApp();
    const res = await app.inject({
      method: 'PATCH', url: '/api/v1/agency-campaigns/camp-1', headers: HEADERS,
      payload: { record_calls: true },
    });

    // A PATCH of an unrelated field must not 403 because the analysis flag is
    // off — the guard is on the key's PRESENCE, not on the stored value.
    expect(res.statusCode).toBe(200);
    expect(campaigns.update).toHaveBeenCalledWith('camp-1', { record_calls: true });
    expect(profileRepo.findByIdScoped).not.toHaveBeenCalled();
  });
});
