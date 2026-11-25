/**
 * The credential scope of telephony admission (docs/carriers.md CR13): a tenant's carrier
 * account (`telephony_credentials` row) may carry its own cap, `max_concurrent_calls`, on the
 * calls live on it at once. A credential serves every account of its tenant (B20), so the
 * scope is tenant-wide per credential: its counter is keyed by the credential id alone,
 * never by account. It is IN ADDITION to the global, account and per-account carrier scopes
 * (B22). A call on the service's own account (no credential) and a call on a credential
 * with no cap take no credential lease.
 *
 * Keys mirror the other scopes (`<prefix>active_calls:credential:<credentialId>`, its
 * `:lock:<concurrencyKey>` leases and `:generation` fence), so the composite Lua in
 * `provider-concurrency-guard.ts` takes, releases and repairs this scope in the same
 * transaction as the others, and the self-heal sweep rebuilds the counter from the live
 * leases as it does theirs ({@link CredentialConcurrencyGuard.reconcileAll}).
 *
 * No process-local fallback: when Redis is down a capped call is refused
 * (`redis_unavailable`), as a provider-breakdown account's is, because every process
 * admitting the whole cap on its own would over-commit the carrier account.
 */
import type Redis from 'ioredis';
import { telephonyCredentialRepository } from '@magick-agency/db/repositories/telephony-credential.repository';
import { logger } from '@magick-agency/observability';
import {
  trackCredentialConcurrencyAdmission,
  trackCredentialConcurrencyReconciliation,
} from '@magick-agency/observability/metrics/voice';

/** How long a credential's cap is cached in this process (as the provider allocation is). */
export const CREDENTIAL_CAP_CACHE_TTL_MS = 5_000;
const CAP_CACHE_MAX_ENTRIES = 10_000;

const ACQUIRE_SCRIPT = `
if redis.call('EXISTS', KEYS[2]) == 1 then return 2 end
if tonumber(redis.call('GET', KEYS[1]) or '0') >= tonumber(ARGV[1]) then return 0 end
redis.call('INCR', KEYS[1])
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
if (redis.call('GET', KEYS[2]) or '0') ~= ARGV[1] then return 0 end
if tonumber(ARGV[2]) == 0 then redis.call('DEL', KEYS[1])
else redis.call('SET', KEYS[1], ARGV[2]) end
return 1
`;

/** The three keys of one credential's scope, for one call. */
export interface CredentialScopeKeys {
  counter: string;
  lock: string;
  generation: string;
}

/** A credential scope a call must take: its keys and the cap read at admission. */
export interface CredentialScope extends CredentialScopeKeys {
  credentialId: string;
  cap: number;
}

export function credentialCounterKey(keyPrefix: string, credentialId: string): string {
  return `${keyPrefix}active_calls:credential:${credentialId}`;
}

export function credentialScopeKeys(keyPrefix: string, credentialId: string, callId: string): CredentialScopeKeys {
  const counter = credentialCounterKey(keyPrefix, credentialId);
  return { counter, lock: `${counter}:lock:${callId}`, generation: `${counter}:generation` };
}

export type CredentialAcquireResult = 'acquired' | 'already_owned' | 'credential_full' | 'redis_unavailable';

export type CredentialCounts =
  | { status: 'available'; counts: Map<string, number> }
  | { status: 'unavailable'; counts: Map<string, number> };

export class CredentialConcurrencyGuard {
  private readonly lockTtlSeconds: number;
  private readonly capCache = new Map<string, { cap: number | null; expiresAt: number }>();

  constructor(
    private readonly redis: Redis | null,
    private readonly keyPrefix: string,
    callTimeoutSeconds: number,
  ) {
    this.lockTtlSeconds = callTimeoutSeconds + 30;
  }

  /**
   * The credential's cap (null: none of its own), cached {@link CREDENTIAL_CAP_CACHE_TTL_MS}.
   * Throws when the read fails: the caller fails closed (`allocation_unavailable`).
   */
  async resolveCap(credentialId: string): Promise<number | null> {
    const cached = this.capCache.get(credentialId);
    if (cached && cached.expiresAt > Date.now()) return cached.cap;
    const raw = await telephonyCredentialRepository.getConcurrencyCap(credentialId);
    const cap = typeof raw === 'number' && Number.isInteger(raw) && raw > 0 ? raw : null;
    if (this.capCache.size >= CAP_CACHE_MAX_ENTRIES) {
      const now = Date.now();
      for (const [key, entry] of this.capCache) if (entry.expiresAt <= now) this.capCache.delete(key);
      while (this.capCache.size >= CAP_CACHE_MAX_ENTRIES) {
        const oldest = this.capCache.keys().next().value as string | undefined;
        if (!oldest) break;
        this.capCache.delete(oldest);
      }
    }
    this.capCache.set(credentialId, { cap, expiresAt: Date.now() + CREDENTIAL_CAP_CACHE_TTL_MS });
    return cap;
  }

  /** Drop a credential's cached cap, so the next admission reads the new one (a super-admin write). */
  invalidateCap(credentialId: string): void {
    this.capCache.delete(credentialId);
  }

  /** The scope a call on `credentialId` must take, or null when it has no cap of its own. */
  async scopeFor(credentialId: string, callId: string): Promise<CredentialScope | null> {
    const cap = await this.resolveCap(credentialId);
    if (cap === null) return null;
    return { credentialId, cap, ...credentialScopeKeys(this.keyPrefix, credentialId, callId) };
  }

  keysFor(credentialId: string, callId: string): CredentialScopeKeys {
    return credentialScopeKeys(this.keyPrefix, credentialId, callId);
  }

  /**
   * Take this scope alone (the legacy-total path and the compatibility path, which take the
   * other scopes through their own guards). Refuses without moving the counter when full.
   */
  async tryAcquire(
    callId: string,
    credentialId: string,
    cap: number,
    provider: string,
    ttlSecondsOverride?: number,
  ): Promise<CredentialAcquireResult> {
    if (!this.redis) {
      trackCredentialConcurrencyAdmission(provider, 'redis_unavailable');
      return 'redis_unavailable';
    }
    const keys = this.keysFor(credentialId, callId);
    const ttl = ttlSecondsOverride && ttlSecondsOverride > 0 ? ttlSecondsOverride : this.lockTtlSeconds;
    try {
      const result = await this.redis.eval(ACQUIRE_SCRIPT, 3, keys.counter, keys.lock, keys.generation, cap, ttl);
      const outcome: CredentialAcquireResult = result === 1 ? 'acquired' : result === 2 ? 'already_owned' : 'credential_full';
      trackCredentialConcurrencyAdmission(provider, outcome);
      return outcome;
    } catch (err) {
      logger.error({ err, callId, credentialId }, 'Redis unavailable for the credential concurrency check; failing closed');
      trackCredentialConcurrencyAdmission(provider, 'redis_unavailable');
      return 'redis_unavailable';
    }
  }

  /** Hand one call's lease back. Idempotent; never throws (teardown is best-effort). */
  async release(callId: string, credentialId: string): Promise<void> {
    if (!this.redis || !credentialId) return;
    const keys = this.keysFor(credentialId, callId);
    try {
      await this.redis.eval(RELEASE_SCRIPT, 3, keys.lock, keys.counter, keys.generation);
    } catch (err) {
      logger.error({ err, callId, credentialId }, 'Failed to release a credential concurrency slot');
    }
  }

  /**
   * Live leases per credential (the counters), for the super-admin's usage read. Best
   * effort: `unavailable` is a Redis fault, never "no calls".
   */
  async getCounts(credentialIds: readonly string[]): Promise<CredentialCounts> {
    const counts = new Map<string, number>();
    if (credentialIds.length === 0) return { status: 'available', counts };
    if (!this.redis) return { status: 'unavailable', counts };
    try {
      const values = await this.redis.mget(...credentialIds.map((id) => credentialCounterKey(this.keyPrefix, id)));
      credentialIds.forEach((id, i) => {
        const parsed = Number.parseInt(values[i] ?? '0', 10);
        counts.set(id, Number.isFinite(parsed) && parsed > 0 ? parsed : 0);
      });
      return { status: 'available', counts };
    } catch (err) {
      logger.warn({ err }, 'Failed to read credential concurrency counts');
      return { status: 'unavailable', counts: new Map() };
    }
  }

  /**
   * Rebuild every credential counter from its live leases (the self-heal sweep), each under
   * its generation fence so a concurrent acquire or release is never overwritten. The same
   * rule as the provider and account scopes: the leases are the truth, the counter a cache.
   */
  async reconcileAll(): Promise<{ credentialsChecked: number; credentialsReconciled: number }> {
    if (!this.redis) return { credentialsChecked: 0, credentialsReconciled: 0 };
    try {
      const ioredisPrefix = (this.redis.options?.keyPrefix as string) ?? '';
      const base = `${this.keyPrefix}active_calls:credential:`;
      const lockMarker = ':lock:';
      const ids = new Set<string>();
      const lockCounts = new Map<string, number>();

      // Pass 1: every scope with a counter, a generation or a lease.
      await this.scanEach(`${ioredisPrefix}${base}*`, (physical) => {
        const logical = physical.slice(ioredisPrefix.length);
        const rest = logical.slice(base.length);
        const marker = rest.indexOf(lockMarker);
        if (marker >= 0) ids.add(rest.slice(0, marker));
        else if (rest.endsWith(':generation')) ids.add(rest.slice(0, -':generation'.length));
        else ids.add(rest);
      });
      // Generations before counting leases: a lease taken after this read moves the fence.
      const generations = new Map<string, string>();
      for (const id of ids) generations.set(id, (await this.redis.get(`${base}${id}:generation`)) ?? '0');
      await this.scanEach(`${ioredisPrefix}${base}*${lockMarker}*`, (physical) => {
        const rest = physical.slice(ioredisPrefix.length).slice(base.length);
        const marker = rest.indexOf(lockMarker);
        if (marker < 0) return;
        const id = rest.slice(0, marker);
        if (ids.has(id)) lockCounts.set(id, (lockCounts.get(id) ?? 0) + 1);
      });

      let reconciled = 0;
      for (const id of ids) {
        const counterKey = `${base}${id}`;
        const currentValue = await this.redis.get(counterKey);
        const current = currentValue ? Number.parseInt(currentValue, 10) : 0;
        const desired = lockCounts.get(id) ?? 0;
        if (current === desired) continue;
        const repaired = await this.redis.eval(
          RECONCILE_SCRIPT, 2, counterKey, `${counterKey}:generation`, generations.get(id) ?? '0', desired,
        );
        if (repaired !== 1) continue;
        reconciled++;
        logger.warn({ credentialId: id, counter: current, locks: desired }, 'Credential concurrency counter drifted — reconciling');
      }
      trackCredentialConcurrencyReconciliation(reconciled > 0 ? 'repaired' : 'clean');
      return { credentialsChecked: ids.size, credentialsReconciled: reconciled };
    } catch (err) {
      logger.warn({ err }, 'Failed to reconcile credential concurrency counters');
      trackCredentialConcurrencyReconciliation('failed');
      return { credentialsChecked: 0, credentialsReconciled: 0 };
    }
  }

  private async scanEach(pattern: string, visit: (key: string) => void): Promise<void> {
    let cursor = '0';
    do {
      const [next, keys] = await this.redis!.scan(cursor, 'MATCH', pattern, 'COUNT', 200);
      cursor = next;
      for (const key of keys) visit(key);
    } while (cursor !== '0');
  }
}
