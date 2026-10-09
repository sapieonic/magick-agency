// Covers `runWithConcurrency`; the sibling concurrency.test.ts covers the semaphore
// and `mapWithConcurrency`.

import { describe, it, expect, vi } from 'vitest';
import { runWithConcurrency } from '../../../src/utils/concurrency.js';

// ── Helpers ────────────────────────────────────────────────────────────

/**
 * A manually-controllable deferred promise.  Callers can await `promise` and
 * then release it by calling `resolve()` from outside.
 */
function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (reason?: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// ── Tests ──────────────────────────────────────────────────────────────

describe('runWithConcurrency', () => {
  // 1. Every item processed exactly once ─────────────────────────────────
  it('processes every item exactly once for a list larger than concurrency', async () => {
    const items = Array.from({ length: 20 }, (_, i) => i);
    const processed = new Set<number>();

    await runWithConcurrency(items, 5, async (item) => {
      expect(processed.has(item)).toBe(false); // no duplicate
      processed.add(item);
    });

    expect(processed.size).toBe(20);
    for (const item of items) {
      expect(processed.has(item)).toBe(true);
    }
  });

  // 2. Respects the concurrency limit ────────────────────────────────────
  it('never exceeds the concurrency limit (measured via live in-flight counter)', async () => {
    const CONCURRENCY = 3;
    const ITEMS = 10;
    const items = Array.from({ length: ITEMS }, (_, i) => i);

    // One deferred per item so we control exactly when each completes.
    const deferreds = items.map(() => deferred<void>());
    let inFlight = 0;
    let maxObserved = 0;

    const runPromise = runWithConcurrency(items, CONCURRENCY, async (item) => {
      inFlight++;
      if (inFlight > maxObserved) maxObserved = inFlight;
      await deferreds[item]!.promise;
      inFlight--;
    });

    // Drain: resolve all deferreds in microtask bursts so the workers can
    // keep pulling from the queue while we observe in-flight counts.
    for (const d of deferreds) {
      d.resolve();
      await Promise.resolve(); // yield to microtask queue
    }

    await runPromise;

    expect(maxObserved).toBeLessThanOrEqual(CONCURRENCY);
    expect(maxObserved).toBeGreaterThan(0); // sanity: we did work
  });

  // 3. Worker count is min(concurrency, items.length) ────────────────────
  it('completes correctly when items.length < concurrency (no extra workers)', async () => {
    const items = [1, 2, 3]; // 3 items, concurrency = 10
    const processed = new Set<number>();
    let maxInFlight = 0;
    let inFlight = 0;

    await runWithConcurrency(items, 10, async (item) => {
      inFlight++;
      if (inFlight > maxInFlight) maxInFlight = inFlight;
      processed.add(item);
      inFlight--;
    });

    // All items processed
    expect(processed.size).toBe(3);
    // In-flight never exceeded items.length
    expect(maxInFlight).toBeLessThanOrEqual(items.length);
  });

  // 4. Empty array → resolves immediately, fn never called ───────────────
  it('resolves immediately for an empty array without calling fn', async () => {
    const fn = vi.fn().mockResolvedValue(undefined);
    await expect(runWithConcurrency([], 5, fn)).resolves.toBeUndefined();
    expect(fn).not.toHaveBeenCalled();
  });

  // 5. concurrency = 1 → strictly sequential ────────────────────────────
  it('processes items strictly sequentially when concurrency is 1', async () => {
    const items = [10, 20, 30, 40, 50];
    const order: number[] = [];
    let inFlight = 0;
    let maxInFlight = 0;

    // Use deferreds so each item's completion is explicit and we can
    // assert that the next item hasn't started yet.
    const deferreds = items.map(() => deferred<void>());

    const runPromise = runWithConcurrency(items, 1, async (item) => {
      inFlight++;
      if (inFlight > maxInFlight) maxInFlight = inFlight;
      order.push(item);
      await deferreds[items.indexOf(item)]!.promise;
      inFlight--;
    });

    // Resolve items one at a time and verify only one is ever in flight.
    for (let i = 0; i < deferreds.length; i++) {
      // Before resolving item i, at most 1 should be running.
      expect(maxInFlight).toBeLessThanOrEqual(1);
      deferreds[i]!.resolve();
      await Promise.resolve();
      await Promise.resolve(); // second yield: lets the next worker start
    }

    await runPromise;

    expect(maxInFlight).toBe(1);
    expect(order).toEqual(items); // sequential order preserved
  });

  // 6. Rejecting fn propagates ────────────────────────────────────────────
  it('rejects the returned promise when fn rejects', async () => {
    const items = [1, 2, 3, 4, 5];
    const processed: number[] = [];

    const promise = runWithConcurrency(items, 2, async (item) => {
      if (item === 2) throw new Error('boom');
      processed.push(item);
    });

    await expect(promise).rejects.toThrow('boom');

    // The promise must have rejected — we make no assertion on the exact
    // count of processed items before abort because scheduling is
    // non-deterministic when multiple workers are in flight.  The
    // important invariant is that the outer promise rejects.
  });

  // 7. Resolves only after ALL work completes ────────────────────────────
  it('resolves only after every item has been processed', async () => {
    const CONCURRENCY = 4;
    const ITEMS = 12;
    const items = Array.from({ length: ITEMS }, (_, i) => i);

    const deferreds = items.map(() => deferred<void>());
    const completed = new Set<number>();
    let resolved = false;

    const runPromise = runWithConcurrency(items, CONCURRENCY, async (item) => {
      await deferreds[item]!.promise;
      completed.add(item);
    }).then(() => {
      resolved = true;
    });

    // Resolve all but the last item and confirm the outer promise hasn't
    // settled yet.
    for (let i = 0; i < ITEMS - 1; i++) {
      deferreds[i]!.resolve();
    }
    // Give microtasks a chance to run
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // Still waiting for item ITEMS-1
    expect(resolved).toBe(false);

    // Now resolve the last item
    deferreds[ITEMS - 1]!.resolve();
    await runPromise; // wait for full resolution

    expect(resolved).toBe(true);
    expect(completed.size).toBe(ITEMS);
  });

  // ── Edge / additional coverage ────────────────────────────────────────

  it('handles concurrency === items.length (one worker per item)', async () => {
    const items = [1, 2, 3];
    const processed = new Set<number>();

    await runWithConcurrency(items, items.length, async (item) => {
      processed.add(item);
    });

    expect(processed.size).toBe(items.length);
  });

  it('handles a single item with concurrency > 1', async () => {
    const fn = vi.fn().mockResolvedValue(undefined);
    await runWithConcurrency([42], 10, fn);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith(42);
  });
});
