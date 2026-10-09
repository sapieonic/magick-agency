import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';

/**
 * Route-level tests for the tenant path-vs-header IDOR:
 * `requirePermission` proves the caller's ROLE in the tenant named by
 * `X-Tenant-Id` and never looks at `:id`, so `PUT /tenants/<B>` (and
 * `GET /tenants/<B>/members`) with `X-Tenant-Id: A` used to write/read B.
 */

const mocks = vi.hoisted(() => ({
  findByTenantIdWithUser: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../../../src/auth/session.middleware.js', () => ({
  sessionMiddleware: async () => {},
}));
vi.mock('../../../../src/api/middleware/tenant-context.middleware.js', () => ({
  tenantContextMiddleware: async () => {},
}));
vi.mock('../../../../src/rbac/rbac.middleware.js', () => ({
  requirePermission: () => async () => {},
}));
vi.mock('@magick-agency/db/repositories/membership.repository', () => ({
  membershipRepository: {
    findByTenantIdWithUser: mocks.findByTenantIdWithUser,
  },
}));

import Fastify from 'fastify';
import { tenantRoutes } from '../../../../src/api/routes/tenant.routes.js';

const OURS = 'tenant-a';
const THEIRS = 'tenant-b';

async function buildApp(
  tenantId = OURS,
  membership: Record<string, unknown> | undefined = { role: 'tenant_admin', account_id: null },
  headerAccountId?: string,
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.addHook('onRequest', async (request: any) => {
    request.user = { id: 'user-1' };
    request.tenantId = tenantId;
    request.membership = membership;
    if (headerAccountId !== undefined) request.accountId = headerAccountId;
  });
  await app.register(tenantRoutes, { prefix: '/tenants' });
  await app.ready();
  return app;
}

describe('tenant.routes — path id must match the proven tenant', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.findByTenantIdWithUser.mockResolvedValue([]);
  });

  describe('GET /tenants/:id/members', () => {
    it('lists members of the proven tenant when the path matches', async () => {
      mocks.findByTenantIdWithUser.mockResolvedValue([]);

      const app = await buildApp();
      const res = await app.inject({ method: 'GET', url: `/tenants/${OURS}/members` });

      expect(res.statusCode).toBe(200);
      expect(mocks.findByTenantIdWithUser).toHaveBeenCalledWith(OURS, undefined);
      await app.close();
    });

    /**
     * The response item's exact shape: the membership row spread as is, the
     * four user fields named one by one, and `invite_state`.
     *
     * `firebase_uid` is the reason the user object is built rather than spread —
     * the derivation reads it and the browser may never see it, stub or real.
     * Asserted here as an exhaustive key list rather than a `not.toHaveProperty`,
     * so a field ADDED to `TenantMemberUser` for some future derivation cannot
     * slip onto the wire unnoticed — and over the SERIALIZED body as well, so
     * the `u_*` aliases the repository selects cannot reach it either by some
     * future handler spreading the raw row.
     */
    it('serves the membership row, four user fields and invite_state — and no uid', async () => {
      mocks.findByTenantIdWithUser.mockResolvedValue([
        {
          membership: {
            id: 'm-1',
            user_id: 'u-1',
            tenant_id: OURS,
            account_id: null,
            role: 'agent',
            status: 'active',
            invited_by: 'inviter-1',
            created_at: '2026-01-01T00:00:00.000Z',
            updated_at: '2026-01-01T00:00:00.000Z',
          },
          user: {
            id: 'u-1',
            email: 'agent@example.com',
            display_name: 'Agent',
            avatar_url: null,
            firebase_uid: 'pending_0f1e2d3c-4b5a-4968-8778-695a4b3c2d1e',
          },
        },
      ]);

      const app = await buildApp();
      const res = await app.inject({ method: 'GET', url: `/tenants/${OURS}/members` });

      expect(res.statusCode).toBe(200);
      expect(res.body).not.toContain('firebase_uid');
      expect(res.body).not.toContain('pending_0f1e2d3c');
      expect(res.body).not.toContain('u_id');
      expect(res.body).not.toContain('u_email');
      expect(res.body).not.toContain('u_firebase_uid');

      const [member] = res.json().members;
      expect(member).toMatchObject({ id: 'm-1', role: 'agent', invite_state: 'pending' });
      expect(Object.keys(member.user).sort()).toEqual([
        'avatar_url',
        'display_name',
        'email',
        'id',
      ]);
      await app.close();
    });

    /**
     * The case the two-arm derivation got wrong, at the route level: an `agent`
     * with a real Firebase uid is `active`, and no invite record is consulted
     * to decide it — the repository no longer returns one.
     */
    it('reports an agent with a real uid as active', async () => {
      mocks.findByTenantIdWithUser.mockResolvedValue([
        {
          membership: { id: 'm-1', user_id: 'u-1', tenant_id: OURS, role: 'agent' },
          user: {
            id: 'u-1',
            email: 'agent@example.com',
            display_name: 'Agent',
            avatar_url: null,
            firebase_uid: 'fb-real',
          },
        },
      ]);

      const app = await buildApp();
      const res = await app.inject({ method: 'GET', url: `/tenants/${OURS}/members` });

      expect(res.json().members[0].invite_state).toBe('active');
      await app.close();
    });

    /**
     * The `user: null` arm the route has always carried. Unreachable from the
     * database (`memberships.user_id` is `NOT NULL … ON DELETE CASCADE`), so
     * this mock is the only place the serialized shape can be pinned.
     */
    it('serves a member with no user row as pending, with user: null', async () => {
      mocks.findByTenantIdWithUser.mockResolvedValue([
        {
          membership: { id: 'm-1', user_id: 'u-1', tenant_id: OURS, role: 'operator' },
          user: null,
        },
      ]);

      const app = await buildApp();
      const res = await app.inject({ method: 'GET', url: `/tenants/${OURS}/members` });

      expect(res.json().members[0]).toMatchObject({ user: null, invite_state: 'pending' });
      await app.close();
    });

    /**
     * The account-scope axis (ClickUp 14ygtkj8rvu). `requirePermission` proves
     * the caller's ROLE and never looks at which account their membership is
     * scoped to, so an account-scoped `viewer` of A used to receive the whole
     * tenant roster — sibling account B's emails, roles and `account_id`s.
     */
    describe('account scope', () => {
      const ACCOUNT_A = 'account-a';
      const ACCOUNT_B = 'account-b';

      it('confines an account-scoped viewer to their own account', async () => {
        mocks.findByTenantIdWithUser.mockResolvedValue([]);

        const app = await buildApp(OURS, { role: 'viewer', account_id: ACCOUNT_A });
        const res = await app.inject({ method: 'GET', url: `/tenants/${OURS}/members` });

        expect(res.statusCode).toBe(200);
        expect(mocks.findByTenantIdWithUser).toHaveBeenCalledWith(OURS, ACCOUNT_A);
        await app.close();
      });

      /**
       * The scope comes from the MEMBERSHIP, never `X-Account-Id`: the header
       * is unauthenticated and optional, so an account-scoped caller who omits
       * it — or names a sibling — must still be confined to their own account.
       */
      it('ignores X-Account-Id in favour of the caller\'s membership', async () => {
        mocks.findByTenantIdWithUser.mockResolvedValue([]);

        const app = await buildApp(OURS, { role: 'viewer', account_id: ACCOUNT_A }, ACCOUNT_B);
        await app.inject({ method: 'GET', url: `/tenants/${OURS}/members` });

        expect(mocks.findByTenantIdWithUser).toHaveBeenCalledWith(OURS, ACCOUNT_A);
        await app.close();
      });

      it('leaves a tenant-wide tenant_owner unrestricted even when naming an account', async () => {
        mocks.findByTenantIdWithUser.mockResolvedValue([]);

        const app = await buildApp(OURS, { role: 'tenant_owner', account_id: null }, ACCOUNT_B);
        await app.inject({ method: 'GET', url: `/tenants/${OURS}/members` });

        expect(mocks.findByTenantIdWithUser).toHaveBeenCalledWith(OURS, undefined);
        await app.close();
      });

      it('404s an account-scoped caller naming another tenant without reading', async () => {
        const app = await buildApp(OURS, { role: 'viewer', account_id: ACCOUNT_A });
        const res = await app.inject({ method: 'GET', url: `/tenants/${THEIRS}/members` });

        expect(res.statusCode).toBe(404);
        expect(res.json()).toEqual({ error: 'Not Found', message: 'Tenant not found' });
        expect(mocks.findByTenantIdWithUser).not.toHaveBeenCalled();
        await app.close();
      });
    });

    it('404s without reading when the path names another tenant', async () => {
      const app = await buildApp(OURS);
      const res = await app.inject({ method: 'GET', url: `/tenants/${THEIRS}/members` });

      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: 'Not Found', message: 'Tenant not found' });
      expect(mocks.findByTenantIdWithUser).not.toHaveBeenCalled();
      await app.close();
    });
  });
});
