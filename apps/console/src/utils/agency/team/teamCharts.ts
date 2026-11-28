import { TEAM_OUTCOME_BARS_MAX, type AgencyTeamOutcomeBar, type AgencyTeamTrend } from '@magick-agency/contracts/api/agency/team-performance';
import type { AgencyTileIcon } from '@magick-agency/contracts/agency/tile-icons';
import { columnPath } from '../../../components/agency/AgentBucketChart';
import { labelledDateIndexes } from '../compare/compareCharts';
import { isoWeekday } from '../../reports/reportWindow';
import { outcomeLabel } from './teamCopy';

/**
 * Team performance's chart geometry (`docs/team-performance.md` §2 item 3): pure functions from
 * figures and a measured width to coordinates, so every mark is unit-tested without a browser and
 * one SVG unit is one CSS pixel (`useChartWidth`). The components only draw what these return.
 *
 * One colour for every bar (TP12, TP13): the charts compare sizes, not kinds. The axis is this
 * file's {@link trendAxis} (a finer top than `AgentBucketChart`'s `niceCeiling`, whose 1-2-3-…×10ⁿ
 * tops leave a peak of 105 under an axis of 200), the columns `AgentBucketChart`'s `columnPath`
 * (rounded at the data end, square on the baseline), and which days get a label is Compare's
 * `labelledDateIndexes`.
 */

// ─── The main outcome per working day ───────────────────────────────────────

const TREND_HEIGHT = 220;
const TREND_TOP = 22;
const TREND_BOTTOM = 26;
const TREND_LEFT = 36;
const TREND_RIGHT = 8;
/** The widest a column is drawn; a wider band keeps the rest as air. */
const COLUMN_MAX = 34;

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;

/** A working day under its column: "Tue 10". */
export function dayLabel(day: string): string {
  return `${WEEKDAYS[isoWeekday(day) - 1]} ${Number(day.slice(8, 10))}`;
}

/** Steps the per-day axis may take, times a power of ten. */
const AXIS_STEPS = [1, 2, 2.5, 3, 4, 5] as const;

/**
 * The per-day chart's axis: a whole-number step of 1, 2, 2.5, 3, 4 or 5 × 10ⁿ, with three or four
 * gaps between its lines, choosing the lowest top (fewer lines when two tops tie), so the tallest
 * column fills most of the plot: 105 → 0, 40, 80, 120; 98 → 0, 25, 50, 75, 100. A chart with
 * nothing to draw, or a peak of 1, still gets a top of 2 and whole-number lines.
 */
export function trendAxis(max: number): { top: number; step: number } {
  if (!(max > 2)) return { top: 2, step: 1 };
  let best: { top: number; step: number; gaps: number } | null = null;
  for (const gaps of [3, 4]) {
    const wanted = max / gaps;
    const magnitude = 10 ** Math.floor(Math.log10(wanted));
    const step = [...AXIS_STEPS, 10]
      .map((m) => m * magnitude)
      .find((candidate) => candidate >= wanted && Number.isInteger(candidate)) ?? 10 * magnitude;
    const top = Math.ceil(max / step) * step;
    const n = top / step;
    if (best === null || top < best.top || (top === best.top && n < best.gaps)) best = { top, step, gaps: n };
  }
  return { top: best!.top, step: best!.step };
}

export interface TrendColumn {
  date: string;
  count: number;
  /** The column's centre. */
  cx: number;
  path: string;
  /** The day under the column, or null when it gives way to its neighbours. */
  label: string | null;
}

export interface TrendColumnsGeometry {
  width: number;
  height: number;
  left: number;
  right: number;
  baseline: number;
  /** The axis top ({@link trendAxis}). */
  top: number;
  /** The labelled lines, 0 to the top, one {@link trendAxis} step apart. */
  ticks: Array<{ value: number; y: number }>;
  columns: TrendColumn[];
  /** The last column's count, drawn above it (TP12: the last bar labelled). */
  lastLabel: { x: number; y: number; text: number } | null;
}

export function trendColumnsGeometry(input: { width: number; trend: Pick<AgencyTeamTrend, 'dates' | 'counts'> }): TrendColumnsGeometry {
  const width = Math.max(240, Math.round(input.width));
  const { dates, counts } = input.trend;
  const plotW = width - TREND_LEFT - TREND_RIGHT;
  const plotH = TREND_HEIGHT - TREND_TOP - TREND_BOTTOM;
  const baseline = TREND_TOP + plotH;
  const { top, step } = trendAxis(Math.max(0, ...counts));
  const n = dates.length;
  const band = n > 0 ? plotW / n : plotW;
  const columnW = Math.max(3, Math.min(COLUMN_MAX, band * 0.55));
  // Labels are spaced as the columns are: `labelledDateIndexes` reads (n − 1) gaps over its width.
  const labelled = new Set(labelledDateIndexes(n, n > 1 ? band * (n - 1) : plotW));
  const columns = dates.map((date, i): TrendColumn => {
    const count = counts[i] ?? 0;
    const cx = TREND_LEFT + band * i + band / 2;
    const h = top > 0 ? (count / top) * plotH : 0;
    return {
      date,
      count,
      cx: round(cx),
      path: columnPath(round(cx - columnW / 2), round(baseline - h), round(columnW), round(h)),
      label: labelled.has(i) ? dayLabel(date) : null,
    };
  });
  const last = columns[columns.length - 1];
  const lastH = last && top > 0 ? (last.count / top) * plotH : 0;
  return {
    width,
    height: TREND_HEIGHT,
    left: TREND_LEFT,
    right: width - TREND_RIGHT,
    baseline,
    top,
    ticks: Array.from({ length: Math.round(top / step) + 1 }, (_, k) => ({ value: k * step, y: round(baseline - ((k * step) / top) * plotH) })),
    columns,
    lastLabel: last ? { x: last.cx, y: round(baseline - lastH - 7), text: last.count } : null,
  };
}

function round(n: number): number {
  return Math.round(n * 10) / 10;
}

// ─── What happened on the calls ─────────────────────────────────────────────

export interface OutcomeBarRow {
  key: string;
  label: string;
  icon: AgencyTileIcon | null;
  conversations: number;
  /** The bar's length as a share of the longest, 0–100. */
  share: number;
  /** The folded remainder (TP13). */
  other: boolean;
}

/**
 * The bars, most first: the first {@link TEAM_OUTCOME_BARS_MAX} one by one, the rest summed into
 * "Other outcomes" (TP13). The answer's order is kept (the server sends them most first).
 */
export function outcomeBars(outcomes: readonly AgencyTeamOutcomeBar[], max: number = TEAM_OUTCOME_BARS_MAX): OutcomeBarRow[] {
  const shown = outcomes.slice(0, max);
  const rest = outcomes.slice(max);
  const rows: Array<Omit<OutcomeBarRow, 'share'>> = shown.map((o) => ({
    key: o.code ?? '∅',
    label: outcomeLabel(o),
    icon: o.icon,
    conversations: o.conversations,
    other: false,
  }));
  if (rest.length > 0) {
    rows.push({
      key: '…other',
      label: 'Other outcomes',
      icon: null,
      conversations: rest.reduce((sum, o) => sum + o.conversations, 0),
      other: true,
    });
  }
  const longest = Math.max(0, ...rows.map((r) => r.conversations));
  return rows.map((r) => ({ ...r, share: longest > 0 ? round((r.conversations / longest) * 100) : 0 }));
}

/** The conversations on the main outcome's codes, the bar the footnote compares with the tile (TP13). */
export function mainOutcomeBarCount(outcomes: readonly AgencyTeamOutcomeBar[], codes: readonly string[]): number {
  return outcomes.reduce((sum, o) => (o.code !== null && codes.includes(o.code) ? sum + o.conversations : sum), 0);
}

// ─── The table's inline bars ────────────────────────────────────────────────

/** A value as a share (0–100) of the column's scale; null for a value that is not drawn. */
export function inlineShare(value: number | null, scale: number): number | null {
  if (value === null || !Number.isFinite(value) || scale <= 0) return null;
  return round(Math.min(100, Math.max(0, (value / scale) * 100)));
}

/**
 * A column's scale: its largest drawn value or its median, whichever is larger, so every bar and
 * the median tick fit. Never 0.
 */
export function inlineScale(values: ReadonlyArray<number | null>, median: number | null): number {
  const top = Math.max(0, ...values.filter((v): v is number => v !== null && Number.isFinite(v)), median ?? 0);
  return top > 0 ? top : 1;
}
