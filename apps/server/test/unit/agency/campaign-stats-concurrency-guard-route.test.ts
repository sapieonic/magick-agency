import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';

/*
 * PORT NOTE (magick-agency, Phase 8): ported from core test/unit/agency/campaign-stats-concurrency-guard-route.test.ts@4850d1d9.
 * Mock paths re-pointed only (logger → a partial `@magick-agency/observability` mock;
 * announcement / call / account-settings / profile repositories → `@magick-agency/db/repositories/*`;
 * leaf modules → `@magick-agency/domain/*`; `contracts.js` → `@magick-agency/contracts/agency`).
 * Cases verbatim unless noted here.
 */

// ---------------------------------------------------------------------------
// MAG-146 — the route's degraded-concurrency fallback, pinned against the REAL
// `campaignHealth`/`saturated()` (not a mock of it).
//
// `agency-campaigns.routes.ts`'s `GET /:id/stats` reads
// `account_settings.max_concurrent_calls` through `bestEffort(...)`, and when
// that read throws, the fallback is `0` — deliberately, because `saturated()`
// treats `0` as "no known ceiling" and therefore never diagnoses saturation.
// That reasoning is correct, and untested: `campaign-health.test.ts` proves the
// GUARD in isolation, but nothing before this file proved the ROUTE actually
// feeds it the sentinel it relies on. The ticket's own probe found the gap by
// changing the fallback from `0` to `1` and watching this surface's test suite
// (`agency-campaign-stats.routes.test.ts`, an INTEGRATION test) stay green.
//
// This file exercises the same seam without a database: `agencyCampaignRepository`
// and `accountSettingsRepository` are mocked, but `campaignHealth` is the REAL
// import — so a route that starts sending `1` (or any positive number) as the
// degraded fallback fails this test via the real guard, not via an assertion on
// the constant alone.
// ---------------------------------------------------------------------------

vi.mock('@magick-agency/observability', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@magick-agency/observability')>()),
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
  createChildLogger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('../../../src/config/index.js', () => ({
  config: { redis: { keyPrefix: '' }, telephony: {} },
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

const { campaigns, accountSettings } = vi.hoisted(() => ({
  campaigns: { findById: vi.fn(), stats: vi.fn(), healthInputs: vi.fn() },
  accountSettings: { getMaxConcurrentCalls: vi.fn() },
}));
vi.mock('../../../src/db/repositories/agency.repository.js', () => ({
  agencyCampaignRepository: campaigns,
}));
vi.mock('@magick-agency/db/repositories/announcement.repository', () => ({
  announcementRepository: { findActiveByIdScoped: vi.fn() },
}));
vi.mock('@magick-agency/db/repositories/account-settings.repository', () => ({
  accountSettingsRepository: accountSettings,
}));

// Deliberately NOT mocked: `campaign-health.js` is the real assembler, so the
// route's fallback value is checked against the real `saturated()` guard.
import { agencyCampaignRoutes } from '../../../src/api/routes/agency-campaigns.routes.js';

const TENANT = 't1';
const ACCOUNT = 'a1';
const HEADERS = { 'x-mgkvc-tenant': TENANT, 'x-mgkvc-account': ACCOUNT };

const CAMPAIGN_ROW = {
  id: 'camp-1', tenant_id: TENANT, account_id: ACCOUNT,
  status: 'running', pause_reason: null, paused_at: null,
  pause_abandonment_rate_pct: null, abandonment_ceiling_pct: 3,
};

/** An empty floor, nothing pending, nothing on the retry queue. */
const EMPTY_STATS = {
  contacts_pending: 0, retries_pending: 0, agents_live: 0,
  agents_by_state: { offline: 0, available: 0, reserved: 0, on_call: 0, wrapup: 0, break: 0 },
  agents: [],
};

const EMPTY_HEALTH_INPUTS = {
  pendingByTimezone: [], nextRetryAt: null, lastDialAt: null,
  recent: { attempts: 0, failed: 0 }, onBreakByReason: {},
};

/**
 * `getDistributedAccountCount` resolving a KNOWN, non-zero in-use count. This
 * is the half of `saturated()`'s AND that is easy to satisfy — a degraded
 * `account_settings` read is the interesting half, and the whole point of the
 * fallback-to-0 design is that a known non-zero in-use count must NOT be
 * enough on its own to read as saturation.
 */
const CONCURRENCY_IN_USE = 7;

function statsDeps() {
  return {
    runtime: {
      dnc: { appliedVersion: vi.fn(async () => 7) },
      stations: { connectedBySession: vi.fn(async () => new Map()) },
    },
    callManager: {
      accountConcurrencyGuard: {
        getDistributedAccountCount: vi.fn(async () => ({ status: 'available' as const, count: CONCURRENCY_IN_USE })),
      },
    },
  } as unknown as Parameters<typeof agencyCampaignRoutes>[1];
}

async function makeApp() {
  const app = Fastify();
  await app.register((a) => agencyCampaignRoutes(a as never, statsDeps()), {
    prefix: '/api/v1/agency-campaigns',
  });
  await app.ready();
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  flags.isEnabled.mockResolvedValue(true);
  campaigns.findById.mockResolvedValue(CAMPAIGN_ROW);
  campaigns.stats.mockResolvedValue(EMPTY_STATS);
  campaigns.healthInputs.mockResolvedValue(EMPTY_HEALTH_INPUTS);
});

describe('GET /agency-campaigns/:id/stats · MAG-146 degraded concurrency fallback', () => {
  it('falls back to 0 (never a positive number) when account_settings cannot be read, and the strip reads it as unknown', async () => {
    accountSettings.getMaxConcurrentCalls.mockRejectedValue(new Error('pool exhausted'));

    const app = await makeApp();
    const res = await app.inject({
      method: 'GET', url: '/api/v1/agency-campaigns/camp-1/stats', headers: HEADERS,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();

    // The constant the route actually sent downstream.
    expect(body.concurrency_limit).toBe(0);
    expect(body.concurrency_in_use).toBe(CONCURRENCY_IN_USE);

    // The outcome that matters: with a KNOWN non-zero in-use count and a
    // degraded settings read, `concurrency_saturated` must not appear anywhere
    // in the ranking. This is checked against the REAL `campaignHealth`, so it
    // fails if either half regresses — the route sending something other than
    // `0`, or `saturated()` losing its `limit > 0` guard.
    const stalls = [
      ...(body.stall ? [body.stall.code] : []),
      ...body.other_stalls,
    ];
    expect(stalls).not.toContain('concurrency_saturated');
  });

  it('does report concurrency_saturated once a REAL positive limit is actually reached', async () => {
    // The guard's other side, so this file cannot pass by turning the
    // diagnosis off unconditionally. A healthy (non-degraded) read of a real,
    // positive limit that the in-use count has met must still fire.
    accountSettings.getMaxConcurrentCalls.mockResolvedValue(CONCURRENCY_IN_USE);

    const app = await makeApp();
    const res = await app.inject({
      method: 'GET', url: '/api/v1/agency-campaigns/camp-1/stats', headers: HEADERS,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.concurrency_limit).toBe(CONCURRENCY_IN_USE);
    const stalls = [
      ...(body.stall ? [body.stall.code] : []),
      ...body.other_stalls,
    ];
    expect(stalls).toContain('concurrency_saturated');
  });
});
