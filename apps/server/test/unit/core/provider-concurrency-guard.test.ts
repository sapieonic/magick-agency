import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getProviderLimit: vi.fn(),
}));

vi.mock('@magick-agency/db/repositories/provider-concurrency.repository', () => ({
  providerConcurrencyRepository: {
    getProviderLimit: mocks.getProviderLimit,
  },
}));

// PORT: the guards import `Traced` from the same package as `logger`; core's suite used
// the real tracing module, so the factory forwards the real decorator.
vi.mock('@magick-agency/observability', async () => ({
  Traced: (await import('@magick-agency/observability/tracing')).Traced,
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
  // The mock was missing this export. Harmless until `metrics.ts` (which this
  // module pulls in transitively) gained an import of `safe-emit.ts`, which calls
  // `createChildLogger` at module scope — a factory mock replaces the WHOLE module,
  // so the absent export became a load-time failure. Every other logger mock in
  // the suite already returns both.
  createChildLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));

import { ProviderConcurrencyGuard } from '../../../src/core/provider-concurrency-guard.js';

function redisMock() {
  return {
    eval: vi.fn(),
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue('OK'),
    del: vi.fn().mockResolvedValue(1),
    scan: vi.fn().mockResolvedValue(['0', []]),
    expire: vi.fn().mockResolvedValue(1),
    options: {},
  };
}

describe('ProviderConcurrencyGuard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('bypasses provider counters for legacy accounts', async () => {
    const redis = redisMock();
    mocks.getProviderLimit.mockResolvedValue({ mode: 'legacy_total', limit: null });
    const guard = new ProviderConcurrencyGuard(redis as any, 'test:', 300);

    await expect(guard.tryAcquire('call-1', 'tenant-1', 'account-1', 'vobiz'))
      .resolves.toEqual({ result: 'acquired', providerScoped: false, newlyAcquired: false });
    expect(redis.eval).not.toHaveBeenCalled();
  });

  it('rejects a provider with no allocation in provider mode', async () => {
    const redis = redisMock();
    mocks.getProviderLimit.mockResolvedValue({ mode: 'provider_breakdown', limit: null });
    const guard = new ProviderConcurrencyGuard(redis as any, 'test:', 300);

    await expect(guard.tryAcquire('call-1', 'tenant-1', 'account-1', 'voicelink'))
      .resolves.toEqual({ result: 'provider_unallocated', providerScoped: true });
  });

  it('atomically acquires within the selected provider limit', async () => {
    const redis = redisMock();
    redis.eval.mockResolvedValue(1);
    mocks.getProviderLimit.mockResolvedValue({ mode: 'provider_breakdown', limit: 30 });
    const guard = new ProviderConcurrencyGuard(redis as any, 'test:', 300);

    await expect(guard.tryAcquire('call-1', 'tenant-1', 'account-1', 'VoBiz'))
      .resolves.toEqual({ result: 'acquired', providerScoped: true, newlyAcquired: true });
    expect(redis.eval).toHaveBeenCalledWith(
      expect.any(String),
      3,
      'test:active_calls:provider:tenant-1:account-1:vobiz',
      'test:active_calls:provider:tenant-1:account-1:vobiz:lock:call-1',
      'test:active_calls:provider:tenant-1:account-1:vobiz:generation',
      30,
      330,
    );
  });

  it('reports provider saturation without borrowing another provider slot', async () => {
    const redis = redisMock();
    redis.eval.mockResolvedValue(0);
    mocks.getProviderLimit.mockResolvedValue({ mode: 'provider_breakdown', limit: 20 });
    const guard = new ProviderConcurrencyGuard(redis as any, 'test:', 300);

    await expect(guard.tryAcquire('call-21', 'tenant-1', 'account-1', 'voicelink'))
      .resolves.toEqual({ result: 'provider_full', providerScoped: true });
  });

  it('fails closed when Redis cannot enforce a provider-mode allocation', async () => {
    const redis = redisMock();
    redis.eval.mockRejectedValue(new Error('redis down'));
    mocks.getProviderLimit.mockResolvedValue({ mode: 'provider_breakdown', limit: 20 });
    const guard = new ProviderConcurrencyGuard(redis as any, 'test:', 300);

    await expect(guard.tryAcquire('call-1', 'tenant-1', 'account-1', 'voicelink'))
      .resolves.toEqual({ result: 'redis_unavailable', providerScoped: true });
  });

  it('fails closed when the allocation database is unavailable', async () => {
    const redis = redisMock();
    mocks.getProviderLimit.mockRejectedValue(new Error('database down'));
    const guard = new ProviderConcurrencyGuard(redis as any, 'test:', 300);

    await expect(guard.tryAcquireAll('call-1', 'tenant-1', 'account-1', 'vobiz'))
      .resolves.toEqual({ result: 'allocation_unavailable', providerScoped: true });
    expect(redis.eval).not.toHaveBeenCalled();
  });

  it('acquires global, account, and provider leases in one Redis transaction', async () => {
    const redis = redisMock();
    redis.eval.mockResolvedValue(1);
    mocks.getProviderLimit.mockResolvedValue({
      mode: 'provider_breakdown', limit: 30, total: 50, version: 2,
    });
    const guard = new ProviderConcurrencyGuard(redis as any, 'test:', 300, 100);

    await expect(guard.tryAcquireAll('call-1', 'tenant-1', 'account-1', 'VoBiz'))
      .resolves.toEqual({ result: 'acquired', providerScoped: true, newlyAcquired: true });
    expect(redis.eval).toHaveBeenCalledWith(
      expect.any(String), 9,
      'test:active_calls', 'test:active_calls:lock:call-1', 'test:active_calls:generation',
      'test:active_calls:account:tenant-1:account-1',
      'test:active_calls:account:tenant-1:account-1:lock:call-1',
      'test:active_calls:account:tenant-1:account-1:generation',
      'test:active_calls:provider:tenant-1:account-1:vobiz',
      'test:active_calls:provider:tenant-1:account-1:vobiz:lock:call-1',
      'test:active_calls:provider:tenant-1:account-1:vobiz:generation',
      100, 50, 30, 330,
    );
  });

  it('recognizes an already-owned composite lease without incrementing again', async () => {
    const redis = redisMock();
    redis.eval.mockResolvedValue(5);
    mocks.getProviderLimit.mockResolvedValue({
      mode: 'provider_breakdown', limit: 30, total: 50, version: 2,
    });
    const guard = new ProviderConcurrencyGuard(redis as any, 'test:', 300, 100);

    await expect(guard.tryAcquireAll('call-1', 'tenant-1', 'account-1', 'vobiz'))
      .resolves.toEqual({ result: 'acquired', providerScoped: true, newlyAcquired: false });
  });

  it('atomically repairs a partial composite lease and admits the retry', async () => {
    const redis = redisMock();
    redis.eval
      .mockResolvedValueOnce(6)
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(1);
    mocks.getProviderLimit.mockResolvedValue({
      mode: 'provider_breakdown', limit: 30, total: 50, version: 2,
    });
    const guard = new ProviderConcurrencyGuard(redis as any, 'test:', 300, 100);

    await expect(guard.tryAcquireAll('call-1', 'tenant-1', 'account-1', 'vobiz'))
      .resolves.toEqual({ result: 'acquired', providerScoped: true, newlyAcquired: true });
  });

  it('caches provider limits briefly and supports explicit account invalidation', async () => {
    const redis = redisMock();
    redis.eval.mockResolvedValue(1);
    mocks.getProviderLimit.mockResolvedValue({
      mode: 'provider_breakdown', limit: 30, total: 50, version: 2,
    });
    const guard = new ProviderConcurrencyGuard(redis as any, 'test:', 300, 100);

    await guard.tryAcquireAll('call-1', 'tenant-1', 'account-1', 'vobiz');
    await guard.tryAcquireAll('call-2', 'tenant-1', 'account-1', 'vobiz');
    expect(mocks.getProviderLimit).toHaveBeenCalledTimes(1);

    await guard.invalidateLimits('tenant-1', 'account-1');
    await guard.tryAcquireAll('call-3', 'tenant-1', 'account-1', 'vobiz');
    expect(mocks.getProviderLimit).toHaveBeenCalledTimes(2);
  });

  it('releases global, account, and provider leases in one Redis transaction', async () => {
    const redis = redisMock();
    const guard = new ProviderConcurrencyGuard(redis as any, 'test:', 300, 100);

    await guard.releaseAll('call-1', 'tenant-1', 'account-1', 'vobiz');

    expect(redis.eval).toHaveBeenCalledWith(
      expect.any(String), 9,
      'test:active_calls', 'test:active_calls:lock:call-1', 'test:active_calls:generation',
      'test:active_calls:account:tenant-1:account-1',
      'test:active_calls:account:tenant-1:account-1:lock:call-1',
      'test:active_calls:account:tenant-1:account-1:generation',
      'test:active_calls:provider:tenant-1:account-1:vobiz',
      'test:active_calls:provider:tenant-1:account-1:vobiz:lock:call-1',
      'test:active_calls:provider:tenant-1:account-1:vobiz:generation',
    );
  });

  it('reports how many leases the composite release actually deleted', async () => {
    const redis = redisMock();
    redis.eval.mockResolvedValue(3);
    const guard = new ProviderConcurrencyGuard(redis as any, 'test:', 300, 100);

    await expect(guard.releaseAll('call-1', 'tenant-1', 'account-1', 'vobiz'))
      .resolves.toEqual({ status: 'released', scopes: 3 });
  });

  it('reports a legacy account release (no provider lease) as two scopes', async () => {
    const redis = redisMock();
    redis.eval.mockResolvedValue(2);
    const guard = new ProviderConcurrencyGuard(redis as any, 'test:', 300, 100);

    await expect(guard.releaseAll('call-1', 'tenant-1', 'account-1', 'vobiz'))
      .resolves.toEqual({ status: 'released', scopes: 2 });
  });

  it('reports zero scopes when the call already had no leases', async () => {
    const redis = redisMock();
    redis.eval.mockResolvedValue(0);
    const guard = new ProviderConcurrencyGuard(redis as any, 'test:', 300, 100);

    await expect(guard.releaseAll('call-1', 'tenant-1', 'account-1', 'vobiz'))
      .resolves.toEqual({ status: 'released', scopes: 0 });
  });

  it('reports `unavailable` rather than silently releasing nothing without a provider', async () => {
    const redis = redisMock();
    const guard = new ProviderConcurrencyGuard(redis as any, 'test:', 300, 100);

    await expect(guard.releaseAll('call-1', 'tenant-1', 'account-1', ''))
      .resolves.toEqual({ status: 'unavailable' });
    expect(redis.eval).not.toHaveBeenCalled();
  });

  it('reports `unavailable` with no Redis client', async () => {
    const guard = new ProviderConcurrencyGuard(null, 'test:', 300, 100);

    await expect(guard.releaseAll('call-1', 'tenant-1', 'account-1', 'vobiz'))
      .resolves.toEqual({ status: 'unavailable' });
  });

  it('reports `failed` (never a zero-scope success) when the composite eval throws', async () => {
    const redis = redisMock();
    redis.eval.mockRejectedValue(new Error('redis down'));
    const guard = new ProviderConcurrencyGuard(redis as any, 'test:', 300, 100);

    const result = await guard.releaseAll('call-1', 'tenant-1', 'account-1', 'vobiz');
    expect(result.status).toBe('failed');
  });

  it('reports `failed` on a non-numeric reply, so the caller falls back', async () => {
    // A zero-scope success would tell the caller there is nothing left to do; an
    // unreadable reply means we genuinely cannot say.
    const redis = redisMock();
    redis.eval.mockResolvedValue('unexpected');
    const guard = new ProviderConcurrencyGuard(redis as any, 'test:', 300, 100);

    const result = await guard.releaseAll('call-1', 'tenant-1', 'account-1', 'vobiz');
    expect(result.status).toBe('failed');
  });

  it('extends all provider-mode leases only through the atomic composite script', async () => {
    const redis = redisMock();
    redis.eval.mockResolvedValue(3);
    mocks.getProviderLimit.mockResolvedValue({
      mode: 'provider_breakdown', limit: 30, total: 50, version: 2,
    });
    const guard = new ProviderConcurrencyGuard(redis as any, 'test:', 300, 100);

    await expect(guard.extendAll('call-1', 'tenant-1', 'account-1', 'vobiz', 4200))
      .resolves.toBe(true);
    expect(redis.eval).toHaveBeenCalledWith(
      expect.any(String),
      3,
      'test:active_calls:lock:call-1',
      'test:active_calls:account:tenant-1:account-1:lock:call-1',
      'test:active_calls:provider:tenant-1:account-1:vobiz:lock:call-1',
      4200,
      3,
    );
  });
});
