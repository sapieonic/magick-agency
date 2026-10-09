// PORT NOTE (magick-agency): ported from master test/unit/db/repositories/membership.repository.test.ts@a1f0756a — verbatim except import specifiers and the type-only casts marked below.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({ pool: { query: vi.fn(), connect: vi.fn() } }));
vi.mock('../../../../src/connection.js', () => ({ getPool: () => mocks.pool }));

import { MembershipRepository } from '../../../../src/repositories/membership.repository.js';

const row = {
  id: 'm-1', user_id: 'u-1', tenant_id: 't-1', account_id: 'a-1',
  role: 'operator', status: 'active', invited_by: null,
  created_at: new Date(), updated_at: new Date(),
};

describe('MembershipRepository', () => {
  let repo: MembershipRepository;

  beforeEach(() => {
    repo = new MembershipRepository();
    vi.clearAllMocks();
  });

  describe('create', () => {
    it('should INSERT membership and return it', async () => {
      mocks.pool.query.mockResolvedValue({ rows: [row] });
      const result = await repo.create({ user_id: 'u-1', tenant_id: 't-1', account_id: 'a-1', role: 'operator' });
      expect(result).toEqual(row);
      const [sql, params] = mocks.pool.query.mock.calls[0]!;
      expect(sql).toContain('INSERT INTO memberships');
      expect(params[0]).toBe('u-1');
      expect(params[1]).toBe('t-1');
      expect(params[2]).toBe('a-1');
      expect(params[3]).toBe('operator');
    });

    it('should set account_id to null when not provided', async () => {
      mocks.pool.query.mockResolvedValue({ rows: [row] });
      await repo.create({ user_id: 'u-1', tenant_id: 't-1', role: 'tenant_owner' });
      const [, params] = mocks.pool.query.mock.calls[0]!;
      expect(params[2]).toBeNull();
    });

    it('should set invited_by to null when not provided', async () => {
      mocks.pool.query.mockResolvedValue({ rows: [row] });
      await repo.create({ user_id: 'u-1', tenant_id: 't-1', role: 'viewer' });
      const [, params] = mocks.pool.query.mock.calls[0]!;
      expect(params[4]).toBeNull();
    });
  });

  describe('findByUserAndTenant', () => {
    it('should SELECT active memberships for user+tenant', async () => {
      mocks.pool.query.mockResolvedValue({ rows: [row] });
      const result = await repo.findByUserAndTenant('u-1', 't-1');
      expect(result).toEqual([row]);
      const [sql, params] = mocks.pool.query.mock.calls[0]!;
      expect(sql).toContain("status = 'active'");
      expect(params).toEqual(['u-1', 't-1']);
    });

    it('should return empty array when no memberships', async () => {
      mocks.pool.query.mockResolvedValue({ rows: [] });
      expect(await repo.findByUserAndTenant('u-1', 't-2')).toEqual([]);
    });
  });

  describe('findAnyByUserAndTenant', () => {
    /**
     * The status-INCLUSIVE twin, for the supervisory agent-record reads. Its whole
     * reason to exist is that offboarding sets `status = 'revoked'`, so the
     * active-only lookup answered "not a member of this workspace" for exactly the
     * departed agent a dispute is about.
     */
    it('SELECTs without a status predicate, so a revoked row still resolves', async () => {
      const revoked = { ...row, status: 'revoked' };
      mocks.pool.query.mockResolvedValue({ rows: [revoked] });

      expect(await repo.findAnyByUserAndTenant('u-1', 't-1')).toEqual([revoked]);
      const [sql, params] = mocks.pool.query.mock.calls[0]!;
      expect(sql).not.toContain('status');
      expect(params).toEqual(['u-1', 't-1']);
    });

    it('keeps the tenant predicate in the same statement as the read', async () => {
      // Dropping the status filter widens WHO is visible, never WHICH TENANT —
      // rule 1 of docs/reference/magick-master/CLAUDE.md's RBAC section, and the property that keeps a user who
      // was never here answering 404.
      mocks.pool.query.mockResolvedValue({ rows: [] });
      await repo.findAnyByUserAndTenant('u-1', 't-2');

      const [sql] = mocks.pool.query.mock.calls[0]!;
      expect(sql).toContain('tenant_id = $2');
      expect(sql).toContain('user_id = $1');
    });

    it('returns an empty array for a user who was never in this tenant', async () => {
      mocks.pool.query.mockResolvedValue({ rows: [] });
      expect(await repo.findAnyByUserAndTenant('u-1', 't-2')).toEqual([]);
    });
  });

  describe('findAnyByUsersAndTenant', () => {
    /**
     * The SET form of `findAnyByUserAndTenant`, and it had no direct test at all —
     * only route tests over a mocked repository, which cannot see any of the
     * properties below. That gap matters more than the usual missing-unit-test
     * because the UUID short-circuit is LOAD-BEARING: the ids come from core's
     * response body, where `agent_user_id` is an opaque string with no `uuid`
     * column behind it (design D3), so a malformed one is reachable — and inside
     * `= ANY($1::uuid[])` it raises Postgres `22P02`, which propagates as a 500
     * that `errorMaskHook` turns into "contact support and quote this request id".
     * One junk id in a roster page would take the whole supervisor screen down as
     * an apparent outage.
     *
     * These are real UUIDs rather than the `'u-1'` this file uses elsewhere, for
     * the same reason: this method filters on the shape, so `'u-1'` would be
     * stripped and every case would assert the empty path.
     */
    const USER_A = '22222222-2222-4222-8222-222222222222';
    const USER_B = '33333333-3333-4333-8333-333333333333';
    const TENANT = '11111111-1111-4111-8111-111111111111';
    const memberRow = { ...row, user_id: USER_A, tenant_id: TENANT };

    it('SELECTs both ids in ONE statement, not one query per id', async () => {
      // The "no per-item loops over I/O" rule in docs/reference/magick-master/CLAUDE.md: the roster reads up to
      // `limit` (200) memberships to decide which rows survive, and asked through
      // the singleton that is 200 round trips.
      mocks.pool.query.mockResolvedValue({ rows: [memberRow] });

      expect(await repo.findAnyByUsersAndTenant([USER_A, USER_B], TENANT)).toEqual([memberRow]);
      expect(mocks.pool.query).toHaveBeenCalledTimes(1);
      const [sql, params] = mocks.pool.query.mock.calls[0]!;
      expect(sql).toContain('= ANY($1::uuid[])');
      expect(params[0]).toEqual([USER_A, USER_B]);
    });

    it('keeps the tenant predicate in the SAME statement as the read', async () => {
      // Rule 1 of docs/reference/magick-master/CLAUDE.md's RBAC section. Widening WHO is visible (no status
      // filter, below) must never widen WHICH TENANT — a user who was never here
      // has to resolve to nothing so the caller drops their row.
      mocks.pool.query.mockResolvedValue({ rows: [] });
      await repo.findAnyByUsersAndTenant([USER_A], TENANT);

      const [sql, params] = mocks.pool.query.mock.calls[0]!;
      expect(sql).toContain('tenant_id = $2');
      expect(params[1]).toBe(TENANT);
    });

    it('does NOT filter on status, because the caller needs all three answers', async () => {
      // `active` (current), `revoked`/`inactive` (departed — dropped or kept by
      // `include_inactive`) and NO ROW AT ALL (never in this tenant, dropped under
      // either flag) are three different decisions. A status predicate here would
      // collapse the last two into one, which is the distinction the roster's
      // filter is made of.
      const revoked = { ...memberRow, status: 'revoked' };
      mocks.pool.query.mockResolvedValue({ rows: [revoked] });

      expect(await repo.findAnyByUsersAndTenant([USER_A], TENANT)).toEqual([revoked]);
      const [sql] = mocks.pool.query.mock.calls[0]!;
      expect(sql).not.toContain('status');
    });

    it('strips a non-UUID id instead of letting it reach the ::uuid cast', async () => {
      /**
       * The load-bearing one. `'not-a-uuid'` inside `ANY($1::uuid[])` is `22P02`,
       * a 500, and a masked support message on the whole roster screen. Filtered
       * in JS instead — exactly as `userRepository.findDisplayNamesInTenant` does
       * — and the caller then sees the id as "no membership row", which is the
       * truth about a string that cannot be a user id.
       */
      mocks.pool.query.mockResolvedValue({ rows: [memberRow] });
      await repo.findAnyByUsersAndTenant(
        [USER_A, 'not-a-uuid', '', '  ', `${USER_B};DROP TABLE memberships`],
        TENANT,
      );

      const [, params] = mocks.pool.query.mock.calls[0]!;
      expect(params[0]).toEqual([USER_A]);
    });

    it('accepts an UPPER-case uuid, which core can legitimately send', async () => {
      // `agent_user_id` is opaque to core, so case is not normalised upstream. The
      // shape check must not reject a perfectly valid id — and the `::uuid` cast
      // matches it — which is why the regex is case-insensitive.
      mocks.pool.query.mockResolvedValue({ rows: [memberRow] });
      await repo.findAnyByUsersAndTenant([USER_A.toUpperCase()], TENANT);

      const [, params] = mocks.pool.query.mock.calls[0]!;
      expect(params[0]).toEqual([USER_A.toUpperCase()]);
    });

    it('collapses duplicates, because a grouped page repeats an agent per row', async () => {
      // `group_by=agent,campaign` emits one row per pair, so the same id arrives
      // once per campaign. De-duplicated HERE rather than at the call site, so
      // neither caller has to remember — and the grouped route's comment says it
      // relies on that.
      mocks.pool.query.mockResolvedValue({ rows: [memberRow] });
      await repo.findAnyByUsersAndTenant([USER_A, USER_A, USER_B, USER_A], TENANT);

      const [, params] = mocks.pool.query.mock.calls[0]!;
      expect(params[0]).toEqual([USER_A, USER_B]);
    });

    it('does not query AT ALL for an empty list, or one that is all junk', async () => {
      // `ANY('{}'::uuid[])` matches nothing, so the query would be correct and
      // pointless. The route reaches this whenever core returns a page of rows
      // whose ids are all unusable, which is a real shape (R4's third state).
      expect(await repo.findAnyByUsersAndTenant([], TENANT)).toEqual([]);
      expect(await repo.findAnyByUsersAndTenant(['nope', ''], TENANT)).toEqual([]);
      expect(mocks.pool.query).not.toHaveBeenCalled();
    });

    it('does not query for a malformed TENANT id either', async () => {
      // The tenant is master's own (`request.tenantId`), so this should be
      // unreachable — and it is checked anyway because the failure mode is the
      // same `22P02` on `$2::uuid`, and "should be unreachable" is how the first
      // one got shipped.
      expect(await repo.findAnyByUsersAndTenant([USER_A], 'not-a-tenant')).toEqual([]);
      expect(mocks.pool.query).not.toHaveBeenCalled();
    });
  });

  describe('findByTenantId', () => {
    it('should SELECT all active memberships for tenant', async () => {
      mocks.pool.query.mockResolvedValue({ rows: [row] });
      const result = await repo.findByTenantId('t-1');
      expect(result).toEqual([row]);
      expect(mocks.pool.query).toHaveBeenCalledWith(
        expect.stringContaining("tenant_id = $1"), ['t-1'],
      );
    });
  });

  describe('findByAccountId', () => {
    it('should SELECT active memberships for account', async () => {
      mocks.pool.query.mockResolvedValue({ rows: [row] });
      const result = await repo.findByAccountId('a-1');
      expect(result).toEqual([row]);
      expect(mocks.pool.query).toHaveBeenCalledWith(
        expect.stringContaining('account_id = $1'), ['a-1'],
      );
    });
  });

  describe('findAllByUserId', () => {
    it('should SELECT all active memberships for user', async () => {
      mocks.pool.query.mockResolvedValue({ rows: [row] });
      const result = await repo.findAllByUserId('u-1');
      expect(result).toEqual([row]);
      expect(mocks.pool.query).toHaveBeenCalledWith(
        expect.stringContaining('user_id = $1'), ['u-1'],
      );
    });
  });

  describe('updateRole', () => {
    it('should UPDATE role and return updated membership', async () => {
      const updated = { ...row, role: 'account_admin' };
      mocks.pool.query.mockResolvedValue({ rows: [updated] });
      const result = await repo.updateRole('m-1', 'account_admin');
      expect(result?.role).toBe('account_admin');
      const [sql, params] = mocks.pool.query.mock.calls[0]!;
      expect(sql).toContain('UPDATE memberships');
      expect(params).toEqual(['account_admin', 'm-1']);
    });

    it('should return null when membership not found', async () => {
      mocks.pool.query.mockResolvedValue({ rows: [] });
      expect(await repo.updateRole('no-such', 'viewer')).toBeNull();
    });
  });

  describe('reactivateWithRole', () => {
    function fakeClient(responses: Array<{ rows: any[] }>) {
      let i = 0;
      return {
        query: vi.fn(async (sql: string) => {
          if (/^(BEGIN|COMMIT|ROLLBACK)/.test(sql.trim())) return { rows: [], rowCount: 0 };
          const next = responses[i++] ?? { rows: [] };
          return { rowCount: next.rows.length, ...next };
        }),
        release: vi.fn(),
      };
    }

    it('reactivates and revokes outstanding invites in one transaction', async () => {
      const reactivated = { ...row, account_id: null, status: 'active', role: 'tenant_admin' };
      const client = fakeClient([{ rows: [reactivated] }, { rows: [] }]);
      mocks.pool.connect.mockResolvedValue(client);

      const result = await repo.reactivateWithRole('m-1', 'tenant_admin', 't-1');

      expect(result).toEqual(reactivated);
      const sql = client.query.mock.calls.map(([q]) => q as string);
      expect(sql[0]!.trim()).toBe('BEGIN');
      expect(sql[1]).toContain("status = 'active'");
      expect(sql[1]).toContain("status <> 'active'");
      expect(sql[1]).toContain('tenant_id = $3');
      // PORT NOTE (magick-agency): type-only cast — agency's tsconfig typechecks tests (B1), master's did not.
      expect((client.query.mock.calls[1] as unknown[])[1]).toEqual(['tenant_admin', 'm-1', 't-1']);
      expect(sql[2]).toContain('UPDATE membership_invites');
      expect(sql[2]).toContain('claimed_at IS NULL');
      expect(sql[2]).toContain('revoked_at IS NULL');
      expect((client.query.mock.calls[2] as unknown[])[1]).toEqual(['m-1', 't-1']);
      expect(sql[3]!.trim()).toBe('COMMIT');
      expect(client.release).toHaveBeenCalled();
    });

    it('rolls back and returns null when the row is missing or already active', async () => {
      const client = fakeClient([{ rows: [] }]);
      mocks.pool.connect.mockResolvedValue(client);

      expect(await repo.reactivateWithRole('m-1', 'operator', 't-1')).toBeNull();
      const sql = client.query.mock.calls.map(([q]) => (q as string).trim());
      expect(sql).toContain('ROLLBACK');
      expect(sql.some((statement) => statement.includes('membership_invites'))).toBe(false);
      expect(client.release).toHaveBeenCalled();
    });
  });

  describe('remove', () => {
    it('should set status=revoked and return true', async () => {
      mocks.pool.query.mockResolvedValue({ rowCount: 1 });
      expect(await repo.remove('m-1')).toBe(true);
      const [sql, params] = mocks.pool.query.mock.calls[0]!;
      expect(sql).toContain("status = 'revoked'");
      expect(params).toEqual(['m-1']);
    });

    it('should return false when membership not found or already revoked', async () => {
      mocks.pool.query.mockResolvedValue({ rowCount: 0 });
      expect(await repo.remove('no-such')).toBe(false);
    });
  });

  describe('countByTenantAndRole', () => {
    it('should return the count as integer', async () => {
      mocks.pool.query.mockResolvedValue({ rows: [{ count: '3' }] });
      const result = await repo.countByTenantAndRole('t-1', 'tenant_owner');
      expect(result).toBe(3);
      expect(mocks.pool.query).toHaveBeenCalledWith(
        expect.stringContaining('COUNT(*)'), ['t-1', 'tenant_owner'],
      );
    });

    it('should return 0 when no rows match', async () => {
      mocks.pool.query.mockResolvedValue({ rows: [{ count: '0' }] });
      expect(await repo.countByTenantAndRole('t-1', 'viewer')).toBe(0);
    });

    it('should handle missing count row gracefully', async () => {
      mocks.pool.query.mockResolvedValue({ rows: [] });
      expect(await repo.countByTenantAndRole('t-1', 'viewer')).toBe(0);
    });
  });

  /**
   * The last-owner guard's correctness — one owner always standing under
   * concurrent demotions — is made by row locks and READ COMMITTED re-checking,
   * so it is proven in `test/integration/repositories/membership.repository.test.ts`
   * against real Postgres. What is proven here is the transaction hygiene a
   * fake client CAN see: the statement order that makes the locking work, and
   * that no branch leaves a client checked out or a transaction open. A leaked
   * client is silent until the pool is exhausted, at which point the symptom is
   * a hang somewhere else entirely.
   */
  describe('last-owner guard transaction hygiene', () => {
    const owner = { ...row, role: 'tenant_owner' as const };

    function fakeClient(responses: Array<{ rows: any[]; rowCount?: number }>) {
      const calls: string[] = [];
      let i = 0;
      return {
        calls,
        released: [] as unknown[],
        query: vi.fn(async (sql: string) => {
          calls.push(sql.trim().split('\n')[0]!.trim());
          if (/^(BEGIN|COMMIT|ROLLBACK)/.test(sql.trim())) return { rows: [], rowCount: 0 };
          const next = responses[i++] ?? { rows: [], rowCount: 0 };
          return { rowCount: next.rows.length, ...next };
        }),
        release: vi.fn(),
      };
    }

    it('locks every owner row BEFORE reading the target', async () => {
      // Order is the whole guarantee: two callers that each locked their own
      // target first would deadlock, and one that read the count without a lock
      // would be back to the race this replaced.
      const client = fakeClient([
        { rows: [{ id: 'm-1' }, { id: 'm-2' }] },  // owners, FOR UPDATE
        { rows: [owner] },                          // target, FOR UPDATE
        { rows: [{ ...owner, role: 'tenant_admin' }] }, // the UPDATE
      ]);
      mocks.pool.connect.mockResolvedValue(client);

      const result = await repo.updateRoleGuardingLastOwner('m-1', 't-1', 'tenant_owner', 'tenant_admin');

      expect(result).toEqual({ ok: true, value: { ...owner, role: 'tenant_admin' } });
      const sql = client.query.mock.calls.map(([q]) => q as string);
      expect(sql[0]!.trim()).toBe('BEGIN');
      // 1st statement: the owner set, locked. Not the target, not a count.
      expect(sql[1]).toContain("role = 'tenant_owner'");
      expect(sql[1]).toContain('ORDER BY id');
      expect(sql[1]).toContain('FOR UPDATE');
      expect(sql[1]).not.toContain('COUNT(');
      // 2nd: the target, locked and tenant-scoped.
      expect(sql[2]).toContain('WHERE id = $1 AND tenant_id = $2');
      expect(sql[2]).toContain('FOR UPDATE');
      // 3rd: the write, inside the same transaction.
      expect(sql[3]).toContain('UPDATE memberships SET role');
      expect(client.calls.at(-1)).toBe('COMMIT');
      expect(client.release).toHaveBeenCalledTimes(1);
    });

    it('rolls back and releases when it refuses the last owner', async () => {
      const client = fakeClient([
        { rows: [{ id: 'm-1' }] },   // the only owner
        { rows: [owner] },
      ]);
      mocks.pool.connect.mockResolvedValue(client);

      const result = await repo.updateRoleGuardingLastOwner('m-1', 't-1', 'tenant_owner', 'tenant_admin');

      expect(result).toEqual({ ok: false, reason: 'last_owner' });
      expect(client.calls).toContain('ROLLBACK');
      expect(client.calls).not.toContain('COMMIT');
      expect(client.query.mock.calls.some(([sql]) => /UPDATE memberships SET role/.test(sql as string))).toBe(false);
      expect(client.release).toHaveBeenCalledTimes(1);
    });

    it('rolls back and releases on not_found and on role_changed', async () => {
      const missing = fakeClient([{ rows: [] }, { rows: [] }]);
      mocks.pool.connect.mockResolvedValue(missing);
      expect(await repo.removeGuardingLastOwner('m-1', 't-1', 'operator'))
        .toEqual({ ok: false, reason: 'not_found' });
      expect(missing.calls).toContain('ROLLBACK');
      expect(missing.release).toHaveBeenCalledTimes(1);

      const moved = fakeClient([{ rows: [] }, { rows: [{ ...row, role: 'tenant_admin' }] }]);
      mocks.pool.connect.mockResolvedValue(moved);
      expect(await repo.removeGuardingLastOwner('m-1', 't-1', 'operator'))
        .toEqual({ ok: false, reason: 'role_changed' });
      expect(moved.calls).toContain('ROLLBACK');
      expect(moved.release).toHaveBeenCalledTimes(1);
    });

    it('releases the client when the write throws, and rethrows the original error', async () => {
      const client = fakeClient([]);
      const boom = new Error('connection terminated');
      client.query.mockImplementation(async (sql: string) => {
        if (sql.trim() === 'BEGIN') return { rows: [], rowCount: 0 };
        throw boom;
      });
      mocks.pool.connect.mockResolvedValue(client);

      await expect(repo.updateRoleGuardingLastOwner('m-1', 't-1', 'operator', 'viewer')).rejects.toBe(boom);
      expect(client.release).toHaveBeenCalledTimes(1);
    });

    it('DESTROYS the client when the rollback itself fails', async () => {
      // A client whose ROLLBACK failed may still hold an open transaction. Handing
      // it back to the pool gives the next borrower someone else's transaction.
      const client = fakeClient([]);
      client.query.mockImplementation(async (sql: string) => {
        if (sql.trim() === 'BEGIN') return { rows: [], rowCount: 0 };
        throw new Error('connection terminated');
      });
      mocks.pool.connect.mockResolvedValue(client);

      await expect(repo.removeGuardingLastOwner('m-1', 't-1', 'operator')).rejects.toThrow();
      expect(client.release).toHaveBeenCalledWith(true);
    });
  });
});
