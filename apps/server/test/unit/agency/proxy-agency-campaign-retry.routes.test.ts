import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

/*
 *  - The capability gates are the per-account settings row, judged by the REAL
 *    `campaign-behavioral-settings.ts`; only `accountSettingsRepository.findByTenantAndAccount`
 *    is supplied as data (`governance(...)` writes `allow_recording` / `analyze_calls`).
 *  - The target account is the PARENT's own `tenant_id` / `account_id`, so `parentCampaign()`
 *    and the slim parent bodies carry `tenant_id` — the internal handler's formatter spreads
 *    the whole row, which has it.
 *  - The `missing_actor` refusal is pinned for a request with no session user.
 *  - The settings row judged is the parent's account, not the request header's.
 */

/**
 * **Retry campaigns at the proxy boundary — the four obligations the public API layer carries
 * on the create**.
 *
 * ── The obligation this file exists for ────────────────────────────────────
 * A retry INHERITS its parent's config. The internal handler copies seventeen columns
 * onto the child, two of which are gated by account-level capabilities the public API layer
 * owns — `record_calls` by `agency.recording`, `analysis_profile_id` by
 * `agency.analytics`. The request body names neither.
 *
 * So the behavioural guard, applied to the request body alone, would be handed a
 * body that says nothing and pass every single time — a gate whose only input is
 * the one on which it cannot fail. A tenant whose `agency.recording` was revoked
 * after the parent campaign was authored would get human↔human recording
 * switched back on by a copy, silently, on a capability whose whole point is
 * two-party consent. Nothing would be red anywhere: the create would 201, the
 * child would dial, and the recordings would exist.
 *
 * That is what the first block below pins, and it is why the public API layer reads the parent
 * campaign at all rather than proxying the create straight through.
 *
 * ── Why the capability gate is REAL here ──────────────────────────────────
 * The same argument `proxy-agency-campaign-behavioral-capabilities.routes.test.ts`
 * makes at length: the defect class is a capability that is DECLARED and not
 * ENFORCED, and a test that stubs the gate to a no-op passes
 * identically before and after the fix, because the thing it mocks away IS the
 * fix. So `campaign-behavioral-settings.ts` runs for real, and only the I/O
 * edge — the account-settings repository — is supplied as data.
 *
 * RBAC is stubbed open, and the two permissions this route carries are asserted
 * by execution next door in `proxy-agency-campaign-retry-rbac.routes.test.ts`.
 * Same split as every other pair of route suites here: each file exercises one
 * guard for real so a failure names which guard broke.
 */

const TENANT = 'tenant-1';
const ACCOUNT = 'account-1';
const USER = 'user-supervisor-1';
const PARENT = 'camp-parent';
const CHILD = 'camp-child';
const PROFILE_ID = '11111111-2222-3333-4444-555555555555';

const mocks = vi.hoisted(() => ({
  proxyToCore: vi.fn(),
  auditLog: vi.fn(),
  findByTenantAndAccount: vi.fn(),
  resolveAgentNames: vi.fn(),
  config: {
    agency: { rosterReplaceEnabled: false },
  },
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
vi.mock('../../../src/rbac/rbac.middleware.js', () => ({
  requirePermission: () => async () => {},
}));
vi.mock('../../../src/config/index.js', () => ({ config: mocks.config }));
// The name lookup is the public API layer's `users ⋈ memberships` read. Mocked at the ONE
// binding the repository has for it (`resolveAgentNames`'s own docstring is
// about there being exactly one), so a test can say what the public API layer knows this
// person is called without standing up a database.
vi.mock('../../../src/agency/agency-agent-identity.js', async () => {
  const actual = await vi.importActual<
    typeof import('../../../src/agency/agency-agent-identity.js')
  >('../../../src/agency/agency-agent-identity.js');
  return { ...actual, resolveAgentNames: mocks.resolveAgentNames };
});
// Collaborators the module imports and these cases never exercise.
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

// ── The one I/O edge under the REAL settings gate ───────────────────────────
vi.mock('@magick-agency/db/repositories/account-settings.repository', () => ({
  accountSettingsRepository: { findByTenantAndAccount: mocks.findByTenantAndAccount },
}));

import { proxyAgencyCampaignsRoutes } from '../../../src/api/routes/proxy-agency-campaigns.routes.js';
import type { AgencyCampaignWire } from '../../../src/agency/agency-campaign-wire.js';

const PREFIX = '/proxy/agency';

/**
 * Writes the account's settings row. An omitted key is a NULL column ("off").
 * `agency` is accepted and ignored.
 */
function governance(opts: { agency?: boolean; recording?: boolean; analytics?: boolean }): void {
  mocks.findByTenantAndAccount.mockResolvedValue({
    allow_recording: opts.recording ?? null,
    analyze_calls: opts.analytics ?? null,
  });
}

/**
 * The PARENT campaign as the internal handler serves it. Typed against the public API layer's wire shape so a
 * field renamed here is a `tsc --noEmit` failure rather than a fixture that
 * quietly stops describing the thing under test — which on this route would mean
 * the capability check reading `undefined` and passing.
 */
// Typed as the wire shape plus `tenant_id` and an open record — the window cases pass
// `calling_window_*`, columns `AgencyCampaignWire` deliberately does not declare, and
// `pnpm lint` typechecks this file and rejects excess properties.
type ParentWire = AgencyCampaignWire & { tenant_id: string } & Record<string, unknown>;

function parentCampaign(
  overrides: Partial<AgencyCampaignWire & { tenant_id: string }> & Record<string, unknown> = {},
): ParentWire {
  return {
    id: PARENT,
    // The gate's target (the internal handler's formatter spreads the row).
    tenant_id: TENANT,
    account_id: ACCOUNT,
    name: 'Q3 Winback',
    status: 'completed',
    record_calls: false,
    analysis_profile_id: null,
    parent_campaign_id: null,
    root_campaign_id: PARENT,
    retry_generation: 0,
    retry_selector: null,
    ...overrides,
  };
}

/**
 * Wire `proxyToCore` up as the internal handler would answer this route's two calls: the parent
 * read, then the create. Anything else 404s, so a hop nobody meant to add shows
 * up as a failure rather than as a silent 200.
 */
function coreAnswers(opts: {
  parent?: ParentWire;
  parentStatus?: number;
  parentBody?: unknown;
  createStatus?: number;
  createBody?: unknown;
} = {}): void {
  mocks.proxyToCore.mockImplementation(async (req: { method: string; path: string }) => {
    if (req.method === 'GET' && req.path === `/agency-campaigns/${PARENT}`) {
      return {
        status: opts.parentStatus ?? 200,
        body: opts.parentBody ?? opts.parent ?? parentCampaign(),
        headers: new Headers(),
      };
    }
    if (req.method === 'POST' && req.path === `/agency-campaigns/${PARENT}/retry`) {
      return {
        status: opts.createStatus ?? 201,
        body: opts.createBody ?? {
          campaign: { id: CHILD, name: 'Q3 Winback — Retry 1', retry_generation: 1 },
          contacts_seeded: 812,
          excluded: { dnc: 14, invalid: 3 },
        },
        headers: new Headers(),
      };
    }
    return { status: 404, body: { error: 'Not Found' }, headers: new Headers() };
  });
}

/** Did the CREATE hop happen? Distinct from "any internal handler call happened". */
function createCalls(): { method: string; path: string; body?: unknown }[] {
  return mocks.proxyToCore.mock.calls
    .map((call) => call[0] as { method: string; path: string; body?: unknown })
    .filter((req) => req.method === 'POST' && req.path.endsWith('/retry'));
}

async function buildApp(opts: { apiKey?: boolean; noUser?: boolean } = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.addHook('onRequest', async (request) => {
    // Double cast: `lint:test` rejects the single-cast form, per the sibling
    // agency suites.
    const r = request as unknown as Record<string, unknown>;
    r['tenantId'] = TENANT;
    r['accountId'] = ACCOUNT;
    // `noUser` models the one request the `missing_actor` refusal answers.
    if (!opts.noUser) r['user'] = { id: USER };
    r['membership'] = { role: 'account_admin' };
    if (opts.apiKey) r['apiKeyTenantId'] = TENANT;
  });
  await app.register(proxyAgencyCampaignsRoutes, { prefix: PREFIX });
  await app.ready();
  return app;
}

const SELECTOR = { last_outcome: ['no_answer', 'busy'], never_attempted: true };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveAgentNames.mockResolvedValue(new Map([[USER, 'Priya S']]));
  governance({ agency: true });
  coreAnswers();
});

describe('the capability-copy trap — a retry must not re-enable a revoked capability', () => {
  it('REFUSES a retry of a RECORDING parent when agency.recording has since been revoked', async () => {
    /**
     * The test the whole obligation exists for.
     *
     * The parent was authored while the tenant held `agency.recording` and its
     * row still says `record_calls: true`. The capability is off now. The request
     * body mentions recording nowhere — it cannot, a retry inherits — so the only
     * way to catch this is to check the config the child would actually be
     * created with.
     *
     * Asserted on the CREATE hop specifically, not on "the internal handler was never called":
     * the public API layer has to read the parent to know any of this, so a bare
     * `not.toHaveBeenCalled()` would be false for the right reason and would pass
     * just as well if the guard were deleted and the read left behind.
     */
    governance({ agency: true, recording: false });
    coreAnswers({ parent: parentCampaign({ record_calls: true }) });
    const app = await buildApp();

    const res = await app.inject({
      method: 'POST',
      url: `${PREFIX}/campaigns/${PARENT}/retry`,
      payload: { selector: SELECTOR },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'capability_disabled', capability: 'agency.recording' });
    expect(createCalls()).toEqual([]);
    // And no activity row: nothing happened for there to be a trail of.
    expect(mocks.auditLog).not.toHaveBeenCalled();
    await app.close();
  });

  it('ALLOWS it when the tenant still holds agency.recording', async () => {
    // The control. Without it, a route that refused every retry would pass the
    // case above and prove nothing about the capability.
    governance({ agency: true, recording: true });
    coreAnswers({ parent: parentCampaign({ record_calls: true }) });
    const app = await buildApp();

    const res = await app.inject({
      method: 'POST',
      url: `${PREFIX}/campaigns/${PARENT}/retry`,
      payload: { selector: SELECTOR },
    });

    expect(res.statusCode).toBe(201);
    expect(createCalls()).toHaveLength(1);
    await app.close();
  });

  it('ALLOWS a retry of a NON-recording parent with the capability off', async () => {
    // Losing the capability must not make a tenant's finished campaigns
    // un-retryable — the same asymmetry the create/patch guard carries, where
    // only ENABLING is refused.
    governance({ agency: true, recording: false });
    coreAnswers({ parent: parentCampaign({ record_calls: false }) });
    const app = await buildApp();

    const res = await app.inject({
      method: 'POST',
      url: `${PREFIX}/campaigns/${PARENT}/retry`,
      payload: { selector: SELECTOR },
    });

    expect(res.statusCode).toBe(201);
    await app.close();
  });

  it('ALLOWS an override that turns recording OFF for a retry of a recording parent', async () => {
    /**
     * The direction that would be lost by checking the parent alone. A supervisor
     * without the capability re-dialling a cohort WITHOUT recording is exactly
     * what the product should let them do, and it is the only way they can retry
     * that campaign at all. `false` has to beat the parent's `true`, which is why
     * the merge applies an override when the KEY is present rather than when its
     * value is truthy.
     */
    governance({ agency: true, recording: false });
    coreAnswers({ parent: parentCampaign({ record_calls: true }) });
    const app = await buildApp();

    const res = await app.inject({
      method: 'POST',
      url: `${PREFIX}/campaigns/${PARENT}/retry`,
      payload: { selector: SELECTOR, config_overrides: { record_calls: false } },
    });

    expect(res.statusCode).toBe(201);
    expect(createCalls()[0]!.body).toMatchObject({
      config_overrides: { record_calls: false },
    });
    await app.close();
  });

  it('REFUSES an override that turns recording ON for a retry of a non-recording parent', async () => {
    // The other direction, and the one a straight "copy the parent" check would
    // miss: the body IS naming the capability here, and it is naming it in the
    // direction the tenant may not have.
    governance({ agency: true, recording: false });
    coreAnswers({ parent: parentCampaign({ record_calls: false }) });
    const app = await buildApp();

    const res = await app.inject({
      method: 'POST',
      url: `${PREFIX}/campaigns/${PARENT}/retry`,
      payload: { selector: SELECTOR, config_overrides: { record_calls: true } },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'capability_disabled', capability: 'agency.recording' });
    expect(createCalls()).toEqual([]);
    await app.close();
  });

  it('FAILS CLOSED when the internal handler\'s parent payload omits record_calls entirely', async () => {
    // The hole the gate had left. The argument for passing an absent key was
    // "an internal handler that does not report `record_calls` does not serve `/retry`
    // either" — true only of an internal handler with NEITHER, and the dependency here is an
    // internal handler that DOES serve it. A slimmer GET DTO, a `{ campaign: … }` wrapper,
    // a projection that drops two columns: any of those and the public API layer silently
    // stops asserting while the internal handler happily copies recording off the parent row.
    //
    // Unreachable against today's internal handler, whose formatter spreads the whole
    // campaign row. Pinned so that a change to that serializer costs a 403
    // somebody reports rather than a consent gate nobody notices stopped
    // running.
    governance({ agency: true, recording: false });
    coreAnswers({ parentBody: { id: PARENT, tenant_id: TENANT, account_id: ACCOUNT, name: 'Q3', status: 'completed' } });
    const app = await buildApp();

    const res = await app.inject({
      method: 'POST',
      url: `${PREFIX}/campaigns/${PARENT}/retry`,
      payload: { selector: SELECTOR },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'capability_disabled', capability: 'agency.recording' });
    expect(createCalls()).toEqual([]);
    await app.close();
  });

  it('lets a slim parent through when the tenant HOLDS the capability', async () => {
    // The mirror, and the reason fail-closed is safe to adopt: the substitution
    // only ever costs a tenant that does not hold the capability. One that does
    // is unaffected, so this cannot break a working deployment on its own.
    governance({ agency: true, recording: true, analytics: true });
    coreAnswers({ parentBody: { id: PARENT, tenant_id: TENANT, account_id: ACCOUNT, name: 'Q3', status: 'completed' } });
    const app = await buildApp();

    const res = await app.inject({
      method: 'POST',
      url: `${PREFIX}/campaigns/${PARENT}/retry`,
      payload: { selector: SELECTOR },
    });

    expect(res.statusCode).toBe(201);
    expect(createCalls()).toHaveLength(1);
    await app.close();
  });

  it('REFUSES an inherited analysis profile when agency.analytics has been revoked', async () => {
    // `agency.analytics` is the second behavioral capability and it inherits the
    // same way. Named separately because the refusal has to NAME it — an operator
    // told "recording is off" about an analysis profile has been sent to the
    // wrong toggle.
    governance({ agency: true, recording: true, analytics: false });
    coreAnswers({ parent: parentCampaign({ analysis_profile_id: PROFILE_ID }) });
    const app = await buildApp();

    const res = await app.inject({
      method: 'POST',
      url: `${PREFIX}/campaigns/${PARENT}/retry`,
      payload: { selector: SELECTOR },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'capability_disabled', capability: 'agency.analytics' });
    expect(createCalls()).toEqual([]);
    await app.close();
  });

  it('ALLOWS an override clearing the inherited analysis profile with analytics off', async () => {
    governance({ agency: true, analytics: false });
    coreAnswers({ parent: parentCampaign({ analysis_profile_id: PROFILE_ID }) });
    const app = await buildApp();

    const res = await app.inject({
      method: 'POST',
      url: `${PREFIX}/campaigns/${PARENT}/retry`,
      payload: { selector: SELECTOR, config_overrides: { analysis_profile_id: null } },
    });

    expect(res.statusCode).toBe(201);
    await app.close();
  });

  /*
   * The settings row judged is the one of
   * the account that OWNS the parent (and so will own the child), read off the parent row —
   * not the request header's. The internal handler's `requireOwned` on the parent read makes the two equal
   * in production; the stub makes them differ to pin WHICH one is read.
   */
  it('judges the PARENT\'s account settings, not the request header\'s', async () => {
    governance({ recording: true });
    coreAnswers({ parent: parentCampaign({ record_calls: true, account_id: 'account-parent' }) });
    const app = await buildApp();

    const res = await app.inject({
      method: 'POST',
      url: `${PREFIX}/campaigns/${PARENT}/retry`,
      payload: { selector: SELECTOR },
    });

    expect(res.statusCode).toBe(201);
    expect(mocks.findByTenantAndAccount).toHaveBeenCalledWith(TENANT, 'account-parent');
    expect(mocks.findByTenantAndAccount).not.toHaveBeenCalledWith(TENANT, ACCOUNT);
    await app.close();
  });
});

describe('the actor is the public API layer\'s fact, never the body\'s', () => {
  it('sends the SESSION user, ignoring a body that names someone else', async () => {
    /**
     * The `sessionCreate` seam's rule, on a different route. A browser that could
     * name the actor could author a retry campaign in a colleague's name, on the
     * one row recording who chose to re-dial 812 customers.
     *
     * `.strict()` on the schema makes the attempt a 400 rather than a silent
     * strip, which is the assertion below — and the rebuilt body is the second,
     * independent reason it cannot be forged.
     */
    const app = await buildApp();

    const res = await app.inject({
      method: 'POST',
      url: `${PREFIX}/campaigns/${PARENT}/retry`,
      payload: { selector: SELECTOR, agent_user_id: 'user-someone-else' },
    });

    expect(res.statusCode).toBe(400);
    expect(createCalls()).toEqual([]);
    // The field is NAMED, so a console that sent it learns which one to drop.
    expect(JSON.stringify(res.json())).toContain('agent_user_id');
    await app.close();
  });

  it('sends the session user and the directory name, truncated to 255', async () => {
    mocks.resolveAgentNames.mockResolvedValue(new Map([[USER, 'P'.repeat(300)]]));
    const app = await buildApp();

    const res = await app.inject({
      method: 'POST',
      url: `${PREFIX}/campaigns/${PARENT}/retry`,
      payload: { selector: SELECTOR },
    });

    expect(res.statusCode).toBe(201);
    const body = createCalls()[0]!.body as Record<string, unknown>;
    expect(body['agent_user_id']).toBe(USER);
    expect((body['actor_name'] as string).length).toBe(255);
    await app.close();
  });

  it('OMITS actor_name rather than sending an empty one when the directory has no name', async () => {
    // The internal handler reads `''`, `'system'` and `'unknown'` as real actors, so an
    // unresolvable name has to be an absent field, not a placeholder. The retry
    // still happens: a name is an improvement on the id, never a precondition.
    mocks.resolveAgentNames.mockResolvedValue(new Map());
    const app = await buildApp();

    const res = await app.inject({
      method: 'POST',
      url: `${PREFIX}/campaigns/${PARENT}/retry`,
      payload: { selector: SELECTOR },
    });

    expect(res.statusCode).toBe(201);
    const body = createCalls()[0]!.body as Record<string, unknown>;
    expect(body['agent_user_id']).toBe(USER);
    expect('actor_name' in body).toBe(false);
    await app.close();
  });

  it('still authors the retry when the name lookup THROWS', async () => {
    // Same rule as the lifecycle transitions: a database blip degrades the label,
    // never the action.
    mocks.resolveAgentNames.mockRejectedValue(new Error('pool exhausted'));
    const app = await buildApp();

    const res = await app.inject({
      method: 'POST',
      url: `${PREFIX}/campaigns/${PARENT}/retry`,
      payload: { selector: SELECTOR },
    });

    expect(res.statusCode).toBe(201);
    expect((createCalls()[0]!.body as Record<string, unknown>)['agent_user_id']).toBe(USER);
    await app.close();
  });

  it('REFUSES a platform API key, which proves a tenant and names nobody', async () => {
    /**
     * The deliberate difference from `/start` and `/stop` on this same plugin,
     * which proceed unattributed rather than lose the off button. Authoring a
     * campaign is not an emergency control and the internal handler's request requires the actor,
     * so the alternatives are the public API layer's 400 now or the internal handler's one round trip later.
     *
     * What the refusal guards is a request that names nobody: no session user ⇒
     * 400 `missing_actor`, before any internal handler call.
     */
    const app = await buildApp({ noUser: true });

    const res = await app.inject({
      method: 'POST',
      url: `${PREFIX}/campaigns/${PARENT}/retry`,
      payload: { selector: SELECTOR },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'missing_actor' });
    expect(mocks.proxyToCore).not.toHaveBeenCalled();
    await app.close();
  });
});

describe('what the public API layer forwards, and what it refuses before the internal handler sees it', () => {
  it('forwards the selector unchanged and never validates its vocabulary', async () => {
    // The selector's vocabulary is the internal handler's, validated against the PARENT
    // campaign's disposition catalog, which the public API layer does not hold. A dimension
    // the public API layer has never heard of has to reach the internal handler so the internal handler can refuse it with the
    // catalog echoed — the public API layer refusing it first would be a second vocabulary, and
    // the public API layer's copy is the one that drifts.
    const app = await buildApp();
    const exotic = { last_disposition: ['voicemail'], some_future_dimension: 'x' };

    const res = await app.inject({
      method: 'POST',
      url: `${PREFIX}/campaigns/${PARENT}/retry`,
      payload: { selector: exotic },
    });

    expect(res.statusCode).toBe(201);
    expect((createCalls()[0]!.body as Record<string, unknown>)['selector']).toEqual(exotic);
    await app.close();
  });

  it('400s a config_overrides shape POST /campaigns would have refused, before any internal handler call', async () => {
    // Obligation 2. An override is a campaign config field by another name, so it
    // goes through the create route's validator — otherwise the retry route is a
    // way around every rule that validator enforces.
    const app = await buildApp();

    const res = await app.inject({
      method: 'POST',
      url: `${PREFIX}/campaigns/${PARENT}/retry`,
      payload: {
        selector: SELECTOR,
        config_overrides: { default_timezone: 'EST' },
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().details).toHaveProperty('default_timezone');
    expect(mocks.proxyToCore).not.toHaveBeenCalled();
    await app.close();
  });

  it('forwards the internal handler\'s 404 for a campaign in another tenant rather than answering itself', async () => {
    // The parent read doubles as the ownership probe: `requirePermission` proves
    // the caller's ROLE and never looks at the target row. The internal handler's status is
    // forwarded unchanged so a cross-tenant id and a nonexistent one stay
    // indistinguishable.
    coreAnswers({
      parentStatus: 404,
      parentBody: { error: 'Not Found', code: 'campaign_not_found', message: 'Campaign not found.' },
    });
    const app = await buildApp();

    const res = await app.inject({
      method: 'POST',
      url: `${PREFIX}/campaigns/${PARENT}/retry`,
      payload: { selector: SELECTOR },
    });

    expect(res.statusCode).toBe(404);
    expect(createCalls()).toEqual([]);
    await app.close();
  });

  it('relays the internal handler\'s 409 refusal body untouched', async () => {
    // `retry_selection_empty` and its two siblings are the internal handler's to raise; the public API layer
    // neither counts the match nor pre-empts the refusal. That the BODY survives
    // the error mask is pinned separately, in
    // `test/unit/api/middleware/error-mask.retry-campaigns.test.ts`.
    const refusal = {
      error: 'Conflict',
      code: 'retry_selection_empty',
      message: 'That selection matched no contacts that can be retried.',
    };
    coreAnswers({ createStatus: 409, createBody: refusal });
    const app = await buildApp();

    const res = await app.inject({
      method: 'POST',
      url: `${PREFIX}/campaigns/${PARENT}/retry`,
      payload: { selector: SELECTOR },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual(refusal);
    // Nothing was created, so nothing is written to the trail.
    expect(mocks.auditLog).not.toHaveBeenCalled();
    await app.close();
  });
});

describe('the idempotency key — forwarded, never invented (obligation 3a)', () => {
  const KEY = 'b3f1c0de-0000-4000-8000-000000000001';

  it('forwards the key unchanged', async () => {
    // The opposite rule to `agent_user_id`, and for the opposite reason: the
    // actor must come from the session because the body cannot be trusted to say
    // who is acting; the key must come from the body because only the client
    // holds the intent it identifies. Any transformation here — a re-mint, a
    // normalisation, a prefix — is a different value on the client's second
    // attempt, and the field then protects nothing.
    const app = await buildApp();

    const res = await app.inject({
      method: 'POST',
      url: `${PREFIX}/campaigns/${PARENT}/retry`,
      payload: { selector: SELECTOR, idempotency_key: KEY },
    });

    expect(res.statusCode).toBe(201);
    expect((createCalls()[0]!.body as Record<string, unknown>)['idempotency_key']).toBe(KEY);
    await app.close();
  });

  it('sends NO key when the client sent none — an unkeyed create is legal', async () => {
    // Minting one here is the trap. It would look like protection, pass every
    // test that only checks the field is present, and leave the client's retry
    // carrying a fresh value that collides with nothing.
    const app = await buildApp();

    await app.inject({
      method: 'POST',
      url: `${PREFIX}/campaigns/${PARENT}/retry`,
      payload: { selector: SELECTOR },
    });

    expect(createCalls()[0]!.body as Record<string, unknown>)
      .not.toHaveProperty('idempotency_key');
    await app.close();
  });

  it('forwards an EMPTY key rather than dropping it into an unkeyed create', async () => {
    // The case the suite was missing, and it is the dangerous one.
    //
    // `z.string().optional()` accepts `""`. A truthiness check on the way out
    // treats `""` as absent, so the internal handler receives a LEGAL UNKEYED CREATE — and a
    // client that sends an empty key (an empty form field, a defaulted string,
    // a retry of a failed parse) gets no protection at all. Press the button
    // twice and there are two campaigns over one cohort, dialling the same
    // customers. Protection-shaped, and none.
    //
    // `null` is already a 400 here (the field is not `.nullable()`); `""` was
    // the only value that fell through. Forwarded, it reaches the internal handler's 16–64 rule
    // and comes back a 400 with `details.idempotency_key`.
    coreAnswers({
      createStatus: 400,
      createBody: { error: 'Validation failed', details: { idempotency_key: 'must be 16-64 characters' } },
    });
    const app = await buildApp();

    const res = await app.inject({
      method: 'POST',
      url: `${PREFIX}/campaigns/${PARENT}/retry`,
      payload: { selector: SELECTOR, idempotency_key: '' },
    });

    // Present and empty — NOT absent. Under the old truthiness check this was
    // `not.toHaveProperty`, and the create succeeded.
    const body = createCalls()[0]!.body as Record<string, unknown>;
    expect(body).toHaveProperty('idempotency_key');
    expect(body['idempotency_key']).toBe('');
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('leaves the SHAPE to the internal handler — a key the public API layer thinks is wrong still reaches it', async () => {
    // The internal handler owns the bounds (16..64, a bounded alphabet) and answers a 400 with
    // field-level `details` that survive the error mask. A second copy of those
    // bounds here is a second thing to keep in step, and the direction it would
    // fail in is a retry refused by the public API layer for a rule the internal handler no longer has.
    coreAnswers({
      createStatus: 400,
      createBody: { error: 'Validation failed', details: { idempotency_key: 'must be 16-64 characters' } },
    });
    const app = await buildApp();

    const res = await app.inject({
      method: 'POST',
      url: `${PREFIX}/campaigns/${PARENT}/retry`,
      payload: { selector: SELECTOR, idempotency_key: 'short' },
    });

    expect(createCalls()).toHaveLength(1);
    expect(res.statusCode).toBe(400);
    expect(res.json().details).toHaveProperty('idempotency_key');
    await app.close();
  });

  it('files NO activity row on a replay, and still relays the campaign', async () => {
    // The internal handler answers 200 + `idempotent_replay: true` when the key had already
    // created a campaign. A second `agency_campaign.retry_created` on the
    // parent's trail would assert that a cohort was selected and re-dialled
    // twice — into the very store a compliance reviewer opens to establish that
    // it was not.
    coreAnswers({
      createStatus: 200,
      createBody: {
        campaign: { id: CHILD, name: 'Q3 Winback — Retry 1', retry_generation: 1 },
        idempotent_replay: true,
        contacts_seeded: null,
        excluded: null,
      },
    });
    const app = await buildApp();

    const res = await app.inject({
      method: 'POST',
      url: `${PREFIX}/campaigns/${PARENT}/retry`,
      payload: { selector: SELECTOR, idempotency_key: KEY },
    });

    // The console must still be able to navigate to the campaign it made.
    expect(res.statusCode).toBe(200);
    expect(res.json().campaign.id).toBe(CHILD);
    expect(mocks.auditLog).not.toHaveBeenCalled();
    await app.close();
  });

  it('files the row on an ordinary create, so the replay guard is not a blanket mute', async () => {
    // The mirror of the case above. Without it, `!replayed` inverted — or an
    // older internal handler omitting the flag being read as a replay — would silently stop
    // the parent's trail recording retries at all, and nothing would be red.
    const app = await buildApp();

    await app.inject({
      method: 'POST',
      url: `${PREFIX}/campaigns/${PARENT}/retry`,
      payload: { selector: SELECTOR, idempotency_key: KEY },
    });

    expect(mocks.auditLog).toHaveBeenCalledTimes(1);
    await app.close();
  });
});

describe('the calling window is validated on the MERGED view (obligation 2)', () => {
  it('REFUSES a one-sided end override that closes a valid parent window', async () => {
    // The hole in the override-only pass. `calling_window_start ===
    // calling_window_end` is PERMANENTLY CLOSED at the internal handler — `nextOpenAt` returns
    // null — so the child is saveable and never dials, a support ticket whose
    // cause is invisible on every screen. `POST /campaigns` cannot produce one
    // because both sides are in the same body; a retry can, because only `end`
    // is named and the validator has nothing to compare it to.
    coreAnswers({ parent: parentCampaign({
      calling_window_start: '09:00:00', calling_window_end: '17:00:00',
    }) });
    const app = await buildApp();

    const res = await app.inject({
      method: 'POST',
      url: `${PREFIX}/campaigns/${PARENT}/retry`,
      payload: { selector: SELECTOR, config_overrides: { calling_window_end: '09:00' } },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().details).toHaveProperty('calling_window_end');
    // Refused before the create, so no campaign that can never dial exists.
    expect(createCalls()).toEqual([]);
    await app.close();
  });

  it('REFUSES it the other way round too — start overridden onto the stored end', async () => {
    coreAnswers({ parent: parentCampaign({
      calling_window_start: '09:00:00', calling_window_end: '17:00:00',
    }) });
    const app = await buildApp();

    const res = await app.inject({
      method: 'POST',
      url: `${PREFIX}/campaigns/${PARENT}/retry`,
      payload: { selector: SELECTOR, config_overrides: { calling_window_start: '17:00' } },
    });

    expect(res.statusCode).toBe(400);
    expect(createCalls()).toEqual([]);
    await app.close();
  });

  it('compares NORMALISED times, so 09:00 against a stored 09:00:00 is caught', async () => {
    // Postgres renders a TIME column as `HH:MM:SS` and the console posts
    // `HH:MM`. A raw string comparison lets exactly this pair through.
    coreAnswers({ parent: parentCampaign({
      calling_window_start: '09:00:00', calling_window_end: '17:00:00',
    }) });
    const app = await buildApp();

    const res = await app.inject({
      method: 'POST',
      url: `${PREFIX}/campaigns/${PARENT}/retry`,
      payload: { selector: SELECTOR, config_overrides: { calling_window_end: '09:00:00' } },
    });

    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('ALLOWS a one-sided override that leaves a real window', async () => {
    // The common case, and the one this must not break: narrowing the window.
    coreAnswers({ parent: parentCampaign({
      calling_window_start: '09:00:00', calling_window_end: '17:00:00',
    }) });
    const app = await buildApp();

    const res = await app.inject({
      method: 'POST',
      url: `${PREFIX}/campaigns/${PARENT}/retry`,
      payload: { selector: SELECTOR, config_overrides: { calling_window_end: '15:00' } },
    });

    expect(res.statusCode).toBe(201);
    await app.close();
  });

  it('does NOT re-litigate a parent window when the overrides name neither side', async () => {
    // Obligation 2's actual rule. A parent whose stored config predates a
    // validation rule must stay retryable — the retry dialog offers no
    // affordance to fix it, so refusing here strands the campaign entirely.
    // Only an OVERRIDE that makes the merged pair invalid is the public API layer's business.
    coreAnswers({ parent: parentCampaign({
      calling_window_start: '09:00:00', calling_window_end: '09:00:00',
    }) });
    const app = await buildApp();

    const res = await app.inject({
      method: 'POST',
      url: `${PREFIX}/campaigns/${PARENT}/retry`,
      payload: { selector: SELECTOR },
    });

    expect(res.statusCode).toBe(201);
    expect(createCalls()).toHaveLength(1);
    await app.close();
  });
});

describe('the selector on the compliance trail is BOUNDED', () => {
  it('clips a huge value rather than storing it whole, and marks the clip', async () => {
    // This file already paid for an unbounded caller-controlled value once:
    // `boundedFilters` exists because a 200KB filter landed unchanged, repeatably,
    // on the one trail a compliance reader depends on. The retry row is written
    // on every successful create, must outlive the child, and lives in
    // partitions that drop only by age.
    const app = await buildApp();
    const huge = 'x'.repeat(10_000);

    await app.inject({
      method: 'POST',
      url: `${PREFIX}/campaigns/${PARENT}/retry`,
      payload: { selector: { last_disposition: [huge] } },
    });

    const details = mocks.auditLog.mock.calls[0]![0].details as Record<string, unknown>;
    const stored = (details['selector'] as Record<string, unknown>)['last_disposition'] as string[];
    expect(stored[0]!.length).toBeLessThan(300);
    // Marked, not silently cut — a clipped value that looks whole misreports
    // which cohort was chosen.
    expect(stored[0]).toContain('[truncated]');
    await app.close();
  });

  it('caps a dumped roster and says how many were dropped', async () => {
    const app = await buildApp();
    const roster = Array.from({ length: 5_000 }, (_, i) => `+9190000${String(i).padStart(5, '0')}`);

    await app.inject({
      method: 'POST',
      url: `${PREFIX}/campaigns/${PARENT}/retry`,
      payload: { selector: { last_outcome: roster } },
    });

    const details = mocks.auditLog.mock.calls[0]![0].details as Record<string, unknown>;
    const stored = (details['selector'] as Record<string, unknown>)['last_outcome'] as string[];
    expect(stored.length).toBeLessThanOrEqual(51);
    expect(stored[stored.length - 1]).toContain('more truncated');
    await app.close();
  });

  it('keeps an ordinary selector byte-for-byte, so the trail is still the intent', async () => {
    // The bound must be invisible on every real selection. The row exists to
    // record which cohort somebody chose to re-dial; a bound that reshaped an
    // ordinary one would defeat it.
    const app = await buildApp();
    const selector = { last_outcome: ['no_answer', 'busy', '__none__'], never_attempted: false };

    await app.inject({
      method: 'POST',
      url: `${PREFIX}/campaigns/${PARENT}/retry`,
      payload: { selector },
    });

    const details = mocks.auditLog.mock.calls[0]![0].details as Record<string, unknown>;
    expect(details['selector']).toEqual(selector);
    await app.close();
  });
});

describe('the activity row (obligation 4)', () => {
  it('files `agency_campaign.retry_created` against the PARENT, with the link across', async () => {
    /**
     * A row carries one `campaign_id`. The child's own creation is already
     * recorded on the child by the internal handler; what nothing else records is that a cohort
     * of THIS campaign's results was selected and re-dialled — which is the fact
     * a compliance reviewer opens the parent's trail to find.
     */
    const app = await buildApp();

    const res = await app.inject({
      method: 'POST',
      url: `${PREFIX}/campaigns/${PARENT}/retry`,
      payload: { selector: SELECTOR, name: 'Q3 Winback — Retry 1' },
    });

    expect(res.statusCode).toBe(201);
    expect(mocks.auditLog).toHaveBeenCalledTimes(1);
    expect(mocks.auditLog.mock.calls[0]![0]).toMatchObject({
      tenant_id: TENANT,
      account_id: ACCOUNT,
      user_id: USER,
      action: 'agency_campaign.retry_created',
      resource_type: 'agency_campaign',
      resource_id: PARENT,
      campaign_id: PARENT,
      details: {
        parent_campaign_id: PARENT,
        child_campaign_id: CHILD,
        contacts_seeded: 812,
        selector: SELECTOR,
      },
    });
    await app.close();
  });

  it('does not throw out of the audit call when the internal handler\'s body is not the shape the public API layer expects', async () => {
    // The rule here: the public API layer keeps no campaign schema, so the internal handler's body is untyped
    // here and every field is narrowed defensively. A malformed response must
    // never take a successful create down with it — the campaign exists either
    // way, and losing the 201 would send the operator to create a second one.
    coreAnswers({ createBody: { campaign: 'not-an-object', contacts_seeded: 'many' } });
    const app = await buildApp();

    const res = await app.inject({
      method: 'POST',
      url: `${PREFIX}/campaigns/${PARENT}/retry`,
      payload: { selector: SELECTOR },
    });

    expect(res.statusCode).toBe(201);
    expect(mocks.auditLog).toHaveBeenCalledTimes(1);
    const row = mocks.auditLog.mock.calls[0]![0] as { details: Record<string, unknown> };
    // The unreadable fields are OMITTED, never guessed at: a `contacts_seeded: 0`
    // invented here would read as "the retry seeded nothing".
    expect('child_campaign_id' in row.details).toBe(false);
    expect('contacts_seeded' in row.details).toBe(false);
    expect(row.details['parent_campaign_id']).toBe(PARENT);
    await app.close();
  });
});

describe('a roster smaller than the preview promised', () => {
  it('records the duplicate collapse on the parent’s trail, when there was one', async () => {
    // A retry seeds fewer rows than the preview matched when the parent held
    // byte-identical roster rows, which the child collapses. This trail is the
    // only place that explains a campaign smaller than the number the supervisor
    // approved — without it, a duplicate collapse and rows lost to a bug read
    // identically, and only one of them is worth escalating.
    coreAnswers({
      createBody: {
        campaign: { id: CHILD, name: 'Q3 Winback — Retry 1', retry_generation: 1 },
        contacts_seeded: 809,
        duplicates_collapsed: 3,
        excluded: { dnc: 14, invalid: 3 },
      },
    });
    const app = await buildApp();

    const res = await app.inject({
      method: 'POST',
      url: `${PREFIX}/campaigns/${PARENT}/retry`,
      payload: { selector: SELECTOR },
    });

    // Relayed unchanged — the public API layer reshapes no part of the internal handler's success body.
    expect(res.json().duplicates_collapsed).toBe(3);
    expect(mocks.auditLog.mock.calls[0]![0].details).toMatchObject({
      contacts_seeded: 809,
      duplicates_collapsed: 3,
    });
    await app.close();
  });

  it('leaves a ZERO collapse off the trail, so the field is not noise', async () => {
    // Every ordinary retry collapses nothing. A `0` on every row is noise in a
    // store read by eye, and it would train a reviewer to skip the line that
    // matters.
    const app = await buildApp();

    await app.inject({
      method: 'POST',
      url: `${PREFIX}/campaigns/${PARENT}/retry`,
      payload: { selector: SELECTOR },
    });

    expect(mocks.auditLog.mock.calls[0]![0].details)
      .not.toHaveProperty('duplicates_collapsed');
    await app.close();
  });
});

describe('the preview and the lineage read', () => {
  beforeEach(() => {
    mocks.proxyToCore.mockResolvedValue({ status: 200, body: { matched: 812 }, headers: new Headers() });
  });

  it('forwards every selector param, comma-joining repeats', async () => {
    // Both spellings are the internal handler's (the wire contract), so a client may use either
    // and the public API layer does not have to pick one for them.
    const app = await buildApp();

    await app.inject({
      method: 'GET',
      url: `${PREFIX}/campaigns/${PARENT}/retry/preview`
        + '?last_outcome=no_answer&last_outcome=busy&never_attempted=true',
    });

    expect(mocks.proxyToCore).toHaveBeenCalledWith(
      expect.objectContaining({
        path: `/agency-campaigns/${PARENT}/retry/preview`,
        query: { last_outcome: 'no_answer,busy', never_attempted: 'true' },
      }),
    );
    await app.close();
  });

  it('forwards a dimension the public API layer has never heard of, so the internal handler refuses it', async () => {
    // The deliberate opposite of the spine reads' allow-list. The public API layer refusing
    // first would answer with a message about the public API layer's list instead of the internal handler's —
    // which for `last_disposition` has to echo the parent campaign's catalog,
    // something the public API layer does not hold.
    const app = await buildApp();

    await app.inject({
      method: 'GET',
      url: `${PREFIX}/campaigns/${PARENT}/retry/preview?some_future_dimension=x`,
    });

    expect(mocks.proxyToCore).toHaveBeenCalledWith(
      expect.objectContaining({ query: { some_future_dimension: 'x' } }),
    );
    await app.close();
  });

  it('drops a blank value rather than forwarding an empty filter', async () => {
    // `?last_outcome=` is what a cleared form control posts; forwarding it would
    // turn an empty filter into one that matches nothing.
    const app = await buildApp();

    await app.inject({
      method: 'GET',
      url: `${PREFIX}/campaigns/${PARENT}/retry/preview?last_outcome=&state=pending`,
    });

    expect(mocks.proxyToCore).toHaveBeenCalledWith(
      expect.objectContaining({ query: { state: 'pending' } }),
    );
    await app.close();
  });

  it('proxies the lineage read straight through', async () => {
    const app = await buildApp();

    const res = await app.inject({ method: 'GET', url: `${PREFIX}/campaigns/${PARENT}/lineage` });

    expect(res.statusCode).toBe(200);
    expect(mocks.proxyToCore).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'GET',
        path: `/agency-campaigns/${PARENT}/lineage`,
        metricPath: '/agency-campaigns/:id/lineage',
      }),
    );
    await app.close();
  });
});
