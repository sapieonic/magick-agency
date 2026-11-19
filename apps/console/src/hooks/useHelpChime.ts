import { useCallback, useEffect, useRef, useState } from 'react';
import { useLatestRef } from './useLatestRef';
import { newHelpKeys, readHelpChimeOn, writeHelpChimeOn } from '../utils/agency/floorAssist';
import { playHelpChime, unlockHelpChime } from '../utils/agency/helpChime';

/**
 * Need help's chime on Live floor (LF4, LF31): once per new request, on by default, muted per
 * browser.
 *
 * - `keys` are the floor's open requests (`helpKeys`), or null until the floor is read. The first
 *   read only notes what is open (shown, not chimed for); each later read chimes once if it holds a
 *   request not seen before on this page, however many are new, and never for one already heard. A poll
 *   that says the same changes nothing (the keys are joined into one string for the effect).
 * - Muted, it notes the requests all the same, so turning the sound back on never plays for a
 *   request that came in while it was off.
 * - The setting is this browser's (`readHelpChimeOn`, storage wrapped: without storage it is on,
 *   and a change lasts until the page is reloaded). Turning it on is a gesture, so it also unlocks
 *   the sound; a browser that still refuses stays silent (`helpChime.ts`).
 */
export function useHelpChime(keys: readonly string[] | null): { on: boolean; toggle: () => void } {
  const [on, setOn] = useState(readHelpChimeOn);
  const onRef = useLatestRef(on);
  const seen = useRef<Set<string> | null>(null);
  const joined = keys === null ? null : keys.join('\n');

  useEffect(() => {
    if (joined === null) return;
    const current = joined === '' ? [] : joined.split('\n');
    const fresh = newHelpKeys(seen.current, current);
    // Every request heard while the page is open, not only the last read's: a request a read left
    // out (the flag unreadable answers `help: null`, LF11) is not new when the next read shows it.
    if (seen.current === null) seen.current = new Set(current);
    else for (const key of fresh) seen.current.add(key);
    if (fresh.length > 0 && onRef.current) playHelpChime();
  }, [joined]);

  const toggle = useCallback(() => {
    setOn((was) => {
      const next = !was;
      writeHelpChimeOn(next);
      return next;
    });
    unlockHelpChime();
  }, []);

  return { on, toggle };
}
