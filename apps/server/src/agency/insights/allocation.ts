/**
 * `GET …/insights/allocation`: the per-agent allocation table, as of now. Part of
 * `src/agency/insights/` (docs/insights.md "API").
 *
 * ── Where each column comes from ─────────────────────────────────────────────
 *  - The contact columns: ONE statement grouped by owner (`allocationStatement`). `reached`,
 *    `not_reached` and `exhausted` are the owner's buckets (`contactBucketSql`), exactly what the
 *    supervisor's progress read (`GET …/assignments/progress`) serves. `due_now`,
 *    `waiting_retry` and the callbacks follow the roster's waiting rule (`insights-sql.ts`:
 *    `pending` and `next_attempt_at <= now()`), which is progress's "due now" (open, i.e. pending
 *    and not DNC) for every row but a `pending` row frozen DNC, a pre-fix leftover the claim
 *    refuses. `attempted` is the
 *    roster's (`dials_placed > 0`, decision IN6), not progress's `attempt_count > 0`: a contact
 *    whose only dial ended on our fault, or whose first call is still ringing, is attempted here
 *    and on the roster. `callbacks_due_today` is a
 *    pending callback due in `[now, local midnight)` in the campaign's zone, `callbacks_overdue` one
 *    due before now. `successes` = latest disposition is an `is_success` code; `dnc` =
 *    `suppressed_reason = 'dnc'`.
 *  - Staffing, `live`, `last_seen_at` and `due_while_absent`: the progress read's own reads and
 *    rule (`listActiveForCampaign`, `presence`, `agentAbsent`). `state`: the agent's joined
 *    session's state, `offline` when none.
 *  - `redials`, `retries_reopened`, `retries_manual`, `overrides_used`, `last_activity_at`:
 *    `allocationAttemptCounters`, over the campaign's lifetime from the insights rollup, by the
 *    agent who PLACED the dial (the rollup's attribution, and the Call attempts list's
 *    `agent_user_id` filter, so each number opens a list of exactly its dials). The contact
 *    columns are by owner; in strict mode, where owners dial their own contacts, the two agree.
 *    The pool row's dial counters are the dials placed with no reserved session. An agent who
 *    dialled and is neither staffed nor an owner still gets a row (allocated 0), so the Total
 *    row is every dial. `last_activity_at` is the agent's newest placed dial.
 *
 * Owners are reported as stored, whatever `agency_contact_assignment_enabled` says: pacing reads
 * the stored `assignment_mode` and owners regardless of the flag (CA9 gates the surface, never the
 * runtime), so this is what the dialler is doing. With the flag off a campaign is normally `pool`
 * with every contact unassigned.
 *
 * ── Imbalance and at risk ────────────────────────────────────────────────────
 *  - `imbalance.high`: staffed agents whose due-now backlog is at least
 *    {@link IMBALANCE_HIGH_FACTOR} × the staffed agents' average (factor to 1 dp), when that
 *    average is above 0; `imbalance.empty`: staffed agents holding no open contact. Both empty in
 *    `pool` mode, where owners do not decide who dials.
 *  - `at_risk.held_by_absent`: agents holding due contacts while away longer than
 *    `absent_after_minutes`, or no longer staffed; `overdue_callbacks_absent_owner`: their overdue
 *    callbacks.
 *
 * ── Reconciliation ───────────────────────────────────────────────────────────
 *  - `allocated_plus_unassigned_vs_total`: the agents' rows plus the pool's, as served, against
 *    the statement's total (an owner dropped from the table is a visible miss);
 *  - `agent_buckets_vs_allocated`: every owner's roster partition (the summary's ten buckets,
 *    each its own predicate) against their allocation.
 */
import {
  AGENCY_ASSIGNMENT_ABSENT_AFTER_MINUTES,
} from '@magick-agency/contracts/api/agency/assignment';
import type { AgencyAgentState } from '@magick-agency/contracts/agency';
import type {
  AgencyInsightsAllocation,
  AgencyInsightsAllocationRow,
} from '@magick-agency/contracts/api/agency/insights';
import { agencyCampaignAgentRepository } from '@magick-agency/db/repositories/agency-campaign-agent.repository';
import { platformAuditRepository } from '@magick-agency/db/repositories/platform/audit.repository';
import type { AgencyCampaignRecord } from '../../db/models/agency.model.js';
import {
  agentAbsent,
  agencyAssignmentReadRepository,
  agencyInsightsReadRepository,
  type OwnerAttemptCounters,
  type OwnerCounts,
} from '../../db/repositories/agency.repository.js';
import { callbackCodes } from '../../db/repositories/agency/assignment-sql.js';
import { agentNamesOrNone } from '../agency-agent-identity.js';
import { localDayEnd } from '../calling-hours.js';
import { actorOf, iso, reconcile, successCodes } from './shared.js';
import { insightsCache, insightsCacheKey } from './cache.js';

/** A due backlog at least this many times the staffed average is "high". */
export const IMBALANCE_HIGH_FACTOR = 1.5;

/** The newest bulk assignment operations listed. */
export const ALLOCATION_HISTORY_LIMIT = 50;

/** The audit actions the history lists (each one `platform_audit_log` row per operation). */
export const ALLOCATION_HISTORY_ACTIONS = [
  'agency_contacts.assigned',
  'agency_contacts.unassigned_on_unstaff',
  'agency_contacts.callback_fallback',
] as const;

/** Reconciliation identifiers of the allocation (docs/insights.md "API"). */
export const ALLOCATION_CHECKS = {
  total: 'allocated_plus_unassigned_vs_total',
  buckets: 'agent_buckets_vs_allocated',
} as const;

type Totals = AgencyInsightsAllocation['totals'];

const AGENT_STATES: ReadonlySet<string> = new Set(['offline', 'available', 'reserved', 'on_call', 'wrapup', 'break']);

function emptyCounts(uid: string | null): OwnerCounts {
  return {
    uid, allocated: 0, attempted: 0, due_now: 0, waiting_retry: 0, callbacks_due_today: 0, callbacks_overdue: 0,
    reached: 0, not_reached: 0, exhausted: 0, successes: 0, dnc: 0, open: 0, partition_sum: 0,
  };
}

const NO_ATTEMPTS: OwnerAttemptCounters = {
  redials: 0, retries_reopened: 0, retries_manual: 0, overrides_used: 0, last_activity_at: null,
};

/** The columns every row shares. */
function columns(c: OwnerCounts, a: OwnerAttemptCounters): Totals {
  return {
    allocated: c.allocated,
    attempted: c.attempted,
    not_attempted: c.allocated - c.attempted,
    due_now: c.due_now,
    waiting_retry: c.waiting_retry,
    callbacks_due_today: c.callbacks_due_today,
    callbacks_overdue: c.callbacks_overdue,
    reached: c.reached,
    successes: c.successes,
    not_reached: c.not_reached,
    exhausted: c.exhausted,
    dnc: c.dnc,
    redials: a.redials,
    retries_reopened: a.retries_reopened,
    retries_manual: a.retries_manual,
    overrides_used: a.overrides_used,
    last_activity_at: iso(a.last_activity_at),
  };
}

function sumTotals(rows: Totals[]): Totals {
  const out = columns(emptyCounts(null), NO_ATTEMPTS);
  let last: string | null = null;
  for (const r of rows) {
    for (const k of Object.keys(out) as Array<keyof Totals>) {
      if (k === 'last_activity_at') continue;
      (out[k] as number) += r[k] as number;
    }
    if (r.last_activity_at && (last === null || r.last_activity_at > last)) last = r.last_activity_at;
  }
  out.last_activity_at = last;
  return out;
}

/** The newest bulk operations, with their actors' names. */
async function history(campaign: AgencyCampaignRecord): Promise<AgencyInsightsAllocation['history']> {
  const page = await platformAuditRepository.find({
    tenantId: campaign.tenant_id,
    campaignId: campaign.id,
    actions: [...ALLOCATION_HISTORY_ACTIONS],
    keysetOrder: true,
    limit: ALLOCATION_HISTORY_LIMIT,
    withTotal: false,
  });
  const names = await agentNamesOrNone(page.logs.map((r) => r.user_id), campaign.tenant_id, 'insights');
  return page.logs.map((row) => {
    const details = (row.details ?? {}) as Record<string, unknown>;
    const system = row.actor_type === 'system' || (row.actor_type === null && row.user_id === null);
    const kind = typeof details['kind'] === 'string' ? details['kind'] : row.action.slice('agency_contacts.'.length);
    return {
      at: new Date(row.created_at).toISOString(),
      actor: system ? null : actorOf(row.user_id, names),
      kind,
      moved: typeof details['moved'] === 'number' ? details['moved'] : 0,
      batch_id: typeof details['batch_id'] === 'string' ? details['batch_id'] : null,
    };
  });
}

/**
 * The allocation as every caller reads it: through the insights cache (`cache.ts`), under the one
 * key the allocation route and the activity read share, so they never compute it twice for the
 * same campaign state.
 */
export function cachedAllocation(campaign: AgencyCampaignRecord): Promise<AgencyInsightsAllocation> {
  return insightsCache.get(insightsCacheKey('allocation', campaign), () => computeAllocation(campaign));
}

/**
 * `totals.callbacks_overdue` of each campaign's allocation, in one read (Home's board): the
 * allocation statement's own predicate (`callbackOverdueSql`) and callback codes, counted per
 * campaign rather than per owner.
 */
export function callbacksOverdueByCampaign(campaigns: readonly AgencyCampaignRecord[]): Promise<Map<string, number>> {
  return agencyInsightsReadRepository.callbacksOverdue(
    campaigns.map((c) => ({ campaignId: c.id, callbackCodes: callbackCodes(c.disposition_catalog) })),
  );
}

export async function computeAllocation(campaign: AgencyCampaignRecord): Promise<AgencyInsightsAllocation> {
  const now = new Date();
  const absentAfter = AGENCY_ASSIGNMENT_ABSENT_AFTER_MINUTES;
  // An unreadable zone (validated at write) falls back to a UTC day rather than failing the read.
  const dayEnd = localDayEnd(campaign.default_timezone, now) ?? localDayEnd('UTC', now)!;
  const [owners, counters, staffing, presence, states, recent] = await Promise.all([
    agencyInsightsReadRepository.allocation({
      campaignId: campaign.id,
      callbackCodes: callbackCodes(campaign.disposition_catalog),
      successCodes: successCodes(campaign.disposition_catalog),
      dayEndAt: dayEnd,
    }),
    agencyInsightsReadRepository.allocationAttemptCounters(campaign.id),
    agencyCampaignAgentRepository.listActiveForCampaign(campaign.id, campaign.tenant_id),
    agencyAssignmentReadRepository.presence(campaign.id),
    agencyInsightsReadRepository.agentStates(campaign.id),
    history(campaign),
  ]);

  const byOwner = new Map(owners.filter((o) => o.uid !== null).map((o) => [o.uid!, o]));
  const pool = owners.find((o) => o.uid === null) ?? emptyCounts(null);
  const staffed = new Set(staffing.map((s) => s.user_id));
  // The progress read's order: the staffed agents, then any other owner, then anyone else who dialled.
  const dialled = [...counters.keys()].filter((k): k is string => k !== null).sort();
  const ids = [...new Set([...staffing.map((s) => s.user_id), ...[...byOwner.keys()].sort(), ...dialled])];
  const names = await agentNamesOrNone(ids, campaign.tenant_id, 'insights');
  const nowMs = now.getTime();

  const agents: AgencyInsightsAllocationRow[] = ids.map((id) => {
    const c = byOwner.get(id) ?? emptyCounts(id);
    const session = presence.get(id);
    const state = states.get(id);
    return {
      agent_user_id: id,
      agent_name: names.get(id) ?? null,
      staffed: staffed.has(id),
      state: (state && AGENT_STATES.has(state) ? state : 'offline') as AgencyAgentState,
      last_seen_at: iso(session?.last_seen_at ?? null),
      ...columns(c, counters.get(id) ?? NO_ATTEMPTS),
      due_while_absent: agentAbsent(session, nowMs, absentAfter) ? c.due_now : 0,
    };
  });
  const unassigned = columns(pool, counters.get(null) ?? NO_ATTEMPTS);
  const totals = sumTotals([...agents, unassigned]);

  // ── Imbalance ──
  const ownersDecide = campaign.assignment_mode !== 'pool';
  const staffedRows = agents.filter((a) => a.staffed);
  const average = staffedRows.length > 0 ? staffedRows.reduce((s, a) => s + a.due_now, 0) / staffedRows.length : 0;
  const high = !ownersDecide || average <= 0
    ? []
    : staffedRows
        .filter((a) => a.due_now >= IMBALANCE_HIGH_FACTOR * average)
        .map((a) => ({ agent_user_id: a.agent_user_id, factor: Math.round((a.due_now / average) * 10) / 10 }));
  const empty = ownersDecide
    ? staffedRows.filter((a) => (byOwner.get(a.agent_user_id)?.open ?? 0) === 0).map((a) => a.agent_user_id)
    : [];

  // ── At risk ──
  const atRisk = agents.filter((a) => a.due_now > 0
    && (!a.staffed || agentAbsent(presence.get(a.agent_user_id), nowMs, absentAfter)));

  const statementTotal = owners.reduce((s, o) => s + o.allocated, 0);
  return {
    campaign_id: campaign.id,
    assignment_mode: campaign.assignment_mode,
    agents,
    unassigned,
    totals,
    imbalance: { high, empty },
    at_risk: {
      held_by_absent: atRisk.map((a) => ({ agent_user_id: a.agent_user_id, due: a.due_now, away_since: a.last_seen_at, staffed: a.staffed })),
      overdue_callbacks_absent_owner: atRisk.reduce((s, a) => s + a.callbacks_overdue, 0),
    },
    absent_after_minutes: absentAfter,
    history: recent,
    reconciliation: [
      reconcile(ALLOCATION_CHECKS.total, statementTotal, agents.reduce((s, a) => s + a.allocated, 0) + unassigned.allocated),
      reconcile(ALLOCATION_CHECKS.buckets, statementTotal, owners.reduce((s, o) => s + o.partition_sum, 0)),
    ],
    generated_at: now.toISOString(),
  };
}
