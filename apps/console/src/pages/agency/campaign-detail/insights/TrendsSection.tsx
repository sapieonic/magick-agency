import type { AgencyInsightsBucket, AgencyInsightsTrendBucket, AgencyInsightsTrends } from '../../../../types/agency-insights';
import { DISPLAY_LOCALE, formatCount, pct } from '../../../../utils/format/number';
import { ceilingPctText } from '../../../../utils/agency/abandonmentCeiling';
import { abandonmentRate, connectRate, insightsRate, rateText, rateValue } from '../../../../utils/agency/insights/rates';
import { formatZoned } from '../../../../utils/agency/insights/copy';
import { BUCKET_LABELS } from '../../../../utils/agency/insights/range';
import { insightsCsvFilename } from '../../../../utils/agency/insights/csv';
import { CsvButton, Disclosure, InsightsTable, Panel, tableCsv, type InsightsColumn } from './InsightsParts';
import { InsightsChart, type ChartPoint } from './InsightsChart';
import type { RangeSectionContext } from './ActivitySections';
import styles from './Insights.module.css';

const DAY_LABEL = new Intl.DateTimeFormat(DISPLAY_LOCALE, { day: 'numeric', month: 'short', timeZone: 'UTC' });

/** A bucket's short and full label, in the campaign zone. Day buckets are already zone days. */
export function bucketLabel(bucket: AgencyInsightsTrendBucket, width: AgencyInsightsBucket, zone: string): { label: string; title: string } {
  if (width === 'day') {
    const [y, m, d] = bucket.bucket_start.split('-').map(Number) as [number, number, number];
    const text = DAY_LABEL.format(new Date(Date.UTC(y, m - 1, d)));
    return { label: text, title: text };
  }
  return { label: formatZoned(bucket.bucket_start, zone, false), title: formatZoned(bucket.bucket_start, zone, true) };
}

/** `14:00–15:00` for an hour of day. */
export function hourSpan(hour: number): string {
  const pad = (h: number) => `${String(h % 24).padStart(2, '0')}:00`;
  return `${pad(hour)}–${pad(hour + 1)}`;
}

/** The hour with the best connect rate (human connects over first dials) among those with enough first dials, or null. */
export function bestHour(rows: AgencyInsightsTrends['best_hours']): { hour: number; rate: number } | null {
  let best: { hour: number; rate: number } | null = null;
  for (const row of rows) {
    const rate = rateValue(connectRate(row));
    if (rate !== null && (best === null || rate > best.rate)) best = { hour: row.hour, rate };
  }
  return best;
}

export function TrendsSection({
  ctx,
  trends,
  bucket,
  bucketOptions,
  onBucketChange,
  timezone,
  ceilingPct,
}: {
  ctx: RangeSectionContext;
  trends: AgencyInsightsTrends;
  bucket: AgencyInsightsBucket;
  bucketOptions: AgencyInsightsBucket[];
  onBucketChange: (bucket: AgencyInsightsBucket) => void;
  timezone: string;
  ceilingPct: number;
}) {
  // Label with the width the server answered, which is the one the buckets have.
  const width = trends.bucket;
  const labelled = trends.buckets.map((b) => ({ ...b, ...bucketLabel(b, width, timezone) }));
  const dialsPoints: ChartPoint[] = labelled.map((b) => ({
    key: b.bucket_start,
    label: b.label,
    title: b.title,
    bar: b.dials,
    line: rateValue(connectRate(b)),
  }));
  const agentPoints: ChartPoint[] = labelled.map((b) => ({ key: b.bucket_start, label: b.label, title: b.title, bar: b.agents_online_peak }));
  const abandonPoints: ChartPoint[] = labelled.map((b) => ({
    key: b.bucket_start,
    label: b.label,
    title: b.title,
    bar: b.abandoned,
    line: rateValue(abandonmentRate(b)),
  }));
  const hours = trends.best_hours.slice().sort((a, b) => a.hour - b.hour);
  const hourPoints: ChartPoint[] = hours.map((h) => ({
    key: String(h.hour),
    label: String(h.hour).padStart(2, '0'),
    title: hourSpan(h.hour),
    bar: h.dials,
    line: rateValue(connectRate(h)),
  }));
  const best = bestHour(trends.best_hours);

  type Labelled = (typeof labelled)[number];
  const columns: InsightsColumn<Labelled>[] = [
    { key: 'bucket', header: width === 'day' ? 'Day' : 'Starting', render: (b) => b.title, csv: (b) => b.bucket_start },
    { key: 'dials', header: 'Dials', numeric: true, render: (b) => formatCount(b.dials), csv: (b) => b.dials },
    { key: 'first_dials', header: 'First dials', numeric: true, render: (b) => formatCount(b.first_dials), csv: (b) => b.first_dials },
    { key: 'connected', header: 'Connected', numeric: true, render: (b) => formatCount(b.connected), csv: (b) => b.connected },
    { key: 'human_connects', header: 'Reached a person', numeric: true, render: (b) => formatCount(b.human_connects), csv: (b) => b.human_connects },
    { key: 'connect_rate', header: 'Connect rate', numeric: true, render: (b) => rateText(connectRate(b)), csv: (b) => rateValue(connectRate(b)) },
    { key: 'successes', header: 'Successes', numeric: true, render: (b) => formatCount(b.successes), csv: (b) => b.successes },
    { key: 'abandoned', header: 'Abandoned', numeric: true, render: (b) => formatCount(b.abandoned), csv: (b) => b.abandoned },
    { key: 'answered', header: 'Answered', numeric: true, render: (b) => formatCount(b.answered), csv: (b) => b.answered },
    { key: 'abandon_rate', header: 'Abandonment', numeric: true, render: (b) => rateText(abandonmentRate(b)), csv: (b) => rateValue(abandonmentRate(b)) },
    { key: 'agents', header: 'Agents online (peak)', numeric: true, render: (b) => formatCount(b.agents_online_peak), csv: (b) => b.agents_online_peak },
  ];
  type Hour = (typeof hours)[number];
  const hourColumns: InsightsColumn<Hour>[] = [
    { key: 'hour', header: 'Hour of day', render: (h) => hourSpan(h.hour), csv: (h) => h.hour },
    { key: 'dials', header: 'Dials', numeric: true, render: (h) => formatCount(h.dials), csv: (h) => h.dials },
    { key: 'first_dials', header: 'First dials', numeric: true, render: (h) => formatCount(h.first_dials), csv: (h) => h.first_dials },
    { key: 'connected', header: 'Connected', numeric: true, render: (h) => formatCount(h.connected), csv: (h) => h.connected },
    { key: 'human_connects', header: 'Reached a person', numeric: true, render: (h) => formatCount(h.human_connects), csv: (h) => h.human_connects },
    { key: 'rate', header: 'Connect rate', numeric: true, render: (h) => rateText(connectRate(h)), csv: (h) => rateValue(connectRate(h)) },
  ];

  return (
    <Panel
      id="trends"
      title="Trends"
      sub={`${ctx.rangeLabel} · by ${BUCKET_LABELS[width].toLowerCase()}, times in ${timezone}`}
      actions={
        <>
          <CsvButton label="Trends CSV" filename={insightsCsvFilename(ctx.campaignName, 'trends', ctx.campaignId)} build={() => tableCsv(columns, labelled)} />
          <CsvButton label="Best hours CSV" filename={insightsCsvFilename(ctx.campaignName, 'best-hours', ctx.campaignId)} build={() => tableCsv(hourColumns, hours)} />
        </>
      }
    >
      {bucketOptions.length > 1 ? (
        <div className={styles.chartControls} role="group" aria-label="Bucket width">
          <span>Group by</span>
          <div className={styles.segmented}>
            {bucketOptions.map((option) => (
              <button
                key={option}
                type="button"
                className={styles.segment}
                aria-pressed={option === bucket}
                onClick={() => onBucketChange(option)}
              >
                {BUCKET_LABELS[option]}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {trends.buckets.length === 0 ? (
        <p className={styles.muted}>Nothing was dialled in this range.</p>
      ) : (
        <>
          <h4 className={styles.subTitle}>Dials and connect rate</h4>
          <InsightsChart
            points={dialsPoints}
            barLabel="Dials"
            lineLabel="Connect rate"
            description={`Dials (bars) and connect rate (line) by ${BUCKET_LABELS[width].toLowerCase()}, ${trends.buckets.length} buckets`}
            testId="trend-dials"
          />
          <div className={styles.grid2}>
            <div>
              <h4 className={styles.subTitle}>Agents online</h4>
              <InsightsChart points={agentPoints} barLabel="Agents online (peak)" description="Peak agents online by bucket" testId="trend-agents" />
            </div>
            <div>
              <h4 className={styles.subTitle}>Abandonment</h4>
              <InsightsChart
                points={abandonPoints}
                barLabel="Abandoned"
                lineLabel="Abandonment rate"
                reference={{ value: ceilingPct, label: `${ceilingPctText(ceilingPct)} ceiling` }}
                description={`Abandoned calls and abandonment rate by bucket, against the ${ceilingPctText(ceilingPct)} ceiling`}
                testId="trend-abandonment"
              />
            </div>
          </div>
          <Disclosure label={['Show the numbers', 'Hide the numbers']}>
            <InsightsTable caption="Trends by bucket" columns={columns} rows={labelled} rowKey={(b) => b.bucket_start} testId="trends-table" />
          </Disclosure>
        </>
      )}

      <h4 className={styles.subTitle}>Best hours of day</h4>
      <p className={styles.muted}>
        {best
          ? `Best hour: ${hourSpan(best.hour)}, ${pct(best.rate)} connect rate. Hours are in each contact’s own time zone (the campaign’s when a contact has none).`
          : 'Not enough calls yet to name a best hour. Hours are in each contact’s own time zone.'}
      </p>
      {hours.length > 0 ? (
        <InsightsChart points={hourPoints} barLabel="Dials" lineLabel="Connect rate" description="Dials and connect rate by hour of day" testId="trend-best-hours" />
      ) : null}
    </Panel>
  );
}
