import { useCallback, useEffect, useRef, useState } from 'react';
import { useLatestRef } from './useLatestRef';
import { newHelpKeys, readHelpChimeOn, writeHelpChimeOn } from '../utils/agency/floorAssist';
import { playHelpChime, unlockHelpChime } from '../utils/agency/helpChime';

/** Every mounted chime's setter: a toggle in one (the shell's alerts, Live floor) moves them all. */
const instances = new Set<(on: boolean) => void>();

const NONE: readonly string[] = [];

/**
 * The supervisor's chime (LF4, LF31; AS16): once per new key, on by default, muted per browser.
 * Live floor hears its Need help requests with it, and the console's shell every supervisor alert
 * on every page (`SupervisorAlerts`).
 *
 * - `keys` are what is open now (the floor's `helpKeys`, or the alerts' ids), or null until the
 *   first read. The first read only notes what is open (shown, not chimed for); each later read
 *   chimes once if it holds a key not seen before by this hook, however many are new, and never for
 *   one already heard. A poll that says the same changes nothing (the keys are joined into one
 *   string for the effect).
 * - `quiet` keys are noted as heard but never played for: the shell names Need help quiet on Live
 *   floor, whose own chime plays for it there, so nothing is heard twice and leaving the page does
 *   not chime for a request already heard.
 * - Muted, it notes the keys all the same, so turning the sound back on never plays for one that
 *   came in while it was off.
 * - The setting is this browser's (`readHelpChimeOn`, storage wrapped: without storage it is on,
 *   and a change lasts until the page is reloaded), and every chime mounted on the page follows a
 *   toggle in any of them. Turning it on is a gesture, so it also unlocks the sound; a browser that
 *   still refuses stays silent (`helpChime.ts`).
 */
export function useHelpChime(
  keys: readonly string[] | null,
  quiet: readonly string[] = NONE,
): { on: boolean; toggle: () => void } {
  const [on, setOn] = useState(readHelpChimeOn);
  const onRef = useLatestRef(on);
  const quietRef = useLatestRef(quiet);
  const seen = useRef<Set<string> | null>(null);
  const joined = keys === null ? null : keys.join('\n');

  useEffect(() => {
    instances.add(setOn);
    return () => {
      instances.delete(setOn);
    };
  }, []);

  useEffect(() => {
    if (joined === null) return;
    const current = joined === '' ? [] : joined.split('\n');
    const fresh = newHelpKeys(seen.current, current);
    // Every key heard while the page is open, not only the last read's: a key a read left out (the
    // flag unreadable answers `help: null`, LF11) is not new when the next read shows it.
    if (seen.current === null) seen.current = new Set(current);
    else for (const key of fresh) seen.current.add(key);
    const audible = fresh.filter((key) => !quietRef.current.includes(key));
    if (audible.length > 0 && onRef.current) playHelpChime();
  }, [joined]);

  const toggle = useCallback(() => {
    const next = !onRef.current;
    writeHelpChimeOn(next);
    for (const set of instances) set(next);
    unlockHelpChime();
  }, [onRef]);

  return { on, toggle };
}
