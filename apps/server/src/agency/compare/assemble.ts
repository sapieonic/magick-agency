/**
 * Compare agents' answer, from the read's figures (docs/compare-agents.md §3, §6; the wire is
 * `AgencyCompareResponse`). Pure: the read (`./read.ts`) gathers each cohort agent's counts from
 * the roster and the other sources, and this file turns them into values, the cohort's band, the
 * findings, the day split and the trend, through the shared rules (`compareValue`,
 * `compareCohortMetric`, `compareFindings`, `cohortPercentiles` in
 * `@magick-agency/domain/agent-compare`), never a second implementation of them.
 *
 * Each metric's numerator and denominator (the contract's catalog table, §3):
 *
 * | Metric | Numerator | Denominator |
 * |---|---|---|
 * | `calls_handled` | roster `connected` | (count) |
 * | `calls_per_hour` | roster `connected` | roster `shift_seconds` (breaks inside, CP5) |
 * | `connect_rate` | roster human connects | roster placed first dials |
 * | `success_rate` | roster `successes` | roster `connected` |
 * | `promises_rate` | promises, three call tables | roster `connected` + soft-phone and inbound conversations |
 * | `promised_amount` | the promises' amounts | (amount) |
 * | `callbacks_booked` | call-backs booked with a time in the window | (count) |
 * | `callbacks_kept_rate` | kept on time | on time + late + missed |
 * | `avg_call` | roster `talk_seconds` | roster `connected` |
 * | `choose_time` | roster `wrapup_seconds` | the measured wrap-ups it sums |
 * | `no_outcome_rate` | rollup conversations with no code or the auto-stamp | rollup conversations |
 * | `breaks_over_limit` | breaks over their limit | (count) |
 * | an outcome set | rollup conversations ending in a code of the set | rollup conversations |
 */
import {
  type AgencyCompareAgent,
  type AgencyCompareCohortMetric,
  type AgencyCompareDaySplit,
  type AgencyCompareMetricInfo,
  type AgencyCompareResponse,
  type AgencyCompareTrend,
  type AgencyCompareValue,
} from '@magick-agency/contracts/api/agency/compare';
import type { AgencyAgentOccupancy } from '@magick-agency/contracts/agency';
import { cohortPercentiles, compareCohortMetric, compareFindings, compareValue } from '@magick-agency/domain/agent-compare';
import { AUTO_DISPOSITION_CODE } from '../disposition.js';
import { roundPreservingSum } from '../reports/datasets/shared.js';

/** The IN4 classes of one agent's booked call-backs. */
export interface CompareCallbackClasses {
  on_time: number;
  late: number;
  missed: number;
  pending_future: number;
  pending_due: number;
}

/** What the read holds for ONE cohort agent. A source the request did not need is null. */
export interface CompareAgentSources {
  agent_user_id: string;
  /** The roster row's counts (`rosterAttemptTotals`). */
  roster: {
    connected: number;
    successes: number;
    talk_seconds: number;
    wrapup_seconds: number;
    measured_wrapups: number;
    human_connects: number;
    first_dials: number;
  };
  /** The roster's occupancy fold scoped to the campaign (`foldOccupancy`); null when not read for this agent. */
  occupancy: AgencyAgentOccupancy | null;
  /** Rollup conversations by outcome code (null key: closed without one). */
  rollup: ReadonlyMap<string | null, number> | null;
  promises: { promises: number; amount: number; other_conversations: number } | null;
  callbacks: CompareCallbackClasses | null;
  break_overruns: number | null;
}

/** The sources a metric needs beyond the roster's attempt counts. */
export type CompareSource = 'occupancy' | 'rollup' | 'promises' | 'callbacks' | 'breaks';

/** Which sources `metric` reads (the read runs only these). */
export function metricSources(metric: Pick<AgencyCompareMetricInfo, 'ref'>): CompareSource[] {
  const { ref } = metric;
  if (ref.kind === 'outcomes') return ['rollup'];
  switch (ref.key) {
    case 'calls_per_hour': return ['occupancy'];
    case 'promises_rate':
    case 'promised_amount': return ['promises'];
    case 'callbacks_booked':
    case 'callbacks_kept_rate': return ['callbacks'];
    case 'no_outcome_rate': return ['rollup'];
    case 'breaks_over_limit': return ['breaks'];
    default: return [];
  }
}

function need<T>(value: T | null, source: CompareSource, agent: string): T {
  if (value === null) throw new Error(`compare: the ${source} source was not read for agent ${agent}`);
  return value;
}

const sum = (values: Iterable<number>): number => {
  let s = 0;
  for (const v of values) s += v;
  return s;
};

/** The no-outcome conversations of a rollup by code: no code, or the reaper's auto-stamp (`no_outcome` facet's rule). */
function noOutcome(rollup: ReadonlyMap<string | null, number>): number {
  return (rollup.get(null) ?? 0) + (rollup.get(AUTO_DISPOSITION_CODE) ?? 0);
}

/** One agent's two counts on one metric (see the module table). */
export function metricCounts(metric: Pick<AgencyCompareMetricInfo, 'ref'>, a: CompareAgentSources): { numerator: number; denominator: number | null } {
  const { ref } = metric;
  const r = a.roster;
  if (ref.kind === 'outcomes') {
    const rollup = need(a.rollup, 'rollup', a.agent_user_id);
    const codes = new Set(ref.codes);
    let hits = 0;
    for (const [code, n] of rollup) if (code !== null && codes.has(code)) hits += n;
    return { numerator: hits, denominator: sum(rollup.values()) };
  }
  switch (ref.key) {
    case 'calls_handled': return { numerator: r.connected, denominator: null };
    case 'calls_per_hour': return { numerator: r.connected, denominator: need(a.occupancy, 'occupancy', a.agent_user_id).shift_seconds };
    case 'connect_rate': return { numerator: r.human_connects, denominator: r.first_dials };
    case 'success_rate': return { numerator: r.successes, denominator: r.connected };
    case 'promises_rate': {
      const p = need(a.promises, 'promises', a.agent_user_id);
      return { numerator: p.promises, denominator: r.connected + p.other_conversations };
    }
    case 'promised_amount': return { numerator: need(a.promises, 'promises', a.agent_user_id).amount, denominator: null };
    case 'callbacks_booked': {
      const c = need(a.callbacks, 'callbacks', a.agent_user_id);
      return { numerator: c.on_time + c.late + c.missed + c.pending_future + c.pending_due, denominator: null };
    }
    case 'callbacks_kept_rate': {
      const c = need(a.callbacks, 'callbacks', a.agent_user_id);
      return { numerator: c.on_time, denominator: c.on_time + c.late + c.missed };
    }
    case 'avg_call': return { numerator: r.talk_seconds, denominator: r.connected };
    case 'choose_time': return { numerator: r.wrapup_seconds, denominator: r.measured_wrapups };
    case 'no_outcome_rate': {
      const rollup = need(a.rollup, 'rollup', a.agent_user_id);
      return { numerator: noOutcome(rollup), denominator: sum(rollup.values()) };
    }
    case 'breaks_over_limit': return { numerator: need(a.break_overruns, 'breaks', a.agent_user_id), denominator: null };
  }
}

/**
 * Where a picked agent's logged-in time went (CP5), in whole seconds: the occupancy fold's
 * states, `reserved` folded into waiting as every report figure folds it, rounded so the four
 * parts sum to the rounded shift (`roundPreservingSum`). All zero with no occupancy.
 */
export function daySplitOf(occupancy: AgencyAgentOccupancy | null): AgencyCompareDaySplit {
  if (occupancy === null) return { on_call: 0, choosing: 0, break: 0, waiting: 0, shift_seconds: 0 };
  const s = occupancy.by_state;
  const [on_call, choosing, brk, waiting] = roundPreservingSum([s.on_call, s.wrapup, s.break, s.available + s.reserved]) as [number, number, number, number];
  return { on_call, choosing, break: brk, waiting, shift_seconds: on_call + choosing + brk + waiting };
}

/** The trend's inputs: every cohort agent's counts and logged-in days. */
export interface CompareTrendSources {
  dates: readonly string[];
  /** Per agent, the trend metric's numerator per local date. */
  counts: ReadonlyMap<string, ReadonlyMap<string, number>>;
  /** Per agent, the local dates with logged-in time on the campaign. */
  loggedIn: ReadonlyMap<string, ReadonlySet<string>>;
}

/**
 * The per-day series: each picked agent's count on a day they had logged-in time on the campaign
 * (0 a real zero), null on any other day; per day the median count over the cohort agents logged
 * in that day (`percentile_cont`, the roster benchmark's method), null when none were.
 */
export function trendOf(metricId: string, picked: readonly string[], cohort: readonly string[], t: CompareTrendSources): AgencyCompareTrend {
  const countOn = (agent: string, date: string): number | null =>
    t.loggedIn.get(agent)?.has(date) ? (t.counts.get(agent)?.get(date) ?? 0) : null;
  return {
    metric: metricId,
    dates: [...t.dates],
    agents: picked.map((agent) => ({ agent_user_id: agent, counts: t.dates.map((d) => countOn(agent, d)) })),
    cohort_median: t.dates.map((d) => {
      const values = cohort.map((agent) => countOn(agent, d)).filter((v): v is number => v !== null);
      return cohortPercentiles(values).median;
    }),
  };
}

/** Everything {@link assembleCompareResponse} needs. */
export interface CompareAssembleInput {
  campaignId: string;
  from: string;
  to: string;
  timezone: string;
  asOf: Date;
  metrics: readonly AgencyCompareMetricInfo[];
  trendMetric: AgencyCompareMetricInfo | null;
  /** The picked agents, in the page's order; each is in `cohort`. */
  picked: readonly string[];
  /** Every cohort agent (the roster's rows for the campaign and window, members of the account). */
  cohort: readonly CompareAgentSources[];
  names: ReadonlyMap<string, string | null>;
  trend: CompareTrendSources | null;
}

/** The answer of `POST /compare/query`. */
export function assembleCompareResponse(input: CompareAssembleInput): AgencyCompareResponse {
  const byAgent = new Map(input.cohort.map((a) => [a.agent_user_id, a]));
  const cohortIds = input.cohort.map((a) => a.agent_user_id);

  // Every cohort agent's value on every metric: the band, the pooled figure and the findings
  // need the whole cohort, the picked agents' columns only theirs.
  const values = new Map<string, Map<string, AgencyCompareValue>>();
  for (const metric of input.metrics) {
    const perAgent = new Map<string, AgencyCompareValue>();
    for (const a of input.cohort) {
      const { numerator, denominator } = metricCounts(metric, a);
      perAgent.set(a.agent_user_id, compareValue(metric.definition, numerator, denominator));
    }
    values.set(metric.id, perAgent);
  }

  const perMetric: Record<string, AgencyCompareCohortMetric> = {};
  for (const metric of input.metrics) {
    perMetric[metric.id] = compareCohortMetric(metric.definition, [...values.get(metric.id)!.values()]);
  }

  const agents: AgencyCompareAgent[] = input.picked.map((agent) => {
    const sources = byAgent.get(agent);
    if (!sources) throw new Error(`compare: picked agent ${agent} is not in the cohort`);
    return {
      agent_user_id: agent,
      agent_name: input.names.get(agent) ?? null,
      values: Object.fromEntries(input.metrics.map((m) => [m.id, values.get(m.id)!.get(agent)!])),
      day_split: daySplitOf(sources.occupancy),
    };
  });

  const { findings, not_clear } = compareFindings({
    metrics: input.metrics.map((metric) => ({
      metric,
      cohort: cohortIds.map((agent) => ({ agent_user_id: agent, ...values.get(metric.id)!.get(agent)! })),
    })),
    picked: input.picked,
  });

  return {
    campaign_id: input.campaignId,
    from: input.from,
    to: input.to,
    timezone: input.timezone,
    as_of: input.asOf.toISOString(),
    metrics: [...input.metrics],
    trend_metric: input.trendMetric,
    agents,
    cohort: { agents: input.cohort.length, per_metric: perMetric },
    findings,
    not_clear,
    trend: input.trendMetric !== null && input.trend !== null
      ? trendOf(input.trendMetric.id, input.picked, cohortIds, input.trend)
      : null,
  };
}
