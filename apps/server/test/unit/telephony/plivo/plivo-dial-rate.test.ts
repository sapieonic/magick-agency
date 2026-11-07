// Plivo's per-account calls-per-second gate: a sliding 1000 ms window per account (a log of
// admission times), shared in Redis, with a bounded wait for a slot. The Lua script itself
// runs against real Redis in test/integration/telephony/plivo-dial-rate.test.ts.
import { createHash } from 'node:crypto';
import { describe, it, expect, vi } from 'vitest';

vi.mock('@magick-agency/observability', () => ({
  createChildLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import {
  InMemoryPlivoDialRateLimiter,
  RedisPlivoDialRateLimiter,
  acquirePlivoDialSlot,
  getPlivoDialRateLimiter,
  setPlivoDialRateLimiter,
} from '../../../../src/telephony/plivo/plivo-dial-rate.js';

function clock(start: number) {
  let t = start;
  return {
    now: () => t,
    sleep: vi.fn(async (ms: number) => { t += ms; }),
    advance: (ms: number) => { t += ms; },
  };
}

describe('InMemoryPlivoDialRateLimiter', () => {
  it('admits perSecond dials per account in any 1000 ms, refusing until the oldest ages out', async () => {
    const c = clock(10_000_250);
    const l = new InMemoryPlivoDialRateLimiter(c.now);
    expect(await l.tryAcquire('MA1', 2)).toEqual({ admitted: true });
    expect(await l.tryAcquire('MA1', 2)).toEqual({ admitted: true });
    expect(await l.tryAcquire('MA1', 2)).toEqual({ admitted: false, retryAfterMs: 1000 });
    // Another account has its own window.
    expect(await l.tryAcquire('MA2', 2)).toEqual({ admitted: true });
    // Past the wall-clock second, but both admissions are still in the window.
    c.advance(750);
    expect(await l.tryAcquire('MA1', 2)).toEqual({ admitted: false, retryAfterMs: 250 });
    c.advance(250);
    expect(await l.tryAcquire('MA1', 2)).toEqual({ admitted: true });
  });

  it('admits no more than perSecond dials in any 1000 ms span', async () => {
    let t = 999; const rate = new InMemoryPlivoDialRateLimiter(() => t); const admittedAt: number[] = [];
    for (const at of [999, 999, 1000, 1000]) { t = at; if ((await rate.tryAcquire('MA1', 2)).admitted) admittedAt.push(at); }
    expect(admittedAt.length).toBeLessThanOrEqual(2);
  });

  it('frees slots one at a time, as each admission ages out', async () => {
    const c = clock(0);
    const l = new InMemoryPlivoDialRateLimiter(c.now);
    c.advance(100); await l.tryAcquire('MA1', 2);
    c.advance(300); await l.tryAcquire('MA1', 2);
    c.advance(200); // t = 600
    expect(await l.tryAcquire('MA1', 2)).toEqual({ admitted: false, retryAfterMs: 500 });
    c.advance(500); // t = 1100: the admission at 100 has aged out, the one at 400 has not
    expect(await l.tryAcquire('MA1', 2)).toEqual({ admitted: true });
    expect(await l.tryAcquire('MA1', 2)).toEqual({ admitted: false, retryAfterMs: 300 });
  });

  it('a lowered limit waits for enough admissions to age out', async () => {
    const c = clock(0);
    const l = new InMemoryPlivoDialRateLimiter(c.now);
    for (const step of [0, 100, 100]) { c.advance(step); await l.tryAcquire('MA1', 3); } // at 0, 100, 200
    // At 1/s the slot frees when the newest (200) ages out.
    expect(await l.tryAcquire('MA1', 1)).toEqual({ admitted: false, retryAfterMs: 1000 });
  });

  it('accounts idle for a window leave nothing behind once many accounts are held', async () => {
    const c = clock(0);
    const l = new InMemoryPlivoDialRateLimiter(c.now);
    for (let i = 0; i < 1001; i++) await l.tryAcquire(`MA${i}`, 2);
    c.advance(1000);
    await l.tryAcquire('fresh', 2);
    expect((l as unknown as { logs: Map<string, number[]> }).logs.size).toBe(1);
  });
});

describe('acquirePlivoDialSlot', () => {
  it('clamps the limit once, to a whole number of at least 1, and floors the wait at 1 ms', async () => {
    const c = clock(0);
    const limits: number[] = [];
    let refusals = 1;
    const rate = {
      tryAcquire: vi.fn(async (_ref: string, perSecond: number) => {
        limits.push(perSecond);
        return refusals-- > 0 ? { admitted: false as const, retryAfterMs: 0 } : { admitted: true as const };
      }),
    };
    expect(await acquirePlivoDialSlot(rate, 'MA1', { perSecond: 0.5, maxWaitMs: 5000, now: c.now, sleep: c.sleep }))
      .toEqual({ admitted: true, waitedMs: 1 });
    expect(c.sleep).toHaveBeenCalledWith(1);
    await acquirePlivoDialSlot(rate, 'MA1', { perSecond: 2.9, maxWaitMs: 5000, now: c.now, sleep: c.sleep });
    expect(limits).toEqual([1, 1, 2]);
  });

  it('sleeps exactly until the oldest admission ages out, then admits', async () => {
    const c = clock(5_000_900);
    const l = new InMemoryPlivoDialRateLimiter(c.now);
    for (let i = 0; i < 2; i++) await l.tryAcquire('MA1', 2);
    const res = await acquirePlivoDialSlot(l, 'MA1', { perSecond: 2, maxWaitMs: 5000, now: c.now, sleep: c.sleep });
    expect(res.admitted).toBe(true);
    expect(c.sleep.mock.calls).toEqual([[1000]]);
    expect(res.waitedMs).toBe(1000);
  });

  it('returns as soon as a slot frees, not a full window later', async () => {
    const c = clock(0);
    const l = new InMemoryPlivoDialRateLimiter(c.now);
    await l.tryAcquire('MA1', 2);
    c.advance(300); await l.tryAcquire('MA1', 2);
    c.advance(200); // t = 500; the admission at 0 frees its slot at 1000
    const res = await acquirePlivoDialSlot(l, 'MA1', { perSecond: 2, maxWaitMs: 5000, now: c.now, sleep: c.sleep });
    expect(res).toEqual({ admitted: true, waitedMs: 500 });
    expect(c.sleep.mock.calls).toEqual([[500]]);
  });

  it('a burst of five at 2/s takes three windows', async () => {
    const c = clock(7_000_000);
    const l = new InMemoryPlivoDialRateLimiter(c.now);
    const waits: number[] = [];
    for (let i = 0; i < 5; i++) {
      const r = await acquirePlivoDialSlot(l, 'MA1', { perSecond: 2, maxWaitMs: 5000, now: c.now, sleep: c.sleep });
      expect(r.admitted).toBe(true);
      waits.push(Math.floor((c.now() - 7_000_000) / 1000));
    }
    expect(waits).toEqual([0, 0, 1, 1, 2]);
  });

  it('refuses when the next window opens after maxWaitMs, without sleeping past it', async () => {
    const c = clock(9_000_100);
    const l = new InMemoryPlivoDialRateLimiter(c.now);
    await l.tryAcquire('MA1', 1);
    const res = await acquirePlivoDialSlot(l, 'MA1', { perSecond: 1, maxWaitMs: 500, now: c.now, sleep: c.sleep });
    expect(res).toEqual({ admitted: false, waitedMs: 0 });
    expect(c.sleep).not.toHaveBeenCalled();
  });

  it('a zero wait budget refuses at once when the window is full', async () => {
    const c = clock(1_000);
    const l = new InMemoryPlivoDialRateLimiter(c.now);
    expect((await acquirePlivoDialSlot(l, 'MA1', { perSecond: 1, maxWaitMs: 0, now: c.now, sleep: c.sleep })).admitted).toBe(true);
    expect((await acquirePlivoDialSlot(l, 'MA1', { perSecond: 1, maxWaitMs: 0, now: c.now, sleep: c.sleep })).admitted).toBe(false);
  });
});

/**
 * A fake ioredis `eval` standing in for the script: one shared store, the script's
 * rule played by the in-memory limiter keyed by KEYS[1] at ARGV[1]'s time. The script
 * itself is proven against real Redis in the integration test.
 */
function fakeRedis(opts: { fail?: boolean; reply?: unknown } = {}) {
  let at = 0;
  const store = new InMemoryPlivoDialRateLimiter(() => at);
  const evalFn = vi.fn(async (_script: string, _n: number, key: string, t: number, limit: number, _w: number, _m: string) => {
    if (opts.fail) throw new Error('Command timed out');
    if (opts.reply !== undefined) return opts.reply;
    at = t;
    const s = await store.tryAcquire(key, limit);
    return s.admitted ? [1, 0] : [0, s.retryAfterMs];
  });
  return { redis: { eval: evalFn } as never, eval: evalFn };
}

describe('RedisPlivoDialRateLimiter', () => {
  it('runs one script per dial on one key per account, with the time, limit, window and a unique member', async () => {
    const c = clock(42_000_300);
    const r = fakeRedis();
    const l = new RedisPlivoDialRateLimiter(r.redis, 'pfx:', c.now);
    expect(await l.tryAcquire('MA1', 2)).toEqual({ admitted: true });
    expect(await l.tryAcquire('MA1', 2)).toEqual({ admitted: true });
    expect(await l.tryAcquire('MA1', 2)).toEqual({ admitted: false, retryAfterMs: 1000 });
    const calls = r.eval.mock.calls;
    expect(calls.map((a) => a.slice(1, 6))).toEqual(Array(3).fill([1, 'pfx:plivo:dial_rate:MA1', 42_000_300, 2, 1000]));
    expect(new Set(calls.map((a) => a[6])).size).toBe(3);
  });

  it('an unexpected script reply falls back to counting in this process', async () => {
    const c = clock(1_000);
    const l = new RedisPlivoDialRateLimiter(fakeRedis({ reply: 'OK' }).redis, '', c.now);
    expect((await l.tryAcquire('MA1', 1)).admitted).toBe(true);
    expect((await l.tryAcquire('MA1', 1)).admitted).toBe(false);
  });

  it('two processes sharing Redis share the window', async () => {
    const c = clock(42_000_300);
    const r = fakeRedis();
    const a = new RedisPlivoDialRateLimiter(r.redis, '', c.now);
    const b = new RedisPlivoDialRateLimiter(r.redis, '', c.now);
    expect((await a.tryAcquire('MA1', 2)).admitted).toBe(true);
    expect((await b.tryAcquire('MA1', 2)).admitted).toBe(true);
    expect((await a.tryAcquire('MA1', 2)).admitted).toBe(false);
  });

  it('sends the script by its SHA1, and in full only when Redis answers NOSCRIPT', async () => {
    const c = clock(5_000);
    const r = fakeRedis();
    const loaded = new Set<string>();
    const evalsha = vi.fn(async (sha: string, ...rest: [number, string, number, number, number, string]) => {
      if (!loaded.has(sha)) throw new Error('NOSCRIPT No matching script. Please use EVAL.');
      return r.eval('', ...rest);
    });
    const evalFn = vi.fn(async (script: string, ...rest: [number, string, number, number, number, string]) => {
      loaded.add(createHash('sha1').update(script).digest('hex'));
      return r.eval(script, ...rest);
    });
    const l = new RedisPlivoDialRateLimiter({ eval: evalFn, evalsha } as never, '', c.now);
    expect(await l.tryAcquire('MA1', 2)).toEqual({ admitted: true });
    expect(await l.tryAcquire('MA1', 2)).toEqual({ admitted: true });
    expect(await l.tryAcquire('MA1', 2)).toEqual({ admitted: false, retryAfterMs: 1000 });
    expect(evalFn).toHaveBeenCalledTimes(1);
    expect(evalsha).toHaveBeenCalledTimes(3);
  });

  it('an EVALSHA error other than NOSCRIPT falls back to counting in this process, not to EVAL', async () => {
    const c = clock(5_000);
    const evalFn = vi.fn();
    const evalsha = vi.fn(async () => { throw new Error('Command timed out'); });
    const l = new RedisPlivoDialRateLimiter({ eval: evalFn, evalsha } as never, '', c.now);
    expect((await l.tryAcquire('MA1', 1)).admitted).toBe(true);
    expect((await l.tryAcquire('MA1', 1)).admitted).toBe(false);
    expect(evalFn).not.toHaveBeenCalled();
  });

  it('falls back to counting in this process when Redis errors, on the same sliding window', async () => {
    const c = clock(999);
    const l = new RedisPlivoDialRateLimiter(fakeRedis({ fail: true }).redis, '', c.now);
    expect((await l.tryAcquire('MA1', 1)).admitted).toBe(true);
    c.advance(1); // across the second boundary: still within 1000 ms of the admission
    expect(await l.tryAcquire('MA1', 1)).toEqual({ admitted: false, retryAfterMs: 999 });
  });
});

describe('process-wide limiter', () => {
  it('is in-memory by default, replaceable, and null restores the default', () => {
    expect(getPlivoDialRateLimiter()).toBeInstanceOf(InMemoryPlivoDialRateLimiter);
    const custom = { tryAcquire: vi.fn() };
    setPlivoDialRateLimiter(custom);
    expect(getPlivoDialRateLimiter()).toBe(custom);
    setPlivoDialRateLimiter(null);
    expect(getPlivoDialRateLimiter()).toBeInstanceOf(InMemoryPlivoDialRateLimiter);
  });
});
