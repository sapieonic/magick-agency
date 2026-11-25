import type Redis from 'ioredis';
import { providerConcurrencyRepository } from '@magick-agency/db/repositories/provider-concurrency.repository';
import { logger, Traced } from '@magick-agency/observability';
import {
  trackCredentialConcurrencyAdmission,
  trackProviderConcurrencyAdmission,
  trackProviderConcurrencyReconciliation,
} from '@magick-agency/observability/metrics/voice';
import { credentialScopeKeys, type CredentialScope } from './credential-concurrency-guard.js';

const ACQUIRE_SCRIPT = `
if redis.call('EXISTS', KEYS[2]) == 1 then
  return 2
end
local current = redis.call('INCR', KEYS[1])
if current > tonumber(ARGV[1]) then
  redis.call('DECR', KEYS[1])
  return 0
end
redis.call('SET', KEYS[2], '1', 'EX', tonumber(ARGV[2]))
redis.call('INCR', KEYS[3])
return 1
`;

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
if (redis.call('GET', KEYS[2]) or '0') ~= ARGV[1] then
  return 0
end
if tonumber(ARGV[2]) == 0 then
  redis.call('DEL', KEYS[1])
else
  redis.call('SET', KEYS[1], ARGV[2])
end
return 1
`;

// Provider-mode telephony admission owns every scope in one Redis transaction.
// KEYS are triples (counter, lock, generation): global, account, provider and,
// when the call is on a carrier account with a cap of its own (CR13), the
// credential scope as a fourth triple. ARGV: global limit, account limit,
// provider limit, lease TTL, then the credential cap when that triple is present.
// Returns: 1 acquired, 2 global full, 3 account full, 4 provider full, 5 every
// lease already owned, 6 a partial lease was found and released (the caller
// repairs the counters and tries again), 7 the carrier account's cap is full.
const COMPOSITE_ACQUIRE_SCRIPT = `
local scopes = #KEYS / 3
local limits = { ARGV[1], ARGV[2], ARGV[3], ARGV[5] }
local full = { 2, 3, 4, 7 }
local held = 0
for i = 1, scopes do
  held = held + redis.call('EXISTS', KEYS[3 * i - 1])
end
if held == scopes then return 5 end
if held > 0 then
  -- A previous non-atomic teardown or partial TTL extension may have left only
  -- some scopes owned. Remove surviving leases in this transaction; the caller
  -- then generation-fences a counter rebuild before attempting fresh admission.
  for i = 1, scopes do
    if redis.call('DEL', KEYS[3 * i - 1]) == 1 then
      local val = redis.call('DECR', KEYS[3 * i - 2])
      if val < 0 then redis.call('SET', KEYS[3 * i - 2], '0') end
      redis.call('INCR', KEYS[3 * i])
    end
  end
  return 6
end
for i = 1, scopes do
  if tonumber(redis.call('GET', KEYS[3 * i - 2]) or '0') >= tonumber(limits[i]) then return full[i] end
end
for i = 1, scopes do
  redis.call('INCR', KEYS[3 * i - 2])
  redis.call('SET', KEYS[3 * i - 1], '1', 'EX', tonumber(ARGV[4]))
  redis.call('INCR', KEYS[3 * i])
end
return 1
`;

// KEYS are the same triples as the acquire's: three, or four with the credential scope.
const COMPOSITE_RELEASE_SCRIPT = `
local released = 0
for i = 1, #KEYS / 3 do
  if redis.call('DEL', KEYS[3 * i - 1]) == 1 then
    local val = redis.call('DECR', KEYS[3 * i - 2])
    if val < 0 then redis.call('SET', KEYS[3 * i - 2], '0') end
    redis.call('INCR', KEYS[3 * i])
    released = released + 1
  end
end
return released
`;

const COMPOSITE_EXTEND_SCRIPT = `
local expected = tonumber(ARGV[2])
for i = 1, expected do
  if redis.call('EXISTS', KEYS[i]) ~= 1 then return 0 end
end
for i = 1, expected do
  redis.call('EXPIRE', KEYS[i], tonumber(ARGV[1]))
end
return expected
`;

export type ProviderAdmissionResult =
  | { result: 'acquired'; providerScoped: boolean; newlyAcquired: boolean }
  | { result: 'provider_full'; providerScoped: true }
  | { result: 'provider_unallocated'; providerScoped: true }
  | { result: 'redis_unavailable'; providerScoped: true }
  | { result: 'allocation_unavailable'; providerScoped: true };

/**
 * Outcome of a composite (single-transaction) release of every telephony scope
 * a call owns.
 *
 * - `released` — the Lua ran; `scopes` is how many leases it actually deleted
 *   (0 means the call already had none, e.g. a duplicate teardown or leases that
 *   TTL-expired; 2 is the ordinary count for a legacy account, whose provider
 *   lease never existed).
 * - `unavailable` — no Redis client, or no provider to build the provider key
 *   from, so nothing was attempted. The caller must fall back.
 * - `failed` — the eval threw. Nothing can be assumed about whether it ran, so
 *   the caller must fall back; that is safe because Redis-level release is
 *   idempotent (a second DEL returns 0 and moves no counter).
 *
 * This is deliberately a value rather than a thrown error: teardown must never
 * be interrupted, and the caller needs to *decide* on the outcome (fall back,
 * label a metric) rather than merely survive it.
 */
export type CompositeReleaseResult =
  | { status: 'released'; scopes: number }
  | { status: 'unavailable' }
  | { status: 'failed'; err: unknown };

export type TelephonyAdmissionResult =
  | { result: 'acquired'; providerScoped: boolean; newlyAcquired: boolean }
  | { result: 'legacy_mode'; providerScoped: false }
  | { result: 'global_full' | 'account_full'; providerScoped: boolean }
  | { result: 'provider_full'; providerScoped: true }
  /** The carrier account's own cap is full (CR13); either allocation mode. */
  | { result: 'credential_full'; providerScoped: boolean }
  | { result: 'provider_unallocated'; providerScoped: true }
  /** Fail-closed refusals. `providerScoped: false` only from a legacy account's credential scope (CR13). */
  | { result: 'redis_unavailable' | 'allocation_unavailable'; providerScoped: boolean };

interface CachedLimit {
  mode: 'legacy_total' | 'provider_breakdown';
  limit: number | null;
  total: number;
  version: number;
}

interface LimitCacheEntry {
  allocation: CachedLimit;
  expiresAt: number;
}

const LIMIT_CACHE_TTL_MS = 5_000;
const LIMIT_CACHE_MAX_ENTRIES = 10_000;

/**
 * Distributed provider-level concurrency guard.
 *
 * Legacy accounts bypass this guard. Provider-breakdown accounts fail closed
 * when Redis is unavailable because a process-local fallback would allow every
 * replica to independently consume the full carrier allocation.
 */
export class ProviderConcurrencyGuard {
  private readonly lockTtlSeconds: number;
  private readonly limitCache = new Map<string, LimitCacheEntry>();

  constructor(
    private readonly redis: Redis | null,
    private readonly keyPrefix: string,
    callTimeoutSeconds: number,
    private readonly globalLimit = Number.MAX_SAFE_INTEGER,
  ) {
    this.lockTtlSeconds = callTimeoutSeconds + 30;
  }

  /** Atomically acquire global + account + provider leases for provider-mode
   * telephony, plus the carrier account's own scope when `credential` is given (CR13:
   * every scope or none). Legacy accounts are explicitly handed back to the caller so the
   * established degraded/local behavior remains unchanged during migration; the caller
   * then takes `credential` itself. */
  async tryAcquireAll(
    callId: string,
    tenantId: string,
    accountId: string,
    provider: string,
    ttlSecondsOverride?: number,
    credential?: CredentialScope | null,
  ): Promise<TelephonyAdmissionResult> {
    const canonicalProvider = provider.toLowerCase();
    let allocation: CachedLimit;
    try {
      allocation = await this.resolveLimit(tenantId, accountId, canonicalProvider);
    } catch (err) {
      logger.error({ err, tenantId, accountId, provider: canonicalProvider }, 'Provider allocation unavailable; failing closed');
      return { result: 'allocation_unavailable', providerScoped: true };
    }
    if (allocation.mode === 'legacy_total') return { result: 'legacy_mode', providerScoped: false };
    if (!allocation.limit || allocation.limit <= 0) {
      trackProviderConcurrencyAdmission(canonicalProvider, 'provider_unallocated');
      return { result: 'provider_unallocated', providerScoped: true };
    }
    if (!this.redis) {
      trackProviderConcurrencyAdmission(canonicalProvider, 'redis_unavailable');
      return { result: 'redis_unavailable', providerScoped: true };
    }
    const providerLimit = allocation.limit;
    const ttl = ttlSecondsOverride && ttlSecondsOverride > 0 ? ttlSecondsOverride : this.lockTtlSeconds;
    try {
      const globalCounter = `${this.keyPrefix}active_calls`;
      const accountCounter = `${this.keyPrefix}active_calls:account:${tenantId}:${accountId}`;
      const providerCounter = this.providerCounterKey(tenantId, accountId, canonicalProvider);
      const keys = [
        globalCounter,
        `${globalCounter}:lock:${callId}`,
        `${globalCounter}:generation`,
        accountCounter,
        `${accountCounter}:lock:${callId}`,
        `${accountCounter}:generation`,
        providerCounter,
        this.providerLockKey(tenantId, accountId, canonicalProvider, callId),
        this.providerGenerationKey(tenantId, accountId, canonicalProvider),
        ...(credential ? [credential.counter, credential.lock, credential.generation] : []),
      ];
      const acquire = () => this.redis!.eval(
        COMPOSITE_ACQUIRE_SCRIPT,
        keys.length,
        ...keys,
        this.globalLimit,
        allocation.total,
        providerLimit,
        ttl,
        ...(credential ? [credential.cap] : []),
      );
      let result = await acquire();
      let repairedPartial = false;
      if (result === 6) {
        logger.warn({ callId, tenantId, accountId, provider: canonicalProvider }, 'Repairing partial composite concurrency lease');
        await Promise.all([
          this.reconcileCounterFromLocks(globalCounter, `${globalCounter}:generation`),
          this.reconcileCounterFromLocks(accountCounter, `${accountCounter}:generation`),
          this.reconcileCounterFromLocks(
            providerCounter,
            this.providerGenerationKey(tenantId, accountId, canonicalProvider),
          ),
          ...(credential ? [this.reconcileCounterFromLocks(credential.counter, credential.generation)] : []),
        ]);
        result = await acquire();
        repairedPartial = result !== 6;
      }
      if (result === 1 || result === 5) {
        const metricResult = repairedPartial ? 'partial_repaired' : result === 1 ? 'acquired' : 'already_owned';
        trackProviderConcurrencyAdmission(canonicalProvider, metricResult);
        if (credential) trackCredentialConcurrencyAdmission(canonicalProvider, metricResult);
        return { result: 'acquired', providerScoped: true, newlyAcquired: result !== 5 };
      }
      if (result === 2) {
        trackProviderConcurrencyAdmission(canonicalProvider, 'global_full');
        return { result: 'global_full', providerScoped: true };
      }
      if (result === 3) {
        trackProviderConcurrencyAdmission(canonicalProvider, 'account_full');
        return { result: 'account_full', providerScoped: true };
      }
      if (result === 4) {
        trackProviderConcurrencyAdmission(canonicalProvider, 'provider_full');
        return { result: 'provider_full', providerScoped: true };
      }
      if (result === 7 && credential) {
        trackProviderConcurrencyAdmission(canonicalProvider, 'credential_full');
        trackCredentialConcurrencyAdmission(canonicalProvider, 'credential_full');
        return { result: 'credential_full', providerScoped: true };
      }
      logger.error({ callId, tenantId, accountId, provider: canonicalProvider, redisResult: result }, 'Unexpected composite concurrency admission result');
      return { result: 'redis_unavailable', providerScoped: true };
    } catch (err) {
      logger.error({ err, callId, tenantId, accountId, provider: canonicalProvider }, 'Composite provider admission failed closed');
      return { result: 'redis_unavailable', providerScoped: true };
    }
  }

  @Traced('concurrency.provider.try_acquire', {
    attrs: (callId: string, tenantId: string, accountId: string, provider: string) => ({
      'call.id': callId,
      'tenant.id': tenantId,
      'account.id': accountId,
      'telephony.provider': provider,
    }),
  })
  async tryAcquire(
    callId: string,
    tenantId: string,
    accountId: string,
    provider: string,
    ttlSecondsOverride?: number,
  ): Promise<ProviderAdmissionResult> {
    const canonicalProvider = provider.toLowerCase();
    let allocation: CachedLimit;
    try {
      allocation = await this.resolveLimit(tenantId, accountId, canonicalProvider);
    } catch (err) {
      logger.error(
        { err, tenantId, accountId, provider: canonicalProvider },
        'Provider allocation unavailable; failing closed',
      );
      return { result: 'allocation_unavailable', providerScoped: true };
    }
    if (allocation.mode === 'legacy_total') {
      return { result: 'acquired', providerScoped: false, newlyAcquired: false };
    }
    if (!allocation.limit || allocation.limit <= 0) {
      return { result: 'provider_unallocated', providerScoped: true };
    }
    if (!this.redis) {
      return { result: 'redis_unavailable', providerScoped: true };
    }

    try {
      const lockTtl = ttlSecondsOverride && ttlSecondsOverride > 0
        ? ttlSecondsOverride
        : this.lockTtlSeconds;
      const result = await this.redis.eval(
        ACQUIRE_SCRIPT,
        3,
        this.providerCounterKey(tenantId, accountId, canonicalProvider),
        this.providerLockKey(tenantId, accountId, canonicalProvider, callId),
        this.providerGenerationKey(tenantId, accountId, canonicalProvider),
        allocation.limit,
        lockTtl,
      );
      return result === 1 || result === 2
        ? { result: 'acquired', providerScoped: true, newlyAcquired: result === 1 }
        : { result: 'provider_full', providerScoped: true };
    } catch (err) {
      logger.error(
        { err, tenantId, accountId, provider: canonicalProvider },
        'Redis unavailable for provider concurrency check; failing closed',
      );
      return { result: 'redis_unavailable', providerScoped: true };
    }
  }

  async release(callId: string, tenantId: string, accountId: string, provider: string): Promise<void> {
    if (!this.redis || !provider) return;
    const canonicalProvider = provider.toLowerCase();
    try {
      await this.redis.eval(
        RELEASE_SCRIPT,
        3,
        this.providerLockKey(tenantId, accountId, canonicalProvider, callId),
        this.providerCounterKey(tenantId, accountId, canonicalProvider),
        this.providerGenerationKey(tenantId, accountId, canonicalProvider),
      );
    } catch (err) {
      logger.error(
        { err, callId, tenantId, accountId, provider: canonicalProvider },
        'Failed to release provider concurrency slot',
      );
      // Teardown is best-effort and idempotent. A provider Redis failure must
      // never prevent account/global release, terminal persistence, or webhook
      // acknowledgement. Reconciliation heals drift after Redis recovers.
    }
  }

  /** Release all three telephony scopes in one Redis transaction. This works
   * for legacy accounts too: the absent provider lease is simply ignored.
   *
   * Returns the authoritative outcome rather than swallowing it — the Lua
   * already reports how many leases it deleted, and callers need that both to
   * decide whether a fallback release is required and to label the teardown
   * metric. See {@link CompositeReleaseResult}. */
  async releaseAll(
    callId: string, tenantId: string, accountId: string, provider: string, credentialId?: string | null,
  ): Promise<CompositeReleaseResult> {
    if (!this.redis || !provider) return { status: 'unavailable' };
    const canonicalProvider = provider.toLowerCase();
    const globalCounter = `${this.keyPrefix}active_calls`;
    const accountCounter = `${this.keyPrefix}active_calls:account:${tenantId}:${accountId}`;
    const providerCounter = this.providerCounterKey(tenantId, accountId, canonicalProvider);
    // A call on a carrier account (CR13) also hands back its credential lease when it holds
    // one; a credential with no cap had none, and the absent lease is ignored like a legacy
    // account's provider lease.
    const credential = credentialId ? credentialScopeKeys(this.keyPrefix, credentialId, callId) : null;
    const keys = [
      globalCounter,
      `${globalCounter}:lock:${callId}`,
      `${globalCounter}:generation`,
      accountCounter,
      `${accountCounter}:lock:${callId}`,
      `${accountCounter}:generation`,
      providerCounter,
      this.providerLockKey(tenantId, accountId, canonicalProvider, callId),
      this.providerGenerationKey(tenantId, accountId, canonicalProvider),
      ...(credential ? [credential.counter, credential.lock, credential.generation] : []),
    ];
    try {
      const released = await this.redis.eval(COMPOSITE_RELEASE_SCRIPT, keys.length, ...keys);
      // Tested with `typeof`, NOT `Number(...)`: `Number(null)`, `Number('')`,
      // `Number(false)` and `Number([])` are all a finite 0, so coercing would
      // turn "we cannot read the reply" into "Redis authoritatively held no
      // leases" — and that answer is terminal for the caller, which would then
      // skip the fallback and leak all three leases until the sweep. A reply we
      // cannot read is the `failed` contract (fall back), never a zero-scope
      // success.
      const scopes = typeof released === 'number' ? released : Number.NaN;
      if (!Number.isFinite(scopes)) {
        logger.error(
          { callId, tenantId, accountId, provider: canonicalProvider, released },
          'Composite telephony release returned a non-numeric reply',
        );
        return { status: 'failed', err: new Error('non-numeric composite release reply') };
      }
      return { status: 'released', scopes };
    } catch (err) {
      logger.error({ err, callId, tenantId, accountId, provider: canonicalProvider }, 'Failed to release composite telephony concurrency lease');
      return { status: 'failed', err };
    }
  }

  async extendLock(
    callId: string,
    tenantId: string,
    accountId: string,
    provider: string,
    ttlSeconds: number,
  ): Promise<boolean> {
    if (!this.redis || !provider || ttlSeconds <= 0) return false;
    try {
      const result = await this.redis.expire(
        this.providerLockKey(tenantId, accountId, provider.toLowerCase(), callId),
        Math.floor(ttlSeconds),
        'XX',
      );
      return result === 1;
    } catch (err) {
      logger.warn({ err, callId, tenantId, accountId, provider }, 'Failed to extend provider concurrency lock');
      return false;
    }
  }

  /** Atomically extend every live scope owned by a call. A Redis command error
   * cannot leave the three TTLs diverged because Lua execution is atomic. */
  async extendAll(
    callId: string,
    tenantId: string,
    accountId: string,
    provider: string,
    ttlSeconds: number,
    credential?: { credentialId: string; capped: boolean } | null,
  ): Promise<boolean> {
    if (!this.redis || !provider || ttlSeconds <= 0) return false;
    const canonicalProvider = provider.toLowerCase();
    const globalCounter = `${this.keyPrefix}active_calls`;
    const accountCounter = `${this.keyPrefix}active_calls:account:${tenantId}:${accountId}`;
    try {
      const allocation = await this.resolveLimit(tenantId, accountId, canonicalProvider);
      // The leases the call must hold, every one of which is extended or none (CR13: a
      // carrier account with a cap of its own adds its lease to the set).
      const locks = [
        `${globalCounter}:lock:${callId}`,
        `${accountCounter}:lock:${callId}`,
        ...(allocation.mode === 'provider_breakdown'
          ? [this.providerLockKey(tenantId, accountId, canonicalProvider, callId)]
          : []),
        ...(credential?.capped
          ? [credentialScopeKeys(this.keyPrefix, credential.credentialId, callId).lock]
          : []),
      ];
      const extended = await this.redis.eval(
        COMPOSITE_EXTEND_SCRIPT,
        locks.length,
        ...locks,
        Math.floor(ttlSeconds),
        locks.length,
      );
      return Number(extended) === locks.length;
    } catch (err) {
      logger.warn({ err, callId, tenantId, accountId, provider: canonicalProvider }, 'Failed to extend composite telephony concurrency lease');
      return false;
    }
  }

  async getProviderCount(tenantId: string, accountId: string, provider: string): Promise<number | null> {
    if (!this.redis) return null;
    try {
      const value = await this.redis.get(
        this.providerCounterKey(tenantId, accountId, provider.toLowerCase()),
      );
      if (!value) return 0;
      const parsed = Number.parseInt(value, 10);
      return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
    } catch (err) {
      logger.warn({ err, tenantId, accountId, provider }, 'Failed to read provider concurrency count');
      return null;
    }
  }

  /** Snapshot live provider leases for an account, including providers removed
   * from the current allocation while calls are still draining. */
  async getAccountProviderCounts(
    tenantId: string,
    accountId: string,
  ): Promise<{ status: 'available'; counts: Map<string, number> } | { status: 'unavailable'; counts: Map<string, number> }> {
    if (!this.redis) return { status: 'unavailable', counts: new Map() };
    const counts = new Map<string, number>();
    try {
      const ioredisPrefix = (this.redis.options?.keyPrefix as string) ?? '';
      const base = `${this.keyPrefix}active_calls:provider:${tenantId}:${accountId}:`;
      const pattern = `${ioredisPrefix}${base}*:lock:*`;
      let cursor = '0';
      do {
        const [nextCursor, keys] = await this.redis.scan(cursor, 'MATCH', pattern, 'COUNT', 200);
        cursor = nextCursor;
        for (const physicalKey of keys) {
          const logicalKey = physicalKey.slice(ioredisPrefix.length);
          const suffix = logicalKey.slice(base.length);
          const marker = suffix.indexOf(':lock:');
          if (marker <= 0) continue;
          const provider = suffix.slice(0, marker);
          counts.set(provider, (counts.get(provider) ?? 0) + 1);
        }
      } while (cursor !== '0');
      return { status: 'available', counts };
    } catch (err) {
      logger.warn({ err, tenantId, accountId }, 'Failed to enumerate provider concurrency leases');
      return { status: 'unavailable', counts: new Map() };
    }
  }

  async invalidateLimits(tenantId: string, accountId: string): Promise<void> {
    const prefix = `${tenantId}:${accountId}:`;
    for (const key of this.limitCache.keys()) {
      if (key.startsWith(prefix)) this.limitCache.delete(key);
    }
  }

  /** Rebuild every provider counter from its live call locks. */
  async reconcileAll(): Promise<{ providersChecked: number; providersReconciled: number }> {
    if (!this.redis) return { providersChecked: 0, providersReconciled: 0 };

    try {
      const ioredisPrefix = (this.redis.options?.keyPrefix as string) ?? '';
      const base = `${this.keyPrefix}active_calls:provider:`;
      const lockMarker = ':lock:';
      const composites = new Set<string>();

      let cursor = '0';
      do {
        const [nextCursor, keys] = await this.redis.scan(
          cursor,
          'MATCH',
          ioredisPrefix + base + '*',
          'COUNT',
          100,
        );
        cursor = nextCursor;
        for (const key of keys) {
          const logical = key.slice(ioredisPrefix.length);
          const markerIndex = logical.indexOf(lockMarker);
          if (markerIndex >= 0) {
            const composite = logical.slice(base.length, markerIndex);
            composites.add(composite);
          } else if (logical.endsWith(':generation')) {
            composites.add(logical.slice(base.length, -':generation'.length));
          } else {
            composites.add(logical.slice(base.length));
          }
        }
      } while (cursor !== '0');

      const generations = new Map<string, string>();
      for (const composite of composites) {
        generations.set(composite, (await this.redis.get(`${base}${composite}:generation`)) ?? '0');
      }

      const lockCounts = new Map<string, number>();
      cursor = '0';
      do {
        const [nextCursor, keys] = await this.redis.scan(
          cursor, 'MATCH', ioredisPrefix + base + '*' + lockMarker + '*', 'COUNT', 100,
        );
        cursor = nextCursor;
        for (const key of keys) {
          const logical = key.slice(ioredisPrefix.length);
          const markerIndex = logical.indexOf(lockMarker);
          if (markerIndex < 0) continue;
          const composite = logical.slice(base.length, markerIndex);
          if (composites.has(composite)) {
            lockCounts.set(composite, (lockCounts.get(composite) ?? 0) + 1);
          }
        }
      } while (cursor !== '0');

      let providersReconciled = 0;
      for (const composite of composites) {
        const counterKey = base + composite;
        const generationKey = `${counterKey}:generation`;
        const currentValue = await this.redis.get(counterKey);
        const current = currentValue ? Number.parseInt(currentValue, 10) : 0;
        const desired = lockCounts.get(composite) ?? 0;
        if (current === desired) continue;
        const repaired = await this.redis.eval(
          RECONCILE_SCRIPT,
          2,
          counterKey,
          generationKey,
          generations.get(composite) ?? '0',
          desired,
        );
        if (repaired !== 1) continue;
        providersReconciled++;
        logger.warn(
          { providerScope: composite, counter: current, locks: desired },
          'Provider concurrency counter drifted — reconciling',
        );
      }

      trackProviderConcurrencyReconciliation(providersReconciled > 0 ? 'repaired' : 'clean');
      return { providersChecked: composites.size, providersReconciled };
    } catch (err) {
      logger.warn({ err }, 'Failed to reconcile provider concurrency counters');
      trackProviderConcurrencyReconciliation('failed');
      return { providersChecked: 0, providersReconciled: 0 };
    }
  }

  private async resolveLimit(
    tenantId: string,
    accountId: string,
    provider: string,
  ): Promise<CachedLimit> {
    const key = `${tenantId}:${accountId}:${provider}`;
    const cached = this.limitCache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.allocation;
    const allocation = await providerConcurrencyRepository.getProviderLimit(
      tenantId,
      accountId,
      provider,
    );
    if (this.limitCache.size >= LIMIT_CACHE_MAX_ENTRIES) {
      const now = Date.now();
      for (const [cachedKey, entry] of this.limitCache) {
        if (entry.expiresAt <= now) this.limitCache.delete(cachedKey);
      }
      while (this.limitCache.size >= LIMIT_CACHE_MAX_ENTRIES) {
        const oldest = this.limitCache.keys().next().value as string | undefined;
        if (!oldest) break;
        this.limitCache.delete(oldest);
      }
    }
    this.limitCache.set(key, { allocation, expiresAt: Date.now() + LIMIT_CACHE_TTL_MS });
    return allocation;
  }

  /** Rebuild one scope counter from live leases after a partial composite state.
   * The generation fence prevents this rare repair scan from overwriting a
   * concurrent acquire or release. */
  private async reconcileCounterFromLocks(counterKey: string, generationKey: string): Promise<boolean> {
    if (!this.redis) return false;
    const ioredisPrefix = (this.redis.options?.keyPrefix as string) ?? '';
    const generation = (await this.redis.get(generationKey)) ?? '0';
    let count = 0;
    let cursor = '0';
    do {
      const [nextCursor, keys] = await this.redis.scan(
        cursor,
        'MATCH',
        `${ioredisPrefix}${counterKey}:lock:*`,
        'COUNT',
        200,
      );
      cursor = nextCursor;
      count += keys.length;
    } while (cursor !== '0');
    const repaired = await this.redis.eval(
      RECONCILE_SCRIPT,
      2,
      counterKey,
      generationKey,
      generation,
      count,
    );
    return repaired === 1;
  }

  private providerCounterKey(tenantId: string, accountId: string, provider: string): string {
    return `${this.keyPrefix}active_calls:provider:${tenantId}:${accountId}:${provider}`;
  }

  private providerLockKey(
    tenantId: string,
    accountId: string,
    provider: string,
    callId: string,
  ): string {
    return `${this.providerCounterKey(tenantId, accountId, provider)}:lock:${callId}`;
  }

  private providerGenerationKey(tenantId: string, accountId: string, provider: string): string {
    return `${this.providerCounterKey(tenantId, accountId, provider)}:generation`;
  }
}
