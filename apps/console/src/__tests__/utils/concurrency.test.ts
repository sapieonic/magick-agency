import { describe, it, expect, vi } from 'vitest';
import { DEFAULT_CONCURRENCY, mapWithConcurrency } from '../../utils/concurrency';

/**
 * The bounded fan-out helper.
 *
 * Written because `Promise.all(items.map(fn))` was firing one request per campaign
 * with no ceiling, over a list whose length is a property of the account's history
 * rather than of the screen.
 */

describe('mapWithConcurrency', () => {
  it('returns results in INPUT order, not completion order', async () => {
    // Load-bearing: both call sites zip results back against the input list by
    // index, so a helper that returned them as they finished would mislabel every
    // row.
    const out = await mapWithConcurrency([30, 10, 20], async (ms) => {
      await new Promise((r) => setTimeout(r, ms));
      return ms;
    });

    expect(out.map((r) => (r.status === 'fulfilled' ? r.value : null))).toEqual([30, 10, 20]);
  });

  it('never exceeds the limit in flight', async () => {
    let inFlight = 0;
    let peak = 0;

    await mapWithConcurrency(
      Array.from({ length: 20 }, (_, i) => i),
      async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight -= 1;
      },
      3,
    );

    expect(peak).toBe(3);
  });

  it('still processes every item', async () => {
    const seen: number[] = [];

    await mapWithConcurrency(
      Array.from({ length: 25 }, (_, i) => i),
      async (i) => {
        seen.push(i);
      },
      4,
    );

    expect(seen.sort((a, b) => a - b)).toEqual(Array.from({ length: 25 }, (_, i) => i));
  });

  it('isolates a rejection — siblings still resolve', async () => {
    // The property the analytics page depends on: one campaign's failed stats read
    // annotates its own card and leaves the others' figures on screen.
    const out = await mapWithConcurrency([1, 2, 3], async (n) => {
      if (n === 2) throw new Error('boom');
      return n * 10;
    });

    expect(out[0]).toEqual({ status: 'fulfilled', value: 10 });
    expect(out[1]!.status).toBe('rejected');
    expect(out[2]).toEqual({ status: 'fulfilled', value: 30 });
  });

  it('does not reject, however many items fail', async () => {
    // `Promise.all` semantics here would discard every successful lookup the
    // moment one campaign 404s.
    await expect(
      mapWithConcurrency([1, 2], async () => {
        throw new Error('all of them');
      }),
    ).resolves.toHaveLength(2);
  });

  it('handles an empty list without calling the mapper', async () => {
    const fn = vi.fn();
    expect(await mapWithConcurrency([], fn)).toEqual([]);
    expect(fn).not.toHaveBeenCalled();
  });

  it('does not spawn more workers than there are items', async () => {
    // A 6-worker pool over one item would be five immediately-returning loops.
    let peak = 0;
    let inFlight = 0;
    await mapWithConcurrency(
      [1],
      async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 1));
        inFlight -= 1;
      },
      DEFAULT_CONCURRENCY,
    );
    expect(peak).toBe(1);
  });

  it('treats a limit below 1 as 1 rather than deadlocking', async () => {
    // A zero-worker pool would await nothing and return holes.
    const out = await mapWithConcurrency([1, 2], async (n) => n, 0);
    expect(out.map((r) => (r.status === 'fulfilled' ? r.value : null))).toEqual([1, 2]);
  });

  it('passes the index through', async () => {
    const out = await mapWithConcurrency(['a', 'b'], async (item, i) => `${i}:${item}`);
    expect(out.map((r) => (r.status === 'fulfilled' ? r.value : null))).toEqual(['0:a', '1:b']);
  });
});
