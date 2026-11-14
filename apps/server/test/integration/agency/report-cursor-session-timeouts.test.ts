import { afterAll, describe, expect, it } from 'vitest';

/**
 * The report cursor under the pool's session timeouts (db-hygiene.md "5. Timeouts"), on real
 * Postgres. `reportCursorRows` replaces `idle_in_transaction_session_timeout` and
 * `statement_timeout` for its own transaction, because it sits idle between FETCHes while the
 * consumer waits on the upload, and its FETCHes can run long. It replaces them with a BOUND, never
 * 0: the report's deadline (`REPORT_BUILD_TIMEOUT_MS`, or the cursor's `timeoutMs`), or the role's
 * and database's own value when that is lower. So a consumer that stalls and never pulls again
 * (where the deadline's signal has no statement to cancel) has its transaction ended by Postgres,
 * while waits and FETCHes longer than the pool's own limits still run. Outside that transaction
 * the pool's values still hold.
 *
 * The timeouts here are a few hundred milliseconds so the cases run fast; the config refuses
 * anything under a second, but `initDbPool` takes what it is given.
 *
 * Mutation-checked: without the cursor's `set_config` the idle and the slow-FETCH cases fail (the
 * session ended under the idle one, 57014 on the slow one); with the bound back at 0 the bound
 * case reads 0 and the stalled consumer's transaction stays open; without the role-or-database
 * `LEAST` the database's lower limit is replaced by the bound.
 */

const { initDbPool, closePool, getPool } = await import('@magick-agency/db');
const { TEST_DB_URL } = await import('../../../../../packages/db/test/helpers/test-db.js');
const POOL_OPTS = {
  url: TEST_DB_URL, poolMin: 0, poolMax: 3,
  sessionTimeouts: { statementTimeoutMs: 300, idleInTransactionTimeoutMs: 300 },
};
initDbPool(POOL_OPTS);

const { reportCursorRows } = await import('../../../src/db/repositories/agency.repository.js');
const { REPORT_BUILD_TIMEOUT_MS } = await import('../../../src/agency/reports/datasets/types.js');

afterAll(closePool);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The two timeouts as the cursor's own transaction sees them, in milliseconds. */
async function insideCursor(timeoutMs?: number): Promise<{ statement: number; idle: number }> {
  const got: Record<string, number> = {};
  for await (const r of reportCursorRows<{ name: string; setting: string }>(
    `SELECT name, setting FROM pg_settings WHERE name IN ('statement_timeout', 'idle_in_transaction_session_timeout')`,
    [], timeoutMs === undefined ? {} : { timeoutMs },
  )) got[r.name] = Number(r.setting);
  return { statement: got['statement_timeout']!, idle: got['idle_in_transaction_session_timeout']! };
}

/** The backend `pid`'s state in this file's database, or null once Postgres has ended it. */
async function backendState(pid: number): Promise<string | null> {
  const { rows } = await getPool().query<{ state: string }>(
    'SELECT state FROM pg_stat_activity WHERE pid = $1::int AND datname = current_database()', [pid]);
  return rows[0]?.state ?? null;
}

describe('report cursor under the pool session timeouts', () => {
  it('the pool really applies them (the precondition)', async () => {
    await expect(getPool().query('SELECT pg_sleep(0.6)')).rejects.toMatchObject({ code: '57014' });
  });

  it('bounds both for its own transaction, never 0: the report deadline by default, else timeoutMs', async () => {
    expect(await insideCursor()).toEqual({ statement: REPORT_BUILD_TIMEOUT_MS, idle: REPORT_BUILD_TIMEOUT_MS });
    expect(await insideCursor(5000)).toEqual({ statement: 5000, idle: 5000 });
    // Rounded up, never down to 0 (which would mean no limit).
    expect(await insideCursor(0.2)).toEqual({ statement: 1, idle: 1 });
  });

  it('survives a consumer that holds a row longer than the idle-in-transaction timeout', async () => {
    const got: number[] = [];
    for await (const row of reportCursorRows<{ n: number }>('SELECT n FROM generate_series(1, 5) AS n', [], { batch: 2 })) {
      got.push(row.n);
      // Idle inside the cursor's transaction, as while the upload applies backpressure.
      if (row.n === 2) await sleep(800);
    }
    expect(got).toEqual([1, 2, 3, 4, 5]);
  });

  it('runs a FETCH longer than the statement timeout', async () => {
    const got: number[] = [];
    for await (const row of reportCursorRows<{ n: number }>('SELECT n FROM generate_series(1, 2) AS n, pg_sleep(0.6) AS s', [])) {
      got.push(row.n);
    }
    expect(got).toEqual([1, 2]);
  });

  it('a consumer that stalls past the bound has its transaction ended by Postgres', async () => {
    const cursor = reportCursorRows<{ n: number; pid: number }>(
      'SELECT n, pg_backend_pid() AS pid FROM generate_series(1, 6) AS n', [], { batch: 2, timeoutMs: 1500 },
    )[Symbol.asyncIterator]();
    const first = await cursor.next();
    const pid = (first.value as { pid: number }).pid;
    await cursor.next();
    // Past the pool's 300 ms, inside the bound: still open, waiting on the consumer.
    await sleep(700);
    expect(await backendState(pid)).toBe('idle in transaction');
    expect((await cursor.next()).value).toMatchObject({ n: 3 });
    // Never pulls again: nothing of the cursor's runs, so only Postgres can end it.
    await sleep(2500);
    expect(await backendState(pid)).toBeNull();
    // The consumer that does come back gets the failure, and the client is discarded.
    await cursor.next();
    await expect(cursor.next()).rejects.toThrow();
    expect((await getPool().query<{ one: number }>('SELECT 1 AS one')).rows[0]!.one).toBe(1);
  });

  it('leaves the session values in place on the connection afterwards', async () => {
    for await (const _ of reportCursorRows<{ n: number }>('SELECT 1 AS n', [])) { /* drain */ }
    const { rows } = await getPool().query<{ s: string; i: string }>(
      `SELECT current_setting('statement_timeout') AS s, current_setting('idle_in_transaction_session_timeout') AS i`);
    expect(rows[0]).toEqual({ s: '300ms', i: '300ms' });
  });

  it('keeps a lower limit the database sets, under the pool\'s own SET', async () => {
    const { rows: [db] } = await getPool().query<{ name: string }>('SELECT current_database() AS name');
    expect(db!.name).toMatch(/^magick_agency_test/);
    const alter = (sql: string) => getPool().query(`DO $$ BEGIN EXECUTE format('ALTER DATABASE %I ${sql}', current_database()); END $$`);
    await alter(`SET statement_timeout = ''45s''`);
    await alter(`SET idle_in_transaction_session_timeout = ''50s''`);
    // Fresh connections, which start with the database's values before the pool's SET.
    await closePool();
    initDbPool(POOL_OPTS);
    try {
      expect(await insideCursor()).toEqual({ statement: 45_000, idle: 50_000 });
      expect(await insideCursor(5000)).toEqual({ statement: 5000, idle: 5000 });
      // The pool's own values still hold outside the cursor.
      await expect(getPool().query('SELECT pg_sleep(0.6)')).rejects.toMatchObject({ code: '57014' });
    } finally {
      await alter('RESET statement_timeout');
      await alter('RESET idle_in_transaction_session_timeout');
      await closePool();
      initDbPool(POOL_OPTS);
    }
  });
});
