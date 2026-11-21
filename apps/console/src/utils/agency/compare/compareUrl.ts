import {
  COMPARE_LENSES,
  COMPARE_MAX_METRICS,
  COMPARE_PAGE_MAX_AGENTS,
  compareMetricId,
  compareMetricRefProblem,
  compareWindowProblem,
  parseCompareMetricId,
  type AgencyCompareMetricRef,
  type CompareLens,
} from '@magick-agency/contracts/api/agency/compare';
import { REPORT_MAX_WINDOW_DAYS, reportWindowDays } from '@magick-agency/contracts/api/agency/reports';
import { addDaysToDay } from '../insights/range';
import { presetWindow } from '../../reports/reportWindow';

/**
 * Compare agents' state in the URL (`docs/compare-agents.md` §2): the campaign, the window, the
 * agents in their colour slots, the lens, the metrics (by id, `compareMetricId`) and the trend, so
 * a link opens the same comparison. A saved view holds only the lens, metrics and trend; `view`
 * says which view was applied, so the page can offer to update it.
 *
 * A LEAF: pure functions over `URLSearchParams`, no React.
 *
 * | Param | Value |
 * |---|---|
 * | `campaign` | the campaign id |
 * | `when` | `today`, `week`, `30d` or `custom` (absent: the last 7 days) |
 * | `from`, `to` | `YYYY-MM-DD`, with `when=custom` only |
 * | `agents` | user ids in colour-slot order, comma-joined; an empty entry is a free slot (`,b,c`), so a colour follows the person through a link |
 * | `lens` | `collections`, `sales` or `verification` |
 * | `m` | one per metric, in page order: its id, then `~` and the supervisor's name for an outcome set when it has one |
 * | `trend` | as one `m`, or `none` |
 * | `view` | the saved view applied |
 *
 * Reading is an allow-list, as the attempts filters' (`agencyCampaignAttemptParams.ts`): an id
 * that does not parse, an unknown lens or window is dropped, so a stale or hand-edited link
 * degrades to what this build knows rather than a query the server refuses.
 */

export type CompareWindowPreset = 'today' | 'this_week' | 'last_7_days' | 'last_30_days' | 'custom';

export const COMPARE_WINDOW_PRESETS: ReadonlyArray<{ id: CompareWindowPreset; label: string }> = [
  { id: 'today', label: 'Today' },
  { id: 'this_week', label: 'This week' },
  { id: 'last_7_days', label: 'Last 7 days' },
  { id: 'last_30_days', label: 'Last 30 days' },
  { id: 'custom', label: 'Custom' },
];

const WHEN_PARAM: Readonly<Record<Exclude<CompareWindowPreset, 'last_7_days'>, string>> = {
  today: 'today',
  this_week: 'week',
  last_30_days: '30d',
  custom: 'custom',
};

export interface CompareUrlState {
  campaignId: string | null;
  window: CompareWindowPreset;
  /** `custom` only. */
  from: string | null;
  to: string | null;
  /** The colour slots, {@link COMPARE_PAGE_MAX_AGENTS} long: a user id, or null for a free slot. */
  slots: Array<string | null>;
  lens: CompareLens | null;
  /** Null: the URL names none, so the page uses the campaign's default view or the lens's metrics. */
  metrics: AgencyCompareMetricRef[] | null;
  /** Undefined: the URL says nothing (the defaults apply); null: no trend (`trend=none`). */
  trend: AgencyCompareMetricRef | null | undefined;
  viewId: string | null;
}

export const EMPTY_SLOTS: ReadonlyArray<null> = Object.freeze(Array.from({ length: COMPARE_PAGE_MAX_AGENTS }, () => null));

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const ID = /^[^,\s]{1,100}$/;
const LABEL_SEP = '~';

/** One `m` (or `trend`) value: `id` or `id~label`. A label that fails the contract's rule is dropped, the metric kept. */
export function parseMetricParam(value: string): AgencyCompareMetricRef | null {
  const sep = value.indexOf(LABEL_SEP);
  const id = sep < 0 ? value : value.slice(0, sep);
  const ref = parseCompareMetricId(id);
  if (ref === null) return null;
  if (sep < 0 || ref.kind !== 'outcomes') return ref;
  const labelled = { ...ref, label: value.slice(sep + 1).trim() };
  return compareMetricRefProblem(labelled) === null ? labelled : ref;
}

/** The `m` value of a ref: its id, and its label when it has one. */
export function metricParam(ref: AgencyCompareMetricRef): string {
  const id = compareMetricId(ref);
  return ref.kind === 'outcomes' && ref.label ? `${id}${LABEL_SEP}${ref.label}` : id;
}

function parseWhen(value: string | null): CompareWindowPreset {
  const hit = (Object.entries(WHEN_PARAM) as Array<[CompareWindowPreset, string]>).find(([, v]) => v === value);
  return hit ? hit[0] : 'last_7_days';
}

/** The slots a value of `agents` names: distinct ids, at most three, free slots kept in place. */
export function parseSlots(value: string | null): Array<string | null> {
  const slots: Array<string | null> = [...EMPTY_SLOTS];
  if (!value) return slots;
  const seen = new Set<string>();
  value
    .split(',')
    .slice(0, COMPARE_PAGE_MAX_AGENTS)
    .forEach((raw, i) => {
      const id = raw.trim();
      if (!ID.test(id) || seen.has(id)) return;
      seen.add(id);
      slots[i] = id;
    });
  return slots;
}

/** URL → state. */
export function compareStateFromParams(params: URLSearchParams): CompareUrlState {
  const campaign = params.get('campaign')?.trim() ?? '';
  const window = parseWhen(params.get('when'));
  const from = params.get('from');
  const to = params.get('to');
  const lensValue = params.get('lens');
  const metricValues = params.getAll('m');
  let metrics: AgencyCompareMetricRef[] | null = null;
  if (metricValues.length > 0) {
    const seen = new Set<string>();
    metrics = [];
    for (const value of metricValues) {
      const ref = parseMetricParam(value);
      if (ref === null) continue;
      const id = compareMetricId(ref);
      if (seen.has(id) || metrics.length >= COMPARE_MAX_METRICS) continue;
      seen.add(id);
      metrics.push(ref);
    }
    if (metrics.length === 0) metrics = null;
  }
  const trendValue = params.get('trend');
  const trend = trendValue === null ? undefined : trendValue === 'none' ? null : (parseMetricParam(trendValue) ?? undefined);
  const view = params.get('view')?.trim() ?? '';
  return {
    campaignId: ID.test(campaign) ? campaign : null,
    window,
    from: window === 'custom' && from && DATE.test(from) ? from : null,
    to: window === 'custom' && to && DATE.test(to) ? to : null,
    slots: parseSlots(params.get('agents')),
    lens: (COMPARE_LENSES as readonly string[]).includes(lensValue ?? '') ? (lensValue as CompareLens) : null,
    metrics,
    trend,
    viewId: ID.test(view) ? view : null,
  };
}

/** State → URL, as a FRESH set in a fixed key order: what is not in the state leaves the query. */
export function compareStateToParams(state: CompareUrlState): URLSearchParams {
  const params = new URLSearchParams();
  if (state.campaignId) params.set('campaign', state.campaignId);
  if (state.window !== 'last_7_days') params.set('when', WHEN_PARAM[state.window]);
  if (state.window === 'custom') {
    if (state.from) params.set('from', state.from);
    if (state.to) params.set('to', state.to);
  }
  const slots = [...state.slots];
  while (slots.length > 0 && slots[slots.length - 1] === null) slots.pop();
  if (slots.length > 0) params.set('agents', slots.map((s) => s ?? '').join(','));
  if (state.lens) params.set('lens', state.lens);
  for (const ref of state.metrics ?? []) params.append('m', metricParam(ref));
  if (state.trend === null) params.set('trend', 'none');
  else if (state.trend !== undefined) params.set('trend', metricParam(state.trend));
  if (state.viewId) params.set('view', state.viewId);
  return params;
}

// ─── Agents in their colour slots ───────────────────────────────────────────

/** The picked agents in slot order (the query's `agent_ids`). */
export function pickedAgents(slots: readonly (string | null)[]): string[] {
  return slots.filter((s): s is string => s !== null);
}

/**
 * Pick or unpick an agent. A pick takes the first free slot, so a colour follows the person:
 * removing one agent never repaints the others (§2). Past three picks, nothing changes.
 */
export function toggleAgent(slots: readonly (string | null)[], id: string): Array<string | null> {
  const next = [...slots];
  const at = next.indexOf(id);
  if (at >= 0) {
    next[at] = null;
    return next;
  }
  const free = next.indexOf(null);
  if (free < 0) return next;
  next[free] = id;
  return next;
}

/** The slots with any agent not in `keep` freed (an agent not in the window's cohort). */
export function keepAgents(slots: readonly (string | null)[], keep: ReadonlySet<string>): Array<string | null> {
  return slots.map((s) => (s !== null && keep.has(s) ? s : null));
}

// ─── The window ────────────────────────────────────────────────────────────

/** ISO weekday of a calendar date, Monday 1 … Sunday 7. */
function isoWeekday(day: string): number {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return weekday === 0 ? 7 : weekday;
}

/** The window's local dates given today in the zone; null for a custom window not yet complete. */
export function windowDates(state: Pick<CompareUrlState, 'window' | 'from' | 'to'>, today: string): { from: string; to: string } | null {
  switch (state.window) {
    case 'today':
      return { from: today, to: today };
    case 'this_week':
      return { from: addDaysToDay(today, -(isoWeekday(today) - 1)), to: today };
    case 'last_7_days':
      return presetWindow('last_7_days', today);
    case 'last_30_days':
      return presetWindow('last_30_days', today);
    case 'custom':
      return state.from && state.to ? { from: state.from, to: state.to } : null;
  }
}

/**
 * The window rule in words: the reports' rule (RP2, `reportWindowProblem`), worded as the reports'
 * own refusal words it (`REPORT_ERROR_MESSAGES.report_window_too_long`): at most
 * `REPORT_MAX_WINDOW_DAYS` days, or exactly one calendar month (which can be 31 days).
 */
export const COMPARE_WINDOW_RULE = `Choose at most ${REPORT_MAX_WINDOW_DAYS} days, or exactly one calendar month, ending no later than today.`;

/** Why the window cannot be compared, in words, or null when it can (the reports' rule, RP2). */
export function windowError(dates: { from: string; to: string } | null, today: string): string | null {
  if (dates === null) return 'Choose a start and an end date.';
  return compareWindowProblem(dates.from, dates.to, today) === null ? null : COMPARE_WINDOW_RULE;
}

/**
 * "Check a longer window" (§2): the next window that holds more days, ending on the same day, or
 * null when the window is already as long as the reports allow (30 days or more).
 */
export function longerWindow(
  state: Pick<CompareUrlState, 'window' | 'from' | 'to'>,
  today: string,
): Pick<CompareUrlState, 'window' | 'from' | 'to'> | null {
  const dates = windowDates(state, today);
  if (dates === null) return null;
  const days = reportWindowDays(dates.from, dates.to) ?? 0;
  if (days >= 30) return null;
  if (dates.to === today) {
    return days < 7 ? { window: 'last_7_days', from: null, to: null } : { window: 'last_30_days', from: null, to: null };
  }
  return { window: 'custom', from: addDaysToDay(dates.to, -29), to: dates.to };
}
