import { describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import { truncateAll } from '../../helpers/test-db.js';

/** A client whose wipe fails with the given SQLSTATEs, in order, then succeeds. */
function fakeClient(failures: string[]) {
  const query = vi.fn(async (sql: string) => {
    if (sql.startsWith('SELECT')) return { rows: [{ t: 'public.tenants' }, { t: 'public.super_admins' }] };
    const code = failures.shift();
    if (code) throw Object.assign(new Error(code), { code });
    return { rows: [] };
  });
  return { query } as unknown as pg.PoolClient & { query: typeof query };
}

/** The wipe is one statement: a CTE per table, each a DELETE. */
const wipes = (c: { query: { mock: { calls: unknown[][] } } }) =>
  c.query.mock.calls.map(([sql]) => String(sql)).filter((sql) => sql.startsWith('WITH'));

describe('truncateAll (lead harness)', () => {
  it('empties every listed table in one statement', async () => {
    const c = fakeClient([]);
    await truncateAll(c);
    expect(wipes(c)).toEqual([
      'WITH d0 AS (DELETE FROM public.tenants), d1 AS (DELETE FROM public.super_admins) SELECT 1',
    ]);
  });

  it('retries a wipe that Postgres killed as a deadlock victim (40P01)', async () => {
    const c = fakeClient(['40P01']);
    await truncateAll(c);
    expect(wipes(c)).toHaveLength(2);
  });

  it('retries a wipe that a straggling insert failed on its FK check (23503)', async () => {
    const c = fakeClient(['23503']);
    await truncateAll(c);
    expect(wipes(c)).toHaveLength(2);
  });

  it('gives up after three failures and surfaces the error', async () => {
    const c = fakeClient(['40P01', '23503', '40P01']);
    await expect(truncateAll(c)).rejects.toMatchObject({ code: '40P01' });
    expect(wipes(c)).toHaveLength(3);
  });

  it('never retries any other error', async () => {
    const c = fakeClient(['42P01']);
    await expect(truncateAll(c)).rejects.toMatchObject({ code: '42P01' });
    expect(wipes(c)).toHaveLength(1);
  });
});
