import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';

// ---------------------------------------------------------------------------
// Configuring the apology, at the route.
//
// Migration 080 and the dial-time resolver both landed before ANYTHING could
// write `abandon_announcement_id`, so the whole clip half of the feature was
// unreachable from outside while every test of the playback path passed. The property is "an operator can set an apology and only
// their own", and neither half is observable below the route.
//
// The dial-time resolver deliberately fails quiet — a customer is already on the
// line by then — which is why the ownership check has to be HERE, where a
// mistake is a status code someone reads instead of an apology that silently
// never plays.
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

const { flags } = vi.hoisted(() => ({ flags: { isEnabled: vi.fn().mockResolvedValue(true) } }));
vi.mock('../../../src/feature-flags/index.js', () => ({
  getFeatureFlagService: () => flags,
  FLAGS: { agency_dialer_enabled: { default: false } },
}));

vi.mock('../../../src/audit/audit-logger.js', () => ({ auditLogger: { log: vi.fn() } }));

const { campaigns, announcementRepo } = vi.hoisted(() => ({
  campaigns: { create: vi.fn(), update: vi.fn(), findById: vi.fn() },
  announcementRepo: { findActiveByIdScoped: vi.fn() },
}));
vi.mock('../../../src/db/repositories/agency.repository.js', () => ({
  agencyCampaignRepository: campaigns,
}));
vi.mock('@magick-agency/db/repositories/announcement.repository', () => ({
  announcementRepository: announcementRepo,
}));

import { agencyCampaignRoutes } from '../../../src/api/routes/agency-campaigns.routes.js';

/**
 * This plugin takes dependencies, for the stats route's health strip
 * only. Every test in this file exercises a DIFFERENT route, so the stubs exist
 * to satisfy the signature and are deliberately not exercised — a stub that
 * returned plausible health data here would invite an assertion about a surface
 * this file does not cover.
 */
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
  caller_ids: ['+14155550100'], abandon_announcement_id: null,
};

async function makeApp() {
  const app = Fastify();
  await app.register((a) => agencyCampaignRoutes(a as never, HEALTH_DEPS), { prefix: '/api/v1/agency-campaigns' });
  await app.ready();
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  flags.isEnabled.mockResolvedValue(true);
  campaigns.findById.mockResolvedValue(CAMPAIGN_ROW);
  campaigns.create.mockImplementation(async (i: any) => ({ ...CAMPAIGN_ROW, ...i }));
  campaigns.update.mockImplementation(async (_id: string, p: any) => ({ ...CAMPAIGN_ROW, ...p }));
  announcementRepo.findActiveByIdScoped.mockResolvedValue({ id: 'ann-1', tenant_id: 't1', account_id: 'a1' });
});

describe('POST /agency-campaigns · the apology can be set at creation', () => {
  it('persists abandon_announcement_id', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST', url: '/api/v1/agency-campaigns', headers: HEADERS,
      payload: { name: 'Q3', caller_ids: ['+14155550100'], abandon_announcement_id: 'ann-1' },
    });

    expect(res.statusCode).toBe(201);
    expect(campaigns.create).toHaveBeenCalledWith(
      expect.objectContaining({ abandon_announcement_id: 'ann-1' }),
    );
  });

  it('defaults to null — an unconfigured campaign still dials', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST', url: '/api/v1/agency-campaigns', headers: HEADERS,
      payload: { name: 'Q3', caller_ids: ['+14155550100'] },
    });

    expect(res.statusCode).toBe(201);
    expect(campaigns.create.mock.calls[0]![0].abandon_announcement_id).toBeNull();
    // Fail-quiet, not fail-closed: an operator who has not written an apology must
    // not have their campaign refuse to dial (migration 080's rationale).
    expect(announcementRepo.findActiveByIdScoped).not.toHaveBeenCalled();
  });

  it('REFUSES an announcement belonging to another account', async () => {
    // The dial-time resolver looks the announcement up by id ALONE, so an
    // unchecked id here is a route to playing another tenant's recorded audio to
    // our customer. Scoped lookup, and a 404 rather than a 403 so the existence of
    // someone else's announcement is not confirmed.
    announcementRepo.findActiveByIdScoped.mockResolvedValue(null);
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST', url: '/api/v1/agency-campaigns', headers: HEADERS,
      payload: { name: 'Q3', caller_ids: ['+14155550100'], abandon_announcement_id: 'someone-elses' },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('announcement_not_found');
    // Nothing was written. A campaign half-created with a rejected apology would
    // leave the operator with a campaign they did not ask for.
    expect(campaigns.create).not.toHaveBeenCalled();
    expect(announcementRepo.findActiveByIdScoped).toHaveBeenCalledWith('someone-elses', 't1', 'a1');
  });
});

describe('PATCH /agency-campaigns/:id · the apology can be added later', () => {
  it('accepts a valid announcement', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'PATCH', url: '/api/v1/agency-campaigns/camp-1', headers: HEADERS,
      payload: { abandon_announcement_id: 'ann-1' },
    });

    expect(res.statusCode).toBe(200);
    expect(campaigns.update).toHaveBeenCalledWith('camp-1', { abandon_announcement_id: 'ann-1' });
  });

  it('accepts null to clear it, without a lookup', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'PATCH', url: '/api/v1/agency-campaigns/camp-1', headers: HEADERS,
      payload: { abandon_announcement_id: null },
    });

    expect(res.statusCode).toBe(200);
    // The null must SURVIVE to the repository. If the route dropped it the
    // operator could never remove a wrong apology, only replace it.
    expect(campaigns.update).toHaveBeenCalledWith('camp-1', { abandon_announcement_id: null });
    expect(announcementRepo.findActiveByIdScoped).not.toHaveBeenCalled();
  });

  it('REFUSES a foreign announcement on the PATCH too, not only on create', async () => {
    announcementRepo.findActiveByIdScoped.mockResolvedValue(null);
    const app = await makeApp();
    const res = await app.inject({
      method: 'PATCH', url: '/api/v1/agency-campaigns/camp-1', headers: HEADERS,
      payload: { abandon_announcement_id: 'someone-elses' },
    });

    expect(res.statusCode).toBe(404);
    expect(campaigns.update).not.toHaveBeenCalled();
  });

  it('rejects a non-string, non-null value as a 400', async () => {
    const app = await makeApp();
    for (const abandon_announcement_id of [42, true, {}, '', '   ']) {
      campaigns.update.mockClear();
      const res = await app.inject({
        method: 'PATCH', url: '/api/v1/agency-campaigns/camp-1', headers: HEADERS,
        payload: { abandon_announcement_id },
      });
      expect(res.statusCode, `value ${JSON.stringify(abandon_announcement_id)}`).toBe(400);
      expect(campaigns.update).not.toHaveBeenCalled();
    }
  });

  it('leaves the field alone when the PATCH does not mention it', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'PATCH', url: '/api/v1/agency-campaigns/camp-1', headers: HEADERS,
      payload: { name: 'Renamed' },
    });

    expect(res.statusCode).toBe(200);
    expect(announcementRepo.findActiveByIdScoped).not.toHaveBeenCalled();
    expect(campaigns.update).toHaveBeenCalledWith('camp-1', { name: 'Renamed' });
  });
});
