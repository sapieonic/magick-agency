import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { ApiError } from '../../api/client';

/**
 * Live floor's floor read (`useAgentFloor`, B28b): every 5 s while visible, from the viewer's
 * local midnight, one read at a time, the last floor kept (and said to be stale) through failed
 * reads, and no more asking after a 403 until Retry. The suite runs in UTC.
 */

const api = vi.hoisted(() => ({ getAgencyFloor: vi.fn() }));
vi.mock('../../api/agencyFloor', () => api);

import { FLOOR_POLL_MS, useAgentFloor } from '../../hooks/useAgentFloor';

const floor = (onShift: number) => ({ agents: [], totals: { on_shift: onShift, assigned: onShift + 1 }, as_of: new Date().toISOString() });

async function flush(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-18T10:00:00Z'));
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  api.getAgencyFloor.mockResolvedValue(floor(3));
});
afterEach(() => vi.useRealTimers());

describe('useAgentFloor', () => {
  it('reads at once from local midnight, then every 5 s', async () => {
    const { result } = renderHook(() => useAgentFloor('t-1', 'a-1', true));
    await flush();
    expect(api.getAgencyFloor).toHaveBeenCalledTimes(1);
    expect(api.getAgencyFloor).toHaveBeenCalledWith({ from: '2026-11-18T00:00:00.000Z' }, 't-1', 'a-1');
    expect(result.current).toMatchObject({ status: 'ready', stale: false, floor: { totals: { on_shift: 3 } } });
    await flush(FLOOR_POLL_MS * 3);
    expect(api.getAgencyFloor).toHaveBeenCalledTimes(4);
  });

  it('asks nothing while a read is still on its way', async () => {
    let answer: (v: unknown) => void = () => {};
    api.getAgencyFloor.mockImplementation(() => new Promise((resolve) => { answer = resolve; }));
    renderHook(() => useAgentFloor('t-1', 'a-1', true));
    await flush(FLOOR_POLL_MS * 3);
    expect(api.getAgencyFloor).toHaveBeenCalledTimes(1);
    answer(floor(1));
    await flush(FLOOR_POLL_MS);
    expect(api.getAgencyFloor).toHaveBeenCalledTimes(2);
  });

  it('keeps the last floor through failed reads, and says it is stale after two periods', async () => {
    const { result } = renderHook(() => useAgentFloor('t-1', 'a-1', true));
    await flush();
    api.getAgencyFloor.mockRejectedValue(new Error('network'));
    await flush(FLOOR_POLL_MS * 2);
    expect(result.current).toMatchObject({ status: 'ready', stale: false, floor: { totals: { on_shift: 3 } } });
    await flush(FLOOR_POLL_MS);
    expect(result.current).toMatchObject({ status: 'ready', stale: true, floor: { totals: { on_shift: 3 } } });
    api.getAgencyFloor.mockResolvedValue(floor(5));
    await flush(FLOOR_POLL_MS);
    expect(result.current).toMatchObject({ stale: false, floor: { totals: { on_shift: 5 } } });
  });

  it('is an error when it never answered', async () => {
    api.getAgencyFloor.mockRejectedValue(new Error('network'));
    const { result } = renderHook(() => useAgentFloor('t-1', 'a-1', true));
    await flush();
    expect(result.current).toMatchObject({ status: 'error', floor: null });
  });

  it('stops asking after a 403, until Retry', async () => {
    api.getAgencyFloor.mockRejectedValue(new ApiError(403, { error: 'Forbidden' }));
    const { result } = renderHook(() => useAgentFloor('t-1', 'a-1', true));
    await flush();
    expect(result.current.status).toBe('refused');
    await flush(FLOOR_POLL_MS * 4);
    expect(api.getAgencyFloor).toHaveBeenCalledTimes(1);
    api.getAgencyFloor.mockResolvedValue(floor(2));
    act(() => result.current.reload());
    await flush();
    expect(result.current).toMatchObject({ status: 'ready', floor: { totals: { on_shift: 2 } } });
  });

  it('reads nothing when not enabled (below Live floor’s gate)', async () => {
    renderHook(() => useAgentFloor('t-1', 'a-1', false));
    await flush(FLOOR_POLL_MS * 2);
    expect(api.getAgencyFloor).not.toHaveBeenCalled();
  });

  it('skips a tick while the tab is hidden', async () => {
    renderHook(() => useAgentFloor('t-1', 'a-1', true));
    await flush();
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    await flush(FLOOR_POLL_MS * 3);
    expect(api.getAgencyFloor).toHaveBeenCalledTimes(1);
  });

  it('on a new scope reads at once, never lands the old scope’s answer, and keeps one read in flight', async () => {
    const answers: Array<(v: unknown) => void> = [];
    api.getAgencyFloor.mockImplementation(() => new Promise((resolve) => { answers.push(resolve); }));
    const { result, rerender } = renderHook(({ account }) => useAgentFloor('t-1', account, true), { initialProps: { account: 'a-1' } });
    await flush();
    rerender({ account: 'a-2' });
    await flush();
    expect(api.getAgencyFloor).toHaveBeenCalledTimes(2);
    expect(api.getAgencyFloor.mock.calls[1]![2]).toBe('a-2');
    // The old account's read answers late: it neither lands nor frees the new read's slot.
    answers[0]!(floor(99));
    await flush();
    expect(result.current).toMatchObject({ status: 'loading', floor: null });
    await flush(FLOOR_POLL_MS * 2);
    expect(api.getAgencyFloor).toHaveBeenCalledTimes(2);
    answers[1]!(floor(4));
    await flush();
    expect(result.current).toMatchObject({ status: 'ready', floor: { totals: { on_shift: 4 } } });
  });

  it('reads on a return to the tab only when the floor is older than a period', async () => {
    renderHook(() => useAgentFloor('t-1', 'a-1', true));
    await flush();
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      document.dispatchEvent(new Event('visibilitychange'));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(api.getAgencyFloor).toHaveBeenCalledTimes(1);
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    await flush(FLOOR_POLL_MS * 2);
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      document.dispatchEvent(new Event('visibilitychange'));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(api.getAgencyFloor).toHaveBeenCalledTimes(2);
  });
});
