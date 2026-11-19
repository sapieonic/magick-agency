import type {
  AgencyAccountCallback,
  AgencyCallbackSource,
  AgencyCallbacksDue,
} from '@magick-agency/contracts/api/agency/callbacks';
import { formatDate, formatTime } from '@magick-agency/web-ui/format';
import { errorStatus } from '../agencyErrors';
import { CALLBACKS_ERROR, CALLBACKS_REFUSED } from './liveFloor';

/**
 * The account's Callbacks page (LF1, LF22, LF32): the words and rules over `GET /callbacks`. Pure,
 * so each is tested where it is made. A row names the customer, never the number (the read carries
 * none).
 */

/** The page's `?due=` (the tab) and `?campaign=` (the filter). */
export const CALLBACKS_DUE_PARAM = 'due';
export const CALLBACKS_CAMPAIGN_PARAM = 'campaign';

/** The tab a `?due=` names: `today` only when it says so, otherwise overdue (the read's default). */
export function callbacksDueOf(value: string | null): AgencyCallbacksDue {
  return value === 'today' ? 'today' : 'overdue';
}

/** The tabs, in order. */
export const CALLBACKS_TABS: ReadonlyArray<{ id: AgencyCallbacksDue; label: string }> = [
  { id: 'overdue', label: 'Overdue' },
  { id: 'today', label: 'Due later today' },
];

/** Where a callback came from, in words. */
export const CALLBACK_SOURCE_LABELS: Record<AgencyCallbackSource, string> = {
  outcome: 'Booked on a call',
  inbound: 'Missed inbound call',
};

/** The customer as the row names them: the roster's name, or that it has none. Never the number. */
export function callbackCustomer(row: Pick<AgencyAccountCallback, 'customer_name'>): string {
  return row.customer_name?.trim() || 'No name on file';
}

/** Who has the callback: the owner's name, or the shared queue (pool). */
export function callbackOwner(row: Pick<AgencyAccountCallback, 'owner'>): { name: string; live: boolean | null } {
  if (!row.owner) return { name: 'Shared queue', live: null };
  return { name: row.owner.name?.trim() || 'Former member', live: row.owner.live };
}

/**
 * When it is due, in the reader's own zone (the zone their other times are in; the campaign's own
 * zone decides which day "today" is on the server, LF22): the time alone when it falls on the
 * reader's today, else the date and time.
 */
export function callbackDueText(dueAt: string, now: Date): string {
  return new Date(dueAt).toDateString() === now.toDateString() ? formatTime(dueAt) : formatDate(dueAt);
}

/** The link to the contact in its campaign (the roster's contact page). */
export function callbackContactHref(row: Pick<AgencyAccountCallback, 'campaign_id' | 'contact_id'>): string {
  return `/agency/campaigns/${encodeURIComponent(row.campaign_id)}/contacts/${encodeURIComponent(row.contact_id)}`;
}

/** The list when it holds nothing: what was asked for, never a wider all-clear. */
export function callbacksEmptyText(due: AgencyCallbacksDue, campaignName: string | null): string {
  const where = campaignName ? ` on ${campaignName}` : '';
  return due === 'overdue'
    ? `No callback is overdue${where} right now.`
    : `No more callbacks are due today${where}.`;
}

/** The read failed: refused (403) or anything else, in the page's own words. */
export function callbacksErrorText(err: unknown): string {
  return errorStatus(err) === 403 ? CALLBACKS_REFUSED : CALLBACKS_ERROR;
}
