// PORT NOTE (magick-agency): ported from master test/unit/cache/local-cache.test.ts@a1f0756a — verbatim, import specifiers remapped only.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { LocalCache, LOCAL_CACHE_FAMILIES } from '../../../src/cache/local-cache.js';

describe('LocalCache', () => {
  const make = (ttlMs = 5_000, maxEntries = 100) => new LocalCache({ ttlMs, maxEntries });

  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('returns a stored value and reports a miss for an unknown key', () => {
    const c = make();
    c.set('cache:user:1', JSON.stringify({ id: '1' }));

    expect(c.get('cache:user:1')).toEqual({ value: { id: '1' } });
    expect(c.get('cache:user:2')).toBeUndefined();
  });

  it('distinguishes a cached null from a miss', () => {
    // A resolver that caches "no such record" stores null. If null meant miss,
    // every hit on a negative entry would fall through to Redis — exactly the
    // lookups the negative caching exists to avoid.
    const c = make();
    c.set('cache:account:1', JSON.stringify(null));

    expect(c.get('cache:account:1')).toEqual({ value: null });
    expect(c.get('cache:account:1')).not.toBeUndefined();
  });

  it('expires an entry once its TTL has elapsed', () => {
    const c = make(5_000);
    c.set('cache:user:1', JSON.stringify('v'));

    vi.advanceTimersByTime(4_999);
    expect(c.get('cache:user:1')).toEqual({ value: 'v' });

    vi.advanceTimersByTime(2);
    expect(c.get('cache:user:1')).toBeUndefined();
    // …and the dead entry is dropped rather than retained.
    expect(c.size).toBe(0);
  });

  it('evicts the least recently USED entry, not merely the oldest inserted', () => {
    const c = make(5_000, 2);
    c.set('a:1', JSON.stringify(1));
    c.set('b:2', JSON.stringify(2));

    // Touch the older key so the newer one becomes the eviction candidate.
    expect(c.get('a:1')).toEqual({ value: 1 });
    c.set('c:3', JSON.stringify(3));

    expect(c.size).toBe(2);
    expect(c.get('a:1')).toEqual({ value: 1 });
    expect(c.get('b:2')).toBeUndefined();
    expect(c.get('c:3')).toEqual({ value: 3 });
  });

  it('never grows past maxEntries', () => {
    const c = make(5_000, 10);
    for (let i = 0; i < 500; i++) c.set(`k:${i}`, JSON.stringify(i));

    expect(c.size).toBe(10);
  });

  it('deletes by glob pattern the way the membership invalidation uses it', () => {
    const c = make();
    c.set('cache:membership:u1:t1', JSON.stringify('a'));
    c.set('cache:membership:u2:t1', JSON.stringify('b'));
    c.set('cache:membership:u1:t2', JSON.stringify('c'));
    c.set('cache:user:u1', JSON.stringify('d'));

    c.deleteByPattern('cache:membership:*:t1');

    expect(c.get('cache:membership:u1:t1')).toBeUndefined();
    expect(c.get('cache:membership:u2:t1')).toBeUndefined();
    // A different tenant, and an unrelated family, are untouched.
    expect(c.get('cache:membership:u1:t2')).toEqual({ value: 'c' });
    expect(c.get('cache:user:u1')).toEqual({ value: 'd' });
  });

  it('treats regex metacharacters in a pattern literally', () => {
    // Without escaping, `.` and `+` in a key would let one tenant's
    // invalidation clear another's entries.
    const c = make();
    c.set('cache:tenant:a.b', JSON.stringify(1));
    c.set('cache:tenant:axb', JSON.stringify(2));

    c.deleteByPattern('cache:tenant:a.b');

    expect(c.get('cache:tenant:a.b')).toBeUndefined();
    expect(c.get('cache:tenant:axb')).toEqual({ value: 2 });
  });

  it('anchors the pattern so a prefix match does not clear a longer key', () => {
    const c = make();
    c.set('cache:tenant:t1', JSON.stringify(1));
    c.set('cache:tenant:t1:extra', JSON.stringify(2));

    c.deleteByPattern('cache:tenant:t1');

    expect(c.get('cache:tenant:t1')).toBeUndefined();
    expect(c.get('cache:tenant:t1:extra')).toEqual({ value: 2 });
  });

  it('hands every reader its own object rather than a shared instance', () => {
    // The Redis path returned a fresh JSON.parse per call. If the local layer
    // handed out one shared object, a caller mutating what it got would corrupt
    // every later request's copy for the whole TTL.
    const c = make();
    c.set('cache:user:1', JSON.stringify({ id: '1', roles: ['viewer'] }));

    const a = c.get('cache:user:1')!.value as { roles: string[] };
    const b = c.get('cache:user:1')!.value as { roles: string[] };

    expect(a).not.toBe(b);
    a.roles.push('tenant_owner');
    expect(b.roles).toEqual(['viewer']);
  });

  describe('epoch guard (setIfEpoch)', () => {
    it('drops a populate whose read started before an invalidation', () => {
      // Cache-aside's classic race: the read was issued BEFORE the revocation,
      // so the value in hand is already stale by the time it is written back.
      const c = make();
      const epoch = c.epochFor('cache:membership:u1:t1');

      c.delete('cache:membership:u1:t1');   // revocation lands mid-read

      const stored = c.setIfEpoch('cache:membership:u1:t1', JSON.stringify(['tenant_admin']), epoch);
      expect(stored).toBe(false);
      expect(c.get('cache:membership:u1:t1')).toBeUndefined();
    });

    it('drops a populate invalidated by a PATTERN delete too', () => {
      const c = make();
      const epoch = c.epochFor('cache:membership:u1:t1');

      c.deleteByPattern('cache:membership:*:t1');

      expect(c.setIfEpoch('cache:membership:u1:t1', JSON.stringify(['a']), epoch)).toBe(false);
      expect(c.get('cache:membership:u1:t1')).toBeUndefined();
    });

    it('stores normally when no invalidation intervened', () => {
      const c = make();
      const epoch = c.epochFor('cache:user:1');

      expect(c.setIfEpoch('cache:user:1', JSON.stringify({ id: '1' }), epoch)).toBe(true);
      expect(c.get('cache:user:1')).toEqual({ value: { id: '1' } });
    });
  });

  describe('isCacheable', () => {
    it('accepts every declared family', () => {
      for (const family of LOCAL_CACHE_FAMILIES) {
        expect(LocalCache.isCacheable(`${family}whatever`)).toBe(true);
      }
    });

    it('rejects the generation-fenced status-summary family', () => {
      // Those keys are written through the fenced helpers specifically so a
      // slow replica cannot refill an invalidated key; a local copy would sit
      // outside that fence.
      expect(LocalCache.isCacheable('cache:bulk-status-summary:t1:a1:ivr_call:abc')).toBe(false);
    });

    it('rejects unrelated families', () => {
      for (const key of ['cache:apikey:x', 'cache:csv:x', 'cache:phone:x', 'cache:telco:x', 'other']) {
        expect(LocalCache.isCacheable(key)).toBe(false);
      }
    });
  });
});
