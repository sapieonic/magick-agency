import { afterAll, describe, expect, it } from 'vitest';

/**
 * The report cursor under the pool's session timeouts (db-hygiene.md "Timeouts"), on real
 * Postgres: `reportCursorRows` lifts `idle_in_transaction_session_timeout` and
 * `statement_timeout` for its own transaction, because it sits idle between FETCHes while the
 * consumer waits on the upload, and its FETCHes can run long. Its deadline bounds both instead
 * (`report-assembler-deadline.test.ts`). Outside that transaction the pool's values still hold.
 *
 * The timeouts here are a few hundred milliseconds so the cases run fast; the config refuses
 * anything under a second, but `initDbPool` takes what it is given.
 *
 * Mutation-checked: without the cursor's `set_config` both cursor cases fail (the idle one with
 * the session ended under it, the slow one with 57014).
 */

const { initDbPool, closePool, getPool } = await import('@magick-agency/db');
const { TEST_DB_URL } = await import('../../../../../packages/db/test/helpers/test-db.js');
initDbPool({
  url: TEST_DB_URL, poolMin: 0, poolMax: 3,
  sessionTimeouts: { statementTimeoutMs: 300, idleInTransactionTimeoutMs: 300 },
});

const { reportCursorRows } = await import('../../../src/db/repositories/agency.repository.js');

afterAll(closePool);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('report cursor under the pool session timeouts', () => {
  it('the pool really applies them (the precondition)', async () => {
    await expect(getPool().query('SELECT pg_sleep(0.6)')).rejects.toMatchObject({ code: '57014' });
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
    for await (const row of reportCursorRows<{ n: number }>('SELECT n FROM generate_series(1, 2) AS n, pg_sleep(0.3) AS s', [])) {
      got.push(row.n);
    }
    expect(got).toEqual([1, 2]);
  });

  it('leaves the session values in place on the connection afterwards', async () => {
    for await (const _ of reportCursorRows<{ n: number }>('SELECT 1 AS n', [])) { /* drain */ }
    const { rows } = await getPool().query<{ s: string; i: string }>(
      `SELECT current_setting('statement_timeout') AS s, current_setting('idle_in_transaction_session_timeout') AS i`);
    expect(rows[0]).toEqual({ s: '300ms', i: '300ms' });
  });
});
