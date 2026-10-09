import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type { MembershipRole } from '@magick-agency/contracts/rbac';
import { PERMISSION_MATRIX, hasPermission } from '@magick-agency/contracts/rbac';
import { filterRosterRowsByMembership } from '../../../src/agency/agency-agent-identity.js';

/**
 * **The supervisory ROSTER read** — `GET /proxy/agency/agents/stats`, the first part of
 * the supervisor console.
 *
 * Its sibling file (`proxy-agency-my-surfaces.routes.test.ts`) covers the four
 * per-agent routes in the same plugin and owns the plugin-level hook assertions.
 * This one covers the fifth, because what can go wrong with it is different in
 * kind: the other four forward the internal handler's body unchanged, while this one FILTERS the
 * rows and then reports what it filtered.
 *
 * ── The four failures this file exists to catch ─────────────────────────────
 *
 *  1. **A floor one notch too low turns a per-person scorecard for the whole
 *     roster into a viewer-readable page.** A whole-floor read reads like
 *     "analytics", and `proxy.analytics.read` / `proxy.stats.read` both floor at
 *     `viewer` — the wrong choice here is more tempting than on the per-agent
 *     twin, not less. Pinned against `PERMISSION_MATRIX` as well as
 *     behaviourally, because a behavioural case alone still passes if the floor
 *     moves to a DIFFERENT permission the same role happens to hold.
 *  2. **An unscoped read answered with the internal handler's header complaint instead of a
 *     named refusal.** `X-Account-Id` is optional to `tenantContextMiddleware`,
 *     so `request.accountId` can be `undefined`, and `proxyToCore` omits the
 *     account header when it is.
 *
 *     The read would not silently widen to every account in the tenant: the
 *     internal handler's `authMiddleware` requires `x-mgkvc-account` on every
 *     authenticated route and answers 400 `Missing required header:
 *     x-mgkvc-account` before any handler runs, so the widened read is
 *     never reachable. The public API layer's own 400 earns its place on what
 *     is left, which is what these cases assert: a named `account_scope_required`
 *     the console can act on rather than internal handler's header complaint
 *     — which `errorMaskHook` rewrites into "contact support", since a forwarded 4xx
 *     with neither `details` nor an allow-listed `code` is masked — and no
 *     handler call spent on a request that cannot succeed. Hence the
 *     assertion is `proxyToCore` untouched.
 *  3. **A filter that lies about itself.** The public API layer drops rows for two different
 *     reasons, so `inactive_omitted` and `unattributed_omitted` are the only
 *     things on the payload that say a list is short — separately, because a
 *     departure and an id the public API layer cannot account for are different facts and
 *     one number for both reports a stranger as a departed colleague. Neither may
 *     be withheld either: a row that vanishes with no counter behind it makes the
 *     console's arithmetic wrong with nothing on the wire to say so.
 *     And `include_inactive` is the public API layer's alone — forwarded to the internal handler it
 *     would be an unknown param on a route the internal handler does not know it, which is a 400
 *     the console cannot fix.
 *  4. **A benchmark that moves when a row filter is toggled.** The cohort is "the
 *     floor as it actually was", revoked members included. If dropping rows also
 *     changed the percentiles, one number would mean two things under one name —
 *     so it is asserted byte-identical across both flag values.
 *

 * ── And the one that is not a behaviour at all ──────────────────────────────
 * Route PRECEDENCE. `GET /agents/stats` and `GET /agents/:userId/stats` are
 * siblings under one prefix, and an assertion can pass vacuously when the route it
 * names does not exist. So both are asserted by the path they build for the
 * internal handler, which is the only evidence that separates "the
 * right handler ran" from "something answered 200".
 */

const TENANT = '11111111-1111-4111-8111-111111111111';
const ACCOUNT = '99999999-9999-4999-8999-999999999999';
/**
 * A second account in the SAME tenant. Exists for one case and it is the one the
 * review found: an agent revoked from `ACCOUNT` and still active here is a
 * departure from this roster, not a current colleague.
 */
const OTHER_ACCOUNT = '88888888-8888-4888-8888-888888888888';
/**
 * A uuid and an account id that contain hex LETTERS.
 *
 * Every other id in this file is digits-and-hyphens, so `.toUpperCase()` is a
 * NO-OP on them — a case-folding assertion built on `ACTIVE_AGENT` passes whether
 * or not the code folds anything. These two are what make that assertion able to
 * fail.
 */
const CASED_AGENT = 'aabbccdd-eeff-4aab-8bcd-eeffaabbccdd';
const CASED_ACCOUNT = 'ddccbbaa-ffee-4ddc-8cba-ffeeddccbbaa';
/** Still on the roster. */
const ACTIVE_AGENT = '22222222-2222-4222-8222-222222222222';
/** Left in April — `memberships.status = 'revoked'`. */
const DEPARTED_AGENT = '33333333-3333-4333-8333-333333333333';
/** No membership row of any status in this tenant. */
const STRANGER = '44444444-4444-4444-8444-444444444444';
const SUPERVISOR = '55555555-5555-4555-8555-555555555555';
const CAMPAIGN = '66666666-6666-4666-8666-666666666666';

const mocks = vi.hoisted(() => ({
  proxyToCore: vi.fn(),
  findAnyByUserAndTenant: vi.fn(),
  findAnyByUsersAndTenant: vi.fn(),
  findDisplayNamesInTenant: vi.fn(),
  hooksRan: [] as string[],
  /** The plugin-level refusal case drives `tenantContextMiddleware`. */
  refuseTenantContext: false,
}));

// The hop is `callCore` (`src/api/core-dispatch.ts`), mocked as `mocks.proxyToCore`; there is
// no key to resolve.
vi.mock('../../../src/api/core-dispatch.js', () => ({ callCore: mocks.proxyToCore }));
vi.mock('@magick-agency/observability', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@magick-agency/observability')>()),
  createChildLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
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
// degrade-never-500 rule is exercised rather than assumed. Same arrangement as
// the sibling file.
vi.mock('@magick-agency/db/repositories/user.repository', () => ({
  userRepository: { findDisplayNamesInTenant: mocks.findDisplayNamesInTenant },
}));

import {
  proxyAgencyPerformanceRoutes,
  ROSTER_CORE_TIME_BUDGET_MS,
} from '../../../src/api/routes/proxy-agency-performance.routes.js';

const PREFIX = '/proxy/agency';
const ROSTER = `${PREFIX}/agents/stats`;

interface Caller {
  role?: MembershipRole;
  /** `undefined` models a request with NO `X-Account-Id` — see failure 2 above. */
  accountId?: string | undefined;
}

async function buildApp(caller: Caller = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.addHook('onRequest', async (request) => {
    // Via `unknown`: `FastifyRequest` and `Record<string, unknown>` do not
    // sufficiently overlap for a direct assertion (TS2352 under `lint:test`).
    const r = request as unknown as Record<string, unknown>;
    r['tenantId'] = TENANT;
    // Assigned only when present, because the property being ABSENT is what
    // `tenantContextMiddleware` produces for a request with no `X-Account-Id`,
    // and it is the state failure 2 is about.
    if (!('accountId' in caller) || caller.accountId !== undefined) {
      r['accountId'] = caller.accountId ?? ACCOUNT;
    }
    r['user'] = { id: SUPERVISOR };
    r['membership'] = { role: caller.role ?? 'account_admin' };
  });
  await app.register(proxyAgencyPerformanceRoutes, { prefix: PREFIX });
  await app.ready();
  return app;
}

/**
 * The internal handler's minimum rate denominator, mirrored HERE and nowhere in `src/`.
 *
 * The public API layer owns no arithmetic on this payload and must not start — the flags are
 * the internal handler's answers and they ride the row spread. This exists only so the fixtures
 * below can be internally consistent.
 */
const CORE_MIN_RATE_DENOMINATOR = 20;

/**
 * One roster row in the internal handler's shape, per the frozen phase-01 contract.
 *
 * Full rather than trimmed, and the nullable metrics are exercised as nulls
 * somewhere in the page, because the public API layer SPREADS these rows: a fixture that
 * carried only the two fields the assertions read could not catch an enrichment
 * that rebuilt the row instead of spreading it. `connect_rate_pct` and friends are
 * `null` — never 0 — on a zero denominator.
 *
 * ── Both reportability flags, and both DERIVED ─────────────────────────────
 * `rates_reportable` says whether the row cleared the DIAL minimum and therefore
 * fed the connect-rate percentiles; `success_rate_reportable` says whether it
 * cleared the CONNECT minimum, which is the floor the conversion-rate and
 * handling-time percentiles pool over. They are computed from this row's own
 * numbers rather than defaulted beside them, so `row(X, { attempts: 3 })` stays a
 * shape the internal handler could emit — a fixture is a claim about the internal handler's output, and a flag
 * that contradicted its own denominator would be a claim the internal handler cannot honour.
 * An explicit override still wins.
 */
function row(agentUserId: string, overrides: Record<string, unknown> = {}) {
  const base = {
    agent_user_id: agentUserId,
    attempts: 120,
    connected: 44,
    successes: 11,
    talk_seconds: 4300,
    wrapup_seconds: 610,
    connect_rate_pct: 36.67,
    success_rate_pct: 25,
    aht_seconds: 111.6,
    campaigns: 2,
    shift_seconds: 16210,
    break_seconds: 1800,
    occupancy_pct: 30.28,
    last_dialed_at: '2026-08-22T11:04:09.000Z',
    ...overrides,
  };
  const ratesReportable =
    'rates_reportable' in base
      ? base.rates_reportable
      : (base.attempts as number) >= CORE_MIN_RATE_DENOMINATOR;
  return {
    ...base,
    rates_reportable: ratesReportable,
    success_rate_reportable:
      'success_rate_reportable' in base
        ? base.success_rate_reportable
        : Boolean(ratesReportable) && (base.connected as number) >= CORE_MIN_RATE_DENOMINATOR,
  };
}

/**
 * The cohort block, and the ONE thing on this payload the public API layer must never touch.
 *
 * It includes the departed agent's numbers by design: the benchmark is the floor
 * as it actually was, and `include_inactive` controls which ROWS come back, not
 * what they are measured against.
 */
function benchmark() {
  return {
    agents: 3,
    agents_rated: 2,
    attempts: 360,
    connected: 132,
    successes: 33,
    talk_seconds: 12900,
    wrapup_seconds: 1830,
    connect_rate_pct: 36.67,
    success_rate_pct: 25,
    aht_seconds: 111.6,
    connect_rate: { p25: 30.1, median: 36.67, p75: 41.2 },
    success_rate: { p25: 18, median: 25, p75: 31.5 },
    occupancy_pct: { p25: 22.4, median: 30.28, p75: 38.9 },
  };
}

/** The internal handler's whole roster page: one active agent, one departed, one stranger. */
function rosterBody(rows = [row(ACTIVE_AGENT), row(DEPARTED_AGENT)]) {
  return {
    from: '2026-08-01T00:00:00.000Z',
    to: '2026-08-23T00:00:00.000Z',
    campaign_id: null,
    sort: 'successes',
    order: 'desc',
    limit: 100,
    total_agents: 3,
    rows,
    benchmark: benchmark(),
  };
}

/**
 * What `findAnyByUsersAndTenant` returns for the standing page.
 *
 * `account_id` is on these rows because the filter reads it: "still on the
 * roster" is answered against the account the read is scoped to, so a fixture
 * without the column would exercise only the tenant-level branch and the
 * account-scoped cases below would have nothing to disagree with. Both rows are
 * scoped to `ACCOUNT`, which is the account every request in this file sends.
 */
const MEMBERSHIPS = [
  { id: 'm-1', user_id: ACTIVE_AGENT, status: 'active', role: 'agent', account_id: ACCOUNT },
  { id: 'm-2', user_id: DEPARTED_AGENT, status: 'revoked', role: 'agent', account_id: ACCOUNT },
];

beforeEach(() => {
  vi.clearAllMocks();
  // Not a mock, so `clearAllMocks` does not reach it.
  mocks.hooksRan.length = 0;
  mocks.refuseTenantContext = false;
  mocks.proxyToCore.mockResolvedValue({ status: 200, body: rosterBody() });
  mocks.findAnyByUsersAndTenant.mockResolvedValue(MEMBERSHIPS);
  mocks.findAnyByUserAndTenant.mockResolvedValue([{ id: 'm-1', role: 'agent', status: 'active' }]);
  mocks.findDisplayNamesInTenant.mockResolvedValue(new Map([
    [ACTIVE_AGENT, 'Sam Okoro'],
    [DEPARTED_AGENT, 'Ravi Menon'],
  ]));
});

describe('the floor, pinned against PERMISSION_MATRIX', () => {
  it('is agency.supervise, which is account_admin', () => {
    expect(PERMISSION_MATRIX['agency.supervise']).toBe('account_admin');
    expect(hasPermission('account_admin', 'agency.supervise')).toBe(true);
    expect(hasPermission('tenant_admin', 'agency.supervise')).toBe(true);
    expect(hasPermission('tenant_owner', 'agency.supervise')).toBe(true);
  });

  it('and it is NOT any viewer-floored read that a roster page resembles', () => {
    /**
     * The specific wrong choices. A whole-floor scorecard looks like an analytics
     * surface, and both of these floor at `viewer` — so picking either would hand
     * every viewer in the tenant every agent's success rate and talk time while
     * reading as entirely reasonable in review.
     */
    // `agency.campaigns.read` is checked; `proxy.analytics.read` and `proxy.stats.read` have no
    // agency twin, so they are asserted ABSENT (neither can be picked by mistake).
    for (const permission of ['agency.campaigns.read'] as const) {
      expect(PERMISSION_MATRIX[permission]).toBe('viewer');
      expect(hasPermission('viewer', permission)).toBe(true);
    }
    expect(PERMISSION_MATRIX).not.toHaveProperty('proxy.analytics.read');
    expect(PERMISSION_MATRIX).not.toHaveProperty('proxy.stats.read');
    // Which the roster floor does not admit.
    expect(hasPermission('viewer', 'agency.supervise')).toBe(false);
  });

  it('refuses agent, viewer and operator — and reads nothing on the way', async () => {
    for (const role of ['agent', 'viewer', 'operator'] as MembershipRole[]) {
      const app = await buildApp({ role });

      const res = await app.inject({ method: 'GET', url: ROSTER });

      expect(res.statusCode, `${role} must not read the roster`).toBe(403);
      // An `agent` reading the whole floor's dispositions and talk time is the
      // peer-surveillance surface the product deliberately does not offer.
      expect(mocks.proxyToCore).not.toHaveBeenCalled();
      expect(mocks.findAnyByUsersAndTenant).not.toHaveBeenCalled();
      await app.close();
    }
  });

  it('admits account_admin and above', async () => {
    for (const role of ['account_admin', 'tenant_admin', 'tenant_owner'] as MembershipRole[]) {
      const app = await buildApp({ role });

      const res = await app.inject({ method: 'GET', url: ROSTER });

      expect(res.statusCode, `${role} must reach the roster`).toBe(200);
      await app.close();
    }
  });
});

describe('the account scope is a predicate, not a filter', () => {
  it('refuses a request with no account, before calling the internal handler', async () => {
    /**
     * The decision, asserted where it can actually fail — and for the right reason.
     *
     * It is true that `X-Account-Id` is optional to `tenantContextMiddleware` and that
     * `proxyToCore` omits `x-mgkvc-account` when the public API layer has none — but the
     * internal handler's own `authMiddleware` requires the header on every authenticated
     * route and answers **400 `Missing required header: x-mgkvc-account`** before any
     * handler runs, so no scoping decision is ever reached and a silent widening to
     * every account in the tenant is not available.
     *
     * The public API layer's 400 earns its place on what is left, and both halves are
     * asserted below: a named `account_scope_required` the console can act on instead of
     * the internal handler's header complaint — which `errorMaskHook` rewrites into "contact
     * support and quote this request id", because a forwarded 4xx carrying
     * neither `details` nor an allow-listed `code` is masked — and the fact that
     * no handler call is spent on a request that cannot succeed.
     */
    const app = await buildApp({ accountId: undefined });

    const res = await app.inject({ method: 'GET', url: ROSTER });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'account_scope_required' });
    // The half that matters: the unscoped read was never issued, and no handler call was
    // made for it.
    expect(mocks.proxyToCore).not.toHaveBeenCalled();
    await app.close();
  });

  it('forwards the account it was given to the internal handler', async () => {
    const app = await buildApp();

    await app.inject({ method: 'GET', url: ROSTER });

    expect(mocks.proxyToCore).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: TENANT, accountId: ACCOUNT }),
    );
    await app.close();
  });
});

describe('the query whitelist', () => {
  it('forwards the six documented params and nothing else', async () => {
    const app = await buildApp();

    await app.inject({
      method: 'GET',
      url: `${ROSTER}?from=2026-08-01&to=2026-08-23&campaign_id=${CAMPAIGN}`
        + '&sort=success_rate_pct&order=asc&limit=50',
    });

    expect(mocks.proxyToCore.mock.calls[0]![0].query).toEqual({
      from: '2026-08-01',
      to: '2026-08-23',
      campaign_id: CAMPAIGN,
      sort: 'success_rate_pct',
      order: 'asc',
      limit: '50',
    });
    await app.close();
  });

  it('refuses an unknown param with a 400, and makes NO the internal handler call', async () => {
    /**
     * A silent drop is the failure this mechanism exists to stop: a param the public API layer
     * does not know about used to vanish and the request still succeeded, so a
     * filter that did nothing was indistinguishable from one that matched
     * everything. `bucket` is the realistic mistake here — it is a legitimate
     * param on the per-agent stats twin next door, and this route has no buckets.
     */
    const app = await buildApp();

    const res = await app.inject({ method: 'GET', url: `${ROSTER}?bucket=day&utm_source=email` });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'unknown_query_params' });
    expect(res.json().details.unknown).toEqual(['bucket', 'utm_source']);
    expect(mocks.proxyToCore).not.toHaveBeenCalled();
    await app.close();
  });

  it('refuses agent_user_id — the subject of this route is the whole roster', async () => {
    /**
     * Its absence from the allowlist means something different here than on the
     * `my-*` routes. There it stopped a caller naming a colleague; here the
     * subject IS everyone in scope, so the param is a filter the internal handler does not
     * implement (the compare surface is a later addition). Refused rather than dropped,
     * because a dropped `agent_user_id` answers 200 with the FULL roster to a
     * console that asked about two people — and presents it as the two.
     */
    const app = await buildApp();

    const res = await app.inject({
      method: 'GET',
      url: `${ROSTER}?agent_user_id=${ACTIVE_AGENT}&from=2026-08-01`,
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().details.unknown).toEqual(['agent_user_id']);
    expect(mocks.proxyToCore).not.toHaveBeenCalled();
    await app.close();
  });

  it('consumes include_inactive and does NOT forward it', async () => {
    // The internal handler has no user table and no idea what a membership status is; the param
    // would be an unknown one on the internal handler's own strict whitelist. It is declared
    // `consumedByRoute` so strictness accepts it here and the forward list leaves
    // it behind.
    const app = await buildApp();

    await app.inject({ method: 'GET', url: `${ROSTER}?include_inactive=true&limit=10` });

    expect(mocks.proxyToCore.mock.calls[0]![0].query).toEqual({ limit: '10' });
    expect(mocks.proxyToCore.mock.calls[0]![0].query).not.toHaveProperty('include_inactive');
    await app.close();
  });

  /**
   * The wire encoding of the flag, pinned VALUE BY VALUE rather than by inspecting the
   * parser.
   *
   * ── Why an accepted value is asserted by what it MEANT ─────────────────────
   * A 200 says only that the value parsed; it does not say which way. The
   * dangerous failure is not a rejected `1`, it is a `1` read as `false` — the
   * request answers 200 with the departed agents hidden, which is the opposite of
   * what was asked, and `inactive_omitted` then reports the omission as though it
   * had been requested. So each accepted value carries the truth table it must
   * produce against the standing fixture (one active agent, one departed):
   * `false` keeps 1 row and counts 1, `true` keeps both and counts 0.
   *
   * ── Why the table is this wide ────────────────────────────────────────────
   * Trimming and lowercasing ARE applied, so the accepted set has to be stated
   * rather than inferred — and every neighbouring truthy string a client might
   * reasonably send (`on`, `yes`) is NOT in it. `2` and `-1` are here because a
   * numeric-looking value is the one a coercing parser would let through, and
   * `'null'` because it is what a client serialising an absent value by accident
   * sends. Refusal, never coercion.
   */
  const INCLUDE_INACTIVE_MEANING: ReadonlyArray<readonly [string, boolean]> = [
    ['true', true],
    ['false', false],
    ['1', true],
    ['0', false],
    ['TRUE', true],
    ['False', false],
    ['  true  ', true],
    ['TRUE ', true],
    // `?include_inactive=` is what an unchecked box posts: the default, not a 400.
    ['', false],
  ];

  it.each(INCLUDE_INACTIVE_MEANING)('reads include_inactive=%j as %s', async (value, expected) => {
    const app = await buildApp();

    const res = await app.inject({
      method: 'GET',
      url: `${ROSTER}?include_inactive=${encodeURIComponent(value)}`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().rows).toHaveLength(expected ? 2 : 1);
    expect(res.json().inactive_omitted).toBe(expected ? 0 : 1);
    // The public API layer's alone under every spelling — the internal handler never learns the param exists.
    expect(mocks.proxyToCore.mock.calls[0]![0].query).not.toHaveProperty('include_inactive');
    await app.close();
  });

  it.each(['maybe', 'yes', 'no', 'on', 'off', '2', '-1', 'null'])(
    'refuses include_inactive=%j rather than coercing it',
    async (value) => {
      const app = await buildApp();

      const res = await app.inject({
        method: 'GET',
        url: `${ROSTER}?include_inactive=${encodeURIComponent(value)}`,
      });

      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ code: 'invalid_include_inactive' });
      // Field-level feedback for the client. What keeps the refusal READABLE is
      // that it is raised before any internal handler call records a status — see the handler
      // comment — but a client still needs to be told which param it was.
      expect(res.json().details).toHaveProperty('include_inactive');
      expect(mocks.proxyToCore).not.toHaveBeenCalled();
      await app.close();
    },
  );

  it('refuses a REPEATED include_inactive rather than picking one', async () => {
    /**
     * The docstring's claim, previously unasserted. Fastify hands a repeated key
     * over as an ARRAY, so this is the one refusal that does not come from the
     * string vocabulary at all — a parser that stringified the array, or took
     * `[0]`, or took the last one, would answer 200 to two contradictory
     * instructions and there is no defensible pick between them.
     */
    const app = await buildApp();

    const res = await app.inject({
      method: 'GET',
      url: `${ROSTER}?include_inactive=true&include_inactive=false`,
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'invalid_include_inactive' });
    expect(mocks.proxyToCore).not.toHaveBeenCalled();
    await app.close();
  });

  it('treats an absent and a VALUELESS include_inactive as false', async () => {
    // `?include_inactive` with no `=` at all is a third spelling of the unchecked
    // box, and it must mean the default rather than a 400.
    for (const url of [ROSTER, `${ROSTER}?include_inactive`]) {
      const app = await buildApp();

      const res = await app.inject({ method: 'GET', url });

      expect(res.statusCode).toBe(200);
      expect(res.json().inactive_omitted).toBe(1);
      await app.close();
    }
  });
});

describe('departed agents: the public API layer decides which rows survive', () => {
  it('drops revoked members by default and counts them', async () => {
    const app = await buildApp();

    const res = await app.inject({ method: 'GET', url: ROSTER });

    expect(res.json().rows.map((r: { agent_user_id: string }) => r.agent_user_id))
      .toEqual([ACTIVE_AGENT]);
    expect(res.json().inactive_omitted).toBe(1);
    await app.close();
  });

  it('keeps them under include_inactive=true, with the counter at 0', async () => {
    /**
     * Zero rather than absent: the key is the only thing on the payload that says
     * whether a list is short, and a sometimes-absent key is indistinguishable
     * from one a client forgot to read.
     */
    const app = await buildApp();

    const res = await app.inject({ method: 'GET', url: `${ROSTER}?include_inactive=true` });

    expect(res.json().rows.map((r: { agent_user_id: string }) => r.agent_user_id))
      .toEqual([ACTIVE_AGENT, DEPARTED_AGENT]);
    expect(res.json().inactive_omitted).toBe(0);
    await app.close();
  });

  it('never shows a user who was never in this tenant, under EITHER flag', async () => {
    /**
     * The third state, and the reason the membership read returns statuses rather
     * than a filtered list. `include_inactive` means "show me the people who
     * left", not "show me ids you cannot account for" — and the count of these is
     * deliberately NOT folded into `inactive_omitted`, because reporting a
     * stranger as a departed colleague is a different lie from hiding one.
     */
    mocks.proxyToCore.mockResolvedValue({
      status: 200,
      body: rosterBody([row(ACTIVE_AGENT), row(DEPARTED_AGENT), row(STRANGER)]),
    });

    for (const url of [ROSTER, `${ROSTER}?include_inactive=true`]) {
      const app = await buildApp();

      const res = await app.inject({ method: 'GET', url });

      const ids = res.json().rows.map((r: { agent_user_id: string }) => r.agent_user_id);
      expect(ids).not.toContain(STRANGER);
      // The stranger is not counted as a departure under either flag.
      expect(res.json().inactive_omitted).toBe(url.includes('include_inactive') ? 0 : 1);
      await app.close();
    }
  });

  it('reports a departure and an unaccountable id as SEPARATE numbers', async () => {
    /**
     * The third state: an id with no membership at all. It is dropped under either flag and
     * must never be folded into `inactive_omitted` — reporting a stranger as a
     * departed colleague is a different lie from hiding one — but it cannot be
     * logged and withheld either, which is what it was at first: the row vanished
     * with no counter behind it, so the console's claim that the gap between a
     * total and the visible rows IS the departed agents' work was false with
     * nothing on the wire to say so.
     *
     * This is reachable, not a hypothetical. The internal handler
     * scoping every statement on `tenant_id` AND `account_id` rules out a FOREIGN
     * agent, not a FORMER one — the internal handler keeps attempt history forever while a
     * `memberships` row goes away with the user.
     *
     * Three facts, three numbers: one row served, one departure, one id the public API layer
     * cannot account for. A merge of the two counters answers 2 and 0 — the same
     * total, and a different and false statement about what happened.
     */
    mocks.proxyToCore.mockResolvedValue({
      status: 200,
      body: rosterBody([row(ACTIVE_AGENT), row(DEPARTED_AGENT), row(STRANGER)]),
    });
    const app = await buildApp();

    const res = await app.inject({ method: 'GET', url: ROSTER });

    expect(res.json().rows).toHaveLength(1);
    expect(res.json().inactive_omitted).toBe(1);
    expect(res.json().unattributed_omitted).toBe(1);
    await app.close();
  });

  it('leaves unattributed_omitted at 0 when the only omission is a departure', async () => {
    // The standing fixture, no stranger on it. Nothing may leak sideways between
    // two counters that are about different rows.
    const app = await buildApp();

    const res = await app.inject({ method: 'GET', url: ROSTER });

    expect(res.json().inactive_omitted).toBe(1);
    expect(res.json().unattributed_omitted).toBe(0);
    await app.close();
  });

  it('counts a stranger WITHOUT calling them a departure', async () => {
    // The mirror image, and the case a merge cannot pass: one row dropped, and
    // `inactive_omitted` stays 0 because nobody left.
    mocks.proxyToCore.mockResolvedValue({
      status: 200,
      body: rosterBody([row(ACTIVE_AGENT), row(STRANGER)]),
    });
    const app = await buildApp();

    const res = await app.inject({ method: 'GET', url: ROSTER });

    expect(res.json().rows.map((r: { agent_user_id: string }) => r.agent_user_id))
      .toEqual([ACTIVE_AGENT]);
    expect(res.json().inactive_omitted).toBe(0);
    expect(res.json().unattributed_omitted).toBe(1);
    await app.close();
  });

  it('and include_inactive does not move it, because that is not what it means', async () => {
    // `include_inactive` means "show me the people who left", not "show me ids
    // you cannot account for". The departure comes back and its counter falls to
    // 0; the stranger's row stays dropped and its counter stays 1.
    mocks.proxyToCore.mockResolvedValue({
      status: 200,
      body: rosterBody([row(ACTIVE_AGENT), row(DEPARTED_AGENT), row(STRANGER)]),
    });
    const app = await buildApp();

    const res = await app.inject({ method: 'GET', url: `${ROSTER}?include_inactive=true` });

    const ids = res.json().rows.map((r: { agent_user_id: string }) => r.agent_user_id);
    expect(ids).toEqual([ACTIVE_AGENT, DEPARTED_AGENT]);
    expect(res.json().inactive_omitted).toBe(0);
    expect(res.json().unattributed_omitted).toBe(1);
    await app.close();
  });

  it('reads the whole page in ONE membership query, keyed on this tenant', async () => {
    // Not one lookup per row: the page is up to 200 rows and each one would be a
    // round trip. The tenant argument is asserted too — it is the boundary that
    // makes "never in this tenant" mean anything.
    mocks.proxyToCore.mockResolvedValue({
      status: 200,
      body: rosterBody([row(ACTIVE_AGENT), row(DEPARTED_AGENT), row(STRANGER)]),
    });
    const app = await buildApp();

    await app.inject({ method: 'GET', url: ROSTER });

    expect(mocks.findAnyByUsersAndTenant).toHaveBeenCalledTimes(1);
    expect(mocks.findAnyByUsersAndTenant).toHaveBeenCalledWith(
      [ACTIVE_AGENT, DEPARTED_AGENT, STRANGER],
      TENANT,
    );
    // And the ACTIVE-only sibling was not used: it answers "what may this person
    // do here", which reports a departed agent as no member at all.
    expect(mocks.findAnyByUserAndTenant).not.toHaveBeenCalled();
    await app.close();
  });

  it('the benchmark is byte-identical whether or not rows were dropped', async () => {
    /**
     * The cohort is "the floor that week", revoked members included, and
     * `include_inactive` controls which ROWS come back rather than what they are
     * measured against. A benchmark that moved when a supervisor ticked a filter
     * would be a different number under the same name — and every per-row
     * comparison in the console reads against it.
     *
     * Asserted as an equality between two RESPONSES rather than against a copy of
     * the fixture, so a public-API-layer recomputation that happened to agree with the
     * fixture on one path still reds.
     */
    const app = await buildApp();

    const dropped = await app.inject({ method: 'GET', url: ROSTER });
    const kept = await app.inject({ method: 'GET', url: `${ROSTER}?include_inactive=true` });

    expect(dropped.json().rows).toHaveLength(1);
    expect(kept.json().rows).toHaveLength(2);
    expect(dropped.json().benchmark).toEqual(kept.json().benchmark);
    expect(dropped.json().benchmark).toEqual(benchmark());
    // `total_agents` is the internal handler's pre-`limit`, post-scope count of who dialled —
    // the population the benchmark is computed over — so it does not move either.
    expect(dropped.json().total_agents).toBe(3);
    expect(kept.json().total_agents).toBe(3);
    await app.close();
  });

  it('leaves every other field the internal handler sent untouched, and rebuilds no row', async () => {
    // A SPREAD, not a reconstruction: `from`/`to`, `sort`, `order`, `limit` and
    // every metric on the surviving row have to arrive exactly as the internal handler wrote
    // them, including fields the internal handler adds after this was written.
    const app = await buildApp();

    const res = await app.inject({ method: 'GET', url: `${ROSTER}?include_inactive=true` });

    expect(res.json()).toEqual({
      ...rosterBody(),
      rows: [
        { ...row(ACTIVE_AGENT), agent_name: 'Sam Okoro' },
        { ...row(DEPARTED_AGENT), agent_name: 'Ravi Menon' },
      ],
      inactive_omitted: 0,
      unattributed_omitted: 0,
    });
    await app.close();
  });
});

describe('the row filter itself, without a router', () => {
  /**
   * The policy is three branches and the cost of getting it wrong is invisible in
   * a status code, so it is also tested directly — including the cases a route
   * test cannot cheaply reach.
   */
  const rows = [
    { agent_user_id: ACTIVE_AGENT },
    { agent_user_id: DEPARTED_AGENT },
    { agent_user_id: STRANGER },
  ];

  it('keeps active, drops departed, drops the stranger', () => {
    const result = filterRosterRowsByMembership(rows, MEMBERSHIPS, ACCOUNT, false);

    expect(result.rows).toEqual([{ agent_user_id: ACTIVE_AGENT }]);
    expect(result.inactiveOmitted).toBe(1);
    expect(result.unknownOmitted).toBe(1);
  });

  it('keeps departed under the flag, and still drops the stranger', () => {
    const result = filterRosterRowsByMembership(rows, MEMBERSHIPS, ACCOUNT, true);

    expect(result.rows).toEqual([{ agent_user_id: ACTIVE_AGENT }, { agent_user_id: DEPARTED_AGENT }]);
    expect(result.inactiveOmitted).toBe(0);
    expect(result.unknownOmitted).toBe(1);
  });

  it('treats ANY membership that REACHES THIS ACCOUNT as current', () => {
    /**
     * A user can hold several memberships in one tenant — one per account, plus
     * possibly a tenant-level one — so the presence of one active row that reaches
     * this account decides it. The opposite fold (last row wins, or
     * all-must-be-active) would hide a working colleague from their own supervisor
     * depending on row order.
     */
    const mixed = [
      { user_id: DEPARTED_AGENT, status: 'revoked', account_id: ACCOUNT },
      { user_id: DEPARTED_AGENT, status: 'active', account_id: ACCOUNT },
    ];

    expect(filterRosterRowsByMembership(
      [{ agent_user_id: DEPARTED_AGENT }], mixed, ACCOUNT, false,
    ).rows).toEqual([{ agent_user_id: DEPARTED_AGENT }]);
  });

  it('counts a TENANT-LEVEL active membership, which reaches every account', () => {
    // `account_id IS NULL` is a tenant-level row and reaches every
    // account by design. Read as "some other account" it would hide every
    // tenant-level agent from every roster.
    const tenantWide = [{ user_id: ACTIVE_AGENT, status: 'active', account_id: null }];

    expect(filterRosterRowsByMembership(
      [{ agent_user_id: ACTIVE_AGENT }], tenantWide, ACCOUNT, false,
    )).toMatchObject({ rows: [{ agent_user_id: ACTIVE_AGENT }], inactiveOmitted: 0 });
  });

  it('does NOT count an active membership on a DIFFERENT account', () => {
    /**
     * ⚠️ The half of this policy that was wrong, and it was wrong in the
     * expensive direction: it SHOWED somebody.
     *
     * The filter counted any active row in the tenant, arguing that a person
     * revoked from one account and active in another has not left the company.
     * True, and not the question this read asks. `GET /agents/stats` is scoped to
     * ONE account by a required predicate, so every row on the page is work done
     * in this account — and an agent who moved to another account was served as a
     * current colleague of a supervisor who cannot see the account they moved to,
     * with `inactive_omitted` reporting nothing hidden.
     *
     * `include_inactive` is the flag that brings them back, which is exactly its
     * meaning: show me the people who are no longer on this floor.
     */
    const elsewhere = [
      { user_id: DEPARTED_AGENT, status: 'revoked', account_id: ACCOUNT },
      { user_id: DEPARTED_AGENT, status: 'active', account_id: OTHER_ACCOUNT },
    ];

    expect(filterRosterRowsByMembership(
      [{ agent_user_id: DEPARTED_AGENT }], elsewhere, ACCOUNT, false,
    )).toMatchObject({ rows: [], inactiveOmitted: 1, unknownOmitted: 0 });
    // Not a stranger, though — they have membership rows here, so they are a
    // departure from this floor and the flag restores them.
    expect(filterRosterRowsByMembership(
      [{ agent_user_id: DEPARTED_AGENT }], elsewhere, ACCOUNT, true,
    )).toMatchObject({ rows: [{ agent_user_id: DEPARTED_AGENT }], inactiveOmitted: 0 });
  });

  it('matches ids case-insensitively, on the row AND on the membership', () => {
    /**
     * The other half of the same hazard, and it hid a real person too.
     *
     * `memberships.user_id` is a Postgres `uuid`, which comes back in canonical
     * LOWER case. `agent_user_id` comes from the internal handler, where it is an opaque string
     * with no `uuid` column behind it — so an upper-case id is reachable.
     * `findAnyByUsersAndTenant` casts to `::uuid[]`, so that id MATCHES in SQL and
     * returns a lower-case row: the membership exists, was read, and was paid
     * for — and then missed by a case-sensitive `Set.has`, so the row was dropped
     * and counted under `unattributed_omitted`. A working colleague vanishes and
     * the payload says the public API layer could not account for them.
     *
     * Both directions, because the fix has to normalise on insert as well as on
     * lookup and one of the two alone still fails half the time.
     */
    // `CASED_*` and not `ACTIVE_AGENT`: see their declaration. On a digits-only
    // uuid `.toUpperCase()` changes nothing and this case cannot fail.
    const lowerMembership = [
      { user_id: CASED_AGENT, status: 'active', account_id: CASED_ACCOUNT },
    ];
    const upperRow = [{ agent_user_id: CASED_AGENT.toUpperCase() }];
    expect(filterRosterRowsByMembership(upperRow, lowerMembership, CASED_ACCOUNT, false))
      .toMatchObject({ rows: upperRow, inactiveOmitted: 0, unknownOmitted: 0 });

    // The other direction, with the scoped account spelled in the other case too,
    // so the account comparison is folded on both sides as well as the user id.
    const upperMembership = [
      { user_id: CASED_AGENT.toUpperCase(), status: 'active', account_id: CASED_ACCOUNT.toUpperCase() },
    ];
    expect(filterRosterRowsByMembership(
      [{ agent_user_id: CASED_AGENT }], upperMembership, CASED_ACCOUNT, false,
    )).toMatchObject({
      rows: [{ agent_user_id: CASED_AGENT }], inactiveOmitted: 0, unknownOmitted: 0,
    });
  });

  it('treats `inactive` like `revoked`, not like active', () => {
    // `memberships.status` is `'active' | 'inactive' | 'revoked'`. Only the first
    // means "still here"; a whitelist rather than a blacklist of the other two, so
    // a status added by a future migration is not silently read as current.
    const suspended = [{ user_id: DEPARTED_AGENT, status: 'inactive', account_id: ACCOUNT }];

    expect(filterRosterRowsByMembership(
      [{ agent_user_id: DEPARTED_AGENT }], suspended, ACCOUNT, false,
    )).toMatchObject({ rows: [], inactiveOmitted: 1, unknownOmitted: 0 });
    expect(filterRosterRowsByMembership(
      [{ agent_user_id: DEPARTED_AGENT }], suspended, ACCOUNT, true,
    )).toMatchObject({ rows: [{ agent_user_id: DEPARTED_AGENT }], inactiveOmitted: 0 });
  });

  it('drops an unusable agent_user_id as unaccountable, not as a departure', () => {
    // The internal handler cannot validate `agent_user_id` (it is opaque), so a blank or
    // non-string one is reachable and resolves to no membership row.
    const junk = [{ agent_user_id: '' }, { agent_user_id: null as unknown as string }];

    expect(filterRosterRowsByMembership(junk, MEMBERSHIPS, ACCOUNT, true))
      .toMatchObject({ rows: [], inactiveOmitted: 0, unknownOmitted: 2 });
  });
});

describe('the membership decision, end to end through the route', () => {
  /**
   * The pure cases above pin the policy; these two pin that the ROUTE hands it
   * the facts it needs. Both were live defects, and both hid a real person's row
   * behind a counter that named the wrong reason.
   */
  it('keeps an agent whose id the internal handler spelled in UPPER case', async () => {
    // The realistic pairing: the internal handler's `agent_user_id` is an opaque string, the
    // repository's `user_id` is a Postgres `uuid` and comes back lower case, and
    // `= ANY($1::uuid[])` matched them to each other in SQL. Everything worked
    // except the `Set` lookup, so the row was dropped as unattributed.
    //
    // `CASED_AGENT` because upper-casing a digits-only uuid is a no-op — see its
    // declaration.
    mocks.findAnyByUsersAndTenant.mockResolvedValue([
      { id: 'm-9', user_id: CASED_AGENT, status: 'active', account_id: ACCOUNT },
    ]);
    mocks.proxyToCore.mockResolvedValue({
      status: 200,
      body: rosterBody([row(CASED_AGENT.toUpperCase())]),
    });
    mocks.findDisplayNamesInTenant.mockResolvedValue(new Map([[CASED_AGENT, 'Sam Okoro']]));
    const app = await buildApp();

    const res = await app.inject({ method: 'GET', url: ROSTER });

    expect(res.json().rows).toHaveLength(1);
    expect(res.json().unattributed_omitted).toBe(0);
    expect(res.json().inactive_omitted).toBe(0);
    // The id the internal handler sent is served back UNCHANGED — the fold is a comparison, not a
    // rewrite, and the internal handler owns the string.
    expect(res.json().rows[0].agent_user_id).toBe(CASED_AGENT.toUpperCase());
    // The NAME still misses, and that is the asymmetry stated rather than fixed:
    // `findDisplayNamesInTenant` is keyed the same way and would answer for the
    // lower-case id, so the row is served with `agent_name: null`. A null name is
    // a degraded label on a row that is present; a missed MEMBERSHIP hid the
    // person entirely. Only the second one was worth changing this filter for.
    expect(res.json().rows[0].agent_name).toBeNull();
    await app.close();
  });

  it('hides an agent who is active only on ANOTHER account, and says so', async () => {
    // Revoked from the account being read, active on one this supervisor cannot
    // see. The read is scoped to one account, so this is a departure from this
    // page — reported under `inactive_omitted`, not `unattributed_omitted`, and
    // restored by `include_inactive`.
    mocks.findAnyByUsersAndTenant.mockResolvedValue([
      { id: 'm-1', user_id: ACTIVE_AGENT, status: 'revoked', account_id: ACCOUNT },
      { id: 'm-2', user_id: ACTIVE_AGENT, status: 'active', account_id: OTHER_ACCOUNT },
    ]);
    mocks.proxyToCore.mockResolvedValue({ status: 200, body: rosterBody([row(ACTIVE_AGENT)]) });
    const app = await buildApp();

    const res = await app.inject({ method: 'GET', url: ROSTER });

    expect(res.json().rows).toEqual([]);
    expect(res.json().inactive_omitted).toBe(1);
    expect(res.json().unattributed_omitted).toBe(0);
    await app.close();
  });
});

describe('names are the public API layer\'s, and never a reason to fail the read', () => {
  it('adds agent_name to every row in ONE query for the page', async () => {
    const app = await buildApp();

    const res = await app.inject({ method: 'GET', url: `${ROSTER}?include_inactive=true` });

    expect(res.json().rows.map((r: { agent_name: string }) => r.agent_name))
      .toEqual(['Sam Okoro', 'Ravi Menon']);
    expect(mocks.findDisplayNamesInTenant).toHaveBeenCalledTimes(1);
    expect(mocks.findDisplayNamesInTenant).toHaveBeenCalledWith(
      [ACTIVE_AGENT, DEPARTED_AGENT],
      TENANT,
    );
    await app.close();
  });

  it('does not spend a lookup on a row it dropped', async () => {
    // The filter runs first, so the departed agent's name is not resolved on the
    // default path.
    const app = await buildApp();

    await app.inject({ method: 'GET', url: ROSTER });

    expect(mocks.findDisplayNamesInTenant).toHaveBeenCalledWith([ACTIVE_AGENT], TENANT);
    await app.close();
  });

  it('degrades to agent_name: null rather than 500ing', async () => {
    mocks.findDisplayNamesInTenant.mockRejectedValue(new Error('db down'));
    const app = await buildApp();

    const res = await app.inject({ method: 'GET', url: `${ROSTER}?include_inactive=true` });

    expect(res.statusCode).toBe(200);
    // The KEY is still produced on every row — an absent key is indistinguishable
    // from one a client forgot to read, while a null is an answer.
    expect(res.json().rows.map((r: { agent_name: string | null }) => r.agent_name))
      .toEqual([null, null]);
    // And the numbers, which are the answer, are untouched.
    expect(res.json().benchmark).toEqual(benchmark());
    expect(res.json().inactive_omitted).toBe(0);
    await app.close();
  });

  it('degrades even when the lookup rejects with a NON-Error', async () => {
    // `pg` and `ioredis` both reject with plain objects on some paths, and a
    // `String(err)` narrowing that was never exercised is a throw inside the
    // catch — which turns the documented degrade into a masked 500.
    mocks.findDisplayNamesInTenant.mockRejectedValue('connection terminated unexpectedly');
    const app = await buildApp();

    const res = await app.inject({ method: 'GET', url: ROSTER });

    expect(res.statusCode).toBe(200);
    expect(res.json().rows[0].agent_name).toBeNull();
    await app.close();
  });

  it('yields null for a row the tenant cannot name, beside the id', async () => {
    // A resolvable id and an unresolvable one must be told apart, which is why
    // both keys are always present.
    mocks.findDisplayNamesInTenant.mockResolvedValue(new Map([[ACTIVE_AGENT, 'Sam Okoro']]));
    const app = await buildApp();

    const res = await app.inject({ method: 'GET', url: `${ROSTER}?include_inactive=true` });

    expect(res.json().rows).toEqual([
      { ...row(ACTIVE_AGENT), agent_name: 'Sam Okoro' },
      { ...row(DEPARTED_AGENT), agent_name: null },
    ]);
    await app.close();
  });
});

describe('non-2xx bodies reach the error mask exactly as the internal handler wrote them', () => {
  it('forwards an internal handler refusal untouched, and spends no database read on it', async () => {
    mocks.proxyToCore.mockResolvedValue({
      status: 400,
      body: { error: 'Validation failed', code: 'invalid_sort', details: { sort: ['unknown metric'] } },
    });
    const app = await buildApp();

    const res = await app.inject({ method: 'GET', url: `${ROSTER}?sort=vibes` });

    expect(res.statusCode).toBe(400);
    // Byte-identical, `details` included — that is what keeps it forwardable
    // rather than masked into "contact support".
    expect(res.json()).toEqual({
      error: 'Validation failed',
      code: 'invalid_sort',
      details: { sort: ['unknown metric'] },
    });
    expect(mocks.findAnyByUsersAndTenant).not.toHaveBeenCalled();
    expect(mocks.findDisplayNamesInTenant).not.toHaveBeenCalled();
    await app.close();
  });

  it('does not filter or count a non-2xx body that DOES carry rows', async () => {
    /**
     * The case the refusal above cannot see. A 424/429 that echoes the page is
     * reachable — the neighbouring campaign-activity surface already answers
     * `{ rows, partial, partial_reason }`, and `errorMaskHook` passes 429 through
     * by policy — and an `inactive_omitted` grafted onto such a body is both a
     * body the mask judges differently and a claim about filtering that did not
     * happen.
     */
    mocks.proxyToCore.mockResolvedValue({
      status: 424,
      body: { ...rosterBody(), partial: true, partial_reason: 'core_unavailable' },
    });
    const app = await buildApp();

    const res = await app.inject({ method: 'GET', url: ROSTER });

    expect(res.statusCode).toBe(424);
    expect(res.json()).toEqual({ ...rosterBody(), partial: true, partial_reason: 'core_unavailable' });
    expect(res.json().inactive_omitted).toBeUndefined();
    expect(res.json().unattributed_omitted).toBeUndefined();
    expect(mocks.findAnyByUsersAndTenant).not.toHaveBeenCalled();
    await app.close();
  });

  it('serves a 2xx body with NO row array unfiltered, rather than 500ing', async () => {
    // A body with nothing to walk. The answer to one is to hand it over
    // untouched, not to invent a filter over rows the public API layer cannot see.
    mocks.proxyToCore.mockResolvedValue({ status: 200, body: { unexpected: true } });
    const app = await buildApp();

    const res = await app.inject({ method: 'GET', url: ROSTER });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      unexpected: true, inactive_omitted: 0, unattributed_omitted: 0,
    });
    expect(mocks.findAnyByUsersAndTenant).not.toHaveBeenCalled();
    await app.close();
  });

  it('but still carries BOTH counters on that degrade path', async () => {
    /**
     * ⚠️ This branch used to send the internal handler's body with the key ABSENT, and the review
     * found it by probe. `inactive_omitted` is the public API layer's own invention — it exists
     * nowhere in the internal handler's payload — so a roster body served without it is a body no
     * client can read, and the client declares it REQUIRED and computes with it:
     * `total_agents <= rows.length + inactive_omitted` decides whether the
     * "showing the top N" truncation note renders, and with the key absent that
     * is `n <= NaN`, which is `false`. So the note appeared on a page that had
     * never been truncated — a 200 outside the contract is not a degrade, it is a
     * second bug wearing one.
     *
     * `0` is truthful rather than filler: the public API layer dropped nothing on this path.
     *
     * ⚠️ **This case's FIXTURE was itself the bug, and it is rewritten here.** It
     * used to be `{ ...rosterBody(), next_cursor: 12 }` — a full roster page with
     * one unreadable paging field — described as "the realistic refusal". It was
     * realistic, and that is precisely why it must not take this branch: the
     * degrade path is where the public API layer serves rows it did NOT filter, and a page whose
     * rows are perfectly walkable has no business on it. See
     * `the membership filter is gated on the ROWS, not on the paging fields`
     * below, which now pins that shape being filtered.
     *
     * So the fixture is a body whose `rows` member is not an array at all —
     * everything else about it looks like a roster, which is where a missing
     * counter does real damage, and there is genuinely nothing to walk.
     */
    const body = { ...rosterBody(), rows: 'not an array' };
    mocks.proxyToCore.mockResolvedValue({ status: 200, body });
    const app = await buildApp();

    const res = await app.inject({ method: 'GET', url: ROSTER });

    expect(res.statusCode).toBe(200);
    expect(res.json().inactive_omitted).toBe(0);
    // `unattributed_omitted` is the NEWER of the two and therefore the one a path
    // is likeliest to be missing, which is why both ride one helper rather than
    // each route separately remembering. Asserted here as well as where it is
    // non-zero, because this is the path the original defect was found on.
    expect(res.json().unattributed_omitted).toBe(0);
    // Everything the internal handler sent is still there, unfiltered and unnamed — the two
    // counters are the ONLY additions, and no row was dropped or enriched behind
    // them.
    expect(res.json()).toEqual({ ...body, inactive_omitted: 0, unattributed_omitted: 0 });
    expect(mocks.findAnyByUsersAndTenant).not.toHaveBeenCalled();
    expect(mocks.findDisplayNamesInTenant).not.toHaveBeenCalled();
    await app.close();
  });

  it('does not wrap a non-object body just to make room for the counter', async () => {
    // A 200 whose body is a string is not a roster in any field, and inventing an
    // object around it would be a shape nobody declared. Handed over as it came.
    mocks.proxyToCore.mockResolvedValue({ status: 200, body: 'not json at all' });
    const app = await buildApp();

    const res = await app.inject({ method: 'GET', url: ROSTER });

    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('not json at all');
    await app.close();
  });
});

describe('the membership filter is gated on the ROWS, not on the paging fields', () => {
  /**
   * **The filter is gated on the rows, not on the paging fields.**
   *
   * The filter must not depend on `asSpinePage(result.body)` returning a page.
   * That function is the CURSOR-page narrowing used by the CSV export drain, and
   * it refuses a body whose `next_cursor` is not a string **or whose `limit` is
   * not a number**. `limit` is a query parameter. `'50'` is the shape a query
   * parameter has. So an internal handler that echoed the caller's own `?limit=50` back as a
   * string — or that answered `next_cursor` at all on a route with no cursor —
   * would produce a page this route served **unfiltered, with `inactive_omitted: 0`**:
   * a departed agent's row on the page, under the public API layer's own assertion that
   * nothing was hidden. Filtering is the one public-API-layer decision on this payload
   * that must never degrade, and a gate on the paging fields would degrade it on
   * the most ordinary body shape available.
   *
   * These cases are therefore about the GATE, not about the paging fields. The
   * body is filtered because it has rows; nothing about a cursor or a limit
   * enters the decision. The complementary claim — that a body with genuinely no
   * row array is still served unfiltered *with* both counters — is the degrade
   * case in the block above.
   */
  const FILTERABLE: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
    // The realistic trigger, and the one the reviewer named: the internal handler echoing back
    // the caller's `limit` as the string it arrived as.
    ['a STRING limit, the shape a query param has', { limit: '100' }],
    // A cursor on a route that has none. Unreadable to the drain, irrelevant here.
    ['an unreadable next_cursor', { next_cursor: 12 }],
    // Both at once, so neither case is passing for the other's reason.
    ['both at once', { limit: '100', next_cursor: 12 }],
    // A field this build of the public API layer has never heard of. The rows are still rows.
    ['a field the public API layer does not know', { some_future_key: { nested: true } }],
  ];

  it.each(FILTERABLE)('filters a page with %s', async (_label, overrides) => {
    const body = { ...rosterBody(), ...overrides };
    mocks.proxyToCore.mockResolvedValue({ status: 200, body });
    const app = await buildApp();

    const res = await app.inject({ method: 'GET', url: ROSTER });

    expect(res.statusCode).toBe(200);
    // The departed agent is GONE and the count says so — the whole point.
    expect(res.json().rows.map((r: { agent_user_id: string }) => r.agent_user_id))
      .toEqual([ACTIVE_AGENT]);
    expect(res.json().inactive_omitted).toBe(1);
    expect(res.json().unattributed_omitted).toBe(0);
    // The membership read really happened — a filter that "ran" over an empty
    // membership list would drop everybody and count them unattributed, which the
    // assertions above would also catch, but this says which mechanism ran.
    expect(mocks.findAnyByUsersAndTenant).toHaveBeenCalledTimes(1);
    // And the name enrichment ran too. It narrowed through the SAME rejected
    // helper, so under the old gate this page came back with no `agent_name` key
    // at all on the branch whose contract is that the key is always present.
    expect(res.json().rows[0]).toHaveProperty('agent_name', 'Sam Okoro');
    // Untouched: the public API layer added its three fields and reshaped nothing else,
    // including the paging field that used to disqualify the whole body.
    for (const [key, value] of Object.entries(overrides)) {
      expect(res.json()[key]).toEqual(value);
    }
    expect(res.json().benchmark).toEqual(benchmark());
    await app.close();
  });

  it('and reports what it hid on such a page, rather than 0', async () => {
    /**
     * The assertion that separates "the filter ran" from "the filter ran and told
     * the truth". Under the old gate this page answered TWO rows and
     * `inactive_omitted: 0`; the failure was never a status code or an exception,
     * it was a truthful-looking number, which is why it survived a full suite.
     */
    mocks.proxyToCore.mockResolvedValue({
      status: 200,
      body: { ...rosterBody([row(ACTIVE_AGENT), row(DEPARTED_AGENT), row(STRANGER)]), limit: '100' },
    });
    const app = await buildApp();

    const res = await app.inject({ method: 'GET', url: ROSTER });

    expect(res.json().rows).toHaveLength(1);
    expect(res.json().inactive_omitted).toBe(1);
    expect(res.json().unattributed_omitted).toBe(1);
    await app.close();
  });
});

describe('the internal handler call carries a wall clock', () => {
  /**
   * Nothing else in this path has one. `proxyToCore` with no `timeoutMs` runs
   * under undici's default 300s header timeout, and the internal handler has **no
   * `statement_timeout`** — so an internal handler answering SLOWLY rather than failing holds
   * the public API layer's worker, its Fastify connection and a socket for as long as it likes.
   * The roster is the most expensive read on this surface (an attempt aggregate
   * plus an occupancy read that walks every agent state transition in the window,
   * two long statements in series), and the neighbouring activity export already
   * carries a budget for exactly this case.
   */
  it('passes ROSTER_CORE_TIME_BUDGET_MS to proxyToCore', async () => {
    const app = await buildApp();

    await app.inject({ method: 'GET', url: ROSTER });

    expect(mocks.proxyToCore.mock.calls[0]![0].timeoutMs).toBe(ROSTER_CORE_TIME_BUDGET_MS);
    await app.close();
  });

  it('is the reader-facing budget the export uses, not the probe\'s', async () => {
    // Asserted as a RELATION, not a literal: this is one whole interactive
    // request, so it gets the export's reader-facing figure rather than the
    // probe's deliberately short one (a probe has the whole export still ahead of
    // it). A future edit to either is then visible here.
    const { ACTIVITY_EXPORT_TIME_BUDGET_MS, ACTIVITY_OWNERSHIP_PROBE_TIMEOUT_MS } = await import(
      '../../../src/agency/agency-activity.js'
    );

    expect(ROSTER_CORE_TIME_BUDGET_MS).toBe(ACTIVITY_EXPORT_TIME_BUDGET_MS);
    expect(ROSTER_CORE_TIME_BUDGET_MS).toBeGreaterThan(ACTIVITY_OWNERSHIP_PROBE_TIMEOUT_MS);
  });

});

describe('route precedence: /agents/stats and /agents/:userId/stats', () => {
  /**
   * An assertion can pass vacuously when the route it names does not exist. So
   * neither of these cases asserts a status code: each asserts
   * the path the handler built for the internal handler, which is the only evidence that
   * distinguishes the roster handler from the per-agent one.
   */
  it('GET /agents/stats hits the ROSTER handler', async () => {
    const app = await buildApp();

    const res = await app.inject({ method: 'GET', url: ROSTER });

    expect(res.statusCode).toBe(200);
    expect(mocks.proxyToCore).toHaveBeenCalledWith(
      expect.objectContaining({ path: '/agency-agents/stats' }),
    );
    // The roster read does not tenant-check a named agent, because it names none.
    expect(mocks.findAnyByUserAndTenant).not.toHaveBeenCalled();
    await app.close();
  });

  it('GET /agents/<uuid>/stats still hits the PER-AGENT handler', async () => {
    const app = await buildApp();

    const res = await app.inject({ method: 'GET', url: `${PREFIX}/agents/${ACTIVE_AGENT}/stats` });

    expect(res.statusCode).toBe(200);
    expect(mocks.proxyToCore).toHaveBeenCalledWith(
      expect.objectContaining({ path: `/agency-agents/${ACTIVE_AGENT}/stats` }),
    );
    // Its own tenancy check ran, and the roster's page-shaped membership read did
    // not — the clearest signal available that the other handler answered.
    expect(mocks.findAnyByUserAndTenant).toHaveBeenCalledWith(ACTIVE_AGENT, TENANT);
    expect(mocks.findAnyByUsersAndTenant).not.toHaveBeenCalled();
    await app.close();
  });

  it('the literal "stats" is not read as a userId', async () => {
    /**
     * The failure this precedence question is actually about. If the parametric
     * route won, `:userId` would be the string `'stats'` — which
     * `agentParamsSchema` refuses, so the symptom would be a **400 Validation
     * Error on the roster read**, not a 404. Pinned so a future path change (a
     * third segment, a rename) cannot make the roster answer as a malformed
     * per-agent read.
     */
    const app = await buildApp();

    const res = await app.inject({ method: 'GET', url: ROSTER });

    expect(res.statusCode).not.toBe(400);
    expect(res.statusCode).not.toBe(404);
    expect(mocks.proxyToCore.mock.calls[0]![0].path).not.toContain('/stats/stats');
    await app.close();
  });
});

describe('the plugin-level hooks reach the roster route too', () => {
  it('runs session → tenant-context', async () => {
    // Registered on the PLUGIN, so a route added to this file inherits all three
    // or none. Asserted on the record each double leaves, because a hook that
    // never ran is indistinguishable from one that ran and allowed.
    const app = await buildApp();

    await app.inject({ method: 'GET', url: ROSTER });

    expect(mocks.hooksRan).toEqual(['session', 'tenant-context']);
    await app.close();
  });

  // A plugin-level hook (`tenantContextMiddleware`) that replies stops the route, and the
  // internal handler is never called.
  it('is refused when a plugin-level hook refuses', async () => {
    mocks.refuseTenantContext = true;
    const app = await buildApp();

    const res = await app.inject({ method: 'GET', url: ROSTER });

    expect(res.statusCode).toBe(403);
    expect(mocks.proxyToCore).not.toHaveBeenCalled();
    await app.close();
  });
});
