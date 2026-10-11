import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Reading the campaign list.
 *
 * `GET /campaigns` is paginated (at most 100 rows a request, newest first, with
 * the account's `total`). `listAgencyCampaigns` used to read the first page only,
 * so the analytics page listed the latest 50 campaigns and the per-agent tab
 * printed raw ids for older ones. Pinned here: it walks every page, stops when it
 * has them all, and cannot loop on a server that over-reports its total.
 */

const mocks = vi.hoisted(() => ({ apiFetch: vi.fn() }));

vi.mock('../../api/client', () => ({ apiFetch: mocks.apiFetch, ApiError: class extends Error {} }));

import { listAgencyCampaigns, listAgencyCampaignsPage } from '../../api/agencyCampaigns';

const TENANT = 'tenant-1';
const ACCOUNT = 'account-1';

function rows(from: number, count: number) {
  return Array.from({ length: count }, (_, i) => ({ id: `c-${from + i}`, name: `C${from + i}`, status: 'draft' }));
}

/** The offset each request asked for, read off the URL. */
function offsets(): number[] {
  return mocks.apiFetch.mock.calls.map((c) => Number(new URL(String(c[0]), 'http://x').searchParams.get('offset')));
}

beforeEach(() => vi.clearAllMocks());

describe('listAgencyCampaigns', () => {
  it('walks every page until it has the total', async () => {
    mocks.apiFetch.mockImplementation(async (url: string) => {
      const offset = Number(new URL(url, 'http://x').searchParams.get('offset'));
      return { campaigns: rows(offset, Math.min(100, 250 - offset)), total: 250 };
    });

    const all = await listAgencyCampaigns(TENANT, ACCOUNT);

    expect(all).toHaveLength(250);
    expect(all[249]!.id).toBe('c-249');
    expect(offsets()).toEqual([0, 100, 200]);
    // Every page carries the account, not only the first.
    for (const call of mocks.apiFetch.mock.calls) expect(call.slice(2)).toEqual([TENANT, ACCOUNT]);
  });

  it('makes one request when the first page is everything', async () => {
    mocks.apiFetch.mockResolvedValue({ campaigns: rows(0, 3), total: 3 });
    expect(await listAgencyCampaigns(TENANT, ACCOUNT)).toHaveLength(3);
    expect(mocks.apiFetch).toHaveBeenCalledTimes(1);
  });

  it('takes a bare array as the whole list', async () => {
    mocks.apiFetch.mockResolvedValue(rows(0, 4));
    expect(await listAgencyCampaigns(TENANT, ACCOUNT)).toHaveLength(4);
    expect(mocks.apiFetch).toHaveBeenCalledTimes(1);
  });

  it('stops on an empty page even if the total says there is more', async () => {
    mocks.apiFetch
      .mockResolvedValueOnce({ campaigns: rows(0, 100), total: 500 })
      .mockResolvedValueOnce({ campaigns: [], total: 500 });
    expect(await listAgencyCampaigns(TENANT, ACCOUNT)).toHaveLength(100);
    expect(mocks.apiFetch).toHaveBeenCalledTimes(2);
  });

  it('gives up after fifty pages rather than looping on a total it never reaches', async () => {
    let next = 0;
    mocks.apiFetch.mockImplementation(async () => {
      const page = { campaigns: rows(next, 100), total: 1_000_000 };
      next += 100;
      return page;
    });
    expect(await listAgencyCampaigns(TENANT, ACCOUNT)).toHaveLength(5000);
    expect(mocks.apiFetch).toHaveBeenCalledTimes(50);
  });
});

describe('listAgencyCampaignsPage', () => {
  it('asks for one page and returns the account total', async () => {
    mocks.apiFetch.mockResolvedValue({ campaigns: rows(100, 100), total: 340 });
    const page = await listAgencyCampaignsPage(TENANT, ACCOUNT, 100);
    expect(page.total).toBe(340);
    expect(String(mocks.apiFetch.mock.calls[0]![0])).toMatch(/\/campaigns\?limit=100&offset=100$/);
  });
});
