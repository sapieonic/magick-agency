import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';
import {
  insertAccount,
  insertMembership,
  insertTenant,
  insertUser,
} from '../../../../../packages/db/test/integration/setup/platform-factories.js';
import { TEST_DB_URL } from '../../../../../packages/db/test/helpers/test-db.js';
import { initDbPool, closePool } from '@magick-agency/db';

/**
 * ─── `GET /proxy/agency/my-campaigns` — THE BOUNDS, AGAINST REAL POSTGRES ────
 *
 * **Modelled on `test/integration/api/agency-staffing.routes.test.ts`**, which
 * already covers `/my-assignment` and `/my-assignments` on this same plugin. Its
 * mock set (module paths included), its DB-backed auth stubs and its `headers()`
 * helper are reused as-is. The fixture helpers are NOT: that suite seeds through
 * `agencyCampaignAgentRepository.assign`, which stamps `assigned_at` from the
 * column default — see {@link seedRow} for why every bound here needs to control
 * that column instead.
 *
 * ── Why the bounds specifically, and why they need real rows ────────────────
 * `test/unit/agency/proxy-agency-staffing.routes.test.ts` drives this handler
 * with a mocked repository, so `HISTORY_LIMIT_MAX` there is whatever the mock
 * returned — the ceiling is a `LIMIT` in a SQL string, and a mock cannot be
 * clipped by it. The same goes for the `from`/`to` window (a `WHERE` on
 * `assigned_at`), the `DESC` ordering the ceiling depends on to keep the RECENT
 * end, and the dedupe that `SELECT *` over a re-staffed campaign makes possible.
 *
 * All four bounds exist for one reason, stated in the repository: this table only
 * ever GROWS. Migration 060 closes rows rather than deleting them, every
 * reassignment adds one, `closeAllForUser` manufactures one per campaign on every
 * offboarding, and nothing removes any. The route is reachable by an `agent` —
 * the lowest-privileged role there is — on their own console, and it spends an internal
 * round trip per distinct campaign. So the bounds are the difference between a
 * page and an unbounded fan-out, and each is asserted against a history large
 * enough to trip it.
 *
 * ── GUARANTEES ─────────────────────────────────────────────────────────────
 * It runs against a real Postgres and Redis. The constants are IMPORTED from the source
 * (`HISTORY_LIMIT_MAX`) rather than transcribed, so the fixture sizes cannot
 * drift from the ceiling they are testing; and `SUMMARY_LOOKUP_MAX`, which the
 * route keeps private, is asserted through the only things a caller can observe
 * — how many internal calls happened and which rows came back named — rather than by
 * reaching into the module for its value. That is the right way round: a test
 * that imported the constant would still pass against a route which had stopped
 * applying it.
 *
 * ── STATUS ASSERTIONS CARRY THE BODY ───────────────────────────────────────
 * Every status is asserted through `seen(res)` from the integration harness —
 * `expect(seen(res)).toMatchObject({ status: 200 })` — which asserts the status
 * exactly and puts the response BODY in the failure diff. The reason is
 * measured, not stylistic: the sibling suite `agency-performance-access.test.ts`
 * came back with 26 failures reading `expected 200, received 403` and nothing
 * else, on routes where five separate layers answer 403 with five different
 * messages. Identifying the layer took a source-reading pass that the body would
 * have answered outright. Keep new assertions in this shape.
 *
 * Runs on the test database (Postgres 5436). It drives `GET /my-campaigns` in
 * `proxy-agency-staffing.routes.ts` (the staffing family).
 *  - **The internal hop is STUBBED** (`callCore`, decision B16, mocked as
 *    `mocks.proxyToCore`). Every assertion here is about the route's fan-out — how many
 *    lookups, which ids, in what order, with what name — over campaign ids that exist only
 *    as staffing rows; the count of in-process calls is the observable. The real handler (and real ownership) is driven by the sibling
 *    `agency-staffing.routes.test.ts`, including a foreign campaign's name never reaching an
 *    agent's `/my-assignments`.
 *  - Harness: `initDbPool` on the test database; partial logger mock; the session stub has
 *    no `x-platform-key` (there are no platform API keys); a local `seen` helper (the shared
 *    test-utils does not carry it).
 *  - Not covered: API-key resolution (there is no API key in one process), "a platform API
 *    key is refused", and "refused when the `agency` capability is off" (no governance).
 */

initDbPool({ url: TEST_DB_URL, poolMin: 0, poolMax: 4 });

/** A response's status paired with its body, for {@link seen}. */
interface SeenResponse {
  status: number;
  body: unknown;
}

/** A response's status and parsed body, so assertions carry the body. */
function seen(res: { statusCode: number; body: string }): SeenResponse {
  return { status: res.statusCode, body: parseBody(res.body) };
}

function parseBody(body: string): unknown {
  if (!body) return null;
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return body;
  }
}

const mocks = vi.hoisted(() => ({
  proxyToCore: vi.fn(),
}));

vi.mock('../../../src/api/core-dispatch.js', () => ({ callCore: mocks.proxyToCore }));

vi.mock('@magick-agency/observability', async (importOriginal) => {
  const child = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() });
  return {
    ...(await importOriginal<typeof import('@magick-agency/observability')>()),
    createChildLogger: child,
    logger: { ...child(), child },
  };
});

vi.mock('../../../src/auth/session.middleware.js', () => ({
  sessionMiddleware: async (request: {
    headers: Record<string, string | undefined>;
    user?: { id: string };
  }) => {
    // There are no platform API keys, so no `x-platform-key` branch.
    const userId = request.headers['x-user-id'];
    if (userId) request.user = { id: userId };
  },
}));

vi.mock('../../../src/api/middleware/tenant-context.middleware.js', async () => {
  const { membershipRepository } = await import(
    '@magick-agency/db/repositories/membership.repository'
  );
  return {
    tenantContextMiddleware: async (request: {
      headers: Record<string, string | undefined>;
      user?: { id: string };
      tenantId?: string;
      accountId?: string;
      membership?: unknown;
    }) => {
      request.tenantId = request.headers['x-tenant-id'];
      request.accountId = request.headers['x-account-id'];
      if (!request.user) return;
      const memberships = await membershipRepository.findByUserAndTenant(
        request.user.id,
        request.tenantId!,
      );
      const accountId = request.accountId;
      const membership = accountId
        ? memberships.find((m) => m.account_id === accountId)
          ?? memberships.find((m) => m.account_id === null)
        : memberships.find((m) => m.account_id === null) ?? memberships[0];
      if (membership && membership.status === 'active') request.membership = membership;
    },
  };
});

const { proxyAgencyStaffingRoutes } = await import(
  '../../../src/api/routes/proxy-agency-staffing.routes.js'
);
const { HISTORY_LIMIT_MAX } = await import(
  '@magick-agency/db/repositories/agency-campaign-agent.repository'
);

const PREFIX = '/proxy/agency';

describe('GET /my-campaigns — the staffing history and its bounds (integration)', () => {
  let app: FastifyInstance;
  let tenant: { id: string };
  let otherTenant: { id: string };
  let account: { id: string };
  let agent: { id: string };
  let colleague: { id: string };

  beforeEach(async () => {
    vi.restoreAllMocks();
    mocks.proxyToCore.mockReset();

    await truncateAll();
    tenant = await insertTenant();
    otherTenant = await insertTenant();
    account = await insertAccount({ tenant_id: tenant.id });

    agent = await insertUser({ display_name: 'Ada Agent' });
    await insertMembership({
      user_id: agent.id, tenant_id: tenant.id, account_id: account.id, role: 'agent',
    });
    colleague = await insertUser({ display_name: 'Bo Colleague' });
    await insertMembership({
      user_id: colleague.id, tenant_id: tenant.id, account_id: account.id, role: 'agent',
    });

    // A campaign the internal handler can always name, unless a case says otherwise.
    mocks.proxyToCore.mockResolvedValue({
      status: 200, body: { id: 'any', name: 'Q3 Renewals', status: 'running' },
    });

    app = Fastify({ logger: false });
    await app.register(proxyAgencyStaffingRoutes, { prefix: PREFIX });
    await app.ready();
  });

  afterEach(async () => {
    await app?.close();
  });

  afterAll(async () => {
    await closeTestPool();
    await closePool();
  });

  // ── helpers ───────────────────────────────────────────────────────────────

  function headers(overrides: Record<string, string | undefined> = {}) {
    const base: Record<string, string> = {
      'x-tenant-id': tenant.id,
      'x-account-id': account.id,
      'x-user-id': agent.id,
    };
    for (const [k, v] of Object.entries(overrides)) {
      if (v === undefined) delete base[k];
      else base[k] = v;
    }
    return base;
  }

  async function get(url: string, h = headers()) {
    return app.inject({ method: 'GET', url: `${PREFIX}${url}`, headers: h });
  }

  /**
   * Insert staffing rows DIRECTLY, with explicit `assigned_at`/`unassigned_at`.
   *
   * `agencyCampaignAgentRepository.assign` cannot be used for these fixtures and
   * the reason is the point of the file: it stamps `assigned_at` with the column
   * default, so every row would land within the same few milliseconds. Both the
   * `from`/`to` window and the newest-first ordering are questions ABOUT
   * `assigned_at`, so a fixture that cannot control it cannot test either — and
   * the ceiling case needs more rows than `assign` can even produce for one
   * (tenant, user, campaign) triple, because the partial unique index refuses a
   * second live one.
   *
   * Rows are inserted CLOSED by default for the same reason: a history is mostly
   * closed rows (that is why it is a history), and migration 064's index only
   * constrains rows with `unassigned_at IS NULL`, so an arbitrary number of closed
   * rows per campaign is both legal and exactly what accumulates.
   */
  async function seedRow(opts: {
    campaignId: string;
    assignedAt: Date;
    unassignedAt?: Date | null;
    userId?: string;
    tenantId?: string;
    accountId?: string | null;
  }) {
    const id = randomUUID();
    await getTestPool().query(
      `INSERT INTO agency_campaign_agents
         (id, tenant_id, account_id, campaign_id, user_id, assigned_by, assigned_at, unassigned_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        id,
        opts.tenantId ?? tenant.id,
        opts.accountId === undefined ? account.id : opts.accountId,
        opts.campaignId,
        opts.userId ?? agent.id,
        colleague.id,
        opts.assignedAt,
        opts.unassignedAt === undefined
          // Closed one day after it opened, unless the case says otherwise.
          ? new Date(opts.assignedAt.getTime() + 86_400_000)
          : opts.unassignedAt,
      ],
    );
    return id;
  }

  /**
   * `n` rows, one per DISTINCT campaign, one day apart, OLDEST first in the
   * returned array.
   *
   * ONE multi-row INSERT rather than `n` calls to {@link seedRow}. Not a
   * micro-optimisation: the ceiling cases need `HISTORY_LIMIT_MAX + 25` rows and
   * several cases need them, and this suite runs under
   * `vitest.config.integration.ts`'s 15s `testTimeout` — 225 sequential round
   * trips per case is a fixture that fails on a slow runner and reads as a
   * product bug when it does.
   */
  async function seedDistinctCampaigns(n: number, opts: { userId?: string } = {}) {
    const ids = Array.from({ length: n }, () => randomUUID());
    // 2026-01-01 + i days, so index 0 is the OLDEST. Every row is CLOSED a day
    // after it opened — a history is mostly closed rows, and only open rows are
    // constrained by migration 064's partial index.
    const assignedAt = ids.map((_, i) => new Date(Date.UTC(2026, 0, 1) + i * 86_400_000));
    await getTestPool().query(
      `INSERT INTO agency_campaign_agents
         (tenant_id, account_id, campaign_id, user_id, assigned_by, assigned_at, unassigned_at)
       SELECT $1, $2, c.campaign_id, $3, $4, c.assigned_at, c.assigned_at + interval '1 day'
         FROM unnest($5::uuid[], $6::timestamptz[]) AS c(campaign_id, assigned_at)`,
      [
        tenant.id,
        account.id,
        opts.userId ?? agent.id,
        colleague.id,
        ids,
        assignedAt.map((d) => d.toISOString()),
      ],
    );
    return ids;
  }

  function campaignIdsOf(res: { json: () => { assignments: Array<{ campaign_id: string }> } }) {
    return res.json().assignments.map((a) => a.campaign_id);
  }

  /** How many DISTINCT campaigns the route asked the internal handler to name. */
  function coreLookupCount() {
    return mocks.proxyToCore.mock.calls.length;
  }

  // ═══ The shape, first — closed rows INCLUDED ═══════════════════════════════

  describe('the history includes CLOSED rows, which is the whole reason it exists', () => {
    it('returns a closed assignment that every other reader filters out', async () => {
      /**
       * `listActiveForUser`, `listActiveForCampaign` and `findActiveForUser` all
       * carry `unassigned_at IS NULL`, so until this route existed the history was
       * being written and was unreadable — storage paying for a promise no code
       * kept. Asserted against a row that is genuinely closed in the table.
       */
      const closedCampaign = randomUUID();
      await seedRow({
        campaignId: closedCampaign,
        assignedAt: new Date('2026-03-01T00:00:00.000Z'),
        unassignedAt: new Date('2026-03-15T00:00:00.000Z'),
      });

      const res = await get('/my-campaigns');

      expect(seen(res)).toMatchObject({ status: 200 });
      expect(campaignIdsOf(res)).toEqual([closedCampaign]);
      const [row] = res.json().assignments;
      expect(row.active).toBe(false);
      // The raw timestamp, not just the boolean: "when did I come off this
      // campaign" is the question a dispute asks and it is not recoverable from
      // `active` alone.
      expect(new Date(row.unassigned_at).toISOString()).toBe('2026-03-15T00:00:00.000Z');
    });

    it('reports an OPEN row as active with a null unassigned_at', async () => {
      const openCampaign = randomUUID();
      await seedRow({
        campaignId: openCampaign,
        assignedAt: new Date('2026-04-01T00:00:00.000Z'),
        unassignedAt: null,
      });

      const [row] = (await get('/my-campaigns')).json().assignments;

      expect(row.active).toBe(true);
      expect(row.unassigned_at).toBeNull();
    });

    it('carries all six keys on every row, present even when the internal handler cannot name it', async () => {
      // A live contract with the console: it reads `assignments`, and a
      // previous defect here rendered every agent's history empty.
      await seedRow({ campaignId: randomUUID(), assignedAt: new Date('2026-02-01T00:00:00.000Z') });
      mocks.proxyToCore.mockResolvedValue({ status: 404, body: { error: 'Not Found' } });

      const [row] = (await get('/my-campaigns')).json().assignments;

      expect(Object.keys(row).sort()).toEqual([
        'active', 'assigned_at', 'campaign_id', 'campaign_name', 'campaign_status', 'unassigned_at',
      ]);
      // Nulls, not absent keys: an absent key is indistinguishable from a client
      // that forgot to read it.
      expect(row.campaign_name).toBeNull();
      expect(row.campaign_status).toBeNull();
    });

    it('answers 200 with an empty array for someone never staffed', async () => {
      const res = await get('/my-campaigns');
      expect(seen(res)).toMatchObject({ status: 200 });
      expect(res.json()).toEqual({ assignments: [] });
      // And spends no internal round trip at all — there is nothing to name.
      expect(coreLookupCount()).toBe(0);
    });
  });

  // ═══ 1. HISTORY_LIMIT_MAX ═════════════════════════════════════════════════

  describe('HISTORY_LIMIT_MAX — a hard ceiling no query param can raise', () => {
    /**
     * The ceiling is a `LIMIT` inside `listAllForUser`, and `limit` is clamped in
     * the repository rather than trusted from the caller — "a repository that
     * accepts an unbounded number from a route is only as bounded as its least
     * careful caller". The route does not expose it at all.
     *
     * Fixtures are sized from the IMPORTED constant, so raising the ceiling moves
     * these cases with it instead of leaving a test that passes by being smaller
     * than the new limit.
     */
    it('clips the page at exactly the ceiling', async () => {
      await seedDistinctCampaigns(HISTORY_LIMIT_MAX + 25);

      const res = await get('/my-campaigns');

      expect(seen(res)).toMatchObject({ status: 200 });
      expect(res.json().assignments).toHaveLength(HISTORY_LIMIT_MAX);
    });

    it('keeps the NEWEST rows, which is what makes the ceiling useful', async () => {
      /**
       * `ORDER BY assigned_at DESC, id DESC` before `LIMIT`, so the rows that
       * survive the clip are the recent ones — the half of a history anybody is
       * looking at. Ascending order plus the same LIMIT would return the OLDEST
       * 200 rows: a page that is bounded, correct-looking, and useless.
       *
       * The 25 newest campaigns are asserted in order rather than just as a set,
       * because the ordering is what the clip depends on.
       */
      const oldestFirst = await seedDistinctCampaigns(HISTORY_LIMIT_MAX + 25);
      const expectedNewest = [...oldestFirst].reverse().slice(0, 25);

      const res = await get('/my-campaigns');

      expect(campaignIdsOf(res).slice(0, 25)).toEqual(expectedNewest);
      // And the very oldest rows are the ones dropped.
      expect(campaignIdsOf(res)).not.toContain(oldestFirst[0]);
    });

    it('cannot be raised by a query param, because the route accepts none', async () => {
      /**
       * `myCampaignsQuerySchema` names `from` and `to` and nothing else, and
       * `listAllForUser` clamps whatever it is handed. A `?limit=` is therefore
       * neither honoured nor an error — it is simply not part of this API. Pinned
       * because the tempting change is to "just pass it through", which hands an
       * `agent` the unbounded fan-out the ceiling exists to prevent.
       */
      await seedDistinctCampaigns(HISTORY_LIMIT_MAX + 25);

      const res = await get(`/my-campaigns?limit=${HISTORY_LIMIT_MAX + 25}`);

      expect(seen(res)).toMatchObject({ status: 200 });
      expect(res.json().assignments).toHaveLength(HISTORY_LIMIT_MAX);
    });

    it('never returns another tenant’s or another person’s rows, even under the ceiling', async () => {
      /**
       * The tenant and user predicates sit in the same statement as the read (the
       * first RBAC rule). Worth asserting alongside the ceiling
       * specifically: a `LIMIT` applied to an under-scoped query returns 200 rows
       * of somebody else's history and looks exactly as healthy as this does.
       */
      const mine = await seedDistinctCampaigns(3);
      await seedRow({
        campaignId: randomUUID(),
        assignedAt: new Date(Date.UTC(2026, 6, 1)),
        userId: colleague.id,
      });
      await seedRow({
        campaignId: randomUUID(),
        assignedAt: new Date(Date.UTC(2026, 6, 2)),
        tenantId: otherTenant.id,
        accountId: null,
      });

      const res = await get('/my-campaigns');

      expect(new Set(campaignIdsOf(res))).toEqual(new Set(mine));
    });
  });

  // ═══ 2. The from/to window ════════════════════════════════════════════════

  describe('the from/to window on assigned_at — what makes the ceiling non-lossy', () => {
    /**
     * `from`/`to` rather than a cursor, which is the shape `listAllForUser`'s own
     * docstring nominated: the question a staffing history answers is always about
     * a PERIOD ("was I on this campaign in March"). It is what makes the rows past
     * the ceiling reachable rather than lost.
     *
     * The window bounds `assigned_at` — the column the ordering is on — so
     * "newest first, capped" and "this period" compose rather than fight.
     */
    async function seedThreeMonths() {
      const jan = await seedRow({ campaignId: randomUUID(), assignedAt: new Date('2026-01-15T00:00:00.000Z') });
      const feb = await seedRow({ campaignId: randomUUID(), assignedAt: new Date('2026-02-15T00:00:00.000Z') });
      const mar = await seedRow({ campaignId: randomUUID(), assignedAt: new Date('2026-03-15T00:00:00.000Z') });
      return { jan, feb, mar };
    }

    /** Map assignment row ids back to the campaign ids the response reports. */
    async function campaignsFor(ids: string[]) {
      const { rows } = await getTestPool().query(
        `SELECT id, campaign_id FROM agency_campaign_agents WHERE id = ANY($1::uuid[])`,
        [ids],
      );
      return new Map((rows as Array<{ id: string; campaign_id: string }>)
        .map((r) => [r.id, r.campaign_id]));
    }

    it('from is INCLUSIVE — a row exactly on the boundary is returned', async () => {
      // `assigned_at >= $n`. A row landing precisely on a month boundary is the
      // ordinary case for a monthly report, and excluding it loses a real row.
      const onBoundary = await seedRow({
        campaignId: randomUUID(), assignedAt: new Date('2026-02-01T00:00:00.000Z'),
      });
      const map = await campaignsFor([onBoundary]);

      const res = await get('/my-campaigns?from=2026-02-01T00:00:00.000Z');

      expect(campaignIdsOf(res)).toEqual([map.get(onBoundary)]);
    });

    it('to is EXCLUSIVE — a row exactly on the boundary is NOT returned', async () => {
      /**
       * `assigned_at < $n`, deliberately, and the asymmetry with `from` is the
       * contract: two adjacent windows (`[Jan, Feb)` then `[Feb, Mar)`) partition
       * the history without double-counting a row on the seam. An inclusive `to`
       * would return that row in both.
       */
      await seedRow({ campaignId: randomUUID(), assignedAt: new Date('2026-02-01T00:00:00.000Z') });

      const res = await get('/my-campaigns?to=2026-02-01T00:00:00.000Z');

      expect(seen(res)).toMatchObject({ status: 200 });
      expect(res.json().assignments).toEqual([]);
    });

    it('windows to a single month out of three', async () => {
      const { feb } = await seedThreeMonths();
      const map = await campaignsFor([feb]);

      const res = await get('/my-campaigns?from=2026-02-01T00:00:00.000Z&to=2026-03-01T00:00:00.000Z');

      expect(campaignIdsOf(res)).toEqual([map.get(feb)]);
    });

    it('applies from and to independently', async () => {
      const { jan, feb, mar } = await seedThreeMonths();
      const map = await campaignsFor([jan, feb, mar]);

      const fromOnly = await get('/my-campaigns?from=2026-02-01T00:00:00.000Z');
      // Newest first, so March then February.
      expect(campaignIdsOf(fromOnly)).toEqual([map.get(mar), map.get(feb)]);

      const toOnly = await get('/my-campaigns?to=2026-03-01T00:00:00.000Z');
      expect(campaignIdsOf(toOnly)).toEqual([map.get(feb), map.get(jan)]);
    });

    it('reaches rows the CEILING dropped, which is its whole justification', async () => {
      /**
       * The two bounds working together, and the case that proves the ceiling is
       * not lossy. A history longer than `HISTORY_LIMIT_MAX` in a single recent
       * month makes the oldest rows unreachable on the unwindowed page; naming the
       * period they are in brings them back.
       */
      const old = await seedRow({
        campaignId: randomUUID(), assignedAt: new Date('2025-01-15T00:00:00.000Z'),
      });
      const oldCampaign = (await campaignsFor([old])).get(old);
      // A full ceiling's worth of MORE RECENT rows, which push the 2025 row out.
      await seedDistinctCampaigns(HISTORY_LIMIT_MAX);

      const unwindowed = await get('/my-campaigns');
      expect(unwindowed.json().assignments).toHaveLength(HISTORY_LIMIT_MAX);
      expect(campaignIdsOf(unwindowed)).not.toContain(oldCampaign);

      const windowed = await get(
        '/my-campaigns?from=2025-01-01T00:00:00.000Z&to=2025-02-01T00:00:00.000Z',
      );
      expect(campaignIdsOf(windowed)).toEqual([oldCampaign]);
    });

    it('REFUSES an unparseable window with a 400 carrying details', async () => {
      /**
       * Refused rather than coerced. A silently-dropped `from` answers with the
       * wrong period under a 200 — the same class of failure as the dropped `phone`
       * filter on the attempt spine: a control that appears to have worked.
       *
       * `details` matters because `errorMaskHook` forwards a 4xx carrying
       * field-level validation feedback and masks a bare one, so a 400 without it
       * reaches the user as "contact support and quote this request id".
       */
      await seedDistinctCampaigns(2);

      const res = await get('/my-campaigns?from=last-tuesday');

      expect(seen(res)).toMatchObject({ status: 400 });
      expect(res.json()).toMatchObject({ error: 'Validation Error' });
      expect(res.json().details).toBeDefined();
      // And nothing was read or looked up for a request that was refused.
      expect(coreLookupCount()).toBe(0);
    });

    it('refuses a date-only `from`, because the schema wants a full instant', async () => {
      // `z.string().datetime()`. `2026-02-01` is the shape a hand-built query
      // string most often carries, so its refusal is the one a client will meet.
      const res = await get('/my-campaigns?from=2026-02-01');

      expect(seen(res)).toMatchObject({ status: 400 });
      expect(res.json().details).toBeDefined();
    });
  });

  // ═══ 3. SUMMARY_LOOKUP_MAX ════════════════════════════════════════════════

  describe('SUMMARY_LOOKUP_MAX — the cap on how many campaigns get NAMED', () => {
    /**
     * The row ceiling alone does not bound the fan-out usefully: 200 rows can be
     * 200 distinct campaigns, and each name is an internal round trip with the agent's
     * console blocked on it. Rows arrive newest-first, so the first
     * `SUMMARY_LOOKUP_MAX` distinct ids are the recent ones and the rest report
     * `campaign_name: null` — which this route already documents as its NORMAL
     * path, since a history is the surface most likely to name campaigns that have
     * since been deleted.
     *
     * The constant is module-private, so it is asserted through the only two
     * things a caller can see: how many internal calls happened, and which rows came
     * back named. That is the right way round — a test reaching into the module
     * would pass against a route that had stopped applying it.
     */
    it('names only a bounded PREFIX of the history, and nulls the rest', async () => {
      // Well past any plausible cap, and past it by enough that an off-by-one
      // cannot be mistaken for the cap itself.
      const oldestFirst = await seedDistinctCampaigns(120);
      const newestFirst = [...oldestFirst].reverse();
      mocks.proxyToCore.mockImplementation(async ({ path }: { path: string }) => ({
        status: 200,
        // Name each campaign after itself, so a row's name identifies which
        // lookup produced it.
        body: { id: path.split('/').pop(), name: `name-${path.split('/').pop()}`, status: 'running' },
      }));

      const res = await get('/my-campaigns');
      const rows = res.json().assignments as Array<{ campaign_id: string; campaign_name: string | null }>;

      expect(rows).toHaveLength(120);
      const named = rows.filter((r) => r.campaign_name !== null);
      const unnamed = rows.filter((r) => r.campaign_name === null);

      // Bounded well below the page — the property, without hard-coding the cap.
      expect(named.length).toBeLessThan(rows.length);
      expect(unnamed.length).toBeGreaterThan(0);
      // One internal call per NAMED campaign and not one more.
      expect(coreLookupCount()).toBe(named.length);

      // The named ones are a PREFIX of the newest-first order — not an arbitrary
      // subset. This is what makes the degradation predictable rather than random.
      expect(named.map((r) => r.campaign_id))
        .toEqual(newestFirst.slice(0, named.length));
      // Every named row's caption came from ITS OWN lookup.
      for (const row of named) {
        expect(row.campaign_name).toBe(`name-${row.campaign_id}`);
      }
    });

    it('names everything when the history is comfortably inside the cap', async () => {
      // The contrast case: without it, "bounded" would also be satisfied by a
      // route that named nothing.
      const ids = await seedDistinctCampaigns(5);
      mocks.proxyToCore.mockImplementation(async ({ path }: { path: string }) => ({
        status: 200,
        body: { id: path.split('/').pop(), name: `name-${path.split('/').pop()}`, status: 'paused' },
      }));

      const rows = (await get('/my-campaigns')).json().assignments as
        Array<{ campaign_id: string; campaign_name: string; campaign_status: string }>;

      expect(rows).toHaveLength(5);
      expect(rows.every((r) => r.campaign_name === `name-${r.campaign_id}`)).toBe(true);
      expect(rows.every((r) => r.campaign_status === 'paused')).toBe(true);
      expect(coreLookupCount()).toBe(5);
      expect(new Set(ids)).toEqual(new Set(rows.map((r) => r.campaign_id)));
    });

    // There is no API key to resolve (the hop is `callCore`), so no key-resolution cases. The
    // "no internal call for an empty history" half is pinned by
    // 'answers 200 with an empty array for someone never staffed'.
  });

  // ═══ 4. X-Staffing-Truncated ══════════════════════════════════════════════

  describe('X-Staffing-Truncated — a HEADER, not a body key', () => {
    /**
     * A header rather than a body key deliberately: the customer UI reads
     * `assignments`, and a previous defect on this table rendered every agent's
     * history empty — so the truncation signal must not be something a client has
     * to restructure its parsing to see.
     *
     * "A full page is not proof there is more, but it is the only signal the
     * ceiling can give without a second COUNT, and reporting possibly-truncated is
     * the safe direction." So the boundary case (exactly `HISTORY_LIMIT_MAX` rows,
     * with nothing beyond) DOES set it, and that is correct rather than a bug —
     * pinned below so the over-report is a known choice.
     */
    it('is absent on a page comfortably under the ceiling', async () => {
      await seedDistinctCampaigns(5);

      const res = await get('/my-campaigns');

      expect(res.headers['x-staffing-truncated']).toBeUndefined();
    });

    it('is absent on an EMPTY history', async () => {
      const res = await get('/my-campaigns');
      expect(res.headers['x-staffing-truncated']).toBeUndefined();
    });

    it('is set once the page is genuinely clipped', async () => {
      await seedDistinctCampaigns(HISTORY_LIMIT_MAX + 10);

      const res = await get('/my-campaigns');

      expect(res.json().assignments).toHaveLength(HISTORY_LIMIT_MAX);
      expect(res.headers['x-staffing-truncated']).toBe('true');
    });

    it('is set on a page of EXACTLY the ceiling with nothing beyond — deliberately over-reported', async () => {
      /**
       * The predicate is `assignments.length >= HISTORY_LIMIT_MAX`, so a history of
       * exactly 200 rows reports "possibly truncated" when in fact nothing was
       * dropped. That is the safe direction and it is the choice the route
       * documents; the alternative is a second `COUNT(*)` over a table that only
       * grows, on a route an agent's console polls.
       *
       * Pinned so the false positive is a known property rather than a bug report,
       * and so a future change to `>` is a deliberate one.
       */
      await seedDistinctCampaigns(HISTORY_LIMIT_MAX);

      const res = await get('/my-campaigns');

      expect(res.json().assignments).toHaveLength(HISTORY_LIMIT_MAX);
      expect(res.headers['x-staffing-truncated']).toBe('true');
    });

    it('is NOT set on a narrow window over a history that would otherwise clip', async () => {
      /**
       * The remedy the header exists to prompt — "narrow the window with
       * ?from=/?to=" — actually working. Without this case the header could be a
       * permanent fixture on any large history and nothing would notice.
       */
      await seedDistinctCampaigns(HISTORY_LIMIT_MAX + 10);
      // One row far outside that block, reachable only by naming its period.
      await seedRow({ campaignId: randomUUID(), assignedAt: new Date('2024-05-05T00:00:00.000Z') });

      const res = await get(
        '/my-campaigns?from=2024-05-01T00:00:00.000Z&to=2024-06-01T00:00:00.000Z',
      );

      expect(res.json().assignments).toHaveLength(1);
      expect(res.headers['x-staffing-truncated']).toBeUndefined();
    });
  });

  // ═══ 5. The same campaign twice — dedupe and order-preserving lookup ══════

  describe('a re-staffing puts the same campaign in the history TWICE', () => {
    /**
     * The ordinary shape after a handover: staffed in January, unstaffed in
     * February, staffed again in March. Both rows belong in the history — that is
     * what a history is — and the route must not collapse them.
     *
     * What IS deduplicated is the LOOKUP: `[...new Set(assignments.map(a =>
     * a.campaign_id))]` before the fan-out, so one campaign costs one internal round
     * trip however many rows name it. `Set` preserves insertion order, which is
     * what keeps `slice(0, SUMMARY_LOOKUP_MAX)` taking the RECENT campaigns and
     * what lets `summaries.get(...)` pair each row with its own answer. A dedupe
     * that sorted or re-ordered would break both halves at once.
     */
    it('returns BOTH rows, newest first, each with its own dates', async () => {
      const campaign = randomUUID();
      await seedRow({
        campaignId: campaign,
        assignedAt: new Date('2026-01-10T00:00:00.000Z'),
        unassignedAt: new Date('2026-02-10T00:00:00.000Z'),
      });
      await seedRow({
        campaignId: campaign,
        assignedAt: new Date('2026-03-10T00:00:00.000Z'),
        unassignedAt: null,
      });

      const rows = (await get('/my-campaigns')).json().assignments as Array<{
        campaign_id: string; assigned_at: string; unassigned_at: string | null; active: boolean;
      }>;

      expect(rows).toHaveLength(2);
      expect(rows.map((r) => r.campaign_id)).toEqual([campaign, campaign]);
      // Newest first: the current stint, then the earlier one.
      expect(rows.map((r) => r.active)).toEqual([true, false]);
      expect(new Date(rows[0]!.assigned_at).toISOString()).toBe('2026-03-10T00:00:00.000Z');
      expect(rows[0]!.unassigned_at).toBeNull();
      expect(new Date(rows[1]!.assigned_at).toISOString()).toBe('2026-01-10T00:00:00.000Z');
      expect(new Date(rows[1]!.unassigned_at!).toISOString()).toBe('2026-02-10T00:00:00.000Z');
    });

    it('spends ONE internal round trip for a campaign named by several rows', async () => {
      const campaign = randomUUID();
      for (let i = 0; i < 6; i += 1) {
        await seedRow({
          campaignId: campaign,
          assignedAt: new Date(Date.UTC(2026, i, 1)),
        });
      }

      const res = await get('/my-campaigns');

      expect(res.json().assignments).toHaveLength(6);
      expect(coreLookupCount()).toBe(1);
    });

    it('gives every row of a repeated campaign the SAME name', async () => {
      /**
       * `summaries.get(assignment.campaign_id)` for each row rather than a
       * positional zip, so the dedupe cannot mis-pair. A positional
       * implementation over a deduped lookup list is the natural bug here and it
       * would name row 2 with row 1's answer.
       */
      const repeated = randomUUID();
      const other = randomUUID();
      await seedRow({ campaignId: repeated, assignedAt: new Date(Date.UTC(2026, 0, 1)) });
      await seedRow({ campaignId: other, assignedAt: new Date(Date.UTC(2026, 1, 1)) });
      await seedRow({ campaignId: repeated, assignedAt: new Date(Date.UTC(2026, 2, 1)) });
      mocks.proxyToCore.mockImplementation(async ({ path }: { path: string }) => ({
        status: 200,
        body: { id: path.split('/').pop(), name: `name-${path.split('/').pop()}`, status: 'running' },
      }));

      const rows = (await get('/my-campaigns')).json().assignments as
        Array<{ campaign_id: string; campaign_name: string }>;

      // Two lookups for three rows.
      expect(coreLookupCount()).toBe(2);
      for (const row of rows) {
        expect(row.campaign_name, `row for ${row.campaign_id}`).toBe(`name-${row.campaign_id}`);
      }
    });

    it('resolves the RECENT campaigns when the distinct count exceeds the cap', async () => {
      /**
       * The order-preserving half of the dedupe, under the cap that makes it
       * matter. `Set` iterates in insertion order and the rows arrive newest-first,
       * so `slice` keeps the recent campaigns. A dedupe via a sorted structure —
       * or one built from a `Map` keyed differently — would still produce the right
       * COUNT of lookups while naming an arbitrary subset, which no count-based
       * assertion can catch.
       */
      const oldestFirst = await seedDistinctCampaigns(120);
      const newestFirst = [...oldestFirst].reverse();
      const lookedUp: string[] = [];
      mocks.proxyToCore.mockImplementation(async ({ path }: { path: string }) => {
        lookedUp.push(path.split('/').pop()!);
        return { status: 200, body: { id: 'x', name: 'named', status: 'running' } };
      });

      await get('/my-campaigns');

      // Whatever the cap is, the campaigns asked about are the newest ones, in
      // order. Compared as a prefix so the cap's value stays out of the assertion.
      expect(lookedUp).toEqual(newestFirst.slice(0, lookedUp.length));
      expect(lookedUp.length).toBeGreaterThan(0);
      expect(lookedUp.length).toBeLessThan(120);
    });
  });

  // ═══ The floor, since this route exists for the lowest role there is ══════

  describe('reachable by a BARE agent, and refused for an unattributable caller', () => {
    it('a bare agent gets their own history', async () => {
      /**
       * The single most important case on this route: `agent` is hierarchy level 5,
       * below `viewer`, so it inherits nothing that predates the agency feature. A
       * floor one notch higher — `proxy.contact_lists.read`, which the neighbouring
       * campaign reads use — 403s the only role this route exists for while reading
       * as entirely reasonable in review.
       */
      const ids = await seedDistinctCampaigns(2);

      const res = await get('/my-campaigns', headers({ 'x-user-id': agent.id }));

      expect(seen(res)).toMatchObject({ status: 200 });
      expect(new Set(campaignIdsOf(res))).toEqual(new Set(ids));
    });

    // There are no platform API keys; `resolveMyAgentId`'s remaining branch
    // (no user id → 400 `missing_actor`) is pinned in the unit suite. There is no governance
    // and no `requireCapability('agency')`.
  });
});
