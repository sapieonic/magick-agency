import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

/*
 * PORT NOTE (magick-agency): master @ a1f0756a
 * `test/unit/agency/proxy-agency-campaign-transition-actor.routes.test.ts`.
 * The pg-pool boundary is `@magick-agency/db/connection` (the shared user repository imports
 * `../connection.js`, the same module). DELETED with platform API keys (decision #5; the
 * route's `isPlatformApiKeyCaller` check and `requestAuditActor`'s key branch are gone):
 * "%s refuses to attribute a PLATFORM API KEY to its creator" (×4), "a client-supplied actor
 * does not survive a key-authenticated call either", "%s names the CREDENTIAL, not its
 * creator, for a key caller" (×4), "still records that a key acted when the credential id
 * is unavailable". `KEY_CREATOR` / `API_KEY_ID` stay as fixtures (unused by the kept cases).
 */

/**
 * **The four lifecycle proxies must tell core WHO pressed the control
 * (`86d45k0bk`).**
 *
 * Core stores `last_transition_by: { user_id, name } | null` on the campaign row,
 * read from an OPTIONAL request body. Master's proxies sent no body, so core
 * stored `null` on every supervisor-initiated transition — indistinguishable from
 * the `null` it writes for a genuinely automatic one (the abandonment auto-pause,
 * the pacing leader's finalization). The field shipped meaning "master did not
 * say" and never "nobody did it".
 *
 * ── What is deliberately NOT mocked ───────────────────────────────────────────
 * `resolveAgentNames` and `src/db/repositories/user.repository.js` are REAL: the
 * mock boundary is the **pg pool**, and the fake below derives its filtering FROM
 * THE SQL TEXT, exactly as `proxy-agency-campaign-stats-enrichment.routes.test.ts`
 * does and for the same reason. So the tenant scope on the actor's own name is
 * only proved if the statement really carries it — delete `m.tenant_id = $2` from
 * `findDisplayNamesInTenant` and "a user outside this tenant" stops being id-only.
 * A stubbed name resolver would pass whether or not master had wired anything up.
 *
 * `requirePermission` IS stubbed here: the floors on these four routes are pinned
 * by execution next door in `proxy-agency-campaign-lifecycle-rbac.routes.test.ts`,
 * and this file is about what master SENDS once a caller is through. A caller
 * shape that must not be trusted — the platform API key — is exercised directly,
 * because RBAC waves those past entirely and so cannot be what stops them.
 */

const TENANT = '11111111-1111-4111-8111-111111111111';
const OTHER_TENANT = '22222222-2222-4222-8222-222222222222';
const ACCOUNT = '33333333-3333-4333-8333-333333333333';
const CAMPAIGN = '44444444-4444-4444-4444-444444444444';

/** A supervisor in THIS tenant with a display name. */
const SUPERVISOR = 'aaaaaaaa-0000-4000-8000-000000000001';
/** In this tenant, never set a display name — the email fallback case. */
const NO_NAME_USER = 'aaaaaaaa-0000-4000-8000-000000000002';
/** Belongs to OTHER_TENANT. Must resolve to no name, never to that tenant's. */
const FOREIGN_USER = 'aaaaaaaa-0000-4000-8000-000000000003';
/** In no `users` row at all. */
const UNKNOWN_USER = 'aaaaaaaa-0000-4000-8000-000000000004';
/** Who minted a platform API key — the identity that must NOT be attributed. */
const KEY_CREATOR = 'aaaaaaaa-0000-4000-8000-000000000005';
/** The credential itself — what the audit row must name INSTEAD of its creator. */
const API_KEY_ID = 'bbbbbbbb-0000-4000-8000-000000000001';

const ACTIONS = ['start', 'pause', 'resume', 'stop'] as const;

interface SeedUser {
  id: string;
  tenant_id: string;
  display_name: string | null;
  email: string;
  status: 'active' | 'deleted';
}

const SEED_USERS: SeedUser[] = [
  { id: SUPERVISOR, tenant_id: TENANT, display_name: 'Asha Menon', email: 'asha@example.com', status: 'active' },
  { id: NO_NAME_USER, tenant_id: TENANT, display_name: null, email: 'anon@example.com', status: 'active' },
  { id: FOREIGN_USER, tenant_id: OTHER_TENANT, display_name: 'Priya', email: 'priya@other.example', status: 'active' },
  { id: KEY_CREATOR, tenant_id: TENANT, display_name: 'Ravi Kumar', email: 'ravi@example.com', status: 'active' },
];

/** Forced failure for the degradation case. */
let userQueryError: Error | null = null;

const mocks = vi.hoisted(() => ({
  proxyToCore: vi.fn(),
  auditLog: vi.fn(),
  query: vi.fn(),
}));

vi.mock('../../../src/api/core-dispatch.js', () => ({ callCore: mocks.proxyToCore }));
vi.mock('../../../src/audit/platform/audit-logger.js', () => ({ platformAuditLogger: { log: mocks.auditLog } }));
vi.mock('@magick-agency/observability', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@magick-agency/observability')>()),
  createChildLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../../../src/auth/session.middleware.js', () => ({ sessionMiddleware: async () => {} }));
vi.mock('../../../src/api/middleware/tenant-context.middleware.js', () => ({
  tenantContextMiddleware: async () => {},
}));
// PORT NOTE (magick-agency): master's `require-capability` mock is gone with governance
// (the route registers no `requireCapability('agency')`; plan §3.2).
vi.mock('../../../src/rbac/rbac.middleware.js', () => ({
  requirePermission: () => async () => {},
}));
// The route module's other collaborators — untouched here, but importing the
// module pulls them in.
vi.mock('../../../src/storage/s3.js', () => ({
  getFileStream: vi.fn(), getFile: vi.fn(), uploadFile: vi.fn(),
}));
vi.mock('../../../src/agency/agency-ingest-job.repository.js', () => ({
  agencyIngestJobRepository: { create: vi.fn(), findById: vi.fn(), requestCancel: vi.fn() },
}));
vi.mock('../../../src/agency/agency-ingest.service.js', () => ({
  agencyIngestService: { run: vi.fn() },
}));

// ── The one mocked boundary that matters: the pg pool ────────────────────────
vi.mock('@magick-agency/db/connection', () => ({
  getPool: () => ({ query: mocks.query }),
}));

import { proxyAgencyCampaignsRoutes } from '../../../src/api/routes/proxy-agency-campaigns.routes.js';
import {
  TRANSITION_ACTOR_LOOKUP_TIMEOUT_MS,
  type AgencyCampaignTransitionRequest,
} from '../../../src/agency/agency-campaign-wire.js';

const PREFIX = '/proxy/agency';

/** Behaviour is a function of the SQL, so a dropped predicate changes the result. */
function fakeQuery(sql: string, params: unknown[] = []): { rows: unknown[] } {
  if (sql.includes('FROM users')) {
    if (userQueryError) throw userQueryError;
    const ids = (params[0] as string[]) ?? [];
    const tenantParam = params[1] as string | undefined;
    const scopesToTenant = /m\.tenant_id\s*=\s*\$2/.test(sql);
    const excludesDeleted = /u\.status\s*<>\s*'deleted'/.test(sql);

    const rows = SEED_USERS.filter((u) => ids.includes(u.id))
      .filter((u) => (scopesToTenant ? u.tenant_id === tenantParam : true))
      .filter((u) => (excludesDeleted ? u.status !== 'deleted' : true))
      .map((u) => ({ id: u.id, display_name: u.display_name, email: u.email }));
    return { rows };
  }
  return { rows: [] };
}

/**
 * `caller.user` is what `sessionMiddleware` would have attached;
 * `caller.apiKeyTenantId` is what its API-KEY branch sets — and note the two are
 * not alternatives, because a creator-backed key carries both.
 */
async function buildApp(caller: {
  user?: { id: string };
  apiKeyTenantId?: string;
  apiKey?: { id: string; scopes: unknown };
} = { user: { id: SUPERVISOR } }): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.addHook('onRequest', async (request) => {
    const r = request as unknown as Record<string, unknown>;
    r['tenantId'] = TENANT;
    r['accountId'] = ACCOUNT;
    if (caller.user) r['user'] = caller.user;
    if (caller.apiKeyTenantId) r['apiKeyTenantId'] = caller.apiKeyTenantId;
    if (caller.apiKey) r['apiKey'] = caller.apiKey;
  });
  await app.register(proxyAgencyCampaignsRoutes, { prefix: PREFIX });
  await app.ready();
  return app;
}

/** What master handed `proxyToCore` as the request body, if anything. */
function sentBody(): unknown {
  return mocks.proxyToCore.mock.calls[0]![0].body;
}

/** Whether the `body` key was present on the proxy call at all. */
function sentBodyKeyPresent(): boolean {
  return 'body' in (mocks.proxyToCore.mock.calls[0]![0] as Record<string, unknown>);
}

beforeEach(() => {
  vi.clearAllMocks();
  userQueryError = null;
  mocks.query.mockImplementation(fakeQuery);
  mocks.proxyToCore.mockResolvedValue({
    status: 200,
    body: { id: CAMPAIGN, status: 'running' },
    headers: new Headers(),
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('the authenticated actor reaches core on all four transitions', () => {
  it.each(ACTIONS)('%s carries the session user and their resolved name', async (action) => {
    const app = await buildApp();

    const res = await app.inject({ method: 'POST', url: `${PREFIX}/campaigns/${CAMPAIGN}/${action}` });

    expect(res.statusCode).toBe(200);
    // The exact contract shape, not a superset: an extra key here would be a
    // field core's `readTransitionActor` ignores while the client believed it.
    expect(sentBody()).toEqual({ actor_user_id: SUPERVISOR, actor_name: 'Asha Menon' });
    // …and nothing else about the call changed.
    expect(mocks.proxyToCore.mock.calls[0]![0].path)
      .toBe(`/agency-campaigns/${CAMPAIGN}/${action}`);
    await app.close();
  });

  it('resolves the name through the ONE repository lookup, tenant-scoped, once', async () => {
    const app = await buildApp();

    await app.inject({ method: 'POST', url: `${PREFIX}/campaigns/${CAMPAIGN}/start` });

    // One statement for one actor — not a lookup per anything.
    const userStatements = mocks.query.mock.calls.filter(([sql]) => String(sql).includes('FROM users'));
    expect(userStatements).toHaveLength(1);
    expect(userStatements[0]![1]).toEqual([[SUPERVISOR], TENANT]);
    await app.close();
  });

  it('falls back to the email for a user with no display name', async () => {
    // The same folding the campaign activity trail applies to its own actor
    // column, so the name master SENDS core cannot disagree with the name the
    // trail DISPLAYS for the same person.
    const app = await buildApp({ user: { id: NO_NAME_USER } });

    await app.inject({ method: 'POST', url: `${PREFIX}/campaigns/${CAMPAIGN}/pause` });

    expect(sentBody()).toEqual({ actor_user_id: NO_NAME_USER, actor_name: 'anon@example.com' });
    await app.close();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('an unresolvable name degrades to an id-only actor, never a placeholder', () => {
  it.each([
    ['a user outside this tenant', FOREIGN_USER],
    ['a user in no users row', UNKNOWN_USER],
  ])('%s attributes by id alone', async (_label, userId) => {
    const app = await buildApp({ user: { id: userId } });

    const res = await app.inject({ method: 'POST', url: `${PREFIX}/campaigns/${CAMPAIGN}/stop` });

    expect(res.statusCode).toBe(200);
    // `actor_name` is OMITTED, not empty. Core stores `name: null` for an
    // id-only actor, which is the honest answer; `''` would be trimmed back to
    // null AFTER the id was accepted, and `'unknown'` would be a fabricated name.
    expect(sentBody()).toEqual({ actor_user_id: userId });
    expect(sentBody()).not.toHaveProperty('actor_name');
    await app.close();
  });

  it('never leaks another tenant\'s name onto the actor', async () => {
    const app = await buildApp({ user: { id: FOREIGN_USER } });

    await app.inject({ method: 'POST', url: `${PREFIX}/campaigns/${CAMPAIGN}/stop` });

    expect(JSON.stringify(sentBody())).not.toContain('Priya');
    await app.close();
  });

  it('still attributes, and still transitions, when the name lookup THROWS', async () => {
    // The transition is the fact and the name is a label on it. Losing the off
    // button to a database blip is the failure this guards.
    userQueryError = new Error('connection terminated unexpectedly');
    const app = await buildApp();

    const res = await app.inject({ method: 'POST', url: `${PREFIX}/campaigns/${CAMPAIGN}/stop` });

    expect(res.statusCode).toBe(200);
    expect(sentBody()).toEqual({ actor_user_id: SUPERVISOR });
    await app.close();
  });

  it('does not WAIT on a HUNG name lookup — the transition goes out on the bound', async () => {
    /**
     * The other half of the case above, and the one a try/catch cannot cover. A
     * pool with no free connection, a lock queue, a replica that has stopped
     * answering: none of them REJECT, they just take longer than anyone pressing
     * Stop on a live campaign will wait. Unbounded, that is "losing the off
     * button to a database blip" again — the very outcome the catch beside it was
     * written for — arriving as latency instead of as an error.
     *
     * Asserted from BOTH sides of the bound, because a test that only proves the
     * transition eventually happens would pass with no timeout at all (the
     * statement would simply have to settle) and one that only proves it happens
     * after the bound would pass for a route that never waited on the lookup in
     * the first place.
     */
    mocks.query.mockImplementation((sql: string, params: unknown[] = []) => {
      if (String(sql).includes('FROM users')) return new Promise(() => undefined);
      return fakeQuery(String(sql), params);
    });
    const app = await buildApp();
    vi.useFakeTimers();
    try {
      const inflight = app.inject({ method: 'POST', url: `${PREFIX}/campaigns/${CAMPAIGN}/stop` });

      // One millisecond short of the bound: the lookup is still hung, so the
      // transition has NOT yet been sent. This is what proves master really is
      // waiting on the lookup — and therefore that the bound is doing work.
      await vi.advanceTimersByTimeAsync(TRANSITION_ACTOR_LOOKUP_TIMEOUT_MS - 1);
      expect(mocks.proxyToCore).not.toHaveBeenCalled();

      // …and on the bound itself it goes out anyway, id-only.
      await vi.advanceTimersByTimeAsync(1);
      const res = await inflight;

      expect(res.statusCode).toBe(200);
      expect(sentBody()).toEqual({ actor_user_id: SUPERVISOR });
      expect(sentBody()).not.toHaveProperty('actor_name');
      // The statement really was issued — the bound is a timeout, not a decision
      // to skip the lookup.
      expect(mocks.query.mock.calls.filter(([sql]) => String(sql).includes('FROM users')))
        .toHaveLength(1);
      // And the audit row is still written: a timed-out label does not un-happen
      // the transition.
      expect(mocks.auditLog).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
      await app.close();
    }
  });

  it('is bounded well below the ownership probe, whose call the request needs', async () => {
    // The precedent this bound follows, and the direction it deliberately differs
    // in. `ACTIVITY_OWNERSHIP_PROBE_TIMEOUT_MS` gates a core read the request
    // cannot proceed without; this one gates a cosmetic label with the whole
    // transition still ahead of it, so it must be the shorter of the two. From
    // the constants, so the ordering cannot rot into a copied literal.
    const { ACTIVITY_OWNERSHIP_PROBE_TIMEOUT_MS } = await import(
      '../../../src/agency/agency-activity.js'
    );

    expect(TRANSITION_ACTOR_LOOKUP_TIMEOUT_MS).toBeLessThan(ACTIVITY_OWNERSHIP_PROBE_TIMEOUT_MS);
    expect(TRANSITION_ACTOR_LOOKUP_TIMEOUT_MS).toBeGreaterThan(0);
  });

  it.each(ACTIONS)('%s never sends a placeholder actor of any spelling', async (action) => {
    for (const userId of [SUPERVISOR, NO_NAME_USER, FOREIGN_USER, UNKNOWN_USER]) {
      vi.clearAllMocks();
      mocks.query.mockImplementation(fakeQuery);
      mocks.proxyToCore.mockResolvedValue({ status: 200, body: {}, headers: new Headers() });

      const app = await buildApp({ user: { id: userId } });
      await app.inject({ method: 'POST', url: `${PREFIX}/campaigns/${CAMPAIGN}/${action}` });

      const body = (sentBody() ?? {}) as AgencyCampaignTransitionRequest;
      // The three strings core would read as a real actor.
      for (const value of Object.values(body)) {
        expect(['system', '', 'unknown', 'system:api', null]).not.toContain(value);
      }
      await app.close();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('a caller master cannot name sends NO actor — and still transitions', () => {
  it.each(ACTIONS)('%s sends no body at all when there is no session user', async (action) => {
    const app = await buildApp({});

    const res = await app.inject({ method: 'POST', url: `${PREFIX}/campaigns/${CAMPAIGN}/${action}` });

    expect(res.statusCode).toBe(200);
    // The `body` KEY is absent, not `{}` — byte-identical to what these routes
    // sent before this feature, which is what core's `actorPatch` already
    // answers with an empty patch.
    expect(sentBodyKeyPresent()).toBe(false);
    await app.close();
  });

  // PORT NOTE (magick-agency): DELETED — "%s refuses to attribute a PLATFORM API KEY to its
  // creator" (×4): no platform API keys (decision #5).
});

// ─────────────────────────────────────────────────────────────────────────────
describe('the actor is NEVER taken from the client', () => {
  it.each(ACTIONS)('%s ignores a client-supplied actor and sends its own', async (action) => {
    // `last_transition_by` is an attribution field on an audit surface, so a
    // caller-supplied actor is a forged one: a supervisor could stop a campaign in
    // a colleague's name. These routes never read `request.body`, and the body
    // core receives is built from facts master authenticated.
    const app = await buildApp();

    await app.inject({
      method: 'POST',
      url: `${PREFIX}/campaigns/${CAMPAIGN}/${action}`,
      payload: { actor_user_id: FOREIGN_USER, actor_name: 'Somebody Else' },
    });

    expect(sentBody()).toEqual({ actor_user_id: SUPERVISOR, actor_name: 'Asha Menon' });
    expect(JSON.stringify(sentBody())).not.toContain('Somebody Else');
    expect(JSON.stringify(sentBody())).not.toContain(FOREIGN_USER);
    await app.close();
  });

  it('a client-supplied actor does NOT become the actor when master has none', async () => {
    // The case where forwarding the inbound body would be invisible: with no
    // session user, a forwarded spoof would be the ONLY actor core ever saw.
    const app = await buildApp({});

    await app.inject({
      method: 'POST',
      url: `${PREFIX}/campaigns/${CAMPAIGN}/stop`,
      payload: { actor_user_id: FOREIGN_USER, actor_name: 'Somebody Else' },
    });

    expect(sentBodyKeyPresent()).toBe(false);
    await app.close();
  });

  // PORT NOTE (magick-agency): DELETED — "a client-supplied actor does not survive a
  // key-authenticated call either": no key-authenticated call exists (decision #5).
});

// ─────────────────────────────────────────────────────────────────────────────
describe('nothing else about the four routes changed', () => {
  it.each(ACTIONS)('%s still writes its audit row naming the session user', async (action) => {
    const app = await buildApp();

    await app.inject({ method: 'POST', url: `${PREFIX}/campaigns/${CAMPAIGN}/${action}` });

    expect(mocks.auditLog).toHaveBeenCalledTimes(1);
    const row = mocks.auditLog.mock.calls[0]![0] as Record<string, unknown>;
    expect(row['actor_type']).toBe('human');
    expect(row['user_id']).toBe(SUPERVISOR);
    expect(row['tenant_id']).toBe(TENANT);
    expect(row['api_key_id']).toBeUndefined();
    await app.close();
  });

  // PORT NOTE (magick-agency): DELETED — "%s names the CREDENTIAL, not its creator, for a key
  // caller" (×4) and "still records that a key acted when the credential id is unavailable":
  // `platform_audit_log` has no `api_key` actor type here (Q4) and there are no keys.

  it('forwards core\'s refusal verbatim and writes no audit row', async () => {
    mocks.proxyToCore.mockResolvedValue({
      status: 409,
      body: { error: 'Invalid Transition', code: 'invalid_campaign_transition' },
      headers: new Headers(),
    });
    const app = await buildApp();

    const res = await app.inject({ method: 'POST', url: `${PREFIX}/campaigns/${CAMPAIGN}/start` });

    expect(res.statusCode).toBe(409);
    expect(mocks.auditLog).not.toHaveBeenCalled();
    // The actor still went out: core decides whether the transition is legal, and
    // an attribution on a refused transition costs nothing.
    expect(sentBody()).toEqual({ actor_user_id: SUPERVISOR, actor_name: 'Asha Menon' });
    await app.close();
  });
});
