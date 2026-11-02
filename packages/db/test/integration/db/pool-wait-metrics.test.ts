import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The pool's own series (`metrics/shared.ts`): `db_pool_acquire_seconds` times every
 * connection the pool hands out (`pool.query` and `withTransaction` both acquire through
 * `pool.connect`), and the stats provider behind the `db_pool_clients_*` gauges reports the
 * clients waiting, open, idle and the configured max. On real Postgres: a mocked pool would
 * not queue.
 *
 * Mutation-checked: removing `timePoolAcquire(pool)` from `initDbPool` reds the first case;
 * removing the `setDbPoolStatsProvider` call reds the second.
 */

const metrics = vi.hoisted(() => ({
  acquire: vi.fn(),
  provider: null as null | (() => { total: number; idle: number; waiting: number; max: number }),
}));
vi.mock('@magick-agency/observability/metrics/shared', () => ({
  observeDbPoolAcquire: metrics.acquire,
  setDbPoolStatsProvider: (fn: typeof metrics.provider) => { metrics.provider = fn; },
}));

import { closePool, DEFAULT_DB_POOL_MAX, initDbPool } from '../../../src/connection.js';
import { withTransaction } from '../../../src/utils/transaction.js';
import { TEST_DB_URL } from '../../helpers/test-db.js';

afterEach(async () => {
  await closePool();
  metrics.acquire.mockReset();
});

describe('Postgres pool metrics', () => {
  it('times every acquire: a query that waited for a connection reports the wait', async () => {
    const pool = initDbPool({ url: TEST_DB_URL, poolMin: 0, poolMax: 1 });
    await pool.query('SELECT 1');
    expect(metrics.acquire).toHaveBeenCalledTimes(1);
    expect(metrics.acquire.mock.calls[0]![1]).toBe('ok');

    // Hold the only connection, then queue a query and a transaction behind it.
    const held = await pool.connect();
    const queued = pool.query('SELECT 2 AS n');
    const tx = withTransaction(async (client) => (await client.query('SELECT 3 AS n')).rows[0].n as number, { pool });
    await new Promise((r) => setTimeout(r, 150));
    held.release();
    expect((await queued).rows[0].n).toBe(2);
    expect(await tx).toBe(3);

    const waits = metrics.acquire.mock.calls.slice(2); // after the first query and the hold
    expect(waits).toHaveLength(2);
    for (const [seconds, result] of waits) {
      expect(result).toBe('ok');
      expect(seconds).toBeGreaterThanOrEqual(0.1);
    }
  });

  it('reports clients waiting, open, idle and the configured max', async () => {
    const pool = initDbPool({ url: TEST_DB_URL, poolMin: 0, poolMax: 1 });
    expect(metrics.provider).not.toBeNull();
    const held = await pool.connect();
    const queued = pool.query('SELECT 1');
    await vi.waitFor(() => expect(metrics.provider!().waiting).toBe(1));
    expect(metrics.provider!()).toEqual({ total: 1, idle: 0, waiting: 1, max: 1 });
    held.release();
    await queued;
    expect(metrics.provider!()).toMatchObject({ waiting: 0, total: 1, idle: 1 });
    await closePool();
    expect(metrics.provider).toBeNull();
  });

  it('a pool built without a size takes the 30-connection default', async () => {
    const pool = initDbPool({ url: TEST_DB_URL, poolMin: 0 });
    expect(DEFAULT_DB_POOL_MAX).toBe(30);
    expect(pool.options.max).toBe(30);
    expect(metrics.provider!().max).toBe(30);
  });
});
