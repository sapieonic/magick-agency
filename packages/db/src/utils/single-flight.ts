/**
 * SingleFlight — deduplicates concurrent async work by key.
 *
 * When multiple callers ask for the same key while a first call is still in
 * flight, they all await the *same* promise instead of each launching the
 * underlying work. The in-flight entry is cleared as soon as the promise
 * settles (success or failure), so failures are never memoized — the next
 * caller retries cleanly.
 *
 * This is the classic guard against a "thundering herd": a burst of identical
 * requests on a cold cache collapsing to one backing-store hit / one expensive
 * synthesis rather than N of them.
 *
 * Intentionally does NOT cache results — it only coalesces overlapping calls.
 * Pair it with {@link TtlCache} (which builds on this) when you also want the
 * result held for a TTL.
 */
export class SingleFlight<T> {
  private readonly inflight = new Map<string, Promise<T>>();

  /**
   * Run `fn` for `key`, sharing the result with any concurrent caller that
   * asks for the same key while it's still running.
   *
   * Contract: the **key must fully determine the result**. While a call is in
   * flight, a second caller's `fn` for the same key is ignored — both awaiters
   * get the first call's result — so two callers passing the same key but
   * semantically different `fn`s would incorrectly share one outcome.
   */
  run(key: string, fn: () => Promise<T>): Promise<T> {
    const existing = this.inflight.get(key);
    if (existing) return existing;

    // Invoke fn synchronously (so a caller whose fn sets state synchronously —
    // e.g. TtlCache's per-load token — has it in place the moment run() returns),
    // but normalize a *synchronous* throw into a rejected promise. A plain
    // `(async () => { try … finally delete })()` would run the finally during
    // this synchronous evaluation — i.e. BEFORE the `inflight.set` below — for a
    // sync throw, leaking a permanently-rejected entry for the key.
    let result: Promise<T>;
    try {
      result = Promise.resolve(fn());
    } catch (err) {
      result = Promise.reject(err);
    }

    // Clear on settle (success OR failure) so errors aren't sticky and a fresh
    // call re-runs the work. `finally` callbacks run as microtasks, so the
    // `inflight.set` below has always executed by the time this fires.
    const p = result.finally(() => {
      this.inflight.delete(key);
    });

    this.inflight.set(key, p);
    return p;
  }

  /** Number of calls currently in flight (for tests / metrics). */
  get size(): number {
    return this.inflight.size;
  }
}
