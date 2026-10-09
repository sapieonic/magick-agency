import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';
import { useServerClock } from '../../hooks/useServerClock';
import { formatDuration } from '../../utils/agencyClock';

/**
 * `useServerClock` (§A.13.2 / §A.13.10) — acceptance criterion (b).
 *
 * **Every assertion here names an exact string or an exact number.** That is not
 * pedantry: the predecessor's own harness bug — advancing `setSystemTime` *and*
 * `advanceTimersByTime`, so the clock moved twice — surfaced only because an
 * assertion named the exact value it expected. `toBeGreaterThan(0)` would have
 * passed against a clock running at double speed for the whole shift.
 */

const T0 = Date.parse('2026-08-11T12:00:00.000Z');

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

/** Advancing the fake timers also advances the faked `Date`. Never both. */
function advance(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

describe('the interval is a repaint trigger, never a time source', () => {
  it('recomputes the remaining time from the deadline on each repaint', () => {
    const endsAt = new Date(T0 + 30_000).toISOString();
    const { result } = renderHook(() => useServerClock(0));

    expect(result.current.until(endsAt)).toBe(30_000);
    advance(1_000);
    expect(result.current.until(endsAt)).toBe(29_000);
    advance(9_000);
    expect(result.current.until(endsAt)).toBe(20_000);
  });

  it('survives a clock that JUMPS, which a decrementing counter could not', () => {
    // The whole point of recompute-from-anchor: a tab that was throttled for 25
    // seconds comes back to the truth, not to 29 seconds of accumulated ticks.
    const endsAt = new Date(T0 + 30_000).toISOString();
    const { result } = renderHook(() => useServerClock(0));

    advance(25_000);

    expect(result.current.until(endsAt)).toBe(5_000);
    expect(formatDuration(result.current.until(endsAt)!)).toBe('0:05');
  });

  it('does not accumulate error over two hundred wrap-ups of a shift', () => {
    // The named criterion failure is "drifts over a shift", not "is wrong once".
    // 200 x 30s of repaints, then an exact-value assertion.
    const { result } = renderHook(() => useServerClock(0));
    const endsAt = new Date(T0 + 6_000_000).toISOString();

    for (let i = 0; i < 200; i += 1) advance(30_000);

    // 200 x 30s = 6,000,000ms elapsed, so exactly zero remains — not "about zero".
    expect(result.current.until(endsAt)).toBe(0);
    expect(result.current.now).toBe(T0 + 6_000_000);
  });
});

describe('the offset correction reaches every helper', () => {
  it('applies the offset to a deadline', () => {
    // A machine 90s FAST reports a server deadline 90s later than it truly is
    // unless corrected. Offset is subtracted from the server instant.
    const endsAt = new Date(T0 + 30_000).toISOString();
    const { result } = renderHook(() => useServerClock(90_000));
    expect(result.current.until(endsAt)).toBe(0);

    const { result: slow } = renderHook(() => useServerClock(-90_000));
    expect(slow.current.until(endsAt)).toBe(120_000);
  });

  it('applies the offset to an elapsed anchor', () => {
    const since = new Date(T0 - 60_000).toISOString();
    const { result } = renderHook(() => useServerClock(0));
    expect(formatDuration(result.current.since(since)!)).toBe('1:00');

    const { result: fast } = renderHook(() => useServerClock(15_000));
    // The server's "60s ago" is really 75s ago on this client's clock.
    expect(formatDuration(fast.current.since(since)!)).toBe('1:15');
  });

  it('clamps a passed deadline at zero rather than counting negative', () => {
    // Reaching `ends_at` is NOT the end of wrap-up — that comes on `agent_state` —
    // so the console must tolerate the present passing the deadline while still in
    // wrap-up. A negative readout is an overrun timer: a surveillance surface
    // whose effect is rushed, low-quality dispositions.
    const endsAt = new Date(T0 - 47_000).toISOString();
    const { result } = renderHook(() => useServerClock(0));
    expect(result.current.until(endsAt)).toBe(0);
  });

  it('floors an elapsed time at zero for an anchor in the future', () => {
    const { result } = renderHook(() => useServerClock(0));
    expect(result.current.since(new Date(T0 + 5_000).toISOString())).toBe(0);
  });

  it('exposes the offset it was given', () => {
    const { result } = renderHook(() => useServerClock(1234));
    expect(result.current.offsetMs).toBe(1234);
  });
});

describe('absent and unparseable instants render nothing, never 1970', () => {
  it.each([null, undefined, '', 'not-a-date'])('returns null for %p', (value) => {
    const { result } = renderHook(() => useServerClock(0));
    expect(result.current.until(value as string | null)).toBeNull();
    expect(result.current.since(value as string | null)).toBeNull();
    expect(result.current.corrected(value as string | null)).toBeNull();
  });

  it('never yields 0 for a missing deadline', () => {
    // `0` here would be the epoch, rendering as a wildly expired countdown — the
    // single worst thing a clock can show an agent.
    const { result } = renderHook(() => useServerClock(0));
    expect(result.current.until(null)).not.toBe(0);
  });
});

describe('the enabled gate', () => {
  it('stops repainting when disabled, and the value freezes rather than lying', () => {
    const endsAt = new Date(T0 + 30_000).toISOString();
    const { result } = renderHook(() => useServerClock(0, false));
    const first = result.current.until(endsAt);

    advance(5_000);

    // No repaint fired, so no re-render happened and the last computed value
    // stands. It is stale, not wrong — nothing on screen is counting.
    expect(result.current.until(endsAt)).toBe(first);
  });

  it('repaints on the 250ms boundary and not before it', () => {
    // §A.13.2 picks 250ms over 1s deliberately: at 1s the visible digit can lag
    // the true boundary by nearly the whole one-second tolerance, spent on repaint
    // alone. So the cadence is a real requirement and worth pinning at its edge.
    //
    // Measured one step at a time. Advancing 1000ms inside a single `act` runs all
    // four callbacks before React flushes, which batches them into ONE render —
    // a render count over a long advance measures React's batching, not this
    // hook's cadence, and the first draft of this test asserted exactly that.
    let renders = 0;
    renderHook(() => {
      renders += 1;
      return useServerClock(0);
    });

    const mounted = renders;
    advance(249);
    expect(renders).toBe(mounted);

    advance(1);
    expect(renders).toBe(mounted + 1);

    advance(250);
    expect(renders).toBe(mounted + 2);
  });
});
