import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';

/*
 * PORT NOTE (magick-agency, Phase 8): ported from core test/unit/agency/campaign-stats-series-route.test.ts@4850d1d9.
 * Mock paths re-pointed only (logger → a partial `@magick-agency/observability` mock;
 * announcement / call / account-settings / profile repositories → `@magick-agency/db/repositories/*`;
 * leaf modules → `@magick-agency/domain/*`; `contracts.js` → `@magick-agency/contracts/agency`).
 * Cases verbatim unless noted here.
 */
import type { FastifyReply } from 'fastify';

// ---------------------------------------------------------------------------
// `GET /agency-campaigns/:id/stats/series` — the route's own wiring.
//
// ── The two assertions this file exists for ────────────────────────────────
//
// 1. **AUTH.** Core registers auth middleware PER ROUTE PLUGIN, not globally
//    (root CLAUDE.md), and this repository has already shipped that mistake
//    once: `agencyInternalRoutes` was mounted as a sibling of `internalRoutes`,
//    inherited none of its hooks, and left the roster-ingest route reachable
//    unauthenticated (MAG-89). So the test asserts the middleware actually RUNS
//    and that a refusal from it short-circuits the handler — deliberately not a
//    status-code assertion, because a route that does not exist also answers 404
//    (the MAG-106 trap).
//
// 2. **PRECEDENCE.** `/:id/stats/series` sits one segment below `/:id/stats`.
//    Fastify's radix tree separates them, and nothing about that is asserted by
//    the routes existing — a 404 and a wrong-handler 200 are both invisible to a
//    status-code assertion on the sibling. So both directions are pinned by WHICH
//    repository method ran.
//
// Everything else here is the validation surface: the required window, the
// half-open refusal, the 92-day cap, and the bucket vocabulary.
// ---------------------------------------------------------------------------

vi.mock('@magick-agency/observability', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@magick-agency/observability')>()),
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
  createChildLogger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('../../../src/config/index.js', () => ({
  config: { redis: { keyPrefix: '' }, telephony: {} },
}));

/**
 * The auth middleware, as a spy that SUCCEEDS by default and can be made to
 * reply.
 *
 * `(request, reply)` rather than zero-arity precisely so the refusal path is
 * reachable: a `preHandler` that sends a reply short-circuits the chain, and with
 * a zero-arity spy every test would run against an always-authenticated route.
 */
const { authSpy } = vi.hoisted(() => ({
  authSpy: vi.fn(async (_request: unknown, _reply: unknown) => { /* authenticated */ }),
}));
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

const { campaigns } = vi.hoisted(() => ({
  campaigns: {
    findById: vi.fn(),
    statsSeries: vi.fn(),
    stats: vi.fn(),
    healthInputs: vi.fn(),
  },
}));
vi.mock('../../../src/db/repositories/agency.repository.js', () => ({
  agencyCampaignRepository: campaigns,
  agencyAttemptRepository: { listForCampaign: vi.fn() },
  agencyContactRepository: { listForCampaign: vi.fn() },
}));
vi.mock('@magick-agency/db/repositories/announcement.repository', () => ({
  announcementRepository: { findActiveByIdScoped: vi.fn() },
}));
vi.mock('@magick-agency/db/repositories/account-settings.repository', () => ({
  accountSettingsRepository: { getMaxConcurrentCalls: vi.fn().mockResolvedValue(5) },
}));

const { agencyCampaignRoutes } = await import('../../../src/api/routes/agency-campaigns.routes.js');

const DEPS = {
  runtime: {
    dnc: { appliedVersion: async () => 1 },
    stations: { connectedBySession: async () => new Map() },
  },
  callManager: {
    accountConcurrencyGuard: {
      getDistributedAccountCount: async () => ({ status: 'unavailable' as const }),
    },
  },
} as unknown as Parameters<typeof agencyCampaignRoutes>[1];

const HEADERS = { 'x-mgkvc-tenant': 't1', 'x-mgkvc-account': 'a1' };
const CAMPAIGN_ID = '11111111-2222-3333-4444-555555555555';
const CAMPAIGN = {
  id: CAMPAIGN_ID, tenant_id: 't1', account_id: 'a1', name: 'Q3', status: 'running',
  calling_window_start: '09:00:00', calling_window_end: '20:00:00',
  calling_days: [1, 2, 3, 4, 5], default_timezone: 'Asia/Kolkata',
};
const WINDOW = 'from=2026-08-11&to=2026-08-14';
const SERIES = {
  campaign_id: CAMPAIGN_ID, bucket: 'day', timezone: 'Asia/Kolkata',
  buckets: [{
    bucket_start: '2026-08-11',
    attempts: 412, connected: 118, successes: 76, talk_seconds: 22910, wrapup_seconds: 4488,
  }],
};

async function makeApp() {
  const app = Fastify();
  await app.register((a) => agencyCampaignRoutes(a as never, DEPS), { prefix: '/api/v1/agency-campaigns' });
  await app.ready();
  return app;
}

const get = async (query: string) => {
  const app = await makeApp();
  const res = await app.inject({
    method: 'GET',
    url: `/api/v1/agency-campaigns/${CAMPAIGN_ID}/stats/series?${query}`,
    headers: HEADERS,
  });
  await app.close();
  return res;
};

beforeEach(() => {
  vi.clearAllMocks();
  flags.isEnabled.mockResolvedValue(true);
  campaigns.findById.mockResolvedValue(CAMPAIGN);
  campaigns.statsSeries.mockResolvedValue(SERIES);
  // The live payload's two producers, so the precedence test can reach `/stats`
  // without a repository stub blowing up inside it.
  campaigns.stats.mockResolvedValue({ agents: [] });
  campaigns.healthInputs.mockResolvedValue({
    pendingByTimezone: [], nextRetryAt: null, lastDialAt: null,
    recent: { attempts: 0, failed: 0 }, onBreakByReason: {},
  });
});

// ─── the wiring ─────────────────────────────────────────────────────────────

describe('the route is behind core auth and the dialer flag', () => {
  it('runs authMiddleware — asserted on the SPY, not on a status code', async () => {
    await get(WINDOW);
    // A route that does not exist also answers 404, which is what made the previous
    // version of this assertion vacuous in this repository (MAG-106). The middleware
    // having been CALLED is the fact that matters.
    expect(authSpy).toHaveBeenCalledTimes(1);
  });

  it('a refusal by the auth middleware reaches the client and the handler never runs', async () => {
    authSpy.mockImplementationOnce(async (_request: unknown, reply: unknown) => {
      (reply as FastifyReply).code(401).send({ error: 'Unauthorized' });
    });
    const res = await get(WINDOW);
    expect(res.statusCode).toBe(401);
    // The half that matters: a `preHandler` reply short-circuits the chain, so the
    // repository must not have been reached at all.
    expect(campaigns.statsSeries).not.toHaveBeenCalled();
    expect(campaigns.findById).not.toHaveBeenCalled();
  });

  it('is 403 with the dialer flag off, and reads nothing', async () => {
    flags.isEnabled.mockResolvedValue(false);
    const res = await get(WINDOW);
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('feature_disabled');
    // Gated, unlike `/stop` and `/pause`: this is a pure read and changes nothing,
    // so none of the "a kill switch that removes the off button is not a kill
    // switch" reasoning applies.
    expect(campaigns.statsSeries).not.toHaveBeenCalled();
  });

  it('a campaign in another tenant is 404, indistinguishable from one that does not exist', async () => {
    campaigns.findById.mockResolvedValue({ ...CAMPAIGN, tenant_id: 'someone-else' });
    const res = await get(WINDOW);
    expect(res.statusCode).toBe(404);
    expect(campaigns.statsSeries).not.toHaveBeenCalled();
  });

  it('hands the repository the CALLER\'s tenant and account, never the campaign row\'s', async () => {
    await get(WINDOW);
    // The scope is the request's. Reading it off the row would make the predicate a
    // restatement of the check that just passed rather than an independent one.
    expect(campaigns.statsSeries).toHaveBeenCalledWith(
      { tenantId: 't1', accountId: 'a1' },
      CAMPAIGN_ID,
      expect.objectContaining({ bucket: 'day' }),
    );
  });
});

describe('ROUTE PRECEDENCE against the live stats payload', () => {
  it('/stats/series reaches the series, and /stats still reaches the live payload', async () => {
    const app = await makeApp();

    await app.inject({
      method: 'GET',
      url: `/api/v1/agency-campaigns/${CAMPAIGN_ID}/stats/series?${WINDOW}`,
      headers: HEADERS,
    });
    // Pinned by WHICH repository method ran, because a 404 and a wrong-handler 200
    // are both invisible to a status-code assertion on the sibling route.
    expect(campaigns.statsSeries).toHaveBeenCalledTimes(1);
    expect(campaigns.stats).not.toHaveBeenCalled();

    vi.clearAllMocks();
    campaigns.findById.mockResolvedValue(CAMPAIGN);
    campaigns.stats.mockResolvedValue({ agents: [] });
    campaigns.healthInputs.mockResolvedValue({
      pendingByTimezone: [], nextRetryAt: null, lastDialAt: null,
      recent: { attempts: 0, failed: 0 }, onBreakByReason: {},
    });

    await app.inject({
      method: 'GET',
      url: `/api/v1/agency-campaigns/${CAMPAIGN_ID}/stats`,
      headers: HEADERS,
    });
    expect(campaigns.stats).toHaveBeenCalledTimes(1);
    expect(campaigns.statsSeries).not.toHaveBeenCalled();

    await app.close();
  });
});

// ─── the validation surface ─────────────────────────────────────────────────

describe('the window is required, half-open and capped', () => {
  it('refuses a missing `from` or `to` rather than defaulting the window', async () => {
    // This endpoint has no page: it aggregates, so an absent bound would mean
    // "every day this campaign has ever run" and the caller could not tell from the
    // response which window they got.
    for (const query of ['', 'from=2026-08-11', 'to=2026-08-14']) {
      const res = await get(query);
      expect(res.statusCode, query).toBe(400);
      expect(res.json().error).toBe('Validation failed');
    }
    expect(campaigns.statsSeries).not.toHaveBeenCalled();
  });

  it('passes `from` inclusive and `to` EXCLUSIVE through as instants', async () => {
    await get('from=2026-08-11&to=2026-08-14');
    const filters = campaigns.statsSeries.mock.calls[0]![2] as { from: Date; to: Date };
    // A date-only bound parses as UTC midnight — `parseFilterDate`'s rule, imported
    // rather than re-implemented. The half-openness itself is in the SQL and is
    // asserted in `campaign-stats-series.test.ts`; what this pins is that the route
    // forwards the two bounds unmodified, so an attempt exactly at `to` is excluded
    // by the statement and one exactly at `from` is included.
    expect(filters.from.toISOString()).toBe('2026-08-11T00:00:00.000Z');
    expect(filters.to.toISOString()).toBe('2026-08-14T00:00:00.000Z');
  });

  it('refuses an inverted OR zero-width window', async () => {
    for (const query of ['from=2026-08-14&to=2026-08-11', 'from=2026-08-11&to=2026-08-11']) {
      const res = await get(query);
      expect(res.statusCode, query).toBe(400);
      // Refused rather than silently emptied: a half-open window of zero width has
      // no buckets, and an empty series reads as a fact about the campaign rather
      // than about the request.
      expect(JSON.stringify(res.json())).toContain('half-open');
    }
  });

  it('refuses a window wider than 92 days, naming the bound', async () => {
    // 93 days.
    const res = await get('from=2026-01-01&to=2026-04-04');
    expect(res.statusCode).toBe(400);
    const details = res.json().details as Array<{ param: string; message: string }>;
    expect(details[0]!.param).toBe('from');
    // The SAME wording as the roster's refusal, from the SAME imported constant —
    // one bound, one sentence, so a console that special-cases the string does not
    // have to learn a second one. A caller wanting a year learns to page by quarter
    // rather than discovering an empty answer.
    expect(details[0]!.message).toBe(
      'the window must be at most 92 days — request a narrower range',
    );
    expect(campaigns.statsSeries).not.toHaveBeenCalled();
  });

  it('accepts exactly 92 days', async () => {
    // The boundary on the accepting side, so the cap cannot drift to 91 unnoticed.
    const res = await get('from=2026-01-01&to=2026-04-03');
    expect(res.statusCode, JSON.stringify(res.json())).toBe(200);
    expect(campaigns.statsSeries).toHaveBeenCalledTimes(1);
  });
});

describe('the bucket vocabulary', () => {
  it('defaults to `day` and accepts week and month', async () => {
    await get(WINDOW);
    expect(campaigns.statsSeries.mock.calls[0]![2]).toMatchObject({ bucket: 'day' });

    for (const bucket of ['day', 'week', 'month']) {
      vi.clearAllMocks();
      campaigns.findById.mockResolvedValue(CAMPAIGN);
      campaigns.statsSeries.mockResolvedValue(SERIES);
      const res = await get(`${WINDOW}&bucket=${bucket}`);
      expect(res.statusCode, bucket).toBe(200);
      expect(campaigns.statsSeries.mock.calls[0]![2]).toMatchObject({ bucket });
    }
  });

  it('refuses an unknown bucket and ECHOES the valid set', async () => {
    const res = await get(`${WINDOW}&bucket=hour`);
    expect(res.statusCode).toBe(400);
    // A client holding a stale vocabulary recovers in one round trip instead of
    // guessing. The unit is interpolated into `date_trunc`, so this 400 is also the
    // only thing standing between raw query input and the statement.
    expect(JSON.stringify(res.json())).toContain('day, week, month');
    expect(campaigns.statsSeries).not.toHaveBeenCalled();
  });
});

describe('the payload', () => {
  it('serves the repository\'s series verbatim — no rates added on the way out', async () => {
    const res = await get(WINDOW);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(SERIES);
    // Explicitly: the route is not a place a rate can be introduced. Both halves of
    // every rate are on every bucket and the client derives them, because a chart
    // aggregating buckets into one column needs `Σnum / Σden` rather than the mean
    // of the per-bucket rates.
    expect(Object.keys(res.json().buckets[0])).not.toContain('connect_rate_pct');
  });

  it('answers 404 when the repository finds no campaign — never an empty series', async () => {
    campaigns.statsSeries.mockResolvedValue(null);
    const res = await get(WINDOW);
    // `requireOwned` just passed, so this is a campaign deleted between the two
    // reads. An empty `buckets` array would read as "this campaign dialled nobody".
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('campaign_not_found');
  });
});
