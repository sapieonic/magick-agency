import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';
import { uuidFor } from '../setup/factories.js';

/*
 * Real Postgres. Tenant/account labels go through `uuidFor` (the baseline types
 * them UUID). The same-lineage successor case passes the caller's tenant/account to
 * `findActiveSuccessor` (it never resolves by id alone), and a further case proves
 * a foreign tenant / account resolves nothing.
 */
const T1 = uuidFor('tenant-1');
const T2 = uuidFor('tenant-2');
const A1 = uuidFor('account-1');
const A2 = uuidFor('account-2');

vi.mock('../../../src/connection.js', () => ({ getPool: () => getTestPool() }));
const { callAnalysisProfileRepository: repo } = await import('../../../src/repositories/call-analysis-profile.repository.js');

const dims = [{ key: 'payment_plan', description: 'Payment plan agreed', type: 'boolean' as const }];

async function create(overrides: Record<string, unknown> = {}) {
  return repo.create({ tenant_id: T1, account_id: A1, name: 'Collections', custom_dimensions: dims, ...overrides });
}

describe('callAnalysisProfileRepository (integration)', () => {
  beforeEach(truncateAll);
  afterAll(closeTestPool);

  it('commits copy-on-write updates with exactly one active row, then supports v2 → v3', async () => {
    const v1 = await create({ context: 'v1' });
    const v2 = await repo.update(v1.id, T1, A1, { context: 'v2' });
    expect(v2).toMatchObject({ version: 2, context: 'v2', is_active: true });
    const v3 = await repo.update(v2!.id, T1, A1, { context: 'v3' });
    expect(v3).toMatchObject({ version: 3, context: 'v3', is_active: true });

    const { rows } = await getTestPool().query(
      `SELECT version, is_active FROM call_analysis_profiles WHERE tenant_id = $1 AND account_id = $2 AND name = $3 ORDER BY version`,
      [T1, A1, 'Collections'],
    );
    expect(rows).toEqual([{ version: 1, is_active: false }, { version: 2, is_active: false }, { version: 3, is_active: true }]);
  });

  it('transfers default atomically and keeps exactly one active default', async () => {
    const first = await create({ name: 'First', is_default: true });
    const second = await create({ name: 'Second', is_default: true });
    expect((await repo.findDefault(T1, A1))!.id).toBe(second.id);

    const { rows } = await getTestPool().query(
      `SELECT id FROM call_analysis_profiles WHERE tenant_id = $1 AND account_id = $2 AND is_active AND is_default`,
      [T1, A1],
    );
    expect(rows).toEqual([{ id: second.id }]);
    expect(first.id).not.toBe(second.id);
  });

  it('rejects duplicate active names and permits name reuse after soft delete', async () => {
    const first = await create();
    await expect(create()).rejects.toMatchObject({ code: '23505' });
    expect(await repo.softDelete(first.id, T1, A1)).toBe(true);
    const replacement = await create();
    expect(replacement.name).toBe('Collections');
    expect(replacement.id).not.toBe(first.id);
  });

  it('finds only the same-lineage active successor and scopes all reads by tenant/account', async () => {
    const old = await create();
    const successor = await repo.update(old.id, T1, A1, { context: 'next' });
    await create({ tenant_id: T2, account_id: A1, name: 'Collections' });
    await create({ tenant_id: T1, account_id: A2, name: 'Collections' });

    expect((await repo.findActiveSuccessor(old.id, T1, A1))!.id).toBe(successor!.id);
    expect(await repo.findByIdScoped(successor!.id, T2, A1)).toBeNull();
    expect(await repo.findByIdScoped(successor!.id, T1, A2)).toBeNull();
    expect((await repo.listByTenant(T1, A1)).rows).toHaveLength(1);
    expect((await repo.listByTenant(T2, A1)).rows).toHaveLength(1);
  });

  it("never resolves another tenant's or account's superseded profile to its current version (IDOR)", async () => {
    const old = await create();
    const successor = await repo.update(old.id, T1, A1, { context: 'next' });
    expect((await repo.findActiveSuccessor(old.id, T1, A1))!.id).toBe(successor!.id);
    expect(await repo.findActiveSuccessor(old.id, T2, A1)).toBeNull();
    expect(await repo.findActiveSuccessor(old.id, T1, A2)).toBeNull();
    // An unknown id and a foreign id are indistinguishable to the caller.
    expect(await repo.findActiveSuccessor('99999999-9999-4999-8999-999999999999', T1, A1)).toBeNull();
  });

  it('updated_at trigger fires when a profile is soft deleted', async () => {
    const profile = await create({ name: `Trigger ${randomUUID()}` });
    await getTestPool().query(`UPDATE call_analysis_profiles SET updated_at = now() - interval '1 hour' WHERE id = $1`, [profile.id]);
    await repo.softDelete(profile.id, T1, A1);
    const { rows } = await getTestPool().query<{ updated_at: Date }>('SELECT updated_at FROM call_analysis_profiles WHERE id = $1', [profile.id]);
    expect(rows[0]!.updated_at.getTime()).toBeGreaterThan(Date.now() - 60_000);
  });
});
