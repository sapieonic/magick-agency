/**
 * Durations, in the two shapes this console prints them and under ONE rounding
 * rule per kind of quantity.
 *
 * ── Live timers floor; aggregate statistics round ──────────────────────────
 * A running clock — talk time on a live call, a wrap-up countdown, time on
 * break — must never show a second that has not elapsed, so {@link formatDuration}
 * floors. An aggregate — an average handle time, a percentile, an occupancy
 * total — is a measured quantity the server may serve as a fraction (a
 * `percentile_cont` of 59.6s), and the honest rendering is the nearest second.
 * Before this rule the roster's AHT cell floored that 59.6s to `0:59` while the
 * AHT band beside it rounded the same quantity to `1m`: one number, two values.
 *
 * ── Cells keep the stopwatch, sentences name the unit ──────────────────────
 * {@link statClock} is `m:ss` / `h:mm:ss`, right in a right-aligned numeric
 * column where a reader compares lengths. {@link durationWords} says the units
 * — `1m 14s`, `31h 40m` — for prose, where a stopwatch fails worst on the
 * figures that matter most (`4800:00:00 handled of 8000:00:00 on shift`, or a
 * `median 22:00` distinguishable from twenty-two HOURS only by counting colons).
 * Both round, so the cell and the sentence can never disagree.
 */

/** Whole seconds as a stopwatch: `m:ss`, rolling to `h:mm:ss`. */
function clock(totalSeconds: number): string {
  const seconds = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3600);
  const ss = String(seconds).padStart(2, '0');
  if (hours === 0) return `${minutes}:${ss}`;
  return `${hours}:${String(minutes).padStart(2, '0')}:${ss}`;
}

/**
 * `m:ss` for a LIVE duration in ms — floored. Used for both counting up (talk
 * time) and down (wrap-up), so it is deliberately unsigned: a caller with a
 * negative value has already made a mistake the clamps in `agencyClock` exist to
 * prevent.
 *
 * Minutes are not padded and seconds always are, which is how a stopwatch reads.
 * Past an hour it rolls into `h:mm:ss` rather than showing numbers like `87:12`,
 * which an agent reads as eighty-seven of something before working out it is
 * minutes.
 */
export function formatDuration(ms: number): string {
  return clock(Math.floor(Math.max(0, ms) / 1000));
}

/**
 * An AGGREGATE duration in seconds, as a stopwatch — rounded to the nearest
 * second. `0` renders `0:00`; a real zero is a finding, not an absence.
 */
export function statClock(seconds: number): string {
  return clock(Math.max(0, Math.round(seconds)));
}

/**
 * An AGGREGATE duration in seconds, with its units said out loud — `45s`,
 * `1m 14s`, `2h 15m`. Rounded to the nearest second, like {@link statClock}.
 *
 * Seconds are dropped once there is an hour, and a zero component is omitted
 * rather than padded — `2h` rather than `2h 0m`, because the reader is being told
 * a magnitude, not read a clock.
 */
export function durationWords(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  if (total < 60) return `${total}s`;
  if (total < 3600) {
    const minutes = Math.floor(total / 60);
    const secs = total % 60;
    return secs === 0 ? `${minutes}m` : `${minutes}m ${secs}s`;
  }
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
}

/**
 * A finished call's recorded length (whole seconds from the server) as a
 * stopwatch, or `--` when there is nothing to show — absent, or zero, which on a
 * call record means "never connected" rather than a measured instant.
 */
export function callSeconds(seconds: number | null | undefined): string {
  if (seconds == null || seconds <= 0) return '--';
  return statClock(seconds);
}
