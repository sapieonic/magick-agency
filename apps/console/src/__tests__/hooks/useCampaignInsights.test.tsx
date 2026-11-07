import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook, cleanup } from '@testing-library/react';
import { activity, allocation, health, readiness, summary, trends, uploads } from '../helpers/insights';
import type { InsightsResolvedRange } from '../../utils/agency/insights/range';

/**
 * The campaign's insights reads and their refresh rules (shared by the Overview,
 * Calls, Agents, Callbacks and Health tabs, IN13), with fake timers:
 *
 *  - `summary` and `allocation` poll every 10 s while running or stopping, or
 *    paused with calls still finishing; never on a draft or a final state.
 *  - the range reads never poll: they load once active, and again only on a
 *    range change or a refresh token.
 */

const api = vi.hoisted(() => ({
  getInsightsSummary: vi.fn(),
  getInsightsAllocation: vi.fn(),
  getInsightsReadiness: vi.fn(),
  getInsightsUploads: vi.fn(),
  getInsightsActivity: vi.fn(),
  getInsightsTrends: vi.fn(),
  getInsightsHealth: vi.fn(),
}));
vi.mock('../../api/agencyInsights', () => api);
vi.mock('../../contexts/TenantContext', () => ({
  useTenant: () => ({ tenantId: 'tenant-1', accountId: 'account-1', role: 'tenant_owner' }),
}));

import { useInsightsLive, useInsightsRange } from '../../hooks/useCampaignInsights';

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function tick(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  api.getInsightsAllocation.mockResolvedValue(allocation());
  api.getInsightsReadiness.mockResolvedValue(readiness());
  api.getInsightsUploads.mockResolvedValue(uploads());
  api.getInsightsActivity.mockResolvedValue(activity());
  api.getInsightsTrends.mockResolvedValue(trends());
  api.getInsightsHealth.mockResolvedValue(health());
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('useInsightsLive — what polls', () => {
  it.each(['running', 'stopping'] as const)('polls summary and allocation every 10 s while %s', async (status) => {
    api.getInsightsSummary.mockResolvedValue(summary(status));
    const { result } = renderHook(() => useInsightsLive('camp-1'));
    await flush();
    expect(result.current.polling).toBe(true);
    expect(api.getInsightsSummary).toHaveBeenCalledTimes(1);
    expect(api.getInsightsAllocation).toHaveBeenCalledTimes(1);

    await tick(10_000);
    expect(api.getInsightsSummary).toHaveBeenCalledTimes(2);
    expect(api.getInsightsAllocation).toHaveBeenCalledTimes(2);
    // The upload history is the Settings tab's own read (IN13), never this hook's.
    expect(api.getInsightsUploads).not.toHaveBeenCalled();
  });

  it('reads once and does not poll on a tab that asks it not to, and catches up on returning to one that does', async () => {
    api.getInsightsSummary.mockResolvedValue(summary('running'));
    const { result, rerender } = renderHook(({ poll }) => useInsightsLive('camp-1', poll), { initialProps: { poll: false } });
    await flush();
    expect(result.current.polling).toBe(false);
    expect(api.getInsightsSummary).toHaveBeenCalledTimes(1);
    await tick(30_000);
    expect(api.getInsightsSummary).toHaveBeenCalledTimes(1);
    expect(api.getInsightsAllocation).toHaveBeenCalledTimes(1);

    // Back on a polling tab: read at once, then every 10 s.
    rerender({ poll: true });
    await flush();
    expect(api.getInsightsSummary).toHaveBeenCalledTimes(2);
    expect(result.current.polling).toBe(true);
    await tick(10_000);
    expect(api.getInsightsSummary).toHaveBeenCalledTimes(3);
  });

  it('polls a paused campaign while calls finish, and stops once they have', async () => {
    api.getInsightsSummary.mockResolvedValue(summary('paused'));
    const { result } = renderHook(() => useInsightsLive('camp-1'));
    await flush();
    expect(result.current.polling).toBe(true);

    const drained = summary('paused');
    drained.headline.paused = { ...drained.headline.paused!, calls_finishing: 0 };
    api.getInsightsSummary.mockResolvedValue(drained);
    await tick(10_000);
    expect(api.getInsightsSummary).toHaveBeenCalledTimes(2);
    expect(result.current.polling).toBe(false);

    await tick(30_000);
    expect(api.getInsightsSummary).toHaveBeenCalledTimes(2);
  });

  it.each(['draft', 'stopped', 'completed'] as const)('never polls a %s campaign', async (status) => {
    api.getInsightsSummary.mockResolvedValue(summary(status));
    const { result } = renderHook(() => useInsightsLive('camp-1'));
    await flush();
    expect(result.current.polling).toBe(false);
    await tick(60_000);
    expect(api.getInsightsSummary).toHaveBeenCalledTimes(1);
    expect(api.getInsightsAllocation).toHaveBeenCalledTimes(1);
  });

  it('reads the launch checklist for a draft only', async () => {
    api.getInsightsSummary.mockResolvedValue(summary('draft'));
    renderHook(() => useInsightsLive('camp-1'));
    await flush();
    expect(api.getInsightsReadiness).toHaveBeenCalledTimes(1);

    cleanup();
    vi.clearAllMocks();
    api.getInsightsSummary.mockResolvedValue(summary('running'));
    renderHook(() => useInsightsLive('camp-1'));
    await flush();
    expect(api.getInsightsReadiness).not.toHaveBeenCalled();
  });

  it('skips a tick while the tab is hidden', async () => {
    api.getInsightsSummary.mockResolvedValue(summary('running'));
    renderHook(() => useInsightsLive('camp-1'));
    await flush();
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    await tick(30_000);
    expect(api.getInsightsSummary).toHaveBeenCalledTimes(1);
  });

  it('stamps the time of the last summary, and refresh re-reads every as-of-now section', async () => {
    vi.setSystemTime(new Date('2026-11-04T10:12:08.000Z'));
    api.getInsightsSummary.mockResolvedValue(summary('stopped'));
    const { result } = renderHook(() => useInsightsLive('camp-1'));
    await flush();
    expect(result.current.lastUpdatedAt?.toISOString()).toBe('2026-11-04T10:12:08.000Z');

    vi.setSystemTime(new Date('2026-11-04T10:20:00.000Z'));
    await act(async () => {
      await result.current.refresh();
    });
    expect(api.getInsightsSummary).toHaveBeenCalledTimes(2);
    expect(api.getInsightsAllocation).toHaveBeenCalledTimes(2);
    expect(result.current.lastUpdatedAt?.toISOString()).toBe('2026-11-04T10:20:00.000Z');
  });
});

describe('useInsightsRange — never polled', () => {
  const lifetime: InsightsResolvedRange = {
    choice: { preset: 'lifetime' },
    lifetime: true,
    label: 'Lifetime',
    timezone: 'Asia/Kolkata',
    zoneFallback: false,
    error: null,
  };
  const today: InsightsResolvedRange = {
    ...lifetime,
    choice: { preset: 'today' },
    lifetime: false,
    label: 'Today',
    from: '2026-11-03T18:30:00.000Z',
    to: '2026-11-04T01:00:00.000Z',
  };

  it('waits until active, then reads each section once and never again on its own', async () => {
    const { rerender } = renderHook(
      ({ active }) => useInsightsRange('camp-1', lifetime, 'day', active, 0),
      { initialProps: { active: false } },
    );
    await flush();
    expect(api.getInsightsActivity).not.toHaveBeenCalled();

    rerender({ active: true });
    await flush();
    expect(api.getInsightsActivity).toHaveBeenCalledTimes(1);
    expect(api.getInsightsActivity).toHaveBeenCalledWith('camp-1', {}, 'tenant-1', 'account-1');
    expect(api.getInsightsTrends).toHaveBeenCalledWith('camp-1', {}, 'day', 'tenant-1', 'account-1');
    expect(api.getInsightsHealth).toHaveBeenCalledTimes(1);

    await tick(120_000);
    expect(api.getInsightsActivity).toHaveBeenCalledTimes(1);
    expect(api.getInsightsTrends).toHaveBeenCalledTimes(1);
  });

  it('reloads on a range change, a bucket change (trends only) and a refresh token', async () => {
    const { rerender } = renderHook(
      ({ range, bucket, token }) => useInsightsRange('camp-1', range, bucket, true, token),
      { initialProps: { range: lifetime, bucket: 'day' as const as 'day' | 'hour', token: 0 } },
    );
    await flush();

    rerender({ range: today, bucket: 'day', token: 0 });
    await flush();
    expect(api.getInsightsActivity).toHaveBeenLastCalledWith(
      'camp-1',
      { from: '2026-11-03T18:30:00.000Z', to: '2026-11-04T01:00:00.000Z' },
      'tenant-1',
      'account-1',
    );
    expect(api.getInsightsActivity).toHaveBeenCalledTimes(2);

    // A new object with the same instants is not a new range.
    rerender({ range: { ...today }, bucket: 'day', token: 0 });
    await flush();
    expect(api.getInsightsActivity).toHaveBeenCalledTimes(2);

    rerender({ range: today, bucket: 'hour', token: 0 });
    await flush();
    expect(api.getInsightsTrends).toHaveBeenCalledTimes(3);
    expect(api.getInsightsActivity).toHaveBeenCalledTimes(2);

    rerender({ range: today, bucket: 'hour', token: 1 });
    await flush();
    expect(api.getInsightsActivity).toHaveBeenCalledTimes(3);
    expect(api.getInsightsHealth).toHaveBeenCalledTimes(3);
  });

  it('fetches nothing for a range that cannot be sent', async () => {
    renderHook(() => useInsightsRange('camp-1', { ...today, error: 'The start date is after the end date.' }, 'day', true, 0));
    await flush();
    expect(api.getInsightsActivity).not.toHaveBeenCalled();
  });
});
