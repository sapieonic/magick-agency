import type { AgencyInsightsHealth, AgencyInsightsSettings, AgencyInsightsStallEpisode } from '../../../../types/agency-insights';
import { AGENCY_PACING_IDLE_REASONS } from '../../../../types/agency-insights';
import { clampPercent, formatCount, pct } from '../../../../utils/format/number';
import { durationWords } from '../../../../utils/format/duration';
import { abandonmentRate, connectRate, insightsRate, rateText, rateValue } from '../../../../utils/agency/insights/rates';
import { formatZoned, IDLE_REASON_LABELS } from '../../../../utils/agency/insights/copy';
import { attemptsLink } from '../../../../utils/agency/insights/links';
import { insightsCsvFilename } from '../../../../utils/agency/insights/csv';
import { CountLink, CsvButton, InsightsTable, Kpi, Panel, rateFigure, tableCsv, type InsightsColumn } from './InsightsParts';
import type { RangeSectionContext } from './ActivitySections';
import styles from './Insights.module.css';

type StallReason = keyof AgencyInsightsHealth['stalls']['minutes_by_reason'];
const STALL_REASONS: StallReason[] = [...AGENCY_PACING_IDLE_REASONS, 'outside_calling_hours'];

function minutes(n: number): string {
  return durationWords(n * 60);
}

/** "TELEPHONY_ERROR 12 · no code 3", most first; empty when nothing failed. */
export function carrierCodesText(rows: AgencyInsightsHealth['carrier_failures_by_code']): string {
  return rows.map((r) => `${r.error_code ?? 'no code'} ${formatCount(r.count)}`).join(' · ');
}

export function HealthSection({
  ctx,
  health,
  timezone,
}: {
  ctx: RangeSectionContext;
  health: AgencyInsightsHealth;
  timezone: string;
}) {
  const { campaignId, range } = ctx;
  const abandonment = abandonmentRate(health.abandonment.rolling_24h);
  const ceiling = health.abandonment.ceiling_pct;
  const over = abandonment.kind === 'value' && abandonment.pct >= ceiling;
  // The campaign's connect rate over the same rows (connected over first dials, connectRate).
  const average = rateFigure(connectRate({
    connected: health.caller_ids.reduce((s, c) => s + c.connected, 0),
    first_dials: health.caller_ids.reduce((s, c) => s + c.first_dials, 0),
  }));

  type CallerRow = AgencyInsightsHealth['caller_ids'][number];
  const callerColumns: InsightsColumn<CallerRow>[] = [
    { key: 'caller_id', header: 'Caller ID', render: (r) => r.caller_id, csv: (r) => r.caller_id },
    {
      key: 'dials',
      header: 'Dials',
      numeric: true,
      render: (r) => <CountLink to={attemptsLink(campaignId, { ...range, caller_id: r.caller_id })} value={r.dials} label={`dials from ${r.caller_id}`} />,
      csv: (r) => r.dials,
    },
    { key: 'first_dials', header: 'First dials', numeric: true, render: (r) => formatCount(r.first_dials), csv: (r) => r.first_dials },
    { key: 'connected', header: 'Connected', numeric: true, render: (r) => formatCount(r.connected), csv: (r) => r.connected },
    { key: 'rate', header: 'Connect rate', numeric: true, render: (r) => rateText(connectRate(r)), csv: (r) => rateValue(connectRate(r)) },
  ];
  const reasonRows = STALL_REASONS.map((reason) => ({ reason, minutes: health.stalls.minutes_by_reason[reason] ?? 0 })).filter((r) => r.minutes > 0);
  const reasonColumns: InsightsColumn<(typeof reasonRows)[number]>[] = [
    { key: 'reason', header: 'Why the dialler waited', render: (r) => IDLE_REASON_LABELS[r.reason], csv: (r) => r.reason },
    { key: 'minutes', header: 'Minutes', numeric: true, render: (r) => minutes(r.minutes), csv: (r) => r.minutes },
  ];
  const episodeColumns: InsightsColumn<AgencyInsightsStallEpisode>[] = [
    { key: 'reason', header: 'Reason', render: (e) => IDLE_REASON_LABELS[e.reason], csv: (e) => e.reason },
    { key: 'started_at', header: 'From', render: (e) => formatZoned(e.started_at, timezone), csv: (e) => e.started_at },
    { key: 'ended_at', header: 'To', render: (e) => (e.ended_at ? formatZoned(e.ended_at, timezone) : 'Still waiting'), csv: (e) => e.ended_at },
    { key: 'minutes', header: 'Minutes', numeric: true, render: (e) => minutes(e.minutes), csv: (e) => e.minutes },
  ];

  return (
    <Panel
      id="health"
      title="Health and compliance"
      sub={`${ctx.rangeLabel} · abandonment is the rolling 24 hours`}
      actions={
        <>
          <CsvButton label="Caller IDs CSV" filename={insightsCsvFilename(ctx.campaignName, 'caller-ids', campaignId)} build={() => tableCsv(callerColumns, health.caller_ids)} />
          <CsvButton label="Stalls CSV" filename={insightsCsvFilename(ctx.campaignName, 'stalls', campaignId)} build={() => tableCsv(episodeColumns, health.stalls.episodes)} />
        </>
      }
    >
      <div className={styles.kpis}>
        <Kpi
          label={`Abandonment vs ${pct(ceiling)} ceiling`}
          value={rateText(abandonment)}
          withheld={abandonment.kind !== 'value'}
          sub={
            <span className={styles.meter} style={{ display: 'block' }} aria-hidden="true">
              <span
                className={styles.meterFill}
                data-over={String(over)}
                style={{ display: 'block', width: `${abandonment.kind === 'value' && ceiling > 0 ? clampPercent((abandonment.pct / ceiling) * 100) : 0}%` }}
              />
            </span>
          }
          testId="kpi-health-abandonment"
        />
        <Kpi
          label="Auto-pauses"
          value={formatCount(health.abandonment.auto_pauses.length)}
          sub={health.abandonment.auto_pauses.map((p) => `${formatZoned(p.at, timezone)}${p.measured_pct === null ? '' : ` at ${pct(p.measured_pct)}`}`).join(' · ') || 'None in this range'}
          testId="kpi-auto-pauses"
        />
        <Kpi
          label="Blocked before dialling"
          value={formatCount(health.predial_blocks.dnc + health.predial_blocks.invalid)}
          sub={`Do Not Call ${formatCount(health.predial_blocks.dnc)} · invalid ${formatCount(health.predial_blocks.invalid)} · ${formatCount(health.predial_blocks.outside_calling_hours_deferrals)} held for calling hours`}
          testId="kpi-predial"
        />
        <Kpi label="At the concurrency limit" value={minutes(health.concurrency_limit_minutes)} sub="Time the account’s line limit held dials back" testId="kpi-concurrency-minutes" />
        <Kpi
          label="Carrier failures"
          value={<CountLink to={attemptsLink(campaignId, { ...range, outcome: 'failed' })} value={health.carrier_failures} label="failed dials" />}
          // By the call's error code. Not linked: the Call attempts list has no error-code filter,
          // so no list's total would be these counts.
          sub={carrierCodesText(health.carrier_failures_by_code)}
          testId="kpi-carrier-failures"
        />
        <Kpi label="Retired by our faults" value={formatCount(health.our_fault_retired)} sub="Contacts closed after repeated system faults" testId="kpi-our-fault" />
      </div>

      <h4 className={styles.subTitle}>Caller IDs</h4>
      {health.caller_ids.length === 0 ? (
        <p className={styles.muted}>No dials in this range.</p>
      ) : (
        <>
          <p className={styles.muted}>{`Campaign connect rate across caller IDs: ${average.value}`}</p>
          <InsightsTable caption="Dials and connect rate by caller ID" columns={callerColumns} rows={health.caller_ids} rowKey={(r) => r.caller_id} sortable testId="caller-ids-table" />
        </>
      )}

      <h4 className={styles.subTitle}>Stalls</h4>
      <p className={styles.muted} data-testid="pacing-history-since">
        {health.pacing_history_since
          ? `Pacing history since ${formatZoned(health.pacing_history_since, timezone)}. Earlier minutes were not recorded.`
          : 'Pacing history has not started recording for this campaign yet.'}
      </p>
      {reasonRows.length === 0 ? (
        <p className={styles.muted}>The dialler was never held back in this range.</p>
      ) : (
        <InsightsTable caption="Minutes the dialler waited, by reason" columns={reasonColumns} rows={reasonRows} rowKey={(r) => r.reason} testId="stall-reasons-table" />
      )}
      {health.stalls.episodes_truncated ? (
        <p className={styles.muted} data-testid="stall-episodes-truncated">Showing the newest 500 stall episodes; older ones in this range are not listed (the minutes above count them all).</p>
      ) : null}
      {health.stalls.episodes.length > 0 ? (
        <div className={styles.historyList}>
          <InsightsTable caption="Stall episodes" columns={episodeColumns} rows={health.stalls.episodes} rowKey={(e) => `${e.reason}-${e.started_at}`} testId="stall-episodes-table" />
        </div>
      ) : null}
    </Panel>
  );
}

export function RecordingSection({
  ctx,
  health,
  settings,
}: {
  ctx: RangeSectionContext;
  health: AgencyInsightsHealth;
  settings: AgencyInsightsSettings;
}) {
  const coverage = rateFigure(insightsRate(health.recording.recorded, health.recording.connected));
  const analysis = health.analysis;
  const sentimentTotal = analysis ? analysis.sentiment.positive + analysis.sentiment.neutral + analysis.sentiment.negative : 0;
  const share = (n: number) => rateText(insightsRate(n, sentimentTotal));
  return (
    <Panel id="recording" title="Recording and analysis" sub={ctx.rangeLabel}>
      <div className={styles.kpis}>
        <Kpi
          label="Recording coverage"
          value={coverage.value}
          withheld={coverage.withheld}
          sub={`${formatCount(health.recording.recorded)} of ${formatCount(health.recording.connected)} connected calls · recording is ${settings.record_calls ? 'on' : 'off'}`}
          testId="kpi-recording"
        />
        {analysis ? (
          <>
            <Kpi
              label="Analysed"
              value={formatCount(analysis.analysed)}
              sub={settings.analysis_profile?.name ? `Profile: ${settings.analysis_profile.name}` : undefined}
              testId="kpi-analysed"
            />
            <Kpi
              label="Sentiment"
              value={share(analysis.sentiment.positive)}
              sub={`positive · neutral ${share(analysis.sentiment.neutral)} · negative ${share(analysis.sentiment.negative)}`}
              withheld={insightsRate(analysis.sentiment.positive, sentimentTotal).kind !== 'value'}
              testId="kpi-sentiment"
            />
          </>
        ) : (
          // Null is "not served": say off only when the campaign has no profile.
          <Kpi
            label="Analysis"
            value={settings.analysis_profile ? 'Not available' : 'Off'}
            withheld
            sub={settings.analysis_profile ? 'Analysis figures are not on this page yet' : 'No analysis profile on this campaign'}
            testId="kpi-analysed"
          />
        )}
      </div>
      {analysis && analysis.top_topics.length > 0 ? (
        <p className={styles.muted} data-testid="top-topics">
          {`Top topics: ${analysis.top_topics.map((t) => `${t.topic} (${formatCount(t.count)})`).join(', ')}`}
        </p>
      ) : null}
    </Panel>
  );
}
