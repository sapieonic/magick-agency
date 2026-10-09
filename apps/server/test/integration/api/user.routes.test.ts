import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { vi } from 'vitest';
import Fastify from 'fastify';
import { randomUUID } from 'node:crypto';
import { getTestPool, closeTestPool, truncateAll } from '../../../../../packages/db/test/integration/setup/test-utils.js';
import { TEST_DB_URL } from '../../../../../packages/db/test/helpers/test-db.js';
import { initDbPool, closePool } from '@magick-agency/db';
import {
  insertTenant,
  insertUser,
  insertMembership,
  insertMembershipInvite,
  insertAccount,
} from '../../../../../packages/db/test/integration/setup/platform-factories.js';

// ── Mocks ──────────────────────────────────────────────────────────────────

// The repositories (server-local and `@magick-agency/db`)
// share the package's pool singleton, so the suite initialises it against the
// agency test database instead (worker-common: `initDbPool`, not a mock).
initDbPool({ url: TEST_DB_URL, poolMin: 0, poolMax: 4 });

vi.mock('../../../src/auth/session.middleware.js', () => ({
  sessionMiddleware: async (request: any) => {
    request.user = { id: request.headers['x-user-id'] };
  },
}));

vi.mock('../../../src/api/middleware/tenant-context.middleware.js', () => ({
  tenantContextMiddleware: async (request: any) => {
    request.tenantId = request.headers['x-tenant-id'];
    request.accountId = request.headers['x-account-id'];
    request.membership = { role: request.headers['x-user-role'] || 'tenant_owner' };
  },
}));

vi.mock('../../../src/rbac/rbac.middleware.js', () => ({
  requirePermission: () => async () => {},
}));

vi.mock('../../../src/cache/redis-cache.js', () => ({
  redisCache: {
    get: vi.fn(), set: vi.fn(), del: vi.fn(), delByPattern: vi.fn(),
    // decision Q5: revocation deletes forward to `del` and report success.
    async delForRevocation(this: { del: (...k: string[]) => unknown }, ...k: string[]) { await this.del(...k); return true; },
  },
}));

// `@magick-agency/observability` is the whole package (the db pool
// imports its `logger`), so the real module is spread and only
// `createChildLogger` is replaced.
vi.mock('@magick-agency/observability', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@magick-agency/observability')>()),
  createChildLogger: () => ({
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  }),
}));

// ── Dynamic import after mocks ─────────────────────────────────────────────

const { userRoutes } = await import('../../../src/api/routes/user.routes.js');

// ── Test suite ─────────────────────────────────────────────────────────────

describe('user routes (integration)', () => {
  let app: ReturnType<typeof Fastify>;
  let tenant: any;
  let account: any;
  let ownerUser: any;

  beforeEach(async () => {
    await truncateAll();

    tenant = await insertTenant();
    account = await insertAccount({ tenant_id: tenant.id });
    ownerUser = await insertUser();
    await insertMembership({
      user_id: ownerUser.id,
      tenant_id: tenant.id,
      account_id: null,
      role: 'tenant_owner',
    });

    app = Fastify();
    await app.register(userRoutes, { prefix: '/users' });
    await app.ready();
  });

  afterAll(async () => {
    await closePool();
    await closeTestPool();
  });

  // ── POST /users/invite ─────────────────────────────────────────────────

  describe('POST /invite', () => {
    it('creates new user and membership for unknown email', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/users/invite',
        headers: {
          'x-user-id': ownerUser.id,
          'x-tenant-id': tenant.id,
          'x-user-role': 'tenant_owner',
        },
        payload: { email: 'newuser@example.com', role: 'operator' },
      });

      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.membership).toBeDefined();
      expect(body.membership.role).toBe('operator');
      expect(body.user.email).toBe('newuser@example.com');
    });

    it('creates membership for existing user without membership in this tenant', async () => {
      const existingUser = await insertUser({ email: 'existing@example.com' });

      const res = await app.inject({
        method: 'POST',
        url: '/users/invite',
        headers: {
          'x-user-id': ownerUser.id,
          'x-tenant-id': tenant.id,
          'x-user-role': 'tenant_owner',
        },
        payload: { email: existingUser.email, role: 'viewer' },
      });

      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.membership.user_id).toBe(existingUser.id);
      expect(body.membership.role).toBe('viewer');
    });

    it('does NOT reuse a row flagged email_unverified', async () => {
      /**
       * The invite half of migration 073's payoff: an attacker self-invites an
       * address, claims it with an unverified Firebase account, and the row then
       * keys under an address they do not control. This route must not hand them
       * a membership in somebody else's workspace.
       *
       * ── What this used to assert, and why it changed ─────────────────────
       * The first version of this fix wrote a FRESH STUB beside the flagged row
       * and expected 201. That is right when the flagged row belongs to somebody
       * else — two principals sharing a string — but it is a trap when it is the
       * same person: a flagged row is always bound, `firebase_uid` is UNIQUE, so
       * their claim on the new invitation raises `23505` and the membership is
       * stranded on a row nothing can activate. Since the two cases are
       * indistinguishable from here, the route refuses and names the remedy.
       * Covered end to end by the case below; this one pins the invariant that
       * matters either way — the flagged row gets NOTHING.
       */
      const pool = getTestPool();
      const poisoned = await insertUser({
        firebase_uid: 'fb-attacker-invite',
        email: 'poisoned@example.com',
      });
      await pool.query('UPDATE users SET email_unverified = true WHERE id = $1', [poisoned.id]);

      const res = await app.inject({
        method: 'POST',
        url: '/users/invite',
        headers: {
          'x-user-id': ownerUser.id,
          'x-tenant-id': tenant.id,
          'x-user-role': 'tenant_owner',
        },
        payload: { email: 'poisoned@example.com', role: 'viewer' },
      });

      expect(res.statusCode).toBe(409);
      const { rows } = await pool.query(
        'SELECT id FROM memberships WHERE user_id = $1',
        [poisoned.id],
      );
      expect(rows).toHaveLength(0);
    });

    it('REFUSES when every row for the address is flagged, instead of stranding a membership', async () => {
      /**
       * Before this, a flagged address produced a fresh stub and a membership
       * on it — and that membership can never be claimed. A flagged row is
       * always bound, `firebase_uid` is UNIQUE, so the one person who would
       * claim the new invitation collides with their own row and is told
       * `identity_in_use`, with nothing reporting the orphan.
       *
       * Refusing names a remedy the recipient can actually perform.
       */
      const pool = getTestPool();
      const bound = await insertUser({
        firebase_uid: 'fb-flagged-invitee',
        email: 'flagged@example.com',
      });
      await pool.query('UPDATE users SET email_unverified = true WHERE id = $1', [bound.id]);

      const res = await app.inject({
        method: 'POST',
        url: '/users/invite',
        headers: {
          'x-user-id': ownerUser.id,
          'x-tenant-id': tenant.id,
          'x-user-role': 'tenant_owner',
        },
        payload: { email: 'flagged@example.com', role: 'viewer' },
      });

      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe('unverified_address_holder');

      // And nothing was written — no second stub, no membership.
      const { rows: users } = await pool.query(
        'SELECT id FROM users WHERE email = $1',
        ['flagged@example.com'],
      );
      expect(users).toHaveLength(1);
      const { rows: memberships } = await pool.query(
        'SELECT id FROM memberships WHERE user_id = $1',
        [bound.id],
      );
      expect(memberships).toHaveLength(0);
    });

    it('returns 409 when user already has membership in this tenant', async () => {
      const user = await insertUser({ email: 'duplicate@example.com' });
      await insertMembership({
        user_id: user.id,
        tenant_id: tenant.id,
        account_id: null,
        role: 'operator',
      });

      const res = await app.inject({
        method: 'POST',
        url: '/users/invite',
        headers: {
          'x-user-id': ownerUser.id,
          'x-tenant-id': tenant.id,
          'x-user-role': 'tenant_owner',
        },
        payload: { email: 'duplicate@example.com', role: 'viewer' },
      });

      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe('Conflict');
    });

    it('reactivates a revoked membership with the new role instead of inserting', async () => {
      const user = await insertUser({ email: 'returning@example.com' });
      const leftover = await insertMembership({
        user_id: user.id,
        tenant_id: tenant.id,
        account_id: null,
        role: 'operator',
        status: 'revoked',
      });

      const res = await app.inject({
        method: 'POST',
        url: '/users/invite',
        headers: {
          'x-user-id': ownerUser.id,
          'x-tenant-id': tenant.id,
          'x-user-role': 'tenant_owner',
        },
        payload: { email: 'returning@example.com', role: 'viewer' },
      });

      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.membership.id).toBe(leftover.id);
      expect(body.membership.role).toBe('viewer');
      expect(body.membership.status).toBe('active');
    });

    it('revokes a leftover live invite in the same re-add, including for a non-agent role', async () => {
      const user = await insertUser({ email: 'viewer-back@example.com' });
      const leftover = await insertMembership({
        user_id: user.id,
        tenant_id: tenant.id,
        account_id: null,
        role: 'operator',
        status: 'revoked',
      });
      const live = await insertMembershipInvite({
        membership_id: leftover.id,
        tenant_id: tenant.id,
        email: user.email,
        role: 'agent',
      });
      const spent = await insertMembershipInvite({
        membership_id: leftover.id,
        tenant_id: tenant.id,
        email: user.email,
        role: 'agent',
        claimed_at: new Date(),
      });

      const res = await app.inject({
        method: 'POST',
        url: '/users/invite',
        headers: {
          'x-user-id': ownerUser.id,
          'x-tenant-id': tenant.id,
          'x-user-role': 'tenant_owner',
        },
        payload: { email: 'viewer-back@example.com', role: 'viewer' },
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

    it('returns 400 for missing email (validation error)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/users/invite',
        headers: {
          'x-user-id': ownerUser.id,
          'x-tenant-id': tenant.id,
          'x-user-role': 'tenant_owner',
        },
        payload: { role: 'operator' },
      });

      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.error).toBe('Bad Request');
      expect(Array.isArray(body.details)).toBe(true);
    });

    it('returns 403 when inviter role is equal to target role (canManageRole)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/users/invite',
        headers: {
          'x-user-id': ownerUser.id,
          'x-tenant-id': tenant.id,
          'x-user-role': 'operator',
        },
        payload: { email: 'peer@example.com', role: 'operator' },
      });

      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe('Forbidden');
    });
  });

  // ── PUT /users/:id/role ────────────────────────────────────────────────

  describe('PUT /:id/role', () => {
    it('updates membership role', async () => {
      const targetUser = await insertUser();
      await insertMembership({
        user_id: targetUser.id,
        tenant_id: tenant.id,
        account_id: null,
        role: 'viewer',
      });

      const res = await app.inject({
        method: 'PUT',
        url: `/users/${targetUser.id}/role`,
        headers: {
          'x-user-id': ownerUser.id,
          'x-tenant-id': tenant.id,
          'x-user-role': 'tenant_owner',
        },
        payload: { role: 'operator' },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().membership.role).toBe('operator');
    });

    it('returns 404 for non-existent user membership', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: `/users/${randomUUID()}/role`,
        headers: {
          'x-user-id': ownerUser.id,
          'x-tenant-id': tenant.id,
          'x-user-role': 'tenant_owner',
        },
        payload: { role: 'operator' },
      });

      expect(res.statusCode).toBe(404);
      expect(res.json().error).toBe('Not Found');
    });
  });

  // ── DELETE /users/:id/membership ───────────────────────────────────────

  describe('DELETE /:id/membership', () => {
    it('removes user membership', async () => {
      const targetUser = await insertUser();
      await insertMembership({
        user_id: targetUser.id,
        tenant_id: tenant.id,
        account_id: null,
        role: 'operator',
      });

      const res = await app.inject({
        method: 'DELETE',
        url: `/users/${targetUser.id}/membership`,
        headers: {
          'x-user-id': ownerUser.id,
          'x-tenant-id': tenant.id,
          'x-user-role': 'tenant_owner',
        },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().message).toBe('Membership removed');
    });

    it('returns 400 when trying to remove self', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: `/users/${ownerUser.id}/membership`,
        headers: {
          'x-user-id': ownerUser.id,
          'x-tenant-id': tenant.id,
          'x-user-role': 'tenant_owner',
        },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().message).toBe('Cannot remove yourself');
    });

    it('returns 400 when trying to remove last tenant_owner', async () => {
      // ownerUser is the only tenant_owner — create a second user as the target owner
      const soleOwner = await insertUser();
      await insertMembership({
        user_id: soleOwner.id,
        tenant_id: tenant.id,
        account_id: null,
        role: 'tenant_owner',
      });

      // Now remove the owner created in beforeEach so soleOwner is truly the last one
      const pool = getTestPool();
      await pool.query(
        `DELETE FROM memberships WHERE user_id = $1 AND tenant_id = $2`,
        [ownerUser.id, tenant.id],
      );

      const anotherAdmin = await insertUser();
      await insertMembership({
        user_id: anotherAdmin.id,
        tenant_id: tenant.id,
        account_id: null,
        role: 'tenant_admin',
      });

      const res = await app.inject({
        method: 'DELETE',
        url: `/users/${soleOwner.id}/membership`,
        headers: {
          'x-user-id': anotherAdmin.id,
          'x-tenant-id': tenant.id,
          'x-user-role': 'tenant_owner',
        },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().message).toBe('Cannot remove the last tenant owner');
    });

    it('returns 404 for non-existent membership', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: `/users/${randomUUID()}/membership`,
        headers: {
          'x-user-id': ownerUser.id,
          'x-tenant-id': tenant.id,
          'x-user-role': 'tenant_owner',
        },
      });

      expect(res.statusCode).toBe(404);
      expect(res.json().error).toBe('Not Found');
    });
  });
});
