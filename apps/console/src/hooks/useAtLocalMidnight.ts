import { useEffect, useRef } from 'react';
import { msToNextLocalMidnight } from '../utils/agency/home';

/**
 * Calls `onMidnight` at each of the viewer's local midnights while `enabled`: one timer to the
 * boundary, set again for the next, cleared on unmount. Today so far and the promises read their
 * own minute, so without it they would show yesterday's figures under "since midnight" for up to a
 * minute after it. Skipped while the tab is hidden: a return to the tab reads once the day has
 * turned, by those hooks' own rule.
 */
export function useAtLocalMidnight(onMidnight: () => void, enabled: boolean): void {
  const latest = useRef(onMidnight);
  latest.current = onMidnight;
  useEffect(() => {
    if (!enabled) return undefined;
    let timer: ReturnType<typeof setTimeout>;
    const arm = () => {
      timer = setTimeout(() => {
        if (typeof document === 'undefined' || document.visibilityState !== 'hidden') latest.current();
        arm();
      }, msToNextLocalMidnight(new Date()));
    };
    arm();
    return () => clearTimeout(timer);
  }, [enabled]);
}
