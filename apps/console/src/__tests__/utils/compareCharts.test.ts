import { describe, it, expect } from 'vitest';
import {
  barChartGeometry,
  barLabelWidth,
  barPath,
  barScaleMax,
  brokenLinePath,
  COUNT_SCALE_MIN,
  daySplitSegments,
  distinctNames,
  fitName,
  labelledDateIndexes,
  niceCountMax,
  overlappingGroups,
  spreadLabels,
  trendGeometry,
  wholePercents,
} from '../../utils/agency/compare/compareCharts';
import { formatReportDay } from '../../utils/reports/reportCopy';
import { THREE_DAYS_COLLECTIONS } from '../helpers/compareRecorded';

/**
 * Compare agents' chart geometry (`docs/compare-agents.md` §5): pure functions from figures and a
 * measured width to SVG coordinates. Bars against the team's band and median, a figure under the
 * floor as words, a per-day line broken on days off, and a 100% day split whose labels add up.
 */

const row = (value: number | null, over: Partial<Parameters<typeof barChartGeometry>[0]['rows'][number]> = {}) => ({
  value,
  reportable: true,
  interval: null,
  valueText: String(value),
  withheldText: 'Too few to compare (12 calls; needs 20)',
  ...over,
});

describe('side by side', () => {
  it('scales to 12% past the largest mark, a rate never past 100%', () => {
    expect(barScaleMax({ rows: [row(40)], cohort: { p25: 30, median: 35, p75: 50 }, isRate: false })).toBeCloseTo(56);
    expect(barScaleMax({ rows: [row(0.3, { interval: [0.2, 0.95] })], cohort: { p25: null, median: null, p75: null }, isRate: true })).toBe(1);
    expect(barScaleMax({ rows: [row(0)], cohort: { p25: null, median: null, p75: null }, isRate: false })).toBe(1);
    // A withheld value is not on the scale.
    expect(barScaleMax({ rows: [row(900, { reportable: false }), row(10)], cohort: { p25: null, median: null, p75: null }, isRate: false })).toBeCloseTo(11.2);
  });

  it('never sets a bar’s value label on the median line when there is room past it (390 px)', () => {
    const text = '1m';
    let moved = 0;
    for (const median of [60, 61, 62, 63, 64, 65, 66, 68, 70]) {
      const g = barChartGeometry({ width: 330, rows: [row(60, { valueText: text }), row(66, { valueText: '1m 6s' })], cohort: { p25: null, median, p75: null }, isRate: false });
      const mx = g.median!.x;
      for (const r of g.rows) {
        if (r.kind !== 'bar') continue;
        const right = r.valueX + r.valueText.length * 7;
        const onLine = mx >= r.valueX - 3 && mx <= right + 3;
        expect(onLine, `median ${median}, label ${r.valueText} at ${r.valueX}–${right}, line at ${mx}`).toBe(false);
        // Still after the bar's end.
        expect(r.valueX).toBeGreaterThan(r.x0 + r.width);
        if (r.valueX > r.x0 + r.width + 6) moved += 1;
      }
    }
    expect(moved).toBeGreaterThan(0);
  });

  it('is width-true: the plot fills the width given, right of the names', () => {
    const narrow = barChartGeometry({ width: 300, rows: [row(50)], cohort: { p25: null, median: 50, p75: null }, isRate: false });
    const wide = barChartGeometry({ width: 600, rows: [row(50)], cohort: { p25: null, median: 50, p75: null }, isRate: false });
    expect(narrow.left).toBe(barLabelWidth(300));
    expect(wide.width).toBe(600);
    const bar = (g: typeof wide) => g.rows[0] as Extract<(typeof g.rows)[number], { kind: 'bar' }>;
    expect(bar(wide).width).toBeGreaterThan(bar(narrow).width);
    // The median sits at the bar's end when they are equal.
    expect(wide.median!.x).toBeCloseTo(bar(wide).x0 + bar(wide).width, 5);
  });

  it('draws the band from p25 to p75 and no band without both', () => {
    const g = barChartGeometry({ width: 400, rows: [row(10)], cohort: { p25: 5, median: 8, p75: 10 }, isRate: false });
    expect(g.band!.x).toBeLessThan(g.median!.x);
    expect(g.band!.x + g.band!.width).toBeGreaterThan(g.median!.x);
    expect(barChartGeometry({ width: 400, rows: [row(10)], cohort: { p25: null, median: null, p75: null }, isRate: false }).band).toBeNull();
    expect(barChartGeometry({ width: 400, rows: [row(10)], cohort: { p25: null, median: null, p75: null }, isRate: false }).median).toBeNull();
  });

  it('draws words, never a bar, under the floor or with no value', () => {
    const g = barChartGeometry({
      width: 400,
      rows: [row(0.4, { reportable: false }), row(null)],
      cohort: { p25: null, median: null, p75: null },
      isRate: true,
    });
    expect(g.rows.map((r) => r.kind)).toEqual(['withheld', 'withheld']);
    expect((g.rows[0] as { text: string }).text).toBe('Too few to compare (12 calls; needs 20)');
  });

  it('says it in fewer words when the long form would not fit', () => {
    const rows = [row(0.4, { reportable: false, withheldShort: 'Too few (12 of 20)' })];
    const cohort = { p25: null, median: null, p75: null };
    expect((barChartGeometry({ width: 500, rows, cohort, isRate: true }).rows[0] as { text: string }).text).toBe('Too few to compare (12 calls; needs 20)');
    expect((barChartGeometry({ width: 240, rows, cohort, isRate: true }).rows[0] as { text: string }).text).toBe('Too few (12 of 20)');
  });

  it('puts a rate’s whisker on its interval and the value past its end, inside the SVG', () => {
    const g = barChartGeometry({
      width: 300,
      rows: [row(0.3, { interval: [0.2, 0.42], valueText: '30%' }), row(0.98, { interval: [0.9, 1], valueText: '98%' })],
      cohort: { p25: null, median: null, p75: null },
      isRate: true,
    });
    const [a, b] = g.rows as Array<Extract<(typeof g.rows)[number], { kind: 'bar' }>>;
    expect(a!.whisker!.x1).toBeLessThan(a!.x0 + a!.width);
    expect(a!.whisker!.x2).toBeGreaterThan(a!.x0 + a!.width);
    expect(a!.valueX).toBeGreaterThan(a!.whisker!.x2);
    expect(b!.valueX + '98%'.length * 7).toBeLessThanOrEqual(g.width);
    // Rows are stacked one row-height apart.
    expect(b!.y - a!.y).toBe(28);
  });

  it('keeps the team’s band and median line off a row of words, so the line never runs through "Too few to compare"', () => {
    // Recorded: Will pay for agent 0.0 and 0.6 (14%), agent 0.7 under the floor; team median 14%.
    const g = barChartGeometry({
      width: 330,
      rows: [row(0.14, { valueText: '14%' }), row(0.14, { valueText: '14%' }), row(0.2, { reportable: false })],
      cohort: { p25: 0.12, median: 0.14, p75: 0.17 },
      isRate: true,
    });
    expect(g.spans).toEqual([{ top: 6 - 2, bottom: 6 + 2 * 28 - 4 }]);
    const words = g.rows[2]!;
    expect(words.kind).toBe('withheld');
    // The words' row starts below every stretch the line is drawn over.
    expect(words.y - 1).toBeGreaterThan(g.spans[0]!.bottom);
    // A row of words between two bars splits the line in two.
    const split = barChartGeometry({
      width: 330,
      rows: [row(0.14), row(0.2, { reportable: false }), row(0.3)],
      cohort: { p25: 0.12, median: 0.14, p75: 0.17 },
      isRate: true,
    });
    expect(split.spans).toEqual([
      { top: 4, bottom: 30 },
      { top: 60, bottom: 86 },
    ]);
    // No bar at all: no stretch, so no line through any words.
    expect(barChartGeometry({ width: 330, rows: [row(0.2, { reportable: false })], cohort: { p25: 0.1, median: 0.14, p75: 0.2 }, isRate: true }).spans).toEqual([]);
  });

  it('draws no band when p25 and p75 are the same: the median line says it', () => {
    const g = barChartGeometry({ width: 400, rows: [row(0.14)], cohort: { p25: 0.14, median: 0.14, p75: 0.14 }, isRate: true });
    expect(g.band).toBeNull();
    expect(g.median).not.toBeNull();
  });

  it('gives a count of all zeros a whole-count scale, so the team’s quarter of a break never fills the chart (recorded breaks over their limit)', () => {
    const breaks = THREE_DAYS_COLLECTIONS.cohort.per_metric['breaks_over_limit']!;
    const cohort = { p25: breaks.p25, median: breaks.median, p75: breaks.p75 };
    const rows = [row(0, { valueText: '0' }), row(0, { valueText: '0' }), row(0, { valueText: '0' })];
    expect(barScaleMax({ rows, cohort, isRate: false, isCount: true })).toBe(COUNT_SCALE_MIN);
    const g = barChartGeometry({ width: 330, rows, cohort, isRate: false, isCount: true });
    const plot = g.width - g.left - 58;
    expect(g.band!.width).toBeLessThan(plot * 0.1);
    // A count past the least scale keeps the usual 12% headroom.
    expect(barScaleMax({ rows: [row(40)], cohort: { p25: null, median: null, p75: null }, isRate: false, isCount: true })).toBeCloseTo(44.8);
    // Nothing at all to draw: still a whole-count scale, and no band.
    const none = barChartGeometry({ width: 330, rows, cohort: { p25: 0, median: 0, p75: 0 }, isRate: false, isCount: true });
    expect(none.max).toBe(COUNT_SCALE_MIN);
    expect(none.band).toBeNull();
  });

  it('rounds a bar’s data end and keeps a sliver square', () => {
    expect(barPath(10, 0, 50)).toBe('M10 0h46a4 4 0 0 1 4 4v6a4 4 0 0 1 -4 4h-46z');
    expect(barPath(10, 0, 5)).toBe('M10 0h5v14h-5z');
  });
});

describe('the trend', () => {
  it('breaks the line on a day off and keeps a lone day as a dot', () => {
    const x = (i: number) => i * 10;
    const y = (v: number) => 100 - v;
    expect(brokenLinePath([1, 2, null, 4, 5], x, y)).toEqual({ path: 'M0 99L10 98M30 96L40 95', dots: [] });
    expect(brokenLinePath([null, 3, null], x, y)).toEqual({ path: 'M10 97', dots: [{ x: 10, y: 97 }] });
    expect(brokenLinePath([null, null], x, y)).toEqual({ path: '', dots: [] });
  });

  it('picks a clean axis top', () => {
    expect(niceCountMax(0)).toBe(4);
    expect(niceCountMax(4)).toBe(4);
    expect(niceCountMax(4.4)).toBe(8);
    expect(niceCountMax(13)).toBe(16);
    expect(niceCountMax(21)).toBe(24);
    expect(niceCountMax(180)).toBe(200);
    expect(niceCountMax(330)).toBe(400);
  });

  it('labels dates far enough apart, and always the last', () => {
    expect(labelledDateIndexes(7, 600)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(labelledDateIndexes(31, 300)).toEqual([0, 6, 12, 18, 24, 30]);
    expect(labelledDateIndexes(1, 300)).toEqual([0]);
    const few = labelledDateIndexes(8, 120);
    expect(few[few.length - 1]).toBe(7);
  });

  it('spreads end labels so none overlaps, within the plot', () => {
    expect(spreadLabels([50, 52, 51], 0, 200)).toEqual([50, 78, 64]);
    expect(spreadLabels([199, 200], 0, 200)).toEqual([186, 200]);
  });

  it('cuts names as the bars do, and never draws two the same', () => {
    expect(fitName('agent 0.0', 92)).toBe('agent 0.0');
    expect(fitName('Lakshmi Prasad Rao', 92)).toBe('Lakshmi Pras…');
    // Two agents sharing a first name, or named "agent 0.x", stay apart.
    expect(distinctNames(['agent 0.0', 'agent 0.6', 'agent 0.7'], 92)).toEqual(['agent 0.0', 'agent 0.6', 'agent 0.7']);
    expect(distinctNames(['Priya Menon', 'Priya Krishnan'], 92)).toEqual(['Priya Menon', 'Priya Krishn…']);
    // Cut to the same words: each keeps its end.
    const cut = distinctNames(['Lakshmi Prasad Rao', 'Lakshmi Prasad Rani'], 92);
    expect(cut[0]).not.toBe(cut[1]);
    expect(cut).toEqual(['Lakshm…ad Rao', 'Lakshm…d Rani']);
    // The same in full: numbered.
    expect(distinctNames(['Priya M', 'Priya M'], 92)).toEqual(['Priya M', 'Priya M (2)']);
  });

  it('labels each line where it stops, not at the last day, with the whole short name (recorded trend)', () => {
    const t = THREE_DAYS_COLLECTIONS.trend!;
    const names: Record<string, string> = Object.fromEntries(THREE_DAYS_COLLECTIONS.agents.map((a) => [a.agent_user_id, a.agent_name ?? '']));
    const g = trendGeometry({
      width: 620,
      height: 240,
      dates: t.dates,
      series: t.agents.map((a) => ({ id: a.agent_user_id, counts: a.counts, name: names[a.agent_user_id]! })),
      median: t.cohort_median,
    });
    const label = (id: string) => g.endLabels.find((e) => e.id === id)!;
    // agent 0.7 logged in on the first day only: labelled beside that day's point.
    const stopped = t.agents.find((a) => a.counts[2] === null)!;
    expect(label(stopped.agent_user_id).text).toBe('agent 0.7 · 1');
    expect(label(stopped.agent_user_id).x).toBe(g.xs[0]! + 8);
    // The others run to the last day: labelled past its point, each by its own name.
    const ran = t.agents.filter((a) => a.counts[2] !== null);
    expect(ran.map((a) => label(a.agent_user_id).text)).toEqual(['agent 0.0 · 2', 'agent 0.6 · 2']);
    for (const a of ran) expect(label(a.agent_user_id).x).toBe(g.xs[2]! + 8);
    expect(label('team').x).toBe(g.xs[2]! + 8);
    // The three at the last day all sit on 2: pushed apart, none overlapping.
    const ys = [...ran.map((a) => label(a.agent_user_id).y), label('team').y].sort((a, b) => a - b);
    for (let k = 1; k < ys.length; k += 1) expect(ys[k]! - ys[k - 1]!).toBeGreaterThanOrEqual(14);
    // The lone label stays beside its own point.
    const dot = g.series.find((s) => s.id === stopped.agent_user_id)!.last!;
    expect(label(stopped.agent_user_id).y).toBe(dot.y + 4);
    // Every label inside the SVG.
    for (const e of g.endLabels) expect(e.x + e.text.length * 6.6).toBeLessThanOrEqual(g.width);
  });

  it('groups only the end labels whose spans across overlap', () => {
    expect(overlappingGroups([{ x: 400, text: 'agent 0.0 · 2' }, { x: 40, text: 'agent 0.7 · 1' }, { x: 400, text: 'Team · 2' }])).toEqual([[1], [0, 2]]);
    expect(overlappingGroups([{ x: 40, text: 'agent 0.7 · 1' }, { x: 80, text: 'Ravi · 3' }])).toEqual([[0, 1]]);
  });

  it('says dates as "20 Nov", whatever the reader’s zone (the reports’ day words)', () => {
    expect(formatReportDay('2026-11-20', false)).toBe('20 Nov');
  });

  it('lays out a series, the dashed median and end labels at the measured width', () => {
    const g = trendGeometry({
      width: 500,
      height: 240,
      dates: ['2026-11-19', '2026-11-20', '2026-11-21'],
      series: [
        { id: 'a', counts: [2, null, 4], name: 'Priya' },
        { id: 'b', counts: [1, 1, null], name: 'Ravi' },
      ],
      median: [1, 2, 3],
    });
    expect(g.width).toBe(500);
    expect(g.xs[0]).toBe(g.plotLeft);
    expect(g.xs[2]).toBe(g.plotRight);
    expect(g.yMax).toBe(8);
    expect(g.series[0]!.dots).toHaveLength(2);
    expect(g.series[1]!.last).toEqual({ x: g.xs[1], y: expect.any(Number) });
    expect(g.endLabels.map((e) => e.text)).toEqual(['Priya · 4', 'Ravi · 1', 'Team · 3']);
    expect(g.medianPath.startsWith('M')).toBe(true);
    expect(g.ticks.map((t) => t.value)).toEqual([0, 2, 4, 6, 8]);
  });
});

describe('where their day went', () => {
  it('rounds the shares to whole percentages that add up to 100', () => {
    expect(wholePercents([1, 1, 1])).toEqual([34, 33, 33]);
    expect(wholePercents([7560, 1260, 1800, 8280]).reduce((a, b) => a + b, 0)).toBe(100);
    expect(wholePercents([0, 0])).toEqual([0, 0]);
  });

  it('splits the width in the parts’ order with a 2px gap, skipping a part of no time', () => {
    const segs = daySplitSegments({ on_call: 50, choosing: 0, break: 25, waiting: 25, shift_seconds: 100 }, 0, 402);
    expect(segs.map((s) => s.key)).toEqual(['on_call', 'break', 'waiting']);
    expect(segs.map((s) => s.percent)).toEqual([50, 25, 25]);
    expect(segs[0]).toMatchObject({ x: 0, width: 199 });
    expect(segs[1]).toMatchObject({ x: 201, width: 98.5 });
    // The last part runs to the end: no gap after it.
    expect(segs[2]!.x + segs[2]!.width).toBeCloseTo(402, 5);
  });

  it('draws nothing with no logged-in time', () => {
    expect(daySplitSegments({ on_call: 0, choosing: 0, break: 0, waiting: 0, shift_seconds: 0 }, 0, 400)).toEqual([]);
  });
});
