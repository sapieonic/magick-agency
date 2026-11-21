import { describe, expect, it } from 'vitest';
import { COMPARE_INTERVAL_Z } from '@magick-agency/contracts/api/agency/compare';
import { wilsonInterval } from '../../../src/agent-compare/wilson';

describe('wilsonInterval', () => {
  it.each([
    // [successes, trials, low, high], worked by hand from the closed form at z = 1.96.
    [10, 20, 0.29929, 0.70071],
    [5, 29, 0.07598, 0.34549],
    [38, 196, 0.14464, 0.25489],
    [0, 25, 0, 0.13320],
    [25, 25, 0.86680, 1],
  ])('%i of %i → [%f, %f]', (k, n, low, high) => {
    const interval = wilsonInterval(k, n);
    expect(interval).not.toBeNull();
    expect(interval![0]).toBeCloseTo(low, 4);
    expect(interval![1]).toBeCloseTo(high, 4);
  });

  it('stays inside [0, 1] and holds the point estimate', () => {
    for (const [k, n] of [[0, 1], [1, 1], [1, 3], [99, 100], [1, 1000]] as const) {
      const [low, high] = wilsonInterval(k, n)!;
      expect(low).toBeGreaterThanOrEqual(0);
      expect(high).toBeLessThanOrEqual(1);
      expect(low).toBeLessThanOrEqual(k / n);
      expect(high).toBeGreaterThanOrEqual(k / n);
    }
  });

  it('narrows as the calls grow at the same rate', () => {
    const width = (k: number, n: number) => { const [a, b] = wilsonInterval(k, n)!; return b - a; };
    expect(width(20, 100)).toBeLessThan(width(2, 10));
    expect(width(200, 1000)).toBeLessThan(width(20, 100));
  });

  it('defaults to the contract z, and a wider z gives a wider interval', () => {
    expect(COMPARE_INTERVAL_Z).toBe(1.96);
    expect(wilsonInterval(10, 20, COMPARE_INTERVAL_Z)).toEqual(wilsonInterval(10, 20));
    const [a95, b95] = wilsonInterval(10, 20)!;
    const [a99, b99] = wilsonInterval(10, 20, 2.576)!;
    expect(a99).toBeLessThan(a95);
    expect(b99).toBeGreaterThan(b95);
  });

  it.each([
    [0, 0], [1, 0], [1, -5], [-1, 10], [11, 10], [Number.NaN, 10], [1, Number.POSITIVE_INFINITY],
  ])('null on %f of %f: nothing to measure, or a broken read', (k, n) => {
    expect(wilsonInterval(k, n)).toBeNull();
  });
});
