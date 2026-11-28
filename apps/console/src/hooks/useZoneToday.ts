import { useState } from 'react';
import { todayIn } from '../utils/reports/reportWindow';
import { useAtLocalMidnight } from './useAtLocalMidnight';
import { useRefetchOnReturn } from './useRefetchOnReturn';
import { useVisibleInterval } from './useVisibleInterval';

/**
 * Today in `zone`, kept current: read on every render, and the page re-renders when the day
 * turns (checked each minute while the tab is shown, when it is shown or focused again, and at
 * local midnight), so a page left open past midnight moves Today, the presets and the date
 * pickers' latest day with it. `now` (tests) fixes the clock.
 */
export function useZoneToday(zone: string, now: Date | undefined): string {
  const [, setDay] = useState(() => todayIn(zone, now ?? new Date()));
  const check = () => {
    if (!now) setDay(todayIn(zone, new Date()));
  };
  useVisibleInterval(check, 60_000, !now);
  useRefetchOnReturn(check);
  useAtLocalMidnight(check, !now);
  return todayIn(zone, now ?? new Date());
}
