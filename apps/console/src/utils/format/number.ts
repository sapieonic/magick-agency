/**
 * Counts, percentages and plurals — the one rendering of each for the console's
 * analytics surfaces.
 *
 * ── One locale, not the reader's ────────────────────────────────────────────
 * Every count goes through one cached `Intl.NumberFormat('en-IN')`, the locale
 * `@magick-agency/web-ui/format` already used for dates. These surfaces used
 * to mix the two: `toLocaleString()` with no argument (whatever the browser is
 * set to, 44 call sites) beside `en-IN` captions, so one screen could print
 * `1,00,000` in a header and `100,000` in the table under it. The product is
 * read in Indian offices, and lakh grouping is what its readers write.
 *
 * Only the separator changes below 1,00,000 — `12,345` reads the same either way.
 */

/** The display locale for every number and date on these surfaces. */
export const DISPLAY_LOCALE = 'en-IN';

const COUNT_FORMAT = new Intl.NumberFormat(DISPLAY_LOCALE);

/** A count, grouped the way the product's readers write it: `12,34,567`. */
export function formatCount(value: number): string {
  return COUNT_FORMAT.format(value);
}

/**
 * A percentage: one decimal, trailing zero trimmed — `18%`, `18.4%`, never
 * `18.0%`. A `.0` reads as a measurement with false precision the denominator
 * cannot support, and one product must not print `18%` on one screen and
 * `18.0%` on the next.
 */
export function pct(value: number): string {
  return `${Number(value.toFixed(1))}%`;
}

/**
 * A count and its noun, agreeing: `1 dial`, `2 dials`, `1 retry`, `3 retries`.
 * The plural defaults to `singular + 's'`; pass it for anything irregular.
 */
export function plural(n: number, singular: string, many = `${singular}s`): string {
  return `${formatCount(n)} ${n === 1 ? singular : many}`;
}

/** A meter is never drawn outside its own track: 0–100, and `0` for a non-finite value. */
export function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}
