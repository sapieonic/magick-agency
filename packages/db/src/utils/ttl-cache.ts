import { SingleFlight } from './single-flight.js';

/**
 * TtlCache — a small, dependency-free, in-process read-through cache.
 *
 * The codebase already leans on a recurring pattern for "immutable-during-use"
 * config rows (prompt templates, messaging/SIP connections, account limits): an
 * in-memory Map with a short TTL and explicit invalidation. This generalizes
 * that pattern into one reusable, well-behaved primitive so new call sites don't
 * each hand-roll (and subtly misget) the expiry / eviction / stampede /
 * invalidation-race logic.
 *
 * Properties:
 *  - **Lazy TTL expiry** — an entry past its TTL is treated as a miss and dropped
 *    on the next access to its key. Reading an entry never extends its TTL.
 *  - **Bounded memory** — an optional `maxEntries` LRU cap evicts the
 *    least-recently-used entry once the cap is exceeded, so an unbounded key
 *    space (e.g. per-tenant keys) can't leak memory. Access (get / getOrLoad
 *    hit) refreshes recency; `has` does not.
 *  - **Single-flight loads** — {@link getOrLoad} collapses concurrent misses for
 *    the same key into one loader call (no thundering herd on a cold key).
 *  - **Invalidation-race safe** — a load that started before a concurrent
 *    `set`/`invalidate`/`clear` for the same key is **not** written back on
 *    completion, so a stale read in flight during a revocation/update can't
 *    resurrect the old value. (Guarded by a per-load token.)
 *  - **Errors are never cached** — a rejected loader propagates and leaves the
 *    key empty so the next caller retries.
 *  - **Negative caching** — whatever the loader returns is cached, including
 *    `null`/`undefined` (a "not found" is a valid, cacheable answer; the read
 *    path uses entry presence, not the value, to detect a hit). Keep the TTL
 *    short if the miss is security-sensitive (e.g. auth) to bound probing
 *    amplification.
 *
 * Reusable-API contract: for {@link getOrLoad}, the **key must fully determine
 * the loader's result** — concurrent callers with the same key share one loader
 * invocation (a second caller's `loader` is ignored while a load is in flight),
 * so two callers passing the same key but semantically different loaders would
 * incorrectly share a result.
 *
 * In-process only: each replica keeps its own copy, so a value can be stale by
 * up to one TTL across replicas after an out-of-band write. That's the same
 * trade-off the existing 60s registries already accept; use explicit
 * {@link invalidate}/{@link set} on the writing replica plus a short TTL as the
 * cross-replica backstop.
 */
export interface TtlCacheOptions {
  /** Entry lifetime in milliseconds. `0` disables caching (pure single-flight). */
  ttlMs: number;
  /**
   * Maximum entries before LRU eviction kicks in. Omit / `0` for unbounded
   * (only safe when the key space is itself bounded).
   */
  maxEntries?: number;
  /** Optional label for diagnostics. */
  name?: string;
}

interface Entry<V> {
  value: V;
  expiresAt: number;
}

export class TtlCache<V> {
  private readonly store = new Map<string, Entry<V>>();
  private readonly flight = new SingleFlight<V>();
  /**
   * Per-load identity tokens for in-flight loads. A load only writes its result
   * back if its token is still the current one for the key; any `set`/
   * `invalidate`/`clear` on that key clears the token, cancelling the write-back
   * of a load that raced with the mutation. Bounded by the number of concurrent
   * in-flight loads (cleared on completion), not by the key space.
   */
  private readonly loadTokens = new Map<string, object>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  readonly name: string;

  constructor(opts: TtlCacheOptions) {
    this.ttlMs = Math.max(0, opts.ttlMs);
    this.maxEntries = opts.maxEntries && opts.maxEntries > 0 ? opts.maxEntries : 0;
    this.name = opts.name ?? 'ttl-cache';
  }

  /**
   * Return the cached value for `key`, or `undefined` if absent/expired.
   *
   * Caveat: because a miss is signalled by `undefined`, `get` cannot distinguish
   * a genuine miss from a cached `undefined` value. Use {@link getOrLoad} (which
   * keys off entry presence) when the value type includes `undefined`.
   */
  get(key: string): V | undefined {
    const peeked = this.peek(key);
    return peeked.hit ? (peeked.value as V) : undefined;
  }

  /** Insert/replace `key`'s value, resetting its TTL and LRU recency. */
  set(key: string, value: V): void {
    // Cancel any in-flight load's pending write-back for this key so a slower,
    // staler load can't overwrite this fresher value.
    this.loadTokens.delete(key);
    this.writeEntry(key, value);
  }

  /**
   * Read-through with single-flight: return the cached value if fresh, else run
   * `loader` once (shared across concurrent callers), cache the result, and
   * return it. A rejected loader is propagated and not cached. A result whose
   * key was `set`/`invalidate`/`clear`'d while the load was in flight is
   * returned to the caller but not written to the cache (invalidation wins).
   */
  async getOrLoad(key: string, loader: () => Promise<V>): Promise<V> {
    const peeked = this.peek(key);
    if (peeked.hit) return peeked.value as V;

    return this.flight.run(key, async () => {
      const token = {};
      this.loadTokens.set(key, token);
      let value: V;
      try {
        value = await loader();
      } catch (err) {
        // Don't cache errors; clean up our token if it's still the current one.
        if (this.loadTokens.get(key) === token) this.loadTokens.delete(key);
        throw err;
      }
      // Only write back if no set/invalidate/clear happened for this key during
      // the load (which would have replaced/removed our token).
      if (this.loadTokens.get(key) === token) {
        this.loadTokens.delete(key);
        this.writeEntry(key, value);
      }
      return value;
    });
  }

  /** Whether `key` currently has a fresh entry. Does NOT refresh LRU recency. */
  has(key: string): boolean {
    const entry = this.store.get(key);
    if (entry === undefined) return false;
    if (this.isExpired(entry)) {
      this.store.delete(key);
      return false;
    }
    return true;
  }

  /** Drop a single key (and cancel any in-flight load's write-back for it). */
  invalidate(key: string): void {
    this.loadTokens.delete(key);
    this.store.delete(key);
  }

  /** Drop every entry (and cancel all in-flight loads' write-backs). */
  clear(): void {
    this.loadTokens.clear();
    this.store.clear();
  }

  /** Current number of live (not-yet-swept) entries. */
  get size(): number {
    return this.store.size;
  }

  /** Read + LRU-touch (moves to MRU) without extending TTL. */
  private peek(key: string): { hit: boolean; value?: V } {
    const entry = this.store.get(key);
    if (entry === undefined) return { hit: false };
    if (this.isExpired(entry)) {
      this.store.delete(key);
      return { hit: false };
    }
    // Refresh LRU recency by re-inserting the SAME entry (expiresAt unchanged).
    this.store.delete(key);
    this.store.set(key, entry);
    return { hit: true, value: entry.value };
  }

  private writeEntry(key: string, value: V): void {
    this.store.delete(key);
    this.store.set(key, { value, expiresAt: Date.now() + this.ttlMs });
    this.evictIfNeeded();
  }

  private isExpired(entry: Entry<V>): boolean {
    return entry.expiresAt <= Date.now();
  }

  private evictIfNeeded(): void {
    if (this.maxEntries === 0) return;
    while (this.store.size > this.maxEntries) {
      // Map preserves insertion order; the first key is the LRU (get/set move
      // touched keys to the end). A stored key never has a live load token, so
      // there's nothing to clean up in loadTokens on eviction.
      const oldest = this.store.keys().next().value;
      if (oldest === undefined) break;
      this.store.delete(oldest);
    }
  }
}
