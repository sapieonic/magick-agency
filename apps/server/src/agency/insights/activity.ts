/**
 * `GET …/insights/activity`: calls, outcomes, callbacks, overrides, no-outcome, DNC marks and the
 * per-agent table over a served range. Part of `src/agency/insights/` (docs/insights.md "API
 * (range reads)").
 *
 * ── Where each block comes from ──────────────────────────────────────────────
 *  - `calls`, `outcomes`, `overrides`, `no_outcome`, the agents' dial columns, `reconciliation`
 *    and `as_of`: the rollup's activity read (`agencyInsightsRollupRepository.activity`), ONE
 *    `REPEATABLE READ` snapshot, so every reconciliation is checked against the numbers served
 *    beside it. Success and override codes are the campaign's CURRENT catalog (`successCodes`,
 *    `overrideCodes`), so a catalog edit re-labels history rather than leaving it stale.
 *  - `calls.redials.refused_at_limit`: the pacing history (`redials_refused_at_limit`), the one
 *    place a refused redial is recorded (it never became an attempt).
 *  - `calls.softphone` (and `calls.softphone_calls`, its `placed`): soft-phone calls tagged to the
 *    campaign, `created_at` in range, placed, connected and reached a person (`softphoneCalls`,
 *    the tag's index; the definition is `softphone-campaign-sql.ts`, SR1–SR3). Outside every
 *    other count: a manual call is not an attempt row (docs/softphone.md), and the dialler's
 *    connect rate is the dialler's alone (SR1). Untagged calls are in no campaign (SR4).
 *  - `calls.inbound`: the inbound calls filed under the campaign that arrived in range, and its
 *    open Missed rows as of now (`inboundCalls`; the definition is `inbound-campaign-sql.ts`, the
 *    Call log's own rule for an inbound row, CL16). Beside the dialler's and the soft phone's,
 *    in neither and in no connect rate (CL7). Read live, as the soft phone's are (CL25).
 *  - `outcomes_by_type`: `outcomes` (the dialler's conversations by code) beside the same codes
 *    on the soft-phone and inbound calls (`outcomesByType`), labelled from the campaign's
 *    CURRENT catalog (CL28).
 *  - `callbacks`: `booked` from the rollup (by the booking dial's time); the IN4 timing classes and
 *    `by_owner` from `callbackTiming` (the callbacks whose booked time is in range); `open_due_today`
 *    and `open_overdue` are as of now, the allocation's totals, read through the shared cache
 *    (`insightsCache`, the allocation's own key), so the page's polled allocation and this read
 *    share one computation and the two blocks cannot disagree.
 *  - `agents`: the rollup's per-agent rows (the null "no agent" row included, so they sum to the
 *    totals) joined to `agentStateSeconds` (the shared occupancy intervals), with names. An agent
 *    who was online but placed nothing gets a row of zero dials.
 *  - `never_joined`: staffed agents with neither state time nor a dial in range.
 *  - `dnc_marked`: the campaign-scoped agent marks written in range.
 *  - `pending_buckets`: the rollup's `asOf`.
 *
 * Every read runs in parallel; the slow ones over a long range are the callback timing and the
 * agent state time (docs/insights.md "API (range reads)", "Cost").
 */
import type {
  AgencyInsightsActivity,
  AgencyInsightsAgentActivityRow,
  AgencyInsightsOutcomeByTypeRow,
} from '@magick-agency/contracts/api/agency/insights';
import { agencyCampaignAgentRepository } from '@magick-agency/db/repositories/agency-campaign-agent.repository';
import type { AgencyCampaignRecord } from '../../db/models/agency.model.js';
import {
  agencyInsightsPacingRepository,
  agencyInsightsReadRepository,
  agencyInsightsRollupRepository,
} from '../../db/repositories/agency.repository.js';
import { agentNamesOrNone } from '../agency-agent-identity.js';
import { cachedAllocation } from './allocation.js';
import { campaignZone, rangeWire, type ServedInsightsRange } from './range.js';
import { InsightsCampaignGone, overrideCodes, successCodes, userIdOf } from './shared.js';

/**
 * One row per outcome code across the three call types (CL28): the dialler's conversations
 * (the rollup's rows), the soft phone's and inbound's (`outcomesByType`), each call under the
 * one type it is. Largest total first, then by code so the order is stable.
 */
export function outcomesByType(
  dialler: ReadonlyArray<{ code: string | null; count: number }>,
  others: ReadonlyArray<{ source: 'soft_phone' | 'inbound'; code: string | null; count: number }>,
  labels: ReadonlyMap<string, string | null>,
  success: ReadonlySet<string>,
): AgencyInsightsOutcomeByTypeRow[] {
  const rows = new Map<string | null, AgencyInsightsOutcomeByTypeRow>();
  const row = (code: string | null) => {
    let r = rows.get(code);
    if (!r) {
      r = {
        code,
        label: code === null ? null : labels.get(code) ?? null,
        is_success: code !== null && success.has(code),
        dialler: 0,
        soft_phone: 0,
        inbound: 0,
        total: 0,
      };
      rows.set(code, r);
    }
    return r;
  };
  for (const o of dialler) row(o.code).dialler += o.count;
  for (const o of others) row(o.code)[o.source] += o.count;
  return [...rows.values()]
    .map((r) => ({ ...r, total: r.dialler + r.soft_phone + r.inbound }))
    .filter((r) => r.total > 0)
    .sort((a, b) => b.total - a.total || String(a.code).localeCompare(String(b.code)));
}

const NO_STATE = { online_seconds: 0, available: 0, on_call: 0, wrapup: 0, break_by_reason: {} as Record<string, number> };

export async function computeActivity(
  campaign: AgencyCampaignRecord,
  range: ServedInsightsRange,
  opts: { now?: Date } = {},
): Promise<AgencyInsightsActivity> {
  const now = opts.now ?? new Date();
  const q = { campaignId: campaign.id, tenantId: campaign.tenant_id, from: range.from, to: range.to };
  const catalog = campaign.disposition_catalog;
  const [rollup, freshness, callbacks, states, pacing, softphone, inbound, otherOutcomes, dnc, staffing, allocation] = await Promise.all([
    agencyInsightsRollupRepository.activity({ ...q, successCodes: successCodes(catalog), overrideCodes: overrideCodes(catalog) }),
    agencyInsightsRollupRepository.asOf(q),
    agencyInsightsRollupRepository.callbackTiming({ ...q, now }),
    agencyInsightsRollupRepository.agentStateSeconds(q),
    agencyInsightsPacingRepository.pacingHistory(campaign.id, campaign.tenant_id, range, { now }),
    agencyInsightsReadRepository.softphoneCalls(q),
    agencyInsightsReadRepository.inboundCalls(q),
    agencyInsightsReadRepository.outcomesByType(q),
    agencyInsightsReadRepository.dncMarked(q),
    agencyCampaignAgentRepository.listActiveForCampaign(campaign.id, campaign.tenant_id),
    cachedAllocation(campaign),
  ]);
  if (!rollup || !freshness || !callbacks) throw new InsightsCampaignGone();

  const labels = new Map((Array.isArray(catalog) ? catalog : []).filter((d) => d && typeof d.code === 'string').map((d) => [d.code, d.label ?? null]));
  const success = new Set(successCodes(catalog));
  // `added_by` is the agent's user id; anything else (a label, NULL) is "nobody we can name".
  const dncCounts = new Map<string | null, number>();
  for (const r of dnc) dncCounts.set(userIdOf(r.added_by), (dncCounts.get(userIdOf(r.added_by)) ?? 0) + r.count);
  const dncByUser = [...dncCounts].map(([user_id, count]) => ({ user_id, count }));

  const stateByAgent = new Map(states.map((s) => [s.agent_user_id, s]));
  const dialledIds = new Set(rollup.agents.map((a) => a.agent_user_id));
  const stateOnly = states.filter((s) => !dialledIds.has(s.agent_user_id));
  const names = await agentNamesOrNone(
    [...dialledIds, ...stateOnly.map((s) => s.agent_user_id), ...dncByUser.map((r) => r.user_id)],
    campaign.tenant_id,
    'insights',
  );

  const agentRow = (id: string | null, dials: Omit<AgencyInsightsAgentActivityRow, 'agent_user_id' | 'agent_name' | 'online_seconds' | 'state_seconds'>): AgencyInsightsAgentActivityRow => {
    const s = (id === null ? undefined : stateByAgent.get(id)) ?? NO_STATE;
    return {
      agent_user_id: id,
      agent_name: id === null ? null : names.get(id) ?? null,
      online_seconds: s.online_seconds,
      state_seconds: { available: s.available, on_call: s.on_call, wrapup: s.wrapup, break_by_reason: { ...s.break_by_reason } },
      ...dials,
    };
  };
  const zero = { dials: 0, connected: 0, conversations: 0, human_connects: 0, successes: 0, talk_seconds: 0, wrapup_seconds: 0, wrapup_measured: 0, redials: 0, retries: 0, overrides: 0 };
  const agents: AgencyInsightsAgentActivityRow[] = [
    ...rollup.agents.map(({ agent_user_id, ...dials }) => agentRow(agent_user_id, dials)),
    ...stateOnly.map((s) => agentRow(s.agent_user_id, zero)),
  ];

  const present = new Set([...dialledIds, ...states.map((s) => s.agent_user_id)]);
  const c = rollup.calls;
  return {
    campaign_id: campaign.id,
    range: rangeWire(range, campaignZone(campaign.default_timezone)),
    calls: {
      dials: c.dials,
      connected: c.connected,
      conversations: c.conversations,
      human_connects: c.human_connects,
      successes: c.successes,
      by_outcome: c.by_outcome,
      redials: { ...c.redials, refused_at_limit: pacing.redials_refused_at_limit },
      agent_retries: c.agent_retries,
      softphone_calls: softphone.placed,
      softphone,
      inbound,
      talk_seconds: c.talk_seconds,
      wrapup_seconds: c.wrapup_seconds,
      wrapup_measured: c.wrapup_measured,
    },
    outcomes: rollup.outcomes.map((o) => ({
      code: o.code,
      label: o.code === null ? null : labels.get(o.code) ?? null,
      is_success: o.code !== null && success.has(o.code),
      count: o.count,
    })),
    outcomes_by_type: outcomesByType(rollup.outcomes, otherOutcomes, labels, success),
    callbacks: {
      booked: c.callbacks_booked,
      open_due_today: allocation.totals.callbacks_due_today,
      open_overdue: allocation.totals.callbacks_overdue,
      kept_on_time: callbacks.kept_on_time,
      kept_late: callbacks.kept_late,
      missed: callbacks.missed,
      pending_future: callbacks.pending_future,
      pending_due: callbacks.pending_due,
      by_owner: callbacks.by_owner,
    },
    overrides: rollup.overrides,
    no_outcome: rollup.no_outcome,
    dnc_marked: { total: dnc.reduce((s, r) => s + r.count, 0), by_agent: dncByUser },
    agents,
    never_joined: staffing.map((s) => s.user_id).filter((id) => !present.has(id)),
    reconciliation: rollup.reconciliation,
    as_of: rollup.as_of,
    pending_buckets: freshness.pending_buckets,
    generated_at: now.toISOString(),
  };
}
