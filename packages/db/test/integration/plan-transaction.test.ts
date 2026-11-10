// Real Postgres: the plan tests' transaction helper (plan-transaction.ts). A plan test that hits
// its timeout leaves its seeding transaction running; the file's afterEach(endPlanTransactions)
// must end it (rolled back, client released, nothing left on the server) before the next test
// truncates the tables it holds.
import { afterAll, describe, expect, it } from 'vitest';
import { closeTestPool, getTestPool } from './setup/test-utils.js';
import { endPlanTransactions, inPlanTransaction, openPlanTransactions } from './plan-transaction.js';

afterAll(closeTestPool);

/** This file's other backends: running statements and open transactions. */
async function serverSide(): Promise<{ sleeping: number; inTransaction: number }> {
  const { rows: [r] } = await getTestPool().query<{ sleeping: number; in_tx: number }>(
    `SELECT count(*) FILTER (WHERE state = 'active' AND query LIKE '%pg_sleep%')::int AS sleeping,
            count(*) FILTER (WHERE state LIKE 'idle in transaction%')::int AS in_tx
       FROM pg_stat_activity
      WHERE datname = current_database() AND pid <> pg_backend_pid()`);
  return { sleeping: r!.sleeping, inTransaction: r!.in_tx };
}

describe('inPlanTransaction / endPlanTransactions', () => {
  it('rolls back and releases on success: nothing open, nothing written', async () => {
    const out = await inPlanTransaction(async (client) => {
      await client.query('CREATE TEMP TABLE plan_probe (x int)');
      return 'planned';
    });
    expect(out).toBe('planned');
    expect(openPlanTransactions()).toBe(0);
    await endPlanTransactions(); // nothing to end: returns at once
    expect(await serverSide()).toEqual({ sleeping: 0, inTransaction: 0 });
  });

  it('ends a transaction a timed-out test left running in one long statement', async () => {
    // The test that "timed out": its promise is abandoned, its statement still running.
    const abandoned = inPlanTransaction((client) => client.query('SELECT pg_sleep(30)'));
    abandoned.catch(() => undefined);
    await expect.poll(async () => (await serverSide()).sleeping, { timeout: 5_000 }).toBe(1);
    expect(openPlanTransactions()).toBe(1);

    const started = Date.now();
    await endPlanTransactions();
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(openPlanTransactions()).toBe(0);
    await expect(abandoned).rejects.toMatchObject({ code: '57014' });
    expect(await serverSide()).toEqual({ sleeping: 0, inTransaction: 0 });
    expect(getTestPool().totalCount - getTestPool().idleCount).toBe(0);
  });

  it('ends one whose test is between statements when asked (a cancel that found nothing running is sent again)', async () => {
    let issued = 0;
    const abandoned = inPlanTransaction(async (client) => {
      await client.query('SELECT 1');
      issued = 1;
      // Idle in the transaction (the test's own code running): a cancel now has nothing to stop.
      await new Promise((resolve) => setTimeout(resolve, 300));
      for (let i = 0; i < 100; i++) {
        issued += 1;
        await client.query('SELECT pg_sleep(0.2)');
      }
    });
    abandoned.catch(() => undefined);
    await expect.poll(() => issued, { timeout: 5_000, interval: 5 }).toBe(1);

    const started = Date.now();
    await endPlanTransactions();
    // Well short of the 20 s the statements would take: a later cancel stopped the first of them.
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(openPlanTransactions()).toBe(0);
    await expect(abandoned).rejects.toMatchObject({ code: '57014' });
    expect(issued).toBeLessThan(5);
    expect(await serverSide()).toEqual({ sleeping: 0, inTransaction: 0 });
  });
});
