import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({ pool: { query: vi.fn() } }));
vi.mock('../../../../src/connection.js', () => ({ getPool: () => mocks.pool }));

import { SuperAdminAuditRepository } from '../../../../src/repositories/super-admin-audit.repository.js';

const auditRow = {
  id: 'sa-audit-1', admin_id: 'sa-1', admin_email: 'admin@example.com',
  action: 'tenant.create', resource_type: 'tenant', resource_id: 't-1',
  details: {}, created_at: new Date(),
};

describe('SuperAdminAuditRepository', () => {
  let repo: SuperAdminAuditRepository;

  beforeEach(() => {
    repo = new SuperAdminAuditRepository();
    vi.clearAllMocks();
  });

  describe('log', () => {
    it('should INSERT audit log entry', async () => {
      mocks.pool.query.mockResolvedValue({ rows: [] });
      await repo.log({
        admin_id: 'sa-1', admin_email: 'admin@example.com',
        action: 'tenant.create', resource_type: 'tenant', resource_id: 't-1',
      });
      const [sql, params] = mocks.pool.query.mock.calls[0]!;
      expect(sql).toContain('INSERT INTO super_admin_audit_log');
      expect(params[0]).toBe('sa-1');
      expect(params[1]).toBe('admin@example.com');
      expect(params[2]).toBe('tenant.create');
      expect(params[3]).toBe('tenant');
      expect(params[4]).toBe('t-1');
    });

    it('should set resource_id to null when not provided', async () => {
      mocks.pool.query.mockResolvedValue({ rows: [] });
      await repo.log({
        admin_id: 'sa-1', admin_email: 'admin@example.com',
        action: 'list.tenants', resource_type: 'tenant',
      });
      const [, params] = mocks.pool.query.mock.calls[0]!;
      expect(params[4]).toBeNull();
    });

    it('should serialize details as JSON', async () => {
      mocks.pool.query.mockResolvedValue({ rows: [] });
      await repo.log({
        admin_id: 'sa-1', admin_email: 'admin@example.com',
        action: 'x', resource_type: 'y',
        details: { reason: 'test' },
      });
      const [, params] = mocks.pool.query.mock.calls[0]!;
      expect(params[5]).toBe('{"reason":"test"}');
    });

    it('should default details to empty object when not provided', async () => {
      mocks.pool.query.mockResolvedValue({ rows: [] });
      await repo.log({
        admin_id: 'sa-1', admin_email: 'admin@example.com',
        action: 'x', resource_type: 'y',
      });
      const [, params] = mocks.pool.query.mock.calls[0]!;
      expect(params[5]).toBe('{}');
    });
  });

  describe('list', () => {
    it('should run data + count + distinct-actions queries in parallel', async () => {
      mocks.pool.query
        .mockResolvedValueOnce({ rows: [auditRow] })
        .mockResolvedValueOnce({ rows: [{ count: '42' }] })
        .mockResolvedValueOnce({ rows: [{ action: 'tenant.create' }] });

      const result = await repo.list();
      expect(result.entries).toEqual([auditRow]);
      expect(result.total).toBe(42);
      expect(result.actions).toEqual(['tenant.create']);
      expect(mocks.pool.query).toHaveBeenCalledTimes(3);
    });

    it('should apply default limit=100 and offset=0', async () => {
      mocks.pool.query
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ count: '0' }] })
        .mockResolvedValueOnce({ rows: [] });

      await repo.list();
      const [, params1] = mocks.pool.query.mock.calls[0]!;
      expect(params1[0]).toBe(100);
      expect(params1[1]).toBe(0);
    });

    it('should apply custom limit and offset', async () => {
      mocks.pool.query
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ count: '0' }] })
        .mockResolvedValueOnce({ rows: [] });

      await repo.list(10, 50);
      const [, params1] = mocks.pool.query.mock.calls[0]!;
      expect(params1[0]).toBe(10);
      expect(params1[1]).toBe(50);
    });

    it('should ORDER BY created_at DESC', async () => {
      mocks.pool.query
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ count: '0' }] })
        .mockResolvedValueOnce({ rows: [] });

      await repo.list();
      const [sql1] = mocks.pool.query.mock.calls[0]!;
      expect(sql1).toContain('ORDER BY created_at DESC');
    });

    it('should return 0 total when count row missing', async () => {
      mocks.pool.query
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] });

      const result = await repo.list();
      expect(result.total).toBe(0);
    });

    it('should apply actor/action/from filters in SQL, not after the page is loaded', async () => {
      mocks.pool.query
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ count: '0' }] })
        .mockResolvedValueOnce({ rows: [] });

      await repo.list(50, 0, {
        actor: 'admin@',
        action: 'topup_credits',
        from: '2026-01-01T00:00:00.000Z',
      });

      const [sql, params] = mocks.pool.query.mock.calls[0]!;
      expect(sql).toContain('admin_email ILIKE');
      expect(sql).toContain('action =');
      expect(sql).toContain('created_at >=');
      expect(params[0]).toBe('%admin@%');
      expect(params[1]).toBe('topup_credits');
      expect(params[2]).toBe('2026-01-01T00:00:00.000Z');
      expect(params[3]).toBe(50);
      expect(params[4]).toBe(0);
    });

    it('should bind q once and search email/action/resource_type/resource_id with ILIKE', async () => {
      mocks.pool.query
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ count: '0' }] })
        .mockResolvedValueOnce({ rows: [] });

      await repo.list(50, 0, { q: 'needle' });

      const [sql, params] = mocks.pool.query.mock.calls[0]!;
      expect(sql).toContain('admin_email ILIKE');
      expect(sql).toContain('action ILIKE');
      expect(sql).toContain('resource_type ILIKE');
      expect(sql).toContain("COALESCE(resource_id, '') ILIKE");
      expect(params).toContain('%needle%');
      expect(params.filter((p: unknown) => p === '%needle%')).toHaveLength(1);
    });

    it('should apply a to filter as created_at <=', async () => {
      mocks.pool.query
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ count: '0' }] })
        .mockResolvedValueOnce({ rows: [] });

      await repo.list(50, 0, { to: '2026-06-01T00:00:00.000Z' });

      const [sql, params] = mocks.pool.query.mock.calls[0]!;
      expect(sql).toContain('created_at <=');
      expect(params).toContain('2026-06-01T00:00:00.000Z');
    });

    it('should not add a q predicate when filters is empty', async () => {
      mocks.pool.query
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ count: '0' }] })
        .mockResolvedValueOnce({ rows: [] });

      await repo.list(50, 0, {});

      const [sql] = mocks.pool.query.mock.calls[0]!;
      expect(sql).not.toContain('ILIKE');
    });

    it('should bind q as a parameter, not concatenate it into SQL', async () => {
      mocks.pool.query
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ count: '0' }] })
        .mockResolvedValueOnce({ rows: [] });

      const raw = "needle'; DROP TABLE super_admin_audit_log; --";
      await repo.list(50, 0, { q: raw });

      const [sql, params] = mocks.pool.query.mock.calls[0]!;
      expect(sql).not.toContain(raw);
      expect(params).toContain(`%${raw}%`);
    });
  });
});
