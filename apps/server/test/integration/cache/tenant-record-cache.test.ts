// PORT NOTE (magick-agency): ported from master test/integration/cache/tenant-record-cache.test.ts@a1f0756a (10 → 10).
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import Redis from 'ioredis';
import { closePool, initDbPool } from '@magick-agency/db';
import { TEST_DB_URL } from '../../../../../packages/db/test/helpers/test-db.js';
import { getTestPool, closeTestPool, truncateAll } from '../../../../../packages/db/test/integration/setup/test-utils.js';
import { insertTenant, insertAccount } from '../../../../../packages/db/test/integration/setup/platform-factories.js';
import { TEST_REDIS_URL, assertSafeTestRedisUrl } from '../../helpers/test-redis.js';

// ── Mocks (must precede the dynamic import of the module under test) ─────────

// PORT NOTE (magick-agency): master redirected `src/db/connection.js` to the
// test pool and stubbed `analytics/posthog.js`. Agency's repositories use the
// package pool, initialised on the test database in `beforeAll`; there is no
// analytics module (the resolver's `identifyGroups` call is removed).

// The real redisCache singleton is used (NOT mocked) — inited against raw Redis
// in beforeAll below.

// PORT NOTE (magick-agency): master pointed this at its own test Redis
// (`redis://localhost:6381`, a port agency must never touch). Agency's guarded
// test Redis (6383, the worktree's non-zero db) is used, and every FLUSHDB goes
// through `assertSafeTestRedisUrl()` first.
assertSafeTestRedisUrl();
const RAW_REDIS_URL = TEST_REDIS_URL;

// ── Dynamic imports after mocks ─────────────────────────────────────────────

const { redisCache } = await import('../../../src/cache/redis-cache.js');
const {
  getCachedTenantRecord,
  getCachedAccountRecord,
  invalidateTenantRecordCache,
  invalidateAccountRecordCache,
  resolveTenantAccountNames,
} = await import('../../../src/services/tenant-name-resolver.js');

const tenantKey = (id: string) => `cache:tenant:full:${id}`;
const accountKey = (id: string) => `cache:account:full:${id}`;

let rawRedis: Redis;

beforeAll(() => {
  initDbPool({ url: TEST_DB_URL, poolMin: 0, poolMax: 4 });
  rawRedis = new Redis(RAW_REDIS_URL, { maxRetriesPerRequest: 3 });
  redisCache.init(rawRedis);
});

beforeEach(async () => {
  await truncateAll();
  assertSafeTestRedisUrl();
    await rawRedis.flushdb();
});

afterAll(async () => {
  await rawRedis.quit();
  await closePool();
  await closeTestPool();
});

describe('getCachedTenantRecord (real DB + Redis)', () => {
  it('miss populates cache:tenant:full:{id} and returns the row', async () => {
    const tenant = await insertTenant({ name: 'Acme Corp' });

    // Cache is empty before the first call.
    expect(await rawRedis.get(tenantKey(tenant.id))).toBeNull();

    const record = await getCachedTenantRecord(tenant.id);
    expect(record).not.toBeNull();
    expect(record!.id).toBe(tenant.id);
    expect(record!.name).toBe('Acme Corp');

    // The key is now populated with the JSON-serialized record.
    const cached = await rawRedis.get(tenantKey(tenant.id));
    expect(cached).not.toBeNull();
    expect(JSON.parse(cached!).name).toBe('Acme Corp');

    // TTL is set (5 minutes = 300s); allow slack for command latency.
    const ttl = await rawRedis.ttl(tenantKey(tenant.id));
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(300);
  });

  it('serves the second call from Redis — a direct DB mutation without invalidation returns the STALE value', async () => {
    const tenant = await insertTenant({ name: 'Original Name' });

    const first = await getCachedTenantRecord(tenant.id);
    expect(first!.name).toBe('Original Name');

    // Mutate the DB row directly, bypassing every invalidation path.
    await getTestPool().query('UPDATE tenants SET name = $1 WHERE id = $2', ['Renamed In DB', tenant.id]);

    // Still served from Redis → stale name, proving the read hit the cache.
    const second = await getCachedTenantRecord(tenant.id);
    expect(second!.name).toBe('Original Name');
  });

  it('invalidateTenantRecordCache removes the full-record key AND the legacy name key, forcing a fresh reload', async () => {
    const tenant = await insertTenant({ name: 'Before' });

    await getCachedTenantRecord(tenant.id); // populate full-record key
    // Simulate a lingering legacy name-only cache entry.
    await rawRedis.set(`cache:tenant-name:${tenant.id}`, JSON.stringify('Before'));

    await getTestPool().query('UPDATE tenants SET name = $1 WHERE id = $2', ['After', tenant.id]);

    await invalidateTenantRecordCache(tenant.id);

    // Both keys are cleared.
    expect(await rawRedis.get(tenantKey(tenant.id))).toBeNull();
    expect(await rawRedis.get(`cache:tenant-name:${tenant.id}`)).toBeNull();

    // Next call reloads fresh from the DB and re-populates the cache.
    const reloaded = await getCachedTenantRecord(tenant.id);
    expect(reloaded!.name).toBe('After');
    expect(JSON.parse((await rawRedis.get(tenantKey(tenant.id)))!).name).toBe('After');
  });

  it('round-trips the .settings JSON intact through the cache', async () => {
    const settings = {
      default_pipeline: 'pipeline-xyz',
      max_concurrent_calls: 7,
      nested: { flags: ['a', 'b'], on: true },
    };
    const tenant = await insertTenant({ name: 'Settings Co', settings: JSON.stringify(settings) });

    const fromDb = await getCachedTenantRecord(tenant.id);
    expect(fromDb!.settings).toEqual(settings);

    // Read straight out of Redis and confirm settings survived serialization.
    const cached = JSON.parse((await rawRedis.get(tenantKey(tenant.id)))!);
    expect(cached.settings).toEqual(settings);

    // And a second (cache-served) call returns the same object shape.
    const fromCache = await getCachedTenantRecord(tenant.id);
    expect(fromCache!.settings).toEqual(settings);
  });

  it('returns null for an unknown tenant and never caches the miss', async () => {
    const missing = '00000000-0000-0000-0000-000000000000';
    const record = await getCachedTenantRecord(missing);
    expect(record).toBeNull();
    expect(await rawRedis.get(tenantKey(missing))).toBeNull();
  });
});

describe('getCachedAccountRecord (real DB + Redis)', () => {
  it('miss populates cache:account:full:{id}, serves stale on second call, and invalidation reloads', async () => {
    const tenant = await insertTenant();
    const account = await insertAccount({ tenant_id: tenant.id, name: 'Acct One' });

    const first = await getCachedAccountRecord(account.id);
    expect(first!.name).toBe('Acct One');
    expect(JSON.parse((await rawRedis.get(accountKey(account.id)))!).name).toBe('Acct One');

    // Direct DB mutation without invalidation → stale read.
    await getTestPool().query('UPDATE accounts SET name = $1 WHERE id = $2', ['Acct Renamed', account.id]);
    const second = await getCachedAccountRecord(account.id);
    expect(second!.name).toBe('Acct One');

    // Invalidate clears both the record key and the legacy name key.
    await rawRedis.set(`cache:account-name:${account.id}`, JSON.stringify('Acct One'));
    await invalidateAccountRecordCache(account.id);
    expect(await rawRedis.get(accountKey(account.id))).toBeNull();
    expect(await rawRedis.get(`cache:account-name:${account.id}`)).toBeNull();

    const reloaded = await getCachedAccountRecord(account.id);
    expect(reloaded!.name).toBe('Acct Renamed');
  });

  it('round-trips account .settings JSON intact', async () => {
    const settings = { default_pipeline: 'p1', theme: { color: 'blue' } };
    const tenant = await insertTenant();
    const account = await insertAccount({ tenant_id: tenant.id, settings: JSON.stringify(settings) });

    const rec = await getCachedAccountRecord(account.id);
    expect(rec!.settings).toEqual(settings);
    expect(JSON.parse((await rawRedis.get(accountKey(account.id)))!).settings).toEqual(settings);
  });
});

describe('resolveTenantAccountNames (derives names from the cached record)', () => {
  it('returns tenant + account names sourced from the cached full records', async () => {
    const tenant = await insertTenant({ name: 'Name Tenant' });
    const account = await insertAccount({ tenant_id: tenant.id, name: 'Name Account' });

    const names = await resolveTenantAccountNames(tenant.id, account.id);
    expect(names.tenantName).toBe('Name Tenant');
    expect(names.accountName).toBe('Name Account');

    // The resolution populated the same full-record cache keys.
    expect(await rawRedis.get(tenantKey(tenant.id))).not.toBeNull();
    expect(await rawRedis.get(accountKey(account.id))).not.toBeNull();
  });

  it('reflects a rename only after invalidateTenantRecordCache', async () => {
    const tenant = await insertTenant({ name: 'Old Display' });

    const before = await resolveTenantAccountNames(tenant.id);
    expect(before.tenantName).toBe('Old Display');

    await getTestPool().query('UPDATE tenants SET name = $1 WHERE id = $2', ['New Display', tenant.id]);

    // Without invalidation the cached (stale) name is still returned.
    const stale = await resolveTenantAccountNames(tenant.id);
    expect(stale.tenantName).toBe('Old Display');

    await invalidateTenantRecordCache(tenant.id);

    const fresh = await resolveTenantAccountNames(tenant.id);
    expect(fresh.tenantName).toBe('New Display');
  });

  it('omits the account name when no accountId is supplied', async () => {
    const tenant = await insertTenant({ name: 'Solo Tenant' });
    const names = await resolveTenantAccountNames(tenant.id);
    expect(names.tenantName).toBe('Solo Tenant');
    expect(names.accountName).toBeUndefined();
  });
});
