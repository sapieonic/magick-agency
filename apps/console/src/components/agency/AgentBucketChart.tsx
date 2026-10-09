import { useId, useState } from 'react';
import {
  BUCKET_TIMEZONE_NOTE,
  SINGLE_BUCKET_NOTE,
  type BucketSeries,
  type SeriesPoint,
} from '../../utils/agencyAgentPerformance';
import styles from './AgentBucketChart.module.css';

/**
 * Day-by-day dials and conversations, as inline SVG.
 *
 * ── Why not chart.js, which this repo already ships ────────────────────────
 * `/app/campaign-analytics` uses chart.js and that stays. This chart is on
 * `/dialer/performance`, which is a full-viewport page outside both shells whose
 * primary reader is a dedicated `agent` — frequently on the oldest machine in the
 * building. chart.js and its date adapter are a ~90 kB parse before a single bar
 * appears, for two series of at most 31 points with no zoom, no pan and no time
 * scale (the buckets are pre-aggregated; the x axis is ordinal, not temporal).
 * `Sparkline` set this precedent for the same reason. Nothing was added to
 * `package.json`.
 *
 * ── The form ────────────────────────────────────────────────────────────────
 * **Grouped columns, never stacked.** Every connected call is also a dial, so the
 * two series overlap rather than partition: stacking them would draw a column
 * whose height is a number that does not exist. Grouping puts them side by side,
 * which is also the product rule the tiles above follow — an agent must always be
 * able to tell "dials I made" from "conversations I had".
 *
 * Two series, so a legend is always present and both series are also named in the
 * numbers table below: identity is never carried by colour alone. The palette is
 * the product's own `--accent` and `--teal` (a plain palette hue, deliberately
 * NOT `--success`, which is a status token and must not stand in for a series).
 * The pair clears the colour-blind separation gate comfortably in both themes
 * (worst deutan ΔE 23, tritan 16, normal-vision 30, against a target of 8).
 *
 * ── A single day does not get a chart ──────────────────────────────────────
 * A one-column bar chart is a stat tile wearing axes, and the tiles above already
 * do that job properly. So a one-bucket range renders the reason instead, naming
 * the range that would draw.
 */

export interface AgentBucketChartProps {
  series: BucketSeries;
  /** Rendered by the caller when absent; here only so the note sits with the chart. */
  className?: string;
}

/** Plot geometry. Fixed rather than measured — see `preserveAspectRatio` below. */
const VIEW_WIDTH = 720;
const VIEW_HEIGHT = 220;
const PAD_LEFT = 44;
const PAD_RIGHT = 8;
const PAD_TOP = 16;
const PAD_BOTTOM = 28;
/** The spec's ceiling. A band wider than this keeps its leftover as air. */
const MAX_BAR = 24;
/** The surface gap that separates the two touching bars of a group. */
const BAR_GAP = 2;

const PLOT_W = VIEW_WIDTH - PAD_LEFT - PAD_RIGHT;
const PLOT_H = VIEW_HEIGHT - PAD_TOP - PAD_BOTTOM;

/**
 * The axis top, rounded up to a clean number.
 *
 * A tick reading `37` is a tick nobody can divide by, and a clean midpoint is
 * what lets these charts carry two labelled gridlines instead of five — so the
 * result is always EVEN, and never below 2. Both guards exist because the
 * midpoint is rendered with `Math.round`, which quietly turned a line at 1.5
 * into a tick reading 2.
 *
 * ── Why not the 1/2/5 ladder ───────────────────────────────────────────────
 * That is the textbook set and it was what shipped here first, but its rungs are
 * far apart in the middle of the range: a campaign peaking at 516 dials a day
 * jumped to a top of 1,000, so every bar sat in the bottom half of the plot and
 * the chart spent half its height on air. 3, 4, 6 and 8 close the two widest
 * gaps and each still halves exactly. The 1→2 rung is unchanged, so nothing that
 * was tight before has loosened.
 */
export function niceCeiling(max: number): number {
  if (max <= 0) return 2;
  /*
    Floored at 2, not 1. These charts label three gridlines — 0, `top / 2` and
    `top` — with `Math.round`, so a ceiling of 1 printed the axis as **0, 1, 1**:
    the same number twice, one of them on a line drawn at 0.5. A campaign's first
    morning, or any range peaking at a single dial, hit it. Two is the smallest
    top whose half is a whole number.
  */
  if (max <= 2) return 2;
  const magnitude = 10 ** Math.floor(Math.log10(max));
  for (const step of [1, 2, 3, 4, 5, 6, 8, 10]) {
    const candidate = step * magnitude;
    /*
      An odd top mislabels the middle line for the same reason: a peak of 3 gives
      `top = 3` and a line drawn at 1.5 labelled "2", so a 2-dial bar's top sits
      visibly above the tick reading 2. Only reachable at magnitude 1 — from 10
      up every rung's half is already whole — so it is cheaper to skip the odd
      candidate there than to carry a decimal into the tick labels.
    */
    if (candidate >= max && (magnitude > 1 || candidate % 2 === 0)) return candidate;
  }
  return 10 * magnitude;
}

/**
 * A column path: rounded at the data end, square at the baseline.
 *
 * Drawn as a path rather than a `<rect rx>` because `rx` rounds all four
 * corners, which lifts the bar off its own baseline and makes a short bar look
 * like a pill floating above the axis. The radius also collapses for a bar
 * shorter than it, so a single dial does not render as a semicircle.
 */
export function columnPath(x: number, y: number, width: number, height: number): string {
  const r = Math.min(4, width / 2, Math.max(height, 0));
  const bottom = y + height;
  if (height <= 0) return '';
  return [
    `M${x},${bottom}`,
    `L${x},${y + r}`,
    `Q${x},${y} ${x + r},${y}`,
    `L${x + width - r},${y}`,
    `Q${x + width},${y} ${x + width},${y + r}`,
    `L${x + width},${bottom}`,
    'Z',
  ].join(' ');
}

export function AgentBucketChart({ series, className }: AgentBucketChartProps) {
  const titleId = useId();
  const [showTable, setShowTable] = useState(false);

  if (!series.drawable) {
    return (
      <div className={`${styles.wrap} ${className ?? ''}`}>
        <Header />
        <p className={styles.note} data-testid="bucket-chart-single">
          {SINGLE_BUCKET_NOTE}
        </p>
      </div>
    );
  }

  const top = niceCeiling(series.max);
  const bandWidth = PLOT_W / series.points.length;
  const barWidth = Math.min(MAX_BAR, Math.max(2, (bandWidth - BAR_GAP) / 2 - 2));
  const groupWidth = barWidth * 2 + BAR_GAP;
  const scale = (value: number) => (value / top) * PLOT_H;

  /**
   * Which bar gets a direct label: the tallest dial column, and only it.
   *
   * A value on every column is chaos and goes unread; the label works because it
   * is the only one. The axis and the numbers table carry the rest.
   */
  const peakIndex = series.points.reduce(
    (best, point, index) => (point.attempts > (series.points[best]?.attempts ?? -1) ? index : best),
    0,
  );

  /** Every label would collide past roughly a fortnight, so they thin out. */
  const labelEvery = Math.ceil(series.points.length / 16);

  return (
    <div className={`${styles.wrap} ${className ?? ''}`}>
      <Header />

      <div className={styles.plot}>
        {/*
          `preserveAspectRatio` is left at its default and the SVG is width-100%:
          the chart scales as one piece rather than reflowing, which keeps the
          bar/gap ratio the spec fixes. A measured-width chart would have to
          re-derive the geometry on every resize for no gain at this data size.
        */}
        <svg
          className={styles.svg}
          viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
          role="img"
          aria-labelledby={titleId}
          data-testid="bucket-chart"
        >
          <title id={titleId}>
            {`Dials and conversations by day, ${series.points.length} days, up to ${top.toLocaleString()} calls a day.`}
          </title>

          {/* Hairline, solid, one step off the surface. Three lines, not five —
              the direct label and the numbers table carry the precision. */}
          {[0, 0.5, 1].map((fraction) => {
            const y = PAD_TOP + PLOT_H - fraction * PLOT_H;
            return (
              <g key={fraction}>
                <line
                  className={fraction === 0 ? styles.axis : styles.grid}
                  x1={PAD_LEFT}
                  y1={y}
                  x2={VIEW_WIDTH - PAD_RIGHT}
                  y2={y}
                />
                <text className={styles.tick} x={PAD_LEFT - 8} y={y + 4} textAnchor="end">
                  {Math.round(top * fraction).toLocaleString()}
                </text>
              </g>
            );
          })}

          {series.points.map((point, index) => {
            const bandStart = PAD_LEFT + index * bandWidth + (bandWidth - groupWidth) / 2;
            const attemptsH = scale(point.attempts);
            const connectedH = scale(point.connected);
            const baseline = PAD_TOP + PLOT_H;

            return (
              <g key={point.start} className={styles.group} data-testid={`bucket-${point.start}`}>
                {/* One tooltip for the pair, because the reader's question is
                    always "how did these two compare on that day". */}
                <title>{`${point.title}: ${point.attempts.toLocaleString()} dials, ${point.connected.toLocaleString()} conversations`}</title>
                {/* A full-height hit target, so hovering does not require
                    landing on a two-pixel bar on a quiet day. */}
                <rect
                  className={styles.hit}
                  x={bandStart - BAR_GAP}
                  y={PAD_TOP}
                  width={groupWidth + BAR_GAP * 2}
                  height={PLOT_H}
                />
                <path
                  className={styles.attempts}
                  d={columnPath(bandStart, baseline - attemptsH, barWidth, attemptsH)}
                />
                <path
                  className={styles.connected}
                  d={columnPath(
                    bandStart + barWidth + BAR_GAP,
                    baseline - connectedH,
                    barWidth,
                    connectedH,
                  )}
                />
                {index === peakIndex && point.attempts > 0 && (
                  <text
                    className={styles.peak}
                    data-testid="bucket-peak"
                    x={bandStart + groupWidth / 2}
                    y={baseline - attemptsH - 6}
                    textAnchor="middle"
                  >
                    {point.attempts.toLocaleString()}
                  </text>
                )}
                {index % labelEvery === 0 && (
                  <text
                    className={styles.dayLabel}
                    x={bandStart + groupWidth / 2}
                    y={baseline + 16}
                    textAnchor="middle"
                  >
                    {point.label}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
      </div>

      {/* Legend, always: two series must never be told apart by colour alone. */}
      <ul className={styles.legend}>
        <li className={styles.legendItem}>
          <span className={`${styles.swatch} ${styles.swatchAttempts}`} aria-hidden="true" />
          Dials
        </li>
        <li className={styles.legendItem}>
          <span className={`${styles.swatch} ${styles.swatchConnected}`} aria-hidden="true" />
          Conversations
        </li>
      </ul>

      <p className={styles.note} data-testid="bucket-timezone-note">
        {BUCKET_TIMEZONE_NOTE}
      </p>

      {/*
        The numbers, for anyone the bars do not serve — a screen reader, a
        printout, or somebody who wants the figure rather than the shape. It is a
        disclosure rather than a permanent table because it repeats the chart
        exactly; hidden by default, present always.
      */}
      <button
        type="button"
        className={styles.disclosure}
        onClick={() => setShowTable((open) => !open)}
        aria-expanded={showTable}
      >
        {showTable ? 'Hide the numbers' : 'Show the numbers'}
      </button>
      {showTable && <NumbersTable points={series.points} />}
    </div>
  );
}

function Header() {
  return (
    <div className={styles.header}>
      <h3 className={styles.heading}>Day by day</h3>
      <p className={styles.description}>
        What you dialled and what you talked to, one bar pair per day.
      </p>
    </div>
  );
}

function NumbersTable({ points }: { points: SeriesPoint[] }) {
  return (
    <div className={styles.tableScroll}>
      <table className={styles.table} data-testid="bucket-chart-table">
        <caption className={styles.caption}>Dials and conversations by day</caption>
        <thead>
          <tr>
            <th scope="col">Day</th>
            <th scope="col">Dials</th>
            <th scope="col">Conversations</th>
          </tr>
        </thead>
        <tbody>
          {points.map((point) => (
            <tr key={point.start}>
              <th scope="row">{point.title}</th>
              <td>{point.attempts.toLocaleString()}</td>
              <td>{point.connected.toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default AgentBucketChart;
