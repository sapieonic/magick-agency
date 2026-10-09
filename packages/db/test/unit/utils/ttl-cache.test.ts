import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TtlCache } from '../../../src/utils/ttl-cache.js';

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

describe('TtlCache', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns undefined on a miss and the value after set', () => {
    const cache = new TtlCache<number>({ ttlMs: 1000 });
    expect(cache.get('a')).toBeUndefined();
    cache.set('a', 1);
    expect(cache.get('a')).toBe(1);
  });

  it('expires entries after the TTL', () => {
    const cache = new TtlCache<number>({ ttlMs: 1000 });
    cache.set('a', 1);
    vi.advanceTimersByTime(999);
    expect(cache.get('a')).toBe(1);
    vi.advanceTimersByTime(2);
    expect(cache.get('a')).toBeUndefined();
  });

  it('negatively caches null (distinct from a miss)', async () => {
    const cache = new TtlCache<number | null>({ ttlMs: 1000 });
    const loader = vi.fn(async () => null);

    expect(await cache.getOrLoad('a', loader)).toBeNull();
    expect(await cache.getOrLoad('a', loader)).toBeNull();
    // Second call served from cache — loader only ran once.
    expect(loader).toHaveBeenCalledTimes(1);
    expect(cache.get('a')).toBeNull();
  });

  it('single-flights concurrent loads for the same key', async () => {
    const cache = new TtlCache<number>({ ttlMs: 1000 });
    const loader = vi.fn(async () => {
      await Promise.resolve();
      return 7;
    });

    const [a, b, c] = await Promise.all([
      cache.getOrLoad('k', loader),
      cache.getOrLoad('k', loader),
      cache.getOrLoad('k', loader),
    ]);

    expect([a, b, c]).toEqual([7, 7, 7]);
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('does not cache loader rejections', async () => {
    const cache = new TtlCache<number>({ ttlMs: 1000 });
    let calls = 0;
    const loader = async () => {
      calls++;
      if (calls === 1) throw new Error('load-fail');
      return calls;
    };

    await expect(cache.getOrLoad('k', loader)).rejects.toThrow('load-fail');
    expect(cache.get('k')).toBeUndefined();
    expect(await cache.getOrLoad('k', loader)).toBe(2);
  });

  it('reloads after TTL expiry via getOrLoad', async () => {
    const cache = new TtlCache<number>({ ttlMs: 1000 });
    let n = 0;
    const loader = async () => ++n;

    expect(await cache.getOrLoad('k', loader)).toBe(1);
    vi.advanceTimersByTime(1001);
    expect(await cache.getOrLoad('k', loader)).toBe(2);
  });

  it('evicts least-recently-used entries past maxEntries', () => {
    const cache = new TtlCache<number>({ ttlMs: 10_000, maxEntries: 2 });
    cache.set('a', 1);
    cache.set('b', 2);
    // Touch 'a' so 'b' becomes the LRU.
    expect(cache.get('a')).toBe(1);
    cache.set('c', 3); // exceeds cap → evict LRU ('b')

    expect(cache.get('a')).toBe(1);
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('c')).toBe(3);
    expect(cache.size).toBe(2);
  });

  it('invalidate drops a single key', async () => {
    const cache = new TtlCache<number>({ ttlMs: 1000 });
    const loader = vi.fn(async () => 5);
    await cache.getOrLoad('k', loader);
    cache.invalidate('k');
    await cache.getOrLoad('k', loader);
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it('ttlMs=0 disables caching but still single-flights concurrent calls', async () => {
    const cache = new TtlCache<number>({ ttlMs: 0 });
    const loader = vi.fn(async () => {
      await Promise.resolve();
      return 1;
    });

    // Concurrent → one load.
    await Promise.all([cache.getOrLoad('k', loader), cache.getOrLoad('k', loader)]);
    expect(loader).toHaveBeenCalledTimes(1);

    // Sequential → not cached, loads again.
    await cache.getOrLoad('k', loader);
    expect(loader).toHaveBeenCalledTimes(2);
  });

  // ── Invalidation-race safety (the H1 fix) ──────────────────────────────
  it('does NOT cache a load that raced with a concurrent invalidate() (revocation safety)', async () => {
    const cache = new TtlCache<string>({ ttlMs: 10_000 });
    let release!: (v: string) => void;
    const slow = new Promise<string>((r) => { release = r; });

    // Start a load that reads the "old" (pre-invalidate) value.
    const loadPromise = cache.getOrLoad('k', () => slow);
    // A concurrent invalidate lands while the load is in flight (e.g. key revoked).
    cache.invalidate('k');
    // The in-flight load now resolves with the stale value.
    release('stale');
    expect(await loadPromise).toBe('stale'); // caller still gets its result...

    // ...but it must NOT have been written to the cache.
    expect(cache.get('k')).toBeUndefined();
    // Next read re-loads fresh instead of serving the stale value.
    const fresh = vi.fn(async () => 'fresh');
    expect(await cache.getOrLoad('k', fresh)).toBe('fresh');
    expect(fresh).toHaveBeenCalledTimes(1);
  });

  it('does NOT let a slow load overwrite a fresher set() that landed during the load', async () => {
    const cache = new TtlCache<string>({ ttlMs: 10_000 });
    let release!: (v: string) => void;
    const slow = new Promise<string>((r) => { release = r; });

    const loadPromise = cache.getOrLoad('k', () => slow);
    // A write-through set (e.g. upsert) lands with the fresh value mid-load.
    cache.set('k', 'fresh-writethrough');
    release('stale-load');
    await loadPromise;

    // The write-through value wins; the stale load did not clobber it.
    expect(cache.get('k')).toBe('fresh-writethrough');
  });

  // ── Negative caching of undefined via getOrLoad (the M2 fix) ────────────
  it('caches an undefined loader result via getOrLoad (presence-based hit)', async () => {
    const cache = new TtlCache<number | undefined>({ ttlMs: 1000 });
    const loader = vi.fn(async () => undefined);

    expect(await cache.getOrLoad('k', loader)).toBeUndefined();
    expect(await cache.getOrLoad('k', loader)).toBeUndefined();
    // Served from cache the second time despite the value being `undefined`.
    expect(loader).toHaveBeenCalledTimes(1);
    expect(cache.has('k')).toBe(true);
  });

  // ── LRU / TTL read semantics ───────────────────────────────────────────
  it('a getOrLoad cache hit refreshes LRU recency', async () => {
    const cache = new TtlCache<number>({ ttlMs: 10_000, maxEntries: 2 });
    await cache.getOrLoad('a', async () => 1);
    await cache.getOrLoad('b', async () => 2);
    // Hit 'a' via getOrLoad → 'a' becomes MRU, 'b' the LRU.
    await cache.getOrLoad('a', async () => 99); // cached → returns 1, refreshes recency
    cache.set('c', 3); // evict LRU ('b')

    expect(cache.get('a')).toBe(1);
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('c')).toBe(3);
  });

  it('a get() hit does NOT extend the entry TTL', () => {
    const cache = new TtlCache<number>({ ttlMs: 1000 });
    cache.set('a', 1);
    vi.advanceTimersByTime(600);
    expect(cache.get('a')).toBe(1); // access at t=600
    vi.advanceTimersByTime(500); // t=1100 — past original 1000ms expiry
    expect(cache.get('a')).toBeUndefined(); // not refreshed by the earlier read
  });

  it('has() does not refresh LRU recency (non-touching)', () => {
    const cache = new TtlCache<number>({ ttlMs: 10_000, maxEntries: 2 });
    cache.set('a', 1);
    cache.set('b', 2);
    // has('a') must NOT promote 'a'; 'a' stays the LRU.
    expect(cache.has('a')).toBe(true);
    cache.set('c', 3); // evict LRU ('a')
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBe(2);
    expect(cache.get('c')).toBe(3);
  });

  it('stays bounded under churn of many distinct keys', () => {
    const cache = new TtlCache<number>({ ttlMs: 10_000, maxEntries: 100 });
    for (let i = 0; i < 10_000; i++) cache.set(`k${i}`, i);
    expect(cache.size).toBe(100);
    // The most recently inserted keys survive; the oldest are evicted.
    expect(cache.get('k9999')).toBe(9999);
    expect(cache.get('k0')).toBeUndefined();
  });

  // ── TTL boundary & lazy sweep ──────────────────────────────────────────
  it('treats the exact TTL boundary as expired (expiresAt <= now)', () => {
    const cache = new TtlCache<number>({ ttlMs: 1000 });
    cache.set('a', 1); // expiresAt = now + 1000
    vi.advanceTimersByTime(1000); // now === expiresAt → isExpired true (<=)
    expect(cache.get('a')).toBeUndefined();
  });

  it('is still a hit one tick before the boundary', () => {
    const cache = new TtlCache<number>({ ttlMs: 1000 });
    cache.set('a', 1);
    vi.advanceTimersByTime(999);
    expect(cache.get('a')).toBe(1);
  });

  it('drops the expired entry from the store on the next get (size shrinks)', () => {
    const cache = new TtlCache<number>({ ttlMs: 1000 });
    cache.set('a', 1);
    expect(cache.size).toBe(1);
    vi.advanceTimersByTime(1001);
    // Still physically present until touched (lazy expiry).
    expect(cache.size).toBe(1);
    expect(cache.get('a')).toBeUndefined();
    // Now swept.
    expect(cache.size).toBe(0);
  });

  it('drops the expired entry on has() as well', () => {
    const cache = new TtlCache<number>({ ttlMs: 1000 });
    cache.set('a', 1);
    vi.advanceTimersByTime(1001);
    expect(cache.size).toBe(1);
    expect(cache.has('a')).toBe(false);
    expect(cache.size).toBe(0);
  });

  it('has() is false for a never-set key and does not create anything', () => {
    const cache = new TtlCache<number>({ ttlMs: 1000 });
    expect(cache.has('missing')).toBe(false);
    expect(cache.size).toBe(0);
  });

  // ── set() semantics ────────────────────────────────────────────────────
  it('set() replaces the value and resets the TTL', () => {
    const cache = new TtlCache<number>({ ttlMs: 1000 });
    cache.set('a', 1);
    vi.advanceTimersByTime(900);
    cache.set('a', 2); // fresh TTL from t=900
    vi.advanceTimersByTime(900); // t=1800 (>1000 from first set, <1000 from second)
    expect(cache.get('a')).toBe(2);
    vi.advanceTimersByTime(200); // t=2000 → past second set's 1000ms
    expect(cache.get('a')).toBeUndefined();
  });

  it('set() moves a key to MRU (LRU eviction sees it as freshest)', () => {
    const cache = new TtlCache<number>({ ttlMs: 10_000, maxEntries: 2 });
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('a', 10); // re-set 'a' → 'a' becomes MRU, 'b' the LRU
    cache.set('c', 3); // evict LRU ('b')
    expect(cache.get('a')).toBe(10);
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('c')).toBe(3);
  });

  // ── invalidate / clear ─────────────────────────────────────────────────
  it('invalidate() on an absent key is a safe no-op', () => {
    const cache = new TtlCache<number>({ ttlMs: 1000 });
    expect(() => cache.invalidate('nope')).not.toThrow();
    expect(cache.size).toBe(0);
    cache.set('a', 1);
    cache.invalidate('a');
    expect(cache.get('a')).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it('clear() empties the store', () => {
    const cache = new TtlCache<number>({ ttlMs: 1000 });
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3);
    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('c')).toBeUndefined();
  });

  it('clear() cancels an in-flight load write-back (load returned but not cached)', async () => {
    const cache = new TtlCache<string>({ ttlMs: 10_000 });
    const d = deferred<string>();
    const loadPromise = cache.getOrLoad('k', () => d.promise);
    cache.clear(); // wipes the load token mid-flight
    d.resolve('stale');
    expect(await loadPromise).toBe('stale'); // caller still gets the value
    expect(cache.get('k')).toBeUndefined(); // but it was not written back
    expect(cache.size).toBe(0);
  });

  // ── getOrLoad hit vs miss ──────────────────────────────────────────────
  it('getOrLoad returns a fresh cached value without calling the loader (hit)', async () => {
    const cache = new TtlCache<number>({ ttlMs: 1000 });
    cache.set('k', 42);
    const loader = vi.fn(async () => 99);
    expect(await cache.getOrLoad('k', loader)).toBe(42);
    expect(loader).not.toHaveBeenCalled();
  });

  it('getOrLoad runs the loader and caches on a miss', async () => {
    const cache = new TtlCache<number>({ ttlMs: 1000 });
    const loader = vi.fn(async () => 42);
    expect(await cache.getOrLoad('k', loader)).toBe(42);
    expect(loader).toHaveBeenCalledTimes(1);
    // Second call is a hit.
    expect(await cache.getOrLoad('k', loader)).toBe(42);
    expect(loader).toHaveBeenCalledTimes(1);
  });

  // ── negative caching (null AND undefined) ──────────────────────────────
  it('serves a cached undefined from get() only via presence — getOrLoad does not re-run', async () => {
    const cache = new TtlCache<number | undefined>({ ttlMs: 1000 });
    const loader = vi.fn(async () => undefined);
    await cache.getOrLoad('k', loader);
    // get() cannot distinguish cached-undefined from a miss (documented caveat)…
    expect(cache.get('k')).toBeUndefined();
    // …but has() proves presence, and getOrLoad does not re-run the loader.
    expect(cache.has('k')).toBe(true);
    expect(await cache.getOrLoad('k', loader)).toBeUndefined();
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('caches both null and undefined independently for different keys', async () => {
    const cache = new TtlCache<number | null | undefined>({ ttlMs: 1000 });
    const nullLoader = vi.fn(async () => null);
    const undefLoader = vi.fn(async () => undefined);
    await cache.getOrLoad('n', nullLoader);
    await cache.getOrLoad('u', undefLoader);
    expect(await cache.getOrLoad('n', nullLoader)).toBeNull();
    expect(await cache.getOrLoad('u', undefLoader)).toBeUndefined();
    expect(nullLoader).toHaveBeenCalledTimes(1);
    expect(undefLoader).toHaveBeenCalledTimes(1);
  });

  it('negative cache respects TTL — reloads after expiry', async () => {
    const cache = new TtlCache<number | null>({ ttlMs: 1000 });
    const loader = vi.fn(async () => null);
    expect(await cache.getOrLoad('k', loader)).toBeNull();
    vi.advanceTimersByTime(1001);
    expect(await cache.getOrLoad('k', loader)).toBeNull();
    expect(loader).toHaveBeenCalledTimes(2);
  });

  // ── loader rejection ───────────────────────────────────────────────────
  it('a rejected loader is not cached and is retried, leaving no token behind', async () => {
    const cache = new TtlCache<number>({ ttlMs: 10_000 });
    const d1 = deferred<number>();
    const p1 = cache.getOrLoad('k', () => d1.promise);
    d1.reject(new Error('load-fail'));
    await expect(p1).rejects.toThrow('load-fail');
    expect(cache.has('k')).toBe(false);
    expect(cache.size).toBe(0);

    // Retry succeeds and caches.
    expect(await cache.getOrLoad('k', async () => 7)).toBe(7);
    expect(cache.get('k')).toBe(7);
  });

  it('concurrent callers share one rejected loader, then a later call retries', async () => {
    const cache = new TtlCache<number>({ ttlMs: 10_000 });
    const d = deferred<number>();
    const loader = vi.fn(() => d.promise);
    const p1 = cache.getOrLoad('k', loader);
    const p2 = cache.getOrLoad('k', loader);
    expect(loader).toHaveBeenCalledTimes(1);
    d.reject(new Error('shared'));
    await expect(p1).rejects.toThrow('shared');
    await expect(p2).rejects.toThrow('shared');
    expect(cache.has('k')).toBe(false);

    expect(await cache.getOrLoad('k', async () => 5)).toBe(5);
  });

  // ── invalidation-race variants ─────────────────────────────────────────
  it('invalidate() during load: value returned to caller, not cached', async () => {
    const cache = new TtlCache<string>({ ttlMs: 10_000 });
    const d = deferred<string>();
    const p = cache.getOrLoad('k', () => d.promise);
    cache.invalidate('k');
    d.resolve('stale');
    expect(await p).toBe('stale');
    expect(cache.get('k')).toBeUndefined();
  });

  it('set() during load: write-through wins and is not clobbered', async () => {
    const cache = new TtlCache<string>({ ttlMs: 10_000 });
    const d = deferred<string>();
    const p = cache.getOrLoad('k', () => d.promise);
    cache.set('k', 'writethrough');
    d.resolve('stale');
    await p;
    expect(cache.get('k')).toBe('writethrough');
  });

  it('no mutation during load: value IS cached (control case)', async () => {
    const cache = new TtlCache<string>({ ttlMs: 10_000 });
    const d = deferred<string>();
    const p = cache.getOrLoad('k', () => d.promise);
    d.resolve('loaded');
    expect(await p).toBe('loaded');
    // Nothing invalidated during the load → write-back happened.
    expect(cache.get('k')).toBe('loaded');
    expect(cache.has('k')).toBe(true);
  });

  it('a set() mid-load is not clobbered even when the loader resolves the same key later', async () => {
    const cache = new TtlCache<number>({ ttlMs: 10_000 });
    const d = deferred<number>();
    const loader = vi.fn(() => d.promise);
    const [p1, p2] = [cache.getOrLoad('k', loader), cache.getOrLoad('k', loader)];
    expect(loader).toHaveBeenCalledTimes(1); // single-flight
    cache.set('k', 100); // fresh write mid-load
    d.resolve(1); // stale load resolves
    expect(await p1).toBe(1); // both callers still get the loaded value
    expect(await p2).toBe(1);
    expect(cache.get('k')).toBe(100); // but the cache holds the fresher set()
  });

  // ── LRU eviction correctness under mixed access ────────────────────────
  it('LRU victim is correct under interleaved get/set/getOrLoad access', async () => {
    const cache = new TtlCache<number>({ ttlMs: 10_000, maxEntries: 3 });
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3);
    // Access pattern: touch a (get), touch b (getOrLoad hit) → c is LRU.
    expect(cache.get('a')).toBe(1);
    expect(await cache.getOrLoad('b', async () => 999)).toBe(2);
    cache.set('d', 4); // over cap → evict LRU ('c')
    expect(cache.get('c')).toBeUndefined();
    expect(cache.get('a')).toBe(1);
    expect(cache.get('b')).toBe(2);
    expect(cache.get('d')).toBe(4);
    expect(cache.size).toBe(3);
  });

  it('a getOrLoad miss inserts as MRU and can evict the current LRU', async () => {
    const cache = new TtlCache<number>({ ttlMs: 10_000, maxEntries: 2 });
    cache.set('a', 1);
    cache.set('b', 2); // 'a' is LRU
    await cache.getOrLoad('c', async () => 3); // insert MRU → evict 'a'
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBe(2);
    expect(cache.get('c')).toBe(3);
  });

  it('churn of thousands of distinct keys stays pinned at maxEntries', () => {
    const cache = new TtlCache<number>({ ttlMs: 100_000, maxEntries: 50 });
    for (let i = 0; i < 5000; i++) {
      cache.set(`k${i}`, i);
      expect(cache.size).toBeLessThanOrEqual(50);
    }
    expect(cache.size).toBe(50);
    // Newest survive, oldest evicted.
    expect(cache.get('k4999')).toBe(4999);
    expect(cache.get('k4950')).toBe(4950);
    expect(cache.get('k4949')).toBeUndefined();
  });

  // ── unbounded mode ─────────────────────────────────────────────────────
  it('maxEntries omitted → unbounded (grows, never evicts)', () => {
    const cache = new TtlCache<number>({ ttlMs: 100_000 });
    for (let i = 0; i < 1000; i++) cache.set(`k${i}`, i);
    expect(cache.size).toBe(1000);
    expect(cache.get('k0')).toBe(0);
    expect(cache.get('k999')).toBe(999);
  });

  it('maxEntries=0 → unbounded (treated same as omitted)', () => {
    const cache = new TtlCache<number>({ ttlMs: 100_000, maxEntries: 0 });
    for (let i = 0; i < 500; i++) cache.set(`k${i}`, i);
    expect(cache.size).toBe(500);
    expect(cache.get('k0')).toBe(0);
  });

  it('negative maxEntries is coerced to unbounded', () => {
    const cache = new TtlCache<number>({ ttlMs: 100_000, maxEntries: -5 });
    for (let i = 0; i < 100; i++) cache.set(`k${i}`, i);
    expect(cache.size).toBe(100);
  });

  // ── ttlMs=0 (pure single-flight) ───────────────────────────────────────
  it('ttlMs=0 dedups concurrent callers but never stores', async () => {
    const cache = new TtlCache<number>({ ttlMs: 0 });
    const d = deferred<number>();
    const loader = vi.fn(() => d.promise);
    const p1 = cache.getOrLoad('k', loader);
    const p2 = cache.getOrLoad('k', loader);
    expect(loader).toHaveBeenCalledTimes(1);
    d.resolve(1);
    expect(await p1).toBe(1);
    expect(await p2).toBe(1);
    // Nothing cached (expiresAt = now, immediately stale).
    expect(cache.get('k')).toBeUndefined();
    expect(cache.has('k')).toBe(false);
  });

  it('ttlMs=0: a set() value is immediately stale', () => {
    const cache = new TtlCache<number>({ ttlMs: 0 });
    cache.set('k', 5);
    expect(cache.get('k')).toBeUndefined();
    expect(cache.has('k')).toBe(false);
  });

  it('negative ttlMs is coerced to 0 (no caching)', async () => {
    const cache = new TtlCache<number>({ ttlMs: -1000 });
    const loader = vi.fn(async () => 1);
    await cache.getOrLoad('k', loader);
    expect(cache.get('k')).toBeUndefined();
    await cache.getOrLoad('k', loader);
    expect(loader).toHaveBeenCalledTimes(2);
  });

  // ── slow concurrent load + mid-load set (deferred determinism) ─────────
  it('concurrent slow getOrLoad: one loader, both get the result', async () => {
    const cache = new TtlCache<number>({ ttlMs: 10_000 });
    const d = deferred<number>();
    const loader = vi.fn(() => d.promise);
    const promises = Array.from({ length: 5 }, () => cache.getOrLoad('k', loader));
    expect(loader).toHaveBeenCalledTimes(1);
    d.resolve(77);
    const results = await Promise.all(promises);
    expect(results).toEqual([77, 77, 77, 77, 77]);
    expect(cache.get('k')).toBe(77);
  });

  // ── name field ─────────────────────────────────────────────────────────
  it("name defaults to 'ttl-cache' when omitted", () => {
    const cache = new TtlCache<number>({ ttlMs: 1000 });
    expect(cache.name).toBe('ttl-cache');
  });

  it('name is taken from options when provided', () => {
    const cache = new TtlCache<number>({ ttlMs: 1000, name: 'api-keys' });
    expect(cache.name).toBe('api-keys');
  });

  // ── independence of keys ───────────────────────────────────────────────
  it('invalidating one key does not affect others', () => {
    const cache = new TtlCache<number>({ ttlMs: 10_000 });
    cache.set('a', 1);
    cache.set('b', 2);
    cache.invalidate('a');
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBe(2);
  });

  it('after expiry, getOrLoad re-runs and the second read is a fresh hit', async () => {
    const cache = new TtlCache<number>({ ttlMs: 1000 });
    let n = 0;
    const loader = vi.fn(async () => ++n);
    expect(await cache.getOrLoad('k', loader)).toBe(1);
    vi.advanceTimersByTime(1001);
    expect(await cache.getOrLoad('k', loader)).toBe(2);
    // Immediately re-read → hit, no third load.
    expect(await cache.getOrLoad('k', loader)).toBe(2);
    expect(loader).toHaveBeenCalledTimes(2);
  });
});
