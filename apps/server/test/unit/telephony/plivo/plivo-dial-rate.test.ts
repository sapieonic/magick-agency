// Plivo's per-account calls-per-second gate: a fixed one-second window per account,
// shared in Redis, with a bounded wait for a slot.
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
  it('admits perSecond dials per account per wall-clock second', async () => {
    const c = clock(10_000_250);
    const l = new InMemoryPlivoDialRateLimiter(c.now);
    expect(await l.tryAcquire('MA1', 2)).toEqual({ admitted: true });
    expect(await l.tryAcquire('MA1', 2)).toEqual({ admitted: true });
    expect(await l.tryAcquire('MA1', 2)).toEqual({ admitted: false, retryAfterMs: 750 });
    // Another account has its own window.
    expect(await l.tryAcquire('MA2', 2)).toEqual({ admitted: true });
    c.advance(750);
    expect(await l.tryAcquire('MA1', 2)).toEqual({ admitted: true });
  });
});

describe('acquirePlivoDialSlot', () => {
  it('waits for the next window, then admits', async () => {
    const c = clock(5_000_900);
    const l = new InMemoryPlivoDialRateLimiter(c.now);
    for (let i = 0; i < 2; i++) await l.tryAcquire('MA1', 2);
    const res = await acquirePlivoDialSlot(l, 'MA1', { perSecond: 2, maxWaitMs: 5000, now: c.now, sleep: c.sleep });
    expect(res.admitted).toBe(true);
    expect(c.sleep).toHaveBeenCalledTimes(1);
    expect(res.waitedMs).toBe(105);
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

/** A fake ioredis `multi()` over an in-memory counter. */
function fakeRedis(opts: { fail?: boolean } = {}) {
  const counts = new Map<string, number>();
  const expiries = new Map<string, number>();
  const multi = vi.fn(() => {
    const ops: Array<() => [Error | null, unknown]> = [];
    const chain = {
      incr(key: string) {
        ops.push(() => { const n = (counts.get(key) ?? 0) + 1; counts.set(key, n); return [null, n]; });
        return chain;
      },
      pexpire(key: string, ms: number) {
        ops.push(() => { expiries.set(key, ms); return [null, 1]; });
        return chain;
      },
      async exec() {
        if (opts.fail) throw new Error('Command timed out');
        return ops.map((op) => op());
      },
    };
    return chain;
  });
  return { redis: { multi } as never, counts, expiries, multi };
}

describe('RedisPlivoDialRateLimiter', () => {
  it('counts per account and window in Redis, keys expiring after two windows', async () => {
    const c = clock(42_000_300);
    const r = fakeRedis();
    const l = new RedisPlivoDialRateLimiter(r.redis, 'pfx:', c.now);
    expect(await l.tryAcquire('MA1', 2)).toEqual({ admitted: true });
    expect(await l.tryAcquire('MA1', 2)).toEqual({ admitted: true });
    expect(await l.tryAcquire('MA1', 2)).toEqual({ admitted: false, retryAfterMs: 700 });
    expect([...r.counts.keys()]).toEqual(['pfx:plivo:dial_rate:MA1:42000']);
    expect(r.expiries.get('pfx:plivo:dial_rate:MA1:42000')).toBe(2000);
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

  it('falls back to counting in this process when Redis errors', async () => {
    const c = clock(1_000);
    const l = new RedisPlivoDialRateLimiter(fakeRedis({ fail: true }).redis, '', c.now);
    expect((await l.tryAcquire('MA1', 1)).admitted).toBe(true);
    expect((await l.tryAcquire('MA1', 1)).admitted).toBe(false);
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
