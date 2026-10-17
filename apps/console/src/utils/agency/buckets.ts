import { formatDayMonth } from '../format/date';
import type { AgencyAgentStatsBucket } from '../../types/agency-stats';

/*
  The day-wise series both the per-agent chart and the campaign series read:
  `bucket_start` parsed as a calendar day on the reader's calendar, and its axis
  label and title. Out of `agencyAgentPerformance.ts`, which re-exports it.
*/

export interface SeriesPoint {
  /** The bucket's own `YYYY-MM-DD` start, unchanged, used as the key. */
  start: string;
  /** A short axis label — day of the month, in the reader's locale. */
  label: string;
  /** The full date, for the tooltip and the accessible name. */
  title: string;
  attempts: number;
  connected: number;
}

export interface BucketSeries {
  points: SeriesPoint[];
  /** The tallest bar's value, and the axis top. At least 1, so nothing divides by 0. */
  max: number;
  /**
   * True only when there is enough to draw.
   *
   * **A one-bucket range is not a chart.** A single-column bar chart is a stat
   * tile wearing axes — the anti-pattern the tiles above already cover properly
   * — so a range of one day declines to draw and says which range would.
   */
  drawable: boolean;
}

/**
 * `YYYY-MM-DD` and nothing else — the only spelling `bucket_start` has.
 *
 * The server formats the label in SQL with `to_char` **precisely so that no zone
 * attaches to it** (`bucketStartSql`; node-pg would otherwise parse a bare
 * `timestamp` into a local-time `Date` and put the server's zone back on a value
 * the query went to some trouble to remove). It is a calendar day in the
 * campaign's own zone, not an instant.
 */
const BUCKET_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * A bucket label as a date on the READER's calendar, or `null` if it is not one.
 *
 * ── Why the components are parsed by hand ───────────────────────────────────
 * `new Date('2026-08-20')` is the one date literal JS parses as **UTC midnight**
 * (ES2015 pinned it: a date-only form is UTC, a date-time form without an offset
 * is local). Every reader of the resulting `Date` here — `getDate()`,
 * `toLocaleDateString()` — then works in LOCAL time, so everywhere west of
 * Greenwich the label came out a day early: under `America/New_York`,
 * `new Date('2026-08-20').getDate()` is `19`. Every bar label, tooltip, peak
 * label and accessible-table row for the whole of the Americas was off by one.
 *
 * `bucket_start` names a DAY, not an instant, so it is built as one — with the
 * reader's own calendar, which is the only calendar the label is read on.
 *
 * ── Exported, because the campaign series parses the same labels ───────────
 * `GET /agency/campaigns/:id/stats/series` mirrors `AgencyAgentStatsBucket`
 * field-for-field precisely so this function serves both. A second copy in
 * `agencyCampaignSeries.ts` would be a second place for the two rules above —
 * parse the components, anchor at noon — to be re-learned the hard way.
 *
 * ── Noon, not midnight ──────────────────────────────────────────────────────
 * Some zones move their clocks AT midnight (Cuba and Chile spring forward at
 * 00:00; Lebanon falls back at 00:00), so local midnight is a time that either
 * does not exist or exists twice. Noon exists exactly once in every zone there
 * has ever been, so anchoring there makes the round-trip check below exact
 * rather than something that happens to hold outside two Sundays a year.
 *
 * `setFullYear` is not decoration: the two-digit-year legacy behaviour of the
 * `Date` constructor maps a year below 100 to 1900+n.
 */
export function bucketDay(raw: string): Date | null {
  const match = BUCKET_DAY.exec(raw);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);

  const parsed = new Date(year, month - 1, day, 12);
  parsed.setFullYear(year);
  /*
    A rolled-over date is not the date that was sent. `new Date(2026, 12, 45)`
    is a perfectly good `Date` for February 2027, and labelling a bar with it
    would be worse than labelling it with the raw string the server sent.
  */
  if (
    parsed.getFullYear() !== year
    || parsed.getMonth() !== month - 1
    || parsed.getDate() !== day
  ) {
    return null;
  }
  return parsed;
}

/**
 * A bucket's axis label (the day of the month) and its title (`20 Aug`), or the
 * raw `bucket_start` for both when it is not a day — a malformed label is shown
 * as sent rather than dropped. Shared with the campaign series, whose buckets
 * carry the same `YYYY-MM-DD` labels.
 */
export function bucketLabels(raw: string): { label: string; title: string } {
  const parsed = bucketDay(raw);
  return parsed
    ? { label: String(parsed.getDate()), title: formatDayMonth(parsed) }
    : { label: raw, title: raw };
}

/**
 * The series for the chart.
 *
 * Buckets arrive oldest-first and are **not re-sorted**: the order is the
 * server's, and re-deriving it here would give the screen a second opinion about
 * a sequence the API already ordered. A malformed `bucket_start` is kept as a
 * point with its raw value as the label rather than dropped — losing a bucket
 * would break the property that the bars sum to the totals, which is the one
 * thing this chart can be checked against.
 *
 * The label is the day the server named, read on the reader's calendar — see
 * {@link bucketDay} for the off-by-one that made that worth spelling out.
 */
export function bucketSeries(buckets: AgencyAgentStatsBucket[] | undefined): BucketSeries {
  const rows = buckets ?? [];
  const points: SeriesPoint[] = rows.map((bucket) => ({
    start: bucket.bucket_start,
    ...bucketLabels(bucket.bucket_start),
    attempts: bucket.attempts,
    connected: bucket.connected,
  }));

  const max = points.reduce((top, point) => Math.max(top, point.attempts, point.connected), 0);
  return { points, max: Math.max(max, 1), drawable: points.length >= 2 };
}

/**
 * The note that goes beside the chart.
 *
 * ── Why this is on screen rather than in a comment ──────────────────────────
 * The server buckets an attempt by its CAMPAIGN'S timezone, because that is the
 * timezone the campaign's calling window is enforced in. Every attempt lands in
 * exactly one bucket, so the bars sum to the totals exactly — but for an agent
 * working a Mumbai campaign and a London one, a "day" is not one contiguous
 * 24-hour window, and two bars can cover overlapping wall-clock hours.
 *
 * Left unsaid, that is a reader spotting an inconsistency and filing a bug
 * against a number that is correct. Said in implementation vocabulary
 * ("buckets are cut per-campaign in the campaign's tz") it is a sentence an
 * agent cannot use. So it is said in the product's words, once, next to the
 * thing it explains.
 */
export const BUCKET_TIMEZONE_NOTE =
  'Each day is counted in its own campaign’s local time. If you work campaigns in '
  + 'different time zones, two days here can overlap — the totals are still exact, '
  + 'because every call belongs to one day only.';

/** Why there is no chart yet, for a range with a single day in it. */
export const SINGLE_BUCKET_NOTE =
  'A day-by-day chart needs more than one day. Switch to this week or this month to see one.';
