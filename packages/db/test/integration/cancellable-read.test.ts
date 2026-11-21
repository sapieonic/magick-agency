// Real Postgres: what `openCancellableRead` (src/utils/cancellable-read.ts) does to a real session.
// Its settings statement bounds `statement_timeout` under the session's ceiling ('session': the
// pool's own SET kept) or the role's ('role': out from under the pool's SET), applies further
// settings for the transaction only and reads the backend's own pid; a stop cancels the running
// statement by that pid and the connection is destroyed, never returned to the pool.
import { afterAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { cancelBackend } from '../../src/utils/cancel-backend.js';
import { openCancellableRead, withCancellableRead, type CancellableReadOptions } from '../../src/utils/cancellable-read.js';
import { closeTestPool, getTestPool } from './setup/test-utils.js';

afterAll(closeTestPool);

const url = (getTestPool().options as { connectionString: string }).connectionString;

/** A pool whose sessions run under a 300 ms statement_timeout, as the pool's own SET would set it. */
function poolWithSessionTimeout(): pg.Pool {
  const pool = new pg.Pool({ connectionString: url, max: 2 });
  // As the pool's own SET does it (after connect), so the role's `reset_val` stays the server's.
  pool.on('connect', (client) => { void client.query('SET statement_timeout = 300'); });
  return pool;
}

const base = (pool: pg.Pool): CancellableReadOptions => ({
  cancel: (pid) => cancelBackend(pid, pool.options),
  timeout: { boundMs: 5_000 },
  ceiling: 'session',
});

const setting = async (tx: { query(t: string): Promise<pg.QueryResult> }, name: string): Promise<string> =>
  String((await tx.query(`SELECT current_setting('${name}') AS v`)).rows[0]!.v);

describe('openCancellableRead on Postgres', () => {
  it('session ceiling keeps the lower session value; role ceiling escapes it; further settings for the transaction only', async () => {
    const pool = poolWithSessionTimeout();
    try {
      await withCancellableRead(pool, { ...base(pool), settings: { max_parallel_workers_per_gather: 1 } }, async (tx) => {
        expect(await setting(tx, 'statement_timeout')).toBe('300ms');
        expect(await setting(tx, 'max_parallel_workers_per_gather')).toBe('1');
        expect(tx.pid).toBe(Number((await tx.query('SELECT pg_backend_pid() AS p')).rows[0]!.p));
      });
      await withCancellableRead(pool, { ...base(pool), ceiling: 'role', idleInTransaction: true }, async (tx) => {
        expect(await setting(tx, 'statement_timeout')).toBe('5s');
        expect(await setting(tx, 'idle_in_transaction_session_timeout')).toBe('5s');
      });
      // Outside the transaction the session's own values hold.
      const { rows } = await pool.query(`SELECT current_setting('statement_timeout') AS s, current_setting('max_parallel_workers_per_gather') AS w`);
      expect(rows[0]).toEqual({ s: '300ms', w: '2' });
    } finally {
      await pool.end();
    }
  });

  it('a stop cancels the running statement by the backend\'s pid and destroys the connection', async () => {
    const pool = new pg.Pool({ connectionString: url, max: 1 });
    try {
      const stop = new AbortController();
      const tx = await openCancellableRead(pool, { ...base(pool), signal: stop.signal, timeout: { boundMs: 60_000 }, graceMs: 1_000 });
      const pid = tx.pid;
      const sleeping = tx.query('SELECT pg_sleep(30)').then(() => 'finished', (err: unknown) => err);
      await new Promise((r) => setTimeout(r, 200));
      const started = Date.now();
      stop.abort(new Error('stopped'));
      expect(((await sleeping) as Error).message).toBe('stopped');
      await tx.close(true);
      expect(Date.now() - started).toBeLessThan(5_000);
      // Destroyed, not pooled: the pool holds nothing, and the backend is gone.
      expect(pool.totalCount).toBe(0);
      await expect.poll(async () => (await getTestPool().query('SELECT 1 FROM pg_stat_activity WHERE pid = $1::int', [pid])).rowCount, { timeout: 5_000 })
        .toBe(0);
    } finally {
      await pool.end();
    }
  });
});
