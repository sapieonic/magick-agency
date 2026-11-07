// The bounded per-entry-expiry cache behind the dialable caller-ID read
// (`agency/campaign-dialability.ts`): an expired entry is deleted when looked up, and a full
// cache drops its expired entries before its oldest live one.
import { describe, it, expect } from 'vitest';
import { ExpiringCache } from '../../../src/utils/expiring-cache.js';

describe('ExpiringCache', () => {
  it('answers a live entry and deletes an expired one when it is looked up', () => {
    const cache = new ExpiringCache<string>({ ttlMs: 100, maxEntries: 10 });
    cache.set('a', 'A', 1_000);
    expect(cache.get('a', 1_099)).toBe('A');
    expect(cache.size).toBe(1);
    expect(cache.get('a', 1_100)).toBeUndefined();
    expect(cache.size).toBe(0);
    expect(cache.get('missing', 1_000)).toBeUndefined();
  });

  it('at the cap drops every expired entry before any live one', () => {
    const cache = new ExpiringCache<number>({ ttlMs: 100, maxEntries: 3 });
    cache.set('live-old', 1, 950);
    cache.set('stale-1', 2, 800);
    cache.set('stale-2', 3, 850);
    cache.set('new', 4, 1_000);
    expect(cache.size).toBe(2);
    expect(cache.get('live-old', 1_000)).toBe(1);
    expect(cache.get('new', 1_000)).toBe(4);
  });

  it('at the cap with nothing expired drops the oldest written', () => {
    const cache = new ExpiringCache<number>({ ttlMs: 1_000, maxEntries: 2 });
    cache.set('first', 1, 0);
    cache.set('second', 2, 1);
    cache.set('first', 10, 2); // a rewrite makes it the newest
    cache.set('third', 3, 3);
    expect(cache.size).toBe(2);
    expect(cache.get('second', 3)).toBeUndefined();
    expect(cache.get('first', 3)).toBe(10);
    expect(cache.get('third', 3)).toBe(3);
  });

  it('clear forgets everything', () => {
    const cache = new ExpiringCache<number>({ ttlMs: 1_000, maxEntries: 2 });
    cache.set('a', 1, 0);
    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.get('a', 0)).toBeUndefined();
  });
});
