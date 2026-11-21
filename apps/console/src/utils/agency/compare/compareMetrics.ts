import {
  COMPARE_BUILTIN_METRICS,
  COMPARE_BUILTIN_METRIC_KEYS,
  COMPARE_MAX_METRICS,
  COMPARE_METRIC_GROUPS,
  COMPARE_OUTCOME_SET_DEFINITION,
  COMPARE_OUTCOME_SET_MAX_CODES,
  compareMetricId,
  defaultOutcomeSetLabel,
  type AgencyCompareMetricInfo,
  type AgencyCompareMetricRef,
  type AgencyCompareOutcomeCode,
  type AgencyCompareOutcomeSetRef,
  type CompareBuiltinMetricKey,
  type CompareLens,
  type CompareMetricBetter,
  type CompareMetricDefinition,
  type CompareMetricGroup,
  type CompareMetricUnit,
} from '@magick-agency/contracts/api/agency/compare';
import { resolveCompareMetric } from '@magick-agency/domain/agent-compare/metrics';
import { COMPARE_LENS_LAYOUT, compareLensDefaults } from '@magick-agency/domain/agent-compare/lens';
import { durationWords } from '../../format/duration';
import { DISPLAY_LOCALE, formatCount, plural } from '../../format/number';

/**
 * Compare agents' metric vocabulary in the console's words (`docs/compare-agents.md` §3, AS15).
 *
 * A LEAF: pure functions over the contract and `@magick-agency/domain/agent-compare`, no React.
 * The server names a built-in by its key and nothing else (its `label` is null), so every word a
 * supervisor reads about a metric comes from {@link BUILTIN_COPY}; an outcome set carries its
 * own label (the supervisor's, else `defaultOutcomeSetLabel`).
 *
 * What the picker offers is the domain's own rule (`resolveCompareMetric`), the same function
 * the server validates with, so the picker can never offer a metric the query would refuse.
 */

/** The words for one built-in metric. */
export interface BuiltinCopy {
  /** The chart title and the picker's line: "Success rate". */
  label: string;
  /** Inside a sentence: "success rate" ("Priya's success rate is 17%"). */
  noun: string;
  /** What the denominator counts, singular and plural: "call" / "calls". */
  per: readonly [string, string];
  /** The picker's and chart's small print: where the number comes from. */
  source: string;
}

export const BUILTIN_COPY: Readonly<Record<CompareBuiltinMetricKey, BuiltinCopy>> = {
  calls_handled: { label: 'Calls handled', noun: 'calls handled', per: ['call', 'calls'], source: 'people spoken to' },
  calls_per_hour: { label: 'Calls per hour', noun: 'calls per hour', per: ['hour', 'hours'], source: 'calls per hour logged in, breaks included' },
  connect_rate: { label: 'Connect rate', noun: 'connect rate', per: ['first dial', 'first dials'], source: 'people who answered, of first dials' },
  success_rate: { label: 'Success rate', noun: 'success rate', per: ['call', 'calls'], source: 'calls ending in a success outcome' },
  promises_rate: { label: 'Promises', noun: 'share of calls with a promise', per: ['call', 'calls'], source: 'calls with a promise to pay recorded' },
  promised_amount: { label: 'Amount promised', noun: 'amount promised', per: ['promise', 'promises'], source: 'sum of promised amounts' },
  callbacks_booked: { label: 'Call-backs booked', noun: 'call-backs booked', per: ['call-back', 'call-backs'], source: 'booked for a time in this window' },
  callbacks_kept_rate: { label: 'Call-backs kept on time', noun: 'call-backs kept on time', per: ['call-back due', 'call-backs due'], source: 'of call-backs whose time has passed' },
  avg_call: { label: 'Average call', noun: 'average call', per: ['call', 'calls'], source: 'talk time per call' },
  choose_time: { label: 'Time to choose outcome', noun: 'time to choose an outcome', per: ['wrap-up', 'wrap-ups'], source: 'wrap-up time per call' },
  no_outcome_rate: { label: 'No outcome chosen', noun: 'share of calls with no outcome chosen', per: ['call', 'calls'], source: 'calls closed with no outcome' },
  breaks_over_limit: { label: 'Breaks over their limit', noun: 'breaks over their limit', per: ['break', 'breaks'], source: 'against the campaign’s own limits' },
};

export const GROUP_LABELS: Readonly<Record<CompareMetricGroup, string>> = {
  volume: 'Volume',
  outcomes: 'Outcomes',
  handling: 'Handling',
  time_use: 'Time use',
};

export const LENS_LABELS: Readonly<Record<CompareLens, string>> = {
  collections: 'Collections',
  sales: 'Sales',
  verification: 'Verification and surveys',
};

/** Which way is better, as the picker and the charts say it. */
export const BETTER_WORDS: Readonly<Record<CompareMetricBetter, string>> = {
  higher: 'higher is better',
  lower: 'lower is better',
  neutral: 'shown, never flagged',
};

/** The outcome-set builder's three choices (CP17, CP18). */
export const BETTER_CHOICES: ReadonlyArray<{ value: CompareMetricBetter; label: string }> = [
  { value: 'higher', label: 'Better when higher' },
  { value: 'lower', label: 'Better when lower' },
  { value: 'neutral', label: 'Just show it' },
];

/** The definition of any ref (an outcome set's `better` filled in). */
export function definitionOf(ref: AgencyCompareMetricRef): CompareMetricDefinition {
  return ref.kind === 'builtin' ? COMPARE_BUILTIN_METRICS[ref.key] : { ...COMPARE_OUTCOME_SET_DEFINITION, better: ref.better };
}

/** A metric's name on screen: a built-in's words, or the outcome set's label. */
export function metricLabel(ref: AgencyCompareMetricRef, codes: readonly AgencyCompareOutcomeCode[]): string {
  if (ref.kind === 'builtin') return BUILTIN_COPY[ref.key].label;
  return ref.label ?? defaultOutcomeSetLabel(ref.codes, codes);
}

/** The name of a metric of an answer: the server's resolved label for an outcome set. */
export function infoLabel(info: AgencyCompareMetricInfo): string {
  if (info.ref.kind === 'builtin') return BUILTIN_COPY[info.ref.key].label;
  return info.label ?? info.ref.label ?? info.ref.codes.join(', ');
}

/**
 * A metric's name inside a sentence: a built-in's label in lower case ("time to choose outcome"),
 * an outcome set's label as the supervisor wrote it ("PTP" stays "PTP").
 */
export function infoLabelInSentence(info: AgencyCompareMetricInfo): string {
  if (info.ref.kind === 'builtin') return BUILTIN_COPY[info.ref.key].label.toLowerCase();
  return infoLabel(info);
}

/** The metric inside a sentence: "success rate", "share of calls ending in Will pay". */
export function infoNoun(info: AgencyCompareMetricInfo): string {
  if (info.ref.kind === 'builtin') return BUILTIN_COPY[info.ref.key].noun;
  return `share of calls ending in ${infoLabel(info)}`;
}

/** What a metric's denominator counts, agreeing with `n`: "1 call", "12 wrap-ups". */
export function perWords(info: Pick<AgencyCompareMetricInfo, 'ref'>, n: number): string {
  const [one, many] = info.ref.kind === 'builtin' ? BUILTIN_COPY[info.ref.key].per : (['call', 'calls'] as const);
  return plural(n, one, many);
}

/** The chart's small print: which way is better, and where the number comes from. */
export function metricSubtitle(info: AgencyCompareMetricInfo): string {
  const source = info.ref.kind === 'builtin' ? BUILTIN_COPY[info.ref.key].source : 'share of calls ending in these outcomes';
  return `${BETTER_WORDS[info.definition.better]} · ${source}`;
}

// ─── Formatting by unit ─────────────────────────────────────────────────────

const WHOLE = new Intl.NumberFormat(DISPLAY_LOCALE, { maximumFractionDigits: 0 });
const ONE_DECIMAL = new Intl.NumberFormat(DISPLAY_LOCALE, { minimumFractionDigits: 1, maximumFractionDigits: 1 });

/** A rate (a FRACTION on the wire) as a whole percentage: `0.194` → `19%`. */
export function formatRate(fraction: number): string {
  return `${Math.round(fraction * 100)}%`;
}

/**
 * One figure in its unit: rates as percentages, seconds as "4m 12s", calls per hour to one
 * decimal, amounts grouped with no currency (PT5), counts grouped. Null is a dash.
 */
export function formatMetricValue(unit: CompareMetricUnit, value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '–';
  switch (unit) {
    case 'rate':
      return formatRate(value);
    case 'seconds':
      return durationWords(value);
    case 'per_hour':
      return ONE_DECIMAL.format(value);
    case 'amount':
      return WHOLE.format(value);
    case 'count':
      return formatCount(Math.round(value));
  }
}

/**
 * The bar's words in place of a bar under the floor: "Too few to compare (12 calls; needs 20)".
 * A null denominator (none sent) states no count: an unknown count is never written as 0.
 */
export function tooFewWords(info: AgencyCompareMetricInfo, denominator: number | null): string {
  const floor = info.definition.min_denominator;
  const parts = [denominator === null ? null : perWords(info, denominator), floor === null ? null : `needs ${formatCount(floor)}`].filter(
    (p): p is string => p !== null,
  );
  return parts.length > 0 ? `Too few to compare (${parts.join('; ')})` : 'Too few to compare';
}

/** The same in fewer words, for a narrow chart: "Too few (12 of 20)". */
export function tooFewShort(info: AgencyCompareMetricInfo, denominator: number | null): string {
  const floor = info.definition.min_denominator;
  if (denominator === null) return floor === null ? 'Too few' : `Too few (needs ${formatCount(floor)})`;
  const have = formatCount(denominator);
  return floor === null ? `Too few (${have})` : `Too few (${have} of ${formatCount(floor)})`;
}

// ─── The picker ────────────────────────────────────────────────────────────

/** The built-ins this campaign may show, in catalog order (promise metrics only when it records promises). */
export function availableBuiltins(codes: readonly AgencyCompareOutcomeCode[]): CompareBuiltinMetricKey[] {
  return COMPARE_BUILTIN_METRIC_KEYS.filter((key) => resolveCompareMetric({ kind: 'builtin', key }, codes).ok);
}

/** The picker's groups, each with its built-ins, in the picker's order; empty groups left out. */
export function pickerGroups(codes: readonly AgencyCompareOutcomeCode[]): Array<{ group: CompareMetricGroup; keys: CompareBuiltinMetricKey[] }> {
  const keys = availableBuiltins(codes);
  return COMPARE_METRIC_GROUPS.map((group) => ({ group, keys: keys.filter((k) => COMPARE_BUILTIN_METRICS[k].group === group) })).filter(
    (g) => g.keys.length > 0,
  );
}

/** Whether one more metric fits ({@link COMPARE_MAX_METRICS}). */
export function canAddMetric(metrics: readonly AgencyCompareMetricRef[]): boolean {
  return metrics.length < COMPARE_MAX_METRICS;
}

/** `metrics` with `ref` added at the end, unless it is there already (by id) or six are chosen. */
export function addMetric(metrics: readonly AgencyCompareMetricRef[], ref: AgencyCompareMetricRef): AgencyCompareMetricRef[] {
  const id = compareMetricId(ref);
  if (!canAddMetric(metrics) || metrics.some((m) => compareMetricId(m) === id)) return [...metrics];
  return [...metrics, ref];
}

/** `metrics` less the one with `id`; never empty (the last metric stays: a comparison needs one). */
export function removeMetric(metrics: readonly AgencyCompareMetricRef[], id: string): AgencyCompareMetricRef[] {
  if (metrics.length <= 1) return [...metrics];
  return metrics.filter((m) => compareMetricId(m) !== id);
}

/** A ref that can be the per-day trend: an outcome set or `promises_rate`. */
export function isCountable(ref: AgencyCompareMetricRef): boolean {
  return definitionOf(ref).countable;
}

/**
 * The trend's choices: every countable metric on screen, then `promises_rate` when the campaign
 * records promises, then the current trend if it is neither (a saved view's trend need not be on
 * screen). Distinct by id, in that order.
 */
export function trendChoices(
  metrics: readonly AgencyCompareMetricRef[],
  current: AgencyCompareMetricRef | null,
  codes: readonly AgencyCompareOutcomeCode[],
): AgencyCompareMetricRef[] {
  const out: AgencyCompareMetricRef[] = [];
  const seen = new Set<string>();
  const push = (ref: AgencyCompareMetricRef) => {
    const id = compareMetricId(ref);
    if (seen.has(id) || !isCountable(ref) || !resolveCompareMetric(ref, codes).ok) return;
    seen.add(id);
    out.push(ref);
  };
  metrics.forEach(push);
  push({ kind: 'builtin', key: 'promises_rate' });
  if (current) push(current);
  return out;
}

// ─── Outcome sets ──────────────────────────────────────────────────────────

/** The builder's codes with `code` toggled; never more than {@link COMPARE_OUTCOME_SET_MAX_CODES}. */
export function toggleCode(codes: readonly string[], code: string): string[] {
  if (codes.includes(code)) return codes.filter((c) => c !== code);
  if (codes.length >= COMPARE_OUTCOME_SET_MAX_CODES) return [...codes];
  return [...codes, code];
}

/**
 * The outcome set the builder makes: the chosen codes in catalog order, the direction, and the
 * name only when the supervisor typed one that differs from the default label.
 */
export function buildOutcomeSet(
  codes: readonly string[],
  better: CompareMetricBetter,
  name: string,
  catalog: readonly AgencyCompareOutcomeCode[],
): AgencyCompareOutcomeSetRef {
  const sorted = (inCatalogOrder({ kind: 'outcomes', codes: [...codes], better }, catalog) as AgencyCompareOutcomeSetRef).codes;
  const label = name.trim();
  const ref: AgencyCompareOutcomeSetRef = { kind: 'outcomes', codes: sorted, better };
  if (label && label !== defaultOutcomeSetLabel(sorted, catalog)) ref.label = label;
  return ref;
}

/** Why the builder cannot add its set yet, in words, or null when it can. */
export function outcomeSetProblem(
  codes: readonly string[],
  better: CompareMetricBetter,
  name: string,
  metrics: readonly AgencyCompareMetricRef[],
  catalog: readonly AgencyCompareOutcomeCode[],
): string | null {
  if (codes.length === 0) return 'Choose at least one outcome.';
  if (!canAddMetric(metrics)) return `Six metrics are chosen. Remove one to add this.`;
  if (name.trim().length > 60) return 'Keep the name to 60 characters.';
  const id = compareMetricId(buildOutcomeSet(codes, better, name, catalog));
  if (metrics.some((m) => compareMetricId(m) === id)) return 'That outcome set is already on the page.';
  return null;
}

// ─── Lenses and saved views against a campaign ─────────────────────────────

export { COMPARE_LENS_LAYOUT, compareLensDefaults };

/** Why a trend was left out: the campaign cannot show it, or it cannot be counted per day. */
export type TrendDropReason = 'catalog' | 'not_countable';

/** What applying a list of refs to a campaign kept, and what it had to leave out. */
export interface AppliedMetrics {
  metrics: AgencyCompareMetricRef[];
  trend: AgencyCompareMetricRef | null;
  /** The names of the metrics left out because the campaign does not have their outcomes (or does not record promises). */
  dropped: string[];
  /** The trend that was left out, with its name and why; null when it was kept or there was none. */
  trendDropped: { label: string; reason: TrendDropReason } | null;
}

/**
 * A saved view's (or a link's) metrics against the campaign's CURRENT catalog: each ref the
 * catalog can no longer show is dropped and named, never sent (the server would refuse the whole
 * query `compare_metric_invalid`, §3). Duplicates by id are dropped silently; at most six kept.
 */
export function applyToCatalog(
  refs: readonly AgencyCompareMetricRef[],
  trend: AgencyCompareMetricRef | null,
  codes: readonly AgencyCompareOutcomeCode[],
): AppliedMetrics {
  const metrics: AgencyCompareMetricRef[] = [];
  const dropped: string[] = [];
  const seen = new Set<string>();
  for (const raw of refs) {
    const ref = inCatalogOrder(raw, codes);
    const id = compareMetricId(ref);
    if (seen.has(id)) continue;
    seen.add(id);
    if (!resolveCompareMetric(ref, codes).ok) {
      dropped.push(metricLabel(ref, codes));
      continue;
    }
    if (metrics.length < COMPARE_MAX_METRICS) metrics.push(ref);
  }
  if (trend === null) return { metrics, trend: null, dropped, trendDropped: null };
  const label = metricLabel(trend, codes);
  if (!resolveCompareMetric(trend, codes).ok) return { metrics, trend: null, dropped, trendDropped: { label, reason: 'catalog' } };
  if (!isCountable(trend)) return { metrics, trend: null, dropped, trendDropped: { label, reason: 'not_countable' } };
  return { metrics, trend: inCatalogOrder(trend, codes), dropped, trendDropped: null };
}

/**
 * An outcome set with its codes in the catalog's order. A set read from a link has them sorted
 * (its id sorts them), and its default label joins them in the order held, so this keeps "Will
 * pay or Part paid" from turning into "Part paid or Will pay" on a reload. A built-in is as is.
 */
export function inCatalogOrder(ref: AgencyCompareMetricRef, codes: readonly AgencyCompareOutcomeCode[]): AgencyCompareMetricRef {
  if (ref.kind === 'builtin') return ref;
  const order = new Map(codes.map((c, i) => [c.code, i] as const));
  const sorted = [...ref.codes].sort((a, b) => (order.get(a) ?? Number.MAX_SAFE_INTEGER) - (order.get(b) ?? Number.MAX_SAFE_INTEGER));
  return sorted.every((c, i) => c === ref.codes[i]) ? ref : { ...ref, codes: sorted };
}

/**
 * The sentences that say what applying a view or a link left out, each with its own reason, or
 * null when it kept everything.
 */
export function droppedNote(applied: Pick<AppliedMetrics, 'dropped' | 'trendDropped'>): string | null {
  const parts: string[] = [];
  if (applied.dropped.length > 0) {
    const names = applied.dropped.join(', ');
    parts.push(
      applied.dropped.length === 1
        ? `${names} was left out: this campaign doesn’t have its outcomes.`
        : `${names} were left out: this campaign doesn’t have their outcomes.`,
    );
  }
  const trend = applied.trendDropped;
  if (trend?.reason === 'catalog') {
    parts.push(
      applied.dropped.length > 0
        ? 'The per-day trend was left out for the same reason.'
        : `The per-day trend, ${trend.label}, was left out: this campaign doesn’t have its outcomes.`,
    );
  } else if (trend?.reason === 'not_countable') {
    parts.push(`${trend.label} can’t be counted per day, so no per-day trend is shown. Choose an outcome set or promises for it.`);
  }
  return parts.length > 0 ? parts.join(' ') : null;
}

/**
 * The note when none of a link's or a view's metrics can be shown on this campaign, so the page
 * falls back to the lens's own: what was left out, and what is shown instead. `source` names
 * where the metrics came from: "the link", "the campaign’s default view, “Weekly”," (an
 * appositive carries its closing comma).
 */
export function fallbackNote(applied: Pick<AppliedMetrics, 'dropped' | 'trendDropped'>, source: string, lens: CompareLens): string {
  const left = droppedNote(applied);
  const instead = `None of the metrics in ${source} can be shown on this campaign, so the ${LENS_LABELS[lens]} lens’s metrics are shown instead.`;
  return left ? `${left} ${instead}` : instead;
}
