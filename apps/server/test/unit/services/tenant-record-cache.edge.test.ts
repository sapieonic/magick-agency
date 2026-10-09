import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Redis } from 'ioredis';

/**
 * Edge-case coverage for the Redis-cached full-record accessors
 * `getCachedTenantRecord` / `getCachedAccountRecord`
 * (src/services/tenant-name-resolver.ts).
 *
 * These are ADDITIVE to test/unit/services/tenant-name-resolver.test.ts — that
 * file mocks the whole `redis-cache` module (so `redisCache.get` is a plain
 * vi.fn). Here we use the REAL `redisCache` with a fake `ioredis` injected via
 * `redisCache.init()`, which lets us exercise the parts the mock-based file
 * cannot:
 *   - the fail-open contract when the underlying Redis GET throws (the cache
 *     layer swallows it into a `null` miss → the accessor falls through to DB);
 *   - the JSON round-trip caveat on a cache HIT (Date columns come back as
 *     ISO strings, and `.settings` round-trips intact).
 *
 * Only the repositories, posthog, and logger are mocked — the cache is real.
 */

const mocks = vi.hoisted(() => ({
  tenantFindById: vi.fn(),
  accountFindById: vi.fn(),
}));

vi.mock('@magick-agency/db/repositories/tenant.repository', () => ({
  tenantRepository: { findById: mocks.tenantFindById },
}));
vi.mock('@magick-agency/db/repositories/account.repository', () => ({
  accountRepository: { findById: mocks.accountFindById },
}));
vi.mock('@magick-agency/observability', () => ({
  createChildLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { redisCache } from '../../../src/cache/redis-cache.js';
import {
  getCachedTenantRecord,
  getCachedAccountRecord,
} from '../../../src/services/tenant-name-resolver.js';

/** Build a fake ioredis with controllable get/set behavior and initialize the real cache. */
function installFakeRedis(overrides: {
  get?: (key: string) => Promise<string | null>;
  set?: (...args: unknown[]) => Promise<unknown>;
}): { get: ReturnType<typeof vi.fn>; set: ReturnType<typeof vi.fn>; del: ReturnType<typeof vi.fn> } {
  const get = vi.fn(overrides.get ?? (async () => null));
  const set = vi.fn(overrides.set ?? (async () => 'OK'));
  const del = vi.fn(async () => 0);
  redisCache.init({ get, set, del } as unknown as Redis);
  return { get, set, del };
}

describe('getCachedTenantRecord — Redis-error fail-open (real cache layer)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('falls through to the DB and still returns the record when the underlying Redis GET throws', async () => {
    // The cache layer (redisCache.get) swallows the thrown Redis error into a
    // `null` miss; the accessor treats that as a miss and reads the DB.
    const fake = installFakeRedis({ get: async () => { throw new Error('redis down'); } });
    const record = { id: 't-1', name: 'Acme', settings: { allowed_pipelines: ['silver'] } };
    mocks.tenantFindById.mockResolvedValue(record);

    const result = await getCachedTenantRecord('t-1');

    expect(result).toEqual(record); // fail-open: request is still served
    expect(mocks.tenantFindById).toHaveBeenCalledWith('t-1');
    // On a miss the freshly-loaded record is written back to the cache.
    expect(fake.set).toHaveBeenCalledOnce();
    expect(fake.set.mock.calls[0]![0]).toBe('cache:tenant:full:t-1');
  });

  it('account accessor is equally fail-open on a throwing Redis GET', async () => {
    installFakeRedis({ get: async () => { throw new Error('redis down'); } });
    const record = { id: 'a-1', name: 'West', settings: {} };
    mocks.accountFindById.mockResolvedValue(record);

    const result = await getCachedAccountRecord('a-1');

    expect(result).toEqual(record);
    expect(mocks.accountFindById).toHaveBeenCalledWith('a-1');
  });
});

describe('getCachedTenantRecord — DB miss is not cached', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns null and never writes the cache when the DB has no such tenant', async () => {
    const fake = installFakeRedis({ get: async () => null }); // cache miss
    mocks.tenantFindById.mockResolvedValue(null);

    const result = await getCachedTenantRecord('t-missing');

    expect(result).toBeNull();
    expect(mocks.tenantFindById).toHaveBeenCalledWith('t-missing');
    // A miss must never be cached — otherwise a not-yet-provisioned tenant would
    // be pinned as absent for the whole TTL.
    expect(fake.set).not.toHaveBeenCalled();
  });

  it('account: returns null and does not cache a DB miss', async () => {
    const fake = installFakeRedis({ get: async () => null });
    mocks.accountFindById.mockResolvedValue(null);

    const result = await getCachedAccountRecord('a-missing');

    expect(result).toBeNull();
    expect(fake.set).not.toHaveBeenCalled();
  });
});

describe('getCachedTenantRecord — JSON round-trip contract on a cache HIT', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns Date columns as ISO strings on a hit (documented caveat), never hitting the DB', async () => {
    const createdAt = new Date('2026-01-02T03:04:05.000Z');
    // Whatever was stored went through JSON.stringify, so a Date became a string.
    const stored = JSON.stringify({
      id: 't-1',
      name: 'Acme',
      slug: 'acme',
      settings: { allowed_pipelines: ['silver'] },
      status: 'active',
      created_at: createdAt,
      updated_at: createdAt,
    });
    installFakeRedis({ get: async () => stored });

    const result = await getCachedTenantRecord('t-1');

    expect(result).not.toBeNull();
    // The load-bearing caveat: a hit does NOT reconstruct Date objects.
    expect(typeof result!.created_at as unknown).toBe('string');
    expect(result!.created_at as unknown).toBe('2026-01-02T03:04:05.000Z');
    // Served purely from cache.
    expect(mocks.tenantFindById).not.toHaveBeenCalled();
  });

  it('round-trips the nested .settings object intact through the cache', async () => {
    const settings = {
      allowed_pipelines: ['silver', 'gold'],
      allowed_providers: ['vobiz'],
      default_pipeline: 'silver',
      enable_recording: true,
    };
    const stored = JSON.stringify({ id: 't-1', name: 'Acme', settings });
    installFakeRedis({ get: async () => stored });

    const result = await getCachedTenantRecord('t-1');

    // settings is what allowed-services enforcement reads — it must survive the
    // JSON round-trip byte-for-byte.
    expect(result!.settings).toEqual(settings);
    expect(mocks.tenantFindById).not.toHaveBeenCalled();
  });

  it('account: settings round-trips intact on a cache hit', async () => {
    const settings = { allowed_providers: ['vobiz', 'twilio'] };
    const stored = JSON.stringify({ id: 'a-1', name: 'West', settings });
    installFakeRedis({ get: async () => stored });

    const result = await getCachedAccountRecord('a-1');

    expect(result!.settings).toEqual(settings);
    expect(mocks.accountFindById).not.toHaveBeenCalled();
  });
});
