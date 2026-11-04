import { AGENCY_INSIGHTS_MIN_RATE_DENOMINATOR } from '../../../types/agency-insights';
import type {
  AgencyInsightsAgentActivityRow,
  AgencyInsightsCalls,
  AgencyInsightsRoster,
} from '../../../types/agency-insights';
import { pct } from '../../format/number';

/**
 * Every rate on the Insights tab, derived here and nowhere else.
 *
 * ── Counts on the wire, rates in the console ────────────────────────────────
 * The contract serves counts only (its header's first rule). A rate is a claim
 * about a sample, and three rules decide whether a number can make one:
 *
 *  1. **A zero denominator is `none`, never 0%.** "0% connect rate" on a campaign
 *     that has placed no calls reads as a campaign that is failing.
 *  2. **Below {@link AGENCY_INSIGHTS_MIN_RATE_DENOMINATOR} (25) it is `withheld`**
 *     (decision IN5): one floor for the whole page, so two panels cannot disagree
 *     about whether 20 calls are enough. The copy is "Not enough calls yet".
 *  3. Above it, the percentage, unrounded here; {@link rateText} formats it.
 *
 * The floor is about a SAMPLE of events. Time ratios (occupancy: seconds on a
 * call over seconds online) are not samples, so {@link timeShare} applies rule 1
 * only. Contact ratios (penetration, completion) are samples of contacts, and
 * take the floor with "contacts" as the noun.
 */

export type InsightsRate =
  | { kind: 'value'; pct: number; numerator: number; denominator: number }
  | { kind: 'none' }
  | { kind: 'withheld'; denominator: number };

export const NOT_ENOUGH_CALLS = 'Not enough calls yet';

/** `numerator / denominator` under the page's three rules. */
export function insightsRate(
  numerator: number,
  denominator: number,
  floor: number = AGENCY_INSIGHTS_MIN_RATE_DENOMINATOR,
): InsightsRate {
  if (!Number.isFinite(denominator) || denominator <= 0) return { kind: 'none' };
  if (denominator < floor) return { kind: 'withheld', denominator };
  return { kind: 'value', pct: (numerator / denominator) * 100, numerator, denominator };
}

/** The percentage, or `null` for both kinds of "no rate". For charts and CSV. */
export function rateValue(rate: InsightsRate): number | null {
  return rate.kind === 'value' ? rate.pct : null;
}

/**
 * The rate as a reader sees it: `30.9%`, a dash for no denominator, or
 * "Not enough calls yet" (or contacts) below the floor.
 */
export function rateText(rate: InsightsRate, noun: 'calls' | 'contacts' = 'calls'): string {
  if (rate.kind === 'none') return '—';
  if (rate.kind === 'withheld') return noun === 'calls' ? NOT_ENOUGH_CALLS : 'Not enough contacts yet';
  return pct(rate.pct);
}

/** A ratio of two durations, null on no time at all. No sample floor (see the module note). */
export function timeShare(part: number, whole: number): number | null {
  if (!Number.isFinite(whole) || whole <= 0) return null;
  return (part / whole) * 100;
}

/** `total / count`, null when nothing was counted. */
export function average(total: number, count: number): number | null {
  if (!Number.isFinite(count) || count <= 0) return null;
  return total / count;
}

// ── Named rates, so a panel never divides inline ────────────────────────────

/**
 * The connect rate, one definition for the whole page and the same as `/stats`'
 * `connect_rate_pct`: CONNECTED over FIRST DIALS, wrap-up redials out of both.
 *
 *  - numerator `connected`: `/stats`' `attempts_connected`, outcome connected and not a wrap-up
 *    redial (a redial continues a call already counted);
 *  - denominator `first_dials`: the placed dials that were not a wrap-up redial. A redial is not
 *    another try at reaching someone, so counting it below a numerator that leaves it out would
 *    pull the rate down for every conversation an agent redialled.
 *
 * Trend buckets, best hours and caller IDs carry `first_dials`; the calls block and the agent
 * rows carry the dials and the redials they placed ({@link callsConnectRate},
 * {@link agentConnectRate}).
 */
export function connectRate(sample: { connected: number; first_dials: number }): InsightsRate {
  return insightsRate(sample.connected, sample.first_dials);
}

/**
 * The calls block's first dials: every placed dial minus the wrap-up redials placed. Exact: both
 * are counts of the same placed dials in the same rollup snapshot (`redial_number > 0` and `= 0`
 * partition them), so no second count is served for it.
 */
export function firstDials(calls: Pick<AgencyInsightsCalls, 'dials' | 'redials'>): number {
  return calls.dials - calls.redials.placed;
}

/** {@link connectRate} over the calls block. */
export function callsConnectRate(calls: Pick<AgencyInsightsCalls, 'dials' | 'connected' | 'redials'>): InsightsRate {
  return connectRate({ connected: calls.connected, first_dials: firstDials(calls) });
}

/** {@link connectRate} over an agent row: its dials minus the redials it placed. */
export function agentConnectRate(row: Pick<AgencyInsightsAgentActivityRow, 'dials' | 'connected' | 'redials'>): InsightsRate {
  return connectRate({ connected: row.connected, first_dials: row.dials - row.redials });
}

/**
 * Abandoned over answered: the guardrail's own definition (`abandoned_24h / answered_24h`).
 * Both count every attempt, redials included (an abandoned redial is an abandoned call).
 */
export function abandonmentRate(sample: { abandoned: number; answered: number }): InsightsRate {
  return insightsRate(sample.abandoned, sample.answered);
}

/** Contacts attempted at least once (`attempted`), over the roster (`total`). Contacts, not dials. */
export function penetrationRate(roster: Pick<AgencyInsightsRoster, 'attempted' | 'total'>): InsightsRate {
  return insightsRate(roster.attempted, roster.total);
}

/** Contacts completed (`completed`), over the roster (`total`). */
export function completionRate(roster: Pick<AgencyInsightsRoster, 'completed' | 'total'>): InsightsRate {
  return insightsRate(roster.completed, roster.total);
}

/** Contacts in a final state (completed, exhausted or suppressed), over the roster. */
export function finishedCount(roster: AgencyInsightsRoster): number {
  return roster.completed + roster.exhausted + roster.suppressed_dnc + roster.suppressed_invalid + roster.suppressed_other;
}

/** {@link finishedCount} over the roster (`total`). */
export function finishedRate(roster: AgencyInsightsRoster): InsightsRate {
  return insightsRate(finishedCount(roster), roster.total);
}

/** Average dials per attempted contact; null before the first. */
export function averageAttempts(roster: Pick<AgencyInsightsRoster, 'dials_placed' | 'attempted'>): number | null {
  return average(roster.dials_placed, roster.attempted);
}

/**
 * Successes over CONVERSATIONS (each conversation once, a redial chain once): the denominator
 * the success count is a subset of, so a redial chain is one conversation in both. Not
 * `connected`, which is the connect rate's numerator and a different count
 * (`calls.conversations`, `row.conversations`, `bucket.conversations`).
 */
export function successRate(successes: number, conversations: number): InsightsRate {
  return insightsRate(successes, conversations);
}

/**
 * Average handle time (talk + wrap-up) per connected call, in seconds. Averages, not rates:
 * talk is `talk_seconds` (every bridged leg's agent time, a redial's leg included) over
 * `connected`; wrap-up is `wrapup_seconds` over `wrapup_measured` (the calls whose wrap-up was
 * measured, the sum's own population).
 */
export function averageHandleSeconds(calls: Pick<AgencyInsightsCalls, 'talk_seconds' | 'wrapup_seconds' | 'connected' | 'wrapup_measured'>): {
  talk: number | null;
  wrapup: number | null;
  handle: number | null;
} {
  const talk = average(calls.talk_seconds, calls.connected);
  const wrapup = average(calls.wrapup_seconds, calls.wrapup_measured);
  return { talk, wrapup, handle: talk === null ? null : talk + (wrapup ?? 0) };
}

/** An agent's occupancy: time on a call or in wrap-up over time online (a time share, {@link timeShare}). */
export function occupancy(row: Pick<AgencyInsightsAgentActivityRow, 'online_seconds' | 'state_seconds'>): number | null {
  return timeShare(row.state_seconds.on_call + row.state_seconds.wrapup, row.online_seconds);
}
