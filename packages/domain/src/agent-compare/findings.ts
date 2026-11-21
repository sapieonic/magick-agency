/**
 * ─── COMPARE AGENTS — WHAT STANDS OUT ───────────────────────────────────────
 *
 * A LEAF module: one pure function over the read's figures, importing only contract types and the
 * sibling leaves. No I/O. The rules are docs/compare-agents.md §6 (CP10, CP11); this file is their
 * one implementation, and its table tests (`test/unit/agent-compare/findings.test.ts`) are
 * mutation-checked.
 *
 * It names an agent only when chance cannot explain the gap:
 *
 * - **Rates** (`clear_gap`): the agent clears the metric's floor; the REST of the cohort's pooled
 *   rate is computed with the agent left out (sum of the others' hits over the sum of their calls,
 *   thin agents included); the agent's 95% Wilson interval lies WHOLLY on the worse side of it;
 *   and the gap (point value against that baseline) is at least the metric's `min_gap`. A gap of at
 *   least `min_gap` on the worse side whose interval still reaches the baseline goes to
 *   `not_clear`. A gap under `min_gap` goes nowhere, interval or not: too small to coach on.
 * - **Praise** (`stands_out`): the same test the other way, for a higher-is-better OUTCOME rate
 *   only (`success_rate`, `promises_rate`, a `higher` outcome set): interval wholly above the rest,
 *   gap at least `min_gap`. Never goes to `not_clear`.
 * - **Time to choose an outcome** (`clear_gap` on `choose_time`): at least
 *   `COMPARE_TIME_RATIO_CLEAR` (1.5) times the cohort median, on at least `COMPARE_TIME_MIN_CALLS`
 *   measured wrap-ups; from `COMPARE_TIME_RATIO_NOT_CLEAR` (1.25) up to 1.5 → `not_clear`. The
 *   median is over the cohort's reportable values, the agent's own included (the band drawn).
 * - **Breaks** (`over_break_limit`): `COMPARE_BREAK_OVERRUNS_MIN` (2) or more breaks over their
 *   reason's limit in the window: judged against the campaign's own limits, not the cohort.
 * - **Too few calls** (`too_few_calls`): a picked agent under the floor of a flaggable metric on
 *   screen, once per agent, citing the first such metric in page order.
 *
 * Guards, in order:
 * 1. Neutral metrics (`better: 'neutral'`) are never named, and yield nothing at all (CP10).
 * 2. A metric whose RATED cohort (agents reportable on it, picked ones included) is under
 *    `COMPARE_MIN_RATED_COHORT` (6) yields nothing at all: no finding, no `not_clear`, no
 *    `too_few_calls`. With so few agents "the rest" is not a benchmark. The breaks metric has no
 *    floor, so every cohort agent with a value counts toward its 6.
 * 3. At most `COMPARE_FINDINGS_PER_AGENT` (3) findings per agent and `COMPARE_FINDINGS_MAX` (5) in
 *    all, taken in this order: clear rate gaps, then times, then breaks, then `stands_out`, then
 *    `too_few_calls`; within one class the larger gap first (a rate's gap in units of its
 *    `min_gap`, a time's ratio, a break count), then the page's agent order, then its metric order.
 *    What does not fit is DROPPED: never moved to `not_clear`, which holds only gaps that could
 *    still be chance.
 *
 * Only the metrics on screen are judged: a break finding needs `breaks_over_limit` among them.
 */
import {
  COMPARE_BREAK_OVERRUNS_MIN,
  COMPARE_FINDINGS_MAX,
  COMPARE_FINDINGS_PER_AGENT,
  COMPARE_MIN_RATED_COHORT,
  COMPARE_TIME_MIN_CALLS,
  COMPARE_TIME_RATIO_CLEAR,
  COMPARE_TIME_RATIO_NOT_CLEAR,
  type AgencyCompareFinding,
  type AgencyCompareMetricInfo,
  type CompareNextStep,
} from '@magick-agency/contracts/api/agency/compare';
import { cohortPercentiles } from './percentiles';
import { wilsonInterval } from './wilson';

/**
 * One cohort agent's counts on one metric: the fields of `AgencyCompareValue` the rules read.
 * For a rate `numerator` / `denominator` are hits / calls; for `choose_time` seconds / measured
 * wrap-ups; for `breaks_over_limit` the count is `numerator`.
 */
export interface CompareAgentFigure {
  agent_user_id: string;
  numerator: number;
  denominator: number | null;
  value: number | null;
  reportable: boolean;
}

/** One metric on screen: its resolved description and EVERY cohort agent's figure, picked ones included. */
export interface CompareFindingsMetric {
  metric: Pick<AgencyCompareMetricInfo, 'id' | 'ref' | 'definition'>;
  cohort: readonly CompareAgentFigure[];
}

export interface CompareFindingsInput {
  /** The metrics on screen, in page order. */
  metrics: readonly CompareFindingsMetric[];
  /** The picked agents' user ids, in page order. */
  picked: readonly string[];
}

export interface CompareFindingsResult {
  findings: AgencyCompareFinding[];
  not_clear: AgencyCompareFinding[];
}

/**
 * Tolerance on `gap >= min_gap`: a gap of exactly five points computed as 0.30 − 0.25 is
 * 0.04999999999999999 in floating point, and must count as five points.
 */
const GAP_EPSILON = 1e-9;

/** The class order of §6: rate gaps, times, breaks, praise, too few. */
type FindingClass = 0 | 1 | 2 | 3 | 4;

interface Candidate {
  finding: AgencyCompareFinding;
  cls: FindingClass;
  /** Larger first within a class. */
  severity: number;
  agentIndex: number;
  metricIndex: number;
}

type Kind = 'rate' | 'time' | 'breaks' | null;

function kindOf(metric: CompareFindingsMetric['metric']): Kind {
  const { ref, definition } = metric;
  if (ref.kind === 'builtin' && ref.key === 'choose_time') return 'time';
  if (ref.kind === 'builtin' && ref.key === 'breaks_over_limit') return 'breaks';
  if (definition.unit === 'rate' && definition.min_gap !== null) return 'rate';
  return null;
}

/** An outcome rate: the only rates `stands_out` may praise (the console's copy asks the same). */
export function isOutcomeRate(metric: CompareFindingsMetric['metric']): boolean {
  const { ref } = metric;
  return ref.kind === 'outcomes' || ref.key === 'success_rate' || ref.key === 'promises_rate';
}

/** The next step a `clear_gap` on a rate offers. */
function rateNextStep(metric: CompareFindingsMetric['metric']): CompareNextStep {
  const { ref, definition } = metric;
  if (ref.kind === 'outcomes') return definition.better === 'lower' ? 'listen_outcome' : 'listen_recent';
  if (ref.key === 'no_outcome_rate') return 'message_outcome_tip';
  if (ref.key === 'callbacks_kept_rate') return 'late_callbacks';
  return 'listen_recent';
}

function finding(
  partial: Pick<AgencyCompareFinding, 'code' | 'agent_user_id' | 'metric' | 'value'> & Partial<AgencyCompareFinding>,
): AgencyCompareFinding {
  return { baseline: null, interval: null, ratio: null, count: null, next_step: null, ...partial };
}

function byClassThenSeverity(a: Candidate, b: Candidate): number {
  return a.cls - b.cls || b.severity - a.severity || a.agentIndex - b.agentIndex || a.metricIndex - b.metricIndex;
}

/** The findings and the not-clear gaps for the picked agents (docs/compare-agents.md §6). */
export function compareFindings(input: CompareFindingsInput): CompareFindingsResult {
  const candidates: Candidate[] = [];
  const unclear: Candidate[] = [];
  /** Per picked agent, the first flaggable metric on screen they are under the floor of. */
  const tooFew = new Map<string, { metricIndex: number; id: string; den: number; floor: number }>();

  input.metrics.forEach(({ metric, cohort }, metricIndex) => {
    const { definition } = metric;
    if (definition.better === 'neutral') return;
    const kind = kindOf(metric);
    if (kind === null) return;
    const rated = cohort.filter((f) => f.reportable && f.value !== null);
    if (rated.length < COMPARE_MIN_RATED_COHORT) return;
    const median = kind === 'time' ? cohortPercentiles(rated.map((f) => f.value as number)).median : null;

    input.picked.forEach((agent, agentIndex) => {
      const fig = cohort.find((f) => f.agent_user_id === agent);
      if (!fig) return;
      const at = { agentIndex, metricIndex };
      const den = fig.denominator ?? 0;

      if (definition.min_denominator !== null && !fig.reportable) {
        if (!tooFew.has(agent)) tooFew.set(agent, { metricIndex, id: metric.id, den, floor: definition.min_denominator });
        return;
      }

      if (kind === 'breaks') {
        if (fig.numerator >= COMPARE_BREAK_OVERRUNS_MIN) {
          candidates.push({
            ...at, cls: 2, severity: fig.numerator,
            finding: finding({ code: 'over_break_limit', agent_user_id: agent, metric: metric.id, value: fig.numerator, next_step: 'open_breaks' }),
          });
        }
        return;
      }

      if (kind === 'time') {
        if (fig.value === null || median === null || median <= 0 || den < COMPARE_TIME_MIN_CALLS) return;
        const ratio = fig.value / median;
        const base = { code: 'clear_gap' as const, agent_user_id: agent, metric: metric.id, value: fig.value, baseline: median, ratio, count: den };
        if (ratio >= COMPARE_TIME_RATIO_CLEAR) {
          candidates.push({ ...at, cls: 1, severity: ratio, finding: finding({ ...base, next_step: 'message_outcome_tip' }) });
        } else if (ratio >= COMPARE_TIME_RATIO_NOT_CLEAR) {
          unclear.push({ ...at, cls: 1, severity: ratio, finding: finding(base) });
        }
        return;
      }

      // kind === 'rate'
      const minGap = definition.min_gap as number;
      if (den <= 0) return;
      let restNum = 0;
      let restDen = 0;
      for (const other of cohort) {
        if (other.agent_user_id === agent) continue;
        restNum += other.numerator;
        restDen += other.denominator ?? 0;
      }
      if (restDen <= 0) return;
      const baseline = restNum / restDen;
      const value = fig.numerator / den;
      const interval = wilsonInterval(fig.numerator, den);
      if (interval === null) return;
      const higher = definition.better === 'higher';
      const worseBy = higher ? baseline - value : value - baseline;
      const base = { agent_user_id: agent, metric: metric.id, value, baseline, interval, count: den };

      if (worseBy + GAP_EPSILON >= minGap) {
        const whollyWorse = higher ? interval[1] < baseline : interval[0] > baseline;
        if (whollyWorse) {
          candidates.push({
            ...at, cls: 0, severity: worseBy / minGap,
            finding: finding({ ...base, code: 'clear_gap', next_step: rateNextStep(metric) }),
          });
        } else {
          unclear.push({ ...at, cls: 0, severity: worseBy / minGap, finding: finding({ ...base, code: 'clear_gap' }) });
        }
        return;
      }

      const betterBy = -worseBy;
      if (higher && isOutcomeRate(metric) && betterBy + GAP_EPSILON >= minGap && interval[0] > baseline) {
        candidates.push({
          ...at, cls: 3, severity: betterBy / minGap,
          finding: finding({ ...base, code: 'stands_out', next_step: 'share_best_call' }),
        });
      }
    });
  });

  input.picked.forEach((agent, agentIndex) => {
    const few = tooFew.get(agent);
    if (!few) return;
    candidates.push({
      agentIndex, metricIndex: few.metricIndex, cls: 4, severity: 0,
      finding: finding({ code: 'too_few_calls', agent_user_id: agent, metric: few.id, value: few.den, baseline: few.floor, count: few.den }),
    });
  });

  candidates.sort(byClassThenSeverity);
  const perAgent = new Map<string, number>();
  const findings: AgencyCompareFinding[] = [];
  for (const c of candidates) {
    if (findings.length >= COMPARE_FINDINGS_MAX) break;
    const n = perAgent.get(c.finding.agent_user_id) ?? 0;
    if (n >= COMPARE_FINDINGS_PER_AGENT) continue;
    perAgent.set(c.finding.agent_user_id, n + 1);
    findings.push(c.finding);
  }

  unclear.sort(byClassThenSeverity);
  return { findings, not_clear: unclear.map((c) => c.finding) };
}
