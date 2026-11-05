import { ATTEMPT_OUTCOME_LABELS } from '@magick-agency/contracts/api/agency/agency-spine';
import type { AgencyAttemptOutcome } from '../../../../types/agency';
import type {
  AgencyInsightsActivity,
  AgencyInsightsOutcomeRow,
  AgencyInsightsOverrideRow,
  AgencyInsightsSettings,
} from '../../../../types/agency-insights';
import { formatCount } from '../../../../utils/format/number';
import { durationWords } from '../../../../utils/format/duration';
import {
  averageHandleSeconds,
  callsConnectRate,
  insightsRate,
  successRate,
  rateText,
  rateValue,
} from '../../../../utils/agency/insights/rates';
import { attemptsLink } from '../../../../utils/agency/insights/links';
import { insightsCsvFilename } from '../../../../utils/agency/insights/csv';
import {
  CountLink,
  CsvButton,
  InsightsTable,
  Kpi,
  Panel,
  rateFigure,
  ReconciliationChips,
  tableCsv,
  type InsightsColumn,
} from './InsightsParts';
import styles from './Insights.module.css';

/** What every range section is handed: whose, which range, and how to name people. */
export interface RangeSectionContext {
  campaignId: string;
  campaignName: string;
  /** `[from, to)` for the attempts drill-downs; empty for the lifetime. */
  range: { from?: string; to?: string };
  /** "Lifetime", "Today", ... */
  rangeLabel: string;
  agentName: (userId: string | null) => string;
}

/** Outcome order on the page: the connected first, then by how often they happen in a dialler. */
const OUTCOME_ORDER: AgencyAttemptOutcome[] = [
  'connected',
  'no_answer',
  'busy',
  'canceled',
  'failed',
  'invalid',
  'abandoned',
  'agent_disconnected',
  'orphaned',
  'machine',
];

export interface OutcomeLine {
  outcome: AgencyAttemptOutcome | null;
  label: string;
  count: number;
}

/** Placed dials by outcome, with the still-live remainder last. Sums to `calls.dials`. */
export function outcomeLines(activity: AgencyInsightsActivity): OutcomeLine[] {
  const by = activity.calls.by_outcome;
  const lines: OutcomeLine[] = OUTCOME_ORDER.map((outcome) => ({
    outcome,
    label: ATTEMPT_OUTCOME_LABELS[outcome],
    count: by[outcome] ?? 0,
  }));
  lines.push({ outcome: null, label: 'Still live or not yet recorded', count: by.null_outcome ?? 0 });
  return lines;
}

// ── Calls and outcomes ──────────────────────────────────────────────────────

export function CallsSection({ ctx, activity }: { ctx: RangeSectionContext; activity: AgencyInsightsActivity }) {
  const { campaignId, range } = ctx;
  const { calls } = activity;
  const connect = rateFigure(callsConnectRate(calls));
  const success = rateFigure(successRate(calls.successes, calls.conversations));
  const handle = averageHandleSeconds(calls);
  const lines = outcomeLines(activity);

  const outcomeColumns: InsightsColumn<OutcomeLine>[] = [
    { key: 'label', header: 'Outcome', render: (l) => l.label, csv: (l) => l.outcome ?? 'null_outcome' },
    {
      key: 'count',
      header: 'Dials',
      numeric: true,
      render: (l) => (l.outcome ? <CountLink to={attemptsLink(campaignId, { ...range, outcome: l.outcome })} value={l.count} label={`dials: ${l.label}`} /> : formatCount(l.count)),
      csv: (l) => l.count,
    },
    { key: 'share', header: 'Share of dials', numeric: true, render: (l) => rateText(insightsRate(l.count, calls.dials)), csv: (l) => rateValue(insightsRate(l.count, calls.dials)) },
  ];

  const dispositionColumns: InsightsColumn<AgencyInsightsOutcomeRow>[] = [
    {
      key: 'label',
      header: 'Disposition',
      render: (row) => (
        <>
          {row.code === null ? 'Closed with no outcome' : (row.label ?? row.code)}
          {row.is_success ? <span className={styles.success}> · Success</span> : null}
        </>
      ),
      csv: (row) => row.label ?? row.code ?? 'no outcome',
    },
    { key: 'code', header: 'Code', render: (row) => row.code ?? '—', csv: (row) => row.code },
    { key: 'success', header: 'Success', render: (row) => (row.is_success ? 'Yes' : 'No'), csv: (row) => row.is_success },
    {
      key: 'count',
      header: 'Calls',
      numeric: true,
      render: (row) => (row.code ? <CountLink to={attemptsLink(campaignId, { ...range, disposition: row.code })} value={row.count} label={`calls written up as ${row.label ?? row.code}`} /> : formatCount(row.count)),
      csv: (row) => row.count,
    },
    {
      key: 'share',
      header: 'Share of conversations',
      numeric: true,
      render: (row) => rateText(insightsRate(row.count, calls.conversations)),
      csv: (row) => rateValue(insightsRate(row.count, calls.conversations)),
    },
  ];
  const dispositions = activity.outcomes.slice().sort((a, b) => b.count - a.count);
  const resolutions = Object.entries(activity.no_outcome.by_resolution).filter(([, n]) => n > 0);

  return (
    <Panel
      id="calls"
      title="Calls and outcomes"
      sub={`${ctx.rangeLabel} · ${formatCount(calls.dials)} dials`}
      actions={
        <>
          <CsvButton label="Outcomes CSV" filename={insightsCsvFilename(ctx.campaignName, 'outcomes', campaignId)} build={() => tableCsv(outcomeColumns, lines)} />
          <CsvButton label="Dispositions CSV" filename={insightsCsvFilename(ctx.campaignName, 'dispositions', campaignId)} build={() => tableCsv(dispositionColumns, dispositions)} />
        </>
      }
    >
      <div className={styles.kpis}>
        <Kpi
          label="Dials"
          value={<CountLink to={attemptsLink(campaignId, range)} value={calls.dials} label="dials" />}
          sub="Wrap-up redials included"
          testId="kpi-dials"
        />
        <Kpi
          label="Connected"
          value={<CountLink to={attemptsLink(campaignId, { ...range, outcome: 'connected', redial: false })} value={calls.connected} label="connected calls" />}
          sub={`Connect rate ${connect.value}`}
          testId="kpi-connected"
        />
        <Kpi
          label="Successes"
          value={formatCount(calls.successes)}
          sub={`Success rate ${success.value} of ${formatCount(calls.conversations)} conversations`}
          testId="kpi-successes"
        />
        <Kpi
          label="Wrap-up redials"
          value={<CountLink to={attemptsLink(campaignId, { ...range, redial: true })} value={calls.redials.placed} label="wrap-up redials" />}
          sub={`${formatCount(calls.redials.connected)} connected · ${formatCount(calls.redials.chains_at_limit)} hit the limit · ${formatCount(calls.redials.refused_at_limit)} refused at the limit`}
          testId="kpi-redials"
        />
        <Kpi
          label="Agent retries"
          value={formatCount(calls.agent_retries.reopened_dials + calls.agent_retries.manual_dials)}
          sub={
            <>
              <CountLink to={attemptsLink(campaignId, { ...range, agent_reopened: true })} value={calls.agent_retries.reopened_dials} label="dials after a reopen" />
              {` reopened (${formatCount(calls.agent_retries.reopened_connected)} connected) · `}
              <CountLink to={attemptsLink(campaignId, { ...range, agent_manual: true })} value={calls.agent_retries.manual_dials} label="dials by hand" />
              {` by hand (${formatCount(calls.agent_retries.manual_connected)} connected)`}
            </>
          }
          testId="kpi-agent-retries"
        />
        <Kpi
          label="Average handle time"
          value={handle.handle === null ? '—' : durationWords(handle.handle)}
          withheld={handle.handle === null}
          sub={`Talk ${handle.talk === null ? '—' : durationWords(handle.talk)} · wrap-up ${handle.wrapup === null ? '—' : durationWords(handle.wrapup)}`}
          testId="kpi-aht"
        />
        <Kpi
          label="Soft-phone calls"
          value={formatCount(calls.softphone_calls)}
          sub="Tagged to this campaign; not in any other count here"
          testId="kpi-softphone"
        />
      </div>

      <h4 className={styles.subTitle}>By outcome</h4>
      <InsightsTable caption="Placed dials by outcome" columns={outcomeColumns} rows={lines} rowKey={(l) => l.outcome ?? 'null'} testId="outcomes-table" />

      <h4 className={styles.subTitle}>Conversations by disposition</h4>
      {dispositions.length === 0 ? (
        <p className={styles.muted}>No conversations in this range.</p>
      ) : (
        <InsightsTable caption="Conversations by disposition, successes marked" columns={dispositionColumns} rows={dispositions} rowKey={(row) => row.code ?? 'none'} testId="dispositions-table" />
      )}

      {activity.no_outcome.total > 0 ? (
        <p className={styles.muted} data-testid="no-outcome">
          {`${formatCount(activity.no_outcome.total)} connected calls closed without an outcome`}
          {resolutions.length ? ` (${resolutions.map(([k, n]) => `${k.replace(/_/g, ' ')} ${formatCount(n)}`).join(', ')})` : ''}.
        </p>
      ) : null}
      {activity.dnc_marked.total > 0 ? (
        <p className={styles.muted} data-testid="dnc-marked">
          {`${formatCount(activity.dnc_marked.total)} numbers marked Do Not Call: `}
          {activity.dnc_marked.by_agent.map((row) => `${ctx.agentName(row.user_id)} ${formatCount(row.count)}`).join(', ')}
        </p>
      ) : null}

      <ReconciliationChips checks={activity.reconciliation} />
    </Panel>
  );
}

// ── Callbacks ───────────────────────────────────────────────────────────────

export function CallbacksSection({ ctx, activity }: { ctx: RangeSectionContext; activity: AgencyInsightsActivity }) {
  const cb = activity.callbacks;
  const resolved = cb.kept_on_time + cb.kept_late + cb.missed;
  const onTime = rateFigure(insightsRate(cb.kept_on_time, resolved));
  type Owner = AgencyInsightsActivity['callbacks']['by_owner'][number];
  const columns: InsightsColumn<Owner>[] = [
    { key: 'owner', header: 'Owner', render: (row) => (row.agent_user_id === null ? 'Unassigned' : ctx.agentName(row.agent_user_id)), csv: (row) => (row.agent_user_id === null ? 'Unassigned' : ctx.agentName(row.agent_user_id)) },
    {
      key: 'open',
      header: 'Open',
      numeric: true,
      // Not a link: these are the callbacks BOOKED for a time in this range that are still open,
      // due ones included, and no contacts filter selects that set (a link would open a list
      // whose total is a different number).
      render: (row) => formatCount(row.open),
      csv: (row) => row.open,
    },
    { key: 'overdue', header: 'Overdue', numeric: true, render: (row) => formatCount(row.overdue), csv: (row) => row.overdue },
  ];
  return (
    <Panel
      id="callbacks"
      title="Callbacks"
      sub={`${ctx.rangeLabel} · on time means dialled within 15 minutes of the booked time`}
      actions={<CsvButton filename={insightsCsvFilename(ctx.campaignName, 'callbacks', ctx.campaignId)} build={() => tableCsv(columns, cb.by_owner)} />}
    >
      <div className={styles.kpis}>
        <Kpi label="Booked" value={formatCount(cb.booked)} sub="In this range" testId="kpi-callbacks-booked" />
        <Kpi label="Kept on time" value={formatCount(cb.kept_on_time)} sub={`${onTime.value} of those due`} testId="kpi-callbacks-on-time" />
        <Kpi label="Late" value={formatCount(cb.kept_late)} testId="kpi-callbacks-late" />
        <Kpi label="Missed" value={formatCount(cb.missed)} sub="Never dialled, or the contact closed first" testId="kpi-callbacks-missed-range" />
        <Kpi
          label="Still open"
          value={formatCount(cb.pending_future + cb.pending_due)}
          sub={`${formatCount(cb.pending_future)} still to come · ${formatCount(cb.pending_due)} overdue`}
          testId="kpi-callbacks-pending"
        />
        <Kpi
          label="Open now"
          // Not a link: due before local midnight, which no contacts filter selects (the
          // Callbacks waiting filter is every later callback, a different number).
          value={formatCount(cb.open_due_today)}
          sub={`Due today · ${formatCount(cb.open_overdue)} overdue · whatever the range`}
          testId="kpi-callbacks-open"
        />
      </div>
      {cb.by_owner.length > 0 ? (
        <InsightsTable caption="Open callbacks by owner" columns={columns} rows={cb.by_owner} rowKey={(row) => row.agent_user_id ?? 'pool'} sortable testId="callbacks-table" />
      ) : (
        <p className={styles.muted}>No open callbacks.</p>
      )}
    </Panel>
  );
}

// ── Overrides ───────────────────────────────────────────────────────────────

export function OverridesSection({
  ctx,
  activity,
  settings,
}: {
  ctx: RangeSectionContext;
  activity: AgencyInsightsActivity;
  settings: AgencyInsightsSettings;
}) {
  const labels = new Map(settings.override_outcomes.map((o) => [o.code, o.label]));
  // `total` is the outcome's own line; an agent line's `agent` is null for dials with no agent session.
  type Line = { code: string; total: boolean; agent: string | null; granted: number; used: number };
  const lines: Line[] = activity.overrides.flatMap((row: AgencyInsightsOverrideRow) => [
    { code: row.code, total: true, agent: null, granted: row.granted, used: row.used },
    ...row.by_agent.map((a) => ({ code: row.code, total: false, agent: a.agent_user_id, granted: a.granted, used: a.used })),
  ]);
  const who = (l: Line) => (l.total ? 'All agents' : l.agent === null ? 'No agent' : ctx.agentName(l.agent));
  const columns: InsightsColumn<Line>[] = [
    { key: 'code', header: 'Outcome', render: (l) => (l.total ? labels.get(l.code) ?? l.code : ''), csv: (l) => l.code },
    { key: 'agent', header: 'Agent', render: who, csv: who },
    { key: 'granted', header: 'Granted', numeric: true, render: (l) => formatCount(l.granted), csv: (l) => l.granted },
    // Not linked: `used` is by the GRANTING outcome (the contact's earlier disposition), which no
    // attempts filter selects. Every dial that spent an override opens from the Agents table's
    // Overrides column and the allocation's Overrides used (`override_applied=1`).
    { key: 'used', header: 'Used', numeric: true, render: (l) => formatCount(l.used), csv: (l) => l.used },
  ];
  return (
    <Panel
      id="overrides"
      title="Overrides"
      sub={`${ctx.rangeLabel} · outcomes that let an agent go past the retry rules`}
      actions={lines.length ? <CsvButton filename={insightsCsvFilename(ctx.campaignName, 'overrides', ctx.campaignId)} build={() => tableCsv(columns, lines)} /> : undefined}
    >
      {lines.length === 0 ? (
        <p className={styles.muted}>
          {settings.override_outcomes.length === 0 ? 'No outcome on this campaign allows an override.' : 'No overrides were granted in this range.'}
        </p>
      ) : (
        <InsightsTable caption="Overrides granted and used, by outcome and agent" columns={columns} rows={lines} rowKey={(l) => `${l.code}-${l.total ? 'all' : l.agent ?? 'none'}`} testId="overrides-table" />
      )}
    </Panel>
  );
}
