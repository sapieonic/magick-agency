import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { readFileSync } from 'node:fs';
import type { MembershipRole } from '@magick-agency/contracts/rbac';
import { PERMISSION_MATRIX, hasPermission } from '@magick-agency/contracts/rbac';

/**
 * PER-AGENT performance (`proxy-agency-performance.routes.ts`): the agent's own
 * `/my-stats` + `/my-attempts`, and the supervisor's `/agents/:userId/*` twins.
 *
 * ── The two opposite failure modes this file exists to catch ────────────────
 * They pull in different directions and a single stubbed-open `requirePermission`
 * would hide both, so RBAC runs for real here and the cases are written per role:
 *
 *  - **A `my-*` route floored one notch too high 403s the only role it exists
 *    for.** `agent` is hierarchy level 5 — BELOW `viewer` — so it holds exactly
 *    the four `agency.*` permissions and nothing that predates the feature. The
 *    obvious-looking gate for a stats read is `proxy.contact_lists.read`, because
 *    that is what the neighbouring campaign stats route uses, and it floors at
 *    `viewer`. Choosing it reads as entirely reasonable in review and breaks the
 *    surface for every agent.
 *  - **A supervisory twin floored one notch too low turns the feature into peer
 *    surveillance.** `agency.supervise` is `account_admin`; at `agent` any agent
 *    could read a colleague's dispositions, talk time and success rate.
 *
 * ── And the one that is not about floors at all ─────────────────────────────
 * The `my-*` routes take their subject from `request.user.id` **server-side**. A
 * route that read a caller-supplied `agent_user_id` would pass every floor
 * assertion in this file and be a full read of any colleague's history, so the
 * subject is asserted on the OUTGOING the internal handler request rather than inferred from a
 * status code.
 */

/*
 *  - `callCore` is mocked as `mocks.proxyToCore`, with no API key to resolve; the logger mock is
 *    a partial `@magick-agency/observability`, repositories come from `@magick-agency/db`, and
 *    RBAC from `@magick-agency/contracts/rbac`;
 *  - there is no capability gate: the plugin-level hook cases assert the two hooks that exist
 *    (session, tenant context), and "a plugin hook's refusal stops every route" is expressed on
 *    `tenantContextMiddleware`;
 *  - platform API keys do not exist, so there are no key-caller cases;
 *  - the stats routes check `agency.campaigns.read`; `proxy.stats.read` /
 *    `proxy.analytics.read` do not exist in agency's matrix (asserted).
 */

const TENANT = '11111111-1111-4111-8111-111111111111';
const AGENT_USER = '22222222-2222-4222-8222-222222222222';
const OTHER_AGENT = '33333333-3333-4333-8333-333333333333';
const SUPERVISOR = '44444444-4444-4444-8444-444444444444';
const CAMPAIGN = '55555555-5555-4555-8555-555555555555';
const CONTACT = '66666666-6666-4666-8666-666666666666';

const mocks = vi.hoisted(() => ({
  proxyToCore: vi.fn(),
  findAnyByUserAndTenant: vi.fn(),
  /**
   * The ROSTER read's set-shaped membership lookup. Present here only so the
   * plugin-level hook cases below can drive `GET /agents/stats` without the
   * handler throwing on an unmocked repository method — the filter it feeds is
   * exercised in `proxy-agency-roster.routes.test.ts`.
   */
  findAnyByUsersAndTenant: vi.fn(),
  findDisplayNamesInTenant: vi.fn(),
  /**
   * What the PLUGIN-LEVEL `preHandler` hooks did, in order, on the last request.
   *
   * The doubles below push into this instead of being bare no-ops, which is the
   * whole mechanism for the `the plugin-level hooks actually run` block: a hook
   * that is never registered leaves no entry, and a stubbed-open double leaves the
   * same trace as a real one — so the assertion has to be on the double being
   * *invoked*, not on a status code.
   */
  hooksRan: [] as string[],
  /**
   * The plugin-level hook whose refusal the "refuses on every route"
   * case drives is `tenantContextMiddleware`; set to make the double answer 403.
   */
  refuseTenantContext: false,
}));

// The hop is `callCore` (`src/api/core-dispatch.ts`), mocked as `mocks.proxyToCore`; there is
// no key to resolve.
vi.mock('../../../src/api/core-dispatch.js', () => ({ callCore: mocks.proxyToCore }));
vi.mock('@magick-agency/observability', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@magick-agency/observability')>()),
  createChildLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
// The two plugin-level hooks are doubled rather than removed, and each records
// that it ran. Authentication and tenant resolution are the
// two things a unit test cannot exercise for real (they need Firebase and a
// database) and are also the two whose DELETION from
// the plugin would change nothing any other case in this file can see.
vi.mock('../../../src/auth/session.middleware.js', () => ({
  sessionMiddleware: async () => { mocks.hooksRan.push('session'); },
}));
vi.mock('../../../src/api/middleware/tenant-context.middleware.js', () => ({
  tenantContextMiddleware: async (
    _request: unknown,
    reply: { code: (n: number) => { send: (b: unknown) => unknown } },
  ) => {
    mocks.hooksRan.push('tenant-context');
    if (mocks.refuseTenantContext) {
      return reply.code(403).send({ error: 'Forbidden', message: 'You are not a member of this tenant' });
    }
    return undefined;
  },
}));
vi.mock('@magick-agency/db/repositories/membership.repository', () => ({
  membershipRepository: {
    findAnyByUserAndTenant: mocks.findAnyByUserAndTenant,
    findAnyByUsersAndTenant: mocks.findAnyByUsersAndTenant,
  },
}));
// The enrichment itself is NOT mocked — only the query under it — so the
// degrade-never-500 rule is exercised rather than assumed.
vi.mock('@magick-agency/db/repositories/user.repository', () => ({
  userRepository: { findDisplayNamesInTenant: mocks.findDisplayNamesInTenant },
}));

import { proxyAgencyPerformanceRoutes } from '../../../src/api/routes/proxy-agency-performance.routes.js';

const PREFIX = '/proxy/agency';

interface Caller {
  role?: MembershipRole;
  /**
   * `null` means **no `request.user` at all**, not `{ id: null }`.
   *
   * That distinction is the fixture's whole value here. `sessionMiddleware`
   * either attaches a loaded `UserRecord` or attaches nothing — it has no path
   * that produces a user object with a null id — so a fixture shaped that way
   * models a state the system cannot reach. It also silently defeats the
   * assertion it exists for: `resolveMyAgentId` returns `request.user?.id`, which
   * is `null` for `{ id: null }` and `undefined` for an absent user, and every
   * call site tests `if (userId === null)`. Against `{ id: null }` a
   * `resolveMyAgentId` with its second guard DELETED still returns null and every
   * route still refuses — so the guard could be removed with nothing failing.
   * Mutation testing found exactly that.
   */
  userId?: string | null;
}

async function buildApp(caller: Caller = { role: 'account_admin' }): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.addHook('onRequest', async (request) => {
    // Via `unknown`: `FastifyRequest` and `Record<string, unknown>` do not
    // sufficiently overlap for a direct assertion (TS2352 under `lint:test`).
    const r = request as unknown as Record<string, unknown>;
    r['tenantId'] = TENANT;
    r['accountId'] = 'account-1';
    // `null` ⇒ no user key whatsoever; see {@link Caller.userId}.
    if (caller.userId !== null) r['user'] = { id: caller.userId ?? SUPERVISOR };
    r['membership'] = { role: caller.role ?? 'account_admin' };
  });
  await app.register(proxyAgencyPerformanceRoutes, { prefix: PREFIX });
  await app.ready();
  return app;
}

/**
 * An occupancy block in the internal handler's shape: `shift_seconds` plus ALL SIX states.
 *
 * `zeroOccupancy()`/`foldOccupancy` in the internal handler's `agent-record.ts` always emit every
 * key — "a missing key is indistinguishable from zero to a consumer, and the
 * console renders all six states" — so a `{}` here is not a trimmed fixture, it is
 * a shape the internal handler cannot produce. A bucket carrying it would let a spread-based
 * enrichment that dropped or reshaped `occupancy` pass, since there would be
 * nothing inside it to lose.
 *
 * `shift_seconds` is every non-`offline` second, which is why it is not the sum of
 * `by_state`.
 */
function occupancy(overrides: Record<string, number> = {}) {
  const byState = {
    available: 9000, reserved: 300, on_call: 4300, wrapup: 610, break: 1800, offline: 12790,
    ...overrides,
  };
  return {
    shift_seconds: Object.entries(byState)
      .filter(([state]) => state !== 'offline')
      .reduce((total, [, seconds]) => total + seconds, 0),
    by_state: byState,
  };
}

/**
 * The internal handler's per-agent stats body, trimmed to the fields the assertions touch.
 *
 * `from`/`to` are full ISO instants because that is what the internal handler sends: the
 * repository builds them with `params.from.toISOString()`, and the contract types
 * them "the window as requested: `from` inclusive, `to` EXCLUSIVE, both ISO-8601
 * UTC". A bare `YYYY-MM-DD` here is a different type, and the public API layer forwards this
 * body unchanged — so a fixture in the wrong shape is a fixture that cannot catch a
 * reshaping of it.
 *
 * `bucket_start` IS a bare `YYYY-MM-DD`, and deliberately: the internal handler formats it in SQL
 * rather than serialising a `Date`, because node-pg parses a bare `timestamp` into
 * a LOCAL-time `Date` and would put the server's zone back on a value the query
 * went to some trouble to remove. The two fields differing is the internal handler's contract, not
 * an inconsistency in this fixture.
 */
function statsBody(agentUserId = AGENT_USER) {
  return {
    agent_user_id: agentUserId,
    bucket: 'day',
    from: '2026-08-01T00:00:00.000Z',
    to: '2026-08-23T00:00:00.000Z',
    totals: {
      attempts: 120,
      connected: 44,
      connect_rate_pct: 36.67,
      successes: 11,
      success_rate_pct: 25,
      talk_seconds: 4300,
      wrapup_seconds: 610,
      aht_seconds: 111.6,
      campaigns: 2,
      occupancy: occupancy(),
    },
    buckets: [{
      bucket_start: '2026-08-22',
      attempts: 20,
      connected: 8,
      successes: 2,
      talk_seconds: 700,
      wrapup_seconds: 90,
      occupancy: occupancy({ available: 2000, on_call: 700, wrapup: 90, break: 0, offline: 400 }),
    }],
    by_campaign: [{ campaign_id: CAMPAIGN, attempts: 60, connected: 22, successes: 6, talk_seconds: 2100, wrapup_seconds: 300 }],
  };
}

/**
 * The internal handler's attempt page for one agent.
 *
 * `state` is drawn from the internal handler's `ATTEMPT_STATES` — `queued | dialing | ringing |
 * answered | bridged | ended` — and nothing else. This fixture used to carry
 * `dispositioned` and `closed`, neither of which the internal handler can emit: they are lifecycle
 * words from the DISPOSITION vocabulary, and a fixture inventing them teaches the
 * next reader a state machine that does not exist. It also makes the file useless
 * as a reference for the `?state=` filter the public API layer forwards, where an invented value
 * is a 400 from the internal handler rather than a filter.
 */
function attemptsBody(agentUserId = AGENT_USER) {
  return {
    rows: [
      { id: 'a-1', agent_user_id: agentUserId, outcome: 'connected', state: 'ended' },
      { id: 'a-2', agent_user_id: agentUserId, outcome: 'no_answer', state: 'ended' },
    ],
    next_cursor: null,
    limit: 50,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Not a mock, so `clearAllMocks` does not reach it.
  mocks.hooksRan.length = 0;
  mocks.refuseTenantContext = false;
  mocks.proxyToCore.mockResolvedValue({ status: 200, body: statsBody() });
  mocks.findAnyByUserAndTenant.mockResolvedValue([{ id: 'm-1', role: 'agent', status: 'active' }]);
  mocks.findAnyByUsersAndTenant.mockResolvedValue([]);
  mocks.findDisplayNamesInTenant.mockResolvedValue(new Map([[AGENT_USER, 'Sam Okoro']]));
});

describe('the floors, pinned against PERMISSION_MATRIX', () => {
  /**
   * Asserted against the matrix as well as behaviourally below, because a
   * behavioural case alone would still pass if the floor moved to a DIFFERENT
   * permission that the same role happens to hold — which is exactly how a
   * supervisory route could quietly acquire an `agent`-floored gate.
   *
   * This block covers the `my-*` routes on BOTH agency plugins that serve this
   * prefix (this file's two, plus `/my-assignments`, `/my-assignment` and
   * `/my-campaigns` in `proxy-agency-staffing.routes.ts`), because they have to
   * agree: an agent whose console can list their campaigns and not read their own
   * numbers is a half-shipped surface, and the reverse is worse.
   */
  it('every my-* route floors at agency.station.connect, which is `agent`', () => {
    expect(PERMISSION_MATRIX['agency.station.connect']).toBe('agent');
    expect(hasPermission('agent', 'agency.station.connect')).toBe(true);
  });

  it('and NOT on any viewer-floored permission an agent cannot hold', () => {
    // `proxy.contact_lists.read` is the specific wrong choice: it is what the
    // campaign stats route next door uses, so it is the one a reviewer would
    // expect to see here.
    // Here that is `agency.campaigns.read` (same `viewer` floor). `proxy.stats.read` /
    // `proxy.analytics.read` have no agency twin: asserted ABSENT, so neither can be the
    // wrong choice.
    expect(PERMISSION_MATRIX['agency.campaigns.read']).toBe('viewer');
    expect(hasPermission('agent', 'agency.campaigns.read')).toBe(false);
    expect(PERMISSION_MATRIX).not.toHaveProperty('proxy.stats.read');
    expect(PERMISSION_MATRIX).not.toHaveProperty('proxy.analytics.read');
  });

  it('the supervisory twins floor at agency.supervise, which an agent cannot hold', () => {
    expect(PERMISSION_MATRIX['agency.supervise']).toBe('account_admin');
    expect(hasPermission('agent', 'agency.supervise')).toBe(false);
    expect(hasPermission('operator', 'agency.supervise')).toBe(false);
    expect(hasPermission('account_admin', 'agency.supervise')).toBe(true);
  });
});

describe('GET /my-stats and /my-attempts are reachable by a BARE agent', () => {
  for (const path of ['my-stats', 'my-attempts'] as const) {
    it(`${path}: 200 for an agent`, async () => {
      const app = await buildApp({ role: 'agent', userId: AGENT_USER });

      const res = await app.inject({ method: 'GET', url: `${PREFIX}/${path}` });

      expect(res.statusCode).toBe(200);
      await app.close();
    });

    it(`${path}: admits every role above agent too`, async () => {
      // Supervisors and admins inherit the four agent permissions on purpose —
      // covering a shift or demoing the console is desirable, not a leak.
      for (const role of ['viewer', 'operator', 'account_admin', 'tenant_owner'] as MembershipRole[]) {
        const app = await buildApp({ role, userId: SUPERVISOR });
        const res = await app.inject({ method: 'GET', url: `${PREFIX}/${path}` });
        expect(res.statusCode, `${role} must reach /${path}`).toBe(200);
        await app.close();
      }
    });

  }
});

describe('the my-* routes take the agent from the SESSION, never from the caller', () => {
  /**
   * The case that is not about floors. Every assertion here is on the OUTGOING
   * request, because a route that honoured a caller-supplied id would answer 200
   * with somebody else's numbers and no status code would say so.
   */
  const HOSTILE_QUERY = [
    `agent_user_id=${OTHER_AGENT}`,
    `user_id=${OTHER_AGENT}`,
    `agentUserId=${OTHER_AGENT}`,
  ].join('&');

  it('my-stats: the path segment is request.user.id', async () => {
    const app = await buildApp({ role: 'agent', userId: AGENT_USER });

    await app.inject({ method: 'GET', url: `${PREFIX}/my-stats?from=2026-08-01&to=2026-08-23` });

    expect(mocks.proxyToCore).toHaveBeenCalledWith(
      expect.objectContaining({ path: `/agency-agents/${AGENT_USER}/stats` }),
    );
    await app.close();
  });

  it('my-attempts: the path segment is request.user.id', async () => {
    const app = await buildApp({ role: 'agent', userId: AGENT_USER });

    await app.inject({ method: 'GET', url: `${PREFIX}/my-attempts?outcome=connected` });

    expect(mocks.proxyToCore).toHaveBeenCalledWith(
      expect.objectContaining({ path: `/agency-agents/${AGENT_USER}/attempts` }),
    );
    await app.close();
  });

  /**
   * The subject of a `my-*` route comes from the session and nothing a caller
   * sends may influence it. The internal handler already resolves it from the path — but a stray
   * `agent_user_id` in the QUERY is a param the internal handler could later give a meaning to, at
   * which point a filter nobody decided to expose would become reachable through
   * the public API layer.
   *
   * That used to be prevented by the whitelist dropping the key silently. It is
   * now prevented by refusing the request outright, which is the same protection
   * plus a signal: the internal handler is not called, and the caller is told which param was
   * rejected instead of receiving a 200 that looks like it was honoured.
   *
   * Note `agent_user_id` IS a legitimate filter on the campaign-scoped spine (a
   * supervisor filtering a campaign's attempts by agent). It is not legitimate
   * here, where the subject is the caller. The two routes therefore carry
   * different allowlists, and this asserts the difference.
   */
  it.each([
    ['my-stats', 'my-stats'],
    ['my-attempts', 'my-attempts'],
  ])('%s: refuses a caller-supplied agent id rather than dropping it', async (_n, route) => {
    const app = await buildApp({ role: 'agent', userId: AGENT_USER });

    const res = await app.inject({ method: 'GET', url: `${PREFIX}/${route}?${HOSTILE_QUERY}` });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'unknown_query_params' });
    // All three spellings named, so the refusal is actionable.
    expect(res.json().details.unknown).toEqual(
      expect.arrayContaining(['agentUserId', 'agent_user_id', 'user_id']),
    );
    // The important half: the internal handler never saw it.
    expect(mocks.proxyToCore).not.toHaveBeenCalled();
    await app.close();
  });

  it('refuses the hostile id even when mixed with legitimate filters', async () => {
    const app = await buildApp({ role: 'agent', userId: AGENT_USER });

    const res = await app.inject({
      method: 'GET',
      url: `${PREFIX}/my-attempts?${HOSTILE_QUERY}&outcome=connected&limit=25`,
    });

    expect(res.statusCode).toBe(400);
    expect(mocks.proxyToCore).not.toHaveBeenCalled();
    await app.close();
  });

  it('forwards the documented ATTEMPT filters — phone and contact_id included', async () => {
    /**
     * Asserted on the OUTGOING request rather than on a status code, because what
     * this pins is which filters actually reach the internal handler. A filter left off the
     * allowlist is now refused rather than dropped, so the old silent-200 failure
     * is gone — but a filter that is on the list and still fails to be forwarded
     * would be just as invisible, and that is what this catches.
     *
     * The internal handler applies both — `parseAgentAttemptFilters` delegates to the campaign
     * spine's `parseAttemptFilters`, and `listForAgent` puts `a.contact_id = …`
     * and `phoneCondition(…)` into the statement — and the public API layer's own campaign-spine
     * whitelist (`ATTEMPT_QUERY_PARAMS`) carries both. The
     * console sends `phone`.
     */
    const app = await buildApp({ role: 'agent', userId: AGENT_USER });

    await app.inject({
      method: 'GET',
      url: `${PREFIX}/my-attempts?outcome=connected&state=ended&disposition_code=sale`
        + `&campaign_id=${CAMPAIGN}&contact_id=${CONTACT}&phone=%2B919876543210`
        + '&from=2026-08-01&to=2026-08-23&cursor=abc&limit=25',
    });

    expect(mocks.proxyToCore.mock.calls[0]![0].query).toEqual({
      outcome: 'connected',
      state: 'ended',
      disposition_code: 'sale',
      campaign_id: CAMPAIGN,
      contact_id: CONTACT,
      phone: '+919876543210',
      from: '2026-08-01',
      to: '2026-08-23',
      cursor: 'abc',
      limit: '25',
    });
    await app.close();
  });

  it('forwards the documented stats filters and nothing else', async () => {
    const app = await buildApp({ role: 'agent', userId: AGENT_USER });

    await app.inject({
      method: 'GET',
      url: `${PREFIX}/my-stats?from=2026-08-01&to=2026-08-23&bucket=week`
        + `&campaign_id=${CAMPAIGN}`,
    });

    expect(mocks.proxyToCore.mock.calls[0]![0].query).toEqual({
      from: '2026-08-01',
      to: '2026-08-23',
      bucket: 'week',
      campaign_id: CAMPAIGN,
    });
    await app.close();
  });

  it('forwards the internal handler’s body and status unchanged — the public API layer reshapes no arithmetic', async () => {
    // The internal handler owns the rates, the AHT and the occupancy split. A second definition of
    // "connect rate" on this hop is a second definition that drifts from the one
    // the supervisor's dashboard shows.
    const app = await buildApp({ role: 'agent', userId: AGENT_USER });

    const res = await app.inject({ method: 'GET', url: `${PREFIX}/my-stats` });

    expect(res.json()).toEqual(statsBody());
    await app.close();
  });

  it('does not spend a name lookup on the caller’s own surface', async () => {
    // They know their own name; a DB read per poll buys nothing.
    const app = await buildApp({ role: 'agent', userId: AGENT_USER });

    await app.inject({ method: 'GET', url: `${PREFIX}/my-attempts` });

    expect(mocks.findDisplayNamesInTenant).not.toHaveBeenCalled();
    await app.close();
  });

  it('forwards an internal handler error untouched rather than masking it here', async () => {
    mocks.proxyToCore.mockResolvedValue({ status: 503, body: { error: 'Service Unavailable' } });
    const app = await buildApp({ role: 'agent', userId: AGENT_USER });

    const res = await app.inject({ method: 'GET', url: `${PREFIX}/my-stats` });

    expect(res.statusCode).toBe(503);
    await app.close();
  });
});

describe('the supervisory twins', () => {
  const TWINS = [
    { path: `agents/${AGENT_USER}/stats`, corePath: `/agency-agents/${AGENT_USER}/stats` },
    { path: `agents/${AGENT_USER}/attempts`, corePath: `/agency-agents/${AGENT_USER}/attempts` },
  ] as const;

  for (const twin of TWINS) {
    it(`${twin.path}: refuses agent, viewer and operator`, async () => {
      for (const role of ['agent', 'viewer', 'operator'] as MembershipRole[]) {
        const app = await buildApp({ role });
        const res = await app.inject({ method: 'GET', url: `${PREFIX}/${twin.path}` });
        expect(res.statusCode, `${role} must not read another agent`).toBe(403);
        // Not merely refused — nothing was read on the way to the refusal.
        expect(mocks.proxyToCore).not.toHaveBeenCalled();
        await app.close();
      }
    });

    it(`${twin.path}: admits account_admin and above`, async () => {
      for (const role of ['account_admin', 'tenant_admin', 'tenant_owner'] as MembershipRole[]) {
        const app = await buildApp({ role });
        const res = await app.inject({ method: 'GET', url: `${PREFIX}/${twin.path}` });
        expect(res.statusCode, `${role} must reach ${twin.path}`).toBe(200);
        await app.close();
      }
    });

    it(`${twin.path}: answers 404 — not 403 — for an agent outside this tenant`, async () => {
      /**
       * The internal handler treats `agent_user_id` as an opaque string (no user table,
       * no FK on that column), so it cannot refuse a foreign id on the public API layer's behalf.
       * `memberships` is the public API layer's, so this boundary exists only here.
       *
       * 404 rather than 403 because a cross-tenant id and a nonexistent one must be
       * indistinguishable. A 403 would confirm
       * the user id exists somewhere.
       */
      mocks.findAnyByUserAndTenant.mockResolvedValue([]);
      const app = await buildApp({ role: 'account_admin' });

      const res = await app.inject({ method: 'GET', url: `${PREFIX}/${twin.path}` });

      expect(res.statusCode).toBe(404);
      // Nothing was asked of the internal handler about a user this tenant does not employ.
      expect(mocks.proxyToCore).not.toHaveBeenCalled();
      await app.close();
    });

    it(`${twin.path}: proves the agent against THIS tenant`, async () => {
      const app = await buildApp({ role: 'account_admin' });

      await app.inject({ method: 'GET', url: `${PREFIX}/${twin.path}` });

      expect(mocks.findAnyByUserAndTenant).toHaveBeenCalledWith(AGENT_USER, TENANT);
      expect(mocks.proxyToCore).toHaveBeenCalledWith(
        expect.objectContaining({ path: twin.corePath, tenantId: TENANT }),
      );
      await app.close();
    });

    it(`${twin.path}: reads a DEPARTED agent — a revoked membership is still a member`, async () => {
      /**
       * The case the surface is justified by. Offboarding sets
       * `memberships.status = 'revoked'`, and the supervisory read is made AFTER
       * somebody leaves rather than while they are on the roster — a pay dispute, a
       * quality complaint, a handover. Asked through the active-only
       * `findByUserAndTenant` this answered *"That user is not a member of this
       * workspace"*, so the one question the route exists for was the one it could
       * not answer.
       *
       * The lookup is asserted BY NAME as well as behaviourally: swapping it back
       * to the active-only sibling would still pass a status-code assertion for as
       * long as the mock returned a row, so the name is what pins which question is
       * being asked.
       */
      mocks.findAnyByUserAndTenant.mockResolvedValue([
        { id: 'm-1', role: 'agent', status: 'revoked' },
      ]);
      const app = await buildApp({ role: 'account_admin' });

      const res = await app.inject({ method: 'GET', url: `${PREFIX}/${twin.path}` });

      expect(res.statusCode).toBe(200);
      expect(mocks.findAnyByUserAndTenant).toHaveBeenCalledWith(AGENT_USER, TENANT);
      expect(mocks.proxyToCore).toHaveBeenCalledWith(
        expect.objectContaining({ path: twin.corePath }),
      );
      await app.close();
    });

    it(`${twin.path}: still 404s a user who was NEVER in this tenant`, async () => {
      /**
       * The other half of the same change, and the reason it is a separate lookup
       * rather than a dropped predicate: including revoked rows widens WHO can be
       * read, never WHICH TENANT. No membership row of any status means no read —
       * and 404, not 403, so a foreign id and a nonexistent one stay
       * indistinguishable.
       */
      mocks.findAnyByUserAndTenant.mockResolvedValue([]);
      const app = await buildApp({ role: 'account_admin' });

      const res = await app.inject({ method: 'GET', url: `${PREFIX}/${twin.path}` });

      expect(res.statusCode).toBe(404);
      expect(mocks.proxyToCore).not.toHaveBeenCalled();
      await app.close();
    });

    it(`${twin.path}: rejects a non-uuid userId with 400, not a masked 500`, async () => {
      // A raw `:userId` reaches a UUID column and raises `22P02` from inside the
      // query, which propagates as a 500 and comes back as "contact support".
      const suffix = twin.path.endsWith('stats') ? 'stats' : 'attempts';
      const app = await buildApp({ role: 'account_admin' });

      const res = await app.inject({ method: 'GET', url: `${PREFIX}/agents/not-a-uuid/${suffix}` });

      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: 'Validation Error' });
      expect(mocks.findAnyByUserAndTenant).not.toHaveBeenCalled();
      expect(mocks.proxyToCore).not.toHaveBeenCalled();
      await app.close();
    });
  }

  it('stats: adds agent_name beside the id, and changes nothing else', async () => {
    // The internal handler has no user table, so a supervisor comparing two agents would otherwise
    // be comparing two UUIDs. A SPREAD, not a reconstruction: everything the internal handler sent
    // has to survive, including fields it adds after this was written.
    const app = await buildApp({ role: 'account_admin' });

    const res = await app.inject({ method: 'GET', url: `${PREFIX}/agents/${AGENT_USER}/stats` });

    expect(res.json()).toEqual({ ...statsBody(), agent_name: 'Sam Okoro' });
    await app.close();
  });

  it('stats: degrades to agent_name: null rather than 500ing', async () => {
    mocks.findDisplayNamesInTenant.mockRejectedValue(new Error('db down'));
    const app = await buildApp({ role: 'account_admin' });

    const res = await app.inject({ method: 'GET', url: `${PREFIX}/agents/${AGENT_USER}/stats` });

    expect(res.statusCode).toBe(200);
    // The KEY is still produced: an absent key is indistinguishable from one a
    // client forgot to read, while a null is an answer.
    expect(res.json().agent_name).toBeNull();
    expect(res.json().totals).toEqual(statsBody().totals);
    await app.close();
  });

  it('stats: leaves a non-2xx body exactly as the internal handler wrote it', async () => {
    mocks.proxyToCore.mockResolvedValue({ status: 404, body: { error: 'Not Found', code: 'agent_not_found' } });
    const app = await buildApp({ role: 'account_admin' });

    const res = await app.inject({ method: 'GET', url: `${PREFIX}/agents/${AGENT_USER}/stats` });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'Not Found', code: 'agent_not_found' });
    // No name was invented onto an error body on its way to the error mask.
    expect(res.json().agent_name).toBeUndefined();
    await app.close();
  });

  it('attempts: names the agent on every row, through the SHARED spine helper', async () => {
    mocks.proxyToCore.mockResolvedValue({ status: 200, body: attemptsBody() });
    const app = await buildApp({ role: 'account_admin' });

    const res = await app.inject({ method: 'GET', url: `${PREFIX}/agents/${AGENT_USER}/attempts` });

    expect(res.json().rows.map((r: { agent_name: string }) => r.agent_name))
      .toEqual(['Sam Okoro', 'Sam Okoro']);
    // ONE query for the whole page, never one per row.
    expect(mocks.findDisplayNamesInTenant).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it('attempts: degrades to nulls on every row rather than 500ing', async () => {
    mocks.proxyToCore.mockResolvedValue({ status: 200, body: attemptsBody() });
    mocks.findDisplayNamesInTenant.mockRejectedValue(new Error('db down'));
    const app = await buildApp({ role: 'account_admin' });

    const res = await app.inject({ method: 'GET', url: `${PREFIX}/agents/${AGENT_USER}/attempts` });

    expect(res.statusCode).toBe(200);
    expect(res.json().rows.map((r: { agent_name: string | null }) => r.agent_name))
      .toEqual([null, null]);
    await app.close();
  });

  it('attempts: leaves a non-2xx body exactly as the internal handler wrote it', async () => {
    /**
     * The stats twin has had this case since the surface shipped; the ATTEMPTS
     * twin did not, and the two guards are separate `result.status >= 200 &&
     * result.status < 300` expressions rather than one shared helper. So the
     * assertion had to be written twice or it protected one route — which is what
     * coverage showed: the enrichment branch on this handler was the only
     * unreached one in the file.
     *
     * It matters more here than on stats, because the failure is not merely a
     * stray key. `enrichAttemptAgentNames` reads `body.rows` and maps over it; an
     * error body has no `rows`, so running it over one either throws (a masked 500
     * where the internal handler sent a diagnosable 404) or quietly rewrites the body into
     * something with a `rows` key — and `errorMaskHook` decides whether to forward
     * or mask the internal handler's 4xx by inspecting exactly that body. A structured refusal
     * with `details` that arrived reshaped would be masked into "contact support",
     * which is the whole class of defect the mask's allow-list exists to prevent.
     */
    mocks.proxyToCore.mockResolvedValue({
      status: 400,
      body: { error: 'Validation failed', code: 'invalid_agent_user_id', details: { agentUserId: ['too long'] } },
    });
    const app = await buildApp({ role: 'account_admin' });

    const res = await app.inject({ method: 'GET', url: `${PREFIX}/agents/${AGENT_USER}/attempts` });

    expect(res.statusCode).toBe(400);
    // Byte-identical, `details` included — that is what keeps it forwardable.
    expect(res.json()).toEqual({
      error: 'Validation failed',
      code: 'invalid_agent_user_id',
      details: { agentUserId: ['too long'] },
    });
    // And no name lookup was spent on a body that has no rows to name.
    expect(mocks.findDisplayNamesInTenant).not.toHaveBeenCalled();
    await app.close();
  });

  it('attempts: does not enrich a non-2xx body even when it DOES carry rows', async () => {
    /**
     * ── Why the case above is not enough, found by mutating ────────────────
     * Deleting the `result.status >= 200 && result.status < 300` guard from this
     * handler leaves the case above green, and for a reason worth recording:
     * `enrichAttemptAgentNames` calls `asSpinePage(body)`, which returns null for
     * any body without a `rows` array, and the helper then returns the body
     * untouched. So an ordinary `{ error, code, details }` refusal is protected by
     * a SECOND, independent mechanism and the guard is invisible against it.
     *
     * Two mechanisms guarding one property is not a reason to test neither. The
     * guard is the one that holds when the body is not error-shaped, and this is
     * the case that distinguishes them: a non-2xx that carries `rows`.
     *
     * That shape is not invented for the mutation's benefit. The internal handler's attempt reads
     * are paginated and partial-tolerant, and the neighbouring campaign-activity
     * surface already answers `{ rows, partial, partial_reason }` — a degraded read
     * that reported a non-2xx while still handing back the rows it managed to
     * fetch would land here exactly. So would a 429 pacing signal that echoed the
     * page, which `errorMaskHook` passes through untouched by policy.
     *
     * The harm if it were enriched is not the extra key. `errorMaskHook` decides
     * whether to FORWARD or MASK the internal handler's 4xx by inspecting the body it is handed —
     * a forwarded refusal needs its `details`, and a body this route rewrote is a
     * body the mask judges differently. Plus a database round trip is spent
     * naming rows on a request that failed.
     */
    mocks.proxyToCore.mockResolvedValue({
      status: 424,
      body: { ...attemptsBody(), partial: true, partial_reason: 'core_unavailable' },
    });
    const app = await buildApp({ role: 'account_admin' });

    const res = await app.inject({ method: 'GET', url: `${PREFIX}/agents/${AGENT_USER}/attempts` });

    expect(res.statusCode).toBe(424);
    // Unchanged: no `agent_name` grafted onto any row, and `partial` intact.
    expect(res.json()).toEqual({ ...attemptsBody(), partial: true, partial_reason: 'core_unavailable' });
    expect(mocks.findDisplayNamesInTenant).not.toHaveBeenCalled();
    await app.close();
  });

  it('stats: does not enrich a non-2xx body that happens to be stats-shaped', async () => {
    /**
     * The stats twin's own version of the case above, and it needs one for the
     * same reason: `enrichAgentStatsIdentity` narrows before it acts, so a bare
     * `{ error }` body is protected whether or not the status guard exists. A
     * non-2xx carrying a stats-shaped body is what the guard itself protects.
     */
    mocks.proxyToCore.mockResolvedValue({ status: 424, body: { ...statsBody(), partial: true } });
    const app = await buildApp({ role: 'account_admin' });

    const res = await app.inject({ method: 'GET', url: `${PREFIX}/agents/${AGENT_USER}/stats` });

    expect(res.statusCode).toBe(424);
    expect(res.json()).toEqual({ ...statsBody(), partial: true });
    expect(res.json().agent_name).toBeUndefined();
    expect(mocks.findDisplayNamesInTenant).not.toHaveBeenCalled();
    await app.close();
  });

  it.each([
    { path: `agents/${AGENT_USER}/stats`, read: (b: { agent_name?: unknown }) => b.agent_name },
    {
      path: `agents/${AGENT_USER}/attempts`,
      read: (b: { rows?: Array<{ agent_name?: unknown }> }) => b.rows?.[0]?.agent_name,
    },
  ])('$path: degrades even when the lookup rejects with a NON-Error', async ({ path, read }) => {
    /**
     * `warnNameLookup` narrows with `err instanceof Error ? err.message :
     * String(err)`, and only the `Error` arm was ever exercised. The other arm is
     * not hypothetical: `pg` and `ioredis` both reject with plain objects on some
     * paths, an aborted `AbortSignal.timeout` rejects with a `DOMException` (which
     * IS an Error, but the point is that callers do not control the shape), and any
     * `Promise.reject('...')` anywhere under the lookup lands here.
     *
     * The failure mode if that narrowing were dropped is worse than an ugly log:
     * `err.message` on a string is `undefined`, which pino serialises fine — but a
     * throw *inside the catch handler* escapes the degrade path entirely and turns
     * this route's documented "answer with null" into a masked 500. Which is
     * exactly the outcome the degrade rule exists to prevent, arrived at through
     * the code that implements it.
     */
    mocks.proxyToCore.mockResolvedValue({
      status: 200,
      body: path.endsWith('stats') ? statsBody() : attemptsBody(),
    });
    mocks.findDisplayNamesInTenant.mockRejectedValue('connection terminated unexpectedly');
    const app = await buildApp({ role: 'account_admin' });

    const res = await app.inject({ method: 'GET', url: `${PREFIX}/${path}` });

    expect(res.statusCode).toBe(200);
    expect(read(res.json())).toBeNull();
    await app.close();
  });
});

describe('M10: the cohort band is SUPERVISOR-ONLY, and today it holds for free', () => {
  /**
   * ── Why a property nothing implements gets a test ──────────────────────────
   * An agent may see every number about
   * THEMSELVES and no number about the cohort. It holds right now by
   * construction rather than by code: the internal handler's `AgencyAgentStats`
   * (`src/agency/contracts.ts`) has no `benchmark` field — the
   * cohort band is `AgencyRosterPage.benchmark`, served only by the ROSTER read
   * `GET /agents/stats`, floored at `agency.supervise` — the public API layer forwards this
   * body unchanged, and `compare_to` appears nowhere in `src/`. There is
   * nothing to delete in order to break it.
   *
   * Which is exactly why it needs pinning. A property that holds for free is the
   * one that stops holding silently, because the edit that ends it does not look
   * like it touches this route at all.
   *
   * ── The one-line edit this block exists to make RED ────────────────────────
   * `src/api/routes/proxy-agency-performance.routes.ts:122`:
   *
   *     const AGENT_STATS_QUERY_PARAMS = ['from', 'to', 'bucket', 'campaign_id'] as const;
   *
   * ONE constant, read by TWO handlers — `/my-stats` (~:472) and its supervisory
   * twin `/agents/:userId/stats` (~:1089). So a "vs team" line on the
   * SUPERVISORY route is bought by appending one word to that array, and the same
   * word is thereby accepted on the agent's own scorecard, in a diff whose every
   * line reads as supervisory. Nobody reviewing "add compare_to for the compare
   * tray" would see an agent acquiring a view of their cohort. The shared
   * constant is the entire mechanism by which this rule dies quietly, and the file's
   * whole design — the two halves of one question side by side so a change cannot
   * land on one and miss the other — is what makes the shortcut so easy to take.
   *
   * The right answer is that the tray needs no param at all: it is built from the
   * roster read the supervisor already holds, and issues ZERO requests. So
   * `compare_to` is refused on BOTH halves below and not only the agent's. That
   * is deliberate over-pinning: a param accepted on the supervisory route is one
   * line from the shared list, and there is no supervisory need for it the roster
   * does not already answer. A future phase that genuinely wants one has to come
   * here and argue the case first — which is the point.
   *
   * ── What these tests do NOT guard, stated so nobody assumes they do ────────
   * The public API layer forwards this body unchanged (pinned above: "forwards the internal handler's body and
   * status unchanged"), so if the internal handler ever grew a `benchmark` on its per-agent
   * endpoint, the public API layer would serve it and no assertion here would notice. That
   * direction is the internal handler's to keep, deliberately: a public API layer that stripped keys out of
   * the internal handler's payload would be a second opinion about the contract, which is the
   * thing this hop exists not to be. What is guarded below is the public API layer never
   * INVENTING a cohort number, and never accepting the param that would ask for
   * one.
   */

  it('my-stats carries no benchmark, and spends no second read that could build one', async () => {
    /**
     * Two halves, and the second is the one that can actually fail.
     *
     * The absent key alone is a weak assertion — the internal handler's fixture has no
     * `benchmark`, so it passes against any route that does not add one. The way
     * a route WOULD add one is the interesting half: a second the internal handler call to
     * `/agency-agents/stats`, lifting that page's cohort band and grafting it
     * beside the agent's own totals. That is a plausible feature request, it
     * needs no new param at all, and it violates the rule in full. So the internal handler
     * calls are asserted — exactly one, and to the agent's own record — which is
     * evidence a missing key and a 200 cannot give.
     */
    const app = await buildApp({ role: 'agent', userId: AGENT_USER });

    const res = await app.inject({ method: 'GET', url: `${PREFIX}/my-stats` });

    expect(res.statusCode).toBe(200);
    expect(res.json()).not.toHaveProperty('benchmark');
    // Nor one level down, beside the totals an agent may legitimately read. A
    // band smuggled into `totals` is the same disclosure in a less obvious place.
    expect(res.json().totals).not.toHaveProperty('benchmark');
    // ONE the internal handler call, and it is the per-agent record — never the roster, which is
    // where `benchmark` legitimately lives and what a cohort line would need.
    expect(mocks.proxyToCore).toHaveBeenCalledTimes(1);
    expect(mocks.proxyToCore.mock.calls[0]![0].path).toBe(`/agency-agents/${AGENT_USER}/stats`);
    for (const call of mocks.proxyToCore.mock.calls) {
      expect(call[0].path).not.toBe('/agency-agents/stats');
    }
    await app.close();
  });

  it.each([
    ['my-stats', 'my-stats'],
    ['agents/:userId/stats', `agents/${AGENT_USER}/stats`],
  ])('%s: refuses ?compare_to with a 400 rather than forwarding it', async (_name, route) => {
    /**
     * Verified rather than assumed: `compare_to` is not in
     * `AGENT_STATS_QUERY_PARAMS`, so `forwardAllowedQuery` should refuse the
     * request outright — a 400 naming the param, with no the internal handler call — rather than
     * dropping the key and answering 200 as though a cohort comparison had been
     * honoured. Both halves matter here: a DROPPED `compare_to` is a client that
     * believes it is reading a band and is in fact reading a bare scorecard, and
     * the console would then render a comparison against whatever it had.
     */
    const app = await buildApp({ role: 'account_admin', userId: SUPERVISOR });

    const res = await app.inject({ method: 'GET', url: `${PREFIX}/${route}?compare_to=team` });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'unknown_query_params' });
    expect(res.json().details.unknown).toEqual(['compare_to']);
    // The important half: the internal handler never saw it, so no cohort read was even attempted.
    expect(mocks.proxyToCore).not.toHaveBeenCalled();
    await app.close();
  });

  it('my-stats: refuses compare_to even mixed with the four legitimate params', async () => {
    // The realistic shape of the request, since a console adding a comparison
    // adds it to the window and campaign filters it already sends. A whitelist
    // that only refused a lone param would let this straight through.
    const app = await buildApp({ role: 'agent', userId: AGENT_USER });

    const res = await app.inject({
      method: 'GET',
      url: `${PREFIX}/my-stats?from=2026-08-01&to=2026-08-23&bucket=day`
        + `&campaign_id=${CAMPAIGN}&compare_to=team`,
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().details.unknown).toEqual(['compare_to']);
    expect(mocks.proxyToCore).not.toHaveBeenCalled();
    await app.close();
  });

  it.each(['team', 'cohort', 'benchmark', 'account', 'true'])(
    'my-stats: refuses compare_to=%s — the VALUE is not what makes it refusable',
    async (value) => {
      // The param is unknown whatever it says, so no spelling of the cohort is a
      // way in. Written as a loop because "we only guarded `team`" is a real
      // failure mode of an allowlist keyed on values instead of names.
      const app = await buildApp({ role: 'agent', userId: AGENT_USER });

      const res = await app.inject({
        method: 'GET',
        url: `${PREFIX}/my-stats?compare_to=${value}`,
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().details.unknown).toEqual(['compare_to']);
      await app.close();
    },
  );

  it('the shared whitelist is those four params, and is read by exactly two handlers', () => {
    /**
     * The source-text counterpart, and it catches the generic form of the hazard
     * that the behavioural cases above catch only one instance of. They refuse
     * `compare_to` by name; this refuses ANY fifth param appearing on the shared
     * list — `cohort`, `vs`, `tz`, whichever spelling the next phase reaches for
     * — which is the actual failure class, since `compare_to` is merely today's.
     *
     * The usage count is pinned for the reason the hazard exists: the constant
     * being SHARED is what makes a supervisory-looking edit an agent-facing one.
     * If a future phase splits it in two so the supervisory route can take a
     * param the agent's cannot, this test reds — and that is intended, not
     * collateral. The param is ruled out on both routes, so a split is a contract
     * change and has to be argued here rather than landed as a refactor.
     */
    const source = readFileSync(
      new URL('../../../src/api/routes/proxy-agency-performance.routes.ts', import.meta.url),
      'utf8',
    );

    const declaration = source.match(/const AGENT_STATS_QUERY_PARAMS = \[([^\]]*)\] as const;/);
    expect(declaration, 'AGENT_STATS_QUERY_PARAMS must still be a literal array').not.toBeNull();
    const params = declaration![1]!
      .split(',')
      .map((part) => part.trim().replace(/^'|'$/g, ''))
      .filter((part) => part.length > 0);
    expect(params).toEqual(['from', 'to', 'bucket', 'campaign_id']);

    const uses = source.match(/forwardAllowedQuery\(request\.query, AGENT_STATS_QUERY_PARAMS\)/g);
    expect(uses, 'the my-* route and its supervisory twin, and nothing else').toHaveLength(2);
  });
});

describe('a request carrying NEITHER a key nor a user is refused, not answered', () => {
  /**
   * ── The guard in `resolveMyAgentId` ────────────────────────────────────────
   * The guard `if (!userId)` (the `replyMissingActor` and `return null` inside it
   * in `proxy-agency-staffing.routes.ts`) answers a request with no user.
   *
   * ── Why it must not be deleted as unreachable ─────────────────────────────
   * It is tempting to read it as unreachable once a session exists. The code says
   * otherwise in as many words: *"a request with neither is still unattributable
   * and must not interpolate `undefined` into the internal handler's path."*
   *
   * That is a concrete consequence, not a stylistic one. Without this guard the
   * handler builds `/agency-agents/undefined/stats` and asks the internal handler for it with the
   * tenant's real API key. The internal handler treats `agent_user_id` as an OPAQUE STRING with no
   * user table behind it — so it cannot refuse the literal
   * `"undefined"`; it answers 200 with a zero-filled scorecard, or, worse, with
   * whatever any row bearing that string happens to hold. A 200 of confident
   * nonsense is the failure this refuses, and it is unfalsifiable from the client
   * side because it looks exactly like a quiet agent's real numbers.
   *
   * How the state arises at all: `sessionMiddleware`'s Firebase branch attaches
   * `request.user` only after `verifyIdToken` AND a successful DB load, and a
   * future auth mode (an S2S caller, a signed internal hop, a middleware that
   * short-circuits on a cache miss) sets neither field. It is defence in depth
   * against a chain that changes, which is the reason to pin it rather than the
   * reason to remove it.
   */
  const MY_ROUTES = ['my-stats', 'my-attempts'] as const;

  it.each(MY_ROUTES)('%s: answers 400 missing_actor', async (path) => {
    const app = await buildApp({ role: 'agent', userId: null });

    const res = await app.inject({ method: 'GET', url: `${PREFIX}/${path}` });

    expect(res.statusCode).toBe(400);
    // The internal handler's own code, so the console keys off one string whichever service refused.
    expect(res.json()).toMatchObject({ code: 'missing_actor' });
    await app.close();
  });

  it.each(MY_ROUTES)('%s: spends no the internal handler round trip, and never builds a path', async (path) => {
    // The stronger half: refusing here rather than at the internal handler is what stops
    // `/agency-agents/undefined/...` from ever being asked for.
    const app = await buildApp({ role: 'agent', userId: null });

    await app.inject({ method: 'GET', url: `${PREFIX}/${path}` });

    expect(mocks.proxyToCore).not.toHaveBeenCalled();
    await app.close();
  });

  it('answers the SAME shape a platform key gets, since both are unattributable', async () => {
    /**
     * One condition, one answer — the reason `replyMissingActor` is a shared
     * exported function rather than five copies of a literal. A console that
     * branches on the message would break the moment two handlers drifted.
     *
     * The comparison is with `replyMissingActor` itself — the staffing plugin's shared
     * answer — answered by a bare route. This route answers an unattributable caller with exactly
     * that function's body, not a copy of it.
     */
    const { replyMissingActor } = await import(
      '../../../src/api/routes/proxy-agency-staffing.routes.js'
    );
    const noUser = await buildApp({ role: 'agent', userId: null });
    const shared = Fastify({ logger: false });
    shared.get('/probe', async (_request, reply) => replyMissingActor(reply));
    await shared.ready();

    const a = await noUser.inject({ method: 'GET', url: `${PREFIX}/my-stats` });
    const b = await shared.inject({ method: 'GET', url: '/probe' });

    expect(a.statusCode).toBe(b.statusCode);
    expect(a.json()).toEqual(b.json());
    await noUser.close();
    await shared.close();
  });
});

describe('the fixtures above are the internal handler’s shape, not an invented one', () => {
  /**
   * ── Why a fixture's realism is worth asserting ────────────────────────────
   * These four routes forward the internal handler's body unchanged, so every behavioural case in
   * this file is only as good as the body it is handed. Three of the fixtures were
   * not shapes the internal handler can produce: `state: 'dispositioned'` and `state: 'closed'`
   * (words from the disposition vocabulary, not the attempt state machine),
   * `occupancy: {}` on a bucket (the internal handler always emits `shift_seconds` plus all six
   * states), and `from: '2026-08-01'` (the internal handler sends a full ISO instant). Each one
   * quietly taught the next reader a contract that does not exist, and the empty
   * occupancy had teeth: an enrichment that dropped or flattened it would have
   * passed, because there was nothing inside to lose.
   *
   * The public API layer holds no copy of the internal handler's vocabularies and cannot import them, so these
   * are TRANSCRIPTIONS naming the file they mirror, and the same approach
   * `error-mask.agency-contract.test.ts` takes for the internal handler's error codes.
   */
  /** `ATTEMPT_STATES`, `src/agency/spine-filters.ts`. */
  const CORE_ATTEMPT_STATES = ['queued', 'dialing', 'ringing', 'answered', 'bridged', 'ended'];
  /** `zeroOccupancy()`, `src/agency/agent-record.ts`. */
  const CORE_OCCUPANCY_STATES = ['available', 'reserved', 'on_call', 'wrapup', 'break', 'offline'];

  it('every attempt row carries a state the internal handler can actually emit', () => {
    for (const row of attemptsBody().rows) {
      expect(CORE_ATTEMPT_STATES, `'${row.state}' is not an attempt state`).toContain(row.state);
    }
  });

  it('every occupancy block carries shift_seconds and all six states', () => {
    // Totals AND buckets. The bucket was the one that was empty, and a bucket's
    // occupancy is the same type as the totals' — the internal handler has one folder for both.
    const blocks = [statsBody().totals.occupancy, ...statsBody().buckets.map((b) => b.occupancy)];

    for (const block of blocks) {
      expect(typeof block.shift_seconds).toBe('number');
      expect(Object.keys(block.by_state).sort()).toEqual([...CORE_OCCUPANCY_STATES].sort());
    }
  });

  it('the stats window is an ISO instant, which is what the internal handler sends', () => {
    // `params.from.toISOString()` in the internal handler's repository; the contract types both as
    // "ISO-8601 UTC", `from` inclusive and `to` EXCLUSIVE.
    for (const value of [statsBody().from, statsBody().to]) {
      expect(value).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    }
  });

  it('but bucket_start is a bare date, because the internal handler formats it in SQL', () => {
    // Not an inconsistency: node-pg parses a bare `timestamp` into a LOCAL-time
    // `Date`, which would put the server's zone back on a value the query went to
    // some trouble to remove. The two fields differ in the internal handler's contract.
    expect(statsBody().buckets[0]!.bucket_start).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('the plugin-level preHandler hooks actually run', () => {
  /**
   * ── The gap this closes ───────────────────────────────────────────────────
   * Every route in `ROUTES` below is individually guarded by `requirePermission`,
   * and that is asserted twice over (behaviourally per role, and against the
   * source). The two hooks registered on the PLUGIN would otherwise be asserted
   * nowhere: replacing `sessionMiddleware` with a no-op (nothing authenticates the
   * caller) or `tenantContextMiddleware` (nothing resolves or validates the tenant,
   * and `request.tenantId!` would be whatever the harness put there) would leave
   * every case in this file green, because a hook that never ran is
   * indistinguishable from one that ran and allowed.
   *
   * They cannot be exercised for real in a unit test — Firebase and a database
   * respectively — so the doubles record instead, and these cases assert the
   * RECORD. A deletion leaves no entry and reds.
   *
   * ── Order is asserted, not just membership ────────────────────────────────
   * `tenantContextMiddleware` reads `request.user`, so the chain only works in
   * one order. Registration order is what fixes it, and it is exactly what a
   * re-ordering edit would change while leaving both present.
   */
  /**
   * **No count in prose.** A list that says "the five routes below" while
   * holding six is drift. A number written next to a list is a
   * second source of truth for the list's length, and it is the copy that is
   * never updated. The case below derives the count from the file instead.
   */
  const ROUTES = [
    'my-stats',
    'my-attempts',
    `agents/${AGENT_USER}/stats`,
    `agents/${AGENT_USER}/attempts`,
    // The two whole-floor reads. Their own files cover their gates, their filters
    // and their payloads; they are in THIS list because these two cases are the
    // only ones that assert the plugin-level hooks, and "a route added tomorrow
    // inherits this or nothing" is a claim that has to be re-made for every route
    // added — which is the whole reason the list is enumerated rather than
    // derived.
    'agents/stats',
    'agents/grouped-stats',
  ] as const;

  it.each(ROUTES)('%s runs session → tenant-context', async (path) => {
    const app = await buildApp({ role: 'account_admin' });

    await app.inject({ method: 'GET', url: `${PREFIX}/${path}` });

    expect(mocks.hooksRan).toEqual(['session', 'tenant-context']);
    await app.close();
  });

  it('covers every route the plugin registers, so a NEW one is not silently exempt', () => {
    /**
     * The list is enumerated rather than derived — that is deliberate, because
     * "a route added tomorrow inherits the plugin hooks or nothing" is a claim
     * that has to be re-made per route. What must NOT be hand-maintained is the
     * COUNT: this asserts the list is as long as the file's registrations, so
     * adding a seventh route without adding it here reds, and no comment has to
     * say a number.
     */
    const source = readFileSync(
      new URL('../../../src/api/routes/proxy-agency-performance.routes.ts', import.meta.url),
      'utf8',
    );
    const registrations =
      source.match(/\b(?:app|sub)\.(?:get|post|patch|put|delete)(?:<[^>]*>)?\(/g) ?? [];

    expect(ROUTES).toHaveLength(registrations.length);
  });


  it('refuses the request when a plugin-level hook refuses, on every route', async () => {
    /**
     * The other half: proving the hook's refusal is not swallowed. A `preHandler`
     * that replies must stop the handler, and the hooks are registered on
     * the plugin rather than per route — so a route added tomorrow inherits this
     * or nothing. Expressed on `tenantContextMiddleware`: a plugin hook that replies
     * stops every route, and the internal handler is never called.
     */
    mocks.refuseTenantContext = true;
    const app = await buildApp({ role: 'account_admin' });

    for (const path of ROUTES) {
      const res = await app.inject({ method: 'GET', url: `${PREFIX}/${path}` });
      expect(res.statusCode, `${path} must inherit the plugin-level gate`).toBe(403);
    }
    expect(mocks.proxyToCore).not.toHaveBeenCalled();
    await app.close();
  });

  it('registers exactly these two plugin-level hooks, so a third is noticed', () => {
    /**
     * The source-text counterpart to the cases above, and it earns its place for
     * the same reason the `requirePermission` block's registration count does: a
     * hook DELETED reds behaviourally, but a hook ADDED — a fourth gate, or a
     * second capability — would pass every case here while changing what the
     * plugin does. Counting is what sees that.
     */
    const source = readFileSync(
      new URL('../../../src/api/routes/proxy-agency-performance.routes.ts', import.meta.url),
      'utf8',
    );
    const hooks = source.match(/app\.addHook\('preHandler',\s*([^)]+)\)/g) ?? [];

    // Two hooks exist; a third (a new gate) reds here.
    expect(hooks).toEqual([
      "app.addHook('preHandler', sessionMiddleware)",
      "app.addHook('preHandler', tenantContextMiddleware)",
    ]);
  });
});

describe('every performance route carries its RBAC permission', () => {
  /**
   * A source-text assertion, copied from `proxy-agency-staffing.routes.test.ts`
   * rather than reinvented, and it earns its place for the same measured reason: a
   * guard DELETED from a route this file exercises would red above, but a route
   * ADDED without a guard would pass every case and be invisible. The registration
   * count is what catches that one.
   */
  const source = readFileSync(
    new URL('../../../src/api/routes/proxy-agency-performance.routes.ts', import.meta.url),
    'utf8',
  );

  const EXPECTED: ReadonlyArray<readonly [string, string, string]> = [
    ['get', '/my-stats', 'agency.station.connect'],
    ['get', '/my-attempts', 'agency.station.connect'],
    ['get', '/agents/:userId/stats', 'agency.supervise'],
    ['get', '/agents/:userId/attempts', 'agency.supervise'],
    // The two whole-floor reads, exercised in full by
    // `proxy-agency-roster.routes.test.ts` and
    // `proxy-agency-grouped-stats.routes.test.ts`. They are listed HERE as well
    // because this block's value is the count below: a route added to this plugin
    // without a `requirePermission` is invisible to every behavioural case in
    // those files, and a whole-floor scorecard is the worst route in the plugin
    // to ship ungated.
    ['get', '/agents/stats', 'agency.supervise'],
    // Same floor, and it has to be asserted rather than inherited: the grouped
    // read breaks the floor out BY PERSON when `agent` is grouped, so a viewer
    // floor here would leak exactly what the roster's floor exists to protect.
    ['get', '/agents/grouped-stats', 'agency.supervise'],
  ];

  it.each(EXPECTED)('%s %s requires %s', (verb, path, permission) => {
    const pattern = new RegExp(
      `\\.${verb}(?:<[^>]*>)?\\(\\s*'${path.replace(/[/:.]/g, '\\$&')}'\\s*,\\s*\\{\\s*` +
        `preHandler: requirePermission\\('${permission.replace(/\./g, '\\.')}'\\)`,
    );

    expect(pattern.test(source), `${verb.toUpperCase()} ${path} must be guarded by ${permission}`)
      .toBe(true);
  });

  it('knows about every route in the file, so a NEW unguarded one reds', () => {
    const registrations =
      source.match(/\b(?:app|sub)\.(?:get|post|patch|put|delete)(?:<[^>]*>)?\(/g) ?? [];

    expect(registrations).toHaveLength(EXPECTED.length);
  });

  it('registers exactly these six routes, as Fastify sees them', async () => {
    const app = Fastify({ logger: false });
    const routes: string[] = [];
    app.addHook('onRoute', (route) => {
      const methods = Array.isArray(route.method) ? route.method : [route.method];
      for (const method of methods) {
        if (method === 'HEAD') continue;
        routes.push(`${method} ${route.url}`);
      }
    });
    await app.register(proxyAgencyPerformanceRoutes, { prefix: PREFIX });
    await app.ready();

    expect([...routes].sort()).toEqual([
      'GET /proxy/agency/agents/:userId/attempts',
      'GET /proxy/agency/agents/:userId/stats',
      // Two segments where the two above have three, which is why Fastify keeps
      // them apart. Asserted here as a REGISTRATION and in
      // `proxy-agency-roster.routes.test.ts` as a dispatch, because the router
      // knowing a path and the right handler serving it are different facts.
      //
      // `grouped-stats` sorts before `stats` and is the same two-segment shape:
      // a static sibling, so there is no parametric route at this depth for it to
      // race. Its dispatch is asserted in
      // `proxy-agency-grouped-stats.routes.test.ts` on the internal handler path the handler
      // builds — a status code cannot tell "the grouped
      // handler answered" from "the roster handler answered".
      'GET /proxy/agency/agents/grouped-stats',
      'GET /proxy/agency/agents/stats',
      'GET /proxy/agency/my-attempts',
      'GET /proxy/agency/my-stats',
    ]);
    await app.close();
  });

  it('does not collide with the staffing plugin on the shared prefix', async () => {
    /**
     * Four plugins serve `/proxy/agency`, and Fastify throws on a duplicate
     * registration rather than picking one — so this both proves the paths are
     * disjoint and is the assertion that would have caught naming one of these
     * `/my-campaigns`.
     */
    const { proxyAgencyStaffingRoutes } = await import(
      '../../../src/api/routes/proxy-agency-staffing.routes.js'
    );
    const app = Fastify({ logger: false });
    await app.register(proxyAgencyPerformanceRoutes, { prefix: PREFIX });
    await app.register(proxyAgencyStaffingRoutes, { prefix: PREFIX });

    await expect(app.ready()).resolves.toBeDefined();
    await app.close();
  });
});
