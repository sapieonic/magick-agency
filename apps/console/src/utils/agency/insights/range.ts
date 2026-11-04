import {
  AGENCY_INSIGHTS_MAX_RANGE_DAYS,
  type AgencyInsightsBucket,
  type AgencyInsightsRange,
} from '../../../types/agency-insights';
import { zoneFormatter, zonedParts } from '../../format/zone';
import { DISPLAY_LOCALE } from '../../format/number';

/**
 * The Insights tab's time range: what the supervisor chose, kept in the URL,
 * and the `[from, to)` instants it means in the CAMPAIGN's time zone.
 *
 * ── The campaign's zone, never the reader's ─────────────────────────────────
 * "Today" on a campaign dialling Pune means the day in Asia/Kolkata, whether the
 * supervisor reading it sits in Pune or London. The server's day buckets are
 * calendar days in the campaign zone (contract header), so a range built in the
 * reader's zone would cut a day bucket in half. The zone comes from
 * `summary.settings.timezone`; a name `Intl` does not know falls back to UTC
 * and says so (`zoneFallback`).
 *
 * ── Days, not instants, in the URL ──────────────────────────────────────────
 * `?range=today`, `?range=yesterday`, `?range=7d`, or `?from=2026-11-01&to=2026-11-03`
 * for a custom range of whole days (both included, as the date pickers read).
 * A link therefore means the same days to whoever opens it, and "today" stays
 * today tomorrow. Anything unrecognised is the lifetime, the default.
 *
 * ── A day starts at the zone's own midnight, found, not assumed ─────────────
 * `zoneDayStart` asks `Intl` what the wall clock reads and corrects for it, so a
 * UTC+05:30 midnight lands on 18:30Z the day before, and a zone whose clocks
 * jump at midnight starts the day at its first real instant. The end is the next
 * day's start (half-open), never a `23:59:59.999` literal (see
 * `agencyAttemptFilters.ts` for what that literal did across a DST change).
 *
 * A range that would run past now ends at now: the server would otherwise answer
 * "every bucket in range, zeros included" with a row of future zeros that reads
 * as a campaign that stopped dialling.
 *
 * ── The lifetime is the server's to cut ─────────────────────────────────────
 * "Lifetime" sends no instants. The server serves the campaign from its
 * `created_at` to now, or, when that is longer than 92 days, the last 92 days
 * ending now with `range.clamped` (the contract's `AgencyInsightsRange`).
 * {@link servedRangeView} turns the served range into what the page says and
 * what its drill-downs send: "Last 92 days" and that window, never "Lifetime"
 * over numbers that are not the lifetime's.
 */

export type InsightsRangePreset = 'lifetime' | 'today' | 'yesterday' | 'last_7_days' | 'custom';

export const INSIGHTS_RANGE_PRESETS: ReadonlyArray<{ id: Exclude<InsightsRangePreset, 'custom'>; label: string }> = [
  { id: 'lifetime', label: 'Lifetime' },
  { id: 'today', label: 'Today' },
  { id: 'yesterday', label: 'Yesterday' },
  { id: 'last_7_days', label: 'Last 7 days' },
];

/** What the supervisor chose. `fromDay`/`toDay` are `YYYY-MM-DD`, both included, custom only. */
export interface InsightsRangeChoice {
  preset: InsightsRangePreset;
  fromDay?: string;
  toDay?: string;
}

/** The `?range=` spelling of each preset. */
const PRESET_PARAM: Record<Exclude<InsightsRangePreset, 'lifetime' | 'custom'>, string> = {
  today: 'today',
  yesterday: 'yesterday',
  last_7_days: '7d',
};

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function isDay(value: string | null): value is string {
  if (!value || !DAY_RE.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number) as [number, number, number];
  const probe = new Date(Date.UTC(y, m - 1, d));
  return probe.getUTCFullYear() === y && probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d;
}

/** URL → choice. A custom range needs both days; anything else is the lifetime. */
export function rangeChoiceFromParams(params: URLSearchParams): InsightsRangeChoice {
  const from = params.get('from');
  const to = params.get('to');
  if (isDay(from) && isDay(to)) return { preset: 'custom', fromDay: from, toDay: to };
  const range = params.get('range');
  for (const [preset, spelling] of Object.entries(PRESET_PARAM)) {
    if (range === spelling) return { preset: preset as InsightsRangePreset };
  }
  return { preset: 'lifetime' };
}

/**
 * Choice → URL, MERGED into the params already there: the range is not the
 * only thing a link to this tab might carry, and a range change must not drop
 * the rest. The range's own three keys are always rewritten, so switching from
 * a custom range to Today leaves no stale `from`.
 */
export function rangeChoiceToParams(choice: InsightsRangeChoice, base?: URLSearchParams): URLSearchParams {
  const params = new URLSearchParams(base);
  params.delete('range');
  params.delete('from');
  params.delete('to');
  if (choice.preset === 'custom') {
    if (choice.fromDay) params.set('from', choice.fromDay);
    if (choice.toDay) params.set('to', choice.toDay);
  } else if (choice.preset !== 'lifetime') {
    params.set('range', PRESET_PARAM[choice.preset]);
  }
  return params;
}

/** A stable identity for a choice, for effect dependencies. */
export function rangeChoiceKey(choice: InsightsRangeChoice): string {
  return choice.preset === 'custom' ? `custom:${choice.fromDay ?? ''}:${choice.toDay ?? ''}` : choice.preset;
}

/** `YYYY-MM-DD` plus `n` calendar days. Pure date arithmetic, no zone involved. */
export function addDaysToDay(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

function dayOf(parts: { year: number; month: number; day: number }): string {
  return `${String(parts.year).padStart(4, '0')}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}

/** The calendar day `at` falls on in `zone`. */
export function zoneDay(zone: string, at: Date): string {
  const formatter = zoneFormatter(zone) ?? zoneFormatter('UTC');
  const parts = formatter ? zonedParts(formatter, at) : null;
  return parts ? dayOf(parts) : at.toISOString().slice(0, 10);
}

/** The zone's UTC offset at `at`, in ms (wall clock minus UTC). */
function offsetAt(formatter: Intl.DateTimeFormat, at: number): number {
  const parts = zonedParts(formatter, new Date(at));
  if (!parts) return 0;
  const wall = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return wall - Math.floor(at / 1000) * 1000;
}

/**
 * The first instant of `day` in `zone`.
 *
 * Two passes of "wall clock minus offset" settle every ordinary day (the second
 * pass corrects a guess that straddled an offset change). Where midnight does
 * not exist (clocks jump forward at 00:00) the candidate lands on the previous
 * day's last hour, and is walked forward to the day's first real instant.
 */
export function zoneDayStart(day: string, zone: string): Date {
  const formatter = zoneFormatter(zone) ?? zoneFormatter('UTC');
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const wall = Date.UTC(y, m - 1, d);
  if (!formatter) return new Date(wall);
  let at = wall - offsetAt(formatter, wall);
  at = wall - offsetAt(formatter, at);
  const parts = zonedParts(formatter, new Date(at));
  if (parts && dayOf(parts) < day) {
    const intoDay = parts.hour * 3600 + parts.minute * 60 + parts.second;
    at += (24 * 3600 - intoDay) * 1000;
  }
  return new Date(at);
}

/** The choice, made concrete: what goes on the wire and what the page says about it. */
export interface InsightsResolvedRange {
  choice: InsightsRangeChoice;
  /** ISO instant, inclusive. Absent for the lifetime. */
  from?: string;
  /** ISO instant, exclusive. Absent for the lifetime. */
  to?: string;
  lifetime: boolean;
  /** "Lifetime", "Today", "1 Nov – 3 Nov 2026". */
  label: string;
  /** The zone the range was computed in (UTC when the campaign's is unknown). */
  timezone: string;
  /** True when the campaign's zone was not one `Intl` knows. */
  zoneFallback: boolean;
  /** A custom range that cannot be sent, in the reader's words. Nothing is fetched. */
  error: string | null;
}

function dayLabel(day: string, withYear: boolean): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return new Intl.DateTimeFormat(DISPLAY_LOCALE, {
    day: 'numeric',
    month: 'short',
    ...(withYear ? { year: 'numeric' } : {}),
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(y, m - 1, d)));
}

/**
 * Resolve a choice in the campaign's zone at `now`.
 *
 * `now` is a parameter so the caller decides when the clock is read: once per
 * range change or Refresh, never per render (a `to` that moved on every render
 * would refetch every render).
 */
export function resolveInsightsRange(
  choice: InsightsRangeChoice,
  campaignZone: string | null | undefined,
  now: Date,
): InsightsResolvedRange {
  const known = Boolean(campaignZone && zoneFormatter(campaignZone));
  const timezone = known ? (campaignZone as string) : 'UTC';
  const base = { choice, timezone, zoneFallback: Boolean(campaignZone) && !known, error: null as string | null };

  if (choice.preset === 'lifetime') return { ...base, lifetime: true, label: 'Lifetime' };

  const today = zoneDay(timezone, now);
  let fromDay: string;
  let endDay: string; // exclusive
  let label: string;
  switch (choice.preset) {
    case 'today':
      fromDay = today;
      endDay = addDaysToDay(today, 1);
      label = 'Today';
      break;
    case 'yesterday':
      fromDay = addDaysToDay(today, -1);
      endDay = today;
      label = 'Yesterday';
      break;
    case 'last_7_days':
      fromDay = addDaysToDay(today, -6);
      endDay = addDaysToDay(today, 1);
      label = 'Last 7 days';
      break;
    case 'custom': {
      const { fromDay: f, toDay: t } = choice;
      if (!f || !t || !isDay(f) || !isDay(t)) {
        return { ...base, lifetime: false, label: 'Custom', error: 'Choose a start and an end date.' };
      }
      label = f === t ? dayLabel(f, true) : `${dayLabel(f, f.slice(0, 4) !== t.slice(0, 4))} – ${dayLabel(t, true)}`;
      if (f > t) return { ...base, lifetime: false, label, error: 'The start date is after the end date.' };
      if (f > today) return { ...base, lifetime: false, label, error: 'The range starts in the future.' };
      fromDay = f;
      endDay = addDaysToDay(t, 1);
      break;
    }
  }

  const fromAt = zoneDayStart(fromDay, timezone);
  const endAt = zoneDayStart(endDay, timezone);
  const toAt = endAt.getTime() > now.getTime() ? now : endAt;
  const days = Math.round((zoneDayStart(endDay, 'UTC').getTime() - zoneDayStart(fromDay, 'UTC').getTime()) / 86_400_000);
  if (days > AGENCY_INSIGHTS_MAX_RANGE_DAYS) {
    return { ...base, lifetime: false, label, error: `A range can cover at most ${AGENCY_INSIGHTS_MAX_RANGE_DAYS} days.` };
  }
  return { ...base, lifetime: false, label, from: fromAt.toISOString(), to: toAt.toISOString() };
}

/** The wire query for a resolved range: both instants, or nothing for the lifetime. */
export function insightsRangeQuery(range: InsightsResolvedRange): { from?: string; to?: string } {
  return range.lifetime ? {} : { from: range.from, to: range.to };
}

/** "Last 92 days": the label of a lifetime the server clamped. */
export const CLAMPED_LIFETIME_LABEL = `Last ${AGENCY_INSIGHTS_MAX_RANGE_DAYS} days`;

/**
 * What the page says about the range and what its drill-downs send, once the
 * server has said what it served. A lifetime the server clamped is labelled
 * {@link CLAMPED_LIFETIME_LABEL} and its links carry the served `[from, to)`, so
 * a number opens the list of exactly the dials it counts; otherwise the label is
 * the choice's and the query is {@link insightsRangeQuery}'s.
 */
export function servedRangeView(
  range: InsightsResolvedRange | null,
  served: Pick<AgencyInsightsRange, 'from' | 'to' | 'lifetime' | 'clamped'> | null | undefined,
): { label: string; query: { from?: string; to?: string } } {
  if (range?.lifetime && served?.lifetime && served.clamped) {
    return { label: CLAMPED_LIFETIME_LABEL, query: { from: served.from, to: served.to } };
  }
  return { label: range?.label ?? 'Lifetime', query: range ? insightsRangeQuery(range) : {} };
}

/** The widest lifetime the server serves, in hours (longer is clamped to it). */
const LIFETIME_MAX_HOURS = AGENCY_INSIGHTS_MAX_RANGE_DAYS * 24;

/** The range's span in hours, using `lifetimeStart` for the lifetime (clamped as the server clamps it); null when unknown. */
function spanHours(range: InsightsResolvedRange, lifetimeStart: string | null, now: Date): number | null {
  if (range.lifetime) {
    if (!lifetimeStart) return null;
    return Math.min(LIFETIME_MAX_HOURS, (now.getTime() - Date.parse(lifetimeStart)) / 3_600_000);
  }
  if (!range.from || !range.to) return null;
  return (Date.parse(range.to) - Date.parse(range.from)) / 3_600_000;
}

/**
 * The bucket widths worth offering for a range. A quarter-hour series over a
 * month is 2,880 columns nobody can read; an hourly one over two weeks is 336.
 */
export function allowedBuckets(range: InsightsResolvedRange, lifetimeStart: string | null, now: Date): AgencyInsightsBucket[] {
  const hours = spanHours(range, lifetimeStart, now);
  if (hours === null) return ['day'];
  const out: AgencyInsightsBucket[] = [];
  if (hours <= 48) out.push('quarter_hour');
  if (hours <= 24 * 14) out.push('hour');
  out.push('day');
  return out;
}

/** The default bucket: hours for up to two days, else days. */
export function defaultBucket(range: InsightsResolvedRange, lifetimeStart: string | null, now: Date): AgencyInsightsBucket {
  const hours = spanHours(range, lifetimeStart, now);
  return hours !== null && hours <= 48 ? 'hour' : 'day';
}

export const BUCKET_LABELS: Record<AgencyInsightsBucket, string> = {
  quarter_hour: '15 minutes',
  hour: 'Hour',
  day: 'Day',
};
