// PORT NOTE (magick-agency): ported from master test/unit/cache/redis-cache.test.ts@a1f0756a — verbatim, import specifiers remapped only.
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@magick-agency/observability', () => ({
  createChildLogger: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
}));

import { redisCache } from '../../../src/cache/redis-cache.js';
import type { Redis } from 'ioredis';

function makeRedis(): Redis {
  return {
    get: vi.fn(),
    set: vi.fn(),
    del: vi.fn(),
    scan: vi.fn(),
  } as unknown as Redis;
}

describe('RedisCache', () => {
  let redis: Redis;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('before init (no Redis)', () => {
    // redisCache starts without a Redis instance — all operations should be no-ops

    it('get should return null', async () => {
      // Use a fresh import via the module — redisCache singleton starts uninitialised
      // We test this by not calling init. Since redisCache is a singleton, we need a
      // separate module-level instance. Instead, we verify the available flag.
      expect(redisCache.available).toBe(false);
      const result = await redisCache.get('any-key');
      expect(result).toBeNull();
    });

    it('set should not throw', async () => {
      await expect(redisCache.set('k', 'v', 60)).resolves.not.toThrow();
    });

    it('del should not throw', async () => {
      await expect(redisCache.del('k')).resolves.not.toThrow();
    });

    it('delByPattern should be a no-op that never throws', async () => {
      await expect(redisCache.delByPattern('cache:phone:t1:*')).resolves.not.toThrow();
    });
  });

  describe('after init', () => {
    beforeEach(() => {
      redis = makeRedis();
      redisCache.init(redis);
    });

    it('available should be true', () => {
      expect(redisCache.available).toBe(true);
    });

    // ─── get ───────────────────────────────────────────────
    describe('get', () => {
      it('should return parsed JSON on cache hit', async () => {
        (redis.get as ReturnType<typeof vi.fn>).mockResolvedValue('{"name":"Alice","age":30}');
        const result = await redisCache.get<{ name: string; age: number }>('cache:user:1');
        expect(result).toEqual({ name: 'Alice', age: 30 });
      });

      it('should return null on cache miss', async () => {
        (redis.get as ReturnType<typeof vi.fn>).mockResolvedValue(null);
        const result = await redisCache.get('cache:user:1');
        expect(result).toBeNull();
      });

      it('should return null and not throw on Redis error', async () => {
        (redis.get as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Connection refused'));
        const result = await redisCache.get('cache:user:1');
        expect(result).toBeNull();
      });

      it('should return null on invalid JSON', async () => {
        (redis.get as ReturnType<typeof vi.fn>).mockResolvedValue('not-json{{{');
        const result = await redisCache.get('cache:user:1');
        expect(result).toBeNull();
      });

      it('should handle string values', async () => {
        (redis.get as ReturnType<typeof vi.fn>).mockResolvedValue('"hello"');
        const result = await redisCache.get<string>('cache:str');
        expect(result).toBe('hello');
      });

      it('should handle array values', async () => {
        (redis.get as ReturnType<typeof vi.fn>).mockResolvedValue('[1,2,3]');
        const result = await redisCache.get<number[]>('cache:arr');
        expect(result).toEqual([1, 2, 3]);
      });
    });

    // ─── set ───────────────────────────────────────────────
    describe('set', () => {
      it('should call redis SET with JSON and EX', async () => {
        (redis.set as ReturnType<typeof vi.fn>).mockResolvedValue('OK');
        await redisCache.set('cache:user:1', { name: 'Bob' }, 300);
        expect(redis.set).toHaveBeenCalledWith('cache:user:1', '{"name":"Bob"}', 'EX', 300);
      });

      it('should handle string values', async () => {
        (redis.set as ReturnType<typeof vi.fn>).mockResolvedValue('OK');
        await redisCache.set('cache:rate:voice_call', '500', 14400);
        expect(redis.set).toHaveBeenCalledWith('cache:rate:voice_call', '"500"', 'EX', 14400);
      });

      it('should not throw on Redis error', async () => {
        (redis.set as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Connection refused'));
        await expect(redisCache.set('k', 'v', 60)).resolves.not.toThrow();
      });
    });

    // ─── del ───────────────────────────────────────────────
    describe('del', () => {
      it('should call redis DEL with the given key', async () => {
        (redis.del as ReturnType<typeof vi.fn>).mockResolvedValue(1);
        await redisCache.del('cache:user:1');
        expect(redis.del).toHaveBeenCalledWith('cache:user:1');
      });

      it('should accept multiple keys', async () => {
        (redis.del as ReturnType<typeof vi.fn>).mockResolvedValue(2);
        await redisCache.del('cache:a', 'cache:b');
        expect(redis.del).toHaveBeenCalledWith('cache:a', 'cache:b');
      });

      it('should no-op when called with zero keys', async () => {
        await redisCache.del();
        expect(redis.del).not.toHaveBeenCalled();
      });

      it('should not throw on Redis error', async () => {
        (redis.del as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Connection refused'));
        await expect(redisCache.del('k')).resolves.not.toThrow();
      });
    });

    // ─── delByPattern ──────────────────────────────────────
    describe('delByPattern', () => {
      const asMock = (fn: unknown) => fn as ReturnType<typeof vi.fn>;

      it('should SCAN and delete matched keys in a single pass', async () => {
        asMock(redis.scan).mockResolvedValue(['0', ['cache:phone:t1:a', 'cache:phone:t1:b']]);
        (redis.del as ReturnType<typeof vi.fn>).mockResolvedValue(2);

        await redisCache.delByPattern('cache:phone:t1:*');

        expect(redis.scan).toHaveBeenCalledWith('0', 'MATCH', 'cache:phone:t1:*', 'COUNT', 100);
        expect(redis.del).toHaveBeenCalledWith('cache:phone:t1:a', 'cache:phone:t1:b');
        expect(redis.scan).toHaveBeenCalledTimes(1);
      });

      it('should follow the cursor across multiple iterations until it returns to 0', async () => {
        asMock(redis.scan)
          .mockResolvedValueOnce(['17', ['cache:phone:t1:a']])
          .mockResolvedValueOnce(['0', ['cache:phone:t1:b']]);
        (redis.del as ReturnType<typeof vi.fn>).mockResolvedValue(1);

        await redisCache.delByPattern('cache:phone:t1:*');

        expect(redis.scan).toHaveBeenCalledTimes(2);
        expect(redis.scan).toHaveBeenNthCalledWith(2, '17', 'MATCH', 'cache:phone:t1:*', 'COUNT', 100);
        expect(redis.del).toHaveBeenCalledWith('cache:phone:t1:a');
        expect(redis.del).toHaveBeenCalledWith('cache:phone:t1:b');
      });

      it('should not call DEL when a scan batch is empty', async () => {
        asMock(redis.scan).mockResolvedValue(['0', []]);

        await redisCache.delByPattern('cache:phone:t1:*');

        expect(redis.del).not.toHaveBeenCalled();
      });

      it('should never fall back to KEYS', async () => {
        asMock(redis.scan).mockResolvedValue(['0', []]);
        await redisCache.delByPattern('cache:phone:t1:*');
        expect((redis as unknown as { keys?: unknown }).keys).toBeUndefined();
      });

      it('should not throw when SCAN errors', async () => {
        asMock(redis.scan).mockRejectedValue(new Error('Connection refused'));
        await expect(redisCache.delByPattern('cache:phone:t1:*')).resolves.not.toThrow();
      });
    });
  });
});
