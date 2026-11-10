import type pg from 'pg';
import { getTestPool } from '../helpers/test-db.js';

/**
 * The plan tests' transactions: seed, ANALYZE, EXPLAIN, roll back. Seeding a realistic roster
 * takes seconds, and on a loaded machine a test can hit its timeout with its transaction still
 * running. Vitest then moves on, but the transaction does not stop: it keeps its locks and its
 * client, the next test's truncate waits behind it, and one timeout becomes a file of them.
 * {@link inPlanTransaction} records each transaction until it has rolled back and released its
 * client; a plan file's `afterEach(endPlanTransactions)` ends any a timed-out test left behind
 * (cancelling its statement until it has rolled back), so the next test starts on a quiet table.
 */

/**
 * The timeout of a test that seeds a plan roster (tens of thousands of rows, an ANALYZE): seconds on
 * a quiet machine, and past the default 20 s on a loaded one.
 */
export const PLAN_ROSTER_TIMEOUT_MS = 60_000;

interface Open {
  pid: number | null;
  settled: Promise<unknown>;
}

const open = new Set<Open>();

/** BEGIN, `fn(client)`, ROLLBACK, release: always rolled back, tracked until it has been. */
export async function inPlanTransaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await getTestPool().connect();
  const pid = (client as unknown as { processID?: number | null }).processID ?? null;
  const work = (async () => {
    try {
      await client.query('BEGIN');
      return await fn(client);
    } finally {
      try {
        await client.query('ROLLBACK');
        client.release();
      } catch (err) {
        client.release(err instanceof Error ? err : new Error(String(err)));
      }
    }
  })();
  const entry: Open = { pid, settled: work.then(() => undefined, () => undefined) };
  open.add(entry);
  void entry.settled.then(() => open.delete(entry));
  return work;
}

/**
 * End every plan transaction still open: cancel its backend's statement (again, while the test's
 * code issues its next one) until it has rolled back and released its client. Returns at once
 * when none is open, the normal case.
 */
export async function endPlanTransactions(): Promise<void> {
  for (const entry of [...open]) {
    for (;;) {
      if (entry.pid !== null) {
        await getTestPool().query('SELECT pg_cancel_backend($1::int)', [entry.pid]);
      }
      const done = await Promise.race([
        entry.settled.then(() => true),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), 100)),
      ]);
      if (done) break;
    }
  }
}

/** How many plan transactions are open (for the helper's own test). */
export function openPlanTransactions(): number {
  return open.size;
}
