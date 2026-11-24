import { describe, expect, it } from 'vitest';
import {
  ABANDONMENT_GRACE_SECONDS,
  DEFAULT_ABANDONMENT_GRACE_MS,
  abandonmentGraceError,
  graceSecondsText,
  graceSummary,
} from '../../utils/agency/abandonmentGrace';

describe('abandonmentGrace (AG1–AG5)', () => {
  it('offers whole seconds 1–5, 3 by default, read from the domain rule', () => {
    expect(ABANDONMENT_GRACE_SECONDS).toEqual([1, 2, 3, 4, 5]);
    expect(DEFAULT_ABANDONMENT_GRACE_MS).toBe(3000);
  });

  it('says the time in seconds, singular for one', () => {
    expect(graceSecondsText(1000)).toBe('1 second');
    expect(graceSecondsText(3000)).toBe('3 seconds');
    expect(graceSummary(5000)).toBe('Abandoned after 5 seconds');
    expect(graceSummary(Number.NaN)).toBe('Not set');
  });

  it('names a value the server would refuse', () => {
    for (const ms of [1000, 2000, 3000, 4000, 5000]) expect(abandonmentGraceError(ms)).toBeNull();
    for (const ms of [0, 500, 2500, 6000, Number.NaN]) expect(abandonmentGraceError(ms)).toBe('Choose 1 to 5 seconds.');
  });
});
