import { useEffect, useState, useSyncExternalStore } from 'react';

/**
 * A repainting `now` (ms), moved on every `periodMs` while `active`.
 *
 * A repaint trigger, never a time source: every duration is recomputed from its absolute anchor
 * against it, so nothing accumulates and nothing drifts (`utils/agencyClock`'s rule). One clock
 * serves everything that shares it, instead of a timer per row. It is read again at once when it
 * (re)activates: a tab restored from the background can be arbitrarily far from the last painted
 * value, and waiting a whole period to correct it shows a stale duration at the worst moment.
 */
export function useNow(periodMs: number, active = true): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), periodMs);
    return () => clearInterval(timer);
  }, [periodMs, active]);
  return now;
}

function subscribeVisibility(onChange: () => void): () => void {
  document.addEventListener('visibilitychange', onChange);
  return () => document.removeEventListener('visibilitychange', onChange);
}

/** Whether the page is visible: a clock that only repaints (`useNow`) can stop while it is not. */
export function usePageVisible(): boolean {
  return useSyncExternalStore(subscribeVisibility, () => document.visibilityState === 'visible', () => true);
}
