/*
 * PORT NOTE (magick-agency): ported from master test/unit/api/routes/proxy-feature-flags.routes.test.ts@a1f0756a
 * (5 cases → 4: 1 modified, 2 deleted, 2 kept re-pointed, plus 1 NEW). The
 * route is now a HOP COLLAPSE (`src/api/routes/feature-flags.routes.ts`): master's
 * gate + core's `resolveClientExposed` body in-process, so there is no core
 * client, no per-tenant API key and no proxied status.
 *  - 'proxies GET to core /feature-flags with the per-tenant API key +
 *    tenant/account' → modified: asserts the in-process resolve for the proven
 *    tenant/account.
 *  - 'passes through the core status (e.g. 401)' → deleted: no upstream status.
 *  - 'uses the S2S-free tenant credential (not the bearer token path)' → deleted:
 *    no credential at all.
 *  - the two permission cases → re-pointed to `agency.flags.read` (master's
 *    `proxy.feature_flags.read`, renamed in the contract).
 *  - NEW: the 400 a tenant-only request got from core's `authMiddleware` through
 *    the passthrough is kept in-process.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';

const mocks = vi.hoisted(() => ({
  resolveClientExposed: vi.fn(),
  accountId: 'account-1' as string | undefined,
  /**
   * A spy rather than a no-op, so the permission this route DECLARES is
   * observable. `requirePermission` runs at route-registration time, so
   * `buildApp()` is what records the call. See the assertions at the bottom of
   * this file for why that matters.
   */
  requirePermission: vi.fn((_permission: string) => async () => {}),
}));

// PORT NOTE (magick-agency): master mocked `proxy/core-client` (`proxyToCore`)
// and `proxy/proxy.utils` (`resolveCoreApiKey`); the route now calls the flag
// service in-process, so that is what is mocked.
vi.mock('../../../../src/feature-flags/index.js', () => ({
  getFeatureFlagService: () => ({ resolveClientExposed: mocks.resolveClientExposed }),
}));
vi.mock('../../../../src/auth/session.middleware.js', () => ({
  sessionMiddleware: async (req: any) => {
    req.tenantId = 'tenant-1';
    req.accountId = mocks.accountId;
  },
}));
vi.mock('../../../../src/api/middleware/tenant-context.middleware.js', () => ({
  tenantContextMiddleware: async () => {},
}));
vi.mock('../../../../src/rbac/rbac.middleware.js', () => ({
  requirePermission: mocks.requirePermission,
}));

import Fastify from 'fastify';
import { featureFlagsRoutes } from '../../../../src/api/routes/feature-flags.routes.js';
import { hasPermission, type Permission } from '@magick-agency/contracts/rbac';

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(featureFlagsRoutes, { prefix: '/feature-flags' });
  await app.ready();
  return app;
}

describe('feature-flags (tenant lane)', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.accountId = 'account-1';
    mocks.resolveClientExposed.mockResolvedValue({ agency_dialer_enabled: true });
    app = await buildApp();
  });
  afterEach(async () => {
    await app.close();
  });

  it('resolves GET in-process for the proven tenant/account (master: proxied to core with the per-tenant key)', async () => {
    const res = await app.inject({ method: 'GET', url: '/feature-flags' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ agency_dialer_enabled: true });
    expect(mocks.resolveClientExposed).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      accountId: 'account-1',
    });
  });

  it('NEW: 400s a request that names no account, as core\'s auth middleware did through the proxy', async () => {
    mocks.accountId = undefined;
    const res = await app.inject({ method: 'GET', url: '/feature-flags' });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'Bad Request', message: 'Missing required header: X-Account-Id' });
    expect(mocks.resolveClientExposed).not.toHaveBeenCalled();
  });
});

/**
 * The regression guard for MAG-181, at the layer where the bug actually lived.
 *
 * The defect was never a wrong floor. It was that this route BORROWED
 * `proxy.stats.read` (floor `viewer`, level 10) while a dedicated `agent` is
 * level 5 — so every agent 403'd on the flag map, `FeatureFlagsContext` is
 * fail-safe closed and resolved every flag to `false`, and `RequireFlag` refused
 * `/station`, `/dialer`, `/dialer/performance` and `/dialer/attempts` alike
 * behind copy about the tenant's billing plan.
 *
 * Nothing caught it because the coverage was split either side of the seam:
 * `test/unit/rbac/roles.agent.test.ts` pins what `proxy.feature_flags.read`
 * FLOORS at and cannot see which permission this route CARRIES, while this file
 * mocked `requirePermission` to a no-op and so could not see it either. Reverting
 * the string on `proxy-feature-flags.routes.ts` — a plausible one-token tidy-up
 * onto the shared floor — put every agent back outside the product with both
 * suites green.
 *
 * A route table built from Fastify's `onRoute` hook is the durable form of this
 * (master already has one: `test/unit/agency/proxy-agency-route-table.test.ts`,
 * whose header was written for exactly this failure class). That generalises the
 * guarantee and is worth filing; these two assertions close the loop today.
 */
describe('the permission this route is gated on', () => {
  /*
   * Registers the plugin itself rather than leaning on the suite above. The
   * recorded call happens at REGISTRATION time, so reading it from a sibling
   * block's leftover mock state would make these assertions depend on execution
   * order — and an assertion that passes because another block ran first is the
   * kind that quietly stops asserting.
   */
  beforeEach(async () => {
    mocks.requirePermission.mockClear();
    const app = Fastify();
    await app.register(featureFlagsRoutes, { prefix: '/feature-flags' });
    await app.ready();
    await app.close();
  });

  it('is proxy.feature_flags.read, not the viewer-floored stats lane it borrowed', () => {
    // The literal is the point: this is the single line MAG-181 changed, and the
    // one a future cleanup would most plausibly change back.
    // PORT NOTE (magick-agency): the contract renames it `agency.flags.read`; the
    // stats lane (`proxy.stats.read`) does not exist, so the negative assertion is
    // that no viewer-floored permission is declared instead.
    expect(mocks.requirePermission).toHaveBeenCalledWith('agency.flags.read');
    expect(mocks.requirePermission).not.toHaveBeenCalledWith('agency.campaigns.read');
  });

  it('is one a dedicated agent actually holds, which is the whole fix', () => {
    /*
     * Asserted as the PROPERTY rather than a second floor literal, so it fails
     * both ways: reverting the route's permission string, AND raising
     * `proxy.feature_flags.read`'s floor in `roles.ts` later. Either one re-locks
     * every agent out of all four dialer routes, and neither is visible from the
     * other file.
     */
    const declared = mocks.requirePermission.mock.calls.map((call) => call[0] as Permission);
    expect(declared.length).toBeGreaterThan(0);
    for (const permission of declared) {
      expect(hasPermission('agent', permission), permission).toBe(true);
    }
  });
});
