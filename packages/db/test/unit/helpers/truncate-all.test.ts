import { describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import { truncateAll } from '../../helpers/test-db.js';

/** A client whose TRUNCATE fails with the given SQLSTATEs, in order, then succeeds. */
function fakeClient(failures: string[]) {
  const query = vi.fn(async (sql: string) => {
    if (sql.startsWith('SELECT')) return { rows: [{ t: 'public.tenants' }, { t: 'public.super_admins' }] };
    const code = failures.shift();
    if (code) throw Object.assign(new Error(code), { code });
    return { rows: [] };
  });
  return { query } as unknown as pg.PoolClient & { query: typeof query };
}

const truncates = (c: { query: { mock: { calls: unknown[][] } } }) =>
  c.query.mock.calls.filter(([sql]) => String(sql).startsWith('TRUNCATE')).length;

describe('truncateAll (lead harness)', () => {
  it('retries a TRUNCATE that Postgres killed as a deadlock victim (40P01)', async () => {
    const c = fakeClient(['40P01']);
    await truncateAll(c);
    expect(truncates(c)).toBe(2);
  });

  it('gives up after three deadlocks and surfaces the error', async () => {
    const c = fakeClient(['40P01', '40P01', '40P01']);
    await expect(truncateAll(c)).rejects.toMatchObject({ code: '40P01' });
    expect(truncates(c)).toBe(3);
  });

  it('never retries any other error', async () => {
    const c = fakeClient(['42P01']);
    await expect(truncateAll(c)).rejects.toMatchObject({ code: '42P01' });
    expect(truncates(c)).toBe(1);
  });
});
