import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import type { FastifyReply } from 'fastify';
import {
  COMPARE_CANCEL_GRACE_MS,
  CompareAborted,
  CompareReads,
  CompareRefusal,
  compareGlobalReadLimit,
  TenantReadLimiter,
  type CompareWindowScope,
} from '../../../../src/agency/compare/read.js';
import { clientGoneSignal } from '../../../../src/api/routes/proxy-agency-compare/shared.js';

/**
 * Compare agents' guards around a statement that has to be stopped (docs/compare-agents.md §7): the
 * whole-read deadline, a client that goes away, the cancel sent and AWAITED before the connection
 * is given up, a cancelled connection destroyed (never back to the pool), a statement that ignores
 * its cancel abandoned after the grace, and the slot freed only once the statement has ended. The
 * connection is a fake: these are the guards' rules, not SQL (the read's SQL, the real cancel and
 * the real disconnect are held on Postgres in `compare-agents.test.ts`).
 */

const SCOPE: CompareWindowScope = {
  tenantId: 't1', accountId: 'a1', campaignId: '00000000-0000-4000-8000-0000000000c1',
  from: '2026-11-01', to: '2026-11-02', timezone: 'UTC', start: new Date('2026-11-01T00:00:00Z'), end: new Date('2026-11-03T00:00:00Z'),
};

/** A connection whose roster statement runs until cancelled (`endsOnCancel`) or forever. */
function fakeConnection(o: { endsOnCancel: boolean; cancelTakesMs?: number }) {
  const log: string[] = [];
  let failRunning: ((err: unknown) => void) | null = null;
  const client = {
    processID: 4242,
    query(text: string) {
      if (/^BEGIN|set_config/.test(text.trim())) { log.push('BEGIN/set'); return Promise.resolve({ rows: [] }); }
      if (text.trim() === 'ROLLBACK') { log.push('ROLLBACK'); return Promise.resolve({ rows: [] }); }
      log.push('statement');
      return new Promise((_, reject) => { failRunning = reject; });
    },
    release(destroy?: boolean) { log.push(destroy === true ? 'destroyed' : 'released'); },
  };
  return {
    log,
    pool: { connect: async () => client as never },
    cancelBackend: async (pid: number) => {
      log.push(`cancel ${pid}`);
      await new Promise((r) => setTimeout(r, o.cancelTakesMs ?? 10));
      if (o.endsOnCancel) setTimeout(() => failRunning?.(Object.assign(new Error('canceling statement'), { code: '57014' })), 30);
      log.push('cancel sent');
      return true;
    },
  };
}

function reads(conn: ReturnType<typeof fakeConnection>, timeoutMs: number) {
  return new CompareReads({
    timeoutMs,
    deps: {
      pool: conn.pool, cancelBackend: conn.cancelBackend, poolMax: () => 30,
      memberships: async () => [], names: async () => new Map(), now: () => new Date(),
    },
  });
}

describe('the whole read\'s deadline', () => {
  it('cancels the statement, awaits the cancel, destroys the connection, then gives the slot back: 503', async () => {
    const conn = fakeConnection({ endsOnCancel: true });
    const r = reads(conn, 150);
    const started = Date.now();
    const err = await r.cohort(SCOPE).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CompareRefusal);
    expect((err as CompareRefusal).code).toBe('compare_timed_out');
    expect(Date.now() - started).toBeLessThan(1000);
    // The cancel was sent and awaited before the connection was given up, destroyed, not pooled.
    expect(conn.log).toEqual(['BEGIN/set', 'BEGIN/set', 'statement', 'cancel 4242', 'cancel sent', 'destroyed']);
    expect(r.inFlight('t1')).toBe(0);
  });

  it('a statement that ignores its cancel is abandoned with its connection after the grace', async () => {
    const conn = fakeConnection({ endsOnCancel: false });
    const r = reads(conn, 100);
    const started = Date.now();
    const err = await r.cohort(SCOPE).catch((e: unknown) => e);
    expect((err as CompareRefusal).code).toBe('compare_timed_out');
    expect(Date.now() - started).toBeGreaterThanOrEqual(COMPARE_CANCEL_GRACE_MS);
    expect(conn.log.at(-1)).toBe('destroyed');
    expect(r.inFlight('t1')).toBe(0);
  }, 10_000);
});

describe('a client that goes away', () => {
  it('stops the statement; the slot is held until the statement has ended, then given back', async () => {
    const conn = fakeConnection({ endsOnCancel: true, cancelTakesMs: 50 });
    const r = reads(conn, 10_000);
    const gone = new AbortController();
    const read = r.cohort(SCOPE, gone.signal).catch((e: unknown) => e);
    await new Promise((res) => setTimeout(res, 20));
    gone.abort();
    // The cancel is on its way and the statement still runs: the slot is still held.
    await new Promise((res) => setTimeout(res, 20));
    expect(r.inFlight('t1')).toBe(1);
    expect(await read).toBeInstanceOf(CompareAborted);
    expect(r.inFlight('t1')).toBe(0);
    // No statement after the abort, and the connection never went back to the pool.
    expect(conn.log).toEqual(['BEGIN/set', 'BEGIN/set', 'statement', 'cancel 4242', 'cancel sent', 'destroyed']);
  });
});

describe('the process-wide limit', () => {
  it('is a sixth of the pool, never under one tenant\'s limit', () => {
    expect(compareGlobalReadLimit(30)).toBe(5);
    expect(compareGlobalReadLimit(60)).toBe(10);
    expect(compareGlobalReadLimit(6)).toBe(2);
    expect(compareGlobalReadLimit(1)).toBe(2);
  });

  it('refuses past it across tenants, each tenant still under its own', () => {
    const limiter = new TenantReadLimiter(2, 3);
    const held = [limiter.tryAcquire('a'), limiter.tryAcquire('a'), limiter.tryAcquire('b')];
    expect(held.every((r) => r !== null)).toBe(true);
    expect(limiter.tryAcquire('c')).toBeNull();
    expect(limiter.inFlightTotal()).toBe(3);
    held[0]!();
    expect(limiter.tryAcquire('c')).not.toBeNull();
  });

  it('reads the pool\'s size only when a slot is first asked for', () => {
    let asked = 0;
    const limiter = new TenantReadLimiter(2, () => { asked += 1; return 1; });
    expect(asked).toBe(0);
    expect(limiter.tryAcquire('a')).not.toBeNull();
    expect(limiter.tryAcquire('b')).toBeNull();
    expect(asked).toBe(1);
  });
});

describe('clientGoneSignal', () => {
  const reply = (o: { destroyed?: boolean; socketDestroyed?: boolean }) => {
    const raw = Object.assign(new EventEmitter(), { destroyed: o.destroyed ?? false, writableFinished: false, socket: { destroyed: o.socketDestroyed ?? false } });
    return { raw, request: { raw: { socket: raw.socket, destroyed: true } } } as unknown as FastifyReply & { raw: EventEmitter & { writableFinished: boolean } };
  };

  it('is aborted at once when the socket is already gone as the handler starts', () => {
    expect(clientGoneSignal(reply({ socketDestroyed: true })).aborted).toBe(true);
    expect(clientGoneSignal(reply({ destroyed: true })).aborted).toBe(true);
  });

  it('a request whose body was read (destroyed in current Node) is not a client gone', () => {
    expect(clientGoneSignal(reply({})).aborted).toBe(false);
  });

  it('aborts on a close before the answer, not on the close that follows it', () => {
    const early = reply({});
    const s1 = clientGoneSignal(early);
    early.raw.emit('close');
    expect(s1.aborted).toBe(true);
    const finished = reply({});
    const s2 = clientGoneSignal(finished);
    finished.raw.writableFinished = true;
    finished.raw.emit('close');
    expect(s2.aborted).toBe(false);
  });
});
