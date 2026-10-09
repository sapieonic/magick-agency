import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import Redis from 'ioredis';
import { TEST_REDIS_URL, assertSafeTestRedisUrl } from '../../helpers/test-redis.js';

// ── Mocks ───────────────────────────────────────────────────────────────────
// The middleware module transitively imports the membership repo (connection.js)
// and the tenant-name-resolver (analytics). We never exercise those paths here —
// only invalidateTenantMembershipCache — but stub them so the import is inert.

// The repositories import the package pool lazily (no connection is opened on import)
// and there is no analytics module, so nothing needs stubbing.

// The guarded test Redis (6383, the worktree's non-zero db) is used, and every FLUSHDB goes
// through `assertSafeTestRedisUrl()` first.
assertSafeTestRedisUrl();
const RAW_REDIS_URL = TEST_REDIS_URL;

// ── Dynamic imports after mocks ─────────────────────────────────────────────

const { redisCache } = await import('../../../src/cache/redis-cache.js');
const { invalidateTenantMembershipCache } = await import(
  '../../../src/api/middleware/tenant-context.middleware.js'
);

const membershipKey = (userId: string, tenantId: string) => `cache:membership:${userId}:${tenantId}`;

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

describe('invalidateTenantMembershipCache (real Redis)', () => {
  it('removes membership keys for ALL users of the target tenant, leaving other tenants intact', async () => {
    const t1 = 'tenant-1111';
    const t2 = 'tenant-2222';

    // Several users cached for t1, several for t2 (some users belong to both).
    await rawRedis.set(membershipKey('userA', t1), JSON.stringify([{ role: 'viewer' }]));
    await rawRedis.set(membershipKey('userB', t1), JSON.stringify([{ role: 'operator' }]));
    await rawRedis.set(membershipKey('userC', t1), JSON.stringify([{ role: 'tenant_admin' }]));
    await rawRedis.set(membershipKey('userA', t2), JSON.stringify([{ role: 'viewer' }]));
    await rawRedis.set(membershipKey('userD', t2), JSON.stringify([{ role: 'operator' }]));

    await invalidateTenantMembershipCache(t1);

    // Every t1 membership key is gone (across all users).
    expect(await rawRedis.get(membershipKey('userA', t1))).toBeNull();
    expect(await rawRedis.get(membershipKey('userB', t1))).toBeNull();
    expect(await rawRedis.get(membershipKey('userC', t1))).toBeNull();

    // t2 is completely untouched — including userA, who also has a t1 entry.
    expect(await rawRedis.get(membershipKey('userA', t2))).not.toBeNull();
    expect(await rawRedis.get(membershipKey('userD', t2))).not.toBeNull();
  });

  it('only matches the tenant as the key SUFFIX (no accidental prefix collisions)', async () => {
    // Keys whose tenant id is a *prefix substring* of the target must survive.
    await rawRedis.set(membershipKey('userA', 'tenant-99'), '1'); // target
    await rawRedis.set(membershipKey('userB', 'tenant-990'), '2'); // longer, different tenant

    await invalidateTenantMembershipCache('tenant-99');

    expect(await rawRedis.get(membershipKey('userA', 'tenant-99'))).toBeNull();
    // 'tenant-990' must NOT be swept by the 'tenant-99' pattern.
    expect(await rawRedis.get(membershipKey('userB', 'tenant-990'))).toBe('2');
  });

  it('is a no-op when the tenant has no cached memberships', async () => {
    await rawRedis.set(membershipKey('userA', 'other'), '1');
    await invalidateTenantMembershipCache('tenant-empty');
    expect(await rawRedis.get(membershipKey('userA', 'other'))).toBe('1');
  });
});
