import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  getTenantId: vi.fn().mockReturnValue('tenant-1'),
  getAccountId: vi.fn().mockReturnValue('account-1'),
  resolveClientExposed: vi.fn(),
}));

// The route reads the tenant/account from the request decorations the
// `sessionMiddleware` → `tenantContextMiddleware` chain sets, gated by
// `requirePermission` — so those three are mocked, and the two getters are
// the source of the values the middleware stub assigns.
vi.mock('../../../../src/auth/session.middleware.js', () => ({
  sessionMiddleware: vi.fn().mockImplementation(async () => {}),
}));
vi.mock('../../../../src/api/middleware/tenant-context.middleware.js', () => ({
  tenantContextMiddleware: vi.fn().mockImplementation(async (req: any) => {
    req.tenantId = mocks.getTenantId();
    req.accountId = mocks.getAccountId();
  }),
}));
vi.mock('../../../../src/rbac/rbac.middleware.js', () => ({
  requirePermission: () => async () => {},
}));

vi.mock('../../../../src/feature-flags/index.js', () => ({
  getFeatureFlagService: () => ({ resolveClientExposed: mocks.resolveClientExposed }),
}));

import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { featureFlagsRoutes } from '../../../../src/api/routes/feature-flags.routes.js';

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(featureFlagsRoutes, { prefix: '/feature-flags' });
  await app.ready();
  return app;
}

describe('Tenant client surface — GET /feature-flags', () => {
  let app: FastifyInstance;
  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.getTenantId.mockReturnValue('tenant-1');
    mocks.getAccountId.mockReturnValue('account-1');
    mocks.resolveClientExposed.mockResolvedValue({ agency_dialer_enabled: true });
    app = await buildApp();
  });
  afterEach(async () => {
    await app.close();
  });

  it('returns the resolved client-exposed flag map', async () => {
    const res = await app.inject({ method: 'GET', url: '/feature-flags' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ agency_dialer_enabled: true });
  });

  it('resolves for the caller tenant/account', async () => {
    await app.inject({ method: 'GET', url: '/feature-flags' });
    expect(mocks.resolveClientExposed).toHaveBeenCalledWith({
      tenantId: 'tenant-1', accountId: 'account-1',
    });
  });

  it('exposes no write verbs', async () => {
    for (const method of ['POST', 'PUT', 'DELETE'] as const) {
      const res = await app.inject({ method, url: '/feature-flags' });
      expect(res.statusCode).toBe(404);
    }
  });
});
