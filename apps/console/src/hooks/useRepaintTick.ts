import { useEffect, useState } from 'react';
import { CLOCK_REPAINT_MS } from '../utils/agencyClock';

/**
 * Drives the console's countdowns and elapsed times.
 *
 * **The interval is a repaint trigger, never a time source.** This hook returns a
 * monotonically increasing tick and nothing else — deliberately not a time, so a
 * caller cannot accumulate it. Every consumer recomputes from an absolute server
 * anchor, which is what makes "does not drift over a shift" a property of the
 * design rather than a hope.
 *
 * Repaints at 250ms even though every display is in whole seconds: at 1s the
 * visible digit can lag the true boundary by nearly the whole one-second
 * tolerance, spent on repaint alone.
 *
 * **Recomputes on `visibilitychange → visible`, before the next tick.** A
 * backgrounded tab is throttled to as little as one timer callback per minute, so
 * an agent who tabs away during wrap-up and comes back would otherwise see a stale
 * bar until the next scheduled tick.
 */
export function useRepaintTick(enabled = true): number {
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!enabled) return;

    const bump = () => setTick((n) => n + 1);
    const id = window.setInterval(bump, CLOCK_REPAINT_MS);

    // Not `document.addEventListener('visibilitychange', bump)` alone: the point
    // is to repaint on the way back to visible, not on the way out.
    const onVisibility = () => {
      if (document.visibilityState === 'visible') bump();
    };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [enabled]);

  return tick;
}
