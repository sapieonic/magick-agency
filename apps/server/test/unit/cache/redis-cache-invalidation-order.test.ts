// PORT NOTE (magick-agency): ported from master test/unit/cache/redis-cache-invalidation-order.test.ts@a1f0756a — verbatim, import specifiers remapped only.
import { describe, it, expect, vi } from 'vitest';

vi.mock('@magick-agency/observability/metrics/platform', () => ({
  localCacheOperationsTotal: { inc: vi.fn() },
  localCacheInvalidationsTotal: { inc: vi.fn() },
}));

const { RedisCache } = await import('../../../src/cache/redis-cache.js');

/**
 * The invalidation broadcast must go out only AFTER Redis is authoritative.
 *
 * Publishing first tells every peer to drop its local copy while the value is
 * still readable from Redis, so ordinary traffic on those peers re-reads and
 * re-caches the very value being invalidated. For a single `del` that window is
 * one round trip; for `delByPattern` it is the whole SCAN+DEL sweep — measured
 * at 412 of 5,000 memberships still being served after a tenant-wide
 * revocation had completed. The call site is the super-admin tenant
 * soft-delete, whose entire purpose is revoking access immediately.
 *
 * Asserted as an ORDER OF OPERATIONS rather than by racing two caches: the race
 * is real but its window is timing-dependent, whereas the ordering invariant is
 * exact and is what actually has to hold.
 */
function recordingRedis(scanPages: string[][] = [[]]) {
  const calls: string[] = [];
  let page = 0;
  const client = {
    async get() { calls.push('get'); return null; },
    async set() { calls.push('set'); return 'OK'; },
    async del(...keys: string[]) { calls.push(`del(${keys.length})`); return keys.length; },
    async scan(_cursor: string) {
      const keys = scanPages[page] ?? [];
      page++;
      const next = page >= scanPages.length ? '0' : String(page);
      calls.push('scan');
      return [next, keys];
    },
    async publish() { calls.push('publish'); return 1; },
  };
  return { client, calls };
}

const localConfig = { enabled: true, ttlMs: 5_000, maxEntries: 100, channel: 'ch' };

describe('invalidation broadcast ordering', () => {
  it('publishes AFTER the Redis delete, not before', async () => {
    const { client, calls } = recordingRedis();
    const cache = new RedisCache();
    cache.init(client as never, localConfig);

    await cache.del('cache:membership:u1:t1');

    expect(calls).toEqual(['del(1)', 'publish']);
    expect(calls.indexOf('publish')).toBeGreaterThan(calls.indexOf('del(1)'));
  });

  it('publishes only once the whole SCAN+DEL sweep has finished', async () => {
    // Three scan pages: a broadcast sent before the sweep would leave the keys
    // on pages 2 and 3 live in Redis and re-cacheable by peers that already
    // dropped them.
    const { client, calls } = recordingRedis([['k1', 'k2'], ['k3'], ['k4']]);
    const cache = new RedisCache();
    cache.init(client as never, localConfig);

    await cache.delByPattern('cache:membership:*:t1');

    expect(calls[calls.length - 1]).toBe('publish');
    expect(calls.filter((c) => c === 'publish')).toHaveLength(1);
    // Every deletion happened before the broadcast went out.
    const publishAt = calls.indexOf('publish');
    expect(calls.slice(0, publishAt).filter((c) => c.startsWith('del'))).toHaveLength(3);
  });

  it('still publishes when this instance has the local layer disabled', async () => {
    // The incident lever is rolled out instance by instance; a disabled
    // instance that went quiet would strand its still-enabled peers on a stale
    // role for a full TTL.
    const { client, calls } = recordingRedis();
    const cache = new RedisCache();
    cache.init(client as never, { ...localConfig, enabled: false });

    await cache.del('cache:membership:u1:t1');

    expect(calls).toContain('publish');
  });

  it('does not publish when no local-cache config was supplied at all', async () => {
    // e.g. the test harnesses that call init(redis) with one argument.
    const { client, calls } = recordingRedis();
    const cache = new RedisCache();
    cache.init(client as never);

    await cache.del('cache:membership:u1:t1');

    expect(calls).toEqual(['del(1)']);
  });
});
