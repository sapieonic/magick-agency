import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';
import { AgentBucketChart, columnPath, niceCeiling } from '../../components/agency/AgentBucketChart';
import { bucketSeries } from '../../utils/agencyAgentPerformance';
import type { AgencyAgentStatsBucket } from '../../types/agency-stats';

/**
 * The day-by-day chart, as inline SVG.
 *
 * ── What is worth asserting about a chart ──────────────────────────────────
 * Not its pixels. Three things that are decisions rather than rendering:
 *
 *  1. **Two series, grouped and never stacked.** Every connected call is also a
 *     dial, so the two overlap rather than partition — a stacked column's height
 *     would be a number that does not exist.
 *  2. **A legend is always present**, so the two series are never told apart by
 *     colour alone, and the numbers are reachable as text for anybody the bars do
 *     not serve.
 *  3. **The timezone caveat is on the page**, not in a `title` attribute. Buckets
 *     are cut in each campaign's own local time, so for somebody working two
 *     zones a "day" is not one contiguous 24 hours — left unsaid, that is a
 *     reader filing a bug against a number that is correct.
 *
 * The geometry helpers are unit-tested because a bar that renders as a pill
 * floating above its own baseline, or an axis top nobody can divide by, are both
 * things a screenshot review misses.
 */

afterEach(cleanup);

/**
 * A bucket in the shape core actually sends: `YYYY-MM-DD`, no time and no
 * offset.
 *
 * This fixture used to carry an ISO midnight instant, and that mismatch is what
 * hid a real defect for the whole life of the feature. An instant is parsed as
 * itself; a date-only string is the one literal JS parses as UTC midnight, and
 * reading it back with `getDate()` in local time puts every label a day early
 * west of Greenwich. Testing a shape the server never sends tests nothing about
 * the server.
 */
function bucket(day: number, attempts: number, connected: number): AgencyAgentStatsBucket {
  return {
    bucket_start: `2026-08-${String(day).padStart(2, '0')}`,
    attempts,
    connected,
    successes: 0,
    talk_seconds: 0,
    wrapup_seconds: 0,
  };
}


describe('niceCeiling', () => {
  it('rounds the axis top to a number a reader can divide by', () => {
    // A tick reading `37` is a tick nobody can halve, which is what forces a
    // chart into five gridlines instead of three.
    expect(niceCeiling(37)).toBe(40);
    expect(niceCeiling(7)).toBe(8);
    expect(niceCeiling(3)).toBe(4);
    expect(niceCeiling(120)).toBe(200);
    expect(niceCeiling(200)).toBe(200);
  });

  it('every rung has an integral half, so the midpoint tick is not a rounding', () => {
    // The chart labels its middle gridline with `Math.round(top / 2)`. A rung
    // whose half is not an integer puts a label on a line it is not on.
    for (const max of [1, 3, 7, 37, 120, 260, 516, 940, 4300]) {
      const top = niceCeiling(max);
      expect(top).toBeGreaterThanOrEqual(max);
      expect(top % 2).toBe(0);
    }
  });

  it('does not spend half the plot on air for a mid-range peak', () => {
    // The 1/2/5 ladder took 516 to 1,000, so every bar sat below the midpoint.
    expect(niceCeiling(516)).toBe(600);
    expect(niceCeiling(260)).toBe(300);
    expect(niceCeiling(940)).toBe(1000);
  });

  it('never returns 0, so nothing divides by it — and never 1 either', () => {
    /*
      The floor is 2, not 1. Three gridlines are labelled 0, `top / 2` and `top`
      with `Math.round`, so a ceiling of 1 printed the axis as 0, 1, 1 — the same
      number twice, one of them on a line drawn at 0.5.
    */
    expect(niceCeiling(0)).toBe(2);
    expect(niceCeiling(-4)).toBe(2);
    expect(niceCeiling(1)).toBe(2);
  });

  it('never returns an odd top, so the middle tick is never a rounding', () => {
    // A peak of 3 gave `top = 3` and a line at 1.5 labelled "2", so a 2-dial bar
    // stood above the tick reading 2. Reachable only at magnitude 1.
    for (let max = 1; max <= 400; max += 1) {
      const top = niceCeiling(max);
      expect(top).toBeGreaterThanOrEqual(max);
      expect(top % 2).toBe(0);
    }
  });
});

describe('columnPath', () => {
  it('rounds the data end and keeps the baseline square', () => {
    /**
     * `<rect rx>` rounds all four corners, which lifts a bar off its own axis and
     * makes a short one read as a pill floating above it. The path draws the
     * radius only at the top.
     */
    const path = columnPath(10, 20, 12, 40);
    expect(path.startsWith('M10,60')).toBe(true);
    expect(path).toContain('Q');
    expect(path.endsWith('Z')).toBe(true);
  });

  it('collapses the radius rather than drawing a semicircle for one dial', () => {
    // A single dial on a quiet day is a 2px bar; a 4px radius on it would render
    // as a dot with no visible relationship to the axis.
    expect(columnPath(0, 99, 12, 1)).toContain('Q0,99 1,99');
  });

  it('draws nothing for a zero-height bar', () => {
    // Not an empty path with a stray move command — an empty `d`, so the day
    // renders as air rather than as a hairline that looks like a value.
    expect(columnPath(0, 100, 12, 0)).toBe('');
  });
});

describe('AgentBucketChart', () => {
  it('declines to draw a single day, and names the range that would', () => {
    render(<AgentBucketChart series={bucketSeries([bucket(20, 5, 2)])} />);
    expect(screen.getByTestId('bucket-chart-single').textContent).toContain('this week');
    expect(screen.queryByTestId('bucket-chart')).toBeNull();
  });

  it('draws one group per day with both series in it', () => {
    render(<AgentBucketChart series={bucketSeries([bucket(19, 20, 8), bucket(20, 22, 9)])} />);

    expect(screen.getByTestId('bucket-chart')).toBeTruthy();
    expect(screen.getByTestId('bucket-2026-08-19')).toBeTruthy();
    expect(screen.getByTestId('bucket-2026-08-20')).toBeTruthy();
  });

  it('names both series in the group tooltip, so neither is inferred', () => {
    render(<AgentBucketChart series={bucketSeries([bucket(19, 20, 8), bucket(20, 22, 9)])} />);
    const group = screen.getByTestId('bucket-2026-08-19');
    expect(group.querySelector('title')?.textContent).toBe(
      'Aug 19: 20 dials, 8 conversations',
    );
  });

  it('always carries a legend for its two series', () => {
    // Identity is never colour-alone. Two series, so a legend is not optional.
    render(<AgentBucketChart series={bucketSeries([bucket(19, 20, 8), bucket(20, 22, 9)])} />);
    expect(screen.getByText('Dials')).toBeTruthy();
    expect(screen.getByText('Conversations')).toBeTruthy();
  });

  it('says the day belongs to the campaign, in the product’s voice', () => {
    render(<AgentBucketChart series={bucketSeries([bucket(19, 20, 8), bucket(20, 22, 9)])} />);
    const note = screen.getByTestId('bucket-timezone-note').textContent ?? '';
    expect(note).toContain('own campaign’s local time');
    expect(note).toContain('totals are still exact');
    // Not in implementation vocabulary: the reader of this page cannot use the
    // word "bucket".
    expect(note).not.toMatch(/bucket|timezone|UTC/i);
  });

  it('offers the numbers as a table for anybody the bars do not serve', () => {
    render(<AgentBucketChart series={bucketSeries([bucket(19, 20, 8), bucket(20, 22, 9)])} />);

    expect(screen.queryByTestId('bucket-chart-table')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /show the numbers/i }));

    const table = screen.getByTestId('bucket-chart-table');
    expect(within(table).getByText('Aug 19')).toBeTruthy();
    expect(within(table).getByText('20')).toBeTruthy();
    expect(within(table).getByText('8')).toBeTruthy();
  });

  it('labels only the peak bar, not every one of them', () => {
    /**
     * A value beside every column is chaos and goes unread; the direct label works
     * precisely because it is the only one. The axis and the table carry the rest.
     */
    render(
      <AgentBucketChart series={bucketSeries([bucket(11, 20, 8), bucket(12, 31, 9), bucket(13, 4, 1)])} />,
    );
    /*
      Asserted against the direct labels THEMSELVES, not against every `<text>`
      in the plot. The earlier version scanned them all and asserted that no
      other text read "20", which made it a hostage to two unrelated things: a
      day number, and an axis tick. It broke on the second when the ceiling
      ladder was refined and 20 became a legitimate gridline label — a green
      test failing for a reason it was never about.
    */
    const peaks = [...screen.getByTestId('bucket-chart').querySelectorAll('[data-testid="bucket-peak"]')];
    expect(peaks).toHaveLength(1);
    expect(peaks[0]!.textContent).toBe('31');
  });
});
