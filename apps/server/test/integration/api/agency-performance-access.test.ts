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
import {
  insertAgencyAttempt,
  insertAgencyCampaign,
  insertAgencyContact,
  insertAgentSession,
} from '../agency/agency-factories.js';


/**
 * ─── WHO MAY READ AND ACT ON THE AGENCY AGENT SURFACES ──────────────────────
 *
 * **Modelled on two existing suites, and it needs both.** The mock set, the
 * governance stub and the `proxyToCore`/`resolveCoreApiKey` doubles come from
 * `test/integration/api/agency-staffing.routes.test.ts`. The auth arrangement
 * comes from `test/integration/api/platform-api-key-auth.test.ts`: the REAL
 * `sessionMiddleware` → `tenantContextMiddleware` → `requirePermission` chain,
 * with a real `platform_api_keys` row and a real hashed key, because the whole
 * point of this file is that the guard cannot be tested against a stub of the
 * thing it guards against. The one seam is Firebase, which is unreachable here —
 * see the dispatching `sessionMiddleware` mock below, which delegates to the
 * genuine implementation whenever `X-Platform-Key` is present and only fakes the
 * token path.
 *
 * ── The three questions here, and why each needs the real chain ─────────────
 *
 * **1. The membership lookup on the supervisory twins is status-INCLUSIVE.**
 * `assertAgentInTenant` uses `findAnyByUserAndTenant`, which does not filter
 * `status`. Offboarding sets `revoked` rather than deleting, so asked the
 * active-only way a DEPARTED agent's record answered "not a member of this
 * workspace" — the exact dispute this surface is justified by, since a supervisor
 * reads somebody's numbers AFTER they leave rather than while they are on the
 * roster. "A revoked row is still a row" is a claim about a SELECT, and only a
 * real revoked row can make it.
 *
 * **2. The API-key guards.** The defect was a false sentence — "a platform API
 * key carries a tenant and no user" — and it is false because
 * `sessionMiddleware` loads `platform_api_keys.created_by` into `request.user`.
 * A test that fabricates `request.apiKeyTenantId` on a synthetic request is
 * therefore asserting against its own model of the thing that was wrong. Here the
 * key is a real row, the `created_by` is a real supervisor, the hash is computed
 * by the real `hashApiKey`, and the user on the request arrives because the real
 * middleware put it there. That is the only arrangement in which "only a
 * NULL-`created_by` system key was ever refused" could have been discovered.
 *
 * **3. Tenancy and RBAC.** `X-Account-Id` naming an account outside the tenant is
 * refused by `tenantContextMiddleware` against the real `accounts` table — a
 * mocked middleware assigns the header verbatim, which is precisely the bug that
 * was there before. And a supervisor in tenant A reading an agent in tenant B is
 * a `memberships` query with a tenant predicate.
 *
 * ── WHAT THE FIRST REAL RUN FOUND, AND WHY IT COST A WHOLE ROUND ───────────
 * This file was written where no Docker daemon exists (`/var/run/docker.sock` is
 * absent, so `npm run test:integration` cannot bring the test stack up) and its
 * header used to say it had never executed. Its first real run failed **26 of 39
 * cases**, and not one failure was a guard: every one was
 * `403 X-Account-Id does not belong to this tenant`, produced by this file's OWN
 * mock of `tenant-name-resolver.js`, which stubbed `getCachedAccountRecord` to
 * `null` — the read behind `accountBelongsToTenant` in
 * `tenant-context.middleware.ts`. A stub taken for a display-name decoration was
 * in fact an authorization dependency, and it refused every request in the file
 * before any route ran. See that mock's docstring.
 *
 * Three things are now built into the file rather than written down.
 *
 *  1. **Mock sets are spread from the real module** (`importOriginal`) instead of
 *     listed by hand — here for `tenant-name-resolver` and for `config` — so an
 *     authorization read cannot be nulled by omission.
 *  2. **Every status assertion carries the response body**, via `seen()` from the
 *     integration harness. Five layers on these routes answer 403 with five
 *     different messages; 26 failures reading `expected 200, received 403` and
 *     nothing else is what turned a one-line mock bug into a source-reading
 *     round trip. If a case here fails again, read the `body` in the diff — it
 *     names the layer.
 *  3. The cross-tenant-headers case names a **caller**. It used to send tenant
 *     B's headers with no `x-user-id` at all, so it was answered `401 User
 *     context not found` and could not tell a missing tenant predicate from a
 *     missing header. See that case.
 *
 * It has since been run to green against a real Postgres 16 and Redis 7 on the
 * ports `docker/test-docker-compose.yml` publishes. What backs it when the stack
 * is unavailable: it type-checks under `npm run lint:test`
 * (the non-gating report); both harnesses are copied rather than invented,
 * module path for module path; the key is minted through the same
 * `generatePlatformApiKey`/`hashApiKey`/`insertPlatformApiKey` trio the
 * platform-key suite already uses successfully; and each refusal asserted here
 * has a mutation-verified unit twin, so this file is checking the guard survives
 * the real chain rather than discovering what the guard does.
 *
 * Still worth watching: the negative controls (`the key is not simply broken`,
 * `an account_admin is admitted on both twins`) depend on the credential
 * authenticating successfully somewhere, so if the whole file goes red at once,
 * suspect the fixtures and the mocks before the guards — which is exactly what

/*
 * PORT NOTE (magick-agency): ported from master
 * `test/integration/api/agency-performance-access.test.ts`@a1f0756a, on agency's test
 * database (Postgres 5436). Master's header above is kept as the record; what changed:
 *
 *  - **The core hop runs core's REAL handler.** Master mocked `proxyToCore` to answer 200 for
 *    everything. Here `callCore` (decision B16) is spied under master's name
 *    `mocks.proxyToCore` and delegates to the real `callCore` → core's
 *    `agency-agents.routes.ts` handlers on the private core instance (`buildCoreHandlers`),
 *    with `agency_dialer_enabled` on for the tenant. So a 200 is core's real answer over real
 *    rows, and every "core really was asked" assertion is still on the spy's arguments. The
 *    stats reads carry a window (`STATS_WINDOW`) because core's real handler requires `from`
 *    and `to` — master's mock answered 200 without them.
 *  - **The auth chain is the same split master used:** `sessionMiddleware` is a seam (no
 *    Firebase here; `x-user-id` becomes `request.user`), while `tenantContextMiddleware` and
 *    `requirePermission` are the REAL modules against real `memberships` / `accounts` rows
 *    (the Redis cache always misses; only the courtesy name resolver is stubbed — master's
 *    reasoning for both is kept below). `src/db/connection.js` → `initDbPool` on the test DB;
 *    the `config` / governance / metrics / Firebase mocks are gone (no governance, no key
 *    branch to reach Firebase or the auth metric).
 *  - **Platform API keys are gone (decision #5):** section 2 (14 cases) and the four key
 *    cases of section 3 are DELETED; `createKey`, `insertPlatformApiKey` and the
 *    `x-platform-key` dispatch with them.
 *  - **Section 3's two signed-in cases** ("but a SIGNED-IN supervisor is allowed, and does
 *    carry on_behalf", "and a signed-in AGENT is allowed WITHOUT on_behalf") assert
 *    `proxy-agency-agent.routes.ts` (the agent-actions family, a runtime route after Phase 6),
 *    which is not this family's file and is not registered here. They are listed for that
 *    family's port in PORTING.md; nothing about them is changed.
 *  - **NEW:** a malformed `:userId` answers the route's own 400 before any SQL (the 22P02
 *    carry-forward, one case per family), and a sibling ACCOUNT's work for the same agent
 *    never reaches a supervisor of this account (the exit gate's account isolation, which
 *    only real rows can show).
 *  - `seen` is master's integration helper, copied verbatim (agency's shared test-utils is
 *    lead-owned and does not carry it).
 */

const mocks = vi.hoisted(() => ({
  proxyToCore: vi.fn(),
  /** The real `callCore`, captured from the actual module; the spy's implementation. */
  realCallCore: null as null | ((...args: unknown[]) => Promise<unknown>),
}));

initDbPool({ url: TEST_DB_URL, poolMin: 0, poolMax: 4 });

// The in-process seam (decision B16). Everything else in the module is the real one, so
// `setCoreHandlers` (below) installs the private core instance the real `callCore` runs.
vi.mock('../../../src/api/core-dispatch.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/api/core-dispatch.js')>();
  mocks.realCallCore = actual.callCore as (...args: unknown[]) => Promise<unknown>;
  return { ...actual, callCore: mocks.proxyToCore };
});

/**
 * ── `sessionMiddleware`: the one irreducible seam ──────────────────────────
 *
 * PORT NOTE (magick-agency): master's stub was a DISPATCHER — real implementation when
 * `X-Platform-Key` was present, `x-user-id` otherwise. The key branch is gone with platform
 * keys (decision #5), so only the Firebase stand-in remains: attach `x-user-id` as the session
 * user, which is what a verified Firebase token would have produced.
 *
 * Note what is NOT seamed: `tenantContextMiddleware` and `requirePermission` are
 * the real modules, so every tenancy and RBAC decision below is made against real
 * `memberships` and `accounts` rows.
 */
vi.mock('../../../src/auth/session.middleware.js', () => ({
  sessionMiddleware: async (request: never) => {
    const r = request as unknown as {
      headers: Record<string, string | undefined>;
      user?: { id: string; status: string };
    };
    const userId = r.headers['x-user-id'];
    if (userId) r.user = { id: userId, status: 'active' };
  },
}));

/**
 * A cache that always MISSES, so every membership and account decision below is
 * made against Postgres.
 *
 * That is not laziness about Redis: `tenantContextMiddleware` and
 * `sessionMiddleware` both read through this cache, and a cache that returned
 * anything would mean the tenancy assertions were checking a fixture rather than
 * a query. `set` is accepted and discarded for the same reason — a second request
 * in the same case must re-read the table.
 */
vi.mock('../../../src/cache/redis-cache.js', () => ({
  redisCache: {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue(undefined),
    del: vi.fn().mockResolvedValue(undefined),
    delByPattern: vi.fn().mockResolvedValue(undefined),
    // Q5 (Manas, 2026-10-09): revocation deletes forward to `del` and report success.
    async delForRevocation(this: { del: (...k: string[]) => unknown }, ...k: string[]) { await this.del(...k); return true; },
  },
}));

/**
 * ── ONE function stubbed here, and the other two MUST stay real ────────────
 *
 * `resolveTenantAccountNames` is best-effort courtesy on the way to core (it
 * decorates a request, it never fails one) and has its own tests, so it is
 * stubbed to keep its reads and its PostHog group call out of the assertions
 * below.
 *
 * `getCachedAccountRecord` is a completely different animal despite living in the
 * same module: it is the read behind `accountBelongsToTenant` in
 * `tenant-context.middleware.ts`, i.e. the **authorization** decision "does this
 * `X-Account-Id` belong to this `X-Tenant-Id`". Stubbing it to `null` makes that
 * check answer *no* for every account that exists, so every request in this file
 * — all of which carry `X-Account-Id` — is refused
 * `403 X-Account-Id does not belong to this tenant` before any route, guard or
 * RBAC floor runs.
 *
 * So the module is spread and only the name resolver is replaced. The two record
 * loaders then read the real `accounts`/`tenants` rows through the always-missing
 * cache above, which is what this file's whole "real chain against real rows"
 * claim requires.
 */
vi.mock('../../../src/services/tenant-name-resolver.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/services/tenant-name-resolver.js')>();
  return {
    ...actual,
    resolveTenantAccountNames: vi.fn().mockResolvedValue({ tenantName: undefined, accountName: undefined }),
  };
});

vi.mock('@magick-agency/observability', async (importOriginal) => {
  const child = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() });
  return {
    ...(await importOriginal<typeof import('@magick-agency/observability')>()),
    createChildLogger: child,
    logger: { ...child(), child },
  };
});

const { proxyAgencyPerformanceRoutes } = await import(
  '../../../src/api/routes/proxy-agency-performance.routes.js'
);
const { proxyAgencyStaffingRoutes } = await import(
  '../../../src/api/routes/proxy-agency-staffing.routes.js'
);
const { agencyCampaignAgentRepository } = await import(
  '@magick-agency/db/repositories/agency-campaign-agent.repository'
);
const { buildCoreHandlers } = await import('../../../src/api/core-handlers.js');
const { setCoreHandlers } = await import('../../../src/api/core-dispatch.js');
const { getFeatureFlagService } = await import('../../../src/feature-flags/index.js');

const PREFIX = '/proxy/agency';
const CAMPAIGN = '44444444-4444-4444-8444-444444444444';
/**
 * PORT NOTE (magick-agency): core's real stats handler REQUIRES `from` and `to` (a defaulted
 * aggregate window would be worse than a refusal — `agent-record.ts` `parseAgentStatsQuery`).
 * Master's mocked core answered 200 without them, so the stats reads here carry one.
 */
const STATS_WINDOW = 'from=2026-08-01T00:00:00.000Z&to=2026-08-23T00:00:00.000Z';

/** A response's status paired with its body, for {@link seen}. */
interface SeenResponse {
  status: number;
  body: unknown;
}

/** master `test/integration/setup/test-utils.ts` `seen`, verbatim. */
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

/** The path a twin is read at, with the window the stats twin needs. */
function twinUrl(userId: string, suffix: 'stats' | 'attempts'): string {
  return `${PREFIX}/agents/${userId}/${suffix}${suffix === 'stats' ? `?${STATS_WINDOW}` : ''}`;
}

/**
 * The five `my-*` routes. All of them go through `resolveMyAgentId`, and the whole
 * reason that helper is exported and shared is that five handlers hitting one
 * condition must not answer it five ways.
 *
 * `/my-assignment` (singular, deprecated) is included deliberately: it is the
 * route a browser tab loaded before the current release is still calling, so it
 * is the one most likely to be forgotten in a guard change and the one an
 * attacker would reach for.
 *
 * PORT NOTE (magick-agency): `/my-stats` carries {@link STATS_WINDOW} (core's real handler
 * requires it).
 */
const MY_ROUTES = [
  `/my-stats?${STATS_WINDOW}`,
  '/my-attempts',
  '/my-campaigns',
  '/my-assignments',
  '/my-assignment',
] as const;

describe('agency agent surfaces — access control through the REAL chain (integration)', () => {
  let app: FastifyInstance;
  let core: FastifyInstance;
  let tenant: { id: string };
  let otherTenant: { id: string };
  let account: { id: string };
  /** An account belonging to `otherTenant` — the cross-tenant `X-Account-Id`. */
  let foreignAccount: { id: string };
  let supervisor: { id: string };
  let agent: { id: string };

  beforeAll(async () => {
    // Core's agency handler modules on their private instance, exactly as `agencyPlugin`
    // builds them. Only `/agency-agents/*` (and staffing's `GET /agency-campaigns/:id`) are
    // reached from these plugins, and neither reads the runtime deps.
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
    mocks.proxyToCore.mockReset().mockImplementation(mocks.realCallCore!);

    await truncateAll();
    tenant = await insertTenant();
    otherTenant = await insertTenant();
    account = await insertAccount({ tenant_id: tenant.id });
    foreignAccount = await insertAccount({ tenant_id: otherTenant.id });

    supervisor = await insertUser({ display_name: 'Sam Supervisor' });
    await insertMembership({
      user_id: supervisor.id, tenant_id: tenant.id, account_id: account.id, role: 'account_admin',
    });
    agent = await insertUser({ display_name: 'Ada Agent' });
    await insertMembership({
      user_id: agent.id, tenant_id: tenant.id, account_id: account.id, role: 'agent',
    });
    // Core's `agency_dialer_enabled` gate (every `/agency-agents/*` handler's `gate`) — on for
    // both tenants, so no refusal below can be the flag's.
    await enableDialer(tenant.id);
    await enableDialer(otherTenant.id);

    app = Fastify({ logger: false });
    // PORT NOTE (magick-agency): master registered all three plugins on the shared prefix
    // (`proxyAgencyAgentRoutes`, staffing, performance). The agent-actions plugin is another
    // family's port (a runtime route after Phase 6) and is not registered; its two cases are
    // listed in PORTING.md.
    await app.register(proxyAgencyStaffingRoutes, { prefix: PREFIX });
    await app.register(proxyAgencyPerformanceRoutes, { prefix: PREFIX });
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

  /** A signed-in caller with a real membership row. */
  async function asUser(role: string, opts: { accountId?: string | null; tenantId?: string } = {}) {
    const user = await insertUser();
    await insertMembership({
      user_id: user.id,
      tenant_id: opts.tenantId ?? tenant.id,
      account_id: opts.accountId === undefined ? account.id : opts.accountId,
      role,
    });
    return user;
  }

  /** A tenant-scoped `agency_dialer_enabled = true` override (core's handler gate). */
  async function enableDialer(tenantId: string) {
    await getTestPool().query(
      `INSERT INTO feature_flag_overrides (flag_key, scope_type, tenant_id, value)
       VALUES ('agency_dialer_enabled', 'tenant', $1, 'true'::jsonb)`,
      [tenantId],
    );
    await getFeatureFlagService().invalidate({ tenantId });
  }

  /** Tenancy headers for the request. */
  function tenancy(overrides: Record<string, string | undefined> = {}) {
    const base: Record<string, string> = {
      'x-tenant-id': tenant.id,
      'x-account-id': account.id,
    };
    for (const [k, v] of Object.entries(overrides)) {
      if (v === undefined) delete base[k];
      else base[k] = v;
    }
    return base;
  }

  /**
   * Tenancy headers plus `X-User-Id`, i.e. a signed-in caller.
   *
   * The `sessionMiddleware` stub turns `x-user-id` into `request.user`; everything
   * after that — tenant context, account validation, RBAC — is the real chain
   * against real rows.
   */
  function asHeaders(userId: string, overrides: Record<string, string | undefined> = {}) {
    return { ...tenancy(overrides), 'x-user-id': userId };
  }

  /**
   * One dialled, connected attempt by `agentUserId` in the given account, dated inside
   * {@link STATS_WINDOW}. A real campaign, contact, session and attempt — what core's
   * agent reads join.
   */
  async function seedWork(agentUserId: string, owner: { tenantId: string; accountId: string }) {
    const dialed = new Date('2026-08-15T09:00:00Z');
    const campaign = await insertAgencyCampaign({
      tenant_id: owner.tenantId, account_id: owner.accountId, status: 'stopped',
    });
    const session = await insertAgentSession(campaign.id as string, {
      tenant_id: owner.tenantId, account_id: owner.accountId, agent_user_id: agentUserId,
      joined_at: new Date('2026-08-15T08:00:00Z'), left_at: new Date('2026-08-15T10:00:00Z'),
    });
    const contact = await insertAgencyContact(campaign.id as string, {
      tenant_id: owner.tenantId, account_id: owner.accountId, state: 'completed',
    });
    const attempt = await insertAgencyAttempt(campaign.id as string, contact.id as string, {
      tenant_id: owner.tenantId, account_id: owner.accountId,
      state: 'ended', outcome: 'connected', reserved_agent_id: session.id,
      created_at: dialed, dialed_at: dialed, bridged_at: dialed,
      ended_at: new Date(dialed.getTime() + 60_000),
    });
    return { campaign, session, contact, attempt };
  }

  // ═══ 1. The membership lookup is status-INCLUSIVE ══════════════════════════

  describe('the supervisory twins read a DEPARTED agent — a revoked row is still a row', () => {
    const twins = ['stats', 'attempts'] as const;

    it.each(twins)('agents/:userId/%s: 200 for a REVOKED membership', async (suffix) => {
      /**
       * The dispute case. A supervisor reads somebody's numbers after they leave,
       * so `findByUserAndTenant` (active-only) was the wrong lookup: it answered
       * "that user is not a member of this workspace" for exactly the departed
       * agent the question is about.
       *
       * Revoked by an UPDATE on the real row, which is what
       * `removeGuardingLastOwner` does — it does not delete.
       */
      const departed = await asUser('agent');
      await getPoolQuery(
        `UPDATE memberships SET status = 'revoked' WHERE user_id = $1 AND tenant_id = $2`,
        [departed.id, tenant.id],
      );

      const res = await app.inject({
        method: 'GET',
        url: twinUrl(departed.id, suffix),
        headers: asHeaders(supervisor.id),
      });

      expect(seen(res)).toMatchObject({ status: 200 });
      // And core really was asked — a 200 the route invented would prove nothing.
      expect(mocks.proxyToCore).toHaveBeenCalledWith(
        expect.objectContaining({ path: `/agency-agents/${departed.id}/${suffix}` }),
      );
    });

    it.each(twins)('agents/:userId/%s: 404 for a user who was NEVER in this tenant', async (suffix) => {
      /**
       * The predicate that is UNCHANGED. Widening the lookup to include revoked
       * rows widens WHO can be read, not WHAT — the tenant predicate is still in
       * the same statement, so a user who never belonged here is refused exactly as
       * before.
       *
       * A real user row, not a random UUID: the distinction between "no membership"
       * and "no user" must not be observable, and a nonexistent id would only test
       * the easier half.
       */
      const stranger = await insertUser();

      const res = await app.inject({
        method: 'GET',
        url: twinUrl(stranger.id, suffix),
        headers: asHeaders(supervisor.id),
      });

      expect(seen(res)).toMatchObject({ status: 404 });
      expect(mocks.proxyToCore).not.toHaveBeenCalled();
    });

    it.each(twins)('agents/:userId/%s: 404 — never 403 — for an agent in ANOTHER tenant', async (suffix) => {
      /**
       * Rule 3 of docs/reference/magick-master/CLAUDE.md's RBAC section: a cross-tenant id and a nonexistent one
       * must be indistinguishable, or the response is a user-id oracle. This is the
       * boundary core CANNOT enforce on master's behalf — `agent_user_id` is an
       * opaque string to core, with no user table and no FK behind it (D3), so it
       * would happily return that person's attempts and talk time.
       */
      const foreign = await asUser('agent', { tenantId: otherTenant.id, accountId: null });

      const res = await app.inject({
        method: 'GET',
        url: twinUrl(foreign.id, suffix),
        headers: asHeaders(supervisor.id),
      });

      expect(seen(res)).toMatchObject({ status: 404 });
      expect(mocks.proxyToCore).not.toHaveBeenCalled();
    });

    it('a cross-tenant id and an unknown id are byte-identical', async () => {
      // The oracle property, stated as one assertion rather than inferred from two
      // separate 404s that happen to agree.
      const foreign = await asUser('agent', { tenantId: otherTenant.id, accountId: null });
      const stranger = await insertUser();

      const a = await app.inject({
        method: 'GET', url: twinUrl(foreign.id, 'stats'), headers: asHeaders(supervisor.id),
      });
      const b = await app.inject({
        method: 'GET', url: twinUrl(stranger.id, 'stats'), headers: asHeaders(supervisor.id),
      });

      // Status AND body in one comparison — the same conjunction as asserting the
      // two separately, and it puts both bodies in the diff. Which is the point
      // here: "these two agree" failing tells you nothing without seeing what
      // each one said.
      expect(seen(a)).toEqual(seen(b));
      // And the answer they agree on must still be the 404, not a shared 403 from
      // a layer upstream of the subject check. Asserted explicitly because two
      // responses agreeing is exactly as true when both are wrong.
      expect(seen(a)).toMatchObject({ status: 404 });
    });

    it('the SUBJECT may be revoked but the CALLER may not', async () => {
      /**
       * The asymmetry that makes the widened lookup safe, and the reason it is a
       * second repository method rather than a flag on the first: every existing
       * caller of the active-only lookup is an AUTHORIZATION decision and would be
       * wrong with more rows.
       *
       * `tenantContextMiddleware` refuses a revoked caller ("No active membership
       * for this context"), so a departed supervisor cannot use their own departure
       * to keep reading. Asserted here because it is the property somebody would
       * break by "consistently" widening both lookups.
       */
      await getPoolQuery(
        `UPDATE memberships SET status = 'revoked' WHERE user_id = $1 AND tenant_id = $2`,
        [supervisor.id, tenant.id],
      );

      const res = await app.inject({
        method: 'GET', url: twinUrl(agent.id, 'stats'), headers: asHeaders(supervisor.id),
      });

      expect(seen(res)).toMatchObject({ status: 403 });
      expect(mocks.proxyToCore).not.toHaveBeenCalled();
    });
  });

  // ═══ 2. The API-key guards ════════════════════════════════════════════════
  //
  // PORT NOTE (magick-agency): DELETED with platform API keys (decision #5) — master's
  // describe "a platform API key is refused on every my-* route", 14 cases:
  //  - "%s: refuses a CREATOR-BACKED key with missing_actor" × 5 (MY_ROUTES)
  //  - "%s: refuses a SYSTEM key EARLIER — no membership, no access" × 5 (MY_ROUTES)
  //  - "refuses BOTH key shapes and lets neither reach core"
  //  - "never names the key CREATOR in the refusal"
  //  - "the key is not simply broken — it reaches a SUPERVISORY route fine"
  //  - "a key for ANOTHER tenant cannot name this tenant"
  // No credential other than a session exists, and `tenantContextMiddleware` /
  // `requirePermission` have no key branch left to reach.

  // ═══ 3. The same guard on the agency WRITE actions ════════════════════════
  //
  // PORT NOTE (magick-agency): master's describe "a platform API key is refused on the agency
  // WRITE actions too", 6 cases, none kept here:
  //  - "$name: refused with missing_actor, and nothing reaches core" × 4 (disposition, station
  //    join, mark-DNC, notes): DELETED with platform API keys (decision #5);
  //  - "but a SIGNED-IN supervisor is allowed, and does carry on_behalf" and "and a signed-in
  //    AGENT is allowed WITHOUT on_behalf": they assert `proxy-agency-agent.routes.ts`
  //    (`resolveAgencyActor` on `POST /attempts/:id/disposition`), the agent-actions family —
  //    a runtime route after Phase 6, not registered here. Carried to that family's port.

  // ═══ 4. RBAC and tenancy through the real middleware chain ════════════════

  describe('RBAC on the supervisory twins, against roles read from the memberships table', () => {
    it.each(['agent', 'viewer', 'operator'])('a %s is refused on both twins', async (role) => {
      /**
       * The split that stops this being a peer-surveillance surface. An `agent`
       * holds the four `agency.*` permissions and nothing else, and
       * `agency.supervise` floors at `account_admin` (30) — which `operator` (20)
       * cannot reach either, so the floor is genuinely "account_admin", not
       * "above agent".
       */
      const caller = await asUser(role);

      const results = await Promise.all([
        app.inject({ method: 'GET', url: twinUrl(agent.id, 'stats'), headers: asHeaders(caller.id) }),
        app.inject({ method: 'GET', url: twinUrl(agent.id, 'attempts'), headers: asHeaders(caller.id) }),
      ]);

      expect(results.map(seen)).toMatchObject([{ status: 403 }, { status: 403 }]);
      expect(mocks.proxyToCore).not.toHaveBeenCalled();
    });

    it('an account_admin is admitted on both twins', async () => {
      // The contrast case, so "403 for everyone" cannot pass the block above.

      const results = await Promise.all([
        app.inject({ method: 'GET', url: twinUrl(agent.id, 'stats'), headers: asHeaders(supervisor.id) }),
        app.inject({ method: 'GET', url: twinUrl(agent.id, 'attempts'), headers: asHeaders(supervisor.id) }),
      ]);

      expect(results.map(seen)).toMatchObject([{ status: 200 }, { status: 200 }]);
    });

    it('a bare AGENT reaches every my-* route', async () => {
      /**
       * The floor that is the whole design. `agent` is hierarchy level 5, BELOW
       * `viewer` (10), so it inherits nothing that predates the agency feature —
       * and the obvious-looking gate for a stats read, `proxy.contact_lists.read`,
       * floors at `viewer`. Choosing it 403s the only role these routes exist for
       * while reading as entirely reasonable in review.
       *
       * Asserted against roles read from the real `memberships` table, so a floor
       * change is caught by behaviour and not only by the matrix assertions in the
       * unit suite.
       *
       * PORT NOTE (magick-agency): master stubbed core's campaign answer
       * (`{ id, name: 'Q3 Renewals', status: 'running' }`); here the campaign is a real row
       * owned by the caller's account, which the staffing routes' in-process
       * `GET /agency-campaigns/:id` reads.
       */
      await insertAgencyCampaign({
        id: CAMPAIGN, tenant_id: tenant.id, account_id: account.id, name: 'Q3 Renewals', status: 'running',
      });
      await agencyCampaignAgentRepository.assign({
        tenant_id: tenant.id, account_id: account.id, campaign_id: CAMPAIGN, user_id: agent.id,
      });

      for (const route of MY_ROUTES) {
        const res = await app.inject({ method: 'GET', url: `${PREFIX}${route}`, headers: asHeaders(agent.id) });
        expect(seen(res), route).toMatchObject({ status: 200 });
      }
    });
  });

  describe('tenancy — X-Account-Id is validated against X-Tenant-Id', () => {
    it('refuses an account that belongs to ANOTHER tenant', async () => {
      /**
       * The header used to be assigned to `request.accountId` verbatim. The
       * tenant-wide membership fallback (`m.account_id === null`) grants access to
       * every account IN THAT TENANT and has no account to compare against, so
       * naming a foreign account satisfied it — and the resolved display name then
       * went to core as `x-mgkvc-account-name`, which is a read leak.
       *
       * Only expressible against the real middleware and a real `accounts` row: a
       * mocked tenant-context assigns the header, which IS the bug.
       */
      const tenantWide = await asUser('account_admin', { accountId: null });

      const res = await app.inject({
        method: 'GET',
        url: twinUrl(agent.id, 'stats'),
        headers: asHeaders(tenantWide.id, { 'x-account-id': foreignAccount.id }),
      });

      expect(seen(res)).toMatchObject({ status: 403 });
      expect(mocks.proxyToCore).not.toHaveBeenCalled();
    });

    it('refuses a foreign account on a my-* route as well', async () => {
      // The `my-*` half. These routes forward `request.accountId` to core, so a
      // foreign one reaching them is the same leak one route over.

      const res = await app.inject({
        method: 'GET',
        url: `${PREFIX}/my-stats?${STATS_WINDOW}`,
        headers: asHeaders(agent.id, { 'x-account-id': foreignAccount.id }),
      });

      expect(seen(res)).toMatchObject({ status: 403 });
      expect(mocks.proxyToCore).not.toHaveBeenCalled();
    });

    it('refuses a MALFORMED account id with a 4xx, not a masked 500', async () => {
      /**
       * A non-UUID reaches a `UUID` column and raises Postgres `22P02` from inside
       * the query. `tenantContextMiddleware` maps that to a refusal rather than
       * letting it propagate as a 500 — because `errorMaskHook` masks every 5xx, so
       * a typo would come back as "contact support and quote this request id" and
       * would land in the 5xx rate as though it were a server fault.
       */

      const res = await app.inject({
        method: 'GET',
        url: `${PREFIX}/my-stats?${STATS_WINDOW}`,
        headers: asHeaders(agent.id, { 'x-account-id': 'not-a-uuid' }),
      });

      // A range, so it cannot be folded into `toMatchObject`; the body is passed as
      // the assertion message instead, so a 500 here still says WHAT threw rather
      // than only that 500 is not below 500.
      const refusal = seen(res);
      const note = JSON.stringify(refusal.body);
      expect(refusal.status, note).toBeGreaterThanOrEqual(400);
      expect(refusal.status, note).toBeLessThan(500);
    });

    it('a caller with no membership in this tenant is refused before any read', async () => {
      const outsider = await asUser('account_admin', { tenantId: otherTenant.id, accountId: null });

      const res = await app.inject({
        method: 'GET', url: twinUrl(agent.id, 'stats'), headers: asHeaders(outsider.id),
      });

      expect(seen(res)).toMatchObject({ status: 403 });
      expect(mocks.proxyToCore).not.toHaveBeenCalled();
    });

    it('a supervisor in tenant A cannot read an agent in tenant B, from B’s own headers either', async () => {
      /**
       * The other direction of the cross-tenant case: rather than naming a foreign
       * SUBJECT, the caller names the foreign TENANT. Refused by membership, not by
       * the subject check — two independent boundaries, and the case exists so that
       * removing either one is visible.
       *
       * ── The caller has to be a CALLER ─────────────────────────────────────
       * These headers carried tenant B's tenant and account and **no `x-user-id`**,
       * so the dispatching `sessionMiddleware` stub attached no `request.user` and
       * `tenantContextMiddleware` answered `401 User context not found` before it
       * ever reached the membership query. That is a real refusal, but it is the
       * unauthenticated one — the case as written could not distinguish a missing
       * tenant predicate from a missing header, which is the boundary it exists to
       * hold. The supervisor is now named as the caller, so the 403 comes from
       * `findByUserAndTenant(supervisor, otherTenant)` returning no rows: "You are
       * not a member of this tenant".
       */
      const foreignAgent = await asUser('agent', { tenantId: otherTenant.id, accountId: foreignAccount.id });

      const res = await app.inject({
        method: 'GET',
        url: twinUrl(foreignAgent.id, 'stats'),
        headers: asHeaders(supervisor.id, {
          'x-tenant-id': otherTenant.id,
          'x-account-id': foreignAccount.id,
        }),
      });

      expect(seen(res)).toMatchObject({ status: 403 });
      expect(mocks.proxyToCore).not.toHaveBeenCalled();
    });

    it('requires X-Tenant-Id at all', async () => {

      const res = await app.inject({
        method: 'GET', url: `${PREFIX}/my-stats?${STATS_WINDOW}`, headers: {},
      });

      expect(seen(res)).toMatchObject({ status: 400 });
    });
  });

  // ═══ 5. NEW in the port: what only an in-process core over real rows can show ═══

  describe('malformed ids and account isolation, in-process (new in the port)', () => {
    it('a malformed :userId is the route’s own 400 on both twins, before any SQL', async () => {
      /**
       * PORT NOTE (magick-agency): NEW (B1/B2 22P02 carry-forward, one case per family).
       * `memberships.user_id` and `agency_agent_sessions.agent_user_id` are UUID columns, so
       * a non-UUID reaching either is Postgres `22P02`. Master's `agentParamsSchema`
       * (`z.string().uuid()`) refuses it first with `400 Validation Error` — the answer kept
       * here — so neither the membership read nor core is reached.
       */
      for (const suffix of ['stats', 'attempts'] as const) {
        const res = await app.inject({
          method: 'GET',
          url: twinUrl('not-a-uuid', suffix),
          headers: asHeaders(supervisor.id),
        });
        expect(seen(res), suffix).toMatchObject({ status: 400, body: { error: 'Validation Error' } });
      }
      expect(mocks.proxyToCore).not.toHaveBeenCalled();
    });

    it('a sibling ACCOUNT’s work for the same agent never reaches this account’s supervisor', async () => {
      /**
       * PORT NOTE (magick-agency): NEW (Phase 8 exit gate: tenant/account isolation on real
       * Postgres). `assertAgentInTenant` is a TENANT check, so an agent who also works in a
       * sibling account of this tenant is admitted as a subject — and what keeps the sibling
       * account's numbers out is core's account predicate (`s.account_id = …` on the session),
       * reached in-process with this request's `X-Account-Id`. Seeded on BOTH sides, so an
       * empty answer cannot be an empty fixture: the sibling account's own admin sees the work.
       */
      const sibling = await insertAccount({ tenant_id: tenant.id });
      await seedWork(agent.id, { tenantId: tenant.id, accountId: sibling.id });
      const siblingAdmin = await asUser('account_admin', { accountId: sibling.id });

      const stats = await app.inject({
        method: 'GET', url: twinUrl(agent.id, 'stats'), headers: asHeaders(supervisor.id),
      });
      const attempts = await app.inject({
        method: 'GET', url: twinUrl(agent.id, 'attempts'), headers: asHeaders(supervisor.id),
      });
      expect(seen(stats)).toMatchObject({ status: 200, body: { totals: { attempts: 0 } } });
      expect(seen(attempts)).toMatchObject({ status: 200, body: { rows: [] } });

      const control = await app.inject({
        method: 'GET',
        url: twinUrl(agent.id, 'attempts'),
        headers: asHeaders(siblingAdmin.id, { 'x-account-id': sibling.id }),
      });
      expect(seen(control)).toMatchObject({ status: 200 });
      expect((control.json() as { rows: unknown[] }).rows).toHaveLength(1);
    });
  });
});

/**
 * A raw statement against the test pool.
 *
 * Declared here rather than imported so these fixtures and the repositories (which
 * share `@magick-agency/db`'s pool, initialised on the same test database above)
 * cannot diverge.
 */
async function getPoolQuery(text: string, values: unknown[]) {
  return getTestPool().query(text, values);
}
