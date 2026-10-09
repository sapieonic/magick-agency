import { useId, useState } from 'react';
import { useChartWidth } from './useChartWidth';
import { columnPath, niceCeiling } from './AgentBucketChart';
import type { BucketSeries, SeriesPoint } from '../../utils/agencyAgentPerformance';
import styles from './CampaignActivityChart.module.css';

/**
 * One campaign's dials and the calls that spoke to a person, day by day.
 *
 * ── The second series is `human_connects`, and its LABEL matters ───────────
 * `AgencyCampaignSeries.buckets` mirrors `AgencyAgentStatsBucket` field for
 * field, and that type defines `connected` as "the ones where a person was on
 * the line" — so this series is the campaign payload's `human_connects`, NOT its
 * wider `attempts_connected`.
 *
 * It was labelled "Conversations", inherited from `AgentBucketChart` where an
 * agent only ever sees bridged calls so the distinction never arises. On this
 * panel it does: the pulse strip four hundred pixels above teaches, carefully,
 * that "Reached someone" (`attempts_connected`, answering machines included) and
 * "Spoke to a person" (`human_connects`) are deliberately different numbers —
 * and then a legend underneath called the second one by a third name. One word
 * per concept across the workspace, so it reuses the strip's own.
 *
 * ── What this is, and what it deliberately is not ──────────────────────────
 * This is `AgentBucketChart`'s form applied to a campaign instead of a person:
 * grouped columns, `--accent` for dials and `--teal` for the second series, three
 * gridlines, one direct label on the peak, thinned day labels, a legend that is
 * always present and the numbers behind a disclosure. Every one of those
 * decisions is argued in that file's docstring and none of them changes because
 * the subject changed, so they are not restated here.
 *
 * It is NOT that component with a prop, because it renders neither of that
 * component's two notes. `BUCKET_TIMEZONE_NOTE` and `SINGLE_BUCKET_NOTE` are
 * agent-surface copy: the first explains that a "day" may not be one contiguous
 * 24 hours for somebody working campaigns in several zones, which is false of a
 * single campaign — one campaign has exactly one zone, and
 * `campaignSeriesZoneNote` names it. The second answers a range picker this
 * component does not own. `CampaignSeriesSection` supplies both.
 *
 * ── And it owns no chrome ──────────────────────────────────────────────────
 * No heading, no card, no range picker, no loading or empty state: the Section
 * owns all of that and only mounts this when `series.drawable`. What is here is
 * the plot, the legend and the numbers — the parts that are about the marks.
 *
 * `niceCeiling` and `columnPath` are IMPORTED rather than reimplemented: they
 * are the mark geometry itself, and a second copy is exactly where a 4px radius
 * and a baseline-anchored path drift apart between two charts that are supposed
 * to be the same chart.
 */

export interface CampaignActivityChartProps {
  series: BucketSeries;
  /** For the caller's own spacing; the Section owns the card around this. */
  className?: string;
}

/**
 * Plot geometry, in REAL CSS pixels — see `useChartWidth` for why this chart is
 * measured rather than drawn into a fixed `viewBox` and scaled.
 *
 * `FALLBACK_WIDTH` is what an unlaid-out plot draws at: the first paint, a
 * collapsed container, and every test. The height is derived from the width so
 * the plot keeps a sane proportion across the range this card actually spans
 * (a phone at ~320 through the workspace's 2400px cap) rather than growing to
 * a third of a tall monitor, which is what a fixed aspect ratio did here.
 */
const FALLBACK_WIDTH = 860;
const chartHeight = (width: number) => Math.round(Math.max(220, Math.min(360, width * 0.26)));
const PAD_LEFT = 44;
const PAD_RIGHT = 8;
const PAD_TOP = 16;
const PAD_BOTTOM = 28;
/**
 * The mark ceiling. A band wider than this keeps its leftover as air.
 *
 * Raised from the per-agent chart's 24 once the plot became a measured 2280px
 * rather than a scaled 720: a 24px bar pair in a 106px band reads as a row of
 * isolated ticks rather than a series, and the bar/gap ratio the spec fixes was
 * only ever preserved there because everything scaled together.
 */
const MAX_BAR = 34;
/** The surface gap that separates the two touching bars of a group. */
const BAR_GAP = 2;


export function CampaignActivityChart({ series, className }: CampaignActivityChartProps) {
  const titleId = useId();
  const tableId = useId();
  const [showTable, setShowTable] = useState(false);
  const [plotRef, VIEW_WIDTH] = useChartWidth(FALLBACK_WIDTH);

  const VIEW_HEIGHT = chartHeight(VIEW_WIDTH);
  const PLOT_W = VIEW_WIDTH - PAD_LEFT - PAD_RIGHT;
  const PLOT_H = VIEW_HEIGHT - PAD_TOP - PAD_BOTTOM;

  const top = niceCeiling(series.max);
  const bandWidth = PLOT_W / Math.max(1, series.points.length);
  const barWidth = Math.min(MAX_BAR, Math.max(2, (bandWidth - BAR_GAP) / 2 - 2));
  const groupWidth = barWidth * 2 + BAR_GAP;
  const scale = (value: number) => (value / top) * PLOT_H;

  /**
   * Which bar gets a direct label: the busiest dialing day, and only it.
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
      <div className={styles.plot} ref={plotRef}>
        {/*
          The `viewBox` is the MEASURED width, so one SVG unit is one CSS pixel
          and nothing is scaled: `font-size: 12` axis labels are 12px at 2400px
          just as they are at 400, and the 4px bar radius and the 2px surface gap
          between a bar pair stay the sizes the mark specs give them. See
          `useChartWidth` for the alternative and what it did to the type.
        */}
        <svg
          className={styles.svg}
          width={VIEW_WIDTH}
          height={VIEW_HEIGHT}
          viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
          role="img"
          aria-labelledby={titleId}
          data-testid="campaign-activity-chart"
        >
          <title id={titleId}>
            {`Dials and calls that spoke to a person, by day, ${series.points.length} days, up to ${top.toLocaleString()} calls a day.`}
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
              <g
                key={`${point.start}-${index}`}
                className={styles.group}
                data-testid={`campaign-activity-bucket-${point.start}`}
              >
                {/* One tooltip for the pair, because the reader's question is
                    always "how did these two compare on that day". */}
                <title>{`${point.title}: ${point.attempts.toLocaleString()} dials, ${point.connected.toLocaleString()} spoke to a person`}</title>
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
                    x={bandStart + groupWidth / 2}
                    y={baseline - attemptsH - 6}
                    textAnchor="middle"
                    data-testid="campaign-activity-peak"
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
          Spoke to a person
        </li>
      </ul>

      {/*
        The numbers, for anyone the bars do not serve — a screen reader, a
        printout, or somebody who wants the figure rather than the shape. It is a
        disclosure rather than a permanent table because it repeats the chart
        exactly. It is mounted on demand, NOT hidden with `hidden` — the comment
        used to claim "present always", which was untrue and bought nothing
        anyway: a `hidden` element is out of the accessibility tree and out of a
        printout too, so the only thing it would add is DOM weight. The button
        names it through `aria-controls`.
      */}
      <button
        type="button"
        className={styles.disclosure}
        onClick={() => setShowTable((open) => !open)}
        aria-expanded={showTable}
        // Names WHAT it expands. `aria-expanded` alone tells a screen-reader
        // user the state of something it never identifies.
        aria-controls={tableId}
      >
        {showTable ? 'Hide the numbers' : 'Show the numbers'}
      </button>
      {showTable && <NumbersTable id={tableId} points={series.points} />}
    </div>
  );
}

function NumbersTable({ id, points }: { id: string; points: SeriesPoint[] }) {
  return (
    <div className={styles.tableScroll} id={id}>
      <table className={styles.table} data-testid="campaign-activity-table">
        <caption className={styles.caption}>Dials and calls that spoke to a person, by day</caption>
        <thead>
          <tr>
            <th scope="col">Day</th>
            <th scope="col">Dials</th>
            <th scope="col">Spoke to a person</th>
          </tr>
        </thead>
        <tbody>
          {/* Keyed by POSITION: the module deliberately does not re-sort or
              de-duplicate the server's buckets, so `bucket_start` is not a key. */}
          {points.map((point, index) => (
            <tr key={`${point.start}-${index}`}>
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

export default CampaignActivityChart;
