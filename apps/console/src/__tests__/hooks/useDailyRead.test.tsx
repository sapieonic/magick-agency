import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { ApiError } from '../../api/client';
import { useDailyRead } from '../../hooks/useDailyRead';
import { HOME_SLOW_MS } from '../../hooks/useHomeBoard';

/**
 * The shared polled "today" read (`useDailyRead`) behind Today so far and the promises: an answer
 * lands only for the scope that asked and only while its read is the latest, and a 403 stops the
 * asking only when the reader asks for that. The suite runs in UTC.
 */

async function flush(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-18T10:00:00Z'));
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
});
afterEach(() => vi.useRealTimers());

describe('useDailyRead', () => {
  it('never lands an older scope’s answer, nor lets it free the newer read’s slot', async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    const read = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise).mockResolvedValue('later');
    const { result, rerender } = renderHook(({ account }) => useDailyRead({ tenantId: 't-1', accountId: account, enabled: true, read }), {
      initialProps: { account: 'a-1' },
    });
    rerender({ account: 'a-2' });
    expect(read).toHaveBeenCalledTimes(2);
    await act(async () => first.resolve('a-1 figures'));
    expect(result.current.state).toEqual({ status: 'loading' });
    // The new scope's read is still in flight: the tick asks nothing.
    await flush(HOME_SLOW_MS);
    expect(read).toHaveBeenCalledTimes(2);
    await act(async () => second.resolve('a-2 figures'));
    expect(result.current.state).toEqual({ status: 'ready', value: 'a-2 figures', day: '2026-11-18' });
  });

  it('treats a 403 as a failed read unless asked to stop on it', async () => {
    const refused = new ApiError(403, { error: 'Forbidden' });
    const read = vi.fn().mockRejectedValue(refused);
    const { result } = renderHook(() => useDailyRead({ tenantId: 't-1', accountId: 'a-1', enabled: true, read }));
    await flush();
    expect(result.current.state).toEqual({ status: 'unavailable' });
    await flush(HOME_SLOW_MS * 2);
    expect(read).toHaveBeenCalledTimes(3);

    const stopping = vi.fn().mockRejectedValue(refused);
    const stopped = renderHook(() => useDailyRead({ tenantId: 't-1', accountId: 'a-1', enabled: true, read: stopping, stopOnRefusal: true }));
    await flush(HOME_SLOW_MS * 2);
    expect(stopping).toHaveBeenCalledTimes(1);
    act(() => stopped.result.current.reload());
    await flush();
    expect(stopping).toHaveBeenCalledTimes(2);
  });

  it('shows nothing for an answer with nothing honest to print', async () => {
    const read = vi.fn().mockResolvedValue(null);
    const { result } = renderHook(() => useDailyRead({ tenantId: 't-1', accountId: 'a-1', enabled: true, read }));
    await flush();
    expect(result.current.state).toEqual({ status: 'unavailable' });
  });
});
