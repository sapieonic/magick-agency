/**
 * `GET …/insights/health`: abandonment, pre-dial blocks, caller IDs, the pacing history (stalls,
 * concurrency, our-fault retirements), carrier failures and recording over a served range. Part of
 * `src/agency/insights/` (docs/insights.md "API (range reads)").
 *
 *  - `abandonment.rolling_24h`: the guardrail's own window for this campaign, whatever the range
 *    (`abandonmentWindow`: ended calls answered in the last 24 h, the guardrail's predicate);
 *    `ceiling_pct` the campaign's; `auto_pauses` the guardrail's `agency_campaign.auto_paused`
 *    audit rows in range with the rate it measured and the ceiling it held (at most
 *    {@link AUTO_PAUSES_MAX}, oldest first). The carrier-account pause writes the same event
 *    (`carrier-account-pause.ts`, reason `carrier_auth` or `carrier_account_unavailable`); its
 *    rows are not the guardrail's and are left out ({@link isGuardrailPause}).
 *  - `predial_blocks`, `concurrency_limit_minutes`, `our_fault_retired`, `stalls`,
 *    `pacing_history_since`: `pacingHistory` (the stall rule is its module header). It starts the
 *    day the pacing history shipped; `pacing_history_since` says when.
 *  - `caller_ids` (dials, first dials, connected), `carrier_failures` and
 *    `carrier_failures_by_code` (the `carrier_error` facet, 0014), `recording`: the rollup.
 *  - `analysis`: null (not served yet: no index-driven read of a range's analysed calls exists).
 *  - `as_of` / `pending_buckets`: the rollup's `asOf`.
 */
import type { AgencyInsightsHealth } from '@magick-agency/contracts/api/agency/insights';
import { auditRepository } from '@magick-agency/db/repositories/audit.repository';
import type { AgencyCampaignRecord } from '../../db/models/agency.model.js';
import {
  agencyInsightsPacingRepository,
  agencyInsightsReadRepository,
  agencyInsightsRollupRepository,
} from '../../db/repositories/agency.repository.js';
import { campaignZone, rangeWire, type ServedInsightsRange } from './range.js';
import { InsightsCampaignGone } from './shared.js';

/** The most auto-pauses listed for a range. */
export const AUTO_PAUSES_MAX = 200;

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * Whether an `agency_campaign.auto_paused` row is the abandonment guardrail's: reason
 * `abandonment_ceiling`, or no reason at all (the guardrail's oldest rows predate it). Any other
 * reason is another writer's (the carrier-account pause), which measured no rate and held no
 * ceiling.
 */
export function isGuardrailPause(eventData: Record<string, unknown>): boolean {
  const reason = eventData['reason'];
  return reason === undefined || reason === null || reason === 'abandonment_ceiling';
}

/** The guardrail's auto-pauses in `[from, to)`, oldest first (`audit_logs`, the activity trail's own read). */
async function autoPauses(campaign: AgencyCampaignRecord, range: ServedInsightsRange): Promise<AgencyInsightsHealth['abandonment']['auto_pauses']> {
  const { rows } = await auditRepository.findFiltered({
    tenantId: campaign.tenant_id,
    accountId: campaign.account_id,
    eventTypes: ['agency_campaign.auto_paused'],
    campaignId: campaign.id,
    from: range.from,
    to: range.to,
    limit: AUTO_PAUSES_MAX,
    withTotal: false,
  });
  return rows
    // `findFiltered`'s `to` is inclusive; the range is not.
    .filter((r) => new Date(r.timestamp).getTime() < range.to.getTime())
    // The carrier-account pauses share the event type. They are filtered here, after the limit:
    // each one waits on a supervisor's resume, so a range never holds enough to crowd the
    // guardrail's out of AUTO_PAUSES_MAX.
    .map((r) => ({ at: new Date(r.timestamp).toISOString(), data: (r.event_data ?? {}) as Record<string, unknown> }))
    .filter((r) => isGuardrailPause(r.data))
    .map(({ at, data }) => ({ at, measured_pct: num(data['measured_pct']), ceiling_pct: num(data['ceiling_pct']) }))
    .sort((a, b) => a.at.localeCompare(b.at));
}

export async function computeHealth(
  campaign: AgencyCampaignRecord,
  range: ServedInsightsRange,
  opts: { now?: Date } = {},
): Promise<AgencyInsightsHealth> {
  const now = opts.now ?? new Date();
  const q = { campaignId: campaign.id, tenantId: campaign.tenant_id, from: range.from, to: range.to };
  const [window, pauses, pacing, callerIds, carrierFailures, recording, freshness] = await Promise.all([
    agencyInsightsReadRepository.abandonmentWindow(campaign.id),
    autoPauses(campaign, range),
    agencyInsightsPacingRepository.pacingHistory(campaign.id, campaign.tenant_id, range, { now }),
    agencyInsightsRollupRepository.callerIds(q),
    agencyInsightsRollupRepository.carrierFailures(q),
    agencyInsightsRollupRepository.recording(q),
    agencyInsightsRollupRepository.asOf(q),
  ]);
  if (!callerIds || !carrierFailures || !recording || !freshness) throw new InsightsCampaignGone();
  return {
    campaign_id: campaign.id,
    range: rangeWire(range, campaignZone(campaign.default_timezone)),
    abandonment: { rolling_24h: window, ceiling_pct: campaign.abandonment_ceiling_pct, auto_pauses: pauses },
    predial_blocks: {
      dnc: pacing.predial_dnc_suppressed,
      invalid: pacing.predial_invalid_suppressed,
      outside_calling_hours_deferrals: pacing.outside_calling_hours_deferrals,
    },
    caller_ids: callerIds,
    concurrency_limit_minutes: pacing.concurrency_limit_minutes,
    carrier_failures: carrierFailures.failed,
    carrier_failures_by_code: carrierFailures.by_code,
    our_fault_retired: pacing.our_fault_retired,
    stalls: { minutes_by_reason: pacing.minutes_by_reason, episodes: pacing.episodes, episodes_truncated: pacing.episodes_truncated },
    recording,
    // TODO(insights): serve `analysis`. It needs an index-driven read of a range's analysed
    // calls: a rollup facet, or an index on the analysis rows by campaign and time. Until
    // then the page reads null as "not available", not as analysis being off.
    analysis: null,
    pacing_history_since: pacing.history_since,
    as_of: freshness.as_of,
    pending_buckets: freshness.pending_buckets,
    generated_at: now.toISOString(),
  };
}
