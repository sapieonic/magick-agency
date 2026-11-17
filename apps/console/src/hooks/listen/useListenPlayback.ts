import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { browserStorage } from '../../utils/browserStorage';
import {
  ListenPlaybackEngine,
  defaultAudioContextFactory,
  type ListenAudioContextFactory,
} from '../../utils/listen/listenPlayback';
import type { AgencyListenLeg } from '../../types/live-calls';

/**
 * The listening bar's audio (`utils/listen/listenPlayback.ts`): one engine for the bar's life,
 * the two mutes, and the volume, which this browser remembers between listens. The engine's
 * `push` is handed straight to the socket, so a frame never goes through React state.
 */

/** Where this browser remembers the listening volume. */
export const LISTEN_VOLUME_KEY = 'magick-agency.listen.volume';

const DEFAULT_VOLUME = 0.8;

/**
 * How long the volume rests before this browser remembers it: a drag of the slider is one write,
 * not one per step. Whatever is still waiting is written when the bar's audio goes.
 */
export const LISTEN_VOLUME_SAVE_MS = 300;

/** The remembered volume, 0–1; the default when there is none or storage is blocked. */
export function readListenVolume(): number {
  try {
    const raw = browserStorage()?.getItem(LISTEN_VOLUME_KEY);
    if (raw === null || raw === undefined) return DEFAULT_VOLUME;
    const value = Number(raw);
    return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : DEFAULT_VOLUME;
  } catch {
    return DEFAULT_VOLUME;
  }
}

export function writeListenVolume(volume: number): void {
  try {
    browserStorage()?.setItem(LISTEN_VOLUME_KEY, String(volume));
  } catch {
    /* blocked site data: the volume is this page's only */
  }
}

export interface ListenPlayback {
  engine: ListenPlaybackEngine;
  muted: Record<AgencyListenLeg, boolean>;
  setMuted: (leg: AgencyListenLeg, muted: boolean) => void;
  volume: number;
  setVolume: (volume: number) => void;
}

export function useListenPlayback(createContext: ListenAudioContextFactory = defaultAudioContextFactory): ListenPlayback {
  const [engine] = useState(() => new ListenPlaybackEngine(createContext));
  const [muted, setMutedState] = useState<Record<AgencyListenLeg, boolean>>({ agent: false, customer: false });
  const [volume, setVolumeState] = useState(readListenVolume);
  /** A volume set and not yet remembered. */
  const unsaved = useRef<number | null>(null);

  useEffect(() => {
    engine.setVolume(volume);
  }, [engine, volume]);

  useEffect(() => {
    if (unsaved.current === null) return;
    const timer = setTimeout(saveVolume, LISTEN_VOLUME_SAVE_MS);
    return () => clearTimeout(timer);
  }, [volume]);

  useEffect(
    () => () => {
      saveVolume();
      engine.close();
    },
    [engine],
  );

  function saveVolume() {
    if (unsaved.current === null) return;
    writeListenVolume(unsaved.current);
    unsaved.current = null;
  }

  const setMuted = useCallback(
    (leg: AgencyListenLeg, next: boolean) => {
      engine.setMuted(leg, next);
      setMutedState((prev) => ({ ...prev, [leg]: next }));
    },
    [engine],
  );

  const setVolume = useCallback((next: number) => {
    const clamped = Math.min(1, Math.max(0, next));
    unsaved.current = clamped;
    setVolumeState(clamped);
  }, []);

  return useMemo(() => ({ engine, muted, setMuted, volume, setVolume }), [engine, muted, setMuted, volume, setVolume]);
}
