import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';

/*
 * PORT NOTE (magick-agency, Phase 8): ported from core test/unit/agency/agent-record-routes.test.ts@4850d1d9.
 * Mock paths re-pointed only (logger → a partial `@magick-agency/observability` mock;
 * announcement / call / account-settings / profile repositories → `@magick-agency/db/repositories/*`;
 * leaf modules → `@magick-agency/domain/*`; `contracts.js` → `@magick-agency/contracts/agency`).
 * Cases verbatim unless noted here. MODIFIED: "never reaches the repository with an id longer than the column" expects
 * 414 (Fastify 5.12.5 / find-my-way 9.9.0) where core's lock (5.8.4 / 9.5.0) answered 404.
 */
import type { FastifyReply } from 'fastify';

// ---------------------------------------------------------------------------
// `GET /agency-agents/{stats,grouped-stats,:agentUserId/stats,:agentUserId/attempts}`
// — the plugin's own wiring. The list is not restated in prose anywhere below:
// `ROUTE_CASES` is the one enumeration, and it is asserted against Fastify's own
// registration record.
//
// ── The assertion this file exists for ─────────────────────────────────────
//
// These routes serve every phone number, note and disposition one agent has
// touched, ACROSS campaigns. Core registers auth middleware PER ROUTE PLUGIN, not
// globally (docs/reference/magic-voice-core/CLAUDE.md), and this repository has already shipped that mistake
// once: `agencyInternalRoutes` was mounted as a sibling of `internalRoutes`,
// inherited none of its hooks, and left the roster-ingest route reachable
// unauthenticated (MAG-89).
//
// So the auth test asserts the middleware actually RUNS, rather than trusting that
// the routes were declared on the right plugin. It is deliberately not a
// status-code assertion — a route that does not exist also answers 404, which is
// the MAG-106 trap. And the test BEFORE it asserts that the sweep covers every
// route the plugin registers, because a sweep is only as good as its list: MAG-89
// was a route added outside the thing that was supposed to cover it.
//
// The second thing worth its own test is the tenant scope. Unlike every other
// agency read, there is no campaign in these paths to run an ownership check
// against: `agent_user_id` is master's user id, opaque to core, and core cannot
// tell a real one from a guess. The scope is therefore a PREDICATE the repository
// applies, and these tests assert the route actually hands it the caller's
// tenant/account rather than dropping them.
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
 * It takes `(request, reply)` rather than no arguments precisely so the refusal
 * path is reachable: a `preHandler` that sends a reply short-circuits the rest of
 * the chain, and with a zero-arity spy there was no way to exercise that at all —
 * every test in this file ran against an always-authenticated route, which is the
 * hole `describe('a refusal by the auth middleware …')` below closes.
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

const { agentStats, attempts } = vi.hoisted(() => ({
  agentStats: { stats: vi.fn(), roster: vi.fn(), groupedStats: vi.fn() },
  attempts: { listForAgent: vi.fn() },
}));
vi.mock('../../../src/db/repositories/agency.repository.js', () => ({
  agencyAgentStatsRepository: agentStats,
  agencyAttemptRepository: attempts,
}));

const { agencyAgentRoutes } = await import('../../../src/api/routes/agency-agents.routes.js');
const { encodeKeysetCursor } = await import('@magick-agency/domain/keyset-cursor');

const HEADERS = { 'x-mgkvc-tenant': 't1', 'x-mgkvc-account': 'a1' };
const WINDOW = 'from=2026-08-17&to=2026-08-19';
const EMPTY_STATS = {
  agent_user_id: 'u-ravi', bucket: 'day', from: '', to: '',
  totals: {}, buckets: [], by_campaign: [],
};
const EMPTY_PAGE = { rows: [], next_cursor: null, limit: 50 };
const EMPTY_ROSTER = {
  from: '', to: '', campaign_id: null, sort: 'successes', order: 'desc',
  limit: 100, total_agents: 0, rows: [],
  benchmark: {
    agents: 0, agents_rated: 0, attempts: 0, connected: 0, successes: 0,
    talk_seconds: 0, wrapup_seconds: 0,
    connect_rate_pct: null, success_rate_pct: null, aht_seconds: null,
    connect_rate: { p25: null, median: null, p75: null },
    success_rate: { p25: null, median: null, p75: null },
    occupancy_pct: { p25: null, median: null, p75: null },
  },
};
const EMPTY_GROUPED = {
  from: '', to: '', campaign_id: null, group_by: ['agent'],
  // `null` on the default fixture because its grouping is zone-free. Present rather
  // than omitted: absent and null are indistinguishable to a consumer, and the
  // verbatim test below is what pins the field surviving the route hop.
  resolved_timezone: null, sort: 'key', order: 'asc', limit: 200,
  total_groups: 0, rows: [],
};
/** The grouped read's minimum legal query: a window plus a zone-free grouping. */
const GROUPED_QUERY = `${WINDOW}&group_by=agent`;
/** A real v4 UUID, so the precedence test's path segment is the shape master sends. */
const AGENT_UUID = '9f1c3d2e-4b5a-4c6d-8e7f-0a1b2c3d4e5f';

/**
 * ── EVERY route on the plugin, and the LIST is the thing under test ─────────
 *
 * The two tests below used to say "ALL THREE routes" and "both routes" while
 * exercising four, which a reviewer caught. The stale numbers were harmless on
 * their own; the drift is not. MAG-89 shipped an unauthenticated endpoint in this
 * repository for exactly this reason — a route was added and the list that was
 * supposed to cover it was not — so a hand-maintained count in a title is the
 * failure mode, not a typo.
 *
 * So the counts in those titles are now interpolated from this array, and
 * `covers every route the plugin registers` asserts the array against Fastify's
 * OWN registration record. A fifth route added to the plugin therefore fails a
 * test that names it, rather than being silently outside a loop.
 *
 * `read` is the repository spy that route must not have touched when the flag is
 * off. Carried per route rather than asserted as a fixed list of four, so a new
 * route cannot be added to the sweep without saying what it reads.
 */
const ROUTE_CASES = [
  {
    // The per-agent record: one person's numbers, bucketed.
    url: '/api/v1/agency-agents/:agentUserId/stats',
    request: `u-ravi/stats?${WINDOW}`,
    read: () => agentStats.stats,
  },
  {
    // The attempt spine: every phone number, note and disposition one agent has
    // touched, across campaigns.
    url: '/api/v1/agency-agents/:agentUserId/attempts',
    request: 'u-ravi/attempts',
    read: () => attempts.listForAgent,
  },
  {
    // The roster. Serving THIRTY agents' phone-touching history in one response
    // makes this the widest read on the plugin, so it is the one where inheriting
    // the hook matters most — and inheriting it is exactly what MAG-89 got wrong on
    // a sibling plugin.
    url: '/api/v1/agency-agents/stats',
    request: `stats?${WINDOW}`,
    read: () => agentStats.roster,
  },
  {
    // The grouped read. Same plugin, same hook, and the same MAG-89 risk: it is a
    // fourth route added to a plugin whose hook a sibling plugin once failed to
    // inherit, and `agent`-grouped rows carry every agent id on the floor.
    url: '/api/v1/agency-agents/grouped-stats',
    request: `grouped-stats?${GROUPED_QUERY}`,
    read: () => agentStats.groupedStats,
  },
] as const;

async function makeApp() {
  const app = Fastify();
  await app.register(agencyAgentRoutes, { prefix: '/api/v1/agency-agents' });
  await app.ready();
  return app;
}

/**
 * The GET routes the plugin actually registers, from Fastify's `onRoute` hook.
 *
 * The hook is added to the PARENT instance before the plugin is registered, so it
 * fires for the plugin's own routes — which is what makes this Fastify's record
 * rather than a second hand-written list. `HEAD` twins (Fastify adds one per GET)
 * are filtered out; they inherit the same hooks by construction.
 */
async function registeredGetRoutes(): Promise<string[]> {
  const app = Fastify();
  const urls: string[] = [];
  app.addHook('onRoute', (route) => {
    if (String(route.method) === 'GET') urls.push(route.url);
  });
  await app.register(agencyAgentRoutes, { prefix: '/api/v1/agency-agents' });
  await app.ready();
  await app.close();
  return urls.sort();
}

beforeEach(() => {
  vi.clearAllMocks();
  flags.isEnabled.mockResolvedValue(true);
  agentStats.stats.mockResolvedValue(EMPTY_STATS);
  agentStats.roster.mockResolvedValue(EMPTY_ROSTER);
  agentStats.groupedStats.mockResolvedValue(EMPTY_GROUPED);
  attempts.listForAgent.mockResolvedValue(EMPTY_PAGE);
});

describe('the routes are behind core auth and the dialer flag', () => {
  it(`covers every route the plugin registers — ${ROUTE_CASES.length} of them`, async () => {
    // The guard on the two sweeps below, and the reason their counts are no longer
    // written by hand. Neither sweep can fail for a route it does not know about, so
    // without this test the coverage claim is only as good as whoever last added a
    // route remembering to widen a loop — which is the MAG-89 sequence exactly.
    expect(await registeredGetRoutes()).toEqual([...ROUTE_CASES].map((c) => c.url).sort());
  });

  it(`runs authMiddleware on all ${ROUTE_CASES.length} routes`, async () => {
    // Deliberately NOT a status-code assertion: a route that does not exist also
    // answers 404, which is the MAG-106 trap. The spy having been CALLED is the only
    // observation that separates "the hook ran" from "there was nothing to run it
    // on".
    const app = await makeApp();
    let expected = 0;
    for (const route of ROUTE_CASES) {
      await app.inject({
        method: 'GET', url: `/api/v1/agency-agents/${route.request}`, headers: HEADERS,
      });
      expected += 1;
      expect(authSpy, route.url).toHaveBeenCalledTimes(expected);
    }
    await app.close();
  });

  it(`403s all ${ROUTE_CASES.length} routes when the dialer flag is off, and reads nothing`, async () => {
    // Every route here is gated with no exception, unlike the campaign plugin —
    // whose `/stop` and `/pause` stay ungated so the kill switch does not also
    // remove the off button. These are pure reads.
    flags.isEnabled.mockResolvedValue(false);
    const app = await makeApp();
    for (const route of ROUTE_CASES) {
      const res = await app.inject({
        method: 'GET', url: `/api/v1/agency-agents/${route.request}`, headers: HEADERS,
      });
      expect(res.statusCode, route.url).toBe(403);
      expect(res.json(), route.url).toMatchObject({ code: 'feature_disabled' });
      // Per route rather than as a list of four at the end: a fifth route added to
      // the sweep has to name what it reads, so "reads nothing" stays a complete
      // claim instead of one that silently stops covering the newest route.
      expect(route.read(), route.url).not.toHaveBeenCalled();
    }
    await app.close();
  });

  it('checks the flag for the CALLER\'s tenant and account', async () => {
    const app = await makeApp();
    await app.inject({
      method: 'GET', url: `/api/v1/agency-agents/u-ravi/stats?${WINDOW}`,
      headers: { 'x-mgkvc-tenant': 't-other', 'x-mgkvc-account': 'a-other' },
    });
    expect(flags.isEnabled).toHaveBeenCalledWith(
      expect.anything(), { tenantId: 't-other', accountId: 'a-other' },
    );
    await app.close();
  });
});

describe('the tenant scope reaches the repository', () => {
  it('passes the caller\'s tenant and account, plus the PATH\'s agent id', async () => {
    // Without this the reads would be keyed on an opaque user id alone, and any
    // tenant holding an API key could read any other tenant's agent.
    const app = await makeApp();
    await app.inject({
      method: 'GET', url: `/api/v1/agency-agents/u-ravi/stats?${WINDOW}`,
      headers: { 'x-mgkvc-tenant': 't-9', 'x-mgkvc-account': 'a-9' },
    });
    expect(agentStats.stats).toHaveBeenCalledWith(
      { tenantId: 't-9', accountId: 'a-9', agentUserId: 'u-ravi' },
      expect.objectContaining({ bucket: 'day' }),
    );

    await app.inject({
      method: 'GET', url: '/api/v1/agency-agents/u-ravi/attempts',
      headers: { 'x-mgkvc-tenant': 't-9', 'x-mgkvc-account': 'a-9' },
    });
    expect(attempts.listForAgent).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: 't-9', accountId: 'a-9', agentUserId: 'u-ravi',
    }));
    await app.close();
  });

  it('refuses a blank agent id rather than answering an empty record', async () => {
    // A whitespace-only id would match nothing, and an empty record reads as a
    // fact about an agent rather than as a malformed request.
    const app = await makeApp();
    const res = await app.inject({
      method: 'GET', url: `/api/v1/agency-agents/%20/stats?${WINDOW}`, headers: HEADERS,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'invalid_agent_user_id' });
    expect(agentStats.stats).not.toHaveBeenCalled();
    await app.close();
  });

  it('never reaches the repository with an id longer than the column', async () => {
    // Fastify's own `maxParamLength` defaults to 100 — the same width as
    // `agency_agent_sessions.agent_user_id` — and it answers 404 for a longer
    // path segment before any handler runs. So the route's own length guard is
    // unreachable over HTTP today and is kept as defence in depth: the coincidence
    // of the two limits is not something this file should depend on, and the
    // outcome that matters is that no query is issued.
    const app = await makeApp();
    const res = await app.inject({
      method: 'GET', url: `/api/v1/agency-agents/${'x'.repeat(101)}/stats?${WINDOW}`, headers: HEADERS,
    });
    // PORT NOTE (magick-agency): core's lock resolved Fastify 5.8.4 / find-my-way 9.5.0,
    // which answered an over-long param with 404; agency resolves Fastify 5.12.5 /
    // find-my-way 9.9.0, which answers 414 URI Too Long for the same request. The
    // framework still refuses it before any handler runs, which is what this case is
    // for; the no-query assertion below is unchanged.
    expect(res.statusCode).toBe(414);
    expect(agentStats.stats).not.toHaveBeenCalled();
    await app.close();
  });
});

describe('GET /:agentUserId/stats — the query vocabulary', () => {
  it('400s an unknown bucket and names the valid set', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'GET', url: `/api/v1/agency-agents/u-ravi/stats?${WINDOW}&bucket=hour`, headers: HEADERS,
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { details: { param: string; message: string }[] };
    const issue = body.details.find((d) => d.param === 'bucket');
    expect(issue?.message).toContain('day, week, month');
    expect(agentStats.stats).not.toHaveBeenCalled();
    await app.close();
  });

  it('400s a missing window rather than aggregating the agent\'s whole history', async () => {
    const app = await makeApp();
    const res = await app.inject({ method: 'GET', url: '/api/v1/agency-agents/u-ravi/stats', headers: HEADERS });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { details: { param: string }[] };
    expect(body.details.map((d) => d.param).sort()).toEqual(['from', 'to']);
    await app.close();
  });

  it('400s an inverted window rather than answering "nothing"', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'GET', url: '/api/v1/agency-agents/u-ravi/stats?from=2026-08-19&to=2026-08-17', headers: HEADERS,
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('passes the parsed window and optional campaign through unchanged', async () => {
    const app = await makeApp();
    await app.inject({
      method: 'GET',
      url: '/api/v1/agency-agents/u-ravi/stats?from=2026-08-17&to=2026-08-19&bucket=week'
        + '&campaign_id=11111111-2222-3333-4444-555555555555',
      headers: HEADERS,
    });
    expect(agentStats.stats).toHaveBeenCalledWith(expect.anything(), {
      from: new Date('2026-08-17T00:00:00.000Z'),
      to: new Date('2026-08-19T00:00:00.000Z'),
      bucket: 'week',
      campaignId: '11111111-2222-3333-4444-555555555555',
    });
    await app.close();
  });

  it('serves the repository payload verbatim', async () => {
    const payload = { ...EMPTY_STATS, from: '2026-08-17T00:00:00.000Z', to: '2026-08-19T00:00:00.000Z' };
    agentStats.stats.mockResolvedValue(payload);
    const app = await makeApp();
    const res = await app.inject({
      method: 'GET', url: `/api/v1/agency-agents/u-ravi/stats?${WINDOW}`, headers: HEADERS,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(payload);
    await app.close();
  });
});

describe('GET /:agentUserId/attempts — the spine, cross-campaign', () => {
  it('does not fork the filter vocabulary: an unknown outcome 400s with the shared set', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'GET', url: '/api/v1/agency-agents/u-ravi/attempts?outcome=sold', headers: HEADERS,
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { details: { param: string; message: string }[] };
    expect(body.details[0]?.message).toContain('unknown outcome: sold');
    expect(body.details[0]?.message).toContain('no_answer');
    await app.close();
  });

  it('passes the shared filters and campaign_id through', async () => {
    const app = await makeApp();
    await app.inject({
      method: 'GET',
      url: '/api/v1/agency-agents/u-ravi/attempts?state=ended&outcome=connected'
        + '&disposition_code=sale&campaign_id=11111111-2222-3333-4444-555555555555&limit=25',
      headers: HEADERS,
    });
    expect(attempts.listForAgent).toHaveBeenCalledWith(expect.objectContaining({
      limit: 25,
      filters: expect.objectContaining({
        states: ['ended'],
        outcomes: ['connected'],
        dispositionCodes: ['sale'],
        campaignId: '11111111-2222-3333-4444-555555555555',
      }),
    }));
    await app.close();
  });

  it('pages by the SAME opaque cursor the campaign spine issues', async () => {
    const cursor = encodeKeysetCursor({ at: '2026-08-17T14:03:11.123456Z', id: '11111111-2222-3333-4444-555555555555' });
    const app = await makeApp();
    await app.inject({
      method: 'GET', url: `/api/v1/agency-agents/u-ravi/attempts?cursor=${cursor}`, headers: HEADERS,
    });
    expect(attempts.listForAgent).toHaveBeenCalledWith(expect.objectContaining({
      after: { at: '2026-08-17T14:03:11.123456Z', id: '11111111-2222-3333-4444-555555555555' },
    }));
    await app.close();
  });

  it('400s a malformed cursor rather than silently restarting at page one', async () => {
    // A list that quietly restarts from the top reads as duplicate rows to
    // whoever is scrolling it, and there is no way to tell that from real ones.
    const app = await makeApp();
    const res = await app.inject({
      method: 'GET', url: '/api/v1/agency-agents/u-ravi/attempts?cursor=not-a-cursor', headers: HEADERS,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'malformed_cursor' });
    expect(attempts.listForAgent).not.toHaveBeenCalled();
    await app.close();
  });

  it('clamps the page size', async () => {
    const app = await makeApp();
    await app.inject({
      method: 'GET', url: '/api/v1/agency-agents/u-ravi/attempts?limit=99999', headers: HEADERS,
    });
    expect(attempts.listForAgent).toHaveBeenCalledWith(expect.objectContaining({ limit: 500 }));
    await app.close();
  });
});

describe('a refusal by the auth middleware stops the request dead', () => {
  /**
   * ── The hole this closes ────────────────────────────────────────────────────
   *
   * Every other test in this file runs with `authSpy` succeeding, so all of them
   * would still pass if the plugin's `preHandler` were a hook that logged and
   * returned. "The middleware was called" is the right assertion for the MAG-89
   * mounting mistake — a route on the wrong plugin never calls it at all — but it
   * is NOT the same claim as "an unauthenticated request cannot read an agent's
   * record". These routes serve every phone number, note and disposition one agent
   * has touched across campaigns, so the second claim is the one that matters and
   * nothing asserted it.
   *
   * The real `authMiddleware` refuses by sending a 401 from the hook rather than by
   * throwing, and Fastify short-circuits the chain when a hook replies. So what
   * must be proven is the consequence: the flag is not consulted, the repository is
   * not queried, and the handler's own 400s never get a chance to reshape the
   * response into something that looks like a validation problem.
   */
  function refuse() {
    authSpy.mockImplementationOnce(async (_request: unknown, reply: unknown) => {
      await (reply as FastifyReply).code(401).send({
        error: 'Unauthorized', code: 'missing_tenant_headers',
      });
    });
  }

  it('401s /stats and reads nothing — not the flag, not the repository', async () => {
    const app = await makeApp();
    refuse();
    const res = await app.inject({
      method: 'GET', url: `/api/v1/agency-agents/u-ravi/stats?${WINDOW}`, headers: HEADERS,
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ code: 'missing_tenant_headers' });
    // The gate is INSIDE the handler, so it can only run if the hook let the
    // request through. Asserting it did not run is how we know the short-circuit
    // is real rather than the handler happening to agree.
    expect(flags.isEnabled).not.toHaveBeenCalled();
    expect(agentStats.stats).not.toHaveBeenCalled();
    await app.close();
  });

  it('401s /attempts and reads nothing', async () => {
    const app = await makeApp();
    refuse();
    const res = await app.inject({
      method: 'GET', url: '/api/v1/agency-agents/u-ravi/attempts', headers: HEADERS,
    });
    expect(res.statusCode).toBe(401);
    expect(flags.isEnabled).not.toHaveBeenCalled();
    expect(attempts.listForAgent).not.toHaveBeenCalled();
    await app.close();
  });

  it('the 401 wins over a request that is ALSO malformed', async () => {
    // Order matters on a surface that is a probe risk. If the handler's own
    // validation ran first, an unauthenticated caller sending a bad bucket would
    // get a 400 naming the valid vocabulary — a small but real disclosure, and
    // worse, a 400 rather than a 401 tells them the route exists and that their
    // credentials were never the problem. The hook is a `preHandler` on the plugin
    // so it runs before any handler body; this pins that ordering.
    const app = await makeApp();
    refuse();
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/agency-agents/%20/stats?bucket=hour&from=2026-08-19&to=2026-08-17',
      headers: HEADERS,
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).not.toHaveProperty('details');
    await app.close();
  });

  it('recovers on the next request — the refusal is not sticky', async () => {
    // `mockImplementationOnce`, so this also proves the fixture itself is not
    // leaving the plugin broken for the tests that follow.
    const app = await makeApp();
    refuse();
    expect((await app.inject({
      method: 'GET', url: `/api/v1/agency-agents/u-ravi/stats?${WINDOW}`, headers: HEADERS,
    })).statusCode).toBe(401);
    expect((await app.inject({
      method: 'GET', url: `/api/v1/agency-agents/u-ravi/stats?${WINDOW}`, headers: HEADERS,
    })).statusCode).toBe(200);
    await app.close();
  });
});

describe('`?agent_user_id=` is accepted, and the PATH is still the agent', () => {
  /**
   * ── The URL that must not mean two things ───────────────────────────────────
   *
   * `parseAgentAttemptFilters` delegates to the campaign spine's parser, which has
   * a real `agent_user_id` filter, so the parameter lands on `filters` for free.
   * The repository ignores it and keys on the path. That is documented in three
   * places and, until these tests, asserted at the route layer in none — so
   * nothing stopped a refactor from reading `filters.agentUserId` and turning
   * `/agency-agents/me/attempts?agent_user_id=someone-else` into a URL that reads
   * as one agent's and answers with another's.
   *
   * Accepting rather than 400ing is deliberate: code generated from the campaign
   * route sends both, and a redundancy is not a bad request. What the route owes
   * is that the value cannot win.
   */
  it('hands the repository the PATH agent even when the query contradicts it', async () => {
    const app = await makeApp();
    await app.inject({
      method: 'GET',
      url: '/api/v1/agency-agents/u-ravi/attempts?agent_user_id=u-someone-else',
      headers: HEADERS,
    });
    const call = attempts.listForAgent.mock.calls[0]?.[0] as {
      agentUserId: string; filters: { agentUserId?: string };
    };
    // The scope key: the path, always.
    expect(call.agentUserId).toBe('u-ravi');
    // Carried on the filter object, where the repository is known not to read it
    // (`agent-attempts-repository.test.ts` pins that against the SQL). Asserted
    // rather than ignored because the pairing is what makes either test meaningful.
    expect(call.filters.agentUserId).toBe('u-someone-else');
    await app.close();
  });

  it('does not 400 on the redundant-but-agreeing form a generated client sends', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/agency-agents/u-ravi/attempts?agent_user_id=u-ravi',
      headers: HEADERS,
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('treats a blank one as absent rather than as an empty-string filter', async () => {
    // `?agent_user_id=` is what a cleared field posts. An empty string present on
    // the filter object is falsy-but-there, and a repository testing presence
    // rather than truthiness would build `s.agent_user_id = ''` and answer an
    // empty page — which on this surface reads as "this agent has never worked
    // here".
    const app = await makeApp();
    await app.inject({
      method: 'GET', url: '/api/v1/agency-agents/u-ravi/attempts?agent_user_id=', headers: HEADERS,
    });
    const call = attempts.listForAgent.mock.calls[0]?.[0] as {
      agentUserId: string; filters: Record<string, unknown>;
    };
    expect(call.agentUserId).toBe('u-ravi');
    expect(Object.hasOwn(call.filters, 'agentUserId')).toBe(false);
    await app.close();
  });

  it('is ignored on /stats, which has no such filter at all', async () => {
    // The stats query vocabulary is `from`/`to`/`bucket`/`campaign_id` and nothing
    // else, so an `agent_user_id` here is neither honoured nor an error — it must
    // not appear on the params object the repository is handed, and it must not
    // 400 either.
    const app = await makeApp();
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/agency-agents/u-ravi/stats?${WINDOW}&agent_user_id=u-someone-else`,
      headers: HEADERS,
    });
    expect(res.statusCode).toBe(200);
    expect(agentStats.stats).toHaveBeenCalledWith(
      { tenantId: 't1', accountId: 'a1', agentUserId: 'u-ravi' },
      { from: new Date('2026-08-17T00:00:00.000Z'), to: new Date('2026-08-19T00:00:00.000Z'), bucket: 'day' },
    );
    await app.close();
  });
});

// ---------------------------------------------------------------------------
// `GET /agency-agents/stats` — THE ROSTER, and the route it must not become.
// ---------------------------------------------------------------------------

describe('GET /stats — route precedence against /:agentUserId/stats', () => {
  /**
   * ── Why this is the first thing the roster gets tested for ─────────────────
   *
   * Two routes on one plugin whose paths differ by a single segment, and both end
   * in `stats`. Fastify's radix tree separates them — the depths differ, and a
   * static segment beats a parametric one at the same position anyway — but NONE of
   * that is asserted by the routes merely existing, and both failure modes are
   * invisible to a status-code assertion:
   *
   *   * If `/stats` were captured as `:agentUserId` it would answer **200** from
   *     the per-agent handler for `agentUserId = "stats"`, which is a well-formed
   *     agent id as far as core can tell (`agent_user_id` is opaque, D3). A
   *     supervisor asking for the roster gets one non-existent agent's empty
   *     record, and every assertion about a 200 passes.
   *   * If `/stats` did not exist at all it would answer **404** — and MAG-106 in
   *     this repository was exactly an assertion that passed vacuously against a
   *     route that was not there.
   *
   * So both directions are pinned on WHICH REPOSITORY METHOD RAN, not on a status.
   */
  it('GET /stats reaches the ROSTER handler and never the per-agent one', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'GET', url: `/api/v1/agency-agents/stats?${WINDOW}`, headers: HEADERS,
    });
    // Not 404: the route exists. Not 400: `stats` was not read as an agent id and
    // then rejected. Not 200-from-the-wrong-handler: `stats` is asserted below.
    expect(res.statusCode).toBe(200);
    expect(agentStats.roster).toHaveBeenCalledTimes(1);
    expect(agentStats.stats).not.toHaveBeenCalled();
    await app.close();
  });

  it('GET /<uuid>/stats STILL reaches the per-agent handler', async () => {
    // The other half, and the one a new route silently steals. A parametric route
    // shadowed by a new static sibling is not a compile error and not a 404.
    const app = await makeApp();
    const res = await app.inject({
      method: 'GET', url: `/api/v1/agency-agents/${AGENT_UUID}/stats?${WINDOW}`, headers: HEADERS,
    });
    expect(res.statusCode).toBe(200);
    expect(agentStats.stats).toHaveBeenCalledWith(
      { tenantId: 't1', accountId: 'a1', agentUserId: AGENT_UUID },
      expect.objectContaining({ bucket: 'day' }),
    );
    expect(agentStats.roster).not.toHaveBeenCalled();
    await app.close();
  });

  it('GET /<uuid>/attempts is untouched by the new sibling', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'GET', url: `/api/v1/agency-agents/${AGENT_UUID}/attempts`, headers: HEADERS,
    });
    expect(res.statusCode).toBe(200);
    expect(attempts.listForAgent).toHaveBeenCalledTimes(1);
    expect(agentStats.roster).not.toHaveBeenCalled();
    await app.close();
  });

  it('the two handlers are told apart by the PATH, and only by the PATH', async () => {
    /**
     * `?agent_user_id=` cannot turn the roster into a per-agent read. It is not in
     * this route's vocabulary at all — narrowing to named agents is a later compare
     * surface, and accepting it would make `benchmark` mean something different per
     * request under the same name.
     *
     * ── Where the 400 for it lives, and why not here ──────────────────────────
     *
     * In MASTER. The frozen contract puts unknown-parameter refusal on master's
     * `forwardAllowedQuery` / `unknownQueryParamsError` (documented at length in its
     * `agency-spine.ts`) rather than duplicating a whitelist in core, and core's own
     * per-agent `/stats` already behaves this way — see "is ignored on /stats, which
     * has no such filter at all" above. So what core owes on this route is narrower
     * and is what is asserted: the value must not reach the repository, must not
     * reach the OTHER handler, and must not change the answer.
     */
    const app = await makeApp();
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/agency-agents/stats?${WINDOW}&agent_user_id=u-ravi`,
      headers: HEADERS,
    });
    expect(res.statusCode).toBe(200);
    expect(agentStats.stats).not.toHaveBeenCalled();
    expect(agentStats.roster).toHaveBeenCalledTimes(1);
    // Nothing agent-shaped on the params object: not as a filter, not smuggled
    // through as scope. The roster's whole vocabulary is window + campaign + ranking.
    const [scope, params] = agentStats.roster.mock.calls[0] as [
      Record<string, unknown>, Record<string, unknown>,
    ];
    expect(Object.keys(params).sort()).toEqual(['from', 'limit', 'order', 'sort', 'to']);
    expect(Object.keys(scope).sort()).toEqual(['accountId', 'tenantId']);
    await app.close();
  });
});

describe('GET /stats — the gate and the scope actually run', () => {
  it('checks the dialer flag for the CALLER\'s tenant and account', async () => {
    // `gate()` is INSIDE the handler, so a handler that forgot to call it is not a
    // status-code difference on the happy path — the read simply happens. This
    // asserts the call, and the 403 case is asserted plugin-wide above.
    const app = await makeApp();
    await app.inject({
      method: 'GET', url: `/api/v1/agency-agents/stats?${WINDOW}`,
      headers: { 'x-mgkvc-tenant': 't-other', 'x-mgkvc-account': 'a-other' },
    });
    expect(flags.isEnabled).toHaveBeenCalledWith(
      expect.anything(), { tenantId: 't-other', accountId: 'a-other' },
    );
    await app.close();
  });

  it('hands the repository BOTH scope halves — there is no path param to fall back on', async () => {
    // Unlike its two siblings this route has no path parameter at all, so these two
    // headers are the ONLY thing separating one account's floor from another's. A
    // handler that dropped `accountId` would answer a tenant-wide roster, which the
    // frozen contract says must not be reachable by omission.
    const app = await makeApp();
    await app.inject({
      method: 'GET', url: `/api/v1/agency-agents/stats?${WINDOW}`,
      headers: { 'x-mgkvc-tenant': 't-9', 'x-mgkvc-account': 'a-9' },
    });
    expect(agentStats.roster).toHaveBeenCalledWith(
      { tenantId: 't-9', accountId: 'a-9' },
      expect.objectContaining({ sort: 'successes', order: 'desc', limit: 100 }),
    );
    await app.close();
  });

  it('401s and reads nothing when the auth middleware refuses', async () => {
    const app = await makeApp();
    authSpy.mockImplementationOnce(async (_request: unknown, reply: unknown) => {
      await (reply as FastifyReply).code(401).send({
        error: 'Unauthorized', code: 'missing_tenant_headers',
      });
    });
    const res = await app.inject({
      method: 'GET', url: `/api/v1/agency-agents/stats?${WINDOW}`, headers: HEADERS,
    });
    expect(res.statusCode).toBe(401);
    // The gate is inside the handler, so asserting it did NOT run is how we know the
    // hook's short-circuit is real rather than the handler happening to agree.
    expect(flags.isEnabled).not.toHaveBeenCalled();
    expect(agentStats.roster).not.toHaveBeenCalled();
    await app.close();
  });
});

describe('GET /stats — the query vocabulary refuses rather than defaults', () => {
  const details = (body: unknown): { param: string; message: string }[] =>
    (body as { details: { param: string; message: string }[] }).details;

  it('400s a missing window rather than aggregating the floor\'s whole history', async () => {
    const app = await makeApp();
    const res = await app.inject({ method: 'GET', url: '/api/v1/agency-agents/stats', headers: HEADERS });
    expect(res.statusCode).toBe(400);
    expect(details(res.json()).map((d) => d.param).sort()).toEqual(['from', 'to']);
    expect(agentStats.roster).not.toHaveBeenCalled();
    await app.close();
  });

  it('400s an unknown sort and names the valid set', async () => {
    // The vocabulary is echoed, the way every other refusal on this surface does it,
    // so a client holding a stale sort list recovers in one round trip instead of
    // being handed a differently-ordered page that looks like an answer.
    const app = await makeApp();
    const res = await app.inject({
      method: 'GET', url: `/api/v1/agency-agents/stats?${WINDOW}&sort=agent_score`, headers: HEADERS,
    });
    expect(res.statusCode).toBe(400);
    const issue = details(res.json()).find((d) => d.param === 'sort');
    expect(issue?.message).toContain('unknown sort: agent_score');
    expect(issue?.message).toContain('connect_rate_pct');
    expect(issue?.message).toContain('occupancy_pct');
    expect(agentStats.roster).not.toHaveBeenCalled();
    await app.close();
  });

  it('400s an unknown order', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'GET', url: `/api/v1/agency-agents/stats?${WINDOW}&order=ascending`, headers: HEADERS,
    });
    expect(res.statusCode).toBe(400);
    expect(details(res.json()).find((d) => d.param === 'order')?.message)
      .toContain('expected one of asc, desc');
    await app.close();
  });

  it('400s a limit outside 1..200 rather than clamping it', async () => {
    // A deliberate divergence from the attempt spine's `clampLimit`. That limit is a
    // page size on a CURSOR-paged list, where a clamped value still returns the next
    // rows. This one truncates a RANKED list with no cursor, so a silently changed
    // limit changes WHICH agents are on the page — and `total_agents` is the only
    // hint, which a caller who did not know their limit moved will not read as one.
    const app = await makeApp();
    for (const limit of ['0', '201', 'abc', '-5', '1.5', '99999']) {
      const res = await app.inject({
        method: 'GET', url: `/api/v1/agency-agents/stats?${WINDOW}&limit=${limit}`, headers: HEADERS,
      });
      expect(res.statusCode, `limit=${limit}`).toBe(400);
      expect(details(res.json()).find((d) => d.param === 'limit')?.message)
        .toContain('between 1 and 200');
    }
    expect(agentStats.roster).not.toHaveBeenCalled();
    await app.close();
  });

  it('400s a malformed campaign_id before it can reach a ::uuid cast', async () => {
    // `22P02 invalid input syntax for type uuid` maps to no status, so it surfaces as
    // a 500 carrying the database's error text — a bad request that reads as a broken
    // service, on a route a supervisor reaches from a link.
    const app = await makeApp();
    const res = await app.inject({
      method: 'GET', url: `/api/v1/agency-agents/stats?${WINDOW}&campaign_id=not-a-uuid`, headers: HEADERS,
    });
    expect(res.statusCode).toBe(400);
    expect(details(res.json()).find((d) => d.param === 'campaign_id')).toBeDefined();
    await app.close();
  });

  it('ignores `bucket` — it belongs to the per-agent record, and master refuses it', async () => {
    // There are no date buckets on this route: a count and a duration are
    // zone-independent, so none of the per-campaign-timezone machinery applies. Core
    // does not whitelist query params (that is master's `unknownQueryParamsError`,
    // per the frozen contract), so what core owes is that the value changes nothing
    // — in particular that it cannot resurrect a `bucket` field on the params object
    // and reach a `date_trunc` that no longer exists on this path.
    const app = await makeApp();
    const res = await app.inject({
      method: 'GET', url: `/api/v1/agency-agents/stats?${WINDOW}&bucket=day`, headers: HEADERS,
    });
    expect(res.statusCode).toBe(200);
    const params = agentStats.roster.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(Object.hasOwn(params, 'bucket')).toBe(false);
    await app.close();
  });

  it('defaults sort/order/limit when absent, and passes the window through unchanged', async () => {
    const app = await makeApp();
    await app.inject({
      method: 'GET',
      url: '/api/v1/agency-agents/stats?from=2026-08-17&to=2026-08-24'
        + '&campaign_id=11111111-2222-3333-4444-555555555555&sort=occupancy_pct&order=asc&limit=25',
      headers: HEADERS,
    });
    expect(agentStats.roster).toHaveBeenCalledWith(expect.anything(), {
      from: new Date('2026-08-17T00:00:00.000Z'),
      to: new Date('2026-08-24T00:00:00.000Z'),
      campaignId: '11111111-2222-3333-4444-555555555555',
      sort: 'occupancy_pct',
      order: 'asc',
      limit: 25,
    });
    await app.close();
  });

  it('serves the repository payload verbatim, benchmark and all', async () => {
    // The route composes nothing on this surface — unlike the campaign stats route,
    // which is a two-producer payload. Everything here comes from one read, so a
    // field appearing or disappearing between the repository and the wire is a bug
    // rather than a design.
    const payload = { ...EMPTY_ROSTER, from: '2026-08-17T00:00:00.000Z', to: '2026-08-24T00:00:00.000Z' };
    agentStats.roster.mockResolvedValue(payload);
    const app = await makeApp();
    const res = await app.inject({
      method: 'GET', url: `/api/v1/agency-agents/stats?${WINDOW}`, headers: HEADERS,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(payload);
    await app.close();
  });
});

// ---------------------------------------------------------------------------
// `GET /agency-agents/grouped-stats` — the fourth route, and the two refusals
// that are not typos.
//
// The parsing rules themselves are pinned in `agent-record.test.ts`, against the
// pure function, including the boundary case for every threshold. What is pinned
// HERE is only what the route layer owns: that the route exists and is the one
// that answers, that auth and the gate actually run on it, that the caller's scope
// reaches the repository, and that the two coded refusals reach the WIRE as a
// `code` rather than as prose a client has to parse.
// ---------------------------------------------------------------------------

describe('GET /grouped-stats — route precedence against its three siblings', () => {
  /**
   * A fourth route on a plugin that already has a static `/stats` and a parametric
   * `/:agentUserId/stats`, and both failure modes are invisible to a status-code
   * assertion — which is the MAG-106 shape this file exists to keep out:
   *
   *   * if `/grouped-stats` were captured as `:agentUserId` there is no
   *     `/:agentUserId` route to catch it, so it would 404 — and a 404 is also what
   *     a route that was never registered answers;
   *   * if it shadowed something, the victim would answer 200 from the wrong
   *     handler.
   *
   * So all four directions are pinned on WHICH REPOSITORY METHOD RAN.
   */
  it('reaches the grouped handler, and neither the roster nor the per-agent one', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'GET', url: `/api/v1/agency-agents/grouped-stats?${GROUPED_QUERY}`, headers: HEADERS,
    });
    expect(res.statusCode).toBe(200);
    expect(agentStats.groupedStats).toHaveBeenCalledTimes(1);
    expect(agentStats.roster).not.toHaveBeenCalled();
    expect(agentStats.stats).not.toHaveBeenCalled();
    await app.close();
  });

  it('leaves /stats, /<uuid>/stats and /<uuid>/attempts exactly where they were', async () => {
    // The half a new sibling silently steals. A parametric route shadowed by a new
    // static one is not a compile error and not a 404.
    const app = await makeApp();

    expect((await app.inject({
      method: 'GET', url: `/api/v1/agency-agents/stats?${WINDOW}`, headers: HEADERS,
    })).statusCode).toBe(200);
    expect(agentStats.roster).toHaveBeenCalledTimes(1);
    expect(agentStats.groupedStats).not.toHaveBeenCalled();

    expect((await app.inject({
      method: 'GET', url: `/api/v1/agency-agents/${AGENT_UUID}/stats?${WINDOW}`, headers: HEADERS,
    })).statusCode).toBe(200);
    expect(agentStats.stats).toHaveBeenCalledTimes(1);

    expect((await app.inject({
      method: 'GET', url: `/api/v1/agency-agents/${AGENT_UUID}/attempts`, headers: HEADERS,
    })).statusCode).toBe(200);
    expect(attempts.listForAgent).toHaveBeenCalledTimes(1);

    expect(agentStats.groupedStats).not.toHaveBeenCalled();
    await app.close();
  });

  it('does not answer `/<uuid>/grouped-stats` — the read names no agent', async () => {
    // There is deliberately no per-agent grouped route: `agent_user_id` is opaque
    // to core (D3), so core cannot validate tenancy on a caller-supplied id, and
    // narrowing to a person is the per-agent record's job. A 404 here is the honest
    // answer, and asserting it stops a future `/:agentUserId/grouped-stats` from
    // appearing without the master-side membership check that would have to come
    // with it.
    const app = await makeApp();
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/agency-agents/${AGENT_UUID}/grouped-stats?${GROUPED_QUERY}`,
      headers: HEADERS,
    });
    expect(res.statusCode).toBe(404);
    expect(agentStats.groupedStats).not.toHaveBeenCalled();
    await app.close();
  });
});

describe('GET /grouped-stats — the gate and the scope actually run', () => {
  it('checks the dialer flag for the CALLER\'s tenant and account', async () => {
    // `gate()` is INSIDE the handler, so a handler that forgot to call it is not a
    // status-code difference on the happy path — the read simply happens.
    const app = await makeApp();
    await app.inject({
      method: 'GET', url: `/api/v1/agency-agents/grouped-stats?${GROUPED_QUERY}`,
      headers: { 'x-mgkvc-tenant': 't-other', 'x-mgkvc-account': 'a-other' },
    });
    expect(flags.isEnabled).toHaveBeenCalledWith(
      expect.anything(), { tenantId: 't-other', accountId: 'a-other' },
    );
    await app.close();
  });

  it('hands the repository BOTH scope halves and nothing agent-shaped', async () => {
    // No path parameter on this route either, so these two headers are the only
    // thing separating one account's numbers from another's. And `agent_user_id` is
    // not in this route's vocabulary at all: core cannot validate it, so a value
    // that reached the params object would be a tenancy hole rather than a filter.
    const app = await makeApp();
    await app.inject({
      method: 'GET',
      url: `/api/v1/agency-agents/grouped-stats?${GROUPED_QUERY}&agent_user_id=u-ravi`,
      headers: { 'x-mgkvc-tenant': 't-9', 'x-mgkvc-account': 'a-9' },
    });
    const [scope, filters] = agentStats.groupedStats.mock.calls[0] as [
      Record<string, unknown>, Record<string, unknown>,
    ];
    expect(scope).toEqual({ tenantId: 't-9', accountId: 'a-9' });
    expect(Object.keys(filters).sort()).toEqual(['from', 'groupBy', 'limit', 'order', 'sort', 'to']);
    await app.close();
  });

  it('401s and reads nothing when the auth middleware refuses', async () => {
    const app = await makeApp();
    authSpy.mockImplementationOnce(async (_request: unknown, reply: unknown) => {
      await (reply as FastifyReply).code(401).send({
        error: 'Unauthorized', code: 'missing_tenant_headers',
      });
    });
    const res = await app.inject({
      method: 'GET', url: `/api/v1/agency-agents/grouped-stats?${GROUPED_QUERY}`, headers: HEADERS,
    });
    expect(res.statusCode).toBe(401);
    // The gate is inside the handler, so asserting it did NOT run is how we know the
    // hook's short-circuit is real rather than the handler happening to agree.
    expect(flags.isEnabled).not.toHaveBeenCalled();
    expect(agentStats.groupedStats).not.toHaveBeenCalled();
    await app.close();
  });

  it('the 401 wins over a request that is ALSO unanswerable', async () => {
    // Order matters on a probe-risk surface. If the handler's validation ran first,
    // an unauthenticated caller would learn the route exists, learn the dimension
    // vocabulary from the 400, and learn that their credentials were never the
    // problem.
    const app = await makeApp();
    authSpy.mockImplementationOnce(async (_request: unknown, reply: unknown) => {
      await (reply as FastifyReply).code(401).send({
        error: 'Unauthorized', code: 'missing_tenant_headers',
      });
    });
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/agency-agents/grouped-stats?${WINDOW}&group_by=hour_of_day&limit=0`,
      headers: HEADERS,
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).not.toHaveProperty('details');
    expect(res.json()).not.toHaveProperty('code', 'timezone_ambiguous');
    await app.close();
  });
});

describe('GET /grouped-stats — the two coded refusals reach the wire', () => {
  const body = (raw: unknown) => raw as {
    code?: string; details: { param: string; message: string }[];
  };

  it('400s three dimensions as `too_many_dimensions`, and still sends the details', async () => {
    // A CODE, because the request is well-formed — every value is in the vocabulary
    // — so a client has to be able to tell this from a typo without parsing prose.
    const app = await makeApp();
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/agency-agents/grouped-stats?${WINDOW}&group_by=agent,campaign,disposition`,
      headers: HEADERS,
    });
    expect(res.statusCode).toBe(400);
    expect(body(res.json()).code).toBe('too_many_dimensions');
    expect(body(res.json()).details.find((d) => d.param === 'group_by')?.message)
      .toContain('at most 2');
    expect(agentStats.groupedStats).not.toHaveBeenCalled();
    await app.close();
  });

  it('400s a bare time dimension as `timezone_ambiguous`, naming both remedies', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/agency-agents/grouped-stats?${WINDOW}&group_by=hour_of_day`,
      headers: HEADERS,
    });
    expect(res.statusCode).toBe(400);
    expect(body(res.json()).code).toBe('timezone_ambiguous');
    const message = body(res.json()).details.find((d) => d.param === 'group_by')?.message ?? '';
    expect(message).toContain('campaign_id');
    expect(message).toContain('group_by');
    expect(agentStats.groupedStats).not.toHaveBeenCalled();
    await app.close();
  });

  it('answers the same read once EITHER remedy is applied', async () => {
    // The other half, so the refusal is not merely a wall: both named remedies have
    // to actually work, and they are not interchangeable — adding `campaign` keeps
    // the read cross-campaign, filtering to one narrows it.
    const app = await makeApp();
    for (const query of [
      `${WINDOW}&group_by=campaign,hour_of_day`,
      `${WINDOW}&group_by=hour_of_day&campaign_id=11111111-2222-3333-4444-555555555555`,
    ]) {
      agentStats.groupedStats.mockClear();
      const res = await app.inject({
        method: 'GET', url: `/api/v1/agency-agents/grouped-stats?${query}`, headers: HEADERS,
      });
      expect(res.statusCode, query).toBe(200);
      expect(agentStats.groupedStats).toHaveBeenCalledTimes(1);
    }
    await app.close();
  });

  it('sends NO `code` for an ordinary validation 400', async () => {
    // The absence is the point: a client keying on `code` must not see a
    // `too_many_dimensions` on a request whose real problem was a typo.
    const app = await makeApp();
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/agency-agents/grouped-stats?${WINDOW}&group_by=team`,
      headers: HEADERS,
    });
    expect(res.statusCode).toBe(400);
    expect(Object.hasOwn(res.json() as object, 'code')).toBe(false);
    expect(body(res.json()).details[0]?.message).toContain('unknown group_by: team');
    await app.close();
  });

  it('keeps the code AND the whole issue list when a request is wrong twice', async () => {
    // A caller with two mistakes should learn both in one round trip; lifting the
    // code must not replace the list.
    const app = await makeApp();
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/agency-agents/grouped-stats?${WINDOW}&group_by=day&limit=0`,
      headers: HEADERS,
    });
    expect(res.statusCode).toBe(400);
    expect(body(res.json()).code).toBe('timezone_ambiguous');
    expect(body(res.json()).details.map((d) => d.param).sort()).toEqual(['group_by', 'limit']);
    await app.close();
  });

  it('400s a missing `group_by` rather than defaulting to one', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'GET', url: `/api/v1/agency-agents/grouped-stats?${WINDOW}`, headers: HEADERS,
    });
    expect(res.statusCode).toBe(400);
    expect(body(res.json()).details.find((d) => d.param === 'group_by')?.message)
      .toContain('required');
    expect(agentStats.groupedStats).not.toHaveBeenCalled();
    await app.close();
  });
});

describe('GET /grouped-stats — the params reach the repository as parsed', () => {
  it('passes the canonicalised grouping, the window, and all three ranking params', async () => {
    const app = await makeApp();
    await app.inject({
      method: 'GET',
      url: '/api/v1/agency-agents/grouped-stats?from=2026-08-17&to=2026-08-24'
        + '&group_by=campaign,agent&campaign_id=11111111-2222-3333-4444-555555555555'
        + '&sort=successes&order=desc&limit=25',
      headers: HEADERS,
    });
    expect(agentStats.groupedStats).toHaveBeenCalledWith(
      { tenantId: 't1', accountId: 'a1' },
      {
        from: new Date('2026-08-17T00:00:00.000Z'),
        to: new Date('2026-08-24T00:00:00.000Z'),
        campaignId: '11111111-2222-3333-4444-555555555555',
        // CANONICAL order, not the order the URL spelled it in — so
        // `campaign,agent` and `agent,campaign` are one read.
        groupBy: ['agent', 'campaign'],
        sort: 'successes', order: 'desc', limit: 25,
      },
    );
    await app.close();
  });

  it('defaults sort/order/limit to key/asc/200 when absent', async () => {
    const app = await makeApp();
    await app.inject({
      method: 'GET', url: `/api/v1/agency-agents/grouped-stats?${GROUPED_QUERY}`, headers: HEADERS,
    });
    expect(agentStats.groupedStats).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ sort: 'key', order: 'asc', limit: 200 }),
    );
    await app.close();
  });

  it('serves the repository payload verbatim', async () => {
    // The route composes nothing on this surface: everything comes from one read,
    // so a field appearing or disappearing between the repository and the wire is a
    // bug rather than a design.
    const payload = {
      ...EMPTY_GROUPED,
      from: '2026-08-17T00:00:00.000Z', to: '2026-08-24T00:00:00.000Z',
      // A NON-null zone, so this pins the string surviving the hop rather than
      // agreeing with the route about a null. What it does NOT prove is anything
      // about which zone is correct — the repository decides that, and
      // `agent-grouped-repository.test.ts` is where that is pinned.
      resolved_timezone: 'Asia/Kolkata',
      total_groups: 3,
      rows: [{
        key: { agent_user_id: 'u-anita' },
        attempts: 400, connected: 200, successes: 60,
        talk_seconds: 40000, wrapup_seconds: 4000,
        connect_rate_pct: 50, success_rate_pct: 30, aht_seconds: 220,
      }],
    };
    agentStats.groupedStats.mockResolvedValue(payload);
    const app = await makeApp();
    const res = await app.inject({
      method: 'GET', url: `/api/v1/agency-agents/grouped-stats?${GROUPED_QUERY}`, headers: HEADERS,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(payload);
    await app.close();
  });
});
