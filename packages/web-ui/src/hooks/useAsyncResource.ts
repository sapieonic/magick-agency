import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Load one value with `fetcher`, expose `{ data, loading, error, reload }`, and
 * never let an older response overwrite a newer one.
 *
 * The apps' list hooks were one shape copied with the names swapped, and none
 * of them guarded stale responses: a `reload()` fired while the first load was
 * still in flight could be answered out of order, and whichever came back LAST
 * won, even when it was the older request. Here every load takes a sequence
 * number and only the latest one may write state.
 *
 * `fetcher` is a dependency: pass a stable function (module-level, or
 * `useCallback` over the inputs it reads). A new identity loads again, which is
 * how a fetcher that closes over an id refetches when the id changes.
 *
 * On a reload the previous `data` stays in place while `loading` is true; a
 * failure sets `error` (the thrown `Error`'s message, else `errorMessage`) and
 * also keeps the previous `data`.
 */
export interface AsyncResource<T> {
  data: T;
  loading: boolean;
  error: string | null;
  /** Load again. Resolves when this load settles (it never rejects). */
  reload: () => Promise<void>;
}

export interface AsyncResourceOptions<T> {
  /** `data` until the first load succeeds. Read once, on mount. */
  initialData: T;
  /** The error text when the thrown value carries no message. */
  errorMessage?: string;
}

export function useAsyncResource<T>(
  fetcher: () => Promise<T>,
  { initialData, errorMessage = 'Failed to load' }: AsyncResourceOptions<T>,
): AsyncResource<T> {
  const [data, setData] = useState<T>(() => initialData);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const sequence = useRef(0);
  const fallback = useRef(errorMessage);
  fallback.current = errorMessage;

  const reload = useCallback(async () => {
    const seq = ++sequence.current;
    setLoading(true);
    setError(null);
    try {
      const value = await fetcher();
      if (seq === sequence.current) setData(value);
    } catch (err) {
      if (seq === sequence.current) {
        setError(err instanceof Error && err.message ? err.message : fallback.current);
      }
    } finally {
      if (seq === sequence.current) setLoading(false);
    }
  }, [fetcher]);

  useEffect(() => { void reload(); }, [reload]);

  return { data, loading, error, reload };
}
