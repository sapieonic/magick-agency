import { useCallback, useEffect, useMemo, useState } from 'react';
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

  useEffect(() => {
    engine.setVolume(volume);
  }, [engine, volume]);

  useEffect(() => () => engine.close(), [engine]);

  const setMuted = useCallback(
    (leg: AgencyListenLeg, next: boolean) => {
      engine.setMuted(leg, next);
      setMutedState((prev) => ({ ...prev, [leg]: next }));
    },
    [engine],
  );

  const setVolume = useCallback((next: number) => {
    const clamped = Math.min(1, Math.max(0, next));
    setVolumeState(clamped);
    writeListenVolume(clamped);
  }, []);

  return useMemo(() => ({ engine, muted, setMuted, volume, setVolume }), [engine, muted, setMuted, volume, setVolume]);
}
