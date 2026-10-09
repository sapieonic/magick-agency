import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';
import {
  insertAccount,
  insertMembership,
  insertTenant,
  insertUser,
} from '../../../../../packages/db/test/integration/setup/platform-factories.js';
import { TEST_DB_URL } from '../../../../../packages/db/test/helpers/test-db.js';
import { initDbPool, closePool } from '@magick-agency/db';
import { insertAgencyCampaign } from '../agency/agency-factories.js';

/**
 * ─── THE FOUR STAFFING ROUTES, END TO END, AGAINST REAL POSTGRES ─────────────
 *
 * `test/unit/agency/proxy-agency-staffing.routes.test.ts` already drives these
 * handlers with real RBAC and a mocked repository. What it cannot drive is the
 * half of each route that is a database question:
 *
 *  - **tenant isolation** is a WHERE clause, not a branch. A unit test asserts
 *    the repository was called with `request.tenantId`; only a real row in a
 *    second tenant proves the clause excludes it.
 *  - **the cross-account leak** — an `account_admin` of account A reading
 *    account B's staffing list, *with names and emails* — is only visible when
 *    there are real people to leak. The assertion here is on the response BYTES,
 *    not on which function was called.
 *  - **audit rows** are written through a buffered logger into a partitioned
 *    table. The `resource_id` correction (the assignment, not the campaign) is
 *    a claim about a row, and this file reads the row.
 *  - **identity enrichment** joins `users` to `memberships`. "Highest role
 *    wins", "one query for the whole list" and "a failure degrades rather than
 *    500s" are all properties of that join under real data.
 *
 * ── What is real here and what is not ──────────────────────────────────────
 * Real: Postgres (5436), the repositories, RBAC (`requirePermission` against roles read
 * from the `memberships` table), the audit logger and its buffer, the identity join.
 * Mocked: the two auth middlewares (there is no Firebase here).
 *  - **The internal hop runs the REAL handler by default.** `callCore` (decision B16) is
 *    spied as `mocks.proxyToCore` and, unless a case shapes the answer itself, delegates to
 *    the real `callCore` → the internal `GET /agency-campaigns/:id` (feature gate +
 *    `requireOwned` on tenant AND account) against real `agency_campaigns` rows seeded in
 *    `beforeEach` (CAMPAIGN = 'Q3 Renewals' and OTHER_CAMPAIGN, both owned by the caller's
 *    account, with `agency_dialer_enabled` on for the tenant). So the cross-account and
 *    cross-tenant refusals below are the real ownership rule, not a mock reproducing it.
 *    Cases that shape the handler's answer (a 404 body, a throw, a 503, a non-string name, a
 *    status) use a per-case stub: they test the route's handling of that answer, which no
 *    real row can produce (a throw, a 503).
 *  - The logger mock is partial (the internal handler's module graph needs the rest of
 *    `@magick-agency/observability`); the audit logger is `platformAuditLogger` (B7).
 *  - There is no governance and no `agency` capability gate (the app IS agency), and no
 *    platform API keys: the gate that remains on this path is the internal
 *    `agency_dialer_enabled` check inside the in-process hop.
 */

const CAMPAIGN = '22222222-2222-4222-8222-222222222222';
const OTHER_CAMPAIGN = '33333333-3333-4333-8333-333333333333';

const mocks = vi.hoisted(() => ({
  proxyToCore: vi.fn(),
  /** The real `callCore`, captured from the actual module; the default implementation. */
  realCallCore: null as null | ((...args: unknown[]) => Promise<unknown>),
  logCalls: [] as unknown[][],
}));

initDbPool({ url: TEST_DB_URL, poolMin: 0, poolMax: 4 });

// The in-process seam (decision B16). Everything else in the module is the real one, so
// `setCoreHandlers` (below) installs the private handler instance the real `callCore` runs.
vi.mock('../../../src/api/core-dispatch.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/api/core-dispatch.js')>();
  mocks.realCallCore = actual.callCore as (...args: unknown[]) => Promise<unknown>;
  return { ...actual, callCore: mocks.proxyToCore };
});

vi.mock('@magick-agency/observability', async (importOriginal) => {
  const record = (...args: unknown[]) => { mocks.logCalls.push(args); };
  const child = () => ({ info: record, warn: record, error: record, debug: record });
  return {
    ...(await importOriginal<typeof import('@magick-agency/observability')>()),
    createChildLogger: child,
    logger: { ...child(), child },
  };
});

// Auth is the only thing with no local equivalent — Firebase is not reachable
// here. The stubs seed exactly what the real middlewares seed, and the
// membership is READ FROM THE DATABASE with the same account-then-tenant
// preference `tenant-context.middleware.ts` uses, so RBAC decides on a real row.
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
const { platformAuditLogger } = await import('../../../src/audit/platform/audit-logger.js');
const { userRepository } = await import('@magick-agency/db/repositories/user.repository');
const { agencyCampaignAgentRepository } = await import(
  '@magick-agency/db/repositories/agency-campaign-agent.repository'
);
const { buildCoreHandlers } = await import('../../../src/api/core-handlers.js');
const { setCoreHandlers } = await import('../../../src/api/core-dispatch.js');
const { getFeatureFlagService } = await import('../../../src/feature-flags/index.js');

const PREFIX = '/proxy/agency';

describe('agency staffing routes (integration)', () => {
  let app: FastifyInstance;
  let tenant: { id: string };
  let otherTenant: { id: string };
  let account: { id: string };
  let otherAccount: { id: string };
  let supervisor: { id: string };
  let agent: { id: string; email: string; display_name: string };
  let core: FastifyInstance;

  beforeAll(async () => {
    // The internal agency handler modules on their private instance, exactly as
    // `agencyPlugin` builds them. Only `GET /agency-campaigns/:id` is reached from this
    // plugin, and it reads none of these runtime deps.
    core = await buildCoreHandlers({
      campaigns: {
        runtime: {
          dnc: { appliedVersion: async () => null },
          stations: { connectedBySession: async () => new Map<string, boolean>() },
        },
        callManager: {
          accountConcurrencyGuard: {
            getDistributedAccountCount: async () => ({ status: 'unavailable' as const }),
          },
        },
      },
    });
    setCoreHandlers(core);
  });

  beforeEach(async () => {
    vi.restoreAllMocks();
    // Default: the REAL internal handler, in-process. A case that shapes its answer
    // overrides this with its own stub.
    mocks.proxyToCore.mockReset().mockImplementation(mocks.realCallCore!);
    mocks.logCalls.length = 0;

    await truncateAll();
    tenant = await insertTenant();
    otherTenant = await insertTenant();
    account = await insertAccount({ tenant_id: tenant.id });
    otherAccount = await insertAccount({ tenant_id: tenant.id });

    supervisor = await insertUser({ display_name: 'Sam Supervisor' });
    await insertMembership({
      user_id: supervisor.id,
      tenant_id: tenant.id,
      account_id: account.id,
      role: 'account_admin',
    });

    agent = await insertUser({
      display_name: 'Ada Agent',
      email: `ada-${randomUUID()}@example.com`,
    });
    await insertMembership({
      user_id: agent.id,
      tenant_id: tenant.id,
      account_id: account.id,
      role: 'agent',
    });

    // The campaign exists and this account owns it; the handler answers from these rows.
    // OTHER_CAMPAIGN is owned by the same account.
    await insertAgencyCampaign({
      id: CAMPAIGN, tenant_id: tenant.id, account_id: account.id, name: 'Q3 Renewals',
    });
    await insertAgencyCampaign({
      id: OTHER_CAMPAIGN, tenant_id: tenant.id, account_id: account.id, name: 'Collections',
    });
    // The `agency_dialer_enabled` gate (the handler's `gate`) — on for this tenant.
    await enableDialer(tenant.id);

    app = Fastify({ logger: false });
    await app.register(proxyAgencyStaffingRoutes, { prefix: PREFIX });
    await app.ready();
  });

  afterEach(async () => {
    await app?.close();
  });

  afterAll(async () => {
    setCoreHandlers(null);
    await core?.close();
    await getTestPool().query(
      `DELETE FROM platform_audit_log WHERE action LIKE 'agency_campaign_agent.%'`,
    );
    await closeTestPool();
    await closePool();
  });

  // ── helpers ───────────────────────────────────────────────────────────────

  function headers(overrides: Record<string, string | undefined> = {}) {
    const base: Record<string, string> = {
      'x-tenant-id': tenant.id,
      'x-account-id': account.id,
      'x-user-id': supervisor.id,
    };
    for (const [k, v] of Object.entries(overrides)) {
      if (v === undefined) delete base[k];
      else base[k] = v;
    }
    return base;
  }

  async function asRole(role: string, accountId = account.id) {
    const user = await insertUser();
    await insertMembership({
      user_id: user.id,
      tenant_id: tenant.id,
      account_id: accountId,
      role,
    });
    return user;
  }

  /** The buffered audit logger writes on flush, not on push. */
  async function flushAudit() {
    await platformAuditLogger.shutdown();
  }

  /** A tenant-scoped `agency_dialer_enabled = true` override (the handler gate). */
  async function enableDialer(tenantId: string) {
    await getTestPool().query(
      `INSERT INTO feature_flag_overrides (flag_key, scope_type, tenant_id, value)
       VALUES ('agency_dialer_enabled', 'tenant', $1, 'true'::jsonb)`,
      [tenantId],
    );
    await getFeatureFlagService().invalidate({ tenantId });
  }

  async function auditRows(tenantId = tenant.id) {
    const { rows } = await getTestPool().query(
      `SELECT * FROM platform_audit_log
        WHERE tenant_id = $1 AND resource_type = 'agency_campaign_agent'
        ORDER BY created_at ASC, action ASC`,
      [tenantId],
    );
    return rows;
  }

  async function seedAssignment(opts: {
    userId?: string;
    campaignId?: string;
    tenantId?: string;
    accountId?: string | null;
  } = {}) {
    return agencyCampaignAgentRepository.assign({
      tenant_id: opts.tenantId ?? tenant.id,
      account_id: opts.accountId === undefined ? account.id : opts.accountId,
      campaign_id: opts.campaignId ?? CAMPAIGN,
      user_id: opts.userId ?? agent.id,
      assigned_by: supervisor.id,
    });
  }

  async function activeRowsFor(userId: string, tenantId = tenant.id) {
    const { rows } = await getTestPool().query(
      `SELECT * FROM agency_campaign_agents
        WHERE tenant_id = $1 AND user_id = $2 AND unassigned_at IS NULL`,
      [tenantId, userId],
    );
    return rows;
  }

  // ═══ Permission floors ════════════════════════════════════════════════════

  describe('permission floors, against roles read from the memberships table', () => {
    it('a BARE agent reaches /my-assignment', async () => {
      // The single most important case: an `agent` (level 5) inherits nothing
      // that predates the agency feature, so a floor one notch higher 403s the
      // only role this route exists for.
      await seedAssignment();

      const res = await app.inject({
        method: 'GET',
        url: `${PREFIX}/my-assignment`,
        headers: headers({ 'x-user-id': agent.id }),
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ campaign_id: CAMPAIGN, campaign_name: 'Q3 Renewals' });
    });

    it('an agent cannot reach any of the three staffing routes', async () => {
      const h = headers({ 'x-user-id': agent.id });
      const results = await Promise.all([
        app.inject({ method: 'GET', url: `${PREFIX}/campaigns/${CAMPAIGN}/agents`, headers: h }),
        app.inject({
          method: 'POST',
          url: `${PREFIX}/campaigns/${CAMPAIGN}/agents`,
          headers: h,
          payload: { user_id: agent.id },
        }),
        app.inject({
          method: 'DELETE',
          url: `${PREFIX}/campaigns/${CAMPAIGN}/agents/${agent.id}`,
          headers: h,
        }),
      ]);
      expect(results.map((r) => r.statusCode)).toEqual([403, 403, 403]);
    });

    for (const role of ['viewer', 'operator']) {
      it(`a ${role} cannot reach any of the three staffing routes`, async () => {
        const user = await asRole(role);
        const h = headers({ 'x-user-id': user.id });

        const results = await Promise.all([
          app.inject({ method: 'GET', url: `${PREFIX}/campaigns/${CAMPAIGN}/agents`, headers: h }),
          app.inject({
            method: 'POST',
            url: `${PREFIX}/campaigns/${CAMPAIGN}/agents`,
            headers: h,
            payload: { user_id: agent.id },
          }),
          app.inject({
            method: 'DELETE',
            url: `${PREFIX}/campaigns/${CAMPAIGN}/agents/${agent.id}`,
            headers: h,
          }),
        ]);

        expect(results.map((r) => r.statusCode)).toEqual([403, 403, 403]);
        // A refused write must not have written.
        expect(await activeRowsFor(agent.id)).toHaveLength(0);
      });
    }

    it('an account_admin is admitted on all three', async () => {
      const h = headers();
      const list = await app.inject({
        method: 'GET',
        url: `${PREFIX}/campaigns/${CAMPAIGN}/agents`,
        headers: h,
      });
      const created = await app.inject({
        method: 'POST',
        url: `${PREFIX}/campaigns/${CAMPAIGN}/agents`,
        headers: h,
        payload: { user_id: agent.id },
      });
      const removed = await app.inject({
        method: 'DELETE',
        url: `${PREFIX}/campaigns/${CAMPAIGN}/agents/${agent.id}`,
        headers: h,
      });

      expect([list.statusCode, created.statusCode, removed.statusCode]).toEqual([200, 201, 204]);
    });

    it('a caller with no membership in this tenant is refused', async () => {
      const stranger = await insertUser();
      await insertMembership({
        user_id: stranger.id,
        tenant_id: otherTenant.id,
        role: 'tenant_owner',
      });

      const res = await app.inject({
        method: 'GET',
        url: `${PREFIX}/campaigns/${CAMPAIGN}/agents`,
        headers: headers({ 'x-user-id': stranger.id }),
      });
      expect(res.statusCode).toBe(403);
    });
  });

  // ═══ What the in-process internal handler can answer, and what the route does with it ═══
  //
  // There is no governance and no `requireCapability('agency')` (the app IS agency). The gate
  // that remains on this path is the internal `agency_dialer_enabled` check inside the
  // in-process hop, which this block drives.

  describe('statuses the in-process internal hop answers are forwarded by the route', () => {
    it('agency_dialer_enabled OFF: the internal 403 is forwarded on all three supervisory routes, and nothing is written', async () => {
      // `assertCampaignInScope` forwards any non-404 status verbatim (the route could
      // not PROVE the campaign is missing). The internal handler answers 403
      // `feature_disabled` when the tenant's dialer flag is off.
      await getTestPool().query(`DELETE FROM feature_flag_overrides WHERE tenant_id = $1`, [tenant.id]);
      await getFeatureFlagService().invalidate({ tenantId: tenant.id });
      await seedAssignment();
      const h = headers();

      const results = await Promise.all([
        app.inject({ method: 'GET', url: `${PREFIX}/campaigns/${CAMPAIGN}/agents`, headers: h }),
        app.inject({
          method: 'POST',
          url: `${PREFIX}/campaigns/${CAMPAIGN}/agents`,
          headers: h,
          payload: { user_id: supervisor.id },
        }),
        app.inject({
          method: 'DELETE',
          url: `${PREFIX}/campaigns/${CAMPAIGN}/agents/${agent.id}`,
          headers: h,
        }),
      ]);

      expect(results.map((r) => r.statusCode)).toEqual([403, 403, 403]);
      expect(results[0]!.json()).toMatchObject({ code: 'feature_disabled' });
      expect(results[0]!.body).not.toContain('Ada Agent');
      // The agent's assignment is untouched and nobody new was staffed.
      expect(await activeRowsFor(agent.id)).toHaveLength(1);
      expect(await activeRowsFor(supervisor.id)).toHaveLength(0);
      // …and the agent's own landing page degrades to null labels, never a 403/500.
      const mine = await app.inject({
        method: 'GET',
        url: `${PREFIX}/my-assignments`,
        headers: headers({ 'x-user-id': agent.id }),
      });
      expect(mine.statusCode).toBe(200);
      expect(mine.json().assignments).toMatchObject([
        { campaign_id: CAMPAIGN, campaign_name: null, campaign_status: null },
      ]);
    });

    it('a TENANT-level caller with no X-Account-Id: the internal 400 (no account context) is forwarded', async () => {
      // The route forwards `request.accountId` (the optional header), so a tenant-level
      // admin who had not picked an account meets the handler's header refusal, verbatim. The
      // same answer here, from the same rule (`auth.middleware.ts`'s header half).
      const tenantAdmin = await insertUser();
      await insertMembership({
        user_id: tenantAdmin.id,
        tenant_id: tenant.id,
        account_id: null,
        role: 'tenant_admin',
      });

      const res = await app.inject({
        method: 'GET',
        url: `${PREFIX}/campaigns/${CAMPAIGN}/agents`,
        headers: headers({ 'x-user-id': tenantAdmin.id, 'x-account-id': undefined }),
      });

      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: 'Bad Request' });
      expect(res.body).not.toContain('Ada Agent');
    });
  });

  // ═══ GET /my-assignment ═══════════════════════════════════════════════════

  describe('GET /my-assignment', () => {
    it('answers 204 with NO body when nobody has staffed them', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `${PREFIX}/my-assignment`,
        headers: headers({ 'x-user-id': agent.id }),
      });

      expect(res.statusCode).toBe(204);
      // A 200 with nulls makes "am I staffed?" a field test the console can
      // forget; the emptiness is the contract.
      expect(res.body).toBe('');
    });

    it('answers 204 once the assignment is closed', async () => {
      await seedAssignment();
      await agencyCampaignAgentRepository.unassign(tenant.id, CAMPAIGN, agent.id);

      const res = await app.inject({
        method: 'GET',
        url: `${PREFIX}/my-assignment`,
        headers: headers({ 'x-user-id': agent.id }),
      });
      expect(res.statusCode).toBe(204);
    });

    it('reports campaign_name: null when the internal handler cannot name the campaign — a live contract with the console', async () => {
      await seedAssignment();
      mocks.proxyToCore.mockResolvedValue({ status: 404, body: { error: 'Not Found' } });

      const res = await app.inject({
        method: 'GET',
        url: `${PREFIX}/my-assignment`,
        headers: headers({ 'x-user-id': agent.id }),
      });

      // The KEY is always present. A sometimes-absent key is a different defect
      // and a client cannot tell it from one it forgot to read.
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ campaign_id: CAMPAIGN, campaign_name: null });
      expect(Object.keys(res.json())).toEqual(['campaign_id', 'campaign_name']);
    });

    it('reports campaign_name: null when the internal call THROWS', async () => {
      await seedAssignment();
      mocks.proxyToCore.mockRejectedValue(new Error('core unreachable'));

      const res = await app.inject({
        method: 'GET',
        url: `${PREFIX}/my-assignment`,
        headers: headers({ 'x-user-id': agent.id }),
      });

      // The assignment is the route's own fact and is already in hand; the name is
      // a courtesy. An outage must not break the agent's landing redirect.
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ campaign_id: CAMPAIGN, campaign_name: null });
    });

    it('reports campaign_name: null when the internal handler answers a shape without a string name', async () => {
      await seedAssignment();
      mocks.proxyToCore.mockResolvedValue({ status: 200, body: { id: CAMPAIGN, name: 42 } });

      const res = await app.inject({
        method: 'GET',
        url: `${PREFIX}/my-assignment`,
        headers: headers({ 'x-user-id': agent.id }),
      });
      expect(res.json()).toEqual({ campaign_id: CAMPAIGN, campaign_name: null });
    });

    it('does not see an assignment held in another tenant', async () => {
      await insertMembership({ user_id: agent.id, tenant_id: otherTenant.id, role: 'agent' });
      await seedAssignment({ tenantId: otherTenant.id, accountId: null });

      const res = await app.inject({
        method: 'GET',
        url: `${PREFIX}/my-assignment`,
        headers: headers({ 'x-user-id': agent.id }),
      });
      expect(res.statusCode).toBe(204);
    });

    it('does not answer with a COLLEAGUE’s assignment', async () => {
      await seedAssignment({ userId: supervisor.id });

      const res = await app.inject({
        method: 'GET',
        url: `${PREFIX}/my-assignment`,
        headers: headers({ 'x-user-id': agent.id }),
      });
      expect(res.statusCode).toBe(204);
    });

    // There are no platform API keys. A caller with no membership is refused by
    // `requirePermission` ('a caller with no membership in this tenant is refused'), and
    // `resolveMyAgentId`'s remaining branch (no user id → 400 `missing_actor`) is pinned in
    // the unit suite.
  });

  // ═══ GET /my-assignments ══════════════════════════════════════════════════

  describe('GET /my-assignments — the plural replacement, over real rows', () => {
    it('answers 200 with an EMPTY ARRAY when nobody has staffed them', async () => {
      // The deliberate divergence from the singular route's 204: for a collection
      // the empty array IS the absence, so a client needs one code path rather
      // than the field test a 204 forces it to remember.
      const res = await app.inject({
        method: 'GET',
        url: `${PREFIX}/my-assignments`,
        headers: headers({ 'x-user-id': agent.id }),
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ assignments: [] });
    });

    it('returns EVERY campaign the agent is staffed on, oldest first', async () => {
      // The whole point of the plural route, asserted against real rows: the
      // singular one could name only the first of these.
      await seedAssignment({ campaignId: CAMPAIGN });
      await seedAssignment({ campaignId: OTHER_CAMPAIGN });
      mocks.proxyToCore.mockResolvedValue({
        status: 200,
        body: { id: CAMPAIGN, name: 'Q3 Renewals', status: 'running' },
      });

      const res = await app.inject({
        method: 'GET',
        url: `${PREFIX}/my-assignments`,
        headers: headers({ 'x-user-id': agent.id }),
      });

      expect(res.statusCode).toBe(200);
      const { assignments } = res.json();
      expect(assignments.map((a: { campaign_id: string }) => a.campaign_id)).toEqual([
        CAMPAIGN,
        OTHER_CAMPAIGN,
      ]);
    });

    it('carries the four keys, always present — a live contract with the console', async () => {
      await seedAssignment({ campaignId: CAMPAIGN });
      mocks.proxyToCore.mockResolvedValue({
        status: 200,
        body: { id: CAMPAIGN, name: 'Q3 Renewals', status: 'paused' },
      });

      const res = await app.inject({
        method: 'GET',
        url: `${PREFIX}/my-assignments`,
        headers: headers({ 'x-user-id': agent.id }),
      });

      const [first] = res.json().assignments;
      expect(Object.keys(first).sort()).toEqual(
        ['assigned_at', 'campaign_id', 'campaign_name', 'campaign_status'].sort(),
      );
      expect(first.campaign_name).toBe('Q3 Renewals');
      expect(first.campaign_status).toBe('paused');
    });

    it('nulls BOTH labels when the internal handler cannot name the campaign, and keeps the id', async () => {
      // Enrichment must never turn a 200 into a 500: the ids are the answer and
      // are already in hand, so every link on the agent's home keeps working.
      await seedAssignment({ campaignId: CAMPAIGN });
      mocks.proxyToCore.mockResolvedValue({ status: 404, body: { error: 'Not Found' } });

      const res = await app.inject({
        method: 'GET',
        url: `${PREFIX}/my-assignments`,
        headers: headers({ 'x-user-id': agent.id }),
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().assignments).toMatchObject([
        { campaign_id: CAMPAIGN, campaign_name: null, campaign_status: null },
      ]);
    });

    it('nulls the labels when the internal call THROWS', async () => {
      await seedAssignment({ campaignId: CAMPAIGN });
      mocks.proxyToCore.mockRejectedValue(new Error('core unreachable'));

      const res = await app.inject({
        method: 'GET',
        url: `${PREFIX}/my-assignments`,
        headers: headers({ 'x-user-id': agent.id }),
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().assignments).toMatchObject([
        { campaign_id: CAMPAIGN, campaign_name: null, campaign_status: null },
      ]);
    });

    it('omits a closed assignment', async () => {
      await seedAssignment({ campaignId: CAMPAIGN });
      await seedAssignment({ campaignId: OTHER_CAMPAIGN });
      await agencyCampaignAgentRepository.unassign(tenant.id, CAMPAIGN, agent.id);

      const res = await app.inject({
        method: 'GET',
        url: `${PREFIX}/my-assignments`,
        headers: headers({ 'x-user-id': agent.id }),
      });

      expect(res.json().assignments.map((a: { campaign_id: string }) => a.campaign_id)).toEqual([
        OTHER_CAMPAIGN,
      ]);
    });

    it('does not see assignments held in another tenant', async () => {
      await insertMembership({ user_id: agent.id, tenant_id: otherTenant.id, role: 'agent' });
      await seedAssignment({ tenantId: otherTenant.id, accountId: null });

      const res = await app.inject({
        method: 'GET',
        url: `${PREFIX}/my-assignments`,
        headers: headers({ 'x-user-id': agent.id }),
      });

      expect(res.json()).toEqual({ assignments: [] });
    });

    it('does not answer with a COLLEAGUE’s assignments', async () => {
      await seedAssignment({ userId: supervisor.id });

      const res = await app.inject({
        method: 'GET',
        url: `${PREFIX}/my-assignments`,
        headers: headers({ 'x-user-id': agent.id }),
      });

      expect(res.json()).toEqual({ assignments: [] });
    });

    // There are no platform API keys. A caller with no membership is refused by
    // `requirePermission` ('a caller with no membership in this tenant is refused'), and
    // `resolveMyAgentId`'s remaining branch (no user id → 400 `missing_actor`) is pinned in
    // the unit suite.
  });

  // ═══ GET /campaigns/:id/agents ════════════════════════════════════════════

  describe('GET /campaigns/:id/agents — identity enrichment over real rows', () => {
    it('returns name, email, role and assigned_at for each staffed person', async () => {
      await seedAssignment();

      const res = await app.inject({
        method: 'GET',
        url: `${PREFIX}/campaigns/${CAMPAIGN}/agents`,
        headers: headers(),
      });

      expect(res.statusCode).toBe(200);
      const { agents } = res.json();
      expect(agents).toHaveLength(1);
      expect(agents[0]).toMatchObject({
        user_id: agent.id,
        name: 'Ada Agent',
        email: agent.email,
        role: 'agent',
      });
      expect(Object.keys(agents[0]).sort()).toEqual(
        ['assigned_at', 'email', 'name', 'role', 'user_id'],
      );
    });

    it('reports the HIGHEST role a person holds in the tenant', async () => {
      // Two memberships, two accounts. Reporting the lower one would show a
      // supervisor an "agent" who can in fact start and stop campaigns.
      await insertMembership({
        user_id: agent.id,
        tenant_id: tenant.id,
        account_id: otherAccount.id,
        role: 'tenant_admin',
      });
      await seedAssignment();

      const res = await app.inject({
        method: 'GET',
        url: `${PREFIX}/campaigns/${CAMPAIGN}/agents`,
        headers: headers(),
      });
      expect(res.json().agents[0].role).toBe('tenant_admin');
    });

    it('keeps an unresolvable assignment in the list rather than dropping it', async () => {
      // A person with no membership in this tenant: the row is stale and the
      // supervisor is the only one who can fix it, so hiding it is the worst
      // outcome. Nulls, not omission.
      const ghost = await insertUser();
      await seedAssignment({ userId: ghost.id });

      const res = await app.inject({
        method: 'GET',
        url: `${PREFIX}/campaigns/${CAMPAIGN}/agents`,
        headers: headers(),
      });

      expect(res.json().agents).toHaveLength(1);
      expect(res.json().agents[0]).toMatchObject({
        user_id: ghost.id,
        name: null,
        email: null,
        role: null,
      });
    });

    it('degrades to nulls rather than turning a 200 into a 500', async () => {
      await seedAssignment();
      vi.spyOn(userRepository, 'findIdentitiesInTenant').mockRejectedValue(
        new Error('users table unavailable'),
      );

      const res = await app.inject({
        method: 'GET',
        url: `${PREFIX}/campaigns/${CAMPAIGN}/agents`,
        headers: headers(),
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().agents).toEqual([
        {
          user_id: agent.id,
          name: null,
          email: null,
          role: null,
          assigned_at: expect.any(String),
        },
      ]);
    });

    it('resolves identity in ONE query for the whole list — no N+1', async () => {
      const others = await Promise.all([insertUser(), insertUser(), insertUser()]);
      for (const u of others) {
        await insertMembership({
          user_id: u.id,
          tenant_id: tenant.id,
          account_id: account.id,
          role: 'agent',
        });
        await seedAssignment({ userId: u.id });
      }
      await seedAssignment();

      const spy = vi.spyOn(userRepository, 'findIdentitiesInTenant');
      const res = await app.inject({
        method: 'GET',
        url: `${PREFIX}/campaigns/${CAMPAIGN}/agents`,
        headers: headers(),
      });

      expect(res.json().agents).toHaveLength(4);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0]![0]).toHaveLength(4);
    });

    it('is tenant-scoped: another tenant’s staffing on the same campaign id is invisible', async () => {
      // `campaign_id` has no FK and arrives from the URL, so the tenant
      // predicate is the security property rather than a filter.
      const foreign = await insertUser({ display_name: 'Foreign Person' });
      await insertMembership({ user_id: foreign.id, tenant_id: otherTenant.id, role: 'agent' });
      await seedAssignment({ userId: foreign.id, tenantId: otherTenant.id, accountId: null });

      const res = await app.inject({
        method: 'GET',
        url: `${PREFIX}/campaigns/${CAMPAIGN}/agents`,
        headers: headers(),
      });

      expect(res.json()).toEqual({ agents: [] });
      expect(res.body).not.toContain('Foreign Person');
    });

    it('omits people who have been unstaffed', async () => {
      await seedAssignment();
      await agencyCampaignAgentRepository.unassign(tenant.id, CAMPAIGN, agent.id);

      const res = await app.inject({
        method: 'GET',
        url: `${PREFIX}/campaigns/${CAMPAIGN}/agents`,
        headers: headers(),
      });
      expect(res.json()).toEqual({ agents: [] });
    });
  });

  // ═══ Cross-account campaign access — the leak this change closed ══════════

  describe('a campaign in ANOTHER account is refused on all three routes', () => {
    /**
     * The real defect, pinned on the bytes. For one commit `GET` and `DELETE`
     * filtered on `(campaign_id, tenant_id)` only, while `POST` round-tripped
     * the internal handler — so the READ surface returned another account's staffing list with
     * NAMES AND EMAILS and the DELETE surface could unstaff their agents, while
     * the WRITE surface was correctly refused.
     *
     * `requireOwned` compares tenant AND account and answers 404, so the route never
     * learns whether the campaign is missing or merely somebody else's, which is the
     * non-oracle property. There is no mock: OTHER_CAMPAIGN is re-owned to the sibling
     * account and the REAL `requireOwned` (in-process) answers the 404.
     */
    beforeEach(async () => {
      // Somebody IS staffed on the foreign campaign, in this tenant — so a
      // tenant-only predicate would happily return them.
      await seedAssignment({ campaignId: OTHER_CAMPAIGN, accountId: otherAccount.id });
      await getTestPool().query(
        `UPDATE agency_campaigns SET account_id = $2 WHERE id = $1`,
        [OTHER_CAMPAIGN, otherAccount.id],
      );
    });

    it('GET refuses with 404 and leaks no name, no email, no user id', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `${PREFIX}/campaigns/${OTHER_CAMPAIGN}/agents`,
        headers: headers(),
      });

      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({
        error: 'Not Found',
        code: 'campaign_not_found',
        message: 'Campaign not found.',
      });
      // Asserted on the raw body rather than on which repository call happened:
      // the property is "these bytes did not leave the process".
      expect(res.body).not.toContain('Ada Agent');
      expect(res.body).not.toContain(agent.email);
      expect(res.body).not.toContain(agent.id);
      expect(res.body).not.toContain('agents');
    });

    it('DELETE refuses with 404 and the foreign assignment stays ACTIVE', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: `${PREFIX}/campaigns/${OTHER_CAMPAIGN}/agents/${agent.id}`,
        headers: headers(),
      });

      expect(res.statusCode).toBe(404);
      expect(await activeRowsFor(agent.id)).toMatchObject([{ campaign_id: OTHER_CAMPAIGN }]);
      await flushAudit();
      expect(await auditRows()).toHaveLength(0);
    });

    it('POST refuses with 404 and writes no row', async () => {
      const newcomer = await insertUser();
      await insertMembership({
        user_id: newcomer.id,
        tenant_id: tenant.id,
        account_id: account.id,
        role: 'agent',
      });

      const res = await app.inject({
        method: 'POST',
        url: `${PREFIX}/campaigns/${OTHER_CAMPAIGN}/agents`,
        headers: headers(),
        payload: { user_id: newcomer.id },
      });

      expect(res.statusCode).toBe(404);
      expect(await activeRowsFor(newcomer.id)).toHaveLength(0);
    });

    it('an internal failure that is NOT a 404 is forwarded rather than called "not found"', async () => {
      // The route could not PROVE the campaign is missing. Answering 404 for "we
      // could not ask" is the confident-wrong answer.
      mocks.proxyToCore.mockResolvedValue({ status: 503, body: { error: 'Service Unavailable' } });

      const res = await app.inject({
        method: 'GET',
        url: `${PREFIX}/campaigns/${CAMPAIGN}/agents`,
        headers: headers(),
      });
      expect(res.statusCode).toBe(503);
    });
  });

  // ═══ The ownership probe against real rows — another TENANT ═════════

  describe('a campaign in ANOTHER TENANT is a 404 on all three routes, never data ', () => {
    /**
     * Another tenant's campaign is a 404, never data — the TENANT half, through the real
     * `requireOwned` in-process. The foreign campaign exists, is running, and has one of
     * ITS tenant's people staffed on it; the caller is a fully-privileged account_admin
     * of a different tenant who knows the id.
     */
    const FOREIGN_CAMPAIGN = '44444444-4444-4444-8444-444444444444';
    let foreignPerson: { id: string };

    beforeEach(async () => {
      const foreignAccount = await insertAccount({ tenant_id: otherTenant.id });
      await insertAgencyCampaign({
        id: FOREIGN_CAMPAIGN, tenant_id: otherTenant.id, account_id: foreignAccount.id,
        name: 'Foreign Campaign', status: 'running',
      });
      await enableDialer(otherTenant.id);
      foreignPerson = await insertUser({ display_name: 'Foreign Person' });
      await insertMembership({
        user_id: foreignPerson.id, tenant_id: otherTenant.id, account_id: foreignAccount.id, role: 'agent',
      });
      await seedAssignment({
        userId: foreignPerson.id, campaignId: FOREIGN_CAMPAIGN,
        tenantId: otherTenant.id, accountId: foreignAccount.id,
      });
    });

    it('GET, POST and DELETE all answer 404 campaign_not_found, and the foreign row is untouched', async () => {
      const h = headers();
      const results = await Promise.all([
        app.inject({ method: 'GET', url: `${PREFIX}/campaigns/${FOREIGN_CAMPAIGN}/agents`, headers: h }),
        app.inject({
          method: 'POST',
          url: `${PREFIX}/campaigns/${FOREIGN_CAMPAIGN}/agents`,
          headers: h,
          payload: { user_id: agent.id },
        }),
        app.inject({
          method: 'DELETE',
          url: `${PREFIX}/campaigns/${FOREIGN_CAMPAIGN}/agents/${foreignPerson.id}`,
          headers: h,
        }),
      ]);

      expect(results.map((r) => r.statusCode)).toEqual([404, 404, 404]);
      for (const r of results) {
        expect(r.json()).toEqual({ error: 'Not Found', code: 'campaign_not_found', message: 'Campaign not found.' });
        expect(r.body).not.toContain('Foreign Person');
        expect(r.body).not.toContain('Foreign Campaign');
        expect(r.body).not.toContain(foreignPerson.id);
      }
      expect(await activeRowsFor(foreignPerson.id, otherTenant.id)).toHaveLength(1);
      expect(await activeRowsFor(agent.id)).toHaveLength(0);
      await flushAudit();
      expect(await auditRows()).toHaveLength(0);
      expect(await auditRows(otherTenant.id)).toHaveLength(0);
    });

    it('an agent staffed on a campaign their account does not own is never told its name', async () => {
      // The `my-*` summary lookup goes through the same `requireOwned` (with the
      // CALLER's tenant and account), so a stale or forged row pointing at a foreign
      // campaign degrades to null labels rather than naming another tenant's campaign.
      await seedAssignment({ campaignId: FOREIGN_CAMPAIGN });

      const res = await app.inject({
        method: 'GET',
        url: `${PREFIX}/my-assignments`,
        headers: headers({ 'x-user-id': agent.id }),
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().assignments).toMatchObject([
        { campaign_id: FOREIGN_CAMPAIGN, campaign_name: null, campaign_status: null },
      ]);
      expect(res.body).not.toContain('Foreign Campaign');
    });
  });

  // ═══ Path params ══════════════════════════════════════════════════════════

  describe('non-UUID path params are refused as 4xx, never as a masked 500', () => {
    /**
     * `campaign_id` and `user_id` are UUID columns: an unvalidated `'not-a-uuid'`
     * raises `22P02` from inside the query, which propagates as a 500 — and the
     * global error mask turns every 5xx into "contact support and quote this
     * request id" for a typo the caller could have fixed themselves.
     */
    const cases = [
      { name: 'GET :id', method: 'GET' as const, url: `${PREFIX}/campaigns/not-a-uuid/agents`, field: 'id' },
      { name: 'POST :id', method: 'POST' as const, url: `${PREFIX}/campaigns/not-a-uuid/agents`, field: 'id', payload: { user_id: randomUUID() } },
      { name: 'DELETE :id', method: 'DELETE' as const, url: `${PREFIX}/campaigns/not-a-uuid/agents/${randomUUID()}`, field: 'id' },
      { name: 'DELETE :userId', method: 'DELETE' as const, url: `${PREFIX}/campaigns/${CAMPAIGN}/agents/not-a-uuid`, field: 'userId' },
    ];

    for (const c of cases) {
      it(`${c.name} → 400 naming the right half of the URL`, async () => {
        const res = await app.inject({
          method: c.method,
          url: c.url,
          headers: headers(),
          ...(c.payload ? { payload: c.payload } : {}),
        });

        expect(res.statusCode).toBe(400);
        expect(res.json().error).toBe('Validation Error');
        // Two param schemas rather than one shared shape: a `details` payload
        // saying "id" for a bad `:userId` sends the caller to the wrong half of
        // their URL.
        expect(Object.keys(res.json().details.fieldErrors)).toEqual([c.field]);
        // Validation precedes the internal round trip — a bad id costs nothing.
        expect(mocks.proxyToCore).not.toHaveBeenCalled();
      });
    }

    it('POST with a non-UUID user_id is refused before anything is read', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `${PREFIX}/campaigns/${CAMPAIGN}/agents`,
        headers: headers(),
        payload: { user_id: 'nope' },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().details.fieldErrors.user_id).toBeTruthy();
      expect(mocks.proxyToCore).not.toHaveBeenCalled();
    });

    it('POST with no body at all is refused', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `${PREFIX}/campaigns/${CAMPAIGN}/agents`,
        headers: headers(),
        payload: {},
      });
      expect(res.statusCode).toBe(400);
    });
  });

  // ═══ POST — assignment semantics and the audit row ════════════════════════

  describe('POST /campaigns/:id/agents', () => {
    it('assigns, answers 201 with the row’s own id, and writes the row', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `${PREFIX}/campaigns/${CAMPAIGN}/agents`,
        headers: headers(),
        payload: { user_id: agent.id },
      });

      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(Object.keys(body).sort()).toEqual(['assigned_at', 'campaign_id', 'id', 'user_id']);
      expect(body.campaign_id).toBe(CAMPAIGN);
      expect(body.user_id).toBe(agent.id);

      const active = await activeRowsFor(agent.id);
      expect(active).toMatchObject([
        { id: body.id, campaign_id: CAMPAIGN, account_id: account.id, assigned_by: supervisor.id },
      ]);
    });

    it('takes the campaign from the URL, never from the body', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `${PREFIX}/campaigns/${CAMPAIGN}/agents`,
        headers: headers(),
        payload: { user_id: agent.id, campaign_id: OTHER_CAMPAIGN },
      });

      expect(res.json().campaign_id).toBe(CAMPAIGN);
      expect(await activeRowsFor(agent.id)).toMatchObject([{ campaign_id: CAMPAIGN }]);
    });

    it('ADDS to someone already staffed elsewhere — it does not move them', async () => {
      /**
       * This used to assert a MOVE, and the change is migration 064's. Under the
       * per-tenant index, staffing somebody onto a second campaign silently closed
       * their first — so a supervisor doing an ordinary afternoon handover destroyed
       * the morning's staffing decision without being told.
       *
       * Being live on one campaign at a time is unchanged: that is the session
       * index, which answers a second concurrent join with a typed 409.
       */
      await seedAssignment({ campaignId: OTHER_CAMPAIGN });

      const res = await app.inject({
        method: 'POST',
        url: `${PREFIX}/campaigns/${CAMPAIGN}/agents`,
        headers: headers(),
        payload: { user_id: agent.id },
      });

      expect(res.statusCode).toBe(201);
      const active = await activeRowsFor(agent.id);
      expect(active.map((r) => r.campaign_id).sort()).toEqual([CAMPAIGN, OTHER_CAMPAIGN].sort());
    });

    it('answers 404 — not 403 — for a user who is not a member of this tenant', async () => {
      // A 403 would confirm the user id exists somewhere, which is the oracle
      // the RBAC rules forbid. The user below is real and is a member of ANOTHER
      // tenant, so this is the membership check and not an existence check.
      const outsider = await insertUser();
      await insertMembership({
        user_id: outsider.id,
        tenant_id: otherTenant.id,
        role: 'tenant_owner',
      });

      const res = await app.inject({
        method: 'POST',
        url: `${PREFIX}/campaigns/${CAMPAIGN}/agents`,
        headers: headers(),
        payload: { user_id: outsider.id },
      });

      expect(res.statusCode).toBe(404);
      expect(res.json().message).toContain('not a member of this workspace');
      expect(await activeRowsFor(outsider.id)).toHaveLength(0);
      // Membership is checked BEFORE the campaign round trip — a local read
      // first, so an unknown user costs no proxy call.
      expect(mocks.proxyToCore).not.toHaveBeenCalled();
    });

    it('refuses a user whose membership is not active', async () => {
      const suspended = await insertUser();
      await insertMembership({
        user_id: suspended.id,
        tenant_id: tenant.id,
        account_id: account.id,
        role: 'agent',
        status: 'revoked',
      });

      const res = await app.inject({
        method: 'POST',
        url: `${PREFIX}/campaigns/${CAMPAIGN}/agents`,
        headers: headers(),
        payload: { user_id: suspended.id },
      });
      expect(res.statusCode).toBe(404);
    });

    it('writes an audit row whose resource_id is the ASSIGNMENT, with ids only', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `${PREFIX}/campaigns/${CAMPAIGN}/agents`,
        headers: headers(),
        payload: { user_id: agent.id },
      });
      await flushAudit();

      const rows = await auditRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        action: 'agency_campaign_agent.assigned',
        resource_type: 'agency_campaign_agent',
        resource_id: res.json().id,
        user_id: supervisor.id,
      });
      expect(rows[0].details).toEqual({ campaign_id: CAMPAIGN, user_id: agent.id });
      // No PII: the read path resolves names and emails, the trail never stores
      // them.
      const serialized = JSON.stringify(rows[0]);
      expect(serialized).not.toContain('Ada Agent');
      expect(serialized).not.toContain(agent.email);
    });

    it('logs no PII either', async () => {
      await app.inject({
        method: 'POST',
        url: `${PREFIX}/campaigns/${CAMPAIGN}/agents`,
        headers: headers(),
        payload: { user_id: agent.id },
      });
      await app.inject({
        method: 'GET',
        url: `${PREFIX}/campaigns/${CAMPAIGN}/agents`,
        headers: headers(),
      });

      const logged = JSON.stringify(mocks.logCalls);
      expect(logged).not.toContain('Ada Agent');
      expect(logged).not.toContain(agent.email);
    });
  });

  // ═══ DELETE ═══════════════════════════════════════════════════════════════

  describe('DELETE /campaigns/:id/agents/:userId', () => {
    it('answers 204, closes the row, and audits the CLOSED ROW’S id', async () => {
      const assignment = await seedAssignment();

      const res = await app.inject({
        method: 'DELETE',
        url: `${PREFIX}/campaigns/${CAMPAIGN}/agents/${agent.id}`,
        headers: headers(),
      });
      await flushAudit();

      expect(res.statusCode).toBe(204);
      expect(res.body).toBe('');
      expect(await activeRowsFor(agent.id)).toHaveLength(0);

      const rows = await auditRows();
      expect(rows).toHaveLength(1);
      // The ASSIGNMENT, not the campaign. POST files the assignment id, so a
      // campaign id here would make the two halves of one row's history
      // unjoinable by `resource_id` — and would point a reader at a resource of
      // a different type than `resource_type` claims.
      expect(rows[0].resource_id).toBe(assignment.id);
      expect(rows[0].action).toBe('agency_campaign_agent.unassigned');
    });

    it('the two halves of one row’s history join on resource_id', async () => {
      const created = await app.inject({
        method: 'POST',
        url: `${PREFIX}/campaigns/${CAMPAIGN}/agents`,
        headers: headers(),
        payload: { user_id: agent.id },
      });
      await app.inject({
        method: 'DELETE',
        url: `${PREFIX}/campaigns/${CAMPAIGN}/agents/${agent.id}`,
        headers: headers(),
      });
      await flushAudit();

      const rows = await auditRows();
      expect(rows).toHaveLength(2);
      expect(new Set(rows.map((r) => r.resource_id))).toEqual(new Set([created.json().id]));
      // Both halves of one INSERT share DEFAULT NOW() (stable inside a
      // transaction), so created_at is not a reliable sequence. The claim is
      // joinability on resource_id, not chronology.
      expect(new Set(rows.map((r) => r.action))).toEqual(new Set([
        'agency_campaign_agent.assigned',
        'agency_campaign_agent.unassigned',
      ]));
    });

    it('is idempotent: a second DELETE is 204 and writes NO second audit row', async () => {
      await seedAssignment();

      const first = await app.inject({
        method: 'DELETE',
        url: `${PREFIX}/campaigns/${CAMPAIGN}/agents/${agent.id}`,
        headers: headers(),
      });
      const second = await app.inject({
        method: 'DELETE',
        url: `${PREFIX}/campaigns/${CAMPAIGN}/agents/${agent.id}`,
        headers: headers(),
      });
      await flushAudit();

      expect([first.statusCode, second.statusCode]).toEqual([204, 204]);
      // The status code is idempotent; the TRAIL is not. It records acts, not
      // requests.
      expect(await auditRows()).toHaveLength(1);
    });

    it('answers 204 for someone who was never staffed at all', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: `${PREFIX}/campaigns/${CAMPAIGN}/agents/${agent.id}`,
        headers: headers(),
      });
      await flushAudit();

      expect(res.statusCode).toBe(204);
      expect(await auditRows()).toHaveLength(0);
    });

    it('unstaffs ONLY the named campaign, leaving their other assignments alone', async () => {
      /**
       * The campaign predicate used to guard against a stale console unstaffing
       * somebody from the campaign they had since been MOVED to. Since migration
       * 064 it does ordinary work on the ordinary path: an agent genuinely holds
       * several assignments, so removing one must not disturb the rest.
       */
      await seedAssignment({ campaignId: CAMPAIGN });
      await seedAssignment({ campaignId: OTHER_CAMPAIGN });

      const res = await app.inject({
        method: 'DELETE',
        url: `${PREFIX}/campaigns/${CAMPAIGN}/agents/${agent.id}`,
        headers: headers(),
      });

      expect(res.statusCode).toBe(204);
      expect(await activeRowsFor(agent.id)).toMatchObject([{ campaign_id: OTHER_CAMPAIGN }]);
    });

    it('cannot reach into another tenant', async () => {
      await insertMembership({ user_id: agent.id, tenant_id: otherTenant.id, role: 'agent' });
      await seedAssignment({ tenantId: otherTenant.id, accountId: null });

      const res = await app.inject({
        method: 'DELETE',
        url: `${PREFIX}/campaigns/${CAMPAIGN}/agents/${agent.id}`,
        headers: headers(),
      });

      expect(res.statusCode).toBe(204);
      expect(await activeRowsFor(agent.id, otherTenant.id)).toHaveLength(1);
    });
  });
});
