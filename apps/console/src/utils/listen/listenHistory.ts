import { hasPermission } from '../permissions';
import { exclusiveDateRange } from '../agencyAttemptFilters';
import { agentName, liveCallPagePath } from './liveCallsTable';
import { LISTENED_TO_BY_COPY, LIVE_CALLS_COPY, ORIGIN_LABELS, campaignCellLabel, customerLabel } from './listenCopy';
import {
  AGENCY_LISTEN_END_REASON_LABELS,
  type AgencyListenHistoryEntry,
  type AgencyListenHistoryQuery,
} from '../../types/listen-history';
import type { TenantMember } from '../../types/team';

/**
 * The account's Listening history page's rules, pure (`docs/listening.md` §12, LS19): the filters
 * as the route's query (the CSV takes the same), each column's words, the link to the call, and
 * the supervisor and agent choices.
 */

/** The filters as the form holds them: user ids, '' for all; dates as `YYYY-MM-DD`, '' for open. */
export interface ListenHistoryDraft {
  supervisor: string;
  agent: string;
  from: string;
  to: string;
}

export const EMPTY_LISTEN_HISTORY_DRAFT: ListenHistoryDraft = { supervisor: '', agent: '', from: '', to: '' };

/**
 * The query for `GET /listen-history` (and `.csv`): the dates as the reader's local day, `from`
 * its first instant and `to` the first instant of the day after the last (the route's `to` is
 * exclusive), so "to 16 November" keeps the whole of the 16th.
 */
export function listenHistoryQuery(draft: ListenHistoryDraft): AgencyListenHistoryQuery {
  const query: AgencyListenHistoryQuery = {};
  if (draft.supervisor) query.listener_user_id = draft.supervisor;
  if (draft.agent) query.agent_user_id = draft.agent;
  const range = exclusiveDateRange(draft.from, draft.to);
  if (range.from) query.from = range.from;
  if (range.to) query.to = range.to;
  return query;
}

/** Filter groups applied, for the filter card's badge: supervisor, agent, the date range. */
export function listenHistoryFilterCount(draft: ListenHistoryDraft): number {
  return (draft.supervisor ? 1 : 0) + (draft.agent ? 1 : 0) + (draft.from || draft.to ? 1 : 0);
}

/** "From" after "To": nothing could match, so the form says so rather than asking. */
export function listenHistoryRangeReversed(draft: ListenHistoryDraft): boolean {
  return Boolean(draft.from && draft.to && draft.from > draft.to);
}

/** "Dialler", "Soft phone", or "Inbound: <route>" (the live table's Campaign cell for an inbound call). */
export function listenHistoryCallType(entry: Pick<AgencyListenHistoryEntry, 'origin' | 'inbound_route_name'>): string {
  if (entry.origin === 'inbound') return campaignCellLabel({ origin: 'inbound', campaign_name: null, inbound_route_name: entry.inbound_route_name });
  return ORIGIN_LABELS[entry.origin];
}

/**
 * The call's row is gone (purged on its own horizon): the entry has neither a masked number nor
 * a withheld caller, and there is no call page to open ("Call no longer available").
 */
export function callRowGone(entry: Pick<AgencyListenHistoryEntry, 'customer_phone_masked' | 'customer_phone_withheld'>): boolean {
  return entry.customer_phone_masked === null && !entry.customer_phone_withheld;
}

/** The customer's name (as the live table words it) and number: masked, "Withheld", or none. */
export function listenHistoryCustomer(entry: AgencyListenHistoryEntry): { name: string; number: string | null } {
  return {
    name: customerLabel(entry),
    number: entry.customer_phone_withheld ? LIVE_CALLS_COPY.withheld : entry.customer_phone_masked,
  };
}

/** How the visit ended, in the contract's words (the CSV's `how_it_ended`). */
export function listenHistoryHowEnded(entry: Pick<AgencyListenHistoryEntry, 'end_reason'>): string {
  return entry.end_reason ? AGENCY_LISTEN_END_REASON_LABELS[entry.end_reason] : LISTENED_TO_BY_COPY.listeningNow;
}

/** The supervisor's name; one the read could not name is "A supervisor". */
export function listenHistorySupervisor(entry: Pick<AgencyListenHistoryEntry, 'listener_name'>): string {
  return entry.listener_name?.trim() || LISTENED_TO_BY_COPY.aSupervisor;
}

/**
 * The call's own page, as the Live calls table opens it (`liveCallPagePath`): the attempt or the
 * soft-phone call; none for an inbound call (no call page in the console), for a soft-phone call
 * while the soft phone is turned off (`softphoneEnabled`: its page would only say it is
 * unavailable, as the campaign History's listen rows rule), or once the call's row is gone.
 */
export function listenHistoryCallPath(entry: AgencyListenHistoryEntry, softphoneEnabled: boolean): string | null {
  if (callRowGone(entry)) return null;
  return liveCallPagePath(entry, softphoneEnabled);
}

export interface ListenHistoryOption {
  id: string;
  name: string;
}

/**
 * The supervisor and agent choices: the team's members in this account (a tenant-wide seat, or a
 * seat in `accountId`; supervisors are those who may listen, `agency.calls.listen`; agents
 * anyone), the people in the rows read so far (a former member included), and the one chosen, so
 * a filter in force always reads as itself. By name. A seat in another account is not offered: no
 * listen of theirs is in this account's history.
 */
export function listenHistoryFilterOptions(
  members: readonly TenantMember[],
  entries: readonly AgencyListenHistoryEntry[],
  keep: { supervisor?: ListenHistoryOption | null; agent?: ListenHistoryOption | null },
  accountId: string | null,
): { supervisors: ListenHistoryOption[]; agents: ListenHistoryOption[] } {
  const supervisors = new Map<string, string>();
  const agents = new Map<string, string>();
  for (const m of members) {
    if (m.membership.account_id !== null && accountId !== null && m.membership.account_id !== accountId) continue;
    const name = m.user.display_name?.trim() || m.user.email;
    agents.set(m.user.id, name);
    if (hasPermission(m.membership.role, 'agency.calls.listen')) supervisors.set(m.user.id, name);
  }
  for (const e of entries) {
    if (!supervisors.has(e.listener_user_id)) supervisors.set(e.listener_user_id, listenHistorySupervisor(e));
    if (!agents.has(e.agent_user_id)) agents.set(e.agent_user_id, agentName(e));
  }
  if (keep.supervisor && !supervisors.has(keep.supervisor.id)) supervisors.set(keep.supervisor.id, keep.supervisor.name);
  if (keep.agent && !agents.has(keep.agent.id)) agents.set(keep.agent.id, keep.agent.name);
  const byName = (a: ListenHistoryOption, b: ListenHistoryOption) => a.name.localeCompare(b.name, 'en-GB', { sensitivity: 'base' });
  return {
    supervisors: [...supervisors].map(([id, name]) => ({ id, name })).sort(byName),
    agents: [...agents].map(([id, name]) => ({ id, name })).sort(byName),
  };
}
