import { useCallback, useEffect, useState } from 'react';
import type { AgencyFloorAlertKind } from '@magick-agency/contracts/api/agency/floor';
import { useLatestRef } from './useLatestRef';
import { heardFrom, readHelpChimeOn, writeHelpChimeOn, type ChimeKey } from '../utils/agency/floorAssist';
import { playHelpChime, unlockHelpChime } from '../utils/agency/helpChime';

/** Every mounted chime's setter: a toggle in one (the shell's alerts, Live floor) moves them all. */
const instances = new Set<(on: boolean) => void>();

/**
 * The alerts heard on this page, by every chime: Live floor's (its floor read) and the shell's (the
 * alerts read). One set, so an alert is chimed once whichever read sees it first, and a request
 * first seen on Live floor is never chimed again by the shell, nor one the shell heard by Live floor.
 * A reload starts it again (a new page).
 */
const heard = new Set<string>();
/** The kinds some read of this page has already seen (its first read of them only noted them). */
const baselined = new Set<AgencyFloorAlertKind>();

/** Tests only: a new page's heard alerts. */
export function resetHeardAlertsForTests(): void {
  heard.clear();
  baselined.clear();
}

const ALL_KINDS: readonly AgencyFloorAlertKind[] = ['help', 'break_over', 'disconnected'];

/**
 * The supervisor's chime (LF4, LF31; AS16): once per new alert on the page, on by default, muted
 * per browser. Live floor hears its Need help requests with it (`covers` `['help']`), and the
 * console's shell every supervisor alert on every page (`SupervisorAlerts`, every kind).
 *
 * - `keys` are what is open now (the floor's `helpKeys`, or the alerts' `chimeKey`s), or null until
 *   the first read. They go into one set for the page ({@link heardFrom}): the page's first read of
 *   a kind only notes what is open of it (shown, not chimed for); after that each read chimes once
 *   if it holds a key no read on the page has heard, however many are new, and never for one
 *   already heard. So a request chimes exactly once across Live floor and the shell, whichever
 *   reads it first, and leaving or opening Live floor never chimes it again. A poll that says the
 *   same changes nothing (the keys are joined into one string for the effect).
 * - Muted, it notes the keys all the same, so turning the sound back on never plays for one that
 *   came in while it was off.
 * - The setting is this browser's (`readHelpChimeOn`: the page's own choice first, so every chime
 *   agrees even where storage is blocked; without storage it is on until toggled), and every chime
 *   mounted on the page follows a toggle in any of them. Turning it on is a gesture, so it also
 *   unlocks the sound; a browser that still refuses stays silent (`helpChime.ts`).
 */
export function useHelpChime(
  keys: readonly ChimeKey[] | null,
  covers: readonly AgencyFloorAlertKind[] = ALL_KINDS,
): { on: boolean; toggle: () => void } {
  const [on, setOn] = useState(readHelpChimeOn);
  const onRef = useLatestRef(on);
  const coversRef = useLatestRef(covers);
  const joined = keys === null ? null : keys.map(({ kind, key }) => `${kind}\t${key}`).join('\n');

  useEffect(() => {
    instances.add(setOn);
    return () => {
      instances.delete(setOn);
    };
  }, []);

  useEffect(() => {
    if (joined === null) return;
    const current: ChimeKey[] = joined === '' ? [] : joined.split('\n').map((line) => {
      const tab = line.indexOf('\t');
      return { kind: line.slice(0, tab) as AgencyFloorAlertKind, key: line.slice(tab + 1) };
    });
    const { fresh, noted, baselines } = heardFrom(heard, baselined, coversRef.current, current);
    for (const kind of baselines) baselined.add(kind);
    for (const key of [...noted, ...fresh]) heard.add(key);
    if (fresh.length > 0 && onRef.current) playHelpChime();
  }, [joined]);

  const toggle = useCallback(() => {
    const next = !onRef.current;
    writeHelpChimeOn(next);
    for (const set of instances) set(next);
    unlockHelpChime();
  }, [onRef]);

  return { on, toggle };
}
