import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { FastifyReply } from 'fastify';
import {
  COMPARE_CANCEL_GRACE_MS,
  COMPARE_MAX_PARALLEL_WORKERS_PER_GATHER,
  COMPARE_STATEMENT_TIMEOUT_MARGIN_MS,
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
 * whole-read deadline, a client that goes away, the cancel sent by the backend's own pid (never
 * `processID`) and AWAITED before the connection is given up, a cancelled connection destroyed
 * (never back to the pool), a statement that ignores its cancel abandoned after the grace, a cancel
 * that could not be sent holding the slot until the statement's own timeout bound, the
 * `statement_timeout` budgeted to end a statement before the deadline (so the server's timeout wins
 * and the connection is reused), a query read shared by identical requests, and the slot freed only
 * once the statement has ended. The connection is a fake: these are the guards' rules, not SQL (the
 * read's SQL, the real cancel and the real disconnect are held on Postgres in
 * `compare-agents.test.ts`).
 */

/** The fake's settings answer: the backend's own pid, and the session's own statement_timeout (none). */
const BACKEND_PID = 4242;
function settingsRow(values: unknown[] | undefined) {
  return { rows: [{ pid: BACKEND_PID, ceiling_ms: '0', applied_ms: String(values?.[0]) }] };
}

const SCOPE: CompareWindowScope = {
  tenantId: 't1', accountId: 'a1', campaignId: '00000000-0000-4000-8000-0000000000c1',
  from: '2026-11-01', to: '2026-11-02', timezone: 'UTC', databaseTimezone: 'UTC', start: new Date('2026-11-01T00:00:00Z'), end: new Date('2026-11-03T00:00:00Z'),
};

/**
 * A connection whose roster statement runs until cancelled (`endsOnCancel`), until its own
 * `statement_timeout` (`honoursTimeout`: as Postgres would end it), or forever. Its `processID` is a
 * pooler's number (as behind the Supabase session pooler), never the backend's pid.
 */
function fakeConnection(o: { endsOnCancel: boolean; cancelTakesMs?: number; cancelAnswers?: boolean | 'throws'; honoursTimeout?: boolean }) {
  const log: string[] = [];
  const settings: unknown[][] = [];
  let failRunning: ((err: unknown) => void) | null = null;
  let timeoutMs = 0;
  const client = {
    processID: 1,
    query(text: string, values?: unknown[]) {
      const t = text.trim();
      if (/^BEGIN/.test(t)) { log.push('BEGIN/set'); return Promise.resolve({ rows: [] }); }
      if (/pg_backend_pid/.test(t)) {
        log.push('BEGIN/set');
        settings.push(values ?? []);
        timeoutMs = Number(values?.[0]);
        return Promise.resolve(settingsRow(values));
      }
      if (/set_config/.test(t)) { log.push(`lowered ${String(values?.[0])}`); timeoutMs = Number(values?.[0]); return Promise.resolve({ rows: [] }); }
      if (t === 'ROLLBACK') { log.push('ROLLBACK'); return Promise.resolve({ rows: [] }); }
      log.push('statement');
      return new Promise((_, reject) => {
        failRunning = reject;
        if (o.honoursTimeout) setTimeout(() => reject(Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' })), timeoutMs);
      });
    },
    release(destroy?: boolean) { log.push(destroy === true ? 'destroyed' : 'released'); },
  };
  return {
    log,
    settings,
    pool: { connect: async () => client as never },
    cancelBackend: async (pid: number) => {
      log.push(`cancel ${pid}`);
      await new Promise((r) => setTimeout(r, o.cancelTakesMs ?? 10));
      if (o.cancelAnswers === 'throws') throw new Error('no pool');
      if (o.endsOnCancel) setTimeout(() => failRunning?.(Object.assign(new Error('canceling statement'), { code: '57014' })), 30);
      log.push('cancel sent');
      return o.cancelAnswers ?? true;
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
    expect(conn.log).toEqual(['BEGIN/set', 'BEGIN/set', 'statement', `cancel ${BACKEND_PID}`, 'cancel sent', 'destroyed']);
    expect(r.inFlight('t1')).toBe(0);
  });

  it('sets statement_timeout to what is left of the budget less the margin, and caps the parallel workers', async () => {
    const conn = fakeConnection({ endsOnCancel: true });
    const r = reads(conn, 2_000);
    await r.cohort(SCOPE).catch(() => undefined);
    const [budget, workers] = conn.settings[0]!;
    expect(Number(budget)).toBeLessThanOrEqual(2_000 - COMPARE_STATEMENT_TIMEOUT_MARGIN_MS);
    expect(Number(budget)).toBeGreaterThan(2_000 - COMPARE_STATEMENT_TIMEOUT_MARGIN_MS - 100);
    expect(Number(workers)).toBe(COMPARE_MAX_PARALLEL_WORKERS_PER_GATHER);
  }, 10_000);

  it('a statement past it is ended by the server first: rolled back, the connection reused, no cancel: 503', async () => {
    const conn = fakeConnection({ endsOnCancel: false, honoursTimeout: true });
    const r = reads(conn, 600);
    const err = await r.cohort(SCOPE).catch((e: unknown) => e);
    expect((err as CompareRefusal).code).toBe('compare_timed_out');
    expect(conn.log).toEqual(['BEGIN/set', 'BEGIN/set', 'statement', 'ROLLBACK', 'released']);
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
    expect(conn.log).toEqual(['BEGIN/set', 'BEGIN/set', 'statement', `cancel ${BACKEND_PID}`, 'cancel sent', 'destroyed']);
  });

  it('a cancel that could not be sent holds the slot until the statement\'s own timeout bound has passed', async () => {
    // The statement runs on (no cancel reached it) until its statement_timeout, about 1.3 s here.
    const conn = fakeConnection({ endsOnCancel: false, cancelAnswers: false });
    const r = reads(conn, 1_500);
    const gone = new AbortController();
    const started = Date.now();
    const read = r.cohort(SCOPE, gone.signal).catch((e: unknown) => e);
    await new Promise((res) => setTimeout(res, 20));
    gone.abort();
    // Past the grace a signalled statement would get: still held, its bound not yet passed.
    await new Promise((res) => setTimeout(res, COMPARE_CANCEL_GRACE_MS + 200));
    expect(r.inFlight('t1')).toBe(1);
    expect(await read).toBeInstanceOf(CompareAborted);
    expect(Date.now() - started).toBeGreaterThanOrEqual(1_500 - COMPARE_STATEMENT_TIMEOUT_MARGIN_MS + COMPARE_CANCEL_GRACE_MS - 50);
    expect(r.inFlight('t1')).toBe(0);
    expect(conn.log.at(-1)).toBe('destroyed');
  }, 10_000);

  it('a cancel that throws is one not sent: never escapes the listener, and the connection is still given up', async () => {
    const conn = fakeConnection({ endsOnCancel: false, cancelAnswers: 'throws' });
    const r = reads(conn, 400);
    const gone = new AbortController();
    const read = r.cohort(SCOPE, gone.signal).catch((e: unknown) => e);
    await new Promise((res) => setTimeout(res, 20));
    gone.abort();
    expect(await read).toBeInstanceOf(CompareAborted);
    expect(conn.log.at(-1)).toBe('destroyed');
    expect(r.inFlight('t1')).toBe(0);
  }, 10_000);
});

describe('statement_timeout follows the whole read\'s budget', () => {
  it('a later statement is sent under what is left of the budget, not the first value', async () => {
    let step = 0;
    const log: string[] = [];
    const client = {
      processID: 1,
      query(text: string, values?: unknown[]) {
        const t = text.trim();
        if (/^BEGIN/.test(t)) return Promise.resolve({ rows: [] });
        if (/pg_backend_pid/.test(t)) { log.push(`set ${String(values?.[0])}`); return Promise.resolve(settingsRow(values)); }
        if (/set_config/.test(t)) { log.push(`lowered ${String(values?.[0])}`); return Promise.resolve({ rows: [] }); }
        if (t === 'ROLLBACK') return Promise.resolve({ rows: [] });
        step += 1;
        log.push(`statement ${step}`);
        // The cohort's attempt statement takes 400 ms and finds the agent; the next is the occupancy.
        if (step === 1) {
          return new Promise((res) => setTimeout(() => res({
            rows: [{ agent_user_id: 'a1', attempts: '1', connected: '1', successes: '0', talk_seconds: '0', wrapup_seconds: '0', human_connects: '0', first_dials: '1', measured_wrapups: '0', campaigns: '1', last_dialed_at: null }],
          }), 400));
        }
        return Promise.resolve({ rows: [] });
      },
      release() { log.push('released'); },
    };
    const r = new CompareReads({
      timeoutMs: 2_000,
      deps: {
        pool: { connect: async () => client as never }, cancelBackend: async () => true, poolMax: () => 30,
        memberships: async () => [], names: async () => new Map(), now: () => new Date(),
      },
    });
    await r.query({ ...SCOPE, agentIds: ['a1'], metrics: [], trend: null });
    const first = Number(log.find((l) => l.startsWith('set '))!.slice(4));
    const lowered = log.find((l) => l.startsWith('lowered '));
    expect(lowered, log.join(' | ')).toBeDefined();
    const second = Number(lowered!.slice(8));
    // Lowered by about the 400 ms the first statement took, sent just before the second statement.
    expect(first - second).toBeGreaterThanOrEqual(350);
    expect(log.indexOf(lowered!)).toBe(log.indexOf('statement 2') - 1);
  });
});

describe('a query read shared by identical requests (SharedLoad)', () => {
  /** A connection whose roster statement waits until `finish` or a cancel. */
  function held() {
    const log: string[] = [];
    let settle: ((v: unknown) => void) | null = null;
    let fail: ((e: unknown) => void) | null = null;
    let connects = 0;
    const client = {
      processID: 1,
      query(text: string, values?: unknown[]) {
        const t = text.trim();
        if (/^BEGIN/.test(t)) return Promise.resolve({ rows: [] });
        if (/pg_backend_pid/.test(t)) return Promise.resolve(settingsRow(values));
        if (/set_config/.test(t) || t === 'ROLLBACK') return Promise.resolve({ rows: [] });
        log.push('statement');
        return new Promise((res, rej) => { settle = res; fail = rej; });
      },
      release(destroy?: boolean) { log.push(destroy === true ? 'destroyed' : 'released'); },
    };
    const r = new CompareReads({
      timeoutMs: 10_000,
      deps: {
        pool: { connect: async () => { connects += 1; return client as never; } },
        cancelBackend: async (pid) => { log.push(`cancel ${pid}`); setTimeout(() => fail?.(Object.assign(new Error('canceled'), { code: '57014' })), 10); return true; },
        poolMax: () => 30, memberships: async () => [], names: async () => new Map(), now: () => new Date(),
      },
    });
    return { r, log, connects: () => connects, finish: () => settle?.({ rows: [] }) };
  }
  const Q = { ...SCOPE, agentIds: ['a1'], metrics: [], trend: null };
  const tick = (ms = 20) => new Promise((res) => setTimeout(res, ms));

  it('a joiner runs nothing and takes no slot; both get the one answer', async () => {
    const h = held();
    const first = h.r.query(Q);
    await tick();
    const joiner = h.r.query(Q);
    await tick();
    expect(h.connects()).toBe(1);
    expect(h.r.inFlight('t1')).toBe(1);
    h.finish();
    expect(await first).toEqual({ kind: 'not_in_cohort' });
    expect(await joiner).toEqual({ kind: 'not_in_cohort' });
    expect(h.r.inFlight('t1')).toBe(0);
  });

  it('the read runs on while one request still waits; the last to leave cancels it', async () => {
    const h = held();
    const a = new AbortController();
    const b = new AbortController();
    const first = h.r.query(Q, a.signal).catch((e: unknown) => e);
    await tick();
    const joiner = h.r.query(Q, b.signal).catch((e: unknown) => e);
    await tick();
    a.abort();
    expect(await first).toBeInstanceOf(CompareAborted);
    await tick(50);
    // One request still waits: no cancel, the slot still held.
    expect(h.log).toEqual(['statement']);
    expect(h.r.inFlight('t1')).toBe(1);
    b.abort();
    expect(await joiner).toBeInstanceOf(CompareAborted);
    await vi.waitFor(() => expect(h.r.inFlight('t1')).toBe(0));
    expect(h.log).toEqual(['statement', `cancel ${BACKEND_PID}`, 'destroyed']);
    // A new request for the key starts afresh (the aborted read left nothing behind).
    const again = h.r.query(Q);
    await tick();
    expect(h.connects()).toBe(2);
    h.finish();
    expect(await again).toEqual({ kind: 'not_in_cohort' });
  });

  it('a request that leaves after the read settled changes nothing', async () => {
    const h = held();
    const a = new AbortController();
    const first = h.r.query(Q, a.signal);
    await tick();
    h.finish();
    expect(await first).toEqual({ kind: 'not_in_cohort' });
    a.abort();
    await tick();
    expect(h.log).toEqual(['statement', 'released']);
  });
});

describe('a statement that ends by itself while its cancel is on the way', () => {
  it('the connection is given up only once the cancel has been sent, and destroyed', async () => {
    const log: string[] = [];
    let finish: ((v: unknown) => void) | null = null;
    const client = {
      processID: 7,
      query(text: string, values?: unknown[]) {
        if (/pg_backend_pid/.test(text)) return Promise.resolve(settingsRow(values));
        if (/^BEGIN|set_config/.test(text.trim())) return Promise.resolve({ rows: [] });
        if (text.trim() === 'ROLLBACK') { log.push('ROLLBACK'); return Promise.resolve({ rows: [] }); }
        log.push('statement');
        return new Promise((resolve) => { finish = resolve; });
      },
      release(destroy?: boolean) { log.push(destroy === true ? 'destroyed' : 'released'); },
    };
    const r = new CompareReads({
      timeoutMs: 10_000,
      deps: {
        pool: { connect: async () => client as never },
        // A slow cancel: the statement finishes on its own before the cancel is through.
        cancelBackend: async () => { log.push('cancel'); finish?.({ rows: [] }); await new Promise((res) => setTimeout(res, 80)); log.push('cancel sent'); return true; },
        poolMax: () => 30, memberships: async () => [], names: async () => new Map(), now: () => new Date(),
      },
    });
    const gone = new AbortController();
    const read = r.cohort(SCOPE, gone.signal).catch((e: unknown) => e);
    await new Promise((res) => setTimeout(res, 20));
    gone.abort();
    expect(await read).toBeInstanceOf(CompareAborted);
    expect(log).toEqual(['statement', 'cancel', 'cancel sent', 'destroyed']);
    expect(r.inFlight('t1')).toBe(0);
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
