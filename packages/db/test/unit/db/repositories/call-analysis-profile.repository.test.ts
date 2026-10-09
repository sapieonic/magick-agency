import { describe, it, expect, vi, beforeEach } from 'vitest';

/*
 * The `findActiveSuccessor` case binds the caller's tenant/account (it never
 * resolves by id alone); one case pins that.
 */

const mocks = vi.hoisted(() => ({
  poolQuery: vi.fn(),
  clientQuery: vi.fn(),
  release: vi.fn(),
}));

vi.mock('../../../../src/connection.js', () => ({
  getPool: () => ({
    query: mocks.poolQuery,
    connect: async () => ({ query: mocks.clientQuery, release: mocks.release }),
  }),
}));

import { CallAnalysisProfileRepository } from '../../../../src/repositories/call-analysis-profile.repository.js';

const repo = new CallAnalysisProfileRepository();

function clientCalls(): string[] {
  return mocks.clientQuery.mock.calls.map((c) => String(c[0]));
}

describe('CallAnalysisProfileRepository', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.poolQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    mocks.clientQuery.mockResolvedValue({ rows: [], rowCount: 0 });
  });

  describe('create — default clearing in the same transaction', () => {
    it('demotes the prior default BEFORE inserting the new default, then commits', async () => {
      mocks.clientQuery
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce({ rowCount: 1 }) // demote prior default
        .mockResolvedValueOnce({ rows: [{ id: 'p1', is_default: true }], rowCount: 1 }) // INSERT
        .mockResolvedValueOnce({}); // COMMIT

      const row = await repo.create({
        tenant_id: 't1', account_id: 'a1', name: 'Collections', is_default: true,
        custom_dimensions: [{ key: 'promised', description: 'd', type: 'boolean' }],
      });

      const calls = clientCalls();
      expect(calls[0]).toBe('BEGIN');
      expect(calls[1]).toContain('SET is_default = false');
      expect(calls[2]).toContain('INSERT INTO call_analysis_profiles');
      expect(calls[3]).toBe('COMMIT');
      // custom_dimensions is JSON-serialized.
      expect(mocks.clientQuery.mock.calls[2]![1]).toContain(
        JSON.stringify([{ key: 'promised', description: 'd', type: 'boolean' }]),
      );
      expect(row).toEqual({ id: 'p1', is_default: true });
    });

    it('does NOT demote when is_default is false/omitted', async () => {
      mocks.clientQuery
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce({ rows: [{ id: 'p2' }], rowCount: 1 }) // INSERT
        .mockResolvedValueOnce({}); // COMMIT

      await repo.create({ tenant_id: 't1', account_id: 'a1', name: 'Plain' });

      const calls = clientCalls();
      expect(calls.some((c) => c.includes('SET is_default = false'))).toBe(false);
    });

    it('rolls back on error', async () => {
      mocks.clientQuery
        .mockResolvedValueOnce({}) // BEGIN
        .mockRejectedValueOnce(new Error('unique_violation'));

      await expect(
        repo.create({ tenant_id: 't1', account_id: 'a1', name: 'Dup' }),
      ).rejects.toThrow('unique_violation');
      expect(clientCalls()).toContain('ROLLBACK');
      expect(mocks.release).toHaveBeenCalled();
    });
  });

  describe('update — copy-on-write + scoped, deactivates old row', () => {
    it('inserts version+1 carrying forward fields and deactivates the superseded row', async () => {
      mocks.clientQuery
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce({
          rows: [{
            id: 'p1', tenant_id: 't1', account_id: 'a1', name: 'Collections',
            description: 'old', context: null, custom_dimensions: [], language_hint: null,
            is_default: false, version: 2,
          }],
          rowCount: 1,
        }) // SELECT ... FOR UPDATE
        .mockResolvedValueOnce({ rowCount: 1 }) // deactivate old
        .mockResolvedValueOnce({ rows: [{ id: 'p1-v3', version: 3 }], rowCount: 1 }) // INSERT
        .mockResolvedValueOnce({}); // COMMIT

      const row = await repo.update('p1', 't1', 'a1', { description: 'new' });

      const calls = clientCalls();
      expect(calls[1]).toContain('FOR UPDATE');
      expect(calls[1]).toContain('tenant_id = $2 AND account_id = $3');
      // The old row is deactivated BEFORE the new active version is inserted, so
      // the partial (version-less) name unique index is never momentarily violated.
      expect(calls[2]).toContain('SET is_active = false');
      const insert = mocks.clientQuery.mock.calls[3]!;
      expect(insert[0]).toContain('INSERT INTO call_analysis_profiles');
      // version bumped to existing.version + 1
      expect(insert[1]![insert[1]!.length - 1]).toBe(3);
      // description overridden, name carried forward
      expect(insert[1]).toContain('new');
      expect(insert[1]).toContain('Collections');
      // Ordering regression guard: the deactivate is strictly before the insert.
      const deactivateIdx = calls.findIndex((c) => c.includes('SET is_active = false'));
      const insertIdx = calls.findIndex((c) => c.includes('INSERT INTO call_analysis_profiles'));
      expect(deactivateIdx).toBeGreaterThanOrEqual(0);
      expect(deactivateIdx).toBeLessThan(insertIdx);
      expect(calls[calls.length - 1]).toBe('COMMIT');
      expect(row).toEqual({ id: 'p1-v3', version: 3 });
    });

    it('returns null (stale/absent/cross-tenant) when the scoped active row is missing', async () => {
      mocks.clientQuery
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // SELECT ... FOR UPDATE → none
        .mockResolvedValueOnce({}); // ROLLBACK

      const row = await repo.update('gone', 't1', 'a1', { description: 'x' });
      expect(row).toBeNull();
      expect(clientCalls()).toContain('ROLLBACK');
    });
  });

  describe('findActiveSuccessor — same-lineage guard (name + higher version)', () => {
    it('joins dead → active on name with a strictly higher version and inactive dead row', async () => {
      mocks.poolQuery.mockResolvedValueOnce({ rows: [{ id: 'p1-v3' }] });
      await repo.findActiveSuccessor('p1-v2', 't1', 'a1');
      const sql = mocks.poolQuery.mock.calls[0]![0] as string;
      expect(sql).toContain('active.name = dead.name');
      expect(sql).toContain('active.version > dead.version');
      expect(sql).toContain('dead.is_active = false');
      expect(sql).toContain('ORDER BY active.version DESC');
      expect(mocks.poolQuery.mock.calls[0]![1]).toEqual(['p1-v2', 't1', 'a1']);
    });

    it("scopes the dead row to the CALLER's tenant and account (cross-tenant lookup resolves nothing)", async () => {
      mocks.poolQuery.mockResolvedValueOnce({ rows: [] });
      expect(await repo.findActiveSuccessor('foreign', 't1', 'a1')).toBeNull();
      const sql = (mocks.poolQuery.mock.calls[0]![0] as string).replace(/\s+/g, ' ');
      expect(sql).toContain('dead.id = $1 AND dead.tenant_id = $2 AND dead.account_id = $3');
    });
  });

  describe('findDefault', () => {
    it('filters on is_default AND is_active', async () => {
      mocks.poolQuery.mockResolvedValueOnce({ rows: [{ id: 'def' }] });
      const row = await repo.findDefault('t1', 'a1');
      const sql = mocks.poolQuery.mock.calls[0]![0] as string;
      expect(sql).toContain('is_default = true');
      expect(sql).toContain('is_active = true');
      expect(row).toEqual({ id: 'def' });
    });
  });

  describe('softDelete', () => {
    it('flips is_active scoped to the owner and reports whether a row changed', async () => {
      mocks.poolQuery.mockResolvedValueOnce({ rowCount: 1 });
      const ok = await repo.softDelete('p1', 't1', 'a1');
      const sql = mocks.poolQuery.mock.calls[0]![0] as string;
      expect(sql).toContain('SET is_active = false');
      expect(sql).toContain('tenant_id = $2 AND account_id = $3');
      expect(ok).toBe(true);
    });
  });
});
