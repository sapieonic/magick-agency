/**
 * Work started but not yet settled, so a `stop()` can wait for it — the pacing
 * engine's in-flight ticks and its completion notices. Split out of
 * `pacing-engine.ts`.
 */
export class InFlight {
  private readonly pending = new Set<Promise<unknown>>();

  /** Track `work` until it settles (either way). Returns `work` itself. */
  track<T>(work: Promise<T>): Promise<T> {
    this.pending.add(work);
    const forget = (): void => { this.pending.delete(work); };
    work.then(forget, forget);
    return work;
  }

  get size(): number {
    return this.pending.size;
  }

  /**
   * Wait for everything tracked now to settle, for at most `timeoutMs`. True when
   * it all settled in time. Never rejects: a rejected member counts as settled.
   */
  async settle(timeoutMs: number): Promise<boolean> {
    if (this.pending.size === 0) return true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timedOut = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), timeoutMs);
      timer.unref?.();
    });
    const settled = Promise.allSettled([...this.pending]).then(() => 'drained' as const);
    const outcome = await Promise.race([settled, timedOut]);
    if (timer) clearTimeout(timer);
    return outcome === 'drained';
  }
}
