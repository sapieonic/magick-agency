import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import Redis from 'ioredis';
import { TEST_REDIS_URL, assertSafeTestRedisUrl } from '../../helpers/test-redis.js';

/**
 * The in-process cache layer is only safe because invalidation is broadcast to
 * every instance. This file exercises that across TWO independently
 * initialised caches over one real Redis — a singleton cannot demonstrate it.
 *
 * The scenario that matters is not staleness in the abstract. `PUT
 * /users/:id/role` and the membership-delete route both `redisCache.del` the
 * membership key precisely so a permission change takes effect at once. Instance
 * A serving that request must not leave instance B handing out the old role.
 */

vi.mock('../../../src/config/index.js', () => ({
  config: { governance: { enabled: true } },
}));

const { RedisCache } = await import('../../../src/cache/redis-cache.js');

// The guarded test Redis (6383, the worktree's non-zero db) is used, and every FLUSHDB goes
// through `assertSafeTestRedisUrl()` first.
assertSafeTestRedisUrl();
const REDIS_URL = TEST_REDIS_URL;
const CHANNEL = 'test:cache:invalidate';

const localConfig = { enabled: true, ttlMs: 30_000, maxEntries: 100, channel: CHANNEL };

/**
 * Wait until `subscriber` has received, and its listeners applied, every invalidation
 * `publisher` sent before this call. Not a fixed sleep: a busy CI runner (four integration
 * workers on one Redis) once took longer than the 60 ms this file used to wait, and four
 * cases failed together. A barrier invalidation of a fresh key goes out on the publisher's
 * own connection, after the ones under test (ioredis sends one connection's commands in
 * order, and `publishInvalidation` does not await its PUBLISH, so only the same connection
 * keeps the order); Redis delivers to one subscriber connection in publish order, and each
 * cache registered its listener before this one, so once the barrier arrives every earlier
 * message has been applied. A negative assertion after it means the message never came.
 */
async function delivered(publisher: InstanceType<typeof RedisCache>, subscriber: Redis): Promise<void> {
  const barrier = `cache:membership:barrier-${randomUUID()}:t0`;
  const arrived = new Promise<void>((resolve) => {
    const onMessage = (_channel: string, raw: string) => {
      if (!raw.includes(barrier)) return;
      subscriber.off('message', onMessage);
      resolve();
    };
    subscriber.on('message', onMessage);
  });
  await publisher.del(barrier);
  await arrived;
}

describe('local cache cross-instance invalidation (integration)', () => {
  let redisA: Redis;
  let redisB: Redis;
  let subA: Redis;
  let subB: Redis;
  let cacheA: InstanceType<typeof RedisCache>;
  let cacheB: InstanceType<typeof RedisCache>;

  beforeAll(async () => {
    redisA = new Redis(REDIS_URL);
    redisB = new Redis(REDIS_URL);
    subA = new Redis(REDIS_URL);
    subB = new Redis(REDIS_URL);

    cacheA = new RedisCache();
    cacheB = new RedisCache();
    cacheA.init(redisA, localConfig);
    cacheB.init(redisB, localConfig);
    await cacheA.attachInvalidationSubscriber(subA);
    await cacheB.attachInvalidationSubscriber(subB);
  });

  beforeEach(async () => {
    assertSafeTestRedisUrl();
    await redisA.flushdb();
    cacheA.clearLocal();
    cacheB.clearLocal();
  });

  afterAll(async () => {
    for (const c of [subA, subB, redisA, redisB]) c.disconnect();
  });

  it('serves a repeat read from memory without touching Redis', async () => {
    await cacheA.set('cache:membership:u1:t1', [{ role: 'viewer' }], 300);
    // Delete straight out of Redis, behind the cache's back: a subsequent hit
    // can then only have come from the local layer.
    await redisA.del('cache:membership:u1:t1');

    expect(await cacheA.get('cache:membership:u1:t1')).toEqual([{ role: 'viewer' }]);
  });

  it('drops the other instance’s copy when a role changes (del broadcast)', async () => {
    await cacheA.set('cache:membership:u1:t1', [{ role: 'tenant_admin' }], 300);
    // B reads it once, so B now holds its own local copy.
    expect(await cacheB.get('cache:membership:u1:t1')).toEqual([{ role: 'tenant_admin' }]);

    // The revocation lands on A only.
    await cacheA.del('cache:membership:u1:t1');
    await delivered(cacheA, subB);

    // B must NOT still be handing out the old role.
    expect(await cacheB.get('cache:membership:u1:t1')).toBeNull();
  });

  it('propagates a pattern invalidation to the other instance', async () => {
    await cacheA.set('cache:membership:u1:t1', ['a'], 300);
    await cacheA.set('cache:membership:u2:t1', ['b'], 300);
    await cacheA.set('cache:membership:u1:t2', ['keep'], 300);
    for (const k of ['cache:membership:u1:t1', 'cache:membership:u2:t1', 'cache:membership:u1:t2']) {
      await cacheB.get(k);
    }

    // Tenant-wide invalidation, as a tenant suspend issues.
    await cacheA.delByPattern('cache:membership:*:t1');
    await delivered(cacheA, subB);

    expect(await cacheB.get('cache:membership:u1:t1')).toBeNull();
    expect(await cacheB.get('cache:membership:u2:t1')).toBeNull();
    // A different tenant is untouched — and still served locally.
    expect(await cacheB.get('cache:membership:u1:t2')).toEqual(['keep']);
  });

  it('does not cache families outside the allow-list', async () => {
    // Generation-fenced keys must keep going to Redis every time.
    await cacheA.set('cache:bulk-status-summary:t1:a1:ivr_call:abc', { queued: 1 }, 300);
    await redisA.del('cache:bulk-status-summary:t1:a1:ivr_call:abc');

    expect(await cacheA.get('cache:bulk-status-summary:t1:a1:ivr_call:abc')).toBeNull();
  });

  it('does not cache an excluded family on the READ path either', async () => {
    // The test above only proves the WRITE path filters: it stores through
    // `set`, which drops the key, so the read never had anything to populate
    // from. The realistic shape is another instance filling Redis and this one
    // reading it — that is the path that must also refuse to cache, or a
    // generation-fenced value gets pinned in memory outside its fence.
    const key = 'cache:bulk-status-summary:t1:a1:ivr_call:read';
    await redisA.set(key, JSON.stringify({ gen: 1 }), 'EX', 300);

    expect(await cacheB.get(key)).toEqual({ gen: 1 });

    await redisA.del(key);
    expect(await cacheB.get(key)).toBeNull();
  });

  it('does not resurrect a key deleted while a read was in flight', async () => {
    // A read issued BEFORE a revocation must not write its now-stale value into
    // memory AFTER it. Without the epoch guard the revoked role is served from
    // process memory for a full TTL — on the very instance that revoked it.
    const key = 'cache:membership:u1:tRACE';
    await redisA.set(key, JSON.stringify([{ role: 'tenant_admin' }]), 'EX', 300);

    const inFlight = cacheA.get(key);   // local miss → Redis GET in flight
    await cacheA.del(key);              // revocation lands mid-read
    await inFlight;

    expect(await cacheA.get(key)).toBeNull();
  });

  it('publishes an invalidation even when this instance has the layer disabled', async () => {
    // The documented incident lever (LOCAL_CACHE_ENABLED=false) is rolled out
    // instance by instance. A disabled instance that stopped broadcasting would
    // leave its still-enabled peers serving the old role — the lever would be
    // least safe exactly when reached for.
    const off = new RedisCache();
    const offRedis = new Redis(REDIS_URL);
    try {
      off.init(offRedis, { ...localConfig, enabled: false });

      await cacheB.set('cache:membership:u9:t9', [{ role: 'tenant_admin' }], 300);
      expect(await cacheB.get('cache:membership:u9:t9')).toEqual([{ role: 'tenant_admin' }]);

      await off.del('cache:membership:u9:t9');
      await delivered(off, subB);

      expect(await cacheB.get('cache:membership:u9:t9')).toBeNull();
    } finally {
      offRedis.disconnect();
    }
  });

  it('populates the local copy from a Redis READ, not only from its own write', async () => {
    // The common shape is one instance filling Redis and every instance reading
    // it; caching only our own writes would leave the layer nearly always cold.
    await cacheA.set('cache:tenant:t9', { name: 'Acme' }, 300);
    expect(await cacheB.get('cache:tenant:t9')).toEqual({ name: 'Acme' });

    await redisA.del('cache:tenant:t9');
    expect(await cacheB.get('cache:tenant:t9')).toEqual({ name: 'Acme' });
  });

  /**
   * Redis pub/sub is server-wide: a channel is not scoped by the db a client `SELECT`ed. Two
   * deployments on one Redis told apart only by db number (dev on 0 and the suites on 1–15,
   * or each worktree's integration run on its own db) configured the SAME channel and
   * dropped each other's local copies; this file flaked whenever another worktree ran it at
   * the same time. `RedisCache.init` now scopes the channel to the client's db
   * (`invalidationChannelFor`). Mutation-checked: returning the configured channel unscoped
   * reds this case.
   */
  it('never hears, or is heard by, a deployment on another Redis db with the same channel', async () => {
    const ownDb = Number(new URL(REDIS_URL).pathname.slice(1));
    // Another non-zero db (never 0, dev's), different from this worker's: possibly another
    // worker's or worktree's, so only a publish and a DEL of a key nobody else uses touch it.
    const otherDb = (ownDb % 15) + 1;
    expect(otherDb).not.toBe(ownDb);
    const otherUrl = new URL(REDIS_URL);
    otherUrl.pathname = `/${otherDb}`;
    const otherRedis = new Redis(otherUrl.toString());
    const otherSub = new Redis(otherUrl.toString());
    const other = new RedisCache();
    try {
      other.init(otherRedis, localConfig);
      await other.attachInvalidationSubscriber(otherSub);
      const key = `cache:membership:${randomUUID()}:t1`;
      const heardByOther: string[] = [];
      // Only messages about this case's key: another worktree on that db may run this file too.
      otherSub.on('message', (_channel: string, raw: string) => { if (raw.includes(key)) heardByOther.push(raw); });

      // B holds a local copy; Redis no longer does, so a later hit can only be local.
      await cacheA.set(key, [{ role: 'tenant_admin' }], 300);
      expect(await cacheB.get(key)).toEqual([{ role: 'tenant_admin' }]);
      await redisA.del(key);

      // The other deployment revokes a key of the same name: not ours to drop. The barrier
      // goes out on the other deployment's connection, so it follows that revocation; it is
      // heard on the other channel, and B's own channel is flushed with a barrier of ours.
      await other.del(key);
      await delivered(other, otherSub);
      await delivered(cacheA, subB);
      expect(await cacheB.get(key), 'another db\'s invalidation dropped this db\'s copy').toEqual([{ role: 'tenant_admin' }]);
      // Its own broadcast did go out (the listener works)...
      expect(heardByOther).toHaveLength(1);

      // ...and ours never reaches it.
      await cacheA.del(key);
      await delivered(cacheA, subB);
      await delivered(other, otherSub);
      expect(heardByOther).toHaveLength(1);
      expect(await cacheB.get(key)).toBeNull();
    } finally {
      otherSub.disconnect();
      otherRedis.disconnect();
    }
  });

  it('keeps a cached null distinguishable from a miss', async () => {
    await cacheA.set('cache:account:none', null, 300);
    await redisA.del('cache:account:none');

    // Served from memory as a genuine null, not re-fetched.
    expect(await cacheA.get('cache:account:none')).toBeNull();
  });
});
