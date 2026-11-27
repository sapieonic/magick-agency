import { COMPARE_PAGE_MAX_AGENTS } from '@magick-agency/contracts/api/agency/compare';
import { reportWindowDays } from '@magick-agency/contracts/api/agency/reports';
import { COMPARE_PATH } from '../compare/compareFlag';
import {
  COMPARE_WINDOW_PRESETS,
  EMPTY_SLOTS,
  compareStateToParams,
  windowDates,
  windowError,
  type CompareWindowPreset,
} from '../compare/compareUrl';

/**
 * Team performance's state in the URL (`docs/team-performance.md` §2): the campaign, the window
 * and the sort, so a link opens the same page. The picks for Compare picked are NOT in the URL
 * and clear when a filter changes (TP18).
 *
 * A LEAF: pure functions over `URLSearchParams`, no React. Reading is an allow-list, as Compare's
 * (`compareUrl.ts`): an unknown window or sort is dropped, so a stale link degrades to the
 * defaults rather than a query the server refuses.
 *
 * | Param | Value |
 * |---|---|
 * | `campaign` | one campaign's id; absent: All campaigns (TP7, the default) |
 * | `when` | `week`, `7d`, `30d` or `custom` (absent: Today) |
 * | `from`, `to` | `YYYY-MM-DD`, with `when=custom` only |
 * | `sort` | `calls` or `shortest` (absent: the main outcome's rate, TP16) |
 *
 * The window's presets and its dates are Compare's (`COMPARE_WINDOW_PRESETS`, `windowDates`,
 * `windowError`): the same days, the same rule (the reports' RP2).
 */

export type TeamWindowPreset = CompareWindowPreset;
export const TEAM_WINDOW_PRESETS = COMPARE_WINDOW_PRESETS;

/** The table's orders (TP16): the main outcome's rate, calls handled, shortest calls. */
export type TeamSort = 'rate' | 'calls' | 'shortest';
export const TEAM_SORTS: readonly TeamSort[] = ['rate', 'calls', 'shortest'];

export interface TeamUrlState {
  /** Null: All campaigns. */
  campaignId: string | null;
  window: TeamWindowPreset;
  /** `custom` only. */
  from: string | null;
  to: string | null;
  sort: TeamSort;
}

const WHEN_PARAM: Readonly<Record<Exclude<TeamWindowPreset, 'today'>, string>> = {
  this_week: 'week',
  last_7_days: '7d',
  last_30_days: '30d',
  custom: 'custom',
};

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const ID = /^[^,\s]{1,100}$/;

function parseWhen(value: string | null): TeamWindowPreset {
  const hit = (Object.entries(WHEN_PARAM) as Array<[TeamWindowPreset, string]>).find(([, v]) => v === value);
  return hit ? hit[0] : 'today';
}

/** URL → state. */
export function teamStateFromParams(params: URLSearchParams): TeamUrlState {
  const campaign = params.get('campaign')?.trim() ?? '';
  const window = parseWhen(params.get('when'));
  const from = params.get('from');
  const to = params.get('to');
  const sort = params.get('sort');
  return {
    campaignId: ID.test(campaign) ? campaign : null,
    window,
    from: window === 'custom' && from && DATE.test(from) ? from : null,
    to: window === 'custom' && to && DATE.test(to) ? to : null,
    sort: sort === 'calls' || sort === 'shortest' ? sort : 'rate',
  };
}

/** State → URL, as a FRESH set in a fixed key order: what is not in the state leaves the query. */
export function teamStateToParams(state: TeamUrlState): URLSearchParams {
  const params = new URLSearchParams();
  if (state.campaignId) params.set('campaign', state.campaignId);
  if (state.window !== 'today') params.set('when', WHEN_PARAM[state.window]);
  if (state.window === 'custom') {
    if (state.from) params.set('from', state.from);
    if (state.to) params.set('to', state.to);
  }
  if (state.sort !== 'rate') params.set('sort', state.sort);
  return params;
}

/** The window's local dates given today in the zone; null for a custom window not yet complete. */
export function teamWindowDates(state: Pick<TeamUrlState, 'window' | 'from' | 'to'>, today: string): { from: string; to: string } | null {
  return windowDates(state, today);
}

/** Why the window cannot be read, in words, or null when it can (the reports' rule, RP2). */
export const teamWindowError = windowError;

/** The window holds today, so its figures move: it runs to now (TP11). */
export function windowHoldsToday(dates: { from: string; to: string } | null, today: string): boolean {
  return dates !== null && dates.from <= today && today <= dates.to;
}

/** The longest window the page reads again on its own (§2 States): a week. */
export const TEAM_AUTO_REFRESH_MAX_DAYS = 7;

/**
 * The page reads this window again on its own (every minute while shown, on return to the page):
 * it holds today AND spans at most {@link TEAM_AUTO_REFRESH_MAX_DAYS} local days (§2 States). A
 * longer window is the heavy read (a month of All campaigns sits at the budget, §4), so it is read
 * once per question and again only when the reader asks.
 */
export function windowAutoRefreshes(dates: { from: string; to: string } | null, today: string): boolean {
  if (dates === null || !windowHoldsToday(dates, today)) return false;
  const days = reportWindowDays(dates.from, dates.to);
  return days !== null && days <= TEAM_AUTO_REFRESH_MAX_DAYS;
}

// ─── Picks for Compare picked (TP18) ────────────────────────────────────────

/** Pick or unpick a row. Past {@link COMPARE_PAGE_MAX_AGENTS} picks a new pick changes nothing. */
export function togglePick(picks: readonly string[], id: string): string[] {
  if (picks.includes(id)) return picks.filter((p) => p !== id);
  if (picks.length >= COMPARE_PAGE_MAX_AGENTS) return [...picks];
  return [...picks, id];
}

/**
 * Compare agents' URL for the picks: the campaign, the same window (the presets are the same
 * ids, a custom one with its dates) and the picks in their colour slots, in pick order.
 */
export function comparePickedPath(
  state: Pick<TeamUrlState, 'window' | 'from' | 'to'>,
  campaignId: string,
  picks: readonly string[],
): string {
  const slots: Array<string | null> = [...EMPTY_SLOTS];
  picks.slice(0, COMPARE_PAGE_MAX_AGENTS).forEach((id, i) => {
    slots[i] = id;
  });
  const params = compareStateToParams({
    campaignId,
    window: state.window,
    from: state.window === 'custom' ? state.from : null,
    to: state.window === 'custom' ? state.to : null,
    slots,
    lens: null,
    metrics: null,
    trend: undefined,
    viewId: null,
  });
  return `${COMPARE_PATH}?${params.toString()}`;
}
