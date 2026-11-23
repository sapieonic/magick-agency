import {
  AGENCY_CALLS_TYPE_FILTER_LABELS,
  AGENCY_CALL_LOG_TYPE_LABELS,
  AGENCY_MY_CALLS_NOTHING_TO_FOLLOW_UP,
  AGENCY_MY_CALLS_TYPE_FILTERS,
  AGENCY_SYSTEM_OUTCOME_LABELS,
  agencyCallbackDueLabel,
  type AgencyCallLogTypeFilter,
  type AgencyMyCallbackDue,
  type AgencyMyCallRow,
  type AgencyMyCallsCounts,
} from '../../types/agency-call-log';
import { AGENCY_INBOUND_TOOK_OVER_DISPOSITION_CODE } from '../../types/inbound';
import { formatDayMonth } from '../format/date';
import { formatTalkTime } from '../agencySpineCopy';
import { formatDialNumber } from '../softphone/phoneInput';
import {
  calledBackTo,
  callLogTypeFromParams,
  followUpWords,
  isMissedInbound,
  missedDetail,
  outboundWhatHappened,
  pairedTime,
} from './callLog';
import { clockTime } from './stationFormat';

/**
 * The agent's own My calls (`docs/call-log.md` §7, CL9): one list of their calls of every type,
 * with To follow up first. Pure: no React, no fetch. The words are the campaign Call log's
 * (`callLog.ts`), on the agent's own row (`AgencyMyCallRow`).
 */

export const MY_CALLS_SUBTITLE =
  'Every call you made or took, newest first: dialled for you, made from the soft phone and answered when customers rang. '
  + 'To follow up is who you still owe a call.';

/** `?type=`: the chip that is on. */
export const MY_CALLS_TYPE_PARAM = 'type';

/**
 * The chip the URL asks for. `?view=softphone` is the Soft-phone calls tab's old URL (My calls
 * had two tabs until CL9): it opens the Soft phone chip. Absent, or anything else, is All.
 */
export function myCallsTypeFromParams(params: URLSearchParams): AgencyCallLogTypeFilter {
  return callLogTypeFromParams(params) ?? (params.get('view') === 'softphone' ? 'soft_phone' : 'all');
}

/** The URL for a chip: `type` set (All is no `type`), the old `view` dropped, everything else kept. */
export function myCallsParamsForType(params: URLSearchParams, type: AgencyCallLogTypeFilter): URLSearchParams {
  const next = new URLSearchParams(params);
  next.delete('view');
  if (type === 'all') next.delete(MY_CALLS_TYPE_PARAM);
  else next.set(MY_CALLS_TYPE_PARAM, type);
  return next;
}

/** What My calls is narrowed by, beside the chip: a campaign (an id, or `none`) and the dates. All in the URL. */
export interface MyCallsFilters {
  campaign: string | null;
  from: string | null;
  to: string | null;
}

export function myCallsFiltersFromParams(params: URLSearchParams): MyCallsFilters {
  const instant = (key: string) => {
    const raw = params.get(key);
    return raw && Number.isFinite(Date.parse(raw)) ? raw : null;
  };
  return { campaign: params.get('campaign_id') || null, from: instant('from'), to: instant('to') };
}

/** The URL with these filters, the chip kept. */
export function myCallsParamsForFilters(params: URLSearchParams, filters: MyCallsFilters): URLSearchParams {
  const next = new URLSearchParams(params);
  const put = (key: string, value: string | null) => (value ? next.set(key, value) : next.delete(key));
  put('campaign_id', filters.campaign);
  put('from', filters.from);
  put('to', filters.to);
  return next;
}

export function myCallsFiltered(filters: MyCallsFilters): boolean {
  return filters.campaign !== null || filters.from !== null || filters.to !== null;
}

/** Said under the date fields while To follow up is on: it is not narrowed by them (CL14). */
export const MY_CALLS_DATES_OFF_HINT = 'To follow up shows everyone you still owe a call, whatever the dates.';

/** Where the To follow up chip lives: what the Missed calls entry and old links can point at. */
export const MY_CALLS_TO_FOLLOW_UP_PATH = `/dialer/attempts?${MY_CALLS_TYPE_PARAM}=to_follow_up`;

export interface MyCallsChip {
  id: AgencyCallLogTypeFilter;
  label: string;
  /** To follow up's badge: what the agent still owes. Null on the other chips, and before the server has said. */
  count: number | null;
  warning: boolean;
}

/**
 * The chips, To follow up first (the proposal's order). The Soft phone and Inbound chips are
 * offered while the agent may use them or while that chip is on, so an old link still shows
 * what it asked for.
 */
export function myCallsChips(
  counts: AgencyMyCallsCounts | null,
  selected: AgencyCallLogTypeFilter,
  availability: { softphone: boolean; inbound: boolean },
): MyCallsChip[] {
  const shown: Record<AgencyCallLogTypeFilter, boolean> = {
    to_follow_up: availability.inbound || (counts?.to_follow_up ?? 0) > 0 || selected === 'to_follow_up',
    all: true,
    dialler: true,
    soft_phone: availability.softphone || selected === 'soft_phone',
    inbound: availability.inbound || selected === 'inbound',
  };
  return AGENCY_MY_CALLS_TYPE_FILTERS.filter((id) => shown[id]).map((id) => ({
    id,
    label: AGENCY_CALLS_TYPE_FILTER_LABELS[id],
    count: id === 'to_follow_up' ? counts?.to_follow_up ?? null : null,
    warning: id === 'to_follow_up',
  }));
}

/** The type and what only that type has, on one line: "Dialler · Try 2", "Soft phone · Call back", "Inbound · missed". */
export function myCallTypeLine(row: AgencyMyCallRow): string {
  const label = AGENCY_CALL_LOG_TYPE_LABELS[row.type];
  if (row.type === 'dialler') {
    const facts = [...(row.attempt_number !== null ? [`Try ${row.attempt_number}`] : []), ...(row.redial ? ['redial'] : [])];
    return [label, ...facts].join(' · ');
  }
  if (row.type === 'soft_phone') return row.callback_of ? `${label} · Call back` : label;
  return isMissedInbound(row) ? `${label} · missed` : label;
}

/** Under a call back: which missed call it answered ("to the 3:12 PM missed call"). */
export function myCallBackOf(row: AgencyMyCallRow): string | null {
  return calledBackTo(row);
}

/**
 * Who the call was with: the customer's name when the roster has one, and the number as this
 * agent may see it (already masked by the server where the campaign hides numbers; a number in
 * full is grouped for reading).
 */
export function myCallCustomer(row: Pick<AgencyMyCallRow, 'customer_name' | 'phone' | 'phone_masked'>): { name: string | null; number: string } {
  const number = row.phone === null ? 'Number withheld' : row.phone_masked ? row.phone : formatDialNumber(row.phone);
  return { name: row.customer_name, number };
}

/** What happened on the line, and a second line where the type has more to say. */
export function myCallWhatHappened(row: AgencyMyCallRow): { text: string; key: string; detail?: string } {
  if (row.type === 'inbound') {
    if (!isMissedInbound(row)) {
      return { text: 'Answered', key: 'connected', ...(row.wait_seconds !== null ? { detail: `waited ${formatTalkTime(row.wait_seconds)}` } : {}) };
    }
    const detail = missedDetail(row);
    return { text: 'Missed', key: 'missed', ...(detail ? { detail } : {}) };
  }
  return outboundWhatHappened(row);
}

/** "25 Nov": a promised or booked day. */
function shortDay(value: string): string {
  // A `YYYY-MM-DD` is a calendar day, not an instant: read at noon so no zone moves it.
  const date = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T12:00:00`) : new Date(value);
  return Number.isNaN(date.getTime()) ? value : formatDayMonth(date);
}

/**
 * The saved outcome in words, with its day when it has one ("Will pay · 25 Nov", "Call later ·
 * 23 Nov"). The campaign's own words when the server sent them, else the code. Null: none saved.
 */
export function myCallOutcome(row: AgencyMyCallRow): string | null {
  const code = row.disposition_code ?? row.auto_disposition_code;
  if (!code) return null;
  if (code === AGENCY_INBOUND_TOOK_OVER_DISPOSITION_CODE) return null;
  const label = AGENCY_SYSTEM_OUTCOME_LABELS[code] ?? (row.disposition_code ? row.disposition_label : null) ?? code;
  const day = row.promise_date ?? row.callback_at;
  const automatic = !row.disposition_code && row.auto_disposition_code ? ' (automatic)' : '';
  return `${label}${automatic}${day ? ` · ${shortDay(day)}` : ''}`;
}

/** A missed call's Outcome cell: rung back, still owed, or closed (the Call log's words). */
export function myCallFollowUp(row: AgencyMyCallRow): { calledBack: string | null; status: string | null; open: boolean } | null {
  if (!isMissedInbound(row)) return null;
  return followUpWords({ calledBackAt: row.called_back?.at ?? null, arrivedAt: row.created_at, followUp: row.follow_up });
}

/** What the Outcome cell says with no outcome saved. */
export function myCallOutcomePlaceholder(row: AgencyMyCallRow): string {
  return row.requires_disposition ? 'No outcome yet' : '—';
}

/** A callback's lines: "Due 4:00 PM" or "Late by 2 hours", and "you booked it for 1:45 PM". */
export function callbackDueCopy(callback: AgencyMyCallbackDue, now: Date = new Date()): { due: string; late: boolean; booked: string } {
  return {
    due: agencyCallbackDueLabel(callback.due_at, now, clockTime(Date.parse(callback.due_at))),
    late: Date.parse(callback.due_at) < now.getTime(),
    booked: `you booked it for ${pairedTime(callback.due_at, now)}`,
  };
}

/** The empty list's words for a chip; with a filter on, that nothing matches it. */
export function myCallsEmpty(type: AgencyCallLogTypeFilter, filtered = false): { title: string; description: string } {
  // To follow up takes the Campaign filter alone (CL14: whatever the dates), on its missed calls and its callbacks both.
  if (filtered && type === 'to_follow_up') {
    return { title: 'Nobody matches that campaign', description: 'Clear the campaign filter to see everyone you still owe a call.' };
  }
  if (filtered) {
    return { title: 'Nothing matches those filters', description: 'Widen the dates or clear the filters to see every call.' };
  }
  switch (type) {
    case 'to_follow_up':
      return {
        title: AGENCY_MY_CALLS_NOTHING_TO_FOLLOW_UP,
        description: 'A missed call that is yours to ring back, and a callback you booked that is due today or late, show here.',
      };
    case 'dialler':
      return { title: 'No dialler calls yet', description: 'Calls the dialler places for you show here.' };
    case 'soft_phone':
      return { title: 'No soft-phone calls yet', description: 'Calls you make from the soft phone show here.' };
    case 'inbound':
      return { title: 'No inbound calls yet', description: 'Calls from customers that you answered, and the missed calls that are yours to ring back, show here.' };
    default:
      return { title: 'No calls yet', description: 'Every call you make or take shows here, newest first.' };
  }
}
