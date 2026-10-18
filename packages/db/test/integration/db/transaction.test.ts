// Real Postgres: what `withTransaction`'s BEGIN / COMMIT / ROLLBACK actually do to
// a transaction. The call order alone is pinned in test/unit/utils/transaction.test.ts.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeTestPool, getTestPool } from '../setup/test-utils.js';
import { withTransaction } from '../../../src/utils/transaction.js';

const TABLE = 'tx_helper_probe';

/** The error `promise` rejects with; fails the test if it resolves. */
async function errorOf(promise: Promise<unknown>): Promise<{ code?: string }> {
  try {
    await promise;
  } catch (err) {
    return err as { code?: string };
  }
  throw new Error('expected the transaction to throw');
}

async function rows(): Promise<string[]> {
  const { rows: r } = await getTestPool().query<{ v: string }>(`SELECT v FROM ${TABLE} ORDER BY v`);
  return r.map((x) => x.v);
}

describe('withTransaction (integration)', () => {
  beforeAll(async () => {
    await getTestPool().query(`CREATE TABLE IF NOT EXISTS ${TABLE} (v TEXT PRIMARY KEY)`);
  });
  beforeEach(async () => {
    await getTestPool().query(`DELETE FROM ${TABLE}`);
  });
  afterAll(async () => {
    await getTestPool().query(`DROP TABLE IF EXISTS ${TABLE}`);
    await closeTestPool();
  });

  it('commits: the writes are visible to another connection afterwards', async () => {
    const pool = getTestPool();
    await withTransaction(async (c) => {
      await c.query(`INSERT INTO ${TABLE} (v) VALUES ('a'), ('b')`);
      // Not yet visible outside the transaction.
      expect(await rows()).toEqual([]);
    }, { pool });
    expect(await rows()).toEqual(['a', 'b']);
  });

  it('rolls back on a throw: nothing the body wrote survives, and the error is the body\'s', async () => {
    const pool = getTestPool();
    const err = await errorOf(withTransaction(async (c) => {
      await c.query(`INSERT INTO ${TABLE} (v) VALUES ('a')`);
      // A real 23505, rethrown unchanged for the caller's own error mapping.
      await c.query(`INSERT INTO ${TABLE} (v) VALUES ('a')`);
    }, { pool }));
    expect(err.code).toBe('23505');
    expect(await rows()).toEqual([]);
  });

  it('releases the client on a throw, so failed transactions do not drain the pool', async () => {
    const pool = getTestPool();
    // More failures than the pool has connections (max 5): a leak would hang here.
    for (let i = 0; i < 8; i++) {
      await expect(withTransaction(async () => {
        throw new Error(`fail ${i}`);
      }, { pool })).rejects.toThrow(`fail ${i}`);
    }
    expect(pool.totalCount - pool.idleCount).toBe(0);
    // And a released client is clean: it is not still inside the aborted transaction.
    const { rows: [state] } = await pool.query<{ txid: string | null }>(
      'SELECT txid_current_if_assigned()::text AS txid',
    );
    expect(state!.txid).toBeNull();
  });

  it('runs at the requested isolation level, and READ ONLY refuses a write (25006)', async () => {
    const pool = getTestPool();
    const level = await withTransaction(async (c) => {
      const { rows: [r] } = await c.query<{ transaction_isolation: string }>('SHOW transaction_isolation');
      return r!.transaction_isolation;
    }, { pool, isolation: 'REPEATABLE READ' });
    expect(level).toBe('repeatable read');

    const err = await errorOf(withTransaction(async (c) => {
      await c.query(`INSERT INTO ${TABLE} (v) VALUES ('ro')`);
    }, { pool, isolation: 'REPEATABLE READ', readOnly: true }));
    expect(err.code).toBe('25006');
    expect(await rows()).toEqual([]);
  });

  it('REPEATABLE READ holds one snapshot across the body\'s statements', async () => {
    const pool = getTestPool();
    const [before, after] = await withTransaction(async (c) => {
      const first = await c.query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM ${TABLE}`);
      await pool.query(`INSERT INTO ${TABLE} (v) VALUES ('concurrent')`);
      const second = await c.query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM ${TABLE}`);
      return [first.rows[0]!.n, second.rows[0]!.n];
    }, { pool, isolation: 'REPEATABLE READ', readOnly: true });
    expect([before, after]).toEqual(['0', '0']);
  });

  it('tx.rollback() discards the writes, and later statements run outside the transaction', async () => {
    const pool = getTestPool();
    await withTransaction(async (c, tx) => {
      await c.query(`INSERT INTO ${TABLE} (v) VALUES ('discarded')`);
      await tx.rollback();
      // Autocommit from here: this one stays.
      await c.query(`INSERT INTO ${TABLE} (v) VALUES ('after')`);
    }, { pool });
    expect(await rows()).toEqual(['after']);
  });

  it('a joined client neither BEGINs nor COMMITs: the OUTER rollback takes the inner writes with it', async () => {
    const pool = getTestPool();
    const outer = await pool.connect();
    try {
      await outer.query('BEGIN');
      await withTransaction(async (c, tx) => {
        expect(c).toBe(outer);
        expect(tx.own).toBe(false);
        await c.query(`INSERT INTO ${TABLE} (v) VALUES ('inner')`);
        // A no-op when joined: the outer transaction is still open after it.
        await tx.rollback();
      }, { pool, client: outer });
      // Had the helper COMMITted, this would already be visible on the pool.
      expect(await rows()).toEqual([]);
      const { rows: [r] } = await outer.query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM ${TABLE}`);
      expect(r!.n).toBe('1');
      await outer.query('ROLLBACK');
    } finally {
      outer.release();
    }
    expect(await rows()).toEqual([]);
  });

  it('a joined client is left to the caller on a throw: still in its (aborted) transaction, not released', async () => {
    const pool = getTestPool();
    const outer = await pool.connect();
    try {
      await outer.query('BEGIN');
      await expect(withTransaction(async (c) => {
        await c.query(`INSERT INTO ${TABLE} (v) VALUES ('x'), ('x')`);
      }, { pool, client: outer })).rejects.toMatchObject({ code: '23505' });
      // The helper issued no ROLLBACK: the outer transaction is aborted, not ended.
      await expect(outer.query('SELECT 1')).rejects.toMatchObject({ code: '25P02' });
      await outer.query('ROLLBACK');
    } finally {
      outer.release();
    }
  });
});
