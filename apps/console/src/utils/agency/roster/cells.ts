import { agentDurationLong, agentPct, agentSeconds } from '../../agencyAgentPerformance';
import { AGENCY_ROSTER_MIN_RATE_DENOMINATOR } from '../../../types/agency-stats';
import type { AgencyRosterAgentRowWithName } from '../../../types/agency-stats';
import { formatCount } from '../../format/number';

/*
  The roster's per-row cells: each metric as measured / withheld / unmeasured,
  with the threshold sentence a withheld cell carries, and the row's dial,
  connect and conversion counts. Out of `agencyAgentRoster.ts`, which
  re-exports everything here.
*/

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
    note: `${formatCount(denominator)} ${noun} — too few to rate`,
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
  return formatCount(row.attempts);
}

/** Answered calls. **Connects**, never "conversations" — see {@link conversionCell}. */
export function connectsText(row: AgencyRosterAgentRowWithName): string {
  return formatCount(row.connected);
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
  return formatCount(row.successes);
}

// ─── The bullet ──────────────────────────────────────────────────────────────
