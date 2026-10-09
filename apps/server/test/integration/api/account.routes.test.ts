/*
 * Account routes on real Postgres through `initDbPool` (the repositories import the
 * package pool directly). `POST /accounts`, `PUT /accounts/:id` and
 * `DELETE /accounts/:id` are not served (no `account.create|update|delete` in the
 * contract), so they are not covered. Also covers `GET /accounts/mine`, the agent's
 * bootstrap read.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { vi } from 'vitest';
import Fastify from 'fastify';
import { closePool, initDbPool } from '@magick-agency/db';
import { TEST_DB_URL } from '../../../../../packages/db/test/helpers/test-db.js';
import { closeTestPool, truncateAll } from '../../../../../packages/db/test/integration/setup/test-utils.js';
import { insertTenant, insertAccount, insertUser, insertMembership } from '../../../../../packages/db/test/integration/setup/platform-factories.js';

// Bypass auth/RBAC — attach tenantId directly
vi.mock('../../../src/auth/session.middleware.js', () => ({
  // Attaches `request.user` from a header for the `/mine` case.
  sessionMiddleware: async (request: any) => {
    if (request.headers['x-user-id']) request.user = { id: request.headers['x-user-id'] };
  },
}));
vi.mock('../../../src/api/middleware/tenant-context.middleware.js', () => ({
  tenantContextMiddleware: async (request: any) => {
    request.tenantId = request.headers['x-tenant-id'];
    request.accountId = request.headers['x-account-id'];
  },
}));
vi.mock('../../../src/rbac/rbac.middleware.js', () => ({
  requirePermission: () => async () => {},
}));

const { accountRoutes } = await import('../../../src/api/routes/account.routes.js');

describe('account routes (integration)', () => {
  let app: ReturnType<typeof Fastify>;
  let tenant: any;

  beforeEach(async () => {
    await truncateAll();
    tenant = await insertTenant();

    app = Fastify();
    await app.register(accountRoutes, { prefix: '/accounts' });
    await app.ready();
  });

  beforeAll(() => {
    initDbPool({ url: TEST_DB_URL, poolMin: 0, poolMax: 4 });
  });

  afterAll(async () => {
    await closePool();
    await closeTestPool();
  });

  describe('GET /accounts — listing', () => {
    it('lists accounts for tenant', async () => {
      await insertAccount({ tenant_id: tenant.id, name: 'A', slug: 'a' });
      await insertAccount({ tenant_id: tenant.id, name: 'B', slug: 'b' });

      const res = await app.inject({
        method: 'GET',
        url: '/accounts',
        headers: { 'x-tenant-id': tenant.id },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.accounts).toHaveLength(2);
    });
  });

  describe('GET /accounts/mine', () => {
    it('resolves a tenant-wide membership to every live account, three fields each', async () => {
      const a1 = await insertAccount({ tenant_id: tenant.id, name: 'A', slug: 'a' });
      const a2 = await insertAccount({ tenant_id: tenant.id, name: 'B', slug: 'b' });
      await insertAccount({ tenant_id: tenant.id, name: 'Gone', slug: 'gone', status: 'deleted' });
      const otherTenant = await insertTenant();
      await insertAccount({ tenant_id: otherTenant.id, name: 'Other', slug: 'other' });
      const user = await insertUser();
      await insertMembership({ user_id: user.id, tenant_id: tenant.id, account_id: null, role: 'agent' });

      const res = await app.inject({
        method: 'GET',
        url: '/accounts/mine',
        headers: { 'x-tenant-id': tenant.id, 'x-user-id': user.id },
      });

      expect(res.statusCode).toBe(200);
      const accounts = res.json().accounts as Array<Record<string, unknown>>;
      expect(accounts.map((a) => a.id).sort()).toEqual([a1.id, a2.id].sort());
      for (const a of accounts) expect(Object.keys(a).sort()).toEqual(['id', 'name', 'tenant_id']);
    });

    it('confines an account-scoped membership to its own account', async () => {
      const a1 = await insertAccount({ tenant_id: tenant.id, name: 'A', slug: 'a' });
      await insertAccount({ tenant_id: tenant.id, name: 'B', slug: 'b' });
      const user = await insertUser();
      await insertMembership({ user_id: user.id, tenant_id: tenant.id, account_id: a1.id, role: 'agent' });

      const res = await app.inject({
        method: 'GET',
        url: '/accounts/mine',
        headers: { 'x-tenant-id': tenant.id, 'x-user-id': user.id },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().accounts).toEqual([{ id: a1.id, name: 'A', tenant_id: tenant.id }]);
    });
  });
});
