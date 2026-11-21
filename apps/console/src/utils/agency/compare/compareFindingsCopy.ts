import {
  COMPARE_BREAK_OVERRUNS_MIN,
  COMPARE_MIN_RATED_COHORT,
  COMPARE_TIME_RATIO_CLEAR,
  COMPARE_TIME_RATIO_NOT_CLEAR,
  type AgencyCompareFinding,
  type AgencyCompareMetricInfo,
  type AgencyCompareOutcomeCode,
  type AgencyCompareResponse,
  type CompareFindingCode,
  type CompareNextStep,
} from '@magick-agency/contracts/api/agency/compare';
import { AGENCY_ROSTER_MIN_RATE_DENOMINATOR } from '../../../types/agency-stats';
import { DISPLAY_LOCALE, formatCount } from '../../format/number';
import { addDaysToDay, zoneDayStart } from '../insights/range';
import { CALLBACKS_CAMPAIGN_PARAM } from '../accountCallbacks';
import { formatMetricValue, formatRate, infoLabel, infoLabelInSentence, infoNoun, isNoneDue, perWords } from './compareMetrics';

/**
 * "What stands out" in the console's words (`docs/compare-agents.md` §6, CP4, CP12, AS15).
 *
 * The server sends codes and numbers only; every sentence is written here, in a coaching tone:
 * what the numbers show and why the page names it, never a cause and never a verdict on the
 * person. Every number a sentence states is one the page shows. A LEAF: pure functions, no React.
 */

/** How a finding's badge reads and is coloured. */
export type FindingTone = 'clear' | 'best' | 'watch' | 'thin';

export const FINDING_BADGES: Readonly<Record<CompareFindingCode, { label: string; tone: FindingTone }>> = {
  clear_gap: { label: 'Clear gap', tone: 'clear' },
  stands_out: { label: 'Stands out', tone: 'best' },
  over_break_limit: { label: 'Over the limit', tone: 'watch' },
  too_few_calls: { label: 'Too few calls', tone: 'thin' },
};

/** A link to a page that exists, as a finding's next step. */
export interface FindingAction {
  step: CompareNextStep;
  label: string;
  to: string;
}

export interface FindingCopy {
  code: CompareFindingCode;
  badge: string;
  tone: FindingTone;
  /** The agent's name, shown bold at the start of the sentence. */
  name: string;
  /** The rest of the sentence, straight after the name ("’s success rate is …"). */
  rest: string;
  /** Under "Why this?". */
  why: string;
  action: FindingAction | null;
}

/** What the words need beyond the finding. */
export interface FindingContext {
  response: AgencyCompareResponse;
  /** The campaign's current outcome catalog (`options.outcome_codes`). */
  codes: readonly AgencyCompareOutcomeCode[];
  /** The zone the window's days are cut in (the query's `timezone`). */
  timezone: string;
  /** `agency.calls.listen`: the listening steps are hidden without it (RC1). */
  canListen: boolean;
}

/** The agent's name as the page shows it; an id that no longer resolves stays marked as one. */
export function agentName(response: Pick<AgencyCompareResponse, 'agents'>, agentId: string): string {
  const name = response.agents.find((a) => a.agent_user_id === agentId)?.agent_name?.trim();
  return name || `Agent ${agentId.slice(0, 6)}`;
}

/** The first word of a name, for buttons: "Priya". */
export function firstName(name: string): string {
  return name.split(/\s+/)[0] || name;
}

/** "Priya’s", "Lakshmi Das’" — the possessive the sentence starts with, after the bold name. */
export function possessive(name: string): string {
  return /s$/i.test(name) ? '’' : '’s';
}

function metricOf(response: AgencyCompareResponse, id: string): AgencyCompareMetricInfo | null {
  return response.metrics.find((m) => m.id === id) ?? (response.trend_metric?.id === id ? response.trend_metric : null);
}

function numeratorOf(response: AgencyCompareResponse, finding: AgencyCompareFinding): number {
  const value = response.agents.find((a) => a.agent_user_id === finding.agent_user_id)?.values[finding.metric];
  if (value) return value.numerator;
  return Math.round(finding.value * (finding.count ?? 0));
}

/** An outcome rate a supervisor wants high: success, promises, a "higher" outcome set. */
function isHigherOutcome(info: AgencyCompareMetricInfo): boolean {
  if (info.definition.better !== 'higher') return false;
  return info.ref.kind === 'outcomes' || info.ref.key === 'success_rate' || info.ref.key === 'promises_rate';
}

/** The codes a call-log link narrows to for this metric: the set's own, or the catalog's success or promise codes. */
export function outcomeCodesFor(info: AgencyCompareMetricInfo, codes: readonly AgencyCompareOutcomeCode[]): string[] {
  if (info.ref.kind === 'outcomes') return [...info.ref.codes];
  if (info.ref.key === 'success_rate') return codes.filter((c) => c.is_success).map((c) => c.code);
  if (info.ref.key === 'promises_rate') return codes.filter((c) => c.requires_promise).map((c) => c.code);
  return [];
}

/**
 * The campaign's Call attempts tab for one agent: their placed dials in the window (half-open on
 * the dial's local midnights, as every compare count is cut), narrowed to `codes` when given.
 */
export function agentCallsLink(
  campaignId: string,
  agentId: string,
  window: { from: string; to: string; timezone: string },
  codes: readonly string[] = [],
): string {
  const params = new URLSearchParams();
  for (const code of codes) params.append('disposition_code', code);
  params.set('agent_user_id', agentId);
  params.set('placed', '1');
  params.set('dialed_from', zoneDayStart(window.from, window.timezone).toISOString());
  params.set('dialed_to', zoneDayStart(addDaysToDay(window.to, 1), window.timezone).toISOString());
  return `/agency/campaigns/${encodeURIComponent(campaignId)}/attempts?${params.toString()}`;
}

/** A next step as a link to a page that exists, or null when there is none for this reader. */
export function findingAction(finding: AgencyCompareFinding, ctx: FindingContext): FindingAction | null {
  const step = finding.next_step;
  if (step === null) return null;
  const { response } = ctx;
  const info = metricOf(response, finding.metric);
  const first = firstName(agentName(response, finding.agent_user_id));
  const window = { from: response.from, to: response.to, timezone: ctx.timezone };
  const calls = (codes: readonly string[] = []) => agentCallsLink(response.campaign_id, finding.agent_user_id, window, codes);
  switch (step) {
    case 'listen_recent':
      return ctx.canListen ? { step, label: `Listen to ${first}’s calls on this campaign`, to: calls() } : null;
    case 'listen_outcome': {
      if (!ctx.canListen || !info) return null;
      return { step, label: `Listen to ${first}’s calls ending in ${infoLabel(info)}`, to: calls(outcomeCodesFor(info, ctx.codes)) };
    }
    case 'share_best_call': {
      if (!ctx.canListen || !info) return null;
      return { step, label: `Find a call of ${first}’s to share with the team`, to: calls(outcomeCodesFor(info, ctx.codes)) };
    }
    case 'open_breaks':
      return { step, label: `See ${first}’s breaks in Analytics, By agent`, to: '/agency/analytics?view=agents' };
    case 'message_outcome_tip':
      return { step, label: `Talk to ${first} from Live floor`, to: '/agency/home' };
    case 'late_callbacks':
      return {
        step,
        label: 'See this campaign’s late call-backs',
        to: `/agency/callbacks?${CALLBACKS_CAMPAIGN_PARAM}=${encodeURIComponent(response.campaign_id)}`,
      };
  }
}

/** Whether the same agent also has a clear gap on an outcome rate they should be high on. */
function lowOnOutcome(finding: AgencyCompareFinding, response: AgencyCompareResponse): boolean {
  return response.findings.some((f) => {
    if (f.code !== 'clear_gap' || f.agent_user_id !== finding.agent_user_id) return false;
    const info = metricOf(response, f.metric);
    return info !== null && isHigherOutcome(info);
  });
}

function percentAt(fraction: number, digits: number, round: (x: number) => number): string {
  const scale = 10 ** digits;
  // The small nudge keeps 0.29 × 100 (28.999…) from flooring to 28.
  const nudge = round === Math.floor ? 1e-9 : round === Math.ceil ? -1e-9 : 0;
  const n = round(fraction * 100 * scale + nudge) / scale;
  return `${n.toLocaleString(DISPLAY_LOCALE, { minimumFractionDigits: digits, maximumFractionDigits: digits })}%`;
}

/**
 * A likely range that lies wholly `side` a baseline, and the baseline, as percentages that say
 * so: the range's end nearest the baseline is rounded away from it (towards the agent's side),
 * and when the two would still read the same, both are shown to one decimal. So the words never
 * read "28% to 28%" for a range said to sit wholly below 28%.
 */
export function rangeBeside(interval: readonly [number, number], baseline: number, side: 'below' | 'above'): { range: string; base: string } {
  let out = { range: '', base: '' };
  for (const digits of [0, 1, 2]) {
    const low = percentAt(interval[0], digits, side === 'above' ? Math.ceil : Math.round);
    const high = percentAt(interval[1], digits, side === 'below' ? Math.floor : Math.round);
    const base = percentAt(baseline, digits, Math.round);
    out = { range: `${low} to ${high}`, base };
    if ((side === 'below' ? high : low) !== base) break;
  }
  return out;
}

function rateWhy(finding: AgencyCompareFinding, response: AgencyCompareResponse, side: 'below' | 'above'): string {
  const num = formatCount(numeratorOf(response, finding));
  const den = formatCount(finding.count ?? 0);
  const head = `${num} of ${den}.`;
  if (!finding.interval || finding.baseline === null) return head;
  const { range, base } = rangeBeside(finding.interval, finding.baseline, side);
  return `${head} Its likely range, ${range}, sits wholly ${side} the rest of the team’s ${base}, so chance does not explain it.`;
}

/**
 * Why a picked agent under a metric's floor is not compared on it, in that metric's own terms:
 * the roster's floor for a rate (CP9), Compare's own for call-backs kept (§3: agents book only a
 * handful), and a count of wrap-ups for a time, which is not a rate.
 */
export function tooFewWhy(info: AgencyCompareMetricInfo | null, floor: number): string {
  if (info === null) {
    return `A figure is compared only from ${plainCalls(floor)}, so a few lucky or unlucky calls never name anyone.`;
  }
  const floorWords = perWords(info, floor);
  if (info.definition.unit === 'seconds') {
    return `A time to choose an outcome is compared only from ${floorWords}, so a few slow or quick ones never name anyone.`;
  }
  if (info.ref.kind === 'builtin' && info.ref.key === 'callbacks_kept_rate') {
    return `Call-backs kept on time are compared only from ${floorWords}. Agents book only a handful a week, so this floor is lower than the roster’s ${formatCount(AGENCY_ROSTER_MIN_RATE_DENOMINATOR)}, and a few lucky or unlucky ones still never name anyone.`;
  }
  const whose = floor === AGENCY_ROSTER_MIN_RATE_DENOMINATOR ? ', the roster’s own floor,' : '';
  return `A rate is compared only from ${floorWords}${whose} so a few lucky or unlucky calls never name anyone.`;
}

/** The words for one finding of `response.findings`. */
export function findingCopy(finding: AgencyCompareFinding, ctx: FindingContext): FindingCopy {
  const { response } = ctx;
  const badge = FINDING_BADGES[finding.code];
  const name = agentName(response, finding.agent_user_id);
  const info = metricOf(response, finding.metric);
  const action = findingAction(finding, ctx);
  const base = { code: finding.code, badge: badge.label, tone: badge.tone, name, action };
  const unit = info?.definition.unit ?? 'rate';
  const value = formatMetricValue(unit, finding.value);

  if (finding.code === 'over_break_limit') {
    const times = finding.value === 1 ? 'once' : `${formatCount(finding.value)} times`;
    return {
      ...base,
      rest: ` went over the break limit ${times} in this window.`,
      why: `Judged against the campaign’s own break limits, not against other agents. An agent is named from ${COMPARE_BREAK_OVERRUNS_MIN} breaks over the limit in a window.`,
    };
  }

  if (finding.code === 'too_few_calls') {
    if (info && isNoneDue(info, finding.count ?? finding.value)) {
      return {
        ...base,
        rest: ` has no call-backs due yet here, so call-backs kept on time can’t be compared.`,
        why: `None of their call-backs has come due in this window, so there is nothing to keep on time yet. ${tooFewWhy(info, finding.baseline ?? 0)}`,
      };
    }
    const den = info ? perWords(info, finding.count ?? finding.value) : plainCalls(finding.count ?? finding.value);
    // No claim that the counts are shown: a rate under the floor is withheld, hits included (CP9).
    return {
      ...base,
      rest: ` has ${den} here, too few to compare ${info ? infoLabelInSentence(info) : 'this'} fairly.`,
      why: tooFewWhy(info, finding.baseline ?? 0),
    };
  }

  if (info === null) {
    return { ...base, rest: ` stands apart on a metric no longer on the page.`, why: '', action: null };
  }

  if (info.definition.unit === 'seconds') {
    const median = formatMetricValue('seconds', finding.baseline);
    const pair = lowOnOutcome(finding, response) ? ' Worth asking whether the outcome buttons are clear to them.' : '';
    const ratio = finding.ratio ?? (finding.baseline ? finding.value / finding.baseline : 0);
    return {
      ...base,
      rest: ` takes ${value} to choose an outcome (team median ${median}).${pair}`,
      why: `${ratio.toFixed(1)} times the team median, over ${perWords(info, finding.count ?? 0)}. A time is named only from ${COMPARE_TIME_RATIO_CLEAR} times the median.`,
    };
  }

  const rest = finding.baseline === null ? '' : formatRate(finding.baseline);
  if (finding.code === 'stands_out') {
    return {
      ...base,
      rest: ` has a high ${infoNoun(info)} here (${value}; rest of the team ${rest}).`,
      why: rateWhy(finding, response, 'above'),
    };
  }
  // clear_gap on a rate: the worse side is below for "higher", above for "lower".
  const side = info.definition.better === 'lower' ? 'above' : 'below';
  return {
    ...base,
    rest: `${possessive(name)} ${infoNoun(info)} is ${value} (rest of the team ${rest}).`,
    why: rateWhy(finding, response, side),
  };
}

function plainCalls(n: number): string {
  return `${formatCount(n)} ${n === 1 ? 'call' : 'calls'}`;
}

/**
 * A ratio cut DOWN to two decimals, trailing zeros dropped ("1.47", "1.3"): a time not clear yet
 * is under {@link COMPARE_TIME_RATIO_CLEAR} times the median, and 1.47 rounded to one decimal
 * would read "1.5 times … named only from 1.5 times", as if it had reached the line it has not;
 * cut to one decimal, 1.25 (where Not clear yet starts) would read 1.2.
 */
export function ratioDown(ratio: number): string {
  // The small nudge keeps a ratio of exact hundredths, held a hair under it in floating point, from
  // flooring a hundredth lower.
  return String(Math.floor(ratio * 100 + 1e-9) / 100);
}

/** One line of "Not clear yet": a gap on the worse side that could still be chance. */
export function notClearLine(finding: AgencyCompareFinding, ctx: Pick<FindingContext, 'response'>): string {
  const { response } = ctx;
  const name = agentName(response, finding.agent_user_id);
  const info = metricOf(response, finding.metric);
  if (!info) return `${name}: a gap that could still be chance.`;
  const label = infoLabelInSentence(info);
  const value = formatMetricValue(info.definition.unit, finding.value);
  if (info.definition.unit === 'seconds') {
    // A time has no likely range: it is named by how many times the median it is (§6).
    const ratio = finding.ratio ?? (finding.baseline ? finding.value / finding.baseline : null);
    const times = ratio === null ? '' : `, ${ratioDown(ratio)} times the team median`;
    return `${name}: takes ${value} to choose an outcome${times} (${formatMetricValue('seconds', finding.baseline)}). Named only from ${COMPARE_TIME_RATIO_CLEAR} times the median, so not yet.`;
  }
  const base = finding.baseline === null ? '–' : formatRate(finding.baseline);
  const range = finding.interval ? `; likely range ${formatRate(finding.interval[0])} to ${formatRate(finding.interval[1])}` : '';
  return `${name}: ${label} ${value} on ${perWords(info, finding.count ?? 0)} (rest of the team ${base}${range}). Could still be chance.`;
}

/**
 * The line under Not clear yet: what a longer window would settle, for the kinds of gap listed. A
 * rate's likely range narrows with more calls; a time is judged by its ratio to the median
 * ({@link COMPARE_TIME_RATIO_NOT_CLEAR} to {@link COMPARE_TIME_RATIO_CLEAR} times is not clear yet).
 */
export function notClearFoot(response: Pick<AgencyCompareResponse, 'not_clear' | 'metrics' | 'trend_metric'>): string {
  const units = response.not_clear.map((f) => metricOf(response as AgencyCompareResponse, f.metric)?.definition.unit ?? 'rate');
  const times = units.some((u) => u === 'seconds');
  const rates = units.some((u) => u !== 'seconds');
  if (times && !rates) return 'A longer window shows whether the time stays this slow over more wrap-ups.';
  if (times) return 'More calls narrow a rate’s likely range and show whether a time stays this slow, so a longer window can show whether these gaps are real.';
  return 'More calls narrow the likely range, so a longer window can show whether these gaps are real.';
}

/** The metrics on the page shown for context only: "Shown for context, never flagged: …", or null. */
export function neutralNote(response: Pick<AgencyCompareResponse, 'metrics'>): string | null {
  const names = response.metrics.filter((m) => !m.flaggable).map(infoLabel);
  return names.length > 0 ? `Shown for context, never flagged: ${names.join(', ')}.` : null;
}

/** `a`, `a and b`, `a, b and c` (no serial comma). */
function joinAnd(items: readonly string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** Metric names as a list in a sentence; the first capitalised when it starts the sentence. */
function metricList(infos: readonly AgencyCompareMetricInfo[], startsSentence: boolean): string {
  return joinAnd(infos.map((m, i) => (startsSentence && i === 0 ? infoLabel(m) : infoLabelInSentence(m))));
}

/**
 * Why "What stands out" is empty, when it is: no metric on the page has a direction; too few
 * agents clear the floor on a flaggable metric (§6, under {@link COMPARE_MIN_RATED_COHORT}), so it
 * is not judged at all; or nothing passed the rules. Null when there are findings.
 *
 * Each flaggable metric is judged or not on its own rated cohort. A metric with no floor (breaks
 * over their limit) rates every agent of the campaign, so its count must never stand in for the
 * floored ones: on a one-day window where no agent has 20 calls, breaks are still judged, while
 * every rate and time is not, and the page says which and offers a longer window.
 */
export function emptyFindingsNote(response: AgencyCompareResponse): string | null {
  if (response.findings.length > 0) return null;
  const flaggable = response.metrics.filter((m) => m.flaggable);
  if (flaggable.length === 0) {
    return 'Every metric on the page is shown for context only, so none is judged. Add one with a direction, such as an outcome set, to see what stands out.';
  }
  const ratedOf = (m: AgencyCompareMetricInfo) => response.cohort.per_metric[m.id]?.agents_rated ?? 0;
  const unjudged = flaggable.filter((m) => ratedOf(m) < COMPARE_MIN_RATED_COHORT);
  if (unjudged.length === 0) return 'Nothing clear stands out among these agents on these metrics.';
  const counts = unjudged.map(ratedOf);
  const most = Math.max(...counts);
  const same = counts.every((c) => c === most);
  const have = most === 0 ? 'none does' : !same ? `at most ${most} do` : most === 1 ? 'only 1 does' : `only ${most} do`;
  const need = `at least ${COMPARE_MIN_RATED_COHORT} agents on this campaign need enough calls in this window to compare fairly, and ${have}. Check a longer window.`;
  if (unjudged.length === flaggable.length) return `Nothing is judged yet: ${need}`;
  const judged = flaggable.filter((m) => !unjudged.includes(m));
  const verb = unjudged.length === 1 ? 'is' : 'are';
  return `Nothing clear stands out on ${metricList(judged, false)}. ${metricList(unjudged, true)} ${verb} not judged yet: ${need}`;
}
