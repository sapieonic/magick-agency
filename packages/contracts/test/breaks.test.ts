import { describe, expect, it } from 'vitest';
import {
  AGENCY_BREAK_DEFAULT_LIMIT_MINUTES,
  AGENCY_BREAK_LIMIT_MAX_MINUTES,
  AGENCY_BREAK_LIMIT_MIN_MINUTES,
  isAgencyBreakLimitMinutes,
} from '../src/agency';

/**
 * SNAPSHOTS, written out by hand, of the break limits' bounds and rule (decisions LF6, LF20): the
 * campaign-config write, the catalog read and a console form all hold a limit to them.
 */
describe('break limits (LF6, LF20)', () => {
  it('bounds: 1 to 240 minutes, the floor\'s 30 without one', () => {
    expect([AGENCY_BREAK_LIMIT_MIN_MINUTES, AGENCY_BREAK_LIMIT_MAX_MINUTES, AGENCY_BREAK_DEFAULT_LIMIT_MINUTES]).toEqual([1, 240, 30]);
  });

  it('a limit is a whole number of minutes in the bounds, nothing else', () => {
    for (const ok of [1, 15, 30, 240]) expect(isAgencyBreakLimitMinutes(ok), String(ok)).toBe(true);
    for (const bad of [0, 241, -1, 15.5, Number.NaN, Number.POSITIVE_INFINITY, '15', null, undefined, true, {}]) {
      expect(isAgencyBreakLimitMinutes(bad), String(bad)).toBe(false);
    }
  });
});
