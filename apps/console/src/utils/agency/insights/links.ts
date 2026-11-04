import type { AgencyAttemptOutcome } from '../../../types/agency';
import type { AgencyInsightsRoster } from '../../../types/agency-insights';
import { AGENCY_UNASSIGNED_FILTER } from '@magick-agency/contracts/api/agency/agency-spine';

/**
 * Every drill-down link on the Insights tab: a number opens the list whose rows
 * it counts.
 *
 * ── One builder, so the key names live in one place ─────────────────────────
 * The Contacts and Call attempts tabs read their filters from the URL
 * (`agencyRosterFilters.ts`, `agencyCampaignAttemptParams.ts`) and the server
 * filters and counts with the same predicates the insights reads use
 * (`drilldown-sql.ts`), so the list's total ("N contacts", "N attempts") is the
 * number that was clicked (docs/insights.md, WS F):
 *
 *  - Contacts: `state`, `suppressed_reason`, `last_disposition`, `assigned_to`
 *    (an agent id, or `unassigned` for the pool), `waiting=due_now|retry|callback`
 *    (the roster's waiting buckets), `attempted=1|0` (a dial placed, or none).
 *  - Call attempts: `outcome`, `disposition_code`, `agent_user_id` (through the
 *    attempt's session), `caller_id`, `redial=1|0`, `agent_manual=1`,
 *    `agent_reopened=1`, and `placed=1` plus `dialed_from` / `dialed_to`.
 *
 * ── Every attempts link is a placed-dial link ───────────────────────────────
 * The insights attempt numbers count dials PLACED (IN6: `dialed_at` set), cut by
 * a half-open `[from, to)` on `dialed_at`. The attempts list's own `from`/`to`
 * are a different window (inclusive, on `created_at`, unplaced attempts
 * included), so the range goes out as `dialed_from` / `dialed_to`, and every link
 * carries `placed=1` so a lifetime number (no range) still lists placed dials
 * only. The builder's own fields keep the insights names (`from`, `to`,
 * `disposition`); only the URL spelling is the list's.
 *
 * ── An agent's own performance has no URL ───────────────────────────────────
 * The analytics page holds its selected agent in component state, so there is no
 * link to "agent X". {@link agentLink} goes to the campaign's Agents tab instead.
 */

export type InsightsWaiting = 'due_now' | 'retry' | 'callback';

export interface InsightsContactsFilter {
  state?: string[];
  waiting?: InsightsWaiting;
  suppressed_reason?: string[];
  /** An agent's user id, or `null` for the unassigned pool. */
  assigned_to?: string | null;
  attempted?: boolean;
  last_disposition?: string;
}

export interface InsightsAttemptsFilter {
  outcome?: AgencyAttemptOutcome | AgencyAttemptOutcome[];
  /** A write-up code; sent as the list's `disposition_code`. */
  disposition?: string;
  agent_user_id?: string;
  caller_id?: string;
  /** `true`: wrap-up redials only (`redial=1`); `false`: none (`redial=0`, what `connected` counts). */
  redial?: boolean;
  agent_manual?: boolean;
  agent_reopened?: boolean;
  /** The insights range, half-open `[from, to)`; sent as `dialed_from` / `dialed_to`. */
  from?: string;
  to?: string;
}

function campaignBase(campaignId: string): string {
  return `/agency/campaigns/${encodeURIComponent(campaignId)}`;
}

function withQuery(path: string, params: URLSearchParams): string {
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}

/** `/agency/campaigns/:id/contacts?…` */
export function contactsLink(campaignId: string, filter: InsightsContactsFilter = {}): string {
  const params = new URLSearchParams();
  for (const state of filter.state ?? []) params.append('state', state);
  if (filter.waiting) params.set('waiting', filter.waiting);
  for (const reason of filter.suppressed_reason ?? []) params.append('suppressed_reason', reason);
  if (filter.last_disposition) params.append('last_disposition', filter.last_disposition);
  if (filter.assigned_to !== undefined) {
    params.append('assigned_to', filter.assigned_to === null ? AGENCY_UNASSIGNED_FILTER : filter.assigned_to);
  }
  if (filter.attempted !== undefined) params.set('attempted', filter.attempted ? '1' : '0');
  return withQuery(`${campaignBase(campaignId)}/contacts`, params);
}

/** `/agency/campaigns/:id/attempts?…`: placed dials, the range half-open on `dialed_at`. */
export function attemptsLink(campaignId: string, filter: InsightsAttemptsFilter = {}): string {
  const params = new URLSearchParams();
  const outcomes = filter.outcome === undefined ? [] : Array.isArray(filter.outcome) ? filter.outcome : [filter.outcome];
  for (const outcome of outcomes) params.append('outcome', outcome);
  if (filter.disposition) params.set('disposition_code', filter.disposition);
  if (filter.agent_user_id) params.set('agent_user_id', filter.agent_user_id);
  if (filter.caller_id) params.set('caller_id', filter.caller_id);
  if (filter.redial !== undefined) params.set('redial', filter.redial ? '1' : '0');
  if (filter.agent_manual) params.set('agent_manual', '1');
  if (filter.agent_reopened) params.set('agent_reopened', '1');
  params.set('placed', '1');
  if (filter.from) params.set('dialed_from', filter.from);
  if (filter.to) params.set('dialed_to', filter.to);
  return withQuery(`${campaignBase(campaignId)}/attempts`, params);
}

/** The campaign's Agents tab. */
export function agentsLink(campaignId: string): string {
  return `${campaignBase(campaignId)}/agents`;
}

/** Where an agent's row leads: their performance view if it had a URL, so the Agents tab. */
export function agentLink(campaignId: string, _agentUserId: string): string {
  return agentsLink(campaignId);
}

/** The campaign's Settings tab, Contacts upload, and the ingest job's rejected-rows path. */
export function settingsLink(campaignId: string): string {
  return `${campaignBase(campaignId)}/settings`;
}

export function contactsUploadLink(campaignId: string): string {
  return `${campaignBase(campaignId)}/contacts/add`;
}

/** The roster bucket a contacts link narrows to, one per counted field. */
export type RosterBucket = keyof Pick<
  AgencyInsightsRoster,
  | 'total'
  | 'waiting_due_now'
  | 'waiting_retry'
  | 'waiting_callback'
  | 'on_call'
  | 'in_wrapup'
  | 'completed'
  | 'exhausted'
  | 'suppressed_dnc'
  | 'suppressed_invalid'
  | 'suppressed_other'
  | 'attempted'
> | 'waiting' | 'suppressed' | 'never_attempted';

const ROSTER_FILTERS: Record<RosterBucket, InsightsContactsFilter> = {
  total: {},
  waiting: { state: ['pending'] },
  waiting_due_now: { state: ['pending'], waiting: 'due_now' },
  waiting_retry: { state: ['pending'], waiting: 'retry' },
  waiting_callback: { state: ['pending'], waiting: 'callback' },
  on_call: { state: ['in_flight'] },
  in_wrapup: { state: ['connected'] },
  completed: { state: ['completed'] },
  exhausted: { state: ['exhausted'] },
  suppressed: { state: ['suppressed'] },
  suppressed_dnc: { state: ['suppressed'], suppressed_reason: ['dnc'] },
  suppressed_invalid: { state: ['suppressed'], suppressed_reason: ['invalid'] },
  suppressed_other: { state: ['suppressed'], suppressed_reason: ['max_attempts', 'manual'] },
  attempted: { attempted: true },
  never_attempted: { attempted: false },
};

/** The contacts list behind one roster number. */
export function rosterBucketLink(campaignId: string, bucket: RosterBucket): string {
  return contactsLink(campaignId, ROSTER_FILTERS[bucket]);
}

// ── The allocation table ─────────────────────────────────────────────────────

type AllocationLinkSpec = { contacts: InsightsContactsFilter } | { attempts: InsightsAttemptsFilter };

/** The allocation columns that open a list, and the filter behind each (the owner is added per row). */
export const ALLOCATION_LINK_FILTERS: Readonly<Record<string, AllocationLinkSpec>> = {
  allocated: { contacts: {} },
  attempted: { contacts: { attempted: true } },
  not_attempted: { contacts: { attempted: false } },
  due_now: { contacts: { state: ['pending'], waiting: 'due_now' } },
  waiting_retry: { contacts: { state: ['pending'], waiting: 'retry' } },
  exhausted: { contacts: { state: ['exhausted'] } },
  dnc: { contacts: { state: ['suppressed'], suppressed_reason: ['dnc'] } },
  // The dial counters are the DIALLING agent's (the server's rollup attribution), so they open
  // that agent's dials; the Unassigned row's (dials with no agent session) has no list.
  redials: { attempts: { redial: true } },
  retries_reopened: { attempts: { agent_reopened: true } },
  retries_manual: { attempts: { agent_manual: true } },
};

/**
 * The list behind one allocation cell, or null when it has none. `owner`: an agent's user id,
 * `null` for the Unassigned row, `undefined` for the Total row. Contacts columns filter by owner
 * (`assigned_to`); the dial counters by the dialling agent, and the Unassigned row's have none.
 */
export function allocationLink(campaignId: string, column: string, owner: string | null | undefined): string | null {
  const spec = Object.hasOwn(ALLOCATION_LINK_FILTERS, column) ? ALLOCATION_LINK_FILTERS[column] : undefined;
  if (!spec) return null;
  if ('contacts' in spec) {
    return contactsLink(campaignId, { ...spec.contacts, ...(owner !== undefined ? { assigned_to: owner } : {}) });
  }
  if (owner === null) return null;
  return attemptsLink(campaignId, { ...spec.attempts, ...(owner ? { agent_user_id: owner } : {}) });
}
