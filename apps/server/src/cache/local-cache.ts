/**
 * A bounded, TTL'd, in-process cache that sits in front of Redis.
 *
 * The middleware chain reads several distinct Redis keys in strict sequence
 * before any handler runs — the user record (session), the membership (tenant
 * context), the tenant and account records (name resolution), and governance
 * overrides on capability-gated routes. That is four to five serial round trips
 * on the floor of every authenticated request, for values that change only on
 * admin edits and are already cached in Redis for 20–30 minutes.
 *
 * This layer collapses a burst of those into process memory. It is deliberately
 * NOT a general-purpose cache:
 *
 *  - **Opt-in by key prefix.** Only the families listed in `LOCAL_CACHE_FAMILIES`
 *    participate. Blanket-caching everything that flows through `redisCache`
 *    would sweep in fenced writes and one-shot keys whose freshness semantics
 *    nobody checked.
 *  - **Seconds, not minutes.** The TTL is a backstop for a missed invalidation
 *    message, not the primary freshness mechanism.
 *  - **Invalidation is cross-instance.** See `redis-cache.ts`: every `del` /
 *    `delByPattern` publishes on a Redis channel and all instances drop the
 *    matching local entries. This matters because the deletes are not
 *    cosmetic — `PUT /users/:id/role` and the membership delete both `del` the
 *    membership key precisely so a revocation takes effect immediately. A local
 *    cache without the broadcast would keep serving the old ROLE from every
 *    other instance until its TTL expired, turning a permission revocation into
 *    an eventually-consistent one.
 *
 * Entries are stored as the already-parsed value, so a hit also skips the
 * `JSON.parse` the Redis path pays.
 */

/** Key prefixes allowed to use the local layer, with the reason each is safe. */
export const LOCAL_CACHE_FAMILIES = [
  // Session user record — invalidated explicitly on profile/auth changes.
  'cache:user:',
  // Membership + role — invalidated explicitly on role change and removal.
  'cache:membership:',
  // Tenant / account display records — invalidated on tenant/account writes.
  'cache:tenant:',
  'cache:account:',
  // Governance capability overrides — invalidated on every super-admin write.
  'cache:governance:',
] as const;

/**
 * Deliberately absent: `cache:bulk-status-summary:`. Those entries are written
 * through the generation-fenced helpers (`setIfGenerationMatches`,
 * `advanceGenerationAndSetIfMatches`) rather than plain `set`, precisely so a
 * slow replica cannot refill a key a newer request has invalidated. A local
 * copy would sit outside that fence and reintroduce the staleness the fence
 * exists to prevent. Anything else adopting the fenced writes must stay out of
 * the list above for the same reason.
 */

interface Entry {
  /** The value as stored in Redis — JSON text, parsed on read. */
  raw: string;
  /** Epoch ms after which the entry is dead. */
  expiresAt: number;
}

export interface LocalCacheOptions {
  ttlMs: number;
  maxEntries: number;
}

export class LocalCache {
  /**
   * Insertion-ordered, which is what makes the eviction below O(1): a JS Map
   * iterates in insertion order, so the first key is always the oldest.
   */
  private readonly entries = new Map<string, Entry>();

  /**
   * Monotonic invalidation counter, bumped on every delete.
   *
   * A reader snapshots it via {@link epochFor} BEFORE issuing its Redis read
   * and passes it back to {@link setIfEpoch}; a delete that lands in between
   * moves the counter and the populate is dropped. Without it, cache-aside's
   * classic race resurrects an invalidated key: the read was issued before the
   * revocation, so it returns the old role, and its continuation writes that
   * role back into memory *after* the invalidation processed.
   *
   * A single global counter rather than one per key: invalidations are rare
   * (admin writes) while reads are constant, so a spurious skip costs one Redis
   * read on an unrelated key and correctness never depends on the precision.
   * Per-key state would also have to outlive the entry it protects, which is
   * exactly the tombstone bookkeeping this avoids.
   */
  private epoch = 0;

  constructor(private readonly opts: LocalCacheOptions) {}

  /** Snapshot the invalidation counter before a read (see {@link epoch}). */
  epochFor(_key: string): number {
    return this.epoch;
  }

  /** True when `key` belongs to a family allowed to use this layer. */
  static isCacheable(key: string): boolean {
    return LOCAL_CACHE_FAMILIES.some((prefix) => key.startsWith(prefix));
  }

  get size(): number {
    return this.entries.size;
  }

  /**
   * Returns the cached value, or `undefined` on miss/expiry.
   *
   * `undefined` rather than `null` is load-bearing: `null` is a legitimate
   * cached value (a resolver that cached "no such record"), so a `null`-means-
   * miss signal would re-query Redis on every hit for exactly the keys the
   * negative caching exists to protect.
   */
  get(key: string): { value: unknown } | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(key);
      return undefined;
    }
    // Refresh recency so the eviction below is LRU rather than FIFO.
    this.entries.delete(key);
    this.entries.set(key, entry);
    try {
      // Parse per read, so every caller gets its OWN object. Handing out a
      // shared instance would let one request mutate another's cached record,
      // and would make `Date`-vs-ISO-string depend on whether the local or the
      // Redis layer served the call.
      return { value: JSON.parse(entry.raw) };
    } catch {
      // Unparseable entry is treated as absent rather than thrown at a caller
      // that only asked for a cache lookup.
      this.entries.delete(key);
      return undefined;
    }
  }

  /** Store pre-serialized JSON (exactly what Redis holds for this key). */
  set(key: string, raw: string): void {
    // Delete first so a re-set moves the key to the end (most recent).
    this.entries.delete(key);
    this.entries.set(key, { raw, expiresAt: Date.now() + this.opts.ttlMs });

    while (this.entries.size > this.opts.maxEntries) {
      // Oldest = first key in insertion order.
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
  }

  /**
   * Populate only if no invalidation has landed since `epoch` was taken.
   * Returns whether the value was stored — false means a delete intervened and
   * the value in hand is already stale.
   */
  setIfEpoch(key: string, raw: string, epoch: number): boolean {
    if (this.epoch !== epoch) return false;
    this.set(key, raw);
    return true;
  }

  delete(key: string): void {
    this.epoch++;
    this.entries.delete(key);
  }

  /**
   * Drop every entry whose key matches a Redis glob pattern.
   *
   * Only `*` is translated (the sole wildcard the callers use, e.g.
   * `cache:membership:*:{tenantId}`); everything else is escaped, so a key
   * containing regex metacharacters cannot widen the match and clear unrelated
   * families.
   */
  deleteByPattern(pattern: string): void {
    this.epoch++;
    const rx = new RegExp(`^${pattern.split('*').map(escapeRegExp).join('.*')}$`);
    for (const key of this.entries.keys()) {
      if (rx.test(key)) this.entries.delete(key);
    }
  }

  clear(): void {
    this.epoch++;
    this.entries.clear();
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
