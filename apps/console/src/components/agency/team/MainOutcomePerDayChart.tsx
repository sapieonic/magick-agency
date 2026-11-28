import { useId } from 'react';
import { ChartColumn } from 'lucide-react';
import type { AgencyTeamTrend } from '@magick-agency/contracts/api/agency/team-performance';
import { formatCount } from '../../../utils/format/number';
import { formatReportDay } from '../../../utils/reports/reportCopy';
import { trendLine, trendSummary } from '../../../utils/agency/team/teamCopy';
import { trendColumnsGeometry } from '../../../utils/agency/team/teamCharts';
import { useChartWidth } from '../useChartWidth';
import styles from './Team.module.css';

/**
 * The main outcome per working day (`docs/team-performance.md` TP12): one column per working day
 * (a day off is left out, not drawn as 0), one colour, the last column labelled. Drawn at the
 * measured width (`useChartWidth`), named for a screen reader (`role="img"` with a summary), and
 * the numbers are in a table only a screen reader reads.
 */
export function MainOutcomePerDayChart({ trend, label }: { trend: AgencyTeamTrend; label: string }) {
  const titleId = useId();
  const [ref, width] = useChartWidth(520);
  const g = trendColumnsGeometry({ width, trend });
  const summary = trendSummary(label, trend);
  return (
    <section className={styles.card} aria-labelledby={titleId} data-testid="team-trend">
      <div className={styles.cardHead}>
        <ChartColumn size={16} aria-hidden="true" className={styles.cardIcon} />
        <h2 className={styles.cardTitle} id={titleId}>
          {`${label} per day`}
        </h2>
        <span className={styles.cardSub}>{`· ${trendLine(trend)}`}</span>
      </div>
      {trend.dates.length === 0 ? (
        <p className={styles.emptyNote}>No working days in this period yet.</p>
      ) : (
        <>
          <div ref={ref} className={styles.plot}>
            <svg width={g.width} height={g.height} viewBox={`0 0 ${g.width} ${g.height}`} role="img" aria-label={summary} data-testid="team-trend-chart">
              {g.ticks.map((t) => (
                <g key={t.value} aria-hidden="true">
                  <line className={t.value === 0 ? styles.axis : styles.grid} x1={g.left} x2={g.right} y1={t.y} y2={t.y} />
                  <text className={styles.tick} x={g.left - 8} y={t.y + 4} textAnchor="end">
                    {formatCount(t.value)}
                  </text>
                </g>
              ))}
              {g.columns.map((c) => (
                <g key={c.date} aria-hidden="true">
                  <title>{`${formatReportDay(c.date, false)}: ${formatCount(c.count)}`}</title>
                  {c.path ? <path className={styles.column} d={c.path} /> : null}
                  {c.label ? (
                    <text className={styles.dayLabel} x={c.cx} y={g.baseline + 17} textAnchor="middle">
                      {c.label}
                    </text>
                  ) : null}
                </g>
              ))}
              {g.lastLabel ? (
                <text className={styles.peak} x={g.lastLabel.x} y={g.lastLabel.y} textAnchor="middle" aria-hidden="true" data-testid="team-trend-last">
                  {formatCount(g.lastLabel.text)}
                </text>
              ) : null}
            </svg>
          </div>
          <table className="sr-only" data-testid="team-trend-table">
            <caption>{`${label} per working day`}</caption>
            <thead>
              <tr>
                <th scope="col">Day</th>
                <th scope="col">{label}</th>
              </tr>
            </thead>
            <tbody>
              {trend.dates.map((d, i) => (
                <tr key={d}>
                  <th scope="row">{formatReportDay(d, false)}</th>
                  <td>{formatCount(trend.counts[i] ?? 0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </section>
  );
}
