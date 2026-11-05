/*
 * Account routes on real Postgres through `initDbPool` (the repositories import the
 * package pool directly): the list, `GET /accounts/mine` (the agent's bootstrap read)
 * and `POST /accounts`, whose slug choice leans on the partial unique index
 * `idx_accounts_tenant_slug_active` and so is only proven here. `PUT` and `DELETE
 * /accounts/:id` are not served (no `account.update|delete` in the contract).
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { vi } from 'vitest';
import Fastify from 'fastify';
import { closePool, initDbPool } from '@magick-agency/db';
import { TEST_DB_URL } from '../../../../../packages/db/test/helpers/test-db.js';
import { closeTestPool, getTestPool, truncateAll } from '../../../../../packages/db/test/integration/setup/test-utils.js';
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
    // A tenant-wide tenant_admin unless a case scopes the seat to an account.
    request.membership = { role: 'tenant_admin', account_id: request.headers['x-membership-account'] ?? null };
  },
}));
vi.mock('../../../src/rbac/rbac.middleware.js', () => ({
  requirePermission: () => async () => {},
}));

const { accountRoutes } = await import('../../../src/api/routes/account.routes.js');
const { platformAuditLogger } = await import('../../../src/audit/platform/audit-logger.js');

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

  describe('POST /accounts', () => {
    const create = (name: string, headers: Record<string, string> = {}) =>
      app.inject({
        method: 'POST',
        url: '/accounts',
        headers: { 'x-tenant-id': tenant.id, 'x-user-id': userId, ...headers },
        payload: { name },
      });
    let userId: string;

    beforeEach(async () => {
      userId = (await insertUser()).id;
    });

    it('writes a live account row with the slug from its name, and it lists at once', async () => {
      const res = await create('  North Region  ');

      expect(res.statusCode).toBe(201);
      const { account } = res.json();
      expect(account).toMatchObject({ tenant_id: tenant.id, name: 'North Region', slug: 'north-region', status: 'active' });

      const { rows } = await getTestPool().query('SELECT tenant_id, name, slug, status FROM accounts WHERE id = $1', [account.id]);
      expect(rows).toEqual([{ tenant_id: tenant.id, name: 'North Region', slug: 'north-region', status: 'active' }]);

      const list = await app.inject({ method: 'GET', url: '/accounts', headers: { 'x-tenant-id': tenant.id } });
      expect(list.json().accounts.map((a: { id: string }) => a.id)).toContain(account.id);
    });

    it('records account.created in platform_audit_log under the new account', async () => {
      const { account } = (await create('Audited')).json();
      await platformAuditLogger.shutdown();

      const { rows } = await getTestPool().query(
        `SELECT tenant_id, account_id, user_id, actor_type, resource_type, resource_id, details
           FROM platform_audit_log WHERE action = 'account.created' AND tenant_id = $1`,
        [tenant.id],
      );
      expect(rows).toEqual([{
        tenant_id: tenant.id,
        account_id: account.id,
        user_id: userId,
        actor_type: 'human',
        resource_type: 'account',
        resource_id: account.id,
        details: { name: 'Audited', slug: 'audited' },
      }]);
    });

    it('refuses a name a live account has (409), ignoring case', async () => {
      await insertAccount({ tenant_id: tenant.id, name: 'Sales', slug: 'sales' });

      const res = await create('SALES');

      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe('account_name_taken');
      const { rows } = await getTestPool().query('SELECT count(*)::int AS n FROM accounts WHERE tenant_id = $1', [tenant.id]);
      expect(rows[0].n).toBe(1);
    });

    it('reuses a deleted account\'s name and slug', async () => {
      await insertAccount({ tenant_id: tenant.id, name: 'Sales', slug: 'sales', status: 'deleted' });

      const res = await create('Sales');

      expect(res.statusCode).toBe(201);
      expect(res.json().account.slug).toBe('sales');
    });

    it('suffixes the slug when a differently named account holds it', async () => {
      await insertAccount({ tenant_id: tenant.id, name: 'Sales!', slug: 'sales' });

      const res = await create('Sales?');

      expect(res.statusCode).toBe(201);
      expect(res.json().account.slug).toMatch(/^sales-[0-9a-f]{6}$/);
    });

    it('another tenant\'s account is no clash, by name or slug: both rules are per tenant', async () => {
      const other = await insertTenant();
      await insertAccount({ tenant_id: other.id, name: 'Sales', slug: 'sales' });

      const res = await create('Sales');
      expect(res.statusCode).toBe(201);
      expect(res.json().account.slug).toBe('sales');
    });

    it('two concurrent creates of one name end as one account and one 409', async () => {
      const [a, b] = await Promise.all([create('Renewals'), create('Renewals')]);

      expect([a.statusCode, b.statusCode].sort()).toEqual([201, 409]);
      const { rows } = await getTestPool().query(
        `SELECT name FROM accounts WHERE tenant_id = $1 AND status != 'deleted'`,
        [tenant.id],
      );
      expect(rows).toEqual([{ name: 'Renewals' }]);
    });

    it('refuses an account-scoped seat (403) and writes nothing', async () => {
      const scoped = await insertAccount({ tenant_id: tenant.id, name: 'Home', slug: 'home' });

      const res = await create('Elsewhere', { 'x-membership-account': scoped.id });

      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('tenant_wide_membership_required');
      const { rows } = await getTestPool().query(`SELECT 1 FROM accounts WHERE name = 'Elsewhere'`);
      expect(rows).toEqual([]);
    });
  });
});
