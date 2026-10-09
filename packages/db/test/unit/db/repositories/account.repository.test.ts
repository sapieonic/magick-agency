// PORT NOTE (magick-agency): ported from master test/unit/db/repositories/account.repository.test.ts@a1f0756a — verbatim except import specifiers and the type-only casts marked below.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({ pool: { query: vi.fn() } }));
vi.mock('../../../../src/connection.js', () => ({ getPool: () => mocks.pool }));

import { AccountRepository } from '../../../../src/repositories/account.repository.js';

const row = {
  id: 'acc-1', tenant_id: 't-1', name: 'Main', slug: 'main',
  settings: {}, status: 'active', created_at: new Date(), updated_at: new Date(),
};

describe('AccountRepository', () => {
  let repo: AccountRepository;

  beforeEach(() => {
    repo = new AccountRepository();
    vi.clearAllMocks();
  });

  describe('create', () => {
    it('should INSERT and return account', async () => {
      mocks.pool.query.mockResolvedValue({ rows: [row] });
      const result = await repo.create({ tenant_id: 't-1', name: 'Main', slug: 'main' });
      expect(result).toEqual(row);
      const [sql, params] = mocks.pool.query.mock.calls[0]!;
      expect(sql).toContain('INSERT INTO accounts');
      expect(params[0]).toBe('t-1');
      expect(params[1]).toBe('Main');
      expect(params[2]).toBe('main');
    });

    it('should serialize settings as JSON string', async () => {
      mocks.pool.query.mockResolvedValue({ rows: [row] });
      await repo.create({ tenant_id: 't-1', name: 'X', slug: 'x', settings: { env: 'prod' } });
      const [, params] = mocks.pool.query.mock.calls[0]!;
      expect(params[3]).toBe('{"env":"prod"}');
    });

    it('should default settings to empty object when not provided', async () => {
      mocks.pool.query.mockResolvedValue({ rows: [row] });
      await repo.create({ tenant_id: 't-1', name: 'X', slug: 'x' });
      const [, params] = mocks.pool.query.mock.calls[0]!;
      expect(params[3]).toBe('{}');
    });
  });

  describe('findById', () => {
    it('should SELECT by id excluding deleted', async () => {
      mocks.pool.query.mockResolvedValue({ rows: [row] });
      const result = await repo.findById('acc-1');
      expect(result).toEqual(row);
      const [sql, params] = mocks.pool.query.mock.calls[0]!;
      expect(sql).toContain("status != 'deleted'");
      expect(params).toEqual(['acc-1']);
    });

    it('should return null when not found', async () => {
      mocks.pool.query.mockResolvedValue({ rows: [] });
      expect(await repo.findById('no-such')).toBeNull();
    });
  });

  describe('findByTenantId', () => {
    it('should SELECT all non-deleted accounts for tenant', async () => {
      mocks.pool.query.mockResolvedValue({ rows: [row] });
      const result = await repo.findByTenantId('t-1');
      expect(result).toEqual([row]);
      const [sql, params] = mocks.pool.query.mock.calls[0]!;
      expect(sql).toContain('tenant_id = $1');
      expect(params).toEqual(['t-1']);
    });

    it('should return empty array when tenant has no accounts', async () => {
      mocks.pool.query.mockResolvedValue({ rows: [] });
      expect(await repo.findByTenantId('t-empty')).toEqual([]);
    });
  });

  describe('findByIds', () => {
    it('should SELECT by id array scoped to tenant, excluding deleted', async () => {
      // `tenantId` is a required second filter, not decoration — see the
      // docstring on the repository method for why id-only is unsafe.
      mocks.pool.query.mockResolvedValue({ rows: [row] });
      const result = await repo.findByIds(['acc-1'], 't-1');
      expect(result).toEqual([row]);
      const [sql, params] = mocks.pool.query.mock.calls[0]!;
      expect(sql).toContain('id = ANY($1)');
      expect(sql).toContain('tenant_id = $2');
      expect(sql).toContain("status != 'deleted'");
      expect(params).toEqual([['acc-1'], 't-1']);
    });

    it('should short-circuit an empty id array without querying the database', async () => {
      const result = await repo.findByIds([], 't-1');
      expect(result).toEqual([]);
      expect(mocks.pool.query).not.toHaveBeenCalled();
    });

    it('should return empty array when nothing matches', async () => {
      mocks.pool.query.mockResolvedValue({ rows: [] });
      expect(await repo.findByIds(['acc-other-tenant'], 't-1')).toEqual([]);
    });
  });

  describe('update', () => {
    it('should fall back to a TENANT-SCOPED read when no fields provided', async () => {
      // The empty-patch shortcut returns the row, so an unscoped read here would
      // hand another tenant's record back for the price of an empty JSON body —
      // the write predicate below would never even run.
      mocks.pool.query.mockResolvedValue({ rows: [row] });
      await repo.update('acc-1', 'tenant-1', {});
      const [sql, params] = mocks.pool.query.mock.calls[0]!;
      expect(sql).toContain('WHERE id = $1');
      expect(sql).toContain('tenant_id = $2');
      expect(params).toEqual(['acc-1', 'tenant-1']);
    });

    it('should UPDATE name', async () => {
      mocks.pool.query.mockResolvedValue({ rows: [row] });
      await repo.update('acc-1', 'tenant-1', { name: 'Updated' });
      const [sql, params] = mocks.pool.query.mock.calls[0]!;
      expect(sql).toContain('UPDATE accounts');
      expect(sql).toContain('name = $1');
      expect(params[0]).toBe('Updated');
    });

    it('should UPDATE settings as JSON', async () => {
      mocks.pool.query.mockResolvedValue({ rows: [row] });
      await repo.update('acc-1', 'tenant-1', { settings: { tier: 'premium' } });
      const [, params] = mocks.pool.query.mock.calls[0]!;
      expect(params[0]).toBe('{"tier":"premium"}');
    });

    it('should UPDATE status', async () => {
      mocks.pool.query.mockResolvedValue({ rows: [row] });
      // PORT NOTE (magick-agency): type-only cast — agency's tsconfig typechecks tests (B1), master's did not.
      await repo.update('acc-1', 'tenant-1', { status: 'inactive' as never });
      const [, params] = mocks.pool.query.mock.calls[0]!;
      expect(params[0]).toBe('inactive');
    });

    it('should return null when no row matched', async () => {
      mocks.pool.query.mockResolvedValue({ rows: [] });
      expect(await repo.update('no-such', 'tenant-1', { name: 'X' })).toBeNull();
    });

    /**
     * ── The cross-tenant WRITE this predicate exists to stop ──────────────────
     *
     * `requirePermission('account.update')` checks the CALLER'S ROLE and never
     * looks at the target row, so before this predicate an account_admin of
     * tenant A could `PUT /accounts/<uuid in tenant B>`, rename B's account, and
     * receive B's full record back — `tenant_id`, `name`, `settings`, `status`.
     * It was an exfiltration primitive as well as a write.
     *
     * Asserted on the SQL rather than through a fake database because the
     * predicate is the whole fix: a test that mocked the driver into returning
     * one row would pass with or without it.
     */
    it('carries the tenant predicate in the same statement as the write', async () => {
      mocks.pool.query.mockResolvedValue({ rows: [row] });
      await repo.update('acc-1', 'tenant-1', { name: 'Renamed' });
      const [sql, params] = mocks.pool.query.mock.calls[0]!;
      // One statement, both keys. A fetch-then-check in the route would be a read
      // and a write that can disagree; a WHERE carrying both cannot.
      expect(sql).toMatch(/UPDATE accounts[\s\S]*WHERE id = \$2 AND tenant_id = \$3/);
      expect(params).toEqual(['Renamed', 'acc-1', 'tenant-1']);
    });
  });

  describe('softDelete', () => {
    it('should set status=deleted and return true on success', async () => {
      mocks.pool.query.mockResolvedValue({ rowCount: 1 });
      expect(await repo.softDelete('acc-1', 'tenant-1')).toBe(true);
      const [sql] = mocks.pool.query.mock.calls[0]!;
      expect(sql).toContain("status = 'deleted'");
    });

    it('should return false when account not found or already deleted', async () => {
      mocks.pool.query.mockResolvedValue({ rowCount: 0 });
      expect(await repo.softDelete('no-such', 'tenant-1')).toBe(false);
    });

    it('cannot soft-delete another tenant\'s account', async () => {
      // Higher stakes than PUT: this one needs no response body to do damage.
      mocks.pool.query.mockResolvedValue({ rowCount: 1 });
      await repo.softDelete('acc-1', 'tenant-1');
      const [sql, params] = mocks.pool.query.mock.calls[0]!;
      expect(sql).toContain('tenant_id = $2');
      expect(params).toEqual(['acc-1', 'tenant-1']);
    });
  });

  describe('findByIdInTenant', () => {
    it('is the tenant-facing lookup, and findById stays deliberately unscoped', async () => {
      // `findById` has legitimate cross-tenant callers (the super-admin tree, and
      // the name resolver which checks ownership itself). Splitting them keeps
      // that legitimacy explicit instead of leaving one method that is safe or
      // unsafe depending on who reads it.
      mocks.pool.query.mockResolvedValue({ rows: [row] });
      await repo.findByIdInTenant('acc-1', 'tenant-1');
      const [scopedSql, scopedParams] = mocks.pool.query.mock.calls[0]!;
      expect(scopedSql).toContain('tenant_id = $2');
      expect(scopedParams).toEqual(['acc-1', 'tenant-1']);

      mocks.pool.query.mockClear();
      await repo.findById('acc-1');
      const [unscopedSql] = mocks.pool.query.mock.calls[0]!;
      expect(unscopedSql).not.toContain('tenant_id');
    });

    it('excludes a soft-deleted account', async () => {
      mocks.pool.query.mockResolvedValue({ rows: [row] });
      await repo.findByIdInTenant('acc-1', 'tenant-1');
      const [sql] = mocks.pool.query.mock.calls[0]!;
      expect(sql).toContain("status != 'deleted'");
    });
  });

  describe('findByIdInTenantIncludingDeleted', () => {
    /**
     * `POST /credits/deallocate`'s lookup, and the ONE place a soft-deleted
     * account must still resolve: a deleted account can still hold an
     * unrefunded balance in `account_credit_allocations`, and the active-only
     * `findByIdInTenant` made that balance permanently unreachable.
     */
    it('keeps the tenant predicate in the same statement as findByIdInTenant, but drops the status filter', async () => {
      mocks.pool.query.mockResolvedValue({ rows: [{ ...row, status: 'deleted' }] });
      const result = await repo.findByIdInTenantIncludingDeleted('acc-1', 'tenant-1');

      expect(result).toEqual({ ...row, status: 'deleted' });
      const [sql, params] = mocks.pool.query.mock.calls[0]!;
      expect(sql).toContain('tenant_id = $2');
      expect(sql).not.toContain('deleted');
      expect(params).toEqual(['acc-1', 'tenant-1']);
    });

    it('still returns null for an account in a DIFFERENT tenant', async () => {
      mocks.pool.query.mockResolvedValue({ rows: [] });
      const result = await repo.findByIdInTenantIncludingDeleted('acc-1', 'tenant-2');
      expect(result).toBeNull();
    });
  });
});
