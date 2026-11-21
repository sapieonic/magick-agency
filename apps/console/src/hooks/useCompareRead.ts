import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * One Compare agents read (`docs/compare-agents.md` §7), keyed by what it asks for: a new key
 * cancels the read in flight (its answer is never shown) and starts another, while the last
 * answer stays on screen marked as updating, so changing a filter does not blank the page.
 * `dataKey` is the key the answer on screen was read for, so a caller can tell an answer to the
 * current question from the last one kept up while the next loads; `doneKey` is the key of the
 * last read that finished, answered or failed (a key it is not has not been answered yet, even
 * on the render that first asks it, before the read has started).
 *
 * A null key reads nothing and clears the answer (nothing to compare yet). `retry` repeats the
 * read of the current key: the page offers it on a failure that can clear by itself. Nothing
 * polls: a comparison is a moment's figures (the server caches them for 30 s), read again only
 * when the reader asks.
 *
 * `paused`: no read runs. A read in flight is cancelled (its answer is never shown), the last
 * answer stays on screen, and the read of the key starts again once unpaused, unless that key was
 * already answered or refused. The page pauses the comparison while a new window's options load,
 * so it never has the options read and a query in flight together (§2: the tenant limit is 2).
 */
export type CompareReadState<T> =
  | { status: 'idle'; data: null; dataKey: null; doneKey: null; error: null }
  | { status: 'loading'; data: T | null; dataKey: string | null; doneKey: string | null; error: null }
  | { status: 'ready'; data: T; dataKey: string; doneKey: string; error: null }
  | { status: 'error'; data: T | null; dataKey: string | null; doneKey: string; error: unknown };

export function useCompareRead<T>(
  key: string | null,
  read: (signal: AbortSignal) => Promise<T>,
  paused = false,
): CompareReadState<T> & { retry: () => void } {
  const [state, setState] = useState<CompareReadState<T>>({ status: 'idle', data: null, dataKey: null, doneKey: null, error: null });
  const [attempt, setAttempt] = useState(0);
  const readRef = useRef(read);
  readRef.current = read;
  // The key and attempt whose read finished (answered or refused): unpausing does not ask it again.
  const settledRef = useRef<{ key: string; attempt: number } | null>(null);

  useEffect(() => {
    if (key === null) {
      settledRef.current = null;
      setState({ status: 'idle', data: null, dataKey: null, doneKey: null, error: null });
      return;
    }
    // Paused: the previous run's clean-up has cancelled any read in flight; start nothing.
    if (paused) return;
    const settled = settledRef.current;
    if (settled !== null && settled.key === key && settled.attempt === attempt) return;
    const controller = new AbortController();
    setState((prev) => ({ status: 'loading', data: prev.data, dataKey: prev.dataKey, doneKey: prev.doneKey, error: null }));
    readRef
      .current(controller.signal)
      .then((data) => {
        if (controller.signal.aborted) return;
        settledRef.current = { key, attempt };
        setState({ status: 'ready', data, dataKey: key, doneKey: key, error: null });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        settledRef.current = { key, attempt };
        setState((prev) => ({ status: 'error', data: prev.data, dataKey: prev.dataKey, doneKey: key, error }));
      });
    return () => controller.abort();
  }, [key, attempt, paused]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  return { ...state, retry };
}

/** How long the comparison's question must stay still before it is asked (§7: one read per settled pick). */
export const COMPARE_SETTLE_MS = 300;

/**
 * `key` once it has stayed the same for `delayMs`, so a burst of chip and metric clicks sends one
 * read, not one per click (each would take one of the tenant's two compare slots, §7). While
 * `hold` is true the settled key does not move: the page holds the comparison while the options
 * for a new window load, so it never asks with the old window's agents. A null key (nothing to
 * compare) settles at once.
 */
export function useSettledKey(key: string | null, delayMs: number, hold = false): string | null {
  const [settled, setSettled] = useState<string | null>(hold ? null : key);
  useEffect(() => {
    if (hold) return;
    if (key === null) {
      setSettled(null);
      return;
    }
    const timer = setTimeout(() => setSettled(key), delayMs);
    return () => clearTimeout(timer);
  }, [key, delayMs, hold]);
  return settled;
}
