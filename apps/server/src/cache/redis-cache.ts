import type { Redis } from 'ioredis';
import { createChildLogger } from '@magick-agency/observability';
import { LocalCache, LOCAL_CACHE_FAMILIES } from './local-cache.js';
import { localCacheOperationsTotal, localCacheInvalidationsTotal } from '@magick-agency/observability/metrics/platform';

const log = createChildLogger({ component: 'redis-cache' });

/** Q5: Redis DEL attempts for a revocation before it is reported as failed. */
export const REVOCATION_DEL_ATTEMPTS = 3;
/** Q5: backoff between those attempts (ms, multiplied by the attempt number). */
export const REVOCATION_DEL_BACKOFF_MS = 50;

/** Payload broadcast to every instance when a key or pattern is invalidated. */
type InvalidationMessage =
  | { op: 'del'; keys: string[] }
  | { op: 'pattern'; pattern: string };

export interface LocalCacheConfig {
  enabled: boolean;
  ttlMs: number;
  maxEntries: number;
  /**
   * Pub/sub channel for invalidation broadcasts. Namespaced with the Redis key
   * prefix by the caller: ioredis applies `keyPrefix` to KEYS, not to channel
   * names, so two deployments sharing one Redis would otherwise cross-talk and
   * clear each other's caches.
   */
  channel: string;
}

/**
 * Metric label for a key — the family PREFIX, never the key itself: a full key
 * carries a user or tenant id, which would mint one permanent metric
 * series per user.
 *
 * The `'other'` fallback is unreachable today (every caller checks
 * `isCacheable` first) and is kept only so the function is total; if it ever
 * shows up in a scrape, a caller has started labelling un-allow-listed keys.
 */
function familyOf(key: string): string {
  return LOCAL_CACHE_FAMILIES.find((p) => key.startsWith(p)) ?? 'other';
}

/**
 * Generic Redis cache with graceful fallback.
 * All operations are fire-and-forget safe — Redis failures never
 * propagate to callers. On any error the method returns null / void
 * and the caller falls through to the authoritative data source.
 */
/**
 * Exported for tests only — production code uses the {@link redisCache}
 * singleton. The cross-instance invalidation contract cannot be verified
 * against a singleton: proving a broadcast reaches *another* process requires
 * two independently-initialised caches over the same Redis.
 */
export class RedisCache {
  private redis: Redis | null = null;
  private local: LocalCache | null = null;
  private localConfig: LocalCacheConfig | null = null;

  /** Call once from index.ts after Redis connects. */
  init(redis: Redis, localConfig?: LocalCacheConfig): void {
    this.redis = redis;
    // Kept even when the layer is DISABLED: `publishInvalidation` needs the
    // channel so a disabled instance still notifies enabled peers.
    if (localConfig) this.localConfig = localConfig;
    if (localConfig?.enabled) {
      this.local = new LocalCache({
        ttlMs: localConfig.ttlMs,
        maxEntries: localConfig.maxEntries,
      });
      this.localConfig = localConfig;
      log.info(
        { ttlMs: localConfig.ttlMs, maxEntries: localConfig.maxEntries },
        'Redis cache initialized with in-process layer',
      );
      return;
    }
    log.info('Redis cache initialized');
  }

  /**
   * Attach the subscriber that keeps every instance's local layer honest.
   *
   * Without this the local cache is only eventually consistent on the TTL, and
   * that is not good enough for what it holds: the role-change and
   * membership-delete routes `del` the membership key specifically so a
   * revocation lands immediately, and a purely TTL'd local copy would keep
   * granting the old role on every other instance until it expired.
   *
   * Best-effort by design — a subscribe failure logs and leaves the TTL as the
   * only backstop, rather than taking the process down over a cache.
   */
  async attachInvalidationSubscriber(subscriber: Redis): Promise<void> {
    if (!this.local || !this.localConfig) return;
    const channel = this.localConfig.channel;

    subscriber.on('message', (received: string, raw: string) => {
      if (received !== channel) return;
      try {
        const msg = JSON.parse(raw) as InvalidationMessage;
        if (msg.op === 'del') {
          for (const key of msg.keys) this.local?.delete(key);
        } else {
          this.local?.deleteByPattern(msg.pattern);
        }
        localCacheInvalidationsTotal.inc({ source: 'broadcast' });
      } catch (err) {
        log.warn({ err }, 'Malformed cache invalidation message ignored');
      }
    });

    try {
      await subscriber.subscribe(channel);
      log.info({ channel }, 'Cache invalidation subscriber attached');
    } catch (err) {
      log.warn({ err, channel }, 'Cache invalidation subscribe failed — local cache falls back to TTL only');
    }
  }

  /**
   * Tell every instance (including this one) to drop these entries. Fire and
   * forget: the local delete has already happened on this instance, and the TTL
   * bounds the damage everywhere else if the publish fails.
   */
  private publishInvalidation(msg: InvalidationMessage): void {
    // Deliberately NOT gated on `this.local`. An instance running with the
    // local layer disabled still has to tell the others, or the documented
    // incident lever becomes a footgun: setting LOCAL_CACHE_ENABLED=false and
    // rolling it out would mean the first restarted instance stops publishing
    // while its peers are still caching, so a role change made on it is never
    // broadcast and the rest of the fleet serves the old role for a full TTL.
    // The lever must not be least safe exactly when it is reached for. Same
    // reasoning covers the rolling deploy that first enables the layer.
    if (!this.localConfig || !this.redis) return;
    this.redis.publish(this.localConfig.channel, JSON.stringify(msg)).catch((err: unknown) => {
      log.warn({ err }, 'Cache invalidation publish failed');
    });
  }

  /** Test seam: drop every local entry without touching Redis. */
  clearLocal(): void {
    this.local?.clear();
  }

  /** Returns true when a Redis instance is available. */
  get available(): boolean {
    return this.redis !== null;
  }

  /**
   * Read a JSON-serialized value.
   * Returns null on miss or any Redis/parse error.
   */
  async get<T>(key: string): Promise<T | null> {
    const useLocal = this.local !== null && LocalCache.isCacheable(key);
    if (useLocal) {
      const hit = this.local!.get(key);
      if (hit) {
        localCacheOperationsTotal.inc({ family: familyOf(key), result: 'hit' });
        return hit.value as T;
      }
      localCacheOperationsTotal.inc({ family: familyOf(key), result: 'miss' });
    }

    if (!this.redis) return null;
    // Snapshot the invalidation epoch BEFORE issuing the read. If anything
    // invalidates this key while the read is in flight, the value coming back
    // is already stale and must not be written to the local map — otherwise a
    // read that started before a revocation repopulates the old role AFTER it,
    // and the cache serves it for a full TTL. Cache-aside's classic race, and
    // the one this layer's whole safety claim rests on.
    const epoch = useLocal ? this.local!.epochFor(key) : 0;
    try {
      const raw = await this.redis.get(key);
      if (raw === null) return null;
      const parsed = JSON.parse(raw) as T;
      // Populate from the Redis read too, not only from `set` — the common
      // shape is one instance filling Redis and every instance reading it, so
      // caching only our own writes would leave the layer nearly always cold.
      // `setIfEpoch` drops the write when an invalidation intervened.
      if (useLocal) this.local!.setIfEpoch(key, raw, epoch);
      return parsed;
    } catch (err) {
      log.warn({ err, key }, 'Redis cache GET failed, falling through');
      return null;
    }
  }

  /**
   * Store a value as JSON with a TTL in seconds.
   * Silently swallows errors.
   */
  async set(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    // No broadcast here. A `set` is overwhelmingly a REFILL of the same value
    // after a TTL expiry, not a change, and it happens on every cache miss —
    // publishing on it would put a pub/sub message on the hot path for no
    // freshness gain. Genuine changes go through `del`, which does broadcast.
    const serialized = JSON.stringify(value);
    // Stored SERIALIZED, so a local hit reproduces the Redis path byte for
    // byte: callers get a fresh object each time (no aliasing between
    // concurrent requests sharing one cached record) and `Date` columns come
    // back as ISO strings exactly as they do through Redis. Storing the live
    // object would make the runtime TYPE of a value depend on which instance
    // and which layer served it — see the round-trip caveat on
    // `getCachedTenantRecord`. The stringify is not extra work: the Redis
    // write below needs it anyway.
    if (this.local && LocalCache.isCacheable(key)) this.local.set(key, serialized);
    if (!this.redis) return;
    try {
      await this.redis.set(key, serialized, 'EX', ttlSeconds);
    } catch (err) {
      log.warn({ err, key }, 'Redis cache SET failed');
    }
  }

  /**
   * Fixed-window counter: `INCR` the key and return the new count, setting the
   * TTL only on the first hit of a window.
   *
   * The "only on 1" is the whole point and the reason this is not
   * {@link incrementGeneration}, which `EXPIRE`s on every call. Refreshing the
   * TTL each hit makes the window slide forward under sustained traffic, so a
   * caller hammering the endpoint is never let out of the penalty box — a rate
   * limit that a client can accidentally turn into a permanent block is not a
   * rate limit.
   *
   * Returns null when Redis is unavailable, and the caller must read that as
   * "allow": same fail-open posture as the rest of this class and as the global
   * IP limiter's `skipOnError`. A cache outage must not take a feature down.
   */
  async incrementWindow(key: string, windowSeconds: number): Promise<number | null> {
    if (!this.redis) return null;
    try {
      const result = await this.redis.eval(
        `local value = redis.call('INCR', KEYS[1])
         if value == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
         return value`,
        1,
        key,
        String(windowSeconds),
      );
      return Number(result);
    } catch (err) {
      log.warn({ err, key }, 'Redis cache window increment failed');
      return null;
    }
  }

  /**
   * Atomically advance a short-lived generation used to fence distributed
   * cache writers. The expiry prevents one generation key per cache digest
   * accumulating forever; callers must choose a TTL longer than their maximum
   * upstream request duration.
   */
  async incrementGeneration(key: string, ttlSeconds: number): Promise<number | null> {
    if (!this.redis) return null;
    try {
      const result = await this.redis.eval(
        `local value = redis.call('INCR', KEYS[1])
         redis.call('EXPIRE', KEYS[1], ARGV[1])
         return value`,
        1,
        key,
        String(ttlSeconds),
      );
      return Number(result);
    } catch (err) {
      log.warn({ err, key }, 'Redis cache generation increment failed');
      return null;
    }
  }

  /**
   * Advance a generation only if no newer invalidation has superseded the
   * caller. Used after a correctness-sensitive refresh so same-generation
   * readers that started during the refresh can no longer overwrite it.
   */
  async advanceGenerationAndSetIfMatches(
    generationKey: string,
    expectedGeneration: number,
    generationTtlSeconds: number,
    cacheKey: string,
    value: unknown,
    cacheTtlSeconds: number,
  ): Promise<number | null> {
    if (!this.redis) return null;
    try {
      const result = await this.redis.eval(
        `local current = redis.call('GET', KEYS[1])
         if not current then current = '0' end
         if current ~= ARGV[1] then return nil end
         local value = redis.call('INCR', KEYS[1])
         redis.call('EXPIRE', KEYS[1], ARGV[2])
         redis.call('SET', KEYS[2], ARGV[3], 'EX', ARGV[4])
         return value`,
        2,
        generationKey,
        cacheKey,
        String(expectedGeneration),
        String(generationTtlSeconds),
        JSON.stringify(value),
        String(cacheTtlSeconds),
      );
      return result === null ? null : Number(result);
    } catch (err) {
      log.warn(
        { err, cacheKey, generationKey, expectedGeneration },
        'Redis cache generation advance-and-set failed',
      );
      return null;
    }
  }

  /**
   * Write only while a Redis-backed generation still matches. This prevents a
   * slow request on another server replica from refilling a key after a newer
   * mutation invalidated it.
   */
  async setIfGenerationMatches(
    key: string,
    value: unknown,
    ttlSeconds: number,
    generationKey: string,
    expectedGeneration: number,
  ): Promise<boolean> {
    if (!this.redis) return false;
    try {
      const result = await this.redis.eval(
        `local current = redis.call('GET', KEYS[1])
         if not current then current = '0' end
         if current ~= ARGV[1] then return 0 end
         redis.call('SET', KEYS[2], ARGV[2], 'EX', ARGV[3])
         return 1`,
        2,
        generationKey,
        key,
        String(expectedGeneration),
        JSON.stringify(value),
        String(ttlSeconds),
      );
      return Number(result) === 1;
    } catch (err) {
      log.warn({ err, key, generationKey }, 'Redis fenced cache SET failed');
      return false;
    }
  }

  /**
   * Delete one or more keys. Silently swallows errors.
   */
  async del(...keys: string[]): Promise<void> {
    if (keys.length === 0) return;
    // Drop our own copies first: an invalidation that reaches memory but not
    // Redis is recoverable (the value is merely re-read), whereas one that
    // clears Redis while this process keeps a stale copy is the revocation bug
    // this guards. `delete` also bumps each key's epoch, which is what stops an
    // already-in-flight read from repopulating it (see `get`).
    if (this.local) for (const key of keys) this.local.delete(key);

    if (this.redis) {
      try {
        await this.redis.del(...keys);
      } catch (err) {
        log.warn({ err, keys }, 'Redis cache DEL failed');
      }
    }

    // Broadcast AFTER Redis is authoritative. Publishing first tells peers to
    // drop their copies while the value is still readable from Redis, so
    // ordinary traffic on those peers re-reads and re-caches the very value
    // being invalidated.
    this.publishInvalidation({ op: 'del', keys });
  }

  /**
   * Q5 (Manas, 2026-10-09): `del` for a REVOCATION — a change that reduces someone's access
   * (membership removal, a role change). `del` logs and swallows a Redis failure, leaving the
   * revoked entry readable until its TTL (membership 30 min, user 20 min); for a revocation
   * that is fail-open. This retries the Redis DEL a bounded number of times
   * ({@link REVOCATION_DEL_ATTEMPTS}, short backoff) and, if it still fails, logs at ERROR
   * and returns `false` so the route can decide: a route that is idempotent on retry answers
   * 503 and the admin retries; one that is not keeps its 2xx (the error log is then the
   * signal). The local copy is dropped and peers are told either way, exactly as `del` does.
   * Returns `true` when Redis holds no copy (deleted, or no Redis at all).
   */
  async delForRevocation(...keys: string[]): Promise<boolean> {
    if (keys.length === 0) return true;
    if (this.local) for (const key of keys) this.local.delete(key);
    let cleared = true;
    if (this.redis) {
      cleared = false;
      let lastErr: unknown;
      for (let attempt = 1; attempt <= REVOCATION_DEL_ATTEMPTS && !cleared; attempt += 1) {
        try {
          await this.redis.del(...keys);
          cleared = true;
        } catch (err) {
          lastErr = err;
          if (attempt < REVOCATION_DEL_ATTEMPTS) {
            await new Promise((resolve) => setTimeout(resolve, REVOCATION_DEL_BACKOFF_MS * attempt));
          }
        }
      }
      if (!cleared) {
        log.error(
          { err: lastErr, keys, attempts: REVOCATION_DEL_ATTEMPTS },
          'Redis cache DEL failed for a REVOCATION — the revoked entry stays readable until its TTL',
        );
      }
    }
    this.publishInvalidation({ op: 'del', keys });
    return cleared;
  }

  /**
   * Delete every key matching a glob pattern (e.g. `cache:phone:${tenantId}:*`).
   * Uses a non-blocking SCAN cursor (never KEYS) so it is safe on the hot
   * data path. Silently swallows errors — invalidation is best-effort, the
   * TTL remains the backstop.
   */
  async delByPattern(pattern: string): Promise<void> {
    if (this.local) this.local.deleteByPattern(pattern);

    if (this.redis) {
      try {
        let cursor = '0';
        do {
          const [next, keys] = await this.redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
          cursor = next;
          if (keys.length > 0) await this.redis.del(...keys);
        } while (cursor !== '0');
      } catch (err) {
        log.warn({ err, pattern }, 'Redis cache DEL-by-pattern failed');
      }
    }

    // Broadcast only once the SCAN+DEL loop has finished, and the ordering
    // matters far more here than for a single `del`: the sweep is many round
    // trips, so publishing first told peers to drop their copies while most of
    // the matching keys were still live in Redis, and ordinary traffic re-cached
    // them. Measured on a 5,000-key tenant sweep: 412 memberships were still
    // being served after the invalidation had completed. That call site is the
    // super-admin tenant soft-delete, whose entire purpose is revoking access
    // immediately rather than waiting out a TTL.
    this.publishInvalidation({ op: 'pattern', pattern });
  }
}

export const redisCache = new RedisCache();
