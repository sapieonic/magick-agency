import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { ApiError } from '../../api/client';
import { usePolledRead } from '../../hooks/usePolledRead';

/**
 * The polling core under Live floor's floor and the "today" reads (`usePolledRead`): the in-flight
 * slot belongs to its own read when `reload` overtakes one, the turn-of-day read only when asked,
 * and a failure after a refusal with nothing kept. The suite runs in UTC.
 */

const PERIOD = 5_000;

async function flush(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-18T10:00:00Z'));
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
});
afterEach(() => vi.useRealTimers());

describe('usePolledRead', () => {
  it('keeps the overtaking read’s slot when the read it overtook answers', async () => {
    const answers: Array<(v: string) => void> = [];
    const read = vi.fn(() => new Promise<string>((resolve) => { answers.push(resolve); }));
    const { result } = renderHook(() => usePolledRead({ tenantId: 't-1', accountId: 'a-1', enabled: true, read, periodMs: PERIOD }));
    act(() => result.current.reload());
    expect(read).toHaveBeenCalledTimes(2);
    // The overtaken read answers: it neither lands nor frees the slot, so the tick asks nothing.
    await act(async () => answers[0]!('old'));
    expect(result.current.state).toEqual({ status: 'loading' });
    await flush(PERIOD * 2);
    expect(read).toHaveBeenCalledTimes(2);
    await act(async () => answers[1]!('new'));
    expect(result.current.state).toEqual({ status: 'ready', value: 'new', day: '2026-11-18', stale: false });
  });

  it('reads at local midnight only with `turnOfDay`', async () => {
    vi.setSystemTime(new Date('2026-11-18T23:59:58Z'));
    const plain = vi.fn().mockResolvedValue('x');
    const daily = vi.fn().mockResolvedValue('x');
    renderHook(() => usePolledRead({ tenantId: 't-1', accountId: 'a-1', enabled: true, read: plain, periodMs: 60_000 }));
    renderHook(() => usePolledRead({ tenantId: 't-1', accountId: 'a-1', enabled: true, read: daily, periodMs: 60_000, turnOfDay: true }));
    await flush(3_000);
    expect(plain).toHaveBeenCalledTimes(1);
    expect(daily).toHaveBeenCalledTimes(2);
  });

  it('is an error when a read after a refusal’s Retry fails with nothing kept', async () => {
    const read = vi.fn()
      .mockResolvedValueOnce('first')
      .mockRejectedValueOnce(new ApiError(403, { error: 'Forbidden' }))
      .mockRejectedValue(new Error('network'));
    const { result } = renderHook(() => usePolledRead({ tenantId: 't-1', accountId: 'a-1', enabled: true, read, periodMs: PERIOD, stopOnRefusal: true }));
    await flush();
    expect(result.current.state).toMatchObject({ status: 'ready', value: 'first' });
    await flush(PERIOD);
    expect(result.current.state).toEqual({ status: 'refused' });
    act(() => result.current.reload());
    await flush();
    expect(result.current.state).toEqual({ status: 'error' });
  });
});
