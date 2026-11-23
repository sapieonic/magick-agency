import { AGENCY_INSIGHTS_MIN_RATE_DENOMINATOR } from '../../../types/agency-insights';
import type {
  AgencyInsightsAgentActivityRow,
  AgencyInsightsCalls,
  AgencyInsightsRoster,
} from '../../../types/agency-insights';
import {
  agencyCallsByType,
  agencyCallsByTypeFootnote,
  type AgencyCallsByTypeColumn,
  type AgencyCallsByTypeTable,
} from '../../../types/agency-call-log';
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
 * The connect rate: the product's ONE definition, `/stats`' `connect_rate_pct` and the agent
 * record's, HUMAN CONNECTS over PLACED FIRST DIALS (the server's `HUMAN_CONNECT_ATTEMPT_SQL` and
 * `PLACED_FIRST_DIAL_SQL`).
 *
 *  - numerator `human_connects`: conversations (a redial chain once) written up with a code that
 *    is neither voicemail nor the reaper's auto-stamp; a machine or an unclassified connect is
 *    not a person reached. Not `connected` (`attempts_connected`), which is the Connected figure;
 *  - denominator `first_dials`: the placed dials that were not a wrap-up redial. A redial is not
 *    another try at reaching someone, and a queued attempt never placed is not a dial.
 *
 * Trend buckets, best hours and caller IDs carry `first_dials`; the calls block and the agent
 * rows carry the dials and the redials they placed ({@link callsConnectRate},
 * {@link agentConnectRate}).
 */
export function connectRate(sample: { human_connects: number; first_dials: number }): InsightsRate {
  return insightsRate(sample.human_connects, sample.first_dials);
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
export function callsConnectRate(calls: Pick<AgencyInsightsCalls, 'dials' | 'human_connects' | 'redials'>): InsightsRate {
  return connectRate({ human_connects: calls.human_connects, first_dials: firstDials(calls) });
}

/** {@link connectRate} over an agent row: its dials minus the redials it placed. */
export function agentConnectRate(row: Pick<AgencyInsightsAgentActivityRow, 'dials' | 'human_connects' | 'redials'>): InsightsRate {
  return connectRate({ human_connects: row.human_connects, first_dials: row.dials - row.redials });
}

// ── The soft phone beside the dialler (SR1–SR5) ─────────────────────────────

/** The tagged soft-phone counts the server serves (`calls.softphone`, `/stats` `softphone`). */
export interface SoftphoneCounts {
  placed: number;
  connected: number;
  human_connects: number;
  /** Talk time of the placed calls; absent from a server that predates Calls by type. */
  talk_seconds?: number;
}

/**
 * Whether a campaign surface shows soft-phone figures (SR5): while the soft phone is on for the
 * account, or whenever the counts hold any call (a soft phone switched off later does not hide
 * calls already logged to the campaign). Never when the counts were not served (an older server).
 */
export function showSoftphoneFigures(enabled: boolean, counts: SoftphoneCounts | null | undefined): counts is SoftphoneCounts {
  if (!counts) return false;
  return enabled || counts.placed > 0;
}

/**
 * The soft phone's connect rate: people reached over calls placed. The dialler's rule
 * ({@link connectRate}) on a soft-phone call, which is always a first dial (no wrap-up redials),
 * and the page's one floor. Never folded into the dialler's (SR1).
 */
export function softphoneConnectRate(counts: SoftphoneCounts): InsightsRate {
  return connectRate({ human_connects: counts.human_connects, first_dials: counts.placed });
}

/**
 * The dialler's and the soft phone's counts together: every call we placed (SR3). Its rate is the
 * **Outbound connect rate** (CL7; "All calls connect rate" before inbound calls joined the
 * figures). An inbound call is never in it.
 */
export interface OutboundCounts {
  /** Every placed call: the dialler's dials (wrap-up redials included) and the soft phone's placed. */
  placed: number;
  connected: number;
  human_connects: number;
  /** The connect rate's denominator: the dialler's first dials and the soft phone's placed. */
  first_dials: number;
}

/** The calls block's {@link OutboundCounts}. */
export function outboundCounts(
  calls: Pick<AgencyInsightsCalls, 'dials' | 'connected' | 'human_connects' | 'redials'>,
  softphone: SoftphoneCounts,
): OutboundCounts {
  return {
    placed: calls.dials + softphone.placed,
    connected: calls.connected + softphone.connected,
    human_connects: calls.human_connects + softphone.human_connects,
    first_dials: firstDials(calls) + softphone.placed,
  };
}

/** The connect rate over {@link OutboundCounts}: every person reached over every first call placed. */
export function outboundConnectRate(counts: OutboundCounts): InsightsRate {
  return connectRate(counts);
}

// ── Inbound beside both, and Calls by type (call log P4, CL7, CL25–CL30) ────

/** The inbound counts the server serves (`calls.inbound`, `/stats` `inbound`). */
export type InboundCounts = AgencyInsightsCalls['inbound'];

/**
 * Whether a campaign surface shows inbound figures (SR5's rule on inbound): while inbound is on
 * for the account (`agency_inbound_enabled`), or whenever the range holds an inbound call (a
 * campaign keeps the calls filed under it when the flag goes off), or while the campaign has
 * missed calls still to follow up: those are owed whatever the dates (CL27), so a range with no
 * inbound call must not hide them. Never when the counts were not served (an older server).
 */
export function showInboundFigures<C extends Pick<InboundCounts, 'received' | 'open_follow_ups'>>(
  enabled: boolean,
  counts: C | null | undefined,
): counts is C {
  if (!counts) return false;
  return enabled || counts.received > 0 || counts.open_follow_ups > 0;
}

/**
 * Inbound's answer rate: calls an agent answered over the calls that arrived in open hours (the
 * inbound summary's definition), under the page's one floor. It measures us, not the list, and
 * is never added to a connect rate (CL7).
 */
export function inboundAnswerRate(counts: Pick<InboundCounts, 'answered' | 'open_hours'>): InsightsRate {
  return insightsRate(counts.answered, counts.open_hours);
}

/** One call type's column of the Calls by type table. */
export type CallsByTypeColumn = AgencyCallsByTypeColumn<InsightsRate>;

/** The Calls by type table: a column per type shown, and All calls, the counts added. */
export interface CallsByType extends AgencyCallsByTypeTable<InsightsRate> {
  /** The dialler and the soft phone together, when the soft phone shows; never inbound (CL7). */
  outbound: OutboundCounts | null;
  footnote: string;
}

/**
 * A campaign's calls by type (`docs/call-log.md` §6), or null when only the dialler shows: the
 * page is then exactly what it was. Counts, people reached and talk time add up across types.
 * **No rate does**: each type keeps its own, and All calls has none. The table is the
 * contract's (`agencyCallsByType`, shared with the report), with this page's rates.
 *
 * One row is one call of one type, the Call log's own rows: the Dialler column is the dials
 * (the Dials figure), Soft phone the calls placed and logged to the campaign, Inbound the calls
 * filed under it. A caller an agent answered is a person reached.
 */
export function callsByType(
  calls: Pick<AgencyInsightsCalls, 'dials' | 'connected' | 'human_connects' | 'redials' | 'talk_seconds'>,
  softphone: SoftphoneCounts | null,
  inbound: InboundCounts | null,
): CallsByType | null {
  if (!softphone && !inbound) return null;
  const table = agencyCallsByType<InsightsRate>({
    dialler: {
      calls: calls.dials,
      connected: calls.connected,
      reached: calls.human_connects,
      talk_seconds: calls.talk_seconds,
      rate: callsConnectRate(calls),
    },
    soft_phone: softphone && {
      calls: softphone.placed,
      connected: softphone.connected,
      reached: softphone.human_connects,
      talk_seconds: typeof softphone.talk_seconds === 'number' ? softphone.talk_seconds : null,
      rate: softphoneConnectRate(softphone),
    },
    inbound: inbound && {
      calls: inbound.received,
      connected: inbound.answered,
      reached: inbound.answered,
      talk_seconds: inbound.talk_seconds,
      missed: inbound.missed,
      open_follow_ups: inbound.open_follow_ups,
      rate: inboundAnswerRate(inbound),
    },
  });
  return {
    ...table,
    outbound: softphone ? outboundCounts(calls, softphone) : null,
    footnote: agencyCallsByTypeFootnote(table.columns.map((c) => c.type)),
  };
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
