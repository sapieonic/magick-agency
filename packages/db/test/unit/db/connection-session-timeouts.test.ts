import { afterEach, describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import { closePool, initDbPool, sessionSettingsHook, sessionSettingsSql, sessionTimeoutsSql } from '../../../src/connection.js';

/**
 * The pool's per-connection settings (`db-hygiene.md`, "5. Timeouts"): the SQL the connect hook
 * sends. On real Postgres, `test/integration/db/pool-session-settings.test.ts`
 * shows each setting taking effect.
 */

function run(hook: ReturnType<typeof sessionSettingsHook>) {
  const query = vi.fn(async () => ({ rows: [] }));
  return { done: hook({ query } as unknown as pg.ClientBase), query };
}

const RESET_ALL = 'RESET statement_timeout; RESET lock_timeout; RESET idle_in_transaction_session_timeout';

describe('sessionTimeoutsSql / sessionSettingsHook', () => {
  it('resets all three when nothing is set, so a pooled connection keeps no value an earlier client left', () => {
    expect(sessionTimeoutsSql(undefined)).toBe(RESET_ALL);
    expect(sessionTimeoutsSql({})).toBe(RESET_ALL);
    expect(sessionTimeoutsSql({ statementTimeoutMs: 0, lockTimeoutMs: 0, idleInTransactionTimeoutMs: 0 })).toBe(RESET_ALL);
  });

  it('sets the non-zero timeouts in milliseconds and resets the others, in one round trip', async () => {
    const { done, query } = run(sessionSettingsHook(undefined, { statementTimeoutMs: 60_000, lockTimeoutMs: 0, idleInTransactionTimeoutMs: 120_000 }));
    await done;
    expect(query).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledWith(
      "SET statement_timeout = '60000ms'; RESET lock_timeout; SET idle_in_transaction_session_timeout = '120000ms'",
    );
  });

  it('sets all three when all are given', () => {
    expect(sessionTimeoutsSql({ statementTimeoutMs: 1, lockTimeoutMs: 2, idleInTransactionTimeoutMs: 3 })).toBe(
      "SET statement_timeout = '1ms'; SET lock_timeout = '2ms'; SET idle_in_transaction_session_timeout = '3ms'",
    );
  });

  it('refuses a negative or fractional value instead of writing it into the SQL', () => {
    expect(() => sessionSettingsHook(undefined, { statementTimeoutMs: -1 })).toThrow(/statementTimeoutMs must be a non-negative integer/);
    expect(() => sessionSettingsHook(undefined, { lockTimeoutMs: 1.5 })).toThrow(/lockTimeoutMs must be a non-negative integer/);
    expect(() => sessionTimeoutsSql({ idleInTransactionTimeoutMs: Number.NaN })).toThrow(/idleInTransactionTimeoutMs/);
  });

  it('sets application_name first when given, and refuses a name it could not write safely', () => {
    expect(sessionSettingsSql('magick-agency-media-1', { lockTimeoutMs: 60_000 })).toBe(
      "SET application_name = 'magick-agency-media-1'; RESET statement_timeout; SET lock_timeout = '60000ms'; RESET idle_in_transaction_session_timeout",
    );
    expect(sessionSettingsSql(undefined, undefined)).toBe(RESET_ALL);
    expect(() => sessionSettingsSql("x'; DROP TABLE t; --", undefined)).toThrow(/applicationName must be/);
    expect(() => sessionSettingsSql('a'.repeat(64), undefined)).toThrow(/applicationName must be/);
    expect(() => sessionSettingsSql('', undefined)).toThrow(/applicationName must be/);
  });

  it('propagates a failed statement, so pg-pool ends that connection rather than hand it out unset', async () => {
    const hook = sessionSettingsHook(undefined, { statementTimeoutMs: 1000 });
    const query = vi.fn(async () => { throw new Error('boom'); });
    await expect(hook({ query } as unknown as pg.ClientBase)).rejects.toThrow('boom');
  });
});

describe('initDbPool connection options (no connection is opened)', () => {
  afterEach(async () => { await closePool(); });
  type Opts = { keepAlive?: boolean; keepAliveInitialDelayMillis?: number; application_name?: string; onConnect?: unknown };
  const optionsOf = (pool: pg.Pool) => (pool as unknown as { options: Opts }).options;

  it('keepalive with a 30 s first probe; no name unless asked; the hook always (it resets the timeouts)', () => {
    // Port 5436 (agency's); a pool connects lazily, so nothing is dialled here.
    const opts = optionsOf(initDbPool({ url: 'postgresql://u:p@localhost:5436/none', poolMin: 0 }));
    expect(opts).toMatchObject({ keepAlive: true, keepAliveInitialDelayMillis: 30_000 });
    expect(opts.application_name).toBeUndefined();
    expect(opts.onConnect).toBeTypeOf('function');
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
