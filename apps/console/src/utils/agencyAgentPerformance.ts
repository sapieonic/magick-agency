import { startOfDay, startOfMonth, startOfWeek, subMonths, subWeeks } from 'date-fns';
import { formatDuration } from './agencyClock';
import { assignmentEntry } from './agencyAssignmentEntry';
import { AGENCY_FLOOR_STATE_LABELS } from './agencyAgentFloor';
import type { AgencyAgentLiveState } from '../types/agency-campaign';
import type {
  AgencyAgentStats,
  AgencyAgentStatsBucket,
  AgencyAgentStatsTotals,
  AgencyOccupancy,
  AgencyStaffingHistoryEntry,
} from '../types/agency-stats';
import type { PerformanceReadout } from './agencyCampaignPerformance';

/**
 * The agent performance surface's derivations, as pure functions.
 *
 * Same reasoning as `agencyCampaignPerformance` and `agencyHealthStrip`: every
 * sentence produced here is a claim about a person's shift, and a derivation is
 * a place to be confidently wrong. They are tested against fixtures rather than
 * eyeballed on a screen.
 *
 * ── The one rule the whole module is built around ───────────────────────────
 * **A `null` rate is NOT MEASURED YET, and must never render as `0.0%`.** The
 * house precedent is `abandonment_rate_24h_pct` — *"a health strip with no
 * diagnosis reads as nothing wrong when the truth is nothing measured"* — and it
 * bites harder here, because the reader is the person being measured. `0.0%`
 * conversion on an agent's first morning is the product telling them they failed
 * at something they have not yet had the chance to do.
 *
 * So there are three absences and they read differently, exactly as they do on
 * the supervisor's side:
 *
 *  1. **`undefined`** — the payload did not carry the field. An em dash and
 *     "didn't load". Never `0`, and never "no data".
 *  2. **`null`** — the server carried it and has nothing to measure. "Not
 *     measured yet", with a sentence naming what has not happened.
 *  3. **A real `0`** — rendered as `0`. The only one of the three that is a
 *     claim about the shift, and the one the other two must not be confused
 *     with.
 *
 * ── Dials and conversations are never collapsed ─────────────────────────────
 * `attempts` and `connected` are always surfaced as two numbers with the connect
 * rate between them (`headlineTrio`). That is a product decision rather than a
 * layout one: "calls" is ambiguous in exactly the way that matters to somebody
 * being measured on it, and an agent who reads one number cannot tell whether
 * they are being credited for dialling or for talking. The labels say which is
 * which in the product's words, not in the wire's.
 */

// ─── The periods ─────────────────────────────────────────────────────────────

/**
 * The three TO-DATE ranges — each one ends at `now`.
 *
 * One fetch per range rather than one month-wide fetch summed client-side, and
 * that is deliberate. Buckets are cut in each campaign's timezone (see
 * {@link BUCKET_TIMEZONE_NOTE}), so re-adding day buckets into "today" would
 * produce a "today" that belongs to a campaign's clock rather than the reader's.
 * Weeks and months are unions of whole buckets and would sum correctly — but
 * having one period derived by the server and another by the client is how two
 * numbers for one fact appear on one screen. The dialer runtime defines every range.
 *
 * ── These are no longer the whole vocabulary of either surface ─────────────
 * `AgentStatsWindow` below adds the two COMPLETED ranges, and both the roster
 * and the per-agent panel now offer all five. This type survives because
 * `periodRange` is where a to-date range is defined and `windowRange` delegates
 * to it — not because three is a set any surface still shows on its own.
 */
export type AgentStatsPeriod = 'today' | 'week' | 'month';

export interface AgentStatsRange {
  /** ISO-8601 instant, inclusive. */
  from: string;
  /**
   * ISO-8601 instant, EXCLUSIVE — the window is `[from, to)`.
   *
   * "Now" for the three to-date periods, because a period in progress has no end
   * yet. The two COMPLETED windows {@link AgentStatsWindow} adds are the other
   * case: their `to` is the start of the current period, so the range is closed
   * and the same question asked twice gives the same answer.
   */
  to: string;
}

/**
 * The range for a period, anchored on the reader's own clock.
 *
 * ── Weeks start Monday, on purpose ──────────────────────────────────────────
 * `date-fns` defaults to Sunday and this passes `weekStartsOn: 1` instead. An
 * agency week is a working week: an agent looking at "this week" on a Monday
 * morning wants the shift they are in, and a Sunday-anchored week hands them
 * yesterday's numbers as though they were this week's. The value is stated here
 * rather than left to the default so that a future locale-aware default cannot
 * silently move an agent's week under them.
 *
 * `now` is a parameter rather than read from the clock inside, which is what
 * makes every boundary case (a Monday 00:01, the 1st of a month) a test rather
 * than a thing to reason about.
 *
 * ── The ranges COINCIDE at boundaries, and that is the right answer ─────────
 * On a Monday `today` and `week` are the same instant, and on a 1st that falls
 * on a Monday all three are. Both are true statements about the reader's shift —
 * an agent's week on Monday morning *is* their morning — so nudging either
 * anchor to keep the three ranges looking distinct would put last week's numbers
 * under a "This week" heading to satisfy an arithmetic that nobody reads.
 *
 * The consequence is a rule for callers: **a period is identified by its name,
 * never by its range.** `useAgentPerformance` keys its three states on
 * {@link AgentStatsPeriod} for exactly this reason, and anything that keys on
 * `from` instead — a cache, a de-duplicated fetch, a `Set` of ranges — collapses
 * three tiles into two one day in seven. That was the whole of the
 * `AgentPerformancePage` defect: the page asked correctly and the assertion
 * counted distinct timestamps, so it was green Tuesday to Sunday and red every
 * Monday.
 */
export function periodRange(period: AgentStatsPeriod, now: Date): AgentStatsRange {
  const to = now.toISOString();
  if (period === 'today') return { from: startOfDay(now).toISOString(), to };
  if (period === 'week') return { from: startOfWeek(now, { weekStartsOn: 1 }).toISOString(), to };
  return { from: startOfMonth(now).toISOString(), to };
}

// ─── The roster's windows: the three above, plus two COMPLETED ones ───────────

/**
 * The five windows — the three to-date periods, plus last week and last month.
 *
 * ── Why the completed two exist at all ─────────────────────────────────────
 * Every {@link AgentStatsPeriod} ends at `now`, and that is a hole rather than a
 * rounding. A supervisor's weekly review happens on a Monday morning: at 09:30
 * "this week" is ninety minutes of dials, so every row sits under
 * `AGENCY_ROSTER_MIN_RATE_DENOMINATOR`, every rate reads "not enough calls",
 * `agents_rated` is 0 and every band reads "no median yet" — the screen is
 * useless at exactly the moment it is opened. A to-date window cannot answer
 * "how did the floor do", because the floor has not done it yet.
 *
 * ── This was a roster-only vocabulary, and that was the defect ─────────────
 * It used to be, and the reason recorded here was that the per-agent panel
 * "shows three tiles side by side" and `PeriodStates` is a `Record` over three —
 * a layout and a type, standing in for a product decision. The argument above
 * never was roster-specific: an agent opening their own numbers on a Monday
 * morning, or on the 1st of a month, reads exactly the same empty screen about
 * themselves, and unlike the supervisor they had no other window to switch to.
 * *"What did I do last month"* had no answer anywhere in the product.
 *
 * So both surfaces now offer all five. The panel takes the list it renders as a
 * prop and `useAgentPerformance` fires one request per window in that list, so
 * "how many tiles" is a caller's decision rather than a property of this type.
 *
 * A consequence worth stating, because it removes a documented compromise:
 * `windowPeriod`'s lossy roster→panel mapping is gone. A supervisor drilling in
 * from a `last_week` roster now lands on `last_week`, not on "this week".
 *
 * ── Every range stays inside BOTH of the server's window caps, which differ ───────
 * There are two, and conflating them is a live trap rather than a pedantic
 * distinction — the server says so itself, in a docblock titled "Why this is NOT
 * `AGENT_STATS_MAX_WINDOW_DAYS`":
 *
 *   • `AGENT_STATS_MAX_WINDOW_DAYS` = **366** guards the PER-AGENT read, which is
 *     what `AgentPerformancePanel` calls. A full year, deliberately: "the longest
 *     range a 'my record' screen has any use for".
 *   • `ROSTER_MAX_WINDOW_DAYS` = **92** guards the whole-floor roster and the
 *     grouped reads. It is lower because those name no agent and pull every
 *     transition for every agent in the account.
 *
 * The widest range this vocabulary can produce is a calendar month (31 days), so
 * every window clears both — and none is user-typed, so there is nothing to
 * validate.
 *
 * ── Before adding a member, read this ───────────────────────────────────────
 * This list is NOT panel-private. It is rendered as the option list on four
 * surfaces governed by those two different caps: `AgentPerformancePanel` (366),
 * but also `AgentAnalyticsSection`, `BestHours` and `CampaignContribution` (92).
 * So a `last_12_months` member added HERE would work on the agent's own page and
 * hard-400 three supervisor surfaces. A window wider than 92 days belongs in a
 * list passed to the panel through its `windows` prop, which exists for exactly
 * this — not in the shared default.
 *
 * There is no `all_time` member because the server states no such total, and a
 * client-side sum over the windows would be a number for a fact nobody reported.
 * That is a product choice about vocabulary, NOT a server ceiling — the endpoint
 * reaches a year. See `AGENT_HISTORY_REACH_NOTE`.
 */
export type AgentStatsWindow = AgentStatsPeriod | 'last_week' | 'last_month';

/**
 * In reading order: the two live windows a supervisor watches during the day,
 * then each completed one immediately after the to-date period it closes.
 * "This week / Last week" adjacent is what makes the pair legible as one choice
 * about which week rather than two unrelated options.
 */
export const AGENT_STATS_WINDOWS: readonly AgentStatsWindow[] = [
  'today',
  'week',
  'last_week',
  'month',
  'last_month',
];

/** In the product's voice — how an agent would name the range out loud. */
export const AGENT_STATS_WINDOW_LABELS: Record<AgentStatsWindow, string> = {
  today: 'Today',
  week: 'This week',
  last_week: 'Last week',
  month: 'This month',
  last_month: 'Last month',
};

/**
 * The range for a roster window, anchored on the reader's own clock.
 *
 * The three to-date windows delegate to {@link periodRange} rather than
 * recomputing — one definition of "this week" for the roster and for the panel a
 * supervisor drills into, or the same person's Monday is two different ranges one
 * click apart.
 *
 * ── The completed windows are half-open and END where the current one starts ──
 * `last_week` is `[startOfWeek(now - 7d), startOfWeek(now))` and `last_month` is
 * `[startOfMonth(now - 1mo), startOfMonth(now))`. Taking `to` from the CURRENT
 * period's start rather than from an `endOf*` is what keeps the boundary exact:
 * `endOfWeek` is the last millisecond of Sunday, and a half-open range whose end
 * is 23:59:59.999 silently drops any dial in that final millisecond. It also
 * means the two ranges tile perfectly with their to-date siblings — no attempt is
 * in both, and none is in neither.
 *
 * Monday-anchored for the same reason `periodRange` is: an agency week is a
 * working week.
 */
export function windowRange(window: AgentStatsWindow, now: Date): AgentStatsRange {
  if (window === 'last_week') {
    return {
      from: startOfWeek(subWeeks(now, 1), { weekStartsOn: 1 }).toISOString(),
      to: startOfWeek(now, { weekStartsOn: 1 }).toISOString(),
    };
  }
  if (window === 'last_month') {
    return {
      from: startOfMonth(subMonths(now, 1)).toISOString(),
      to: startOfMonth(now).toISOString(),
    };
  }
  return periodRange(window, now);
}

/**
 * How far back the numbers on an agent's own page can see, in the product's
 * voice — rendered beneath the tiles rather than left to be discovered.
 *
 * Why it says "the windows we show" and NOT "as far as we can go": the limit is
 * ours, not the server's. The per-agent read accepts a full year
 * (`AGENT_STATS_MAX_WINDOW_DAYS` = 366); "last month" is the furthest this
 * VOCABULARY reaches. An earlier version of this string blamed a 92-day server
 * cap, which is the roster's bound and does not apply to this endpoint — it told
 * an agent who worked here in March that March was unreachable, which was false.
 * If a wider tile is ever added, this note should shrink rather than be re-argued.
 *
 * It still points at `/dialer/attempts`, but for FINDING rather than counting,
 * and the distinction is the honest part: that list filters on `created_at` with
 * a user-chosen day range and no window cap, so every dial an agent has ever
 * placed is reachable there — but its only readout is the number of rows loaded
 * so far, 50 at a time. It can show an agent a call from March. It cannot tell
 * them how many they made, and this note must not imply that it can.
 */
export const AGENT_HISTORY_REACH_NOTE =
  'These are the windows we show — the furthest back is last month. To find older calls, open My calls and pick the days you want.';

// ─── Formatting primitives ───────────────────────────────────────────────────

/**
 * One decimal, trailing zero trimmed — the same rule `agencyHealthStrip` and
 * `agencyCampaignPerformance` use, so one product never prints `18%` on one
 * screen and `18.0%` on the next.
 */
export function agentPct(value: number): string {
  return `${Number(value.toFixed(1))}%`;
}

/**
 * Whole seconds as `m:ss`, rolling to `h:mm:ss`. A real `0` renders `0:00`.
 *
 * Exported alongside {@link agentPct} for the same reason: the roster table shows
 * the same figures one level up (a column of handle times against a cohort's) and
 * a second `toFixed(1)` or a second duration format would let one product print
 * `18%` on one screen and `18.0%` on the next — or `1:05` beside `65s`.
 */
export function agentSeconds(value: number): string {
  return formatDuration(value * 1000);
}

/**
 * The same duration with its UNITS said out loud — `1m 14s`, `31h 40m`.
 *
 * ── Why a second duration format exists at all ────────────────────────────
 * {@link agentSeconds} is a stopwatch, which is right in a numeric CELL: the
 * column is right-aligned and tabular, every value has the same shape, and a
 * reader scanning it is comparing lengths rather than reading quantities. It
 * fails in PROSE, and it fails worst on exactly the figures that matter most:
 * pooled over a 200-agent floor the utilisation basis read
 * `4800:00:00 handled of 8000:00:00 on shift`, a stopwatch expressing five-figure
 * hours on the line most likely to be quoted in a pay review, and the team row's
 * handling-time band read `median 22:00`, distinguishable from twenty-two HOURS
 * only by counting colons.
 *
 * So the rule this codebase now holds is: **cells keep the stopwatch, sentences
 * name the unit.** Both come from one module, so neither can drift.
 *
 * Seconds are dropped once there is an hour, and a zero component is omitted
 * rather than padded — `2h` rather than `2h 0m`, because the reader is being told
 * a magnitude, not read a clock.
 */
export function agentDurationLong(value: number): string {
  const total = Math.max(0, Math.round(value));
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
 * The window the figures on screen were measured over, as DATES and a zone.
 *
 * ── Why "This week" is not a label these tables can ship with ─────────────
 * Every one of these surfaces titled itself with the name of its window, and the
 * name is not a range: a supervisor quoting a conversion rate in a pay
 * conversation, or a dealer disputing a booking count, needs to know which days
 * were counted — and "this week" on a Monday morning means something different
 * every hour. The zone is on it for the same reason the grouped route refuses a
 * time dimension it cannot resolve one for: the day a dial lands in is a
 * statement about a timezone.
 *
 * The zone is the READER's, because that is what {@link windowRange} cut the
 * range in (it builds the bounds from a local `Date`). It is named rather than
 * implied so that two people in two offices comparing the same screen can see
 * why their numbers differ.
 *
 * `to` is EXCLUSIVE on every one of these reads, so the last day shown is the
 * instant before it — otherwise a week ending at midnight on the 24th would be
 * labelled as including the 24th, which is the off-by-one the half-open bound
 * exists to avoid.
 *
 * `null` on anything unparseable: this is a caption, and a caption is the last
 * place to render `Invalid Date`.
 */
export function windowRangeReadout(from: string, to: string): string | null {
  const start = new Date(from);
  const endExclusive = new Date(to);
  if (Number.isNaN(start.getTime()) || Number.isNaN(endExclusive.getTime())) return null;
  const end = new Date(endExclusive.getTime() - 1);
  if (end.getTime() < start.getTime()) return null;

  const day = (date: Date) =>
    date.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
  const zone = readerTimeZone();

  const sameDay =
    start.getFullYear() === end.getFullYear() &&
    start.getMonth() === end.getMonth() &&
    start.getDate() === end.getDate();
  if (sameDay) return `${day(start)} ${end.getFullYear()} · ${zone}`;

  // Both years only when they differ — a range that straddles a new year is the
  // one case where one of them is not enough.
  const startLabel =
    start.getFullYear() === end.getFullYear()
      ? day(start)
      : `${day(start)} ${start.getFullYear()}`;
  return `${startLabel} – ${day(end)} ${end.getFullYear()} · ${zone}`;
}

/**
 * The zone the reader's browser is in, or `UTC` when it will not say.
 *
 * `resolvedOptions()` is specified to return an IANA name, but a caption must not
 * be the thing that throws in an environment with a partial `Intl`.
 */
function readerTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/**
 * A percentage from a part and a whole, or **`null` on a zero denominator**.
 *
 * ── The one division helper, and why there is exactly one ─────────────────
 * Almost every rate on these surfaces is SERVED, and that is deliberate: two
 * places dividing is two answers that round differently. The exceptions are the
 * figures no payload carries — the floor's pooled utilisation, once the benchmark
 * gained a pooled `shift_seconds`, and one agent's share of a campaign's
 * conversions — and both of them route through here rather than through a
 * hand-rolled `n / d * 100`.
 *
 * The guard is the whole point. `0 / 0` is `NaN`, `NaN.toFixed(1)` is `"NaN"`,
 * and `NaN` serialises to `null` — so a hand-rolled rate is wrong in a way that
 * is invisible on the wire and legible only as a broken cell on screen. Here a
 * zero denominator is `null`, which this codebase's null-not-zero rule then
 * renders as an em dash and a phrase naming what has not happened. **A real `0`
 * numerator over a real denominator still returns `0`** — measured-and-zero is a
 * finding, and softening it would be the same dishonesty in the other direction.
 *
 * Non-finite inputs are `null` for the same reason: a figure this client cannot
 * vouch for must not reach a reader as a number.
 */
export function ratePct(part: number, whole: number): number | null {
  if (!Number.isFinite(part) || !Number.isFinite(whole)) return null;
  if (whole <= 0) return null;
  return (part / whole) * 100;
}

/*
  The private aliases the rest of this module was written against. Kept so the
  ~30 existing call sites read as they always did — the exports above are the
  single definition, these are two names for it.
*/
const pct = agentPct;
const seconds = agentSeconds;

/**
 * A count, thousands-separated.
 *
 * Deliberately not `format.ts`'s number helper, which collapses `0`, `null` and
 * `undefined` into one `'--'`. On this page those are three different facts and
 * a zero dial count is a true one.
 */
export function agentCount(value: number | undefined): string {
  return typeof value === 'number' ? value.toLocaleString() : '—';
}

// ─── The headline trio ───────────────────────────────────────────────────────

/** One of the three headline figures, in the order they are read. */
export interface HeadlineFigure {
  key: 'attempts' | 'connect_rate' | 'connected';
  label: string;
  /**
   * What the label means, in one short clause. **Rendered**, not advisory.
   *
   * It was populated here and read by nothing for the whole life of the feature,
   * so an agent saw a bare `Dials · Connect rate · Conversations` while their
   * supervisor's campaign screens explained every one of their own figures — with
   * the person being measured the one left guessing. `AgentPerformancePanel`
   * renders these as a definition list beneath the tiles.
   */
  hint: string;
  value: string;
  /** False when {@link value} is a stand-in for an absent measurement. */
  known: boolean;
}

/**
 * Dials · connect rate · conversations — always all three, always in that order.
 *
 * The middle figure is the rate rather than a derived total on purpose: with the
 * denominator on its left and the numerator on its right, the rate cannot be
 * read as a fourth independent number. Collapsing any of the three into a single
 * "calls" figure is the thing this function exists to make impossible at every
 * call site.
 */
export function headlineTrio(totals: AgencyAgentStatsTotals | undefined): HeadlineFigure[] {
  const rate = totals?.connect_rate_pct;
  return [
    {
      key: 'attempts',
      label: 'Dials',
      /*
        "Calls placed TO you" was backwards, and backwards in the one way that
        matters on this screen: this is an outbound predictive dialer. The server places
        the dial to a CUSTOMER and reserves an agent onto it — nothing is placed to
        the agent — so an agent reading the old clause would reasonably conclude
        the tile was counting calls that came in.
      */
      hint: 'Calls the dialer placed and handed to you, whether or not anyone picked up.',
      value: agentCount(totals?.attempts),
      known: typeof totals?.attempts === 'number',
    },
    {
      key: 'connect_rate',
      label: 'Connect rate',
      hint: 'How often a dial reached a person.',
      // `null` is "nobody has been dialled yet", which is not a 0% connect rate:
      // a dial that never happened has not failed to reach anybody.
      value: rate === undefined ? '—' : rate === null ? 'Not measured yet' : pct(rate),
      known: typeof rate === 'number',
    },
    {
      key: 'connected',
      label: 'Conversations',
      hint: 'Dials where you actually spoke to someone.',
      value: agentCount(totals?.connected),
      known: typeof totals?.connected === 'number',
    },
  ];
}

// ─── The derived readouts ────────────────────────────────────────────────────

/**
 * Conversion rate — successes over **conversations**, not over dials.
 *
 * The denominator is the entire meaning of this number and the two readings are
 * nowhere near each other: a fifth of your conversations is a strong day, a
 * fifth of your dials is not a thing that happens. So the label and the detail
 * both name the denominator rather than leaving "conversion rate" to be read
 * against whichever number is nearest on screen.
 */
export function conversionRateReadout(
  totals: AgencyAgentStatsTotals | undefined,
): PerformanceReadout {
  const rate = totals?.success_rate_pct;
  const successes = totals?.successes;
  const secondary = typeof successes === 'number' ? `${successes.toLocaleString()} counted` : null;

  if (rate === undefined) {
    return {
      value: '—',
      detail: 'Your conversion rate didn’t load.',
      caveat: null,
      secondary,
      known: false,
    };
  }
  if (rate === null) {
    return {
      value: 'Not measured yet',
      detail: 'You haven’t had a conversation to convert yet.',
      caveat: null,
      secondary,
      known: false,
    };
  }
  return {
    value: pct(rate),
    detail: 'Calls that counted as a win, out of the ones where you spoke to someone — not out of every dial.',
    caveat: null,
    secondary,
    known: true,
  };
}

/** Average handle time. `null` is "no call has finished", never a fast shift. */
export function handleTimeReadout(
  totals: AgencyAgentStatsTotals | undefined,
): PerformanceReadout {
  const aht = totals?.aht_seconds;
  const talk = totals?.talk_seconds;
  const secondary = typeof talk === 'number' ? `${seconds(talk)} on calls in total` : null;

  if (aht === undefined) {
    return { value: '—', detail: 'Your average call length didn’t load.', caveat: null, secondary, known: false };
  }
  if (aht === null) {
    return {
      value: 'Not measured yet',
      detail: 'No call of yours has finished in this period, so there is nothing to average.',
      caveat: null,
      secondary,
      known: false,
    };
  }
  return {
    value: seconds(aht),
    detail: 'Your average time on a call, from the moment you and the customer were joined.',
    caveat: null,
    secondary,
    known: true,
  };
}

/**
 * Total wrap-up.
 *
 * A SUM rather than an average, and unlike the supervisor's wrap-up readout it
 * is not measured against the campaign's configured window. An agent working two
 * campaigns has two windows, so "against the 45s you're allowed" would be false
 * for at least one of them — and the tuning decision the supervisor's version
 * feeds is not one an agent can act on anyway.
 */
export function wrapupReadout(totals: AgencyAgentStatsTotals | undefined): PerformanceReadout {
  const wrapup = totals?.wrapup_seconds;
  if (typeof wrapup !== 'number') {
    return { value: '—', detail: 'Your wrap-up time didn’t load.', caveat: null, secondary: null, known: false };
  }
  return {
    value: seconds(wrapup),
    detail: 'Time spent writing calls up after the customer hung up.',
    caveat: null,
    secondary: null,
    known: true,
  };
}

// ─── Occupancy ───────────────────────────────────────────────────────────────

/**
 * The states the breakdown is made of, busiest first — and `offline` is not one
 * of them.
 *
 * ── Why the order ───────────────────────────────────────────────────────────
 * Deliberately the floor's state summary order rather than the wire enum's:
 * someone reading where their shift went wants the working states first.
 *
 * ── Why `offline` is absent, which is the load-bearing half ────────────────
 * It is not a presentational preference — it is what makes the shares agree with
 * the denominator the server publishes. The dialer runtime defines `shift_seconds` as the sum
 * of the states **excluding** `offline` (`foldOccupancy`, `src/agency/
 * agent-record.ts`: `if (row.state !== 'offline') occupancy.shift_seconds +=
 * clamped`), on the stated ground that *"an agent who logged out at 17:00 was
 * not on shift at 18:00, and folding that into the denominator would make every
 * short shift look unoccupied"*.
 *
 * Summing all six here contradicted that twice over. Every share was diluted by
 * time the agent was signed out — 30 of 90 worked minutes on calls read as 6.7%
 * rather than 33% for somebody whose shift was one part of a long day — and the
 * recorded sum could then only ever be ≥ `shift_seconds`, which made
 * {@link OccupancyBreakdown.unaccountedSeconds} structurally zero and the gap
 * note below it unreachable code.
 *
 * `offline` is still on the payload and that is right: "logged out" and "no
 * data" are different facts, and only one of them is a hole in the record. It is
 * simply not part of the shift being broken down.
 */
const OCCUPANCY_ORDER: readonly AgencyAgentLiveState[] = [
  'on_call',
  'wrapup',
  'reserved',
  'available',
  'break',
];

export interface OccupancySegment {
  state: AgencyAgentLiveState;
  label: string;
  seconds: number;
  /** Share of the ON-SHIFT states that were recorded — see the docstring. */
  sharePct: number;
}

export interface OccupancyBreakdown {
  /**
   * False when there is nothing to show. The caller must render **nothing** in
   * that case — never a zeroed bar.
   */
  measured: boolean;
  segments: OccupancySegment[];
  /**
   * The sum of the recorded ON-SHIFT states, which is the shares' denominator.
   * `offline` is not in it; see {@link OCCUPANCY_ORDER}.
   */
  recordedSeconds: number;
  /**
   * `shift_seconds` minus {@link recordedSeconds}, when the shift is longer than
   * the states account for. `0` when they agree.
   *
   * Reachable precisely BECAUSE `offline` is out of the sum. While it was in,
   * the recorded total could only ever be ≥ `shift_seconds` (which excludes it),
   * so this was structurally `0` and the sentence the caller renders from it was
   * dead code.
   */
  unaccountedSeconds: number;
}

/**
 * Where the shift went — or the honest admission that we do not know.
 *
 * ── Why "all zeros" is unmeasured rather than a shift of nothing ────────────
 * The server computes occupancy from its agent-state event log, which shipped after
 * the dialer itself. A session that predates the log emits no events, so the API
 * answers with **zeros, not nulls** — and a zeroed breakdown drawn as a bar is a
 * confident claim that an agent spent a shift doing nothing whatsoever. That is
 * the same defect as rendering a null rate as `0.0%`, in a different costume,
 * and it is aimed at the same person.
 *
 * The check is on the **sum of the states** rather than on `shift_seconds`
 * alone, and the asymmetry is load-bearing in both directions:
 *
 *  - a non-zero `shift_seconds` with every state at zero is exactly the
 *    pre-event-log case, so trusting `shift_seconds` would draw the bar it is
 *    meant to suppress;
 *  - a zero `shift_seconds` with real state seconds is a gappy log rather than
 *    an absence, and suppressing that would discard measurements we have.
 *
 * ── Shares are of what was RECORDED, and the gap is named ──────────────────
 * The states can sum to less than `shift_seconds` — a browser closed mid-state,
 * a session the reaper closed. `AgencyOccupancy.shift_seconds` says so in its
 * own contract. Dividing by `shift_seconds` would then produce shares that
 * quietly refuse to reach 100%, which reads as a rounding bug. So the
 * denominator is the recorded sum and the remainder is returned separately for
 * the caller to say out loud.
 *
 * ── `offline` is in neither the denominator nor the segments ───────────────
 * Because it is in neither on the server's side: `shift_seconds` is the sum of the
 * states except `offline`. See {@link OCCUPANCY_ORDER} for the two things
 * including it broke — every share diluted by signed-out time, and the gap above
 * made unreachable.
 *
 * A period in which the ONLY recorded state is `offline` is therefore
 * `measured: false`: the shift it describes is zero seconds long, and there is
 * no such thing as a share of it. That is the same answer the server gives — a
 * `shift_seconds` of 0 — rather than a separate client opinion.
 */
export function occupancyBreakdown(
  occupancy: AgencyOccupancy | null | undefined,
): OccupancyBreakdown {
  const byState = occupancy?.by_state;
  if (!byState) {
    return { measured: false, segments: [], recordedSeconds: 0, unaccountedSeconds: 0 };
  }

  /*
    The ON-SHIFT states only. This is the same sum the server calls `shift_seconds`,
    computed from the same six-key record, which is what lets the remainder below
    mean "the shift covers time the states do not account for" rather than
    "these two numbers were never comparable".
  */
  const recorded = OCCUPANCY_ORDER.reduce((sum, state) => sum + (byState[state] ?? 0), 0);
  if (recorded <= 0) {
    return { measured: false, segments: [], recordedSeconds: 0, unaccountedSeconds: 0 };
  }

  const shift = occupancy?.shift_seconds ?? 0;
  return {
    measured: true,
    recordedSeconds: recorded,
    unaccountedSeconds: Math.max(0, shift - recorded),
    /*
      Zero-length states are dropped rather than rendered as a 0% row. Unlike a
      zero rate, an unused state is not a withheld measurement — an agent who
      took no break genuinely took no break — and six rows where two carry the
      shift makes the two harder to read.
    */
    segments: OCCUPANCY_ORDER.filter((state) => (byState[state] ?? 0) > 0).map((state) => {
      const value = byState[state] ?? 0;
      return {
        state,
        label: AGENCY_FLOOR_STATE_LABELS[state],
        seconds: value,
        sharePct: (value / recorded) * 100,
      };
    }),
  };
}

/** `m:ss` / `h:mm:ss` for an occupancy row, and the share beside it. */
export function occupancySegmentText(segment: OccupancySegment): string {
  return `${seconds(segment.seconds)} · ${pct(segment.sharePct)}`;
}

// ─── The day-wise series ─────────────────────────────────────────────────────

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
  const points: SeriesPoint[] = rows.map((bucket) => {
    const parsed = bucketDay(bucket.bucket_start);
    return {
      start: bucket.bucket_start,
      label: parsed ? String(parsed.getDate()) : bucket.bucket_start,
      title: parsed
        ? parsed.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
        : bucket.bucket_start,
      attempts: bucket.attempts,
      connected: bucket.connected,
    };
  });

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

/** Why there is no occupancy breakdown — never a zeroed bar. See {@link occupancyBreakdown}. */
export const OCCUPANCY_UNMEASURED_NOTE =
  'We don’t have a record of how this time was spent. Shifts are only broken down like '
  + 'this from the point we started tracking station activity, so older shifts show nothing '
  + 'here rather than showing zeros.';

// ─── Staffing history ────────────────────────────────────────────────────────

export interface StaffingSummary {
  /**
   * DISTINCT campaigns the agent has ever been staffed on.
   *
   * Not `entries.length`. A staffing history repeats campaigns **by
   * construction** — the API's own docstring for `/my-campaigns` spells it out:
   * *"staffed in March, unstaffed in April, staffed again in June is three rows
   * and one campaign"*. So a row count printed under a heading reading "Campaigns
   * you've worked" told an agent they had worked three campaigns when they had
   * worked one, and it did it most often to the people with the longest history.
   */
  campaigns: number;
  /**
   * Assignment ROWS that have not ended — a different axis from the three counts
   * around it. See the docstring, and see the caller for why it is not in the
   * same middot chain.
   */
  active: number;
  /**
   * Distinct campaigns that will never send another call — `stopped` or
   * `completed`.
   *
   * Read through `assignmentEntry` rather than through a second status list.
   * That module already owns "may an agent enter this", its allow-list-of-blocks
   * shape means a status the server adds is treated as enterable rather than as
   * finished, and a second mapping here would be the copy that goes stale.
   */
  finished: number;
  /**
   * Distinct campaigns that are staffed and enterable, but not dialing right
   * now — paused, draft, stopping.
   */
  waiting: number;
}

/**
 * How much of the dialer this agent has seen, and how much of it is over.
 *
 * ── Two axes, and they must not be added together ───────────────────────────
 * `active` counts ASSIGNMENTS: The API's own `active` flag rather than
 * `unassigned_at === null`, because the API owns the staffing table and is
 * entitled to end an assignment in ways this client has no business modelling.
 *
 * `campaigns`, `waiting` and `finished` count CAMPAIGNS, because that is what
 * their words mean and what the section they are printed in is a list of.
 * `waiting` and `finished` are derived from the CAMPAIGN's status rather than the
 * assignment's, since an assignment can be perfectly current on a campaign that
 * stopped dialing last week — which is also exactly why the two axes overlap: one
 * paused campaign an agent is still staffed on is counted by `active` AND by
 * `waiting`. Neither count is wrong; adding them is, and putting them in one
 * middot chain is an invitation to. The caller therefore renders one axis as the
 * chain and the other beside it.
 *
 * ── Deduplication, and where it does NOT apply ─────────────────────────────
 * Every campaign-axis count is over distinct `campaign_id`s. A history repeats a
 * campaign by construction (the API's own words: three rows, one campaign), so a
 * row count under a heading that says "campaigns" is simply a different number
 * from the one it claims to be — and a campaign that was paused across two
 * separate stints was counted as two waiting campaigns.
 *
 * `active` is deliberately NOT deduplicated: it is a count of live assignment
 * rows, which is what the API's flag is per, and two concurrent live assignments
 * to one campaign would be a real thing about the staffing table rather than
 * double counting. It is also the count whose word ("current") does not say
 * "campaign".
 */
export function staffingSummary(entries: AgencyStaffingHistoryEntry[]): StaffingSummary {
  let active = 0;
  /*
    Per campaign, not per row — and `Map`, not two `Set`s, because a campaign's
    status is a property of the CAMPAIGN and every row for it carries the same
    value. Last one wins, which is the same answer as first one wins; what
    matters is that it is counted once.
  */
  const statusByCampaign = new Map<string, string | null>();
  for (const entry of entries) {
    if (entry.active) active += 1;
    statusByCampaign.set(entry.campaign_id, entry.campaign_status);
  }

  let finished = 0;
  let waiting = 0;
  for (const status of statusByCampaign.values()) {
    const { canEnter, note } = assignmentEntry(status);
    if (!canEnter) finished += 1;
    else if (note !== null) waiting += 1;
  }

  return { campaigns: statusByCampaign.size, active, finished, waiting };
}

/**
 * The campaign's name for a breakdown row, or a stand-in.
 *
 * `by_campaign[]` carries ids and no names — the API's contract, not an omission
 * — so the name is resolved from a list the caller already holds. An id with no
 * match renders as a shortened id: never blank, and never a name this client
 * invented for a campaign the server declined to identify.
 */
export function campaignLabel(
  campaignId: string,
  names: ReadonlyMap<string, string | null>,
): string {
  const name = names.get(campaignId);
  if (name) return name;
  return `Campaign ${campaignId.slice(0, 8)}`;
}

/** Names by id, from whatever list the surface has — staffing history or the campaign list. */
export function campaignNameMap(
  rows: readonly { campaign_id?: string; id?: string; campaign_name?: string | null; name?: string | null }[],
): Map<string, string | null> {
  const map = new Map<string, string | null>();
  for (const row of rows) {
    const id = row.campaign_id ?? row.id;
    if (!id) continue;
    map.set(id, row.campaign_name ?? row.name ?? null);
  }
  return map;
}

/** Talk time for one campaign row, so the table and the totals agree on format. */
export function rowSeconds(value: number | undefined): string {
  return typeof value === 'number' ? seconds(value) : '—';
}

/** A rate for one campaign row, derived HERE only because the server sends none. */
export function rowConnectRate(row: { attempts: number; connected: number }): string {
  /*
    The one place this module divides. `by_campaign[]` carries counts and no
    rates, and a per-campaign connect rate is the whole reason a supervisor or an
    agent reads that table — but the guard matters: zero dials is "not measured
    yet", exactly as `connect_rate_pct: null` is on the totals, and printing
    `0.0%` for a campaign nobody has dialled yet would be the same lie by
    arithmetic instead of by wire.
  */
  if (row.attempts <= 0) return '—';
  return pct((row.connected / row.attempts) * 100);
}

/** Whether a stats payload describes a range in which literally nothing happened. */
export function isEmptyRange(stats: AgencyAgentStats | null): boolean {
  if (!stats) return false;
  return stats.totals.attempts === 0 && stats.buckets.length === 0;
}
