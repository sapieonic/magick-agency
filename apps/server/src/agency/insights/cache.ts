/**
 * A few seconds of memory in front of the insights summary and allocation (docs/insights.md
 * "API").
 *
 * ── Why ──────────────────────────────────────────────────────────────────────
 * The console polls `summary` and `allocation` every 10 s per open tab while a campaign moves
 * (`apps/console/src/utils/agency/insights/polling.ts`). Each read counts the whole campaign's
 * contacts once, and the running summary adds the stats strip's own reads; measured on a
 * 1M-contact campaign with 900k attempts (docs/insights.md "API"), a running summary costs ~2.4 s
 * of database time and an allocation ~1.9 s. Ten supervisors watching one campaign would be ten
 * times that every 10 s for numbers that are the same to the second. Here they share one
 * computation:
 *
 *  - **TTL** {@link INSIGHTS_CACHE_TTL_MS}, or {@link INSIGHTS_CACHE_COST_FACTOR} times what the
 *    answer took to compute when that is longer: an answer is reused that long, then recomputed.
 *    A small campaign is fresh to the 5 s; a 1M-contact one is never computing more than a
 *    quarter of the time.
 *  - **Single flight**: a read that arrives while the same key is being computed waits for that
 *    computation instead of starting another (the burst of tabs opening at once).
 *  - **Keyed by the campaign row's `status` and `updated_at`** as well as its id
 *    ({@link insightsCacheKey}): a pause, resume, stop or settings edit stamps `updated_at`, so
 *    the next read after it misses and the headline never trails a transition. Contact and
 *    attempt changes do not stamp the campaign; they show within the TTL.
 *  - **Bounded** at {@link INSIGHTS_CACHE_MAX_ENTRIES} (oldest first out).
 *
 * The guards still run on every request (permission, flag, id, ownership) BEFORE the cache is
 * consulted; only the computed body is shared, and a key names exactly one campaign, so a body is
 * only ever served to a caller who just proved they may read that campaign.
 *
 * In process, not Redis: HTTP is served by one process (the primary in `docs/scaling.md`'s
 * topology; workers never listen), so there is exactly one cache to keep, and a stale copy on
 * another process cannot exist. A rejected computation is not cached.
 */

/** How long a computed summary or allocation is reused, at least. */
export const INSIGHTS_CACHE_TTL_MS = 5_000;

/**
 * An answer that took `t` to compute is reused for at least `t` × this, so one campaign's insights
 * keep the database busy at most a quarter of the time however large the campaign: a 1M-contact
 * running campaign's summary (~2.5 s) is reused for ~10 s, the console's poll interval.
 */
export const INSIGHTS_CACHE_COST_FACTOR = 4;

/** The most entries kept (campaigns × sections). */
export const INSIGHTS_CACHE_MAX_ENTRIES = 500;

interface Entry<V> {
  value: Promise<V>;
  /** When the computation finished; null while it runs (every caller then shares it). */
  doneAt: number | null;
  ttlMs: number;
}

export class InsightsCache {
  private readonly entries = new Map<string, Entry<unknown>>();

  constructor(
    private readonly ttlMs = INSIGHTS_CACHE_TTL_MS,
    private readonly maxEntries = INSIGHTS_CACHE_MAX_ENTRIES,
    private readonly now: () => number = Date.now,
    private readonly costFactor = INSIGHTS_CACHE_COST_FACTOR,
  ) {}

  /** The cached answer for `key`, or `compute()`'s, shared by every caller while fresh. */
  get<V>(key: string, compute: () => Promise<V>): Promise<V> {
    const hit = this.entries.get(key);
    if (hit && (hit.doneAt === null || this.now() - hit.doneAt < hit.ttlMs)) return hit.value as Promise<V>;
    if (hit) this.entries.delete(key);

    const startedAt = this.now();
    const value = compute();
    const entry: Entry<V> = { value, doneAt: null, ttlMs: this.ttlMs };
    this.entries.set(key, entry);
    value.then(
      () => {
        entry.doneAt = this.now();
        entry.ttlMs = Math.max(this.ttlMs, (entry.doneAt - startedAt) * this.costFactor);
      },
      // A failure is never served to the next caller.
      () => {
        if (this.entries.get(key) === entry) this.entries.delete(key);
      },
    );
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    return value;
  }

  /** Drop everything (tests). */
  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}

/** `section:campaign:status:updated_at`: a lifecycle change or a settings edit misses. */
export function insightsCacheKey(
  section: string,
  campaign: { id: string; status: string; updated_at: Date | string },
): string {
  const stamp = campaign.updated_at instanceof Date ? campaign.updated_at.getTime() : String(campaign.updated_at);
  return `${section}:${campaign.id}:${campaign.status}:${stamp}`;
}

/** The process's one cache. */
export const insightsCache = new InsightsCache();
