import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Comprehensive tests for concurrency-lock extension (`extendLock`).
 *
 * This tests the REAL implementations of `extendLock` in both
 * `ConcurrencyGuard` and `AccountConcurrencyGuard` (mocking only the Redis
 * client). The load-bearing detail is the `'XX'` flag on `EXPIRE`: it only
 * extends a lock that still exists, preventing resurrection of an expired and
 * reconciled lock, which would double-count against the counter.
 *
 * §6b of escalate-to-human-transfer-design.md: "The concurrency slot is
 * actually held now. Both guards gained `extendLock`, and the transfer extends
 * to the destination's `max_transfer_seconds` + grace — the same problem the
 * WebRTC bridge solves with its TTL override."
 */

// ─── Global mocks ───────────────────────────────────────────────────────────

// PORT: the guards import `Traced` from the same package as `logger`; core's suite used
// the real tracing module, so the factory forwards the real decorator.
vi.mock('@magick-agency/observability', async () => ({
  Traced: (await import('@magick-agency/observability/tracing')).Traced,
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
  createChildLogger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn() }),
}));

// ─── ConcurrencyGuard tests ──────────────────────────────────────────────────

describe('ConcurrencyGuard.extendLock()', () => {
  let mockRedis: any;

  beforeEach(() => {
    mockRedis = {
      expire: vi.fn(),
    };
  });

  it('returns true when Redis reports the key was extended (result === 1)', async () => {
    const { ConcurrencyGuard } = await import('../../../src/core/concurrency-guard.js');
    mockRedis.expire.mockResolvedValue(1);
    const guard = new ConcurrencyGuard(mockRedis, 'test:', 10, 300);

    const result = await guard.extendLock('call-1', 600);

    expect(result).toBe(true);
    expect(mockRedis.expire).toHaveBeenCalledWith('test:active_calls:lock:call-1', 600, 'XX');
  });

  it('returns false when Redis reports the key was NOT extended (result === 0)', async () => {
    const { ConcurrencyGuard } = await import('../../../src/core/concurrency-guard.js');
    mockRedis.expire.mockResolvedValue(0);
    const guard = new ConcurrencyGuard(mockRedis, 'test:', 10, 300);

    const result = await guard.extendLock('call-2', 600);

    expect(result).toBe(false);
    // The key didn't exist — extending failed gracefully
    expect(mockRedis.expire).toHaveBeenCalledWith('test:active_calls:lock:call-2', 600, 'XX');
  });

  it('uses the XX flag to prevent resurrection of expired locks', async () => {
    const { ConcurrencyGuard } = await import('../../../src/core/concurrency-guard.js');
    mockRedis.expire.mockResolvedValue(0); // Key is gone
    const guard = new ConcurrencyGuard(mockRedis, 'test:', 10, 300);

    // The lock has already expired and been reconciled. Without 'XX',
    // EXPIRE would succeed and recreate the lock, resurrecting a slot.
    const result = await guard.extendLock('call-zombie', 600);

    // Must fail because the key doesn't exist
    expect(result).toBe(false);
    // Verify we DID send the XX flag (the thing that prevents resurrection)
    const [, , ...args] = mockRedis.expire.mock.calls[0];
    expect(args).toContain('XX');
  });

  it('returns false when ttlSeconds <= 0', async () => {
    const { ConcurrencyGuard } = await import('../../../src/core/concurrency-guard.js');
    const guard = new ConcurrencyGuard(mockRedis, 'test:', 10, 300);

    const resultZero = await guard.extendLock('call-3', 0);
    const resultNeg = await guard.extendLock('call-4', -100);

    expect(resultZero).toBe(false);
    expect(resultNeg).toBe(false);
    // Redis should never be called for invalid TTL
    expect(mockRedis.expire).not.toHaveBeenCalled();
  });

  it('returns false when redis is null', async () => {
    const { ConcurrencyGuard } = await import('../../../src/core/concurrency-guard.js');
    const guard = new ConcurrencyGuard(null, 'test:', 10, 300);

    const result = await guard.extendLock('call-5', 600);

    expect(result).toBe(false);
  });

  it('returns false when Redis throws an error (gracefully caught)', async () => {
    const { ConcurrencyGuard } = await import('../../../src/core/concurrency-guard.js');
    mockRedis.expire.mockRejectedValue(new Error('Redis connection lost'));
    const guard = new ConcurrencyGuard(mockRedis, 'test:', 10, 300);

    const result = await guard.extendLock('call-6', 600);

    // Must not throw into the call path
    expect(result).toBe(false);
  });

  it('checks degradedMode flag and returns false without calling Redis when true', async () => {
    const { ConcurrencyGuard } = await import('../../../src/core/concurrency-guard.js');
    const guard = new ConcurrencyGuard(mockRedis, 'test:', 10, 300);

    // Manually set degraded mode on the guard
    (guard as any).degradedMode = true;

    const result = await guard.extendLock('call-8', 600);

    expect(result).toBe(false);
    // No call should have been made to Redis
    expect(mockRedis.expire).not.toHaveBeenCalled();
  });

  it('converts ttlSeconds to integer via Math.floor', async () => {
    const { ConcurrencyGuard } = await import('../../../src/core/concurrency-guard.js');
    mockRedis.expire.mockResolvedValue(1);
    const guard = new ConcurrencyGuard(mockRedis, 'test:', 10, 300);

    await guard.extendLock('call-9', 599.9);

    expect(mockRedis.expire).toHaveBeenCalledWith('test:active_calls:lock:call-9', 599, 'XX');
  });

  it('uses correct key naming: ${keyPrefix}active_calls:lock:${callId}', async () => {
    const { ConcurrencyGuard } = await import('../../../src/core/concurrency-guard.js');
    mockRedis.expire.mockResolvedValue(1);
    const guard = new ConcurrencyGuard(mockRedis, 'myapp:', 10, 300);

    await guard.extendLock('my-call-id', 600);

    expect(mockRedis.expire).toHaveBeenCalledWith('myapp:active_calls:lock:my-call-id', 600, 'XX');
  });
});

// ─── AccountConcurrencyGuard tests ───────────────────────────────────────────

describe('AccountConcurrencyGuard.extendLock()', () => {
  let mockRedis: any;

  beforeEach(() => {
    mockRedis = {
      expire: vi.fn(),
    };
  });

  it('returns true when Redis reports the key was extended (result === 1)', async () => {
    const { AccountConcurrencyGuard } = await import('../../../src/core/account-concurrency-guard.js');
    mockRedis.expire.mockResolvedValue(1);
    const guard = new AccountConcurrencyGuard(mockRedis, 'test:', 300);

    const result = await guard.extendLock('call-1', 'tenant-a', 'account-1', 600);

    expect(result).toBe(true);
    expect(mockRedis.expire).toHaveBeenCalledWith(
      'test:active_calls:account:tenant-a:account-1:lock:call-1',
      600,
      'XX'
    );
  });

  it('returns false when Redis reports the key was NOT extended (result === 0)', async () => {
    const { AccountConcurrencyGuard } = await import('../../../src/core/account-concurrency-guard.js');
    mockRedis.expire.mockResolvedValue(0);
    const guard = new AccountConcurrencyGuard(mockRedis, 'test:', 300);

    const result = await guard.extendLock('call-2', 'tenant-a', 'account-1', 600);

    expect(result).toBe(false);
    expect(mockRedis.expire).toHaveBeenCalledWith(
      'test:active_calls:account:tenant-a:account-1:lock:call-2',
      600,
      'XX'
    );
  });

  it('uses the XX flag to prevent resurrection of expired locks (tenant/account scoped)', async () => {
    const { AccountConcurrencyGuard } = await import('../../../src/core/account-concurrency-guard.js');
    mockRedis.expire.mockResolvedValue(0); // Key is gone
    const guard = new AccountConcurrencyGuard(mockRedis, 'test:', 300);

    // A transferred call's lock expires mid-conversation. Later extension fails
    // because the lock no longer exists. Without 'XX', a new lock would be
    // created, resurrecting a slot for a counter that's already been
    // reconciled down.
    const result = await guard.extendLock('call-zombie', 'tenant-b', 'account-2', 600);

    expect(result).toBe(false);
    // Verify the XX flag is present
    const [, , ...args] = mockRedis.expire.mock.calls[0];
    expect(args).toContain('XX');
  });

  it('returns false when ttlSeconds <= 0', async () => {
    const { AccountConcurrencyGuard } = await import('../../../src/core/account-concurrency-guard.js');
    const guard = new AccountConcurrencyGuard(mockRedis, 'test:', 300);

    const resultZero = await guard.extendLock('call-3', 'tenant-a', 'account-1', 0);
    const resultNeg = await guard.extendLock('call-4', 'tenant-a', 'account-1', -100);

    expect(resultZero).toBe(false);
    expect(resultNeg).toBe(false);
    expect(mockRedis.expire).not.toHaveBeenCalled();
  });

  it('returns false when redis is null', async () => {
    const { AccountConcurrencyGuard } = await import('../../../src/core/account-concurrency-guard.js');
    const guard = new AccountConcurrencyGuard(null, 'test:', 300);

    const result = await guard.extendLock('call-5', 'tenant-a', 'account-1', 600);

    expect(result).toBe(false);
  });

  it('returns false when Redis throws an error (gracefully caught)', async () => {
    const { AccountConcurrencyGuard } = await import('../../../src/core/account-concurrency-guard.js');
    mockRedis.expire.mockRejectedValue(new Error('Connection timeout'));
    const guard = new AccountConcurrencyGuard(mockRedis, 'test:', 300);

    const result = await guard.extendLock('call-6', 'tenant-a', 'account-1', 600);

    // Must not throw
    expect(result).toBe(false);
  });

  it('checks degradedMode flag and returns false without calling Redis when true', async () => {
    const { AccountConcurrencyGuard } = await import('../../../src/core/account-concurrency-guard.js');
    const guard = new AccountConcurrencyGuard(mockRedis, 'test:', 300);

    // Manually set degraded mode on the guard
    (guard as any).degradedMode = true;

    const result = await guard.extendLock('call-8', 'tenant-a', 'account-1', 600);

    expect(result).toBe(false);
    expect(mockRedis.expire).not.toHaveBeenCalled();
  });

  it('converts ttlSeconds to integer via Math.floor', async () => {
    const { AccountConcurrencyGuard } = await import('../../../src/core/account-concurrency-guard.js');
    mockRedis.expire.mockResolvedValue(1);
    const guard = new AccountConcurrencyGuard(mockRedis, 'test:', 300);

    await guard.extendLock('call-9', 'tenant-a', 'account-1', 599.7);

    expect(mockRedis.expire).toHaveBeenCalledWith(
      'test:active_calls:account:tenant-a:account-1:lock:call-9',
      599,
      'XX'
    );
  });

  it('uses correct key naming: ${keyPrefix}active_calls:account:${tenantId}:${accountId}:lock:${callId}', async () => {
    const { AccountConcurrencyGuard } = await import('../../../src/core/account-concurrency-guard.js');
    mockRedis.expire.mockResolvedValue(1);
    const guard = new AccountConcurrencyGuard(mockRedis, 'prod:', 300);

    await guard.extendLock('call-xyz', 'tenant-prod', 'account-premium', 600);

    expect(mockRedis.expire).toHaveBeenCalledWith(
      'prod:active_calls:account:tenant-prod:account-premium:lock:call-xyz',
      600,
      'XX'
    );
  });

  it('correctly scopes by tenant+account composite', async () => {
    const { AccountConcurrencyGuard } = await import('../../../src/core/account-concurrency-guard.js');
    mockRedis.expire.mockResolvedValue(1);
    const guard = new AccountConcurrencyGuard(mockRedis, 'test:', 300);

    // Two different accounts
    await guard.extendLock('call-a', 'tenant-1', 'account-1', 600);
    await guard.extendLock('call-b', 'tenant-1', 'account-2', 600);

    // Verify the keys are scoped by BOTH tenant and account
    const call1 = mockRedis.expire.mock.calls[0][0];
    const call2 = mockRedis.expire.mock.calls[1][0];

    expect(call1).toContain('tenant-1:account-1');
    expect(call2).toContain('tenant-1:account-2');
    expect(call1).not.toEqual(call2);
  });
});

// ─── Mutation tests to verify the XX flag is load-bearing ──────────────────

describe('ConcurrencyGuard.extendLock() — mutation verification (XX flag)', () => {
  let mockRedis: any;

  beforeEach(() => {
    mockRedis = { expire: vi.fn() };
  });

  it('FAILS when XX flag is removed from EXPIRE call', async () => {
    const { ConcurrencyGuard } = await import('../../../src/core/concurrency-guard.js');

    // This simulates what would happen if a mutation removed the 'XX' flag:
    // the key would be created even if expired, resurrecting the slot.
    // Our test must detect this by asserting the XX flag is present.
    mockRedis.expire.mockResolvedValue(1);
    const guard = new ConcurrencyGuard(mockRedis, 'test:', 10, 300);

    await guard.extendLock('call-x', 600);

    const [, , ...args] = mockRedis.expire.mock.calls[0];
    // This assertion FAILS if XX is missing — the mutation test would catch it
    expect(args).toContain('XX');
  });

  it('FAILS when EXPIRE is replaced with SET (would resurrect expired locks)', async () => {
    const { ConcurrencyGuard } = await import('../../../src/core/concurrency-guard.js');

    // If extendLock used SET instead of EXPIRE XX, it would always succeed
    // even for non-existent keys, violating the guard semantics.
    mockRedis.expire.mockResolvedValue(1);
    mockRedis.set = vi.fn(); // Add set mock for comparison
    const guard = new ConcurrencyGuard(mockRedis, 'test:', 10, 300);

    await guard.extendLock('call-y', 600);

    // The call was made to expire(), not set()
    expect(mockRedis.expire).toHaveBeenCalled();
    expect(mockRedis.set).not.toHaveBeenCalled();
  });
});
