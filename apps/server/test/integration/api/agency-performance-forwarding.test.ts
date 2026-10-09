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
 * ─── THE AGENT SURFACES THROUGH THE IN-PROCESS HOP ───────────────────────────
 *
 * `callCore` (decision B16) runs the REAL `agency-agents.routes.ts` handlers in-process on the
 * private internal handler instance (`buildCoreHandlers`, exactly as `agencyPlugin` builds it)
 * against real rows, with `agency_dialer_enabled` on for the tenant. `received[]` is a spy on
 * that instance's `inject`, i.e. the request the internal handler is actually given: the URL
 * `callCore` built with `new URLSearchParams(query)` and its headers. The handler's body is
 * whatever it answers from the rows a case seeds.
 *
 * ── Why this cannot be a unit test, and specifically what it buys ───────────
 * Unit tests of these routes mock `callCore`, which means the assertion is on the ARGUMENTS the
 * route handed a function. Four claims are not about arguments at all:
 *
 *  1. **`forwardAllowedQuery`'s output has to survive being turned into a URL.**
 *     `new URLSearchParams(req.query).toString()` is what actually happens to
 *     that record, and the array→CSV flattening, the blank-value drop and the
 *     whitelist all only matter as far as the bytes the internal handler receives. A mocked
 *     `callCore` asserts the record; the handler reads the query string.
 *  2. **"A hostile `?agent_user_id=` never reaches the internal handler"** — because the
 *     request is REFUSED rather than because the param is dropped. It is a claim about a
 *     request the handler did or did not see. Asserting it against a mock's argument list
 *     tests the whitelist; asserting it against `received[]` tests the whole hop,
 *     including the interpolated path segment the whitelist exists to protect.
 *  3. **Error classification.** Internal 4xx bodies pass through unchanged, and a 5xx is
 *     masked, on a real request through the real error handler.
 *  4. **An empty-but-successful record vs a failed read.** The handler answers 200 with
 *     zeroed totals for an agent who has done nothing. That must not be
 *     indistinguishable from a failure, and the distinction lives in the status
 *     and the body the handler sent.
 *
 * Values the internal handler really validates are real: `contact_id` is a seeded contact's
 * id, `cursor` is one the handler minted for this agent, and the stats reads that assert a 200
 * carry `STATS_WINDOW` (the real stats read requires `from`/`to`). There is no per-tenant API
 * key in-process, so the header cases assert `x-api-key` is ABSENT and keep the tenancy
 * headers the handler reads. The real zero record has `null` rates (never 0 — "we cannot
 * say"), so the zero cases assert the handler's own answer plus the keys being present.
 *
 * ── STATUS ASSERTIONS CARRY THE BODY ───────────────────────────────────────
 * Every status is asserted through `seen(res)` —
 * `expect(seen(res)).toMatchObject({ status: 200 })` — which asserts the status
 * exactly and puts the response BODY in the failure diff. The reason is
 * measured, not stylistic: `agency-performance-access.test.ts` once came back with 26
 * failures reading `expected 200, received 403` and nothing else, on routes where five
 * separate layers answer 403 with five different messages. Keep new assertions in this shape.
 */

const mocks = vi.hoisted(() => ({
  proxyToCore: vi.fn(),
  /** The real `callCore`, captured from the actual module; the spy's implementation. */
  realCallCore: null as null | ((...args: unknown[]) => Promise<unknown>),
  resolveAgentNames: vi.fn(),
  /** The real `resolveAgentNames`, the default implementation of the seam. */
  realResolveAgentNames: null as null | ((...args: never[]) => Promise<Map<string, string | null>>),
}));

initDbPool({ url: TEST_DB_URL, poolMin: 0, poolMax: 4 });

// The in-process seam (decision B16): a spy delegating to the real `callCore`, so a case can
// read the request the route built AND the internal handler's real answer.
vi.mock('../../../src/api/core-dispatch.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/api/core-dispatch.js')>();
  mocks.realCallCore = actual.callCore as (...args: unknown[]) => Promise<unknown>;
  return { ...actual, callCore: mocks.proxyToCore };
});

/**
 * Identity enrichment is stubbed at its narrowest seam — the name lookup — so the
 * real `enrichAgentStatsIdentity`/`enrichAttemptAgentNames` still run over the internal
 * handler's real response body. Mocking the enrichers themselves would hide whether they
 * preserve what came over the wire, which several cases below assert.
 *
 * The seam defaults to the REAL lookup, so the name a case asserts is read from the `users`
 * table.
 */
vi.mock('../../../src/agency/agency-agent-identity.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/agency/agency-agent-identity.js')>();
  mocks.realResolveAgentNames = actual.resolveAgentNames as never;
  return { ...actual, resolveAgentNames: mocks.resolveAgentNames };
});

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
      const membership = memberships.find((m) => m.account_id === request.accountId)
        ?? memberships.find((m) => m.account_id === null) ?? memberships[0];
      if (membership && membership.status === 'active') request.membership = membership;
    },
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
const { errorHandler } = await import('../../../src/api/middleware/error-handler.middleware.js');
const { buildCoreHandlers } = await import('../../../src/api/core-handlers.js');
const { setCoreHandlers } = await import('../../../src/api/core-dispatch.js');
const { getFeatureFlagService } = await import('../../../src/feature-flags/index.js');
const { agencyAgentStatsRepository } = await import('../../../src/db/repositories/agency.repository.js');

// ── What the internal handler was given ───────────────────────────────────────

interface ReceivedRequest {
  method: string;
  path: string;
  /** Every value for every key, so repeated params are observable. */
  query: Record<string, string[]>;
  /** The raw query string, for the cases that care about the exact bytes. */
  rawQuery: string;
  headers: Record<string, string | undefined>;
}

let core: FastifyInstance;
let injectSpy: { mock: { calls: unknown[][] } } | null = null;

/**
 * Every request `callCore` handed the private handler instance during this case, decoded
 * with `new URL(...)` and `getAll` per key.
 */
function received(): ReceivedRequest[] {
  return (injectSpy?.mock.calls ?? []).map(([opts]) => {
    const o = opts as { method: string; url: string; headers: Record<string, string | undefined> };
    const url = new URL(o.url, 'http://handler.in-process');
    const query: Record<string, string[]> = {};
    for (const key of new Set(url.searchParams.keys())) {
      query[key] = url.searchParams.getAll(key);
    }
    return { method: o.method, path: url.pathname, query, rawQuery: url.search, headers: o.headers };
  });
}

/** The internal handler's own answer to the Nth `callCore` of this case (the spy delegates to the real one). */
async function coreAnswer(n = 0): Promise<{ status: number; body: unknown }> {
  return (await mocks.proxyToCore.mock.results[n]!.value) as { status: number; body: unknown };
}

const PREFIX = '/proxy/agency';
/** The real stats read requires a window. */
const STATS_WINDOW = 'from=2026-08-01T00:00:00.000Z&to=2026-08-23T00:00:00.000Z';
const DIALED = new Date('2026-08-15T09:00:00Z');

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

describe('agency agent surfaces through the in-process internal hop (integration)', () => {
  let app: FastifyInstance;
  let tenant: { id: string };
  let account: { id: string };
  let supervisor: { id: string };
  let agent: { id: string };

  beforeAll(async () => {
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
    // Re-armed after `restoreAllMocks`, which restores `vi.spyOn` spies.
    injectSpy = vi.spyOn(core, 'inject') as unknown as { mock: { calls: unknown[][] } };
    mocks.proxyToCore.mockReset().mockImplementation(mocks.realCallCore!);
    mocks.resolveAgentNames.mockReset().mockImplementation(mocks.realResolveAgentNames!);

    await truncateAll();
    tenant = await insertTenant();
    account = await insertAccount({ tenant_id: tenant.id });
    supervisor = await insertUser({ display_name: 'Sam Supervisor' });
    await insertMembership({
      user_id: supervisor.id, tenant_id: tenant.id, account_id: account.id, role: 'account_admin',
    });
    agent = await insertUser({ display_name: 'Ada Agent' });
    await insertMembership({
      user_id: agent.id, tenant_id: tenant.id, account_id: account.id, role: 'agent',
    });
    await getTestPool().query(
      `INSERT INTO feature_flag_overrides (flag_key, scope_type, tenant_id, value)
       VALUES ('agency_dialer_enabled', 'tenant', $1, 'true'::jsonb)`,
      [tenant.id],
    );
    await getFeatureFlagService().invalidate({ tenantId: tenant.id });

    app = Fastify({ logger: false });
    // The response pipeline is the error handler alone (no mask hook here).
    app.setErrorHandler(errorHandler);

    await app.register(proxyAgencyPerformanceRoutes, { prefix: PREFIX });
    await app.ready();
  });

  afterEach(async () => {
    await app?.close();
  });

  afterAll(async () => {
    setCoreHandlers(null);
    await core?.close();
    await closeTestPool();
    await closePool();
  });

  // ── helpers ───────────────────────────────────────────────────────────────

  function headers(userId: string) {
    return {
      'x-tenant-id': tenant.id,
      'x-account-id': account.id,
      'x-user-id': userId,
    };
  }

  /**
   * Real attempts by `agent`, one per phone, on one campaign and one session — the rows
   * the `listForAgent` read joins (`reserved_agent_id` → the session that owns the agent).
   */
  async function seedAttempts(phones: readonly string[]) {
    const campaign = await insertAgencyCampaign({
      tenant_id: tenant.id, account_id: account.id, status: 'stopped',
    });
    const session = await insertAgentSession(campaign.id as string, {
      tenant_id: tenant.id, account_id: account.id, agent_user_id: agent.id,
      joined_at: new Date('2026-08-15T08:00:00Z'), left_at: new Date('2026-08-15T12:00:00Z'),
    });
    const out: { contactId: string; attemptId: string; campaignId: string }[] = [];
    for (const [i, phone] of phones.entries()) {
      const contact = await insertAgencyContact(campaign.id as string, {
        tenant_id: tenant.id, account_id: account.id, phone_e164: phone, state: 'completed',
      });
      const at = new Date(DIALED.getTime() + i * 60_000);
      const attempt = await insertAgencyAttempt(campaign.id as string, contact.id as string, {
        tenant_id: tenant.id, account_id: account.id,
        state: 'ended', outcome: 'connected', disposition_code: 'not_interested',
        reserved_agent_id: session.id,
        created_at: at, dialed_at: at, bridged_at: at, ended_at: new Date(at.getTime() + 30_000),
      });
      out.push({ contactId: contact.id as string, attemptId: attempt.id as string, campaignId: campaign.id as string });
    }
    return out;
  }

  // ═══ 1. The whitelisted filters actually arrive ═══════════════════════════

  describe('the attempt filters reach the internal handler as query bytes', () => {
    it('forwards `phone` and `contact_id` — the two that were silently dropped', async () => {
      /**
       * ── Why these two specifically ──────────────────────────────────────────
       * The internal handler APPLIES both on this endpoint: `parseAgentAttemptFilters` delegates
       * to the campaign spine's `parseAttemptFilters` ("the vocabulary is IMPORTED,
       * not forked") and `listForAgent` puts both into the statement.
       *
       * Omitting them from the whitelist did not REFUSE the filter, which
       * would at least be visible — it made `forwardAllowedQuery` drop the key silently,
       * so a `?phone=` search answered **200 with the agent's whole unfiltered
       * history**: a search control that looks like it matched everything rather
       * than one that failed. The console sends `phone`, so this is what makes
       * that control real.
       *
       * Asserted on what the internal handler RECEIVED, not on what the route passed to a
       * mock, because the failure was a key going missing between the two.
       *
       * `contact_id` is a real contact's id (the handler refuses a non-UUID), and the case
       * also asserts the EFFECT: of the agent's two attempts, the real statement returns only
       * the one both filters name.
       */
      const [wanted] = await seedAttempts(['+919812345678', '+919811111111']);

      const res = await app.inject({
        method: 'GET',
        url: `${PREFIX}/my-attempts?phone=%2B919812345678&contact_id=${wanted!.contactId}`,
        headers: headers(agent.id),
      });

      expect(seen(res)).toMatchObject({ status: 200 });
      expect(received()).toHaveLength(1);
      expect(received()[0]!.path).toBe(`/api/v1/agency-agents/${agent.id}/attempts`);
      // `+` survives as `+`, not as a space: `URLSearchParams` re-encodes it as
      // `%2B`, and a phone search that lost its leading plus matches nothing.
      expect(received()[0]!.query['phone']).toEqual(['+919812345678']);
      expect(received()[0]!.query['contact_id']).toEqual([wanted!.contactId]);
      expect((res.json() as { rows: { id: string }[] }).rows.map((r) => r.id)).toEqual([wanted!.attemptId]);
    });

    it('forwards the whole documented attempt vocabulary', async () => {
      // Every key on `AGENT_ATTEMPT_QUERY_PARAMS`, so a deletion from that list
      // shows up here as a missing filter rather than as a silent full-history read.
      //
      // `campaign_id` / `contact_id` are seeded rows and `cursor` is one the handler minted
      // for this agent (a first page of one), because the handler really parses all three;
      // and the read is asserted to be ANSWERED (200), which only a real parser accepting
      // every value can show.
      const rows = await seedAttempts(['+14155550101', '+14155550102']);
      const first = await app.inject({
        method: 'GET', url: `${PREFIX}/my-attempts?limit=1`, headers: headers(agent.id),
      });
      const cursor = (first.json() as { next_cursor: string }).next_cursor;
      expect(cursor).toEqual(expect.any(String));

      const query = new URLSearchParams({
        outcome: 'connected',
        state: 'ended',
        disposition_code: 'not_interested',
        campaign_id: rows[0]!.campaignId,
        contact_id: rows[0]!.contactId,
        phone: '+14155550101',
        from: '2026-08-01T00:00:00.000Z',
        to: '2026-08-23T00:00:00.000Z',
        cursor,
        limit: '25',
      });

      const res = await app.inject({
        method: 'GET',
        url: `${PREFIX}/my-attempts?${query.toString()}`,
        headers: headers(agent.id),
      });

      expect(seen(res)).toMatchObject({ status: 200 });
      const arrived = received()[1]!.query;
      for (const [key, value] of query.entries()) {
        expect(arrived[key], key).toEqual([value]);
      }
    });

    it('forwards the stats vocabulary and NOTHING else', async () => {
      /**
       * The whitelist's other direction, on a clean request: exactly the named
       * params arrive and nothing is added on the way.
       */
      const [row] = await seedAttempts(['+919812345678']);

      const res = await app.inject({
        method: 'GET',
        url: `${PREFIX}/my-stats?from=2026-08-01T00:00:00.000Z&to=2026-08-23T00:00:00.000Z`
          + `&bucket=day&campaign_id=${row!.campaignId}`,
        headers: headers(agent.id),
      });

      const arrived = received()[0]!.query;
      expect(Object.keys(arrived).sort()).toEqual(['bucket', 'campaign_id', 'from', 'to']);
      // The real handler answered the read.
      expect(seen(res)).toMatchObject({ status: 200 });
    });

    /**
     * An unrecognised param is REFUSED, and the internal handler is never called at all.
     *
     * This used to assert the opposite — that the key was silently dropped and the
     * request succeeded. That was the defect, not the protection: for a FILTER, a
     * dropped key means the handler answers 200 over an unfiltered population and the
     * console presents it as the rows matching the search. Refusing is the same
     * protection (the param still cannot reach the handler) plus a signal.
     */
    it('refuses an unrecognised param outright and never calls the internal handler', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `${PREFIX}/my-stats?from=2026-08-01T00:00:00.000Z&to=2026-08-23T00:00:00.000Z`
          + '&include_secret_totals=1&tenant_id=someone-else',
        headers: headers(agent.id),
      });

      expect(seen(res)).toMatchObject({ status: 400 });
      expect(res.json()).toMatchObject({ code: 'unknown_query_params' });
      expect(res.json().details.unknown.sort()).toEqual(['include_secret_totals', 'tenant_id']);
      // The whole point: the hostile params never reached the internal handler.
      expect(received()).toHaveLength(0);
    });
  });

  // ═══ 2. Array flattening and blank dropping ═══════════════════════════════

  describe('repeated and blank params, as they cross the wire', () => {
    it('flattens a REPEATED param to a single comma-separated value', async () => {
      /**
       * `forwardAllowedQuery` does `Array.isArray(value) ? value.map(String).join(',')`.
       * Fastify parses `?outcome=a&outcome=b` into an ARRAY, so without that
       * branch the value handed to `URLSearchParams` would stringify as
       * `"a,b"` anyway on some paths and as `[object Object]`-ish garbage on
       * others — and the filter parsers accept the comma form (the activity
       * route documents `action` as "repeatable or comma-separated").
       *
       * The assertion is that the internal handler receives ONE `outcome` key with the joined
       * value, not two keys — which is the shape its parser expects.
       */
      const res = await app.inject({
        method: 'GET',
        url: `${PREFIX}/my-attempts?outcome=connected&outcome=no_answer&outcome=busy`,
        headers: headers(agent.id),
      });

      expect(received()[0]!.query['outcome']).toEqual(['connected,no_answer,busy']);
      // One key, one value — the repetition did not survive as repetition.
      expect(received()[0]!.rawQuery).toContain('outcome=connected%2Cno_answer%2Cbusy');
      // The REAL parser accepts the joined form.
      expect(seen(res)).toMatchObject({ status: 200 });
    });

    it('drops a BLANK value rather than forwarding an empty filter', async () => {
      /**
       * `if (flat.trim().length === 0) continue`. A browser that renders an empty
       * select as `?disposition_code=` would otherwise ask the handler to filter on the
       * empty string — which matches nothing, so the agent's history comes back
       * empty and looks like "you have made no calls" rather than "your filter is
       * blank".
       *
       * Whitespace-only too, since `trim()` is what the guard uses and `%20` is
       * what a copied-and-pasted value carries.
       */
      await app.inject({
        method: 'GET',
        url: `${PREFIX}/my-attempts?disposition_code=&state=%20%20&outcome=connected`,
        headers: headers(agent.id),
      });

      const arrived = received()[0]!.query;
      expect(arrived['disposition_code']).toBeUndefined();
      expect(arrived['state']).toBeUndefined();
      // The real filter beside them is untouched — the drop is per key.
      expect(arrived['outcome']).toEqual(['connected']);
    });

    it('the internal handler sees an EMPTY query when nothing survives the whitelist', async () => {
      /**
       * Precisely, because the mechanism is worth stating rather than guessing at:
       * `forwardAllowedQuery` returns `{}`, and `{}` is TRUTHY — so `callCore`'s
       * `req.query ? '?' + … : ''` does append a bare `?`. Node's `URL` then
       * normalises `…/stats?` to an empty `search`, which is what the handler observes and
       * what this asserts.
       *
       * So the claim is "the handler sees no parameters", not "no `?` is emitted". Said
       * that way because a future reader would otherwise conclude one of the two is wrong.
       */

      // A request with no params at all. This used to send `?nothing_valid=1` and
      // rely on the whitelist emptying it out; an unrecognised key is now a 400,
      // so the empty-query mechanism is exercised the way it is actually reached.
      await app.inject({
        method: 'GET',
        url: `${PREFIX}/my-stats`,
        headers: headers(agent.id),
      });

      expect(received()[0]!.rawQuery).toBe('');
      expect(received()[0]!.query).toEqual({});
    });

    it('refuses a request whose ONLY param is unrecognised', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `${PREFIX}/my-stats?nothing_valid=1`,
        headers: headers(agent.id),
      });

      expect(seen(res)).toMatchObject({ status: 400 });
      expect(received()).toHaveLength(0);
    });
  });

  // ═══ 3. The hostile agent_user_id ════════════════════════════════════════

  describe('a caller-supplied agent id NEVER reaches the internal handler on a my-* route', () => {
    /**
     * ── The security property, stated as the request the handler receives ───────────────────
     * The subject of a `my-*` read is decided by the path segment the route builds
     * from `request.user.id`. `agent_user_id` is absent from BOTH whitelists on
     * purpose, and its absence IS the property rather than the documentation of
     * one: a route that honoured such a param would be a full read of any
     * colleague's history while passing every floor assertion in the suite.
     *
     * So the assertion is made where it cannot be fudged — on the request the internal handler
     * received: the path segment is the CALLER's id, and the string the caller
     * supplied appears nowhere in the URL.
     */
    const hostile = '99999999-9999-4999-8999-999999999999';

    /**
     * The hostile param is now REFUSED rather than dropped, so the strongest form
     * of the property is that the internal handler is never called at all: the hostile id cannot
     * appear in a request line that does not exist.
     *
     * This case used to assert a 200 with the param dropped. Refusal is the same
     * protection plus a signal — see the whitelist section above for why silence
     * was the wrong answer for a filter.
     */
    it.each(['my-stats', 'my-attempts'] as const)('%s: refuses it, and the internal handler is never called', async (route) => {
      const res = await app.inject({
        method: 'GET',
        url: `${PREFIX}/${route}?agent_user_id=${hostile}&user_id=${hostile}`,
        headers: headers(agent.id),
      });

      expect(seen(res)).toMatchObject({ status: 400 });
      expect(res.json()).toMatchObject({ code: 'unknown_query_params' });
      expect(received()).toHaveLength(0);
    });

    /**
     * And the subject still comes from the session on a clean request — the half
     * of the property the refusal above cannot show, because it never reaches
     * the internal handler. The path segment is the CALLER's id whatever the caller asked
     * for. `my-stats` carries `STATS_WINDOW` so the real handler answers 200.
     */
    it.each(['my-stats', 'my-attempts'] as const)('%s: the path segment is the CALLER', async (route) => {
      const res = await app.inject({
        method: 'GET',
        url: `${PREFIX}/${route}${route === 'my-stats' ? `?${STATS_WINDOW}` : ''}`,
        headers: headers(agent.id),
      });

      expect(seen(res)).toMatchObject({ status: 200 });
      const suffix = route === 'my-stats' ? 'stats' : 'attempts';
      expect(received()[0]!.path).toBe(`/api/v1/agency-agents/${agent.id}/${suffix}`);
      expect(`${received()[0]!.path}${received()[0]!.rawQuery}`).not.toContain(hostile);
    });

    it('an agent cannot reach a colleague by any route in this plugin', async () => {
      /**
       * The complement: the only surface that DOES take an id in the path is the
       * supervisory pair, and an `agent` is refused there by RBAC. Together the two
       * cases say there is no path from an agent's session to a colleague's
       * numbers — which is the actual product claim.
       */
      const res = await app.inject({
        method: 'GET',
        url: `${PREFIX}/agents/${supervisor.id}/attempts`,
        headers: headers(agent.id),
      });

      expect(seen(res)).toMatchObject({ status: 403 });
      expect(received()).toHaveLength(0);
    });

    it('the supervisory pair DOES take the id from the path, so the whitelist is not the only guard', async () => {
      // The contrast that keeps the case above meaningful: naming a subject is
      // done by the path, on the routes that are allowed to.
      await app.inject({
        method: 'GET',
        url: `${PREFIX}/agents/${agent.id}/stats`,
        headers: headers(supervisor.id),
      });

      expect(received()[0]!.path).toBe(`/api/v1/agency-agents/${agent.id}/stats`);
      expect(received()[0]!.query['agent_user_id']).toBeUndefined();
    });

    /**
     * `agent_user_id` is refused on the SUPERVISORY route too, and that is worth
     * a case of its own: the param is a legitimate filter on the campaign-scoped
     * spine, so the two allowlists genuinely differ and the difference is what is
     * being asserted.
     */
    it('refuses the param on the supervisory route as well', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `${PREFIX}/agents/${agent.id}/stats?agent_user_id=${hostile}`,
        headers: headers(supervisor.id),
      });

      expect(seen(res)).toMatchObject({ status: 400 });
      expect(received()).toHaveLength(0);
    });
  });

  // ═══ 4. The tenancy headers added to the internal request ════════════════

  describe('the headers the route attaches to the internal request', () => {
    it('sends the tenancy ids and no API key', async () => {
      /**
       * The internal handler reads tenant and account from headers. This hop is invisible to
       * any test that mocks `callCore` — the mock never builds a header.
       *
       * There is no credential in-process (the hop is a function call behind the public
       * session chain), so `x-api-key` is asserted ABSENT; the tenancy ids the handler reads
       * (`getTenantId` / `getAccountId`) are asserted present.
       */
      await app.inject({
        method: 'GET', url: `${PREFIX}/my-stats`, headers: headers(agent.id),
      });

      const sent = received()[0]!.headers;
      expect(sent['x-api-key']).toBeUndefined();
      expect(sent['x-mgkvc-tenant']).toBe(tenant.id);
      expect(sent['x-mgkvc-account']).toBe(account.id);
    });

    it('never forwards the caller’s own session headers to the internal handler', async () => {
      // `x-user-id` is this harness's stand-in for a Firebase bearer token, and
      // the handler must not see either: the actor travels in the PATH, not in a header.
      await app.inject({
        method: 'GET', url: `${PREFIX}/my-stats`, headers: headers(agent.id),
      });

      expect(received()[0]!.headers['x-user-id']).toBeUndefined();
      expect(received()[0]!.headers['authorization']).toBeUndefined();
    });

    it('sends exactly the headers the route is responsible for, and no more', async () => {
      /**
       * The whole outgoing set, so a header ADDED to this hop is noticed. Bounded
       * to the `x-mgkvc-*`/`x-api-key` family because the rest are Node's own
       * (`host`, `connection`, `accept`) and are not the route's decision.
       *
       * `x-api-key` is not in the expected set (there is no key); the filter still includes it
       * so a key appearing on the hop reds here.
       */
      await app.inject({
        method: 'GET', url: `${PREFIX}/my-stats`, headers: headers(agent.id),
      });

      const ours = Object.fromEntries(
        Object.entries(received()[0]!.headers)
          .filter(([k]) => k === 'x-api-key' || k.startsWith('x-mgkvc-')),
      );
      expect(ours).toEqual({
        'x-mgkvc-tenant': tenant.id,
        'x-mgkvc-account': account.id,
      });
    });
  });

  // ═══ 5. The internal handler's refusals, as the client receives them ═══════
  //
  // There is no error-mask hook on this app instance and no in-process producer of a 429, so
  // masking and rate-limit pass-through are not covered here.

  describe('the internal handler’s refusals and the route’s own, as the client receives them', () => {
    it('FORWARDS a structured 4xx with its `details` intact', async () => {
      /**
       * The other half of the policy, and the reason the allow-list exists: a 4xx
       * forwarded from the internal handler carries field-level validation
       * feedback. `details` is what makes this one forwardable, and it has to
       * arrive whole — a masked validation error tells the user to contact support
       * about a value they could have fixed themselves.
       *
       * The refusal is real: an outcome outside `ATTEMPT_OUTCOMES` is the handler's
       * `400 Validation failed` with `details`, asserted byte-identical to what the handler
       * answered.
       */
      const res = await app.inject({
        method: 'GET', url: `${PREFIX}/my-attempts?outcome=vibes`, headers: headers(agent.id),
      });

      const fromCore = await coreAnswer();
      expect(fromCore.status).toBe(400);
      expect(seen(res)).toMatchObject({ status: 400 });
      expect(res.json()).toEqual(fromCore.body);
      expect(res.json()).toMatchObject({
        error: 'Validation failed',
        details: [expect.objectContaining({ param: 'outcome' })],
      });
    });

    it('passes through the route’s own 4xx unchanged — it is not the internal handler’s', async () => {
      /**
       * Telling an error forwarded from the internal handler from one the route itself
       * raised. This 404 is `assertAgentInTenant`'s, returned BEFORE any internal call,
       * so it is left alone.
       *
       * The invariant it relies on — "a route's own client errors are returned
       * before any internal call" — is exactly what this case
       * checks holds on this surface.
       */
      const stranger = await insertUser();

      const res = await app.inject({
        method: 'GET',
        url: `${PREFIX}/agents/${stranger.id}/stats`,
        headers: headers(supervisor.id),
      });

      expect(seen(res)).toMatchObject({ status: 404 });
      expect(res.json()).toEqual({
        error: 'Not Found',
        message: 'That user is not a member of this workspace.',
      });
      expect(received()).toHaveLength(0);
    });
  });

  // ═══ 6. Empty-but-successful vs failed ═══════════════════════════════════

  describe('an agent with no activity is DISTINGUISHABLE from a failed read', () => {
    /**
     * ── Why this needs saying at all ────────────────────────────────────────
     * A new hire on their first shift, an agent who was staffed and never dialled,
     * and an agent whose stats query blew up all produce "no numbers on the
     * screen". Only the first two are correct, and an interface that renders them
     * the same way turns a real outage into "I suppose I have made no calls".
     *
     * The route reshapes nothing here, which is precisely what preserves the
     * distinction: the internal handler answers 200 with every counter present and zero, and a
     * failure is a masked non-2xx. The cases below assert that the two are
     * different at the status, at the body, and — for the client that only reads
     * `totals` — in whether `totals` exists at all.
     */
    it('a zero scorecard is a 200 with every counter present', async () => {
      // The REAL zero record (no rows seeded for this agent). Its rates are `null`, not 0
      // ("we cannot say"), so presence is asserted with `in`.
      const res = await app.inject({
        method: 'GET', url: `${PREFIX}/my-stats?${STATS_WINDOW}`, headers: headers(agent.id),
      });

      expect(seen(res)).toMatchObject({ status: 200 });
      const body = res.json();
      // Unchanged: the route owns none of this arithmetic, and a second definition of
      // "connect rate" in this hop is one that drifts from the supervisor's.
      expect(body).toEqual((await coreAnswer()).body);
      // The keys a console reads are PRESENT and zero, not absent.
      expect(body.totals.attempts).toBe(0);
      expect('connect_rate_pct' in body.totals).toBe(true);
      expect(Object.keys(body.totals.occupancy.by_state).sort()).toEqual(
        ['available', 'break', 'offline', 'on_call', 'reserved', 'wrapup'],
      );
    });

    it('an empty attempt page is a 200 with rows: [] and a null cursor', async () => {
      // Same property on the page: `rows: []` and `next_cursor: null` say "nothing
      // here, and nothing more to fetch". An error says neither.
      const res = await app.inject({
        method: 'GET', url: `${PREFIX}/my-attempts`, headers: headers(agent.id),
      });

      expect(seen(res)).toMatchObject({ status: 200 });
      // The real page; `limit` is the handler's default.
      expect(res.json()).toEqual({ rows: [], next_cursor: null, limit: expect.any(Number) });
    });

    it('and a FAILED read carries neither — different status, no totals, no rows', async () => {
      /**
       * The assertion that makes the two previous ones mean something. Stated as a
       * comparison rather than as two independent facts, because "distinguishable"
       * is a relation.
       *
       * The failure is a real fault inside the internal handler (its stats repository
       * rejects, as a pool timeout would), answered by its error handler.
       */
      const ok = await app.inject({
        method: 'GET', url: `${PREFIX}/my-stats?${STATS_WINDOW}`, headers: headers(agent.id),
      });

      vi.spyOn(agencyAgentStatsRepository, 'stats').mockRejectedValueOnce(new Error('pool timeout'));
      const failed = await app.inject({
        method: 'GET', url: `${PREFIX}/my-stats?${STATS_WINDOW}`, headers: headers(agent.id),
      });

      expect(seen(ok)).toMatchObject({ status: 200 });
      expect(seen(failed)).toMatchObject({ status: 500 });
      expect(ok.json()).not.toEqual(failed.json());
      // A client keying on `totals` sees it on the empty read and not on the failure.
      expect(ok.json().totals).toBeDefined();
      expect((failed.json() as Record<string, unknown>)['totals']).toBeUndefined();
    });

    it('the supervisory twin still adds agent_name to a ZERO scorecard', async () => {
      /**
       * The enrichment must not be conditional on there being activity: a
       * supervisor comparing two agents needs the name of the one who has done
       * nothing most of all. The real `enrichAgentStatsIdentity` runs over the
       * handler's real response here, and not even the lookup is stubbed — the name is the
       * agent's real `users.display_name` and the body is the real zero record.
       */
      const res = await app.inject({
        method: 'GET',
        url: `${PREFIX}/agents/${agent.id}/stats?${STATS_WINDOW}`,
        headers: headers(supervisor.id),
      });

      expect(seen(res)).toMatchObject({ status: 200 });
      const fromCore = (await coreAnswer()).body as Record<string, unknown>;
      expect(res.json()).toEqual({ ...fromCore, agent_name: 'Ada Agent' });
    });

    it('and degrades to agent_name: null rather than 500ing when the lookup fails', async () => {
      // Enrichment must never turn a 200 into a 500. The KEY is still produced: an
      // absent key is indistinguishable from a client that forgot to read it.
      mocks.resolveAgentNames.mockRejectedValue(new Error('db down'));

      const res = await app.inject({
        method: 'GET',
        url: `${PREFIX}/agents/${agent.id}/stats?${STATS_WINDOW}`,
        headers: headers(supervisor.id),
      });

      expect(seen(res)).toMatchObject({ status: 200 });
      expect(res.json().agent_name).toBeNull();
      expect(res.json().totals).toEqual(((await coreAnswer()).body as { totals: unknown }).totals);
    });
  });
});
