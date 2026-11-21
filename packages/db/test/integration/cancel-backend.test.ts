// Real Postgres: `cancelBackend` (src/utils/cancel-backend.ts) stops another backend's statement over
// a connection of its own, so it works when the pool is exhausted (the case it exists for: a cancel
// sent through a saturated pool waits behind every borrower and can land on the next one).
import { afterAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { cancelBackend } from '../../src/utils/cancel-backend.js';
import { closeTestPool, getTestPool } from './setup/test-utils.js';

afterAll(closeTestPool);

const url = (getTestPool().options as { connectionString: string }).connectionString;

describe('cancelBackend', () => {
  it('cancels a running statement while the only pooled connection is busy with it', async () => {
    const pool = new pg.Pool({ connectionString: url, max: 1 });
    try {
      const client = await pool.connect();
      // The backend's own pid, as the readers read it (never `processID`: a pooler's number).
      const { rows } = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
      const pid = rows[0]!.pid;
      const sleeping = client.query('SELECT pg_sleep(30)').then(() => 'finished', (err: { code?: string }) => err.code);
      // The pool is exhausted: a cancel through it would wait for this very statement.
      await new Promise((r) => setTimeout(r, 100));
      const started = Date.now();
      expect(await cancelBackend(pid, pool.options)).toBe(true);
      expect(await sleeping).toBe('57014');
      expect(Date.now() - started).toBeLessThan(5_000);
      // The connection was not taken from the pool.
      expect(pool.totalCount).toBe(1);
      client.release(true);
    } finally {
      await pool.end();
    }
  });

  it('answers false, never throws, when it cannot reach the server', async () => {
    expect(await cancelBackend(123, { connectionString: 'postgresql://nobody:nothing@127.0.0.1:1/none' }, 500)).toBe(false);
  });

  it('answers false, never throws or rejects, when its connection cannot even be built', async () => {
    // A malformed connection string throws in `new pg.Client`; a pool that is not there throws in
    // the options function. Both are inside the cancel, so the caller's release always runs.
    expect(await cancelBackend(123, { connectionString: 'not a url %%' }, 500)).toBe(false);
    expect(await cancelBackend(123, () => { throw new Error('no pool'); }, 500)).toBe(false);
  });

  it('answers false for a backend that does not exist', async () => {
    expect(await cancelBackend(2_147_483_000, { connectionString: url })).toBe(false);
  });
});
