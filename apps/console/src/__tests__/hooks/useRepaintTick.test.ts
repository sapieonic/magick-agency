import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';
import { useRepaintTick } from '../../hooks/useRepaintTick';

/**
 * `useRepaintTick` — the cadence every counting leaf repaints on.
 *
 * These were `useServerClock`'s tests while that hook ran the repaint at the
 * console root. The repaint moved into the leaves (the talk timer, `WrapupTimer`,
 * the callback chips, `RailPresenceRegion`), so its cadence and its gate are
 * pinned here, at the hook that owns them.
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

describe('the enabled gate', () => {
  it('stops repainting when disabled', () => {
    let renders = 0;
    renderHook(() => {
      renders += 1;
      return useRepaintTick(false);
    });
    const mounted = renders;

    advance(5_000);

    // No repaint fired, so no re-render happened. Nothing on screen is counting.
    expect(renders).toBe(mounted);
  });

  it('starts and stops with the gate, without remounting', () => {
    let renders = 0;
    const { rerender } = renderHook(
      ({ on }) => {
        renders += 1;
        return useRepaintTick(on);
      },
      { initialProps: { on: false } },
    );
    advance(1_000);
    const before = renders;

    rerender({ on: true });
    const enabledAt = renders;
    expect(enabledAt).toBe(before + 1);
    advance(250);
    expect(renders).toBe(enabledAt + 1);

    rerender({ on: false });
    const disabledAt = renders;
    advance(1_000);
    expect(renders).toBe(disabledAt);
  });
});

describe('the cadence', () => {
  it('repaints on the 250ms boundary and not before it', () => {
    // picks 250ms over 1s deliberately: at 1s the visible digit can lag
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
      return useRepaintTick();
    });

    const mounted = renders;
    advance(249);
    expect(renders).toBe(mounted);

    advance(1);
    expect(renders).toBe(mounted + 1);

    advance(250);
    expect(renders).toBe(mounted + 2);
  });

  it('repaints on the way back to visible, before the next tick', () => {
    let renders = 0;
    renderHook(() => {
      renders += 1;
      return useRepaintTick();
    });
    const mounted = renders;

    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });

    // happy-dom reports `visible`, so the return trip repaints at once.
    expect(document.visibilityState).toBe('visible');
    expect(renders).toBe(mounted + 1);
  });
});
