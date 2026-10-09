import type Redis from 'ioredis';
import { logger, Traced } from '@magick-agency/observability';
import { accountSettingsRepository } from '@magick-agency/db/repositories/account-settings.repository';
// PORT NOTE (magick-agency): ported from core src/core/account-concurrency-guard.ts@4850d1d9.
// Changed: import specifiers; the per-broadcast group-concurrency gate is stripped
// (agency has no per-broadcast bulk concurrency): the `GroupLeaseHooks` import,
// `setGroupLeaseHooks`, the `groupLeaseHooks` field, `releaseGroupLease`, and the
// group-release calls inside `release`. `release` is therefore restored to its
// pre-gate shape (core d1179938^), which behaves identically to the 4850d1d9 body with
// no hooks wired. Lua, keys, TTLs, degraded mode and everything else are verbatim.

const DEFAULT_MAX_CONCURRENT_CALLS = 5;
const LIMIT_CACHE_TTL_SECONDS = 60;

/**
 * Lua script: atomically INCR counter, check limit, SET lock — or DECR on rejection.
 * KEYS[1] = counterKey, KEYS[2] = lockKey, KEYS[3] = generationKey
 * ARGV[1] = limit, ARGV[2] = lockTtlSeconds
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

export class AccountConcurrencyGuard {
  private readonly keyPrefix: string;
  private readonly lockTtlSeconds: number;
  private redis: Redis | null = null;
  private degradedMode = false;
  /**
   * Degraded-mode fallback: per-account sets of the call ids holding a
   * process-local slot, keyed by "tenantId:accountId".
   *
   * Deliberately keyed sets rather than bare counters. An unkeyed decrement is
   * not ownership-checked, so a duplicate terminal webhook for call A, a
   * release for a call acquired on a *different* replica, or a release for a
   * `queued` row that never acquired a slot would each decrement a slot
   * belonging to some *other* live call on that account — letting this replica
   * admit past the account limit. Keying by call id makes local release
   * idempotent and ownership-checked, mirroring the Redis path (whose `DEL` is
   * key-gated and returns 0 for a lease it never held).
   *
   * Each set is bounded by that account's resolved limit (`tryAcquireLocal`
   * refuses at the limit). The map itself is bounded by the number of accounts
   * this replica has dialled for while degraded, so `releaseLocal` deletes an
   * emptied set rather than leaving a 0-sized entry behind: without that, a
   * long-degraded replica serving many short-lived accounts would retain one
   * map entry per account forever, and `reconcileAll`-style callers would see
   * phantom scopes. An absent entry and an empty set already mean the same
   * thing (count 0), so deleting loses no information.
   */
  private readonly localLeases = new Map<string, Set<string>>();
  /** Fallback: local limit cache keyed by "tenantId:accountId" */
  private localLimitCache = new Map<string, { limit: number; expiresAt: number }>();

  constructor(redis: Redis | null, keyPrefix: string, callTimeoutSeconds: number) {
    this.redis = redis;
    this.keyPrefix = keyPrefix;
    this.lockTtlSeconds = callTimeoutSeconds + 30;
  }

  @Traced('concurrency.account.try_acquire', {
    attrs: (callId: string, tenantId: string, accountId: string) => ({
      'call.id': callId,
      'tenant.id': tenantId,
      'account.id': accountId,
    }),
  })
  async tryAcquire(
    callId: string, tenantId: string, accountId: string, ttlSecondsOverride?: number,
  ): Promise<boolean> {
    const limit = await this.resolveLimit(tenantId, accountId);

    if (this.degradedMode || !this.redis) {
      return this.tryAcquireLocal(tenantId, accountId, limit, callId);
    }

    try {
      const counterKey = this.accountCounterKey(tenantId, accountId);
      const lockKey = this.accountLockKey(tenantId, accountId, callId);

      // Longer-running call types (e.g. WebRTC bridges) override the default lock
      // TTL so the lock outlives the call — otherwise it expires mid-call and the
      // release can't decrement the counter (permanent +1 drift).
      const lockTtl = ttlSecondsOverride && ttlSecondsOverride > 0 ? ttlSecondsOverride : this.lockTtlSeconds;
      const result = await this.redis.eval(
        ACQUIRE_SCRIPT, 3, counterKey, lockKey, `${counterKey}:generation`, limit, lockTtl
      );
      return result === 1 || result === 2;
    } catch (err) {
      logger.warn({ err }, 'Redis unavailable for account concurrency check, falling back to local');
      this.degradedMode = true;
      return this.tryAcquireLocal(tenantId, accountId, limit, callId);
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
  async extendLock(
    callId: string, tenantId: string, accountId: string, ttlSeconds: number,
  ): Promise<boolean> {
    if (this.degradedMode || !this.redis || ttlSeconds <= 0) return false;
    try {
      const lockKey = this.accountLockKey(tenantId, accountId, callId);
      const result = await this.redis.expire(lockKey, Math.floor(ttlSeconds), 'XX');
      return result === 1;
    } catch (err) {
      logger.warn({ err, callId, tenantId, accountId }, 'Failed to extend account concurrency lock');
      return false;
    }
  }

  @Traced('concurrency.account.release', {
    attrs: (callId: string, tenantId: string, accountId: string) => ({
      'call.id': callId,
      'tenant.id': tenantId,
      'account.id': accountId,
    }),
  })
  async release(callId: string, tenantId: string, accountId: string): Promise<void> {
    if (this.degradedMode || !this.redis) {
      this.releaseLocal(tenantId, accountId, callId);
      return;
    }

    try {
      const lockKey = this.accountLockKey(tenantId, accountId, callId);
      const counterKey = this.accountCounterKey(tenantId, accountId);
      await this.redis.eval(RELEASE_SCRIPT, 3, lockKey, counterKey, `${counterKey}:generation`);
    } catch (err) {
      logger.warn({ err }, 'Redis unavailable for account concurrency release');
      this.releaseLocal(tenantId, accountId, callId);
    }
  }

  async getAccountCount(tenantId: string, accountId: string): Promise<number> {
    if (this.degradedMode || !this.redis) {
      return this.localLeaseCount(tenantId, accountId);
    }

    try {
      const val = await this.redis.get(this.accountCounterKey(tenantId, accountId));
      return val ? parseInt(val, 10) : 0;
    } catch {
      return this.localLeaseCount(tenantId, accountId);
    }
  }

  /** Read the distributed count for control-plane safety checks. Unlike the
   * runtime compatibility accessor above, this never substitutes a process-
   * local value when Redis is degraded. */
  async getDistributedAccountCount(
    tenantId: string,
    accountId: string,
  ): Promise<{ status: 'available'; count: number } | { status: 'unavailable' }> {
    if (this.degradedMode || !this.redis) return { status: 'unavailable' };
    try {
      const val = await this.redis.get(this.accountCounterKey(tenantId, accountId));
      const count = val ? Number.parseInt(val, 10) : 0;
      return Number.isFinite(count) && count >= 0
        ? { status: 'available', count }
        : { status: 'unavailable' };
    } catch (err) {
      logger.warn({ err, tenantId, accountId }, 'Distributed account concurrency count unavailable');
      return { status: 'unavailable' };
    }
  }

  isDegraded(): boolean {
    return this.degradedMode;
  }

  /**
   * Invalidate the cached concurrency limit so the next call picks up the new DB value.
   */
  async invalidateLimit(tenantId: string, accountId: string): Promise<void> {
    // Clear local cache
    this.localLimitCache.delete(this.localKey(tenantId, accountId));

    // Clear Redis cache
    if (!this.degradedMode && this.redis) {
      try {
        await this.redis.del(this.limitCacheKey(tenantId, accountId));
      } catch (err) {
        logger.warn({ err, tenantId, accountId }, 'Failed to invalidate account limit cache in Redis');
      }
    }
  }

  // --- Limit resolution: Redis cache → DB → default ---

  private async resolveLimit(tenantId: string, accountId: string): Promise<number> {
    // Try Redis cache first
    if (!this.degradedMode && this.redis) {
      try {
        const cached = await this.redis.get(this.limitCacheKey(tenantId, accountId));
        if (cached !== null) {
          return parseInt(cached, 10);
        }
      } catch {
        // Redis read failed, fall through to DB
      }
    } else {
      // Check local limit cache in degraded mode
      const localEntry = this.localLimitCache.get(this.localKey(tenantId, accountId));
      if (localEntry && localEntry.expiresAt > Date.now()) {
        return localEntry.limit;
      }
    }

    // Cache miss — query DB
    let limit: number;
    try {
      limit = await accountSettingsRepository.getMaxConcurrentCalls(tenantId, accountId);
    } catch (err) {
      logger.warn({ err, tenantId, accountId }, 'Failed to fetch account concurrency limit from DB, using default');
      limit = DEFAULT_MAX_CONCURRENT_CALLS;
    }

    // Store in Redis cache (best effort)
    if (!this.degradedMode && this.redis) {
      try {
        await this.redis.set(
          this.limitCacheKey(tenantId, accountId),
          String(limit),
          'EX',
          LIMIT_CACHE_TTL_SECONDS
        );
      } catch {
        // Non-critical — next call will re-query DB
      }
    } else {
      // Store in local cache in degraded mode
      this.localLimitCache.set(this.localKey(tenantId, accountId), {
        limit,
        expiresAt: Date.now() + LIMIT_CACHE_TTL_SECONDS * 1000,
      });
    }

    return limit;
  }

  // --- Local fallback ---

  private tryAcquireLocal(
    tenantId: string, accountId: string, limit: number, callId: string,
  ): boolean {
    const key = this.localKey(tenantId, accountId);
    const leases = this.localLeases.get(key);
    // Re-acquire of a lease this replica already holds is idempotent (parity
    // with the Redis script's `EXISTS lock -> return 2`).
    if (leases?.has(callId)) return true;
    if ((leases?.size ?? 0) >= limit) return false;
    if (leases) leases.add(callId);
    else this.localLeases.set(key, new Set([callId]));
    return true;
  }

  /**
   * Ownership-checked and idempotent: releasing a call id this replica never
   * acquired for this account (duplicate webhook, lease taken on another
   * replica, a `queued` row that never got a slot) is a no-op rather than a
   * decrement that would steal another live call's slot.
   */
  private releaseLocal(tenantId: string, accountId: string, callId: string): void {
    const key = this.localKey(tenantId, accountId);
    const leases = this.localLeases.get(key);
    if (!leases) return;
    leases.delete(callId);
    // Drop the emptied set so the map doesn't grow one entry per account seen
    // while degraded; absent and empty are the same count.
    if (leases.size === 0) this.localLeases.delete(key);
  }

  private localLeaseCount(tenantId: string, accountId: string): number {
    return this.localLeases.get(this.localKey(tenantId, accountId))?.size ?? 0;
  }

  // --- Key helpers ---

  private accountCounterKey(tenantId: string, accountId: string): string {
    return `${this.keyPrefix}active_calls:account:${tenantId}:${accountId}`;
  }

  private accountLockKey(tenantId: string, accountId: string, callId: string): string {
    return `${this.keyPrefix}active_calls:account:${tenantId}:${accountId}:lock:${callId}`;
  }

  private limitCacheKey(tenantId: string, accountId: string): string {
    return `${this.keyPrefix}account_limit:${tenantId}:${accountId}`;
  }

  private localKey(tenantId: string, accountId: string): string {
    return `${tenantId}:${accountId}`;
  }

  /**
   * Reconcile the counter for an account by counting actual lock keys.
   * Heals drift caused by process crashes where the lock TTL expired
   * but the counter was never decremented. Returns true when it actually
   * reset/deleted the counter (i.e. `current !== lockCount`); false in the
   * degraded/early-return, no-drift, and error paths.
   */
  async reconcile(tenantId: string, accountId: string): Promise<boolean> {
    if (!this.redis || this.degradedMode) return false;

    try {
      // ioredis auto-prefixes keys for eval/get/set/del but NOT for scan MATCH.
      // Prepend the ioredis keyPrefix to the pattern so it matches actual Redis keys.
      const ioredisPrefix = (this.redis.options?.keyPrefix as string) ?? '';
      const pattern = ioredisPrefix + this.accountLockKey(tenantId, accountId, '*');
      const counterKey = this.accountCounterKey(tenantId, accountId);
      const generationKey = `${counterKey}:generation`;
      const generation = (await this.redis.get(generationKey)) ?? '0';
      let lockCount = 0;
      let cursor = '0';
      do {
        const [nextCursor, keys] = await this.redis.scan(
          cursor, 'MATCH', pattern, 'COUNT', 100
        );
        cursor = nextCursor;
        lockCount += keys.length;
      } while (cursor !== '0');

      const currentStr = await this.redis.get(counterKey);
      const current = currentStr ? parseInt(currentStr, 10) : 0;

      if (current !== lockCount) {
        logger.warn(
          { tenantId, accountId, counter: current, locks: lockCount },
          'Account concurrency counter drifted — reconciling'
        );
        const repaired = await this.redis.eval(
          RECONCILE_SCRIPT, 2, counterKey, generationKey, generation, lockCount,
        );
        return repaired === 1;
      }
      return false;
    } catch (err) {
      logger.warn({ err, tenantId, accountId }, 'Failed to reconcile account concurrency counter');
      return false;
    }
  }

  /**
   * Reconcile **every** account's counter against its live lock keys in a single
   * pass — used by the startup/periodic self-heal sweep so crash drift across all
   * accounts is healed without knowing the tenant/account set up front. Counts
   * locks per `{tenant}:{account}` composite, then for each account whose counter
   * disagrees (including counters left positive with zero surviving locks) resets
   * it to the live lock count. Returns how many accounts were checked/healed.
   */
  async reconcileAll(): Promise<{ accountsChecked: number; accountsReconciled: number }> {
    if (!this.redis || this.degradedMode) {
      return { accountsChecked: 0, accountsReconciled: 0 };
    }

    try {
      // ioredis auto-prefixes keys for eval/get/set/del but NOT for scan MATCH,
      // so the scanned keys come back WITH the prefix and must be stripped before
      // get/set/del re-applies it.
      const ioredisPrefix = (this.redis.options?.keyPrefix as string) ?? '';
      const base = `${this.keyPrefix}active_calls:account:`;
      const lockMarker = ':lock:';

      // Pass 1 discovers scopes, including counters with no surviving locks.
      const composites = new Set<string>();
      await this.scanEach(ioredisPrefix + base + '*', (prefixedKey) => {
        const logical = prefixedKey.slice(ioredisPrefix.length);
        const markerIdx = logical.indexOf(lockMarker);
        if (markerIdx >= 0) {
          composites.add(logical.slice(base.length, markerIdx));
        } else if (logical.endsWith(':generation')) {
          composites.add(logical.slice(base.length, -':generation'.length));
        } else {
          composites.add(logical.slice(base.length));
        }
      });

      // Snapshot every scope's generation before the authoritative lock scan.
      const generations = new Map<string, string>();
      for (const composite of composites) {
        generations.set(composite, (await this.redis.get(`${base}${composite}:generation`)) ?? '0');
      }

      // Pass 2 counts locks. Any mutation after its generation snapshot makes
      // that scope's CAS fail, while unrelated scopes can still be repaired.
      const lockCounts = new Map<string, number>();
      await this.scanEach(ioredisPrefix + base + '*' + lockMarker + '*', (prefixedKey) => {
        const logical = prefixedKey.slice(ioredisPrefix.length);
        const markerIdx = logical.indexOf(lockMarker);
        if (markerIdx < 0) return;
        const composite = logical.slice(base.length, markerIdx);
        if (composites.has(composite)) {
          lockCounts.set(composite, (lockCounts.get(composite) ?? 0) + 1);
        }
      });

      let reconciled = 0;
      for (const composite of composites) {
        const counterKey = base + composite;
        const desired = lockCounts.get(composite) ?? 0;
        const currentStr = await this.redis.get(counterKey);
        const current = currentStr ? parseInt(currentStr, 10) : 0;
        if (current === desired) continue;

        logger.warn(
          { account: composite, counter: current, locks: desired },
          'Account concurrency counter drifted — reconciling (sweep)'
        );
        const repaired = await this.redis.eval(
          RECONCILE_SCRIPT, 2, counterKey, `${counterKey}:generation`,
          generations.get(composite) ?? '0', desired,
        );
        if (repaired !== 1) continue;
        reconciled++;
      }

      return { accountsChecked: composites.size, accountsReconciled: reconciled };
    } catch (err) {
      logger.warn({ err }, 'Failed to reconcile account concurrency counters (sweep)');
      return { accountsChecked: 0, accountsReconciled: 0 };
    }
  }

  /** SCAN the keyspace for `pattern`, invoking `onKey` for every matched key. */
  private async scanEach(pattern: string, onKey: (key: string) => void): Promise<void> {
    if (!this.redis) return;
    let cursor = '0';
    do {
      const [nextCursor, keys] = await this.redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
      cursor = nextCursor;
      for (const key of keys) onKey(key);
    } while (cursor !== '0');
  }
}
