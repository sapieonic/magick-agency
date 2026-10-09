import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock logger
// The guards import `Traced` from the same package as `logger`, so the factory
// forwards the real tracing decorator.
vi.mock('@magick-agency/observability', async () => ({
  Traced: (await import('@magick-agency/observability/tracing')).Traced,
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
  createChildLogger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { ConcurrencyGuard } from '../../../src/core/concurrency-guard.js';

function createMockRedis(overrides: Record<string, unknown> = {}) {
  return {
    incr: vi.fn().mockResolvedValue(1),
    decr: vi.fn().mockResolvedValue(0),
    set: vi.fn().mockResolvedValue('OK'),
    del: vi.fn().mockResolvedValue(1),
    get: vi.fn().mockResolvedValue('0'),
    eval: vi.fn().mockResolvedValue(1),
    scan: vi.fn().mockResolvedValue(['0', []]),
    options: {},
    ...overrides,
  } as any;
}

describe('ConcurrencyGuard', () => {
  describe('with Redis', () => {
    let redis: ReturnType<typeof createMockRedis>;
    let guard: ConcurrencyGuard;

    beforeEach(() => {
      redis = createMockRedis();
      guard = new ConcurrencyGuard(redis, 'voiceai:', 5, 300);
    });

    it('acquires via atomic Lua script when under limit', async () => {
      redis.eval.mockResolvedValue(1);
      const result = await guard.tryAcquire('call-1');

      expect(result).toBe(true);
      expect(redis.eval).toHaveBeenCalledOnce();
      const args = redis.eval.mock.calls[0]!;
      expect(args[1]).toBe(3); // counter, call lock, generation fence
      expect(args[2]).toBe('voiceai:active_calls'); // counterKey
      expect(args[3]).toBe('voiceai:active_calls:lock:call-1'); // lockKey
      expect(args[4]).toBe('voiceai:active_calls:generation');
      expect(args[5]).toBe(5); // maxConcurrent
      expect(args[6]).toBe(330); // ttl = 300 + 30
    });

    it('rejects when Lua script returns 0 (limit exceeded)', async () => {
      redis.eval.mockResolvedValue(0);
      const result = await guard.tryAcquire('call-1');

      expect(result).toBe(false);
      // No separate INCR/DECR — all inside Lua
      expect(redis.incr).not.toHaveBeenCalled();
      expect(redis.decr).not.toHaveBeenCalled();
    });

    it('honors ttlSecondsOverride as the lock TTL (ARGV[2]) instead of the default', async () => {
      redis.eval.mockResolvedValue(1);
      await guard.tryAcquire('call-1', 1860);
      expect(redis.eval.mock.calls[0]![6]).toBe(1860);
    });

    it('falls back to the default lock TTL when the override is omitted or non-positive', async () => {
      redis.eval.mockResolvedValue(1);
      await guard.tryAcquire('call-1');
      expect(redis.eval.mock.calls[0]![6]).toBe(330); // 300 + 30

      redis.eval.mockClear();
      await guard.tryAcquire('call-2', 0);
      expect(redis.eval.mock.calls[0]![6]).toBe(330);
    });

    it('acquires at exactly the limit', async () => {
      redis.eval.mockResolvedValue(1);
      const result = await guard.tryAcquire('call-1');
      expect(result).toBe(true);
    });

    it('releases via atomic Lua script', async () => {
      redis.eval.mockResolvedValue(1); // lock existed
      await guard.release('call-1');

      expect(redis.eval).toHaveBeenCalledOnce();
      const args = redis.eval.mock.calls[0]!;
      expect(args[1]).toBe(3); // lock, counter, generation fence
      // Release script: KEYS[1] = lockKey, KEYS[2] = counterKey
      expect(args[2]).toBe('voiceai:active_calls:lock:call-1');
      expect(args[3]).toBe('voiceai:active_calls');
      expect(args[4]).toBe('voiceai:active_calls:generation');
    });

    it('release handles non-existent lock gracefully', async () => {
      redis.eval.mockResolvedValue(0); // lock did not exist
      await guard.release('call-1');

      expect(redis.eval).toHaveBeenCalledOnce();
      expect(redis.decr).not.toHaveBeenCalled();
    });

    it('acquire does not make separate INCR/SET calls', async () => {
      redis.eval.mockResolvedValue(1);
      await guard.tryAcquire('call-1');

      expect(redis.incr).not.toHaveBeenCalled();
      // redis.set is NOT called for lock — it's inside eval
      expect(redis.set).not.toHaveBeenCalled();
    });

    it('release does not make separate DEL/DECR calls', async () => {
      await guard.release('call-1');

      expect(redis.del).not.toHaveBeenCalled();
      expect(redis.decr).not.toHaveBeenCalled();
    });

    it('release script contains floor-at-zero logic', async () => {
      await guard.release('call-1');

      const script = redis.eval.mock.calls[0]![0] as string;
      expect(script).toContain('val < 0');
    });

    it('getCurrentCount returns Redis value', async () => {
      redis.get.mockResolvedValue('7');
      const count = await guard.getCurrentCount();
      expect(count).toBe(7);
    });

    it('getCurrentCount returns 0 when key missing', async () => {
      redis.get.mockResolvedValue(null);
      const count = await guard.getCurrentCount();
      expect(count).toBe(0);
    });

    it('does not apply a reconciliation repair when admission changes the generation', async () => {
      redis.scan.mockResolvedValue(['0', ['voiceai:active_calls:lock:call-1']]);
      redis.get
        .mockResolvedValueOnce('7') // generation sampled before SCAN
        .mockResolvedValueOnce('5'); // drifted counter
      redis.eval.mockResolvedValue(0); // CAS observes a newer generation

      await expect(guard.reconcile()).resolves.toEqual({ before: 5, after: 5 });
      expect(redis.eval).toHaveBeenCalledWith(
        expect.any(String), 2, 'voiceai:active_calls', 'voiceai:active_calls:generation', '7', 1,
      );
    });

    it('is not degraded initially', () => {
      expect(guard.isDegraded()).toBe(false);
    });
  });

  describe('Redis failure fallback', () => {
    it('falls back to local mode on Redis eval error during acquire', async () => {
      const redis = createMockRedis({
        eval: vi.fn().mockRejectedValue(new Error('connection refused')),
      });
      const guard = new ConcurrencyGuard(redis, 'voiceai:', 5, 300);

      const result = await guard.tryAcquire('call-1');

      expect(result).toBe(true);
      expect(guard.isDegraded()).toBe(true);
    });

    it('stays in degraded mode after first Redis failure', async () => {
      const redis = createMockRedis({
        eval: vi.fn().mockRejectedValueOnce(new Error('timeout')),
      });
      const guard = new ConcurrencyGuard(redis, 'voiceai:', 5, 300);

      await guard.tryAcquire('call-1');
      expect(guard.isDegraded()).toBe(true);

      const result = await guard.tryAcquire('call-2');
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
      const guard = new ConcurrencyGuard(redis, 'voiceai:', 5, 300);

      await guard.tryAcquire('call-1');
      await guard.release('call-1');
      // No throw expected — falls back to local release
    });
  });

  describe('without Redis (null)', () => {
    let guard: ConcurrencyGuard;

    beforeEach(() => {
      guard = new ConcurrencyGuard(null, 'voiceai:', 3, 300);
    });

    it('uses local counter', async () => {
      expect(await guard.tryAcquire('call-1')).toBe(true);
      expect(await guard.tryAcquire('call-2')).toBe(true);
      expect(await guard.tryAcquire('call-3')).toBe(true);
      expect(await guard.tryAcquire('call-4')).toBe(false); // over limit
    });

    it('release decrements local counter', async () => {
      await guard.tryAcquire('call-1');
      await guard.tryAcquire('call-2');
      await guard.tryAcquire('call-3');

      await guard.release('call-3');
      expect(await guard.tryAcquire('call-4')).toBe(true);
    });

    it('release does not go below zero', async () => {
      await guard.release('nonexistent');
      const count = await guard.getCurrentCount();
      expect(count).toBe(0);
    });

    it('getCurrentCount returns local count', async () => {
      await guard.tryAcquire('call-1');
      await guard.tryAcquire('call-2');
      expect(await guard.getCurrentCount()).toBe(2);
    });
  });

  // The local fallback tracks leases BY CALL ID, not as a bare counter, so a
  // release is ownership-checked. An unkeyed decrement let a duplicate terminal
  // webhook for call A free a slot still held by a live call B, and this
  // replica could then admit past its own limit.
  describe('local lease ownership (over-admission guard)', () => {
    let guard: ConcurrencyGuard;

    beforeEach(() => {
      guard = new ConcurrencyGuard(null, 'voiceai:', 2, 300);
    });

    it('duplicate release for the same call does not free another live call\'s slot', async () => {
      expect(await guard.tryAcquire('call-a')).toBe(true);
      expect(await guard.tryAcquire('call-b')).toBe(true);
      expect(await guard.getCurrentCount()).toBe(2);

      // Duplicate terminal carrier webhook for call-a.
      await guard.release('call-a');
      await guard.release('call-a');

      // call-b still holds its slot: exactly one slot is free.
      expect(await guard.getCurrentCount()).toBe(1);
      expect(await guard.tryAcquire('call-c')).toBe(true);
      expect(await guard.tryAcquire('call-d')).toBe(false);
      expect(await guard.getCurrentCount()).toBe(2);
    });

    it('releasing a call id that never acquired a slot is a no-op', async () => {
      expect(await guard.tryAcquire('call-a')).toBe(true);
      expect(await guard.tryAcquire('call-b')).toBe(true);

      // Lease taken on a different replica / a `queued` row that never acquired.
      await guard.release('call-from-other-replica');
      await guard.release('never-acquired');

      expect(await guard.getCurrentCount()).toBe(2);
      expect(await guard.tryAcquire('call-c')).toBe(false);
    });

    it('re-acquiring an already-held call id is idempotent and consumes no extra slot', async () => {
      expect(await guard.tryAcquire('call-a')).toBe(true);
      expect(await guard.tryAcquire('call-a')).toBe(true);
      expect(await guard.getCurrentCount()).toBe(1);
      expect(await guard.tryAcquire('call-b')).toBe(true);
      expect(await guard.tryAcquire('call-c')).toBe(false);
    });

    it('applies the same ownership check after degradedMode latches mid-flight', async () => {
      const redis = createMockRedis({
        eval: vi.fn().mockRejectedValue(new Error('connection refused')),
      });
      const degraded = new ConcurrencyGuard(redis, 'voiceai:', 2, 300);

      expect(await degraded.tryAcquire('call-a')).toBe(true);
      expect(degraded.isDegraded()).toBe(true);
      expect(await degraded.tryAcquire('call-b')).toBe(true);

      await degraded.release('call-a');
      await degraded.release('call-a');

      expect(await degraded.getCurrentCount()).toBe(1);
      expect(await degraded.tryAcquire('call-c')).toBe(true);
      expect(await degraded.tryAcquire('call-d')).toBe(false);
    });
  });
});
