import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type { MembershipRole } from '@magick-agency/contracts/rbac';
import { PERMISSION_MATRIX, hasPermission } from '@magick-agency/contracts/rbac';
import {
  filterRowsByMembership,
  groupedRowAgentId,
  groupedRowHasAgentKey,
} from '../../../src/agency/agency-agent-identity.js';

/**
 * **The GROUPED read** — `GET /proxy/agency/agents/grouped-stats`, in
 * the supervisor console.
 *
 * Its two sibling files cover the rest of the plugin:
 * `proxy-agency-my-surfaces.routes.test.ts` owns the four per-agent routes and
 * the plugin-level hook/registration blocks, `proxy-agency-roster.routes.test.ts`
 * owns the roster. This file exists because what can go wrong HERE is different
 * in kind from both: the roster always filters its rows, the per-agent pair never
 * does, and this route decides **per page** which of those it is.
 *
 * ── The failures this file exists to catch ──────────────────────────────────
 *
 *  1. **A floor one notch too low.** A grouped aggregate reads like an analytics
 *     surface even more than the roster does — it is literally a pivot table —
 *     and `proxy.analytics.read` / `proxy.stats.read` both floor at `viewer`.
 *     When `agent` is grouped this payload IS a per-person scorecard, so the
 *     wrong floor leaks exactly what the roster's floor protects. Pinned against
 *     `PERMISSION_MATRIX` as well as behaviourally, because a behavioural case
 *     alone still passes if the floor moves to a DIFFERENT permission the same
 *     role happens to hold.
 *  2. **The filter applied to the wrong pages, in either direction.** Applied to
 *     a campaign-grouped page every row is dropped as unaccountable (no row
 *     carries an agent id), so a supervisor's contribution chart comes back
 *     empty. NOT applied to an agent-grouped page, departed colleagues are served
 *     under `inactive_omitted: 0` — a payload that states, falsely, that nothing
 *     was hidden.
 *  3. **Either omission counter missing on any path.** The public API layer invented
 *     `inactive_omitted` AND `unattributed_omitted`; the client declares them
 *     required and computes `total_groups <= rows.length + inactive_omitted`
 *     with the first, so an absent key makes that `n <= NaN`, which is `false`,
 *     and a truncation note renders on an untruncated page. This regressed on
 *     the roster's degrade path once already, which is why the newer field is
 *     asserted on the same paths rather than only where it is non-zero.
 *  4. **The two counters folded into one.** A departure and an id the public API layer
 *     cannot account for are different facts, and one number for both reports a
 *     stranger as a departed colleague. Withholding the second is the other half
 *     of the same defect — rows vanish, no counter moves, and the contribution
 *     screen's claim that the gap IS the departed agents' work is false.
 *  5. **The public API layer growing an opinion about `group_by`.** The vocabulary, the
 *     two-dimension cap and the timezone rule are the internal handler's. A second parser in
 *     the public API layer is a second definition of the same enum, and the copy that drifts is
 *     the one no query exercises.
 *
 * ── And the one that is not a failure at all ─────────────────────────────────
 * ⚠️ **The reconciliation asymmetry.** A campaign-grouped total INCLUDES a
 * departed agent's attempts; an agent-grouped view of the same campaign EXCLUDES
 * them by default. Both numbers are true answers to different questions, and the
 * difference is exactly the departed agents' work. It looks like a bug, so a
 * future reader will "fix" it — the block at the bottom pins it on one fixture
 * with both groupings and states the arithmetic, so the "fix" reds.
 */

const TENANT = '11111111-1111-4111-8111-111111111111';
const ACCOUNT = '99999999-9999-4999-8999-999999999999';
/** A second account in the same tenant — see the account-scoped filter cases. */
const OTHER_ACCOUNT = '88888888-8888-4888-8888-888888888888';
/**
 * A uuid and an account id that contain hex LETTERS.
 *
 * ⚠️ Every other id in this file is digits-and-hyphens, so `.toUpperCase()` is a
 * NO-OP on them and a case-folding assertion built on one passes whether or not
 * anything folds. Caught by mutating the fold away and watching
 * the case test stay green.
 */
const CASED_AGENT = 'aabbccdd-eeff-4aab-8bcd-eeffaabbccdd';
const CASED_ACCOUNT = 'ddccbbaa-ffee-4ddc-8cba-ffeeddccbbaa';
/** Still on the roster. */
const ACTIVE_AGENT = '22222222-2222-4222-8222-222222222222';
/** Left in April — `memberships.status = 'revoked'`. */
const DEPARTED_AGENT = '33333333-3333-4333-8333-333333333333';
/** No membership row of any status in this tenant. */
const STRANGER = '44444444-4444-4444-8444-444444444444';
/**
 * A second agent still on the roster, used only where a third row is needed to
 * pin a THIRD combination of the two reportability flags.
 *
 * Added to `MEMBERSHIPS` rather than reusing one of the two above, because
 * `group_by=agent` yields one row per person and the case being pinned is a row
 * whose two flags disagree — which needs a row of its own beside an agreeing one.
 * Adding a membership is inert for every other test here: rows come from the internal handler's
 * mocked body, and `MEMBERSHIPS` only ever filters them.
 */
const SECOND_AGENT = '77777777-7777-4777-8777-777777777777';
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
// both sibling files.
vi.mock('@magick-agency/db/repositories/user.repository', () => ({
  userRepository: { findDisplayNamesInTenant: mocks.findDisplayNamesInTenant },
}));

import {
  proxyAgencyPerformanceRoutes,
  ROSTER_CORE_TIME_BUDGET_MS,
} from '../../../src/api/routes/proxy-agency-performance.routes.js';

const PREFIX = '/proxy/agency';
const GROUPED = `${PREFIX}/agents/grouped-stats`;
const ROSTER = `${PREFIX}/agents/stats`;

interface Caller {
  role?: MembershipRole;
  /** `undefined` models a request with NO `X-Account-Id`. */
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
    // `tenantContextMiddleware` produces for a request with no `X-Account-Id`.
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

/** The internal handler answered a refusal; the helper stubs the internal handler's answer. */
async function coreRefuses(status: number, body: unknown): Promise<void> {
  mocks.proxyToCore.mockImplementation(async () => ({ status, body }));
}

// ─── Fixtures, in the internal handler's contract shape (D3/D4) ─────────────────────────────
//
// The eight metrics AND `rates_reportable` are always present, because the public API layer
// SPREADS these rows: a fixture carrying only the fields the assertions read
// could not catch an enrichment that REBUILT the row instead.
//
// The two reportability flags are the fields that prove that reasoning was worth
// stating — and both were missing from here. They appear NOWHERE in the public API layer's own
// `src/` or `test/` for this route, because the public API layer owns no arithmetic on this
// payload and they ride the row spread; that is precisely what makes them the
// keys a rebuild would drop in silence, with the visible symptom a 100%
// conversion rate printed as a NUMBER beside a named person.
//
// `success_rate_reportable` is the second of them, added after review found that
// `rates_reportable` gates on DIALS while the conversion rate divides by
// CONNECTS. It is the internal handler's per-metric answer and the public API layer must carry it untouched for
// exactly the same reason as the first.
//
// `key` carries a member if and only if its dimension is in `group_by`, which is
// the property the route reads to decide whether it is looking at people.

/**
 * The internal handler's minimum rate denominator, mirrored HERE and nowhere in `src/`.
 *
 * The public API layer owns no arithmetic on this payload and must not start: the flags below
 * are the internal handler's answers and they ride the row spread. This constant exists only so
 * the fixtures can be internally consistent — a fixture is a claim about what
 * the internal handler emits, and a test may not assert a shape the internal handler cannot produce.
 */
const CORE_MIN_RATE_DENOMINATOR = 20;

/**
 * The eight metrics plus BOTH reportability flags, with the nullable three
 * exercised as numbers by default.
 *
 * `attempts: 120` and `connected: 44` are both over `CORE_MIN_RATE_DENOMINATOR`,
 * so both flags default to `true` CONSISTENTLY rather than arbitrarily.
 *
 * ── The flags are DERIVED from the overrides, not defaulted beside them ─────
 * `rates_reportable` gates on `attempts`, `success_rate_reportable` on
 * `connected`, and deriving them is what keeps `metrics({ attempts: 3 })` a shape
 * the internal handler could actually emit. Hardcoding `success_rate_reportable: true` would let
 * `metrics({ attempts: 3, rates_reportable: false })` — which this file already
 * uses twice — produce a row whose conversion-rate flag contradicts its own dial
 * flag, and the console reads that flag to decide whether to print a percentage
 * beside a named person. An explicit override still wins, so a test that wants an
 * inconsistent row for its own reasons can still say so out loud.
 */
function metrics(overrides: Record<string, unknown> = {}) {
  const base = {
    attempts: 120,
    connected: 44,
    successes: 11,
    talk_seconds: 4300,
    wrapup_seconds: 610,
    connect_rate_pct: 36.67,
    success_rate_pct: 25,
    aht_seconds: 111.6,
    ...overrides,
  };
  const ratesReportable =
    'rates_reportable' in base
      ? base.rates_reportable
      : (base.attempts as number) >= CORE_MIN_RATE_DENOMINATOR;
  return {
    ...base,
    rates_reportable: ratesReportable,
    /*
      `rates_reportable` AND the CONNECT floor — the internal handler's own definition, and
      strictly stronger, because `connected <= attempts` always.
    */
    success_rate_reportable:
      'success_rate_reportable' in base
        ? base.success_rate_reportable
        : Boolean(ratesReportable) && (base.connected as number) >= CORE_MIN_RATE_DENOMINATOR,
  };
}

/** `group_by=agent`. */
function agentRow(agentUserId: string, overrides: Record<string, unknown> = {}) {
  return { key: { agent_user_id: agentUserId }, ...metrics(overrides) };
}

/** `group_by=agent,campaign` — the contribution view. */
function agentCampaignRow(
  agentUserId: string,
  campaignId: string,
  overrides: Record<string, unknown> = {},
) {
  return { key: { agent_user_id: agentUserId, campaign_id: campaignId }, ...metrics(overrides) };
}

/** `group_by=campaign` — an aggregate over everyone who dialled. */
function campaignRow(campaignId: string, overrides: Record<string, unknown> = {}) {
  return { key: { campaign_id: campaignId }, ...metrics(overrides) };
}

/**
 * `group_by=day_of_week,hour_of_day` — the best-hours view. `day_of_week` is a
 * NUMBER (0 = Sunday, matching `EXTRACT(DOW)`), not a name.
 */
function hourRow(dayOfWeek: number, hourOfDay: number, overrides: Record<string, unknown> = {}) {
  return { key: { day_of_week: dayOfWeek, hour_of_day: hourOfDay }, ...metrics(overrides) };
}

/**
 * `group_by=agent,day` — the per-agent trend, and the only shape in this file
 * that is BOTH agent-grouped (so the public API layer REBUILDS the row) and cut in a timezone
 * (so `resolved_timezone` is a string rather than a null). The internal handler names it as a
 * first-class screen: "`agent`+`campaign` for contribution,
 * `day_of_week`+`hour_of_day` for best hours, `agent`+`day` for a trend".
 *
 * `day` is a `YYYY-MM-DD` string in the resolved zone — the same format and the
 * same spelling as `bucket_start`, and formatted in SQL for the same reason.
 */
function agentDayRow(agentUserId: string, day: string, overrides: Record<string, unknown> = {}) {
  return { key: { agent_user_id: agentUserId, day }, ...metrics(overrides) };
}

/**
 * `group_by=disposition`. `disposition_code: null` is a REAL key value — an
 * attempt with no disposition submitted is precisely what a supervisor is looking
 * for on this screen — so the null must survive the hop rather than being folded
 * into an "other" bucket or dropped.
 */
function dispositionRow(code: string | null, overrides: Record<string, unknown> = {}) {
  return { key: { disposition_code: code }, ...metrics(overrides) };
}

/**
 * Which grouped dimensions are cut in a TIMEZONE — the internal handler's
 * `GROUP_DIMENSION_NEEDS_ZONE` (`src/agency/agent-record.ts`),
 * mirrored here for the same reason {@link CORE_MIN_RATE_DENOMINATOR} is: the public API layer
 * owns no arithmetic on this payload and must not start. It exists only so the
 * fixtures can be internally consistent.
 */
const GROUPED_DIMENSIONS_NEEDING_A_ZONE = new Set(['day', 'day_of_week', 'hour_of_day']);

/**
 * The zone the buckets were ACTUALLY cut in — `COALESCE(z.name, 'UTC')`,
 * read back out of the same `LEFT JOIN pg_timezone_names` the grouping used.
 *
 * Deliberately NOT `'UTC'`. `UTC` is what that join falls back to when it
 * resolves nothing, so a fixture carrying it cannot tell a value the public API layer carried
 * from one the public API layer manufactured — and a helpful default in this hop is the exact
 * defect the field exists to prevent. `Asia/Kolkata` is also the case the
 * contract argues from: five and a half hours from where a UTC fallback would
 * draw the connect peak, with a quietly wrong rostering decision as the only
 * visible symptom.
 */
const RESOLVED_TIMEZONE = 'Asia/Kolkata';

function groupedBody(
  groupBy: string[],
  rows: Array<Record<string, unknown>>,
  overrides: Record<string, unknown> = {},
) {
  /*
    Both page-level fields below are DERIVED from `group_by`, which is the rule
    `metrics()` follows for the reportability flags: a fixture is a claim about
    what the internal handler emits, and a test may not assert a shape the internal handler cannot produce.

    `resolved_timezone` is a STRING when any grouped dimension is zoned and
    `null` otherwise — and that null is a fact, not a gap: it says nothing on
    this page was cut in a zone. An ABSENT key means something different again (a
    the internal handler that predates the field), on which the surface renders the
    matrix with NO hour-axis label and says so. Three states, and the public API layer has to
    keep them distinguishable.

    `campaign_id` follows from the same fact: a zoned
    dimension is REFUSED (`timezone_ambiguous`) unless exactly one campaign is in
    scope, and that filter is required rather than optional — a pooled
    best-hours read is a 400. So a fixture that grouped by hour with
    `campaign_id: null` is a page the internal handler answers 400 for, and asserting it as a 200
    body would be asserting a shape the internal handler cannot emit.

    The other remedy — grouping BY `campaign`, so each row carries its own
    campaign's zone — IS modelled, and it is the case the derivation below exists
    for. That read is a 200 spanning every campaign in the account, and its rows
    are cut in as many zones as those campaigns have. The field is page-level, so
    on that page there is no single zone to name and the honest value is `null`.

    `null` therefore carries ONE meaning — *this page has no single zone* — and it
    covers two causes that a client must treat identically: nothing zoned was
    grouped, or the read spans campaigns. Both mean "do not label an axis with one
    zone". That is why the condition below is `zoned && NOT campaign-grouped`
    rather than `zoned` alone: deriving from `zoned` by itself would emit a
    confident single zone for a page that genuinely has several, which is the one
    shape this field must never claim.

    An explicit override still wins (`...overrides` is last), so a case that
    wants a shape of its own can say so out loud.
  */
  const zoned = groupBy.some((dimension) => GROUPED_DIMENSIONS_NEEDING_A_ZONE.has(dimension));
  /*
    Which reads the CLIENT makes. D5 offers two remedies and they are not
    interchangeable: grouping by `campaign` keeps the read cross-campaign, while
    filtering narrows it to one. The console's zoned read is best hours, which
    spends both dimensions on time and therefore always filters.
  */
  const base = {
    from: '2026-08-01T00:00:00.000Z',
    to: '2026-08-23T00:00:00.000Z',
    campaign_id: zoned && !groupBy.includes('campaign') ? CAMPAIGN : null,
    group_by: groupBy,
    sort: 'key',
    order: 'asc',
    limit: 200,
    total_groups: 7,
    rows,
    ...overrides,
  };
  /*
    The zone is derived from the MERGED `campaign_id`, after overrides, and it
    mirrors the internal handler's predicate exactly: `campaignId !== undefined && zoned`.

    Not from `!groupBy.includes('campaign')`, which is a proxy that agrees for
    every shape above and DIVERGES on one: `group_by=campaign,hour_of_day` WITH a
    campaign filter is one campaign, therefore one zone, and the internal handler emits a string
    for it. A fixture deriving from the proxy would assert `null` on a page the internal handler
    answers with a zone — a shape the internal handler cannot emit, which is the thing these
    fixtures exist to never do. Reading the merged value also means a case that
    overrides `campaign_id` gets a zone consistent with it for free.
  */
  return {
    ...base,
    resolved_timezone:
      'resolved_timezone' in base
        ? (base as Record<string, unknown>)['resolved_timezone']
        : (base.campaign_id !== null && zoned ? RESOLVED_TIMEZONE : null),
  };
}

/** The standing fixture: one active agent, one departed, grouped by agent. */
function agentGroupedBody(rows = [agentRow(ACTIVE_AGENT), agentRow(DEPARTED_AGENT)]) {
  return groupedBody(['agent'], rows);
}

/**
 * `account_id` is on these rows because the filter reads it: "still on the
 * roster" is answered against the account the read is scoped to, so a fixture
 * without the column would only ever exercise the tenant-level branch. All three
 * are scoped to `ACCOUNT`, the account every request in this file sends.
 */
const MEMBERSHIPS = [
  { id: 'm-1', user_id: ACTIVE_AGENT, status: 'active', role: 'agent', account_id: ACCOUNT },
  { id: 'm-2', user_id: DEPARTED_AGENT, status: 'revoked', role: 'agent', account_id: ACCOUNT },
  { id: 'm-3', user_id: SECOND_AGENT, status: 'active', role: 'agent', account_id: ACCOUNT },
];

const keysOf = (res: { json: () => { rows: Array<{ key: Record<string, unknown> }> } }) =>
  res.json().rows.map((r) => r.key);

beforeEach(() => {
  vi.clearAllMocks();
  // Not a mock, so `clearAllMocks` does not reach it.
  mocks.hooksRan.length = 0;
  mocks.refuseTenantContext = false;
  mocks.proxyToCore.mockResolvedValue({ status: 200, body: agentGroupedBody() });
  mocks.findAnyByUsersAndTenant.mockResolvedValue(MEMBERSHIPS);
  mocks.findAnyByUserAndTenant.mockResolvedValue([{ id: 'm-1', role: 'agent', status: 'active' }]);
  mocks.findDisplayNamesInTenant.mockResolvedValue(new Map([
    [ACTIVE_AGENT, 'Sam Okoro'],
    [DEPARTED_AGENT, 'Ravi Menon'],
    [SECOND_AGENT, 'Nadia Hassan'],
  ]));
});

describe('the floor, pinned against PERMISSION_MATRIX', () => {
  it('is agency.supervise, which is account_admin', () => {
    expect(PERMISSION_MATRIX['agency.supervise']).toBe('account_admin');
    expect(hasPermission('account_admin', 'agency.supervise')).toBe(true);
    expect(hasPermission('tenant_admin', 'agency.supervise')).toBe(true);
    expect(hasPermission('tenant_owner', 'agency.supervise')).toBe(true);
  });

  it('and it is NOT any viewer-floored read that a pivot table resembles', () => {
    // A grouped aggregate reads like "analytics" more than the roster does, and
    // when `agent` is grouped it is a per-person scorecard.
    // `agency.campaigns.read` is checked; `proxy.analytics.read` and `proxy.stats.read` have no
    // agency twin, so they are asserted ABSENT (neither can be picked by mistake).
    for (const permission of ['agency.campaigns.read'] as const) {
      expect(PERMISSION_MATRIX[permission]).toBe('viewer');
      expect(hasPermission('viewer', permission)).toBe(true);
    }
    expect(PERMISSION_MATRIX).not.toHaveProperty('proxy.analytics.read');
    expect(PERMISSION_MATRIX).not.toHaveProperty('proxy.stats.read');
    expect(hasPermission('viewer', 'agency.supervise')).toBe(false);
  });

  it('refuses agent, viewer and operator — and reads nothing on the way', async () => {
    for (const role of ['agent', 'viewer', 'operator'] as MembershipRole[]) {
      const app = await buildApp({ role });

      const res = await app.inject({ method: 'GET', url: `${GROUPED}?group_by=agent` });

      expect(res.statusCode, `${role} must not read the grouped stats`).toBe(403);
      expect(mocks.proxyToCore).not.toHaveBeenCalled();
      expect(mocks.findAnyByUsersAndTenant).not.toHaveBeenCalled();
      await app.close();
    }
  });

  it('admits account_admin and above', async () => {
    for (const role of ['account_admin', 'tenant_admin', 'tenant_owner'] as MembershipRole[]) {
      const app = await buildApp({ role });

      const res = await app.inject({ method: 'GET', url: `${GROUPED}?group_by=agent` });

      expect(res.statusCode, `${role} must reach the grouped stats`).toBe(200);
      await app.close();
    }
  });
});

describe('the account scope is a predicate, not a filter', () => {
  it('refuses a request with no account, before calling the internal handler', async () => {
    /**
     * This is defence in depth rather
     * than the only guard — the internal handler's own `authMiddleware` answers 400 `Missing
     * required header: x-mgkvc-account` before any internal handler handler runs. What
     * the public API layer's check buys is a named code the console can act on, and the fact
     * that no handler call is spent
     * on a request that cannot succeed. The second half is the assertion below.
     */
    const app = await buildApp({ accountId: undefined });

    const res = await app.inject({ method: 'GET', url: `${GROUPED}?group_by=agent` });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'account_scope_required' });
    expect(mocks.proxyToCore).not.toHaveBeenCalled();
    await app.close();
  });

  it('forwards the account it was given to the internal handler', async () => {
    const app = await buildApp();

    await app.inject({ method: 'GET', url: `${GROUPED}?group_by=agent` });

    expect(mocks.proxyToCore).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: TENANT, accountId: ACCOUNT }),
    );
    await app.close();
  });
});

describe('the query whitelist', () => {
  it('forwards the seven documented params and nothing else', async () => {
    const app = await buildApp();

    await app.inject({
      method: 'GET',
      url: `${GROUPED}?from=2026-08-01&to=2026-08-23&campaign_id=${CAMPAIGN}`
        + '&group_by=agent,campaign&sort=successes&order=desc&limit=50',
    });

    expect(mocks.proxyToCore.mock.calls[0]![0].query).toEqual({
      from: '2026-08-01',
      to: '2026-08-23',
      campaign_id: CAMPAIGN,
      group_by: 'agent,campaign',
      sort: 'successes',
      order: 'desc',
      limit: '50',
    });
    await app.close();
  });

  it('refuses an unknown param with a 400, and makes NO the internal handler call', async () => {
    // `bucket` is the realistic mistake: it is a legitimate param on the
    // per-agent stats routes next door, and this route groups rather than buckets.
    const app = await buildApp();

    const res = await app.inject({
      method: 'GET',
      url: `${GROUPED}?group_by=agent&bucket=day&tz=Asia/Kolkata`,
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'unknown_query_params' });
    // `tz` is on this list deliberately: D5 rules that there is NO `tz` parameter
    // in 02a — a time dimension is refused by the internal handler unless the zone is unambiguous
    // — so a client reaching for one must be told it does not exist rather than
    // have it silently dropped and get UTC buckets for an Asia/Kolkata campaign.
    expect(res.json().details.unknown).toEqual(['bucket', 'tz']);
    expect(mocks.proxyToCore).not.toHaveBeenCalled();
    await app.close();
  });

  it('refuses agent_user_id — the tenancy boundary is the public API layer\'s memberships', async () => {
    /**
     * Not accepted on either service. The internal handler has no user table, so `agent_user_id`
     * is an opaque string it cannot tenancy-check, and the public API layer's `memberships` is
     * the only place that boundary can exist — which makes a caller-supplied
     * filter on it a tenancy decision taken from the query string. Filtering to
     * one person is the per-agent record's job, where the id is proved against
     * this tenant first. Refused rather than dropped, because a dropped filter
     * answers 200 with everybody and is presented as the one person asked about.
     */
    const app = await buildApp();

    const res = await app.inject({
      method: 'GET',
      url: `${GROUPED}?group_by=agent&agent_user_id=${ACTIVE_AGENT}`,
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().details.unknown).toEqual(['agent_user_id']);
    expect(mocks.proxyToCore).not.toHaveBeenCalled();
    await app.close();
  });

  it('consumes include_inactive and does NOT forward it', async () => {
    const app = await buildApp();

    await app.inject({ method: 'GET', url: `${GROUPED}?group_by=agent&include_inactive=true` });

    expect(mocks.proxyToCore.mock.calls[0]![0].query).toEqual({ group_by: 'agent' });
    expect(mocks.proxyToCore.mock.calls[0]![0].query).not.toHaveProperty('include_inactive');
    await app.close();
  });

  it('forwards group_by UNPARSED, and has no opinion about its vocabulary', async () => {
    /**
     * The vocabulary, the 1-or-2-dimension cap, the canonicalisation of the order
     * and the timezone rule are the internal handler's, because the internal handler is where the rows are
     * grouped. A second parser in the public API layer would be a second definition of the same
     * enum and the copy that drifts is the one no query exercises. So the public API layer must
     * pass even obvious nonsense through — the refusal has to come from the
     * service that did the grouping.
     */
    const app = await buildApp();

    for (const value of ['agent', 'campaign,agent', 'agent,campaign,day', 'vibes', '']) {
      mocks.proxyToCore.mockClear();
      await app.inject({
        method: 'GET',
        url: `${GROUPED}?group_by=${encodeURIComponent(value)}`,
      });

      // A blank value is dropped by `forwardAllowedQuery` (it is what a cleared
      // form field posts), and `group_by`'s required-ness is the internal handler's to enforce —
      // so the call is still made and the internal handler answers.
      const forwarded = mocks.proxyToCore.mock.calls[0]![0].query;
      expect(forwarded['group_by']).toBe(value === '' ? undefined : value);
    }
    await app.close();
  });

  it('forwards the internal handler\'s own refusal byte-identically, details included', async () => {
    /**
     * The internal handler's REAL wire shape: the body is
     * `{ error: 'Validation failed', code, details: [issues] }` — `details` is the
     * ARRAY of `{ param, code?, message }` issues
     * (`src/api/routes/agency-agents.routes.ts` lifts the first
     * coded issue into `code` and keeps the whole list), not a `{ field: [msg] }`
     * map, and the `message` lives on the issue rather than at the top level.
     *
     * A fixture that asserts a shape the internal handler cannot emit proves nothing about the
     * hop, and this one is the shape the console actually parses.
     */
    const coreBody = {
      error: 'Validation failed',
      code: 'timezone_ambiguous',
      details: [{
        param: 'group_by',
        code: 'timezone_ambiguous',
        message: 'a time dimension (day, day_of_week, hour_of_day) is cut in the campaign\'s own '
          + 'timezone, so it is only unambiguous when campaigns are separated: either add '
          + '`campaign` to `group_by`, or filter to exactly one `campaign_id`',
      }],
    };
    mocks.proxyToCore.mockResolvedValue({ status: 400, body: coreBody });
    const app = await buildApp();

    const res = await app.inject({ method: 'GET', url: `${GROUPED}?group_by=hour_of_day` });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual(coreBody);
    // No `inactive_omitted` grafted onto a non-2xx body, and no database read
    // spent on a request that failed.
    expect(res.json().inactive_omitted).toBeUndefined();
    expect(res.json().unattributed_omitted).toBeUndefined();
    expect(mocks.findAnyByUsersAndTenant).not.toHaveBeenCalled();
    expect(mocks.findDisplayNamesInTenant).not.toHaveBeenCalled();
    await app.close();
  });

    describe('and those refusals reach the client, which is a separate claim', () => {
    /**
     * The case above covers the refusal body. These cases assert the other half:
     * the client receives the internal handler's code, message and details intact.
     * (This app builds no error-mask hook here, so what is asserted is the route's own
     * half of the claim.)
     *
     * ── What forwards these ───────────────────────────────────────────────────
     * In production `isStructuredClientError` forwards a body with a non-null `details`,
     * and the internal handler attaches `details` to every grouped refusal — so these
     * survive on shape. The allow-list entry makes forwarding depend on the CODE instead,
     * which is the pattern `malformed_cursor` and `profile_in_use_by_agency_campaign`
     * are already on for the same reason: the rescue is a field the internal handler
     * owns and could trim, the console keys its 400 handling off `code`, and a masked
     * refusal is invisible — the status stays right and only the explanation is destroyed.
     */
    const REFUSALS: ReadonlyArray<readonly [string, string]> = [
      ['timezone_ambiguous', 'group_by'],
      ['too_many_dimensions', 'group_by'],
    ];

    it.each(REFUSALS)('%s survives with the internal handler\'s details attached', async (code, param) => {
      await coreRefuses(400, {
        error: 'Validation failed',
        code,
        details: [{ param, code, message: 'the remedy, in the handler\'s own words' }],
      });
      const app = await buildApp();

      const res = await app.inject({ method: 'GET', url: `${GROUPED}?group_by=hour_of_day` });

      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe(code);
      expect(res.json().message ?? '').not.toContain('contact');
      await app.close();
    });

    it.each(REFUSALS)('%s survives even with `details` TRIMMED', async (code) => {
      /**
       * The case the allow-list entry is FOR, and the only one that can see it.
       * Strip `details` and the shape rule no longer applies, so forwarding rests
       * entirely on `FORWARDABLE_ERROR_CODES` — remove the entry and this reds
       * while the case above stays green, which is exactly why both exist.
       */
      await coreRefuses(400, {
        error: 'Validation failed',
        code,
        message: 'the remedy, in the handler\'s own words',
      });
      const app = await buildApp();

      const res = await app.inject({ method: 'GET', url: `${GROUPED}?group_by=hour_of_day` });

      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe(code);
      expect(res.json().message).toBe('the remedy, in the handler\'s own words');
      await app.close();
    });

    it('the 92-day window refusal forwards on `details` ALONE, having no code', async () => {
      /**
       * The third refusal the review grouped with the two above, and it is NOT the
       * same case: the internal handler's window cap pushes a plain
       * `{ param: 'from', message: 'the window must be at most 92 days …' }` issue
       * with **no `code` member at all**
       * (`src/agency/agent-record.ts`, in both
       * `parseRosterQuery` and `parseGroupedStatsQuery`), so the body the internal handler sends
       * carries `details` and no `code`. There is therefore nothing to allow-list,
       * and inventing a public-API-layer code for it would be a second vocabulary for
       * the internal handler's own refusal.
       *
       * What survives it is the structured-error rule, asserted here so the
       * asymmetry is recorded rather than rediscovered.
       */
      await coreRefuses(400, {
        error: 'Validation failed',
        details: [{
          param: 'from',
          message: 'the window must be at most 92 days — request a narrower range',
        }],
      });
      const app = await buildApp();

      const res = await app.inject({
        method: 'GET',
        url: `${GROUPED}?group_by=agent&from=2025-01-01&to=2026-01-01`,
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().details[0].message).toContain('92 days');
      expect(res.json().code).toBeUndefined();
      await app.close();
    });
  });

  /**
   * R2's wire encoding, pinned VALUE BY VALUE and by what each value MEANT.
   *
   * A 200 says only that the value parsed, not which way it was read, and the
   * dangerous failure is a `1` read as `false`: the request answers 200 with the
   * departed agents hidden, which is the opposite of what was asked, and
   * `inactive_omitted` then reports the omission as though it had been requested.
   * So each accepted value carries the truth table it must produce against the
   * standing agent-grouped fixture (one active, one departed).
   *
   * The same table as the roster's, deliberately: one param, one parser
   * (`parseIncludeInactive`), and two reads that disagreed about what
   * `?include_inactive=1` means would be a defect visible only by comparing two
   * screens.
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
      url: `${GROUPED}?group_by=agent&include_inactive=${encodeURIComponent(value)}`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().rows).toHaveLength(expected ? 2 : 1);
    expect(res.json().inactive_omitted).toBe(expected ? 0 : 1);
    expect(mocks.proxyToCore.mock.calls[0]![0].query).not.toHaveProperty('include_inactive');
    await app.close();
  });

  it.each(['maybe', 'yes', 'no', 'on', 'off', '2', '-1', 'null'])(
    'refuses include_inactive=%j rather than coercing it',
    async (value) => {
      const app = await buildApp();

      const res = await app.inject({
        method: 'GET',
        url: `${GROUPED}?group_by=agent&include_inactive=${encodeURIComponent(value)}`,
      });

      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ code: 'invalid_include_inactive' });
      // Field-level feedback for the client. What keeps the refusal READABLE is
      // that it is raised before any internal handler call has recorded a status, so
      // `errorMaskHook` leaves a route's own 400 alone.
      expect(res.json().details).toHaveProperty('include_inactive');
      expect(mocks.proxyToCore).not.toHaveBeenCalled();
      await app.close();
    },
  );

  it('refuses a REPEATED include_inactive rather than picking one', async () => {
    // Fastify hands a repeated key over as an ARRAY, so this refusal does not
    // come from the string vocabulary at all — a parser that stringified the
    // array, or took `[0]`, or took the last one, would answer 200 to two
    // contradictory instructions.
    const app = await buildApp();

    const res = await app.inject({
      method: 'GET',
      url: `${GROUPED}?group_by=agent&include_inactive=true&include_inactive=false`,
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'invalid_include_inactive' });
    expect(mocks.proxyToCore).not.toHaveBeenCalled();
    await app.close();
  });

  it('treats an absent and a VALUELESS include_inactive as false', async () => {
    for (const url of [`${GROUPED}?group_by=agent`, `${GROUPED}?group_by=agent&include_inactive`]) {
      const app = await buildApp();

      const res = await app.inject({ method: 'GET', url });

      expect(res.statusCode).toBe(200);
      expect(res.json().inactive_omitted).toBe(1);
      await app.close();
    }
  });
});

describe('when `agent` IS grouped, the public API layer filters and names the rows', () => {
  it('drops revoked members by default and counts them', async () => {
    const app = await buildApp();

    const res = await app.inject({ method: 'GET', url: `${GROUPED}?group_by=agent` });

    expect(keysOf(res)).toEqual([{ agent_user_id: ACTIVE_AGENT }]);
    expect(res.json().inactive_omitted).toBe(1);
    await app.close();
  });

  it('keeps them under include_inactive=true, with the counter at 0', async () => {
    const app = await buildApp();

    const res = await app.inject({
      method: 'GET',
      url: `${GROUPED}?group_by=agent&include_inactive=true`,
    });

    expect(keysOf(res)).toEqual([
      { agent_user_id: ACTIVE_AGENT },
      { agent_user_id: DEPARTED_AGENT },
    ]);
    expect(res.json().inactive_omitted).toBe(0);
    await app.close();
  });

  it('never shows a user who was never in this tenant, under EITHER flag', async () => {
    // The third state. `include_inactive` means "show me the people who left",
    // not "show me ids you cannot account for", and the count is deliberately NOT
    // folded into `inactive_omitted` — reporting a stranger as a departed
    // colleague is a different lie from hiding one.
    mocks.proxyToCore.mockResolvedValue({
      status: 200,
      body: agentGroupedBody([
        agentRow(ACTIVE_AGENT), agentRow(DEPARTED_AGENT), agentRow(STRANGER),
      ]),
    });

    for (const suffix of ['', '&include_inactive=true']) {
      const app = await buildApp();

      const res = await app.inject({ method: 'GET', url: `${GROUPED}?group_by=agent${suffix}` });

      expect(keysOf(res)).not.toContainEqual({ agent_user_id: STRANGER });
      expect(res.json().inactive_omitted).toBe(suffix ? 0 : 1);
      await app.close();
    }
  });

  it('reads the whole page in ONE membership query, keyed on this tenant', async () => {
    // Not one lookup per row: the page is up to 1000 rows and each one would be a
    // round trip. The tenant argument is asserted too — it is the boundary that
    // makes "never in this tenant" mean anything.
    mocks.proxyToCore.mockResolvedValue({
      status: 200,
      body: agentGroupedBody([
        agentRow(ACTIVE_AGENT), agentRow(DEPARTED_AGENT), agentRow(STRANGER),
      ]),
    });
    const app = await buildApp();

    await app.inject({ method: 'GET', url: `${GROUPED}?group_by=agent` });

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

  it('still makes ONE query when an agent repeats across grouped campaigns', async () => {
    /**
     * `agent,campaign` — the contribution view — emits one row per (agent,
     * campaign) pair, so the same agent id appears several times on one page.
     * That is unlike the roster, where one row per agent makes duplicates
     * impossible. The ids are passed one per ROW rather than de-duplicated at the
     * call site because `findAnyByUsersAndTenant` already de-duplicates its
     * input; this pins that the cost is still one query, and that the repeated id
     * does not double-count anything.
     */
    const other = '77777777-7777-4777-8777-777777777777';
    mocks.proxyToCore.mockResolvedValue({
      status: 200,
      body: groupedBody(['agent', 'campaign'], [
        agentCampaignRow(ACTIVE_AGENT, CAMPAIGN),
        agentCampaignRow(ACTIVE_AGENT, other),
        agentCampaignRow(DEPARTED_AGENT, CAMPAIGN),
        agentCampaignRow(DEPARTED_AGENT, other),
      ]),
    });
    const app = await buildApp();

    const res = await app.inject({ method: 'GET', url: `${GROUPED}?group_by=agent,campaign` });

    expect(mocks.findAnyByUsersAndTenant).toHaveBeenCalledTimes(1);
    expect(mocks.findAnyByUsersAndTenant).toHaveBeenCalledWith(
      [ACTIVE_AGENT, ACTIVE_AGENT, DEPARTED_AGENT, DEPARTED_AGENT],
      TENANT,
    );
    // BOTH of the departed agent's rows are dropped and BOTH are counted: the
    // counter is a row count, not a person count, because it is what the console
    // compares against `rows.length`.
    expect(res.json().rows).toHaveLength(2);
    expect(res.json().inactive_omitted).toBe(2);
    await app.close();
  });

  it('adds agent_name to every row in ONE query for the page', async () => {
    const app = await buildApp();

    const res = await app.inject({
      method: 'GET',
      url: `${GROUPED}?group_by=agent&include_inactive=true`,
    });

    expect(res.json().rows.map((r: { agent_name: string }) => r.agent_name))
      .toEqual(['Sam Okoro', 'Ravi Menon']);
    expect(mocks.findDisplayNamesInTenant).toHaveBeenCalledTimes(1);
    expect(mocks.findDisplayNamesInTenant).toHaveBeenCalledWith(
      [ACTIVE_AGENT, DEPARTED_AGENT],
      TENANT,
    );
    await app.close();
  });

  it('puts agent_name on the ROW, not inside the grouping key', async () => {
    // `key` is the grouping identity the internal handler computed; a name the public API layer looked up is
    // not part of it. Writing it into `key` would also change what a client uses
    // as a row identity, which is the one thing on this payload that has to be
    // stable across reads.
    const app = await buildApp();

    const res = await app.inject({ method: 'GET', url: `${GROUPED}?group_by=agent` });

    expect(res.json().rows[0]).toEqual({
      ...agentRow(ACTIVE_AGENT),
      agent_name: 'Sam Okoro',
    });
    expect(res.json().rows[0].key).toEqual({ agent_user_id: ACTIVE_AGENT });
    await app.close();
  });

  it('does not spend a name lookup on a row it dropped', async () => {
    const app = await buildApp();

    await app.inject({ method: 'GET', url: `${GROUPED}?group_by=agent` });

    expect(mocks.findDisplayNamesInTenant).toHaveBeenCalledWith([ACTIVE_AGENT], TENANT);
    await app.close();
  });

  it('degrades to agent_name: null rather than 500ing', async () => {
    mocks.findDisplayNamesInTenant.mockRejectedValue(new Error('db down'));
    const app = await buildApp();

    const res = await app.inject({
      method: 'GET',
      url: `${GROUPED}?group_by=agent&include_inactive=true`,
    });

    expect(res.statusCode).toBe(200);
    // The KEY is still produced on every row — an absent key is indistinguishable
    // from one a client forgot to read, while a null is an answer.
    expect(res.json().rows.map((r: { agent_name: string | null }) => r.agent_name))
      .toEqual([null, null]);
    // And the numbers, which are the answer, are untouched.
    expect(res.json().rows[0].attempts).toBe(120);
    expect(res.json().inactive_omitted).toBe(0);
    await app.close();
  });

  it('degrades even when the lookup rejects with a NON-Error', async () => {
    // `pg` and `ioredis` both reject with plain objects on some paths, and a
    // `String(err)` narrowing that was never exercised is a throw inside the
    // catch — which turns the documented degrade into a masked 500.
    mocks.findDisplayNamesInTenant.mockRejectedValue('connection terminated unexpectedly');
    const app = await buildApp();

    const res = await app.inject({ method: 'GET', url: `${GROUPED}?group_by=agent` });

    expect(res.statusCode).toBe(200);
    expect(res.json().rows[0].agent_name).toBeNull();
    await app.close();
  });

  it('yields null for a row the tenant cannot name, beside the id', async () => {
    mocks.findDisplayNamesInTenant.mockResolvedValue(new Map([[ACTIVE_AGENT, 'Sam Okoro']]));
    const app = await buildApp();

    const res = await app.inject({
      method: 'GET',
      url: `${GROUPED}?group_by=agent&include_inactive=true`,
    });

    expect(res.json().rows).toEqual([
      { ...agentRow(ACTIVE_AGENT), agent_name: 'Sam Okoro' },
      { ...agentRow(DEPARTED_AGENT), agent_name: null },
    ]);
    await app.close();
  });

  it('does NOT recompute total_groups, group_by or anything else the internal handler sent', async () => {
    /**
     * R1 still binds: `total_groups` is the internal handler's pre-`limit`, post-scope count of
     * groups, `rows.length` is what survived, and `inactive_omitted` is what
     * the public API layer hid. Three independent facts, and no "showing X of Y" fraction is
     * derivable from them — a default read legitimately returns 1 row,
     * `total_groups: 7` and `inactive_omitted: 1`.
     *
     * Asserted as a whole-body equality so a SPREAD is distinguished from a
     * reconstruction: `from`/`to`, `campaign_id`, the echoed canonical `group_by`,
     * `sort`/`order`/`limit` and every metric have to arrive exactly as the internal handler
     * wrote them, including fields the internal handler adds after this was written.
     */
    const app = await buildApp();

    const res = await app.inject({ method: 'GET', url: `${GROUPED}?group_by=campaign,agent` });

    expect(res.json()).toEqual({
      ...agentGroupedBody(),
      rows: [{ ...agentRow(ACTIVE_AGENT), agent_name: 'Sam Okoro' }],
      inactive_omitted: 1,
      unattributed_omitted: 0,
    });
    expect(res.json().total_groups).toBe(7);
    // The echo is the internal handler's canonical order, not the order the request used.
    expect(res.json().group_by).toEqual(['agent']);
    await app.close();
  });

  it('carries the nullable metrics through as nulls, never as zeros', async () => {
    /**
     * House rule: `0` means measured-and-zero, `null` means no denominator. A
     * read that broke it is how a supervisor comes to see "0% conversion" against
     * an agent who connected nothing. The public API layer must not touch them — and the
     * reachable shape is `connected: 0` with `attempts >= 1`, since `COUNT(*)`
     * over an inner-joined `GROUP BY` filtered on `dialed_at IS NOT NULL` cannot
     * emit a zero-attempt group.
     */
    mocks.proxyToCore.mockResolvedValue({
      status: 200,
      body: agentGroupedBody([agentRow(ACTIVE_AGENT, {
        attempts: 1,
        connected: 0,
        successes: 0,
        talk_seconds: 0,
        wrapup_seconds: 0,
        connect_rate_pct: 0,
        success_rate_pct: null,
        aht_seconds: null,
        // One attempt is far under the 20-dial floor, so the flag the internal handler computed
        // is `false` here — the override keeps the fixture internally consistent
        // and gives the assertions below a row on which the field is NOT the
        // default.
        rates_reportable: false,
      })]),
    });
    const app = await buildApp();

    const res = await app.inject({ method: 'GET', url: `${GROUPED}?group_by=agent` });

    const row = res.json().rows[0];
    // Measured-and-zero stays 0; no denominator stays null. Both directions,
    // because a coercion in either one is the same class of lie.
    expect(row.connect_rate_pct).toBe(0);
    expect(row.success_rate_pct).toBeNull();
    expect(row.aht_seconds).toBeNull();
    expect(row.attempts).toBe(1);
    // And the flag that says how those rates must READ survives beside them. A
    // `null` rate is withheld by arithmetic; a `0` over one attempt is withheld
    // only by this boolean.
    expect(row.rates_reportable).toBe(false);
    await app.close();
  });

  it('carries BOTH reportability flags through untouched, on BOTH branches', async () => {
    /**
     * The field this phase is about, and the one no the public API layer test would have caught
     * going missing: it appears nowhere in the public API layer's `src/` for this route, because
     * the public API layer computes nothing on this payload and the flag rides the row spread.
     *
     * Both branches, because they are different code over the row. The
     * agent-grouped one REBUILDS each row to attach `agent_name`
     * (`{ ...row, agent_name }` in `enrichGroupedRowAgentNames`), which is the
     * only place on this route where a key can be lost; the pass-through one
     * hands the internal handler's body over whole. A regression in either prints a rate as a
     * number where the house rule says WORDS — and `AGENCY_ROSTER_MIN_RATE_DENOMINATOR`
     * exists in the console to EXPLAIN this flag, never to recompute it, so
     * there is no client-side fallback to catch it.
     *
     * Both values, in both branches: an assertion on `true` alone passes against
     * a route that hard-coded it.
     *
     * ── And both FLAGS, because they can disagree ─────────────────────────
     * `rates_reportable` gates on dials, `success_rate_reportable` on connects,
     * so a row with plenty of dials and few connects carries `true` beside
     * `false`. That row is the reason the second field exists — it is the one
     * whose conversion rate was printing as a number off a handful of connects —
     * and it is the only shape that can tell a route carrying two flags apart
     * from one collapsing them into either single answer. A rebuild that emitted
     * `success_rate_reportable: row.rates_reportable` passes every assertion an
     * agreeing row can make.
     */
    const app = await buildApp();

    mocks.proxyToCore.mockResolvedValue({
      status: 200,
      body: agentGroupedBody([
        agentRow(ACTIVE_AGENT),
        agentRow(DEPARTED_AGENT, { attempts: 3, rates_reportable: false }),
        // Dials over the floor, connects under it: the two flags DISAGREE, which
        // is the shape that catches a route collapsing them into one.
        agentRow(SECOND_AGENT, { connected: 4, successes: 2 }),
      ]),
    });
    const grouped = await app.inject({
      method: 'GET',
      url: `${GROUPED}?group_by=agent&include_inactive=true`,
    });

    const groupedRows = grouped.json().rows as {
      rates_reportable: boolean;
      success_rate_reportable: boolean;
    }[];
    expect(groupedRows.map((r) => r.rates_reportable)).toEqual([true, false, true]);
    expect(groupedRows.map((r) => r.success_rate_reportable)).toEqual([true, false, false]);

    mocks.proxyToCore.mockResolvedValue({
      status: 200,
      body: groupedBody(['day_of_week', 'hour_of_day'], [
        hourRow(0, 18),
        // A best-hours cell with three dials is exactly the case the flag exists
        // for: 33% off three attempts must not render as a number.
        hourRow(3, 9, { attempts: 3, rates_reportable: false }),
        // The same disagreeing shape on the branch that never touches a row: an
        // hour with 120 dials and 4 connects.
        hourRow(4, 11, { connected: 4, successes: 2 }),
      ]),
    });
    const passThrough = await app.inject({
      method: 'GET',
      url: `${GROUPED}?group_by=day_of_week,hour_of_day&campaign_id=${CAMPAIGN}`,
    });

    const passThroughRows = passThrough.json().rows as {
      rates_reportable: boolean;
      success_rate_reportable: boolean;
    }[];
    expect(passThroughRows.map((r) => r.rates_reportable)).toEqual([true, false, true]);
    expect(passThroughRows.map((r) => r.success_rate_reportable)).toEqual([true, false, false]);
    await app.close();
  });
});

describe('unattributed_omitted: the rows the public API layer cannot account for', () => {
  /**
   * The counter for the third state: an id with no membership at all.
   *
   * A row whose agent id has no membership row of ANY status is dropped under
   * either flag, and must never be folded into `inactive_omitted` — reporting a
   * stranger as a departed colleague is a different lie from hiding one. But
   * until this field existed the row was dropped with NOTHING on the wire
   * accounting for it, so the contribution screen's one quantitative claim (the
   * visible rows fall short of the campaign total by exactly the departed
   * agents' work) was false and no client could tell.
   *
   * ⚠️ Reachable, despite the handler's first comment calling it unreachable.
   * The internal handler scoping every statement on `tenant_id` AND `account_id` rules out a
   * FOREIGN agent, not a FORMER one: the internal handler keeps attempt history forever while a
   * `memberships` row goes away with the user. And on THIS read one such id is
   * not one row — an `agent,campaign` page repeats each agent once per campaign.
   *
   * These cases are what a merge of the two counters has to red on. Folding
   * `unknownOmitted` into `inactiveOmitted` leaves the departed-only case
   * passing, which is why the stranger cases are stated separately from it and
   * both numbers are asserted in each.
   */
  it('is 0 when the only omission is a departure', async () => {
    // The standing fixture: one active, one departed, no stranger. The counters
    // are separate facts about separate rows, so nothing may leak sideways.
    const app = await buildApp();

    const res = await app.inject({ method: 'GET', url: `${GROUPED}?group_by=agent` });

    expect(res.json().inactive_omitted).toBe(1);
    expect(res.json().unattributed_omitted).toBe(0);
    await app.close();
  });

  it('counts a stranger WITHOUT calling them a departure', async () => {
    // The mirror image, and the case a merge of the two counters cannot pass:
    // one row dropped, and `inactive_omitted` must stay 0 because nobody left.
    mocks.proxyToCore.mockResolvedValue({
      status: 200,
      body: agentGroupedBody([agentRow(ACTIVE_AGENT), agentRow(STRANGER)]),
    });
    const app = await buildApp();

    const res = await app.inject({ method: 'GET', url: `${GROUPED}?group_by=agent` });

    expect(keysOf(res)).toEqual([{ agent_user_id: ACTIVE_AGENT }]);
    expect(res.json().inactive_omitted).toBe(0);
    expect(res.json().unattributed_omitted).toBe(1);
    await app.close();
  });

  it('counts the two independently when both are on one page', async () => {
    // Three facts, three numbers: one row served, one departure, one id
    // the public API layer cannot account for. A merge would answer 2 and 0 here — the same
    // total, and a different and false statement about what happened.
    mocks.proxyToCore.mockResolvedValue({
      status: 200,
      body: agentGroupedBody([
        agentRow(ACTIVE_AGENT), agentRow(DEPARTED_AGENT), agentRow(STRANGER),
      ]),
    });
    const app = await buildApp();

    const res = await app.inject({ method: 'GET', url: `${GROUPED}?group_by=agent` });

    expect(res.json().rows).toHaveLength(1);
    expect(res.json().inactive_omitted).toBe(1);
    expect(res.json().unattributed_omitted).toBe(1);
    await app.close();
  });

  it('is unmoved by include_inactive, which is not what it means', async () => {
    // `include_inactive` means "show me the people who left", not "show me ids
    // you cannot account for". So the stranger's row stays dropped and its
    // counter stays 1 while `inactive_omitted` falls to 0 — which is also the
    // assertion that separates the two numbers behaviourally rather than by
    // reading the filter.
    mocks.proxyToCore.mockResolvedValue({
      status: 200,
      body: agentGroupedBody([
        agentRow(ACTIVE_AGENT), agentRow(DEPARTED_AGENT), agentRow(STRANGER),
      ]),
    });
    const app = await buildApp();

    const res = await app.inject({
      method: 'GET',
      url: `${GROUPED}?group_by=agent&include_inactive=true`,
    });

    expect(keysOf(res)).not.toContainEqual({ agent_user_id: STRANGER });
    expect(res.json().inactive_omitted).toBe(0);
    expect(res.json().unattributed_omitted).toBe(1);
    await app.close();
  });

  it('counts ONE unaccountable agent once per ROW on an agent,campaign page', async () => {
    /**
     * The mechanism that makes this read worse than the roster, stated as
     * arithmetic. `agent,campaign` emits one row per pair, so a single id the public API layer
     * cannot account for takes N rows off the page — and the console's gap
     * sentence is wrong by all of them, not by one.
     *
     * `total_groups` is the internal handler's pre-`limit` count and does not move, so the three
     * facts here are 4 groups, 2 rows served, and 2 + 0 omitted. Counting people
     * rather than rows would report 1 and leave the arithmetic short by one row,
     * the same reason `inactive_omitted` counts rows.
     */
    const other = '77777777-7777-4777-8777-777777777777';
    mocks.proxyToCore.mockResolvedValue({
      status: 200,
      body: groupedBody(['agent', 'campaign'], [
        agentCampaignRow(ACTIVE_AGENT, CAMPAIGN),
        agentCampaignRow(ACTIVE_AGENT, other),
        agentCampaignRow(STRANGER, CAMPAIGN),
        agentCampaignRow(STRANGER, other),
      ], { total_groups: 4 }),
    });
    const app = await buildApp();

    const res = await app.inject({ method: 'GET', url: `${GROUPED}?group_by=agent,campaign` });

    expect(res.json().rows).toHaveLength(2);
    expect(res.json().unattributed_omitted).toBe(2);
    expect(res.json().inactive_omitted).toBe(0);
    expect(res.json().total_groups).toBe(4);
    await app.close();
  });
});

describe('when `agent` is NOT grouped, the rows pass through untouched', () => {
  /**
   * There is nothing to filter: a row that is not about a person cannot have a
   * person filtered out of it. So `inactive_omitted` is 0 as a TRUE statement,
   * and no membership read and no name lookup happen at all — which is both the
   * correct behaviour and the cheapest.
   */
  const NON_AGENT_PAGES: ReadonlyArray<readonly [string, string[], Array<Record<string, unknown>>]> = [
    ['campaign', ['campaign'], [campaignRow(CAMPAIGN)]],
    ['disposition', ['disposition'], [dispositionRow('sale'), dispositionRow(null)]],
    ['day_of_week,hour_of_day', ['day_of_week', 'hour_of_day'], [hourRow(0, 18), hourRow(3, 9)]],
  ];

  /**
   * The request has to match the fixture's own scope, or the case asserts a 200
   * over a body the internal handler would have answered 400 for: a zoned grouping needs exactly
   * one campaign in scope (D5, E2), and `groupedBody` derives `campaign_id` from
   * `group_by` for that reason. `day_of_week,hour_of_day` is the entry this
   * applies to.
   */
  const urlFor = (groupBy: string, body: { campaign_id: string | null }) =>
    `${GROUPED}?group_by=${groupBy}`
      + (body.campaign_id === null ? '' : `&campaign_id=${body.campaign_id}`);

  it.each(NON_AGENT_PAGES)('%s: serves every row, and reads no membership', async (
    groupBy, echoed, rows,
  ) => {
    const body = groupedBody(echoed, rows);
    mocks.proxyToCore.mockResolvedValue({ status: 200, body });
    const app = await buildApp();

    const res = await app.inject({ method: 'GET', url: urlFor(groupBy, body) });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      ...body,
      inactive_omitted: 0,
      unattributed_omitted: 0,
    });
    expect(res.json().inactive_omitted).toBe(0);
    // Both counters, and both true: no person was filtered out of an aggregate
    // that is not about a person, and no membership was read to fail to account
    // for one.
    expect(res.json().unattributed_omitted).toBe(0);
    expect(mocks.findAnyByUsersAndTenant).not.toHaveBeenCalled();
    expect(mocks.findDisplayNamesInTenant).not.toHaveBeenCalled();
    await app.close();
  });

  it.each(NON_AGENT_PAGES)('%s: adds NO agent_name key', async (groupBy, echoed, rows) => {
    // D9: `agent_name` is present iff `agent` is grouped. A `null` on a
    // campaign-grouped row would be a claim that the row is about a person the public API layer
    // could not identify, which is a different and false statement.
    const body = groupedBody(echoed, rows);
    mocks.proxyToCore.mockResolvedValue({ status: 200, body });
    const app = await buildApp();

    const res = await app.inject({ method: 'GET', url: urlFor(groupBy, body) });

    for (const row of res.json().rows) expect(row).not.toHaveProperty('agent_name');
    await app.close();
  });

  it('keeps disposition_code: null as a REAL key value', async () => {
    // An attempt with no disposition submitted is precisely the number a
    // supervisor is looking for on this screen. Folding it into an "other" bucket
    // or dropping it hides un-dispositioned work, so the null has to survive the
    // hop — which it only does because the public API layer spreads the row.
    mocks.proxyToCore.mockResolvedValue({
      status: 200,
      body: groupedBody(['disposition'], [dispositionRow('sale'), dispositionRow(null)]),
    });
    const app = await buildApp();

    const res = await app.inject({ method: 'GET', url: `${GROUPED}?group_by=disposition` });

    expect(keysOf(res)).toEqual([{ disposition_code: 'sale' }, { disposition_code: null }]);
    await app.close();
  });

  it('include_inactive is accepted but changes nothing on such a page', async () => {
    // Meaningful only when `agent` is grouped. It is still ACCEPTED rather than
    // refused — the console's checkbox does not know what the current grouping is
    // — and the two responses are compared to each other so a filter that
    // accidentally applied here would red however it counted.
    mocks.proxyToCore.mockResolvedValue({
      status: 200,
      body: groupedBody(['campaign'], [campaignRow(CAMPAIGN)]),
    });
    const app = await buildApp();

    const off = await app.inject({ method: 'GET', url: `${GROUPED}?group_by=campaign` });
    const on = await app.inject({
      method: 'GET',
      url: `${GROUPED}?group_by=campaign&include_inactive=true`,
    });

    expect(off.json()).toEqual(on.json());
    expect(off.json().inactive_omitted).toBe(0);
    expect(mocks.findAnyByUsersAndTenant).not.toHaveBeenCalled();
    await app.close();
  });

  it('an EMPTY page is not agent-grouped, and still carries the counter', async () => {
    /**
     * `group_by=agent` over a window in which nobody dialled. The public API layer reads
     * "was `agent` grouped" off the rows, so an empty page takes the pass-through
     * branch — which is the right answer rather than a gap: there is no row to
     * filter, no name to look up and nothing omitted, so both branches agree on
     * the payload and this one spends no database read reaching it.
     */
    mocks.proxyToCore.mockResolvedValue({
      status: 200,
      body: groupedBody(['agent'], [], { total_groups: 0 }),
    });
    const app = await buildApp();

    const res = await app.inject({ method: 'GET', url: `${GROUPED}?group_by=agent` });

    expect(res.statusCode).toBe(200);
    expect(res.json().rows).toEqual([]);
    expect(res.json().inactive_omitted).toBe(0);
    expect(res.json().unattributed_omitted).toBe(0);
    expect(mocks.findAnyByUsersAndTenant).not.toHaveBeenCalled();
    await app.close();
  });
});

describe('resolved_timezone: the additive page-level field, carried untouched', () => {
  /**
   * The zone the buckets were ACTUALLY cut in — `COALESCE(z.name, 'UTC')` read
   * back out of the internal handler's `LEFT JOIN pg_timezone_names`, so it can DIFFER from
   * `agency_campaigns.default_timezone`, and it differs precisely when the stored
   * value is garbage. That is why a client may not derive it from the campaign
   * record: doing so would print `Asia/Calcutta_typo` over columns that are in
   * fact UTC, on exactly the campaign whose zone is broken.
   *
   * ── the public API layer's job here is nothing, and nothing is the hard part ─────────────
   * The public API layer owns no arithmetic on this payload; it spreads the body. So there is
   * no code to get right and only a shape to not lose, which puts the entire risk
   * on a REBUILD — and this route has page-level rebuilds at two different
   * altitudes, neither of which any row-level assertion in this file can see:
   *
   *  - `enrichGroupedRowAgentNames` returns `{ ...body, rows: rows.map(...) }`.
   *    Every row is reconstructed; the page is spread. A page-level key survives
   *    that spread today, and would not survive a version that enumerated the
   *    page's keys — with every `rates_reportable` and `agent_name` assertion in
   *    this file still green.
   *  - `withOmissionCounters` is the one place the page-level shape is the public API layer's
   *    own construction rather than internal handler's body handed over. It spreads too. It
   *    is also the function an earlier fix caught dropping a field once (the
   *    roster's `inactive_omitted`), which is the precedent for not assuming.
   *
   * ── Three states, not two ─────────────────────────────────────────────────
   * A string, a `null`, and ABSENT are three different instructions to the
   * console: name the axis, nothing here was cut in a zone, and an internal handler that
   * predates the field (render the matrix with no hour-axis label and say the
   * zone could not be read). Guessing on the third is forbidden, so the public API layer must
   * neither drop the null nor invent a value — both are asserted below, and the
   * null is the one a keys-enumerating rebuild loses first.
   */

  it('the fixtures DERIVE it, so each one is a shape the internal handler can actually emit', () => {
    /**
     * The `metrics()` rule applied to a page-level field. Asserted rather than
     * trusted because every behavioural case below is only as good as the body it
     * is handed: a fixture naming a zone on an unzoned grouping, or naming one
     * with no campaign in scope, is a page the internal handler answers 400 for — and a test
     * built on it proves nothing about a payload that can exist.
     */
    for (const groupBy of [['day'], ['day_of_week', 'hour_of_day'], ['agent', 'day']]) {
      const page = groupedBody(groupBy, []);
      expect(page.resolved_timezone, `${groupBy} is cut in a zone`).toBe(RESOLVED_TIMEZONE);
      // D5/E2: a zoned dimension is refused unless one campaign is in scope.
      expect(page.campaign_id).toBe(CAMPAIGN);
    }

    for (const groupBy of [['agent'], ['campaign'], ['disposition'], ['agent', 'campaign']]) {
      const page = groupedBody(groupBy, []);
      // An explicit null, never an absent key: "nothing here was cut in a zone"
      // is an answer, and it is not the same answer as "this internal handler has no such
      // field".
      expect(page, `${groupBy} is cut in no zone`).toHaveProperty('resolved_timezone', null);
      expect(page.campaign_id).toBeNull();
    }
  });

  it('survives the branch that REBUILDS every row — group_by=agent,day', async () => {
    /**
     * `agent,day` is the only shape that is both agent-grouped and zoned, so it
     * is the only one that puts a real zone string through
     * `enrichGroupedRowAgentNames`. The internal handler names it as a screen ("`agent`+`day` for
     * a trend"), and `GROUP_MAX_DIMENSIONS` is 2, so it is a read a supervisor can
     * actually issue rather than a shape invented for this assertion.
     */
    mocks.proxyToCore.mockResolvedValue({
      status: 200,
      body: groupedBody(['agent', 'day'], [
        agentDayRow(ACTIVE_AGENT, '2026-08-21'),
        agentDayRow(ACTIVE_AGENT, '2026-08-22'),
      ]),
    });
    const app = await buildApp();

    const res = await app.inject({
      method: 'GET',
      url: `${GROUPED}?group_by=agent,day&campaign_id=${CAMPAIGN}`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveProperty('resolved_timezone', RESOLVED_TIMEZONE);
    // Proof this page really took the rebuild branch, so the assertion above is
    // about a body that went THROUGH the enrichment rather than past it. Without
    // this the case would pass identically against a route that had stopped
    // enriching altogether.
    expect(res.json().rows.map((row: { agent_name?: unknown }) => row.agent_name))
      .toEqual(['Sam Okoro', 'Sam Okoro']);
    // And the whole page, so a field lost BESIDE this one reds as well.
    expect(res.json()).toEqual({
      ...groupedBody(['agent', 'day'], [
        { ...agentDayRow(ACTIVE_AGENT, '2026-08-21'), agent_name: 'Sam Okoro' },
        { ...agentDayRow(ACTIVE_AGENT, '2026-08-22'), agent_name: 'Sam Okoro' },
      ]),
      inactive_omitted: 0,
      unattributed_omitted: 0,
    });
    await app.close();
  });

  it('survives the PASS-THROUGH branch — group_by=day_of_week,hour_of_day', async () => {
    // The best-hours read itself (E1: one request, the default limit, 168 cells).
    // No agent in any key, so the public API layer hands the internal handler's body over through
    // `withOmissionCounters` and never touches a row.
    mocks.proxyToCore.mockResolvedValue({
      status: 200,
      body: groupedBody(['day_of_week', 'hour_of_day'], [hourRow(0, 18), hourRow(3, 9)]),
    });
    const app = await buildApp();

    const res = await app.inject({
      method: 'GET',
      url: `${GROUPED}?group_by=day_of_week,hour_of_day&campaign_id=${CAMPAIGN}`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveProperty('resolved_timezone', RESOLVED_TIMEZONE);
    expect(mocks.findAnyByUsersAndTenant).not.toHaveBeenCalled();
    await app.close();
  });

  it('is a STRING for campaign + a time dimension WHEN one campaign is filtered', async () => {
    /**
     * The sibling of the case below, and the one that separates the internal handler's real rule
     * from a plausible proxy for it.
     *
     * The internal handler's predicate is `campaignId !== undefined && zoned`. A tempting
     * shorthand is "zoned and NOT grouped by campaign", which agrees on every
     * other shape in this file — and disagrees here: grouping BY campaign while
     * also FILTERING to one campaign is one campaign, therefore one zone, and the internal handler
     * names it. A fixture built on the shorthand would assert `null` on a page
     * the internal handler answers with a zone, which is exactly the shape these fixtures exist
     * never to assert.
     */
    const app = await buildApp();
    mocks.proxyToCore.mockResolvedValue({
      status: 200,
      body: groupedBody(['campaign', 'hour_of_day'], [
        { key: { campaign_id: CAMPAIGN, hour_of_day: 11 }, ...metrics() },
      ], { campaign_id: CAMPAIGN }),
    });

    const res = await app.inject({
      method: 'GET',
      url: `${GROUPED}?group_by=campaign,hour_of_day&campaign_id=${CAMPAIGN}`,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.campaign_id).toBe(CAMPAIGN);
    // One campaign in scope, so one zone — and the public API layer carries it.
    expect(body.resolved_timezone).toBe(RESOLVED_TIMEZONE);
    await app.close();
  });

  it('is NULL on the cross-campaign zoned read — a page with several zones has no one zone', async () => {
    /**
     * `group_by=campaign,hour_of_day` with NO `campaign_id`. This is a 200, not a
     * 400: D5 offers two remedies for an ambiguous zone and they are not
     * interchangeable — adding `campaign` to `group_by` keeps the read
     * cross-campaign (each row cut in its own campaign's zone), while filtering
     * `campaign_id` narrows it to one. `campaign` plus ONE time dimension fits
     * `GROUP_MAX_DIMENSIONS` exactly, so the shape is reachable from the browser.
     *
     * On that page `resolved_timezone` must be `null`, because there is no single
     * zone to name. Emitting a string would be the field's one unforgivable
     * failure: a confident single zone over columns that are in fact several,
     * which is worse than no label at all — the reader has no way to tell.
     *
     * This is the case a future edit breaks. Deriving the field from "is any
     * dimension zoned" alone — the obvious reading, and the one this file's own
     * fixture had first — emits a string here and passes every other test.
     */
    const app = await buildApp();
    const other = '88888888-8888-4888-8888-888888888888';
    mocks.proxyToCore.mockResolvedValue({
      status: 200,
      body: groupedBody(['campaign', 'hour_of_day'], [
        { key: { campaign_id: CAMPAIGN, hour_of_day: 11 }, ...metrics() },
        { key: { campaign_id: other, hour_of_day: 11 }, ...metrics() },
      ]),
    });

    const res = await app.inject({
      method: 'GET',
      url: `${GROUPED}?group_by=campaign,hour_of_day`,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    // Present and null — not absent, which would mean "this internal handler cannot tell you".
    expect('resolved_timezone' in body).toBe(true);
    expect(body.resolved_timezone).toBeNull();
    // And the public API layer has not narrowed the read to one campaign to manufacture a zone.
    expect(body.campaign_id).toBeNull();
    expect(body.rows).toHaveLength(2);
    await app.close();
  });

  it('carries a NULL through both branches as a null, not as an absence', async () => {
    /**
     * The state a rebuild loses first, and the one that matters most: `null` and
     * absent are different instructions to the console (name no axis because
     * nothing here was zoned, versus this internal handler cannot tell you). The concrete way
     * it goes is a rebuild that copies the field as
     * `resolved_timezone: page.resolved_timezone ?? undefined` — which keeps
     * every string in this file and drops exactly this null.
     *
     * Spelled `toHaveProperty(key, null)` because both halves are the claim: the
     * key is there, and its value is the null.
     */
    const app = await buildApp();

    // Rebuild branch: `group_by=agent`, no zoned dimension.
    mocks.proxyToCore.mockResolvedValue({ status: 200, body: agentGroupedBody() });
    const rebuilt = await app.inject({ method: 'GET', url: `${GROUPED}?group_by=agent` });
    expect(rebuilt.json()).toHaveProperty('resolved_timezone', null);
    // Really the rebuild branch: the departed agent was filtered and the survivor
    // named.
    expect(rebuilt.json().inactive_omitted).toBe(1);

    // Pass-through branch: `group_by=campaign`.
    mocks.proxyToCore.mockResolvedValue({
      status: 200,
      body: groupedBody(['campaign'], [campaignRow(CAMPAIGN)]),
    });
    const passed = await app.inject({ method: 'GET', url: `${GROUPED}?group_by=campaign` });
    expect(passed.json()).toHaveProperty('resolved_timezone', null);
    await app.close();
  });

  it('survives the DEGRADE path, where the page shape is the public API layer’s own', async () => {
    /**
     * The narrowing refuses the body and `withOmissionCounters` answers — the one
     * place on this route where the public API layer, not the internal handler, decides which page-level keys
     * exist. It spreads today, so the field rides it; the counters' own case in
     * `BOTH omission counters are emitted on EVERY path` is the precedent for
     * asserting that rather than assuming it, because that is the path a review
     * found dropping `inactive_omitted` on the roster.
     *
     * ⚠️ The fixture used to be `{ ...body, next_cursor: 12 }`, from when the gate
     * was `asSpinePage` — a page with perfectly walkable ROWS, refused over a
     * PAGING field. That gate was the M7/M8 defect and is gone; a body reaches
     * this branch only when it has no row array at all, which is what the fixture
     * now models.
     */
    const zonedBody = {
      ...groupedBody(['day_of_week', 'hour_of_day'], [hourRow(0, 18)]),
      rows: 'not an array',
    };
    mocks.proxyToCore.mockResolvedValue({ status: 200, body: zonedBody });
    const app = await buildApp();

    const res = await app.inject({
      method: 'GET',
      url: `${GROUPED}?group_by=day_of_week,hour_of_day&campaign_id=${CAMPAIGN}`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveProperty('resolved_timezone', RESOLVED_TIMEZONE);
    // The two counters are still the ONLY additions on this path.
    expect(res.json()).toEqual({ ...zonedBody, inactive_omitted: 0, unattributed_omitted: 0 });

    // And the null on the same path: a rebuild copying the field with
    // `?? undefined` keeps the string above and drops this one.
    const unzonedBody = { ...agentGroupedBody(), rows: 'not an array' };
    mocks.proxyToCore.mockResolvedValue({ status: 200, body: unzonedBody });
    const unzoned = await app.inject({ method: 'GET', url: `${GROUPED}?group_by=agent` });

    expect(unzoned.json()).toHaveProperty('resolved_timezone', null);
    await app.close();
  });

  it('does not INVENT one for an internal handler that predates the field', async () => {
    /**
     * A state that exists for as long as the rollout takes: the field is additive
     * on the internal handler's side, so the public API layer serves pages without it before it serves pages
     * with it. An absent zone makes the surface render the matrix
     * with no hour-axis label and SAY the zone could not be read — it does not
     * guess, and specifically does not fall back to UTC or to the reader's own
     * zone (`windowRangeReadout`'s `Intl` zone is the right answer for the window
     * caption and the wrong one for this axis).
     *
     * A `resolved_timezone: 'UTC'` defaulted in this hop out of helpfulness would
     * print a UTC axis over Asia/Kolkata buckets and remove the console's ability
     * to know it was guessing. Confidently wrong beats blank, so the key must
     * stay absent.
     */
    const { resolved_timezone: _absent, ...withoutTheField } =
      groupedBody(['day_of_week', 'hour_of_day'], [hourRow(0, 18)]);
    mocks.proxyToCore.mockResolvedValue({ status: 200, body: withoutTheField });
    const app = await buildApp();

    const res = await app.inject({
      method: 'GET',
      url: `${GROUPED}?group_by=day_of_week,hour_of_day&campaign_id=${CAMPAIGN}`,
    });

    expect(res.json()).not.toHaveProperty('resolved_timezone');
    // An absent field is not a degrade: nothing else about the answer changes,
    // both counters included.
    expect(res.json()).toEqual({
      ...withoutTheField, inactive_omitted: 0, unattributed_omitted: 0,
    });
    await app.close();
  });

  it('is not forwarded as a QUERY param — the public API layer has no opinion to send', async () => {
    /**
     * The read direction only. `resolved_timezone` is an ANSWER, and the zone rules are
     * explicit that this phase has no `tz` parameter in either direction: a
     * caller reaching for one must be refused rather than silently given UTC
     * buckets for an Asia/Kolkata campaign. Pinned because the obvious next
     * request after "label the axis" is "let me pick the zone", and the whitelist
     * is where that would land.
     */
    const app = await buildApp();

    const res = await app.inject({
      method: 'GET',
      url: `${GROUPED}?group_by=day_of_week,hour_of_day&campaign_id=${CAMPAIGN}`
        + `&resolved_timezone=${encodeURIComponent(RESOLVED_TIMEZONE)}`,
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'unknown_query_params' });
    expect(res.json().details.unknown).toEqual(['resolved_timezone']);
    expect(mocks.proxyToCore).not.toHaveBeenCalled();
    await app.close();
  });
});

describe('⚠️ the reconciliation asymmetry, which is NOT a bug', () => {
  /**
   * Read this before "fixing" either number.
   *
   * One account, one campaign, one window. The active agent made 120 attempts and
   * the departed agent 80, so the campaign's total is 200.
   *
   *  - Grouped by CAMPAIGN, the row is an aggregate over everyone who dialled.
   *    There is no row that belongs to the departed agent, so there is nothing to
   *    drop: the total is 200 and `inactive_omitted` is 0.
   *  - Grouped by AGENT, the departed agent's row is dropped by default: the
   *    visible attempts are 120 and `inactive_omitted` is 1.
   *
   * 200 ≠ 120, and the difference is exactly the departed agent's 80 attempts.
   * Neither number is wrong; showing them adjacent without a note is. The fix a
   * future reader will reach for — filtering the campaign row too, or dropping
   * the agent filter — would break one screen to make the other add up, so both
   * halves are pinned here with the arithmetic stated.
   */
  const ACTIVE_ATTEMPTS = 120;
  const DEPARTED_ATTEMPTS = 80;
  const CAMPAIGN_TOTAL = ACTIVE_ATTEMPTS + DEPARTED_ATTEMPTS;

  it('a campaign-grouped total INCLUDES the departed agent\'s attempts', async () => {
    mocks.proxyToCore.mockResolvedValue({
      status: 200,
      body: groupedBody(['campaign'], [campaignRow(CAMPAIGN, { attempts: CAMPAIGN_TOTAL })]),
    });
    const app = await buildApp();

    const res = await app.inject({
      method: 'GET',
      url: `${GROUPED}?group_by=campaign&campaign_id=${CAMPAIGN}`,
    });

    expect(res.json().rows).toHaveLength(1);
    expect(res.json().rows[0].attempts).toBe(CAMPAIGN_TOTAL);
    expect(res.json().inactive_omitted).toBe(0);
    await app.close();
  });

  it('an agent-grouped view of the SAME campaign excludes them by default', async () => {
    mocks.proxyToCore.mockResolvedValue({
      status: 200,
      body: groupedBody(['agent'], [
        agentRow(ACTIVE_AGENT, { attempts: ACTIVE_ATTEMPTS }),
        agentRow(DEPARTED_AGENT, { attempts: DEPARTED_ATTEMPTS }),
      ]),
    });
    const app = await buildApp();

    const res = await app.inject({
      method: 'GET',
      url: `${GROUPED}?group_by=agent&campaign_id=${CAMPAIGN}`,
    });

    const visible = res.json().rows
      .reduce((sum: number, r: { attempts: number }) => sum + r.attempts, 0);
    expect(visible).toBe(ACTIVE_ATTEMPTS);
    expect(res.json().inactive_omitted).toBe(1);
    // The gap the console must not present silently.
    expect(CAMPAIGN_TOTAL - visible).toBe(DEPARTED_ATTEMPTS);
    await app.close();
  });

  it('and include_inactive=true is what makes the two agree', async () => {
    // The remedy, and the proof that the asymmetry is the FILTER rather than two
    // different populations: asked for the departed agents, the agent-grouped
    // view sums to the campaign total exactly.
    mocks.proxyToCore.mockResolvedValue({
      status: 200,
      body: groupedBody(['agent'], [
        agentRow(ACTIVE_AGENT, { attempts: ACTIVE_ATTEMPTS }),
        agentRow(DEPARTED_AGENT, { attempts: DEPARTED_ATTEMPTS }),
      ]),
    });
    const app = await buildApp();

    const res = await app.inject({
      method: 'GET',
      url: `${GROUPED}?group_by=agent&campaign_id=${CAMPAIGN}&include_inactive=true`,
    });

    const visible = res.json().rows
      .reduce((sum: number, r: { attempts: number }) => sum + r.attempts, 0);
    expect(visible).toBe(CAMPAIGN_TOTAL);
    expect(res.json().inactive_omitted).toBe(0);
    await app.close();
  });
});

describe('BOTH omission counters are emitted on EVERY path', () => {
  it('serves a 2xx body with NO row array unfiltered, rather than 500ing', async () => {
    // A body with nothing to walk. The answer to one is to hand it over
    // untouched, not to invent a filter over rows the public API layer cannot see.
    mocks.proxyToCore.mockResolvedValue({ status: 200, body: { unexpected: true } });
    const app = await buildApp();

    const res = await app.inject({ method: 'GET', url: `${GROUPED}?group_by=agent` });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      unexpected: true, inactive_omitted: 0, unattributed_omitted: 0,
    });
    expect(mocks.findAnyByUsersAndTenant).not.toHaveBeenCalled();
    await app.close();
  });

  it('but still carries BOTH counters on that degrade path', async () => {
    /**
     * ⚠️ The bug a review found on the roster, asserted here so it is not shipped
     * twice. `inactive_omitted` exists nowhere in the internal handler's payload, so the public API layer is the
     * only thing that can ever put it there, and the client declares it REQUIRED
     * and computes with it: `total_groups <= rows.length + inactive_omitted`
     * decides whether the truncation note renders, and with the key absent that is
     * `n <= NaN`, which is `false` — so the note appears on a page that was never
     * truncated.
     *
     * ⚠️ The FIXTURE here was itself the M7/M8 bug and is rewritten. It used to
     * be `{ ...agentGroupedBody(), next_cursor: 12 }` — a full agent-grouped page
     * with one unreadable paging field — called "the realistic refusal". It was
     * realistic, which is exactly why it must not reach this branch: the degrade
     * path serves rows the public API layer did NOT filter, and those rows are walkable. See
     * `the membership filter is gated on the ROWS, not on the paging fields`
     * below, which pins that shape being filtered instead.
     *
     * So the fixture is a body whose `rows` is not an array: everything else looks
     * like a grouped page, and there is genuinely nothing to walk.
     */
    const body = { ...agentGroupedBody(), rows: 'not an array' };
    mocks.proxyToCore.mockResolvedValue({ status: 200, body });
    const app = await buildApp();

    const res = await app.inject({ method: 'GET', url: `${GROUPED}?group_by=agent` });

    expect(res.statusCode).toBe(200);
    expect(res.json().inactive_omitted).toBe(0);
    // `unattributed_omitted` is the NEWER of the two and therefore the one a
    // path is likely to be missing, which is the whole reason both ride one
    // helper rather than each route remembering separately.
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
    // A 200 whose body is a string is not a page in any field, and inventing an
    // object around it would be a shape nobody declared. Handed over as it came.
    mocks.proxyToCore.mockResolvedValue({ status: 200, body: 'not json at all' });
    const app = await buildApp();

    const res = await app.inject({ method: 'GET', url: `${GROUPED}?group_by=agent` });

    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('not json at all');
    await app.close();
  });

  it('does not graft the counter onto a non-2xx body that DOES carry rows', async () => {
    /**
     * A 424/429 that echoes the page is reachable — the neighbouring
     * campaign-activity surface already answers `{ rows, partial,
     * partial_reason }`, and `errorMaskHook` passes 429 through by policy. An
     * `inactive_omitted` grafted onto such a body is both a body the mask judges
     * differently and a claim about filtering that did not happen.
     */
    mocks.proxyToCore.mockResolvedValue({
      status: 424,
      body: { ...agentGroupedBody(), partial: true, partial_reason: 'core_unavailable' },
    });
    const app = await buildApp();

    const res = await app.inject({ method: 'GET', url: `${GROUPED}?group_by=agent` });

    expect(res.statusCode).toBe(424);
    expect(res.json()).toEqual({
      ...agentGroupedBody(), partial: true, partial_reason: 'core_unavailable',
    });
    expect(res.json().inactive_omitted).toBeUndefined();
    expect(res.json().unattributed_omitted).toBeUndefined();
    expect(mocks.findAnyByUsersAndTenant).not.toHaveBeenCalled();
    await app.close();
  });

  it('propagates a membership-read fault instead of counting 0', async () => {
    /**
     * The one degrade this route deliberately does NOT make. A name lookup fails
     * to `agent_name: null` because a name is an improvement on an id; the
     * membership read decides WHICH ROWS EXIST, so degrading it would mean either
     * serving departed agents under `inactive_omitted: 0` — a payload that states,
     * falsely, that nothing was hidden — or dropping everybody. Both are confident
     * wrong answers, and the fault is masked into a generic 500 rather than
     * dressed as a successful page.
     */
    mocks.findAnyByUsersAndTenant.mockRejectedValue(new Error('memberships unreachable'));
    // The route's half: the fault propagates as a 500 rather than a 200 page under
    // `inactive_omitted: 0`.
    const app = await buildApp();

    const res = await app.inject({ method: 'GET', url: `${GROUPED}?group_by=agent` });

    expect(res.statusCode).toBe(500);
    expect(res.json().rows).toBeUndefined();
    expect(res.json().inactive_omitted).toBeUndefined();
    await app.close();
  });
});

describe('the membership filter is gated on the ROWS, not on the paging fields', () => {
  /**
   * ⚠️ The roster's twin, and the same defect: the filter used to run only if
   * `asSpinePage(result.body)` returned a page, and that function refuses a body
   * whose `next_cursor` is not a string **or whose `limit` is not a number**.
   * `limit` reaches the internal handler as a query param, so `'200'` is a shape it can be echoed
   * back in — and an agent-grouped page carrying one was served **unfiltered with
   * `inactive_omitted: 0`**, a departed agent's row present under the public API layer's own
   * claim that nothing was hidden.
   *
   * The gate now asks the only question this branch is about: is there a row
   * array to walk?
   */
  const FILTERABLE: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
    ['a STRING limit, the shape a query param has', { limit: '200' }],
    ['an unreadable next_cursor', { next_cursor: 12 }],
    ['both at once', { limit: '200', next_cursor: 12 }],
  ];

  it.each(FILTERABLE)('filters an agent-grouped page with %s', async (_label, overrides) => {
    const body = { ...agentGroupedBody(), ...overrides };
    mocks.proxyToCore.mockResolvedValue({ status: 200, body });
    const app = await buildApp();

    const res = await app.inject({ method: 'GET', url: `${GROUPED}?group_by=agent` });

    expect(res.statusCode).toBe(200);
    expect(keysOf(res)).toEqual([{ agent_user_id: ACTIVE_AGENT }]);
    expect(res.json().inactive_omitted).toBe(1);
    expect(res.json().unattributed_omitted).toBe(0);
    expect(mocks.findAnyByUsersAndTenant).toHaveBeenCalledTimes(1);
    // The name enrichment narrowed through the same rejected helper, so under the
    // old gate this page came back with no `agent_name` at all — on the branch
    // whose contract (D9) is that the key is present iff `agent` was grouped.
    expect(res.json().rows[0]).toHaveProperty('agent_name', 'Sam Okoro');
    for (const [key, value] of Object.entries(overrides)) {
      expect(res.json()[key]).toEqual(value);
    }
    await app.close();
  });
});

describe('an agent-grouped page whose ids are unusable is still FILTERED', () => {
  /**
   * ⚠️ M2/M11: the branch was chosen by the id EXTRACTOR
   * (`rows.some((r) => groupedRowAgentId(r) !== null)`), which conflates "was
   * `agent` grouped" with "is this id usable". A page whose only agent keys are
   * empty strings, nulls or numbers therefore looked NOT agent-grouped, took the
   * pass-through branch, and was served unfiltered with both counters at 0 — every
   * row about a person the public API layer could not account for, under a payload asserting
   * nothing was hidden.
   *
   * The branch is now chosen on the key's SHAPE
   * (`groupedRowHasAgentKey`), so these pages are filtered and their rows are
   * dropped as the third state (unattributable).
   */
  const UNUSABLE: ReadonlyArray<readonly [string, unknown]> = [
    ['an empty string', ''],
    ['a null', null],
    ['a number', 42],
  ];

  it.each(UNUSABLE)('drops a sole row whose agent_user_id is %s', async (_label, value) => {
    const body = groupedBody(['agent'], [{ key: { agent_user_id: value }, ...metrics() }]);
    mocks.proxyToCore.mockResolvedValue({ status: 200, body });
    const app = await buildApp();

    const res = await app.inject({ method: 'GET', url: `${GROUPED}?group_by=agent` });

    expect(res.statusCode).toBe(200);
    // Dropped, not leaked.
    expect(res.json().rows).toEqual([]);
    // And counted as what it is: unattributable, never a departure.
    expect(res.json().unattributed_omitted).toBe(1);
    expect(res.json().inactive_omitted).toBe(0);
    await app.close();
  });

  it('drops it under include_inactive=true as well', async () => {
    // `include_inactive` means "show me the people who left", not "show me ids you
    // cannot account for" — so the flag does not rescue this row either.
    const body = groupedBody(['agent'], [{ key: { agent_user_id: '' }, ...metrics() }]);
    mocks.proxyToCore.mockResolvedValue({ status: 200, body });
    const app = await buildApp();

    const res = await app.inject({
      method: 'GET',
      url: `${GROUPED}?group_by=agent&include_inactive=true`,
    });

    expect(res.json().rows).toEqual([]);
    expect(res.json().unattributed_omitted).toBe(1);
    await app.close();
  });

  it('still filters the usable rows on a page that MIXES the two', async () => {
    // The page the old predicate did handle — one good id makes it agent-grouped
    // either way — asserted so the fix is not read as being only about the
    // all-unusable page. The departed agent still goes, the stranger still goes,
    // and the blank row is the third omission.
    const body = groupedBody(['agent'], [
      agentRow(ACTIVE_AGENT),
      agentRow(DEPARTED_AGENT),
      { key: { agent_user_id: '' }, ...metrics() },
    ]);
    mocks.proxyToCore.mockResolvedValue({ status: 200, body });
    const app = await buildApp();

    const res = await app.inject({ method: 'GET', url: `${GROUPED}?group_by=agent` });

    expect(keysOf(res)).toEqual([{ agent_user_id: ACTIVE_AGENT }]);
    expect(res.json().inactive_omitted).toBe(1);
    expect(res.json().unattributed_omitted).toBe(1);
    await app.close();
  });

  it('and a page with NO agent member on any key still passes through', async () => {
    // The complement, so the shape predicate is not passing for being always
    // true: a campaign-grouped page reads no membership at all.
    mocks.proxyToCore.mockResolvedValue({
      status: 200,
      body: groupedBody(['campaign'], [campaignRow(CAMPAIGN)]),
    });
    const app = await buildApp();

    const res = await app.inject({ method: 'GET', url: `${GROUPED}?group_by=campaign` });

    expect(res.json().rows).toHaveLength(1);
    expect(mocks.findAnyByUsersAndTenant).not.toHaveBeenCalled();
    await app.close();
  });
});

describe('the internal handler call carries a wall clock', () => {
  it('passes ROSTER_CORE_TIME_BUDGET_MS to proxyToCore', async () => {
    /**
     * The internal handler has **no `statement_timeout`** anywhere, and `proxyToCore` with no
     * `timeoutMs` runs under undici's default 300s header timeout — so an internal handler
     * answering SLOWLY rather than failing holds the public API layer's worker, its Fastify
     * connection and a socket for as long as it likes. This read is if anything
     * the more expensive of the two whole-floor reads: its row count is the
     * PRODUCT of the grouped dimensions' cardinalities, where the roster's is
     * bounded by headcount.
     */
    const app = await buildApp();

    await app.inject({ method: 'GET', url: `${GROUPED}?group_by=agent,day` });

    expect(mocks.proxyToCore.mock.calls[0]![0].timeoutMs).toBe(ROSTER_CORE_TIME_BUDGET_MS);
    await app.close();
  });

  it('is the SAME budget as the roster, not a second number with one value', async () => {
    // Asserted as a relation to the export's reader-facing figure, exactly as the
    // roster's own case does: both reads are one whole interactive request
    // measured against a reader's patience, so a second constant with the same
    // value would be two things to change.
    const { ACTIVITY_EXPORT_TIME_BUDGET_MS, ACTIVITY_OWNERSHIP_PROBE_TIMEOUT_MS } = await import(
      '../../../src/agency/agency-activity.js'
    );

    expect(ROSTER_CORE_TIME_BUDGET_MS).toBe(ACTIVITY_EXPORT_TIME_BUDGET_MS);
    expect(ROSTER_CORE_TIME_BUDGET_MS).toBeGreaterThan(ACTIVITY_OWNERSHIP_PROBE_TIMEOUT_MS);
  });

});

describe('route precedence, asserted on the internal handler path each handler builds', () => {
  /**
   * A route assertion can pass vacuously when the route it names
   * does not exist, so none of these cases rests on a status code. `grouped-stats`
   * and `stats` are both static two-segment siblings under `/agents`, and the
   * parametric routes are three segments deep — true statements about Fastify's
   * radix router and useless ones about this repository. The evidence that
   * separates "the right handler ran" from "something answered 200" is the path
   * the handler built for the internal handler.
   */
  it('GET /agents/grouped-stats hits the GROUPED handler', async () => {
    const app = await buildApp();

    const res = await app.inject({ method: 'GET', url: `${GROUPED}?group_by=agent` });

    expect(res.statusCode).toBe(200);
    expect(mocks.proxyToCore).toHaveBeenCalledWith(
      expect.objectContaining({ path: '/agency-agents/grouped-stats' }),
    );
    // It names no agent, so it runs no per-agent tenancy check.
    expect(mocks.findAnyByUserAndTenant).not.toHaveBeenCalled();
    await app.close();
  });

  it('and does NOT reach the roster handler, which shares the prefix', async () => {
    const app = await buildApp();

    await app.inject({ method: 'GET', url: `${GROUPED}?group_by=agent` });

    expect(mocks.proxyToCore.mock.calls[0]![0].path).not.toBe('/agency-agents/stats');
    await app.close();
  });

  it('GET /agents/stats still hits the ROSTER handler', async () => {
    // The other direction: adding this route must not have shadowed the roster.
    // `?group_by=` is not on the roster's whitelist, so the assertion also proves
    // the two whitelists did not merge.
    mocks.proxyToCore.mockResolvedValue({
      status: 200,
      body: { from: 'x', to: 'y', total_agents: 1, rows: [], benchmark: {} },
    });
    const app = await buildApp();

    const res = await app.inject({ method: 'GET', url: ROSTER });

    expect(res.statusCode).toBe(200);
    expect(mocks.proxyToCore).toHaveBeenCalledWith(
      expect.objectContaining({ path: '/agency-agents/stats' }),
    );
    const refused = await app.inject({ method: 'GET', url: `${ROSTER}?group_by=agent` });
    expect(refused.statusCode).toBe(400);
    expect(refused.json().details.unknown).toEqual(['group_by']);
    await app.close();
  });

  it('GET /agents/<uuid>/stats still hits the PER-AGENT handler', async () => {
    const app = await buildApp();

    const res = await app.inject({ method: 'GET', url: `${PREFIX}/agents/${ACTIVE_AGENT}/stats` });

    expect(res.statusCode).toBe(200);
    expect(mocks.proxyToCore).toHaveBeenCalledWith(
      expect.objectContaining({ path: `/agency-agents/${ACTIVE_AGENT}/stats` }),
    );
    expect(mocks.findAnyByUserAndTenant).toHaveBeenCalledWith(ACTIVE_AGENT, TENANT);
    await app.close();
  });

  it('the literal "grouped-stats" is not read as a userId', async () => {
    /**
     * The failure this precedence question is actually about. If a parametric
     * route won, `:userId` would be the string `'grouped-stats'` — which
     * `agentParamsSchema` refuses, so the symptom would be a **400 Validation
     * Error on the grouped read**, not a 404. Pinned so a future path change (a
     * rename, or a two-segment `/agents/:userId`) cannot make this route answer
     * as a malformed per-agent read.
     */
    const app = await buildApp();

    const res = await app.inject({ method: 'GET', url: `${GROUPED}?group_by=agent` });

    expect(res.statusCode).not.toBe(400);
    expect(res.statusCode).not.toBe(404);
    expect(mocks.proxyToCore.mock.calls[0]![0].path).not.toContain('grouped-stats/stats');
    await app.close();
  });
});

describe('the plugin-level hooks reach the grouped route too', () => {
  it('runs session → tenant-context', async () => {
    // Registered on the PLUGIN, so a route added to this file inherits both
    // or neither. Asserted on the record each double leaves, because a hook that
    // never ran is indistinguishable from one that ran and allowed.
    const app = await buildApp();

    await app.inject({ method: 'GET', url: `${GROUPED}?group_by=agent` });

    expect(mocks.hooksRan).toEqual(['session', 'tenant-context']);
    await app.close();
  });

  // A plugin-level hook (`tenantContextMiddleware`) that replies stops the route, and the
  // internal handler is never called.
  it('is refused when a plugin-level hook refuses', async () => {
    mocks.refuseTenantContext = true;
    const app = await buildApp();

    const res = await app.inject({ method: 'GET', url: `${GROUPED}?group_by=agent` });

    expect(res.statusCode).toBe(403);
    expect(mocks.proxyToCore).not.toHaveBeenCalled();
    await app.close();
  });
});

describe('the grouped row\'s agent id, and the filter over it, without a router', () => {
  /**
   * The two pure functions the route's whole branch rests on. Tested directly
   * because the cost of getting either wrong is invisible in a status code, and
   * because a router test cannot cheaply reach the malformed shapes the internal handler is
   * capable of producing — `agent_user_id` is an opaque string to it, with no
   * user table and no FK behind the column.
   */
  it('reads the agent id out of `key`, and only a usable one', () => {
    expect(groupedRowAgentId({ key: { agent_user_id: ACTIVE_AGENT } })).toBe(ACTIVE_AGENT);
    expect(groupedRowAgentId({ key: { agent_user_id: ACTIVE_AGENT, campaign_id: CAMPAIGN } }))
      .toBe(ACTIVE_AGENT);
    // Present-but-unusable and absent both mean "no usable agent id on this row".
    // They do NOT mean the same thing about the GROUPING — see the block below.
    expect(groupedRowAgentId({ key: { agent_user_id: '' } })).toBeNull();
    expect(groupedRowAgentId({ key: { agent_user_id: null } as unknown as object })).toBeNull();
    expect(groupedRowAgentId({ key: { agent_user_id: 42 } as unknown as object })).toBeNull();
  });

  it('returns null for every non-agent grouping', () => {
    // `disposition_code: null` is a real key value and must NOT be mistaken for an
    // agent id slot; `day_of_week: 0` is falsy and must not be mistaken for an
    // absent key either.
    expect(groupedRowAgentId({ key: { campaign_id: CAMPAIGN } })).toBeNull();
    expect(groupedRowAgentId({ key: { disposition_code: null } })).toBeNull();
    expect(groupedRowAgentId({ key: { day_of_week: 0, hour_of_day: 0 } })).toBeNull();
  });

  it('survives a `key` that is not an object at all', () => {
    // Defensive because nothing upstream can promise the shape: a body the internal handler
    // changed must degrade, never throw inside the filter.
    expect(groupedRowAgentId({})).toBeNull();
    expect(groupedRowAgentId({ key: null })).toBeNull();
    expect(groupedRowAgentId({ key: 'agent' })).toBeNull();
    expect(groupedRowAgentId({ key: [ACTIVE_AGENT] })).toBeNull();
  });

  describe('and the SHAPE predicate, which is what chooses the branch', () => {
    /**
     * ⚠️ **These two questions used to be answered by one function, and that was
     * the defect.** The route decided "was `agent` grouped" with
     * `rows.some((r) => groupedRowAgentId(r) !== null)` — the id EXTRACTOR — so a
     * page whose only agent keys were empty strings, nulls or numbers answered
     * "not agent-grouped", took the pass-through branch, and was served
     * **unfiltered with both omission counters at 0**: every row about a person
     * the public API layer could not account for, under a payload stating nothing was hidden.
     *
     * `groupedRowHasAgentKey` asks about the KEY'S SHAPE and
     * {@link groupedRowAgentId} about the VALUE, so a present-but-unusable member
     * chooses the filtering branch and is then dropped by it as the third state (unattributable).
     */
    it('sees the member even when its value is unusable', () => {
      expect(groupedRowHasAgentKey({ key: { agent_user_id: ACTIVE_AGENT } })).toBe(true);
      // The three shapes the extractor calls `null` and this must still call
      // grouped — the whole reason there are two functions.
      expect(groupedRowHasAgentKey({ key: { agent_user_id: '' } })).toBe(true);
      expect(groupedRowHasAgentKey({ key: { agent_user_id: null } as unknown as object }))
        .toBe(true);
      expect(groupedRowHasAgentKey({ key: { agent_user_id: 42 } as unknown as object }))
        .toBe(true);
    });

    it('says false for a key that has no agent member, and for no key at all', () => {
      expect(groupedRowHasAgentKey({ key: { campaign_id: CAMPAIGN } })).toBe(false);
      expect(groupedRowHasAgentKey({ key: { day_of_week: 0, hour_of_day: 0 } })).toBe(false);
      expect(groupedRowHasAgentKey({})).toBe(false);
      expect(groupedRowHasAgentKey({ key: null })).toBe(false);
      expect(groupedRowHasAgentKey({ key: 'agent' })).toBe(false);
      expect(groupedRowHasAgentKey({ key: [ACTIVE_AGENT] })).toBe(false);
    });

    it('does not count an INHERITED property as the dimension being grouped', () => {
      // `Object.hasOwn`, not `in`: a key object whose prototype chain happens to
      // carry the name has no agent dimension on it.
      const inherited = Object.create({ agent_user_id: ACTIVE_AGENT }) as object;
      expect(groupedRowHasAgentKey({ key: inherited })).toBe(false);
    });
  });

  const rows = [
    { key: { agent_user_id: ACTIVE_AGENT } },
    { key: { agent_user_id: DEPARTED_AGENT } },
    { key: { agent_user_id: STRANGER } },
  ];

  it('keeps active, drops departed, drops the stranger', () => {
    const result = filterRowsByMembership(rows, MEMBERSHIPS, ACCOUNT, false, groupedRowAgentId);

    expect(result.rows).toEqual([{ key: { agent_user_id: ACTIVE_AGENT } }]);
    expect(result.inactiveOmitted).toBe(1);
    expect(result.unknownOmitted).toBe(1);
  });

  it('keeps departed under the flag, and still drops the stranger', () => {
    const result = filterRowsByMembership(rows, MEMBERSHIPS, ACCOUNT, true, groupedRowAgentId);

    expect(result.rows).toEqual([
      { key: { agent_user_id: ACTIVE_AGENT } },
      { key: { agent_user_id: DEPARTED_AGENT } },
    ]);
    expect(result.inactiveOmitted).toBe(0);
    expect(result.unknownOmitted).toBe(1);
  });

  it('drops a row whose agent member is PRESENT but unusable, as unattributed', () => {
    /**
     * The other half of the M2/M11 split, at the level of one row. The page is
     * agent-grouped by shape, so the filter runs; this row cannot be attributed to
     * anybody, so it is the third state (unattributable) — dropped under either flag and counted
     * apart from the departures. What must never happen is what used to: the row
     * served, because "no usable id" was read as "not about a person".
     */
    const unusable = [
      { key: { agent_user_id: '' } },
      { key: { agent_user_id: null } as unknown as { agent_user_id: string } },
    ];

    for (const includeInactive of [false, true]) {
      expect(filterRowsByMembership(unusable, MEMBERSHIPS, ACCOUNT, includeInactive, groupedRowAgentId))
        .toMatchObject({ rows: [], inactiveOmitted: 0, unknownOmitted: 2 });
    }
  });

  it('treats ANY membership that REACHES THIS ACCOUNT as current', () => {
    // A user can hold several memberships in one tenant — one per account, plus
    // possibly a tenant-level one — so the presence of one active row that reaches
    // this account decides it.
    const mixed = [
      { user_id: DEPARTED_AGENT, status: 'revoked', account_id: ACCOUNT },
      { user_id: DEPARTED_AGENT, status: 'active', account_id: ACCOUNT },
    ];

    expect(filterRowsByMembership(
      [{ key: { agent_user_id: DEPARTED_AGENT } }], mixed, ACCOUNT, false, groupedRowAgentId,
    ).rows).toEqual([{ key: { agent_user_id: DEPARTED_AGENT } }]);
  });

  it('does NOT count an active membership on a DIFFERENT account', () => {
    // The read is account-scoped, so an agent who moved to an account this
    // supervisor cannot see is a departure from THIS page. A tenant-level row
    // (`account_id: null`) reaches every account and still counts.
    const elsewhere = [
      { user_id: DEPARTED_AGENT, status: 'revoked', account_id: ACCOUNT },
      { user_id: DEPARTED_AGENT, status: 'active', account_id: OTHER_ACCOUNT },
    ];
    const row = [{ key: { agent_user_id: DEPARTED_AGENT } }];

    expect(filterRowsByMembership(row, elsewhere, ACCOUNT, false, groupedRowAgentId))
      .toMatchObject({ rows: [], inactiveOmitted: 1, unknownOmitted: 0 });
    expect(filterRowsByMembership(
      row, [{ user_id: DEPARTED_AGENT, status: 'active', account_id: null }],
      ACCOUNT, false, groupedRowAgentId,
    )).toMatchObject({ rows: row, inactiveOmitted: 0, unknownOmitted: 0 });
  });

  it('matches ids case-insensitively, on the row AND on the membership', () => {
    // Postgres returns `uuid` lower case; the internal handler's `agent_user_id` is an opaque
    // string with no `uuid` column behind it, so an upper-case id is reachable —
    // and it MATCHED in SQL (`::uuid[]`) before missing a case-sensitive `Set`,
    // which dropped a working colleague as unattributed.
    // `CASED_*` and not `ACTIVE_AGENT`: on a digits-only uuid `.toUpperCase()` is
    // a no-op and this case could not fail. See their declaration.
    const upper = [{ key: { agent_user_id: CASED_AGENT.toUpperCase() } }];
    expect(filterRowsByMembership(
      upper,
      [{ user_id: CASED_AGENT, status: 'active', account_id: CASED_ACCOUNT }],
      CASED_ACCOUNT, false, groupedRowAgentId,
    )).toMatchObject({ rows: upper, inactiveOmitted: 0, unknownOmitted: 0 });

    // The other direction, with the scoped account in the other case too.
    expect(filterRowsByMembership(
      [{ key: { agent_user_id: CASED_AGENT } }],
      [{
        user_id: CASED_AGENT.toUpperCase(),
        status: 'active',
        account_id: CASED_ACCOUNT.toUpperCase(),
      }],
      CASED_ACCOUNT, false, groupedRowAgentId,
    )).toMatchObject({
      rows: [{ key: { agent_user_id: CASED_AGENT } }], inactiveOmitted: 0, unknownOmitted: 0,
    });
  });

  it('treats `inactive` like `revoked`, not like active', () => {
    // `memberships.status` is `'active' | 'inactive' | 'revoked'`. Only the first
    // means "still here" — a whitelist rather than a blacklist of the other two,
    // so a status added by a future migration is not silently read as current.
    const suspended = [{ user_id: DEPARTED_AGENT, status: 'inactive', account_id: ACCOUNT }];
    const row = [{ key: { agent_user_id: DEPARTED_AGENT } }];

    expect(filterRowsByMembership(row, suspended, ACCOUNT, false, groupedRowAgentId))
      .toMatchObject({ rows: [], inactiveOmitted: 1, unknownOmitted: 0 });
    expect(filterRowsByMembership(row, suspended, ACCOUNT, true, groupedRowAgentId))
      .toMatchObject({ rows: row, inactiveOmitted: 0, unknownOmitted: 0 });
  });

  it('counts a repeated agent once per ROW, because the client compares row counts', () => {
    // `agent,campaign` emits one row per pair. `inactive_omitted` is compared
    // against `rows.length`, so it has to count rows rather than people —
    // de-duplicating it would understate what was hidden.
    const pairs = [
      { key: { agent_user_id: DEPARTED_AGENT, campaign_id: CAMPAIGN } },
      { key: { agent_user_id: DEPARTED_AGENT, campaign_id: 'other' } },
    ];

    expect(filterRowsByMembership(pairs, MEMBERSHIPS, ACCOUNT, false, groupedRowAgentId))
      .toMatchObject({ rows: [], inactiveOmitted: 2, unknownOmitted: 0 });
  });
});
