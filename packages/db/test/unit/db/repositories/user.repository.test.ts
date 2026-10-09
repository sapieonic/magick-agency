// PORT NOTE (magick-agency): ported from master test/unit/db/repositories/user.repository.test.ts@a1f0756a — verbatim, import specifiers remapped only.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({ pool: { query: vi.fn() } }));
vi.mock('../../../../src/connection.js', () => ({ getPool: () => mocks.pool }));

import { UserRepository } from '../../../../src/repositories/user.repository.js';

const row = {
  id: 'u-1', firebase_uid: 'fb-123', email: 'a@b.com',
  phone_number: '1234567890', display_name: 'Alice', avatar_url: null,
  status: 'active', created_at: new Date(), updated_at: new Date(),
};

describe('UserRepository', () => {
  let repo: UserRepository;

  beforeEach(() => {
    repo = new UserRepository();
    vi.clearAllMocks();
  });

  describe('create', () => {
    it('should INSERT and return the created user', async () => {
      mocks.pool.query.mockResolvedValue({ rows: [row] });

      const result = await repo.create({ firebase_uid: 'fb-123', email: 'a@b.com' });

      expect(result).toEqual(row);
      const [sql, params] = mocks.pool.query.mock.calls[0]!;
      expect(sql).toContain('INSERT INTO users');
      expect(params[0]).toBe('fb-123');
      expect(params[1]).toBe('a@b.com');
    });

    it('should default phone_number to 0000000000 when not provided', async () => {
      mocks.pool.query.mockResolvedValue({ rows: [row] });
      await repo.create({ firebase_uid: 'fb-123', email: 'a@b.com' });
      const [, params] = mocks.pool.query.mock.calls[0]!;
      expect(params[2]).toBe('0000000000');
    });

    it('should use the provided phone_number', async () => {
      mocks.pool.query.mockResolvedValue({ rows: [row] });
      await repo.create({ firebase_uid: 'fb-1', email: 'x@y.com', phone_number: '9999999999' });
      const [, params] = mocks.pool.query.mock.calls[0]!;
      expect(params[2]).toBe('9999999999');
    });

    it('should set display_name to null when not provided', async () => {
      mocks.pool.query.mockResolvedValue({ rows: [row] });
      await repo.create({ firebase_uid: 'fb-1', email: 'x@y.com' });
      const [, params] = mocks.pool.query.mock.calls[0]!;
      expect(params[3]).toBeNull();
    });
  });

  describe('findById', () => {
    it('should SELECT by id and return the user', async () => {
      mocks.pool.query.mockResolvedValue({ rows: [row] });
      const result = await repo.findById('u-1');
      expect(result).toEqual(row);
      expect(mocks.pool.query).toHaveBeenCalledWith(expect.stringContaining('WHERE id = $1'), ['u-1']);
    });

    it('should return null when no user found', async () => {
      mocks.pool.query.mockResolvedValue({ rows: [] });
      expect(await repo.findById('no-such')).toBeNull();
    });
  });

  describe('findByFirebaseUid', () => {
    it('should SELECT by firebase_uid and return the user', async () => {
      mocks.pool.query.mockResolvedValue({ rows: [row] });
      const result = await repo.findByFirebaseUid('fb-123');
      expect(result).toEqual(row);
      expect(mocks.pool.query).toHaveBeenCalledWith(
        expect.stringContaining('firebase_uid = $1'), ['fb-123'],
      );
    });

    it('should return null when not found', async () => {
      mocks.pool.query.mockResolvedValue({ rows: [] });
      expect(await repo.findByFirebaseUid('unknown')).toBeNull();
    });
  });

  describe('findByEmail', () => {
    it('should SELECT by email', async () => {
      mocks.pool.query.mockResolvedValue({ rows: [row] });
      const result = await repo.findByEmail('a@b.com');
      expect(result).toEqual(row);
      expect(mocks.pool.query).toHaveBeenCalledWith(
        expect.stringContaining('email = $1'), ['a@b.com'],
      );
    });

    it('should return null when not found', async () => {
      mocks.pool.query.mockResolvedValue({ rows: [] });
      expect(await repo.findByEmail('no@body.com')).toBeNull();
    });
  });

  describe('update', () => {
    it('should return existing user without querying when no fields provided', async () => {
      mocks.pool.query.mockResolvedValue({ rows: [row] });
      const result = await repo.update('u-1', {});
      // Calls findById internally
      expect(mocks.pool.query).toHaveBeenCalledWith(expect.stringContaining('WHERE id = $1'), ['u-1']);
      expect(result).toEqual(row);
    });

    it('should UPDATE display_name only', async () => {
      mocks.pool.query.mockResolvedValue({ rows: [{ ...row, display_name: 'Bob' }] });
      const result = await repo.update('u-1', { display_name: 'Bob' });
      const [sql, params] = mocks.pool.query.mock.calls[0]!;
      expect(sql).toContain('UPDATE users');
      expect(sql).toContain('display_name = $1');
      expect(params[0]).toBe('Bob');
      expect(params[params.length - 1]).toBe('u-1');
      expect(result?.display_name).toBe('Bob');
    });

    it('should UPDATE multiple fields', async () => {
      mocks.pool.query.mockResolvedValue({ rows: [row] });
      await repo.update('u-1', { display_name: 'Carol', status: 'inactive' });
      const [sql] = mocks.pool.query.mock.calls[0]!;
      expect(sql).toContain('display_name = $1');
      expect(sql).toContain('status = $2');
    });

    it('should UPDATE avatar_url', async () => {
      mocks.pool.query.mockResolvedValue({ rows: [row] });
      await repo.update('u-1', { avatar_url: 'https://cdn/img.jpg' });
      const [, params] = mocks.pool.query.mock.calls[0]!;
      expect(params[0]).toBe('https://cdn/img.jpg');
    });

    it('should UPDATE phone_number', async () => {
      mocks.pool.query.mockResolvedValue({ rows: [row] });
      await repo.update('u-1', { phone_number: '5551234567' });
      const [, params] = mocks.pool.query.mock.calls[0]!;
      expect(params[0]).toBe('5551234567');
    });

    it('should return null when no row matched', async () => {
      mocks.pool.query.mockResolvedValue({ rows: [] });
      expect(await repo.update('no-such', { display_name: 'X' })).toBeNull();
    });
  });
});
