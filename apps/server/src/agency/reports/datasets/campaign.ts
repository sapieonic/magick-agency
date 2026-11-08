/**
 * The campaign report's builder (`kind: 'campaign'`, `CampaignReportDataset`, supervisor only):
 * the campaign Insights tab's four reads over the run's window, verbatim (RP1):
 *
 *  - `summary`: `computeSummary` with the stats strip read through the internal handler
 *    (`liveStats`, the summary route's own), as of `generated_at`;
 *  - `activity`, `trends` (`bucket: 'day'`), `health`: `computeActivity`, `computeTrends`,
 *    `computeHealth` over the range the Insights range routes serve for the window
 *    (`insightsRangeFor`: their parser, so the same buckets);
 *  - `agent_names`: every agent id the four objects carry, through the name resolver the
 *    Insights reads use (`agentNamesOrNone`).
 *
 * The four are computed directly, not through the routes' cache, so a report never carries an
 * answer cached for someone else's request.
 *
 * Detail sheets: `attempts` (every placed dial of the campaign in the window, phone numbers in
 * full: a campaign report is the supervisor's) and `sessions` (every agent session on it
 * overlapping the window).
 */
import { AGENCY_INSIGHTS_MIN_RATE_DENOMINATOR } from '@magick-agency/contracts/api/agency/insights';
import type { AgencyCampaignStats } from '@magick-agency/contracts/agency';
import { REPORT_DATASET_VERSION, type CampaignReportDataset } from '@magick-agency/contracts/reports';
import { createChildLogger } from '@magick-agency/observability';
import type { AgencyCampaignRecord } from '../../../db/models/agency.model.js';
import {
  agencyCampaignRepository,
  campaignAttemptsStatement,
  campaignSessionsStatement,
  reportCursorRows,
  type ReportAttemptRow,
  type ReportSessionDetailRow,
} from '../../../db/repositories/agency.repository.js';
import { agentNamesOrNone } from '../../agency-agent-identity.js';
import { computeActivity } from '../../insights/activity.js';
import { computeHealth } from '../../insights/health.js';
import { liveStats } from '../../../api/routes/helpers/live-stats.js';
import { campaignZone } from '../../insights/range.js';
import { computeSummary } from '../../insights/summary.js';
import { computeTrends } from '../../insights/trends.js';
import { sessionCells, sessionColumns } from './agent.js';
import { campaignDefinitions } from './definitions.js';
import {
  col,
  commonNotes,
  dispositionLabel,
  insightsRangeFor,
  instantCell,
  outcomeLabel,
  reportRange,
  runTenancy,
  secondsCell,
  wire,
  withAgentNames,
} from './shared.js';
import { ReportSubjectUnavailableError, ReportZoneChangedError, type ReportDatasetBuilder, type ReportDetailSource } from './types.js';

const log = createChildLogger({ component: 'report-datasets' });

/**
 * Every agent id under an `agent_user_id` or `user_id` key, or in `never_joined`, anywhere in
 * the values (pure): the ids `agent_names` must cover.
 */
export function agentIdsIn(...values: unknown[]): string[] {
  const out = new Set<string>();
  const walk = (v: unknown, key: string | null): void => {
    if (typeof v === 'string') {
      if (key === 'agent_user_id' || key === 'user_id' || key === 'never_joined') out.add(v);
      return;
    }
    if (Array.isArray(v)) {
      for (const item of v) walk(item, key === 'never_joined' ? key : null);
      return;
    }
    if (v && typeof v === 'object') for (const [k, item] of Object.entries(v)) walk(item, k);
  };
  for (const v of values) walk(v, null);
  return [...out];
}

/** The campaign of a run, in its tenant and account, or the subject is unavailable. */
export async function runCampaign(campaignId: string, tenantId: string, accountId: string | null): Promise<AgencyCampaignRecord> {
  const campaign = await agencyCampaignRepository.findById(campaignId);
  if (!campaign || campaign.tenant_id !== tenantId || campaign.account_id !== accountId) {
    throw new ReportSubjectUnavailableError('the campaign no longer exists in the report\'s account');
  }
  return campaign;
}

/** The summary's stats strip read, degrading to null as the summary route's own refusal does. */
async function summaryLiveStats(campaign: AgencyCampaignRecord): Promise<Partial<AgencyCampaignStats> | null> {
  try {
    return await liveStats(campaign);
  } catch (err) {
    log.warn({ campaignId: campaign.id, err: err instanceof Error ? err.message : String(err) },
      'report campaign summary: the stats strip read failed; the summary reports what it reads itself');
    return null;
  }
}

export const buildCampaignReport: ReportDatasetBuilder<'campaign'> = async ({ run, now }) => {
  const [tenancy, campaign] = await Promise.all([
    runTenancy(run),
    runCampaign(run.subject_id, run.tenant_id, run.account_id),
  ]);
  // The run's window was cut in the campaign's zone when it was requested (RP3); the Insights day
  // buckets are cut in the zone the campaign has NOW. A zone changed in between would serve
  // `range` in one zone and `trends` in the other (and break `campaign.timezone ===
  // range.timezone`), so the run fails (`assembly_failed`: the campaign is still there) and the
  // next run, or a re-run, is cut in the new zone.
  if (campaignZone(campaign.default_timezone) !== run.timezone) {
    throw new ReportZoneChangedError('The campaign\'s time zone changed after this report was requested; run it again.');
  }
  const range = insightsRangeFor(campaign, run, now);
  const dayRange = insightsRangeFor(campaign, run, now, 'day');
  const [summary, activity, trends, health] = await Promise.all([
    computeSummary(campaign, { liveStats: () => summaryLiveStats(campaign) }),
    computeActivity(campaign, range, { now }),
    computeTrends(campaign, { ...dayRange, bucket: 'day' }, { now }),
    computeHealth(campaign, range, { now }),
  ].map((p) => p.then(wire)) as [
    ReturnType<typeof computeSummary>, ReturnType<typeof computeActivity>, ReturnType<typeof computeTrends>, ReturnType<typeof computeHealth>,
  ]);

  const ids = agentIdsIn(summary, activity, trends, health);
  // Also the detail sheets' first names: they look up only the agents these do not cover.
  const names = await agentNamesOrNone(ids, run.tenant_id, 'report campaign');
  const agentNames: Record<string, string | null> = {};
  for (const id of ids.sort()) agentNames[id] = names.get(id) ?? null;

  const notes = [
    `The summary describes the campaign as it was when this report was made (${now.toISOString()}), not over the window.`,
    `Days run from midnight to midnight in the campaign's time zone, ${run.timezone}.`,
    'Successes and outcome labels follow the campaign\'s current outcome list, so an outcome renamed or reclassified since applies to earlier calls too.',
    'Best hours are counted in each contact\'s own time zone.',
    ...commonNotes({
      pending: activity.pending_buckets > 0 || trends.pending_buckets > 0 || health.pending_buckets > 0,
      future: run.range_to.getTime() > now.getTime(),
      later: 'calls',
    }),
  ];

  const dataset: Omit<CampaignReportDataset, 'detail_files'> = {
    dataset_version: REPORT_DATASET_VERSION,
    run_id: run.id,
    kind: 'campaign',
    audience: 'supervisor',
    generated_at: now.toISOString(),
    range: reportRange(run),
    tenant: tenancy.tenant,
    account: tenancy.account,
    subject: { id: campaign.id, name: campaign.name || campaign.id },
    definitions: campaignDefinitions(),
    notes,
    campaign: { id: campaign.id, name: campaign.name, status: campaign.status, timezone: campaignZone(campaign.default_timezone) },
    summary,
    activity,
    trends,
    health,
    agent_names: agentNames,
    floors: { campaign_rate_min_first_dials: AGENCY_INSIGHTS_MIN_RATE_DENOMINATOR },
  };

  const campaigns = new Map([[campaign.id, campaign]]);
  return {
    dataset,
    details: [
      attemptsSource({ campaignIds: [campaign.id], tenantId: run.tenant_id, from: run.range_from, to: run.range_to }, campaigns, false, names),
      campaignSessionsSource(campaign, run.range_from, run.range_to, names),
    ],
  };
};

/** The attempts sheet's columns: the campaign column only when several campaigns share the sheet. */
export function attemptColumns(withCampaign: boolean): ReportDetailSource['columns'] {
  return [
    col('dialed_at', 'Dialled', 'datetime'),
    ...(withCampaign ? [col('campaign', 'Campaign', 'text')] : []),
    col('agent', 'Agent', 'text'),
    col('phone', 'Phone', 'text'),
    col('result', 'Result', 'text'),
    col('outcome_code', 'Outcome code', 'text'),
    col('outcome', 'Outcome', 'text'),
    col('talk_s', 'Talk', 'duration_s'),
    col('wrapup_s', 'Wrap-up', 'duration_s'),
    col('caller_id', 'Caller ID', 'text'),
    col('redial', 'Redial', 'int'),
    col('callback_at', 'Callback', 'datetime'),
  ];
}

/**
 * Every placed attempt of the campaigns in the window, oldest first, with each agent's name
 * (`withAgentNames`: the builder's `knownNames` first, then one lookup per batch of new ids; a
 * name only improves on the id).
 */
export function attemptsSource(
  q: { campaignIds: string[]; tenantId: string; from: Date; to: Date },
  campaigns: ReadonlyMap<string, AgencyCampaignRecord>,
  withCampaign: boolean,
  knownNames?: ReadonlyMap<string, string | null>,
): ReportDetailSource {
  return {
    sheet: 'attempts',
    label: 'Call attempts',
    columns: attemptColumns(withCampaign),
    async *rows() {
      const { text, values } = campaignAttemptsStatement(q);
      const named = withAgentNames(reportCursorRows<ReportAttemptRow>(text, values), (r) => r.agent_user_id, {
        tenantId: q.tenantId, surface: 'report attempts', ...(knownNames ? { known: knownNames } : {}),
      });
      for await (const [r, agentName] of named) {
        const campaign = campaigns.get(r.campaign_id);
        yield [
          instantCell(r.dialed_at),
          ...(withCampaign ? [campaign?.name ?? r.campaign_id] : []),
          r.agent_user_id === null ? null : agentName ?? r.agent_user_id,
          r.phone,
          outcomeLabel(r.outcome),
          r.disposition_code,
          r.disposition_code === null ? null : dispositionLabel(r.disposition_code, campaign?.disposition_catalog),
          secondsCell(r.talk_s),
          secondsCell(r.wrapup_s),
          r.caller_id,
          Number(r.redial_number),
          instantCell(r.callback_at),
        ];
      }
    },
  };
}

function campaignSessionsSource(
  campaign: AgencyCampaignRecord,
  from: Date,
  to: Date,
  knownNames: ReadonlyMap<string, string | null>,
): ReportDetailSource {
  return {
    sheet: 'sessions',
    label: 'Sessions',
    columns: [col('agent', 'Agent', 'text'), ...sessionColumns()],
    async *rows() {
      const { text, values } = campaignSessionsStatement({ campaignId: campaign.id, tenantId: campaign.tenant_id, from, to });
      const named = withAgentNames(reportCursorRows<ReportSessionDetailRow>(text, values), (r) => r.agent_user_id, {
        tenantId: campaign.tenant_id, surface: 'report sessions', known: knownNames,
      });
      for await (const [r, agentName] of named) yield sessionCells(r, true, agentName ?? r.agent_user_id);
    },
  };
}
