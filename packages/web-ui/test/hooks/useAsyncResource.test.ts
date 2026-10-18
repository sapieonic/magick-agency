import { describe, it, expect, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useAsyncResource } from '../../src/hooks/useAsyncResource';

/** A promise the test settles by hand. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe('useAsyncResource', () => {
  it('starts loading with the initial data, then holds the fetched value', async () => {
    const fetcher = vi.fn().mockResolvedValue(['a', 'b']);
    const { result } = renderHook(() => useAsyncResource(fetcher, { initialData: [] as string[] }));

    expect(result.current.loading).toBe(true);
    expect(result.current.data).toEqual([]);
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data).toEqual(['a', 'b']);
    expect(result.current.error).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('reports the thrown message, else the fallback, and keeps the previous data', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(['kept'])
      .mockRejectedValueOnce(new Error('boom'))
      .mockRejectedValueOnce('not an Error');
    const { result } = renderHook(() =>
      useAsyncResource(fetcher, { initialData: [] as string[], errorMessage: 'Failed to load things' }));
    await waitFor(() => expect(result.current.data).toEqual(['kept']));

    await act(() => result.current.reload());
    expect(result.current.error).toBe('boom');
    expect(result.current.data).toEqual(['kept']);

    await act(() => result.current.reload());
    expect(result.current.error).toBe('Failed to load things');
    expect(result.current.loading).toBe(false);
  });

  // The guard the copied hooks lacked: an older response that lands last must
  // not overwrite the newer one.
  it('ignores an older response that settles after a newer one', async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    const fetcher = vi.fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const { result } = renderHook(() => useAsyncResource(fetcher, { initialData: 'initial' }));

    let reloading!: Promise<void>;
    act(() => { reloading = result.current.reload(); });
    await act(async () => { second.resolve('newer'); await reloading; });
    expect(result.current.data).toBe('newer');
    expect(result.current.loading).toBe(false);

    await act(async () => { first.resolve('older'); await first.promise; });
    expect(result.current.data).toBe('newer');
  });

  it('ignores an older failure that settles after a newer success', async () => {
    const first = deferred<string>();
    const fetcher = vi.fn()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce('newer');
    const { result } = renderHook(() => useAsyncResource(fetcher, { initialData: '' }));

    await act(() => result.current.reload());
    expect(result.current.data).toBe('newer');

    await act(async () => { first.reject(new Error('stale failure')); await first.promise.catch(() => {}); });
    expect(result.current.error).toBeNull();
    expect(result.current.loading).toBe(false);
  });

  it('keeps `reload` stable and loads again when the fetcher changes', async () => {
    const a = vi.fn().mockResolvedValue('a');
    const b = vi.fn().mockResolvedValue('b');
    const { result, rerender } = renderHook(
      ({ fetcher }) => useAsyncResource(fetcher, { initialData: '' }),
      { initialProps: { fetcher: a } },
    );
    await waitFor(() => expect(result.current.data).toBe('a'));
    const reload = result.current.reload;

    rerender({ fetcher: a });
    expect(result.current.reload).toBe(reload);
    expect(a).toHaveBeenCalledTimes(1);

    rerender({ fetcher: b });
    await waitFor(() => expect(result.current.data).toBe('b'));
  });

  it('while disabled, makes no request, stays loading and settles `reload`; enabling loads', async () => {
    const fetcher = vi.fn().mockResolvedValue('v');
    const { result, rerender } = renderHook(
      ({ enabled }) => useAsyncResource(fetcher, { initialData: '', enabled }),
      { initialProps: { enabled: false } },
    );
    await act(async () => { await result.current.reload(); });
    expect(fetcher).not.toHaveBeenCalled();
    expect(result.current.loading).toBe(true);
    expect(result.current.data).toBe('');

    rerender({ enabled: true });
    await waitFor(() => expect(result.current.data).toBe('v'));
    expect(result.current.loading).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('disabling drops the previous scope\'s data back to the initial data', async () => {
    const fetcher = vi.fn().mockResolvedValue(['row of scope A']);
    const { result, rerender } = renderHook(
      ({ enabled }) => useAsyncResource(fetcher, { initialData: [] as string[], enabled }),
      { initialProps: { enabled: true } },
    );
    await waitFor(() => expect(result.current.data).toEqual(['row of scope A']));

    rerender({ enabled: false });
    expect(result.current.data).toEqual([]);
    expect(result.current.loading).toBe(true);
  });

  it('disabling drops a load still in flight', async () => {
    const pending = deferred<string>();
    const fetcher = vi.fn().mockReturnValue(pending.promise);
    const { result, rerender } = renderHook(
      ({ enabled }) => useAsyncResource(fetcher, { initialData: '', enabled }),
      { initialProps: { enabled: true } },
    );
    expect(fetcher).toHaveBeenCalledTimes(1);

    rerender({ enabled: false });
    await act(async () => { pending.resolve('stale'); await pending.promise; });
    expect(result.current.data).toBe('');
    expect(result.current.loading).toBe(true);
  });
});
