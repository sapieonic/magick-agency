import { useId } from 'react';
import type {
  AgencyCompareAgent,
  AgencyCompareCohortMetric,
  AgencyCompareMetricInfo,
  AgencyCompareTrend,
} from '@magick-agency/contracts/api/agency/compare';
import { useChartWidth } from '../useChartWidth';
import {
  BAR_THICKNESS,
  DAY_SPLIT_PARTS,
  barChartGeometry,
  barLabelWidth,
  barPath,
  daySplitSegments,
  formatMedian,
  shortDate,
  trendGeometry,
  type DaySplitKey,
} from '../../../utils/agency/compare/compareCharts';
import { formatMetricValue, formatRate, infoLabel, metricSubtitle, tooFewWords } from '../../../utils/agency/compare/compareMetrics';
import { durationWords } from '../../../utils/format/duration';
import { formatCount } from '../../../utils/format/number';
import styles from './Compare.module.css';

/**
 * Compare agents' charts (`docs/compare-agents.md` §5), drawn in SVG at the container's measured
 * width (`useChartWidth`: one SVG unit is one CSS pixel, re-drawn on resize). Every mark's
 * geometry comes from `utils/agency/compare/compareCharts.ts`; these components only draw it.
 *
 * Each chart is an `img` with a label that says its figures in words, each mark carries a
 * `<title>` (the hover), and The numbers below the charts holds every figure as a table, so no
 * figure is told by colour or position alone.
 */

/** A picked agent as the charts draw them: their colour slot follows the person (§2). */
export interface ChartAgent {
  id: string;
  name: string;
  /** 0, 1 or 2: the categorical slot. */
  slot: number;
}

export function agentColour(slot: number): string {
  return `var(--cmp-agent-${slot + 1})`;
}

/** A name cut to fit `width` pixels of 12px text. */
function fitName(name: string, width: number): string {
  const max = Math.max(4, Math.floor(width / 6.6));
  return name.length <= max ? name : `${name.slice(0, max - 1)}…`;
}

// ─── Side by side ──────────────────────────────────────────────────────────

export interface MetricBarsProps {
  info: AgencyCompareMetricInfo;
  agents: readonly ChartAgent[];
  columns: readonly AgencyCompareAgent[];
  cohort: AgencyCompareCohortMetric | undefined;
}

/** One metric: a bar per agent, the team's middle half as a band, its median as a line. */
export function MetricBars({ info, agents, columns, cohort }: MetricBarsProps) {
  const [ref, width] = useChartWidth(320);
  const titleId = useId();
  const unit = info.definition.unit;
  const band = { p25: cohort?.p25 ?? null, median: cohort?.median ?? null, p75: cohort?.p75 ?? null };
  const rows = agents.map((agent) => {
    const v = columns.find((c) => c.agent_user_id === agent.id)?.values[info.id];
    return {
      agent,
      value: v ?? null,
      input: {
        value: v?.value ?? null,
        reportable: v?.reportable ?? false,
        interval: unit === 'rate' ? (v?.interval ?? null) : null,
        valueText: formatMetricValue(unit, v?.value ?? null),
        withheldText: v && v.value === null ? 'No calls in this window' : tooFewWords(info, v?.denominator ?? 0),
      },
    };
  });
  const g = barChartGeometry({ width, rows: rows.map((r) => r.input), cohort: band, isRate: unit === 'rate' });
  const label = infoLabel(info);
  const median = formatMetricValue(unit, band.median);
  const summary = `${label}: ${rows
    .map((r) => `${r.agent.name} ${r.input.reportable && r.input.value !== null ? r.input.valueText : 'too few to compare'}`)
    .join(', ')}${band.median !== null ? `; team median ${median}` : ''}.`;

  return (
    <div className={styles.metric} data-testid="compare-metric" data-metric={info.id}>
      <h4 className={styles.metricTitle} id={titleId}>
        {label}
        <span className={styles.metricSub}>{metricSubtitle(info)}</span>
      </h4>
      <div ref={ref} className={styles.chart}>
        <svg width={g.width} height={g.height} viewBox={`0 0 ${g.width} ${g.height}`} role="img" aria-label={summary}>
          {g.band ? <rect className={styles.band} x={g.band.x} y={g.plotTop} width={g.band.width} height={g.plotBottom - g.plotTop} rx={3} /> : null}
          {g.median ? <line className={styles.medianLine} x1={g.median.x} x2={g.median.x} y1={g.plotTop - 1} y2={g.plotBottom} /> : null}
          {g.rows.map((row, i) => {
            const r = rows[i]!;
            const name = fitName(r.agent.name, barLabelWidth(g.width) - 8);
            const mid = row.y + BAR_THICKNESS / 2;
            const counts =
              r.value && r.value.denominator !== null && unit === 'rate'
                ? ` (${formatCount(r.value.numerator)} of ${formatCount(r.value.denominator)}${r.value.interval ? `; likely range ${formatRate(r.value.interval[0])} to ${formatRate(r.value.interval[1])}` : ''})`
                : '';
            return (
              <g key={r.agent.id} data-testid="compare-bar-row" data-kind={row.kind}>
                <text className={styles.label} x={0} y={mid + 4}>
                  {name}
                </text>
                {row.kind === 'withheld' ? (
                  <text className={styles.withheld} x={row.x0} y={mid + 4}>
                    {row.text}
                  </text>
                ) : (
                  <>
                    <path d={barPath(row.x0, row.y, row.width)} fill={agentColour(r.agent.slot)} />
                    {row.whisker ? (
                      <g className={styles.whisker}>
                        <line x1={row.whisker.x1} x2={row.whisker.x2} y1={mid} y2={mid} />
                        <line x1={row.whisker.x1} x2={row.whisker.x1} y1={mid - 4} y2={mid + 4} />
                        <line x1={row.whisker.x2} x2={row.whisker.x2} y1={mid - 4} y2={mid + 4} />
                      </g>
                    ) : null}
                    <text className={styles.value} x={row.valueX} y={mid + 4}>
                      {row.valueText}
                    </text>
                  </>
                )}
                <rect className={styles.hit} x={0} y={row.y - 6} width={g.width} height={28}>
                  <title>
                    {`${r.agent.name} · ${label}: ${row.kind === 'bar' ? row.valueText : (row as { text: string }).text}${counts}${band.median !== null ? ` · team median ${median}` : ''}`}
                  </title>
                </rect>
              </g>
            );
          })}
          {g.median ? (
            <text className={styles.axis} x={g.median.x} y={g.height - 4} textAnchor="middle">
              {`median ${median}`}
            </text>
          ) : null}
        </svg>
      </div>
    </div>
  );
}

// ─── The trend ─────────────────────────────────────────────────────────────

export interface TrendChartProps {
  trend: AgencyCompareTrend;
  agents: readonly ChartAgent[];
  label: string;
}

/** The trend metric's count per working day: a line per agent, broken on days off; the team median dashed. */
export function TrendChart({ trend, agents, label }: TrendChartProps) {
  const [ref, width] = useChartWidth(520);
  const series = agents.map((agent) => ({
    agent,
    counts: trend.agents.find((a) => a.agent_user_id === agent.id)?.counts ?? trend.dates.map(() => null),
  }));
  const g = trendGeometry({
    width,
    height: 240,
    dates: trend.dates,
    series: series.map((s) => ({ id: s.agent.id, counts: s.counts, name: s.agent.name.split(/\s+/)[0] ?? s.agent.name })),
    median: trend.cohort_median,
  });
  const slotOf = new Map(agents.map((a) => [a.id, a.slot] as const));
  const summary = `${label} per day, ${shortDate(trend.dates[0] ?? '')} to ${shortDate(trend.dates[trend.dates.length - 1] ?? '')}, for ${agents
    .map((a) => a.name)
    .join(', ')} and the team median. The table below has every day's figures.`;

  return (
    <div>
      <div ref={ref} className={styles.chart}>
        <svg width={g.width} height={g.height} viewBox={`0 0 ${g.width} ${g.height}`} role="img" aria-label={summary} data-testid="compare-trend">
          {g.ticks.map((t) => (
            <g key={t.value}>
              <line className={styles.grid} x1={g.plotLeft} x2={g.plotRight} y1={t.y} y2={t.y} />
              <text className={styles.axis} x={g.plotLeft - 6} y={t.y + 4} textAnchor="end">
                {formatMedian(t.value)}
              </text>
            </g>
          ))}
          {g.xLabels.map((l) => (
            <text key={l.index} className={styles.axis} x={l.x} y={g.height - 8} textAnchor="middle">
              {l.text}
            </text>
          ))}
          <path className={styles.medianDash} d={g.medianPath} data-testid="compare-trend-median" />
          {g.series.map((s) => {
            const colour = agentColour(slotOf.get(s.id) ?? 0);
            return (
              <g key={s.id} data-testid="compare-trend-line">
                <path d={s.path} stroke={colour} strokeWidth={2} fill="none" strokeLinejoin="round" strokeLinecap="round" />
                {s.dots.map((d) => (
                  <circle key={`${d.x}-${d.y}`} cx={d.x} cy={d.y} r={4} fill={colour} stroke="var(--bg-secondary)" strokeWidth={2} />
                ))}
                {s.last ? <circle cx={s.last.x} cy={s.last.y} r={4} fill={colour} stroke="var(--bg-secondary)" strokeWidth={2} /> : null}
              </g>
            );
          })}
          {g.endLabels.map((e) => (
            <text key={e.id} className={e.team ? styles.axis : styles.label} x={g.plotRight + 8} y={e.y} fontWeight={e.team ? 400 : 600}>
              {e.text}
            </text>
          ))}
          {g.xs.map((x, i) => (
            <rect
              key={trend.dates[i]}
              className={styles.hit}
              x={x - (g.plotRight - g.plotLeft) / Math.max(2, trend.dates.length * 2)}
              y={g.plotTop}
              width={(g.plotRight - g.plotLeft) / Math.max(1, trend.dates.length)}
              height={g.plotBottom - g.plotTop}
            >
              <title>
                {[
                  shortDate(trend.dates[i]!),
                  ...series.map((s) => `${s.agent.name}: ${s.counts[i] === null || s.counts[i] === undefined ? 'not logged in' : s.counts[i]}`),
                  `Team median: ${trend.cohort_median[i] === null || trend.cohort_median[i] === undefined ? '–' : formatMedian(trend.cohort_median[i]!)}`,
                ].join('\n')}
              </title>
            </rect>
          ))}
        </svg>
      </div>
      <details className={styles.notClear}>
        <summary>Show each day’s figures</summary>
        <div className={styles.tableWrap}>
          <table className={styles.numbers}>
            <caption className={styles.srOnly}>{`${label} per day`}</caption>
            <thead>
              <tr>
                <th scope="col">Day</th>
                {agents.map((a) => (
                  <th key={a.id} scope="col" className={styles.num}>
                    {a.name}
                  </th>
                ))}
                <th scope="col" className={styles.num}>
                  Team median
                </th>
              </tr>
            </thead>
            <tbody>
              {trend.dates.map((date, i) => (
                <tr key={date}>
                  <td>{shortDate(date)}</td>
                  {series.map((s) => (
                    <td key={s.agent.id} className={styles.num}>
                      {s.counts[i] === null || s.counts[i] === undefined ? <span className={styles.muted}>not logged in</span> : formatCount(s.counts[i]!)}
                    </td>
                  ))}
                  <td className={`${styles.num} ${styles.muted}`}>
                    {trend.cohort_median[i] === null || trend.cohort_median[i] === undefined ? '–' : formatMedian(trend.cohort_median[i]!)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}

// ─── Where their day went ──────────────────────────────────────────────────

const ACT: Readonly<Record<DaySplitKey, { fill: string; ink: string }>> = {
  on_call: { fill: 'var(--cmp-act-call)', ink: 'var(--cmp-act-call-ink)' },
  choosing: { fill: 'var(--cmp-act-choose)', ink: 'var(--cmp-act-choose-ink)' },
  break: { fill: 'var(--cmp-act-break)', ink: 'var(--cmp-act-break-ink)' },
  waiting: { fill: 'var(--cmp-act-wait)', ink: 'var(--cmp-act-wait-ink)' },
};

export function DaySplitLegend() {
  return (
    <ul className={styles.legend} aria-label="Activities">
      {DAY_SPLIT_PARTS.map((p) => (
        <li key={p.key}>
          <span className={styles.swatch} style={{ background: ACT[p.key].fill }} aria-hidden="true" />
          {p.label}
        </li>
      ))}
    </ul>
  );
}

/** One 100% bar per agent: on a call, choosing the outcome, break, waiting (grey, never flagged). */
export function DaySplitBars({ agents, columns }: { agents: readonly ChartAgent[]; columns: readonly AgencyCompareAgent[] }) {
  const [ref, width] = useChartWidth(420);
  return (
    <div ref={ref} className={styles.dayRows}>
      {agents.map((agent) => {
        const split = columns.find((c) => c.agent_user_id === agent.id)?.day_split;
        const segments = split ? daySplitSegments(split, 0, width) : [];
        const logged = split ? durationWords(split.shift_seconds) : null;
        const summary = segments.length
          ? `${agent.name}, ${logged} logged in: ${segments.map((s) => `${s.label.toLowerCase()} ${s.percent}%`).join(', ')}.`
          : `${agent.name}: no logged-in time on this campaign in this window.`;
        return (
          <div key={agent.id} className={styles.dayRow} data-testid="compare-day-row">
            <div className={styles.dayName}>
              <span className={styles.dot} style={{ background: agentColour(agent.slot) }} aria-hidden="true" />
              <span>{agent.name}</span>
              <span>{segments.length ? `· ${logged} logged in` : '· not logged in'}</span>
            </div>
            {segments.length ? (
              <svg width={width} height={26} viewBox={`0 0 ${width} 26`} role="img" aria-label={summary}>
                {segments.map((s, i) => (
                  <g key={s.key} data-testid="compare-day-segment" data-key={s.key}>
                    <rect x={s.x} y={0} width={s.width} height={26} rx={i === 0 || i === segments.length - 1 ? 4 : 2} fill={ACT[s.key].fill}>
                      <title>{`${agent.name} · ${s.label}: ${s.percent}% · ${durationWords(s.seconds)}`}</title>
                    </rect>
                    {s.width > 36 ? (
                      <text x={s.x + 6} y={17} fontSize={11.5} fontWeight={700} fill={ACT[s.key].ink} pointerEvents="none">
                        {`${s.percent}%`}
                      </text>
                    ) : null}
                  </g>
                ))}
              </svg>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
