import type Redis from 'ioredis';
import { logger, Traced } from '@magick-agency/observability';
// PORT NOTE (magick-agency): ported from core src/core/concurrency-guard.ts@4850d1d9;
// only the logger/Traced import specifiers changed (now @magick-agency/observability).

/**
 * Lua script: atomically INCR counter, check limit, SET lock — or DECR on rejection.
 * KEYS[1] = counterKey, KEYS[2] = lockKey, KEYS[3] = generationKey
 * ARGV[1] = maxConcurrent, ARGV[2] = lockTtlSeconds
 * Returns 1 if acquired, 0 if limit reached.
 */
const ACQUIRE_SCRIPT = `
if redis.call('EXISTS', KEYS[2]) == 1 then return 2 end
local current = redis.call('INCR', KEYS[1])
if current > tonumber(ARGV[1]) then
  redis.call('DECR', KEYS[1])
  return 0
end
redis.call('SET', KEYS[2], '1', 'EX', tonumber(ARGV[2]))
redis.call('INCR', KEYS[3])
return 1
`;

/**
 * Lua script: atomically DEL lock, DECR counter if lock existed, floor at 0.
 * KEYS[1] = lockKey, KEYS[2] = counterKey, KEYS[3] = generationKey
 * Returns 1 if lock existed, 0 otherwise.
 */
const RELEASE_SCRIPT = `
local existed = redis.call('DEL', KEYS[1])
if existed == 1 then
  local val = redis.call('DECR', KEYS[2])
  if val < 0 then redis.call('SET', KEYS[2], '0') end
  redis.call('INCR', KEYS[3])
end
return existed
`;

const RECONCILE_SCRIPT = `
if (redis.call('GET', KEYS[2]) or '0') ~= ARGV[1] then return 0 end
if tonumber(ARGV[2]) == 0 then redis.call('DEL', KEYS[1])
else redis.call('SET', KEYS[1], ARGV[2]) end
return 1
`;

export class ConcurrencyGuard {
  private readonly counterKey: string;
  private readonly maxConcurrent: number;
  private readonly lockTtlSeconds: number;
  private redis: Redis | null = null;
  /**
   * Degraded-mode fallback: the set of call ids holding a process-local slot.
   *
   * Deliberately a keyed set rather than a bare counter. An unkeyed
   * `localCount--` release is not ownership-checked, so a duplicate terminal
   * webhook for call A, a release for a call acquired on a *different* replica,
   * or a release for a `queued` row that never acquired a slot would each
   * decrement a slot belonging to some *other* live call — letting this replica
   * admit past its own limit. Keying by call id makes local release idempotent
   * and ownership-checked, mirroring the Redis path (whose `DEL` is key-gated
   * and returns 0 for a lease it never held).
   *
   * Memory is bounded by `maxConcurrent`: `tryAcquireLocal` refuses once
   * `size >= maxConcurrent`, so a degraded replica whose calls never release
   * accumulates at most `maxConcurrent` ids (the same ceiling the counter
   * enforced), not one per call ever seen.
   */
  private readonly localLeases = new Set<string>();
  private degradedMode = false;

  constructor(
    redis: Redis | null,
    keyPrefix: string,
    maxConcurrent: number,
    callTimeoutSeconds: number
  ) {
    this.redis = redis;
    this.counterKey = `${keyPrefix}active_calls`;
    this.maxConcurrent = maxConcurrent;
    this.lockTtlSeconds = callTimeoutSeconds + 30;
  }

  @Traced('concurrency.global.try_acquire', {
    attrs: (callId: string) => ({ 'call.id': callId }),
  })
  async tryAcquire(callId: string, ttlSecondsOverride?: number): Promise<boolean> {
    if (this.degradedMode || !this.redis) {
      return this.tryAcquireLocal(callId);
    }

    try {
      const lockKey = `${this.counterKey}:lock:${callId}`;
      // Longer-running call types (e.g. WebRTC bridges) override the default lock
      // TTL so the lock outlives the call — otherwise it expires mid-call and the
      // release can't decrement the counter (permanent +1 drift).
      const lockTtl = ttlSecondsOverride && ttlSecondsOverride > 0 ? ttlSecondsOverride : this.lockTtlSeconds;
      const result = await this.redis.eval(
        ACQUIRE_SCRIPT, 3, this.counterKey, lockKey, `${this.counterKey}:generation`, this.maxConcurrent, lockTtl
      );
      return result === 1 || result === 2;
    } catch (err) {
      logger.warn({ err }, 'Redis unavailable for concurrency check, falling back to local');
      this.degradedMode = true;
      return this.tryAcquireLocal(callId);
    }
  }


  /**
   * Extend an already-held slot lock.
   *
   * A call's lock TTL is sized at acquire time from the ordinary call timeout,
   * on the assumption the call ends within it. A call transferred to a human
   * breaks that assumption: it can legitimately run for hours, and when its lock
   * expires the self-heal reconcile sees counter > locks and decrements the
   * counter while the conversation is still live — silently freeing capacity the
   * call is still using, and leaving the eventual release with nothing to
   * decrement.
   *
   * Only refreshes a lock that still exists (`EXPIRE ... XX` semantics via a
   * bare EXISTS check): re-creating an expired lock would double-count against a
   * counter reconcile has already corrected.
   */
  async extendLock(callId: string, ttlSeconds: number): Promise<boolean> {
    if (this.degradedMode || !this.redis || ttlSeconds <= 0) return false;
    try {
      const lockKey = `${this.counterKey}:lock:${callId}`;
      // `expire key ttl XX` only sets a TTL on a key that already has one.
      const result = await this.redis.expire(lockKey, Math.floor(ttlSeconds), 'XX');
      return result === 1;
    } catch (err) {
      logger.warn({ err, callId }, 'Failed to extend global concurrency lock');
      return false;
    }
  }

  @Traced('concurrency.global.release', {
    attrs: (callId: string) => ({ 'call.id': callId }),
  })
  async release(callId: string): Promise<void> {
    if (this.degradedMode || !this.redis) {
      this.releaseLocal(callId);
      return;
    }

    try {
      const lockKey = `${this.counterKey}:lock:${callId}`;
      await this.redis.eval(RELEASE_SCRIPT, 3, lockKey, this.counterKey, `${this.counterKey}:generation`);
    } catch (err) {
      logger.warn({ err }, 'Redis unavailable for concurrency release');
      this.releaseLocal(callId);
    }
  }

  async getCurrentCount(): Promise<number> {
    if (this.degradedMode || !this.redis) {
      return this.localLeases.size;
    }

    try {
      const val = await this.redis.get(this.counterKey);
      return val ? parseInt(val, 10) : 0;
    } catch {
      return this.localLeases.size;
    }
  }

  isDegraded(): boolean {
    return this.degradedMode;
  }

  /**
   * Reconcile the global counter by counting actual lock keys.
   * Heals drift caused by process crashes where locks expired
   * but the counter was never decremented.
   */
  async reconcile(): Promise<{ before: number; after: number }> {
    if (!this.redis || this.degradedMode) {
      return { before: this.localLeases.size, after: this.localLeases.size };
    }

    try {
      const ioredisPrefix = (this.redis.options?.keyPrefix as string) ?? '';
      const pattern = ioredisPrefix + `${this.counterKey}:lock:*`;
      const generationKey = `${this.counterKey}:generation`;
      // Snapshot before scanning. Any acquire/release during the non-atomic
      // SCAN increments this key and makes the final CAS a no-op.
      const generation = (await this.redis.get(generationKey)) ?? '0';
      let lockCount = 0;
      let cursor = '0';
      do {
        const [nextCursor, keys] = await this.redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
        cursor = nextCursor;
        lockCount += keys.length;
      } while (cursor !== '0');

      const currentStr = await this.redis.get(this.counterKey);
      const before = currentStr ? parseInt(currentStr, 10) : 0;
      if (before !== lockCount) {
        logger.warn(
          { counter: before, locks: lockCount },
          'Global concurrency counter drifted — reconciling'
        );
        const repaired = await this.redis.eval(
          RECONCILE_SCRIPT, 2, this.counterKey, generationKey, generation, lockCount,
        );
        if (repaired !== 1) return { before, after: before };
      }
      return { before, after: lockCount };
    } catch (err) {
      logger.warn({ err }, 'Failed to reconcile global concurrency counter');
      const current = await this.getCurrentCount();
      return { before: current, after: current };
    }
  }

  private tryAcquireLocal(callId: string): boolean {
    // Re-acquire of a lease this replica already holds is idempotent (parity
    // with the Redis script's `EXISTS lock -> return 2`).
    if (this.localLeases.has(callId)) return true;
    if (this.localLeases.size >= this.maxConcurrent) return false;
    this.localLeases.add(callId);
    return true;
  }

  /**
   * Ownership-checked and idempotent: releasing a call id this replica never
   * acquired (duplicate webhook, lease taken on another replica, a `queued` row
   * that never got a slot) is a no-op rather than a decrement that would steal
   * another live call's slot.
   */
  private releaseLocal(callId: string): void {
    this.localLeases.delete(callId);
  }
}
