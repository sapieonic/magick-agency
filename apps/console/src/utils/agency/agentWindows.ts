import { startOfDay, startOfMonth, startOfWeek, subMonths, subWeeks } from 'date-fns';
import { formatDayMonth, readerZone } from '../format/date';

/*
  The agent stats WINDOWS — the five ranges the roster and the per-agent panel
  offer, cut on the reader's calendar, and the caption naming the dates and the
  zone they were cut in. Out of `agencyAgentPerformance.ts`, which re-exports
  everything here; `agentWindows.timezone.test.ts` pins them outside UTC.
*/

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

  const day = formatDayMonth;
  const zone = readerZone() ?? 'UTC';

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
