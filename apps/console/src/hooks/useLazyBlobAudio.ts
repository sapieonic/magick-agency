import { useEffect, useRef, useState } from 'react';
import type { BlobAudio } from '../api/blobAudio';
import { useMountedRef } from './useMountedRef';

export type LazyBlobAudioState = { status: 'idle' } | { status: 'loading' } | BlobAudio;

/**
 * A recording fetched only when the reader asks for it (`load`), into a blob URL revoked when the
 * component goes, including one that lands after it went. Behind the Missed list's voicemail
 * player and the route editor's recording preview.
 */
export function useLazyBlobAudio(
  /** Starts the fetch; null when there is nothing to fetch with yet (no tenant). */
  fetchAudio: () => Promise<BlobAudio> | null,
): { state: LazyBlobAudioState; load: () => Promise<void> } {
  const [state, setState] = useState<LazyBlobAudioState>({ status: 'idle' });
  const urlRef = useRef<string | null>(null);
  const mounted = useMountedRef();

  useEffect(
    () => () => {
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      urlRef.current = null;
    },
    [],
  );

  const load = async () => {
    if (state.status === 'loading') return;
    const pending = fetchAudio();
    if (!pending) return;
    setState({ status: 'loading' });
    const audio = await pending;
    if (!mounted.current) {
      if (audio.status === 'ready') URL.revokeObjectURL(audio.url);
      return;
    }
    if (audio.status === 'ready') urlRef.current = audio.url;
    setState(audio);
  };

  return { state, load };
}
