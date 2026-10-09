import { useId, useState } from 'react';
import { useChartWidth } from './useChartWidth';
import { agentPct } from '../../utils/agencyAgentPerformance';
import { CONVERSION_DENOMINATOR_NOTE } from '../../utils/agencyCampaignSeries';
import type {
  RatePoint,
  RateRun,
  RateSeriesKey,
  RateSeriesLine,
  RateTrend,
} from '../../utils/agencyCampaignSeries';
import styles from './CampaignRateChart.module.css';

/**
 * Connect rate and conversion over the same days, as two lines.
 *
 * ── A gap is a gap, and that is the whole component ────────────────────────
 * `rateTrend` hands down `values` with a `null` wherever a day had no
 * denominator or too small a one, and `runs` — the unbroken stretches of
 * measured days. **One `<path>` per run.** A single path across the whole array
 * would join the day before a gap to the day after it, drawing a segment that
 * asserts a trend through days nobody measured; plotting the gap at 0% would be
 * worse still, because a Sunday with no dials would read as a collapse and a
 * supervisor acts on a collapse. A run of length one gets a **dot** rather than
 * nothing: an isolated measured day is a reading, and a line chart that silently
 * omits it is the same lie in the other direction.
 *
 * ── The two rates never appear as two bare percentages ─────────────────────
 * Connect rate is measured over DIALS, conversion over CONVERSATIONS. A reader
 * who assumes one denominator for both is out by a factor that changes what they
 * do next. The Performance cards solve this with a denominator line under each
 * figure; a chart has one legend for both, so each legend entry carries its own
 * `denominator` string. That is why the legend is not optional here even beyond
 * the usual "identity is never colour alone" rule.
 *
 * ── Form and palette follow `AgentBucketChart` ─────────────────────────────
 * Same three gridlines, same recessive chrome, same disclosure over the numbers,
 * and the same `--accent` / `--teal` pair — deliberately NOT `--success`, which
 * is a status token meaning good/bad and must not stand in for a series
 * identity. Direct labels are on the last measured point of each line only; a
 * value on every point is chaos and goes unread.
 *
 * The Section owns the card, the heading, the range picker and the notes about
 * the range and the campaign's time zone. What is here is the plot, the legend,
 * the withheld-days sentence and the numbers.
 */

export interface CampaignRateChartProps {
  trend: RateTrend;
  /** For the caller's own spacing; the Section owns the card around this. */
  className?: string;
}

/**
 * Plot geometry, in REAL CSS pixels — see `useChartWidth` for why this chart is
 * measured rather than drawn into a fixed `viewBox` and scaled. The short
 * version: a scaled viewBox scales its type, and at the workspace's 2400px this
 * chart's axis labels landed on screen three times the size of the heading
 * above them.
 */
const FALLBACK_WIDTH = 860;
const chartHeight = (width: number) => Math.round(Math.max(220, Math.min(360, width * 0.26)));
const PAD_LEFT = 44;
/** Wider than the bar chart's: the right-hand direct labels live in this margin. */
const PAD_RIGHT = 52;
const PAD_TOP = 20;
const PAD_BOTTOM = 28;

/** The radius of an isolated measured day, drawn where a line cannot be. */
const DOT_R = 3.5;
/**
 * How close two end labels may sit vertically before the second moves.
 *
 * Must be at least the label's own LINE HEIGHT, not its font size: two 11px
 * labels 14px apart do not collide by any arithmetic that compares against 11,
 * and they overlap on screen — which is what a threshold of 12 did on a campaign
 * whose two rates sat four points apart. 22 is the label plus its ascender and a
 * little air, measured against `.endLabel` in this module's stylesheet.
 */
const LABEL_COLLISION = 22;

const STROKE: Record<RateSeriesKey, string> = {
  connect: styles.strokeConnect!,
  conversion: styles.strokeConversion!,
};

const FILL: Record<RateSeriesKey, string> = {
  connect: styles.fillConnect!,
  conversion: styles.fillConversion!,
};

/** What a `null` reads as, in the reader's words. Never `0%`. */
const NO_READING = 'not enough calls';

export function CampaignRateChart({ trend, className }: CampaignRateChartProps) {
  const titleId = useId();
  const tableId = useId();
  const [showTable, setShowTable] = useState(false);
  const [plotRef, VIEW_WIDTH] = useChartWidth(FALLBACK_WIDTH);

  const VIEW_HEIGHT = chartHeight(VIEW_WIDTH);
  const PLOT_W = VIEW_WIDTH - PAD_LEFT - PAD_RIGHT;
  const PLOT_H = VIEW_HEIGHT - PAD_TOP - PAD_BOTTOM;

  const { points, lines } = trend;
  const top = trend.max;
  const bandWidth = PLOT_W / Math.max(1, points.length);
  /** Band centres, so the first and last day are not welded to the axis. */
  const xOf = (index: number) => PAD_LEFT + (index + 0.5) * bandWidth;
  const yOf = (value: number) => PAD_TOP + PLOT_H - (value / top) * PLOT_H;

  /** Every label would collide past roughly a fortnight, so they thin out. */
  const labelEvery = Math.ceil(points.length / 16);
  const baseline = PAD_TOP + PLOT_H;

  /*
    One direct label per line, on its last measured day.

    When the two land on top of each other the SECOND series' label drops below
    its own point rather than both being nudged apart by half the overlap: a
    symmetric nudge moves the connect label too, so the reader cannot tell which
    of the two is actually at that height. Sending one down leaves the other
    exactly where its point is, and the marker beneath each label says which line
    it belongs to.
  */
  const endLabels = lines.flatMap((line) => {
    if (line.lastIndex === null) return [];
    const value = line.values[line.lastIndex] ?? null;
    if (value === null) return [];
    return [{
      key: line.key,
      label: line.label,
      x: xOf(line.lastIndex),
      y: yOf(value),
      text: agentPct(value),
      below: false,
    }];
  });
  const [first, second] = endLabels;
  if (first && second
    && Math.abs(first.x - second.x) < bandWidth * 2
    && Math.abs(first.y - second.y) < LABEL_COLLISION) {
    second.below = true;
  }

  return (
    <div className={`${styles.wrap} ${className ?? ''}`}>
      <div className={styles.plot} ref={plotRef}>
        {/*
          The `viewBox` is the MEASURED width, so one SVG unit is one CSS pixel:
          the 2px line stroke is 2px and the tick labels are the size they are
          set at, whatever the card is. See `useChartWidth`.
        */}
        <svg
          className={styles.svg}
          width={VIEW_WIDTH}
          height={VIEW_HEIGHT}
          viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
          role="img"
          aria-labelledby={titleId}
          data-testid="campaign-rate-chart"
        >
          <title id={titleId}>
            {`Connect rate and conversion by day, ${points.length} days, `
              + `on one axis running to ${top}%. Days without enough calls behind them `
              + 'are left as gaps in the lines.'}
          </title>

          {/* One axis, in percent. Three lines, not five — the direct labels and
              the numbers table carry the precision. */}
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
                  {`${Math.round(top * fraction)}%`}
                </text>
              </g>
            );
          })}

          {/* Day labels, off the ordinal axis. */}
          {points.map((point, index) => (
            index % labelEvery === 0 ? (
              <text
                key={`${point.start}-${index}`}
                className={styles.dayLabel}
                x={xOf(index)}
                y={baseline + 16}
                textAnchor="middle"
              >
                {point.label}
              </text>
            ) : null
          ))}

          {/* One path per RUN, never one across the array. */}
          {lines.map((line) => (
            <g key={line.key}>
              {line.runs.map((run) => (
                run.from === run.to
                  ? renderDot(line, run, xOf, yOf)
                  : (
                    <path
                      key={`${line.key}-${run.from}`}
                      className={`${styles.line} ${STROKE[line.key]}`}
                      // Per RUN, not per line: a series with a gap draws several
                      // paths, and a shared id makes `getByTestId` throw.
                      data-testid={`campaign-rate-line-${line.key}-${run.from}`}
                      d={runPath(line, run, xOf, yOf)}
                    />
                  )
              ))}
            </g>
          ))}

          {/* The direct labels, each with the marker that says whose it is. */}
          {endLabels.map((end) => (
            <g key={end.key}>
              <circle
                className={`${styles.marker} ${FILL[end.key]}`}
                cx={end.x}
                cy={end.y}
                r={4}
              />
              <text
                className={styles.endLabel}
                x={end.x}
                y={end.below ? end.y + 16 : end.y - 9}
                textAnchor="middle"
                data-testid={`campaign-rate-end-${end.key}`}
              >
                {end.text}
              </text>
            </g>
          ))}

          {/* Hover last, so the hit targets sit above the marks. A full-height
              rect per day: hovering must not require landing on a 2px line. */}
          {points.map((point, index) => (
            <g
              key={`${point.start}-${index}`}
              className={styles.day}
              data-testid={`campaign-rate-day-${point.start}`}
            >
              <title>{dayTooltip(point, lines, index)}</title>
              <rect
                className={styles.hit}
                x={PAD_LEFT + index * bandWidth}
                y={PAD_TOP}
                width={bandWidth}
                height={PLOT_H}
              />
            </g>
          ))}
        </svg>
      </div>

      {/* The denominator travels IN the legend entry — see the docstring. */}
      <ul className={styles.legend}>
        {lines.map((line) => (
          <li key={line.key} className={styles.legendItem} data-testid={`campaign-rate-legend-${line.key}`}>
            <span className={`${styles.swatch} ${swatchClass(line.key)}`} aria-hidden="true" />
            <span className={styles.legendLabel}>{line.label}</span>
            <span className={styles.legendDenominator}>{line.denominator}</span>
          </li>
        ))}
      </ul>

      {/* Why days are missing, on the page rather than behind a hover: a caveat
          you have to find is one the chart gets read without. */}
      {/*
        Stated, not hidden: this chart's conversion divides by the calls that
        spoke to a person, the card above divides by every call that connected.
        Two conversion figures a few inches apart that disagree, with nothing
        accounting for the gap, is how a supervisor stops trusting both.
      */}
      <p className={styles.note} data-testid="campaign-rate-denominator-note">
        {CONVERSION_DENOMINATOR_NOTE}
      </p>

      {trend.withheldNote && (
        <p className={styles.note} data-testid="campaign-rate-withheld">{trend.withheldNote}</p>
      )}

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
      {showTable && <NumbersTable id={tableId} points={points} lines={lines} />}
    </div>
  );
}

/**
 * An isolated measured day.
 *
 * A run of one has no second point to draw a segment to, so without this the day
 * simply vanishes — and a reading that is present in the table and absent from
 * the plot is the chart disagreeing with itself.
 */
function renderDot(
  line: RateSeriesLine,
  run: RateRun,
  xOf: (index: number) => number,
  yOf: (value: number) => number,
) {
  const value = line.values[run.from] ?? null;
  if (value === null) return null;
  return (
    <circle
      key={`${line.key}-${run.from}`}
      className={`${styles.dot} ${FILL[line.key]}`}
      data-testid={`campaign-rate-dot-${line.key}`}
      cx={xOf(run.from)}
      cy={yOf(value)}
      r={DOT_R}
    />
  );
}

function runPath(
  line: RateSeriesLine,
  run: RateRun,
  xOf: (index: number) => number,
  yOf: (value: number) => number,
): string {
  const commands: string[] = [];
  for (let index = run.from; index <= run.to; index += 1) {
    const value = line.values[index] ?? null;
    // `runs` are measured by construction; the guard is here so a malformed run
    // degrades to a shorter line rather than to `NaN` in the `d` attribute,
    // which renders as nothing at all with no error anywhere.
    if (value === null) continue;
    commands.push(`${commands.length === 0 ? 'M' : 'L'}${xOf(index)},${yOf(value)}`);
  }
  return commands.join(' ');
}

/** A rate as text, or the words that say why there isn't one. */
function rateText(value: number | null): string {
  return value === null ? NO_READING : agentPct(value);
}

/**
 * One tooltip for the day, naming both rates.
 *
 * The same phrase covers a day with no dials at all and a day with too few:
 * from the reader's side both are "there is no rate here worth reading", and the
 * distinction between them is the withheld sentence's job, not a tooltip's.
 */
function dayTooltip(point: RatePoint, lines: RateSeriesLine[], index: number): string {
  const parts = lines.map(
    (line) => `${line.label}: ${rateText(line.values[index] ?? null)}`,
  );
  return `${point.title} · ${parts.join(' · ')}`;
}

function valueAt(lines: RateSeriesLine[], key: RateSeriesKey, index: number): number | null {
  const line = lines.find((candidate) => candidate.key === key);
  return line ? line.values[index] ?? null : null;
}

/**
 * The numbers behind the plot.
 *
 * The rate columns read the LINE's values, not the point's own `connect` /
 * `conversion`. A day withheld for too small a denominator is `null` in the line
 * and would still be a number on the point — printing it here would put a figure
 * in the table that the chart declined to plot, and the reader would rightly
 * trust the table.
 */
function NumbersTable({ id, points, lines }: { id: string; points: RatePoint[]; lines: RateSeriesLine[] }) {
  return (
    <div className={styles.tableScroll} id={id}>
      <table className={styles.table} data-testid="campaign-rate-table">
        <caption className={styles.caption}>Connect rate and conversion by day</caption>
        <thead>
          <tr>
            <th scope="col">Day</th>
            <th scope="col">Dials</th>
            <th scope="col">Spoke to a person</th>
            <th scope="col">Connect rate</th>
            <th scope="col">Conversion</th>
          </tr>
        </thead>
        <tbody>
          {points.map((point, index) => {
            const connect = valueAt(lines, 'connect', index);
            const conversion = valueAt(lines, 'conversion', index);
            return (
              <tr key={`${point.start}-${index}`}>
                <th scope="row">{point.title}</th>
                <td>{point.attempts.toLocaleString()}</td>
                <td>{point.connected.toLocaleString()}</td>
                {/* An em dash, never `0%` — the day has no reading, not a zero one. */}
                <td>{connect === null ? '—' : agentPct(connect)}</td>
                <td>{conversion === null ? '—' : agentPct(conversion)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function swatchClass(key: RateSeriesKey): string {
  return key === 'connect' ? styles.swatchConnect! : styles.swatchConversion!;
}

export default CampaignRateChart;
