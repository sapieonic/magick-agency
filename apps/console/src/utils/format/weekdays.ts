/**
 * Calling days and times of day, as the campaign screens print them.
 *
 * The campaign builder's echo ("Mon–Fri, 09:00–20:00, Asia/Kolkata") and the
 * campaigns home's schedule line ("09:00–18:00 · Mon–Fri") each had a copy of
 * the day-list phrase and the `HH:MM:SS` trim, and they had drifted: the
 * builder's copy did not drop a day outside 1–7, so a malformed `calling_days`
 * printed "Mon, Tue, undefined".
 */

/** ISO-8601 weekday names, index 0 = Monday (ISO day 1). */
export const ISO_WEEKDAY_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;

/**
 * ISO days (1 = Monday … 7 = Sunday) as the shortest honest phrase: "Every day",
 * "Mon–Fri", "Mon, Wed, Fri". Duplicates are collapsed, out-of-range values are
 * dropped rather than printed, and a list with nothing valid left in it is
 * `null` — each caller words "no days" its own way.
 *
 * Three or more contiguous days read as a range, which is how an operator says
 * it; two adjacent days ("Sat, Sun") stay a list.
 */
export function describeIsoDays(days: readonly number[] | undefined): string | null {
  if (!days || days.length === 0) return null;
  const valid = [...new Set(days)]
    .filter((d) => Number.isInteger(d) && d >= 1 && d <= 7)
    .sort((a, b) => a - b);
  if (valid.length === 0) return null;
  if (valid.length === 7) return 'Every day';

  const contiguous = valid.every((d, i) => i === 0 || d === valid[i - 1]! + 1);
  if (contiguous && valid.length >= 3) {
    return `${ISO_WEEKDAY_SHORT[valid[0]! - 1]}–${ISO_WEEKDAY_SHORT[valid[valid.length - 1]! - 1]}`;
  }
  return valid.map((d) => ISO_WEEKDAY_SHORT[d - 1]).join(', ');
}

/**
 * `09:00:00` → `09:00`. Postgres renders a `TIME` column as `HH:MM:SS`, and both
 * `<input type="time">` and a schedule line want `HH:MM`. Anything not shaped
 * like a time is returned as sent.
 */
export function hhmm(value: string): string {
  return /^\d{2}:\d{2}/.test(value) ? value.slice(0, 5) : value;
}
