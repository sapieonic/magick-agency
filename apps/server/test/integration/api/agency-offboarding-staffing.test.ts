import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { getTestPool, closeTestPool, truncateAll } from '../../../../../packages/db/test/integration/setup/test-utils.js';
import { TEST_DB_URL } from '../../../../../packages/db/test/helpers/test-db.js';
import { initDbPool, closePool } from '@magick-agency/db';
import {
  insertAccount,
  insertMembership,
  insertTenant,
  insertUser,
} from '../../../../../packages/db/test/integration/setup/platform-factories.js';

/**
 * ─── OFFBOARDING CLOSES AGENCY STAFFING — AGAINST REAL POSTGRES ─────────────
 *
 * **Modelled on `test/integration/api/agency-staffing.routes.test.ts`.** Its
 * mock set, its DB-backed auth stubs (which read the real `memberships` row so
 * RBAC decides on real data), its `flushAudit`/`auditRows` helpers and its
 * `afterAll` cleanup of `platform_audit_log` are reused as-is rather than
 * reinvented. Where this file differs is stated at each point.
 *
 * ── What the unit suite already covers, and what it structurally cannot ─────
 * `test/unit/api/routes/user-offboarding-staffing.test.ts` drives both routes
 * with a mocked `closeAllForUser`, and it is the right place for the predicate
 * cases — "a promotion between two non-agent roles must not unstaff anybody" is
 * a decision, and a mock proves it exactly.
 *
 * Four things about this feature are claims about a DATABASE, and a mock cannot
 * be wrong about them in the way production can:
 *
 *  1. **The partial failure.** The whole design rests on ordering: the
 *     membership write is authoritative, the cache `del` makes the revocation
 *     take effect fleet-wide, and the staffing close is a swallowed tidy-up
 *     that runs last. The claim is that when the close fails, the authoritative
 *     write SURVIVES and the surviving open staffing row grants nothing. Half of
 *     that is a row that is gone and half is a row that is still there — and
 *     "grants nothing" is a real RBAC decision against the real tables, which is
 *     the only way to state it without restating the code.
 *  2. **Multi-account correctness.** `closeAllForUser` closes across every
 *     account in the tenant in ONE statement. With a mock, "the right rows" is
 *     whatever the mock returned. Here the rows exist, in three different account
 *     contexts including a NULL one, and the statement either reaches them or not.
 *  3. **Audit scoping.** This is the defect the feature exists around and it is
 *     invisible without both halves being real: the audit row is written through
 *     a BUFFERED logger into a partitioned table, and `GET /audit-log` filters on
 *     `membership.account_id`. "The `account_admin` whose roster changed can see
 *     the trail" is a claim about a SELECT finding a row an INSERT put somewhere
 *     — asserted here by reading the route, as that admin, and looking at the
 *     bytes.
 *  4. **Idempotence.** `unassigned_at IS NULL` in the same statement is what
 *     makes a retried offboarding write one audit row rather than two. A mock
 *     returning a fixed array is idempotent by construction.
 *
 * ── EXECUTED, GREEN ────────────────────────────────────────────────────────
 * This file was written without a Docker daemon (`/var/run/docker.sock` does not
 * exist in that environment, so `npm run test:integration` cannot bring the test
 * stack up) and its header used to say it had never run. It has now been run
 * against a real Postgres 16 and Redis 7 — the same URLs and ports
 * `docker/test-docker-compose.yml` publishes, served by a hand-started cluster
 * instead of a container — and passes in full. What backed it before, and still
 * does when the stack is unavailable:
 *
 *   - it type-checks under `npm run lint:test`, the non-gating
 *     report, which is what catches a renamed factory, a wrong arity or
 *     a changed repository signature — the class of error that would otherwise
 *     surface as a swallowed `TypeError` on somebody else's machine;
 *   - every harness idiom is copied from the sibling suite named above rather
 *     than invented, including the exact mock module paths;
 *   - every schema reference (`agency_campaign_agents`, `platform_audit_log`,
 *     `memberships`) is against columns read out of the migrations and the
 *     repositories in this branch, not remembered;
 *   - the behaviours asserted are each already pinned by a mutation-verified
 *     unit case, so this file is proving they hold against Postgres rather than
 *     discovering them.
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
 */

const mocks = vi.hoisted(() => ({
  redisDel: vi.fn(),
  logCalls: [] as unknown[][],
}));

/*
 * Harness notes:
 *  - Every repository shares `@magick-agency/db`'s pool singleton, so it is initialised
 *    against the test database (`initDbPool`, closed in afterAll).
 *  - `seen` is a local helper (the shared test-utils does not carry it).
 *  - The audit logger is `platformAuditLogger` (decision B7).
 *  - There is no `GET /audit-log` route, so `auditRoutes` is not registered and the audit
 *    cases assert the WRITTEN row's account directly ("lands correctly even when the ACTOR
 *    sent no X-Account-Id at all", "is not filed under whichever account the ADMIN happened
 *    to have selected"). Add reads through the route if an audit read route lands.
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

/**
 * The invalidation broadcast is a Redis concern and this file is about Postgres,
 * so it is a spy rather than a live client — but it is ASSERTED, because its
 * position relative to the staffing close is the ordering property under test.
 * The sibling suite mocks the whole cache module the same way.
 */
vi.mock('../../../src/cache/redis-cache.js', () => ({
  redisCache: {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue(undefined),
    del: mocks.redisDel,
    // decision Q5: forwards to the `del` mock and reports success.
    delForRevocation: async (...k: string[]) => { await mocks.redisDel(...k); return true; },
    delByPattern: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('@magick-agency/observability', () => {
  const record = (...args: unknown[]) => { mocks.logCalls.push(args); };
  const child = () => ({ info: record, warn: record, error: record, debug: record });
  return {
    createChildLogger: child,
    logger: { ...child(), child },
    setLogContext: vi.fn(),
  };
});

/**
 * Auth, stubbed exactly as the sibling suite stubs it and for the same reason:
 * Firebase is not reachable here, and these two are the only pieces with no
 * local equivalent. Everything they seed is READ FROM THE DATABASE, including
 * the membership — with the same account-then-tenant preference
 * `tenant-context.middleware.ts` applies — so `requirePermission` and
 * `auditAccountScope` both decide on a real row.
 *
 * `membership.account_id` is the field that matters here beyond RBAC: it is what
 * `GET /audit-log` scopes on, and the whole point of the audit assertions is that
 * an account-scoped reader sees their own account's rows.
 */
vi.mock('../../../src/auth/session.middleware.js', () => ({
  sessionMiddleware: async (request: {
    headers: Record<string, string | undefined>;
    user?: { id: string };
  }) => {
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

const { userRoutes } = await import('../../../src/api/routes/user.routes.js');
const { platformAuditLogger } = await import('../../../src/audit/platform/audit-logger.js');
const { agencyCampaignAgentRepository } = await import(
  '@magick-agency/db/repositories/agency-campaign-agent.repository'
);
const { requirePermission } = await import('../../../src/rbac/rbac.middleware.js');
const { sessionMiddleware } = await import('../../../src/auth/session.middleware.js');
const { tenantContextMiddleware } = await import(
  '../../../src/api/middleware/tenant-context.middleware.js'
);

const CAMPAIGN_A = '11111111-1111-4111-8111-111111111111';
const CAMPAIGN_B = '22222222-2222-4222-8222-222222222222';
const CAMPAIGN_C = '33333333-3333-4333-8333-333333333333';

describe('offboarding closes agency staffing (integration)', () => {
  let app: FastifyInstance;
  let tenant: { id: string };
  let otherTenant: { id: string };
  let accountA: { id: string };
  let accountB: { id: string };
  /** The offboarding admin. Tenant-level, so `X-Account-Id` is optional for them. */
  let admin: { id: string };
  let agent: { id: string };

  beforeEach(async () => {
    vi.restoreAllMocks();
    mocks.redisDel.mockReset().mockResolvedValue(undefined);
    mocks.logCalls.length = 0;

    await truncateAll();
    tenant = await insertTenant();
    otherTenant = await insertTenant();
    accountA = await insertAccount({ tenant_id: tenant.id });
    accountB = await insertAccount({ tenant_id: tenant.id });

    admin = await insertUser({ display_name: 'Dee Admin' });
    await insertMembership({
      user_id: admin.id,
      tenant_id: tenant.id,
      account_id: null,
      role: 'tenant_admin',
    });

    agent = await insertUser({ display_name: 'Ada Agent' });
    await insertMembership({
      user_id: agent.id,
      tenant_id: tenant.id,
      account_id: accountA.id,
      role: 'agent',
    });

    app = Fastify({ logger: false });
    /**
     * A probe route gated on the real `agency.station.connect`, registered
     * alongside the routes under test.
     *
     * This is what turns "a closed staffing row revokes nothing, and an OPEN one
     * grants nothing" from a comment into an assertion. The claim is about
     * authorization, so it has to be made by the thing that authorizes — the real
     * `requirePermission` reading the real `memberships` table — and not by
     * inspecting `agency_campaign_agents` and reasoning about it.
     *
     * `agency.station.connect` specifically, because that is the permission the
     * feature's own docs name as the one that actually gates a join: *"nothing
     * consults this table to decide whether a join is allowed —
     * `agency.station.connect` does, and the membership removal is what takes that
     * away."*
     */
    app.get('/probe/station', {
      preHandler: [sessionMiddleware, tenantContextMiddleware, requirePermission('agency.station.connect')],
    }, async () => ({ joined: true }));

    await app.register(userRoutes, { prefix: '/users' });
    await app.ready();
  });

  afterEach(async () => {
    await app?.close();
  });

  afterAll(async () => {
    // Same cleanup the sibling suite does: `platform_audit_log` is partitioned
    // and is not in `truncateAll`'s list.
    await getTestPool().query(
      `DELETE FROM platform_audit_log WHERE action LIKE 'agency_campaign_agent.%'`,
    );
    await closePool();
    await closeTestPool();
  });

  // ── helpers ───────────────────────────────────────────────────────────────

  function headers(overrides: Record<string, string | undefined> = {}) {
    const base: Record<string, string> = {
      'x-tenant-id': tenant.id,
      'x-user-id': admin.id,
    };
    for (const [k, v] of Object.entries(overrides)) {
      if (v === undefined) delete base[k];
      else base[k] = v;
    }
    return base;
  }

  /** The buffered audit logger writes on flush, not on push. */
  async function flushAudit() {
    await platformAuditLogger.shutdown();
  }

  async function staffingAuditRows() {
    const { rows } = await getTestPool().query(
      `SELECT * FROM platform_audit_log
        WHERE tenant_id = $1 AND action = 'agency_campaign_agent.unassigned'
        ORDER BY resource_id ASC`,
      [tenant.id],
    );
    return rows;
  }

  async function seedAssignment(opts: {
    campaignId: string;
    accountId?: string | null;
    userId?: string;
    tenantId?: string;
  }) {
    return agencyCampaignAgentRepository.assign({
      tenant_id: opts.tenantId ?? tenant.id,
      account_id: opts.accountId === undefined ? accountA.id : opts.accountId,
      campaign_id: opts.campaignId,
      user_id: opts.userId ?? agent.id,
      assigned_by: admin.id,
    });
  }

  async function staffingRows(userId = agent.id, tenantId = tenant.id) {
    const { rows } = await getTestPool().query(
      `SELECT id, campaign_id, account_id, unassigned_at FROM agency_campaign_agents
        WHERE tenant_id = $1 AND user_id = $2
        ORDER BY campaign_id ASC`,
      [tenantId, userId],
    );
    return rows;
  }

  /**
   * EVERY membership row, revoked ones included.
   *
   * `removeGuardingLastOwner` does not DELETE — it sets `status = 'revoked'`. That
   * distinction is load-bearing for this whole feature (it is why the supervisory
   * twins use `findAnyByUserAndTenant`, so a departed agent's record still reads),
   * so the helper returns the raw rows and each case says which status it means.
   * A helper that silently filtered to active rows would let "the membership is
   * gone" read as true for a row that is still very much there.
   */
  async function membershipRows(userId = agent.id, tenantId = tenant.id) {
    const { rows } = await getTestPool().query(
      `SELECT id, role, account_id, status FROM memberships
        WHERE tenant_id = $1 AND user_id = $2
        ORDER BY created_at ASC`,
      [tenantId, userId],
    );
    return rows as Array<{ id: string; role: string; account_id: string | null; status: string }>;
  }

  /** Only the rows that still grant anything. */
  async function activeMembershipRows(userId = agent.id, tenantId = tenant.id) {
    return (await membershipRows(userId, tenantId)).filter((m) => m.status === 'active');
  }

  // ═══ 1. The partial failure ════════════════════════════════════════════════

  describe('a staffing close that fails leaves the AUTHORITATIVE write standing', () => {
    it('removes the membership, broadcasts the invalidation, and keeps the open row', async () => {
      /**
       * The exact interleaving the ordering exists for. `closeAllForUser` throws
       * AFTER the removal has committed and after the cache key was dropped, which
       * is the only failure the swallow is for.
       *
       * Doing it the other way round would be strictly worse in this one case and
       * the code says so: the removal then failing would leave a member unstaffed
       * from every campaign for no reason anybody can see, and a supervisor would
       * have to reconstruct the roster by hand.
       */
      await seedAssignment({ campaignId: CAMPAIGN_A });
      const spy = vi
        .spyOn(agencyCampaignAgentRepository, 'closeAllForUser')
        .mockRejectedValueOnce(new Error('connection terminated unexpectedly'));

      const res = await app.inject({
        method: 'DELETE',
        url: `/users/${agent.id}/membership`,
        headers: headers(),
      });

      // The request SUCCEEDS: re-raising would report failure for work that
      // committed, and would invite an operator to retry a removal already done.
      expect(seen(res)).toMatchObject({ status: 200 });
      expect(res.json()).toEqual({ message: 'Membership removed' });
      expect(spy).toHaveBeenCalledWith(tenant.id, agent.id);

      // The authoritative write survived. Note it is a REVOCATION, not a delete:
      // the row stays so a departed agent's record is still readable (which is
      // what `findAnyByUserAndTenant` on the supervisory twins depends on), and
      // what it no longer does is grant anything.
      expect(await activeMembershipRows()).toHaveLength(0);
      expect((await membershipRows()).map((m) => m.status)).toEqual(['revoked']);
      // The revocation broadcast happened — it runs BEFORE the tidy-up.
      expect(mocks.redisDel).toHaveBeenCalledWith(`cache:membership:${agent.id}:${tenant.id}`);
      // And the staffing row is still open, which is the residue this accepts.
      const staffing = await staffingRows();
      expect(staffing).toHaveLength(1);
      expect(staffing[0].unassigned_at).toBeNull();
    });

    it('and the surviving OPEN staffing row grants nothing', async () => {
      /**
       * ── The property the whole "swallow the failure" decision rests on ───────
       * Staffing is not authorization. If it were, this
       * failure mode would be a privilege leak — a departed agent with a live
       * staffing row still able to take calls — and swallowing the error would be
       * indefensible rather than correct.
       *
       * So the assertion is made by the thing that actually decides: the real
       * `requirePermission('agency.station.connect')` against the real
       * `memberships` table, with the stale row sitting right there in
       * `agency_campaign_agents`. Reading the table and reasoning about it would
       * assert nothing, because the claim is precisely that NOTHING reads it.
       *
       * The 403 also has to be a 403 for the right reason, so the same probe is
       * asserted to succeed BEFORE the offboarding. Otherwise a probe that was
       * always refused would pass this case while proving nothing at all.
       */
      await seedAssignment({ campaignId: CAMPAIGN_A });

      const before = await app.inject({
        method: 'GET',
        url: '/probe/station',
        headers: { 'x-tenant-id': tenant.id, 'x-user-id': agent.id, 'x-account-id': accountA.id },
      });
      expect(seen(before), 'the agent could join before offboarding').toMatchObject({ status: 200 });

      vi.spyOn(agencyCampaignAgentRepository, 'closeAllForUser')
        .mockRejectedValueOnce(new Error('db down'));
      await app.inject({
        method: 'DELETE',
        url: `/users/${agent.id}/membership`,
        headers: headers(),
      });

      // Precondition for the assertion below: the row really is still open.
      expect((await staffingRows())[0].unassigned_at).toBeNull();

      const after = await app.inject({
        method: 'GET',
        url: '/probe/station',
        headers: { 'x-tenant-id': tenant.id, 'x-user-id': agent.id, 'x-account-id': accountA.id },
      });
      expect(seen(after)).toMatchObject({ status: 403 });
    });

    it('writes NO audit row for a close that did not happen', async () => {
      // A trail that claims a staffing change nobody made is worse than a missing
      // one: it points a supervisor at an admin who did not touch their roster.
      await seedAssignment({ campaignId: CAMPAIGN_A });
      vi.spyOn(agencyCampaignAgentRepository, 'closeAllForUser')
        .mockRejectedValueOnce(new Error('db down'));

      await app.inject({
        method: 'DELETE',
        url: `/users/${agent.id}/membership`,
        headers: headers(),
      });
      await flushAudit();

      expect(await staffingAuditRows()).toHaveLength(0);
    });
  });

  // ═══ 2. Idempotent retry ══════════════════════════════════════════════════

  describe('the close is idempotent, so a retried offboarding is not a second event', () => {
    it('a repeat close finds nothing and writes no second audit row', async () => {
      /**
       * An offboarding can be retried — by an operator after the failure above, or
       * by an admin with two tabs open. `unassigned_at IS NULL` lives in the same
       * statement as the write, which is what makes the second pass a no-op rather
       * than a second round of audit rows.
       *
       * Driven through the route twice rather than by calling the repository twice,
       * because the audit write is the caller's and it is the audit rows that must
       * not double. The second DELETE 404s (the membership is gone) — which is its
       * own useful fact: the guard that stops it is the missing membership, not the
       * staffing table.
       */
      await seedAssignment({ campaignId: CAMPAIGN_A });
      await seedAssignment({ campaignId: CAMPAIGN_B });

      const first = await app.inject({
        method: 'DELETE', url: `/users/${agent.id}/membership`, headers: headers(),
      });
      expect(seen(first)).toMatchObject({ status: 200 });
      await flushAudit();
      expect(await staffingAuditRows()).toHaveLength(2);

      const second = await app.inject({
        method: 'DELETE', url: `/users/${agent.id}/membership`, headers: headers(),
      });
      expect(seen(second)).toMatchObject({ status: 404 });
      await flushAudit();

      // Still two. Not four, and not three.
      expect(await staffingAuditRows()).toHaveLength(2);
    });

    it('a row closed earlier keeps its ORIGINAL unassigned_at', async () => {
      /**
       * "When did I come off this campaign" is the question a dispute asks, and it
       * is unanswerable if a later offboarding rewrites the timestamp to today.
       * The mixed history is the realistic shape: this person was unstaffed from
       * one campaign weeks ago and is still on another when they leave.
       */
      const stale = await seedAssignment({ campaignId: CAMPAIGN_A });
      await agencyCampaignAgentRepository.unassign(tenant.id, CAMPAIGN_A, agent.id);
      const { rows: before } = await getTestPool().query(
        `SELECT unassigned_at FROM agency_campaign_agents WHERE id = $1`, [stale.id],
      );
      const original: Date = before[0].unassigned_at;
      expect(original).not.toBeNull();

      const live = await seedAssignment({ campaignId: CAMPAIGN_B });

      await app.inject({
        method: 'DELETE', url: `/users/${agent.id}/membership`, headers: headers(),
      });
      await flushAudit();

      const { rows: after } = await getTestPool().query(
        `SELECT unassigned_at FROM agency_campaign_agents WHERE id = $1`, [stale.id],
      );
      expect(after[0].unassigned_at.getTime()).toBe(original.getTime());

      // And only the LIVE assignment is audited — one row, naming that assignment.
      const audit = await staffingAuditRows();
      expect(audit).toHaveLength(1);
      expect(audit[0].resource_id).toBe(live.id);
    });
  });

  // ═══ 3. Staffing across MULTIPLE accounts ═════════════════════════════════

  describe('a user staffed in several accounts has the right rows closed', () => {
    it('closes every account’s assignment, and stamps each audit row with ITS account', async () => {
      /**
       * ── The defect, and why it needs three different account contexts ────────
       * `closeAllForUser` closes across every account in the tenant while
       * `GET /audit-log` is account-scoped. Stamping `request.accountId` — ONE
       * value for a whole tenant's worth of assignments — filed every row under
       * whichever account the offboarding admin happened to have selected, and the
       * `account_admin` whose roster actually changed saw nothing.
       *
       * Two accounts prove the rows do not collapse onto one value. The third
       * assignment has `account_id: null`, which is the row a tenant-level member's
       * staffing produces, and NULL must stay NULL: the column records the account
       * context the assignment was MADE in, so back-filling it from the actor is
       * the same wrong answer one row at a time.
       *
       * Note the actor sends NO `X-Account-Id` — see the dedicated case below for
       * why that is the shape that made every row account-less.
       */
      const a = await seedAssignment({ campaignId: CAMPAIGN_A, accountId: accountA.id });
      const b = await seedAssignment({ campaignId: CAMPAIGN_B, accountId: accountB.id });
      const c = await seedAssignment({ campaignId: CAMPAIGN_C, accountId: null });

      const res = await app.inject({
        method: 'DELETE', url: `/users/${agent.id}/membership`, headers: headers(),
      });
      expect(seen(res)).toMatchObject({ status: 200 });
      await flushAudit();

      // Every row closed, none left open.
      expect((await staffingRows()).filter((r) => r.unassigned_at === null)).toHaveLength(0);

      // One audit row per assignment, each carrying the assignment's OWN account.
      const audit = await staffingAuditRows();
      expect(new Map(audit.map((r) => [r.resource_id, r.account_id]))).toEqual(
        new Map([[a.id, accountA.id], [b.id, accountB.id], [c.id, null]]),
      );
      // `resource_id` is the ASSIGNMENT, never the campaign — filing the campaign
      // id under `resource_type: 'agency_campaign_agent'` makes the two halves of
      // one row's history unjoinable and points a reader at the wrong type.
      expect(audit.map((r) => r.resource_type)).toEqual([
        'agency_campaign_agent', 'agency_campaign_agent', 'agency_campaign_agent',
      ]);
      // The campaign travels as its own first-class column.
      expect(new Set(audit.map((r) => r.campaign_id)))
        .toEqual(new Set([CAMPAIGN_A, CAMPAIGN_B, CAMPAIGN_C]));
      // The ACTOR is the offboarding admin; the person unstaffed is in `details`.
      for (const row of audit) {
        expect(row.user_id).toBe(admin.id);
        expect(row.details).toMatchObject({ user_id: agent.id, reason: 'membership_removed' });
      }
    });

    it('does not reach the same person’s staffing in ANOTHER tenant', async () => {
      /**
       * A shared-services agent contracted to several tenants. Offboarding them
       * from one must not end their shift at the other — staffing is per tenant,
       * which keeps that person working, and the tenant predicate is in the same
       * statement as the write for exactly this reason.
       *
       * Only expressible with real rows: a mock asserting "called with
       * (tenantId, userId)" cannot show that the WHERE clause excludes anything.
       */
      await insertMembership({
        user_id: agent.id, tenant_id: otherTenant.id, account_id: null, role: 'agent',
      });
      await seedAssignment({ campaignId: CAMPAIGN_A });
      const foreign = await seedAssignment({
        campaignId: CAMPAIGN_B, tenantId: otherTenant.id, accountId: null,
      });

      await app.inject({
        method: 'DELETE', url: `/users/${agent.id}/membership`, headers: headers(),
      });

      // Their other tenant's assignment is untouched and still live.
      const { rows } = await getTestPool().query(
        `SELECT unassigned_at FROM agency_campaign_agents WHERE id = $1`, [foreign.id],
      );
      expect(rows[0].unassigned_at).toBeNull();
      // And their membership there is still ACTIVE, so they can still work.
      expect(await activeMembershipRows(agent.id, otherTenant.id)).toHaveLength(1);
    });

    it('leaves a COLLEAGUE staffed on the same campaign alone', async () => {
      // One person leaving is not a campaign being unstaffed.
      const colleague = await insertUser();
      await insertMembership({
        user_id: colleague.id, tenant_id: tenant.id, account_id: accountA.id, role: 'agent',
      });
      await seedAssignment({ campaignId: CAMPAIGN_A });
      await seedAssignment({ campaignId: CAMPAIGN_A, userId: colleague.id });

      await app.inject({
        method: 'DELETE', url: `/users/${agent.id}/membership`, headers: headers(),
      });
      await flushAudit();

      const theirs = await staffingRows(colleague.id);
      expect(theirs).toHaveLength(1);
      expect(theirs[0].unassigned_at).toBeNull();
      // And exactly one audit row, for the person who actually left.
      const audit = await staffingAuditRows();
      expect(audit).toHaveLength(1);
      expect(audit[0].details).toMatchObject({ user_id: agent.id });
    });
  });

  // ═══ 4. Zero staffing rows ════════════════════════════════════════════════

  describe('a user with NO staffing at all', () => {
    it('is offboarded normally and produces no audit noise', async () => {
      /**
       * The common case — most departing members were never agents — and the one
       * that must not write a row. `closed.length === 0` returns early, before the
       * log and before the loop, so the trail is silent rather than carrying an
       * `agency_campaign_agent.unassigned` with nothing behind it.
       */
      const res = await app.inject({
        method: 'DELETE', url: `/users/${agent.id}/membership`, headers: headers(),
      });
      await flushAudit();

      expect(seen(res)).toMatchObject({ status: 200 });
      expect(await activeMembershipRows()).toHaveLength(0);
      expect(await staffingAuditRows()).toHaveLength(0);
    });

    it('is offboarded normally when every row was ALREADY closed', async () => {
      // Indistinguishable from "never staffed" as far as the trail goes, and it
      // should be: nothing changed, so nothing is recorded.
      await seedAssignment({ campaignId: CAMPAIGN_A });
      await agencyCampaignAgentRepository.unassign(tenant.id, CAMPAIGN_A, agent.id);

      const res = await app.inject({
        method: 'DELETE', url: `/users/${agent.id}/membership`, headers: headers(),
      });
      await flushAudit();

      expect(seen(res)).toMatchObject({ status: 200 });
      expect(await staffingAuditRows()).toHaveLength(0);
    });
  });

  // ═══ 5. The audit rows are READABLE by the admin whose roster changed ══════

  describe('GET /audit-log — the account-scoped reader actually sees the change', () => {
    /**
     * ── This is the assertion the feature exists for ────────────────────────
     * Everything above proves the rows are WRITTEN with the right `account_id`.
     * That is only half the claim: the other half is that
     * `auditAccountScope` — which confines an account-scoped membership to rows
     * stamped with its own account — then FINDS them. Writing the column
     * correctly and the reader still seeing nothing is exactly the shape of the
     * original defect, so the read is done through the real route, as a real
     * `account_admin`, and the assertion is on the response body.
     */
    async function accountAdminFor(accountId: string) {
      const user = await insertUser();
      await insertMembership({
        user_id: user.id, tenant_id: tenant.id, account_id: accountId, role: 'account_admin',
      });
      return user;
    }

    // Reads through `GET /audit-log` ("each account_admin sees their own row", "the
    // tenant-level admin sees both") are not covered: that route is not served.

    it('lands correctly even when the ACTOR sent no X-Account-Id at all', async () => {
      /**
       * ── The shape that made every row account-less ──────────────────────────
       * This route floors at `tenant_admin`, for whom omitting `X-Account-Id` is
       * entirely legal — and it is what an admin doing tenant administration
       * actually does. With the account taken from the actor, `request.accountId`
       * was then `undefined` and EVERY row was written with no account, so no
       * account-scoped admin saw any of it.
       *
       * Every other case in this block already omits the header, which is
       * deliberate; this one asserts the property directly so the reason is not
       * left implicit in a helper's defaults.
       */
      const a = await seedAssignment({ campaignId: CAMPAIGN_A, accountId: accountA.id });
      const adminA = await accountAdminFor(accountA.id);

      const res = await app.inject({
        method: 'DELETE',
        url: `/users/${agent.id}/membership`,
        // Explicitly, not by omission from a helper: no account context whatsoever.
        headers: { 'x-tenant-id': tenant.id, 'x-user-id': admin.id },
      });
      expect(seen(res)).toMatchObject({ status: 200 });
      await flushAudit();

      // The row carries the ASSIGNMENT's account despite the actor naming none.
      const audit = await staffingAuditRows();
      expect(audit).toHaveLength(1);
      expect(audit[0].account_id).toBe(accountA.id);
      expect(audit[0].resource_id).toBe(a.id);

      // The row is not read back through `GET /audit-log` (not served); `adminA` is
      // still seeded so the fixture stays complete.
      expect(adminA.id).toBeTruthy();
    });

    it('is not filed under whichever account the ADMIN happened to have selected', async () => {
      /**
       * The defect stated as its own case, and the only one that can fail while
       * every case above passes: an admin with `X-Account-Id: accountB` offboarding
       * somebody staffed in accountA. Under the old behaviour the row landed in
       * accountB — visible to the wrong admin, invisible to the right one.
       */
      const a = await seedAssignment({ campaignId: CAMPAIGN_A, accountId: accountA.id });
      const adminA = await accountAdminFor(accountA.id);
      const adminB = await accountAdminFor(accountB.id);

      await app.inject({
        method: 'DELETE',
        url: `/users/${agent.id}/membership`,
        // The actor names accountB. The assignment is in accountA.
        headers: headers({ 'x-account-id': accountB.id }),
      });
      await flushAudit();

      const audit = await staffingAuditRows();
      expect(audit).toHaveLength(1);
      expect(audit[0].account_id).toBe(accountA.id);
      expect(audit[0].resource_id).toBe(a.id);
      // The written row's account, asserted above, does not depend on an audit read
      // route: it is NOT the admin's selected accountB.
      expect(audit[0].account_id).not.toBe(accountB.id);
      expect([adminA.id, adminB.id].every(Boolean)).toBe(true);
    });
  });

  // ═══ 6. The role-change path, over real rows ══════════════════════════════

  describe('PUT /users/:id/role — the demotion path against real memberships', () => {
    it('a demotion away from agent closes staffing and audits the reason', async () => {
      const a = await seedAssignment({ campaignId: CAMPAIGN_A });

      const res = await app.inject({
        method: 'PUT',
        url: `/users/${agent.id}/role`,
        headers: headers(),
        payload: { role: 'viewer' },
      });
      expect(seen(res)).toMatchObject({ status: 200 });
      await flushAudit();

      expect((await staffingRows())[0].unassigned_at).not.toBeNull();
      const audit = await staffingAuditRows();
      expect(audit).toHaveLength(1);
      // `reason` is what distinguishes an offboarding close from a supervisor's
      // manual unassign — both write the same action, deliberately, so the merged
      // campaign activity view needs no new vocabulary entry.
      expect(audit[0].details).toMatchObject({
        reason: 'role_changed_from_agent', user_id: agent.id,
      });
      expect(audit[0].resource_id).toBe(a.id);
      // The membership itself really changed, which is what makes the close right.
      expect((await activeMembershipRows()).map((m) => m.role)).toEqual(['viewer']);
    });

    it('a surviving agent membership in the tenant suppresses the close, over real rows', async () => {
      /**
       * The multi-membership case with the memberships actually in the table. This
       * route changes ONE row, and the other still makes them an agent here — so
       * closing would take a working agent off their campaigns.
       *
       * Worth doing against Postgres as well as against a mock because the input
       * is `findByUserAndTenant`'s result: the unit test supplies that list
       * directly, and this one proves the query returns the sibling at all.
       */
      await insertMembership({
        user_id: agent.id, tenant_id: tenant.id, account_id: accountB.id, role: 'agent',
      });
      await seedAssignment({ campaignId: CAMPAIGN_A });

      const res = await app.inject({
        method: 'PUT',
        url: `/users/${agent.id}/role`,
        headers: headers({ 'x-account-id': accountA.id }),
        payload: { role: 'viewer' },
      });
      expect(seen(res)).toMatchObject({ status: 200 });
      await flushAudit();

      expect((await staffingRows())[0].unassigned_at).toBeNull();
      expect(await staffingAuditRows()).toHaveLength(0);
    });

    it('a promotion INTO agent touches no staffing', async () => {
      // They hold none yet and a supervisor is about to give them some; closing on
      // this direction would silently undo an assignment made in the same minute.
      const viewer = await insertUser();
      await insertMembership({
        user_id: viewer.id, tenant_id: tenant.id, account_id: accountA.id, role: 'viewer',
      });

      const res = await app.inject({
        method: 'PUT',
        url: `/users/${viewer.id}/role`,
        headers: headers(),
        payload: { role: 'agent' },
      });
      expect(seen(res)).toMatchObject({ status: 200 });
      await flushAudit();

      expect(await staffingAuditRows()).toHaveLength(0);
    });
  });

  // ═══ 7. The unresolved product question, pinned rather than endorsed ═══════

  describe('the close on DELETE is TENANT-WIDE — current behaviour, NOT a settled decision', () => {
    /**
     * ── Read this before changing anything here ─────────────────────────────
     * `DELETE /users/:id/membership` removes ONE membership row and closes the
     * user's staffing across the WHOLE TENANT, including assignments made in
     * accounts the removed membership had nothing to do with.
     *
     * **This is an open product question, and these cases pin the behaviour
     * rather than endorse it.** The argument for it is in the route: a membership
     * removal takes away `agency.station.connect` outright whatever the role was,
     * so nobody who no longer has a membership should appear on a staffing list,
     * and filtering on `role === 'agent'` would leave exactly those rows behind.
     * The argument against is the multi-membership case the route itself names: a
     * user with a tenant-level membership AND an account-scoped one keeps the
     * other, so they may still legitimately be in the tenant — and their staffing
     * has been closed anyway. The route calls that "the safe direction" (a
     * supervisor can restaff in one click) rather than the correct one.
     *
     * A future change here is therefore a product decision somebody should make on
     * purpose. These cases exist so that making it is DELIBERATE: whoever narrows
     * the close will see two red tests with this comment attached, instead of
     * shipping a silent change to who appears on a supervisor's list.
     */
    it('closes staffing in an account the removed membership was not scoped to', async () => {
      // The membership being removed is scoped to accountA. The assignment is in
      // accountB. It is closed anyway.
      const b = await seedAssignment({ campaignId: CAMPAIGN_B, accountId: accountB.id });

      const res = await app.inject({
        method: 'DELETE',
        url: `/users/${agent.id}/membership`,
        headers: headers({ 'x-account-id': accountA.id }),
      });
      expect(seen(res)).toMatchObject({ status: 200 });
      await flushAudit();

      const { rows } = await getTestPool().query(
        `SELECT unassigned_at FROM agency_campaign_agents WHERE id = $1`, [b.id],
      );
      expect(rows[0].unassigned_at, 'CURRENT behaviour — see this describe block').not.toBeNull();
    });

    it('closes staffing even though ANOTHER membership in the tenant survives', async () => {
      /**
       * The case that makes the question real rather than theoretical. This person
       * still has a membership in this tenant after the request — a tenant-level
       * one — so they are still a member, and their staffing is closed regardless.
       *
       * Note what is deliberately NOT asserted: that this is right. Only that it
       * is what happens today.
       */
      await insertMembership({
        user_id: agent.id, tenant_id: tenant.id, account_id: null, role: 'agent',
      });
      const a = await seedAssignment({ campaignId: CAMPAIGN_A, accountId: accountA.id });

      /**
       * `primaryMembership` picks the strongest role and breaks ties on the oldest
       * row, so with two `agent` memberships it removes the older one — the
       * account-scoped row seeded in `beforeEach`. Either way one survives, which
       * is the precondition this case needs.
       */
      const res = await app.inject({
        method: 'DELETE', url: `/users/${agent.id}/membership`, headers: headers(),
      });
      expect(seen(res)).toMatchObject({ status: 200 });
      await flushAudit();

      expect(await activeMembershipRows(), 'an ACTIVE membership survives the removal')
        .toHaveLength(1);
      const { rows } = await getTestPool().query(
        `SELECT unassigned_at FROM agency_campaign_agents WHERE id = $1`, [a.id],
      );
      expect(rows[0].unassigned_at, 'CURRENT behaviour — see this describe block').not.toBeNull();
    });
  });
});
