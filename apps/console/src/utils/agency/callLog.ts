import {
  AGENCY_CALLS_NO_CAMPAIGN,
  AGENCY_CALL_LOG_INBOUND_OUTCOME_FILTERS,
  AGENCY_CALL_LOG_INBOUND_OUTCOME_FILTER_LABELS,
  AGENCY_CALL_LOG_STATUSES,
  AGENCY_CALL_LOG_TYPE_FILTERS,
  AGENCY_CALL_LOG_TYPE_LABELS,
  type AgencyCallLogCounts,
  type AgencyCallLogFollowUp,
  type AgencyCallLogInboundOutcomeFilter,
  type AgencyCallLogInboundRow,
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
import { dateFormatter, upperDayPeriod } from '../format/date';
import { formatCallTimestamp, formatTalkTime } from '../agencySpineCopy';
import { AGENCY_INBOUND_TOOK_OVER_DISPOSITION_CODE } from '../../types/inbound';
import { missedReasonLabel } from '../inbound/missedCopy';

/**
 * The campaign Call log's rules (`docs/call-log.md`, decisions CL1, CL11): one list of the
 * campaign's calls (dialled, made from the soft phone, received) with type chips, pure. The filters themselves are the attempt list's
 * (`agencyCampaignAttemptParams.ts`); this adds what the combined list has on top of them:
 * the type and the soft-phone status in the URL, the dates the list opens on, the chips, and
 * how a row of each type reads.
 *
 * A LEAF: no React, no fetch.
 */

/** What the page is, under its title. */
export const CALL_LOG_DESCRIPTION =
  'Every call on this campaign, newest first: dialled, made from the soft phone and received, '
  + 'including the dials that never reached an agent.';

/** What the account's All calls says under its title (`docs/call-log.md` §7). */
export const ALL_CALLS_DESCRIPTION =
  'Every call in this account, newest first: dialled, made from the soft phone and received, '
  + 'on every campaign and on none.';

/** `?campaign_id=` on All calls: a campaign's id, or `none` for the calls filed under no campaign. */
export const ALL_CALLS_CAMPAIGN_PARAM = 'campaign_id';

/** The account's All calls, with a chip on and a campaign chosen. */
export function allCallsPath(options: { type?: AgencyCallLogTypeFilter; campaign?: string } = {}): string {
  const params = new URLSearchParams();
  if (options.type && options.type !== 'all') params.set(CALL_LOG_TYPE_PARAM, options.type);
  if (options.campaign) params.set(ALL_CALLS_CAMPAIGN_PARAM, options.campaign);
  const qs = params.toString();
  return qs ? `/agency/calls?${qs}` : '/agency/calls';
}

/**
 * Where `/agency/softphone` lands: All calls with the Soft phone chip on, and whatever query the
 * old link carried kept (its own `type`, if any, replaced).
 */
export function softphoneCallsRedirectPath(search: string): string {
  const params = new URLSearchParams(search);
  params.set(CALL_LOG_TYPE_PARAM, 'soft_phone');
  return `/agency/calls?${params.toString()}`;
}

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
export const CALL_LOG_STATUS_HINT = 'Soft-phone calls only. A dialler or inbound call has no status.';

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

/**
 * All calls on the calls of the last `days` days that are filed under no campaign: where
 * Settings › Calls' "N calls were not filed under a campaign" leads (the same window, the same
 * rows).
 */
export function unfiledCallsPath(days: number, now: Date = new Date()): string {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - days, 12);
  const params = callLogParams(attemptDateRange(localDay(start), localDay(now)), { type: 'all', allDates: false, status: null });
  params.set(ALL_CALLS_CAMPAIGN_PARAM, AGENCY_CALLS_NO_CAMPAIGN);
  return `/agency/calls?${params.toString()}`;
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
  /** Owed work, not a type: To follow up. */
  warning?: boolean;
}

/** Whether a type has calls to show or could have: the rule one chip is shown by. */
export interface CallLogTypeAvailability {
  /** The soft phone is on for the account (`agency_softphone_enabled`). */
  softphoneEnabled: boolean;
  /** Inbound calls are on for the account (`agency_inbound_enabled`). */
  inboundEnabled: boolean;
}

/** The To follow up chip's words. */
export const TO_FOLLOW_UP_LABEL = 'To follow up';
/** Said under the date fields while To follow up is on: why they are switched off. */
export const TO_FOLLOW_UP_DATES_HINT = 'To follow up shows every open missed call, whatever the dates.';
/** Said under the chips while To follow up is on: the one chip the dates do not narrow. */
export const TO_FOLLOW_UP_NOTE =
  'Every missed call on this campaign that is still open, whatever the dates. Call the customer back, or mark the call handled. '
  + 'The Agent filter here is who a call is assigned to.';
/** The same, on the account's All calls. */
export const ALL_CALLS_TO_FOLLOW_UP_NOTE =
  'Every missed call in this account that is still open, whatever the dates. Call the customer back, or mark the call handled. '
  + 'The Agent filter here is who a call is assigned to.';

/**
 * The chips to show: "All · Dialler · Soft phone · Inbound · To follow up", each with its count.
 *
 * A type that is switched off AND has no call under the chosen filters gets no chip (SR5's
 * rule): the soft phone's flag off and no soft-phone call in the range, inbound's flag off and
 * no inbound call. The chip that is on is always shown, so a link to it can be left. With one
 * type left there is nothing to choose, so no type chips.
 *
 * **To follow up** is the campaign's open Missed rows: a to-do, shown only while there is one
 * (hidden at 0), and `warning` so it reads as owed work rather than as a fourth type.
 */
export function visibleCallLogChips(
  counts: AgencyCallLogCounts | null,
  selected: AgencyCallLogTypeFilter,
  availability: CallLogTypeAvailability,
): CallLogChip[] {
  const shown: Record<AgencyCallLogType, boolean> = {
    dialler: true,
    soft_phone: availability.softphoneEnabled || (counts?.soft_phone ?? 0) > 0 || selected === 'soft_phone',
    inbound: availability.inboundEnabled || (counts?.inbound ?? 0) > 0 || selected === 'inbound',
  };
  const types = (Object.keys(AGENCY_CALL_LOG_TYPE_LABELS) as AgencyCallLogType[]).filter((type) => shown[type]);
  const followUp: CallLogChip[] = (counts?.to_follow_up ?? 0) > 0 || selected === 'to_follow_up'
    ? [{ id: 'to_follow_up', label: TO_FOLLOW_UP_LABEL, count: counts?.to_follow_up ?? null, warning: true }]
    : [];
  if (types.length < 2 && followUp.length === 0) return [];
  return [
    { id: 'all', label: 'All', count: counts?.all ?? null },
    ...(types.length < 2 ? [] : types.map((type) => ({ id: type, label: AGENCY_CALL_LOG_TYPE_LABELS[type], count: counts?.[type] ?? null }))),
    ...followUp,
  ];
}

// ─── What happened: the inbound choices ─────────────────────────────────────

/**
 * The What happened filter's inbound choices (Missed, Voicemail, Abandoned), after the attempt
 * list's. Things only a caller does to us: with one chosen, no dialler or soft-phone call
 * matches it.
 */
export const CALL_LOG_INBOUND_OUTCOME_OPTIONS: ReadonlyArray<{ value: AgencyCallLogInboundOutcomeFilter; label: string }> =
  AGENCY_CALL_LOG_INBOUND_OUTCOME_FILTERS.map((value) => ({ value, label: AGENCY_CALL_LOG_INBOUND_OUTCOME_FILTER_LABELS[value] }));

/** Said under the What happened filter while its inbound choices are offered. */
export const CALL_LOG_INBOUND_OUTCOME_HINT = 'Missed, Voicemail and Abandoned (hung up while waiting) are inbound calls only.';

/** A What happened value in words: an inbound choice's, else the attempt outcome's. */
export function callLogOutcomeFilterLabel(value: string): string {
  return (AGENCY_CALL_LOG_INBOUND_OUTCOME_FILTER_LABELS as Record<string, string>)[value] ?? attemptOutcomeLabel(value);
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
  inbound: 'inbound calls',
  to_follow_up: 'missed calls to follow up',
};

/**
 * What an empty list says, and what it offers. `filters` are the ones the list was read with.
 * `scope` is the account's All calls (the default is a campaign's Call log): its words say
 * "in this account", and a campaign chosen there is a filter like any other.
 */
export function callLogEmptyState(
  filters: AgencyAttemptFilters,
  view: Pick<CallLogView, 'type' | 'status'>,
  scope: { where: 'account'; campaignChosen: boolean } | { where: 'campaign' } = { where: 'campaign' },
): { kind: CallLogEmptyKind; title: string; description: string } {
  const { type } = view;
  const account = scope.where === 'account';
  const here = account ? 'in this account' : 'on this campaign';
  const campaignChosen = scope.where === 'account' && scope.campaignChosen;
  // To follow up is not narrowed by the dates: an empty one is never about them.
  if (type === 'to_follow_up') {
    const { from: _from, to: _to, ...rest } = filters;
    void _from; void _to;
    return isCallLogFiltered(rest, view) || campaignChosen
      ? {
        kind: 'filtered',
        title: 'Nothing matches those filters',
        description: 'Clear the filters to see every missed call that is still open.',
      }
      : {
        kind: 'none',
        title: `Nobody is waiting for a call back ${here}.`,
        description: 'A missed call stays here until the customer is reached or someone marks it handled.',
      };
  }
  if (onlyDatesNarrow(filters, view) && !campaignChosen) {
    return {
      kind: 'dates',
      title: `No ${EMPTY_TYPE_WORDS[type]} ${here} for these dates.`,
      description: 'Widen the dates to see earlier calls.',
    };
  }
  if (isCallLogFiltered(filters, view) || campaignChosen) {
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
      description: account
        ? 'Nobody in this account has made or taken a call yet. Calls appear here as they are placed, '
          + 'including the ones that never reach an agent.'
        : 'This campaign has not dialled anyone yet. Calls appear here as they are placed, '
          + 'including the ones that never reach an agent.',
    }
    : {
      kind: 'none',
      title: `No ${EMPTY_TYPE_WORDS[type]} ${here}`,
      description: `Choose All to see every call ${here}.`,
    };
}

// ─── How a row reads ────────────────────────────────────────────────────────

/** The type in words: the Type column. */
export function callLogTypeLabel(type: AgencyCallLogType): string {
  return AGENCY_CALL_LOG_TYPE_LABELS[type];
}

/** `m:ss` for a wait or a voicemail (the talk-time format). */
const duration = (seconds: number) => formatTalkTime(seconds);

/** "3:12 PM": the hour without a leading zero (said through `upperDayPeriod`). */
const CLOCK: Intl.DateTimeFormatOptions = { hour: 'numeric', minute: '2-digit' };

/** Whether two instants fall on one calendar day for the reader. */
function sameLocalDay(a: string, b: string): boolean {
  const [x, y] = [new Date(a), new Date(b)];
  return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate();
}

/**
 * When the other half of a pair happened, as said on this row: the clock time ("3:12 PM") when
 * both are on one day, else the day too ("21 Nov 2026, 03:12 PM").
 */
export function pairedTime(other: string, own: string): string {
  return sameLocalDay(other, own) ? upperDayPeriod(dateFormatter(CLOCK).format(new Date(other))) : formatCallTimestamp(other);
}

/**
 * A soft-phone call placed from a Missed row's Call back says so (CL1): it is still a
 * soft-phone call, marked "Call back" and tied to the missed call it answered.
 */
export function callBackFact(row: AgencyCallLogRow): string | null {
  if (row.type !== 'soft_phone' || !row.callback_of) return null;
  return row.callback_of.arrived_at
    ? `Call back · to the ${pairedTime(row.callback_of.arrived_at, row.created_at)} missed call`
    : 'Call back · to a missed call';
}

/**
 * A row's own facts, under its type: what only that type has. Dialler: which try it was, and
 * that it was a wrap-up redial. Soft phone: that it was a call back to a missed call (its
 * overrides are badges). Inbound: the customer rang us.
 */
export function callLogTypeFacts(row: AgencyCallLogRow): string[] {
  if (row.type === 'inbound') return ['rang us'];
  if (row.type === 'soft_phone') {
    const callBack = callBackFact(row);
    return callBack ? [callBack] : [];
  }
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
 * one that did not dial says why in its own outcome. Nor is an inbound call: it was not a dial.
 */
export function isNotDialled(row: AgencyCallLogRow): boolean {
  return row.type === 'soft_phone' && row.dialed_at === null && row.state === 'ended';
}

/** A dial stopped while it rang because the customer rang us (`docs/inbound.md` §5.4). */
export function stoppedByInbound(row: AgencyCallLogRow): boolean {
  return row.type === 'dialler' && row.disposition_code === AGENCY_INBOUND_TOOK_OVER_DISPOSITION_CODE;
}

/** Whether an inbound call reached nobody (it has a Missed row, or was not answered by an agent). */
export function isMissedInbound(row: AgencyCallLogRow): boolean {
  return row.type === 'inbound' && (row.follow_up !== null || row.outcome !== 'answered');
}

/**
 * The What happened cell: what the line did. `key` styles it (`data-outcome`); `detail` is the
 * second line, where the type has more to say. An inbound call is Answered or Missed: answered,
 * with how long the caller waited and whether they came through their own agent; missed, with
 * why in the Missed list's words and how long they waited when they were queued.
 */
export function callLogWhatHappened(row: AgencyCallLogRow): { text: string; key: string; detail?: string } {
  if (row.type === 'inbound') {
    if (!isMissedInbound(row)) {
      const detail = [`waited ${duration(row.wait_seconds)}`, ...(row.via_sticky_agent ? ['came through their agent'] : [])];
      return { text: 'Answered', key: 'connected', detail: detail.join(' · ') };
    }
    return { text: 'Missed', key: 'missed', detail: missedDetail(row) };
  }
  if (isNotDialled(row)) return { text: 'Not dialled', key: 'not_dialled' };
  if (row.type === 'soft_phone' && row.state !== 'ended') return { text: 'On a call now', key: 'live' };
  if (stoppedByInbound(row)) return { text: 'Stopped: customer rang us', key: row.outcome ?? 'canceled' };
  return { text: attemptOutcomeLabel(row.outcome), key: row.outcome ?? 'unknown' };
}

/** Why an inbound call was missed, lower case to sit under "Missed", and the wait when the caller queued. */
function missedDetail(row: AgencyCallLogInboundRow): string {
  const label = row.follow_up ? missedReasonLabel(row.follow_up) : null;
  const reason = label ? label.charAt(0).toLowerCase() + label.slice(1) : null;
  // "hung up while waiting · 0:52" already says it was a wait.
  const wait = !row.queued ? null : row.follow_up?.reason === 'abandoned_in_queue' ? duration(row.wait_seconds) : `waited ${duration(row.wait_seconds)}`;
  return [reason, wait].filter(Boolean).join(' · ');
}

/** What the Outcome cell says when no outcome is saved: a call that still owes one says so. */
export function callLogOutcomePlaceholder(row: AgencyCallLogRow): string {
  return row.type !== 'dialler' && row.requires_disposition ? 'No outcome yet' : '—';
}

/**
 * A missed inbound call's Outcome cell: whether it was rung back and when, and where its
 * Missed row stands. Open rows are owed work ("To follow up"); a handled one says how it was
 * closed, unless the call back already says so.
 */
export function followUpCopy(row: AgencyCallLogInboundRow): { calledBack: string | null; status: string | null; open: boolean } {
  const calledBack = row.called_back ? `Called back ${pairedTime(row.called_back.at, row.created_at)}` : null;
  const followUp: AgencyCallLogFollowUp | null = row.follow_up;
  if (!followUp) return { calledBack, status: null, open: false };
  if (followUp.status === 'open') return { calledBack, status: TO_FOLLOW_UP_LABEL, open: true };
  return { calledBack, status: calledBack ? null : followUp.handled_reason === 'reached' ? 'Customer reached' : 'Handled', open: false };
}

/** The Agent cell of a soft-phone row: who placed it. */
export function softphoneAgentCopy(row: { agent_name: string | null }): { text: string; muted: boolean } {
  return row.agent_name ? { text: row.agent_name, muted: false } : { text: 'Former member', muted: true };
}

/**
 * The Agent cell of an inbound row: who answered; for a call nobody answered, a dash, with who
 * the Missed row is assigned to under it ("assigned to Arjun Mehta").
 */
export function inboundAgentCopy(row: AgencyCallLogInboundRow): { text: string; muted: boolean; detail?: string } {
  if (row.agent_user_id) return softphoneAgentCopy(row);
  const followUp = row.follow_up;
  if (!followUp?.assignee_user_id) return { text: '—', muted: true };
  return { text: '—', muted: true, detail: `assigned to ${followUp.assignee_name ?? 'a former member'}` };
}

/** The inbound Call page of a campaign's call. */
export function inboundCallPath(campaignId: string, callId: string): string {
  return `/agency/campaigns/${campaignId}/calls/inbound/${callId}`;
}

/**
 * Where a row opens: the Call page of its own type. Null when that page cannot be opened:
 * the soft-phone call detail is behind the soft phone's flag.
 */
export function callLogRowPath(
  row: Pick<AgencyCallLogRow, 'type' | 'id'>,
  campaignId: string,
  availability: Pick<CallLogTypeAvailability, 'softphoneEnabled'>,
): string | null {
  if (row.type === 'dialler') return `/agency/campaigns/${campaignId}/attempts/${row.id}`;
  if (row.type === 'inbound') return inboundCallPath(campaignId, row.id);
  return availability.softphoneEnabled ? `/agency/softphone/calls/${row.id}` : null;
}

/**
 * The other row of a missed call and its call back, as a row key (`type:id`), so hovering one
 * can light the other. Null for a row that is half of no pair.
 */
export function pairedRowKey(row: AgencyCallLogRow): string | null {
  if (row.type === 'soft_phone' && row.callback_of) return `inbound:${row.callback_of.inbound_call_id}`;
  if (row.type === 'inbound' && row.called_back) return `soft_phone:${row.called_back.call_id}`;
  return null;
}

/** A row's own key in the table. */
export function callLogRowKey(row: Pick<AgencyCallLogRow, 'type' | 'id'>): string {
  return `${row.type}:${row.id}`;
}
