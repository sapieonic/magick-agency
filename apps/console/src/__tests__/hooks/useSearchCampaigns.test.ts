import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

/**
 * Search's campaign list read (`readAllCampaigns`): the first page says how many there are, the
 * rest are read a few at a time rather than one after another, and only ids and names are kept.
 */

const mocks = vi.hoisted(() => ({ listAgencyCampaignsPage: vi.fn() }));
vi.mock('../../api/agencyCampaigns', () => ({ listAgencyCampaignsPage: mocks.listAgencyCampaignsPage }));

import { readAllCampaigns, resetSearchCampaignsCache, useSearchCampaigns } from '../../hooks/useSearchCampaigns';

/** An account of `total` campaigns, `c-0` newest; each read waits a tick and counts how many overlap. */
function account(total: number, emptyFrom = Infinity) {
  let inFlight = 0;
  const stats = { maxInFlight: 0 };
  mocks.listAgencyCampaignsPage.mockImplementation(async (_t: string | undefined, _a: string, offset: number, limit: number) => {
    inFlight += 1;
    stats.maxInFlight = Math.max(stats.maxInFlight, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 0));
    inFlight -= 1;
    const end = Math.min(offset + limit, total, emptyFrom);
    const campaigns = Array.from({ length: Math.max(end - offset, 0) }, (_, i) => ({
      id: `c-${offset + i}`,
      name: `Campaign ${offset + i}`,
      status: 'running',
    }));
    return { campaigns, total };
  });
  return stats;
}

const offsets = () => mocks.listAgencyCampaignsPage.mock.calls.map((call) => call[2] as number).sort((a, b) => a - b);

beforeEach(() => {
  vi.clearAllMocks();
  resetSearchCampaignsCache();
});

describe('readAllCampaigns', () => {
  it('reads every page, in order, keeping only ids and names', async () => {
    account(250);
    const campaigns = await readAllCampaigns('tenant-1', 'account-1');
    expect(offsets()).toEqual([0, 100, 200]);
    expect(mocks.listAgencyCampaignsPage).toHaveBeenCalledWith('tenant-1', 'account-1', 0, 100);
    expect(campaigns).toHaveLength(250);
    expect(campaigns.map((c) => c.id)).toEqual(Array.from({ length: 250 }, (_, i) => `c-${i}`));
    expect(campaigns[0]).toEqual({ id: 'c-0', name: 'Campaign 0' });
  });

  it('reads the pages after the first a few at a time', async () => {
    const stats = account(1_000);
    expect(await readAllCampaigns(null, 'account-1')).toHaveLength(1_000);
    expect(offsets()).toHaveLength(10);
    expect(stats.maxInFlight).toBeGreaterThan(1);
    expect(stats.maxInFlight).toBeLessThanOrEqual(4);
    expect(mocks.listAgencyCampaignsPage.mock.calls[0]![0]).toBeUndefined();
  });

  it('reads one page when it holds everything, and none past an empty one', async () => {
    account(40);
    expect(await readAllCampaigns('tenant-1', 'account-1')).toHaveLength(40);
    expect(offsets()).toEqual([0]);

    vi.clearAllMocks();
    // A server that says 900 but stops at 150.
    account(900, 150);
    expect(await readAllCampaigns('tenant-1', 'account-1')).toHaveLength(150);
    expect(offsets().length).toBeLessThan(9);
  });

  it('stops at 5,000 campaigns however many the server says', async () => {
    account(1_000_000);
    expect(await readAllCampaigns('tenant-1', 'account-1')).toHaveLength(5_000);
    expect(offsets()).toHaveLength(50);
  });

  it('stops every worker at the first page that fails, and fails the read', async () => {
    account(2_000);
    const read = mocks.listAgencyCampaignsPage.getMockImplementation() as (
      t: string | undefined, a: string, offset: number, limit: number,
    ) => Promise<unknown>;
    mocks.listAgencyCampaignsPage.mockImplementation(async (t: string | undefined, a: string, offset: number, limit: number) => {
      if (offset === 100) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        throw new Error('boom');
      }
      return read(t, a, offset, limit);
    });
    await expect(readAllCampaigns('tenant-1', 'account-1')).rejects.toThrow('boom');
    // Let any worker still looping run on: none starts another page.
    await new Promise((resolve) => setTimeout(resolve, 20));
    // The first page, then the four started together; nothing after the failure.
    expect(offsets()).toEqual([0, 100, 200, 300, 400]);
  });

  it('keeps each campaign once when the pages shift under it (one created mid-read)', async () => {
    let created = false;
    mocks.listAgencyCampaignsPage.mockImplementation(async (_t: string | undefined, _a: string, offset: number, limit: number) => {
      // Once the first page is read a campaign is created: every later row moves down one.
      const shift = created ? 1 : 0;
      created = true;
      const total = 250 + shift;
      const ids = Array.from({ length: Math.max(Math.min(offset + limit, total) - offset, 0) }, (_, i) => offset + i - shift);
      return { campaigns: ids.map((n) => ({ id: n < 0 ? 'c-new' : `c-${n}`, name: `Campaign ${n}`, status: 'running' })), total: 250 };
    });
    const campaigns = await readAllCampaigns('tenant-1', 'account-1');
    const ids = campaigns.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.slice(0, 101)).toEqual(Array.from({ length: 101 }, (_, i) => `c-${i}`));
  });
});

describe('useSearchCampaigns', () => {
  it('keeps only the current account’s list: going back to an account reads it again', async () => {
    account(3);
    const { result, rerender } = renderHook(({ accountId }) => useSearchCampaigns(true, 'tenant-1', accountId), {
      initialProps: { accountId: 'account-1' },
    });
    await waitFor(() => expect(result.current.status).toBe('ready'));
    rerender({ accountId: 'account-2' });
    await waitFor(() => expect(mocks.listAgencyCampaignsPage).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    rerender({ accountId: 'account-1' });
    // account-1's list was dropped when account-2 opened, so it is not shown at once.
    expect(result.current.status).toBe('loading');
    await waitFor(() => expect(mocks.listAgencyCampaignsPage).toHaveBeenCalledTimes(3));
  });
});
