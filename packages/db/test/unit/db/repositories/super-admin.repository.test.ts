import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({ pool: { query: vi.fn() } }));
vi.mock('../../../../src/connection.js', () => ({ getPool: () => mocks.pool }));

import { SuperAdminRepository } from '../../../../src/repositories/super-admin.repository.js';

const fullRow = {
  id: 'sa-1', email: 'admin@example.com', name: 'Admin',
  password_hash: 'hashed-pw', status: 'active',
  created_at: new Date(), updated_at: new Date(),
};
const safeRow = {
  id: 'sa-1', email: 'admin@example.com', name: 'Admin',
  status: 'active', created_at: new Date(), updated_at: new Date(),
};

describe('SuperAdminRepository', () => {
  let repo: SuperAdminRepository;

  beforeEach(() => {
    repo = new SuperAdminRepository();
    vi.clearAllMocks();
  });

  describe('findByEmail', () => {
    it('should SELECT * (including password_hash) by email', async () => {
      mocks.pool.query.mockResolvedValue({ rows: [fullRow] });
      const result = await repo.findByEmail('admin@example.com');
      expect(result).toEqual(fullRow);
      const [sql, params] = mocks.pool.query.mock.calls[0]!;
      expect(sql).toContain('SELECT *');
      expect(sql).toContain('super_admins');
      expect(params[0]).toBe('admin@example.com');
    });

    it('should return null when email not found', async () => {
      mocks.pool.query.mockResolvedValue({ rows: [] });
      expect(await repo.findByEmail('no@example.com')).toBeNull();
    });
  });

  describe('findById', () => {
    it('should SELECT safe columns (no password_hash) by id', async () => {
      mocks.pool.query.mockResolvedValue({ rows: [safeRow] });
      const result = await repo.findById('sa-1');
      expect(result).toEqual(safeRow);
      const [sql, params] = mocks.pool.query.mock.calls[0]!;
      expect(sql).not.toContain('password_hash');
      expect(sql).toContain('id, email, name, status');
      expect(params[0]).toBe('sa-1');
    });

    it('should return null when id not found', async () => {
      mocks.pool.query.mockResolvedValue({ rows: [] });
      expect(await repo.findById('no-such')).toBeNull();
    });
  });

  describe('create', () => {
    it('should INSERT and return safe columns only', async () => {
      mocks.pool.query.mockResolvedValue({ rows: [safeRow] });
      const result = await repo.create({
        email: 'admin@example.com',
        password_hash: 'hashed-pw',
        name: 'Admin',
      });
      expect(result).toEqual(safeRow);
      const [sql, params] = mocks.pool.query.mock.calls[0]!;
      expect(sql).toContain('INSERT INTO super_admins');
      expect(sql).not.toContain('RETURNING *');
      expect(sql).toContain('id, email, name, status');
      expect(params[0]).toBe('admin@example.com');
      expect(params[1]).toBe('hashed-pw');
      expect(params[2]).toBe('Admin');
    });
  });

  describe('findAll', () => {
    it('should SELECT all super admins ordered by created_at ASC', async () => {
      mocks.pool.query.mockResolvedValue({ rows: [safeRow] });
      const result = await repo.findAll();
      expect(result).toEqual([safeRow]);
      const [sql] = mocks.pool.query.mock.calls[0]!;
      expect(sql).toContain('super_admins');
      expect(sql).toContain('ORDER BY created_at ASC');
      expect(sql).not.toContain('password_hash');
    });

    it('should return empty array when no super admins', async () => {
      mocks.pool.query.mockResolvedValue({ rows: [] });
      expect(await repo.findAll()).toEqual([]);
    });
  });
});
