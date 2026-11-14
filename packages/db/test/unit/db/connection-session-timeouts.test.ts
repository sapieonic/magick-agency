import { afterEach, describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import { closePool, initDbPool, sessionTimeoutsHook } from '../../../src/connection.js';

/**
 * The pool's session timeouts (`db-hygiene.md`, "Timeouts"): which `set_config` calls the
 * connect hook sends. On real Postgres, `test/integration/db/pool-session-settings.test.ts`
 * shows each setting taking effect.
 */

function run(hook: NonNullable<ReturnType<typeof sessionTimeoutsHook>>) {
  const query = vi.fn(async () => ({ rows: [] }));
  return { done: hook({ query } as unknown as pg.ClientBase), query };
}

describe('sessionTimeoutsHook', () => {
  it('is absent when nothing is set, so a pool without timeouts sends no extra statement', () => {
    expect(sessionTimeoutsHook(undefined)).toBeUndefined();
    expect(sessionTimeoutsHook({})).toBeUndefined();
    expect(sessionTimeoutsHook({ statementTimeoutMs: 0, lockTimeoutMs: 0, idleInTransactionTimeoutMs: 0 })).toBeUndefined();
  });

  it('sets only the non-zero timeouts, in milliseconds, in one statement', async () => {
    const { done, query } = run(sessionTimeoutsHook({ statementTimeoutMs: 60_000, lockTimeoutMs: 0, idleInTransactionTimeoutMs: 120_000 })!);
    await done;
    expect(query).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledWith(
      'SELECT set_config($1, $2, false), set_config($3, $4, false)',
      ['statement_timeout', '60000ms', 'idle_in_transaction_session_timeout', '120000ms'],
    );
  });

  it('sets all three when all are given', async () => {
    const { done, query } = run(sessionTimeoutsHook({ statementTimeoutMs: 1, lockTimeoutMs: 2, idleInTransactionTimeoutMs: 3 })!);
    await done;
    expect(query).toHaveBeenCalledWith(
      'SELECT set_config($1, $2, false), set_config($3, $4, false), set_config($5, $6, false)',
      ['statement_timeout', '1ms', 'lock_timeout', '2ms', 'idle_in_transaction_session_timeout', '3ms'],
    );
  });

  it('refuses a negative or fractional value instead of sending it', () => {
    expect(() => sessionTimeoutsHook({ statementTimeoutMs: -1 })).toThrow(/statementTimeoutMs must be a non-negative integer/);
    expect(() => sessionTimeoutsHook({ lockTimeoutMs: 1.5 })).toThrow(/lockTimeoutMs must be a non-negative integer/);
  });

  it('propagates a failed set_config, so pg-pool ends that connection rather than hand it out unset', async () => {
    const hook = sessionTimeoutsHook({ statementTimeoutMs: 1000 })!;
    const query = vi.fn(async () => { throw new Error('boom'); });
    await expect(hook({ query } as unknown as pg.ClientBase)).rejects.toThrow('boom');
  });
});

describe('initDbPool connection options (no connection is opened)', () => {
  afterEach(async () => { await closePool(); });
  type Opts = { keepAlive?: boolean; keepAliveInitialDelayMillis?: number; application_name?: string; onConnect?: unknown };
  const optionsOf = (pool: pg.Pool) => (pool as unknown as { options: Opts }).options;

  it('keepalive with a 30 s first probe; no name and no hook unless asked', () => {
    // Port 5436 (agency's); a pool connects lazily, so nothing is dialled here.
    const opts = optionsOf(initDbPool({ url: 'postgresql://u:p@localhost:5436/none', poolMin: 0 }));
    expect(opts).toMatchObject({ keepAlive: true, keepAliveInitialDelayMillis: 30_000 });
    expect(opts.application_name).toBeUndefined();
    expect(opts.onConnect).toBeUndefined();
  });

  it('the name and the hook when asked', () => {
    const opts = optionsOf(initDbPool({
      url: 'postgresql://u:p@localhost:5436/none', poolMin: 0,
      applicationName: 'magick-agency-test', sessionTimeouts: { lockTimeoutMs: 60_000 },
    }));
    expect(opts.application_name).toBe('magick-agency-test');
    expect(opts.onConnect).toBeTypeOf('function');
  });
});
