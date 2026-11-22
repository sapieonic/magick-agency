import {
  AGENCY_CALL_LOG_STATUSES,
  AGENCY_CALL_LOG_TYPE_FILTERS,
  AGENCY_CALL_LOG_TYPE_LABELS,
  type AgencyCallLogCounts,
  type AgencyCallLogRow,
  type AgencyCallLogStatus,
  type AgencyCallLogType,
  type AgencyCallLogTypeFilter,
} from '../../types/agency-call-log';
import { isTerminalCampaignStatus } from '../agencyCampaignControls';
import type { AgencyAttemptFilters } from '../../types/agency-spine';
import { attemptOutcomeLabel } from '../../types/agency-spine';
import { attemptDateRange } from '../agencyAttemptFilters';
import {
  campaignAttemptFiltersToParams,
  isCampaignAttemptFiltered,
} from '../agencyCampaignAttemptParams';
import { formatCount } from '../format/number';

/**
 * The campaign Call log's rules (`docs/call-log.md`, decision CL11): one list of the campaign's
 * calls with type chips, pure. The filters themselves are the attempt list's
 * (`agencyCampaignAttemptParams.ts`); this adds what the combined list has on top of them:
 * the type and the soft-phone status in the URL, the dates the list opens on, the chips, and
 * how a row of each type reads.
 *
 * A LEAF: no React, no fetch.
 */

/** What the page is, under its title. */
export const CALL_LOG_DESCRIPTION =
  'Every call on this campaign, newest first: dialled by the dialler and made from the soft phone, '
  + 'including the dials that never reached an agent.';

// ─── The view in the URL ────────────────────────────────────────────────────

/** `?type=`: the chip that is on. Absent is All. */
export const CALL_LOG_TYPE_PARAM = 'type';
/** `?dates=all`: every date, said out loud. Without it a live campaign's URL with no filter opens on today. */
export const CALL_LOG_DATES_PARAM = 'dates';
/** `?status=`: where a soft-phone call stands ({@link CALL_LOG_STATUS_OPTIONS}). */
export const CALL_LOG_STATUS_PARAM = 'status';
const ALL_DATES = 'all';

/**
 * What the URL says beside the attempt list's filters: the chip, whether every date was asked
 * for, and the soft-phone status filter.
 */
export interface CallLogView {
  type: AgencyCallLogTypeFilter;
  allDates: boolean;
  status: AgencyCallLogStatus | null;
}

export const DEFAULT_CALL_LOG_VIEW: CallLogView = { type: 'all', allDates: false, status: null };

/** URL → view. An unknown type is All and an unknown status none, as an unknown filter key is ignored. */
export function callLogViewFromParams(params: URLSearchParams): CallLogView {
  const rawType = params.get(CALL_LOG_TYPE_PARAM);
  const type = (AGENCY_CALL_LOG_TYPE_FILTERS as readonly string[]).includes(rawType ?? '')
    ? (rawType as AgencyCallLogTypeFilter)
    : 'all';
  const rawStatus = params.get(CALL_LOG_STATUS_PARAM);
  const status = (AGENCY_CALL_LOG_STATUSES as readonly string[]).includes(rawStatus ?? '')
    ? (rawStatus as AgencyCallLogStatus)
    : null;
  return { type, allDates: params.get(CALL_LOG_DATES_PARAM) === ALL_DATES, status };
}

/** Whether anything narrows the list: an attempt filter or the soft-phone status. Not the chip. */
export function isCallLogFiltered(filters: AgencyAttemptFilters, view: Pick<CallLogView, 'status'>): boolean {
  return view.status !== null || isCampaignAttemptFiltered(filters);
}

/**
 * Filters and view → URL. `dates=all` is written only where it changes anything: with no
 * filter at all. Beside a filter it would say nothing (a filtered URL never opens on today).
 */
export function callLogParams(filters: AgencyAttemptFilters, view: CallLogView): URLSearchParams {
  const params = campaignAttemptFiltersToParams(filters);
  if (view.status) params.set(CALL_LOG_STATUS_PARAM, view.status);
  if (view.type !== 'all') params.set(CALL_LOG_TYPE_PARAM, view.type);
  if (view.allDates && !isCallLogFiltered(filters, view)) params.set(CALL_LOG_DATES_PARAM, ALL_DATES);
  return params;
}

/** The Call log's path for one campaign, with a chip on: where `/manual-calls` now leads. */
export function campaignCallLogPath(campaignId: string, type: AgencyCallLogTypeFilter = 'all'): string {
  const base = `/agency/campaigns/${campaignId}/attempts`;
  return type === 'all' ? base : `${base}?${CALL_LOG_TYPE_PARAM}=${type}`;
}

/**
 * Where `/agency/campaigns/:id/manual-calls` lands: the Call log with the Soft phone chip on,
 * and whatever query the old link carried kept (its own `type`, if any, replaced).
 */
export function manualCallsRedirectPath(campaignId: string, search: string): string {
  const params = new URLSearchParams(search);
  params.set(CALL_LOG_TYPE_PARAM, 'soft_phone');
  return `/agency/campaigns/${campaignId}/attempts?${params.toString()}`;
}

// ─── The soft-phone status filter ───────────────────────────────────────────

/**
 * The Status filter's choices, in the Soft-phone calls list's words (the campaign's old
 * Soft-phone calls view had it). A dialler call has no such status: with one chosen the list
 * holds soft-phone calls only, and every chip's count follows it.
 */
export const CALL_LOG_STATUS_OPTIONS: ReadonlyArray<{ value: AgencyCallLogStatus; label: string }> = [
  { value: 'live', label: 'On a call now' },
  { value: 'awaiting_outcome', label: 'Waiting for an outcome' },
  { value: 'settled', label: 'Done' },
];

/** Said under the Status control. */
export const CALL_LOG_STATUS_HINT = 'Soft-phone calls only. A dialler call has no status.';

export function callLogStatusLabel(status: AgencyCallLogStatus): string {
  return CALL_LOG_STATUS_OPTIONS.find((option) => option.value === status)?.label ?? status;
}

// ─── The dates the list opens on ────────────────────────────────────────────

/** `YYYY-MM-DD` on the reader's calendar. */
export function localDay(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** What a URL with no filter shows: today's calls, or every call. */
export type CallLogOpening = 'today' | 'all';

/**
 * The dates a campaign's Call log opens on. A campaign that is dialling, or could again, opens
 * on **today**: "what happened on my campaign today". A finished one (stopped or completed) or
 * an archived one opens on **every date**: its calls are all in the past, and today would be an
 * empty list on the page built to answer "what did this campaign do".
 */
export function callLogOpening(campaign: { status: string; archived_at?: string | null }): CallLogOpening {
  return isTerminalCampaignStatus(campaign.status) || Boolean(campaign.archived_at) ? 'all' : 'today';
}

/**
 * Whether the list is on its opening view: the URL carries no filter and has not asked for
 * every date. A link that carries any filter (an Insights number, one contact) means exactly
 * what it says and is never narrowed to today behind the reader's back.
 */
export function onOpeningView(filters: AgencyAttemptFilters, view: CallLogView): boolean {
  return !view.allDates && !isCallLogFiltered(filters, view);
}

/**
 * The filters the list is read with: the URL's, or on the opening view of a campaign that
 * opens on today, `today` (a {@link localDay}; the page holds it and takes it again on Refresh,
 * so a list left open past midnight moves on).
 */
export function effectiveCallLogFilters(
  filters: AgencyAttemptFilters,
  view: CallLogView,
  opening: CallLogOpening,
  today: string,
): AgencyAttemptFilters {
  if (opening === 'all' || !onOpeningView(filters, view)) return filters;
  return attemptDateRange(today, today);
}

/** The last seven days, today included: what the empty state's "Show last 7 days" applies. */
export function lastSevenDays(now: Date = new Date()): { from?: string; to?: string } {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6, 12);
  return attemptDateRange(localDay(start), localDay(now));
}

/** Whether only the created-date range narrows the list (so an empty list is about the dates). */
export function onlyDatesNarrow(filters: AgencyAttemptFilters, view: Pick<CallLogView, 'status'>): boolean {
  const { from, to, ...rest } = filters;
  return Boolean(from || to) && !isCallLogFiltered(rest, view);
}

// ─── The chips ──────────────────────────────────────────────────────────────

export interface CallLogChip {
  id: AgencyCallLogTypeFilter;
  label: string;
  /** Calls the chosen filters match for this chip, or null before the server has said. */
  count: number | null;
}

/** Whether a type has calls to show or could have: the rule one chip is shown by. */
export interface CallLogTypeAvailability {
  /** The soft phone is on for the account (`agency_softphone_enabled`). */
  softphoneEnabled: boolean;
}

/**
 * The chips to show: "All · Dialler · Soft phone", each with its count.
 *
 * A type that is switched off AND has no call under the chosen filters gets no chip (SR5's
 * rule): the soft phone's flag off and no soft-phone call in the range. The chip that is on is
 * always shown, so a link to it can be left. With one type left there is nothing to choose, so
 * no chips at all.
 */
export function visibleCallLogChips(
  counts: AgencyCallLogCounts | null,
  selected: AgencyCallLogTypeFilter,
  availability: CallLogTypeAvailability,
): CallLogChip[] {
  const shown: Record<AgencyCallLogType, boolean> = {
    dialler: true,
    soft_phone: availability.softphoneEnabled || (counts?.soft_phone ?? 0) > 0 || selected === 'soft_phone',
  };
  const types = (Object.keys(AGENCY_CALL_LOG_TYPE_LABELS) as AgencyCallLogType[]).filter((type) => shown[type]);
  if (types.length < 2) return [];
  return [
    { id: 'all', label: 'All', count: counts?.all ?? null },
    ...types.map((type) => ({ id: type, label: AGENCY_CALL_LOG_TYPE_LABELS[type], count: counts?.[type] ?? null })),
  ];
}

/** The count for the chip that is on, or null when the server sent none. */
export function selectedCallLogCount(counts: AgencyCallLogCounts | null, type: AgencyCallLogTypeFilter): number | null {
  return counts ? counts[type] : null;
}

/**
 * The count line. With the server's count: "1,234 calls — showing 50". Without one: what is on
 * screen, never an "N of M" nothing counted.
 */
export function callLogCountCopy(shown: number, total: number | null, more: boolean): string {
  const noun = (n: number) => `call${n === 1 ? '' : 's'}`;
  if (total !== null) {
    return `${formatCount(total)} ${noun(total)}` + (shown < total ? ` — showing ${formatCount(shown)}` : '');
  }
  return `Showing ${formatCount(shown)} ${noun(shown)}` + (more ? ' — there are more' : '');
}

// ─── The empty list ─────────────────────────────────────────────────────────

export type CallLogEmptyKind =
  /** Only the dates narrow it: say so, and offer the last seven days and every date. */
  | 'dates'
  /** Something else narrows it: "Nothing matches those filters", with Clear. */
  | 'filtered'
  /** Every date, no filter: the campaign has no calls at all. */
  | 'none';

const EMPTY_TYPE_WORDS: Record<AgencyCallLogTypeFilter, string> = {
  all: 'calls',
  dialler: 'dialler calls',
  soft_phone: 'soft-phone calls',
};

/** What an empty list says, and what it offers. `filters` are the ones the list was read with. */
export function callLogEmptyState(
  filters: AgencyAttemptFilters,
  view: Pick<CallLogView, 'type' | 'status'>,
): { kind: CallLogEmptyKind; title: string; description: string } {
  const { type } = view;
  if (onlyDatesNarrow(filters, view)) {
    return {
      kind: 'dates',
      title: `No ${EMPTY_TYPE_WORDS[type]} on this campaign for these dates.`,
      description: 'Widen the dates to see earlier calls.',
    };
  }
  if (isCallLogFiltered(filters, view)) {
    return {
      kind: 'filtered',
      title: 'Nothing matches those filters',
      description: 'Widen the date range or clear the filters to see every call.',
    };
  }
  return type === 'all'
    ? {
      kind: 'none',
      title: 'No calls were placed',
      description: 'This campaign has not dialled anyone yet. Calls appear here as they are placed, '
        + 'including the ones that never reach an agent.',
    }
    : {
      kind: 'none',
      title: `No ${EMPTY_TYPE_WORDS[type]} on this campaign`,
      description: 'Choose All to see every call on this campaign.',
    };
}

// ─── How a row reads ────────────────────────────────────────────────────────

/** The type in words: the Type column. */
export function callLogTypeLabel(type: AgencyCallLogType): string {
  return AGENCY_CALL_LOG_TYPE_LABELS[type];
}

/**
 * A row's own facts, under its type: what only that type has. Dialler: which try it was, and
 * that it was a wrap-up redial. A soft-phone call has none here (its overrides are badges).
 */
export function callLogTypeFacts(row: AgencyCallLogRow): string[] {
  if (row.type !== 'dialler') return [];
  const facts = [`Try ${row.attempt_number}`];
  if ((row.redial_number ?? 0) > 0) facts.push('redial');
  return facts;
}

/** A soft-phone call's override badges, in `SoftphoneCallsList`'s words. */
export function callLogBadges(row: AgencyCallLogRow): Array<{ label: string; title: string }> {
  if (row.type !== 'soft_phone') return [];
  const badges: Array<{ label: string; title: string }> = [];
  if (row.dnc_overridden) badges.push({ label: 'DNC override', title: 'Called through a Do Not Call entry, with a note' });
  if (row.hours_overridden) badges.push({ label: 'Hours override', title: 'Called outside calling hours, with a note' });
  return badges;
}

/**
 * A soft-phone row whose dial was never sent (SR2): the station was gone, or the dial failed
 * before it left. Listed, greyed, and in no chip's count. A dialler attempt is never this:
 * one that did not dial says why in its own outcome.
 */
export function isNotDialled(row: AgencyCallLogRow): boolean {
  return row.type === 'soft_phone' && row.dialed_at === null && row.state === 'ended';
}

/** The What happened cell: what the line did. `key` styles it (`data-outcome`). */
export function callLogWhatHappened(row: AgencyCallLogRow): { text: string; key: string } {
  if (isNotDialled(row)) return { text: 'Not dialled', key: 'not_dialled' };
  if (row.type === 'soft_phone' && row.state !== 'ended') return { text: 'On a call now', key: 'live' };
  return { text: attemptOutcomeLabel(row.outcome), key: row.outcome ?? 'unknown' };
}

/** What the Outcome cell says when no outcome is saved: a soft-phone call that still owes one says so. */
export function callLogOutcomePlaceholder(row: AgencyCallLogRow): string {
  return row.type === 'soft_phone' && row.requires_disposition ? 'No outcome yet' : '—';
}

/** The Agent cell of a soft-phone row: who placed it. */
export function softphoneAgentCopy(row: { agent_name: string | null }): { text: string; muted: boolean } {
  return row.agent_name ? { text: row.agent_name, muted: false } : { text: 'Former member', muted: true };
}

/**
 * Where a row opens: the detail page of its own type. Null when that page cannot be opened:
 * the soft-phone call detail is behind the soft phone's flag.
 */
export function callLogRowPath(
  row: Pick<AgencyCallLogRow, 'type' | 'id'>,
  campaignId: string,
  availability: CallLogTypeAvailability,
): string | null {
  if (row.type === 'dialler') return `/agency/campaigns/${campaignId}/attempts/${row.id}`;
  return availability.softphoneEnabled ? `/agency/softphone/calls/${row.id}` : null;
}
