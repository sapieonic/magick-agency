import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InFlight } from '../../../src/agency/pacing/in-flight.js';
import { createRng, scaled } from '../../helpers/load-scale.js';

/**
 * ─── IN-FLIGHT TRACKING UNDER A STORM OF TICKS ──────────────────────────────
 *
 * `InFlight` is what `PacingEngine.stop()` waits on: every tick and completion
 * notice is tracked until it settles, and shutdown drains them for a bounded
 * time. A full floor puts hundreds of overlapping ticks in it, settling in any
 * order, some rejecting, while new ones keep arriving during the drain. The
 * properties a shutdown depends on:
 *
 *  - `settle()` answers true exactly when everything tracked AT THE CALL settled
 *    inside the budget — work tracked after the call does not extend the wait;
 *  - a rejection counts as settled and never rejects `settle()`;
 *  - nothing is ever left behind: once all work settles, `size` is 0.
 *
 * Fake timers: settle times and the budget are a pure function of the seed.
 */

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('InFlight under contention', () => {
  it('a drain answers on exactly the work tracked when it began, whatever order it settles in', async () => {
    const rng = createRng();
    const ROUNDS = scaled(60);
    for (let round = 0; round < ROUNDS; round++) {
      const inFlight = new InFlight();
      const N = rng.int(1, 200);
      const BUDGET = 1_000;
      // Each tick settles at a seeded time, a fifth of them by rejecting.
      // Never within 10ms of the budget: which of two timers due at one instant
      // runs first is the fake clock's business, not this tracker's.
      const settleAt = Array.from({ length: N }, () => {
        const at = rng.int(0, 1_400);
        return Math.abs(at - BUDGET) <= 10 ? BUDGET + 50 : at;
      });
      const work = settleAt.map((at) => {
        const d = deferred<void>();
        setTimeout(() => (rng.chance(0.2) ? d.reject(new Error('tick threw')) : d.resolve()), at);
        return inFlight.track(d.promise).catch(() => { /* the tick's own handler */ });
      });
      expect(inFlight.size).toBe(N);

      const drained = inFlight.settle(BUDGET);
      // Ticks that start DURING the drain, some of them very long: not waited on.
      const late = Array.from({ length: rng.int(0, 30) }, () => {
        const d = deferred<void>();
        setTimeout(() => d.resolve(), 5_000);
        return inFlight.track(d.promise);
      });

      await vi.advanceTimersByTimeAsync(BUDGET + 1);
      const expected = Math.max(...settleAt) < BUDGET;
      await expect(drained, `seed=${rng.seed} round=${round}`).resolves.toBe(expected);

      await vi.advanceTimersByTimeAsync(10_000);
      await Promise.all([...work, ...late]);
      expect(inFlight.size, `seed=${rng.seed} round=${round}: tracked work leaked`).toBe(0);
    }
  });

  it('many overlapping drains over shared work all agree, and none rejects', async () => {
    const inFlight = new InFlight();
    const ds = Array.from({ length: scaled(300) }, () => deferred<void>());
    ds.forEach((d) => { void inFlight.track(d.promise).catch(() => {}); });
    const drains = Array.from({ length: 20 }, () => inFlight.settle(500));
    ds.forEach((d, i) => (i % 3 === 0 ? d.reject(new Error('x')) : d.resolve()));
    await vi.advanceTimersByTimeAsync(1);
    expect(await Promise.all(drains)).toEqual(Array(20).fill(true));
    expect(inFlight.size).toBe(0);
    // An empty tracker drains instantly, without waiting out a timer.
    expect(await inFlight.settle(60_000)).toBe(true);
  });
});
