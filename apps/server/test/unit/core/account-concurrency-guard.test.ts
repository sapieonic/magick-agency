import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock logger
// The guards import `Traced` from the same package as `logger`, so the factory
// forwards the real tracing decorator.
vi.mock('@magick-agency/observability', async () => ({
  Traced: (await import('@magick-agency/observability/tracing')).Traced,
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
  createChildLogger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

// Mock account settings repository
const mocks = vi.hoisted(() => ({
  getMaxConcurrentCalls: vi.fn().mockResolvedValue(5),
}));

vi.mock('@magick-agency/db/repositories/account-settings.repository', () => ({
  accountSettingsRepository: {
    getMaxConcurrentCalls: mocks.getMaxConcurrentCalls,
  },
}));

import { AccountConcurrencyGuard } from '../../../src/core/account-concurrency-guard.js';

function createMockRedis(overrides: Record<string, unknown> = {}) {
  return {
    incr: vi.fn().mockResolvedValue(1),
    decr: vi.fn().mockResolvedValue(0),
    set: vi.fn().mockResolvedValue('OK'),
    del: vi.fn().mockResolvedValue(1),
    get: vi.fn().mockResolvedValue(null),
    eval: vi.fn().mockResolvedValue(1),
    scan: vi.fn().mockResolvedValue(['0', []]),
    ...overrides,
  } as any;
}

const TENANT = 'tenant-1';
const ACCOUNT = 'account-1';

describe('AccountConcurrencyGuard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getMaxConcurrentCalls.mockResolvedValue(5);
  });

  describe('with Redis', () => {
    let redis: ReturnType<typeof createMockRedis>;
    let guard: AccountConcurrencyGuard;

    beforeEach(() => {
      redis = createMockRedis();
      guard = new AccountConcurrencyGuard(redis, 'voiceai:', 300);
    });

    it('acquires when under account limit via atomic Lua script', async () => {
      redis.eval.mockResolvedValue(1);
      const result = await guard.tryAcquire('call-1', TENANT, ACCOUNT);

      expect(result).toBe(true);
      expect(redis.eval).toHaveBeenCalledOnce();
      // Verify script args: counter, call lock and reconciliation generation.
      const evalArgs = redis.eval.mock.calls[0]!;
      expect(evalArgs[1]).toBe(3); // numKeys
      expect(evalArgs[2]).toBe(`voiceai:active_calls:account:${TENANT}:${ACCOUNT}`); // counterKey
      expect(evalArgs[3]).toBe(`voiceai:active_calls:account:${TENANT}:${ACCOUNT}:lock:call-1`); // lockKey
      expect(evalArgs[4]).toBe(`voiceai:active_calls:account:${TENANT}:${ACCOUNT}:generation`);
      expect(evalArgs[5]).toBe(5);   // limit
      expect(evalArgs[6]).toBe(330); // ttl = 300 + 30
    });

    it('rejects when Lua script returns 0 (limit exceeded)', async () => {
      redis.eval.mockResolvedValue(0);
      const result = await guard.tryAcquire('call-1', TENANT, ACCOUNT);

      expect(result).toBe(false);
      // No separate INCR/DECR calls — all inside Lua
      expect(redis.incr).not.toHaveBeenCalled();
      expect(redis.decr).not.toHaveBeenCalled();
    });

    it('honors ttlSecondsOverride as the lock TTL (ARGV[2]) instead of the default', async () => {
      redis.eval.mockResolvedValue(1);
      await guard.tryAcquire('call-1', TENANT, ACCOUNT, 1860);

      expect(redis.eval.mock.calls[0]![6]).toBe(1860);
    });

    it('falls back to the default lock TTL when the override is omitted or non-positive', async () => {
      redis.eval.mockResolvedValue(1);
      await guard.tryAcquire('call-1', TENANT, ACCOUNT);
      expect(redis.eval.mock.calls[0]![6]).toBe(330); // 300 + 30

      redis.eval.mockClear();
      await guard.tryAcquire('call-2', TENANT, ACCOUNT, 0);
      expect(redis.eval.mock.calls[0]![6]).toBe(330);
    });

    it('uses custom limit from DB as Lua script argument', async () => {
      mocks.getMaxConcurrentCalls.mockResolvedValue(3);
      redis.eval.mockResolvedValue(0);

      await guard.tryAcquire('call-1', TENANT, ACCOUNT);

      const evalArgs = redis.eval.mock.calls[0]!;
      expect(evalArgs[5]).toBe(3); // limit from DB
      expect(mocks.getMaxConcurrentCalls).toHaveBeenCalledWith(TENANT, ACCOUNT);
    });

    it('caches limit in Redis after DB lookup', async () => {
      redis.get.mockResolvedValue(null); // cache miss
      await guard.tryAcquire('call-1', TENANT, ACCOUNT);

      expect(mocks.getMaxConcurrentCalls).toHaveBeenCalledWith(TENANT, ACCOUNT);
      // Should cache the limit via regular SET (not inside Lua)
      expect(redis.set).toHaveBeenCalledWith(
        `voiceai:account_limit:${TENANT}:${ACCOUNT}`,
        '5',
        'EX',
        60,
      );
    });

    it('uses cached limit from Redis without hitting DB', async () => {
      redis.get
        .mockResolvedValueOnce('3') // limit cache hit
        .mockResolvedValue(null);
      redis.eval.mockResolvedValue(0); // rejected (4 > 3)

      const result = await guard.tryAcquire('call-1', TENANT, ACCOUNT);

      expect(result).toBe(false);
      expect(mocks.getMaxConcurrentCalls).not.toHaveBeenCalled();
      // Verify limit=3 was passed to the Lua script
      expect(redis.eval.mock.calls[0]![5]).toBe(3);
    });

    it('releases via atomic Lua script', async () => {
      redis.eval.mockResolvedValue(1); // lock existed
      await guard.release('call-1', TENANT, ACCOUNT);

      expect(redis.eval).toHaveBeenCalledOnce();
      const evalArgs = redis.eval.mock.calls[0]!;
      expect(evalArgs[1]).toBe(3); // numKeys
      // Release script: KEYS[1] = lockKey, KEYS[2] = counterKey
      expect(evalArgs[2]).toBe(`voiceai:active_calls:account:${TENANT}:${ACCOUNT}:lock:call-1`);
      expect(evalArgs[3]).toBe(`voiceai:active_calls:account:${TENANT}:${ACCOUNT}`);
      expect(evalArgs[4]).toBe(`voiceai:active_calls:account:${TENANT}:${ACCOUNT}:generation`);
    });

    it('release handles non-existent lock via Lua script without error', async () => {
      redis.eval.mockResolvedValue(0); // lock did not exist
      await guard.release('call-1', TENANT, ACCOUNT);

      expect(redis.eval).toHaveBeenCalledOnce();
      // No separate decr — Lua script handles it internally (only decrements if existed)
      expect(redis.decr).not.toHaveBeenCalled();
    });

    it('getAccountCount returns Redis value', async () => {
      redis.get.mockResolvedValue('3');
      const count = await guard.getAccountCount(TENANT, ACCOUNT);
      expect(count).toBe(3);
    });

    it('getAccountCount returns 0 when key missing', async () => {
      redis.get.mockResolvedValue(null);
      const count = await guard.getAccountCount(TENANT, ACCOUNT);
      expect(count).toBe(0);
    });

    it('is not degraded initially', () => {
      expect(guard.isDegraded()).toBe(false);
    });
  });

  describe('Lua script atomicity', () => {
    it('acquire does not make separate INCR/SET calls — all inside eval', async () => {
      const redis = createMockRedis();
      const guard = new AccountConcurrencyGuard(redis, 'voiceai:', 300);

      redis.eval.mockResolvedValue(1);
      await guard.tryAcquire('call-1', TENANT, ACCOUNT);

      expect(redis.eval).toHaveBeenCalledOnce();
      expect(redis.incr).not.toHaveBeenCalled();
      // redis.set IS called for limit caching, but NOT for lock key
      const setCallArgs = redis.set.mock.calls.map((c: any[]) => c[0]);
      expect(setCallArgs.every((key: string) => key.includes('account_limit:'))).toBe(true);
    });

    it('release does not make separate DEL/DECR calls — all inside eval', async () => {
      const redis = createMockRedis();
      const guard = new AccountConcurrencyGuard(redis, 'voiceai:', 300);

      redis.eval.mockResolvedValue(1);
      await guard.release('call-1', TENANT, ACCOUNT);

      expect(redis.eval).toHaveBeenCalledOnce();
      expect(redis.del).not.toHaveBeenCalled();
      expect(redis.decr).not.toHaveBeenCalled();
    });

    it('acquire script receives INCR logic (contains INCR in script body)', async () => {
      const redis = createMockRedis();
      const guard = new AccountConcurrencyGuard(redis, 'voiceai:', 300);

      redis.eval.mockResolvedValue(1);
      await guard.tryAcquire('call-1', TENANT, ACCOUNT);

      const script = redis.eval.mock.calls[0]![0] as string;
      expect(script).toContain('INCR');
      expect(script).toContain('DECR');
      expect(script).toContain('SET');
    });

    it('release script contains DEL and DECR with floor logic', async () => {
      const redis = createMockRedis();
      const guard = new AccountConcurrencyGuard(redis, 'voiceai:', 300);

      await guard.release('call-1', TENANT, ACCOUNT);

      const script = redis.eval.mock.calls[0]![0] as string;
      expect(script).toContain('DEL');
      expect(script).toContain('DECR');
      // Floor-at-zero: if val < 0 then SET to '0'
      expect(script).toContain('val < 0');
    });
  });

  describe('reconcile', () => {
    it('resets counter when it drifts above lock count', async () => {
      const redis = createMockRedis({
        scan: vi.fn().mockResolvedValue(['0', ['lock:call-1', 'lock:call-2']]),
        get: vi.fn().mockResolvedValue('5'), // counter says 5 but only 2 locks
      });
      const guard = new AccountConcurrencyGuard(redis, 'voiceai:', 300);

      await guard.reconcile(TENANT, ACCOUNT);

      expect(redis.eval).toHaveBeenCalledWith(
        expect.any(String), 2,
        `voiceai:active_calls:account:${TENANT}:${ACCOUNT}`,
        `voiceai:active_calls:account:${TENANT}:${ACCOUNT}:generation`,
        '5', 2,
      );
    });

    it('deletes counter when no locks exist and returns true', async () => {
      const redis = createMockRedis({
        scan: vi.fn().mockResolvedValue(['0', []]),
        get: vi.fn().mockResolvedValue('3'), // counter says 3 but 0 locks
      });
      const guard = new AccountConcurrencyGuard(redis, 'voiceai:', 300);

      const healed = await guard.reconcile(TENANT, ACCOUNT);

      expect(healed).toBe(true);
      expect(redis.eval).toHaveBeenCalledWith(
        expect.any(String), 2,
        `voiceai:active_calls:account:${TENANT}:${ACCOUNT}`,
        `voiceai:active_calls:account:${TENANT}:${ACCOUNT}:generation`,
        '3', 0,
      );
    });

    it('returns true when it resets a drifted counter', async () => {
      const redis = createMockRedis({
        scan: vi.fn().mockResolvedValue(['0', ['lock:call-1', 'lock:call-2']]),
        get: vi.fn().mockResolvedValue('5'),
      });
      const guard = new AccountConcurrencyGuard(redis, 'voiceai:', 300);

      const healed = await guard.reconcile(TENANT, ACCOUNT);

      expect(healed).toBe(true);
    });

    it('is a no-op when counter matches lock count and returns false', async () => {
      const redis = createMockRedis({
        scan: vi.fn().mockResolvedValue(['0', ['lock:call-1', 'lock:call-2']]),
        get: vi.fn().mockResolvedValue('2'), // matches
      });
      const guard = new AccountConcurrencyGuard(redis, 'voiceai:', 300);

      const healed = await guard.reconcile(TENANT, ACCOUNT);

      expect(healed).toBe(false);
      // No set or del on the counter key
      expect(redis.set).not.toHaveBeenCalled();
      expect(redis.del).not.toHaveBeenCalled();
    });

    it('returns false without Redis and in the error path', async () => {
      const noRedis = new AccountConcurrencyGuard(null, 'voiceai:', 300);
      expect(await noRedis.reconcile(TENANT, ACCOUNT)).toBe(false);

      const redis = createMockRedis({
        scan: vi.fn().mockRejectedValue(new Error('connection lost')),
      });
      const guard = new AccountConcurrencyGuard(redis, 'voiceai:', 300);
      expect(await guard.reconcile(TENANT, ACCOUNT)).toBe(false);
    });

    it('handles multi-page SCAN correctly', async () => {
      const redis = createMockRedis({
        scan: vi.fn()
          .mockResolvedValueOnce(['42', ['lock:call-1', 'lock:call-2']]) // first page, cursor=42
          .mockResolvedValueOnce(['0', ['lock:call-3']]),                // second page, cursor=0 (done)
        get: vi.fn().mockResolvedValue('5'), // counter says 5, but 3 locks
      });
      const guard = new AccountConcurrencyGuard(redis, 'voiceai:', 300);

      await guard.reconcile(TENANT, ACCOUNT);

      expect(redis.scan).toHaveBeenCalledTimes(2);
      expect(redis.eval).toHaveBeenCalledWith(
        expect.any(String), 2,
        `voiceai:active_calls:account:${TENANT}:${ACCOUNT}`,
        `voiceai:active_calls:account:${TENANT}:${ACCOUNT}:generation`,
        '5', 3,
      );
    });

    it('abandons a repair when a call mutates the generation during SCAN', async () => {
      const redis = createMockRedis({
        scan: vi.fn().mockResolvedValue(['0', ['lock:call-1']]),
        get: vi.fn()
          .mockResolvedValueOnce('7') // generation before SCAN
          .mockResolvedValueOnce('5'), // current counter after SCAN
        eval: vi.fn().mockResolvedValue(0),
      });
      const guard = new AccountConcurrencyGuard(redis, 'voiceai:', 300);

      await expect(guard.reconcile(TENANT, ACCOUNT)).resolves.toBe(false);
      expect(redis.eval).toHaveBeenCalledWith(
        expect.any(String), 2,
        `voiceai:active_calls:account:${TENANT}:${ACCOUNT}`,
        `voiceai:active_calls:account:${TENANT}:${ACCOUNT}:generation`,
        '7', 1,
      );
    });

    it('is a no-op without Redis', async () => {
      const guard = new AccountConcurrencyGuard(null, 'voiceai:', 300);
      // Should not throw
      await guard.reconcile(TENANT, ACCOUNT);
    });

    it('is a no-op in degraded mode', async () => {
      const redis = createMockRedis({
        eval: vi.fn().mockRejectedValue(new Error('timeout')),
        get: vi.fn().mockRejectedValue(new Error('timeout')),
      });
      const guard = new AccountConcurrencyGuard(redis, 'voiceai:', 300);

      // Force degraded mode
      await guard.tryAcquire('call-1', TENANT, ACCOUNT);
      expect(guard.isDegraded()).toBe(true);

      redis.scan.mockClear();
      await guard.reconcile(TENANT, ACCOUNT);
      expect(redis.scan).not.toHaveBeenCalled();
    });

    it('handles Redis errors gracefully without throwing', async () => {
      const redis = createMockRedis({
        scan: vi.fn().mockRejectedValue(new Error('connection lost')),
      });
      const guard = new AccountConcurrencyGuard(redis, 'voiceai:', 300);

      await expect(guard.reconcile(TENANT, ACCOUNT)).resolves.not.toThrow();
    });
  });

  describe('reconcileAll', () => {
    // Mock SCAN that serves lock keys for the lock pattern and counter keys for
    // the bare counter pattern (reconcileAll scans both).
    function scanByPattern(lockKeys: string[], counterKeys: string[]) {
      return vi.fn((_cursor: string, _match: string, pattern: string) => {
        const keys = pattern.endsWith(':lock:*') ? lockKeys : counterKeys;
        return Promise.resolve(['0', keys]);
      });
    }
    const counterKey = (t: string, a: string) => `voiceai:active_calls:account:${t}:${a}`;
    const lockKey = (t: string, a: string, c: string) => `${counterKey(t, a)}:lock:${c}`;
    const expectReconciled = (redis: ReturnType<typeof createMockRedis>, key: string, desired: number) => {
      expect(redis.eval).toHaveBeenCalledWith(
        expect.any(String), 2, key, `${key}:generation`, expect.any(String), desired,
      );
    };

    it('resets a drifted account counter to its live lock count', async () => {
      const redis = createMockRedis({
        scan: scanByPattern(
          [lockKey(TENANT, ACCOUNT, 'call-1'), lockKey(TENANT, ACCOUNT, 'call-2')],
          [counterKey(TENANT, ACCOUNT)],
        ),
        get: vi.fn().mockResolvedValue('5'), // counter stuck at 5, only 2 locks survive
      });
      const guard = new AccountConcurrencyGuard(redis, 'voiceai:', 300);

      const result = await guard.reconcileAll();

      expectReconciled(redis, counterKey(TENANT, ACCOUNT), 2);
      expect(result).toEqual({ accountsChecked: 1, accountsReconciled: 1 });
    });

    it('skips lock keys when collecting counter keys (the bare scan matches both)', async () => {
      // In real Redis the bare `active_calls:account:*` pattern ALSO matches lock
      // keys; reconcileAll must filter them out rather than treat them as counters.
      const redis = createMockRedis({
        scan: vi.fn((_c: string, _m: string, pattern: string) => {
          if (pattern.endsWith(':lock:*')) {
            return Promise.resolve(['0', [lockKey(TENANT, ACCOUNT, 'call-1')]]);
          }
          // bare counter scan returns the counter AND the lock key
          return Promise.resolve(['0', [counterKey(TENANT, ACCOUNT), lockKey(TENANT, ACCOUNT, 'call-1')]]);
        }),
        get: vi.fn().mockResolvedValue('1'), // counter matches the single lock
      });
      const guard = new AccountConcurrencyGuard(redis, 'voiceai:', 300);

      const result = await guard.reconcileAll();

      // Exactly one composite checked — the lock key was NOT mistaken for a counter.
      expect(result.accountsChecked).toBe(1);
      expect(redis.get).toHaveBeenCalledTimes(2);
      expect(redis.get).toHaveBeenCalledWith(`${counterKey(TENANT, ACCOUNT)}:generation`);
      expect(redis.get).toHaveBeenCalledWith(counterKey(TENANT, ACCOUNT));
      expect(result.accountsReconciled).toBe(0); // counter already matches
    });

    it('deletes a counter that drifted positive with zero surviving locks', async () => {
      const redis = createMockRedis({
        // No locks at all, but a counter key lingers at 3.
        scan: scanByPattern([], [counterKey(TENANT, ACCOUNT)]),
        get: vi.fn().mockResolvedValue('3'),
      });
      const guard = new AccountConcurrencyGuard(redis, 'voiceai:', 300);

      const result = await guard.reconcileAll();

      expectReconciled(redis, counterKey(TENANT, ACCOUNT), 0);
      expect(result.accountsReconciled).toBe(1);
    });

    it('heals multiple accounts in a single pass', async () => {
      const redis = createMockRedis({
        scan: scanByPattern(
          [lockKey('t1', 'a1', 'c1'), lockKey('t2', 'a2', 'c1'), lockKey('t2', 'a2', 'c2')],
          [counterKey('t1', 'a1'), counterKey('t2', 'a2')],
        ),
        get: vi.fn(async (key: string) => {
          if (key.endsWith(':generation')) return '0';
          return key === counterKey('t1', 'a1') ? '4' : '9';
        }),
      });
      const guard = new AccountConcurrencyGuard(redis, 'voiceai:', 300);

      const result = await guard.reconcileAll();

      expect(result.accountsChecked).toBe(2);
      expect(result.accountsReconciled).toBe(2);
      expectReconciled(redis, counterKey('t1', 'a1'), 1);
      expectReconciled(redis, counterKey('t2', 'a2'), 2);
    });

    it('is a no-op when every counter matches its lock count', async () => {
      const redis = createMockRedis({
        scan: scanByPattern(
          [lockKey(TENANT, ACCOUNT, 'call-1'), lockKey(TENANT, ACCOUNT, 'call-2')],
          [counterKey(TENANT, ACCOUNT)],
        ),
        get: vi.fn().mockResolvedValue('2'),
      });
      const guard = new AccountConcurrencyGuard(redis, 'voiceai:', 300);

      const result = await guard.reconcileAll();

      expect(redis.set).not.toHaveBeenCalled();
      expect(redis.del).not.toHaveBeenCalled();
      expect(result.accountsReconciled).toBe(0);
    });

    it('is a no-op without Redis', async () => {
      const guard = new AccountConcurrencyGuard(null, 'voiceai:', 300);
      const result = await guard.reconcileAll();
      expect(result).toEqual({ accountsChecked: 0, accountsReconciled: 0 });
    });

    it('handles Redis errors gracefully without throwing', async () => {
      const redis = createMockRedis({
        scan: vi.fn().mockRejectedValue(new Error('connection lost')),
      });
      const guard = new AccountConcurrencyGuard(redis, 'voiceai:', 300);

      await expect(guard.reconcileAll()).resolves.toEqual({ accountsChecked: 0, accountsReconciled: 0 });
    });

    it('sets the counter UP when it drifted below the live lock count', async () => {
      const redis = createMockRedis({
        scan: scanByPattern(
          [
            lockKey(TENANT, ACCOUNT, 'call-1'),
            lockKey(TENANT, ACCOUNT, 'call-2'),
            lockKey(TENANT, ACCOUNT, 'call-3'),
          ],
          [counterKey(TENANT, ACCOUNT)],
        ),
        get: vi.fn().mockResolvedValue('1'), // counter undercounts at 1, 3 locks survive
      });
      const guard = new AccountConcurrencyGuard(redis, 'voiceai:', 300);

      const result = await guard.reconcileAll();

      expectReconciled(redis, counterKey(TENANT, ACCOUNT), 3);
      expect(result).toEqual({ accountsChecked: 1, accountsReconciled: 1 });
    });

    it('exact match → no set/del, drift → set, zero-lock → del across mixed accounts', async () => {
      // a1 matches (no-op), a2 drifts high (set), a3 zero locks + lingering counter (del).
      const redis = createMockRedis({
        scan: scanByPattern(
          [lockKey('t', 'a1', 'c1'), lockKey('t', 'a1', 'c2'), lockKey('t', 'a2', 'c1')],
          [counterKey('t', 'a1'), counterKey('t', 'a2'), counterKey('t', 'a3')],
        ),
        get: vi.fn(async (key: string) => {
          if (key === counterKey('t', 'a1')) return '2'; // matches 2 locks
          if (key === counterKey('t', 'a2')) return '7'; // drifted high, 1 lock
          if (key === counterKey('t', 'a3')) return '4'; // zero locks lingering
          return null;
        }),
      });
      const guard = new AccountConcurrencyGuard(redis, 'voiceai:', 300);

      const result = await guard.reconcileAll();

      expect(result.accountsChecked).toBe(3);
      expect(result.accountsReconciled).toBe(2);
      expect(redis.eval).not.toHaveBeenCalledWith(
        expect.any(String), 2, counterKey('t', 'a1'), expect.anything(), expect.anything(), expect.anything(),
      );
      expectReconciled(redis, counterKey('t', 'a2'), 1);
      expectReconciled(redis, counterKey('t', 'a3'), 0);
    });

    it('sets the counter for an account that has locks but no counter key (get → null)', async () => {
      const redis = createMockRedis({
        // locks exist for the composite, but the bare counter scan returns nothing
        // (no counter key persisted) → get returns null → treated as current 0.
        scan: scanByPattern(
          [lockKey(TENANT, ACCOUNT, 'call-1'), lockKey(TENANT, ACCOUNT, 'call-2')],
          // The broad discovery scan sees the lock keys even though no bare
          // counter key exists.
          [lockKey(TENANT, ACCOUNT, 'call-1'), lockKey(TENANT, ACCOUNT, 'call-2')],
        ),
        get: vi.fn().mockResolvedValue(null),
      });
      const guard = new AccountConcurrencyGuard(redis, 'voiceai:', 300);

      const result = await guard.reconcileAll();

      // composite came from the lock scan, current=0, desired=2 → set up
      expectReconciled(redis, counterKey(TENANT, ACCOUNT), 2);
      expect(result).toEqual({ accountsChecked: 1, accountsReconciled: 1 });
    });

    it('aggregates across multi-page SCAN for BOTH the lock scan and the counter scan', async () => {
      // Each scan paginates: cursor != '0' then '0'. Lock pages span the same
      // account so all 3 locks aggregate; counter pages both resolve to the same
      // composite so it is checked once.
      const redis = createMockRedis({
        scan: vi.fn((cursor: string, _m: string, pattern: string) => {
          const isLock = pattern.endsWith(':lock:*');
          if (isLock) {
            return cursor === '0'
              ? Promise.resolve(['7', [lockKey(TENANT, ACCOUNT, 'call-1'), lockKey(TENANT, ACCOUNT, 'call-2')]])
              : Promise.resolve(['0', [lockKey(TENANT, ACCOUNT, 'call-3')]]);
          }
          // counter scan, also paginated
          return cursor === '0'
            ? Promise.resolve(['9', [counterKey(TENANT, ACCOUNT)]])
            : Promise.resolve(['0', [lockKey(TENANT, ACCOUNT, 'call-3')]]); // lock key mixed in 2nd page, filtered
        }),
        get: vi.fn().mockResolvedValue('5'), // counter says 5, 3 locks survive
      });
      const guard = new AccountConcurrencyGuard(redis, 'voiceai:', 300);

      const result = await guard.reconcileAll();

      // lock scan paged twice + counter scan paged twice = 4 scan calls
      expect(redis.scan).toHaveBeenCalledTimes(4);
      expect(result.accountsChecked).toBe(1);
      expectReconciled(redis, counterKey(TENANT, ACCOUNT), 3);
      expect(result.accountsReconciled).toBe(1);
    });

    it('parses multi-segment composite ids correctly (tenant t-1, account acct-x)', async () => {
      const redis = createMockRedis({
        scan: scanByPattern(
          [lockKey('t-1', 'acct-x', 'call-1')],
          [counterKey('t-1', 'acct-x')],
        ),
        get: vi.fn().mockResolvedValue('4'), // drifted high, 1 lock
      });
      const guard = new AccountConcurrencyGuard(redis, 'voiceai:', 300);

      const result = await guard.reconcileAll();

      expect(redis.get).toHaveBeenCalledWith(counterKey('t-1', 'acct-x'));
      expectReconciled(redis, counterKey('t-1', 'acct-x'), 1);
      expect(result).toEqual({ accountsChecked: 1, accountsReconciled: 1 });
    });

    it('strips a non-empty ioredis keyPrefix from scanned keys and re-applies the logical key to get/set/del', async () => {
      const counterPrefixed = (t: string, a: string) => `p:${counterKey(t, a)}`;
      const lockPrefixed = (t: string, a: string, c: string) => `p:${lockKey(t, a, c)}`;
      const redis = createMockRedis({
        options: { keyPrefix: 'p:' },
        scan: vi.fn((_c: string, _m: string, pattern: string) => {
          // scanned keys carry the ioredis prefix `p:` (scan is NOT auto-prefixed)
          const keys = pattern.endsWith(':lock:*')
            ? [lockPrefixed(TENANT, ACCOUNT, 'call-1')]
            : [counterPrefixed(TENANT, ACCOUNT)];
          return Promise.resolve(['0', keys]);
        }),
        get: vi.fn().mockResolvedValue('9'), // drifted high, 1 lock
      });
      const guard = new AccountConcurrencyGuard(redis, 'voiceai:', 300);

      const result = await guard.reconcileAll();

      // The SCAN MATCH pattern must carry the prefix.
      const scanPatterns = redis.scan.mock.calls.map((c: any[]) => c[2]);
      expect(scanPatterns.some((p: string) => p.startsWith('p:voiceai:active_calls:account:'))).toBe(true);
      // get/eval use the UN-prefixed logical key (ioredis re-applies the prefix itself).
      expect(redis.get).toHaveBeenCalledWith(counterKey(TENANT, ACCOUNT));
      expectReconciled(redis, counterKey(TENANT, ACCOUNT), 1);
      expect(result).toEqual({ accountsChecked: 1, accountsReconciled: 1 });
    });

    it('parses the composite correctly under a non-empty keyPrefix (zero-lock del path)', async () => {
      const counterPrefixed = (t: string, a: string) => `p:${counterKey(t, a)}`;
      const redis = createMockRedis({
        options: { keyPrefix: 'p:' },
        scan: vi.fn((_c: string, _m: string, pattern: string) => {
          const keys = pattern.endsWith(':lock:*') ? [] : [counterPrefixed(TENANT, ACCOUNT)];
          return Promise.resolve(['0', keys]);
        }),
        get: vi.fn().mockResolvedValue('3'), // lingering counter, no locks
      });
      const guard = new AccountConcurrencyGuard(redis, 'voiceai:', 300);

      const result = await guard.reconcileAll();

      expectReconciled(redis, counterKey(TENANT, ACCOUNT), 0);
      expect(result).toEqual({ accountsChecked: 1, accountsReconciled: 1 });
    });

    it('returns {0,0} and never scans in degraded mode', async () => {
      const redis = createMockRedis({
        eval: vi.fn().mockRejectedValue(new Error('timeout')),
        get: vi.fn().mockRejectedValue(new Error('timeout')),
      });
      const guard = new AccountConcurrencyGuard(redis, 'voiceai:', 300);

      // Force degraded mode via a failing acquire.
      await guard.tryAcquire('call-1', TENANT, ACCOUNT);
      expect(guard.isDegraded()).toBe(true);

      redis.scan.mockClear();
      const result = await guard.reconcileAll();

      expect(result).toEqual({ accountsChecked: 0, accountsReconciled: 0 });
      expect(redis.scan).not.toHaveBeenCalled();
    });

    it('returns {0,0} when scan throws and does not rethrow', async () => {
      const redis = createMockRedis({
        scan: vi.fn().mockRejectedValue(new Error('connection lost')),
      });
      const guard = new AccountConcurrencyGuard(redis, 'voiceai:', 300);

      let threw = false;
      const result = await guard.reconcileAll().catch(() => {
        threw = true;
        return { accountsChecked: -1, accountsReconciled: -1 };
      });

      expect(threw).toBe(false);
      expect(result).toEqual({ accountsChecked: 0, accountsReconciled: 0 });
    });

    it('returns {0,0} when get throws mid-loop without an unhandled rejection', async () => {
      const redis = createMockRedis({
        scan: scanByPattern(
          [lockKey(TENANT, ACCOUNT, 'call-1')],
          [counterKey(TENANT, ACCOUNT)],
        ),
        get: vi.fn().mockRejectedValue(new Error('get failed')),
      });
      const guard = new AccountConcurrencyGuard(redis, 'voiceai:', 300);

      let threw = false;
      const result = await guard.reconcileAll().catch(() => {
        threw = true;
        return { accountsChecked: -1, accountsReconciled: -1 };
      });

      expect(threw).toBe(false);
      // The catch block in reconcileAll swallows the get error and returns {0,0}.
      expect(result).toEqual({ accountsChecked: 0, accountsReconciled: 0 });
      expect(redis.set).not.toHaveBeenCalled();
      expect(redis.del).not.toHaveBeenCalled();
    });

    it('returns {0,0} with no set/del on an empty keyspace (both scans return [])', async () => {
      const redis = createMockRedis({
        scan: scanByPattern([], []),
        get: vi.fn().mockResolvedValue(null),
      });
      const guard = new AccountConcurrencyGuard(redis, 'voiceai:', 300);

      const result = await guard.reconcileAll();

      expect(result).toEqual({ accountsChecked: 0, accountsReconciled: 0 });
      expect(redis.get).not.toHaveBeenCalled();
      expect(redis.set).not.toHaveBeenCalled();
      expect(redis.del).not.toHaveBeenCalled();
    });
  });

  describe('Redis failure fallback', () => {
    it('falls back to local mode on Redis eval error during acquire', async () => {
      const redis = createMockRedis({
        eval: vi.fn().mockRejectedValue(new Error('connection refused')),
        get: vi.fn().mockRejectedValue(new Error('connection refused')),
      });
      const guard = new AccountConcurrencyGuard(redis, 'voiceai:', 300);

      const result = await guard.tryAcquire('call-1', TENANT, ACCOUNT);

      expect(result).toBe(true);
      expect(guard.isDegraded()).toBe(true);
    });

    it('stays in degraded mode after first Redis failure', async () => {
      const redis = createMockRedis({
        eval: vi.fn().mockRejectedValueOnce(new Error('timeout')),
        get: vi.fn().mockRejectedValue(new Error('timeout')),
      });
      const guard = new AccountConcurrencyGuard(redis, 'voiceai:', 300);

      await guard.tryAcquire('call-1', TENANT, ACCOUNT);
      expect(guard.isDegraded()).toBe(true);

      const result = await guard.tryAcquire('call-2', TENANT, ACCOUNT);
      expect(result).toBe(true);
      // eval was only called once (the failed attempt)
      expect(redis.eval).toHaveBeenCalledTimes(1);
    });

    it('falls back to local mode on Redis eval error during release', async () => {
      const redis = createMockRedis({
        eval: vi.fn()
          .mockResolvedValueOnce(1)                           // acquire succeeds
          .mockRejectedValueOnce(new Error('connection refused')), // release fails
      });
      const guard = new AccountConcurrencyGuard(redis, 'voiceai:', 300);

      await guard.tryAcquire('call-1', TENANT, ACCOUNT);
      await guard.release('call-1', TENANT, ACCOUNT);
      // No throw expected — falls back to local release
    });

    it('uses default limit when DB query fails', async () => {
      const redis = createMockRedis();
      const guard = new AccountConcurrencyGuard(redis, 'voiceai:', 300);

      mocks.getMaxConcurrentCalls.mockRejectedValue(new Error('DB down'));
      redis.eval.mockResolvedValue(1);

      // Default limit is aligned with the platform default (5).
      const result = await guard.tryAcquire('call-1', TENANT, ACCOUNT);
      expect(result).toBe(true);
      expect(redis.eval.mock.calls[0]![5]).toBe(5);
    });
  });

  describe('without Redis (null)', () => {
    let guard: AccountConcurrencyGuard;

    beforeEach(() => {
      mocks.getMaxConcurrentCalls.mockResolvedValue(3);
      guard = new AccountConcurrencyGuard(null, 'voiceai:', 300);
    });

    it('uses local counter with DB-sourced limit', async () => {
      expect(await guard.tryAcquire('call-1', TENANT, ACCOUNT)).toBe(true);
      expect(await guard.tryAcquire('call-2', TENANT, ACCOUNT)).toBe(true);
      expect(await guard.tryAcquire('call-3', TENANT, ACCOUNT)).toBe(true);
      expect(await guard.tryAcquire('call-4', TENANT, ACCOUNT)).toBe(false);
    });

    it('release decrements local counter', async () => {
      await guard.tryAcquire('call-1', TENANT, ACCOUNT);
      await guard.tryAcquire('call-2', TENANT, ACCOUNT);
      await guard.tryAcquire('call-3', TENANT, ACCOUNT);

      await guard.release('call-3', TENANT, ACCOUNT);
      expect(await guard.tryAcquire('call-4', TENANT, ACCOUNT)).toBe(true);
    });

    it('release does not go below zero', async () => {
      await guard.release('nonexistent', TENANT, ACCOUNT);
      const count = await guard.getAccountCount(TENANT, ACCOUNT);
      expect(count).toBe(0);
    });

    it('tracks accounts independently', async () => {
      mocks.getMaxConcurrentCalls.mockResolvedValue(2);

      expect(await guard.tryAcquire('call-1', TENANT, 'account-a')).toBe(true);
      expect(await guard.tryAcquire('call-2', TENANT, 'account-a')).toBe(true);
      expect(await guard.tryAcquire('call-3', TENANT, 'account-a')).toBe(false);

      // Different account should have its own counter
      expect(await guard.tryAcquire('call-4', TENANT, 'account-b')).toBe(true);
    });

    it('getAccountCount returns local count', async () => {
      await guard.tryAcquire('call-1', TENANT, ACCOUNT);
      await guard.tryAcquire('call-2', TENANT, ACCOUNT);
      expect(await guard.getAccountCount(TENANT, ACCOUNT)).toBe(2);
    });
  });

  // The local fallback tracks leases BY CALL ID per account, not as a bare
  // per-account counter, so a release is ownership-checked. An unkeyed
  // decrement let a duplicate terminal webhook for call A free a slot still
  // held by a live call B on the same account — over-admission past the
  // account limit.
  describe('local lease ownership (over-admission guard)', () => {
    let guard: AccountConcurrencyGuard;

    beforeEach(() => {
      mocks.getMaxConcurrentCalls.mockResolvedValue(2);
      guard = new AccountConcurrencyGuard(null, 'voiceai:', 300);
    });

    it('duplicate release for the same call does not free another live call\'s slot', async () => {
      expect(await guard.tryAcquire('call-a', TENANT, ACCOUNT)).toBe(true);
      expect(await guard.tryAcquire('call-b', TENANT, ACCOUNT)).toBe(true);
      expect(await guard.getAccountCount(TENANT, ACCOUNT)).toBe(2);

      // Duplicate terminal carrier webhook for call-a.
      await guard.release('call-a', TENANT, ACCOUNT);
      await guard.release('call-a', TENANT, ACCOUNT);

      expect(await guard.getAccountCount(TENANT, ACCOUNT)).toBe(1);
      expect(await guard.tryAcquire('call-c', TENANT, ACCOUNT)).toBe(true);
      expect(await guard.tryAcquire('call-d', TENANT, ACCOUNT)).toBe(false);
    });

    it('releasing a call id that never acquired a slot is a no-op', async () => {
      expect(await guard.tryAcquire('call-a', TENANT, ACCOUNT)).toBe(true);
      expect(await guard.tryAcquire('call-b', TENANT, ACCOUNT)).toBe(true);

      await guard.release('call-from-other-replica', TENANT, ACCOUNT);
      await guard.release('never-acquired', TENANT, ACCOUNT);

      expect(await guard.getAccountCount(TENANT, ACCOUNT)).toBe(2);
      expect(await guard.tryAcquire('call-c', TENANT, ACCOUNT)).toBe(false);
    });

    it('releasing a live call id against the WRONG account does not free that account\'s slot', async () => {
      expect(await guard.tryAcquire('call-a', TENANT, 'account-a')).toBe(true);
      expect(await guard.tryAcquire('call-b', TENANT, 'account-b')).toBe(true);

      // Wrong-account release: the id is live, but not on account-b.
      await guard.release('call-a', TENANT, 'account-b');

      expect(await guard.getAccountCount(TENANT, 'account-a')).toBe(1);
      expect(await guard.getAccountCount(TENANT, 'account-b')).toBe(1);
    });

    it('keeps accounts independent across duplicate releases', async () => {
      expect(await guard.tryAcquire('call-a1', TENANT, 'account-a')).toBe(true);
      expect(await guard.tryAcquire('call-a2', TENANT, 'account-a')).toBe(true);
      expect(await guard.tryAcquire('call-b1', TENANT, 'account-b')).toBe(true);
      expect(await guard.tryAcquire('call-b2', TENANT, 'account-b')).toBe(true);

      await guard.release('call-a1', TENANT, 'account-a');
      await guard.release('call-a1', TENANT, 'account-a');

      expect(await guard.getAccountCount(TENANT, 'account-a')).toBe(1);
      expect(await guard.getAccountCount(TENANT, 'account-b')).toBe(2);
      expect(await guard.tryAcquire('call-a3', TENANT, 'account-a')).toBe(true);
      expect(await guard.tryAcquire('call-a4', TENANT, 'account-a')).toBe(false);
      expect(await guard.tryAcquire('call-b3', TENANT, 'account-b')).toBe(false);
    });

    it('re-acquiring an already-held call id is idempotent and consumes no extra slot', async () => {
      expect(await guard.tryAcquire('call-a', TENANT, ACCOUNT)).toBe(true);
      expect(await guard.tryAcquire('call-a', TENANT, ACCOUNT)).toBe(true);
      expect(await guard.getAccountCount(TENANT, ACCOUNT)).toBe(1);
      expect(await guard.tryAcquire('call-b', TENANT, ACCOUNT)).toBe(true);
      expect(await guard.tryAcquire('call-c', TENANT, ACCOUNT)).toBe(false);
    });

    it('releasing the last lease frees the per-account entry without changing observable counts', async () => {
      expect(await guard.tryAcquire('call-a', TENANT, ACCOUNT)).toBe(true);
      await guard.release('call-a', TENANT, ACCOUNT);

      expect(await guard.getAccountCount(TENANT, ACCOUNT)).toBe(0);
      // Reusable afterwards — the emptied set is recreated on demand.
      expect(await guard.tryAcquire('call-b', TENANT, ACCOUNT)).toBe(true);
      expect(await guard.getAccountCount(TENANT, ACCOUNT)).toBe(1);
    });

    it('applies the same ownership check after degradedMode latches mid-flight', async () => {
      const redis = createMockRedis({
        eval: vi.fn().mockRejectedValue(new Error('connection refused')),
      });
      const degraded = new AccountConcurrencyGuard(redis, 'voiceai:', 300);

      expect(await degraded.tryAcquire('call-a', TENANT, ACCOUNT)).toBe(true);
      expect(degraded.isDegraded()).toBe(true);
      expect(await degraded.tryAcquire('call-b', TENANT, ACCOUNT)).toBe(true);

      await degraded.release('call-a', TENANT, ACCOUNT);
      await degraded.release('call-a', TENANT, ACCOUNT);

      expect(await degraded.getAccountCount(TENANT, ACCOUNT)).toBe(1);
      expect(await degraded.tryAcquire('call-c', TENANT, ACCOUNT)).toBe(true);
      expect(await degraded.tryAcquire('call-d', TENANT, ACCOUNT)).toBe(false);
    });
  });
});
