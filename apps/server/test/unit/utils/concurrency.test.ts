import { describe, it, expect } from 'vitest';
import { createSemaphore, mapWithConcurrency } from '../../../src/utils/concurrency.js';

/**
 * The point of this helper is the BOUND, so most of these assert on how many
 * tasks were in flight at once rather than on the results — a version that
 * simply forwarded to `Promise.all` would satisfy every ordering assertion.
 */
describe('mapWithConcurrency', () => {
  const deferred = <T>() => {
    let resolve!: (v: T) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
  };

  it('never exceeds the limit and still completes every item', async () => {
    let inFlight = 0;
    let peak = 0;
    const items = Array.from({ length: 50 }, (_, i) => i);

    const results = await mapWithConcurrency(items, 4, async (n) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight--;
      return n * 2;
    });

    expect(peak).toBeLessThanOrEqual(4);
    // Guards the other direction: a serial implementation also never exceeds 4.
    expect(peak).toBe(4);
    expect(results).toHaveLength(50);
    expect(results[0]).toBe(0);
    expect(results[49]).toBe(98);
  });

  it('returns results in input order regardless of completion order', async () => {
    // Later items finish first, so an implementation that pushed on completion
    // would come back reversed.
    const results = await mapWithConcurrency([30, 20, 10], 3, async (delay) => {
      await new Promise((r) => setTimeout(r, delay / 10));
      return delay;
    });

    expect(results).toEqual([30, 20, 10]);
  });

  it('starts the next task as soon as a slot frees, not in lockstep rounds', async () => {
    // Batching (chunk-and-await) would hold the third task until BOTH of the
    // first two settled; a worker pool starts it the moment one does.
    const gates = [deferred<void>(), deferred<void>(), deferred<void>()];
    const started: number[] = [];

    const all = mapWithConcurrency([0, 1, 2], 2, async (i) => {
      started.push(i);
      await gates[i]!.promise;
      return i;
    });

    await Promise.resolve();
    expect(started).toEqual([0, 1]);

    // Release only the FIRST — a batching implementation would still be waiting.
    gates[0]!.resolve();
    await new Promise((r) => setTimeout(r, 0));
    expect(started).toEqual([0, 1, 2]);

    gates[1]!.resolve();
    gates[2]!.resolve();
    await expect(all).resolves.toEqual([0, 1, 2]);
  });

  it('rejects with the first rejection and stops starting new tasks', async () => {
    const started: number[] = [];

    await expect(
      mapWithConcurrency([0, 1, 2, 3, 4, 5], 1, async (i) => {
        started.push(i);
        if (i === 1) throw new Error('boom');
        return i;
      }),
    ).rejects.toThrow('boom');

    // Serial worker: item 2 onward must never have been started.
    expect(started).toEqual([0, 1]);
  });

  it('stops starting queued tasks once one has rejected, even at high concurrency', async () => {
    // The point of the helper is bounding load on a downstream service, so
    // draining the rest of the queue after the caller already has a rejection
    // is the opposite of what it is for. With `Promise.all` alone the workers
    // keep pulling items long after the returned promise settled.
    const started: number[] = [];
    const items = Array.from({ length: 40 }, (_, i) => i);

    await expect(
      mapWithConcurrency(items, 4, async (i) => {
        started.push(i);
        await new Promise((r) => setTimeout(r, 1));
        if (i === 2) throw new Error('boom');
        return i;
      }),
    ).rejects.toThrow('boom');

    const atRejection = started.length;
    // Let any stragglers run; nothing new must be claimed.
    await new Promise((r) => setTimeout(r, 50));
    expect(started.length).toBe(atRejection);
    expect(started.length).toBeLessThan(items.length);
  });

  it('handles an empty list without invoking the callback', async () => {
    let calls = 0;
    const results = await mapWithConcurrency([], 4, async () => { calls++; return 1; });

    expect(results).toEqual([]);
    expect(calls).toBe(0);
  });

  it('does not spawn more workers than items', async () => {
    let peak = 0;
    let inFlight = 0;

    await mapWithConcurrency([1, 2], 100, async (n) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight--;
      return n;
    });

    expect(peak).toBe(2);
  });

  it('rejects a non-positive or fractional limit rather than hanging', async () => {
    // limit 0 would create zero workers and never resolve.
    await expect(mapWithConcurrency([1], 0, async (n) => n)).rejects.toThrow(RangeError);
    await expect(mapWithConcurrency([1], -1, async (n) => n)).rejects.toThrow(RangeError);
    await expect(mapWithConcurrency([1], 1.5, async (n) => n)).rejects.toThrow(RangeError);
  });
});

describe('createSemaphore', () => {
  it('rejects a nonsensical limit', () => {
    expect(() => createSemaphore(0)).toThrow(RangeError);
    expect(() => createSemaphore(1.5)).toThrow(RangeError);
    expect(() => createSemaphore(-1)).toThrow(RangeError);
  });

  it('admits up to the limit without parking anybody', async () => {
    const sem = createSemaphore(3);
    await sem.acquire();
    await sem.acquire();
    await sem.acquire();
    expect(sem.inFlight).toBe(3);
    expect(sem.waiting).toBe(0);
  });

  it('parks the caller past the limit until a slot is released', async () => {
    const sem = createSemaphore(1);
    await sem.acquire();

    let admitted = false;
    const parked = sem.acquire().then(() => { admitted = true; });
    await Promise.resolve();
    expect(admitted).toBe(false);
    expect(sem.waiting).toBe(1);

    sem.release();
    await parked;
    expect(admitted).toBe(true);
  });

  /**
   * THE regression test. The release-then-wake form fails exactly here.
   *
   * `release()` used to decrement and then wake a waiter whose own increment ran
   * a microtask later. Any `acquire()` whose continuation was ALREADY queued in
   * that window observed the freed slot and took it as well — so the limit was
   * exceeded by one per handover. This drives that interleaving deliberately:
   * `queued` is parked on an already-resolved promise, so its continuation sits
   * in the microtask queue ahead of the waiter that `release()` is about to
   * wake. Mutation-checked — restoring the old form makes this red.
   */
  it('never exceeds the limit when an acquire is already queued at release time', async () => {
    const sem = createSemaphore(2);
    await sem.acquire();
    await sem.acquire();

    // Parked: no slots left.
    let waiterAdmitted = false;
    const waiter = sem.acquire().then(() => { waiterAdmitted = true; });

    // Resumes INSIDE the handover window: its continuation is already on the
    // microtask queue when `release()` wakes the waiter, so it runs first.
    let queuedAdmitted = false;
    const queued = Promise.resolve().then(async () => {
      await sem.acquire();
      queuedAdmitted = true;
    });

    sem.release();
    await waiter;
    // Drain anything else the handover queued.
    await Promise.resolve();
    await Promise.resolve();

    // One slot was freed, so exactly ONE of the two may hold it. The old form
    // admitted both and reported inFlight = 3 against a limit of 2.
    expect(sem.inFlight).toBe(2);
    expect(waiterAdmitted).toBe(true);
    expect(queuedAdmitted).toBe(false);

    // Let the straggler through so the test leaves nothing pending.
    sem.release();
    await queued;
    expect(sem.inFlight).toBe(2);
  });

  it('returns to zero once every holder releases', async () => {
    // A leaked slot is permanent and degrades the process until it stops, which
    // is strictly worse than a transient overshoot.
    const sem = createSemaphore(2);
    const holders = [sem.acquire(), sem.acquire(), sem.acquire(), sem.acquire()];
    for (let i = 0; i < 4; i += 1) {
      await holders[i];
      sem.release();
    }
    expect(sem.inFlight).toBe(0);
    expect(sem.waiting).toBe(0);
  });

  it('holds the bound under a burst of independent callers', async () => {
    const LIMIT = 6;
    const sem = createSemaphore(LIMIT);
    let live = 0;
    let peak = 0;

    await Promise.all(
      Array.from({ length: 60 }, async () => {
        await sem.acquire();
        try {
          live += 1;
          peak = Math.max(peak, live);
          await new Promise((r) => setTimeout(r, 1));
          live -= 1;
        } finally {
          sem.release();
        }
      }),
    );

    expect(peak).toBe(LIMIT);
    expect(sem.inFlight).toBe(0);
  });
});
