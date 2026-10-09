import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

/*
 * PORT NOTE (magick-agency): master @ a1f0756a
 * `test/unit/agency/proxy-agency-campaign-behavioral-capabilities.routes.test.ts`, run through
 * the ported route. Plan §3.2: the two governance capabilities are the per-account settings
 * row — `agency.recording` → `account_settings.allow_recording`, `agency.analytics` →
 * `account_settings.analyze_calls` — judged by lane A's `campaign-behavioral-settings.ts`.
 * So the REAL gate stays unmocked (that module and its pure decision), and the one I/O edge
 * under it, `accountSettingsRepository.findByTenantAndAccount`, is supplied as data: a
 * column is only ever ON here because a row says so, exactly as master's override rows did.
 * Lane A's module-level twin is `campaign-behavioral-settings.test.ts` (52); this suite pins
 * the WIRING on the two write surfaces.
 *
 * Deleted (each ×2 surfaces): "the section preHandler still refuses on `agency` itself when
 * the parent is off" (no `requireCapability('agency')`: the app is agency) and "kill switch
 * OFF lets an enabling body straight through" (no governance kill switch). "a repository
 * failure under the CHILD check refuses" is kept; its "armed for the SECOND resolve"
 * arrangement existed only to get past the deleted section gate, so the read simply fails.
 * New (each ×2): the account judged is the request's tenant/account (the account core
 * stamps on a created row, and the only one `requireOwned` lets a PATCH write), and the
 * object asserted is the very object forwarded to `callCore`.
 */

/**
 * **`agency.recording` / `agency.analytics` are `behavioral` capabilities and
 * must behave — asserted by execution over the real catalog (MAG-138).**
 *
 * ── Why this file does not mock the governance module ─────────────────────────
 * (master's header, kept for its rationale; "governance" is now the settings row.)
 * The defect being fixed is precisely that the capability was *declared* and not
 * *enforced*: `catalog.ts` gives both keys `enforcement: ['nav','behavioral']`,
 * cusui hid the toggles, and `POST`/`PATCH /campaigns` forwarded the body to core
 * untouched — `grep -rn record_calls src/` in this repo returned nothing at all.
 * A test that stubs `src/governance/require-capability.js` to a no-op (as
 * `proxy-agency-campaigns.routes.test.ts` does, deliberately, for its own
 * purposes) passes identically before and after the fix, because the thing it
 * mocks away IS the fix.
 *
 * So the guard here is REAL, and so is everything under it:
 *   - `require-capability.ts` — the actual `assertCapability`,
 *   - `governance.service.ts` — the actual kill-switch + cache-then-resolve path,
 *   - `resolver.ts` + `catalog.ts` — the actual `CAPABILITIES`, which is what
 *     makes `agency.recording`'s `default: false` and its `parent: 'agency'`
 *     gating real facts of this test rather than fixture values.
 * Only the two I/O edges are stubbed — the Redis cache and the override
 * repository — so the DB rows a super admin would have written are supplied as
 * data. That is the same standard `proxy-agency-campaign-lifecycle-rbac.routes.ts`
 * set for RBAC: exercise the guard at the point of CONSUMPTION.
 *
 * ── Assert on execution, not only on status ───────────────────────────────────
 * Every refusal case also asserts `proxyToCore` was never called. A 403 that
 * arrives *after* the body reached core would be a fix in name only, and status
 * alone cannot tell the two apart.
 *
 * ── The asymmetry is the part most likely to regress ──────────────────────────
 * Only *enabling* is refused. `record_calls: false`, an absent `record_calls` and
 * `analysis_profile_id: null` must all pass with the capability OFF — otherwise a
 * tenant that loses the capability can no longer edit its campaign, and cannot
 * turn recording off. Half the cases below exist for that one property.
 */

const TENANT = 'tenant-1';
const ACCOUNT = 'account-1';

const mocks = vi.hoisted(() => ({
  proxyToCore: vi.fn(),
  auditLog: vi.fn(),
  findByTenantAndAccount: vi.fn(),
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
// RBAC has its own execution-based suite next door; here it is a no-op so a 403
// can only ever mean the capability gate fired.
vi.mock('../../../src/rbac/rbac.middleware.js', () => ({
  requirePermission: () => async () => {},
}));
vi.mock('../../../src/config/index.js', () => ({ config: mocks.config }));
// The route module's other collaborators — none is exercised by these cases, but
// importing the module pulls them in.
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

// ── The one I/O edge under the REAL settings gate ────────────────────────────
// Deliberately NOT mocked: `campaign-behavioral-settings.js` (lane A). Its exported
// assert is wrapped (not replaced) so a case can read the exact object it was handed.
vi.mock('@magick-agency/db/repositories/account-settings.repository', () => ({
  accountSettingsRepository: { findByTenantAndAccount: mocks.findByTenantAndAccount },
}));
vi.mock('../../../src/agency/campaign-behavioral-settings.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/agency/campaign-behavioral-settings.js')>();
  return { ...actual, assertBehavioralCapabilitiesForConfig: vi.fn(actual.assertBehavioralCapabilitiesForConfig) };
});

import { assertBehavioralCapabilitiesForConfig } from '../../../src/agency/campaign-behavioral-settings.js';
import { proxyAgencyCampaignsRoutes } from '../../../src/api/routes/proxy-agency-campaigns.routes.js';

const PREFIX = '/proxy/agency';
const PROFILE_ID = '11111111-2222-3333-4444-555555555555';

/**
 * PORT NOTE (magick-agency): master's `tenantOverride` + `governance({ agency, recording,
 * analytics })` wrote governance override rows. Here they write the account's settings row:
 * `recording` → `allow_recording`, `analytics` → `analyze_calls`; an omitted key is a NULL
 * column, which is "off" (as an absent override was the catalog's `default: false`). The
 * `agency` key is accepted and ignored — there is no parent gate.
 */
function governance(opts: { agency?: boolean; recording?: boolean; analytics?: boolean }): void {
  mocks.findByTenantAndAccount.mockResolvedValue({
    tenant_id: TENANT,
    account_id: ACCOUNT,
    allow_recording: opts.recording ?? null,
    analyze_calls: opts.analytics ?? null,
  });
}

async function buildApp(accountId: string | null = ACCOUNT): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.addHook('onRequest', async (request) => {
    // Double cast: matches the sibling agency route tests — `lint:test` rejects a
    // single-cast `FastifyRequest as Record<string, unknown>`.
    const r = request as unknown as Record<string, unknown>;
    r['tenantId'] = TENANT;
    r['accountId'] = accountId ?? undefined;
    r['user'] = { id: 'user-1' };
  });
  await app.register(proxyAgencyCampaignsRoutes, { prefix: PREFIX });
  await app.ready();
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.proxyToCore.mockResolvedValue({
    status: 200,
    body: { id: 'c1' },
    headers: new Headers(),
  });
  governance({ agency: true });
});

/** The two write surfaces are the same guard; every case runs against both. */
const surfaces = [
  { name: 'POST /campaigns', method: 'POST' as const, url: `${PREFIX}/campaigns` },
  { name: 'PATCH /campaigns/:id', method: 'PATCH' as const, url: `${PREFIX}/campaigns/c1` },
];

describe.each(surfaces)('$name — agency.recording is enforced, not merely declared', (surface) => {
  it('REFUSES record_calls: true when agency.recording is off, and core is never called', async () => {
    governance({ agency: true, recording: false });
    const app = await buildApp();

    const res = await app.inject({
      method: surface.method,
      url: surface.url,
      payload: { name: 'Campaign', record_calls: true },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'capability_disabled', capability: 'agency.recording' });
    // The assertion that distinguishes a real gate from a decorative one: the
    // body must not have reached core, which honours `record_calls` unchecked.
    expect(mocks.proxyToCore).not.toHaveBeenCalled();
    await app.close();
  });

  it('ALLOWS record_calls: false with the capability off — losing it must not freeze the campaign', async () => {
    governance({ agency: true, recording: false });
    const app = await buildApp();

    const res = await app.inject({
      method: surface.method,
      url: surface.url,
      payload: { name: 'Campaign', record_calls: false },
    });

    expect(res.statusCode).toBe(200);
    expect(mocks.proxyToCore).toHaveBeenCalledTimes(1);
    expect(mocks.proxyToCore.mock.calls[0]![0].body).toMatchObject({ record_calls: false });
    await app.close();
  });

  it('ALLOWS an absent record_calls with the capability off', async () => {
    governance({ agency: true, recording: false });
    const app = await buildApp();

    const res = await app.inject({
      method: surface.method,
      url: surface.url,
      payload: { name: 'Campaign' },
    });

    expect(res.statusCode).toBe(200);
    expect(mocks.proxyToCore).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it('ALLOWS record_calls: true when agency.recording is on', async () => {
    governance({ agency: true, recording: true });
    const app = await buildApp();

    const res = await app.inject({
      method: surface.method,
      url: surface.url,
      payload: { name: 'Campaign', record_calls: true },
    });

    expect(res.statusCode).toBe(200);
    expect(mocks.proxyToCore).toHaveBeenCalledTimes(1);
    expect(mocks.proxyToCore.mock.calls[0]![0].body).toMatchObject({ record_calls: true });
    await app.close();
  });

  it("REFUSES a string 'true' too — core casts unchecked and Postgres coerces it", async () => {
    governance({ agency: true, recording: false });
    const app = await buildApp();

    const res = await app.inject({
      method: surface.method,
      url: surface.url,
      payload: { name: 'Campaign', record_calls: 'true' },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'capability_disabled', capability: 'agency.recording' });
    expect(mocks.proxyToCore).not.toHaveBeenCalled();
    await app.close();
  });
});

describe.each(surfaces)('$name — agency.analytics is enforced, not merely declared', (surface) => {
  it('REFUSES a non-null analysis_profile_id when agency.analytics is off, and core is never called', async () => {
    governance({ agency: true, analytics: false });
    const app = await buildApp();

    const res = await app.inject({
      method: surface.method,
      url: surface.url,
      payload: { name: 'Campaign', analysis_profile_id: PROFILE_ID },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'capability_disabled', capability: 'agency.analytics' });
    expect(mocks.proxyToCore).not.toHaveBeenCalled();
    await app.close();
  });

  it('ALLOWS analysis_profile_id: null with the capability off — that is how you turn it OFF', async () => {
    governance({ agency: true, analytics: false });
    const app = await buildApp();

    const res = await app.inject({
      method: surface.method,
      url: surface.url,
      payload: { name: 'Campaign', analysis_profile_id: null },
    });

    expect(res.statusCode).toBe(200);
    expect(mocks.proxyToCore).toHaveBeenCalledTimes(1);
    expect(mocks.proxyToCore.mock.calls[0]![0].body).toMatchObject({ analysis_profile_id: null });
    await app.close();
  });

  it('ALLOWS an absent analysis_profile_id with the capability off', async () => {
    governance({ agency: true, analytics: false });
    const app = await buildApp();

    const res = await app.inject({
      method: surface.method,
      url: surface.url,
      payload: { name: 'Campaign' },
    });

    expect(res.statusCode).toBe(200);
    expect(mocks.proxyToCore).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it('ALLOWS analysis_profile_id when agency.analytics is on', async () => {
    governance({ agency: true, analytics: true });
    const app = await buildApp();

    const res = await app.inject({
      method: surface.method,
      url: surface.url,
      payload: { name: 'Campaign', analysis_profile_id: PROFILE_ID },
    });

    expect(res.statusCode).toBe(200);
    expect(mocks.proxyToCore).toHaveBeenCalledTimes(1);
    await app.close();
  });
});

describe.each(surfaces)('$name — the two capabilities are independent', (surface) => {
  it('recording ON + analytics OFF still refuses the analysis profile, naming analytics', async () => {
    governance({ agency: true, recording: true, analytics: false });
    const app = await buildApp();

    const res = await app.inject({
      method: surface.method,
      url: surface.url,
      payload: { name: 'Campaign', record_calls: true, analysis_profile_id: PROFILE_ID },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'capability_disabled', capability: 'agency.analytics' });
    expect(mocks.proxyToCore).not.toHaveBeenCalled();
    await app.close();
  });

  it('both ON forwards a body carrying both', async () => {
    governance({ agency: true, recording: true, analytics: true });
    const app = await buildApp();

    const res = await app.inject({
      method: surface.method,
      url: surface.url,
      payload: { name: 'Campaign', record_calls: true, analysis_profile_id: PROFILE_ID },
    });

    expect(res.statusCode).toBe(200);
    expect(mocks.proxyToCore.mock.calls[0]![0].body).toMatchObject({
      record_calls: true,
      analysis_profile_id: PROFILE_ID,
    });
    await app.close();
  });
});

// PORT NOTE (magick-agency): DELETED — '$name — the parent gate is kept, and is not the
// child gate' ("the section preHandler still refuses on `agency` itself when the parent is
// off") and '$name — GOVERNANCE_ENABLED kill switch' ("kill switch OFF lets an enabling body
// straight through, and never reads overrides"): no section `agency` gate and no governance
// kill switch (plan §3.2). Lane A deleted the same two at module level.

describe.each(surfaces)('$name — fail closed on a governance resolve error', (surface) => {
  /**
   * PORT NOTE (magick-agency): master armed the rejection for the SECOND resolve so the
   * section `requireCapability('agency')` could pass first. There is no section gate, so
   * the settings read itself fails, and the gate must refuse rather than forward.
   */
  it('a repository failure under the CHILD check refuses rather than forwarding', async () => {
    mocks.findByTenantAndAccount.mockRejectedValue(new Error('pg down'));
    const app = await buildApp();

    const res = await app.inject({
      method: surface.method,
      url: surface.url,
      payload: { name: 'Campaign', record_calls: true },
    });

    expect(res.statusCode).toBe(403);
    expect(mocks.proxyToCore).not.toHaveBeenCalled();
    await app.close();
  });
});

/*
 * NEW (magick-agency, MAG-138 wiring). Two properties the brief makes binding and that only
 * the route can get wrong:
 *  - the account judged: create and PATCH pass the REQUEST's tenant and account as the
 *    target. On create that is the account core stamps on the new row; on PATCH it is the
 *    only account core's `requireOwned` lets the write reach (route PORT NOTE);
 *  - the object judged: exactly the object handed to `callCore`, by reference — never
 *    `request.body` "for convenience". On create that is the body WITH the catalog default.
 */
describe.each(surfaces)('$name — the gate judges the forwarded object, for the owning account', (surface) => {
  it('reads the settings row of the request\'s tenant and account', async () => {
    governance({ recording: true });
    const app = await buildApp();

    const res = await app.inject({
      method: surface.method,
      url: surface.url,
      payload: { name: 'Campaign', record_calls: true },
    });

    expect(res.statusCode).toBe(200);
    expect(mocks.findByTenantAndAccount).toHaveBeenCalledWith(TENANT, ACCOUNT);
    expect(vi.mocked(assertBehavioralCapabilitiesForConfig).mock.calls[0]![3]).toEqual({
      tenantId: TENANT,
      accountId: ACCOUNT,
    });
    await app.close();
  });

  it('asserts the very object it forwards to core', async () => {
    governance({ recording: true, analytics: true });
    const app = await buildApp();

    await app.inject({
      method: surface.method,
      url: surface.url,
      payload: { name: 'Campaign', record_calls: true, analysis_profile_id: PROFILE_ID },
    });

    const asserted = vi.mocked(assertBehavioralCapabilitiesForConfig).mock.calls[0]![2];
    const forwarded = mocks.proxyToCore.mock.calls[0]![0].body;
    expect(asserted).toBe(forwarded);
    await app.close();
  });
});

/**
 * NEW (magick-agency, Phase 8 review): a tenant-wide caller with no `X-Account-Id`. Master's
 * capability resolved at tenant level and forwarded; core's `authMiddleware` answered 400
 * `Missing required header: x-mgkvc-account`. That observed answer is kept, ahead of the
 * account-level settings read (which would otherwise answer 403 with no row to judge), and
 * nothing reaches core. Also pins the PATCH's one-reference rule: what is asserted is what is
 * forwarded (the earlier REFUSES cases show nothing is forwarded when the assert refuses).
 */
describe.each(surfaces)('$name — no account context (NEW)', (surface) => {
  it("answers core's 400 for the missing account header, reads no settings and calls no core", async () => {
    const app = await buildApp(null);
    const res = await app.inject({ method: surface.method, url: surface.url, payload: { name: 'C', record_calls: true } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'Bad Request', message: 'Missing required header: x-mgkvc-account' });
    expect(mocks.findByTenantAndAccount).not.toHaveBeenCalled();
    expect(mocks.proxyToCore).not.toHaveBeenCalled();
    await app.close();
  });

  it('forwards to core exactly the object the gate was handed', async () => {
    governance({ agency: true, recording: true });
    const app = await buildApp();
    await app.inject({ method: surface.method, url: surface.url, payload: { name: 'C', record_calls: true } });
    const asserted = vi.mocked(assertBehavioralCapabilitiesForConfig).mock.calls[0]![2];
    expect(mocks.proxyToCore.mock.calls[0]![0].body).toBe(asserted);
    await app.close();
  });
});
