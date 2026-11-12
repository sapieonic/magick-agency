import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Search's campaign list read (`readAllCampaigns`): the first page says how many there are, the
 * rest are read a few at a time rather than one after another, and only ids and names are kept.
 */

const mocks = vi.hoisted(() => ({ listAgencyCampaignsPage: vi.fn() }));
vi.mock('../../api/agencyCampaigns', () => ({ listAgencyCampaignsPage: mocks.listAgencyCampaignsPage }));

import { readAllCampaigns } from '../../hooks/useSearchCampaigns';

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
});
