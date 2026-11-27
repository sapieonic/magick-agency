import {
  COMPARE_BUILTIN_METRICS,
  COMPARE_PAGE_MAX_AGENTS,
  type AgencyCompareFinding,
  type AgencyCompareValue,
} from '@magick-agency/contracts/api/agency/compare';
import {
  TEAM_MAIN_OUTCOME_METRIC,
  type AgencyTeamCallbacks,
  type AgencyTeamMainOutcome,
  type AgencyTeamMainOutcomeKind,
  type AgencyTeamPerformanceErrorCode,
  type AgencyTeamTotals,
  type AgencyTeamTrend,
  type AgencyTeamWrapupAllowed,
} from '@magick-agency/contracts/api/agency/team-performance';
import { formatCount, plural } from '../../format/number';
import { statClock } from '../../format/duration';
import { clockTime } from '../stationFormat';
import { formatReportDay } from '../../reports/reportCopy';
import { COMPARE_WINDOW_RULE } from '../compare/compareUrl';
import type { TeamWindowPreset } from './teamUrl';

/**
 * Team performance in the console's words (`docs/team-performance.md` §2, TP17): the server sends
 * codes, counts and catalog labels; every sentence is written here, in simple Indian English with
 * British spelling. A LEAF: pure functions, no React.
 */

// ─── The main outcome (TP8) ─────────────────────────────────────────────────

/** The console's own name for the successes outcome, when the catalogs give none (TP8). */
export const SUCCESSES_FALLBACK_LABEL = 'Successes';

/** The main outcome's name: the catalog's one label, else "Will pay" (promises) or "Successes". */
export function mainLabel(main: Pick<AgencyTeamMainOutcome, 'kind' | 'label'>): string {
  const label = main.label?.trim();
  if (label) return label;
  return main.kind === 'promises' ? 'Will pay' : SUCCESSES_FALLBACK_LABEL;
}

/**
 * The label as a compound before "rate": "Will pay" → "Will-pay". An acronym or one word stays as
 * it is, except the plural fallback, which names the rate in the singular: "Success rate", never
 * "Successes rate".
 */
function compound(label: string): string {
  const name = label.trim();
  if (name === SUCCESSES_FALLBACK_LABEL) return 'Success';
  return name.split(/\s+/).join('-');
}

/** The rate's name for a column and the sort pill: "Will-pay rate" ("{label} rate", TP8). */
export function rateLabel(label: string): string {
  return `${compound(label)} rate`;
}

/** The same inside a sentence: "will-pay rate" (an acronym keeps its capitals: "PTP rate"). */
export function rateWords(label: string): string {
  const name = compound(label);
  const acronym = name.length > 1 && name[1] === name[1]!.toUpperCase() && name[1] !== name[1]!.toLowerCase();
  return `${acronym ? name : name.charAt(0).toLowerCase() + name.slice(1)} rate`;
}

/** The floor under which the main rate is said in words, not drawn (the Compare metric's, 20). */
export function mainFloor(kind: AgencyTeamMainOutcome['kind']): number {
  return COMPARE_BUILTIN_METRICS[TEAM_MAIN_OUTCOME_METRIC[kind]].min_denominator ?? 0;
}

/** The floor of the time to choose an outcome (`COMPARE_TIME_MIN_CALLS`, 20). */
export const CHOOSE_FLOOR = COMPARE_BUILTIN_METRICS.choose_time.min_denominator ?? 0;

// ─── Numbers ────────────────────────────────────────────────────────────────

/** A fraction as a whole percentage: `0.272` → "27%". */
export function percent(fraction: number): string {
  return `${Math.round(fraction * 100)}%`;
}

/** Seconds as `m:ss`, or a dash when there is nothing to average. */
export function clockOrDash(seconds: number | null): string {
  return seconds === null ? '—' : statClock(seconds);
}

/** Seconds on break as whole minutes: "18 min". */
export function breakMinutes(seconds: number): string {
  return `${formatCount(Math.round(seconds / 60))} min`;
}

/**
 * A figure under its floor, in words, never a bar: "Too few calls (12; needs 20)". A figure whose
 * counts disagree (promises recorded after the window's calls) says so instead.
 */
export function withheldWords(value: AgencyCompareValue, floor: number): string {
  if (value.withheld === 'counts_disagree') return 'Counts don’t agree yet';
  return `Too few calls (${formatCount(value.denominator ?? 0)}; needs ${formatCount(floor)})`;
}

// ─── The tiles ──────────────────────────────────────────────────────────────

/** Calls handled's line: "by 9 agents". */
export function callsLine(agents: number): string {
  return `by ${plural(agents, 'agent')}`;
}

/**
 * The main outcome tile's line: "27% of calls handled", or, when soft-phone and inbound calls are
 * in the rate (TP4), "26% will-pay rate · counts 12 soft-phone and inbound calls".
 */
export function mainLine(totals: Pick<AgencyTeamTotals, 'main' | 'other_conversations'>, label: string, floor: number): string {
  const { main } = totals;
  if (main.value === null && (main.denominator ?? 0) === 0) return 'No calls yet';
  if (main.withheld === 'counts_disagree') return withheldWords(main, floor);
  if (!main.reportable || main.value === null) {
    return `Too few calls for a rate (${formatCount(main.denominator ?? 0)}; needs ${formatCount(floor)})`;
  }
  if (totals.other_conversations === 0) return `${percent(main.value)} of calls handled`;
  const other = totals.other_conversations;
  return `${percent(main.value)} ${rateWords(label)} · counts ${formatCount(other)} soft-phone and inbound ${other === 1 ? 'call' : 'calls'}`;
}

/** The allowed time to choose an outcome: "30 s allowed", "no time limit", "allowed time differs by campaign". */
export function allowedWords(allowed: AgencyTeamWrapupAllowed): string | null {
  if (allowed.varies) return 'allowed time differs by campaign';
  if (allowed.seconds === null) return null;
  if (allowed.seconds === 0) return 'no time limit';
  return `${formatCount(allowed.seconds)} s allowed`;
}

/** Time to choose outcome's line: "average · 30 s allowed". */
export function chooseLine(allowed: AgencyTeamWrapupAllowed): string {
  const words = allowedWords(allowed);
  return words ? `average · ${words}` : 'average';
}

/** Call-backs on time: the figure and its line, or "No call-backs due yet" (TP10). */
export function callbacksTile(callbacks: AgencyTeamCallbacks, holdsToday: boolean): { value: string; of: string | null; line: string } {
  if (callbacks.due === 0) {
    return {
      value: '—',
      of: null,
      line: callbacks.upcoming > 0 ? `No call-backs due yet · ${formatCount(callbacks.upcoming)} later today` : 'No call-backs due yet',
    };
  }
  return {
    value: formatCount(callbacks.on_time),
    of: `of ${formatCount(callbacks.due)}`,
    line: holdsToday ? 'due so far today' : 'due in this period',
  };
}

// ─── The period ─────────────────────────────────────────────────────────────

const PRESET_WORDS: Readonly<Record<Exclude<TeamWindowPreset, 'custom'>, string>> = {
  today: 'today',
  this_week: 'this week',
  last_7_days: 'last 7 days',
  last_30_days: 'last 30 days',
};

/** Dates in words: "11 Nov to 17 Nov", or "17 Nov" for one day. */
export function datesWords(dates: { from: string; to: string }): string {
  return dates.from === dates.to ? formatReportDay(dates.from, false) : `${formatReportDay(dates.from, false)} to ${formatReportDay(dates.to, false)}`;
}

/** The period in a heading's words: "today", "last 7 days", "11 Nov to 17 Nov". */
export function periodWords(preset: TeamWindowPreset, dates: { from: string; to: string }): string {
  return preset === 'custom' ? datesWords(dates) : PRESET_WORDS[preset];
}

/** Capitalised: "Today", "Last 7 days". */
export function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * What the figures cover, beside the filters: "Today, up to 2:15 PM" when the window holds now
 * (TP11: it runs to now), else the dates.
 */
export function asOfWords(preset: TeamWindowPreset, dates: { from: string; to: string }, asOf: string, holdsToday: boolean): string {
  const period = capitalise(periodWords(preset, dates));
  return holdsToday ? `${period}, up to ${clockTime(new Date(asOf))}` : period;
}

// ─── The charts ─────────────────────────────────────────────────────────────

/** The per-day chart's line (TP12): "whole team, last 7 working days". */
export function trendLine(trend: Pick<AgencyTeamTrend, 'span' | 'dates'>): string {
  const days = trend.dates.length;
  if (trend.span === 'last_working_days') return days === 1 ? 'whole team, last working day' : `whole team, last ${formatCount(days)} working days`;
  return `whole team, ${plural(days, 'working day')}`;
}

/** "What happened on today’s 360 calls", or "What happened on 2,120 calls" for any other period. */
export function outcomesTitle(preset: TeamWindowPreset, calls: number): string {
  return preset === 'today' ? `What happened on today’s ${formatCount(calls)} calls` : `What happened on ${formatCount(calls)} calls`;
}

/** An outcome bar's name: the catalog's label; "No outcome chosen" for none; else the code itself. */
export function outcomeLabel(bar: { code: string | null; label: string | null }): string {
  if (bar.code === null || bar.code === 'no_disposition') return 'No outcome chosen';
  return bar.label?.trim() || bar.code;
}

/** How fresh the outcome bars are (TP13), a line of its own: "Dialler calls only · as of 2:10 PM". */
export function rollupLine(rollupAsOf: string | null): string {
  return rollupAsOf ? `Dialler calls only · as of ${clockTime(new Date(rollupAsOf))}` : 'Dialler calls only';
}

/**
 * A quiet refresh failed with the figures still on screen (§2 States): said calmly, not as an
 * alert, with the time the figures on screen run to.
 */
export function refreshFailedWords(asOf: string): string {
  return `Couldn’t refresh. Showing figures up to ${clockTime(new Date(asOf))}.`;
}

/**
 * Said under the bars only when the main outcome's bar and its tile count differently (TP13), with
 * the likeliest reason: the tile also counts soft-phone and inbound calls (TP4); else, for
 * promises, the tile counts a promise on the day it was given and the bars a call on the day it was
 * made; else (successes) the bars are the rollup's, a few minutes behind the tile.
 */
export function outcomesFootnote(
  label: string,
  bar: number,
  tile: number,
  why: { kind: AgencyTeamMainOutcomeKind; otherCalls: number },
): string | null {
  if (bar === tile) return null;
  const counts = `(${formatCount(tile)} vs ${formatCount(bar)} here)`;
  if (why.kind === 'promises' && why.otherCalls > 0) return `The tile also counts ${label} on soft-phone and inbound calls ${counts}.`;
  if (why.kind === 'promises') return `The tile counts ${label} on the day it was given, the bars on the day the call was made ${counts}.`;
  return `The bars are a few minutes behind the tile ${counts}.`;
}

/** The colour rule, said once under the bars. */
export const ONE_COLOUR_NOTE = 'Bars share one colour on purpose: this compares sizes, not outcome types.';

// ─── Worth a look (TP15) ────────────────────────────────────────────────────

export type TeamBadgeTone = 'best' | 'watch';

/** A finding as a row's badge: "Stands out", "Low will-pay rate", "Slow to choose outcome". */
export function findingBadge(finding: Pick<AgencyCompareFinding, 'code' | 'metric'>, label: string): { label: string; tone: TeamBadgeTone } | null {
  if (finding.code === 'stands_out') return { label: 'Stands out', tone: 'best' };
  if (finding.code !== 'clear_gap') return null;
  if (finding.metric === 'choose_time') return { label: 'Slow to choose outcome', tone: 'watch' };
  return { label: `Low ${rateWords(label)}`, tone: 'watch' };
}

/** With All campaigns nobody is marked (TP7, CP8): the table says why. */
export const CHOOSE_ONE_CAMPAIGN_NOTE = 'Choose one campaign to see who’s worth a look.';

/** The same, where Compare picked is offered too: agents are compared within one campaign (CP8). */
export const CHOOSE_ONE_CAMPAIGN_TO_COMPARE_NOTE = 'Choose one campaign to see who’s worth a look and to compare agents.';

// ─── Picks (TP18) ───────────────────────────────────────────────────────────

/** "2 of 3 picked". */
export function picksLine(count: number): string {
  return `${count} of ${COMPARE_PAGE_MAX_AGENTS} picked`;
}

/** Why Compare picked is off. */
export function compareDisabledReason(comparable: boolean, picks: number): string | null {
  if (!comparable) return CHOOSE_ONE_CAMPAIGN_TO_COMPARE_NOTE;
  if (picks === 0) return `Pick up to ${COMPARE_PAGE_MAX_AGENTS} agents to compare.`;
  return null;
}

/** A pick box's name for a screen reader. */
export function pickLabel(name: string): string {
  return `Pick ${name} to compare`;
}

// ─── Refusals (§4) ──────────────────────────────────────────────────────────

/** The codes the read can refuse with: the family's, plus the flag gate's. */
export type TeamRefusalCode = AgencyTeamPerformanceErrorCode | 'feature_disabled';

/** What the console says for each refusal, keyed by the wire code (AS15). */
export const TEAM_ERROR_MESSAGES: Readonly<Record<TeamRefusalCode, string>> = {
  team_campaign_not_found: 'That campaign isn’t one of this account’s. Choose another campaign.',
  team_timezone_invalid: 'Your browser’s time zone isn’t recognised, so the days can’t be worked out.',
  team_window_invalid: `Those dates don’t make a valid period. ${COMPARE_WINDOW_RULE}`,
  // Refused by the account's limit or by the server's own (both answer team_busy).
  team_busy: 'Too many reports are being worked out right now. Try again in a moment.',
  team_timed_out: 'Too much to read at once. Try a shorter period.',
  feature_disabled: 'Team performance isn’t turned on for this account.',
};

/** A 403 without a code. */
export const TEAM_FORBIDDEN_MESSAGE = 'You don’t have permission to see the team’s figures.';

/** No answer from the server at all. */
export const TEAM_NETWORK_MESSAGE = 'Couldn’t reach the server. Check your connection and try again.';
