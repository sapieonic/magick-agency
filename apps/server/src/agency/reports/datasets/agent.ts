/**
 * The agent performance review's builder (`kind: 'agent'`, `AgentReviewDataset`): one agent
 * across every campaign of the run's account over `[range_from, range_to)`. docs/reports.md
 * "Datasets" lists each block's source; the rule is RP1, a figure the screens serve is read by
 * the screens' own code:
 *
 *  - `record`, `per_campaign`: the agent record's read (`agencyAgentStatsRepository.stats`, what
 *    `GET /proxy/agency/agents/:userId/stats` and `/my-stats` serve through the internal handler),
 *    with the handler's own query parser, over the run's window.
 *  - `roster_row`, `benchmark`: the roster screen's read for the window (`readAccountRoster`, the
 *    handler read plus the route's membership scope and names), the agent's row picked out of it
 *    (departed agents kept, so a supervisor can still review someone who left). The benchmark is
 *    null for the `self` audience (RP5).
 *  - `occupancy` (RP11): the roster row's `occupancy_pct`, and on-call ÷ shift from the record's
 *    occupancy block, with and without breaks.
 *  - `presence`, `daily`, `timeline`: the agent's state intervals (the shared occupancy
 *    intervals) cut into local days of `range.timezone` (`agent-presence.ts`), joined to the
 *    agent's attempts by local day (the record's counters, so the days sum to `record`).
 *  - `outcomes`: conversations by disposition code; labels from each campaign's CURRENT catalog.
 *  - `follow_through`: IN4's callback classes over the callbacks the agent booked, the rollup's
 *    redial, retry and override measures over their attempts, their Do Not Call marks and
 *    soft-phone calls.
 *  - `quality` (supervisor only): analysed calls by overall sentiment, one count per label the
 *    analysis emits (positive, neutral, negative, mixed).
 *
 * Detail sheets: `sessions`, `state_log`, `calls`, streamed through server-side cursors; the
 * `self` calls sheet has phone numbers masked to the last four digits (RP7) and no recording or
 * sentiment column (RP5).
 */
import {
  AGENCY_DEFAULT_DISPOSITION_CATALOG,
  AGENCY_ROSTER_MIN_RATE_DENOMINATOR,
  type AgencyDisposition,
} from '@magick-agency/contracts/agency';
import { REPORT_DATASET_VERSION, type AgentReviewDataset, type AgentReviewOutcomeRow, type ReportCampaignRef } from '@magick-agency/contracts/reports';
import type { AgencyAgentStatsTotals } from '@magick-agency/contracts/api/agency/agency-stats';
import { ratePct, ratio } from '@magick-agency/domain/rates';
import { membershipRepository } from '@magick-agency/db/repositories/membership.repository';
import type { AgencyCampaignRecord } from '../../../db/models/agency.model.js';
import {
  agencyAgentStatsRepository,
  agencyReportDatasetRepository,
  agencySoftphoneSettingsRepository,
  agentCallsStatement,
  agentSessionsStatement,
  agentStateLogStatement,
  reportCursorRows,
  type ReportAgentAttemptDayRow,
  type ReportAgentCallRow,
  type ReportAgentScope,
  type ReportSessionDetailRow,
  type ReportStateLogRow,
} from '../../../db/repositories/agency.repository.js';
import { parseAgentStatsQuery } from '../../agent-record.js';
import { agentNamesOrNone } from '../../agency-agent-identity.js';
import { campaignZone } from '../../insights/range.js';
import { buildTimeline, dailyRows, foldPresence } from './agent-presence.js';
import { agentDefinitions } from './definitions.js';
import {
  CLIENT_KIND_LABELS,
  SESSION_KIND_LABELS,
  STATE_LABELS,
  breakReasonLabel,
  campaignsByIds,
  col,
  commonNotes,
  dispositionLabel,
  instantCell,
  localDays,
  maskPhone,
  outcomeLabel,
  readAccountRoster,
  reportRange,
  resolveReportZone,
  roundPreservingSum,
  runTenancy,
  secondsCell,
  wire,
} from './shared.js';
import { ReportSubjectUnavailableError, type ReportDatasetBuilder, type ReportDetailSource } from './types.js';

/** RP11's three readings, from the roster row and the record (pure). */
export function occupancyReadings(handlingPct: number | null | undefined, record: Pick<AgencyAgentStatsTotals, 'occupancy'>): AgentReviewDataset['occupancy'] {
  const occ = record.occupancy;
  const shift = occ?.shift_seconds ?? 0;
  const onCall = occ?.by_state?.on_call ?? 0;
  const breaks = occ?.by_state?.break ?? 0;
  return {
    handling_pct: handlingPct ?? null,
    on_call_pct: ratePct(onCall, shift),
    on_call_pct_excl_break: ratePct(onCall, shift - breaks),
  };
}

/** The outcome rows, largest first (then by label), with shares and average talk (pure). */
export function outcomeRows(
  rows: ReadonlyArray<{ code: string | null; conversations: number; successes: number; talk_seconds: number }>,
  labelOf: (code: string | null) => string,
): AgentReviewOutcomeRow[] {
  const total = rows.reduce((s, r) => s + r.conversations, 0);
  return rows
    .filter((r) => r.conversations > 0)
    .map((r) => {
      const avg = ratio(r.talk_seconds, r.conversations);
      return {
        code: r.code,
        label: labelOf(r.code),
        is_success: r.successes > 0,
        conversations: r.conversations,
        share_pct: ratePct(r.conversations, total),
        avg_talk_s: avg === null ? null : Math.round(avg),
      };
    })
    .sort((a, b) => b.conversations - a.conversations || a.label.localeCompare(b.label));
}

/**
 * Sentiment counts, one per label the call analysis emits (`SentimentLabel`; `mixed` is its own
 * count). The read already keeps only those labels (`agentSentiment`); a row with any other label
 * is not an analysed call here and is left out, never counted as one of the four (pure).
 */
export function sentimentBlock(rows: ReadonlyArray<{ label: string; calls: number }>): AgentReviewDataset['quality'] {
  const out: NonNullable<AgentReviewDataset['quality']>['sentiment'] = { positive: 0, neutral: 0, negative: 0, mixed: 0 };
  for (const r of rows) {
    if (Object.hasOwn(out, r.label)) out[r.label as keyof typeof out] += r.calls;
  }
  const analysed = out.positive + out.neutral + out.negative + out.mixed;
  return analysed === 0 ? null : { analysed_calls: analysed, sentiment: out };
}

/** The first label any of the campaigns' catalogs gives a code. */
function labelAcross(catalogs: ReadonlyArray<readonly AgencyDisposition[]>, code: string | null): string {
  if (code !== null) {
    for (const catalog of catalogs) {
      if (catalog.some((d) => d && d.code === code)) return dispositionLabel(code, catalog);
    }
  }
  return dispositionLabel(code, null);
}

export const buildAgentReview: ReportDatasetBuilder<'agent'> = async ({ run, now }) => {
  const agentUserId = run.subject_id;
  const accountId = run.account_id;
  if (!accountId) throw new ReportSubjectUnavailableError('an agent review needs an account');
  const supervisor = run.audience === 'supervisor';

  // The subject: a membership in this account or tenant-wide. A supervisor may review an agent
  // who has left (any status, as on the agent record's route); an agent's own (`self`) review
  // needs their membership to be active still: a removed member's self run is unavailable.
  const [tenancy, memberships, zone] = await Promise.all([
    runTenancy(run),
    membershipRepository.findAnyByUserAndTenant(agentUserId, run.tenant_id),
    resolveReportZone(run.timezone),
  ]);
  const inAccount = memberships.filter((m) => m.account_id === null || m.account_id === accountId);
  if (inAccount.length === 0) {
    throw new ReportSubjectUnavailableError('the agent is not a member of the report\'s account');
  }
  if (!supervisor && !inAccount.some((m) => m.status === 'active')) {
    throw new ReportSubjectUnavailableError('the agent is no longer an active member of the report\'s account');
  }

  const scope: ReportAgentScope = { agentUserId, tenantId: run.tenant_id, accountId, from: run.range_from, to: run.range_to };
  const statsQuery = parseAgentStatsQuery({ from: run.range_from.toISOString(), to: run.range_to.toISOString(), bucket: 'day' });
  if (!statsQuery.ok) throw new Error(`agent record window refused: ${statsQuery.issues.map((i) => `${i.param} ${i.message}`).join('; ')}`);

  const [stats, roster, intervals, attemptDays, outcomeCounts, callbacks, dncMarked, softphoneCalls, sentiment, names, softphoneSettings] = await Promise.all([
    agencyAgentStatsRepository.stats({ tenantId: run.tenant_id, accountId, agentUserId }, statsQuery.filters).then(wire),
    readAccountRoster({ tenantId: run.tenant_id, accountId, from: run.range_from, to: run.range_to, includeInactive: true }),
    agencyReportDatasetRepository.agentStateIntervals(scope),
    agencyReportDatasetRepository.agentAttemptDays({ ...scope, timezone: zone }),
    agencyReportDatasetRepository.agentOutcomes(scope),
    agencyReportDatasetRepository.agentCallbackTiming({ ...scope, now }),
    agencyReportDatasetRepository.agentDncMarked(scope),
    agencyReportDatasetRepository.agentSoftphoneCalls(scope),
    supervisor ? agencyReportDatasetRepository.agentSentiment(scope) : Promise.resolve([]),
    agentNamesOrNone([agentUserId], run.tenant_id, 'report agent review'),
    agencySoftphoneSettingsRepository.get(run.tenant_id, accountId),
  ]);

  const campaignIds = [...new Set([
    ...stats.by_campaign.map((c) => c.campaign_id),
    ...intervals.map((i) => i.campaign_id).filter((id): id is string => id !== null),
  ])];
  const campaigns = await campaignsByIds(campaignIds, run.tenant_id);
  const catalogs = [...campaigns.values()].map((c) => (Array.isArray(c.disposition_catalog) ? c.disposition_catalog : []));
  const nameOf = (id: string) => campaigns.get(id)?.name ?? id;

  // ── Time and the days ──
  const days = localDays(run.local_from, run.local_to, run.timezone);
  const presence = foldPresence(intervals, days);
  const daily = dailyRows(presence.days, attemptDays);
  const clipEnd = new Date(Math.min(run.range_to.getTime(), now.getTime()));
  const breakCatalogs = [...campaigns.values()].map((c) => c.break_reasons);
  const sum = (k: Exclude<keyof ReportAgentAttemptDayRow, 'date'>) => attemptDays.reduce((s, a) => s + a[k], 0);

  const rosterRow = roster.rows.find((r) => r.agent_user_id.toLowerCase() === agentUserId.toLowerCase()) ?? null;
  const record = stats.totals;
  const softphoneCatalog = softphoneSettings.disposition_catalog.length > 0
    ? softphoneSettings.disposition_catalog
    : [...AGENCY_DEFAULT_DISPOSITION_CATALOG];

  const campaignRefs: ReportCampaignRef[] = campaignIds
    .filter((id) => campaigns.has(id))
    .map((id) => ({ id, name: nameOf(id), timezone: campaignZone(campaigns.get(id)!.default_timezone) }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const stationSeconds = presence.by_state.available + presence.by_state.on_call + presence.by_state.wrapup + presence.by_state.break;
  const notes = agentNotes({
    supervisor,
    timezone: run.timezone,
    stationSeconds,
    recordShiftSeconds: record.occupancy?.shift_seconds ?? 0,
    rosterRow: rosterRow !== null,
    future: run.range_to.getTime() > now.getTime(),
  });

  const agentName = names.get(agentUserId) ?? agentUserId;
  const dataset: Omit<AgentReviewDataset, 'detail_files'> = {
    dataset_version: REPORT_DATASET_VERSION,
    run_id: run.id,
    kind: 'agent',
    audience: run.audience,
    generated_at: now.toISOString(),
    range: reportRange(run),
    tenant: tenancy.tenant,
    account: tenancy.account,
    subject: { id: agentUserId, name: agentName },
    definitions: agentDefinitions(run.audience),
    notes,
    agent: { user_id: agentUserId, name: agentName },
    campaigns: campaignRefs,
    record,
    roster_row: rosterRow,
    benchmark: supervisor ? roster.benchmark : null,
    occupancy: occupancyReadings(rosterRow?.occupancy_pct, record),
    presence: {
      days_worked: daily.filter((x) => x.station_s > 0).length,
      station_seconds: stationSeconds,
      by_state: presence.by_state,
      break_by_reason: [...presence.break_by_reason]
        .filter(([, seconds]) => seconds > 0)
        .map(([reason, seconds]) => ({ reason, label: breakReasonLabel(reason, breakCatalogs), seconds }))
        .sort((a, b) => b.seconds - a.seconds || a.reason.localeCompare(b.reason)),
      drops: daily.reduce((s, x) => s + x.drops, 0),
    },
    daily,
    timeline: buildTimeline(intervals, days, daily, clipEnd),
    outcomes: outcomeRows(outcomeCounts, (code) => labelAcross(catalogs, code)),
    per_campaign: stats.by_campaign.map((c) => ({ ...c, campaign_name: nameOf(c.campaign_id) })),
    follow_through: {
      callbacks: {
        booked: sum('callbacks_booked'),
        on_time: callbacks.on_time,
        late: callbacks.late,
        missed: callbacks.missed,
        pending_future: callbacks.pending_future,
        pending_due: callbacks.pending_due,
      },
      redials_placed: sum('redials_placed'),
      redials_connected: sum('redials_connected'),
      agent_retries: sum('reopened_dials') + sum('manual_dials'),
      overrides_used: sum('overrides_used'),
      dnc_marked: dncMarked,
      softphone_calls: softphoneCalls,
    },
    quality: supervisor ? sentimentBlock(sentiment) : null,
    floors: { agent_rate_min_first_dials: AGENCY_ROSTER_MIN_RATE_DENOMINATOR },
  };

  return {
    dataset,
    details: [
      agentSessionsSource(scope),
      agentStateLogSource(scope, breakCatalogs),
      agentCallsSource(scope, supervisor, campaigns, softphoneCatalog),
    ],
  };
};

/** The agent review's notes, in print order (pure). */
export function agentNotes(o: {
  supervisor: boolean;
  timezone: string;
  /** `presence.station_seconds`: the logged-in time the report itself measured. */
  stationSeconds: number;
  /** `record.occupancy.shift_seconds`, 0 when the record served no occupancy (a degraded read). */
  recordShiftSeconds: number;
  rosterRow: boolean;
  future: boolean;
}): string[] {
  const notes = [
    'Time comes from recorded state changes: a session with no recorded changes shows no time.',
    'Reserved time (a call being connected to the agent) counts as available.',
    'Only this account\'s sessions and calls are counted.',
    'Outcome labels and successes follow each campaign\'s current outcome list, so an outcome renamed or reclassified since applies to earlier calls too.',
    `Days run from midnight to midnight in ${o.timezone}. The agent's record page cuts each campaign's calls in that campaign's time zone, so a call near midnight can fall on a different day there.`,
  ];
  if (o.stationSeconds === 0) {
    notes.push('No state changes were recorded for this agent in the window, so occupancy is not measured.');
  } else if (o.recordShiftSeconds === 0) {
    // The report measured logged-in time but the agent record's occupancy read served none.
    notes.push('The agent record\'s occupancy was unavailable for this run, so the on-call shares are not shown; logged-in time and the days are measured.');
  }
  if (!o.rosterRow) notes.push('The agent placed no dials in the window, so there is no floor row for them.');
  notes.push(...commonNotes({ future: o.future, later: 'time' }));
  if (!o.supervisor) notes.push('This copy is the agent\'s own: it leaves out the floor comparison and call analysis, and shows phone numbers to the last four digits.');
  return notes;
}

// ── Detail sources ──

/** A sessions sheet's columns (the campaign's adds the agent in front). */
export function sessionColumns(): ReportDetailSource['columns'] {
  return [
    col('joined_at', 'Joined', 'datetime'),
    col('left_at', 'Left', 'datetime'),
    col('campaign', 'Campaign', 'text'),
    col('kind', 'Session', 'text'),
    col('client', 'App', 'text'),
    col('logged_in_s', 'Logged in', 'duration_s'),
    col('available_s', 'Available', 'duration_s'),
    col('on_call_s', 'On a call', 'duration_s'),
    col('wrapup_s', 'Wrap-up', 'duration_s'),
    col('break_s', 'Break', 'duration_s'),
    col('dials', 'Dials', 'int'),
    col('drops', 'Dropped calls', 'int'),
  ];
}

function agentSessionsSource(scope: ReportAgentScope): ReportDetailSource {
  return {
    sheet: 'sessions',
    label: 'Sessions',
    columns: sessionColumns(),
    async *rows() {
      const { text, values } = agentSessionsStatement(scope);
      for await (const r of reportCursorRows<ReportSessionDetailRow>(text, values)) yield sessionCells(r, false);
    },
  };
}

/** One session's cells; `withAgent` puts the agent's name first (the campaign sheet). */
export function sessionCells(r: ReportSessionDetailRow, withAgent: false): unknown[];
export function sessionCells(r: ReportSessionDetailRow, withAgent: true, agentName: string | null): unknown[];
export function sessionCells(r: ReportSessionDetailRow, withAgent: boolean, agentName?: string | null): unknown[] {
  // Logged in is the session's total rounded once; the state parts are rounded so they add up to it.
  const seconds = (v: unknown) => (Number.isFinite(Number(v ?? 0)) ? Number(v ?? 0) : 0);
  const [available, onCall, wrapup, brk] = roundPreservingSum([r.available_s, r.on_call_s, r.wrapup_s, r.break_s].map(seconds)) as [number, number, number, number];
  const cells = [
    instantCell(r.joined_at),
    instantCell(r.left_at),
    r.kind === 'softphone' ? SESSION_KIND_LABELS['softphone'] : r.campaign_name,
    SESSION_KIND_LABELS[r.kind] ?? r.kind,
    r.client_kind === null ? null : CLIENT_KIND_LABELS[r.client_kind] ?? r.client_kind,
    available + onCall + wrapup + brk,
    available, onCall, wrapup, brk,
    Number(r.dials ?? 0),
    Number(r.drops ?? 0),
  ];
  return withAgent ? [agentName ?? null, ...cells] : cells;
}

function agentStateLogSource(scope: ReportAgentScope, breakCatalogs: ReadonlyArray<AgencyCampaignRecord['break_reasons']>): ReportDetailSource {
  return {
    sheet: 'state_log',
    label: 'State log',
    columns: [
      col('started_at', 'From', 'datetime'),
      col('ended_at', 'To', 'datetime'),
      col('state', 'State', 'text'),
      col('break_reason', 'Break reason', 'text'),
      col('campaign', 'Campaign', 'text'),
      col('seconds', 'Duration', 'duration_s'),
    ],
    async *rows() {
      const { text, values } = agentStateLogStatement(scope);
      for await (const r of reportCursorRows<ReportStateLogRow>(text, values)) {
        yield [
          instantCell(r.started),
          instantCell(r.ended),
          STATE_LABELS[r.state] ?? r.state,
          r.state === 'break' ? breakReasonLabel(r.break_reason ?? 'unspecified', breakCatalogs) : null,
          r.kind === 'softphone' ? SESSION_KIND_LABELS['softphone'] : r.campaign_name,
          secondsCell(r.seconds),
        ];
      }
    },
  };
}

/** The calls sheet's columns for an audience: `self` has no recording or sentiment column (RP5). */
export function agentCallColumns(supervisor: boolean): ReportDetailSource['columns'] {
  return [
    col('dialed_at', 'Dialled', 'datetime'),
    col('type', 'Type', 'text'),
    col('campaign', 'Campaign', 'text'),
    col('phone', 'Phone', 'text'),
    col('result', 'Result', 'text'),
    col('outcome_code', 'Outcome code', 'text'),
    col('outcome', 'Outcome', 'text'),
    col('talk_s', 'Talk', 'duration_s'),
    col('wrapup_s', 'Wrap-up', 'duration_s'),
    col('redial', 'Redial', 'int'),
    col('callback_at', 'Callback', 'datetime'),
    ...(supervisor ? [col('recorded', 'Recorded', 'bool'), col('sentiment', 'Sentiment', 'text')] : []),
  ];
}

/** One call's cells for an audience (pure): `self` masks the phone (RP7) and drops the analysis columns. */
export function agentCallCells(
  r: ReportAgentCallRow,
  supervisor: boolean,
  catalogOf: (r: ReportAgentCallRow) => readonly AgencyDisposition[] | null,
): unknown[] {
  const cells: unknown[] = [
    instantCell(r.at),
    r.origin === 'softphone' ? 'Soft phone' : 'Campaign',
    r.campaign_name ?? (r.origin === 'softphone' ? null : r.campaign_id),
    supervisor ? r.phone : maskPhone(r.phone),
    outcomeLabel(r.outcome),
    r.disposition_code,
    r.disposition_code === null ? null : dispositionLabel(r.disposition_code, catalogOf(r)),
    secondsCell(r.talk_s),
    secondsCell(r.wrapup_s),
    r.redial_number === null ? null : Number(r.redial_number),
    instantCell(r.callback_at),
  ];
  if (supervisor) cells.push(r.recorded ?? false, r.sentiment ?? null);
  return cells;
}

function agentCallsSource(
  scope: ReportAgentScope,
  supervisor: boolean,
  campaigns: ReadonlyMap<string, AgencyCampaignRecord>,
  softphoneCatalog: readonly AgencyDisposition[],
): ReportDetailSource {
  const catalogOf = (r: ReportAgentCallRow) =>
    r.campaign_id !== null && campaigns.has(r.campaign_id)
      ? campaigns.get(r.campaign_id)!.disposition_catalog
      : r.origin === 'softphone' ? softphoneCatalog : null;
  return {
    sheet: 'calls',
    label: 'Calls',
    columns: agentCallColumns(supervisor),
    async *rows() {
      const { text, values } = agentCallsStatement({ ...scope, analysis: supervisor });
      for await (const r of reportCursorRows<ReportAgentCallRow>(text, values)) yield agentCallCells(r, supervisor, catalogOf);
    },
  };
}
