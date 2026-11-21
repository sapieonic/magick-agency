import { describe, expect, it } from 'vitest';
import {
  cancellableReadSettingsSql,
  openCancellableRead,
  withCancellableRead,
  type CancellableReadOptions,
} from '../../../src/utils/cancellable-read.js';

/**
 * The control flow of a stoppable read transaction (`src/utils/cancellable-read.ts`): which
 * statements run, the cancel by the backend's own pid, awaited before the connection is given
 * up, a cancelled connection destroyed (never back to the pool), a statement abandoned after the
 * grace or waited for without one, a deadline's `statement_timeout` lowered before a later
 * statement. The connection is a fake; what the settings statement does to a real session is held
 * on Postgres in `test/integration/cancellable-read.test.ts`.
 */

const PID = 4242;

/** A connection whose user statements wait until `finish()`, a cancel (`endsOnCancel`), or forever. */
function fake(o: { endsOnCancel?: boolean; cancelAnswers?: boolean | 'throws'; rollbackFails?: boolean; statementMs?: number } = {}) {
  const log: string[] = [];
  const settings: unknown[][] = [];
  let fail: ((e: unknown) => void) | null = null;
  let finish: ((v: unknown) => void) | null = null;
  const client = {
    processID: 1,
    query(text: string, values?: unknown[]) {
      const t = text.trim();
      if (/^BEGIN/.test(t)) { log.push(t); return Promise.resolve({ rows: [] }); }
      if (/pg_backend_pid/.test(t)) {
        log.push('settings');
        settings.push(values ?? []);
        return Promise.resolve({ rows: [{ name: 'statement_timeout', pid: PID, ceiling_ms: '0', applied_ms: String(values?.[0]) }] });
      }
      if (/^SELECT set_config/.test(t)) { log.push(`lowered ${String(values?.[0])}`); return Promise.resolve({ rows: [] }); }
      if (t === 'ROLLBACK') {
        log.push('ROLLBACK');
        return o.rollbackFails ? Promise.reject(new Error('connection lost')) : Promise.resolve({ rows: [] });
      }
      log.push(t);
      return new Promise((res, rej) => {
        finish = res;
        fail = rej;
        if (o.statementMs !== undefined) setTimeout(() => res({ rows: [{ ok: 1 }] }), o.statementMs);
      });
    },
    release(destroy?: boolean) { log.push(destroy === true ? 'destroyed' : 'released'); },
  };
  const cancel = async (pid: number) => {
    log.push(`cancel ${pid}`);
    await new Promise((r) => setTimeout(r, 10));
    if (o.cancelAnswers === 'throws') throw new Error('no pool');
    if (o.endsOnCancel) setTimeout(() => fail?.(Object.assign(new Error('canceling statement'), { code: '57014' })), 20);
    log.push('cancel sent');
    return o.cancelAnswers ?? true;
  };
  return { log, settings, pool: { connect: async () => client as never }, cancel, finish: () => finish?.({ rows: [] }) };
}

const opts = (f: ReturnType<typeof fake>, extra: Partial<CancellableReadOptions> = {}): CancellableReadOptions => ({
  cancel: f.cancel, timeout: { boundMs: 5_000 }, ceiling: 'session', ...extra,
});
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

describe('the settings statement', () => {
  it('bounds statement_timeout under the session\'s own value, or the role\'s, and reads the backend\'s pid', () => {
    const session = cancellableReadSettingsSql({ ceiling: 'session' });
    expect(session).toMatch(/pg_backend_pid\(\) AS pid/);
    expect(session).toMatch(/setting::bigint/);
    expect(session).not.toMatch(/reset_val/);
    expect(session).toMatch(/name IN \('statement_timeout'\)/);
    const role = cancellableReadSettingsSql({ ceiling: 'role', idleInTransaction: true });
    expect(role).toMatch(/reset_val::bigint/);
    expect(role).toMatch(/name IN \('idle_in_transaction_session_timeout', 'statement_timeout'\)/);
  });

  it('applies further settings as later parameters, and refuses a name that is not one', () => {
    expect(cancellableReadSettingsSql({ ceiling: 'session', settings: { max_parallel_workers_per_gather: 1 } }))
      .toMatch(/set_config\('max_parallel_workers_per_gather', \$2::text, true\)/);
    expect(() => cancellableReadSettingsSql({ ceiling: 'session', settings: { "x'; DROP": 1 } })).toThrow(RangeError);
  });
});

describe('a read that finishes', () => {
  it('BEGINs read-only, sends the settings, runs the statements, rolls back and releases', async () => {
    const f = fake({ statementMs: 5 });
    const out = await withCancellableRead(f.pool, opts(f, { settings: { max_parallel_workers_per_gather: 1 } }), async (tx) => {
      expect(tx.pid).toBe(PID);
      return (await tx.client.query('SELECT 1')).rows;
    });
    expect(out).toEqual([{ ok: 1 }]);
    expect(f.log).toEqual(['BEGIN ISOLATION LEVEL REPEATABLE READ, READ ONLY', 'settings', 'SELECT 1', 'ROLLBACK', 'released']);
    expect(f.settings[0]).toEqual([5_000, '1']);
  });

  it('a failure is rolled back and the connection reused, unless destroyAfterFailure', async () => {
    const reused = fake();
    await expect(withCancellableRead(reused.pool, opts(reused), async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(reused.log.slice(-2)).toEqual(['ROLLBACK', 'released']);
    const destroyed = fake();
    await expect(withCancellableRead(destroyed.pool, opts(destroyed, { destroyAfterFailure: true }), async () => { throw new Error('boom'); }))
      .rejects.toThrow('boom');
    expect(destroyed.log.slice(-2)).toEqual(['ROLLBACK', 'destroyed']);
  });

  it('a ROLLBACK that fails destroys the connection', async () => {
    const f = fake({ rollbackFails: true, statementMs: 1 });
    await withCancellableRead(f.pool, opts(f), (tx) => tx.query('SELECT 1'));
    expect(f.log.slice(-2)).toEqual(['ROLLBACK', 'destroyed']);
  });
});

describe('a read that is stopped', () => {
  it('cancels the running statement by the backend\'s pid, awaits it, sends nothing more and destroys the connection', async () => {
    const f = fake({ endsOnCancel: true });
    const stop = new AbortController();
    const read = withCancellableRead(f.pool, opts(f, { signal: stop.signal }), async (tx) => {
      await tx.query('SELECT slow');
      await tx.query('SELECT never');
    }).catch((e: unknown) => e);
    await tick();
    stop.abort(new Error('gone'));
    const err = await read;
    // The stop's reason, not the statement's 57014.
    expect((err as Error).message).toBe('gone');
    expect(f.log).toEqual(['BEGIN ISOLATION LEVEL REPEATABLE READ, READ ONLY', 'settings', 'SELECT slow', `cancel ${PID}`, 'cancel sent', 'destroyed']);
  });

  it('a statement that ends while its cancel is on the way: the connection is given up only once the cancel is through', async () => {
    const log: string[] = [];
    let finish: ((v: unknown) => void) | null = null;
    const client = {
      query(text: string, values?: unknown[]) {
        if (/pg_backend_pid/.test(text)) return Promise.resolve({ rows: [{ pid: PID, ceiling_ms: '0', applied_ms: String(values?.[0]) }] });
        if (/^BEGIN/.test(text.trim())) return Promise.resolve({ rows: [] });
        if (text.trim() === 'ROLLBACK') { log.push('ROLLBACK'); return Promise.resolve({ rows: [] }); }
        log.push('statement');
        return new Promise((resolve) => { finish = resolve; });
      },
      release(destroy?: boolean) { log.push(destroy === true ? 'destroyed' : 'released'); },
    };
    const stop = new AbortController();
    const read = withCancellableRead({ connect: async () => client as never }, {
      signal: stop.signal, timeout: { boundMs: 5_000 }, ceiling: 'session',
      cancel: async () => { log.push('cancel'); finish?.({ rows: [] }); await tick(80); log.push('cancel sent'); return true; },
    }, (tx) => tx.query('SELECT slow')).catch((e: unknown) => e);
    await tick();
    stop.abort();
    await read;
    expect(log).toEqual(['statement', 'cancel', 'cancel sent', 'destroyed']);
  });

  it('cancels once however often the signal is heard', async () => {
    const f = fake({ endsOnCancel: true });
    const stop = new AbortController();
    const tx = await openCancellableRead(f.pool, opts(f, { signal: stop.signal }));
    const running = tx.query('SELECT slow').catch(() => undefined);
    await tick();
    stop.abort();
    stop.abort();
    await running;
    await tx.close(true);
    await tx.close(true);
    expect(f.log.filter((l) => /^cancel \d/.test(l))).toEqual([`cancel ${PID}`]);
    expect(f.log.filter((l) => l === 'destroyed')).toHaveLength(1);
  });

  it('a stop while no statement runs sends no cancel; the next statement is never sent', async () => {
    const f = fake({ statementMs: 1 });
    const stop = new AbortController();
    const tx = await openCancellableRead(f.pool, opts(f, { signal: stop.signal }));
    await tx.query('SELECT 1');
    stop.abort();
    await expect(tx.query('SELECT 2')).rejects.toBeDefined();
    await tx.close(true);
    expect(f.log).toEqual(['BEGIN ISOLATION LEVEL REPEATABLE READ, READ ONLY', 'settings', 'SELECT 1', 'ROLLBACK', 'released']);
  });

  it('a statement that ignores its cancel is abandoned after the grace, with its connection', async () => {
    const f = fake();
    const stop = new AbortController();
    const started = Date.now();
    const read = withCancellableRead(f.pool, opts(f, { signal: stop.signal, graceMs: 150 }), (tx) => tx.query('SELECT stuck')).catch((e: unknown) => e);
    await tick();
    stop.abort();
    await read;
    expect(Date.now() - started).toBeGreaterThanOrEqual(150);
    expect(f.log.at(-1)).toBe('destroyed');
  });

  it('a cancel that could not be sent waits for the statement\'s own bound, plus the grace', async () => {
    const f = fake({ cancelAnswers: false });
    const stop = new AbortController();
    const started = Date.now();
    const read = withCancellableRead(f.pool, opts(f, { signal: stop.signal, graceMs: 100, timeout: { boundMs: 600 } }), (tx) => tx.query('SELECT stuck'))
      .catch((e: unknown) => e);
    await tick();
    stop.abort();
    await tick(300);
    expect(f.log.at(-1)).toBe('cancel sent');
    await read;
    expect(Date.now() - started).toBeGreaterThanOrEqual(600 + 100 - 30);
    expect(f.log.at(-1)).toBe('destroyed');
  });

  it('a cancel that throws counts as not sent and never escapes the listener', async () => {
    const f = fake({ cancelAnswers: 'throws' });
    const stop = new AbortController();
    const read = withCancellableRead(f.pool, opts(f, { signal: stop.signal, graceMs: 50, timeout: { boundMs: 100 } }), (tx) => tx.query('SELECT stuck'))
      .catch((e: unknown) => e);
    await tick();
    stop.abort();
    await read;
    expect(f.log.at(-1)).toBe('destroyed');
  });

  it('without a grace, a cancelled statement is waited for until it ends', async () => {
    const f = fake();
    const stop = new AbortController();
    let settled = false;
    const read = withCancellableRead(f.pool, opts(f, { signal: stop.signal }), (tx) => tx.query('SELECT stuck'))
      .catch((e: unknown) => e).finally(() => { settled = true; });
    await tick();
    stop.abort();
    await tick(200);
    expect(settled).toBe(false);
    f.finish();
    await read;
    expect(f.log.at(-1)).toBe('destroyed');
  });

  it('a signal already aborted takes no connection', async () => {
    const f = fake();
    let connects = 0;
    const pool = { connect: async () => { connects += 1; return f.pool.connect(); } };
    await expect(openCancellableRead(pool, opts(f, { signal: AbortSignal.abort() }))).rejects.toBeDefined();
    expect(connects).toBe(0);
  });
});

describe('a deadline', () => {
  it('sets what is left less the margin, and lowers it before a later statement only past the slack', async () => {
    const f = fake({ statementMs: 300 });
    const deadlineAt = performance.now() + 2_000;
    await withCancellableRead(f.pool, opts(f, { timeout: { deadlineAt, marginMs: 200, slackMs: 50 } }), async (tx) => {
      await tx.query('SELECT first');
      await tx.query('SELECT second');
    });
    const set = Number(f.settings[0]![0]);
    expect(set).toBeLessThanOrEqual(1_800);
    expect(set).toBeGreaterThan(1_700);
    const lowered = f.log.find((l) => l.startsWith('lowered '));
    expect(lowered, f.log.join(' | ')).toBeDefined();
    expect(set - Number(lowered!.slice(8))).toBeGreaterThanOrEqual(250);
    expect(f.log.indexOf(lowered!)).toBe(f.log.indexOf('SELECT second') - 1);
    // The first statement ran under the value set: no lowering before it.
    expect(f.log.indexOf('SELECT first')).toBe(f.log.indexOf('settings') + 1);
  });

  it('a fixed bound is never lowered', async () => {
    const f = fake({ statementMs: 60 });
    await withCancellableRead(f.pool, opts(f, { timeout: { boundMs: 100 } }), async (tx) => {
      await tx.query('SELECT first');
      await tx.query('SELECT second');
    });
    expect(f.log.some((l) => l.startsWith('lowered '))).toBe(false);
  });
});
