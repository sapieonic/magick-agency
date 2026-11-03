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
/** Keys whose generation is remembered before the map is folded into the floor. */
export const MAX_TRACKED_GENERATIONS = 10_000;

export class GenerationTtlCache<V> {
  private readonly entries = new Map<string, { value: V; storedAt: number }>();
  /**
   * The generation of each key invalidated since the last fold. Generations come from one
   * counter for the whole cache, so a value is never reused. Every campaign and account the
   * process ever invalidated would otherwise stay here for the process's life: past
   * {@link MAX_TRACKED_GENERATIONS} the map is dropped and every key reads the counter's
   * value at that moment (`floor`). A load in flight then fails its store unless nothing
   * was invalidated after the generation it read (at worst a cache miss, never a stale
   * store: the floor is at least every generation forgotten).
   */
  private readonly generations = new Map<string, number>();
  private seq = 0;
  private floor = 0;

  constructor(
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
    private readonly maxTrackedGenerations = MAX_TRACKED_GENERATIONS,
  ) {}

  /** The current generation of `key`: read it BEFORE starting a load, pass it to {@link setIf}. */
  generation(key: string): number {
    return this.generations.get(key) ?? this.floor;
  }

  /** Keys with a remembered generation (bounded by {@link MAX_TRACKED_GENERATIONS}). */
  get trackedGenerations(): number {
    return this.generations.size;
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
    this.entries.delete(key);
    if (!this.generations.has(key) && this.generations.size >= this.maxTrackedGenerations) {
      this.floor = this.seq;
      this.generations.clear();
    }
    this.generations.set(key, ++this.seq);
  }

  /**
   * Drop every entry and move every key to a new generation, so a load in flight across a
   * clear cannot store.
   */
  clear(): void {
    this.floor = ++this.seq;
    this.generations.clear();
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}
