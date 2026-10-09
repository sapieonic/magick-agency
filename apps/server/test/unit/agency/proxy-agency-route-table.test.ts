import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { readFileSync } from 'node:fs';

/**
 * **The agency proxy's route table, asserted from Fastify's own routing.**
 *
 * ── Why this file exists ─────────────────────────────────────────────────────
 * "Which agency routes does the public API layer serve?" was answered twice in one day by
 * grepping for `\.(get|post)\(` and both answers were wrong the same way. Every
 * route carrying a `Params` type is written
 *
 *     app.post<{ Params: { id: string } }>('/sessions/:id/available', …)
 *
 * so the generic sits between the verb and the paren and the pattern misses it.
 * The agent plugin reports **1 route** to that grep and registers **11**. The
 * conclusion drawn — that no agent action route was proxied, that the console
 * could not work end to end, and that the whole action surface still had to be
 * written — was the opposite of the truth, and acting on it would have meant
 * re-implementing eleven live routes over the top of themselves.
 *
 * A comment cannot fix this and neither can a better grep: the next person will
 * run the same grep. What fixes it is making the route table **executable**, so
 * the question is answered by running a test rather than by reading source.
 *
 * ── What it asserts, and why in this shape ───────────────────────────────────
 * Two different things, because they fail differently:
 *
 * 1. **The exact registered set**, collected through Fastify's `onRoute` hook —
 *    the router's own record, not source text. An addition or a removal shows up
 *    as a diff on a list, which is the cheapest possible review signal.
 * 2. **Every path the browser client actually calls resolves** — asserted as
 *    "not 404", which is precisely the property that matters. A route was
 *    believed landed for hours partly because there was no assertion connecting
 *    the client's path strings to the registered routes: "ticket done" and
 *    "endpoint exists" were different events, and nothing in the suite
 *    could tell them apart.
 *
 * The client list is hand-maintained here, and that is a real limitation worth
 * naming rather than hiding: the server cannot import the console. It is the same
 * hand-maintained-mirror arrangement as the console's `types/agency.ts` against
 * the server's contracts, and it carries the same duty — when `src/api/agency.ts`
 * in `apps/console` gains a call, it gains a line here.
 */

const mocks = vi.hoisted(() => ({
  proxyToCore: vi.fn(),
  agencyIngestService: {},
  auditLog: vi.fn(),
  // `rosterReplaceEnabled: false` is production's value, and the campaign
  // plugin's route table is a FUNCTION of it — `/campaigns/:id/roster/clear` is
  // registered only when it is set. So the expected set below is the set a
  // default deployment serves, and the flag is stated here rather than left to
  // whatever the real config module would have answered.
  config: { agency: { rosterReplaceEnabled: false } },
}));

vi.mock('../../../src/api/core-dispatch.js', () => ({ callCore: mocks.proxyToCore }));
vi.mock('@magick-agency/observability', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@magick-agency/observability')>()),
  createChildLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../../../src/auth/session.middleware.js', () => ({ sessionMiddleware: async () => {} }));
vi.mock('../../../src/api/middleware/tenant-context.middleware.js', () => ({
  tenantContextMiddleware: async () => {},
}));
// RBAC is stubbed open on purpose: this file asks "does the router know this
// path", and a 403 would answer that just as well as a 200 while making the
// assertion depend on the permission matrix, which its siblings already own.
vi.mock('../../../src/rbac/rbac.middleware.js', () => ({
  requirePermission: () => async () => {},
}));
// ── The campaign plugin's collaborators ────────────────────────────────────
// None is exercised by anything in this file — it asks only what the ROUTER
// knows — but importing the plugin pulls all of them in, and the real config
// module `process.exit(1)`s on an unset env.
vi.mock('../../../src/audit/platform/audit-logger.js', () => ({ platformAuditLogger: { log: mocks.auditLog } }));
vi.mock('../../../src/config/index.js', () => ({ config: mocks.config }));
vi.mock('../../../src/storage/s3.js', () => ({
  getFileStream: vi.fn(),
  getFile: vi.fn(),
  uploadFile: vi.fn(),
}));
vi.mock('../../../src/agency/agency-ingest-job.repository.js', () => ({
  agencyIngestJobRepository: { create: vi.fn(), findById: vi.fn(), requestCancel: vi.fn() },
}));
vi.mock('../../../src/agency/agency-ingest.service.js', () => ({
  agencyIngestService: { run: vi.fn() },
}));

import { proxyAgencyAgentRoutes } from '../../../src/api/routes/proxy-agency-agent.routes.js';
import { proxyAgencyCampaignsRoutes } from '../../../src/api/routes/proxy-agency-campaigns.routes.js';

const PREFIX = '/proxy/agency';

/**
 * Every agency path the browser client issues, from `src/api/agency.ts` in
 * `apps/console` — the exported functions, in file order.
 *
 * Concrete ids rather than `:id` templates: the point is that the **router
 * resolves what the client sends**, and a parameterised path that fails to match
 * a concrete one is exactly the failure this is looking for.
 */
const CLIENT_CALLS: ReadonlyArray<{ fn: string; method: 'POST'; url: string }> = [
  { fn: 'createAgencySession', method: 'POST', url: `${PREFIX}/sessions` },
  { fn: 'mintStationToken', method: 'POST', url: `${PREFIX}/sessions/sess-1/station-token` },
  { fn: 'setAgentAvailable', method: 'POST', url: `${PREFIX}/sessions/sess-1/available` },
  { fn: 'leaveAgencySession', method: 'POST', url: `${PREFIX}/sessions/sess-1/leave` },
  { fn: 'hangupAttempt', method: 'POST', url: `${PREFIX}/attempts/att-1/hangup` },
  { fn: 'setAgentBreak', method: 'POST', url: `${PREFIX}/sessions/sess-1/break` },
  { fn: 'cancelQueuedBreak', method: 'POST', url: `${PREFIX}/sessions/sess-1/break/cancel` },
  { fn: 'submitDisposition', method: 'POST', url: `${PREFIX}/attempts/att-1/disposition` },
  { fn: 'saveAttemptNotes', method: 'POST', url: `${PREFIX}/attempts/att-1/notes` },
];

/**
 * Every CAMPAIGN path the supervisor console issues, from
 * `src/api/agencyCampaigns.ts` in `apps/console`.
 *
 * Deliberately not exhaustive over that file — it is the same hand-maintained
 * mirror the agent list above is, with the same duty and the same limitation
 * (the server cannot import the console). What earns a line here is a path whose SHAPE the
 * router could get wrong: a nested segment after a param, a new sub-collection,
 * a verb that differs from its neighbours. A flat `GET /campaigns` cannot fail
 * to resolve in an interesting way; `GET /campaigns/:id/retry/preview` sitting
 * beside a `:id`-terminal read at a lower floor absolutely can.
 */
const CAMPAIGN_CLIENT_CALLS: ReadonlyArray<{ fn: string; method: 'GET' | 'POST'; url: string }> = [
  { fn: 'retryPreview', method: 'GET', url: `${PREFIX}/campaigns/camp-1/retry/preview` },
  { fn: 'createRetry', method: 'POST', url: `${PREFIX}/campaigns/camp-1/retry` },
  { fn: 'campaignLineage', method: 'GET', url: `${PREFIX}/campaigns/camp-1/lineage` },
];

/**
 * The campaign plugin's registered surface, as route templates, with
 * `AGENCY_ROSTER_REPLACE_ENABLED` off (see the `config` mock above).
 *
 * The same sorted-set comparison the agent plugin gets, and here it buys one
 * more thing: this plugin's routes do NOT share a floor — `GET /campaigns/:id`
 * is `viewer` and the attempt spine beside it is `account_admin` — so a route
 * appearing or disappearing from this list is a change to what the browser can
 * reach and at which level, not just a routing detail.
 */
const EXPECTED_CAMPAIGN_ROUTES = [
  'GET /proxy/agency/campaigns',
  'GET /proxy/agency/campaigns/:id',
  'GET /proxy/agency/campaigns/:id/activity',
  'GET /proxy/agency/campaigns/:id/activity.csv',
  'GET /proxy/agency/campaigns/:id/attempts',
  'GET /proxy/agency/campaigns/:id/attempts.csv',
  'GET /proxy/agency/campaigns/:id/contacts',
  'GET /proxy/agency/campaigns/:id/contacts.csv',
  'GET /proxy/agency/campaigns/:id/contacts/:contactId',
  'GET /proxy/agency/campaigns/:id/lineage',
  'GET /proxy/agency/campaigns/:id/retry/preview',
  'GET /proxy/agency/campaigns/:id/stats',
  'GET /proxy/agency/campaigns/:id/stats/series',
  'GET /proxy/agency/ingest/jobs/:id',
  'GET /proxy/agency/ingest/jobs/:id/rejected.csv',
  'GET /proxy/agency/ingest/limits',
  'PATCH /proxy/agency/campaigns/:id',
  'POST /proxy/agency/campaigns',
  'POST /proxy/agency/campaigns/:id/pause',
  'POST /proxy/agency/campaigns/:id/resume',
  'POST /proxy/agency/campaigns/:id/retry',
  'POST /proxy/agency/campaigns/:id/start',
  'POST /proxy/agency/campaigns/:id/stop',
  'POST /proxy/agency/ingest/analyze',
  'POST /proxy/agency/ingest/jobs',
  'POST /proxy/agency/ingest/jobs/:id/cancel',
  'POST /proxy/agency/ingest/upload',
];

/** The agent plugin's registered surface, as route templates. */
const EXPECTED_AGENT_ROUTES = [
  'POST /proxy/agency/attempts/:id/disposition',
  'POST /proxy/agency/attempts/:id/dnc',
  'POST /proxy/agency/attempts/:id/hangup',
  'POST /proxy/agency/attempts/:id/notes',
  'POST /proxy/agency/sessions',
  'POST /proxy/agency/sessions/:id/available',
  'POST /proxy/agency/sessions/:id/break',
  'POST /proxy/agency/sessions/:id/break/cancel',
  'POST /proxy/agency/sessions/:id/force-available',
  'POST /proxy/agency/sessions/:id/leave',
  'POST /proxy/agency/sessions/:id/station-token',
];

/** Bodies that satisfy each route's schema, so a 400 cannot be mistaken for a 404. */
const BODIES: Record<string, unknown> = {
  [`${PREFIX}/sessions`]: { campaign_id: '00000000-0000-4000-8000-000000000001' },
  [`${PREFIX}/sessions/sess-1/break`]: { reason: 'lunch' },
  [`${PREFIX}/attempts/att-1/disposition`]: { disposition_code: 'sale' },
  [`${PREFIX}/attempts/att-1/notes`]: { notes: 'ok' },
};

async function buildAgentApp(): Promise<{ app: FastifyInstance; routes: string[] }> {
  const app = Fastify({ logger: false });
  const routes: string[] = [];
  // Fastify's own record of what it will route. Source text does not get a vote.
  app.addHook('onRoute', (route) => {
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    for (const method of methods) {
      if (method === 'HEAD') continue;
      routes.push(`${method} ${route.url}`);
    }
  });
  app.addHook('onRequest', async (request) => {
    // Double cast, unlike the sibling suites' single one: `lint:test` (landed at
    // `0331965`) rejects `FastifyRequest as Record<string, unknown>` under
    // TS2352, so the shorter form in `proxy-agency-agent-actions.test.ts` is one
    // of that script's 169 outstanding errors rather than a pattern to copy.
    const r = request as unknown as Record<string, unknown>;
    r['tenantId'] = 'tenant-1';
    r['accountId'] = 'account-1';
    r['user'] = { id: 'user-agent-1' };
    r['membership'] = { role: 'agent' };
  });
  await app.register(proxyAgencyAgentRoutes, { prefix: PREFIX });
  await app.ready();
  return { app, routes };
}

/** The same harness for the campaign plugin, whose caller is a supervisor. */
async function buildCampaignApp(): Promise<{ app: FastifyInstance; routes: string[] }> {
  const app = Fastify({ logger: false });
  const routes: string[] = [];
  app.addHook('onRoute', (route) => {
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    for (const method of methods) {
      if (method === 'HEAD') continue;
      routes.push(`${method} ${route.url}`);
    }
  });
  app.addHook('onRequest', async (request) => {
    const r = request as unknown as Record<string, unknown>;
    r['tenantId'] = 'tenant-1';
    r['accountId'] = 'account-1';
    r['user'] = { id: 'user-supervisor-1' };
    r['membership'] = { role: 'account_admin' };
  });
  await app.register(proxyAgencyCampaignsRoutes, { prefix: PREFIX });
  await app.ready();
  return { app, routes };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.proxyToCore.mockResolvedValue({ status: 200, body: { attempt_id: 'att-1' } });
});

describe('the agent proxy registers the whole action surface', () => {
  it('registers exactly these eleven routes', async () => {
    const { routes } = await buildAgentApp();

    // A sorted set comparison rather than a count: `toHaveLength(11)` would pass
    // if a route were swapped for a different one, which is the change most
    // likely to be made by accident.
    expect([...routes].sort()).toEqual(EXPECTED_AGENT_ROUTES);
  });

  it('is not the one route a verb-paren grep reports', async () => {
    const { routes } = await buildAgentApp();

    /**
     * The assertion this whole file is named for. `1` is what
     * `grep -cE '\.(get|post)\('` returns against this plugin, because ten of
     * the eleven registrations carry a generic type parameter. Pinned as a number
     * so a future reader can see the size of the gap between the two methods.
     */
    expect(routes.length).toBe(11);
    expect(routes.length).not.toBe(1);
  });
});

describe('the campaign proxy registers the supervisor surface', () => {
  it('registers exactly this set', async () => {
    const { routes } = await buildCampaignApp();

    // Sorted set, not a count, for the reason the agent case gives: a count
    // passes when one route is swapped for another, which is the change most
    // likely to be made by accident.
    expect([...routes].sort()).toEqual(EXPECTED_CAMPAIGN_ROUTES);
  });

  it('the verb-paren grep under-reports this plugin too', async () => {
    const { routes } = await buildCampaignApp();

    /**
     * The same measurement this file is named for, on the plugin that actually
     * carries the supervisor's whole surface. Every route here that takes an
     * `:id` is written `app.get<{ Params: { id: string } }>('…')`, so the
     * pattern misses all but a handful — and the routes it misses are the ones
     * that matter, because a flat `/campaigns` is not what anybody draws a wrong
     * conclusion about.
     */
    const grepVisible = readFileSync(
      new URL('../../../src/api/routes/proxy-agency-campaigns.routes.ts', import.meta.url),
      'utf8',
    ).match(/\.(?:get|post|patch|put|delete)\(/g) ?? [];

    expect(grepVisible.length).toBeLessThan(routes.length);
  });
});

describe('every campaign path the supervisor console calls resolves', () => {
  for (const call of CAMPAIGN_CLIENT_CALLS) {
    it(`${call.fn} → ${call.method} ${call.url.replace(PREFIX, '')}`, async () => {
      const { app } = await buildCampaignApp();

      // Same property, same reason as the agent block below: 404 is the only
      // failure that matters, because it is the one that is invisible in both
      // repos' suites and reaches the supervisor as a control that does nothing.
      // A 400 from the create's schema still proves the router matched.
      const res = await app.inject({ method: call.method, url: call.url, payload: {} });

      expect(res.statusCode).not.toBe(404);
      await app.close();
    });
  }

  it('the retry preview is not swallowed by the `:id`-terminal campaign read', async () => {
    /**
     * The specific routing hazard these three paths introduce, pinned rather
     * than assumed. `GET /campaigns/:id` floors at `viewer` and interpolates its
     * param as the LAST segment of the internal handler path; `GET /campaigns/:id/retry/preview`
     * floors two role levels above it. If find-my-way ever preferred the param
     * route, a viewer would reach the supervisory read — which is exactly the
     * escalation `rejectPathEscapingParams()` exists for, arriving by a
     * different door.
     *
     * Asserted through the internal path the proxy builds, because that is the
     * observable difference: both routes answer 200 here.
     */
    const { app } = await buildCampaignApp();

    await app.inject({ method: 'GET', url: `${PREFIX}/campaigns/camp-1/retry/preview` });

    expect(mocks.proxyToCore).toHaveBeenCalledWith(
      expect.objectContaining({ path: '/agency-campaigns/camp-1/retry/preview' }),
    );
    await app.close();
  });
});

describe('every path the browser client calls resolves', () => {
  for (const call of CLIENT_CALLS) {
    it(`${call.fn} → ${call.method} ${call.url.replace(PREFIX, '')}`, async () => {
      const { app } = await buildAgentApp();

      const res = await app.inject({
        method: call.method,
        url: call.url,
        payload: BODIES[call.url] ?? {},
      });

      /**
       * 404 is the only failure that matters here: it means the browser sends a
       * request the server does not serve, which is invisible to the rest of the suite
       * and surfaces to the agent as a button that does nothing. Any other status
       * — including a 400 or a 403 — proves the router matched.
       */
      expect(res.statusCode).not.toBe(404);
      await app.close();
    });
  }
});

describe('every agent action route carries its RBAC permission', () => {
  /**
   * ── Why this is asserted against the SOURCE TEXT ───────────────────────────
   * `requirePermission` is mocked to a no-op at the top of this file (line ~67)
   * — it has to be, or every case above would be re-testing the RBAC middleware
   * instead of the router. The cost is that **no behavioural test in this file,
   * or in `proxy-agency-agent-actions.test.ts`, can observe a missing guard on
   * every route** — that sibling file exercises real RBAC, but only on
   * `disposition`/`notes`/`force-available`/`break/cancel`; `POST /sessions`,
   * `/sessions/:id/available`, `/sessions/:id/leave`, `/sessions/:id/station-token`,
   * `/sessions/:id/break`, and `/attempts/:id/dnc` are never called there at all.
   *
   * Measured: deleting
   * `preHandler: requirePermission('agency.station.connect')` from
   * `POST /sessions` in `proxy-agency-agent.routes.ts` left the entire
   * `test/unit/agency/` suite green — 309 passed, 0 failed. That is the same
   * shape as the roster-ingest route that once shipped unauthenticated. These are the
   * routes an agent calls **mid-call** — hang up, submit disposition, mark DNC —
   * so an unguarded one is reachable by any authenticated caller in the tenant
   * regardless of role.
   *
   * The campaigns plugin (`proxy-agency-campaigns.routes.ts`) gets the same block:
   * a source-text assertion per route, plus a
   * registration count so a route ADDED without a guard reds too — the per-route
   * list alone can only catch a guard removed from a route it already names, and
   * an added unguarded route is the real failure mode, not the hypothetical one.
   */
  const agentSource = readFileSync(
    new URL('../../../src/api/routes/proxy-agency-agent.routes.ts', import.meta.url),
    'utf8',
  );

  // Route → the permission it must carry, in the order they appear in the file.
  const EXPECTED: ReadonlyArray<readonly [string, string, string]> = [
    ['post', '/sessions', 'agency.station.connect'],
    ['post', '/sessions/:id/available', 'agency.station.connect'],
    ['post', '/sessions/:id/station-token', 'agency.station.connect'],
    ['post', '/sessions/:id/break', 'agency.station.connect'],
    ['post', '/sessions/:id/break/cancel', 'agency.station.connect'],
    ['post', '/sessions/:id/force-available', 'agency.supervise'],
    ['post', '/attempts/:id/hangup', 'agency.attempts.handle'],
    ['post', '/attempts/:id/disposition', 'agency.attempts.dispose'],
    ['post', '/attempts/:id/notes', 'agency.attempts.dispose'],
    ['post', '/attempts/:id/dnc', 'agency.dnc.write'],
    // `/sessions/:id/leave` is last in EXPECTED_AGENT_ROUTES above but appears
    // here in file order — order does not matter to `it.each`, only membership.
    ['post', '/sessions/:id/leave', 'agency.station.connect'],
  ];

  it.each(EXPECTED)('%s %s requires %s', (verb, path, permission) => {
    // Matches the registration through to its `requirePermission(...)`, allowing
    // only whitespace and the generic between — so a guard moved out of the
    // route's own options, or replaced with a different permission, does not
    // match. Mirrors `proxy-agency-campaigns.routes.test.ts`'s pattern exactly.
    const pattern = new RegExp(
      `\\.${verb}(?:<[^>]*>)?\\(\\s*'${path.replace(/[/:.]/g, '\\$&')}'\\s*,\\s*\\{\\s*` +
        `preHandler: requirePermission\\('${permission.replace(/\./g, '\\.')}'\\)`,
    );

    expect(pattern.test(agentSource), `${verb.toUpperCase()} ${path} must be guarded by ${permission}`)
      .toBe(true);
  });

  it('knows about every route in the file, so a NEW unguarded one reds', () => {
    /**
     * The list above can only catch a guard removed from a route it names. A
     * route ADDED without a guard would pass every case and be invisible —
     * which is a real failure mode, not a hypothetical one. So count the
     * registrations and require the table to cover them all. This is the same
     * count `EXPECTED_AGENT_ROUTES` above pins from Fastify's router (11) —
     * asserted independently here, from source text, because that assertion
     * exists to catch a routing mismatch, not a missing guard.
     */
    const registrations =
      agentSource.match(/\b(?:app|sub)\.(?:get|post|patch|put|delete)(?:<[^>]*>)?\(/g) ?? [];

    expect(registrations).toHaveLength(EXPECTED.length);
  });
});
