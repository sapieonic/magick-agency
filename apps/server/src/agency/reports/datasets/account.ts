/**
 * The account report's builder (`kind: 'account'`, `AccountReportDataset`, supervisor only):
 * the account's covered campaigns side by side, the account roster and the account's days.
 *
 *  - Covered campaigns: `run.campaign_ids` when the request named some (each must be a campaign
 *    of the account, else the subject is unavailable), else every campaign of the account that
 *    placed a dial in the window or is running, paused or stopping now; by name.
 *  - Per campaign, the Insights range reads over the range their routes serve for the window
 *    (RP1): `calls` and `callbacks_booked` from `computeActivity`, the recording pair and the
 *    health row from `computeHealth`, abandoned / answered summed over the rollup's trend read
 *    (the read `computeTrends` serves its buckets from) cut into days of the REPORT's zone.
 *  - `totals`: the campaigns' figures summed field by field (`sumFigures`); `abandoned_pct`
 *    recomputed from the summed counts with the screens' rate helper (`ratePct`), never averaged.
 *  - `agents`, `benchmark`: the roster screen's read for the window (`readAccountRoster`, the
 *    console's query and its departed-agent default), over the whole account whatever
 *    `campaign_ids` narrowed.
 *  - `daily`: the rollup's 15-minute UTC buckets of the covered campaigns, re-bucketed into local
 *    days of `range.timezone` by the rollup's own trend read (`bucket: 'day'` in that zone, DST
 *    aware; every zone's offset is a multiple of 15 minutes, so no bucket straddles a local
 *    midnight), summed across campaigns. `agents_online_peak` is null: a distinct count across
 *    campaigns is not measured (a sum of per-campaign peaks would count an agent who moved twice).
 *
 * Campaigns are read at most {@link ACCOUNT_CAMPAIGN_CONCURRENCY} at a time: each campaign's
 * activity read runs its own parallel statements.
 *
 * Detail sheet: `attempts`, every placed dial of the covered campaigns in the window.
 */
import { AGENCY_ROSTER_MIN_RATE_DENOMINATOR } from '@magick-agency/contracts/agency';
import {
  AGENCY_INSIGHTS_MIN_RATE_DENOMINATOR,
  type AgencyInsightsActivity,
  type AgencyInsightsHealth,
} from '@magick-agency/contracts/api/agency/insights';
import {
  REPORT_DATASET_VERSION,
  type AccountReportCampaignRow,
  type AccountReportDailyRow,
  type AccountReportDataset,
  type AccountReportFigures,
  type AccountReportHealthRow,
} from '@magick-agency/contracts/reports';
import { ratePct } from '@magick-agency/domain/rates';
import type { AgencyCampaignRecord } from '../../../db/models/agency.model.js';
import {
  agencyInsightsRollupRepository,
  agencyReportDatasetRepository,
  type InsightsTrendRow,
} from '../../../db/repositories/agency.repository.js';
import { computeActivity } from '../../insights/activity.js';
import { computeHealth } from '../../insights/health.js';
import { campaignZone } from '../../insights/range.js';
import { successCodes } from '../../insights/shared.js';
import { attemptsSource } from './campaign.js';
import { accountDefinitions } from './definitions.js';
import {
  campaignsByIds,
  insightsRangeFor,
  localDates,
  mapLimit,
  readAccountRoster,
  reportRange,
  resolveReportZone,
  runTenancy,
  wire,
} from './shared.js';
import { ReportSubjectUnavailableError, type ReportDatasetBuilder } from './types.js';

/** Campaigns whose Insights reads run at once. */
export const ACCOUNT_CAMPAIGN_CONCURRENCY = 3;

/**
 * Sum same-shaped count objects field by field (pure): numbers add, objects recurse (the union of
 * their keys, so an outcome one campaign never saw is still summed), anything else is taken from
 * the first value that has it.
 */
export function sumCounts<T>(values: readonly T[]): T {
  const sum = (items: unknown[]): unknown => {
    const present = items.filter((v) => v !== undefined);
    if (present.length === 0) return undefined;
    if (present.every((v) => typeof v === 'number')) return (present as number[]).reduce((s, v) => s + v, 0);
    if (present.every((v) => v !== null && typeof v === 'object' && !Array.isArray(v))) {
      const keys = new Set(present.flatMap((v) => Object.keys(v as object)));
      const out: Record<string, unknown> = {};
      for (const k of keys) out[k] = sum(present.map((v) => (v as Record<string, unknown>)[k]).map((v) => (v === undefined ? 0 : v)));
      return out;
    }
    return present[0];
  };
  return sum([...values]) as T;
}

/** One campaign's figures from its reads (pure). */
export function campaignFigures(
  activity: Pick<AgencyInsightsActivity, 'calls' | 'callbacks'>,
  dayRows: ReadonlyArray<Pick<InsightsTrendRow, 'abandoned' | 'answered'>>,
  health: Pick<AgencyInsightsHealth, 'recording'>,
): AccountReportFigures {
  const abandoned = dayRows.reduce((s, b) => s + b.abandoned, 0);
  const answered = dayRows.reduce((s, b) => s + b.answered, 0);
  return {
    calls: activity.calls,
    callbacks_booked: activity.callbacks.booked,
    abandoned,
    answered,
    abandoned_pct: ratePct(abandoned, answered),
    recording_connected: health.recording.connected,
    recorded: health.recording.recorded,
  };
}

/** The account's totals: every count summed, the rate worked out again from the sums (pure). */
export function totalFigures(rows: readonly AccountReportFigures[]): AccountReportFigures {
  const summed = sumCounts(rows.map(({ abandoned_pct: _rate, ...counts }) => counts));
  const zero: Omit<AccountReportFigures, 'abandoned_pct'> = {
    calls: {
      dials: 0, connected: 0, human_connects: 0, conversations: 0, successes: 0,
      by_outcome: { null_outcome: 0 } as AccountReportFigures['calls']['by_outcome'],
      redials: { placed: 0, connected: 0, chains_at_limit: 0, refused_at_limit: 0 },
      agent_retries: { reopened_dials: 0, reopened_connected: 0, manual_dials: 0, manual_connected: 0 },
      softphone_calls: 0, talk_seconds: 0, wrapup_seconds: 0, wrapup_measured: 0,
    },
    callbacks_booked: 0, abandoned: 0, answered: 0, recording_connected: 0, recorded: 0,
  };
  const counts = summed ?? zero;
  return { ...counts, abandoned_pct: ratePct(counts.abandoned, counts.answered) };
}

/** The account's days: every date of the window, the campaigns' day rows summed on it (pure). */
export function accountDaily(dates: readonly string[], perCampaign: ReadonlyArray<ReadonlyArray<InsightsTrendRow>>): AccountReportDailyRow[] {
  const byDate = new Map<string, AccountReportDailyRow>(dates.map((date) => [date, {
    date, dials: 0, first_dials: 0, connected: 0, conversations: 0, human_connects: 0, successes: 0, agents_online_peak: null,
  }]));
  for (const rows of perCampaign) {
    for (const b of rows) {
      const day = byDate.get(b.bucket_start);
      if (!day) continue;
      day.dials += b.dials;
      day.first_dials += b.first_dials;
      day.connected += b.connected;
      day.conversations += b.conversations;
      day.human_connects += b.human_connects;
      day.successes += b.successes;
    }
  }
  return [...byDate.values()];
}

/** The health row of one campaign (pure). */
export function healthRow(campaignId: string, health: AgencyInsightsHealth): AccountReportHealthRow {
  return {
    campaign_id: campaignId,
    auto_pauses: health.abandonment.auto_pauses.length,
    stall_minutes_by_reason: health.stalls.minutes_by_reason,
    concurrency_limit_minutes: health.concurrency_limit_minutes,
    carrier_failures: health.carrier_failures,
    our_fault_retired: health.our_fault_retired,
    predial_blocks: health.predial_blocks,
  };
}

/** The covered campaigns of a run, by name. */
async function coveredCampaigns(run: Parameters<ReportDatasetBuilder>[0]['run'], accountId: string): Promise<AgencyCampaignRecord[]> {
  const ids = run.campaign_ids && run.campaign_ids.length > 0
    ? run.campaign_ids
    : await agencyReportDatasetRepository.accountCoveredCampaignIds({
      tenantId: run.tenant_id, accountId, from: run.range_from, to: run.range_to,
    });
  const found = await campaignsByIds(ids, run.tenant_id);
  const out: AgencyCampaignRecord[] = [];
  for (const id of new Set(ids)) {
    const c = found.get(id);
    if (!c || c.account_id !== accountId) {
      throw new ReportSubjectUnavailableError('a campaign the report covers is no longer in its account');
    }
    out.push(c);
  }
  return out.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

export const buildAccountReport: ReportDatasetBuilder<'account'> = async ({ run, now }) => {
  const accountId = run.account_id;
  if (!accountId || run.subject_id !== accountId) throw new ReportSubjectUnavailableError('an account report is about its own account');
  const [tenancy, campaigns, roster] = await Promise.all([
    runTenancy(run),
    coveredCampaigns(run, accountId),
    readAccountRoster({ tenantId: run.tenant_id, accountId, from: run.range_from, to: run.range_to, includeInactive: false }),
  ]);
  const zone = await resolveReportZone(run.timezone);

  const reads = await mapLimit(campaigns, ACCOUNT_CAMPAIGN_CONCURRENCY, async (campaign) => {
    const range = insightsRangeFor(campaign, run, now);
    const [activity, health, days] = await Promise.all([
      computeActivity(campaign, range, { now }).then(wire),
      computeHealth(campaign, range, { now }).then(wire),
      agencyInsightsRollupRepository.trends({
        campaignId: campaign.id, tenantId: campaign.tenant_id, from: range.from, to: range.to,
        bucket: 'day', timezone: zone, successCodes: successCodes(campaign.disposition_catalog),
      }),
    ]);
    if (!days) throw new ReportSubjectUnavailableError('a campaign the report covers left its tenant');
    return { campaign, activity, health, days: days.buckets, pending: activity.pending_buckets + health.pending_buckets };
  });

  const rows: AccountReportCampaignRow[] = reads.map(({ campaign, activity, health, days }) => ({
    id: campaign.id,
    name: campaign.name,
    status: campaign.status,
    timezone: campaignZone(campaign.default_timezone),
    ...campaignFigures(activity, days, health),
  }));
  const figures = rows.map(({ id: _id, name: _name, status: _status, timezone: _tz, ...f }) => f);

  const notes = [
    `Days run from midnight to midnight in ${run.timezone}, worked out from the quarter-hour counts; each campaign's own Insights page cuts its days in the campaign's time zone.`,
    'Totals add up the campaigns\' counts; every rate of the totals is worked out again from those sums.',
    'The agent table covers all of the account\'s campaigns, whichever campaigns this report lists.',
    'Successes follow each campaign\'s current outcome list, so an outcome reclassified since applies to earlier calls too.',
    'Agents online at the busiest moment of each day are not measured across campaigns, so the day table leaves them out.',
    ...(reads.some((r) => r.pending > 0) ? ['Some of the window\'s most recent calls were still being counted when this report was made.'] : []),
    ...(run.range_to.getTime() > now.getTime() ? ['The window runs past the time this report was made; later calls are not included.'] : []),
    ...(campaigns.length === 0 ? ['No campaign of this account placed a call in the window.'] : []),
  ];

  const dataset: Omit<AccountReportDataset, 'detail_files'> = {
    dataset_version: REPORT_DATASET_VERSION,
    run_id: run.id,
    kind: 'account',
    audience: 'supervisor',
    generated_at: now.toISOString(),
    range: reportRange(run),
    tenant: tenancy.tenant,
    account: tenancy.account,
    subject: { id: tenancy.account.id, name: tenancy.account.name || tenancy.account.id },
    definitions: accountDefinitions(),
    notes,
    campaigns: rows,
    totals: totalFigures(figures),
    agents: roster.rows,
    benchmark: roster.benchmark,
    daily: accountDaily(localDates(run.local_from, run.local_to), reads.map((r) => r.days)),
    health: reads.map(({ campaign, health }) => healthRow(campaign.id, health)),
    floors: {
      campaign_rate_min_first_dials: AGENCY_INSIGHTS_MIN_RATE_DENOMINATOR,
      agent_rate_min_first_dials: AGENCY_ROSTER_MIN_RATE_DENOMINATOR,
    },
  };

  return {
    dataset,
    details: [
      attemptsSource(
        { campaignIds: campaigns.map((c) => c.id), tenantId: run.tenant_id, from: run.range_from, to: run.range_to },
        new Map(campaigns.map((c) => [c.id, c])),
        true,
      ),
    ],
  };
};
