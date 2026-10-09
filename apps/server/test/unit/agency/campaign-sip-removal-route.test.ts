import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';

/*
 * NEW (magick-agency, Phase 8), no source twin: the equivalence tests for the two
 * SIP-deletion changes in `src/api/routes/agency-campaigns.routes.ts` (plan §2: SIP is
 * deleted, and with it `sip_connection_id`, which the baseline, `AgencyCampaignRecord`
 * and the repository's INSERT no longer carry).
 *
 *  1. `POST /` no longer passes `sip_connection_id` to `agencyCampaignRepository.create`
 *     (core `agency-campaigns.routes.ts:451`@4850d1d9). Everything else it passed is
 *     unchanged.
 *  2. The retry create reads its config keys from `RETRY_CONFIG_KEYS`, the shared
 *     `RETRY_INHERITED_CONFIG_KEYS` (lane B1's verbatim leaf, which still names
 *     `sip_connection_id`) minus that one key. So the child inherits exactly every other
 *     key core's did, and an override naming `sip_connection_id` is refused with the 400
 *     any other non-config key gets — not accepted and then dropped by the repository.
 *
 * Mocks are `campaign-retry-route.test.ts`'s.
 */

vi.mock('@magick-agency/observability', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@magick-agency/observability')>()),
  createChildLogger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('../../../src/api/middleware/auth.middleware.js', () => ({
  authMiddleware: vi.fn(async () => { /* authenticated */ }),
  getTenantId: () => 't1',
  getAccountId: () => 'a1',
  getOriginator: () => 'console',
}));

const { flags } = vi.hoisted(() => ({ flags: { isEnabled: vi.fn().mockResolvedValue(true) } }));
vi.mock('../../../src/feature-flags/index.js', () => ({
  getFeatureFlagService: () => flags,
  FLAGS: { agency_dialer_enabled: { default: false } },
}));

vi.mock('../../../src/audit/audit-logger.js', () => ({ auditLogger: { log: vi.fn() } }));

const { campaigns, preflight } = vi.hoisted(() => ({
  campaigns: { findById: vi.fn(), create: vi.fn(), retryFromCampaign: vi.fn() },
  preflight: { preflightAnalysisProfile: vi.fn().mockResolvedValue(null) },
}));
vi.mock('../../../src/db/repositories/agency.repository.js', () => ({
  agencyCampaignRepository: campaigns,
}));
vi.mock('@magick-agency/db/repositories/announcement.repository', () => ({
  announcementRepository: { findActiveByIdScoped: vi.fn().mockResolvedValue({ id: 'ann-1' }) },
}));
vi.mock('../../../src/analysis/profile-preflight.js', () => preflight);

import { agencyCampaignRoutes } from '../../../src/api/routes/agency-campaigns.routes.js';
import { RETRY_INHERITED_CONFIG_KEYS } from '@magick-agency/domain/retry-campaign-bounds';

const DEPS = {
  runtime: { dnc: { appliedVersion: async () => 1 }, stations: { connectedBySession: async () => new Map() } },
  callManager: {
    accountConcurrencyGuard: { getDistributedAccountCount: async () => ({ status: 'unavailable' as const }) },
  },
} as unknown as Parameters<typeof agencyCampaignRoutes>[1];

const HEADERS = { 'x-mgkvc-tenant': 't1', 'x-mgkvc-account': 'a1' };

/**
 * A parent that still CARRIES a `sip_connection_id` value (a row shape that cannot
 * exist on the baseline, which is the point: if the route read the key, this value
 * would surface in the child's config).
 */
const PARENT = {
  id: 'camp-parent', tenant_id: 't1', account_id: 'a1', name: 'Q3 Winback',
  caller_ids: ['+14155550100'], telephony_provider: 'voicelink', sip_connection_id: 'sip-legacy',
  calling_window_start: '09:00:00', calling_window_end: '20:00:00',
  calling_days: [1, 2, 3, 4, 5], default_timezone: 'UTC',
  wrapup_seconds: 30, wrapup_auto_return: true,
  retry_policy: {}, disposition_catalog: [{ code: 'not_interested', label: 'Not Interested' }],
  context_display: {}, break_reasons: [],
  record_calls: false, analysis_profile_id: null, abandon_announcement_id: null,
  abandonment_ceiling_pct: 3,
  status: 'completed', contacts_total: 4000,
  parent_campaign_id: null, root_campaign_id: null, retry_generation: 0, retry_selector: null,
};
const CHILD = { ...PARENT, id: 'camp-child', status: 'draft', retry_generation: 1 };

async function makeApp() {
  const app = Fastify();
  await app.register((a) => agencyCampaignRoutes(a as never, DEPS), { prefix: '/api/v1/agency-campaigns' });
  await app.ready();
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  flags.isEnabled.mockResolvedValue(true);
  campaigns.findById.mockResolvedValue(PARENT);
  campaigns.create.mockImplementation(async (i: Record<string, unknown>) => ({ ...PARENT, ...i, id: 'camp-new' }));
  campaigns.retryFromCampaign.mockResolvedValue({
    status: 'created', campaign: CHILD, contacts_seeded: 1, duplicates_collapsed: 0,
    excluded: { dnc: 0, invalid: 0 },
  });
});

describe('POST / no longer hands sip_connection_id to the repository', () => {
  it('omits the key even when the body sends one, and passes every other field as core did', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST', url: '/api/v1/agency-campaigns', headers: HEADERS,
      payload: { name: 'Q3', caller_ids: ['+14155550100'], sip_connection_id: 'sip-1', record_calls: true },
    });

    expect(res.statusCode).toBe(201);
    const input = campaigns.create.mock.calls[0]![0] as Record<string, unknown>;
    expect(input).not.toHaveProperty('sip_connection_id');
    // Core's create input, key for key, minus `sip_connection_id`.
    expect(Object.keys(input).sort()).toEqual([
      'abandon_announcement_id', 'abandonment_ceiling_pct', 'account_id', 'analysis_profile_id',
      'caller_ids', 'calling_days', 'calling_window_end', 'calling_window_start', 'context_display',
      'created_by', 'default_timezone', 'disposition_catalog', 'name', 'record_calls', 'retry_policy',
      'telephony_provider', 'tenant_id', 'wrapup_auto_return', 'wrapup_seconds',
    ]);
    expect(input.record_calls).toBe(true);
    await app.close();
  });
});

describe('retry create: RETRY_CONFIG_KEYS is the shared list minus sip_connection_id', () => {
  it('the child inherits EXACTLY the shared keys except sip_connection_id', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST', url: '/api/v1/agency-campaigns/camp-parent/retry', headers: HEADERS,
      payload: { selector: { state: ['pending'] } },
    });

    expect(res.statusCode).toBe(201);
    const [{ config }] = campaigns.retryFromCampaign.mock.calls[0]! as [{ config: Record<string, unknown> }];
    const expected = RETRY_INHERITED_CONFIG_KEYS.filter((k) => k !== 'sip_connection_id');
    // One key fewer than the shared list, and nothing else lost.
    expect(expected).toHaveLength(RETRY_INHERITED_CONFIG_KEYS.length - 1);
    expect(Object.keys(config).sort()).toEqual([...expected].sort());
    for (const key of expected) expect(config[key]).toEqual(PARENT[key as keyof typeof PARENT]);
    expect(JSON.stringify(config)).not.toContain('sip-legacy');
    await app.close();
  });

  it('an override naming sip_connection_id is refused BY NAME as a non-config field, and nothing is created', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST', url: '/api/v1/agency-campaigns/camp-parent/retry', headers: HEADERS,
      payload: { selector: { state: ['pending'] }, config_overrides: { sip_connection_id: 'sip-1' } },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({
      error: 'Validation failed',
      details: {
        sip_connection_id: 'sip_connection_id is not a campaign config field — a retry inherits everything else from its parent, and its name is set with `name`',
      },
    });
    expect(campaigns.retryFromCampaign).not.toHaveBeenCalled();
    await app.close();
  });

  it('every other shared key is still accepted as an override (the filter removes one key, not more)', async () => {
    const app = await makeApp();
    const overrides = { telephony_provider: 'voicelink', wrapup_seconds: 45, record_calls: true };
    const res = await app.inject({
      method: 'POST', url: '/api/v1/agency-campaigns/camp-parent/retry', headers: HEADERS,
      payload: { selector: { state: ['pending'] }, config_overrides: overrides },
    });

    expect(res.statusCode).toBe(201);
    const [{ config }] = campaigns.retryFromCampaign.mock.calls[0]! as [{ config: Record<string, unknown> }];
    expect(config).toMatchObject(overrides);
    await app.close();
  });
});
