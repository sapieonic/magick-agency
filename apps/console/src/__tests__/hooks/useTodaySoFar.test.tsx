import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';

/**
 * Today so far's read (`useTodaySoFar`, B28a): one account-wide grouped read at a time, a return to
 * the tab that reads only when the totals are old, and a failed refresh that never leaves
 * yesterday's totals under "Today so far". The suite runs in UTC, so the local day is UTC's.
 */

const api = vi.hoisted(() => ({ getAgencyGroupedStats: vi.fn() }));
vi.mock('../../api/agencyStats', () => api);

import { useTodaySoFar } from '../../hooks/useTodaySoFar';
import { HOME_SLOW_MS } from '../../hooks/useHomeBoard';

const page = (attempts: number) => ({
  rows: [{ attempts, connected: 1, successes: 0, talk_seconds: 60 }],
  total_groups: 1,
});

async function flush(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

/** A tab switch back: the browser fires both. */
async function comeBack() {
  await act(async () => {
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('focus'));
    await vi.advanceTimersByTimeAsync(0);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-12T10:00:00Z'));
  api.getAgencyGroupedStats.mockResolvedValue(page(5));
});
afterEach(() => vi.useRealTimers());

describe('a return to the tab', () => {
  it('reads nothing while the totals are fresh, and once (not per event) when they are old', async () => {
    renderHook(() => useTodaySoFar('t-1', 'a-1', true));
    await flush();
    expect(api.getAgencyGroupedStats).toHaveBeenCalledTimes(1);

    await comeBack();
    expect(api.getAgencyGroupedStats).toHaveBeenCalledTimes(1);

    // Hidden past the slow tick (which skips while hidden), then back: one read for both events.
    vi.setSystemTime(new Date(Date.now() + HOME_SLOW_MS + 1));
    await comeBack();
    expect(api.getAgencyGroupedStats).toHaveBeenCalledTimes(2);
  });

  it('asks nothing while a read is still on its way', async () => {
    let answer: (value: ReturnType<typeof page>) => void = () => {};
    api.getAgencyGroupedStats.mockReturnValue(new Promise((resolve) => { answer = resolve; }));
    const { result } = renderHook(() => useTodaySoFar('t-1', 'a-1', true));
    await comeBack();
    await comeBack();
    expect(api.getAgencyGroupedStats).toHaveBeenCalledTimes(1);
    await act(async () => {
      answer(page(7));
    });
    expect(result.current).toMatchObject({ status: 'ready', totals: { dials: 7 } });
  });
});

describe('a failed refresh', () => {
  it('keeps today’s totals the same day', async () => {
    const { result } = renderHook(() => useTodaySoFar('t-1', 'a-1', true));
    await flush();
    expect(result.current).toMatchObject({ status: 'ready', totals: { dials: 5 }, day: '2026-11-12' });
    api.getAgencyGroupedStats.mockRejectedValue(new Error('down'));
    await flush(HOME_SLOW_MS);
    expect(result.current).toMatchObject({ status: 'ready', totals: { dials: 5 } });
  });

  it('shows nothing once the day has turned, never yesterday’s totals as today’s', async () => {
    vi.setSystemTime(new Date('2026-11-12T23:59:00Z'));
    const { result } = renderHook(() => useTodaySoFar('t-1', 'a-1', true));
    await flush();
    expect(result.current).toMatchObject({ status: 'ready', day: '2026-11-12' });
    api.getAgencyGroupedStats.mockRejectedValue(new Error('down'));
    await flush(HOME_SLOW_MS);
    expect(result.current).toEqual({ status: 'unavailable' });
  });
});
