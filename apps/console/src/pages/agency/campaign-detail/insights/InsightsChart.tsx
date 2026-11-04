import { useId } from 'react';
import { useChartWidth } from '../../../../components/agency/useChartWidth';
import { columnPath, niceCeiling } from '../../../../components/agency/AgentBucketChart';
import { formatCount, pct } from '../../../../utils/format/number';
import styles from './Insights.module.css';

/**
 * Bars for a count and, optionally, a line for a rate on its own right-hand
 * axis: dials and connect rate by bucket, agents online, abandonment against
 * its ceiling, best hours.
 *
 * ── To scale ────────────────────────────────────────────────────────────────
 * Both axes start at zero. The bar axis tops out at `niceCeiling` of the
 * tallest bar (the geometry `AgentBucketChart` and the campaign charts share);
 * the rate axis at the next 10% above the highest rate or reference, so a 3%
 * ceiling and a 2.1% rate are drawn where they are, not stretched to the top.
 * A withheld rate (fewer than 25 calls in the bucket) is a gap in the line,
 * never a point at zero.
 *
 * Measured with `useChartWidth`, so one SVG unit is one CSS pixel and the type
 * stays its own size at every width.
 */

export interface ChartPoint {
  key: string;
  /** Short axis label. */
  label: string;
  /** Full label for the tooltip. */
  title: string;
  bar: number;
  /** Percent, or null where withheld / undefined. */
  line?: number | null;
}

const FALLBACK_WIDTH = 720;
const HEIGHT = 220;
const PAD_LEFT = 44;
const PAD_TOP = 14;
const PAD_BOTTOM = 26;

export function rateAxisTop(values: Array<number | null | undefined>, reference?: number): number {
  const max = Math.max(0, reference ?? 0, ...values.map((v) => (typeof v === 'number' ? v : 0)));
  return Math.min(100, Math.max(10, Math.ceil(max / 10) * 10));
}

export function InsightsChart({
  points,
  barLabel,
  lineLabel,
  reference,
  description,
  testId,
}: {
  points: ChartPoint[];
  barLabel: string;
  lineLabel?: string;
  /** A horizontal line on the rate axis, e.g. the abandonment ceiling. */
  reference?: { value: number; label: string };
  /** The chart's accessible name. */
  description: string;
  testId?: string;
}) {
  const titleId = useId();
  const [plotRef, width] = useChartWidth(FALLBACK_WIDTH);
  const hasLine = lineLabel !== undefined;
  const padRight = hasLine ? 40 : 10;
  const plotW = width - PAD_LEFT - padRight;
  const plotH = HEIGHT - PAD_TOP - PAD_BOTTOM;
  const barTop = niceCeiling(points.reduce((m, p) => Math.max(m, p.bar), 0));
  const lineTop = rateAxisTop(points.map((p) => p.line), reference?.value);
  const band = plotW / Math.max(1, points.length);
  const barW = Math.max(2, Math.min(28, band * 0.64));
  const baseline = PAD_TOP + plotH;
  const yBar = (v: number) => baseline - (v / barTop) * plotH;
  const yLine = (v: number) => baseline - (v / lineTop) * plotH;
  const xMid = (i: number) => PAD_LEFT + i * band + band / 2;
  const labelEvery = Math.ceil(points.length / 12);

  // The line, broken at every withheld bucket.
  const segments: string[] = [];
  let current: string[] = [];
  points.forEach((p, i) => {
    if (typeof p.line === 'number') current.push(`${xMid(i)},${yLine(p.line)}`);
    else if (current.length) {
      segments.push(current.join(' '));
      current = [];
    }
  });
  if (current.length) segments.push(current.join(' '));

  return (
    <div className={styles.chart}>
      <div className={styles.plot} ref={plotRef}>
        <svg
          className={styles.svg}
          width={width}
          height={HEIGHT}
          viewBox={`0 0 ${width} ${HEIGHT}`}
          role="img"
          aria-labelledby={titleId}
          data-testid={testId}
        >
          <title id={titleId}>{description}</title>
          {[0, 0.5, 1].map((f) => {
            const y = baseline - f * plotH;
            return (
              <g key={f}>
                <line className={f === 0 ? styles.axis : styles.grid} x1={PAD_LEFT} x2={width - padRight} y1={y} y2={y} />
                <text className={styles.tick} x={PAD_LEFT - 6} y={y + 3} textAnchor="end">{formatCount(Math.round(barTop * f))}</text>
                {hasLine ? <text className={styles.tick} x={width - padRight + 6} y={y + 3}>{pct(lineTop * f)}</text> : null}
              </g>
            );
          })}
          {points.map((p, i) => {
            const h = baseline - yBar(p.bar);
            return (
              <g key={p.key} data-testid={testId ? `${testId}-bucket` : undefined}>
                <title>{`${p.title}: ${formatCount(p.bar)} ${barLabel.toLowerCase()}${hasLine ? `, ${typeof p.line === 'number' ? pct(p.line) : 'not enough calls'} ${lineLabel?.toLowerCase()}` : ''}`}</title>
                <path className={styles.bar} d={columnPath(xMid(i) - barW / 2, yBar(p.bar), barW, h)} />
                {i % labelEvery === 0 ? (
                  <text className={styles.tick} x={xMid(i)} y={HEIGHT - 8} textAnchor="middle">{p.label}</text>
                ) : null}
              </g>
            );
          })}
          {reference ? (
            <line className={styles.ceiling} x1={PAD_LEFT} x2={width - padRight} y1={yLine(reference.value)} y2={yLine(reference.value)} data-testid="chart-reference" />
          ) : null}
          {segments.map((s) => (
            <polyline key={s} className={styles.line} points={s} />
          ))}
        </svg>
      </div>
      <ul className={styles.legend}>
        <li className={styles.legendItem}><span className={`${styles.swatch} ${styles.swatchBar}`} aria-hidden="true" />{barLabel}</li>
        {hasLine ? <li className={styles.legendItem}><span className={`${styles.swatch} ${styles.swatchLine}`} aria-hidden="true" />{lineLabel}</li> : null}
        {reference ? <li className={styles.legendItem}><span className={`${styles.swatch} ${styles.swatchCeiling}`} aria-hidden="true" />{reference.label}</li> : null}
      </ul>
    </div>
  );
}
