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
 *
 * **Visibility.** Each opening tells its listeners why (the vendor's own words, when the
 * runner has them) and since when the vendor has refused every job; a close tells them how
 * long that lasted. From {@link PERSISTENT_RATE_LIMIT_PAUSES} consecutive openings on (about
 * 45 minutes with no analysis completed) it is not a short rate limit any more but an
 * exhausted quota or a billing stop, and the worker says so at error level.
 */

export const BREAKER_BASE_PAUSE_MS = 30_000;
export const BREAKER_MAX_PAUSE_MS = 15 * 60_000;

/**
 * Consecutive openings from which the refusal is persistent: 30 s + 1 + 2 + 4 + 8 min reach the
 * 15-minute cap at the sixth, so the eighth comes ~45 minutes after the first with every probe
 * refused. The alert `agy-analysis-vendor-refusing` uses the same count.
 */
export const PERSISTENT_RATE_LIMIT_PAUSES = 8;

/** Why the vendor refused a job, as far as it said: for logs only. */
export interface RateLimitCause {
  /** Which call was refused: transcribing the recording or analysing the transcript (each has its own key). */
  stage?: 'transcribe' | 'analyze';
  provider?: string;
  status?: number;
  vendorCode?: string;
  quotaIds?: string[];
  retryAfterSeconds?: number;
  /** The vendor's message (or the error's), trimmed. */
  reason: string;
}

/**
 * A cause as flat log fields: `stage`, `vendor`, `vendorStatus`, `vendorCode`, `quotaIds`
 * (comma-joined, so Loki keeps it as one readable field), `vendorRetryAfterSeconds`, `vendorReason`.
 */
export function rateLimitLogFields(cause: RateLimitCause | undefined): Record<string, string | number> {
  if (!cause) return {};
  const fields: Record<string, string | number> = { vendorReason: cause.reason };
  if (cause.stage) fields.stage = cause.stage;
  if (cause.provider) fields.vendor = cause.provider;
  if (cause.status !== undefined) fields.vendorStatus = cause.status;
  if (cause.vendorCode) fields.vendorCode = cause.vendorCode;
  if (cause.quotaIds?.length) fields.quotaIds = cause.quotaIds.join(',');
  if (cause.retryAfterSeconds !== undefined) fields.vendorRetryAfterSeconds = cause.retryAfterSeconds;
  return fields;
}

export interface BreakerOpenInfo {
  /** When the vendor started refusing (the first opening of this run of openings), epoch ms. */
  since: number;
  /** Why this opening's job was refused, when the runner knew. */
  cause?: RateLimitCause;
}

export interface BreakerCloseInfo {
  /** When the refusals began, epoch ms. */
  since: number;
  /** Openings in the run that just ended. */
  pauses: number;
}

export type BreakerState = 'closed' | 'open' | 'half_open';

export interface VendorRateLimitBreakerOptions {
  now?: () => number;
  /** Random source for jitter, [0, 1). Injectable so tests are exact. */
  random?: () => number;
}

export type BreakerOpenListener = (pauseMs: number, consecutive: number, info: BreakerOpenInfo) => void;
export type BreakerCloseListener = (info: BreakerCloseInfo) => void;

export class VendorRateLimitBreaker {
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly openListeners: BreakerOpenListener[] = [];
  private readonly closeListeners: BreakerCloseListener[] = [];

  /** Consecutive openings without a completed job in between. 0 = closed. */
  private consecutive = 0;
  /** When the current pause ends (epoch ms). */
  private openUntil = 0;
  /** When the breaker last opened; jobs that started before it cannot reopen or close it. */
  private openedAt = Number.NEGATIVE_INFINITY;
  private probeInFlight = false;
  /** The end of a pause applied from another process ({@link applyRemotePause}); 0 when none. */
  private remoteUntil = 0;
  /** When this run of openings began (epoch ms); meaningful only while not closed. */
  private since = 0;

  constructor(opts: VendorRateLimitBreakerOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.random = opts.random ?? Math.random;
  }

  /** Be told each time the breaker opens (metrics, logs). */
  onOpenListener(listener: BreakerOpenListener): void {
    this.openListeners.push(listener);
  }

  /** Be told when a completed job closes it again after one or more openings. */
  onCloseListener(listener: BreakerCloseListener): void {
    this.closeListeners.push(listener);
  }

  /** When the vendor started refusing (epoch ms), or null while closed. */
  get refusingSince(): number | null {
    return this.consecutive === 0 ? null : this.since;
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

  /**
   * The worker started `count` jobs it was admitted for. True when they are the half-open
   * probe (admitted one at a time): the caller hands that back to {@link onFinished}.
   */
  onStarted(count: number): boolean {
    if (count > 0 && this.state === 'half_open') {
      this.probeInFlight = true;
      return true;
    }
    return false;
  }

  /**
   * A job finished (any outcome). Only the probe frees the half-open slot: a job that
   * started before the breaker opened (still in flight from the closed state) finishing
   * says nothing about the probe, and freeing the slot then would let a second probe run
   * beside the first.
   */
  onFinished(wasProbe: boolean): void {
    if (wasProbe) this.probeInFlight = false;
  }

  /**
   * A job that started at `startedAt` was rate-limited. Opens (or escalates) the
   * breaker unless that job predates the current opening. Returns the seconds left in
   * the pause, for the job's own requeue backoff.
   */
  recordRateLimit(startedAt: number, cause?: RateLimitCause): number {
    if (startedAt >= this.openedAt && this.state !== 'open') {
      if (this.consecutive === 0) this.since = this.now();
      this.consecutive++;
      const base = Math.min(BREAKER_BASE_PAUSE_MS * 2 ** (this.consecutive - 1), BREAKER_MAX_PAUSE_MS);
      const pauseMs = Math.round(base * (0.8 + this.random() * 0.4));
      this.openedAt = this.now();
      this.openUntil = this.openedAt + pauseMs;
      const info: BreakerOpenInfo = cause ? { since: this.since, cause } : { since: this.since };
      for (const listener of this.openListeners) listener(pauseMs, this.consecutive, info);
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
    if (this.consecutive === 0) this.since = now;
    this.consecutive = Math.max(this.consecutive, consecutive);
    this.openedAt = now;
    this.openUntil = Math.max(this.openUntil, untilMs);
    this.remoteUntil = this.openUntil;
  }

  /** A job that started at `startedAt` completed: closes the breaker unless that job predates the opening. */
  recordSuccess(startedAt: number): void {
    if (startedAt < this.openedAt) return;
    // A pause another process applied runs to its end: a job here that slipped through
    // (its claim was already on the way) succeeding says nothing about the vendor key the
    // whole fleet shares. Local openings keep their rule, as before.
    if (this.now() < this.remoteUntil) return;
    const pauses = this.consecutive;
    this.consecutive = 0;
    this.openUntil = 0;
    if (pauses > 0) {
      for (const listener of this.closeListeners) listener({ since: this.since, pauses });
    }
  }
}
