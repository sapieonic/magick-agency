import { CALL_OVERRUN_AHT_MULTIPLE, agentDisplayName } from '../agencyAgentFloor';
import { LIVE_CALLS_COPY, campaignCellLabel, customerLabel, maskedNumberLabel } from './listenCopy';
import type { AgencyCallOrigin, AgencyLiveCall } from '../../types/live-calls';
import type { ListenTarget } from './listenSessionReducer';

/**
 * The live calls table's rules, pure (`docs/listening.md` §9): filters, sorting, the rows that
 * just ended, the overrun, and what a listen is started with.
 */

/** The type chips: All, Dialler, Soft phone, Inbound. */
export type LiveCallTypeFilter = 'all' | AgencyCallOrigin;

export const LIVE_CALL_TYPE_FILTERS: readonly { id: LiveCallTypeFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'campaign', label: 'Dialler' },
  { id: 'manual', label: 'Soft phone' },
  { id: 'inbound', label: 'Inbound' },
];

export interface LiveCallFilters {
  type: LiveCallTypeFilter;
  /** An agent's user id, or '' for all. */
  agent: string;
  /** A campaign id, or '' for all (the account page only). */
  campaign: string;
}

export const NO_LIVE_CALL_FILTERS: LiveCallFilters = { type: 'all', agent: '', campaign: '' };

/** Whether any filter is in force: "Clear filters" is offered. */
export function hasLiveCallFilters(filters: LiveCallFilters): boolean {
  return filters.type !== 'all' || filters.agent !== '' || filters.campaign !== '';
}

export function filterLiveCalls<T extends { call: AgencyLiveCall }>(rows: readonly T[], filters: LiveCallFilters): T[] {
  return rows.filter(({ call }) =>
    (filters.type === 'all' || call.origin === filters.type)
    && (filters.agent === '' || call.agent_user_id === filters.agent)
    && (filters.campaign === '' || call.campaign_id === filters.campaign));
}

/** Sortable columns: Agent and Time on call. The default is the longest on call first. */
export type LiveCallSortKey = 'agent' | 'time';
export interface LiveCallSort {
  key: LiveCallSortKey;
  dir: 'asc' | 'desc';
}
export const DEFAULT_LIVE_CALL_SORT: LiveCallSort = { key: 'time', dir: 'desc' };

/** The next sort when a header is pressed: its own column flips; another starts on its natural order. */
export function nextLiveCallSort(current: LiveCallSort, key: LiveCallSortKey): LiveCallSort {
  if (current.key === key) return { key, dir: current.dir === 'asc' ? 'desc' : 'asc' };
  return { key, dir: key === 'time' ? 'desc' : 'asc' };
}

function connectedMs(call: AgencyLiveCall): number {
  const at = Date.parse(call.connected_at);
  return Number.isFinite(at) ? at : Number.POSITIVE_INFINITY;
}

/**
 * Sorted copy. Time on call `desc` is the earliest connected first (longest on call); ties and
 * names fall back to the call id so a poll never reshuffles equal rows.
 */
export function sortLiveCalls<T extends { call: AgencyLiveCall }>(rows: readonly T[], sort: LiveCallSort): T[] {
  const sign = sort.dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    let diff: number;
    if (sort.key === 'agent') {
      diff = agentName(a.call).localeCompare(agentName(b.call), 'en-GB', { sensitivity: 'base' });
    } else {
      // Longer on call = earlier connected: `desc` puts the smaller timestamp first.
      diff = connectedMs(b.call) - connectedMs(a.call);
      if (!Number.isFinite(diff)) diff = 0;
    }
    if (diff !== 0) return diff * sign;
    return a.call.call_id.localeCompare(b.call.call_id);
  });
}

/** The agent's name, or the floor's id stand-in. */
export function agentName(call: Pick<AgencyLiveCall, 'agent_user_id' | 'agent_name'>): string {
  return agentDisplayName({ agent_user_id: call.agent_user_id, agent_name: call.agent_name });
}

/** How long an ended row stays, faded with "Call ended", before it goes. */
export const LIVE_CALL_ENDED_LINGER_MS = 3_000;

/** A row as shown: a call in the latest read, or one that just left it (`endedAt`, client ms). */
export interface ShownLiveCall {
  call: AgencyLiveCall;
  endedAt: number | null;
}

/**
 * The rows after a read: every call in it (live again if it had been marked ended), plus the
 * rows that were live before and are not in it, now ended; an ended row past
 * {@link LIVE_CALL_ENDED_LINGER_MS} is gone.
 */
export function mergeLiveCalls(prev: readonly ShownLiveCall[], calls: readonly AgencyLiveCall[], now: number): ShownLiveCall[] {
  const ids = new Set(calls.map((c) => c.call_id));
  const live: ShownLiveCall[] = calls.map((call) => ({ call, endedAt: null }));
  const ended = prev
    .filter((row) => !ids.has(row.call.call_id))
    .map((row) => ({ call: row.call, endedAt: row.endedAt ?? now }))
    .filter((row) => now - row.endedAt < LIVE_CALL_ENDED_LINGER_MS);
  return [...live, ...ended];
}

/** The ended rows past their linger, dropped (run on a timer between reads). */
export function pruneEndedLiveCalls(rows: readonly ShownLiveCall[], now: number): ShownLiveCall[] {
  const kept = rows.filter((row) => row.endedAt === null || now - row.endedAt < LIVE_CALL_ENDED_LINGER_MS);
  return kept.length === rows.length ? (rows as ShownLiveCall[]) : kept;
}

/**
 * Past twice the average handle time (the agent floor's rule, `CALL_OVERRUN_AHT_MULTIPLE`). Never
 * when the handle time is not known: a new campaign has none, and amber on every call would be noise.
 */
export function isLiveCallOverrun(elapsedMs: number | null, ahtSeconds: number | null | undefined): boolean {
  if (elapsedMs === null || typeof ahtSeconds !== 'number' || !(ahtSeconds > 0)) return false;
  return elapsedMs > ahtSeconds * CALL_OVERRUN_AHT_MULTIPLE * 1000;
}

/** One choice in the agent or campaign filter. */
export interface LiveCallFilterOption {
  id: string;
  name: string;
}

/**
 * The agents and campaigns in the rows, for the filters, by name; plus the agent and campaign
 * chosen (`keep`), when their calls have all ended: a filter in force stays shown in its control,
 * rather than read as "All" while it still hides every row.
 */
export function liveCallFilterOptions(
  calls: readonly AgencyLiveCall[],
  keep: { agent?: LiveCallFilterOption | null; campaign?: LiveCallFilterOption | null } = {},
): {
  agents: LiveCallFilterOption[];
  campaigns: LiveCallFilterOption[];
} {
  const agents = new Map<string, string>();
  const campaigns = new Map<string, string>();
  for (const call of calls) {
    agents.set(call.agent_user_id, agentName(call));
    if (call.campaign_id) campaigns.set(call.campaign_id, call.campaign_name ?? LIVE_CALLS_COPY.unnamedCampaign);
  }
  if (keep.agent && !agents.has(keep.agent.id)) agents.set(keep.agent.id, keep.agent.name);
  if (keep.campaign && !campaigns.has(keep.campaign.id)) campaigns.set(keep.campaign.id, keep.campaign.name);
  const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name, 'en-GB', { sensitivity: 'base' });
  return {
    agents: [...agents].map(([id, name]) => ({ id, name })).sort(byName),
    campaigns: [...campaigns].map(([id, name]) => ({ id, name })).sort(byName),
  };
}

/** What the listening bar keeps about a call when a listen starts. */
export function listenTargetFor(call: AgencyLiveCall, clockOffsetMs: number): ListenTarget {
  return {
    callId: call.call_id,
    origin: call.origin,
    correlationId: call.correlation_id,
    campaignId: call.campaign_id,
    campaignLabel: campaignCellLabel(call),
    agentName: agentName(call),
    customerMasked: maskedNumberLabel(call),
    connectedAt: call.connected_at,
    clockOffsetMs,
  };
}

/**
 * The call's own page, keyed on the live row's `correlation_id` (the spine row, by `origin`): a
 * dialler call opens its attempt (`/agency/campaigns/:id/attempts/:attemptId`), a soft-phone call
 * its call page (`/agency/softphone/calls/:id`). Null for an inbound call, which has no call page in
 * the console, and for a row missing the ids its page needs: neither the row nor the listening
 * bar offers "Open call" then (a link to a list of other calls would be a dead end).
 */
export function liveCallPagePath(
  call: { origin: AgencyCallOrigin; campaignId: string | null; correlationId: string | null | undefined },
): string | null {
  if (!call.correlationId) return null;
  switch (call.origin) {
    case 'campaign':
      return call.campaignId ? `/agency/campaigns/${call.campaignId}/attempts/${call.correlationId}` : null;
    case 'manual':
      return `/agency/softphone/calls/${call.correlationId}`;
    case 'inbound':
      return null;
  }
}

/** {@link liveCallPagePath} for a live row. */
export function liveCallRowPagePath(call: Pick<AgencyLiveCall, 'origin' | 'campaign_id' | 'correlation_id'>): string | null {
  return liveCallPagePath({ origin: call.origin, campaignId: call.campaign_id, correlationId: call.correlation_id });
}

/** The table's customer cell words (re-exported so the table reads one module). */
export { customerLabel };
