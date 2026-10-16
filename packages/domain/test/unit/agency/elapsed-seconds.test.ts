import { describe, it, expect } from 'vitest';
import { elapsedSeconds } from '../../../src/timers.js';

describe('elapsedSeconds', () => {
  it('measures between two instants, in fractional seconds', () => {
    expect(elapsedSeconds(new Date(1_000), new Date(3_500))).toBe(2.5);
    expect(elapsedSeconds(new Date(1_000), 1_250)).toBe(0.25);
  });

  it('defaults the end to now', () => {
    const s = elapsedSeconds(new Date(Date.now() - 2_000));
    expect(s).toBeGreaterThanOrEqual(2);
    expect(s).toBeLessThan(10);
  });

  it('never goes negative when the clock steps backwards', () => {
    expect(elapsedSeconds(new Date(5_000), new Date(1_000))).toBe(0);
  });
});
