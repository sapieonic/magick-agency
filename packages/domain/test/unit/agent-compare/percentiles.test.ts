import { describe, expect, it } from 'vitest';
import { cohortPercentiles, percentileCont } from '../../../src/agent-compare/percentiles';

describe('cohortPercentiles (percentile_cont, the roster benchmark\'s method)', () => {
  it('empty input is all null, never 0', () => {
    expect(cohortPercentiles([])).toEqual({ p25: null, median: null, p75: null });
  });

  it('one value is every quantile of itself', () => {
    expect(cohortPercentiles([0.42])).toEqual({ p25: 0.42, median: 0.42, p75: 0.42 });
  });

  it('interpolates linearly between neighbours: four agents still have a median that is nobody\'s', () => {
    expect(cohortPercentiles([1, 2, 3, 4])).toEqual({ p25: 1.75, median: 2.5, p75: 3.25 });
  });

  // Reference values from Postgres 16 on the dev database:
  //   SELECT percentile_cont(ARRAY[0.25,0.5,0.75]) WITHIN GROUP (ORDER BY x) FROM unnest(ARRAY[...]::float8[]) x;
  it.each([
    [[3, 1, 10, 7, 2], { p25: 2, median: 3, p75: 7 }],
    [[0.172, 0.31, 0.25, 0.29, 0.18, 0.4], { p25: 0.1975, median: 0.27, p75: 0.305 }],
  ])('agrees with Postgres percentile_cont on %j', (values, expected) => {
    const got = cohortPercentiles(values);
    expect(got.p25).toBeCloseTo(expected.p25, 12);
    expect(got.median).toBeCloseTo(expected.median, 12);
    expect(got.p75).toBeCloseTo(expected.p75, 12);
  });

  it('does not mutate its input', () => {
    const values = [3, 1, 2];
    cohortPercentiles(values);
    expect(values).toEqual([3, 1, 2]);
  });

  it('percentileCont refuses an empty list rather than inventing a number', () => {
    expect(() => percentileCont([], 0.5)).toThrow(RangeError);
    expect(percentileCont([10, 20], 0)).toBe(10);
    expect(percentileCont([10, 20], 1)).toBe(20);
  });
});
