// PORT NOTE (magick-agency): ported from master test/integration/cache/redis-cache.delbypattern.test.ts@a1f0756a (4 → 4); only the Redis target changed.
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import Redis from 'ioredis';
import { redisCache } from '../../../src/cache/redis-cache.js';
import { TEST_REDIS_URL, assertSafeTestRedisUrl } from '../../helpers/test-redis.js';

// ── Raw, UN-prefixed Redis client ───────────────────────────────────────────
// The shared getTestRedis() helper uses keyPrefix:'test:', but ioredis does NOT
// apply keyPrefix to SCAN's MATCH argument — so delByPattern (which SCANs) would
// never match keys written through a prefixed client. We therefore drive the
// REAL redisCache singleton against a raw, un-prefixed client and assert against
// that same client so SCAN MATCH and GET/KEYS all agree on the key namespace.
// PORT NOTE (magick-agency): master pointed this at its own test Redis
// (`redis://localhost:6381`, a port agency must never touch). Agency's guarded
// test Redis (6383, the worktree's non-zero db) is used, and every FLUSHDB goes
// through `assertSafeTestRedisUrl()` first.
assertSafeTestRedisUrl();
const RAW_REDIS_URL = TEST_REDIS_URL;

let rawRedis: Redis;

beforeAll(() => {
  rawRedis = new Redis(RAW_REDIS_URL, { maxRetriesPerRequest: 3 });
  redisCache.init(rawRedis);
});

beforeEach(async () => {
  assertSafeTestRedisUrl();
    await rawRedis.flushdb();
});

afterAll(async () => {
  await rawRedis.quit();
});

describe('redisCache.delByPattern (real Redis)', () => {
  it('deletes only keys matching the glob, leaving non-matching keys intact', async () => {
    // Matching set
    await rawRedis.set('cache:phone:t1:a:none', '1');
    await rawRedis.set('cache:phone:t1:b:acc', '2');
    await rawRedis.set('cache:phone:t1:default:none', '3');
    // Non-matching: different tenant, and an unrelated namespace
    await rawRedis.set('cache:phone:t2:a:none', '4');
    await rawRedis.set('cache:tenant:full:t1', '5');
    await rawRedis.set('unrelated:key', '6');

    await redisCache.delByPattern('cache:phone:t1:*');

    // All t1 phone keys gone
    expect(await rawRedis.get('cache:phone:t1:a:none')).toBeNull();
    expect(await rawRedis.get('cache:phone:t1:b:acc')).toBeNull();
    expect(await rawRedis.get('cache:phone:t1:default:none')).toBeNull();
    // Everything else survives
    expect(await rawRedis.get('cache:phone:t2:a:none')).toBe('4');
    expect(await rawRedis.get('cache:tenant:full:t1')).toBe('5');
    expect(await rawRedis.get('unrelated:key')).toBe('6');
  });

  it('removes ALL matching keys across multiple SCAN iterations (multi-hundred keys)', async () => {
    const MATCH = 750;
    const NOISE = 250;

    const pipe = rawRedis.pipeline();
    for (let i = 0; i < MATCH; i++) pipe.set(`cache:membership:user${i}:tenantX`, String(i));
    for (let i = 0; i < NOISE; i++) pipe.set(`cache:membership:user${i}:tenantY`, String(i));
    await pipe.exec();

    // Sanity: everything is present before the delete.
    expect((await rawRedis.keys('cache:membership:*:tenantX')).length).toBe(MATCH);

    await redisCache.delByPattern('cache:membership:*:tenantX');

    // COUNT 100 forces many SCAN round-trips; every matching key must be gone.
    expect(await rawRedis.keys('cache:membership:*:tenantX')).toEqual([]);
    // The non-matching tenant is fully intact.
    expect((await rawRedis.keys('cache:membership:*:tenantY')).length).toBe(NOISE);
  });

  it('is a no-op when nothing matches the pattern', async () => {
    await rawRedis.set('cache:phone:keep:1', 'a');
    await rawRedis.set('cache:phone:keep:2', 'b');

    await redisCache.delByPattern('cache:phone:absent:*');

    expect(await rawRedis.get('cache:phone:keep:1')).toBe('a');
    expect(await rawRedis.get('cache:phone:keep:2')).toBe('b');
    expect((await rawRedis.dbsize())).toBe(2);
  });

  it('is a no-op against an empty database', async () => {
    await redisCache.delByPattern('cache:anything:*');
    expect(await rawRedis.dbsize()).toBe(0);
  });
});
