/*
 * PORT NOTE (magick-agency): ported from master test/integration/api/super-admin.routes.test.ts@a1f0756a
 * (56 cases → 46). Deleted with the routes they exercised (super-admin.routes.ts
 * module note): 'POST /super-admin/tenants/:id/credits' (4) and
 * 'POST /super-admin/tenants/:id/credits/deduct' (3) — no credits in v1;
 * 'reports the credit cache beside the ledger, as strings' (1) — `credit_cache`
 * went with the credit ledger; 'DELETE /super-admin/tenants/:id' (2) — the route
 * is not ported. Modified: 'creates tenant with account and membership' (no
 * `core_key_provisioned` / `phone_auto_assigned` on the response, no
 * `tenant_phone_assignments` row, and no `tenant_credit_balances` row to check),
 * 'lists all tenants with credit balance and member count' and 'returns tenant
 * detail with members and credits' (the credit-balance fixture and assertions
 * are dropped; the rest is master's). Real Postgres through `initDbPool` (master
 * mocked `src/db/connection.js`). The config mock spreads the real config and
 * overrides only `superAdmin` (master's `encryption` / `coreService` have no
 * counterpart). Master's core-client, proxy.utils, crypto and phone-number
 * repository mocks are removed with the modules they stubbed (no core, no core
 * API key, no pooled number). The route takes no `creditService` option.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach } from 'vitest';
import { vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import bcrypt from 'bcryptjs';
import { closePool, initDbPool } from '@magick-agency/db';
import { TEST_DB_URL } from '../../../../../packages/db/test/helpers/test-db.js';
import { getTestPool, closeTestPool, truncateAll } from '../../../../../packages/db/test/integration/setup/test-utils.js';
import {
  insertTenant,
  insertUser,
  insertMembership,
  insertMembershipInvite,
} from '../../../../../packages/db/test/integration/setup/platform-factories.js';
import { trackSuperAdminAuditWrites } from '../../helpers/drain-super-admin-audit.js';

// ── Mocks (must be before dynamic imports) ─────────────────────────────────

// PORT NOTE (magick-agency): master replaced the whole config with
// `{ superAdmin, encryption, coreService }`. The invite issuer that add-user now
// calls reads `invites` / `brand` / `consoleBaseUrl` / `mailjet` (unset → the
// mail reports unsent), so the real parsed config is kept and only `superAdmin`
// is overridden.
vi.mock('../../../src/config/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/config/index.js')>();
  return {
    ...actual,
    config: {
      ...actual.config,
      superAdmin: { jwtSecret: 'test-super-secret-at-least-16-chars' },
    },
  };
});

// PORT NOTE (magick-agency): partial — `packages/db`'s pool imports `logger`.
vi.mock('@magick-agency/observability', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@magick-agency/observability')>()),
  createChildLogger: () => ({
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('../../../src/cache/redis-cache.js', () => ({
  redisCache: {
    get: vi.fn().mockResolvedValue(null), set: vi.fn(), del: vi.fn(), delByPattern: vi.fn(),
    // Q5 (Manas, 2026-10-09): revocation deletes forward to `del` and report success.
    async delForRevocation(this: { del: (...k: string[]) => unknown }, ...k: string[]) { await this.del(...k); return true; },
    // metadata-cache.ts write fence
    incrementGeneration: vi.fn().mockResolvedValue(1),
    setIfGenerationMatches: vi.fn().mockResolvedValue(true),
  },
}));

// ── Dynamic imports AFTER mocks ────────────────────────────────────────────

const { superAdminRoutes } = await import('../../../src/api/routes/super-admin.routes.js');
const { redisCache } = await import('../../../src/cache/redis-cache.js');
const { superAdminRepository } = await import('@magick-agency/db/repositories/super-admin.repository');

// ── Helpers ────────────────────────────────────────────────────────────────

const ADMIN_EMAIL = 'admin@test.com';
const ADMIN_PASSWORD = 'TestPassword123!';
const ADMIN_NAME = 'Test Admin';

let adminId: string;

async function insertSuperAdmin(overrides: Record<string, unknown> = {}) {
  const pool = getTestPool();
  const id = (overrides['id'] as string) || randomUUID();
  const email = (overrides['email'] as string) || ADMIN_EMAIL;
  const password = (overrides['password'] as string) || ADMIN_PASSWORD;
  const name = (overrides['name'] as string) || ADMIN_NAME;
  const status = (overrides['status'] as string) || 'active';

  const passwordHash = await bcrypt.hash(password, 10);
  await pool.query(
    `INSERT INTO super_admins (id, email, password_hash, name, status)
     VALUES ($1, $2, $3, $4, $5)`,
    [id, email, passwordHash, name, status],
  );
  return { id, email, name, status };
}

async function loginAndGetToken(
  app: ReturnType<typeof Fastify>,
  email = ADMIN_EMAIL,
  password = ADMIN_PASSWORD,
): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/super-admin/login',
    payload: { email, password },
  });
  return res.json().token;
}

// ── Test suite ─────────────────────────────────────────────────────────────

describe('super-admin routes (integration)', () => {
  let app: ReturnType<typeof Fastify>;

  beforeAll(() => {
    initDbPool({ url: TEST_DB_URL, poolMin: 0, poolMax: 4 });
  });

  beforeEach(async () => {
    await truncateAll();

    adminId = randomUUID();
    await insertSuperAdmin({ id: adminId });

    app = Fastify();
    // PORT NOTE (magick-agency): master passed `creditService: new CreditService(null)`.
    await app.register(superAdminRoutes, {
      prefix: '/super-admin',
    });
    await app.ready();
  });

  // PORT NOTE (magick-agency): drain the routes' fire-and-forget super-admin
  // audit writes before the next `truncateAll()`; an in-flight INSERT deadlocks
  // with the TRUNCATE (see test/helpers/drain-super-admin-audit.ts).
  const auditWrites = trackSuperAdminAuditWrites();
  afterEach(async () => {
    await auditWrites.drain();
  });

  afterAll(async () => {
    auditWrites.restore();
    await closePool();
    await closeTestPool();
  });

  // ── POST /login ──────────────────────────────────────────────────────────

  describe('POST /super-admin/login', () => {
    it('returns JWT for valid credentials', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/super-admin/login',
        payload: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.token).toBeDefined();
      expect(typeof body.token).toBe('string');
      expect(body.admin).toBeDefined();
      expect(body.admin.email).toBe(ADMIN_EMAIL);
      expect(body.admin.name).toBe(ADMIN_NAME);
      expect(body.admin.id).toBe(adminId);
    });

    it('returns 401 for wrong password', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/super-admin/login',
        payload: { email: ADMIN_EMAIL, password: 'WrongPassword999!' },
      });

      expect(res.statusCode).toBe(401);
      const body = res.json();
      expect(body.error).toBe('Unauthorized');
      expect(body.message).toBe('Invalid credentials');
    });

    it('returns 401 for non-existent email', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/super-admin/login',
        payload: { email: 'nobody@test.com', password: ADMIN_PASSWORD },
      });

      expect(res.statusCode).toBe(401);
      const body = res.json();
      expect(body.error).toBe('Unauthorized');
      expect(body.message).toBe('Invalid credentials');
    });

    it('returns 400 for missing email', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/super-admin/login',
        payload: { password: ADMIN_PASSWORD },
      });

      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.error).toBe('Bad Request');
      expect(body.details).toBeDefined();
    });

    it('returns 403 for inactive admin', async () => {
      const inactiveId = randomUUID();
      await insertSuperAdmin({
        id: inactiveId,
        email: 'inactive@test.com',
        password: 'InactivePass123!',
        status: 'inactive',
      });

      const res = await app.inject({
        method: 'POST',
        url: '/super-admin/login',
        payload: { email: 'inactive@test.com', password: 'InactivePass123!' },
      });

      expect(res.statusCode).toBe(403);
      const body = res.json();
      expect(body.error).toBe('Forbidden');
      expect(body.message).toBe('Account is inactive');
    });
  });

  // ── GET /me ──────────────────────────────────────────────────────────────

  describe('GET /super-admin/me', () => {
    it('returns admin info with valid JWT', async () => {
      const token = await loginAndGetToken(app);

      const res = await app.inject({
        method: 'GET',
        url: '/super-admin/me',
        headers: { authorization: `Bearer ${token}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.admin).toBeDefined();
      expect(body.admin.email).toBe(ADMIN_EMAIL);
      expect(body.admin.name).toBe(ADMIN_NAME);
      expect(body.admin.id).toBe(adminId);
      // Should not include password_hash
      expect(body.admin.password_hash).toBeUndefined();
    });

    it('returns 401 without token', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/super-admin/me',
      });

      expect(res.statusCode).toBe(401);
      const body = res.json();
      expect(body.error).toBe('Unauthorized');
    });

    it('returns 401 with invalid token', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/super-admin/me',
        headers: { authorization: 'Bearer totally-invalid-jwt-token' },
      });

      expect(res.statusCode).toBe(401);
      const body = res.json();
      expect(body.error).toBe('Unauthorized');
    });
  });

  // ── POST /tenants ────────────────────────────────────────────────────────

  describe('POST /super-admin/tenants', () => {
    it('creates tenant with account and membership', async () => {
      const token = await loginAndGetToken(app);

      const res = await app.inject({
        method: 'POST',
        url: '/super-admin/tenants',
        headers: { authorization: `Bearer ${token}` },
        payload: {
          name: 'New Tenant Corp',
          owner_email: 'owner@example.com',
          owner_name: 'Tenant Owner',
        },
      });

      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.tenant).toBeDefined();
      expect(body.tenant.name).toBe('New Tenant Corp');
      expect(body.owner_email).toBe('owner@example.com');
      // PORT NOTE (magick-agency): master asserted `core_key_provisioned: true`
      // (a mocked `createCoreApiKey`). No core API key and no pooled number are
      // provisioned, so neither flag is on the response (contract
      // `CreateTenantResponse`).
      expect(body).not.toHaveProperty('core_key_provisioned');
      expect(body).not.toHaveProperty('phone_auto_assigned');

      // Verify tenant, account and membership were created in DB
      // PORT NOTE (magick-agency): master also checked a zero
      // `tenant_credit_balances` row — no credits; the pooled-number check below
      // replaces it.
      const pool = getTestPool();
      const tenantId = body.tenant.id;

      const { rows: accounts } = await pool.query(
        'SELECT * FROM accounts WHERE tenant_id = $1',
        [tenantId],
      );
      expect(accounts).toHaveLength(1);
      expect(accounts[0].name).toBe('Default');

      const { rows: memberships } = await pool.query(
        'SELECT * FROM memberships WHERE tenant_id = $1',
        [tenantId],
      );
      expect(memberships).toHaveLength(1);
      expect(memberships[0].role).toBe('tenant_owner');

      const { rows: assignments } = await pool.query(
        'SELECT * FROM tenant_phone_assignments WHERE tenant_id = $1',
        [tenantId],
      );
      expect(assignments).toHaveLength(0);
    });

    it('REFUSES a flagged owner_email rather than provisioning an unclaimable owner', async () => {
      /**
       * The previous version wrote a fresh stub and made it `tenant_owner`.
       * A flagged row is always bound and `firebase_uid` is UNIQUE, so that
       * owner could never claim the workspace — the worst place on the platform
       * to leave a membership nothing can activate.
       */
      const token = await loginAndGetToken(app);
      const pool = getTestPool();
      const bound = await insertUser({
        firebase_uid: 'fb-flagged-owner',
        email: 'owner@flagged.com',
      });
      await pool.query('UPDATE users SET email_unverified = true WHERE id = $1', [bound.id]);

      const res = await app.inject({
        method: 'POST',
        url: '/super-admin/tenants',
        headers: { authorization: `Bearer ${token}` },
        payload: { name: 'Flagged Corp', owner_email: 'owner@flagged.com' },
      });

      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe('unverified_address_holder');
      // The whole provisioning transaction rolled back — no half-made tenant.
      const { rows } = await pool.query('SELECT id FROM tenants WHERE name = $1', ['Flagged Corp']);
      expect(rows).toHaveLength(0);
    });

    it('returns 400 for missing required fields', async () => {
      const token = await loginAndGetToken(app);

      const res = await app.inject({
        method: 'POST',
        url: '/super-admin/tenants',
        headers: { authorization: `Bearer ${token}` },
        payload: { name: 'Missing Owner Email' },
      });

      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.error).toBe('Bad Request');
      expect(body.details).toBeDefined();
    });
  });

  // PORT NOTE (magick-agency): master's 'POST /super-admin/tenants/:id/credits'
  // (4 cases) and 'POST /super-admin/tenants/:id/credits/deduct' (3 cases) are
  // deleted with the credit routes — see the file note.

  // ── POST /admins ─────────────────────────────────────────────────────────

  describe('POST /super-admin/admins', () => {
    it('creates a new super admin', async () => {
      const token = await loginAndGetToken(app);

      const res = await app.inject({
        method: 'POST',
        url: '/super-admin/admins',
        headers: { authorization: `Bearer ${token}` },
        payload: {
          email: 'newadmin@test.com',
          password: 'NewAdminPass123!',
          name: 'New Admin',
        },
      });

      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.admin).toBeDefined();
      expect(body.admin.email).toBe('newadmin@test.com');
      expect(body.admin.name).toBe('New Admin');
      expect(body.admin.status).toBe('active');
      // Should not expose password_hash
      expect(body.admin.password_hash).toBeUndefined();

      // Verify the new admin can log in
      const loginRes = await app.inject({
        method: 'POST',
        url: '/super-admin/login',
        payload: { email: 'newadmin@test.com', password: 'NewAdminPass123!' },
      });
      expect(loginRes.statusCode).toBe(200);
      expect(loginRes.json().token).toBeDefined();
    });

    it('returns 409 for duplicate email', async () => {
      const token = await loginAndGetToken(app);

      const res = await app.inject({
        method: 'POST',
        url: '/super-admin/admins',
        headers: { authorization: `Bearer ${token}` },
        payload: {
          email: ADMIN_EMAIL, // already exists
          password: 'AnotherPass123!',
          name: 'Duplicate Admin',
        },
      });

      expect(res.statusCode).toBe(409);
      const body = res.json();
      expect(body.error).toBe('Conflict');
      expect(body.message).toContain('already registered');
    });

    it('returns 400 for password shorter than 8 characters', async () => {
      const token = await loginAndGetToken(app);

      const res = await app.inject({
        method: 'POST',
        url: '/super-admin/admins',
        headers: { authorization: `Bearer ${token}` },
        payload: {
          email: 'short@test.com',
          password: 'short',
          name: 'Short Pass Admin',
        },
      });

      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.error).toBe('Bad Request');
    });
  });

  // ── PUT /change-password ─────────────────────────────────────────────────

  describe('PUT /super-admin/change-password', () => {
    it('changes password successfully', async () => {
      const token = await loginAndGetToken(app);

      const res = await app.inject({
        method: 'PUT',
        url: '/super-admin/change-password',
        headers: { authorization: `Bearer ${token}` },
        payload: {
          current_password: ADMIN_PASSWORD,
          new_password: 'NewSecurePassword456!',
        },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.success).toBe(true);

      // Verify old password no longer works
      const oldLoginRes = await app.inject({
        method: 'POST',
        url: '/super-admin/login',
        payload: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
      });
      expect(oldLoginRes.statusCode).toBe(401);

      // Verify new password works
      const newLoginRes = await app.inject({
        method: 'POST',
        url: '/super-admin/login',
        payload: { email: ADMIN_EMAIL, password: 'NewSecurePassword456!' },
      });
      expect(newLoginRes.statusCode).toBe(200);
      expect(newLoginRes.json().token).toBeDefined();
    });

    it('returns 401 for wrong current password', async () => {
      const token = await loginAndGetToken(app);

      const res = await app.inject({
        method: 'PUT',
        url: '/super-admin/change-password',
        headers: { authorization: `Bearer ${token}` },
        payload: {
          current_password: 'WrongCurrentPass!',
          new_password: 'NewSecurePassword456!',
        },
      });

      expect(res.statusCode).toBe(401);
      const body = res.json();
      expect(body.error).toBe('Unauthorized');
      expect(body.message).toBe('Current password is incorrect');
    });

    it('returns 400 for new password shorter than 8 characters', async () => {
      const token = await loginAndGetToken(app);

      const res = await app.inject({
        method: 'PUT',
        url: '/super-admin/change-password',
        headers: { authorization: `Bearer ${token}` },
        payload: {
          current_password: ADMIN_PASSWORD,
          new_password: 'short',
        },
      });

      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.error).toBe('Bad Request');
    });
  });

  // ── POST /tenants/:id/users ──────────────────────────────────────────────

  describe('POST /super-admin/tenants/:id/users', () => {
    it('adds a new user to an existing tenant', async () => {
      const token = await loginAndGetToken(app);
      const tenant = await insertTenant();

      const res = await app.inject({
        method: 'POST',
        url: `/super-admin/tenants/${tenant.id}/users`,
        headers: { authorization: `Bearer ${token}` },
        payload: {
          email: 'newuser@example.com',
          role: 'operator',
          name: 'New User',
        },
      });

      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.membership).toBeDefined();
      expect(body.membership.tenant_id).toBe(tenant.id);
      expect(body.membership.role).toBe('operator');

      // Verify user was created in DB
      const pool = getTestPool();
      const { rows: users } = await pool.query(
        'SELECT * FROM users WHERE email = $1',
        ['newuser@example.com'],
      );
      expect(users).toHaveLength(1);
      expect(users[0].display_name).toBe('New User');
      // Should have a pending firebase_uid
      expect(users[0].firebase_uid).toMatch(/^pending_/);
    });

    it('adds an existing user to a tenant', async () => {
      const token = await loginAndGetToken(app);
      const tenant = await insertTenant();
      const user = await insertUser({ email: 'existing@example.com' });

      const res = await app.inject({
        method: 'POST',
        url: `/super-admin/tenants/${tenant.id}/users`,
        headers: { authorization: `Bearer ${token}` },
        payload: {
          email: 'existing@example.com',
          role: 'tenant_admin',
        },
      });

      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.membership.user_id).toBe(user.id);
      expect(body.membership.role).toBe('tenant_admin');
    });

    it('REFUSES a flagged email on add-user, same rule as tenant-create', async () => {
      const token = await loginAndGetToken(app);
      const tenant = await insertTenant();
      const pool = getTestPool();
      const bound = await insertUser({
        firebase_uid: 'fb-flagged-add',
        email: 'staff@flagged.com',
      });
      await pool.query('UPDATE users SET email_unverified = true WHERE id = $1', [bound.id]);

      const res = await app.inject({
        method: 'POST',
        url: `/super-admin/tenants/${tenant.id}/users`,
        headers: { authorization: `Bearer ${token}` },
        payload: { email: 'staff@flagged.com', role: 'tenant_admin' },
      });

      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe('unverified_address_holder');
      const { rows } = await pool.query(
        'SELECT id FROM memberships WHERE user_id = $1',
        [bound.id],
      );
      expect(rows).toHaveLength(0);
    });

    it('returns 409 when user is already a member', async () => {
      const token = await loginAndGetToken(app);
      const tenant = await insertTenant();
      const user = await insertUser({ email: 'member@example.com' });
      await insertMembership({
        user_id: user.id,
        tenant_id: tenant.id,
        role: 'operator',
      });

      const res = await app.inject({
        method: 'POST',
        url: `/super-admin/tenants/${tenant.id}/users`,
        headers: { authorization: `Bearer ${token}` },
        payload: {
          email: 'member@example.com',
          role: 'tenant_admin',
        },
      });

      expect(res.statusCode).toBe(409);
      const body = res.json();
      expect(body.error).toBe('Conflict');
      expect(body.message).toContain('already a member');
    });

    it.each(['revoked', 'inactive'] as const)(
      'reactivates a %s membership with the new role instead of inserting',
      async (status) => {
        const token = await loginAndGetToken(app);
        const tenant = await insertTenant();
        const user = await insertUser({ email: `returning-${status}@example.com` });
        const leftover = await insertMembership({
          user_id: user.id,
          tenant_id: tenant.id,
          role: 'operator',
          status,
        });

        const res = await app.inject({
          method: 'POST',
          url: `/super-admin/tenants/${tenant.id}/users`,
          headers: { authorization: `Bearer ${token}` },
          payload: {
            email: user.email,
            role: 'tenant_admin',
          },
        });

        expect(res.statusCode).toBe(201);
        const body = res.json();
        expect(body.membership.id).toBe(leftover.id);
        expect(body.membership.user_id).toBe(user.id);
        expect(body.membership.role).toBe('tenant_admin');
        expect(body.membership.status).toBe('active');

        const pool = getTestPool();
        const { rows } = await pool.query(
          'SELECT id, role, status FROM memberships WHERE user_id = $1 AND tenant_id = $2',
          [user.id, tenant.id],
        );
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ id: leftover.id, role: 'tenant_admin', status: 'active' });
        expect(redisCache.del).toHaveBeenCalledWith(`cache:membership:${user.id}:${tenant.id}`);
      },
    );

    it('revokes an outstanding invite when reactivating the same membership', async () => {
      const token = await loginAndGetToken(app);
      const tenant = await insertTenant();
      const user = await insertUser({ email: 'invite-leftover@example.com' });
      const leftover = await insertMembership({
        user_id: user.id,
        tenant_id: tenant.id,
        role: 'operator',
        status: 'revoked',
      });
      const live = await insertMembershipInvite({
        membership_id: leftover.id,
        tenant_id: tenant.id,
        email: user.email,
        role: 'operator',
      });
      const spent = await insertMembershipInvite({
        membership_id: leftover.id,
        tenant_id: tenant.id,
        email: user.email,
        role: 'operator',
        claimed_at: new Date(),
      });

      const res = await app.inject({
        method: 'POST',
        url: `/super-admin/tenants/${tenant.id}/users`,
        headers: { authorization: `Bearer ${token}` },
        payload: { email: user.email, role: 'viewer' },
      });

      expect(res.statusCode).toBe(201);
      const pool = getTestPool();
      const { rows } = await pool.query(
        'SELECT id, revoked_at FROM membership_invites WHERE id = ANY($1::uuid[])',
        [[live.id, spent.id]],
      );
      const byId = new Map(rows.map((row) => [row.id, row]));
      expect(byId.get(live.id).revoked_at).not.toBeNull();
      expect(byId.get(spent.id).revoked_at).toBeNull();
    });

    it('returns 404 for non-existent tenant', async () => {
      const token = await loginAndGetToken(app);

      const res = await app.inject({
        method: 'POST',
        url: `/super-admin/tenants/${randomUUID()}/users`,
        headers: { authorization: `Bearer ${token}` },
        payload: {
          email: 'someone@example.com',
          role: 'operator',
        },
      });

      expect(res.statusCode).toBe(404);
    });

    it('returns 400 for invalid role', async () => {
      const token = await loginAndGetToken(app);
      const tenant = await insertTenant();

      const res = await app.inject({
        method: 'POST',
        url: `/super-admin/tenants/${tenant.id}/users`,
        headers: { authorization: `Bearer ${token}` },
        payload: {
          email: 'someone@example.com',
          role: 'super_admin', // not a valid role in the enum
        },
      });

      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.error).toBe('Bad Request');
    });
  });

  // ── GET /tenants ─────────────────────────────────────────────────────────

  describe('GET /super-admin/tenants', () => {
    // PORT NOTE (magick-agency): name kept verbatim; the `insertCreditBalance`
    // fixture and the `credit_balance` assertion are dropped with the
    // `tenant_credit_balances` join (no credits). `member_count` is master's.
    it('lists all tenants with credit balance and member count', async () => {
      const token = await loginAndGetToken(app);
      const tenant1 = await insertTenant({ name: 'Tenant Alpha' });
      const tenant2 = await insertTenant({ name: 'Tenant Beta' });
      const user = await insertUser();
      await insertMembership({ user_id: user.id, tenant_id: tenant1.id, role: 'operator' });

      const res = await app.inject({
        method: 'GET',
        url: '/super-admin/tenants',
        headers: { authorization: `Bearer ${token}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(Array.isArray(body.tenants)).toBe(true);
      expect(body.tenants.length).toBeGreaterThanOrEqual(2);

      const alpha = body.tenants.find((t: any) => t.name === 'Tenant Alpha');
      expect(alpha).toBeDefined();
      expect(alpha.member_count).toBe(1);
    });
  });

  // ── GET /tenants/:id ─────────────────────────────────────────────────────

  describe('GET /super-admin/tenants/:id', () => {
    // PORT NOTE (magick-agency): name kept verbatim; the `insertCreditBalance`
    // fixture and the `credits` assertions are dropped (contract
    // `SuperAdminTenantDetail` has no `credits`).
    it('returns tenant detail with members and credits', async () => {
      const token = await loginAndGetToken(app);
      const tenant = await insertTenant();
      const user = await insertUser();
      await insertMembership({ user_id: user.id, tenant_id: tenant.id, role: 'tenant_owner' });

      const res = await app.inject({
        method: 'GET',
        url: `/super-admin/tenants/${tenant.id}`,
        headers: { authorization: `Bearer ${token}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.tenant).toBeDefined();
      expect(body.tenant.id).toBe(tenant.id);
      expect(Array.isArray(body.members)).toBe(true);
      expect(body.members).toHaveLength(1);
    });

    // PORT NOTE (magick-agency): master's 'reports the credit cache beside the
    // ledger, as strings' is deleted — `credit_cache` went with the credit ledger.

    it('returns 404 for non-existent tenant', async () => {
      const token = await loginAndGetToken(app);

      const res = await app.inject({
        method: 'GET',
        url: `/super-admin/tenants/${randomUUID()}`,
        headers: { authorization: `Bearer ${token}` },
      });

      expect(res.statusCode).toBe(404);
    });
  });

  // PORT NOTE (magick-agency): master's 'DELETE /super-admin/tenants/:id'
  // (2 cases) is deleted — the route is not ported (super-admin.routes.ts).

  // ── GET /admins ──────────────────────────────────────────────────────────

  describe('GET /super-admin/admins', () => {
    it('lists all super admins without password hashes', async () => {
      const token = await loginAndGetToken(app);

      const res = await app.inject({
        method: 'GET',
        url: '/super-admin/admins',
        headers: { authorization: `Bearer ${token}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(Array.isArray(body.admins)).toBe(true);
      expect(body.admins.length).toBeGreaterThanOrEqual(1);

      for (const admin of body.admins) {
        expect(admin.password_hash).toBeUndefined();
        expect(admin.email).toBeDefined();
        expect(admin.name).toBeDefined();
      }
    });
  });

  // ── DELETE /admins/:id ───────────────────────────────────────────────────

  describe('DELETE /super-admin/admins/:id', () => {
    it('deactivates another super admin', async () => {
      const token = await loginAndGetToken(app);
      const otherId = randomUUID();
      await insertSuperAdmin({
        id: otherId,
        email: 'other@test.com',
        name: 'Other Admin',
      });

      const res = await app.inject({
        method: 'DELETE',
        url: `/super-admin/admins/${otherId}`,
        headers: { authorization: `Bearer ${token}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.success).toBe(true);

      // Verify the deactivated admin can no longer log in
      const loginRes = await app.inject({
        method: 'POST',
        url: '/super-admin/login',
        payload: { email: 'other@test.com', password: ADMIN_PASSWORD },
      });
      expect(loginRes.statusCode).toBe(403); // inactive
    });

    it('returns 400 when trying to remove yourself', async () => {
      const token = await loginAndGetToken(app);

      const res = await app.inject({
        method: 'DELETE',
        url: `/super-admin/admins/${adminId}`,
        headers: { authorization: `Bearer ${token}` },
      });

      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.message).toContain('Cannot remove yourself');
    });

    it('returns 404 for non-existent admin', async () => {
      const token = await loginAndGetToken(app);

      const res = await app.inject({
        method: 'DELETE',
        url: `/super-admin/admins/${randomUUID()}`,
        headers: { authorization: `Bearer ${token}` },
      });

      expect(res.statusCode).toBe(404);
    });
  });

  describe('POST /super-admin/admins/:id/reactivate', () => {
    it('reactivates an inactive admin and lets them log in', async () => {
      const token = await loginAndGetToken(app);
      const other = await insertSuperAdmin({
        email: 'inactive@test.com', status: 'inactive',
      });

      const res = await app.inject({
        method: 'POST',
        url: `/super-admin/admins/${other.id}/reactivate`,
        headers: { authorization: `Bearer ${token}` },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().admin.status).toBe('active');
      expect(res.json().admin.password_hash).toBeUndefined();

      // The reactivated admin can now log in (login rejects inactive).
      const login = await app.inject({
        method: 'POST',
        url: '/super-admin/login',
        payload: { email: 'inactive@test.com', password: ADMIN_PASSWORD },
      });
      expect(login.statusCode).toBe(200);
    });

    it('repository.reactivate returns null for an already-active admin', async () => {
      const other = await insertSuperAdmin({ email: 'already-active@test.com', status: 'active' });
      const result = await superAdminRepository.reactivate(other.id);
      expect(result).toBeNull();
    });

    it('404s when the admin does not exist', async () => {
      const token = await loginAndGetToken(app);
      const res = await app.inject({
        method: 'POST',
        url: `/super-admin/admins/${randomUUID()}/reactivate`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(404);
    });

    it('400s when the admin is already active', async () => {
      const token = await loginAndGetToken(app);
      const other = await insertSuperAdmin({ email: 'active2@test.com', status: 'active' });
      const res = await app.inject({
        method: 'POST',
        url: `/super-admin/admins/${other.id}/reactivate`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(400);
    });

    it('403s for the system admin', async () => {
      const token = await loginAndGetToken(app);
      const pool = getTestPool();
      const sysId = randomUUID();
      const hash = await bcrypt.hash(ADMIN_PASSWORD, 10);
      await pool.query(
        `INSERT INTO super_admins (id, email, password_hash, name, status, is_system)
         VALUES ($1, $2, $3, $4, 'inactive', true)`,
        [sysId, 'sys@test.com', hash, 'System'],
      );
      const res = await app.inject({
        method: 'POST',
        url: `/super-admin/admins/${sysId}/reactivate`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(403);
    });
  });

  describe('PUT /super-admin/admins/:id/password', () => {
    it('resets another admin password after verifying the actor password', async () => {
      const token = await loginAndGetToken(app);
      const other = await insertSuperAdmin({ email: 'target@test.com', status: 'active' });

      const res = await app.inject({
        method: 'PUT',
        url: `/super-admin/admins/${other.id}/password`,
        headers: { authorization: `Bearer ${token}` },
        payload: { admin_password: ADMIN_PASSWORD, new_password: 'BrandNewPass123' },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().success).toBe(true);

      // The target can log in with the new password.
      const login = await app.inject({
        method: 'POST',
        url: '/super-admin/login',
        payload: { email: 'target@test.com', password: 'BrandNewPass123' },
      });
      expect(login.statusCode).toBe(200);

      const stale = await app.inject({
        method: 'POST', url: '/super-admin/login',
        payload: { email: 'target@test.com', password: ADMIN_PASSWORD },
      });
      expect(stale.statusCode).toBe(401);

      const actorLogin = await app.inject({
        method: 'POST', url: '/super-admin/login',
        payload: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
      });
      expect(actorLogin.statusCode).toBe(200);
    });

    it('works on an inactive target too', async () => {
      const token = await loginAndGetToken(app);
      const other = await insertSuperAdmin({ email: 'inact-t@test.com', status: 'inactive' });
      const res = await app.inject({
        method: 'PUT',
        url: `/super-admin/admins/${other.id}/password`,
        headers: { authorization: `Bearer ${token}` },
        payload: { admin_password: ADMIN_PASSWORD, new_password: 'AnotherPass123' },
      });
      expect(res.statusCode).toBe(200);
    });

    it('400s when admin_password is empty', async () => {
      const token = await loginAndGetToken(app);
      const other = await insertSuperAdmin({ email: 'target-empty@test.com', status: 'active' });
      const res = await app.inject({
        method: 'PUT',
        url: `/super-admin/admins/${other.id}/password`,
        headers: { authorization: `Bearer ${token}` },
        payload: { admin_password: '', new_password: 'ValidPass123' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('422s when the actor password is wrong', async () => {
      const token = await loginAndGetToken(app);
      const other = await insertSuperAdmin({ email: 'target2@test.com', status: 'active' });
      const res = await app.inject({
        method: 'PUT',
        url: `/super-admin/admins/${other.id}/password`,
        headers: { authorization: `Bearer ${token}` },
        payload: { admin_password: 'WrongPassword!', new_password: 'BrandNewPass123' },
      });
      expect(res.statusCode).toBe(422);
    });

    it('400s when targeting yourself', async () => {
      const token = await loginAndGetToken(app);
      const res = await app.inject({
        method: 'PUT',
        url: `/super-admin/admins/${adminId}/password`,
        headers: { authorization: `Bearer ${token}` },
        payload: { admin_password: ADMIN_PASSWORD, new_password: 'BrandNewPass123' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('400s when new_password is shorter than 8', async () => {
      const token = await loginAndGetToken(app);
      const other = await insertSuperAdmin({ email: 'target3@test.com', status: 'active' });
      const res = await app.inject({
        method: 'PUT',
        url: `/super-admin/admins/${other.id}/password`,
        headers: { authorization: `Bearer ${token}` },
        payload: { admin_password: ADMIN_PASSWORD, new_password: 'short' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('404s when the target does not exist', async () => {
      const token = await loginAndGetToken(app);
      const res = await app.inject({
        method: 'PUT',
        url: `/super-admin/admins/${randomUUID()}/password`,
        headers: { authorization: `Bearer ${token}` },
        payload: { admin_password: ADMIN_PASSWORD, new_password: 'BrandNewPass123' },
      });
      expect(res.statusCode).toBe(404);
    });

    it('403s for the system admin', async () => {
      const token = await loginAndGetToken(app);
      const pool = getTestPool();
      const sysId = randomUUID();
      const hash = await bcrypt.hash(ADMIN_PASSWORD, 10);
      await pool.query(
        `INSERT INTO super_admins (id, email, password_hash, name, status, is_system)
         VALUES ($1, $2, $3, $4, 'active', true)`,
        [sysId, 'sys2@test.com', hash, 'System'],
      );
      const res = await app.inject({
        method: 'PUT',
        url: `/super-admin/admins/${sysId}/password`,
        headers: { authorization: `Bearer ${token}` },
        payload: { admin_password: ADMIN_PASSWORD, new_password: 'BrandNewPass123' },
      });
      expect(res.statusCode).toBe(403);
    });
  });
});
