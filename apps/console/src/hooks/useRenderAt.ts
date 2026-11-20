import { useEffect, useState } from 'react';

/**
 * Renders its caller once more at `at` (a local epoch ms), and never otherwise: one timer to the
 * next instant the caller's words change, instead of a repaint four times a second. The caller
 * recomputes from the clock when it renders and passes the next instant again, so it keeps
 * moving for as long as there is a next instant, and stops (no timer at all) when there is none.
 *
 * Also renders again when the tab comes back to the front: a background tab's timers are
 * throttled, so the instant may have passed unseen.
 */
export function useRenderAt(at: number | null): void {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (at === null) return undefined;
    const bump = () => setTick((n) => n + 1);
    const onVisibility = () => {
      if (document.visibilityState === 'visible') bump();
    };
    document.addEventListener('visibilitychange', onVisibility);
    const wait = at - Date.now();
    const timer = wait > 0 ? window.setTimeout(bump, wait) : null;
    return () => {
      if (timer !== null) window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [at]);
}
