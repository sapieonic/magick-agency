/**
 * Team performance's answer, from the read's figures (docs/team-performance.md §3; the wire is
 * `AgencyTeamPerformance`). Pure: the read (`./read.ts`) gathers the scope's campaigns, each cohort
 * agent's counts and the rollup's, and this file turns them into rows, sums, medians, the bars, the
 * per-day series and the findings, through Compare agents' shared rules (`compareValue`,
 * `compareFindings`, `cohortPercentiles` in `@magick-agency/domain/agent-compare`), never a second
 * implementation of them (TP2, CP9).
 *
 * | Figure | Numerator | Denominator |
 * |---|---|---|
 * | `main`, promises (TP4; Compare's `promises_rate`) | promises, three call tables | roster `connected` + soft-phone and inbound conversations |
 * | `main`, successes (Compare's `success_rate`) | roster `successes` | roster `connected` |
 * | `choose` (Compare's `choose_time`) | roster `wrapup_seconds` | the measured wrap-ups it sums |
 * | `avg_call_seconds` (Compare's `avg_call`) | roster `talk_seconds` | roster `connected` |
 */
import {
  COMPARE_BUILTIN_METRICS,
  type AgencyCompareFinding,
  type AgencyCompareMetricInfo,
  type AgencyCompareValue,
  type CompareBuiltinMetricKey,
} from '@magick-agency/contracts/api/agency/compare';
import {
  TEAM_FINDING_CODES,
  TEAM_MAIN_OUTCOME_METRIC,
  TEAM_TREND_LOOKBACK_DAYS,
  TEAM_TREND_WORKING_DAYS,
  type AgencyTeamAgentRow,
  type AgencyTeamCallbacks,
  type AgencyTeamMainOutcome,
  type AgencyTeamMainOutcomeKind,
  type AgencyTeamMedians,
  type AgencyTeamOutcomeBar,
  type AgencyTeamPerformance,
  type AgencyTeamTotals,
  type AgencyTeamTrend,
  type AgencyTeamTrendSpan,
  type AgencyTeamWrapupAllowed,
} from '@magick-agency/contracts/api/agency/team-performance';
import { agencyTileIconOrNone, type AgencyDisposition } from '@magick-agency/contracts/agency';
import { cohortPercentiles, compareFindings, compareValue } from '@magick-agency/domain/agent-compare';
import { ratio } from '@magick-agency/domain/rates';
import type { CompareCallbackClasses, TeamRollupCodeRow, TeamRollupDayRow } from '../../db/repositories/agency.repository.js';
import { AUTO_DISPOSITION_CODE } from '../disposition.js';
import { localDates } from '../reports/datasets/shared.js';

/** One campaign of the scope as the answer reads it: its catalog is the effective one (`effectiveCatalog`). */
export interface TeamCampaign {
  id: string;
  wrapup_seconds: number;
  catalog: readonly AgencyDisposition[];
  rollup_as_of: string | null;
}

/** What the read holds for ONE cohort agent (a member of the account, a departed one kept, TP5). */
export interface TeamAgentSources {
  agent_user_id: string;
  agent_name: string | null;
  departed: boolean;
  /** The roster row's counts (`rosterAttemptTotals`). */
  roster: { connected: number; successes: number; talk_seconds: number; wrapup_seconds: number; measured_wrapups: number };
  /** The roster's occupancy fold (`foldOccupancy`): logged-in seconds, and the break seconds inside them. */
  occupancy: { shift_seconds: number; break_seconds: number };
  /** Promises in scope and the other conversations beside the dialler's; null when the main outcome is successes (not read). */
  promises: { promises: number; other_conversations: number } | null;
  callbacks: CompareCallbackClasses;
}

/** The days the per-day chart is read over (TP12). */
export interface TeamTrendRange {
  span: AgencyTeamTrendSpan;
  /** The first local date read: the window's `from`, or `TEAM_TREND_LOOKBACK_DAYS` back from `to` (itself included). */
  from: string;
  to: string;
}

/** `date` moved by `days` (local calendar dates, `YYYY-MM-DD`). */
function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * The per-day chart's range (TP12): a window of `TEAM_TREND_WORKING_DAYS` local days or more is read
 * as it is (`window`); a shorter one reads the `TEAM_TREND_LOOKBACK_DAYS` local days ending at `to`
 * (`last_working_days`), of which the chart keeps the last working ones.
 */
export function teamTrendRange(from: string, to: string): TeamTrendRange {
  if (localDates(from, to).length >= TEAM_TREND_WORKING_DAYS) return { span: 'window', from, to };
  return { span: 'last_working_days', from: addDays(to, 1 - TEAM_TREND_LOOKBACK_DAYS), to };
}

/** The distinct codes, sorted, and the one label they carry when they carry exactly one. */
function outcomeOf(kind: AgencyTeamMainOutcomeKind, entries: readonly AgencyDisposition[]): AgencyTeamMainOutcome {
  const codes = [...new Set(entries.map((e) => e.code))].sort();
  const labels = new Set(entries.map((e) => e.label));
  return { kind, codes, label: labels.size === 1 ? [...labels][0]! : null };
}

/**
 * The scope's main outcome (TP8, the Live floor's rule): promises when any campaign's catalog has a
 * `requires_promise` entry (a mixed scope too), else successes; the codes it counts across the
 * scope, and their label when they carry one.
 */
export function mainOutcomeFor(campaigns: readonly TeamCampaign[]): AgencyTeamMainOutcome {
  const entries = campaigns.flatMap((c) => c.catalog);
  const promises = entries.filter((e) => e.requires_promise === true);
  if (promises.length > 0) return outcomeOf('promises', promises);
  return outcomeOf('successes', entries.filter((e) => e.is_success === true));
}

/** A built-in Compare metric as the shared rules take it. */
function builtin(key: CompareBuiltinMetricKey): AgencyCompareMetricInfo {
  const definition = COMPARE_BUILTIN_METRICS[key];
  return { id: key, ref: { kind: 'builtin', key }, label: null, definition, flaggable: definition.better !== 'neutral' };
}

const CHOOSE_TIME = builtin('choose_time');
const MAIN_METRIC: Readonly<Record<AgencyTeamMainOutcomeKind, AgencyCompareMetricInfo>> = {
  promises: builtin(TEAM_MAIN_OUTCOME_METRIC.promises),
  successes: builtin(TEAM_MAIN_OUTCOME_METRIC.successes),
};

/**
 * A rate whose count exceeds its calls is withheld, as Compare withholds it (`counts_disagree`,
 * docs/compare-agents.md §7): promises are counted when recorded, conversations when dialled, so a
 * promise in the window on a call dialled before it can outnumber the window's conversations.
 */
function withheldWhenImpossible(v: AgencyCompareValue): AgencyCompareValue {
  if (v.denominator === null || v.numerator <= v.denominator) return v;
  return { ...v, value: null, reportable: false, interval: null, withheld: 'counts_disagree' };
}

/** The main outcome's two counts for one agent, or for the sums. */
function mainCounts(kind: AgencyTeamMainOutcomeKind, a: Pick<TeamAgentSources, 'roster' | 'promises'>): { numerator: number; denominator: number } {
  if (kind === 'successes') return { numerator: a.roster.successes, denominator: a.roster.connected };
  const p = a.promises ?? { promises: 0, other_conversations: 0 };
  return { numerator: p.promises, denominator: a.roster.connected + p.other_conversations };
}

/** One cohort agent's row: Compare's figures for the same agent, scope and window. */
export function teamAgentRow(kind: AgencyTeamMainOutcomeKind, a: TeamAgentSources): AgencyTeamAgentRow {
  const main = mainCounts(kind, a);
  const r = a.roster;
  return {
    agent_user_id: a.agent_user_id,
    agent_name: a.agent_name,
    departed: a.departed,
    calls_handled: r.connected,
    main: withheldWhenImpossible(compareValue(MAIN_METRIC[kind], main.numerator, main.denominator)),
    talk_seconds: r.talk_seconds,
    avg_call_seconds: ratio(r.talk_seconds, r.connected),
    wrapup_seconds: r.wrapup_seconds,
    measured_wrapups: r.measured_wrapups,
    choose: compareValue(CHOOSE_TIME, r.wrapup_seconds, r.measured_wrapups),
    break_seconds: a.occupancy.break_seconds,
    shift_seconds: a.occupancy.shift_seconds,
  };
}

const sum = <T>(rows: readonly T[], of: (row: T) => number): number => rows.reduce((s, row) => s + of(row), 0);

/** The call-backs of every cohort agent in IN4's classes (TP10); `upcoming` is not due. */
export function teamCallbacks(agents: readonly TeamAgentSources[]): AgencyTeamCallbacks {
  const on_time = sum(agents, (a) => a.callbacks.on_time);
  const late = sum(agents, (a) => a.callbacks.late);
  const missed = sum(agents, (a) => a.callbacks.missed);
  const pending_due = sum(agents, (a) => a.callbacks.pending_due);
  return { due: on_time + late + missed + pending_due, on_time, late, missed, pending_due, upcoming: sum(agents, (a) => a.callbacks.pending_future) };
}

/** Conversations per campaign in the window (the rollup's). */
function conversationsByCampaign(codes: readonly TeamRollupCodeRow[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of codes) out.set(r.campaign_id, (out.get(r.campaign_id) ?? 0) + r.conversations);
  return out;
}

/**
 * The allowed time to choose an outcome over the scope's campaigns with conversations in the window
 * (the rollup's): their one value, else `varies`; null with no campaign that had calls.
 */
export function wrapupAllowed(campaigns: readonly TeamCampaign[], codes: readonly TeamRollupCodeRow[]): AgencyTeamWrapupAllowed {
  const withCalls = conversationsByCampaign(codes);
  const values = new Set(campaigns.filter((c) => (withCalls.get(c.id) ?? 0) > 0).map((c) => c.wrapup_seconds));
  if (values.size === 1) return { seconds: [...values][0]!, varies: false };
  return { seconds: null, varies: values.size > 1 };
}

/** The team's sums over EVERY cohort row (ratios of sums). */
export function teamTotals(
  kind: AgencyTeamMainOutcomeKind,
  agents: readonly TeamAgentSources[],
  wrapup: AgencyTeamWrapupAllowed,
): AgencyTeamTotals {
  const connected = sum(agents, (a) => a.roster.connected);
  const counts = agents.map((a) => mainCounts(kind, a));
  return {
    agents: agents.length,
    calls_handled: connected,
    main: withheldWhenImpossible(compareValue(MAIN_METRIC[kind], sum(counts, (c) => c.numerator), sum(counts, (c) => c.denominator))),
    other_conversations: kind === 'promises' ? sum(agents, (a) => a.promises?.other_conversations ?? 0) : 0,
    avg_call_seconds: ratio(sum(agents, (a) => a.roster.talk_seconds), connected),
    choose_seconds: ratio(sum(agents, (a) => a.roster.wrapup_seconds), sum(agents, (a) => a.roster.measured_wrapups)),
    wrapup_allowed: wrapup,
    callbacks: teamCallbacks(agents),
  };
}

const values = (xs: ReadonlyArray<number | null>): number[] => xs.filter((x): x is number => x !== null);
const reportableValue = (v: AgencyCompareValue): number | null => (v.reportable ? v.value : null);

/** The medians the table's ticks are drawn at (`cohortPercentiles`, the roster's method). */
export function teamMedians(rows: readonly AgencyTeamAgentRow[]): AgencyTeamMedians {
  return {
    calls_handled: cohortPercentiles(rows.map((r) => r.calls_handled)).median,
    main_rate: cohortPercentiles(values(rows.map((r) => reportableValue(r.main)))).median,
    avg_call_seconds: cohortPercentiles(values(rows.map((r) => r.avg_call_seconds))).median,
    choose_seconds: cohortPercentiles(values(rows.map((r) => reportableValue(r.choose)))).median,
  };
}

/** A null code and the reaper's auto-stamp are both "no outcome chosen" (Compare's `no_outcome_rate` rule). */
const barCode = (code: string | null): string | null => (code === AUTO_DISPOSITION_CODE ? null : code);

/**
 * "What happened on the calls" (TP13): every outcome with a conversation, most first (ties by code,
 * no outcome chosen last among equals), labelled and iconned from the catalog of the campaign with
 * the most conversations on the code that has it in its catalog.
 */
export function outcomeBars(campaigns: readonly TeamCampaign[], codes: readonly TeamRollupCodeRow[]): AgencyTeamOutcomeBar[] {
  const catalogs = new Map(campaigns.map((c) => [c.id, c.catalog]));
  const byCode = new Map<string | null, Map<string, number>>();
  for (const r of codes) {
    const code = barCode(r.disposition_code);
    const perCampaign = byCode.get(code) ?? new Map<string, number>();
    perCampaign.set(r.campaign_id, (perCampaign.get(r.campaign_id) ?? 0) + r.conversations);
    byCode.set(code, perCampaign);
  }
  const bars: AgencyTeamOutcomeBar[] = [];
  for (const [code, perCampaign] of byCode) {
    const conversations = sum([...perCampaign.values()], (n) => n);
    if (conversations <= 0) continue;
    const entry = code === null ? undefined : [...perCampaign]
      .sort(([a, x], [b, y]) => y - x || a.localeCompare(b))
      .map(([id]) => catalogs.get(id)?.find((e) => e.code === code))
      .find((e) => e !== undefined);
    bars.push({ code, label: entry?.label ?? null, icon: agencyTileIconOrNone(entry?.icon) ?? null, conversations });
  }
  return bars.sort((a, b) => b.conversations - a.conversations
    || (a.code === null ? 1 : 0) - (b.code === null ? 1 : 0)
    || (a.code ?? '').localeCompare(b.code ?? ''));
}

/** Per campaign, its success codes (a code is a success in its own campaign's catalog, as the roster counts it). */
function successCodes(campaigns: readonly TeamCampaign[]): Map<string, Set<string>> {
  return new Map(campaigns.map((c) => [c.id, new Set(c.catalog.filter((e) => e.is_success === true).map((e) => e.code))]));
}

/**
 * The main outcome per working day (TP12): over the range's local days, those with a dialler
 * conversation in scope (the rollup) or a count that is not zero; a day off is left out, not drawn
 * as 0. The count is the team's promises recorded that day (`promiseDays`), or the conversations
 * ending in a success code of their campaign. A `last_working_days` range keeps the last
 * `TEAM_TREND_WORKING_DAYS` of them.
 */
export function teamTrend(
  range: TeamTrendRange,
  kind: AgencyTeamMainOutcomeKind,
  campaigns: readonly TeamCampaign[],
  days: readonly TeamRollupDayRow[],
  promiseDays: ReadonlyMap<string, number>,
): AgencyTeamTrend {
  const successes = successCodes(campaigns);
  const conversations = new Map<string, number>();
  const counts = new Map<string, number>(kind === 'promises' ? promiseDays : []);
  for (const r of days) {
    conversations.set(r.date, (conversations.get(r.date) ?? 0) + r.conversations);
    if (kind === 'successes' && r.disposition_code !== null && successes.get(r.campaign_id)?.has(r.disposition_code) === true) {
      counts.set(r.date, (counts.get(r.date) ?? 0) + r.conversations);
    }
  }
  const working = localDates(range.from, range.to).filter((d) => (conversations.get(d) ?? 0) > 0 || (counts.get(d) ?? 0) !== 0);
  const dates = range.span === 'window' ? working : working.slice(-TEAM_TREND_WORKING_DAYS);
  return { span: range.span, dates, counts: dates.map((d) => counts.get(d) ?? 0) };
}

/**
 * Worth a look (TP15): `compareFindings` on the main rate and `choose_time` over the whole cohort,
 * every row picked (in the rows' order), keeping `TEAM_FINDING_CODES` only. A row withheld on a
 * figure is out of that figure's cohort, as Compare leaves it out.
 */
export function teamFindings(kind: AgencyTeamMainOutcomeKind, rows: readonly AgencyTeamAgentRow[]): AgencyCompareFinding[] {
  const counted = (pick: (r: AgencyTeamAgentRow) => AgencyCompareValue) =>
    rows.filter((r) => pick(r).withheld !== 'counts_disagree').map((r) => ({ agent_user_id: r.agent_user_id, ...pick(r) }));
  const { findings } = compareFindings({
    metrics: [{ metric: MAIN_METRIC[kind], cohort: counted((r) => r.main) }, { metric: CHOOSE_TIME, cohort: counted((r) => r.choose) }],
    picked: rows.map((r) => r.agent_user_id),
  });
  const kept: ReadonlySet<string> = new Set(TEAM_FINDING_CODES);
  return findings.filter((f) => kept.has(f.code));
}

/** The oldest of the scope's campaigns' rollup freshness; null when the rollup holds nothing for any. */
function oldestRollup(campaigns: readonly TeamCampaign[]): string | null {
  const known = values(campaigns.map((c) => (c.rollup_as_of === null ? null : Date.parse(c.rollup_as_of))));
  return known.length === 0 ? null : new Date(Math.min(...known)).toISOString();
}

/** Everything {@link assembleTeamPerformance} needs. */
export interface TeamAssembleInput {
  campaignId: string | null;
  from: string;
  to: string;
  timezone: string;
  asOf: Date;
  main: AgencyTeamMainOutcome;
  campaigns: readonly TeamCampaign[];
  /** Every cohort agent, in the order the rows are sent. */
  agents: readonly TeamAgentSources[];
  /** The rollup by campaign and code over the window. */
  rollupCodes: readonly TeamRollupCodeRow[];
  trendRange: TeamTrendRange;
  /** The rollup by campaign, day and code over the trend's range. */
  rollupDays: readonly TeamRollupDayRow[];
  /** The cohort's promises per local day over the trend's range (empty for successes). */
  promiseDays: ReadonlyMap<string, number>;
}

/** The answer of `GET /proxy/agency/team-performance`. */
export function assembleTeamPerformance(input: TeamAssembleInput): AgencyTeamPerformance {
  const kind = input.main.kind;
  const rows = input.agents.map((a) => teamAgentRow(kind, a));
  const comparable = input.campaignId !== null;
  return {
    campaign_id: input.campaignId,
    from: input.from,
    to: input.to,
    timezone: input.timezone,
    as_of: input.asOf.toISOString(),
    rollup_as_of: oldestRollup(input.campaigns),
    main_outcome: input.main,
    totals: teamTotals(kind, input.agents, wrapupAllowed(input.campaigns, input.rollupCodes)),
    medians: teamMedians(rows),
    outcomes: outcomeBars(input.campaigns, input.rollupCodes),
    trend: teamTrend(input.trendRange, kind, input.campaigns, input.rollupDays, input.promiseDays),
    agents: rows,
    comparable,
    findings: comparable ? teamFindings(kind, rows) : [],
  };
}
