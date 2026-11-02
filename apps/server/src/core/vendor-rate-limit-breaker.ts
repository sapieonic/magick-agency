/**
 * One process-wide pause for the analysis worker when an AI vendor rate-limits it.
 *
 * Each rate-limited job is requeued without using an attempt (the runner's
 * `requeueRateLimited`). That alone does not stop the worker: with N slots, every free
 * slot would claim the next job and hit the same 429, and `requeueRateLimited` restores
 * `attempts`, so a job's own backoff never grows. The breaker sits in front of the claim:
 *
 *  - **closed**: claims as many jobs as there are free slots.
 *  - **open**: a job that started after the last opening hit a rate limit. No claims
 *    until the pause ends. The pause doubles with each consecutive opening
 *    ({@link BREAKER_BASE_PAUSE_MS} up to {@link BREAKER_MAX_PAUSE_MS}, ±20 % jitter).
 *    A rate limit from a job that started before the opening (one already in flight
 *    when the first 429 came back) neither reopens nor escalates it, so eight slots
 *    hitting the same limit count once.
 *  - **half-open**: the pause is over. One probe job at a time until one completes
 *    (closed) or is rate-limited (open again, longer pause).
 *
 * Only `completed` closes it: a job that never reached the vendor proves nothing. The
 * runner also requeues a rate-limited job no earlier than the pause, so another process
 * sharing the queue does not pick it straight back up.
 */

export const BREAKER_BASE_PAUSE_MS = 30_000;
export const BREAKER_MAX_PAUSE_MS = 15 * 60_000;

export type BreakerState = 'closed' | 'open' | 'half_open';

export interface VendorRateLimitBreakerOptions {
  now?: () => number;
  /** Random source for jitter, [0, 1). Injectable so tests are exact. */
  random?: () => number;
}

export type BreakerOpenListener = (pauseMs: number, consecutive: number) => void;

export class VendorRateLimitBreaker {
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly openListeners: BreakerOpenListener[] = [];

  /** Consecutive openings without a completed job in between. 0 = closed. */
  private consecutive = 0;
  /** When the current pause ends (epoch ms). */
  private openUntil = 0;
  /** When the breaker last opened; jobs that started before it cannot reopen or close it. */
  private openedAt = Number.NEGATIVE_INFINITY;
  private probeInFlight = false;

  constructor(opts: VendorRateLimitBreakerOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.random = opts.random ?? Math.random;
  }

  /** Be told each time the breaker opens (metrics, logs). */
  onOpenListener(listener: BreakerOpenListener): void {
    this.openListeners.push(listener);
  }

  get state(): BreakerState {
    if (this.consecutive === 0) return 'closed';
    return this.now() < this.openUntil ? 'open' : 'half_open';
  }

  /** Milliseconds until the pause ends; 0 when not open. */
  reopensInMs(): number {
    return this.state === 'open' ? this.openUntil - this.now() : 0;
  }

  /** How many of `wanted` jobs may be claimed now. */
  admit(wanted: number): number {
    switch (this.state) {
      case 'closed': return wanted;
      case 'open': return 0;
      case 'half_open': return this.probeInFlight ? 0 : Math.min(wanted, 1);
    }
  }

  /** The worker started `count` jobs it was admitted for. */
  onStarted(count: number): void {
    if (count > 0 && this.state === 'half_open') this.probeInFlight = true;
  }

  /** A job finished (any outcome). Frees the half-open probe. */
  onFinished(): void {
    this.probeInFlight = false;
  }

  /**
   * A job that started at `startedAt` was rate-limited. Opens (or escalates) the
   * breaker unless that job predates the current opening. Returns the seconds left in
   * the pause, for the job's own requeue backoff.
   */
  recordRateLimit(startedAt: number): number {
    if (startedAt >= this.openedAt && this.state !== 'open') {
      this.consecutive++;
      const base = Math.min(BREAKER_BASE_PAUSE_MS * 2 ** (this.consecutive - 1), BREAKER_MAX_PAUSE_MS);
      const pauseMs = Math.round(base * (0.8 + this.random() * 0.4));
      this.openedAt = this.now();
      this.openUntil = this.openedAt + pauseMs;
      for (const listener of this.openListeners) listener(pauseMs, this.consecutive);
    }
    return Math.ceil(this.reopensInMs() / 1000);
  }

  /**
   * Another analysis process sharing the queue (and the vendor key) was rate-limited
   * and opened its breaker until `untilMs`, after `consecutive` openings
   * (`docs/scaling.md` decision D10, relayed by the primary over IPC). Pause here too,
   * so one 429 pauses the fleet rather than each process finding it out with jobs of its
   * own. Takes the later end and the higher count; never shortens a pause this process
   * already holds. Counts as an opening for the "started before the opening" rule, so a
   * job already in flight here that comes back rate-limited does not reopen it. The
   * open listeners are NOT called: the opening was another process's, and it already
   * logged, counted and announced it.
   */
  applyRemotePause(untilMs: number, consecutive: number): void {
    const now = this.now();
    if (untilMs <= now) return;
    if (this.state === 'open' && untilMs <= this.openUntil) return;
    this.consecutive = Math.max(this.consecutive, consecutive);
    this.openedAt = now;
    this.openUntil = Math.max(this.openUntil, untilMs);
  }

  /** A job that started at `startedAt` completed: closes the breaker unless that job predates the opening. */
  recordSuccess(startedAt: number): void {
    if (startedAt < this.openedAt) return;
    this.consecutive = 0;
    this.openUntil = 0;
  }
}
