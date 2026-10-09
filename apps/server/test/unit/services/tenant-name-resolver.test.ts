import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  tenantFindById: vi.fn(),
  accountFindById: vi.fn(),
  cacheGet: vi.fn(),
  cacheSet: vi.fn(),
  cacheDel: vi.fn(),
  createChildLogger: vi.fn(() => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() })),
}));

vi.mock('@magick-agency/db/repositories/tenant.repository', () => ({
  tenantRepository: { findById: mocks.tenantFindById },
}));
vi.mock('@magick-agency/db/repositories/account.repository', () => ({
  accountRepository: { findById: mocks.accountFindById },
}));
vi.mock('../../../src/cache/redis-cache.js', () => ({
  redisCache: { get: mocks.cacheGet, set: mocks.cacheSet, del: mocks.cacheDel },
}));
vi.mock('@magick-agency/observability', () => ({ createChildLogger: mocks.createChildLogger }));

import {
  resolveTenantAccountNames,
  getCachedTenantRecord,
  getCachedAccountRecord,
  invalidateTenantRecordCache,
  invalidateAccountRecordCache,
} from '../../../src/services/tenant-name-resolver.js';

describe('resolveTenantAccountNames', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.cacheGet.mockResolvedValue(null);
  });

  it('loads tenant and account names from the repositories on a cache miss', async () => {
    mocks.tenantFindById.mockResolvedValue({ name: 'Acme' });
    // `tenant_id` is now part of the fixture because the resolver checks it: an
    // account's name is only used when the account is actually in this tenant.
    mocks.accountFindById.mockResolvedValue({ name: 'West', tenant_id: 't-1' });

    const result = await resolveTenantAccountNames('t-1', 'a-1');

    expect(result).toEqual({ tenantName: 'Acme', accountName: 'West' });
    expect(mocks.tenantFindById).toHaveBeenCalledWith('t-1');
    expect(mocks.accountFindById).toHaveBeenCalledWith('a-1');
    // Names now derive from the shared full-record cache, so the whole record is stored.
    expect(mocks.cacheSet).toHaveBeenCalledWith('cache:tenant:full:t-1', { name: 'Acme' }, expect.any(Number));
    expect(mocks.cacheSet).toHaveBeenCalledWith('cache:account:full:a-1', { name: 'West', tenant_id: 't-1' }, expect.any(Number));
  });

  it('serves names from cache without hitting the repositories', async () => {
    mocks.cacheGet.mockImplementation(async (key: string) =>
      key === 'cache:tenant:full:t-1'
        ? { name: 'Cached Tenant' }
        : { name: 'Cached Account', tenant_id: 't-1' },
    );

    const result = await resolveTenantAccountNames('t-1', 'a-1');

    expect(result).toEqual({ tenantName: 'Cached Tenant', accountName: 'Cached Account' });
    expect(mocks.tenantFindById).not.toHaveBeenCalled();
    expect(mocks.accountFindById).not.toHaveBeenCalled();
  });

  it('resolves a cached tenant name alongside a DB-loaded account name', async () => {
    mocks.cacheGet.mockImplementation(async (key: string) =>
      key === 'cache:tenant:full:t-1' ? { name: 'Cached Tenant' } : null,
    );
    mocks.accountFindById.mockResolvedValue({ name: 'Fresh Account', tenant_id: 't-1' });

    const result = await resolveTenantAccountNames('t-1', 'a-1');

    expect(result).toEqual({ tenantName: 'Cached Tenant', accountName: 'Fresh Account' });
    expect(mocks.tenantFindById).not.toHaveBeenCalled(); // tenant served from cache
    expect(mocks.accountFindById).toHaveBeenCalledWith('a-1'); // account loaded + cached
    expect(mocks.cacheSet).toHaveBeenCalledWith('cache:account:full:a-1', { name: 'Fresh Account', tenant_id: 't-1' }, expect.any(Number));
  });

  it('still resolves the tenant name when account resolution fails', async () => {
    mocks.tenantFindById.mockResolvedValue({ name: 'Acme' });
    mocks.accountFindById.mockRejectedValue(new Error('db down'));

    const result = await resolveTenantAccountNames('t-1', 'a-1');

    expect(result).toEqual({ tenantName: 'Acme' });
  });

  it('will not name an account that belongs to a DIFFERENT tenant', async () => {
    /**
     * The read half of the `X-Account-Id` hole. The tenant-context middleware now
     * refuses a foreign account before any route runs, so on the HTTP path this is
     * a second lock — but this function has other callers (the scheduler,
     * recurring schedules, the bulk-dispatch consumer) and what the name is used
     * FOR is why it matters: it is forwarded to the voice engine as `x-mgkvc-account-name`. One mismatched pair attributes one
     * tenant's calls and events to another tenant's account, silently and
     * permanently.
     */
    mocks.tenantFindById.mockResolvedValue({ name: 'Acme' });
    mocks.accountFindById.mockResolvedValue({ name: "Rival's West", tenant_id: 't-2' });

    const result = await resolveTenantAccountNames('t-1', 'a-foreign');

    // Omitted, not thrown: this function decorates a request and must never fail
    // one. A missing name header is already a supported outcome; a wrong one is not.
    expect(result).toEqual({ tenantName: 'Acme' });
  });

  it('skips account resolution when no accountId is provided', async () => {
    mocks.tenantFindById.mockResolvedValue({ name: 'Acme' });

    const result = await resolveTenantAccountNames('t-1');

    expect(result).toEqual({ tenantName: 'Acme' });
    expect(mocks.accountFindById).not.toHaveBeenCalled();
  });

  it('omits a name (never throws) when the record is missing', async () => {
    mocks.tenantFindById.mockResolvedValue(null);

    const result = await resolveTenantAccountNames('t-unknown');

    expect(result).toEqual({});
    expect(mocks.cacheSet).not.toHaveBeenCalled();
  });

  it('omits a name (never throws) when the repository errors', async () => {
    mocks.tenantFindById.mockRejectedValue(new Error('db down'));

    await expect(resolveTenantAccountNames('t-1')).resolves.toEqual({});
  });
});

describe('getCachedTenantRecord / getCachedAccountRecord', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.cacheGet.mockResolvedValue(null);
  });

  it('returns the cached full record without hitting the DB', async () => {
    const record = { id: 't-1', name: 'Acme', settings: { pipelines: ['x'] } };
    mocks.cacheGet.mockResolvedValue(record);

    const result = await getCachedTenantRecord('t-1');

    expect(result).toEqual(record);
    expect(mocks.cacheGet).toHaveBeenCalledWith('cache:tenant:full:t-1');
    expect(mocks.tenantFindById).not.toHaveBeenCalled();
  });

  it('loads from the DB on a miss and caches the full record', async () => {
    const record = { id: 't-1', name: 'Acme', settings: { pipelines: ['x'] } };
    mocks.tenantFindById.mockResolvedValue(record);

    const result = await getCachedTenantRecord('t-1');

    expect(result).toEqual(record);
    expect(mocks.cacheSet).toHaveBeenCalledWith('cache:tenant:full:t-1', record, expect.any(Number));
  });

  it('does not cache a missing record', async () => {
    mocks.tenantFindById.mockResolvedValue(null);

    const result = await getCachedTenantRecord('t-unknown');

    expect(result).toBeNull();
    expect(mocks.cacheSet).not.toHaveBeenCalled();
  });

  it('resolves account records under their own key', async () => {
    const record = { id: 'a-1', name: 'West', settings: {} };
    mocks.accountFindById.mockResolvedValue(record);

    await getCachedAccountRecord('a-1');

    expect(mocks.cacheSet).toHaveBeenCalledWith('cache:account:full:a-1', record, expect.any(Number));
  });
});

describe('record cache invalidation', () => {
  beforeEach(() => vi.clearAllMocks());

  it('clears the tenant full-record key and the legacy name key', async () => {
    await invalidateTenantRecordCache('t-1');
    expect(mocks.cacheDel).toHaveBeenCalledWith('cache:tenant:full:t-1', 'cache:tenant-name:t-1');
  });

  it('clears the account full-record key and the legacy name key', async () => {
    await invalidateAccountRecordCache('a-1');
    expect(mocks.cacheDel).toHaveBeenCalledWith('cache:account:full:a-1', 'cache:account-name:a-1');
  });
});
