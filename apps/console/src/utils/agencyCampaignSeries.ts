import { addDays, differenceInCalendarDays, startOfDay } from 'date-fns';
import { bucketDay } from './agencyAgentPerformance';
import { RATE_MIN_ATTEMPTS } from './agencyCampaignPerformance';
import { isTerminalCampaignStatus } from './agencyCampaignControls';
import type { AgencyCampaignSeries } from '../types/agency-campaign-series';

/**
 * The campaign workspace's TIME dimension — the range picker behind
 * `GET /agency/campaigns/:id/stats/series`, and the two charts drawn from it.
 *
 * A LEAF module: pure functions over data, no React, no formatting decisions
 * left to a component. Same reasoning as `agencyCampaignOverview` and
 * `agencyCampaignPerformance` — every value here is a claim about a campaign
 * derived from counts that may legitimately be zero, and a derivation inlined
 * into JSX is a claim no test can reach.
 *
 * ── The rule the whole module is built around, again ───────────────────────
 * **A rate whose denominator is zero is `null`, never `0`.** The workspace
 * already carries that rule on `abandonment_rate_24h_pct`, on `success_rate_pct`
 * and on the pulse strip; a LINE CHART is where breaking it is most expensive.
 * A Sunday with no dials plotted at 0% does not read as "we did not dial on
 * Sunday" — it reads as a cliff, and a supervisor acts on a cliff. So a bucket
 * with no denominator produces a **gap in the line**, and the line is drawn as
 * runs of consecutive measured points rather than as one path.
 *
 * ── And a rate off a handful of calls is not published at all ──────────────
 * {@link RATE_MIN_ATTEMPTS} is imported from the Performance section rather
 * than restated: one THRESHOLD, so nobody can raise the bar on one section of
 * the workspace and leave the other publishing below it.
 *
 * It is not the same TEST, and the distinction matters. There it guards a
 * lifetime figure against `attempts_total`; here it guards each DAY against that
 * day's own denominator — dials for the connect rate, calls that reached a
 * person for conversion. So a one-day campaign of 30 dials and 5 conversations
 * publishes a lifetime conversion rate on the card and withholds that same day's
 * point on the chart. Both are right for what they are measuring, and neither
 * "disagrees" with the other; what would be wrong is a reader taking the gap as
 * a claim about the card. A day of four dials swinging
 * between 0% and 50% is noise drawn as a trend, which is worse than a gap,
 * because a gap says what it is.
 */

// ── The range ───────────────────────────────────────────────────────────────

/**
 * The windows offered above the charts.
 *
 * Four, and `life` is the one that needs justifying: the other three are
 * relative to today and are useless on a campaign that stopped last month —
 * which is the primary case for this workspace, not an edge of it. `life` needs
 * `started_at`, which is why the contract for it and the contract for the series
 * shipped together; {@link campaignSeriesWindows} withholds it when the
 * timestamp is absent rather than guessing a start.
 */
export type CampaignSeriesWindow = '7d' | '14d' | '30d' | 'life';

export const CAMPAIGN_SERIES_WINDOWS: readonly CampaignSeriesWindow[] = [
  '7d',
  '14d',
  '30d',
  'life',
];

export const CAMPAIGN_SERIES_WINDOW_LABELS: Record<CampaignSeriesWindow, string> = {
  '7d': 'Last 7 days',
  '14d': 'Last 14 days',
  '30d': 'Last 30 days',
  life: 'Whole campaign',
};

/**
 * The server's own cap, restated so the client never forms a request the dialer runtime will refuse.
 *
 * A campaign that ran longer is not an error and is not truncated silently: the
 * range keeps the MOST RECENT 92 days and {@link campaignSeriesRangeNote} says
 * so in words. An invisible truncation on a chart is a chart that lies about
 * what it covers.
 */
export const CAMPAIGN_SERIES_MAX_DAYS = 92;

export interface CampaignSeriesRange {
  /** ISO-8601 instant. **Inclusive** — the start of the first local day shown. */
  from: string;
  /** ISO-8601 instant. **Exclusive** — the start of the day after the last one. */
  to: string;
  /** Whole days in `[from, to)`. */
  days: number;
  /** True when the range was cut to {@link CAMPAIGN_SERIES_MAX_DAYS}. */
  clamped: boolean;
  /**
   * True for a finished campaign whose `ended_at` we were never told.
   *
   * The window then runs FORWARD from the start rather than back from today, so
   * it covers the campaign rather than the weeks since — and the note beside the
   * chart says the end date is unknown instead of claiming a truncation.
   */
  endUnknown: boolean;
  /** True when the last day in the range is today, so it is still filling. */
  partialToday: boolean;
}

/**
 * The two campaign fields every range decision reads.
 *
 * Structural rather than `AgencyCampaign`, because the hook holds these two as
 * primitives — depending on the whole campaign object there would re-request 92
 * buckets on every 10s poll of the page above, since the stats read hands down a
 * fresh object each tick. An `AgencyCampaign` satisfies it as it stands.
 */
export interface CampaignLifespan {
  started_at?: string | null;
  ended_at?: string | null;
  /**
   * Whether the campaign has finished — the authority on every decision here.
   *
   * **`ended_at` is not that authority and must never be used as it.** It is
   * optional on the row precisely because an API that predates the lifecycle
   * timestamps does not send it, and this console talks to whatever API is
   * deployed. Keying "has it finished?" on the timestamp made a campaign that
   * stopped in July default to the last 14 days — fourteen empty bars under a
   * heading promising a trend — and print "today is still in progress" beneath
   * them. Both are statements about a live campaign, made about a dead one.
   *
   * A BOOLEAN rather than the status string, and the caller derives it with
   * `isTerminalCampaignStatus` — the repo's single definition of finished. Two
   * reasons: this module never has a use for `paused` versus `running`, so
   * taking the string would invite it to grow one; and a caller that memoises on
   * its input (`useCampaignSeries` does) would re-read on every status change
   * rather than on the one that moves a boundary.
   */
  finished?: boolean;
}

/**
 * A calendar day, anchored at local NOON rather than local midnight.
 *
 * ── Why noon, and why this is not decoration ──────────────────────────────
 * `addDays` preserves the wall-clock time of its anchor. In a zone whose DST
 * transition is at midnight — Chile, Paraguay, Cuba, Lebanon — local midnight on
 * the transition day **does not exist**, so `startOfDay` resolves to 01:00 and
 * every boundary walked from it inherits that hour.
 *
 * Measured, before this was fixed, in `America/Santiago` on 2026-09-06 (the
 * spring-forward): a "last 7 days" range came back as
 * `[2026-08-31T05:00Z, 2026-09-07T04:00Z)` where local midnight on those two
 * days is `04:00Z` and `03:00Z`. The window therefore EXCLUDED the first hour of
 * the first day on the chart and INCLUDED the first hour of the day after the
 * last one — attempts from a day not on the chart counted, attempts from a day
 * on it did not.
 *
 * Noon exists exactly once in every zone there has ever been, so days are walked
 * from noon and each boundary is turned into a real midnight with `startOfDay`
 * at the end. This is the rule `bucketDay` already carries for parsing the
 * server's labels; it applies just as hard to building the range.
 */
function noonOf(value: Date): Date {
  const day = startOfDay(value);
  day.setHours(12, 0, 0, 0);
  return day;
}

/** The day a campaign first dialed, or `null` when it never did / we weren't told. */
function startedDay(campaign: CampaignLifespan | null): Date | null {
  const raw = campaign?.started_at;
  if (!raw) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : noonOf(parsed);
}

/**
 * A campaign row as this module wants it.
 *
 * The ONE place a status becomes a `finished` boolean, so no caller has to
 * remember to derive it and no two callers can derive it differently. Everything
 * below takes {@link CampaignLifespan}, which is deliberately a boolean rather
 * than the string — see that type for why.
 */
export function campaignLifespan(
  campaign: { status?: string | null; started_at?: string | null; ended_at?: string | null } | null,
): CampaignLifespan {
  return {
    started_at: campaign?.started_at ?? null,
    ended_at: campaign?.ended_at ?? null,
    finished: isTerminalCampaignStatus(campaign?.status),
  };
}

/** Whether the campaign has finished — never inferred from `ended_at`. */
function finished(campaign: CampaignLifespan | null): boolean {
  return campaign?.finished === true;
}

/**
 * The day a campaign reached a terminal status, or `null`.
 *
 * `null` means "we were not told when", which is NOT the same as "it is still
 * running" — see {@link finished}. A finished campaign with no `ended_at` still
 * gets a range ending today, because today is the best upper bound available;
 * what it must not get is a note claiming today is still filling.
 */
function endedDay(campaign: CampaignLifespan | null): Date | null {
  const raw = campaign?.ended_at;
  if (!raw) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : noonOf(parsed);
}

/**
 * Which windows this campaign can actually answer.
 *
 * `life` is withheld without a `started_at`, because the alternative — falling
 * back to 30 days and still calling it "Whole campaign" — is a label that lies
 * on exactly the campaigns the option exists for.
 */
export function campaignSeriesWindows(
  campaign: CampaignLifespan | null,
): CampaignSeriesWindow[] {
  return CAMPAIGN_SERIES_WINDOWS.filter(
    (window) => window !== 'life' || startedDay(campaign) !== null,
  );
}

/**
 * The window a campaign opens on.
 *
 * A terminal campaign defaults to its whole life; a live one to the last 14
 * days. That asymmetry is the point: "last 7 days" on a campaign that stopped
 * three weeks ago is an empty chart under a heading promising a trend, and an
 * empty chart is indistinguishable from a broken one.
 */
export function defaultCampaignSeriesWindow(
  campaign: CampaignLifespan | null,
): CampaignSeriesWindow {
  const available = campaignSeriesWindows(campaign);
  // The STATUS decides, not `ended_at` — a finished campaign whose the API never
  // sent a timestamp still wants its whole life, not the last fortnight of
  // nothing. See `CampaignLifespan.status`.
  if (finished(campaign) && available.includes('life')) return 'life';
  return '14d';
}

const RELATIVE_DAYS: Record<Exclude<CampaignSeriesWindow, 'life'>, number> = {
  '7d': 7,
  '14d': 14,
  '30d': 30,
};

/**
 * The width a `life` window falls back to when there is no `started_at`.
 *
 * The option is withheld in that state, so this is only reachable through a
 * caller passing `'life'` anyway — but "unreachable" is what the previous
 * spelling claimed too, and it was wrong. It matches {@link
 * defaultCampaignSeriesWindow}'s own fallback, so the two cannot drift into
 * disagreeing about what a campaign with no known start is shown.
 */
const DEFAULT_RELATIVE_DAYS = 14;

/**
 * The range to ask the API for.
 *
 * ── Whole LOCAL days, and an exclusive end that is derived ─────────────────
 * `to` is the start of the day AFTER the last day shown, never a
 * `T23:59:59.999` literal. That literal is ambiguous wherever the clocks go
 * back at midnight (Chile, Paraguay, Cuba, Lebanon), resolves to the earlier
 * offset, and drops the last local hour — the exact defect
 * `agencyAttemptFilters` was fixed for.
 *
 * The days themselves are walked from local NOON and only then turned into
 * midnights — see {@link noonOf} for the hour this loses in those same zones if
 * the walk starts at midnight instead.
 *
 * ── The end of a terminal campaign is its OWN last day ─────────────────────
 * A campaign that stopped on the 3rd is asked about up to the end of the 3rd,
 * not up to today: trailing weeks of structural zeros would compress the part
 * of the chart that has anything in it into the left quarter of the plot.
 *
 * ── `now` is a parameter ───────────────────────────────────────────────────
 * For the reason `periodRange` states: every boundary case becomes a test
 * rather than something to reason about.
 */
export function campaignSeriesRange(
  window: CampaignSeriesWindow,
  campaign: CampaignLifespan | null,
  now: Date,
): CampaignSeriesRange {
  const today = noonOf(now);
  const over = finished(campaign);
  /*
    ── `ended_at` only counts when the STATUS agrees ─────────────────────────
    The timestamp is optional and a mixed-version row can carry one that does not
    mean "this campaign is over". Reading it unguarded truncated a LIVE campaign
    to that date: "Last 7 days" of a running campaign came back as seven empty
    bars from last month, with `partialToday` false so nothing said today was
    still filling. Status is what this module says decides — that has to hold
    here as well as in the default window.

    An `ended_at` in the future is not a thing the server produces either, but clock
    skew between a server and a browser is very ordinary, and a range ending
    tomorrow would ask for a day that cannot have happened.
  */
  const ended = over ? endedDay(campaign) : null;
  const lastDay = ended !== null && ended.getTime() < today.getTime() ? ended : today;

  const started = startedDay(campaign);
  /*
    A relative window of N days ENDS on `lastDay` inclusive, so it begins N-1
    days earlier — "last 7 days" is today and the six before it, not today and
    the seven before it. A `life` window with no start (the option is withheld
    in that state, but a caller can still pass it) falls back to the default
    relative width rather than to the epoch.
  */
  /*
    Branched rather than indexed-with-a-cast. `RELATIVE_DAYS[window as Exclude<…,
    'life'>] ?? 14` asserted that `'life'` is a key of the record, which it is
    not — so TypeScript typed the lookup as `number` and the `?? 14` became dead
    code to the compiler while staying live at runtime. Anyone tidying away the
    "unreachable" fallback would have given a `life` window with no `started_at`
    a span of `NaN` days, and `toISOString()` on that throws.
  */
  const relative = window === 'life' ? DEFAULT_RELATIVE_DAYS : RELATIVE_DAYS[window];
  const requestedFirst =
    window === 'life' && started !== null ? started : addDays(lastDay, -(relative - 1));

  /*
    A `started_at` after the last day (a campaign that started and stopped
    inside one day, plus skew) would produce a negative span. One day is the
    floor: the campaign existed for at least the day it ran on.
  */
  const spanDays = Math.max(1, differenceInCalendarDays(lastDay, requestedFirst) + 1);
  const clamped = spanDays > CAMPAIGN_SERIES_MAX_DAYS;
  const days = clamped ? CAMPAIGN_SERIES_MAX_DAYS : spanDays;
  /*
    ── Which END of a `life` window survives the cap ─────────────────────────
    Normally the most recent days: a long RUNNING campaign is most usefully read
    from today backwards.

    But a campaign that has finished and never told us WHEN falls back to a
    `lastDay` of today, which is not its last day at all. Walking 92 days back
    from now then charted this month's structural zeros, dropped the months the
    campaign actually ran, and captioned it "This campaign ran longer than 92
    days. Showing the most recent 92." — a truncation of a run that never
    happened. So that case counts FORWARD from the start instead, which is the
    only end of the window we actually know.
  */
  const endUnknown = window === 'life' && over && endedDay(campaign) === null;
  const first = endUnknown && started !== null
    ? started
    : addDays(lastDay, -(days - 1));
  const last = endUnknown && started !== null ? addDays(started, days - 1) : lastDay;

  return {
    /*
      `startOfDay` LAST, on a noon-anchored day: the walk happens at noon so DST
      cannot shift it, and each boundary is only then turned into that day's real
      local midnight — which on a spring-forward day is 01:00, correctly, because
      that is when the day starts there.
    */
    from: startOfDay(first).toISOString(),
    to: startOfDay(addDays(last, 1)).toISOString(),
    days,
    /*
      Only a range we actually cut short. A finished campaign whose end we were
      never told is not "showing the most recent 92 days of a longer run" — it is
      showing the first 92 from its start, and {@link endUnknown} is what the
      note beside it says instead.
    */
    clamped: clamped && !endUnknown,
    endUnknown,
    /*
      A campaign that has FINISHED is not still filling, whether or not we were
      told the day it ended: nothing else will be dialed on it. So the note is a
      statement about a LIVE campaign whose last day happens to be today, never
      about a range whose last day happens to be today.
    */
    partialToday: !finished(campaign) && lastDay.getTime() === today.getTime(),
  };
}

/**
 * The sentences that qualify a range, in the order a reader needs them.
 *
 * Returned as a list rather than one joined string so the caller can render
 * them as separate lines, and so a test can assert on one without matching the
 * others' wording.
 */
export function campaignSeriesRangeNotes(range: CampaignSeriesRange): string[] {
  const notes: string[] = [];
  if (range.endUnknown) {
    notes.push(
      'We don’t have an end date for this campaign, so this covers the '
      + `${range.days.toLocaleString()} days from when it started.`,
    );
  }
  if (range.clamped) {
    notes.push(
      `This campaign ran longer than ${CAMPAIGN_SERIES_MAX_DAYS} days. `
      + `Showing the most recent ${CAMPAIGN_SERIES_MAX_DAYS}.`,
    );
  }
  if (range.partialToday) {
    notes.push('Today is still in progress, so its figures are partial.');
  }
  return notes;
}

/**
 * Which time zone the days were cut in, named.
 *
 * The per-agent chart has to explain in a paragraph that a "day" may not be one
 * contiguous 24 hours, because an agent works campaigns in several zones. One
 * campaign has exactly one zone, so the honest note here is a short sentence —
 * but it needs the zone's NAME to be worth saying at all, which is why the
 * contract asks the API to echo it back. Absent zone, no note: "days are counted
 * in the campaign's time zone" without naming it tells a reader nothing they
 * can check.
 */
export function campaignSeriesZoneNote(series: AgencyCampaignSeries | null): string | null {
  const zone = series?.timezone;
  if (!zone) return null;

  /*
    ── The range is cut in the READER's day, the buckets in the campaign's ───
    `campaignSeriesRange` builds its bounds from a local `Date`, so a supervisor
    in Los Angeles asking for "the last 7 days" of a Kolkata campaign sends a
    window whose edges fall at 12:30 in the campaign's own clock. The API answers
    with the campaign-days that window touches — so eight buckets can arrive for
    a seven-day request, and the first and last each cover part of a day.

    The honest options were to cut the range in the campaign's zone (which needs
    a tz library this repo does not ship) or to say so. Silence was not one:
    without it the end bars simply look like quiet days, which is the one reading
    a supervisor acts on.

    Said only when the zones actually differ. On the common case — a supervisor
    and their campaign in one country — the sentence would be noise about a
    problem that is not there.
  */
  const reader = readerZone();
  const partialEdges = reader !== null && reader !== zone
    ? ' Your own day starts at a different time, so the first and last bars can '
      + 'each cover part of a day.'
    : '';

  return `Days are counted in ${zone} — this campaign's own time zone, the one its `
    + `calling window is enforced in.${partialEdges}`;
}

/** The reader's IANA zone, or `null` where the environment cannot say. */
function readerZone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    // Never a render-time throw for a caption. An environment with no `Intl`
    // resolution simply gets the short note.
    return null;
  }
}

/**
 * The one place the chart and the card above it are measured differently.
 *
 * `success_rate_pct` on the campaign payload divides by `attempts_connected` —
 * every call that connected, answering machines included. A bucket's `connected`
 * is `human_connects`, the narrower population, so this chart's conversion runs
 * a little higher than the card's for the same campaign.
 *
 * Both are correct and neither can be re-derived into the other from what the
 * wire carries, so the difference is STATED rather than hidden. Left unsaid, a
 * supervisor reads two conversion figures a few inches apart, sees them
 * disagree, and stops trusting whichever they looked at second.
 */
export const CONVERSION_DENOMINATOR_NOTE =
  'Conversion here counts calls that spoke to a person. The figure above counts every call '
  + 'that connected, answering machines included, so the two differ slightly.';

/**
 * How much of the campaign the range in force is able to speak for.
 *
 * ── Why this is not the boolean it started as ───────────────────────────────
 *
 * The two "there is no chart" notes below both used to end *"Pick a wider
 * range"* unconditionally, and both range pickers **default to the widest
 * option** — `life` on a terminal campaign, which is the primary case for this
 * whole section. So the commonest reading of either message was advice to press
 * a control that was already pressed. Measured on production: a campaign that
 * ran for twenty minutes showed "Whole campaign" selected above the sentence
 * "Pick a wider range to see one", on both the Overview and Performance charts.
 *
 * Fixing that with a single `atWidest` flag then bought a second, quieter bug,
 * because *not being able to widen* and *covering the whole campaign* are not
 * the same fact and the replacement copy asserted both. Two ways they come
 * apart, and each makes a campaign-wide sentence false:
 *
 *  - `life` is **withheld** from a campaign with no known start
 *    ({@link campaignSeriesWindows}), so `30d` is the widest on offer. Nothing
 *    to widen to — but the campaign may well have dialed before that window,
 *    and "this campaign has dialed on one day only" is then simply wrong.
 *  - `life` itself is **clamped** to {@link CAMPAIGN_SERIES_MAX_DAYS}: a
 *    campaign that ran longer keeps only its most recent 92 days, which
 *    {@link campaignSeriesRangeNote} states in words a few pixels below the
 *    very sentence claiming to cover all of it.
 *
 * `'widest'` is therefore the honest middle: withhold the advice, withhold the
 * claim. A missing range resolves to it too — the campaign-wide reading is the
 * stronger one and this module does not make the stronger reading off an
 * absence.
 */
export type CampaignSeriesReach =
  /** A wider range exists. Advice to widen it is worth giving. */
  | 'narrower'
  /** The widest on offer, but it is not the whole campaign. Claim neither. */
  | 'widest'
  /** `life`, unclamped: this range IS the campaign, and may be spoken of so. */
  | 'campaign';

export function campaignSeriesReach(
  window: CampaignSeriesWindow,
  windows: readonly CampaignSeriesWindow[],
  range: CampaignSeriesRange | null,
): CampaignSeriesReach {
  if (windows.length === 0 || windows[windows.length - 1] !== window) return 'narrower';
  if (window === 'life' && range !== null && !range.clamped) return 'campaign';
  return 'widest';
}

/**
 * Why there is no chart, for a range that resolved to a single day.
 *
 * Three answers, because there are three different next actions: widen the
 * range, stop looking for a control that is not there, or read the sentence as
 * a fact about the campaign. Only the last may say "this campaign".
 */
export function campaignSingleBucketNote(reach: CampaignSeriesReach): string {
  if (reach === 'campaign') {
    return 'This campaign has dialed on one day only, so there is no day-by-day shape to '
      + 'draw. The figures above cover all of it.';
  }
  if (reach === 'widest') {
    // Scoped to the range, and says why pressing on is pointless without
    // claiming anything about the days outside it.
    return 'Only one day in this range had any dialing, so there is no day-by-day shape to '
      + 'draw. This is already the widest range available for this campaign.';
  }
  return 'A day-by-day chart needs more than one day. Pick a wider range to see one.';
}

// ── The rate trend ──────────────────────────────────────────────────────────

export type RateSeriesKey = 'connect' | 'conversion';

/** One day of the rate chart. Both rates may be `null`, independently. */
export interface RatePoint {
  /** The bucket's own `YYYY-MM-DD`, unchanged, and the row key. */
  start: string;
  /** A short axis label — day of the month, on the reader's calendar. */
  label: string;
  /** The full date, for the tooltip and the numbers table. */
  title: string;
  attempts: number;
  connected: number;
  /**
   * `undefined` where the bucket did not carry one — kept as an absence rather
   * than folded to `0`, so the conversion it feeds is a gap and not a plotted
   * cliff. See `rateTrend`.
   */
  successes: number | undefined;
  /** `connected / attempts`, or `null` — see {@link RateSeriesLine.withheld}. */
  connect: number | null;
  /** `successes / connected`, or `null`. */
  conversion: number | null;
}

/** A run of consecutive measured days — one `<path>`, or one dot if length 1. */
export interface RateRun {
  /** Indices into {@link RateTrend.points}, inclusive. */
  from: number;
  to: number;
}

export interface RateSeriesLine {
  key: RateSeriesKey;
  label: string;
  /** What the rate is measured OUT OF, in the reader's words. Never omitted. */
  denominator: string;
  /** `null` wherever the day is unmeasured or withheld, aligned with `points`. */
  values: (number | null)[];
  /** Unbroken runs of measured days. A line is drawn per run, never across a gap. */
  runs: RateRun[];
  /**
   * The indices of the days dropped for a denominator under
   * {@link RATE_MIN_ATTEMPTS} — INDICES, not a count.
   *
   * A count per line cannot be summed across the two lines, because a quiet day
   * is normally withheld on BOTH and would be counted twice. That is how a
   * seven-day chart came to carry the sentence "14 days are left out" above
   * seven columns — the one caveat this honesty feature depends on, falsifiable
   * by counting the bars.
   */
  withheldIndices: number[];
  /** Days with no denominator at all — nothing to withhold, nothing to draw. */
  unmeasured: number;
  /** The last measured day, for the direct label. `null` when nothing measured. */
  lastIndex: number | null;
  /** True when at least two measured days exist, so a line can be drawn. */
  drawable: boolean;
}

export interface RateTrend {
  points: RatePoint[];
  lines: RateSeriesLine[];
  /** The axis top as a percentage. At least 10, never above 100. */
  max: number;
  /** True when ANY line has two measured days. Otherwise {@link reason} says why. */
  drawable: boolean;
  /** Why nothing is drawn, in the reader's words. `null` when it is. */
  reason: string | null;
  /** The threshold sentence, present whenever any day was withheld. */
  withheldNote: string | null;
}

/**
 * The axis top for a percentage series.
 *
 * Rounded up to a clean 10 so the midpoint tick divides, floored at 10 (a
 * campaign converting at 1.2% still gets a plot with room in it rather than a
 * line pinned to the axis) and capped at 100, which is where a percentage
 * stops. Deliberately NOT `niceCeiling`'s 1/2/5 ladder: that yields 20/50/100
 * for rate data and jumps the axis by 2.5× between two ordinary campaigns.
 */
export function rateCeiling(max: number): number {
  if (!Number.isFinite(max) || max <= 0) return 10;
  return Math.min(100, Math.max(10, Math.ceil(max / 10) * 10));
}

/** `connected / attempts` as a percentage, or `null` — never `0` for `0/0`. */
function rate(part: number, whole: number): number | null {
  if (!Number.isFinite(part) || !Number.isFinite(whole) || whole <= 0) return null;
  return (part / whole) * 100;
}

function runsOf(values: (number | null)[]): RateRun[] {
  const runs: RateRun[] = [];
  let open: number | null = null;
  values.forEach((value, index) => {
    if (value !== null) {
      if (open === null) open = index;
      return;
    }
    if (open !== null) {
      runs.push({ from: open, to: index - 1 });
      open = null;
    }
  });
  if (open !== null) runs.push({ from: open, to: values.length - 1 });
  return runs;
}

interface LineSpec {
  key: RateSeriesKey;
  label: string;
  denominator: string;
  /** The day's own denominator — dials for connect, connected calls for conversion. */
  of: (point: RatePoint) => number;
  value: (point: RatePoint) => number | null;
}

/**
 * The two lines, and the labels are load-bearing.
 *
 * Neither may appear as a bare percentage beside the other: connect rate is
 * measured over DIALS and conversion over CONVERSATIONS, and a reader who
 * assumes one denominator for both is out by a factor that changes what they do
 * next. The Performance cards solve this with a denominator line under each
 * figure; a chart has one legend for both, so the denominator travels IN the
 * legend entry rather than beside it.
 */
const LINE_SPECS: readonly LineSpec[] = [
  {
    key: 'connect',
    label: 'Connect rate',
    denominator: 'of dials placed that day',
    of: (point) => point.attempts,
    value: (point) => point.connect,
  },
  {
    key: 'conversion',
    label: 'Conversion',
    /*
      "of conversations that day" was too loose to be safe next to the card
      above, which measures conversion against `attempts_connected` — every call
      that connected, answering machines included. The bucket's `connected` is
      the narrower `human_connects`, so the two rates have different denominators
      and the legend has to say which this one is.

      The wording is the pulse strip's own — "Spoke to a person" — and NOT
      "reached a person", which is one word away from "Reached someone", the
      strip's label for the wider `attempts_connected`. Teaching the difference
      four hundred pixels above and then blurring it here is worse than never
      having drawn the distinction. See `CONVERSION_DENOMINATOR_NOTE`.
    */
    denominator: 'of calls that spoke to a person that day',
    of: (point) => point.connected,
    value: (point) => point.conversion,
  },
];

/**
 * The rate chart's data.
 *
 * Buckets are **not re-sorted** — the order is the API's, and re-deriving it here
 * would give the screen a second opinion about a sequence the server already
 * ordered. A malformed `bucket_start` keeps its raw value as the label rather
 * than being dropped, for the reason `bucketSeries` states: losing a bucket
 * breaks the one property the series can be checked against.
 */
export function rateTrend(
  series: AgencyCampaignSeries | null,
  /**
   * How much of the campaign this range speaks for — see
   * {@link campaignSeriesReach}. Defaults to `'narrower'`, the weakest reading:
   * it keeps the advice-to-widen wording and claims nothing campaign-wide, so a
   * caller that has not been updated cannot accidentally publish either.
   */
  reach: CampaignSeriesReach = 'narrower',
): RateTrend {
  const buckets = series?.buckets ?? [];

  const points: RatePoint[] = buckets.map((bucket) => {
    const parsed = bucketDay(bucket.bucket_start);
    /*
      NOT coerced to 0. `rate()` bails on a non-finite numerator, so passing an
      absent `successes` straight through makes the day a GAP — while `?? 0`
      made it a measured 0% that joins the line and draws a cliff into the middle
      of a campaign.

      That is this module's own missing-is-not-zero rule applied to the numerator
      the conversion line sits with, and it is the rule every other optional
      count on this payload already follows: `attempts_retried` and `agents_peak`
      drop their figure rather than invent one.
    */
    const successes = bucket.successes;
    return {
      start: bucket.bucket_start,
      label: parsed ? String(parsed.getDate()) : bucket.bucket_start,
      title: parsed
        ? parsed.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
        : bucket.bucket_start,
      attempts: bucket.attempts,
      connected: bucket.connected,
      successes,
      connect: rate(bucket.connected, bucket.attempts),
      conversion: rate(successes, bucket.connected),
    };
  });

  const lines: RateSeriesLine[] = LINE_SPECS.map((spec) => {
    const withheldIndices: number[] = [];
    let unmeasured = 0;
    const values = points.map((point, index) => {
      const raw = spec.value(point);
      if (raw === null) {
        unmeasured += 1;
        return null;
      }
      // The same floor the Performance cards publish against, per day. See the
      // module note: a rate off four calls is noise drawn as a trend.
      if (spec.of(point) < RATE_MIN_ATTEMPTS) {
        withheldIndices.push(index);
        return null;
      }
      return raw;
    });

    const runs = runsOf(values);
    const measured = values.filter((v) => v !== null).length;
    let lastIndex: number | null = null;
    values.forEach((value, index) => {
      if (value !== null) lastIndex = index;
    });

    return {
      key: spec.key,
      label: spec.label,
      denominator: spec.denominator,
      values,
      runs,
      withheldIndices,
      unmeasured,
      lastIndex,
      drawable: measured >= 2,
    };
  });

  const max = lines.reduce(
    (top, line) => line.values.reduce<number>((best, v) => (v === null ? best : Math.max(best, v)), top),
    0,
  );

  const drawable = lines.some((line) => line.drawable);
  /*
    DISTINCT days, not the sum of the two lines' tallies: a quiet day is normally
    withheld on both, and summing counted it twice. See `withheldIndices`.
  */
  const withheldDays = new Set(lines.flatMap((line) => line.withheldIndices)).size;
  /*
    Whether ANY day, on either line, produced a publishable figure. This is what
    separates "the whole range is too quiet to plot" from "there is only one good
    day here" — two states that need different sentences and lead to different
    next actions.
  */
  const anyMeasured = lines.some((line) => line.values.some((value) => value !== null));

  return {
    points,
    lines,
    max: rateCeiling(max),
    drawable,
    reason: drawable ? null : noTrendReason(points, withheldDays, anyMeasured, reach),
    withheldNote: withheldDays > 0 ? withheldNote(withheldDays) : null,
  };
}

/**
 * Why the rate chart declined to draw.
 *
 * Three different answers, because they lead to three different next actions —
 * widen the range, wait, or nothing at all. One "no data" would collapse them
 * and leave a supervisor unable to tell a quiet campaign from a broken screen.
 */
function noTrendReason(
  points: RatePoint[],
  withheldDays: number,
  anyMeasured: boolean,
  reach: CampaignSeriesReach,
): string {
  if (points.length === 0) return 'There are no days in this range.';
  /*
    Every day in the range arrives, zeros included (the endpoint's contract), so
    an empty `points` is a range with no days in it — a different failure from a
    campaign that simply did not dial. The second is the ordinary one and needs
    its own sentence, or a quiet week reads as a broken screen.
  */
  if (points.every((point) => point.attempts === 0)) return 'Nothing was dialed in this range.';
  /*
    `anyMeasured` is the guard that keeps the next sentence true. Without it, a
    range holding one 400-dial day and one 4-dial day was told "no day here had
    25 calls behind it" — false, and it sent the reader back to the lifetime
    figures when the correct next move is to widen the range. A day that WAS
    publishable means the range is short, not quiet.
  */
  if (withheldDays > 0 && !anyMeasured) {
    return `No day in this range had ${RATE_MIN_ATTEMPTS} calls behind it, so there is no rate `
      + 'worth plotting yet. The figures above cover the whole campaign and are still the ones '
      + 'to read.';
  }
  // Names the real bar. "Two days with calls in them" understated it, so a
  // supervisor widened the range, got the same message back, and concluded the
  // control was broken.
  //
  // `reach` is the second half of that same fix. Naming the bar correctly still
  // left the sentence telling a reader on "Whole campaign" — the default for
  // every terminal campaign — to widen a range that cannot be widened. And only
  // the `'campaign'` reach may then generalise from the range to the campaign;
  // see {@link campaignSeriesReach} for the two ways the widest range is not the
  // whole of it.
  const bar = `A trend needs two days with at least ${RATE_MIN_ATTEMPTS} calls each. `;
  if (reach === 'campaign') {
    return `${bar}This campaign has not dialed that much on two separate days. The figures `
      + 'above cover the whole of it.';
  }
  if (reach === 'widest') {
    return `${bar}No two days in this range clear it, and this is already the widest range `
      + 'available for this campaign.';
  }
  return `${bar}Pick a wider range.`;
}

function withheldNote(days: number): string {
  // "The gap is the day, not a missing reading" read as a riddle and was
  // skipped, which left the reader exactly where they started: unsure whether a
  // hole in the line is a quiet day or a failed fetch. Say both halves plainly —
  // and agree with itself in number, which the first attempt did not ("Those day
  // show as gaps").
  const one = days === 1;
  const subject = one ? 'One day is' : `${days.toLocaleString()} days are`;
  const gap = one ? 'It shows as a gap' : 'They show as gaps';
  const dialed = one ? 'It was dialed' : 'They were dialed';
  return `${subject} left out — fewer than ${RATE_MIN_ATTEMPTS} calls behind the figure. `
    + `${gap} in the lines. ${dialed}; we just won’t publish a rate off that few calls.`;
}
