import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * One Compare agents read (`docs/compare-agents.md` §7), keyed by what it asks for: a new key
 * cancels the read in flight (its answer is never shown) and starts another, while the last
 * answer stays on screen marked as updating, so changing a filter does not blank the page.
 *
 * A null key reads nothing and clears the answer (nothing to compare yet). `retry` repeats the
 * read of the current key: the page offers it on `compare_busy` and `compare_timed_out`, which
 * clear by themselves. Nothing polls: a comparison is a moment's figures (the server caches
 * them for 30 s), read again only when the reader asks.
 */
export type CompareReadState<T> =
  | { status: 'idle'; data: null; error: null }
  | { status: 'loading'; data: T | null; error: null }
  | { status: 'ready'; data: T; error: null }
  | { status: 'error'; data: T | null; error: unknown };

export function useCompareRead<T>(
  key: string | null,
  read: (signal: AbortSignal) => Promise<T>,
): CompareReadState<T> & { retry: () => void } {
  const [state, setState] = useState<CompareReadState<T>>({ status: 'idle', data: null, error: null });
  const [attempt, setAttempt] = useState(0);
  const readRef = useRef(read);
  readRef.current = read;

  useEffect(() => {
    if (key === null) {
      setState({ status: 'idle', data: null, error: null });
      return;
    }
    const controller = new AbortController();
    setState((prev) => ({ status: 'loading', data: prev.data, error: null }));
    readRef
      .current(controller.signal)
      .then((data) => {
        if (!controller.signal.aborted) setState({ status: 'ready', data, error: null });
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setState((prev) => ({ status: 'error', data: prev.data, error }));
      });
    return () => controller.abort();
  }, [key, attempt]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  return { ...state, retry };
}
