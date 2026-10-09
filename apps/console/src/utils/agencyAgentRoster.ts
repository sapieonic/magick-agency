import { formatDateShort } from './format';
import { agentDurationLong, agentPct, agentSeconds, ratePct } from './agencyAgentPerformance';
import { AGENCY_ROSTER_MIN_RATE_DENOMINATOR } from '../types/agency-stats';
import type {
  AgencyRosterAgentRowWithName,
  AgencyRosterBenchmark,
  AgencyRosterPage,
  AgencyRosterPercentiles,
  AgencyRosterSort,
} from '../types/agency-stats';

/**
 * The roster table's derivations, as pure functions.
 *
 * Same reasoning as `agencyAgentPerformance`, `agencyCampaignPerformance` and
 * `agencyHealthStrip`: every sentence here is a claim about a named person's
 * week, a derivation is a place to be confidently wrong, and these are tested
 * against fixtures rather than eyeballed on a screen.
 *
 * ── Nothing here re-defines a figure that already has a definition ─────────
 * The percentage and duration formats come from `agencyAgentPerformance`
 * (`agentPct`, `agentSeconds`) rather than from a local `toFixed(1)`, so the
 * roster's connect-rate column and the per-agent panel a supervisor drills into
 * cannot print `18%` and `18.0%` for the same number. The name fallback comes
 * from `agencyAgentFloor.agentDisplayName` for the same reason, and **every rate
 * this payload carries is rendered as served** — dividing again here would produce
 * a second answer that rounds differently.
 *
 * There is now exactly ONE exception, and it is a figure the payload does not
 * carry: the team row's POOLED utilisation, which the benchmark makes derivable
 * (`shift_seconds`) but does not itself state. It goes through the sibling
 * module's single `ratePct` helper rather than a local `n / d * 100` — see
 * {@link teamUtilisation}, and note that it divides the BENCHMARK's own figures,
 * never the rows'.
 *
 * ── The one rule this whole module is built around ─────────────────────────
 * A table is SCANNED, not read. On the per-agent panel a wrong absence is a
 * misleading sentence; in a column of percentages it is invisible — `0%` sitting
 * among real rates looks exactly like a bad week. So this module never produces a
 * number for something that was not measured, and it distinguishes **three**
 * absences, which the {@link RosterCell} union makes unrepresentable to confuse:
 *
 *  1. **`measured`** — a real figure, including a real `0`.
 *  2. **`unmeasured`** — the server carried the field and had nothing to divide.
 *     An em dash plus a phrase naming what has not happened.
 *  3. **`withheld`** — the server carried a real number and told us it is not
 *     reportable (`rates_reportable: false`). **Words, not a faint number.** A
 *     rate greyed out is still a rate, and it is the one a supervisor reads
 *     aloud; the whole point of the server's flag is that a 27% conversion built
 *     from eleven calls should not be presentable as 27%.
 */

// ─── Cells ───────────────────────────────────────────────────────────────────

/** What a metric cell renders, and why. See the module header. */
export type RosterCell =
  | {
      kind: 'measured';
      /** Formatted for display. A real `0` is a real measurement and renders as one. */
      text: string;
      /** The raw figure, for the bullet's geometry. Never re-formatted by a caller. */
      value: number;
    }
  | {
      kind: 'unmeasured';
      /** An em dash. The explanation is {@link note}, never a `0`. */
      text: string;
      note: string;
    }
  | {
      kind: 'withheld';
      /** Words. "Not enough calls" — deliberately not a number of any weight. */
      text: string;
      /** The denominator, so the reader can see how thin it is. */
      note: string;
      /**
       * WHICH denominator fell short — the rate's own, named.
       *
       * On the cell it is already in {@link note}; it is a field of its own so the
       * renderers' `title` can name it too. Every one of the three tables that
       * render a `RosterCell` wrote *"Fewer than 20 **calls**"* into that tooltip,
       * which is false on the row this phase exists to fix: 41 dials and 11
       * connects withholds the CONVERSION rate for want of connects, and a tooltip
       * claiming a dials shortfall sends the reader to look at a number that is
       * fine. Carried on the cell rather than re-derived per component so the three
       * copies cannot drift apart again. See {@link withheldRateTitle}.
       */
      unit: 'dials' | 'connects';
    };

/** True when the cell is showing a real figure — the only case a bullet may draw. */
export function cellMeasured(cell: RosterCell): cell is Extract<RosterCell, { kind: 'measured' }> {
  return cell.kind === 'measured';
}

function count(value: number): string {
  return value.toLocaleString();
}

/**
 * The inert absence — an em dash and no explanation.
 *
 * For a null this payload cannot actually produce. The three REACHABLE nulls
 * (`success_rate_pct`, `aht_seconds`, `occupancy_pct`) each get a phrase naming
 * what has not happened, because each of them is an ordinary state a supervisor
 * needs read back to them. This one is for a shape that would be a contract
 * violation: it must render something rather than throw, and it must not invent a
 * finding about a row nobody can explain. Silence is the honest form.
 *
 * Exported for the GROUPED read's cells (`agencyCampaignContribution.ts`), which
 * are the same three states over a payload with the same rate rules — a second
 * em-dash-and-a-phrase would be a second dialect for one decision.
 */
export function unmeasuredCell(): Extract<RosterCell, { kind: 'unmeasured' }> {
  return { kind: 'unmeasured', text: '—', note: 'Not measured' };
}

/**
 * The withheld absence — words, and the denominator beneath them.
 *
 * ── One set of words, for two payloads ────────────────────────────────────
 * The roster and the GROUPED read (`agencyCampaignContribution.ts`) both carry
 * `rates_reportable`, and a supervisor is one click from one table to the other.
 * Two modules each writing their own "not enough calls" is how one screen comes to
 * say something slightly different about the same server flag, so the copy lives
 * here once and both callers ask for it.
 *
 * `unit` is the rate's OWN denominator, spelled out: a connect rate is over dials,
 * a conversion rate is over connects. Rates and their denominators travel together
 * — naming the wrong one is how a reader concludes the two columns disagree.
 *
 * Singular when the denominator is 1, which stopped being a curiosity the moment
 * the conversion rate started gating on `success_rate_reportable`: twenty dials
 * and ONE connect is the row that flag exists for, and "1 connects" beside it
 * reads as a rendering bug in the sentence explaining a withheld number.
 */
export function withheldRateCell(
  denominator: number,
  unit: 'dials' | 'connects',
): Extract<RosterCell, { kind: 'withheld' }> {
  const noun = denominator === 1 ? unit.slice(0, -1) : unit;
  return {
    kind: 'withheld',
    text: 'Not enough calls',
    note: `${count(denominator)} ${noun} — too few to rate`,
    unit,
  };
}

/**
 * The withheld cell's TOOLTIP — the threshold, over the rate's own denominator.
 *
 * ── One sentence, three tables, and it used to be wrong in two of them ─────
 * `RosterTable`, `ContributionTable` and `CompareTray` each render a `RosterCell`
 * and each hand-wrote *"Fewer than 20 calls, so this rate is not comparable."*
 * into the `title` of a withheld one. "Calls" is not a denominator this surface
 * uses anywhere else — it says **dials** for an attempt and **connects** for an
 * answered call, in the columns, the sublines and the notes — and on the 41-dial /
 * 11-connect row it is worse than vague: the conversion rate there is withheld for
 * want of CONNECTS, and a tooltip claiming a shortfall of calls points the reader
 * at forty-one dials and invites them to conclude the console is wrong.
 *
 * So the sentence lives here once, beside the words the cell itself uses, and it
 * takes the denominator from the CELL rather than from the caller's guess about
 * which metric it is rendering. A fourth table gets it right for free.
 *
 * The count is deliberately NOT repeated here: it is already in {@link
 * RosterCell.note}, which is rendered as the cell's own subline immediately under
 * the words this tooltip explains.
 */
export function withheldRateTitle(cell: Extract<RosterCell, { kind: 'withheld' }>): string {
  return (
    `Fewer than ${AGENCY_ROSTER_MIN_RATE_DENOMINATOR} ${cell.unit}, so this rate is ` +
    'not comparable.'
  );
}

/**
 * May this row's CONVERSION rate be quoted — the server's answer, guarded.
 *
 * ── Why this is not {@link AgencyRosterAgentRow.rates_reportable} ──────────
 * `rates_reportable` gates on ATTEMPTS and the conversion rate divides by
 * CONNECTS, so the flag did not withhold the thing it was added to withhold: 20
 * dials, 1 connect and 1 conversion cleared it and rendered `100%` beside a named
 * person. The house rule is a **per-metric** minimum volume, and one flag over one
 * denominator cannot express two.
 *
 * `success_rate_reportable` is `rates_reportable` AND `connected >= 20` — the same
 * predicate `benchmark.success_rate` and `benchmark.aht` pool over — so it is
 * strictly stronger and gating on it ALONE is correct.
 *
 * ── The fallback is today's behaviour, not the permissive one ──────────────
 * An absent flag falls back to `rates_reportable`, which is exactly what this cell
 * gated on before the field existed. The two tempting alternatives are both worse:
 * `true` would REVEAL rates the console withholds today, and re-deriving
 * `connected >= AGENCY_ROSTER_MIN_RATE_DENOMINATOR` here would be this client
 * computing a threshold the constant's own doc comment forbids it to compute — a
 * second answer that disagrees with the server's the moment it is tuned.
 */
export function successRateReportable(row: AgencyRosterAgentRowWithName): boolean {
  return typeof row.success_rate_reportable === 'boolean'
    ? row.success_rate_reportable
    : row.rates_reportable;
}

/**
 * The connect rate for one row.
 *
 * ── There is no "no dials" copy here, and its absence is deliberate ────────
 * An earlier revision rendered *"No dials in this window"* for
 * `connect_rate_pct === null`, and had a test constructing `attempts: 0` to prove
 * it. **That row cannot exist.** The server builds the roster from
 * `rosterAttemptTotals`, which is a `COUNT(*) … GROUP BY s.agent_user_id` over
 * rows already filtered on `dialed_at IS NOT NULL` — a group only exists because
 * at least one dial fell in it, so `attempts >= 1` on every served row and
 * `ratePct(connected, attempts)` therefore never divides by zero. An agent who
 * was logged in and never handed a call has no line at all; the repository's own
 * header states that ("the row set is ATTEMPTS-driven").
 *
 * A sentence for an impossible payload is worse than no sentence: it reads as a
 * state the product handles, and a test asserting it passes over data the server
 * cannot send — a pattern that passes tests without proving anything. So the null arm
 * is now the module's generic inert fallback: it still renders rather than
 * throwing if the shape ever changes, and it makes no claim about why.
 *
 * (Surfacing "logged in but never dialled" needs a field this payload does not
 * carry and is deferred to phase 02. It is not derivable here.)
 */
export function connectRateCell(row: AgencyRosterAgentRowWithName): RosterCell {
  if (row.connect_rate_pct === null) return unmeasuredCell();
  // The denominator of a CONNECT rate is dials. Rates and their denominators
  // travel together — the contract's rule, and the reason the two withheld cells
  // below name different numbers.
  if (!row.rates_reportable) return withheldRateCell(row.attempts, 'dials');
  return { kind: 'measured', text: agentPct(row.connect_rate_pct), value: row.connect_rate_pct };
}

/**
 * The conversion rate for one row — conversions over **connects**, not dials.
 *
 * ── Two words, two quantities, and one of them is a 5x error ───────────────
 * This surface says **connects** for an answered call and **conversions** for a
 * booked outcome, in the columns, in the sort menu, in the sublines and in the
 * notes. It used to say three things for the two: a `Conv.` column that meant
 * connects, a "Conversion" column that meant a rate, and a menu saying
 * "conversations". On a car-dealership campaign a connect rate near 30% and a
 * conversion rate near 6% are roughly a fivefold difference, and `Conv.` read as
 * bookings is that error on the number the dealer actually pays for.
 *
 * The denominator is the whole meaning of this figure, which is why the withheld
 * note names connects rather than dials, and why the Connects count sits
 * immediately to the left of it.
 *
 * `null` here is REACHABLE and ordinary: `ratePct(successes, connected)` with
 * `connected === 0` is a row that dialled and reached nobody. The phrase says
 * that rather than falling through to the inert fallback.
 *
 * ── It gates on `success_rate_reportable`, not on `rates_reportable` ───────
 * The flag has to have the same denominator as the rate it withholds. See
 * {@link successRateReportable}: gating a connects-over-connects rate on a dial
 * threshold let `100%` through on a single connect.
 */
export function conversionCell(row: AgencyRosterAgentRowWithName): RosterCell {
  if (row.success_rate_pct === null) {
    return { kind: 'unmeasured', text: '—', note: 'No connect to convert yet' };
  }
  if (!successRateReportable(row)) return withheldRateCell(row.connected, 'connects');
  return { kind: 'measured', text: agentPct(row.success_rate_pct), value: row.success_rate_pct };
}

/**
 * Average handle time.
 *
 * **Not gated on `rates_reportable`**, and that is a decision rather than an
 * oversight. The flag is about RATES: a percentage built from eleven calls is
 * flattering or damning by luck, because the numerator is a count of a rare
 * event. A mean duration over eleven finished calls is noisy but it is not
 * *misleading* — it is genuinely how long those eleven took — and withholding it
 * would leave the thinnest rows with no readable figure at all, which is the row
 * a supervisor most often opens the roster to find.
 */
export function handleTimeCell(row: AgencyRosterAgentRowWithName): RosterCell {
  if (row.aht_seconds === null) {
    return { kind: 'unmeasured', text: '—', note: 'No call has finished' };
  }
  return { kind: 'measured', text: agentSeconds(row.aht_seconds), value: row.aht_seconds };
}

/**
 * Utilisation — `(talk + wrapup) / shift_seconds`, the server's chosen
 * denominator.
 *
 * **Also not gated on `rates_reportable`**, for a sharper reason than handle time:
 * this rate's denominator is *time on shift*, not dials. Somebody who sat
 * available for eight hours and was handed eleven calls has a perfectly
 * measurable — and very informative — utilisation, and withholding it because
 * their DIAL count is thin would hide the single number that explains the thin
 * dial count.
 *
 * `null` is "no measured shift", which is also what an unmeasured occupancy read
 * produces. The two are indistinguishable on the wire and the phrase says so
 * without guessing which it was.
 */
export function utilisationCell(row: AgencyRosterAgentRowWithName): RosterCell {
  if (row.occupancy_pct === null) {
    return { kind: 'unmeasured', text: '—', note: 'No shift recorded' };
  }
  return { kind: 'measured', text: agentPct(row.occupancy_pct), value: row.occupancy_pct };
}

/**
 * Utilisation's own denominator, in seconds, for the cell beneath the percentage.
 *
 * ── Why this column and not the others ────────────────────────────────────
 * `shift_seconds` and `break_seconds` are on every row for a stated reason: the
 * contract put them there "so the other occupancy reading stays derivable". They
 * were on the payload and rendered nowhere, which left a bare percentage as the
 * only thing on screen — and this is the figure most likely to end up quoted in a
 * pay review. A rate whose denominator nobody can see is a rate nobody can
 * challenge, and "37.5% utilised" over a six-hour shift and over forty minutes
 * are not the same finding.
 *
 * The numerator is `talk + wrapup`, exactly what the server divided; the
 * denominator is `shift_seconds`, which INCLUDES break time (again the contract's
 * choice, because a roster column has to be one number). Break is named
 * separately rather than subtracted, so the reader can compute the other reading
 * without this module picking a second definition of the same word.
 *
 * `null` when there is no measured shift — the cell is then
 * {@link utilisationCell}'s "No shift recorded", which already says everything a
 * basis line could.
 */
export function utilisationBasis(row: AgencyRosterAgentRowWithName): string | null {
  if (row.occupancy_pct === null || row.shift_seconds <= 0) return null;
  const handled = `${agentDurationLong(row.talk_seconds + row.wrapup_seconds)} handled`;
  const shift = `${agentDurationLong(row.shift_seconds)} on shift`;
  // Only when there was one. "0m break" invites the reader to wonder whether
  // nobody took a break or nobody recorded one, which this payload cannot tell.
  const brk = row.break_seconds > 0 ? ` · ${agentDurationLong(row.break_seconds)} break` : '';
  return `${handled} of ${shift}${brk}`;
}

/** Dials, connects and conversions — plain counts, and a real `0` is a real answer. */
export function dialsText(row: AgencyRosterAgentRowWithName): string {
  return count(row.attempts);
}

/** Answered calls. **Connects**, never "conversations" — see {@link conversionCell}. */
export function connectsText(row: AgencyRosterAgentRowWithName): string {
  return count(row.connected);
}

/**
 * Booked outcomes — the count, not the rate.
 *
 * On screen because it is the number the roster is RANKED BY: the route's default
 * sort is `successes`, and a table ordered by a figure that appears in no column
 * is a table whose order cannot be checked. It is also the number a telecaller
 * agency's client pays for, which makes its absence the more serious of the two
 * problems.
 */
export function conversionsText(row: AgencyRosterAgentRowWithName): string {
  return count(row.successes);
}

// ─── The bullet ──────────────────────────────────────────────────────────────

/**
 * One row's connect rate drawn against the cohort's middle-half band.
 *
 * ── Why a bullet and not a bar ─────────────────────────────────────────────
 * A bar answers "how big"; nobody scanning a roster needs that — 34% next to 31%
 * is not a size question. The question is "is this person unusual", and that is
 * unanswerable without the band, which is exactly what the server puts on the
 * payload beside the row.
 *
 * ── Percentages, and still not a 0–100 axis ────────────────────────────────
 * A connect rate lives in a narrow part of its own range (a real floor sits
 * somewhere in the teens to the forties), so drawing it against 0–100 puts every
 * mark in the left third and the band becomes a few pixels wide — the one thing
 * the bullet exists to show. So the axis is computed ONCE for the whole column
 * (see {@link rosterConnectAxis}) and shared by every row: a per-row axis would
 * make two rows with different rates draw identical bars, which is worse than no
 * chart.
 */
export interface RosterBullet {
  /** Where the agent's own rate sits, 0–100 as a share of the axis. */
  value: number;
  /** The cohort's inter-quartile band, or `null` when too few agents were rated. */
  band: { start: number; end: number } | null;
  /** The cohort median's tick, or `null`. */
  median: number | null;
}

/**
 * The shared axis maximum for the connect-rate column, as a percentage.
 *
 * Taken over every row's rate AND the band's own p75, because the band can sit
 * above every returned row when `limit` truncated the roster on a different sort
 * — and a band drawn off the end of its own axis is a chart lying about the
 * comparison it exists to make.
 *
 * Padded by a quarter so the largest mark is not flush against the edge, floored
 * at 10 so a floor with one 2% row does not get an axis that magnifies noise, and
 * capped at 100 because it is a percentage.
 */
export function rosterConnectAxis(
  rows: readonly AgencyRosterAgentRowWithName[],
  benchmark: AgencyRosterBenchmark,
): number {
  const marks: number[] = [];
  for (const row of rows) {
    // Only reportable rates. A withheld rate is not drawn (see `connectBullet`),
    // so letting one stretch the axis would rescale the column for a number the
    // reader is never shown.
    if (row.rates_reportable && row.connect_rate_pct !== null) marks.push(row.connect_rate_pct);
  }
  for (const mark of [benchmark.connect_rate.p75, benchmark.connect_rate.median]) {
    if (mark !== null) marks.push(mark);
  }
  const peak = marks.length > 0 ? Math.max(...marks) : 0;
  return Math.min(100, Math.max(10, Math.ceil((peak * 1.25) / 5) * 5));
}

/** A share of the axis, clamped — a mark outside it is drawn at the edge, never off it. */
function share(value: number, axis: number): number {
  if (axis <= 0) return 0;
  return Math.max(0, Math.min(100, (value / axis) * 100));
}

/**
 * The bullet for one row, or `null` when there is nothing honest to draw.
 *
 * `null` for an unmeasured or a WITHHELD rate, both of them: drawing a bar for a
 * rate the table refuses to print in words would put the number back on screen
 * as a length, which is the same claim in a form nobody can quote but everybody
 * can compare.
 */
export function connectBullet(
  row: AgencyRosterAgentRowWithName,
  benchmark: AgencyRosterBenchmark,
  axis: number,
): RosterBullet | null {
  const cell = connectRateCell(row);
  if (!cellMeasured(cell)) return null;

  const { p25, p75, median } = benchmark.connect_rate;
  return {
    value: share(cell.value, axis),
    band:
      p25 !== null && p75 !== null
        ? { start: share(Math.min(p25, p75), axis), end: share(Math.max(p25, p75), axis) }
        : null,
    median: median !== null ? share(median, axis) : null,
  };
}

// ─── The flag chip ───────────────────────────────────────────────────────────

/**
 * Why a row is worth a second look, in a few words.
 *
 * ── This is NOT a score, and the kinds are the guardrail ───────────────────
 * A composite "agent score" is explicitly out of scope until after the nightly
 * rollup lands, and a chip that blended these would be one by the back door. So
 * every kind below is a single, stated, checkable fact about ONE metric against
 * the cohort — never a weighting of several — and the label says which metric.
 *
 * ── Ordered by what a supervisor must not misread ──────────────────────────
 * `thin` outranks `below_band` deliberately. A rate that is below the bottom
 * quarter *and* built from eleven calls is not a performance finding, and a chip
 * saying so would start exactly the coaching conversation the `rates_reportable`
 * flag exists to prevent.
 *
 * ── There is no `no_dials` kind, and there cannot be ───────────────────────
 * It was removed rather than left unused. The server groups over rows filtered on
 * `dialed_at IS NOT NULL`, so every served row has `attempts >= 1` and a chip for
 * `attempts === 0` was unreachable UI with a passing test over it — see
 * {@link connectRateCell} for the same deletion and the same reasoning.
 */
export type RosterFlagKind = 'thin' | 'below_band' | 'above_band';

export interface RosterFlag {
  kind: RosterFlagKind;
  /** Always rendered, and it NAMES THE METRIC. The chip is never colour-only. */
  label: string;
  /** The sentence behind the words, for the cell's title and its accessible name. */
  detail: string;
}

/**
 * The chip for one row, or `null` when the row is unremarkable.
 *
 * `null` rather than an "OK" chip: a column where every cell carries a badge is a
 * column nobody scans, and the whole value of this one is that a marked row is
 * rare.
 *
 * ── The metric is CONVERSION rate, not connect rate ────────────────────────
 * This keyed on `connect_rate_pct` and that was the wrong choice twice over.
 * Connect rate is the metric an agent controls least — it is mostly list quality
 * and dial timing — so an agent with a healthy 38% connect rate and a 4%
 * conversion rate collected a reassuring green chip while the number the business
 * runs on went unremarked. And it is the very metric that is not comparable
 * across campaigns, which is why {@link mixedCohortNote} exists.
 *
 * Conversion rate is the closest thing on this payload to a measure of what the
 * agent did with the call they were handed. It is still ONE metric compared
 * against ONE band, and the label says which — "Conversion rate below the band",
 * not "Below the band", so the chip can be read (and quoted) without hovering it.
 *
 * ── `comparable` is the caller's decision, and it is required ──────────────
 * `false` suppresses both band chips and leaves only `thin`. The roster's
 * all-campaigns view passes `false`, because a median pooled across different
 * dealers' lead lists is not a like-for-like comparison and a chip naming a
 * person against it is the most consequential sentence this table can print. It
 * is a parameter rather than something derived here because this module never
 * sees the page; `thin` survives it because "fewer than twenty calls" is a
 * statement about volume and is true whatever the rows were pooled from.
 *
 * ── The band comparison needs the band's OWN denominator ───────────────────
 * `rates_reportable` is `attempts >= 20` — the row's headline threshold. The
 * SUCCESS-rate percentiles have a second floor on top: The server only admits a row to
 * that pool when `connected >= 20` as well. So a row with 400 dials and 3
 * connects is `rates_reportable: true`, is NOT in the pool the band came from,
 * and comparing its 33% conversion rate against that band would flag somebody
 * against a cohort they were excluded from. The extra guard is that pool's floor,
 * applied here so the chip and the percentiles agree about who was measured.
 *
 * **The SERVER states that floor, and where it does this function does not.**
 * `success_rate_reportable` IS `rates_reportable AND connected >= 20`, so a
 * client-side `connected < 20` beside it is a duplicate threshold that can only
 * ever disagree — see the comment at the guard itself. The comparison runs only
 * when the flag is absent.
 */
export function rosterFlag(
  row: AgencyRosterAgentRowWithName,
  benchmark: AgencyRosterBenchmark,
  comparable: boolean,
): RosterFlag | null {
  if (!row.rates_reportable) {
    return {
      kind: 'thin',
      label: 'Too few to rate',
      detail:
        /*
          DIALS, not "calls". `rates_reportable` is `attempts >= 20`, so dials is the
          denominator that fell short — and the withheld CELLS in the same row now
          name their own denominators (see `withheldRateTitle`), so a chip still
          saying "calls" would be the third vocabulary in one row for two quantities.
        */
        `Fewer than ${AGENCY_ROSTER_MIN_RATE_DENOMINATOR} dials, so their rates are not ` +
        'comparable and did not count towards the team’s median.',
    };
  }

  if (!comparable) return null;

  const rate = row.success_rate_pct;
  if (rate === null) return null;
  /*
    The success-rate pool's own floor. See the header: `rates_reportable` is not
    this band's basis, and a row must not be judged against a band it was never
    admitted to.

    `success_rate_reportable` is the SERVER's statement of exactly this predicate,
    so where it is PRESENT it is the whole answer and nothing here recomputes it.

    ── The bug this shape exists to prevent ──────────────────────────────────
    The `connected` comparison below used to run unconditionally, right after the
    guard above. So on a server that does send the flag, a row the dialer runtime had
    admitted to the success-rate pool (`success_rate_reportable: true`) could
    still be dropped here by this client's own `connected < 20` — a second answer
    to a question the dialer runtime had already answered, which disagrees with the server
    the moment the server tunes that threshold and disagrees with the conversion CELL
    sitting in the same row (which gates on the flag alone).
    `AGENCY_ROSTER_MIN_RATE_DENOMINATOR`'s own doc comment forbids computing with
    it for exactly this reason: it is mirrored so the console can SAY the number,
    not so the console can apply it.

    It survives only as the fallback for a service that predates the field, so it
    is now gated on the field being absent. That is {@link successRateReportable}'s
    fallback carried one step further: the CELL can degrade to `rates_reportable`,
    but this band needs the stronger floor and with no flag on the row there is
    nothing else to derive it from.
  */
  if (!successRateReportable(row)) return null;
  if (
    typeof row.success_rate_reportable !== 'boolean' &&
    row.connected < AGENCY_ROSTER_MIN_RATE_DENOMINATOR
  ) {
    return null;
  }

  const { p25, p75 } = benchmark.success_rate;
  if (p25 !== null && rate < p25) {
    return {
      kind: 'below_band',
      label: 'Conversion rate below the band',
      detail:
        'Their conversion rate is below the bottom quarter of the team for this window, ' +
        'on this campaign.',
    };
  }
  if (p75 !== null && rate > p75) {
    return {
      kind: 'above_band',
      label: 'Conversion rate in the top quarter',
      detail:
        'Their conversion rate is above the top quarter of the team for this window, ' +
        'on this campaign.',
    };
  }
  return null;
}

/**
 * The rows on the page that carry a chip — what the "needs attention" filter lists,
 * and what its count counts.
 *
 * The filter exists because of `limit`. this console asks for the contract's maximum
 * (200) and there is no server-side paging in phase 01, so on a floor larger than
 * that the ranking decides who is visible — and under `conversions desc` the rows
 * cut are the LOWEST converters, which is the population a supervisor triaging
 * their week most needs. Sorting ascending finds them, but the flag column is
 * deliberately unsortable (it is derived from the row's relationship to the
 * benchmark, so no server can order by it). A client-side filter over the rows in
 * hand is what makes a flagged row reachable without re-asking the question.
 *
 * It filters what is ON the page and says so; it is not a claim about the floor.
 */
export function rosterAttentionRows(
  rows: readonly AgencyRosterAgentRowWithName[],
  benchmark: AgencyRosterBenchmark,
  comparable: boolean,
): AgencyRosterAgentRowWithName[] {
  return rows.filter((row) => rosterFlag(row, benchmark, comparable) !== null);
}

// ─── The agent cell ──────────────────────────────────────────────────────────

/**
 * Up to two initials for the avatar.
 *
 * Derived from whatever `agentDisplayName` produced, so an unresolvable agent
 * gets `AG` from its `Agent 4f21ab90` fallback rather than a blank circle — the
 * avatar must never be the thing that makes a row look broken. It is decoration:
 * the name is beside it and the avatar is `aria-hidden`, which is why two letters
 * of a uuid-derived fallback is acceptable here and would not be as a label.
 */
export function agentInitials(displayName: string): string {
  const words = displayName.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return `${words[0]![0]}${words[words.length - 1]![0]}`.toUpperCase();
}

/**
 * The small line under a name: how many campaigns, and when they last dialled.
 *
 * ── Why "last dialled" and not "joined" ───────────────────────────────────
 * The payload carries `last_dialed_at` and carries nothing about membership
 * dates, so a "joined" subline would be a fact this client invented. It is also
 * the less useful of the two here: a roster is a window, and "last dialled 19
 * Aug" on a window ending the 26th is the explanation for a thin row sitting
 * right beneath the thin row.
 *
 * ── The "no dials" branch was removed, not forgotten ──────────────────────
 * It read *"No dials in this window"* for `last_dialed_at === null`, and that row
 * cannot arrive: `last_dialed_at` is `MAX(a.dialed_at)` over a group that only
 * exists because a dial fell in it, and `campaigns` is a `COUNT(DISTINCT
 * a.campaign_id)` over the same group — so both are `>= 1` on every served row.
 * `include_inactive` changes which rows the server RETURNS, never how the dialer runtime built
 * them. See {@link connectRateCell} for the same deletion and the same reasoning.
 *
 * What is left is an inert fallback for a shape this payload cannot produce: the
 * campaign count on its own, with no sentence claiming a state nobody can
 * explain.
 */
export function rosterSubline(row: AgencyRosterAgentRowWithName): string {
  const campaigns =
    row.campaigns === 1 ? '1 campaign' : `${count(row.campaigns)} campaigns`;
  if (row.last_dialed_at === null) return campaigns;
  return `${campaigns} · last dialled ${formatDateShort(row.last_dialed_at)}`;
}

// ─── The pinned team row and the page's honesty affordances ──────────────────

/**
 * The team row's band readout for ONE metric.
 *
 * Says "median" and "middle half" in those words rather than drawing them, because the
 * pinned row is where a supervisor goes to find out what the bullets above it were
 * measured against — and a legend that is itself a chart answers the question with
 * the thing that raised it.
 *
 * ── It takes the percentiles and NOTHING else, deliberately ────────────────
 * An earlier revision passed `agents_rated` in and, on an all-null block, said
 * *"no agent cleared 20 calls"*. That sentence is only reliably true of the
 * CONNECT-rate pool, and the server resolved the three pools differently:
 *
 *  - `rates_reportable` is `attempts >= AGENCY_ROSTER_MIN_RATE_DENOMINATOR` — the
 *    row's HEADLINE denominator. A row without it enters no pool at all.
 *  - `connect_rate`'s pool is `rates_reportable` plus non-null. Its denominator IS
 *    attempts, so the headline threshold is exactly its own.
 *  - `success_rate`'s pool **additionally** requires `connected >= 20`. So a row
 *    with 400 dials and 3 connects is `rates_reportable: true`, is in the
 *    connect-rate pool, and is absent from the success-rate one. That row's own
 *    flag for this is `success_rate_reportable` — see {@link successRateReportable}.
 *  - `aht`'s pool — the fourth block, added after this list was written — is
 *    the SAME predicate as `success_rate`'s: `rates_reportable` AND
 *    `connected >= 20` AND non-null. `aht_seconds` divides by `connected`, which
 *    is precisely the denominator that second floor protects. It is emphatically
 *    NOT `rates_reportable` alone: gating an AHT comparison on that would draw a
 *    400-dial/3-connect row against a band it was excluded from, which is the
 *    identical defect phase 01 fixed for the conversion rate a hundred lines above.
 *  - `occupancy_pct`'s pool is gated on `rates_reportable` plus non-null and
 *    nothing else. `AGENCY_ROSTER_MIN_RATE_DENOMINATOR` counts CALLS and cannot
 *    gate a rate whose denominator is seconds — there is no minimum-shift floor in
 *    phase 01 and the copy must not imply one.
 *
 * So four blocks describe up to THREE populations, `agents_rated` is not the
 * denominator of any but the first, each block can independently be all-null while
 * the others carry values, and this function therefore renders each block's
 * absence on its own terms without naming a threshold it cannot vouch for. The
 * basis count lives in {@link ratedBasisNote}, once, where it can say what it
 * actually counts.
 *
 * ── `format` is how a DURATION band reads in the same sentence ─────────────
 * Every band on this row was a percentage until the benchmark gained `aht`
 * percentiles, and handling time is seconds. Passing the formatter in — rather
 * than adding a second, nearly identical readout — is what keeps one sentence
 * shape across the row; passing `agentPct` for a duration is the single mistake
 * available here, and it would print `median 74%` for a 74-second call, so the
 * AHT caller goes through {@link ahtBandReadout} rather than calling this
 * directly with a formatter of its choosing.
 */
export function bandReadout(
  percentiles: AgencyRosterPercentiles,
  format: (value: number) => string = agentPct,
): string {
  if (percentiles.median === null) return 'No median yet — too few rated agents';
  const median = `median ${format(percentiles.median)}`;
  if (percentiles.p25 === null || percentiles.p75 === null) return median;
  /*
    "Middle half", not "p25–p75". This module's sibling states the house rule in
    one line — *"'MTD' and 'WTD' are finance words, not agency ones"* — and then
    this readout, the most prominent legend on the surface, printed the quartile
    notation itself. The reader is a floor supervisor at a telecaller agency; the
    band is the middle half of their team and that is what it is called. The
    section's own description above the table already used those words, so the
    legend was the one place disagreeing with the product's voice.
  */
  return `${median} · middle half ${format(percentiles.p25)}–${format(percentiles.p75)}`;
}

/**
 * A percentile block the wire may not have sent at all.
 *
 * `benchmark.aht` is declared optional precisely so this guard cannot be
 * "simplified" away, and the type is in any case a hand-mirrored claim about a
 * payload rather than proof of one — the same reason {@link truncationNote} tests
 * `inactive_omitted` with `typeof`. A block whose
 * members are not numbers-or-null is not a thin cohort, it is a shape this build
 * does not understand, and the difference matters: "no median yet — too few rated
 * agents" is a claim about the FLOOR, and printing it for a field the API has not
 * shipped yet would be a false one.
 *
 * So `null` here means "say nothing", and a present block with a null median says
 * the honest thing on its own.
 */
function readPercentiles(block: unknown): AgencyRosterPercentiles | null {
  if (typeof block !== 'object' || block === null || Array.isArray(block)) return null;
  const record = block as Record<string, unknown>;
  const read = (value: unknown): number | null | undefined => {
    if (value === null) return null;
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  };
  const p25 = read(record.p25);
  const median = read(record.median);
  const p75 = read(record.p75);
  if (p25 === undefined || median === undefined || p75 === undefined) return null;
  return { p25, median, p75 };
}

/**
 * The handling-time band for the team row, or `null` when there is none to state.
 *
 * Reads exactly as the connect-rate and conversion-rate bands do — the same
 * "median … · middle half …" sentence — with one difference the reader never has
 * to think about: the figures are DURATIONS, so they go through
 * `agentDurationLong` and say their units out loud.
 *
 * The stopwatch format the CELLS use is wrong in this sentence, and the AHT band
 * is where it is worst: `median 22:00` is distinguishable from twenty-two hours
 * only by counting colons. In a right-aligned column of identically shaped values
 * the colons are the format's whole virtue; in prose they are its failure.
 *
 * `null` when the payload did not carry the block, which is an ordinary arrival
 * rather than a violation: `benchmark.aht` is additive (additive) and merge
 * order puts this console last, so an API mid-deploy simply has no band to show
 * here. The pooled `aht_seconds` beside it is unaffected and stays on screen —
 * every absence on this surface degrades to the next-best true statement.
 */
export function ahtBandReadout(benchmark: AgencyRosterBenchmark): string | null {
  const block = readPercentiles(benchmark.aht);
  if (block === null) return null;
  return bandReadout(block, agentDurationLong);
}

/**
 * The team row's utilisation — a REAL pooled rate now that the benchmark carries a
 * pooled denominator, with the median stand-in kept for an API that does not.
 *
 * ── What this replaced ────────────────────────────────────────────────────
 * Every other pinned cell shows the floor's own rate with the distribution
 * beneath it. Utilisation could not: the benchmark carried the cohort's
 * `talk_seconds` and `wrapup_seconds` and no pooled shift, so the floor's actual
 * utilisation was not derivable and the cell showed the cohort MEDIAN with a note
 * saying so — a typical agent standing in for the floor, in a column of pooled
 * rates.
 *
 * ── Pooled from the BENCHMARK, never from the rows ────────────────────────
 * `(talk + wrapup) / shift_seconds`, all four figures off the benchmark, which is
 * the same agent set and the same break-inclusive denominator the row-level
 * `occupancy_pct` uses — so the team figure and the column above it cannot
 * disagree about what the word means. Summing the visible ROWS instead would make
 * this cell move when the reader revealed former members, which the benchmark's
 * contract forbids and a test pins by comparing the whole team row's
 * `textContent` across that toggle.
 *
 * ── Three outcomes, and the middle one is the mid-deploy ──────────────────
 *  - **`pooled`** — the floor's own rate. `basis` is the arithmetic behind it, in
 *    the same words the row-level basis uses, because this is the figure most
 *    likely to reach a pay review and a rate whose denominator nobody can see is
 *    a rate nobody can challenge. The note names it as the FLOOR's, so the median
 *    sitting beside it is legible as the different number it is.
 *  - **`median`** — `shift_seconds` absent from the payload. Falls back to exactly
 *    what this cell showed before the field existed, labelled exactly as it was.
 *    A missing additive field costs the cell its pooled figure, never the render.
 *  - **`unmeasured`** — the field arrived and the floor has no measured shift at
 *    all (the server's agent-state event log shipped after the dialer, so a session
 *    that predates it has no events rather than zeroed ones). An em dash and a
 *    phrase, never `0%`: nobody's shift being recorded is not a floor that sat
 *    idle.
 */
export interface TeamUtilisation {
  kind: 'pooled' | 'median' | 'unmeasured';
  /** The figure, or an em dash. */
  text: string;
  /** The pooled arithmetic, in words — only when there is a pooled figure. */
  basis: string | null;
  /** What the figure IS, and the distribution around it. */
  note: string;
}

export function teamUtilisation(benchmark: AgencyRosterBenchmark): TeamUtilisation {
  const percentiles = readPercentiles(benchmark.occupancy_pct) ?? {
    p25: null,
    median: null,
    p75: null,
  };
  const shift = benchmark.shift_seconds;

  /*
    The additive field, read with `typeof` rather than trusted from the type — see
    `readPercentiles` above for why, and `AgencyRosterBenchmark.shift_seconds` for
    the deployment order that makes it reachable.
  */
  if (typeof shift !== 'number' || !Number.isFinite(shift)) {
    return {
      kind: 'median',
      text: pooledRate(percentiles.median),
      basis: null,
      note: utilisationTeamNote(percentiles),
    };
  }

  const handled = benchmark.talk_seconds + benchmark.wrapup_seconds;
  const rate = ratePct(handled, shift);
  if (rate === null) {
    return {
      kind: 'unmeasured',
      text: '—',
      basis: null,
      // Not "0% utilised". The floor having no recorded shift and the floor
      // having sat idle are different facts, and only one of them is measurable
      // from this payload.
      note: 'No shift recorded for the floor',
    };
  }

  const brk = benchmark.break_seconds;
  // Named rather than subtracted, exactly as on a row: `shift_seconds` INCLUDES
  // break, and naming it separately keeps the stricter reading derivable without
  // this module picking a second definition of one word. Only when there was one —
  // "0:00 break" invites the reader to wonder whether nobody took a break or
  // nobody recorded one, which this payload cannot tell.
  const breakNote =
    typeof brk === 'number' && Number.isFinite(brk) && brk > 0
      ? ` · ${agentDurationLong(brk)} break`
      : '';
  const band = bandReadout(percentiles);
  return {
    kind: 'pooled',
    text: agentPct(rate),
    basis: `${agentDurationLong(handled)} handled of ${agentDurationLong(shift)} on shift${breakNote}`,
    // "The whole floor", against the stand-in's "typical agent" — the two labels
    // are a minimal pair on purpose, because they are the two readings of this
    // column and the cell has shown both.
    note: percentiles.median === null ? 'the whole floor' : `the whole floor · ${band}`,
  };
}

/**
 * The team row's utilisation readout **for a payload with no pooled shift** — the
 * pre-`shift_seconds` fallback, not the rule.
 *
 * ── What this was, and what it now is ─────────────────────────────────────
 * It used to be the only reading available: the benchmark carried the cohort's
 * `talk_seconds` and `wrapup_seconds` and no pooled denominator, so the floor's
 * actual utilisation was not derivable and the cell showed the cohort MEDIAN with
 * this note saying so. The server added `benchmark.shift_seconds`, so the floor's own
 * rate IS derivable and {@link teamUtilisation} is what the cell renders.
 *
 * This function is now reached on exactly one path: the additive field has not
 * arrived (an API mid-deploy), and the cell degrades to precisely the figure and
 * precisely the label it carried before the field existed. It is kept rather than
 * inlined so that fallback is one named, tested thing.
 *
 * Deriving the pooled figure from the ROWS remains rejected in both worlds: the
 * rows are what `include_inactive` moves and the benchmark deliberately is not, so
 * a row-derived team figure would be a different number under the same name.
 *
 * "median" is not repeated in the band that follows, because the value beside it
 * already is one.
 */
export function utilisationTeamNote(percentiles: AgencyRosterPercentiles): string {
  if (percentiles.median === null) return 'No median yet — too few rated agents';
  if (percentiles.p25 === null || percentiles.p75 === null) return 'typical agent';
  return `typical agent · middle half ${agentPct(percentiles.p25)}–${agentPct(percentiles.p75)}`;
}

/**
 * What `agents_rated` actually counts, said once for the whole row.
 *
 * The HEADLINE threshold — enough dials to be rated at all — and not a claim about
 * any one percentile block. It is not attached to a specific median precisely
 * because it is only the exact basis of the connect-rate one; wording it as the
 * population that cleared the dial threshold is true of all three without
 * over-claiming for any.
 */
export function ratedBasisNote(benchmark: AgencyRosterBenchmark): string {
  return `${count(benchmark.agents_rated)} of ${count(benchmark.agents)} with enough calls to rate`;
}

/**
 * The pooled team rate for one metric — the FLOOR's rate, not the median.
 *
 * A separate function from {@link bandReadout} because they are different
 * questions and the pinned row shows both: "what did the floor actually do" and
 * "what does a typical agent do". They diverge most when one agent dialled most
 * of the calls, which is precisely when a supervisor would otherwise quote the
 * wrong one.
 */
export function pooledRate(rate: number | null): string {
  return rate === null ? '—' : agentPct(rate);
}

/**
 * `8 agents dialled · 2,495 dials` — the POPULATION, not the row count.
 *
 * ── Why `total_agents` and not `rows.length` ───────────────────────────────
 * They are different facts and the readout is about the floor rather than about
 * the table: `total_agents` is how many people dialled in this window and scope,
 * and `benchmark.attempts` is what they dialled between them. Both come off the
 * same object as the percentiles, so this sentence and the pinned team row cannot
 * disagree.
 *
 * `rows.length` would make the readout move when a former member was dropped or
 * when `limit` cut the page, which reads as the floor having changed size. What
 * was NOT shown is said separately — see {@link truncationNote} and
 * {@link inactiveNote}, and the note on why the three never combine.
 */
export function rosterCountReadout(page: AgencyRosterPage): string {
  const agents =
    page.total_agents === 1 ? '1 agent dialled' : `${count(page.total_agents)} agents dialled`;
  const dials = page.benchmark.attempts === 1 ? '1 dial' : `${count(page.benchmark.attempts)} dials`;
  return `${agents} · ${dials}`;
}

/**
 * "Showing the top 100 by conversions", or `null` when nothing was cut.
 *
 * ── There is deliberately NO "showing N of M" fraction here ────────────────
 * It is tempting and it is not computable. Three numbers on this payload are
 * related but independent, because of the ORDER the server and the API apply their
 * rules in:
 *
 *  - The server scopes, ranks, and cuts to `limit`; `total_agents` is its pre-`limit`
 *    population and is also the benchmark's population;
 *  - **The API then filters the page it was handed**, dropping departed members and
 *    reporting how many in `inactive_omitted`.
 *
 * So `rows.length` is "the top `limit`, minus the departed ones that happened to be
 * in it". A default read can legitimately come back with 1 row, `total_agents: 3`
 * and `inactive_omitted: 1`: "showing 1 of 3" is wrong, and "showing 1 of 2" is not
 * computable either, because the server never saw the two agents the dialer runtime cut. The
 * alternative — the server shipping hundreds of agent ids to the dialer runtime on a GET so the
 * filter could happen first — is not phase 01's trade.
 *
 * The honest form is therefore three separate true statements, and this is one of
 * them: the roster was cut, and by which order. The order is named because "the
 * rest" only means something relative to the ranking that selected these rows.
 *
 * The guard adds BOTH of the API's drop counts back in before comparing —
 * `inactive_omitted` and `unattributed_omitted` — so a page that fitted
 * comfortably under the limit and simply had rows removed does not claim to have
 * been truncated.
 */
export function truncationNote(page: AgencyRosterPage): string | null {
  /*
    The key first, and its absence means SILENCE rather than a comparison.

    `inactive_omitted` is the API's addition, and the API has a documented degrade
    path that serves the server's body unfiltered — with no such key on it. Read
    straight, `total_agents <= rows.length + undefined` is `1 <= NaN`, which is
    `false`, so the note fired on EVERY page: a supervisor looking at their whole
    floor was told the rest of it was further down an order. The guard is the
    client's own robustness and stays even though the API is being fixed in
    parallel to always emit the field — the two fixes are independent, and a
    comparison against `undefined` should never be reachable from a typed field
    the wire can omit.
  */
  if (typeof page.inactive_omitted !== 'number') return null;
  /*
    And the third state (an id with no membership at all) is now COUNTED rather than reasoned about. The API drops an
    id with no membership row of any status ("never in this tenant") and reports it
    separately, because folding it into `inactive_omitted` would claim a person left
    a team they were never on. `total_agents` counts those rows and `rows` does not,
    so without adding them back the comparison below is false with nothing
    truncated — and the note then tells a supervisor looking at their whole floor
    that the rest of it is further down an order. The paragraph above called that
    "structurally unreachable and cheap to be wrong about quietly"; it was neither.

    Absent means 0, which is exactly the behaviour that shipped before the field.
  */
  const unattributed =
    typeof page.unattributed_omitted === 'number' ? page.unattributed_omitted : 0;
  if (page.total_agents <= page.rows.length + page.inactive_omitted + unattributed) return null;
  return `Showing the top ${count(page.limit)} by ${SORT_LABELS[page.sort]} — the rest of the floor is further down that order.`;
}

/**
 * "2 former members hidden", or `null`.
 *
 * The dialer runtime returns departed agents because it cannot know they departed; the server drops
 * them. This sentence is what stops that from being a silent edit — and it names
 * them as FORMER MEMBERS rather than "hidden rows", because the reader's question
 * is "where is Priya", not "why are there fewer rows".
 */
export function inactiveNote(page: AgencyRosterPage): string | null {
  // Same guard as `truncationNote`, for the same degrade path. `undefined <= 0`
  // is `false`, so this one already fell silent on an absent key — stated rather
  // than relied on, because the coincidence is not the reason it is correct.
  if (typeof page.inactive_omitted !== 'number' || page.inactive_omitted <= 0) return null;
  const people =
    page.inactive_omitted === 1 ? '1 former member' : `${count(page.inactive_omitted)} former members`;
  return `${people} hidden — they dialled in this window but have since left the team.`;
}

/**
 * Which fact explains an EMPTY `rows` on a page that dropped something, or `null`
 * when nothing was dropped.
 *
 * ── Why "everyone left" was not a safe thing to assume ─────────────────────
 * Both screens derived this as `rows.length === 0` on a `ready` page and printed
 * *"Everyone who dialled in this window has since left the team"*. The API has TWO
 * independent reasons to drop a row and they mean opposite things to the reader:
 *
 *  - `inactive_omitted` — a former member. Revealable: the toggle exists for it,
 *    and the sentence can name a remedy.
 *  - `unattributed_omitted` — the third state, an id with no membership row of
 *    ANY status. **The toggle cannot bring these back**, because
 *    `include_inactive` widens the membership filter and these rows match no
 *    membership at all. Telling the reader to tick it is advice that does nothing.
 *
 * So `{ rows: [], unattributed_omitted: 3 }` — an ordinary the API response, not a
 * shape violation — claimed three people had resigned. On a supervisory surface
 * that is not a wording nit: it is a statement about named colleagues, made from a
 * count that says nothing of the kind.
 *
 * ── Shared, structurally typed, because the bug was in the DERIVATION ──────
 * The roster and the grouped read carry these three fields identically and both
 * screens got this wrong in the same way, so the predicate lives once. The COPY
 * stays with each screen: one says "this window", the other names a campaign, and
 * one sentence bent to fit both would name neither well.
 *
 * `null` on a page with rows is the important arm: this asks "why is the table
 * empty", and a page with rows does not have that question.
 */
export type RosterHiddenReason = 'departed' | 'unattributed' | 'both';

export function allRowsHiddenReason(page: {
  rows: readonly unknown[];
  inactive_omitted: number;
  unattributed_omitted?: number;
}): RosterHiddenReason | null {
  if (!Array.isArray(page.rows) || page.rows.length > 0) return null;
  // Both through `typeof`, for `truncationNote`'s reason: The API has a degrade path
  // that serves the server's body unfiltered, and `undefined > 0` is a comparison this
  // client should never make against a field the wire can omit.
  const departed = typeof page.inactive_omitted === 'number' ? page.inactive_omitted : 0;
  const unattributed =
    typeof page.unattributed_omitted === 'number' ? page.unattributed_omitted : 0;
  if (departed > 0 && unattributed > 0) return 'both';
  if (departed > 0) return 'departed';
  if (unattributed > 0) return 'unattributed';
  return null;
}

/**
 * Whether the CONNECT-RATE band is worth drawing a bullet against.
 *
 * Scoped to that one metric on purpose. `agents_rated` is exactly the connect-rate
 * pool's size — a row enters it on `rates_reportable` alone — so it is the one
 * percentile block this count genuinely describes, and the bullet is the only
 * thing drawn against a band. Gating the whole team row on it would hide a
 * perfectly good success-rate or utilisation median because a different pool was
 * thin.
 *
 * One rated agent IS the median, so a bullet drawn against it tells the reader
 * that somebody is exactly average with themselves. The table still renders every
 * figure; it just stops claiming a cohort.
 */
export function benchmarkUsable(benchmark: AgencyRosterBenchmark): boolean {
  return benchmark.agents_rated >= 2 && benchmark.connect_rate.median !== null;
}

// ─── Campaign scope: the comparison this table is only honest inside ─────────

/**
 * Whether the page's cohort supports a comparison between two named people.
 *
 * `false` for the all-campaigns read, and this is the single most consequential
 * decision on the surface.
 *
 * ── What went wrong, concretely ────────────────────────────────────────────
 * The roster defaulted to `campaign_id: null`. The server applies no campaign predicate
 * when the parameter is omitted and the API forwards without defaulting, so the
 * DEFAULT screen pooled every campaign in the account into one cohort — and the
 * median, the middle-half band and the per-row chips were all computed against
 * that pool. A telecaller agency works several car dealerships at once, each with
 * its own lead list; intrinsic connectability and intrinsic bookability differ by
 * a large factor between them. So "their conversion rate is below the bottom
 * quarter of the team" was rendered beside a person's NAME on the strength of a
 * comparison between different dealers' lists. The only thing on screen
 * acknowledging it was a muted twelve-pixel line in the footer reading "Every
 * campaign in scope".
 *
 * The default is now the most recently active campaign
 * ({@link defaultRosterCampaign}). The all-campaigns view stays reachable —
 * "how much did the floor dial this week" is a real question and the counts,
 * durations and per-row rates are all true in it — so what is suppressed is
 * exactly the part that is not: the per-row band comparison. See
 * {@link rosterFlag}'s `comparable` parameter and {@link mixedCohortNote}.
 */
export function cohortComparable(page: AgencyRosterPage): boolean {
  return page.campaign_id !== null;
}

/**
 * The sentence above the table when the cohort is pooled across campaigns, or
 * `null`.
 *
 * Above rather than below, and in the reader's normal text size. The other three
 * notes on this surface are about what is NOT on screen, which is a question the
 * reader has after scanning; this one is about how to read what IS on screen, and
 * a caveat encountered after the number it qualifies has already been read is not
 * a caveat.
 *
 * ── It says what is actually switched off, which is not the bands ─────────
 * It used to say "the band comparison is switched off", while the pinned team row
 * went on rendering four bands — connect rate, conversion rate, utilisation and,
 * since `shift_seconds`, handling time. Those are facts about the cohort and they are true of
 * a pooled cohort too; a sentence claiming they are absent is contradicted by the
 * row directly beneath it. What `comparable === false` actually suppresses is the
 * per-PERSON comparison against them — {@link rosterFlag}'s two band chips and
 * {@link connectBullet}'s bar — so that is what the sentence names.
 */
export function mixedCohortNote(page: AgencyRosterPage): string | null {
  if (cohortComparable(page)) return null;
  return (
    'Every campaign in the account is pooled here, so the team median mixes lead ' +
    'lists — it is not a like-for-like comparison. Counts and rates below are each ' +
    'person’s own, and the pinned row still shows the floor’s own figures and bands; ' +
    'what is switched off until you pick one campaign is comparing any ONE person ' +
    'against them — no chips, and no bullets.'
  );
}

/**
 * A campaign to open the roster on — the most recently ACTIVE one.
 *
 * ── What "most recently active" can mean from what is in hand ──────────────
 * The page already holds the campaign list, so this is a client-side choice and
 * costs no request. What that list carries is the constraint: `AgencyCampaign` has
 * `id`, `name` and `status` and **no timestamps at all** — no `created_at`, no
 * `started_at`, nothing this client could order by recency. Two facts are
 * available and both are used:
 *
 *  1. **`status`**, which is a statement about dialing right now. `running` and
 *     `stopping` are dialing; `paused` was dialing and is held; `completed` and
 *     `stopped` dialled in the past; `draft` has never dialled and therefore has
 *     no roster to show. That ordering is a recency ordering — it is the only one
 *     the payload supports directly.
 *  2. **The list's own order**, used only to break ties inside a status class.
 *     The dialer runtime serves `GET /campaigns` as `ORDER BY created_at DESC` and the server
 *     forwards the body unchanged, so position 0 is the newest campaign. Relying on
 *     it for the tie-break and nothing more is the point: if that order ever
 *     changes, the default moves between two campaigns of the same status rather
 *     than becoming wrong.
 *
 * A status this client does not know is treated as "dialled at some point" rather
 * than as a draft — the same instinct `AgencyCampaignStatusBadge` records about an
 * unrecognised status, and the safer of the two errors, since a draft is the one
 * class guaranteed to have an empty roster.
 *
 * `null` for an empty list: there is nothing to scope to, the roster is empty
 * either way, and the all-campaigns view then reports itself honestly.
 */
const CAMPAIGN_RECENCY: Record<string, number> = {
  running: 0,
  stopping: 0,
  paused: 1,
  completed: 2,
  stopped: 2,
  draft: 4,
};

export function defaultRosterCampaign(
  campaigns: readonly { id: string; status?: string | null }[],
): string | null {
  let best: { id: string; rank: number } | null = null;
  campaigns.forEach((campaign) => {
    if (!campaign.id) return;
    // 3 — below every status that has dialled, above `draft`. See the header.
    const rank = CAMPAIGN_RECENCY[campaign.status ?? ''] ?? 3;
    // Strictly greater, so the FIRST campaign of a rank wins and the list's
    // newest-first order decides the tie.
    if (best === null || rank < best.rank) best = { id: campaign.id, rank };
  });
  return best === null ? null : (best as { id: string; rank: number }).id;
}

// ─── Sort vocabulary ─────────────────────────────────────────────────────────

/**
 * What each sortable column is called, in the product's voice.
 *
 * Keyed by the WIRE value so a column header, the truncation sentence and the
 * request parameter cannot drift: the header is the thing that issues the sort,
 * and a second mapping is how a table ends up sorted by something other than the
 * column the reader pressed.
 */
export const SORT_LABELS: Record<AgencyRosterSort, string> = {
  attempts: 'dials',
  // **Connects**, not "conversations". Two quantities, one vocabulary — see
  // `conversionCell`, and the 5x misreading that motivated it.
  connected: 'connects',
  connect_rate_pct: 'connect rate',
  successes: 'conversions',
  success_rate_pct: 'conversion rate',
  aht_seconds: 'handle time',
  talk_seconds: 'talk time',
  occupancy_pct: 'utilisation',
  agent_user_id: 'agent',
};

/**
 * The table's columns, in the order they are read — and the ONLY sortable set.
 *
 * ── Why this lives here rather than in the component ──────────────────────
 * The sort menu above the table and the pressable column headers are two
 * affordances over one piece of state, and the menu used to be built from
 * `Object.keys(SORT_LABELS)`. That is the whole wire enum, so it offered
 * `successes` and `talk_seconds` — two orders with no column to show them, one of
 * which was also the DEFAULT. The table then loaded ranked by a number that
 * appeared nowhere on screen, with `aria-sort="none"` on every header, and nothing
 * about the page said what it was ordered by.
 *
 * Deriving both from this one list makes "every sort option has a column" true by
 * construction instead of by two lists agreeing. `SORT_LABELS` stays complete over
 * the wire enum because {@link truncationNote} renders whatever `sort` the SERVER
 * echoes, which need not be something this client can ask for.
 *
 * ── `talk_seconds` is deliberately absent ─────────────────────────────────
 * It has no column and is therefore not offered. Handle time already carries the
 * per-call duration a supervisor reads, utilisation carries where the shift went,
 * and a tenth column for the raw talk total would be a column nobody scans on a
 * table that already scrolls sideways. The wire still accepts it; this console
 * does not ask.
 */
export interface RosterColumn {
  sort: AgencyRosterSort;
  label: string;
  /** Numeric columns are right-aligned and tabular; the name column is not. */
  numeric: boolean;
  /**
   * The definition, rendered under the header rather than hidden in a `title`.
   *
   * Only where the label is genuinely ambiguous about its denominator — which on
   * this table is every rate. A hint on "Dials" would be noise.
   */
  hint?: string;
}

export const ROSTER_COLUMNS: readonly RosterColumn[] = [
  { sort: 'agent_user_id', label: 'Agent', numeric: false },
  { sort: 'attempts', label: 'Dials', numeric: true },
  { sort: 'connected', label: 'Connects', numeric: true, hint: 'answered' },
  { sort: 'connect_rate_pct', label: 'Connect rate', numeric: false, hint: 'of dials' },
  // The count, immediately left of its rate — the same pairing as dials and
  // connect rate, and the reason both are on screen: this is the column the
  // roster's default order ranks by, and the one a dealer pays for.
  { sort: 'successes', label: 'Conversions', numeric: true, hint: 'booked' },
  { sort: 'success_rate_pct', label: 'Conversion rate', numeric: true, hint: 'of connects' },
  { sort: 'aht_seconds', label: 'AHT', numeric: true, hint: 'talk + wrap-up per connect' },
  {
    sort: 'occupancy_pct',
    label: 'Utilisation',
    numeric: true,
    // The definition on the header, the denominator on every row — see
    // `utilisationBasis`, which also names the break time the shift includes. This
    // is the figure most likely to reach a pay review.
    hint: 'handled ÷ time on shift',
  },
];

/**
 * The `limit` this console asks for — the contract's maximum.
 *
 * This console used to send none, so the server's default of 100 applied and an agency with
 * 180 agents silently lost 80 rows. Under `conversions desc` the eighty cut are
 * the LOWEST converters, which is the exact population a supervisor is triaging.
 * 200 is the contract's ceiling (`limit` is `1..200`), there is no server-side
 * paging in phase 01, and asking for the maximum is the only lever this client
 * has. Beyond 200 the honest affordances take over: {@link truncationNote} says
 * the roster was cut and by which order, and the flag filter
 * ({@link rosterAttentionRows}) makes a marked row reachable without re-sorting.
 */
export const ROSTER_LIMIT = 200;

/**
 * The direction a column should START in when it is first pressed.
 *
 * Descending for every metric, because pressing "dials" means "who dialled most"
 * — and ascending for the name, because pressing a name column means A–Z. A
 * uniform default would make one of the two need two presses to do the obvious
 * thing.
 */
export function initialOrder(sort: AgencyRosterSort): 'asc' | 'desc' {
  return sort === 'agent_user_id' ? 'asc' : 'desc';
}

/** `aria-sort`'s vocabulary, which is not `asc`/`desc`. */
export function ariaSort(
  column: AgencyRosterSort,
  sort: AgencyRosterSort,
  order: 'asc' | 'desc',
): 'ascending' | 'descending' | 'none' {
  if (column !== sort) return 'none';
  return order === 'asc' ? 'ascending' : 'descending';
}
