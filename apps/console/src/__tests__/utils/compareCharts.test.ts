import { describe, it, expect } from 'vitest';
import {
  barChartGeometry,
  barLabelWidth,
  barPath,
  barScaleMax,
  brokenLinePath,
  daySplitSegments,
  labelledDateIndexes,
  niceCountMax,
  shortDate,
  spreadLabels,
  trendGeometry,
  wholePercents,
} from '../../utils/agency/compare/compareCharts';

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

  it('says dates as "20 Nov", whatever the reader’s zone', () => {
    expect(shortDate('2026-11-20')).toBe('20 Nov');
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
