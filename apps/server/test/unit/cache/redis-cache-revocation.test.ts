import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Decision Q5: `RedisCache.delForRevocation` — the delete a
 * revocation (membership removal, role change) uses. `del` logs and swallows a Redis failure;
 * this retries a bounded number of times, logs at ERROR with the keys if it still fails, and
 * reports the outcome so the route can 503 (when its retry is idempotent). The local copy is
 * dropped and peers are notified either way. Mutation-checked: making it return `true` after
 * a failed loop reds case 2; dropping the retry loop reds case 1.
 */
const log = vi.hoisted(() => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }));
vi.mock('@magick-agency/observability', () => ({ createChildLogger: () => log }));
vi.mock('@magick-agency/observability/metrics/platform', () => ({
  localCacheOperationsTotal: { inc: vi.fn() },
  localCacheInvalidationsTotal: { inc: vi.fn() },
}));

import type { Redis } from 'ioredis';
import { RedisCache, REVOCATION_DEL_ATTEMPTS } from '../../../src/cache/redis-cache.js';

const KEY = 'cache:membership:u1:t1';

function makeRedis(del: ReturnType<typeof vi.fn>): Redis {
  return { get: vi.fn().mockResolvedValue(null), set: vi.fn(), del, publish: vi.fn().mockResolvedValue(1) } as unknown as Redis;
}

describe('RedisCache.delForRevocation (Q5)', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('retries a failing DEL and reports success once it lands', async () => {
    const del = vi.fn()
      .mockRejectedValueOnce(new Error('blip'))
      .mockRejectedValueOnce(new Error('blip'))
      .mockResolvedValue(1);
    const cache = new RedisCache();
    cache.init(makeRedis(del), { enabled: false, ttlMs: 5000, maxEntries: 10, channel: 'inv' });
    expect(await cache.delForRevocation(KEY)).toBe(true);
    expect(del).toHaveBeenCalledTimes(3);
    expect(log.error).not.toHaveBeenCalled();
  });

  it('after the bounded attempts it reports failure and logs at ERROR with the keys; peers are still told', async () => {
    const del = vi.fn().mockRejectedValue(new Error('redis down'));
    const redis = makeRedis(del);
    const cache = new RedisCache();
    cache.init(redis, { enabled: true, ttlMs: 5000, maxEntries: 10, channel: 'inv' });
    await cache.set(KEY, { role: 'tenant_admin' }, 60);

    expect(await cache.delForRevocation(KEY)).toBe(false);
    expect(del).toHaveBeenCalledTimes(REVOCATION_DEL_ATTEMPTS);
    expect(log.error).toHaveBeenCalledWith(expect.objectContaining({ keys: [KEY], attempts: REVOCATION_DEL_ATTEMPTS }), expect.any(String));
    expect(redis.publish).toHaveBeenCalledWith('inv', JSON.stringify({ op: 'del', keys: [KEY] }));
    // The local copy is gone even though Redis kept its own.
    (redis.get as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    expect(await cache.get(KEY)).toBeNull();
  });

  it('with no Redis there is nothing to leave behind: true', async () => {
    expect(await new RedisCache().delForRevocation(KEY)).toBe(true);
  });
});
