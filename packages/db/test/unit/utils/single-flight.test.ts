import { describe, it, expect, vi } from 'vitest';
import { SingleFlight } from '../../../src/utils/single-flight.js';

/** A manually-resolvable promise, for deterministic race control. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('SingleFlight', () => {
  it('coalesces concurrent calls for the same key into one execution', async () => {
    const sf = new SingleFlight<number>();
    const fn = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 10));
      return 42;
    });

    const [a, b, c] = await Promise.all([
      sf.run('k', fn),
      sf.run('k', fn),
      sf.run('k', fn),
    ]);

    expect(a).toBe(42);
    expect(b).toBe(42);
    expect(c).toBe(42);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('runs different keys independently', async () => {
    const sf = new SingleFlight<string>();
    const fn = vi.fn(async (v: string) => v);

    const [a, b] = await Promise.all([
      sf.run('a', () => fn('a')),
      sf.run('b', () => fn('b')),
    ]);

    expect(a).toBe('a');
    expect(b).toBe('b');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('clears the in-flight entry after settling so a later call re-runs', async () => {
    const sf = new SingleFlight<number>();
    let calls = 0;
    const fn = async () => ++calls;

    expect(await sf.run('k', fn)).toBe(1);
    expect(sf.size).toBe(0);
    expect(await sf.run('k', fn)).toBe(2);
  });

  it('does not memoize failures — the next call retries', async () => {
    const sf = new SingleFlight<number>();
    let calls = 0;
    const fn = async () => {
      calls++;
      if (calls === 1) throw new Error('boom');
      return calls;
    };

    await expect(sf.run('k', fn)).rejects.toThrow('boom');
    expect(sf.size).toBe(0);
    expect(await sf.run('k', fn)).toBe(2);
  });

  it('shares a rejection across concurrent callers', async () => {
    const sf = new SingleFlight<number>();
    const fn = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 5));
      throw new Error('shared-failure');
    });

    const results = await Promise.allSettled([sf.run('k', fn), sf.run('k', fn)]);

    expect(results[0]!.status).toBe('rejected');
    expect(results[1]!.status).toBe('rejected');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('collapses 50 concurrent callers for the same key into a single execution', async () => {
    const sf = new SingleFlight<number>();
    const d = deferred<number>();
    const fn = vi.fn(() => d.promise);

    const promises = Array.from({ length: 50 }, () => sf.run('k', fn));
    // All 50 share the one in-flight entry.
    expect(sf.size).toBe(1);
    expect(fn).toHaveBeenCalledTimes(1);

    d.resolve(99);
    const results = await Promise.all(promises);

    expect(results).toEqual(Array.from({ length: 50 }, () => 99));
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sf.size).toBe(0);
  });

  it('runs many distinct keys concurrently and independently', async () => {
    const sf = new SingleFlight<string>();
    const deferreds = new Map<string, ReturnType<typeof deferred<string>>>();
    const keys = Array.from({ length: 10 }, (_, i) => `key-${i}`);

    const promises = keys.map((k) => {
      const d = deferred<string>();
      deferreds.set(k, d);
      return sf.run(k, () => d.promise);
    });

    // Each distinct key holds its own in-flight slot.
    expect(sf.size).toBe(10);

    // Resolve out of order.
    for (const k of [...keys].reverse()) deferreds.get(k)!.resolve(`v-${k}`);
    const results = await Promise.all(promises);

    expect(results).toEqual(keys.map((k) => `v-${k}`));
    expect(sf.size).toBe(0);
  });

  it('re-runs fn on each sequential (non-overlapping) call', async () => {
    const sf = new SingleFlight<number>();
    const fn = vi.fn(async () => 1);

    await sf.run('k', fn);
    await sf.run('k', fn);
    await sf.run('k', fn);

    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('size is 1 while a call is in flight and 0 once it settles', async () => {
    const sf = new SingleFlight<number>();
    const d = deferred<number>();

    expect(sf.size).toBe(0);
    const p = sf.run('k', () => d.promise);
    expect(sf.size).toBe(1);

    d.resolve(5);
    await p;
    expect(sf.size).toBe(0);
  });

  it('size returns to 0 after a rejection settles', async () => {
    const sf = new SingleFlight<number>();
    const d = deferred<number>();

    const p = sf.run('k', () => d.promise);
    expect(sf.size).toBe(1);

    d.reject(new Error('nope'));
    await expect(p).rejects.toThrow('nope');
    expect(sf.size).toBe(0);
  });

  it('surfaces a synchronous throw inside fn as a rejection', async () => {
    const sf = new SingleFlight<number>();
    const fn = vi.fn(() => {
      throw new Error('sync-boom');
    });

    // The async IIFE wrapper turns a sync throw into a rejected promise.
    await expect(sf.run('k', fn as () => Promise<number>)).rejects.toThrow('sync-boom');
  });

  it('does NOT leak the in-flight entry when fn throws synchronously', async () => {
    // A synchronous throw is normalized to a rejected promise, and the cleanup
    // runs as a microtask AFTER the entry is registered — so the entry clears
    // and the key is not left sticky (regression guard).
    const sf = new SingleFlight<number>();
    const fn = () => {
      throw new Error('sync-boom');
    };

    await expect(sf.run('k', fn as () => Promise<number>)).rejects.toThrow('sync-boom');
    // Entry cleared on settle.
    expect(sf.size).toBe(0);

    // A subsequent call for the same key re-runs a fresh fn (not sticky).
    const ok = vi.fn(async () => 7);
    expect(await sf.run('k', ok)).toBe(7);
    expect(ok).toHaveBeenCalledTimes(1);
  });

  it("ignores the second caller's fn while a call is in flight (key determines result)", async () => {
    const sf = new SingleFlight<string>();
    const d = deferred<string>();
    const firstFn = vi.fn(() => d.promise);
    const secondFn = vi.fn(async () => 'second');

    const pA = sf.run('k', firstFn);
    const pB = sf.run('k', secondFn); // secondFn must NOT run

    d.resolve('first');
    expect(await pA).toBe('first');
    expect(await pB).toBe('first'); // shares the first result
    expect(firstFn).toHaveBeenCalledTimes(1);
    expect(secondFn).not.toHaveBeenCalled();
  });

  it('interleaves two keys where one fails and one succeeds, independently', async () => {
    const sf = new SingleFlight<string>();
    const dOk = deferred<string>();
    const dErr = deferred<string>();

    const okP = sf.run('ok', () => dOk.promise);
    const errP = sf.run('err', () => dErr.promise);
    expect(sf.size).toBe(2);

    dErr.reject(new Error('failed-key'));
    await expect(errP).rejects.toThrow('failed-key');
    // The failing key is cleared; the succeeding key remains in flight.
    expect(sf.size).toBe(1);

    dOk.resolve('good');
    expect(await okP).toBe('good');
    expect(sf.size).toBe(0);
  });

  it('shares one failure across concurrent awaiters, then the next call retries fresh', async () => {
    const sf = new SingleFlight<number>();
    let attempt = 0;
    const d = deferred<number>();
    const fn = vi.fn(() => {
      attempt++;
      return d.promise;
    });

    const p1 = sf.run('k', fn);
    const p2 = sf.run('k', fn);
    expect(fn).toHaveBeenCalledTimes(1);

    d.reject(new Error('boom-1'));
    await expect(p1).rejects.toThrow('boom-1');
    await expect(p2).rejects.toThrow('boom-1');
    expect(attempt).toBe(1);
    expect(sf.size).toBe(0);

    // Next call retries with a fresh fn invocation.
    const retry = vi.fn(async () => 123);
    expect(await sf.run('k', retry)).toBe(123);
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('a new call for the same key AFTER settle starts a fresh flight', async () => {
    const sf = new SingleFlight<number>();
    const d1 = deferred<number>();
    const p1 = sf.run('k', () => d1.promise);
    d1.resolve(1);
    expect(await p1).toBe(1);

    // Same key again — brand-new in-flight entry.
    const d2 = deferred<number>();
    const fn2 = vi.fn(() => d2.promise);
    const p2 = sf.run('k', fn2);
    expect(sf.size).toBe(1);
    expect(fn2).toHaveBeenCalledTimes(1);
    d2.resolve(2);
    expect(await p2).toBe(2);
  });
});
