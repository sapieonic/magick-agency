import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';
import { beginStatement, withTransaction } from '../../../src/utils/transaction.js';

// The control flow around the caller's statements: which of BEGIN / COMMIT /
// ROLLBACK / release run, in what order, on which path. What those statements DO
// to a real transaction is pinned in `test/integration/db/transaction.test.ts`.

const client = { query: vi.fn(), release: vi.fn() };
const pool = { connect: vi.fn() };

function statements(): string[] {
  return client.query.mock.calls.map((c) => String(c[0]));
}

beforeEach(() => {
  vi.clearAllMocks();
  client.query.mockResolvedValue({ rows: [], rowCount: 0 });
  pool.connect.mockResolvedValue(client);
});

describe('beginStatement', () => {
  it('is a bare BEGIN with no options', () => {
    expect(beginStatement()).toBe('BEGIN');
  });

  it('puts the isolation level and the access mode in ONE BEGIN', () => {
    expect(beginStatement({ isolation: 'REPEATABLE READ' })).toBe('BEGIN ISOLATION LEVEL REPEATABLE READ');
    expect(beginStatement({ readOnly: true })).toBe('BEGIN READ ONLY');
    expect(beginStatement({ isolation: 'REPEATABLE READ', readOnly: true }))
      .toBe('BEGIN ISOLATION LEVEL REPEATABLE READ, READ ONLY');
  });
});

describe('withTransaction', () => {
  it('BEGINs, runs the body on the checked-out client, COMMITs and releases', async () => {
    const result = await withTransaction(async (c) => {
      await c.query('SELECT 1');
      return 'done';
    }, { pool: pool as never });

    expect(result).toBe('done');
    expect(statements()).toEqual(['BEGIN', 'SELECT 1', 'COMMIT']);
    expect(pool.connect).toHaveBeenCalledTimes(1);
    expect(client.release).toHaveBeenCalledTimes(1);
    expect(client.release).toHaveBeenCalledWith();
  });

  it('opens with the requested isolation level and access mode', async () => {
    await withTransaction(async () => undefined, {
      pool: pool as never, isolation: 'REPEATABLE READ', readOnly: true,
    });
    expect(statements()[0]).toBe('BEGIN ISOLATION LEVEL REPEATABLE READ, READ ONLY');
  });

  it('rolls back on a throw, rethrows the SAME error and still releases', async () => {
    const boom = Object.assign(new Error('boom'), { code: '23505', constraint: 'uq_x' });
    await expect(withTransaction(async (c) => {
      await c.query('INSERT 1');
      throw boom;
    }, { pool: pool as never })).rejects.toBe(boom);

    expect(statements()).toEqual(['BEGIN', 'INSERT 1', 'ROLLBACK']);
    expect(client.release).toHaveBeenCalledTimes(1);
    expect(client.release).toHaveBeenCalledWith();
  });

  it('rolls back when COMMIT itself fails', async () => {
    client.query.mockImplementation(async (sql: string) => {
      if (sql === 'COMMIT') throw new Error('serialization failure');
      return { rows: [] };
    });
    await expect(withTransaction(async () => 1, { pool: pool as never }))
      .rejects.toThrow('serialization failure');
    expect(statements()).toEqual(['BEGIN', 'COMMIT', 'ROLLBACK']);
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it('keeps the body\'s error when ROLLBACK fails too, and DESTROYS that client', async () => {
    // A client whose ROLLBACK failed may still hold an open transaction; returned
    // to the pool, the next borrower would run its statements inside it.
    client.query.mockImplementation(async (sql: string) => {
      if (sql === 'ROLLBACK') throw new Error('connection terminated');
      return { rows: [] };
    });
    await expect(withTransaction(async () => {
      throw new Error('the real failure');
    }, { pool: pool as never })).rejects.toThrow('the real failure');
    expect(client.release).toHaveBeenCalledTimes(1);
    expect(client.release).toHaveBeenCalledWith(true);
  });

  it('releases when BEGIN itself fails', async () => {
    client.query.mockImplementation(async (sql: string) => {
      if (sql === 'BEGIN') throw new Error('cannot begin');
      return { rows: [] };
    });
    await expect(withTransaction(async () => 1, { pool: pool as never })).rejects.toThrow('cannot begin');
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it('tx.rollback() ends the transaction without COMMIT; later statements run after it', async () => {
    const result = await withTransaction(async (c, tx) => {
      await c.query('INSERT marker');
      await tx.rollback();
      await c.query('SELECT recorded');
      return 'replayed';
    }, { pool: pool as never });

    expect(result).toBe('replayed');
    expect(statements()).toEqual(['BEGIN', 'INSERT marker', 'ROLLBACK', 'SELECT recorded']);
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it('does not ROLLBACK twice when the body throws after tx.rollback()', async () => {
    await expect(withTransaction(async (c, tx) => {
      await tx.rollback();
      await c.query('SELECT after');
      throw new Error('late');
    }, { pool: pool as never })).rejects.toThrow('late');
    expect(statements()).toEqual(['BEGIN', 'ROLLBACK', 'SELECT after']);
    expect(client.release).toHaveBeenCalledWith();
  });

  it('retries a failed tx.rollback() once in the catch, and destroys the client if that fails', async () => {
    client.query.mockImplementation(async (sql: string) => {
      if (sql === 'ROLLBACK') throw new Error('gone');
      return { rows: [] };
    });
    await expect(withTransaction(async (_c, tx) => {
      await tx.rollback();
      return 1;
    }, { pool: pool as never })).rejects.toThrow('gone');
    expect(statements()).toEqual(['BEGIN', 'ROLLBACK', 'ROLLBACK']);
    expect(client.release).toHaveBeenCalledWith(true);
  });

  describe('joining the caller\'s transaction (client)', () => {
    const outer = { query: vi.fn(), release: vi.fn() };

    beforeEach(() => {
      outer.query.mockResolvedValue({ rows: [] });
    });

    it('issues no BEGIN, COMMIT or release, and checks nothing out of the pool', async () => {
      const result = await withTransaction(async (c, tx) => {
        expect(tx.own).toBe(false);
        await c.query('UPDATE x');
        return 7;
      }, { pool: pool as never, client: outer as unknown as PoolClient, isolation: 'REPEATABLE READ' });

      expect(result).toBe(7);
      expect(outer.query.mock.calls.map((c) => c[0])).toEqual(['UPDATE x']);
      expect(outer.release).not.toHaveBeenCalled();
      expect(pool.connect).not.toHaveBeenCalled();
    });

    it('leaves a throw to the caller: no ROLLBACK, no release', async () => {
      await expect(withTransaction(async () => {
        throw new Error('caller decides');
      }, { pool: pool as never, client: outer as unknown as PoolClient })).rejects.toThrow('caller decides');
      expect(outer.query).not.toHaveBeenCalled();
      expect(outer.release).not.toHaveBeenCalled();
    });

    it('makes tx.rollback() a no-op — the caller owns the transaction', async () => {
      await withTransaction(async (_c, tx) => {
        await tx.rollback();
      }, { pool: pool as never, client: outer as unknown as PoolClient });
      expect(outer.query).not.toHaveBeenCalled();
    });
  });
});
