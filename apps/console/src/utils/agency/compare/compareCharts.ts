import type { AgencyCompareDaySplit } from '@magick-agency/contracts/api/agency/compare';
import { formatReportDay } from '../../reports/reportCopy';

/**
 * Compare agents' chart geometry (`docs/compare-agents.md` §5): pure functions from figures and
 * a measured width to SVG coordinates, so every mark is unit-tested without a browser and one SVG
 * unit is one CSS pixel at every width (`useChartWidth`). The components only draw what these
 * return.
 *
 * Mark specs follow the house's chart rules: thin bars with a rounded data end, 2px lines,
 * markers of at least 8px, a 2px surface gap between stacked segments, the team as a recessive
 * band and line, never a colour of its own.
 */

// ─── Side by side: one bar per agent against the team ───────────────────────

export const BAR_ROW_HEIGHT = 28;
export const BAR_THICKNESS = 14;
const BAR_TOP = 6;
const BAR_BOTTOM = 20;
/** Room right of the plot for the value at a bar's end. */
const BAR_RIGHT = 58;
/** Roughly the width of one character of the 12px value label, to keep it inside the SVG. */
const CHAR_WIDTH = 7;
/** The clear space kept between a value label and the median line. */
const LINE_CLEAR = 3;
/** Roughly the width of one character of the 11.5px italic withheld words. */
const WITHHELD_CHAR_WIDTH = 6;

export interface BarRowInput {
  /** The figure in its unit (a rate as a fraction). */
  value: number | null;
  reportable: boolean;
  /** A rate's 95% interval (fractions), drawn as a whisker. */
  interval: [number, number] | null;
  /** The text at the bar's end, already formatted. */
  valueText: string;
  /** What is drawn in place of a bar under the floor, already worded. */
  withheldText: string;
  /** The same in fewer words, drawn when the long form would not fit the plot. */
  withheldShort?: string;
}

export interface BarChartInput {
  width: number;
  rows: readonly BarRowInput[];
  cohort: { p25: number | null; median: number | null; p75: number | null };
  /** Rates cap the scale at 100%. */
  isRate: boolean;
  /** Whole counts: the scale reaches at least {@link COUNT_SCALE_MIN}, so all zeros never fill it. */
  isCount?: boolean;
}

/**
 * The least top of a count's scale. A count of breaks over their limit is mostly 0, and the
 * team's p75 can be 0.25; scaled to that, a quarter of a break would fill the chart. Four keeps
 * the two breaks that name an agent at half the width.
 */
export const COUNT_SCALE_MIN = 4;

export type BarRowGeometry =
  | { kind: 'bar'; y: number; x0: number; width: number; whisker: { x1: number; x2: number } | null; valueX: number; valueText: string }
  | { kind: 'withheld'; y: number; x0: number; text: string };

export interface BarChartGeometry {
  width: number;
  height: number;
  /** Where the bars start (right of the agents' names). */
  left: number;
  /** The scale's top value. */
  max: number;
  /**
   * The middle half of the team, p25 to p75, behind the bars; null when the team has no band, or
   * none worth drawing (p25 and p75 the same: the median line says it).
   */
  band: { x: number; width: number } | null;
  /** The team median's line; null when no agent clears the floor. */
  median: { x: number } | null;
  /**
   * The stretches the band and median line are drawn over: each run of rows with a bar. A row of
   * words ("Too few to compare …") is left clear, so the line never runs through its text; with
   * no bar at all there is no stretch, and the median is said in words under the chart.
   */
  spans: Array<{ top: number; bottom: number }>;
  rows: BarRowGeometry[];
}

/** The width of the names column: a third of the chart, between 64 and 120px. */
export function barLabelWidth(width: number): number {
  return Math.round(Math.min(120, Math.max(64, width * 0.3)));
}

/**
 * The scale's top: 12% past the largest thing drawn (a bar, a whisker's end, the band's top or
 * the median), so nothing touches the edge; a rate's scale stops at 100%, a count's is at least
 * {@link COUNT_SCALE_MIN}. Never 0.
 */
export function barScaleMax(input: Pick<BarChartInput, 'rows' | 'cohort' | 'isRate' | 'isCount'>): number {
  const values: number[] = [];
  for (const row of input.rows) {
    if (!row.reportable || row.value === null) continue;
    values.push(row.value);
    if (row.interval) values.push(row.interval[1]);
  }
  for (const v of [input.cohort.p75, input.cohort.median, input.cohort.p25]) if (v !== null) values.push(v);
  const top = Math.max(0, ...values.filter(Number.isFinite));
  const floor = input.isCount ? COUNT_SCALE_MIN : 1;
  if (top <= 0) return floor;
  const padded = top * 1.12;
  if (input.isRate) return Math.min(1, padded);
  return input.isCount ? Math.max(floor, padded) : padded;
}

export function barChartGeometry(input: BarChartInput): BarChartGeometry {
  const width = Math.max(200, Math.round(input.width));
  const left = barLabelWidth(width);
  const plotW = Math.max(40, width - left - BAR_RIGHT);
  const max = barScaleMax(input);
  const x = (v: number) => left + plotW * Math.min(1, Math.max(0, v / max));
  const { p25, median, p75 } = input.cohort;
  const band = p25 !== null && p75 !== null && x(p75) - x(p25) >= 1 ? { x: x(p25), width: x(p75) - x(p25) } : null;
  const medianX = median !== null ? x(median) : null;
  const rows = input.rows.map((row, i): BarRowGeometry => {
    const y = BAR_TOP + i * BAR_ROW_HEIGHT;
    if (!row.reportable || row.value === null) {
      const fits = row.withheldText.length * WITHHELD_CHAR_WIDTH <= width - left;
      return { kind: 'withheld', y, x0: left, text: fits || !row.withheldShort ? row.withheldText : row.withheldShort };
    }
    const barW = Math.max(3, x(row.value) - left);
    const whisker = row.interval ? { x1: x(row.interval[0]), x2: x(row.interval[1]) } : null;
    const after = Math.max(left + barW, whisker ? whisker.x2 : 0) + 6;
    const textW = row.valueText.length * CHAR_WIDTH;
    let valueX = Math.min(after, width - textW - 2);
    // The median line runs down every row: a value it would cut moves just past it, when there
    // is room; at the right edge the label's halo keeps it readable.
    if (medianX !== null && medianX >= valueX - LINE_CLEAR && medianX <= valueX + textW + LINE_CLEAR) {
      const past = medianX + LINE_CLEAR + 2;
      if (past + textW <= width - 2) valueX = past;
    }
    return { kind: 'bar', y, x0: left, width: barW, whisker, valueX, valueText: row.valueText };
  });
  const spans: Array<{ top: number; bottom: number }> = [];
  rows.forEach((row, i) => {
    if (row.kind !== 'bar') return;
    const top = BAR_TOP + i * BAR_ROW_HEIGHT - 2;
    const bottom = BAR_TOP + (i + 1) * BAR_ROW_HEIGHT - 4;
    const last = spans[spans.length - 1];
    if (last && rows[i - 1]?.kind === 'bar') last.bottom = bottom;
    else spans.push({ top, bottom });
  });
  return {
    width,
    height: BAR_TOP + input.rows.length * BAR_ROW_HEIGHT + BAR_BOTTOM,
    left,
    max,
    band,
    median: medianX !== null ? { x: medianX } : null,
    spans,
    rows,
  };
}

/**
 * The path of a bar with its data end rounded (radius 4) and its baseline end square, anchored at
 * `x0`. Under 8px wide it is a plain rectangle: a rounded end would be wider than the bar.
 */
export function barPath(x0: number, y: number, width: number, height = BAR_THICKNESS, radius = 4): string {
  if (width < 8) return `M${x0} ${y}h${width}v${height}h${-width}z`;
  const r = Math.min(radius, height / 2);
  return `M${x0} ${y}h${width - r}a${r} ${r} 0 0 1 ${r} ${r}v${height - 2 * r}a${r} ${r} 0 0 1 ${-r} ${r}h${-(width - r)}z`;
}

// ─── Agents' names on a chart ──────────────────────────────────────────────

/** Roughly the width of one character of a 12px name. */
const NAME_CHAR_WIDTH = 6.6;

/** A name cut to fit `width` pixels of 12px text: "Lakshmi Prasa…". */
export function fitName(name: string, width: number): string {
  const max = Math.max(4, Math.floor(width / NAME_CHAR_WIDTH));
  return name.length <= max ? name : `${name.slice(0, max - 1)}…`;
}

/**
 * Each name cut to fit `width` ({@link fitName}), and never two the same on one chart: names that
 * cut to the same words keep their ends instead ("Lakshmi…Pillai"), and names that are the same
 * in full are numbered ("Priya M (2)"), so a label always tells the agents apart.
 */
export function distinctNames(names: readonly string[], width: number): string[] {
  const max = Math.max(4, Math.floor(width / NAME_CHAR_WIDTH));
  const out = names.map((n) => fitName(n, width));
  const clashes = (i: number) => out.some((o, j) => j !== i && o === out[i]);
  const cut = names.map((n, i) => {
    if (!clashes(i) || n.length <= max) return out[i]!;
    const tail = Math.ceil((max - 1) / 2);
    return `${n.slice(0, max - 1 - tail)}…${n.slice(-tail)}`;
  });
  const seen = new Map<string, number>();
  return cut.map((c) => {
    const k = (seen.get(c) ?? 0) + 1;
    seen.set(c, k);
    return k === 1 ? c : `${c} (${k})`;
  });
}

// ─── The trend: a line per agent per working day ────────────────────────────

const TREND_TOP = 12;
const TREND_BOTTOM = 26;
const TREND_LEFT = 34;
/** The width an end label's name is cut to: the bars' names column at its usual width. */
export const TREND_NAME_WIDTH = 92;
/** The gap between a line's last point and its label. */
const END_LABEL_OFFSET = 8;
/** The least space between two x-axis dates, so their labels never touch. */
const MIN_LABEL_GAP = 52;
/** The least space between two end labels. */
const END_LABEL_GAP = 14;

export interface TrendSeriesInput {
  id: string;
  counts: ReadonlyArray<number | null>;
  /** The agent's full name; the end label cuts it as the bars do ({@link distinctNames}). */
  name: string;
}

export interface TrendInput {
  width: number;
  height: number;
  dates: readonly string[];
  series: readonly TrendSeriesInput[];
  median: ReadonlyArray<number | null>;
}

export interface TrendGeometry {
  width: number;
  height: number;
  plotLeft: number;
  plotRight: number;
  plotTop: number;
  plotBottom: number;
  yMax: number;
  ticks: Array<{ value: number; y: number }>;
  xs: number[];
  xLabels: Array<{ index: number; x: number; text: string }>;
  series: Array<{ id: string; path: string; dots: Array<{ x: number; y: number }>; last: { x: number; y: number } | null }>;
  medianPath: string;
  /** Each line's label, beside its LAST point (a line that stopped early is labelled where it stopped). */
  endLabels: Array<{ id: string; x: number; y: number; text: string; team: boolean }>;
}

/**
 * A clean axis top for counts: four gridlines of a whole step, the step from the ladder
 * 1, 2, 3, 4, 5, 6, 8 times a power of ten (the bucket chart's, whose middle rungs keep a
 * count of 21 from jumping to an axis of 40). At least 4, so every tick is a whole number.
 */
export function niceCountMax(value: number): number {
  const need = Number.isFinite(value) && value > 0 ? value / 4 : 1;
  const power = 10 ** Math.floor(Math.log10(Math.max(1, need)));
  for (const rung of [1, 2, 3, 4, 5, 6, 8, 10]) {
    if (rung * power >= need) return rung * power * 4;
  }
  return 40 * power;
}

/**
 * An SVG path through the non-null points, broken on every null so a day off is a gap, never a
 * dip (§5). A point with no non-null neighbour cannot be a line; it is returned in `dots`.
 */
export function brokenLinePath(
  values: ReadonlyArray<number | null>,
  x: (i: number) => number,
  y: (v: number) => number,
): { path: string; dots: Array<{ x: number; y: number }> } {
  let path = '';
  const dots: Array<{ x: number; y: number }> = [];
  values.forEach((v, i) => {
    if (v === null) return;
    const prev = i > 0 ? values[i - 1] : null;
    const next = i < values.length - 1 ? values[i + 1] : null;
    const px = round(x(i));
    const py = round(y(v));
    if (prev === null || prev === undefined) {
      if (next === null || next === undefined) dots.push({ x: px, y: py });
      path += `M${px} ${py}`;
    } else {
      path += `L${px} ${py}`;
    }
  });
  return { path, dots };
}

function round(n: number): number {
  return Math.round(n * 10) / 10;
}

/** Which dates get a label: every k-th so labels stay {@link MIN_LABEL_GAP} apart, and always the last. */
export function labelledDateIndexes(count: number, plotWidth: number): number[] {
  if (count <= 0) return [];
  if (count === 1) return [0];
  const spacing = plotWidth / (count - 1);
  const every = Math.max(1, Math.ceil(MIN_LABEL_GAP / Math.max(1, spacing)));
  const out: number[] = [];
  for (let i = 0; i < count; i += every) out.push(i);
  const last = count - 1;
  if (out[out.length - 1] !== last) {
    // The last date always shows; the label before it gives way when the two would touch.
    if (out.length > 1 && (last - out[out.length - 1]!) * spacing < MIN_LABEL_GAP) out.pop();
    out.push(last);
  }
  return out;
}

/** Roughly how wide a label is drawn. */
function labelWidth(text: string): number {
  return text.length * NAME_CHAR_WIDTH;
}

/**
 * End labels that could touch, grouped: labels whose spans across (x to x + width) overlap, so
 * only those are pushed apart and a label that stands clear stays beside its point.
 */
export function overlappingGroups(labels: ReadonlyArray<{ x: number; text: string }>): number[][] {
  const order = labels.map((l, i) => ({ i, x: l.x, right: l.x + labelWidth(l.text) })).sort((a, b) => a.x - b.x || a.i - b.i);
  const groups: number[][] = [];
  let right = -Infinity;
  for (const o of order) {
    if (groups.length > 0 && o.x < right) groups[groups.length - 1]!.push(o.i);
    else groups.push([o.i]);
    right = groups[groups.length - 1]!.length === 1 ? o.right : Math.max(right, o.right);
  }
  return groups;
}

/**
 * End labels pushed apart so none overlaps the one above it (at least {@link END_LABEL_GAP}
 * apart, top to bottom), then pulled back up if the last went past the plot's foot.
 */
export function spreadLabels(ys: readonly number[], top: number, bottom: number, gap = END_LABEL_GAP): number[] {
  const order = ys.map((y, i) => ({ y, i })).sort((a, b) => a.y - b.y || a.i - b.i);
  const placed = order.map((o) => o.y);
  for (let k = 0; k < placed.length; k += 1) {
    const floor = k === 0 ? top : placed[k - 1]! + gap;
    placed[k] = Math.max(placed[k]!, floor);
  }
  for (let k = placed.length - 1; k >= 0; k -= 1) {
    const ceiling = k === placed.length - 1 ? bottom : placed[k + 1]! - gap;
    placed[k] = Math.min(placed[k]!, ceiling);
  }
  const out = new Array<number>(ys.length);
  order.forEach((o, k) => {
    out[o.i] = placed[k]!;
  });
  return out;
}

function lastPoint(values: ReadonlyArray<number | null>): { index: number; value: number } | null {
  for (let i = values.length - 1; i >= 0; i -= 1) {
    const v = values[i];
    if (v !== null && v !== undefined) return { index: i, value: v };
  }
  return null;
}

export function trendGeometry(input: TrendInput): TrendGeometry {
  const width = Math.max(260, Math.round(input.width));
  const height = input.height;
  const names = distinctNames(
    input.series.map((s) => s.name),
    TREND_NAME_WIDTH,
  );
  const lasts = input.series.map((s) => lastPoint(s.counts));
  const texts = lasts.map((last, i) => (last ? `${names[i]} · ${last.value}` : null));
  const medianLast = lastPoint(input.median);
  const teamText = medianLast ? `Team · ${formatMedian(medianLast.value)}` : null;
  // Room right of the plot for the longest label of a line that runs to the last day.
  const widest = Math.max(0, ...[...texts, teamText].filter((t): t is string => t !== null).map(labelWidth));
  const plotLeft = TREND_LEFT;
  const plotRight = width - Math.round(Math.min(width / 3, Math.max(40, END_LABEL_OFFSET + widest + 4)));
  // Beside the point, kept inside the SVG on the narrowest charts.
  const labelX = (pointX: number, text: string) => round(Math.min(pointX + END_LABEL_OFFSET, width - labelWidth(text) - 2));
  const plotTop = TREND_TOP;
  const plotBottom = height - TREND_BOTTOM;
  const n = input.dates.length;
  const all = [...input.series.flatMap((s) => s.counts), ...input.median].filter((v): v is number => v !== null);
  const yMax = niceCountMax(Math.max(0, ...all) * 1.1);
  const x = (i: number) => (n <= 1 ? (plotLeft + plotRight) / 2 : plotLeft + ((plotRight - plotLeft) * i) / (n - 1));
  const y = (v: number) => plotBottom - ((plotBottom - plotTop) * v) / yMax;
  const ticks = [0, 1, 2, 3, 4].map((k) => ({ value: (yMax * k) / 4, y: round(y((yMax * k) / 4)) }));
  const xs = input.dates.map((_, i) => round(x(i)));
  const xLabels = labelledDateIndexes(n, plotRight - plotLeft).map((i) => ({ index: i, x: xs[i]!, text: formatReportDay(input.dates[i]!, false) }));
  const series = input.series.map((s, i) => {
    const line = brokenLinePath(s.counts, x, y);
    const last = lasts[i];
    return { id: s.id, path: line.path, dots: line.dots, last: last ? { x: round(x(last.index)), y: round(y(last.value)) } : null };
  });
  const medianPath = brokenLinePath(input.median, x, y).path;
  const ends: Array<{ id: string; x: number; y: number; text: string; team: boolean }> = [];
  input.series.forEach((s, i) => {
    const last = series[i]!.last;
    if (last && texts[i]) ends.push({ id: s.id, x: labelX(last.x, texts[i]!), y: last.y + 4, text: texts[i]!, team: false });
  });
  if (medianLast && teamText) {
    ends.push({ id: 'team', x: labelX(x(medianLast.index), teamText), y: round(y(medianLast.value)) + 4, text: teamText, team: true });
  }
  const spread = ends.map((e) => e.y);
  for (const group of overlappingGroups(ends)) {
    const ys = spreadLabels(
      group.map((i) => ends[i]!.y),
      plotTop + 4,
      plotBottom + 4,
    );
    group.forEach((i, k) => {
      spread[i] = ys[k]!;
    });
  }
  return {
    width,
    height,
    plotLeft,
    plotRight,
    plotTop,
    plotBottom,
    yMax,
    ticks,
    xs,
    xLabels,
    series,
    medianPath,
    endLabels: ends.map((e, i) => ({ ...e, y: round(spread[i]!) })),
  };
}

/** A median count: whole when it is, else to one decimal (the median of two days can be 10.5). */
export function formatMedian(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

// ─── Where their day went: a 100% stacked bar per agent ─────────────────────

export type DaySplitKey = 'on_call' | 'choosing' | 'break' | 'waiting';

/** The order and words of the four parts of the shift (CP5: breaks inside; waiting never flagged). */
export const DAY_SPLIT_PARTS: ReadonlyArray<{ key: DaySplitKey; label: string }> = [
  { key: 'on_call', label: 'On a call' },
  { key: 'choosing', label: 'Choosing outcome' },
  { key: 'break', label: 'Break' },
  { key: 'waiting', label: 'Waiting for a call' },
];

/**
 * Whole percentages that add up to exactly 100 (largest remainder), so the four labels of one
 * bar never read 99% or 101% in all. All zeros when there is nothing to share out.
 */
export function wholePercents(parts: readonly number[]): number[] {
  const total = parts.reduce((s, p) => s + Math.max(0, p), 0);
  if (total <= 0) return parts.map(() => 0);
  const exact = parts.map((p) => (Math.max(0, p) / total) * 100);
  const floors = exact.map(Math.floor);
  let left = 100 - floors.reduce((s, f) => s + f, 0);
  const order = exact.map((e, i) => ({ i, r: e - Math.floor(e) })).sort((a, b) => b.r - a.r || a.i - b.i);
  for (const { i } of order) {
    if (left <= 0) break;
    floors[i] = floors[i]! + 1;
    left -= 1;
  }
  return floors;
}

export interface DaySegment {
  key: DaySplitKey;
  label: string;
  seconds: number;
  /** Whole percent of the shift (the four add up to 100). */
  percent: number;
  x: number;
  width: number;
}

/** The 2px surface gap between two touching segments. */
const SEGMENT_GAP = 2;

/**
 * One agent's bar from `x0` across `width`: each part's share of the logged-in time, in the
 * order of {@link DAY_SPLIT_PARTS}, with a 2px gap between parts; a part of no time has no
 * segment. Empty when there was no logged-in time.
 */
export function daySplitSegments(split: AgencyCompareDaySplit, x0: number, width: number): DaySegment[] {
  const seconds = DAY_SPLIT_PARTS.map((p) => Math.max(0, split[p.key]));
  const total = seconds.reduce((s, v) => s + v, 0);
  if (total <= 0 || width <= 0) return [];
  const percents = wholePercents(seconds);
  const out: DaySegment[] = [];
  const lastIndex = seconds.reduce((last, v, i) => (v > 0 ? i : last), -1);
  let x = x0;
  DAY_SPLIT_PARTS.forEach((part, i) => {
    const share = seconds[i]! / total;
    const w = width * share;
    if (seconds[i]! > 0) {
      const gap = i === lastIndex ? 0 : SEGMENT_GAP;
      out.push({ key: part.key, label: part.label, seconds: seconds[i]!, percent: percents[i]!, x: round(x), width: round(Math.max(1, w - gap)) });
    }
    x += w;
  });
  return out;
}
