// Real Postgres: `src/connection.js` is pointed at the test pool. Type-only `!` non-null assertions because tests are typechecked (decision B1).
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { vi } from 'vitest';
import { getTestPool, closeTestPool, truncateAll } from '../setup/test-utils.js';
import { insertTenant, insertUser, insertAccount, insertMembership } from '../setup/platform-factories.js';

vi.mock('../../../src/connection.js', () => ({
  getPool: () => getTestPool(),
}));

const { membershipRepository } = await import('../../../src/repositories/membership.repository.js');

describe('membershipRepository (integration)', () => {
  let tenant: any;
  let user: any;

  beforeEach(async () => {
    await truncateAll();
    tenant = await insertTenant();
    user = await insertUser();
  });

  afterAll(async () => {
    await closeTestPool();
  });

  describe('create', () => {
    it('inserts a membership with correct fields', async () => {
      const result = await membershipRepository.create({
        user_id: user.id,
        tenant_id: tenant.id,
        role: 'tenant_admin',
      });

      expect(result!.id).toBeDefined();
      expect(result!.user_id).toBe(user.id);
      expect(result!.tenant_id).toBe(tenant.id);
      expect(result!.role).toBe('tenant_admin');
      expect(result!.status).toBe('active');
      expect(result!.account_id).toBeNull();
    });

    it('inserts a membership with account_id', async () => {
      const account = await insertAccount({ tenant_id: tenant.id });

      const result = await membershipRepository.create({
        user_id: user.id,
        tenant_id: tenant.id,
        account_id: account.id,
        role: 'operator',
      });

      expect(result!.account_id).toBe(account.id);
      expect(result!.role).toBe('operator');
    });
  });

  describe('findByUserAndTenant', () => {
    it('returns memberships for user in tenant', async () => {
      await insertMembership({ user_id: user.id, tenant_id: tenant.id, role: 'tenant_owner' });

      const results = await membershipRepository.findByUserAndTenant(user.id, tenant.id);

      expect(results).toHaveLength(1);
      expect(results[0]!.user_id).toBe(user.id);
      expect(results[0]!.tenant_id).toBe(tenant.id);
    });

    it('returns empty array when user has no membership in tenant', async () => {
      const results = await membershipRepository.findByUserAndTenant(user.id, tenant.id);
      expect(results).toHaveLength(0);
    });

    it('excludes revoked memberships', async () => {
      const membership = await insertMembership({ user_id: user.id, tenant_id: tenant.id, role: 'viewer' });
      await membershipRepository.remove(membership.id);

      const results = await membershipRepository.findByUserAndTenant(user.id, tenant.id);
      expect(results).toHaveLength(0);
    });

    it('returns rows oldest first, so "the first membership" is deterministic', async () => {
      // tenantContextMiddleware falls back to the oldest account-scoped row when
      // no X-Account-Id is sent. Inserted newest-first so heap order would give
      // the wrong answer if the ORDER BY were dropped.
      const a1 = await insertAccount({ tenant_id: tenant.id });
      const a2 = await insertAccount({ tenant_id: tenant.id });
      await insertMembership({
        user_id: user.id, tenant_id: tenant.id, account_id: a2.id, role: 'viewer',
        created_at: new Date('2026-06-01T00:00:00Z'),
      });
      await insertMembership({
        user_id: user.id, tenant_id: tenant.id, account_id: a1.id, role: 'viewer',
        created_at: new Date('2026-01-01T00:00:00Z'),
      });

      const results = await membershipRepository.findByUserAndTenant(user.id, tenant.id);
      expect(results.map((m: any) => m.account_id)).toEqual([a1.id, a2.id]);
    });
  });

  describe('findByTenantId', () => {
    it('returns all active memberships for tenant', async () => {
      const user2 = await insertUser();
      await insertMembership({ user_id: user.id, tenant_id: tenant.id, role: 'tenant_owner' });
      await insertMembership({ user_id: user2.id, tenant_id: tenant.id, role: 'operator' });

      const results = await membershipRepository.findByTenantId(tenant.id);

      expect(results).toHaveLength(2);
      expect(results.every((r: any) => r.tenant_id === tenant.id)).toBe(true);
    });

    it('excludes revoked memberships', async () => {
      const membership = await insertMembership({ user_id: user.id, tenant_id: tenant.id, role: 'viewer' });
      await membershipRepository.remove(membership.id);

      const results = await membershipRepository.findByTenantId(tenant.id);
      expect(results).toHaveLength(0);
    });
  });

  /**
   * The account-scope predicate behind `GET /tenants/:id/members` (ClickUp
   * 14ygtkj8rvu). Pinned against a real Postgres because the route suite mocks
   * the repository and a mocked pool never evaluates a `WHERE`.
   */
  describe('findByTenantIdWithUser', () => {
    it('returns the whole roster when no account is given', async () => {
      const accountA = await insertAccount({ tenant_id: tenant.id });
      const accountB = await insertAccount({ tenant_id: tenant.id });
      const [uA, uB] = [await insertUser(), await insertUser()];
      await insertMembership({ user_id: user.id, tenant_id: tenant.id, role: 'tenant_owner' });
      await insertMembership({ user_id: uA.id, tenant_id: tenant.id, account_id: accountA.id, role: 'viewer' });
      await insertMembership({ user_id: uB.id, tenant_id: tenant.id, account_id: accountB.id, role: 'operator' });

      const rows = await membershipRepository.findByTenantIdWithUser(tenant.id);

      expect(rows.map((r) => r.user?.id).sort()).toEqual([user.id, uA.id, uB.id].sort());
    });

    it('confines to one account — excluding sibling accounts AND tenant-wide members', async () => {
      const accountA = await insertAccount({ tenant_id: tenant.id });
      const accountB = await insertAccount({ tenant_id: tenant.id });
      const [uA, uA2, uB] = [await insertUser(), await insertUser(), await insertUser()];
      await insertMembership({ user_id: user.id, tenant_id: tenant.id, role: 'tenant_owner' });
      await insertMembership({ user_id: uA.id, tenant_id: tenant.id, account_id: accountA.id, role: 'viewer' });
      await insertMembership({ user_id: uA2.id, tenant_id: tenant.id, account_id: accountA.id, role: 'operator' });
      await insertMembership({ user_id: uB.id, tenant_id: tenant.id, account_id: accountB.id, role: 'account_admin' });

      const rows = await membershipRepository.findByTenantIdWithUser(tenant.id, accountA.id);

      expect(rows.map((r) => r.user?.id).sort()).toEqual([uA.id, uA2.id].sort());
      expect(rows.every((r) => r.membership.account_id === accountA.id)).toBe(true);
    });

    it('still excludes revoked memberships in the scoped branch', async () => {
      const accountA = await insertAccount({ tenant_id: tenant.id });
      const m = await insertMembership({ user_id: user.id, tenant_id: tenant.id, account_id: accountA.id, role: 'viewer' });
      await membershipRepository.remove(m.id);

      const rows = await membershipRepository.findByTenantIdWithUser(tenant.id, accountA.id);
      expect(rows).toHaveLength(0);
    });
  });

  describe('findAllByUserId', () => {
    it('returns memberships across all tenants for a user', async () => {
      const tenant2 = await insertTenant({ slug: 'tenant-two' });
      await insertMembership({ user_id: user.id, tenant_id: tenant.id, role: 'tenant_owner' });
      await insertMembership({ user_id: user.id, tenant_id: tenant2.id, role: 'viewer' });

      const results = await membershipRepository.findAllByUserId(user.id);

      expect(results).toHaveLength(2);
      const tenantIds = results.map((r: any) => r.tenant_id);
      expect(tenantIds).toContain(tenant.id);
      expect(tenantIds).toContain(tenant2.id);
    });

    it('returns empty array for user with no memberships', async () => {
      const loneUser = await insertUser();
      const results = await membershipRepository.findAllByUserId(loneUser.id);
      expect(results).toHaveLength(0);
    });
  });

  describe('updateRole', () => {
    it('changes role from viewer to operator', async () => {
      const membership = await insertMembership({ user_id: user.id, tenant_id: tenant.id, role: 'viewer' });

      const updated = await membershipRepository.updateRole(membership.id, 'operator');

      expect(updated).not.toBeNull();
      expect(updated!.role).toBe('operator');
      expect(updated!.id).toBe(membership.id);
    });

    it('returns null for non-existent membership', async () => {
      const result = await membershipRepository.updateRole('00000000-0000-0000-0000-000000000000', 'operator');
      expect(result).toBeNull();
    });
  });

  describe('remove', () => {
    it('soft deletes membership (status=revoked) and is excluded from findByTenantId', async () => {
      const membership = await insertMembership({ user_id: user.id, tenant_id: tenant.id, role: 'viewer' });

      const removed = await membershipRepository.remove(membership.id);
      expect(removed).toBe(true);

      const results = await membershipRepository.findByTenantId(tenant.id);
      expect(results).toHaveLength(0);
    });

    it('returns false for already-revoked membership', async () => {
      const membership = await insertMembership({ user_id: user.id, tenant_id: tenant.id, role: 'viewer' });
      await membershipRepository.remove(membership.id);

      const result = await membershipRepository.remove(membership.id);
      expect(result).toBe(false);
    });

    it('returns false for non-existent membership', async () => {
      const result = await membershipRepository.remove('00000000-0000-0000-0000-000000000000');
      expect(result).toBe(false);
    });
  });

  describe('countByTenantAndRole', () => {
    it('counts tenant_owners correctly', async () => {
      const user2 = await insertUser();
      await insertMembership({ user_id: user.id, tenant_id: tenant.id, role: 'tenant_owner' });
      await insertMembership({ user_id: user2.id, tenant_id: tenant.id, role: 'tenant_owner' });

      const count = await membershipRepository.countByTenantAndRole(tenant.id, 'tenant_owner');
      expect(count).toBe(2);
    });

    it('returns 0 when no memberships match', async () => {
      const count = await membershipRepository.countByTenantAndRole(tenant.id, 'tenant_owner');
      expect(count).toBe(0);
    });

    it('excludes revoked memberships from count', async () => {
      const membership = await insertMembership({ user_id: user.id, tenant_id: tenant.id, role: 'tenant_owner' });
      await membershipRepository.remove(membership.id);

      const count = await membershipRepository.countByTenantAndRole(tenant.id, 'tenant_owner');
      expect(count).toBe(0);
    });
  });

  describe('findByAccountId', () => {
    it('returns memberships for specific account', async () => {
      const account = await insertAccount({ tenant_id: tenant.id });
      await insertMembership({ user_id: user.id, tenant_id: tenant.id, account_id: account.id, role: 'operator' });

      const results = await membershipRepository.findByAccountId(account.id);

      expect(results).toHaveLength(1);
      expect(results[0]!.account_id).toBe(account.id);
      expect(results[0]!.user_id).toBe(user.id);
    });

    it('excludes tenant-level memberships (account_id is null)', async () => {
      const account = await insertAccount({ tenant_id: tenant.id });
      // Tenant-level membership (no account_id)
      await insertMembership({ user_id: user.id, tenant_id: tenant.id, role: 'tenant_owner' });

      const results = await membershipRepository.findByAccountId(account.id);
      expect(results).toHaveLength(0);
    });

    it('returns empty array for account with no memberships', async () => {
      const account = await insertAccount({ tenant_id: tenant.id });
      const results = await membershipRepository.findByAccountId(account.id);
      expect(results).toHaveLength(0);
    });
  });

  /**
   * The routes used to read `countByTenantAndRole` and then write. Two
   * statements, two snapshots: with two owners, a concurrent demotion of each
   * both read `count = 2`, both pass, and the tenant ends with none — which no
   * customer-facing route can undo, since `updateRoleSchema` and
   * `inviteUserSchema` both exclude `tenant_owner`.
   *
   * These run the two calls concurrently against real Postgres, because that is
   * the only place the guarantee lives: it is made by row locks and READ
   * COMMITTED re-checking, neither of which a mocked pool has.
   */
  describe('last-owner guard', () => {
    it('demotes a co-owner while another owner remains', async () => {
      const target = await insertMembership({ user_id: user.id, tenant_id: tenant.id, role: 'tenant_owner' });
      const other = await insertUser();
      await insertMembership({ user_id: other.id, tenant_id: tenant.id, role: 'tenant_owner' });

      const result = await membershipRepository.updateRoleGuardingLastOwner(
        target.id, tenant.id, 'tenant_owner', 'tenant_admin',
      );

      expect(result).toEqual({ ok: true, value: expect.objectContaining({ id: target.id, role: 'tenant_admin' }) });
      expect(await membershipRepository.countByTenantAndRole(tenant.id, 'tenant_owner')).toBe(1);
    });

    it('refuses to demote the last owner', async () => {
      const target = await insertMembership({ user_id: user.id, tenant_id: tenant.id, role: 'tenant_owner' });

      const result = await membershipRepository.updateRoleGuardingLastOwner(
        target.id, tenant.id, 'tenant_owner', 'tenant_admin',
      );

      expect(result).toEqual({ ok: false, reason: 'last_owner' });
      const [row] = await membershipRepository.findByUserAndTenant(user.id, tenant.id);
      expect(row!.role).toBe('tenant_owner');
    });

    it('refuses to remove the last owner', async () => {
      const target = await insertMembership({ user_id: user.id, tenant_id: tenant.id, role: 'tenant_owner' });

      const result = await membershipRepository.removeGuardingLastOwner(target.id, tenant.id, 'tenant_owner');

      expect(result).toEqual({ ok: false, reason: 'last_owner' });
      expect(await membershipRepository.countByTenantAndRole(tenant.id, 'tenant_owner')).toBe(1);
    });

    /**
     * The deterministic proof, and the one that matters.
     *
     * `Promise.all` over two demotions is NOT a reliable race detector: the two
     * calls usually serialise on their own, so the read-then-write version this
     * replaced PASSES it. (Verified by mutation — that shape passed the
     * concurrent-demotion case and only failed the demote-vs-remove one.) A
     * test that green-lights the bug it exists to catch is worse than no test.
     *
     * So drive the interleaving instead of hoping for it: hold the owner rows
     * locked from outside, prove the repository call BLOCKS on that lock rather
     * than reading around it, then commit a demotion underneath it. If the call
     * re-evaluates after the wait (READ COMMITTED re-checks the predicate on a
     * row it waited for) it sees one owner and refuses. If it read the count
     * before the lock — the old shape — it would have already decided "2 owners,
     * go ahead" and would demote the last one.
     */
    it('blocks on the owner lock and re-reads after the winner commits', async () => {
      const ownerA = await insertMembership({ user_id: user.id, tenant_id: tenant.id, role: 'tenant_owner' });
      const otherUser = await insertUser();
      const ownerB = await insertMembership({ user_id: otherUser.id, tenant_id: tenant.id, role: 'tenant_owner' });

      const blocker = await getTestPool().connect();
      let settled = false;
      try {
        await blocker.query('BEGIN');
        await blocker.query(
          `SELECT id FROM memberships
            WHERE tenant_id = $1 AND role = 'tenant_owner' AND status = 'active'
            ORDER BY id FOR UPDATE`,
          [tenant.id],
        );

        const contender = membershipRepository
          .updateRoleGuardingLastOwner(ownerA.id, tenant.id, 'tenant_owner', 'tenant_admin')
          .then((r) => { settled = true; return r; });

        // It must still be waiting on the lock. Without the lock it would have
        // read two owners and committed by now.
        await new Promise((resolve) => setTimeout(resolve, 250));
        expect(settled).toBe(false);

        // The "other" demotion wins, leaving exactly one owner.
        await blocker.query(`UPDATE memberships SET role = 'tenant_admin' WHERE id = $1`, [ownerB.id]);
        await blocker.query('COMMIT');

        expect(await contender).toEqual({ ok: false, reason: 'last_owner' });
      } finally {
        blocker.release();
      }

      expect(await membershipRepository.countByTenantAndRole(tenant.id, 'tenant_owner')).toBe(1);
    });

    it('leaves one owner standing across repeated concurrent demotions', async () => {
      // Kept as a smoke test over the real entry points, run enough times that
      // an implementation without the lock loses at least one round. The test
      // above is what actually pins the mechanism.
      for (let round = 0; round < 15; round += 1) {
        await truncateAll();
        const t = await insertTenant();
        const uA = await insertUser();
        const uB = await insertUser();
        const ownerA = await insertMembership({ user_id: uA.id, tenant_id: t.id, role: 'tenant_owner' });
        const ownerB = await insertMembership({ user_id: uB.id, tenant_id: t.id, role: 'tenant_owner' });

        const [a, b] = await Promise.all([
          membershipRepository.updateRoleGuardingLastOwner(ownerA.id, t.id, 'tenant_owner', 'tenant_admin'),
          membershipRepository.updateRoleGuardingLastOwner(ownerB.id, t.id, 'tenant_owner', 'tenant_admin'),
        ]);

        expect([a!.ok, b!.ok].sort()).toEqual([false, true]);
        expect(await membershipRepository.countByTenantAndRole(t.id, 'tenant_owner')).toBe(1);
      }
    });

    it('refuses a write whose expected role no longer matches (compare-and-swap)', async () => {
      const target = await insertMembership({ user_id: user.id, tenant_id: tenant.id, role: 'operator' });

      const result = await membershipRepository.updateRoleGuardingLastOwner(
        target.id, tenant.id, 'viewer', 'agent',
      );

      expect(result).toEqual({ ok: false, reason: 'role_changed' });
      const [row] = await membershipRepository.findByUserAndTenant(user.id, tenant.id);
      expect(row!.role).toBe('operator');
    });

    it('reports not_found for a membership in another tenant', async () => {
      const otherTenant = await insertTenant();
      const target = await insertMembership({ user_id: user.id, tenant_id: otherTenant.id, role: 'operator' });

      const result = await membershipRepository.updateRoleGuardingLastOwner(
        target.id, tenant.id, 'operator', 'viewer',
      );

      expect(result).toEqual({ ok: false, reason: 'not_found' });
    });

    it('reports not_found for an already-revoked membership', async () => {
      const target = await insertMembership({ user_id: user.id, tenant_id: tenant.id, role: 'operator' });
      await membershipRepository.remove(target.id);

      const result = await membershipRepository.removeGuardingLastOwner(target.id, tenant.id, 'operator');

      expect(result).toEqual({ ok: false, reason: 'not_found' });
    });

    it('does not leak a pool client per call', async () => {
      // Every branch of the guard opens a transaction; one that forgets to
      // release exhausts the pool (max 5) and the suite hangs rather than fails.
      const target = await insertMembership({ user_id: user.id, tenant_id: tenant.id, role: 'operator' });
      for (let i = 0; i < 12; i += 1) {
        await membershipRepository.updateRoleGuardingLastOwner(target.id, tenant.id, 'viewer', 'agent');
      }
      expect(getTestPool().idleCount).toBeGreaterThan(0);
    });
  });
});
