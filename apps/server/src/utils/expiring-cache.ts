/**
 * A bounded in-process read cache whose entries each expire. A lookup that finds an
 * expired entry deletes it; a write at the cap first drops every expired entry, then the
 * oldest written, until there is room (the eviction the provider concurrency guard's limit
 * cache uses). Times are passed in, so a caller can read with the clock it already holds.
 */
export class ExpiringCache<V> {
  private readonly entries = new Map<string, { value: V; expiresAt: number }>();

  constructor(private readonly opts: { ttlMs: number; maxEntries: number }) {}

  /** The live value for `key`, or undefined. An expired entry is deleted. */
  get(key: string, now = Date.now()): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt > now) return entry.value;
    this.entries.delete(key);
    return undefined;
  }

  /** Store `value` for `key` until `now + ttlMs`, evicting first when at the cap. */
  set(key: string, value: V, now = Date.now()): void {
    this.entries.delete(key);
    if (this.entries.size >= this.opts.maxEntries) {
      for (const [cachedKey, entry] of this.entries) {
        if (entry.expiresAt <= now) this.entries.delete(cachedKey);
      }
      while (this.entries.size >= this.opts.maxEntries) {
        const oldest = this.entries.keys().next().value as string | undefined;
        if (oldest === undefined) break;
        this.entries.delete(oldest);
      }
    }
    this.entries.set(key, { value, expiresAt: now + this.opts.ttlMs });
  }

  /** Forget every entry. */
  clear(): void {
    this.entries.clear();
  }

  /** How many entries are held, live or not yet swept. */
  get size(): number {
    return this.entries.size;
  }
}
