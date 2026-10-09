// PORT NOTE (magick-agency): ported from master test/unit/db/repositories/tenant.repository.test.ts@a1f0756a — verbatim except import specifiers and the type-only casts marked below.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({ pool: { query: vi.fn() } }));
vi.mock('../../../../src/connection.js', () => ({ getPool: () => mocks.pool }));

import { TenantRepository } from '../../../../src/repositories/tenant.repository.js';

const row = {
  id: 't-1', name: 'Acme', slug: 'acme', settings: {},
  status: 'active', created_at: new Date(), updated_at: new Date(),
};

describe('TenantRepository', () => {
  let repo: TenantRepository;

  beforeEach(() => {
    repo = new TenantRepository();
    vi.clearAllMocks();
  });

  describe('create', () => {
    it('should INSERT and return tenant', async () => {
      mocks.pool.query.mockResolvedValue({ rows: [row] });
      const result = await repo.create({ name: 'Acme', slug: 'acme' });
      expect(result).toEqual(row);
      const [sql, params] = mocks.pool.query.mock.calls[0]!;
      expect(sql).toContain('INSERT INTO tenants');
      expect(params).toEqual(['Acme', 'acme', '{}']);
    });

    it('should serialize settings as JSON', async () => {
      mocks.pool.query.mockResolvedValue({ rows: [row] });
      await repo.create({ name: 'X', slug: 'x', settings: { key: 'val' } });
      const [, params] = mocks.pool.query.mock.calls[0]!;
      expect(params[2]).toBe('{"key":"val"}');
    });
  });

  describe('findById', () => {
    it('should SELECT by id excluding deleted', async () => {
      mocks.pool.query.mockResolvedValue({ rows: [row] });
      const result = await repo.findById('t-1');
      expect(result).toEqual(row);
      const [sql, params] = mocks.pool.query.mock.calls[0]!;
      expect(sql).toContain("status != 'deleted'");
      expect(params).toEqual(['t-1']);
    });

    it('should return null when not found', async () => {
      mocks.pool.query.mockResolvedValue({ rows: [] });
      expect(await repo.findById('no-such')).toBeNull();
    });
  });

  describe('findBySlug', () => {
    it('should SELECT by slug excluding deleted', async () => {
      mocks.pool.query.mockResolvedValue({ rows: [row] });
      const result = await repo.findBySlug('acme');
      expect(result).toEqual(row);
      expect(mocks.pool.query).toHaveBeenCalledWith(
        expect.stringContaining('slug = $1'), ['acme'],
      );
    });

    it('should return null when not found', async () => {
      mocks.pool.query.mockResolvedValue({ rows: [] });
      expect(await repo.findBySlug('no-slug')).toBeNull();
    });
  });

  describe('update', () => {
    it('should fall back to findById when no fields provided', async () => {
      mocks.pool.query.mockResolvedValue({ rows: [row] });
      await repo.update('t-1', {});
      expect(mocks.pool.query).toHaveBeenCalledWith(expect.stringContaining('WHERE id = $1'), ['t-1']);
    });

    it('should UPDATE name', async () => {
      mocks.pool.query.mockResolvedValue({ rows: [row] });
      await repo.update('t-1', { name: 'NewName' });
      const [sql, params] = mocks.pool.query.mock.calls[0]!;
      expect(sql).toContain('UPDATE tenants');
      expect(sql).toContain('name = $1');
      expect(params[0]).toBe('NewName');
      expect(params[params.length - 1]).toBe('t-1');
    });

    it('should UPDATE settings as JSON', async () => {
      mocks.pool.query.mockResolvedValue({ rows: [row] });
      await repo.update('t-1', { settings: { plan: 'pro' } });
      const [sql, params] = mocks.pool.query.mock.calls[0]!;
      expect(sql).toContain('settings = $1');
      expect(params[0]).toBe('{"plan":"pro"}');
    });

    it('should UPDATE status', async () => {
      mocks.pool.query.mockResolvedValue({ rows: [row] });
      // PORT NOTE (magick-agency): type-only cast — agency's tsconfig typechecks tests (B1), master's did not.
      await repo.update('t-1', { status: 'inactive' as never });
      const [, params] = mocks.pool.query.mock.calls[0]!;
      expect(params[0]).toBe('inactive');
    });

    it('should return null when no row matched', async () => {
      mocks.pool.query.mockResolvedValue({ rows: [] });
      expect(await repo.update('no-such', { name: 'X' })).toBeNull();
    });
  });

  describe('listByUserId', () => {
    it('should JOIN memberships and filter active/non-deleted', async () => {
      mocks.pool.query.mockResolvedValue({ rows: [row] });
      const result = await repo.listByUserId('user-1');
      expect(result).toEqual([row]);
      const [sql, params] = mocks.pool.query.mock.calls[0]!;
      expect(sql).toContain('INNER JOIN memberships');
      expect(sql).toContain("m.status = 'active'");
      expect(params).toEqual(['user-1']);
    });

    it('should return empty array when user has no tenants', async () => {
      mocks.pool.query.mockResolvedValue({ rows: [] });
      expect(await repo.listByUserId('no-user')).toEqual([]);
    });
  });

  describe('softDelete', () => {
    it('should return true when row was updated', async () => {
      mocks.pool.query.mockResolvedValue({ rowCount: 1 });
      expect(await repo.softDelete('t-1')).toBe(true);
      const [sql, params] = mocks.pool.query.mock.calls[0]!;
      expect(sql).toContain("status = 'deleted'");
      expect(params).toEqual(['t-1']);
    });

    it('should return false when no row matched (already deleted or not found)', async () => {
      mocks.pool.query.mockResolvedValue({ rowCount: 0 });
      expect(await repo.softDelete('no-such')).toBe(false);
    });
  });
});
