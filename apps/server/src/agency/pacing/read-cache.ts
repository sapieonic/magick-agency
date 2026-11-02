/**
 * A small TTL cache whose writes are guarded by a per-key GENERATION, for the pacing
 * engine's campaign rows and account limits.
 *
 * The generation is what makes invalidation safe against a load in flight. Without
 * it the classic race reinstates a stale value for a whole TTL: a tick starts
 * loading the campaign row, a supervisor's pause commits and its event invalidates
 * the key, then the tick's load (which read the row BEFORE the pause) returns and
 * stores it. With it, {@link invalidate} bumps the key's generation, a load stores
 * its value only if the generation it started under is still current, and the
 * stale row is used by that one tick at most (the same tick would have read it
 * without any cache) and never cached.
 *
 * The TTL is the backstop for an invalidation that never arrives (a lost event, a
 * raw SQL write): no entry is served older than `ttlMs`.
 */
export class GenerationTtlCache<V> {
  private readonly entries = new Map<string, { value: V; storedAt: number }>();
  private readonly generations = new Map<string, number>();

  constructor(
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** The current generation of `key`: read it BEFORE starting a load, pass it to {@link setIf}. */
  generation(key: string): number {
    return this.generations.get(key) ?? 0;
  }

  /** A fresh value, or undefined. An expired entry is dropped. */
  get(key: string): V | undefined {
    const e = this.entries.get(key);
    if (!e) return undefined;
    if (this.now() - e.storedAt >= this.ttlMs) {
      this.entries.delete(key);
      return undefined;
    }
    return e.value;
  }

  /** Store `value` only if nothing invalidated `key` since `generation` was read. */
  setIf(key: string, generation: number, value: V): boolean {
    if (this.generation(key) !== generation) return false;
    this.entries.set(key, { value, storedAt: this.now() });
    return true;
  }

  /**
   * Serve a fresh entry, or load and (generation permitting) store. `fresh` skips
   * the read but still stores what it loads.
   */
  async getOrLoad(key: string, load: () => Promise<V>, opts: { fresh?: boolean } = {}): Promise<V> {
    if (!opts.fresh) {
      const hit = this.get(key);
      if (hit !== undefined) return hit;
    }
    const generation = this.generation(key);
    const value = await load();
    this.setIf(key, generation, value);
    return value;
  }

  invalidate(key: string): void {
    this.generations.set(key, this.generation(key) + 1);
    this.entries.delete(key);
  }

  /**
   * Drop every entry. Generations are bumped for the keys that had entries AND kept
   * for the rest, so a load in flight across a clear cannot store either.
   */
  clear(): void {
    for (const key of new Set([...this.entries.keys(), ...this.generations.keys()])) this.invalidate(key);
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}
