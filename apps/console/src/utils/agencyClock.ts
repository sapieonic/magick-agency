/**
 * Server-corrected clock for the Agent Console (the requirement:
 * *matches the server's timer within a second and does not drift over a shift*).
 *
 * Three independent things would each break that criterion, and this module is
 * the answer to the first two. The third (background tab throttling) belongs to
 * the hook that drives repaints, because it is a lifecycle concern.
 *
 * ── 1. The client's wall clock is wrong ──────────────────────────────────────
 * `since`, `bridged_at` and `ends_at` are **server** ISO-8601 timestamps.
 * Agency-floor machines are not reliably NTP-synced and a clock can be minutes
 * out, which would put the countdown minutes out — looking exactly like a
 * product bug and reproducing on nobody's development machine.
 *
 * The heartbeat already carries what is needed, so the fix costs nothing: `ping`
 * sends `ts` (client epoch ms), `pong` echoes it and adds `server_ts`.
 *
 * ── 2. Interval accumulation ─────────────────────────────────────────────────
 * The classic drift is `remaining -= 1` on a 1s interval: browser timers are
 * late by a few milliseconds every tick and the error compounds. Over one 30s
 * wrap-up it is invisible; over the two hundred wrap-ups of a shift it is
 * exactly the failure the criterion names.
 *
 * **The rule this module exists to enforce: the interval is a repaint trigger,
 * never a time source.** Every computation here derives from an absolute anchor
 * and the corrected present. Nothing accumulates, so there is nothing to drift.
 */

/**
 * How many `pong` samples the offset is taken over.
 *
 * The estimator is a **median, not a mean**: one 3-second wifi stall poisons a
 * mean for the rest of the shift, while a median shrugs it off as long as most
 * of the window is healthy. Five is small enough to track a client clock that is
 * itself drifting — or that jumps when NTP finally lands, or at a DST change on a
 * badly-configured machine — and large enough that a single bad sample cannot
 * move it.
 */
export const CLOCK_SAMPLE_WINDOW = 5;

/**
 * Repaint cadence for every countdown in the console.
 *
 * 250ms rather than 1s **even though the display is in whole seconds**: at 1s the
 * visible digit can lag the true boundary by nearly a full second, which is the
 * entire tolerance spent on repaint alone. At 250ms the digit changes within
 * 250ms of the boundary, leaving margin for a slow frame.
 */
export const CLOCK_REPAINT_MS = 250;

export interface ClockSample {
  /** Client epoch ms echoed back from our `ping`. */
  ts: number;
  /** Server epoch ms at the moment it was handled. */
  server_ts: number;
  /** Client epoch ms when the `pong` was received. */
  receivedAt: number;
}

/**
 * One offset estimate, in ms, to be **subtracted** from a server timestamp to
 * express it in client time.
 *
 * ```
 * rtt    = receivedAt − ts
 * offset = server_ts − (ts + rtt / 2)
 * ```
 *
 * The `rtt / 2` term assumes a symmetric round trip. That assumption is wrong in
 * detail on any real network, but it is wrong by a fraction of an RTT — tens of
 * milliseconds — against a tolerance of a second, and the median across samples
 * absorbs the asymmetry that remains.
 */
export function offsetFromSample(sample: ClockSample): number {
  const rtt = sample.receivedAt - sample.ts;
  return sample.server_ts - (sample.ts + rtt / 2);
}

/** Median of a non-empty list. Even counts take the mean of the middle pair. */
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid]!;
  return (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * Rolling offset estimator. Immutable — `push` returns a new estimator — so it
 * can live in React state without an in-place mutation that skips a render.
 */
export class ClockOffsetEstimator {
  private constructor(private readonly samples: readonly number[]) {}

  static empty(): ClockOffsetEstimator {
    return new ClockOffsetEstimator([]);
  }

  push(sample: ClockSample): ClockOffsetEstimator {
    const next = [...this.samples, offsetFromSample(sample)];
    return new ClockOffsetEstimator(next.slice(-CLOCK_SAMPLE_WINDOW));
  }

  /**
   * The current correction in ms.
   *
   * **Zero until the first sample lands**, which is deliberate: before any pong
   * the honest position is "we have no reason to believe the clock is wrong", and
   * assuming an offset we have not measured would be worse than assuming none.
   */
  get offsetMs(): number {
    return this.samples.length === 0 ? 0 : median([...this.samples]);
  }

  get sampleCount(): number {
    return this.samples.length;
  }
}

/**
 * Convert a server instant (ISO-8601 or epoch ms) into client-clock ms.
 *
 * Returns `null` for null/undefined/unparseable input rather than `NaN` or
 * `0` — `0` is 1970 and would render as a wildly expired deadline, which is the
 * single worst thing a countdown can do. A caller that gets `null` renders no
 * digits, which is always the correct fallback here.
 */
export function correctedInstant(
  serverInstant: string | number | null | undefined,
  offsetMs: number,
): number | null {
  if (serverInstant === null || serverInstant === undefined) return null;
  const raw = typeof serverInstant === 'number' ? serverInstant : Date.parse(serverInstant);
  if (!Number.isFinite(raw)) return null;
  return raw - offsetMs;
}

/**
 * Milliseconds elapsed since a server anchor, floored at zero.
 *
 * Used by the talk timer and the break elapsed time. Floored because a small
 * positive offset error on a just-arrived anchor would otherwise render as a
 * negative duration for the first few hundred milliseconds.
 */
export function elapsedSince(
  anchor: string | number | null | undefined,
  offsetMs: number,
  now: number,
): number | null {
  const corrected = correctedInstant(anchor, offsetMs);
  if (corrected === null) return null;
  return Math.max(0, now - corrected);
}

/**
 * Milliseconds remaining until a server deadline, **clamped at zero**.
 *
 * The clamp is normative rather than defensive. Reaching the deadline is not the
 * end of wrap-up — wrap-up ends on `agent_state` — so the console must tolerate
 * the present passing `ends_at` while still in wrap-up. Without the clamp that
 * case renders a negative countdown, and a negative countdown shown to an agent
 * is an overrun timer: a surveillance surface whose effect is rushed, low-quality
 * dispositions, which is the exact data failure the wrap-up window exists to
 * prevent.
 */
export function remainingUntil(
  deadline: string | number | null | undefined,
  offsetMs: number,
  now: number,
): number | null {
  const corrected = correctedInstant(deadline, offsetMs);
  if (corrected === null) return null;
  return Math.max(0, corrected - now);
}

/**
 * `m:ss` for a duration in ms. Used for both counting up (talk time) and down
 * (wrap-up), so it is deliberately unsigned — a caller with a negative value has
 * already made a mistake the clamps above exist to prevent.
 *
 * Minutes are not padded and seconds always are, which is how a stopwatch reads.
 * Past an hour it rolls into `h:mm:ss` rather than showing `numbers like 87:12`,
 * which an agent reads as eighty-seven of something before working out it is
 * minutes.
 */
export function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(Math.max(0, ms) / 1000);
  const seconds = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3600);
  const ss = String(seconds).padStart(2, '0');
  if (hours === 0) return `${minutes}:${ss}`;
  return `${hours}:${String(minutes).padStart(2, '0')}:${ss}`;
}
