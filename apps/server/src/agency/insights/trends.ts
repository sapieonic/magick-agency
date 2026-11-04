/**
 * `GET …/insights/trends`: the series by bucket and the best hours over a served range. Part of
 * `src/agency/insights/` (docs/insights.md "API (range reads)").
 *
 *  - Every bucket of the range, zeros included, from the rollup's trend read
 *    (`agencyInsightsRollupRepository.trends`): dials, connected, conversations, successes (the
 *    campaign's CURRENT success codes), abandoned, answered. `hour` and `day` are cut in the
 *    campaign's zone as Postgres resolves it (UTC when it cannot), which `range.timezone` echoes.
 *  - `agents_online_peak` per bucket from `agentsOnlinePeak` (the session events; not the rollup),
 *    labelled by the same label function, joined on the label. A bucket the peak read has no row
 *    for is 0.
 *  - `best_hours`: dials and connected by the CONTACT's local hour (the rollup's `local_hour`).
 *  - `as_of` from the trend read, `pending_buckets` from `asOf`.
 */
import type { AgencyInsightsTrends } from '@magick-agency/contracts/api/agency/insights';
import type { AgencyCampaignRecord } from '../../db/models/agency.model.js';
import { agencyInsightsRollupRepository } from '../../db/repositories/agency.repository.js';
import { rangeWire, type ServedInsightsRange } from './range.js';
import { InsightsCampaignGone, successCodes } from './shared.js';

export async function computeTrends(
  campaign: AgencyCampaignRecord,
  range: ServedInsightsRange & { bucket: NonNullable<ServedInsightsRange['bucket']> },
  opts: { now?: Date } = {},
): Promise<AgencyInsightsTrends> {
  const now = opts.now ?? new Date();
  const q = { campaignId: campaign.id, tenantId: campaign.tenant_id, from: range.from, to: range.to };
  const zone = campaign.default_timezone || 'UTC';
  const [series, peaks, freshness] = await Promise.all([
    agencyInsightsRollupRepository.trends({ ...q, bucket: range.bucket, timezone: zone, successCodes: successCodes(campaign.disposition_catalog) }),
    agencyInsightsRollupRepository.agentsOnlinePeak({ ...q, bucket: range.bucket, timezone: zone }),
    agencyInsightsRollupRepository.asOf(q),
  ]);
  if (!series || !freshness) throw new InsightsCampaignGone();
  const peakBy = new Map(peaks.map((p) => [p.bucket_start, p.agents_online_peak]));
  return {
    campaign_id: campaign.id,
    range: rangeWire(range, series.timezone),
    bucket: range.bucket,
    buckets: series.buckets.map((b) => ({
      bucket_start: b.bucket_start,
      dials: b.dials,
      connected: b.connected,
      conversations: b.conversations,
      successes: b.successes,
      abandoned: b.abandoned,
      answered: b.answered,
      agents_online_peak: peakBy.get(b.bucket_start) ?? 0,
    })),
    best_hours: series.best_hours,
    as_of: series.as_of,
    pending_buckets: freshness.pending_buckets,
    generated_at: now.toISOString(),
  };
}
