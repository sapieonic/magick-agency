/**
 * The per-user cap on Excel conversions (IM8): at most {@link XLSX_STARTS_PER_USER}
 * conversions started by one user in any {@link XLSX_STARTS_WINDOW_MS}. One conversion runs
 * at a time, server-wide (`agency-xlsx-runner.ts`), so without a cap one supervisor
 * re-uploading a slow workbook could keep that slot from every other tenant. The upload
 * route asks before it reads a workbook's body and counts a start only when it hands a
 * workbook to the runner with the slot free, so a `workbook_busy` refusal costs nothing.
 *
 * In memory: the server is one process (single replica), and a restart that forgets the
 * counts lets a user start at most one more window's worth.
 */

/** Conversions one user may start in a window. */
export const XLSX_STARTS_PER_USER = 10;

/** The window, sliding: a start counts for 15 minutes after it. */
export const XLSX_STARTS_WINDOW_MS = 15 * 60 * 1000;

export class XlsxStartCap {
  /** Each user's starts still in the window, oldest first. */
  private readonly starts = new Map<string, number[]>();

  constructor(
    private readonly max = XLSX_STARTS_PER_USER,
    private readonly windowMs = XLSX_STARTS_WINDOW_MS,
    private readonly now: () => number = Date.now,
  ) {}

  /** Seconds until `userId` may start another conversion: 0 while under the cap. */
  retryAfterSeconds(userId: string): number {
    const at = this.now();
    const times = this.recent(userId, at);
    if (times.length < this.max) return 0;
    // Under the cap again once the start `max` from the end has left the window.
    return Math.max(1, Math.ceil((times[times.length - this.max]! + this.windowMs - at) / 1000));
  }

  /** Count one conversion start for `userId`. */
  record(userId: string): void {
    const at = this.now();
    this.forgetIdle(at);
    const times = this.recent(userId, at);
    times.push(at);
    this.starts.set(userId, times);
  }

  /** How many users have a start in the window (for tests: the map does not grow without bound). */
  get size(): number {
    return this.starts.size;
  }

  private recent(userId: string, at: number): number[] {
    const times = (this.starts.get(userId) ?? []).filter((t) => t > at - this.windowMs);
    if (times.length > 0) this.starts.set(userId, times);
    else this.starts.delete(userId);
    return times;
  }

  /** Drop every user whose last start has left the window. */
  private forgetIdle(at: number): void {
    for (const [userId, times] of this.starts) {
      if (times[times.length - 1]! <= at - this.windowMs) this.starts.delete(userId);
    }
  }
}
