import { beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';

/*
 * `concurrency` on the campaign stats (decisions MC7): the pure assembler, and the
 * route's wiring of it — which reads it makes, for which statuses, and that every
 * failure behind it degrades to `concurrency: null` rather than a 500 or a share of
 * zero. The SQL behind the three reads is pinned on real Postgres by
 * `test/integration/agency/agency-campaign-stats-concurrency.test.ts`.
 */

vi.mock('@magick-agency/observability', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@magick-agency/observability')>()),
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
  createChildLogger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('../../../src/config/index.js', () => ({
  config: { redis: { keyPrefix: '' }, agency: { campaignStatsCacheMs: 2_000 }, telephony: {} },
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

const { campaigns, attempts, accountSettings } = vi.hoisted(() => ({
  campaigns: { findById: vi.fn(), stats: vi.fn(), healthInputs: vi.fn(), countRunningForAccount: vi.fn() },
  attempts: { countLiveForAccount: vi.fn() },
  accountSettings: { getMaxConcurrentCalls: vi.fn() },
}));
vi.mock('../../../src/db/repositories/agency.repository.js', () => ({
  agencyCampaignRepository: campaigns,
  agencyAttemptRepository: attempts,
}));
vi.mock('@magick-agency/db/repositories/announcement.repository', () => ({
  announcementRepository: { findActiveByIdScoped: vi.fn() },
}));
vi.mock('@magick-agency/db/repositories/account-settings.repository', () => ({
  accountSettingsRepository: accountSettings,
}));

import { agencyCampaignRoutes } from '../../../src/api/routes/agency-campaigns.routes.js';
import { campaignConcurrency, CAMPAIGN_CONCURRENCY_STATUSES } from '../../../src/agency/campaign-concurrency.js';

const TENANT = 't1';
const ACCOUNT = 'a1';
const HEADERS = { 'x-mgkvc-tenant': TENANT, 'x-mgkvc-account': ACCOUNT };

const CAMPAIGN_ROW = {
  id: 'camp-1', tenant_id: TENANT, account_id: ACCOUNT,
  status: 'running', pause_reason: null, paused_at: null,
  pause_abandonment_rate_pct: null, abandonment_ceiling_pct: 3,
};

const STATS = {
  contacts_pending: 0, retries_pending: 0, agents_live: 0, attempts_live: 4,
  agents_by_state: { offline: 0, available: 0, reserved: 0, on_call: 0, wrapup: 0, break: 0 },
  agents: [],
};

const HEALTH_INPUTS = {
  pendingByTimezone: [], nextRetryAt: null, lastDialAt: null,
  recent: { attempts: 0, failed: 0 }, onBreakByReason: {},
};

function statsDeps() {
  return {
    runtime: {
      dnc: { appliedVersion: vi.fn(async () => 7) },
      stations: { connectedBySession: vi.fn(async () => new Map()) },
    },
    callManager: {
      accountConcurrencyGuard: {
        getDistributedAccountCount: vi.fn(async () => ({ status: 'available' as const, count: 6 })),
      },
    },
  } as unknown as Parameters<typeof agencyCampaignRoutes>[1];
}

async function getStats() {
  const app = Fastify();
  await app.register((a) => agencyCampaignRoutes(a as never, statsDeps()), {
    prefix: '/api/v1/agency-campaigns',
  });
  await app.ready();
  try {
    const res = await app.inject({ method: 'GET', url: '/api/v1/agency-campaigns/camp-1/stats', headers: HEADERS });
    expect(res.statusCode).toBe(200);
    return res.json();
  } finally {
    await app.close();
  }
}

describe('campaignConcurrency', () => {
  const base = { campaignLive: 4, accountLimit: 10, accountLive: 7 };

  it('gives a running campaign the floor of an equal share while others run', () => {
    expect(campaignConcurrency({ ...base, status: 'running', runningCampaigns: 2 })).toEqual({
      campaign_live: 4, fair_share: 5, account_limit: 10, account_live: 7, running_campaigns: 2,
    });
    expect(campaignConcurrency({ ...base, status: 'running', runningCampaigns: 3 }).fair_share).toBe(3);
    expect(campaignConcurrency({ ...base, accountLimit: 1, status: 'running', runningCampaigns: 2 }).fair_share).toBe(0);
  });

  it('reports no share for a campaign running alone, or not running', () => {
    expect(campaignConcurrency({ ...base, status: 'running', runningCampaigns: 1 }).fair_share).toBeNull();
    expect(campaignConcurrency({ ...base, status: 'paused', runningCampaigns: 2 }).fair_share).toBeNull();
    expect(campaignConcurrency({ ...base, status: 'stopping', runningCampaigns: 2 }).fair_share).toBeNull();
  });

  it('never reports a running campaign beside zero running campaigns', () => {
    // The count is read a moment apart from the campaign row: a Start landing between
    // the two reads must not produce "running, 0 campaigns running".
    expect(campaignConcurrency({ ...base, status: 'running', runningCampaigns: 0 })).toMatchObject({
      running_campaigns: 1, fair_share: null,
    });
    expect(campaignConcurrency({ ...base, status: 'paused', runningCampaigns: 0 }).running_campaigns).toBe(0);
  });

  it('applies to the started-and-not-finished statuses only', () => {
    expect([...CAMPAIGN_CONCURRENCY_STATUSES].sort()).toEqual(['paused', 'running', 'stopping']);
  });
});

describe('GET /agency-campaigns/:id/stats · concurrency wiring', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    flags.isEnabled.mockResolvedValue(true);
    campaigns.findById.mockResolvedValue(CAMPAIGN_ROW);
    campaigns.stats.mockResolvedValue(STATS);
    campaigns.healthInputs.mockResolvedValue(HEALTH_INPUTS);
    campaigns.countRunningForAccount.mockResolvedValue(2);
    attempts.countLiveForAccount.mockResolvedValue(7);
    accountSettings.getMaxConcurrentCalls.mockResolvedValue(10);
  });

  it('assembles the block from the account reads, scoped to the caller\'s tenant and account', async () => {
    const body = await getStats();

    expect(body.concurrency).toEqual({
      campaign_live: 4, fair_share: 5, account_limit: 10, account_live: 7, running_campaigns: 2,
    });
    expect(attempts.countLiveForAccount).toHaveBeenCalledWith(TENANT, ACCOUNT);
    expect(campaigns.countRunningForAccount).toHaveBeenCalledWith(TENANT, ACCOUNT);
    // The existing read-outs are untouched: the guard's Redis count is still `concurrency_in_use`.
    expect(body.concurrency_limit).toBe(10);
    expect(body.concurrency_in_use).toBe(6);
  });

  it('sends null, and makes neither account read, for a campaign that holds no lines', async () => {
    for (const status of ['draft', 'completed', 'stopped']) {
      campaigns.findById.mockResolvedValue({ ...CAMPAIGN_ROW, status });
      const body = await getStats();
      expect(body, status).toHaveProperty('concurrency', null);
    }
    expect(attempts.countLiveForAccount).not.toHaveBeenCalled();
    expect(campaigns.countRunningForAccount).not.toHaveBeenCalled();
  });

  it('degrades to null, not a 500 or a zero share, when an account read fails', async () => {
    attempts.countLiveForAccount.mockRejectedValue(new Error('pool exhausted'));
    expect((await getStats()).concurrency).toBeNull();

    attempts.countLiveForAccount.mockResolvedValue(7);
    campaigns.countRunningForAccount.mockRejectedValue(new Error('pool exhausted'));
    expect((await getStats()).concurrency).toBeNull();
  });

  it('degrades to null when the limit cannot be read, while concurrency_limit keeps its 0 sentinel', async () => {
    accountSettings.getMaxConcurrentCalls.mockRejectedValue(new Error('pool exhausted'));

    const body = await getStats();

    // A failed read is not a ceiling of zero: the block says "not known".
    expect(body.concurrency).toBeNull();
    // `saturated()` reads 0 as "no known ceiling" (campaign-stats-concurrency-guard-route.test.ts).
    expect(body.concurrency_limit).toBe(0);
  });
});
