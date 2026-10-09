/*
 * PORT NOTE (magick-agency): ported from master test/integration/api/tenant.routes.test.ts@a1f0756a
 * (23 cases → 17). Deleted with `GET /tenants` and `PUT /tenants/:id`: 'GET / —
 * lists user tenants' (2) and 'PUT /:id — update tenant' (4). Real Postgres
 * through `initDbPool` (master mocked `src/db/connection.js`). The
 * metadata-cache write-fence stubs and the core account-settings sync stub are
 * removed with the modules.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { closePool, initDbPool } from '@magick-agency/db';
import { TEST_DB_URL } from '../../../../../packages/db/test/helpers/test-db.js';
import { getTestPool, closeTestPool, truncateAll } from '../../../../../packages/db/test/integration/setup/test-utils.js';
import {
  insertTenant,
  insertUser,
  insertMembership,
  insertAccount,
  insertMembershipInvite,
} from '../../../../../packages/db/test/integration/setup/platform-factories.js';

// ── Mocks ──────────────────────────────────────────────────────────────────────


// Bypass session auth — attach user from header
vi.mock('../../../src/auth/session.middleware.js', () => ({
  sessionMiddleware: async (request: any) => {
    request.user = { id: request.headers['x-user-id'] };
  },
}));

// Bypass tenant context — attach tenantId/accountId from headers
vi.mock('../../../src/api/middleware/tenant-context.middleware.js', () => ({
  tenantContextMiddleware: async (request: any) => {
    request.tenantId = request.headers['x-tenant-id'];
    request.accountId = request.headers['x-account-id'];
    // The caller's own membership, as the real middleware resolves it. Only
    // the account-scope case sets it; absent, the route treats the caller as
    // tenant-wide (RBAC is bypassed below).
    if (request.headers['x-membership-account-id']) {
      request.membership = {
        role: 'viewer',
        account_id: request.headers['x-membership-account-id'],
      };
    }
  },
}));

// Bypass RBAC
vi.mock('../../../src/rbac/rbac.middleware.js', () => ({
  requirePermission: () => async () => {},
}));

// Stub logger
// PORT NOTE (magick-agency): partial — `packages/db`'s pool imports `logger`.
vi.mock('@magick-agency/observability', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@magick-agency/observability')>()),
  createChildLogger: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
}));

// Stub Redis cache
vi.mock('../../../src/cache/redis-cache.js', () => ({
  redisCache: {
    get: vi.fn(), set: vi.fn(), del: vi.fn(), delByPattern: vi.fn(),
  },
}));

// ── Dynamic import after mocks ─────────────────────────────────────────────────

const { tenantRoutes } = await import('../../../src/api/routes/tenant.routes.js');

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('tenant routes (integration)', () => {
  let app: ReturnType<typeof Fastify>;

  beforeEach(async () => {
    await truncateAll();

    app = Fastify();
    await app.register(tenantRoutes, { prefix: '/tenants' });
    await app.ready();
  });

  beforeAll(() => {
    initDbPool({ url: TEST_DB_URL, poolMin: 0, poolMax: 4 });
  });

  afterAll(async () => {
    await closePool();
    await closeTestPool();
  });

  // ── GET / ────────────────────────────────────────────────────────────────────

  describe('GET /:id/members — list tenant members', () => {
    it('returns members enriched with user info', async () => {
      const tenant = await insertTenant();
      const user1 = await insertUser({ display_name: 'Alice', email: 'alice@example.com' });
      const user2 = await insertUser({ display_name: 'Bob', email: 'bob@example.com' });

      await insertMembership({ user_id: user1.id, tenant_id: tenant.id, role: 'tenant_owner' });
      await insertMembership({ user_id: user2.id, tenant_id: tenant.id, role: 'operator' });

      const res = await app.inject({
        method: 'GET',
        url: `/tenants/${tenant.id}/members`,
        headers: { 'x-tenant-id': tenant.id },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.members).toHaveLength(2);

      // Each member should have enriched user info
      for (const member of body.members) {
        expect(member.user).toBeDefined();
        expect(member.user).toHaveProperty('id');
        expect(member.user).toHaveProperty('email');
        expect(member.user).toHaveProperty('display_name');
      }

      const displayNames = body.members.map((m: any) => m.user.display_name);
      expect(displayNames).toContain('Alice');
      expect(displayNames).toContain('Bob');
    });

    /**
     * ClickUp 14ygtkj8rvu, end to end over real SQL: an account-scoped viewer
     * of A sees only A's members — no sibling-account email and no tenant-wide
     * member — even when `X-Account-Id` names the sibling.
     */
    it('confines an account-scoped viewer to their own account', async () => {
      const tenant = await insertTenant();
      const accountA = await insertAccount({ tenant_id: tenant.id });
      const accountB = await insertAccount({ tenant_id: tenant.id });
      const owner = await insertUser({ email: 'owner@example.com' });
      const inA = await insertUser({ email: 'in-a@example.com' });
      const inB = await insertUser({ email: 'in-b@example.com' });
      await insertMembership({ user_id: owner.id, tenant_id: tenant.id, role: 'tenant_owner' });
      await insertMembership({ user_id: inA.id, tenant_id: tenant.id, account_id: accountA.id, role: 'viewer' });
      await insertMembership({ user_id: inB.id, tenant_id: tenant.id, account_id: accountB.id, role: 'operator' });

      const res = await app.inject({
        method: 'GET',
        url: `/tenants/${tenant.id}/members`,
        headers: {
          'x-tenant-id': tenant.id,
          'x-account-id': accountB.id,
          'x-membership-account-id': accountA.id,
        },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().members.map((m: any) => m.user.email)).toEqual(['in-a@example.com']);
      expect(res.body).not.toContain('in-b@example.com');
      expect(res.body).not.toContain('owner@example.com');
      expect(res.body).not.toContain(accountB.id);
    });

    it('returns empty array for tenant with no members', async () => {
      const tenant = await insertTenant();

      const res = await app.inject({
        method: 'GET',
        url: `/tenants/${tenant.id}/members`,
        headers: { 'x-tenant-id': tenant.id },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.members).toHaveLength(0);
    });

    /**
     * `invite_state` — has this member completed Firebase sign-in?
     *
     * The derivation itself is unit-tested (`deriveMembershipInviteState`);
     * what only a real database can prove is the half that feeds it — that
     * `findByTenantIdWithUser`'s `LEFT JOIN` delivers `users.firebase_uid` for
     * every member and keeps one row per membership, that the answer is the
     * same for `agent` as for every other role whatever sits in
     * `membership_invites`, and that neither the uid nor the `u_*` aliases the
     * query selects reach the wire. A mocked pool cannot answer any of those;
     * it supplies the keys.
     *
     * ── Why the `membership_invites` rows below ───────────────────────────
     * They are not read by anything any more, and that is exactly the point.
     * The rejected design derived `agent`'s state from
     * `membership_invites.claimed_at`; these cases assert that a real, signed-in
     * agent reads `active` whether an invite row exists, is unclaimed, is
     * absent, or is present several times over. Reintroducing that arm — or a
     * join onto the table — reds them.
     */
    describe('invite_state', () => {
      it('is pending for an agent whose invitation is still outstanding', async () => {
        const tenant = await insertTenant();
        const user = await insertUser({ firebase_uid: `pending_${randomUUID()}` });
        const membership = await insertMembership({
          user_id: user.id,
          tenant_id: tenant.id,
          role: 'agent',
        });
        await insertMembershipInvite({
          membership_id: membership.id,
          tenant_id: tenant.id,
          email: user.email,
        });

        const res = await app.inject({
          method: 'GET',
          url: `/tenants/${tenant.id}/members`,
          headers: { 'x-tenant-id': tenant.id },
        });

        expect(res.statusCode).toBe(200);
        expect(res.json().members[0].invite_state).toBe('pending');
      });

      it('is pending for an agent with no invite row at all', async () => {
        const tenant = await insertTenant();
        const user = await insertUser({ firebase_uid: `pending_${randomUUID()}` });
        await insertMembership({ user_id: user.id, tenant_id: tenant.id, role: 'agent' });

        const res = await app.inject({
          method: 'GET',
          url: `/tenants/${tenant.id}/members`,
          headers: { 'x-tenant-id': tenant.id },
        });

        expect(res.json().members[0].invite_state).toBe('pending');
      });

      /**
       * ── The regression the two-arm design shipped, cases 1–3 ──────────────
       *
       * An `agent` membership with a real Firebase uid and NO `membership_invites`
       * row is not a hypothetical: it is every agent predating migration 069
       * (the role dates from 051 and 069 ships no backfill), every membership
       * `PUT /users/:id/role` re-roles to `agent`, and every one super-admin
       * creates directly. None of those paths writes an invite, so the claim
       * arm labelled all three populations `pending` forever. They are `active`.
       */
      it('is active for an agent with a real uid and no invite row — the pre-069, re-role and super-admin cases', async () => {
        const tenant = await insertTenant();
        const user = await insertUser({ firebase_uid: `fb-real-${randomUUID()}` });
        await insertMembership({ user_id: user.id, tenant_id: tenant.id, role: 'agent' });

        const res = await app.inject({
          method: 'GET',
          url: `/tenants/${tenant.id}/members`,
          headers: { 'x-tenant-id': tenant.id },
        });

        expect(res.json().members[0].invite_state).toBe('active');
      });

      /**
       * ── The regression the two-arm design shipped, case 4 ─────────────────
       *
       * Nothing requires an invitee to use the emailed link. If they ignore it
       * and sign in normally, `POST /auth/session` adopts the stub by verified
       * email (path 2) or matches their existing uid (path 1) — and touches
       * `membership_invites` on neither path. The invite row sits unclaimed
       * forever behind somebody who is on the floor taking calls, so the claim
       * arm reported them `pending` for the rest of the membership's life.
       */
      it('is active for an agent who signed in without ever claiming their outstanding invite', async () => {
        const tenant = await insertTenant();
        const user = await insertUser({ firebase_uid: `fb-real-${randomUUID()}` });
        const membership = await insertMembership({
          user_id: user.id,
          tenant_id: tenant.id,
          role: 'agent',
        });
        // Outstanding: unclaimed, unrevoked, still in date. Never consulted.
        await insertMembershipInvite({
          membership_id: membership.id,
          tenant_id: tenant.id,
          email: user.email,
        });

        const res = await app.inject({
          method: 'GET',
          url: `/tenants/${tenant.id}/members`,
          headers: { 'x-tenant-id': tenant.id },
        });

        expect(res.json().members[0].invite_state).toBe('active');
      });

      it('is active for an agent who claimed their invitation', async () => {
        const tenant = await insertTenant();
        const user = await insertUser({ firebase_uid: `fb-real-${randomUUID()}` });
        const membership = await insertMembership({
          user_id: user.id,
          tenant_id: tenant.id,
          role: 'agent',
        });
        await insertMembershipInvite({
          membership_id: membership.id,
          tenant_id: tenant.id,
          email: user.email,
          claimed_at: new Date(),
          claimed_by_user_id: user.id,
        });

        const res = await app.inject({
          method: 'GET',
          url: `/tenants/${tenant.id}/members`,
          headers: { 'x-tenant-id': tenant.id },
        });

        expect(res.json().members[0].invite_state).toBe('active');
      });

      it('is pending for a non-agent still on a pending_ stub uid', async () => {
        const tenant = await insertTenant();
        const user = await insertUser({ firebase_uid: `pending_${randomUUID()}` });
        await insertMembership({ user_id: user.id, tenant_id: tenant.id, role: 'operator' });

        const res = await app.inject({
          method: 'GET',
          url: `/tenants/${tenant.id}/members`,
          headers: { 'x-tenant-id': tenant.id },
        });

        expect(res.json().members[0].invite_state).toBe('pending');
      });

      it('is active for a non-agent with a real Firebase uid', async () => {
        const tenant = await insertTenant();
        const user = await insertUser({ firebase_uid: `fb-real-${randomUUID()}` });
        await insertMembership({ user_id: user.id, tenant_id: tenant.id, role: 'account_admin' });

        const res = await app.inject({
          method: 'GET',
          url: `/tenants/${tenant.id}/members`,
          headers: { 'x-tenant-id': tenant.id },
        });

        expect(res.json().members[0].invite_state).toBe('active');
      });

      /**
       * Role-invariance, asserted where a role actually exists: one tenant, two
       * members in the same identity state, one `agent` and one `viewer`. The
       * agent additionally holds an unclaimed invite — under the rejected
       * design that alone split the answers. Here they must match.
       */
      it('answers the same for an agent as for any other role in the same identity state', async () => {
        const tenant = await insertTenant();

        const agentUser = await insertUser({ firebase_uid: `fb-real-${randomUUID()}` });
        const agentMembership = await insertMembership({
          user_id: agentUser.id,
          tenant_id: tenant.id,
          role: 'agent',
        });
        await insertMembershipInvite({
          membership_id: agentMembership.id,
          tenant_id: tenant.id,
          email: agentUser.email,
        });

        const viewerUser = await insertUser({ firebase_uid: `fb-real-${randomUUID()}` });
        await insertMembership({ user_id: viewerUser.id, tenant_id: tenant.id, role: 'viewer' });

        const stubAgent = await insertUser({ firebase_uid: `pending_${randomUUID()}` });
        await insertMembership({ user_id: stubAgent.id, tenant_id: tenant.id, role: 'agent' });

        const stubViewer = await insertUser({ firebase_uid: `pending_${randomUUID()}` });
        await insertMembership({ user_id: stubViewer.id, tenant_id: tenant.id, role: 'viewer' });

        const res = await app.inject({
          method: 'GET',
          url: `/tenants/${tenant.id}/members`,
          headers: { 'x-tenant-id': tenant.id },
        });

        const byUser = Object.fromEntries(
          res.json().members.map((m: any) => [m.user.id, m.invite_state]),
        );
        expect(byUser[agentUser.id]).toBe('active');
        expect(byUser[viewerUser.id]).toBe('active');
        expect(byUser[stubAgent.id]).toBe('pending');
        expect(byUser[stubViewer.id]).toBe('pending');
      });

      /**
       * `firebase_uid` is read by the derivation and must not leave the
       * service — the stub form is `pending_<uuid>` and the ticket forbids
       * leaking either it or a real uid. Asserted over the SERIALIZED body, not
       * over the parsed object's top-level keys: the point is that the bytes do
       * not contain it, wherever somebody might later nest it.
       *
       * The `u_*` aliases are checked for the same reason. They are how the
       * query keeps `m.*` a wildcard, and a handler that ever spread the raw
       * repository row instead of naming fields would put `u_firebase_uid` on
       * the wire under a name no `firebase_uid` assertion would catch.
       */
      it('never puts firebase_uid, the u_* aliases or raw invite columns on the wire', async () => {
        const tenant = await insertTenant();
        const stubUid = `pending_${randomUUID()}`;
        const user = await insertUser({ firebase_uid: stubUid });
        const membership = await insertMembership({
          user_id: user.id,
          tenant_id: tenant.id,
          role: 'agent',
        });
        await insertMembershipInvite({
          membership_id: membership.id,
          tenant_id: tenant.id,
          email: user.email,
        });

        const res = await app.inject({
          method: 'GET',
          url: `/tenants/${tenant.id}/members`,
          headers: { 'x-tenant-id': tenant.id },
        });

        expect(res.body).not.toContain(stubUid);
        expect(res.body).not.toContain('firebase_uid');
        expect(res.body).not.toContain('claimed_at');
        expect(res.body).not.toContain('token_hash');
        expect(res.body).not.toContain('u_id');
        expect(res.body).not.toContain('u_email');
        expect(res.body).not.toContain('u_display_name');
        expect(res.body).not.toContain('u_avatar_url');
        expect(res.body).not.toContain('u_firebase_uid');

        const member = res.json().members[0];
        expect(Object.keys(member.user).sort()).toEqual([
          'avatar_url',
          'display_name',
          'email',
          'id',
        ]);
      });

      /**
       * The `user: null` arm is UNREACHABLE from the database, and that is
       * worth pinning rather than asserting the opposite.
       *
       * `memberships.user_id` is `NOT NULL REFERENCES users(id) ON DELETE
       * CASCADE` (migration 001), so hard-deleting the user takes the
       * membership with it — the member does not appear with a null `user`,
       * they stop appearing at all. The old per-member
       * `userRepository.findById` could never have returned `null` either.
       *
       * The route keeps the arm anyway (and reads through a LEFT JOIN rather
       * than an inner one) so that relaxing this FK would surface a member with
       * no identity instead of silently dropping them off their own tenant's
       * Team page. The `pending` answer for that shape is unit-tested on
       * `deriveMembershipInviteState` and on the route with a mocked repository,
       * which are the only places it can be reached; this case exists so the
       * next reader does not spend the time this one did discovering why the
       * fixture would not build.
       */
      it('cascades the membership away with the user rather than yielding a null user', async () => {
        const tenant = await insertTenant();
        const user = await insertUser();
        await insertMembership({ user_id: user.id, tenant_id: tenant.id, role: 'agent' });

        await getTestPool().query('DELETE FROM users WHERE id = $1', [user.id]);

        const res = await app.inject({
          method: 'GET',
          url: `/tenants/${tenant.id}/members`,
          headers: { 'x-tenant-id': tenant.id },
        });

        expect(res.statusCode).toBe(200);
        expect(res.json().members).toHaveLength(0);
      });

      /**
       * One row per membership, however many invites it has accumulated. The
       * query does not touch `membership_invites` at all, and this is what
       * would red if somebody joined it back on: a plain JOIN would fan a
       * resent member out once per invitation.
       */
      it('returns one row per member regardless of how many invites exist', async () => {
        const tenant = await insertTenant();
        const user = await insertUser({ firebase_uid: `fb-real-${randomUUID()}` });
        const membership = await insertMembership({
          user_id: user.id,
          tenant_id: tenant.id,
          role: 'agent',
        });

        for (let i = 0; i < 3; i += 1) {
          await insertMembershipInvite({
            membership_id: membership.id,
            tenant_id: tenant.id,
            email: user.email,
            revoked_at: new Date(),
          });
        }
        await insertMembershipInvite({
          membership_id: membership.id,
          tenant_id: tenant.id,
          email: user.email,
          claimed_at: new Date(),
          claimed_by_user_id: user.id,
        });

        const res = await app.inject({
          method: 'GET',
          url: `/tenants/${tenant.id}/members`,
          headers: { 'x-tenant-id': tenant.id },
        });

        const body = res.json();
        expect(body.members).toHaveLength(1);
        expect(body.members[0].invite_state).toBe('active');
      });

      it('preserves the created_at DESC ordering the route has always had', async () => {
        const tenant = await insertTenant();
        const oldest = await insertUser({ display_name: 'Oldest' });
        const newest = await insertUser({ display_name: 'Newest' });

        await insertMembership({
          user_id: oldest.id,
          tenant_id: tenant.id,
          role: 'operator',
          created_at: new Date(Date.now() - 60 * 60 * 1000),
        });
        await insertMembership({
          user_id: newest.id,
          tenant_id: tenant.id,
          role: 'operator',
          created_at: new Date(),
        });

        const res = await app.inject({
          method: 'GET',
          url: `/tenants/${tenant.id}/members`,
          headers: { 'x-tenant-id': tenant.id },
        });

        expect(res.json().members.map((m: any) => m.user.display_name)).toEqual([
          'Newest',
          'Oldest',
        ]);
      });

      it('excludes revoked memberships, as the status filter always has', async () => {
        const tenant = await insertTenant();
        const active = await insertUser({ display_name: 'Active' });
        const departed = await insertUser({ display_name: 'Departed' });

        await insertMembership({ user_id: active.id, tenant_id: tenant.id, role: 'agent' });
        await insertMembership({
          user_id: departed.id,
          tenant_id: tenant.id,
          role: 'agent',
          status: 'revoked',
        });

        const res = await app.inject({
          method: 'GET',
          url: `/tenants/${tenant.id}/members`,
          headers: { 'x-tenant-id': tenant.id },
        });

        const body = res.json();
        expect(body.members).toHaveLength(1);
        expect(body.members[0].user.display_name).toBe('Active');
      });
    });

    it('cannot list another tenant\'s members when the path id disagrees with X-Tenant-Id', async () => {
      const ours = await insertTenant({ slug: 'ours-members' });
      const theirs = await insertTenant({ slug: 'theirs-members' });
      const foreignUser = await insertUser({ email: 'secret@example.com', display_name: 'Secret' });
      await insertMembership({ user_id: foreignUser.id, tenant_id: theirs.id, role: 'tenant_owner' });

      const res = await app.inject({
        method: 'GET',
        url: `/tenants/${theirs.id}/members`,
        headers: { 'x-tenant-id': ours.id },
      });

      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: 'Not Found', message: 'Tenant not found' });
      expect(res.json()).not.toHaveProperty('members');
    });
  });
});
