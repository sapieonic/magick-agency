import { describe, expect, it } from 'vitest';
import { abandonmentBreachesCeiling, singleAbandonSampleFloor } from '../../../src/abandonment-predicate';

/**
 * The guardrail's pause rule, as the console reads it for its Resume warning (decisions AW1,
 * AW2). The server's `breachedRows` is held equal to it over a sweep in its own unit test
 * (`abandonment-guardrail.test.ts`); these are the cases its module note names.
 */
describe('abandonmentBreachesCeiling', () => {
  it.each([
    // [abandoned, answered, ceiling, breaches]
    [0, 0, 3, false], // no answered calls: no rate, no evidence
    [3, 100, 3, false], // at the ceiling is not over it
    [4, 100, 3, true], // the real case
    [1, 1, 3, false], // one call in too coarse a sample
    [1, 33, 3, false], // one call cannot come in under 3% below 34 answered
    [2, 2, 3, true], // two in a row is not a coincidence
    [20, 25, 3, true], // a catastrophic small campaign still stops
    [1, 20, 10, false], // 5%, under a 10% ceiling
    [3, 20, 10, true], // 15%, over it
  ])('%i abandoned of %i answered, ceiling %d → %s', (abandoned, answered, ceiling, breaches) => {
    expect(abandonmentBreachesCeiling({ abandoned, answered }, ceiling)).toBe(breaches);
  });

  it('a non-positive ceiling pauses on the first abandoned call (fail closed)', () => {
    expect(singleAbandonSampleFloor(0)).toBe(0);
    expect(abandonmentBreachesCeiling({ abandoned: 1, answered: 1 }, 0)).toBe(true);
  });

  it('the floor is the campaign’s own: 34 at 3%, 100 at 1%, 10 at 10%', () => {
    expect(singleAbandonSampleFloor(3)).toBe(34);
    expect(singleAbandonSampleFloor(1)).toBe(100);
    expect(singleAbandonSampleFloor(10)).toBe(10);
  });
});
