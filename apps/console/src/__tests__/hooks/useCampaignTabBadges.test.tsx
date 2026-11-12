import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';

/**
 * The campaign bar's badge counts (`useCampaignTabBadges`): Agents on shift is the server's
 * `agents_live`, and a read that answers late never replaces a count published while it was on
 * its way.
 */

const api = vi.hoisted(() => ({ getAgencyCampaignStats: vi.fn(), getInsightsAllocation: vi.fn() }));
vi.mock('../../api/agencyCampaigns', () => ({ getAgencyCampaignStats: api.getAgencyCampaignStats }));
vi.mock('../../api/agencyInsights', () => ({ getInsightsAllocation: api.getInsightsAllocation }));
vi.mock('../../contexts/TenantContext', () => ({ useTenant: () => ({ tenantId: 't1', accountId: 'acc-1' }) }));

import { publishCampaignTabBadge, resetCampaignTabBadges, useCampaignTabBadge } from '../../hooks/useCampaignTabBadges';

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  resetCampaignTabBadges();
});
afterEach(() => vi.useRealTimers());

describe('Agents on shift', () => {
  it('is the stats’ agents_live, the server’s on-shift count', async () => {
    api.getAgencyCampaignStats.mockResolvedValue({ agents_live: 4, agents: [] });
    const { result } = renderHook(() => useCampaignTabBadge('onShift', 'c-1', true));
    await act(async () => {});
    expect(result.current).toBe(4);
  });

  it('keeps a count published while a read was on its way, rather than the late answer', async () => {
    let answer: (value: { agents_live: number }) => void = () => {};
    api.getAgencyCampaignStats.mockReturnValue(new Promise((resolve) => { answer = resolve; }));
    const { result } = renderHook(() => useCampaignTabBadge('onShift', 'c-1', true));
    await act(async () => { vi.advanceTimersByTime(1_000); });
    act(() => publishCampaignTabBadge('onShift', 't1', 'acc-1', 'c-1', 6));
    expect(result.current).toBe(6);
    await act(async () => { answer({ agents_live: 2 }); });
    expect(result.current).toBe(6);
  });
});
