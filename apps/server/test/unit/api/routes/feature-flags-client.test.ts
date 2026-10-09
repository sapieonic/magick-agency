/*
 * PORT NOTE (magick-agency): ported from core test/unit/api/routes/feature-flags-client.test.ts@4850d1d9
 * (3 cases → 3) against the collapsed route. Changes: the auth mocks (see below),
 * the prefix, and the fixture flag (`whatsapp_personal` is not an agency flag).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  getTenantId: vi.fn().mockReturnValue('tenant-1'),
  getAccountId: vi.fn().mockReturnValue('account-1'),
  resolveClientExposed: vi.fn(),
}));

// PORT NOTE (magick-agency): core's route read the tenant/account from the
// `x-mgkvc-*` headers its `authMiddleware` validated (`getTenantId` /
// `getAccountId`). The collapsed route reads them from the request decorations
// lane A's `sessionMiddleware` → `tenantContextMiddleware` chain sets, gated by
// `requirePermission` — so those three are mocked, and the two getters survive as
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
  // PORT NOTE (magick-agency): core's prefix `/api/v1/feature-flags` → `/feature-flags`.
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
