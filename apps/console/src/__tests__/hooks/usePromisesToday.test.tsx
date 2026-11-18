import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { ApiError } from '../../api/client';

/**
 * Today's promises (`usePromisesToday`, B28b): Today so far's window and minute, and a failed
 * refresh that keeps today's figures but never yesterday's. The suite runs in UTC.
 */

const api = vi.hoisted(() => ({ getAgencyPromisesSummary: vi.fn() }));
vi.mock('../../api/agencyFloor', () => api);

import { usePromisesToday } from '../../hooks/usePromisesToday';
import { HOME_SLOW_MS } from '../../hooks/useHomeBoard';

const summary = (promises: number) => ({
  campaigns: [{ campaign_id: 'c1', promises, with_amount: 0, amount_total: '0.00' }],
  promise_campaign_ids: ['c1'],
  from: '',
  to: '',
});

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
  api.getAgencyPromisesSummary.mockResolvedValue(summary(4));
});
afterEach(() => vi.useRealTimers());

describe('usePromisesToday', () => {
  it('reads from local midnight to now, then once a minute', async () => {
    const { result } = renderHook(() => usePromisesToday('t-1', 'a-1', true));
    await flush();
    expect(api.getAgencyPromisesSummary).toHaveBeenCalledWith(
      { from: '2026-11-18T00:00:00.000Z', to: '2026-11-18T10:00:00.000Z' }, 't-1', 'a-1',
    );
    expect(result.current).toMatchObject({ status: 'ready', day: '2026-11-18' });
    await flush(HOME_SLOW_MS);
    expect(api.getAgencyPromisesSummary).toHaveBeenCalledTimes(2);
  });

  it('keeps today’s figures through a failed refresh, but shows none once the day has turned', async () => {
    const { result } = renderHook(() => usePromisesToday('t-1', 'a-1', true));
    await flush();
    api.getAgencyPromisesSummary.mockRejectedValue(new Error('network'));
    await flush(HOME_SLOW_MS);
    expect(result.current.status).toBe('ready');
    vi.setSystemTime(new Date('2026-11-19T00:00:30Z'));
    await flush(HOME_SLOW_MS);
    expect(result.current.status).toBe('unavailable');
  });

  it('stops asking after a 403, the tile then staying Successes', async () => {
    api.getAgencyPromisesSummary.mockRejectedValue(new ApiError(403, { error: 'Forbidden' }));
    const { result } = renderHook(() => usePromisesToday('t-1', 'a-1', true));
    await flush();
    expect(result.current.status).toBe('unavailable');
    await flush(HOME_SLOW_MS * 3);
    expect(api.getAgencyPromisesSummary).toHaveBeenCalledTimes(1);
  });

  it('asks again after a 403 on Retry, and for a new role', async () => {
    api.getAgencyPromisesSummary.mockRejectedValue(new ApiError(403, { error: 'Forbidden' }));
    const { result, rerender } = renderHook(({ role }) => usePromisesToday('t-1', 'a-1', true, role), {
      initialProps: { role: 'account_admin' },
    });
    await flush();
    expect(result.current.status).toBe('unavailable');
    act(() => result.current.reload());
    await flush();
    expect(api.getAgencyPromisesSummary).toHaveBeenCalledTimes(2);
    rerender({ role: 'tenant_admin' });
    await flush();
    expect(api.getAgencyPromisesSummary).toHaveBeenCalledTimes(3);
    await flush(HOME_SLOW_MS * 2);
    expect(api.getAgencyPromisesSummary).toHaveBeenCalledTimes(3);
  });
});
