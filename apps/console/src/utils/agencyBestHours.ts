import { agentCount, agentPct } from './agencyAgentPerformance';
import { withheldRateCell } from './agencyAgentRoster';
import type {
  AgencyGroupDimension,
  AgencyGroupPage,
  AgencyGroupRow,
} from '../types/agency-stats';

/**
 * "When does this campaign actually connect" — the best-hours matrix, as pure
 * functions.
 *
 * ── One read, 168 cells, and no second question ────────────────────────────
 * `group_by=day_of_week,hour_of_day` is exactly the route's two-dimension cap, and
 * 7 × 24 = 168 rows fits under its default `limit` of 200 — so the whole map is one
 * request at the DEFAULT limit. The client does not send `limit=168`: that is a
 * magic number which would silently truncate the map the day a seventh weekday
 * value appears, and it would be a request describing the client's arithmetic
 * rather than the reader's question.
 *
 * ── It is per-campaign, always ────────────────────────────────────────────
 * Both time dimensions are spent, so there is no room for `campaign` in `group_by`
 * — which means the read's zone is unambiguous only because exactly one
 * `campaign_id` is filtered. Upstream answers a pooled read with
 * `400 timezone_ambiguous`, and this client must not "handle" that by retrying in
 * UTC: an Asia/Kolkata campaign's real connect peak sits five and a half hours from
 * where a UTC fallback would draw it, and the only visible symptom is a rostering
 * decision that is quietly wrong.
 *
 * ── The four things this module exists to get right ────────────────────────
 *  1. **A thin cell is never coloured** and is excluded from the scale's domain
 *     ({@link bestHoursMatrix}, {@link BestHoursDomain}). A 20:00 Sunday cell with
 *     2 dials and 1 connect is 50%, which on a ramp topping out near a ~30% floor
 *     median is the brightest cell on the map — and a supervisor moves staffing to
 *     Sunday night on the strength of one answered call. The roster already refuses
 *     this for its bullet (`rosterConnectAxis` skips withheld rates so one cannot
 *     rescale the column); at 168 cells the same rule is what keeps the map's
 *     contrast attached to its honest values.
 *  2. **An out-of-window weekday is not a zero** ({@link weekdayCoverage}). A
 *     window shorter than seven days has weekday rows that were never asked about,
 *     and rendering them like "we dialled Tuesday and connected nobody" makes the
 *     map lie about up to six of its seven rows — in the direction a supervisor
 *     acts on, because an empty row reads as "stop staffing Tuesdays".
 *  3. **The hour axis names the zone the buckets were CUT in, or nothing**
 *     ({@link bestHoursZone}). Never the reader's, which is a different zone that a
 *     neighbouring caption on the same screen correctly prints.
 *  4. **A view switch re-renders** ({@link BestHoursView}). Every metric is on
 *     every cell already, so nothing here reads the wire twice — a view switch that
 *     fired a request would let the three views disagree.
 *
 * Nothing in this module divides. Every rate is served, and the one ratio that is
 * not a rate — a cell's position along the colour ramp — is geometry, computed the
 * way the roster's bullet computes its own share of an axis.
 */

// ─── What this surface asks for ──────────────────────────────────────────────

/**
 * The cut: one row per weekday-hour cell.
 *
 * Exactly the route's two-dimension cap, which is why `campaign` cannot also be in
 * the group — and therefore why a single `campaign_id` filter is the only remaining
 * way for the read's zone to be unambiguous. One campaign is a fact about the read
 * here rather than a preference of the screen: the contribution view *prefers* one,
 * this one is a 400 without it. So the selector has no "all campaigns" option, the
 * hook takes the id as a required field, and `useBestHours` refuses a blank one
 * rather than letting `groupQuery` drop it into a pooled read.
 */
export const BEST_HOURS_GROUP_BY: readonly [AgencyGroupDimension, AgencyGroupDimension] = [
  'day_of_week',
  'hour_of_day',
];

/** 0 = Sunday … 6 = Saturday, matching Postgres `EXTRACT(DOW …)` and `key.day_of_week`. */
export const BEST_HOURS_DAYS = 7;
/** 0–23 in the resolved zone. */
export const BEST_HOURS_HOURS = 24;
/** 168 — one request at the route's default limit, and the number the surface states. */
export const BEST_HOURS_CELLS = BEST_HOURS_DAYS * BEST_HOURS_HOURS;

/**
 * Weekday names, indexed by `key.day_of_week`.
 *
 * A constant rather than `Intl`'s locale weekdays, and deliberately: the wire
 * carries a NUMBER because naming a day is a formatting decision that belongs in
 * the console (D3), and 0 = Sunday is the value `EXTRACT(DOW)` produces. Deriving
 * the names from a locale would make the row order depend on the reader's
 * first-day-of-week and re-introduce exactly the off-by-one against ISO's 1 = Monday
 * that the numeric wire value exists to avoid.
 */
export const BEST_HOURS_WEEKDAYS: readonly string[] = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
];

/** The same seven, for a column head two characters wider than the figures under it. */
export const BEST_HOURS_WEEKDAYS_SHORT: readonly string[] = [
  'Sun',
  'Mon',
  'Tue',
  'Wed',
  'Thu',
  'Fri',
  'Sat',
];

function weekdayName(day: number): string {
  return BEST_HOURS_WEEKDAYS[day] ?? `Day ${day}`;
}

// ─── The three views ─────────────────────────────────────────────────────────

/**
 * What the colour encodes. Three of them, and one is always reportable.
 *
 * | View | Colour | Gate |
 * |---|---|---|
 * | `connect_rate` (default) | `connect_rate_pct` | `rates_reportable`, absent ⇒ quote |
 * | `volume` | `attempts` | none — a count needs no threshold |
 * | `conversion_rate` | `success_rate_pct` | `success_rate_reportable`, absent ⇒ **withhold** |
 *
 * The two gates degrade in OPPOSITE directions, and that asymmetry is deliberate:
 * see `successRateReportable` below. Falling back to `rates_reportable` for the
 * conversion view paints a 20-dial/1-connect/1-conversion cell as 100% and as the
 * ramp's upper endpoint, which is E5's own failure; the connect rate has no such
 * second denominator to be wrong about.
 *
 * Connect rate is the default because it is the "best hours to call" question.
 * **Volume exists because it is the one view that is always reportable**, and
 * because it answers the other half of a rostering decision — "when do we currently
 * dial" — which a rate map cannot: a 40% cell at 06:00 over 21 dials and a 30% cell
 * at 15:00 over 900 are not the same instruction.
 *
 * One request serves all three. The payload carries every metric on every cell, so
 * switching view is a **re-render**; a view switch that fired a request would make
 * the three views capable of disagreeing about one campaign's week.
 */
export type BestHoursView = 'connect_rate' | 'volume' | 'conversion_rate';

/** In reading order, with the default first. */
export const BEST_HOURS_VIEWS: readonly BestHoursView[] = [
  'connect_rate',
  'volume',
  'conversion_rate',
];

export const BEST_HOURS_DEFAULT_VIEW: BestHoursView = 'connect_rate';

/**
 * The roster's words for the same three quantities — **connects** for an answered
 * call, **conversions** for a booked one, dials for an attempt. A supervisor is one
 * click from the roster and the contribution table and must not meet a second
 * dialect on the way here.
 */
export const BEST_HOURS_VIEW_LABELS: Record<BestHoursView, string> = {
  connect_rate: 'Connect rate',
  volume: 'Dials',
  conversion_rate: 'Conversion rate',
};

/** Each view's denominator, said out loud — the contribution table's rule for the same reason. */
export const BEST_HOURS_VIEW_HINTS: Record<BestHoursView, string> = {
  connect_rate: 'of dials',
  volume: 'attempts placed',
  conversion_rate: 'of connects',
};

// ─── The zone (E3) ───────────────────────────────────────────────────────────

/**
 * The zone the buckets were ACTUALLY cut in, or `null`.
 *
 * ── Read through a `typeof` guard, and the direction of the fallback matters ─
 * `resolved_timezone` is additive and merge order is core → master → cusui, so this
 * console can meet a service that predates it. The fallback is **silence**, not a
 * guess: `undefined` (the field never arrived) and `null` (a read with no zoned
 * dimension) are two different arrivals and both mean "this surface may not name a
 * zone". A guess is the one option that is worse than blank here, because
 * "the 18:00 column" is not a fact until a zone is named and a wrong name is a
 * rostering decision.
 *
 * ⚠️ **It is not the reader's zone.** `windowRangeReadout` prints
 * `Intl.DateTimeFormat().resolvedOptions().timeZone`, and that is correct for its
 * own caption — the window bounds really are cut from a local `Date` — and wrong for
 * this axis. Two zones can legitimately sit on this screen; mixing them is the
 * defect E3 exists to prevent, so nothing in this module reaches for the browser's
 * default and every function that needs a zone takes it as an argument.
 */
export function bestHoursZone(page: AgencyGroupPage): string | null {
  const zone = page.resolved_timezone;
  if (typeof zone !== 'string') return null;
  const trimmed = zone.trim();
  if (trimmed === '') return null;
  /*
    ── One predicate for the axis, the third state and the banner ────────────
    This used to accept any non-blank string, and the axis and the coverage walk
    then disagreed about the same value: `weekdayCoverage` builds an
    `Intl.DateTimeFormat` for the zone and answers `known: false` when the name
    throws, while the axis printed the junk name anyway. So a campaign whose
    `default_timezone` is `Asia/Calcutta_typo` got a column head reading
    "Hour of day · Asia/Calcutta_typo" above a matrix that had already given up on
    telling an out-of-window cell from a zero — the axis asserting exactly what the
    third state denies, on the one campaign whose zone is broken.

    Validating through `zoneFormatter` — the same construction, so the same
    RangeError — makes the three surfaces answer from one predicate. A name this
    build cannot resolve is therefore "no zone", which is the honest reading: E3's
    rule is that the axis names the zone the buckets were cut in **or nothing**, and
    a name that resolves to nothing is not a name.

    Note what this does NOT claim: core's buckets are still correct — it cut them
    with the value Postgres accepted. This console just cannot say which zone that
    was, which is the same position an absent field leaves it in, and it degrades the
    same way.
  */
  return zoneFormatter(trimmed) === null ? null : trimmed;
}

/**
 * What the hour axis is called, or `null` when the zone could not be read.
 *
 * `null` renders NO zone on the axis — see {@link BEST_HOURS_ZONE_UNKNOWN_NOTE},
 * which is the sentence that says so rather than leaving a bare row of numbers to
 * be read as though it were in the reader's own day.
 */
export function bestHoursHourAxisLabel(zone: string | null): string | null {
  return zone === null ? null : `Hour of day · ${zone}`;
}

/**
 * Said on the surface when {@link bestHoursZone} could not name a zone.
 *
 * It names the consequence rather than the cause, and that is deliberate now that
 * there are two causes: the field did not arrive (a core that predates it), or it
 * arrived carrying a name this build cannot resolve. **Both leave the reader in
 * exactly the same position** — the columns are true, because core cut them in
 * whatever zone Postgres accepted, but this console cannot say which zone that was,
 * and a reader who assumes their own would be five and a half hours out on a
 * campaign in another one. One sentence for both, because a reader cannot act
 * differently on the difference.
 */
export const BEST_HOURS_ZONE_UNKNOWN_NOTE =
  'The timezone these hours were cut in did not come back in a form this page can ' +
  'read, so the columns are not labelled with one. They are the campaign’s own local ' +
  'hours, not yours — this build cannot say which zone that is, so it does not guess.';

/** `'00'` … `'23'`. Two digits, so a column of hours is one width. */
export function bestHoursHourLabel(hour: number): string {
  return String(hour).padStart(2, '0');
}

/**
 * `Tuesday 18:00 · Asia/Kolkata` — one cell's coordinates, in words.
 *
 * The zone is appended only when it is known, for {@link bestHoursZone}'s reason:
 * an hour with a zone beside it is a fact, and an hour with the WRONG zone beside
 * it is worse than an hour with none.
 */
export function bestHoursCellCoordinates(day: number, hour: number, zone: string | null): string {
  const stem = `${weekdayName(day)} ${bestHoursHourLabel(hour)}:00`;
  return zone === null ? stem : `${stem} · ${zone}`;
}

// ─── Coverage: which cells were ASKED about (E4) ─────────────────────────────

/**
 * Which weekday-hour cells the window actually covers.
 *
 * ── The two facts an empty cell can be, and why they must not look alike ────
 * `day_of_week` over a window shorter than seven days has weekday rows that were
 * **never in the window**. Rendering them the same as "we dialled on Tuesday and
 * connected nobody" makes the matrix lie about up to six of its seven rows, and it
 * lies in the direction a supervisor acts on. Same again per HOUR on a window that
 * truncates mid-day: at 09:30 on a Monday the "today" window covers hours 00–09 of
 * one weekday and nothing else, so fifteen cells of that row were never asked about
 * and 143 cells of the map belong to days that were not in it.
 *
 * ── Derived in the RESOLVED zone, and unavailable without one ───────────────
 * A window boundary near midnight lands on a different weekday in a different zone,
 * so computing this in the reader's zone would mark the wrong row as out-of-window —
 * which is the same class of error as labelling the axis from the wrong zone. When
 * the zone is absent this function therefore answers **`known: false`** rather than
 * falling back: with no zone there is no honest way to tell the two facts apart, and
 * the surface says so instead of picking one. That interaction between E3 and E4 is
 * not something either ruling states, and silence is the only answer that does not
 * invent a finding.
 *
 * ── `Intl` with an EXPLICIT zone is not the thing E3 forbids ───────────────
 * E3 forbids reaching for `Intl.DateTimeFormat().resolvedOptions().timeZone` — the
 * BROWSER's zone — to name this axis. Formatting a known instant *into* a zone this
 * function was handed is the only way to answer the question at all, and it is the
 * opposite operation: the zone is an input here, never a default.
 *
 * ── Why it walks rather than doing offset arithmetic ───────────────────────
 * Half-hour steps FORWARD from `from` itself, letting `Intl` resolve each instant. A
 * window can contain a DST transition, and an offset read once at `from` and added
 * would then place every subsequent cell an hour out — silently, and only for part
 * of the year. Stepping and re-resolving makes a spring-forward skip the hour that
 * does not exist and a fall-back mark the hour that happens twice, which is what
 * both of those cells honestly are. Half-hours rather than whole ones because a
 * handful of zones shift by 30 or 45 minutes, and an hourly walk aligned to one side
 * of such a shift can step straight over a wall-clock hour.
 *
 * **Nothing here does millisecond arithmetic across a wall-clock boundary**, and
 * that is a correction rather than a restatement: this function used to rewind to
 * the top of the first hour by subtracting the zoned minutes as UTC milliseconds,
 * which lands in the previous offset across a 30-minute DST step and marked an hour
 * OUTSIDE the window as covered. The walk now seeds from the already-in-zone parts
 * of `from` and only ever moves forward; see the comment at the seed.
 *
 * The walk is bounded: the route caps the window at 92 days, and a range longer than
 * the guard below is a read the server refused, so it answers `known: false` rather
 * than spinning.
 */
export interface BestHoursCoverage {
  /**
   * Whether coverage could be derived at all.
   *
   * `false` means the surface must not claim either fact about a blank cell — see
   * {@link BestHoursCellState}'s `unknown_coverage`.
   */
  known: boolean;
  /** weekday → the hours of it inside `[from, to)`. Empty for a weekday not in the window. */
  covered: ReadonlyMap<number, ReadonlySet<number>>;
}

/** 92 days is the route's window cap; the guard sits well above it and below a runaway. */
const COVERAGE_MAX_STEPS = 2 * 24 * 120;
const HALF_HOUR_MS = 30 * 60 * 1000;

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/**
 * A formatter for one named zone, or `null` when the name is not one.
 *
 * `Intl.DateTimeFormat` throws a `RangeError` on an unknown `timeZone`, and this is
 * exactly the input that can be one: core's zone comes out of `COALESCE(z.name,
 * 'UTC')` and is therefore always a real IANA name today, but the value reaching
 * this client crossed two services and a hand-mirrored type. A caught `RangeError`
 * degrades to "coverage unknown"; an uncaught one takes the section down.
 */
function zoneFormatter(zone: string): Intl.DateTimeFormat | null {
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    return null;
  }
}

function zonedParts(formatter: Intl.DateTimeFormat, at: Date): ZonedParts | null {
  let year: number | null = null;
  let month: number | null = null;
  let day: number | null = null;
  let hour: number | null = null;
  let minute: number | null = null;
  let second: number | null = null;
  for (const part of formatter.formatToParts(at)) {
    const value = Number(part.value);
    if (!Number.isFinite(value)) continue;
    if (part.type === 'year') year = value;
    else if (part.type === 'month') month = value;
    else if (part.type === 'day') day = value;
    else if (part.type === 'hour') hour = value;
    else if (part.type === 'minute') minute = value;
    else if (part.type === 'second') second = value;
  }
  if (year === null || month === null || day === null) return null;
  if (hour === null || minute === null || second === null) return null;
  // `h23` should never produce 24, but an implementation that does would otherwise
  // put a real dial in a column this matrix has no room for.
  return { year, month, day, hour: hour % 24, minute, second };
}

export function weekdayCoverage(
  from: string,
  to: string,
  zone: string | null,
): BestHoursCoverage {
  const empty: BestHoursCoverage = { known: false, covered: new Map() };
  if (zone === null) return empty;

  const start = new Date(from);
  const endExclusive = new Date(to);
  if (Number.isNaN(start.getTime()) || Number.isNaN(endExclusive.getTime())) return empty;
  if (endExclusive.getTime() <= start.getTime()) return empty;

  const formatter = zoneFormatter(zone);
  if (formatter === null) return empty;

  const first = zonedParts(formatter, start);
  if (first === null) return empty;

  const covered = new Map<number, Set<number>>();
  const mark = (parts: ZonedParts): void => {
    /*
      The weekday of the ZONED calendar date, computed from that date rather than
      from the instant: `getUTCDay` over a `Date.UTC` of the same y/m/d is the only
      reading that cannot drift back a day for a zone behind UTC.
    */
    const weekday = new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay();
    let hours = covered.get(weekday);
    if (hours === undefined) {
      hours = new Set<number>();
      covered.set(weekday, hours);
    }
    hours.add(parts.hour);
  };

  /*
    ── The walk starts AT `from`, and never rewinds ──────────────────────────
    It used to rewind to the top of the hour containing `from` by subtracting the
    zoned wall-clock minutes and seconds as UTC milliseconds. That arithmetic
    assumes the offset is the same at both ends of the subtraction, and across a
    DST step of less than an hour it is not.

    Reproduced on `Australia/Lord_Howe`, whose spring-forward is **thirty minutes**
    (2026-10-04, 02:00 → 02:30). A window of 02:45–04:00 local rewound to
    `15:45Z - 45min = 15:00Z`, which in that zone is **01:30** on the old +10:30
    offset — an hour the window never contained. Hour 1 was then marked covered, so
    a cell nobody was asked about rendered `no_dials`: a printed ZERO, in the row a
    supervisor reads as "stop staffing this slot". That is precisely the lie E4
    exists to prevent, produced by E4's own implementation.

    Seeding from `first` — which is already IN the zone, resolved by `Intl` rather
    than by offset arithmetic — and only ever stepping FORWARD removes the class of
    bug rather than the instance: no computation here crosses a discontinuity.

    The hour containing `from` is still covered, because `first` IS that hour: an
    hour the window enters part-way through was asked about, since a dial could have
    landed in it. The rewind was only ever a mechanism for saying so.
  */
  mark(first);

  let cursor = start.getTime();
  let steps = 0;
  while (cursor < endExclusive.getTime()) {
    if (++steps > COVERAGE_MAX_STEPS) return empty;
    const parts = zonedParts(formatter, new Date(cursor));
    if (parts === null) return empty;
    mark(parts);
    cursor += HALF_HOUR_MS;
  }

  /*
    The LAST instant inside the half-open window, marked explicitly.

    Walking from an unaligned `from` means the steps land on a phase of their own,
    so the final partial hour can fall between two of them: 00:10 → 02:05 steps
    00:10, 00:40, 01:10, 01:40 and then past the end, never landing in hour 2 —
    which the window does contain, for five minutes. The old alignment to the top of
    the hour happened to catch that case; this catches it directly, without an
    arithmetic step that a DST transition can invalidate.

    `to - 1ms` rather than `to`: the window is `[from, to)`, so an hour the window
    ends exactly on was not asked about — the existing 09:00-exclusive case pins it.
  */
  const last = zonedParts(formatter, new Date(endExclusive.getTime() - 1));
  if (last === null) return empty;
  mark(last);

  return { known: true, covered };
}

// ─── The matrix ──────────────────────────────────────────────────────────────

/**
 * What one cell is, and the five things it can be.
 *
 *  - **`measured`** — a real figure, on the ramp. Includes a real `0`.
 *  - **`withheld`** — the server served a number and said it is not reportable.
 *    Off the ramp entirely and out of the scale's domain (E5), showing its DIAL
 *    COUNT instead, because "we barely called then" is itself the answer to a
 *    rostering question.
 *  - **`unmeasured`** — dials, but no denominator for THIS view's rate (an hour
 *    that dialled and reached nobody, on the conversion view). Also off the ramp,
 *    also showing its dial count, and distinguished from `withheld` because
 *    "nothing to divide" and "too few to trust" are different findings.
 *  - **`no_dials`** — inside the window, and nobody dialled. A real zero and a real
 *    finding.
 *  - **`out_of_window`** — that weekday-hour was never in `[from, to)`. Not a zero,
 *    not a rate, no colour: a treatment that reads as *not asked*.
 *  - **`unknown_coverage`** — no zone, so this build cannot tell the previous two
 *    apart. It says that rather than picking one.
 */
export type BestHoursCellState =
  | 'measured'
  | 'withheld'
  | 'unmeasured'
  | 'no_dials'
  | 'out_of_window'
  | 'unknown_coverage';

export interface BestHoursCell {
  day: number;
  hour: number;
  state: BestHoursCellState;
  /**
   * What the cell PRINTS. Every cell carries its number, never only its colour:
   * the rate on a measured cell, the dial count on a cell that is off the ramp, and
   * nothing at all on a cell that has no figure to print.
   */
  text: string;
  /** The ramp value — `measured` only, so nothing else can enter the domain. */
  value: number | null;
  /** Dials behind the cell, when there is a row. `null` when there is no row at all. */
  attempts: number | null;
  /** Why the cell reads as it does, for the title and the screen reader. */
  note: string;
}

export interface BestHoursRow {
  day: number;
  label: string;
  short: string;
  cells: readonly BestHoursCell[];
  /** Hours of this weekday inside the window. `0` is an out-of-window row. */
  coveredHours: number;
}

/** The ends of the colour ramp — measured cells only. `null` when nothing is coloured. */
export interface BestHoursDomain {
  min: number;
  max: number;
}

export interface BestHoursMatrix {
  view: BestHoursView;
  rows: readonly BestHoursRow[];
  /** Measured cells only (E5). A thin cell left in compresses every honest one. */
  domain: BestHoursDomain | null;
  /** Cells carrying a row — i.e. cells with at least one dial. */
  dialled: number;
  /** Cells the server told us not to rate. Stated on the surface, not inferred from grey. */
  withheld: number;
  /** Cells with dials and no denominator for this view's rate. */
  unmeasured: number;
  /** Cells never in the window. `0` when coverage is unknown — nothing is claimed. */
  outOfWindow: number;
  /** Whether {@link weekdayCoverage} could answer at all. */
  coverageKnown: boolean;
  /** Weekdays with no hour in the window, in `day_of_week` order. */
  uncoveredDays: readonly number[];
}

/**
 * May this cell's rates be quoted — the server's answer, guarded.
 *
 * The contribution screen's `contributionRatesReportable`, on the same payload and
 * with the same permissive fallback for the same reason: an absent flag must not
 * withhold every rate on the screen the moment this console runs ahead of core. On
 * a heatmap the permissive fallback is also the only one that degrades sensibly —
 * `false` would hatch all 168 cells and leave a map with no map on it.
 *
 * Never compared against `AGENCY_ROSTER_MIN_RATE_DENOMINATOR`. The threshold is the
 * server's to tune; the constant is mirrored only so the console can say it aloud.
 */
function ratesReportable(row: AgencyGroupRow): boolean {
  return typeof row.rates_reportable === 'boolean' ? row.rates_reportable : true;
}

/**
 * May this cell's CONVERSION rate be quoted — a different flag, because it is a
 * different denominator, and **the one place on this surface that fails CLOSED.**
 *
 * `rates_reportable` counts DIALS and this rate divides by CONNECTS, so gating the
 * conversion view on it would let a 20-dial/1-connect/1-conversion cell paint 100%
 * as the brightest square on the map.
 *
 * ── Absent means WITHHELD here, unlike everywhere else in the phase ────────
 * The roster's `successRateReportable` and the contribution table's
 * `contributionSuccessRateReportable` both fall back to `rates_reportable` when the
 * field is missing, on the stated grounds that it is "exactly what the cell gated
 * on before the field existed". This function did the same and it was wrong, for
 * two reasons that do not apply to either of those tables:
 *
 *  1. **The fallback IS the bug at 168× scale.** `rates_reportable` is
 *     `attempts >= 20`, so a cell with 20 dials, 1 connect and 1 conversion clears
 *     it — and its served `success_rate_pct` is `100`. On a ramp whose honest
 *     values top out near a floor median of ~30% that cell is not merely quoted,
 *     it is the DARKEST square on the map and it sets the domain's upper end,
 *     compressing every trustworthy cell into the bottom third. That is E5's exact
 *     failure, and E5 is a ruling about this grid.
 *  2. **Colour reads as authority in a way a table cell does not.** A withheld
 *     roster cell is a phrase a reader can weigh; a dark square is a finding
 *     already made. The roster's "absent means do not withhold" precedent is a
 *     judgement about a column of words, and it does not carry to a colour ramp.
 *
 * The cost is bounded and visible: on a core that predates the field the CONVERSION
 * view hatches every cell, `bestHoursWithheldReadout` says how many and advises a
 * longer window, and the other two views — including `volume`, which is always
 * reportable by construction (E6) — are untouched. A map that says "I cannot rate
 * these" is recoverable; a map that paints one answered call as the best hour of
 * the week is not.
 */
function successRateReportable(row: AgencyGroupRow): boolean {
  return row.success_rate_reportable === true;
}

function cellKey(day: number, hour: number): string {
  return `${day}:${hour}`;
}

/**
 * The rows indexed by cell, ignoring anything outside 0–6 × 0–23.
 *
 * A row whose key is out of range is a contract violation rather than a cell, and
 * dropping it is the only option that does not either throw during a render or
 * invent a 25th column. A duplicate key keeps the FIRST row: the read is grouped, so
 * two rows for one cell cannot happen, and silently summing them would invent a
 * total the server never served.
 */
function indexRows(rows: readonly AgencyGroupRow[]): Map<string, AgencyGroupRow> {
  const byCell = new Map<string, AgencyGroupRow>();
  for (const row of rows) {
    const day = row.key.day_of_week;
    const hour = row.key.hour_of_day;
    if (typeof day !== 'number' || typeof hour !== 'number') continue;
    if (!Number.isInteger(day) || day < 0 || day >= BEST_HOURS_DAYS) continue;
    if (!Number.isInteger(hour) || hour < 0 || hour >= BEST_HOURS_HOURS) continue;
    const key = cellKey(day, hour);
    if (!byCell.has(key)) byCell.set(key, row);
  }
  return byCell;
}

/**
 * One cell's figure for one view, as the union above.
 *
 * The order of the arms is the roster's and is not arbitrary: `null` is checked
 * BEFORE the reportable flag, so a cell with no denominator says what has not
 * happened rather than "too few to rate", which would imply a number is being held
 * back when there is none.
 */
function measureCell(row: AgencyGroupRow, view: BestHoursView, day: number, hour: number): BestHoursCell {
  const base = { day, hour, attempts: row.attempts };
  const dials = `${agentCount(row.attempts)} ${row.attempts === 1 ? 'dial' : 'dials'}`;

  if (view === 'volume') {
    /*
      No gate, and that is the point of this view: a count needs no minimum volume
      because it IS the volume. It is the one view that is always reportable, which
      is why the surface keeps it beside two that are not.
    */
    return {
      ...base,
      state: 'measured',
      text: agentCount(row.attempts),
      value: row.attempts,
      note: dials,
    };
  }

  if (view === 'connect_rate') {
    if (row.connect_rate_pct === null) {
      /*
        Unreachable on an attempts-driven read — `COUNT(*)` over an inner-joined
        `GROUP BY` filtered on `dialed_at IS NOT NULL` cannot emit a zero, so
        `attempts >= 1` on every served row. Kept as the inert arm rather than a
        sentence about a state nobody can explain, exactly as the roster's
        `connectRateCell` keeps its own.
      */
      return { ...base, state: 'unmeasured', text: agentCount(row.attempts), value: null, note: `${dials} · not measured` };
    }
    if (!ratesReportable(row)) {
      return {
        ...base,
        state: 'withheld',
        text: agentCount(row.attempts),
        value: null,
        // The roster's own words and the roster's own helper, so a withheld cell
        // here and a withheld cell on the table cannot come to say it differently.
        note: withheldRateCell(row.attempts, 'dials').note,
      };
    }
    return {
      ...base,
      state: 'measured',
      text: agentPct(row.connect_rate_pct),
      value: row.connect_rate_pct,
      note: `${agentPct(row.connect_rate_pct)} of ${dials} connected`,
    };
  }

  if (row.success_rate_pct === null) {
    /*
      REACHABLE and ordinary here: an hour that dialled and reached nobody. It says
      so rather than printing `0%`, which would read as an hour with forty
      conversations and no bookings — a different and much worse finding.
    */
    return {
      ...base,
      state: 'unmeasured',
      text: agentCount(row.attempts),
      value: null,
      note: `${dials} · no connect to convert yet`,
    };
  }
  if (!successRateReportable(row)) {
    return {
      ...base,
      state: 'withheld',
      text: agentCount(row.attempts),
      value: null,
      // CONNECTS, not dials: this rate's denominator, named as the roster names it.
      note: withheldRateCell(row.connected, 'connects').note,
    };
  }
  return {
    ...base,
    state: 'measured',
    text: agentPct(row.success_rate_pct),
    value: row.success_rate_pct,
    note: `${agentPct(row.success_rate_pct)} of ${agentCount(row.connected)} ${
      row.connected === 1 ? 'connect' : 'connects'
    } converted`,
  };
}

/**
 * The whole 7 × 24 matrix for one view, and the scale's domain with the thin cells
 * left out of it.
 *
 * ── Why the domain excludes them ──────────────────────────────────────────
 * Left in, one 100%-on-two-dials cell compresses every honest cell into the bottom
 * fifth of the ramp, and the map's useful contrast is destroyed by the least
 * trustworthy number on it. The roster already refuses this for its bullet's axis
 * (`rosterConnectAxis` skips withheld rates so a rate the table never prints cannot
 * rescale the column); the same rule at 168 cells is what keeps the colour attached
 * to values the surface is willing to quote.
 *
 * ── A pale ramp step is not a "not enough calls" treatment ─────────────────
 * A thin cell is not given the bottom step of the ramp: a pale colour is still a
 * position on the scale, and it reads as a low value rather than as an absent one.
 * It gets a treatment that is not on the ramp at all, and it keeps its dial count.
 */
export function bestHoursMatrix(
  page: AgencyGroupPage,
  view: BestHoursView,
  coverage: BestHoursCoverage,
): BestHoursMatrix {
  const byCell = indexRows(page.rows);
  const rows: BestHoursRow[] = [];
  const uncoveredDays: number[] = [];
  let min: number | null = null;
  let max: number | null = null;
  let dialled = 0;
  let withheld = 0;
  let unmeasured = 0;
  let outOfWindow = 0;

  for (let day = 0; day < BEST_HOURS_DAYS; day += 1) {
    const coveredHours = coverage.covered.get(day);
    const cells: BestHoursCell[] = [];
    for (let hour = 0; hour < BEST_HOURS_HOURS; hour += 1) {
      const row = byCell.get(cellKey(day, hour));
      if (row !== undefined) {
        dialled += 1;
        const cell = measureCell(row, view, day, hour);
        if (cell.state === 'withheld') withheld += 1;
        if (cell.state === 'unmeasured') unmeasured += 1;
        if (cell.state === 'measured' && cell.value !== null) {
          min = min === null || cell.value < min ? cell.value : min;
          max = max === null || cell.value > max ? cell.value : max;
        }
        cells.push(cell);
        continue;
      }
      /*
        No row, so no dial landed in this cell — and the whole of E4 is that this
        says two different things. With no zone there is no honest way to tell them
        apart, so the third state is the answer rather than a guess.
      */
      if (!coverage.known) {
        cells.push({
          day,
          hour,
          state: 'unknown_coverage',
          text: '',
          value: null,
          attempts: null,
          note: 'No dial here, and this build cannot say whether this hour was in the window',
        });
        continue;
      }
      if (coveredHours?.has(hour) === true) {
        cells.push({
          day,
          hour,
          state: 'no_dials',
          text: '0',
          value: null,
          attempts: 0,
          note: 'In the window, and nobody dialled',
        });
        continue;
      }
      outOfWindow += 1;
      cells.push({
        day,
        hour,
        state: 'out_of_window',
        text: '',
        value: null,
        attempts: null,
        note: 'Not in this window — never asked about',
      });
    }
    const coveredCount = coverage.known ? coveredHours?.size ?? 0 : BEST_HOURS_HOURS;
    if (coverage.known && coveredCount === 0) uncoveredDays.push(day);
    rows.push({
      day,
      label: weekdayName(day),
      short: BEST_HOURS_WEEKDAYS_SHORT[day] ?? weekdayName(day),
      cells,
      coveredHours: coveredCount,
    });
  }

  return {
    view,
    rows,
    domain: min === null || max === null ? null : { min, max },
    dialled,
    withheld,
    unmeasured,
    outOfWindow,
    coverageKnown: coverage.known,
    uncoveredDays,
  };
}

/** How many steps the ramp has. Five: enough to read a gradient, few enough to tell apart. */
export const BEST_HOURS_STEPS = 5;

/**
 * Where a measured value sits on the ramp, `0` … `BEST_HOURS_STEPS - 1`.
 *
 * ── This is geometry, not a rate ──────────────────────────────────────────
 * It is the roster bullet's `share(value, axis)` over a domain instead of an axis,
 * and it deliberately does NOT go through `ratePct`: that helper answers "what
 * percentage is this" and returns `null` on a zero denominator so a reader is never
 * shown a rate the data cannot support. A ramp position is not shown to anybody — the
 * cell prints its own served number beside the colour — so the honest behaviour for a
 * degenerate domain is a defined step rather than an absent one.
 *
 * A single-valued domain paints every coloured cell at the TOP step, and the scale
 * readout then states the one value rather than a range. Spreading one value across
 * five steps would be a gradient with no information in it.
 */
export function bestHoursStep(value: number, domain: BestHoursDomain | null): number {
  if (domain === null) return 0;
  if (!(domain.max > domain.min)) return BEST_HOURS_STEPS - 1;
  const share = (value - domain.min) / (domain.max - domain.min);
  const step = Math.floor(share * BEST_HOURS_STEPS);
  return Math.max(0, Math.min(BEST_HOURS_STEPS - 1, step));
}

/** A view's own format — percentages for the two rates, a count for volume. */
export function bestHoursFormat(view: BestHoursView, value: number): string {
  return view === 'volume' ? agentCount(value) : agentPct(value);
}

// ─── What the surface says about the map ─────────────────────────────────────

/**
 * `42 of 168 weekday-hour cells had a dial` — the population behind the map.
 *
 * The cell count is stated rather than implied because 168 is the whole point of the
 * read: it is one request at the default limit, and a reader who can see that the
 * map is 168 cells can also see that a map with four coloured squares is a window
 * problem rather than a campaign finding.
 */
export function bestHoursCountReadout(matrix: BestHoursMatrix): string {
  const cells = matrix.rows.reduce((total, row) => total + row.cells.length, 0);
  const had = matrix.dialled === 1 ? '1 weekday-hour cell had a dial' : `${agentCount(matrix.dialled)} weekday-hour cells had a dial`;
  return `${had}, of ${agentCount(cells)}`;
}

/**
 * What the two ends of the ramp mean, in numbers — and that the thin cells are
 * outside it.
 *
 * A heatmap may not rely on colour alone, and a legend that names only the hue
 * order ("darker is better") is exactly that: it tells the reader which end is
 * which and nothing about what either end is worth. So the scale is stated in the
 * view's own units, and the cells that are NOT on it are named in the same breath —
 * a reader who has not been told that the hatched squares are off the scale will
 * read them as its bottom step.
 */
export function bestHoursScaleReadout(matrix: BestHoursMatrix): string {
  const metric = BEST_HOURS_VIEW_LABELS[matrix.view].toLowerCase();
  if (matrix.domain === null) {
    return matrix.view === 'volume'
      ? `Nothing is coloured: no cell has a dial in this window.`
      : `Nothing is coloured: no cell has enough calls for its ${metric} to be rated.`;
  }
  const { min, max } = matrix.domain;
  const range =
    max > min
      ? `Lightest ${bestHoursFormat(matrix.view, min)} → darkest ${bestHoursFormat(matrix.view, max)}`
      : `Every coloured cell is ${bestHoursFormat(matrix.view, min)}`;
  if (matrix.view === 'volume') {
    // No gate on a count, so there is nothing sitting outside this scale to warn
    // about — and claiming there might be would be a sentence about nothing.
    return `${range}, by ${metric}.`;
  }
  return (
    `${range}, by ${metric}. Cells with too few calls to rate are not on this scale ` +
    `at all — they show their dial count instead, so a bright square is never one ` +
    `answered call.`
  );
}

/**
 * How many cells were WITHHELD, said out loud — or `null` when none were.
 *
 * ── Why the count is on the surface rather than left to the eye ────────────
 * A map that is mostly withheld is a map whose window is too short, and the reader
 * has to be able to SEE that rather than infer it from a lot of grey. The count is
 * also the only way to tell "this campaign does not dial at night" from "this
 * campaign barely dialled at all this week", which are opposite instructions.
 *
 * The remedy is named only when most of the dialled cells are withheld: on a map
 * where three cells out of forty are thin, "try a longer window" is advice about
 * nothing.
 */
export function bestHoursWithheldReadout(matrix: BestHoursMatrix): string | null {
  if (matrix.withheld <= 0) return null;
  const cells = matrix.withheld === 1 ? '1 cell has' : `${agentCount(matrix.withheld)} cells have`;
  const stem =
    `${cells} dials but too few calls to rate, so ${matrix.withheld === 1 ? 'it is' : 'they are'} ` +
    `not coloured — ${matrix.withheld === 1 ? 'it shows' : 'they show'} the dial count instead.`;
  // Strictly more than half, so an even split is not called "most of".
  const mostly = matrix.withheld * 2 > matrix.dialled;
  return mostly
    ? `${stem} That is most of the ${agentCount(matrix.dialled)} cells that were dialled at all — try a longer window before reading this map.`
    : stem;
}

/**
 * Which figures the map is NOT showing because the window never covered them, or
 * `null` when it covered everything.
 *
 * Named weekday by weekday when whole rows are missing, because that is the shape
 * of the misreading: a blank Tuesday row reads as "stop staffing Tuesdays", and the
 * only thing that stops it reading that way is a sentence saying Tuesday was not in
 * the window.
 */
export function bestHoursCoverageNote(matrix: BestHoursMatrix): string | null {
  if (!matrix.coverageKnown) {
    return (
      'Without the timezone these hours were cut in, this map cannot tell a weekday ' +
      'that was never in the window from one nobody dialled. Blank cells are one or ' +
      'the other, and it does not guess which.'
    );
  }
  if (matrix.outOfWindow <= 0) return null;
  if (matrix.uncoveredDays.length > 0) {
    const names = matrix.uncoveredDays.map((day) => weekdayName(day));
    const plural = names.length > 1;
    return (
      `${joinList(names)} ${plural ? 'were' : 'was'} not in this window at all, so ` +
      `${plural ? 'those rows are' : 'that row is'} blank rather than zero. A weekday ` +
      'nobody was asked about is not a weekday that connected nobody.'
    );
  }
  return (
    `${agentCount(matrix.outOfWindow)} cells fall outside this window — it starts or ends ` +
    'part-way through a day — so they are blank rather than zero.'
  );
}

/** `Tuesday, Wednesday and Thursday`. Serial commas are not this product's voice. */
function joinList(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  const head = items.slice(0, -1).join(', ');
  return `${head} and ${items[items.length - 1] ?? ''}`;
}

/**
 * What ONE cell says, in full — for its `title` and its screen-reader label.
 *
 * Every figure on the cell is in it: where it is, in which zone, and what its
 * number means. The colour is the scan and the number is the answer, and this is
 * what makes the number readable when a reader cannot tell two steps of a ramp
 * apart.
 */
export function bestHoursCellLabel(cell: BestHoursCell, zone: string | null): string {
  return `${bestHoursCellCoordinates(cell.day, cell.hour, zone)} — ${cell.note}`;
}
