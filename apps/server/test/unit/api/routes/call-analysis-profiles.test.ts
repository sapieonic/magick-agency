import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

/*
 * The routes take auth and the campaign reference check as OPTIONS (`ProfileRouteAuth`,
 * `ProfileDependents`), so the suite injects fakes instead of mocking the auth middleware
 * and `agency.repository`. Flag gating is on `agency_call_analysis` alone. Also covered: the
 * stale-version 409 passes the caller's tenant/account to `findActiveSuccessor`, the routes
 * refuse all by default (every route 401 with no auth option), and PUT/DELETE refuse (503)
 * when no reference check is wired.
 */

// ── Hoisted mocks ─────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  authMiddleware: vi.fn(async () => {}),
  getTenantId: vi.fn().mockReturnValue('tenant-1'),
  getAccountId: vi.fn().mockReturnValue('account-1'),
  isEnabled: vi.fn().mockResolvedValue(true),
  repo: {
    create: vi.fn(),
    findByIdScoped: vi.fn(),
    findActiveByName: vi.fn(),
    listByTenant: vi.fn(),
    update: vi.fn(),
    findActiveSuccessor: vi.fn(),
    softDelete: vi.fn(),
  },
  // Q3's reference check reaches into agency_campaigns on PUT and DELETE, and it
  // asks TWO questions: which live campaigns NAME this profile, and how many name
  // nothing and so inherit whichever profile is the account default. Every test in
  // this file is about the profile surface itself, so the default answers are
  // "nothing depends on it either way" — the refusal has its own file, under
  // test/unit/agency/ where the type lock applies.
  campaigns: {
    findLiveDependentsOnAnalysisProfile: vi.fn(),
    countLiveCampaignsInheritingAccountDefault: vi.fn(),
  },
}));

// Only the agency flag exists here (the softphone's `dialer_call_analysis` is deleted).
const { FLAG_DEFS } = vi.hoisted(() => ({
  FLAG_DEFS: {
    agency_call_analysis: { key: 'agency_call_analysis', type: 'boolean' },
  },
}));
vi.mock('../../../../src/feature-flags/index.js', () => ({
  getFeatureFlagService: () => ({ isEnabled: mocks.isEnabled }),
  FLAGS: FLAG_DEFS,
}));
vi.mock('../../../../src/feature-flags/registry.js', () => ({
  FLAGS: FLAG_DEFS,
}));
vi.mock('@magick-agency/db/repositories/call-analysis-profile.repository', () => ({
  callAnalysisProfileRepository: mocks.repo,
}));
vi.mock('../../../../src/audit/audit-logger.js', () => ({ auditLogger: { log: vi.fn() } }));
vi.mock('@magick-agency/observability', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createChildLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { callAnalysisProfilesRoutes } from '../../../../src/api/routes/call-analysis-profiles.routes.js';

const HEADERS = { 'x-mgkvc-tenant': 'tenant-1', 'x-mgkvc-account': 'account-1' };
let app: FastifyInstance;

// `vi.clearAllMocks()` drops implementations as well as call records, so every
// default answer has to be re-armed here rather than at `vi.hoisted` time.
beforeEach(async () => {
  vi.clearAllMocks();
  mocks.isEnabled.mockResolvedValue(true);
  mocks.repo.findActiveByName.mockResolvedValue(null);
  // The reference guard's first act is an active-only lookup of the addressed row,
  // and it only guards a row it finds. Left resolving `undefined`, the guard would
  // decline on every PUT and DELETE in this file — which happens to be the answer
  // these tests want, but for the wrong reason: the guard would be inert rather
  // than satisfied, and a real refusal path could regress with this suite green.
  // So the row exists, is active, and is NOT the account default, which is what
  // makes both dependency classes genuinely empty below.
  mocks.repo.findByIdScoped.mockResolvedValue({
    id: 'p1', name: 'Collections', is_default: false, is_active: true, version: 1,
  });
  mocks.campaigns.findLiveDependentsOnAnalysisProfile.mockResolvedValue([]);
  mocks.campaigns.countLiveCampaignsInheritingAccountDefault.mockResolvedValue(0);
  app = Fastify({ logger: false });
  await app.register(callAnalysisProfilesRoutes, {
    prefix: '/api/v1/call-analysis-profiles',
    auth: { preHandler: mocks.authMiddleware, getTenantId: mocks.getTenantId, getAccountId: mocks.getAccountId },
    dependents: mocks.campaigns,
  });
  await app.ready();
});

afterEach(async () => { await app.close(); });

describe('call-analysis-profiles routes — flag gating', () => {
  /** Resolve per flag key. */
  const flagsOn = (state: Record<string, boolean>) =>
    mocks.isEnabled.mockImplementation(async (flag: { key: string }) => state[flag.key] ?? false);

  const hitEveryRoute = async () => ({
    post: await app.inject({ method: 'POST', url: '/api/v1/call-analysis-profiles', headers: HEADERS, payload: { name: 'X' } }),
    list: await app.inject({ method: 'GET', url: '/api/v1/call-analysis-profiles', headers: HEADERS }),
    detail: await app.inject({ method: 'GET', url: '/api/v1/call-analysis-profiles/p1', headers: HEADERS }),
    put: await app.inject({ method: 'PUT', url: '/api/v1/call-analysis-profiles/p1', headers: HEADERS, payload: { name: 'X' } }),
    del: await app.inject({ method: 'DELETE', url: '/api/v1/call-analysis-profiles/p1', headers: HEADERS }),
  });

  it('returns 403 on every method when the agency flag is off', async () => {
    flagsOn({});
    const res = await hitEveryRoute();
    for (const [route, reply] of Object.entries(res)) {
      expect(reply.statusCode, route).toBe(403);
      expect(reply.json().error, route).toBe('Feature Not Enabled');
    }
    expect(res.post.json().message).toBe('Call analysis is not enabled for this account.');
    expect(mocks.repo.create).not.toHaveBeenCalled();
  });

  it('opens every method on the agency flag', async () => {
    flagsOn({ agency_call_analysis: true });
    const res = await hitEveryRoute();
    for (const [route, reply] of Object.entries(res)) {
      expect(reply.statusCode, route).not.toBe(403);
    }
    expect(mocks.isEnabled.mock.calls[0]![0]).toMatchObject({ key: 'agency_call_analysis' });
  });
});

describe('call-analysis-profiles routes — defaults fail closed', () => {
  it('refuses EVERY route with 401 when no auth option is supplied (enumerated from onRoute)', async () => {
    const bare = Fastify({ logger: false });
    const routes: string[] = [];
    bare.addHook('onRoute', (r) => {
      for (const m of Array.isArray(r.method) ? r.method : [r.method]) if (m !== 'HEAD') routes.push(`${m} ${r.url}`);
    });
    await bare.register(callAnalysisProfilesRoutes, { prefix: '/api/v1/call-analysis-profiles' });
    await bare.ready();
    expect(routes.sort()).toEqual([
      'DELETE /api/v1/call-analysis-profiles/:id',
      'GET /api/v1/call-analysis-profiles',
      'GET /api/v1/call-analysis-profiles/:id',
      'POST /api/v1/call-analysis-profiles',
      'PUT /api/v1/call-analysis-profiles/:id',
    ]);
    for (const route of routes) {
      const [method, url] = route.split(' ') as [string, string];
      const res = await bare.inject({ method: method as 'GET', url: url.replace(':id', 'p1'), payload: method === 'POST' || method === 'PUT' ? { name: 'x' } : undefined });
      expect(res.statusCode, route).toBe(401);
    }
    expect(mocks.repo.create).not.toHaveBeenCalled();
    expect(mocks.repo.findByIdScoped).not.toHaveBeenCalled();
    await bare.close();
  });

  it('PUT and DELETE refuse (503) when the campaign reference check is not wired', async () => {
    const noDeps = Fastify({ logger: false });
    await noDeps.register(callAnalysisProfilesRoutes, {
      prefix: '/p',
      auth: { preHandler: mocks.authMiddleware, getTenantId: mocks.getTenantId, getAccountId: mocks.getAccountId },
    });
    await noDeps.ready();
    const put = await noDeps.inject({ method: 'PUT', url: '/p/p1', payload: { context: 'x' } });
    const del = await noDeps.inject({ method: 'DELETE', url: '/p/p1' });
    expect(put.statusCode).toBe(503);
    expect(del.statusCode).toBe(503);
    expect(mocks.repo.update).not.toHaveBeenCalled();
    expect(mocks.repo.softDelete).not.toHaveBeenCalled();
    await noDeps.close();
  });
});

describe('call-analysis-profiles routes — create', () => {
  it('rejects malformed and oversized profile input before hitting the repository', async () => {
    for (const payload of [
      { name: '' },
      { name: 'x'.repeat(121) },
      { name: 'x', context: 'c'.repeat(2001) },
      { name: 'x', custom_dimensions: Array.from({ length: 21 }, (_, i) => ({ key: `dimension_${i}`, description: 'd', type: 'string' })) },
    ]) {
      const res = await app.inject({ method: 'POST', url: '/api/v1/call-analysis-profiles', headers: HEADERS, payload });
      expect(res.statusCode).toBe(400);
    }
    expect(mocks.repo.create).not.toHaveBeenCalled();
  });

  it('creates a profile (201) and forwards is_default', async () => {
    mocks.repo.create.mockResolvedValue({ id: 'p1', name: 'Collections', is_default: true });
    const res = await app.inject({
      method: 'POST', url: '/api/v1/call-analysis-profiles', headers: HEADERS,
      payload: { name: 'Collections', context: 'Overdue borrowers', is_default: true, custom_dimensions: [] },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().id).toBe('p1');
    expect(mocks.repo.create).toHaveBeenCalledWith(expect.objectContaining({ tenant_id: 'tenant-1', account_id: 'account-1', name: 'Collections', is_default: true }));
  });

  it('returns 409 on a duplicate active name (pre-check)', async () => {
    mocks.repo.findActiveByName.mockResolvedValue({ id: 'existing' });
    const res = await app.inject({ method: 'POST', url: '/api/v1/call-analysis-profiles', headers: HEADERS, payload: { name: 'Collections' } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('Profile Already Exists');
    expect(mocks.repo.create).not.toHaveBeenCalled();
  });

  it('returns 409 when the unique index trips (race past the pre-check)', async () => {
    mocks.repo.create.mockRejectedValue(Object.assign(new Error('dup'), { code: '23505' }));
    const res = await app.inject({ method: 'POST', url: '/api/v1/call-analysis-profiles', headers: HEADERS, payload: { name: 'Collections' } });
    expect(res.statusCode).toBe(409);
  });

  it('returns 400 on invalid custom_dimension (enum with <2 options)', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/v1/call-analysis-profiles', headers: HEADERS,
      payload: { name: 'X', custom_dimensions: [{ key: 'plan', description: 'agreed?', type: 'enum', options: ['yes'] }] },
    });
    expect(res.statusCode).toBe(400);
    expect(mocks.repo.create).not.toHaveBeenCalled();
  });
});

describe('call-analysis-profiles routes — ownership scoping', () => {
  it.each([
    ['cross-tenant', 'other-tenant', 'account-1'],
    ['cross-account', 'tenant-1', 'other-account'],
  ])('GET /:id returns scoped 404 for %s access', async (_caseName, tenantId, accountId) => {
    // Headers are read by the auth middleware. Stub its helpers to represent the
    // authenticated caller's scope, which is what production uses for ownership.
    mocks.getTenantId.mockReturnValueOnce(tenantId);
    mocks.getAccountId.mockReturnValueOnce(accountId);
    mocks.repo.findByIdScoped.mockResolvedValue(null);
    const res = await app.inject({ method: 'GET', url: '/api/v1/call-analysis-profiles/00000000-0000-0000-0000-000000000000', headers: HEADERS });
    expect(res.statusCode).toBe(404);
    expect(mocks.repo.findByIdScoped).toHaveBeenCalledWith('00000000-0000-0000-0000-000000000000', tenantId, accountId);
  });

  it('GET /:id returns 404 for a non-owned profile', async () => {
    mocks.repo.findByIdScoped.mockResolvedValue(null);
    const res = await app.inject({ method: 'GET', url: '/api/v1/call-analysis-profiles/px', headers: HEADERS });
    expect(res.statusCode).toBe(404);
  });

  it('GET /:id returns the profile when owned', async () => {
    mocks.repo.findByIdScoped.mockResolvedValue({ id: 'p1', name: 'Collections' });
    const res = await app.inject({ method: 'GET', url: '/api/v1/call-analysis-profiles/p1', headers: HEADERS });
    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe('p1');
  });

  it('DELETE returns 404 for a non-owned profile', async () => {
    mocks.repo.softDelete.mockResolvedValue(false);
    const res = await app.inject({ method: 'DELETE', url: '/api/v1/call-analysis-profiles/px', headers: HEADERS });
    expect(res.statusCode).toBe(404);
  });

  it('DELETE returns 204 on success', async () => {
    mocks.repo.softDelete.mockResolvedValue(true);
    const res = await app.inject({ method: 'DELETE', url: '/api/v1/call-analysis-profiles/p1', headers: HEADERS });
    expect(res.statusCode).toBe(204);
  });
});

describe('call-analysis-profiles routes — update (copy-on-write)', () => {
  it('returns the new version on success', async () => {
    mocks.repo.update.mockResolvedValue({ id: 'p2', name: 'Collections', version: 2 });
    const res = await app.inject({ method: 'PUT', url: '/api/v1/call-analysis-profiles/p1', headers: HEADERS, payload: { context: 'updated' } });
    expect(res.statusCode).toBe(200);
    expect(res.json().version).toBe(2);
  });

  it('returns 409 with successor id when the version is stale', async () => {
    mocks.repo.update.mockResolvedValue(null);
    mocks.repo.findActiveSuccessor.mockResolvedValue({ id: 'p2' });
    const res = await app.inject({ method: 'PUT', url: '/api/v1/call-analysis-profiles/p1', headers: HEADERS, payload: { context: 'x' } });
    expect(res.statusCode).toBe(409);
    expect(res.json().details.current_profile_id).toBe('p2');
    // Scoped to the caller: the lookup is never by id alone.
    expect(mocks.repo.findActiveSuccessor).toHaveBeenCalledWith('p1', 'tenant-1', 'account-1');
  });

  it("another tenant's superseded id is a plain 404, not a 409 leaking its successor", async () => {
    // The repository is scoped, so a foreign id resolves to no successor.
    mocks.repo.update.mockResolvedValue(null);
    mocks.repo.findActiveSuccessor.mockImplementation(
      async (id: string, tenantId: string) => (id === 'p-foreign' && tenantId === 'owner-tenant' ? { id: 'p-foreign-current' } : null),
    );
    const res = await app.inject({ method: 'PUT', url: '/api/v1/call-analysis-profiles/p-foreign', headers: HEADERS, payload: { context: 'x' } });
    expect(res.statusCode).toBe(404);
    expect(JSON.stringify(res.json())).not.toContain('p-foreign-current');
    expect(mocks.repo.findActiveSuccessor).toHaveBeenCalledWith('p-foreign', 'tenant-1', 'account-1');
  });

  it('returns 404 when neither the row nor a successor exists', async () => {
    mocks.repo.update.mockResolvedValue(null);
    mocks.repo.findActiveSuccessor.mockResolvedValue(null);
    const res = await app.inject({ method: 'PUT', url: '/api/v1/call-analysis-profiles/px', headers: HEADERS, payload: { context: 'x' } });
    expect(res.statusCode).toBe(404);
  });
});

describe('call-analysis-profiles routes — list', () => {
  it('paginates', async () => {
    mocks.repo.listByTenant.mockResolvedValue({ rows: [{ id: 'p1' }], total: 1 });
    const res = await app.inject({ method: 'GET', url: '/api/v1/call-analysis-profiles?limit=10&offset=0', headers: HEADERS });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ total: 1, limit: 10, offset: 0 });
    expect(mocks.repo.listByTenant).toHaveBeenCalledWith('tenant-1', 'account-1', 10, 0);
  });

  it('uses pagination defaults and rejects out-of-range bounds', async () => {
    mocks.repo.listByTenant.mockResolvedValue({ rows: [], total: 0 });
    const defaults = await app.inject({ method: 'GET', url: '/api/v1/call-analysis-profiles', headers: HEADERS });
    expect(defaults.statusCode).toBe(200);
    expect(defaults.json()).toMatchObject({ limit: 20, offset: 0 });

    for (const query of ['?limit=0', '?limit=101', '?offset=-1']) {
      const res = await app.inject({ method: 'GET', url: `/api/v1/call-analysis-profiles${query}`, headers: HEADERS });
      expect(res.statusCode).toBe(400);
    }
  });
});
