import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent, within, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

/**
 * The campaigns home, the page a supervisor lands on in `/agency`.
 *
 * Pinned here:
 *  - with no campaigns, the getting-started guide replaces the list, and only a
 *    role that can create is given the create action and the steps;
 *  - `/stats` is read for active campaigns only, never once per row, and one
 *    card's failed read stays on that card;
 *  - the cards refresh on the detail page's predicate (status, OR live attempts,
 *    OR anyone on the floor), so a paused campaign's drain is followed and a
 *    settled one is left alone; a failed refresh keeps the last good numbers; a
 *    hidden tab skips the tick; unmounting stops it;
 *  - the list is paginated server-side, so the header counts the account's real
 *    total and older campaigns load on request; active campaigns are read in
 *    full on their own, so an old paused one still gets its card, and the next
 *    page's offset counts only the paged history;
 *  - the filter tabs, the search box and the rail's permission gates.
 */

const mocks = vi.hoisted(() => ({
  useTenant: vi.fn(),
  listAgencyCampaignsPage: vi.fn(),
  listAgencyCampaigns: vi.fn(),
  getAgencyCampaign: vi.fn(),
  getAgencyCampaignStats: vi.fn(),
}));

vi.mock('../../contexts/TenantContext', () => ({ useTenant: mocks.useTenant }));
vi.mock('../../api/agencyCampaigns', () => ({
  listAgencyCampaignsPage: mocks.listAgencyCampaignsPage,
  listAgencyCampaigns: mocks.listAgencyCampaigns,
  getAgencyCampaign: mocks.getAgencyCampaign,
  getAgencyCampaignStats: mocks.getAgencyCampaignStats,
}));

import { AgencyCampaignsPage } from '../../pages/agency/AgencyCampaignsPage';
import type { AgencyCampaign, AgencyCampaignStats } from '../../types/agency-campaign';

function renderPage() {
  return render(
    <MemoryRouter>
      <AgencyCampaignsPage />
    </MemoryRouter>,
  );
}

function tenant(over: Record<string, unknown> = {}) {
  return {
    tenantId: 'tenant-1',
    accountId: 'account-1',
    role: 'account_admin',
    accounts: [{ id: 'account-1', name: 'Default', tenant_id: 'tenant-1' }],
    ...over,
  };
}

function stats(over: Partial<AgencyCampaignStats> = {}): AgencyCampaignStats {
  return {
    stall: null,
    attempts_live: 3,
    agents_live: 5,
    attempts_connected: 40,
    attempts_total: 120,
    contacts_pending: 60,
    contacts_total: 100,
    contacts_completed: 30,
    contacts_suppressed: 5,
    contacts_exhausted: 5,
    ...over,
    // The page reads only these fields; the rest of the payload is irrelevant here.
  } as AgencyCampaignStats;
}

/** The list endpoint's answer: one page and the account's total. */
function listing(campaigns: AgencyCampaign[], total = campaigns.length) {
  return { campaigns, total };
}

const RUNNING: AgencyCampaign = { id: 'c-live', name: 'Monsoon offers', status: 'running' };
const PAUSED: AgencyCampaign = { id: 'c-paused', name: 'Gold loan pilot', status: 'paused' };
const DRAFT: AgencyCampaign = {
  id: 'c-draft',
  name: 'Diwali leads',
  status: 'draft',
  calling_window_start: '09:00:00',
  calling_window_end: '18:00:00',
  calling_days: [1, 2, 3, 4, 5],
};
const DONE: AgencyCampaign = {
  id: 'c-done',
  name: 'Spring renewals',
  status: 'completed',
  ended_at: '2026-05-01T00:00:00Z',
};

function card(name: string): HTMLElement {
  return screen.getByRole('article', { name });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.useTenant.mockReturnValue(tenant());
  mocks.getAgencyCampaignStats.mockResolvedValue(stats());
  mocks.listAgencyCampaigns.mockResolvedValue([]);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
});

describe('AgencyCampaignsPage — no campaigns yet', () => {
  beforeEach(() => {
    mocks.listAgencyCampaignsPage.mockResolvedValue(listing([]));
  });

  it('shows the getting-started guide with the create action and the steps', async () => {
    renderPage();
    expect(await screen.findByRole('heading', { name: 'Launch your first campaign' })).toBeTruthy();
    const create = screen.getByRole('link', { name: /New campaign/ });
    expect(create.getAttribute('href')).toBe('/agency/campaigns/new');
    expect(screen.getByRole('heading', { name: 'Start dialing' })).toBeTruthy();
    expect(screen.getByText('Only one campaign can run at a time per account.')).toBeTruthy();
    expect(mocks.getAgencyCampaignStats).not.toHaveBeenCalled();
  });

  it('offers a viewer neither the create action nor steps they cannot follow', async () => {
    mocks.useTenant.mockReturnValue(tenant({ role: 'viewer' }));
    renderPage();
    expect(await screen.findByRole('heading', { name: 'No campaigns yet' })).toBeTruthy();
    expect(screen.queryByRole('link', { name: /New campaign/ })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Start dialing' })).toBeNull();
    expect(screen.getByText('Only one campaign can run at a time per account.')).toBeTruthy();
  });
});

describe('AgencyCampaignsPage — active campaigns', () => {
  beforeEach(() => {
    mocks.listAgencyCampaignsPage.mockResolvedValue(listing([DONE, DRAFT, RUNNING, PAUSED]));
  });

  it('reads /stats for active campaigns only and shows their numbers', async () => {
    mocks.getAgencyCampaignStats.mockImplementation(async (id: string) =>
      id === 'c-paused' ? stats({ attempts_live: 0, agents_live: 0 }) : stats(),
    );
    renderPage();

    await waitFor(() => expect(within(card('Monsoon offers')).getByText('5')).toBeTruthy());
    const live = card('Monsoon offers');
    expect(within(live).getByText('40%')).toBeTruthy();
    expect(within(live).getByText('Reached someone')).toBeTruthy();

    const ids = mocks.getAgencyCampaignStats.mock.calls.map((c) => c[0]).sort();
    expect(ids).toEqual(['c-live', 'c-paused']);
    expect(mocks.getAgencyCampaignStats).toHaveBeenCalledWith('c-live', 'tenant-1', 'account-1');
  });

  it('keeps one card’s failed read on that card, with its sibling’s numbers intact', async () => {
    mocks.getAgencyCampaignStats.mockImplementation(async (id: string) => {
      if (id === 'c-live') throw new Error('boom');
      return stats({ attempts_live: 0, agents_live: 7 });
    });
    renderPage();

    await waitFor(() =>
      expect(within(card('Monsoon offers')).getByText(/Live numbers didn’t load/)).toBeTruthy(),
    );
    await waitFor(() => expect(within(card('Gold loan pilot')).getByText('7')).toBeTruthy());
    expect(within(card('Gold loan pilot')).queryByText(/didn’t load/)).toBeNull();
    // The list is still there.
    expect(screen.getByRole('link', { name: /Diwali leads/ })).toBeTruthy();
  });

  it('shows the top diagnosis when the campaign is stalled', async () => {
    mocks.listAgencyCampaignsPage.mockResolvedValue(listing([RUNNING]));
    mocks.getAgencyCampaignStats.mockResolvedValue(
      stats({ stall: { code: 'concurrency_saturated', limit: 10, in_use: 10 } }),
    );
    renderPage();
    await waitFor(() =>
      expect(within(card('Monsoon offers')).getByText(/lines/i)).toBeTruthy(),
    );
  });
});

describe('AgencyCampaignsPage — refreshing the cards', () => {
  /** Wait for a card's numbers to be RENDERED: the poll predicate reads them. */
  async function settle(name: string, text: string) {
    await vi.waitFor(() => expect(within(card(name)).getByText(text)).toBeTruthy());
  }

  function statsCallsFor(id: string): number {
    return mocks.getAgencyCampaignStats.mock.calls.filter((c) => c[0] === id).length;
  }

  it('re-reads a running campaign and the list every ten seconds', async () => {
    vi.useFakeTimers();
    mocks.listAgencyCampaignsPage.mockResolvedValue(listing([RUNNING, DRAFT]));
    renderPage();
    await settle('Monsoon offers', '5');
    const lists = mocks.listAgencyCampaignsPage.mock.calls.length;

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });

    expect(statsCallsFor('c-live')).toBe(2);
    expect(mocks.listAgencyCampaignsPage.mock.calls.length).toBe(lists + 1);
  });

  it('follows a paused campaign while its calls drain, and leaves a settled one alone', async () => {
    vi.useFakeTimers();
    const draining: AgencyCampaign = { id: 'c-drain', name: 'Draining', status: 'paused' };
    mocks.listAgencyCampaignsPage.mockResolvedValue(listing([draining, PAUSED]));
    mocks.getAgencyCampaignStats.mockImplementation(async (id: string) =>
      id === 'c-drain'
        ? stats({ attempts_live: 2, agents_live: 9 })
        : stats({ attempts_live: 0, agents_live: 0, attempts_connected: 17 }),
    );
    renderPage();
    await settle('Draining', '9');
    await settle('Gold loan pilot', '17');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });

    expect(statsCallsFor('c-drain')).toBe(2);
    expect(statsCallsFor('c-paused')).toBe(1);
  });

  it('keeps following a drained paused campaign when a payload without the roster says agents are on it', async () => {
    vi.useFakeTimers();
    mocks.listAgencyCampaignsPage.mockResolvedValue(listing([PAUSED]));
    // `agents` is optional on the wire; `agents_live` is still the total.
    mocks.getAgencyCampaignStats.mockResolvedValue(stats({ attempts_live: 0, agents: undefined, agents_live: 2 }));
    renderPage();
    await settle('Gold loan pilot', '2');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });

    expect(statsCallsFor('c-paused')).toBe(2);
  });

  it('does not poll at all when nothing is moving', async () => {
    vi.useFakeTimers();
    mocks.listAgencyCampaignsPage.mockResolvedValue(listing([PAUSED, DRAFT]));
    mocks.getAgencyCampaignStats.mockResolvedValue(stats({ attempts_live: 0, agents_live: 0 }));
    renderPage();
    await settle('Gold loan pilot', 'Agents on the floor');
    await vi.waitFor(() => expect(statsCallsFor('c-paused')).toBe(1));
    const lists = mocks.listAgencyCampaignsPage.mock.calls.length;

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });

    expect(statsCallsFor('c-paused')).toBe(1);
    expect(mocks.listAgencyCampaignsPage.mock.calls.length).toBe(lists);
  });

  it('keeps the last good numbers when a refresh fails', async () => {
    vi.useFakeTimers();
    mocks.listAgencyCampaignsPage.mockResolvedValue(listing([RUNNING]));
    renderPage();
    await settle('Monsoon offers', '5');

    mocks.getAgencyCampaignStats.mockRejectedValue(new Error('blip'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });

    expect(statsCallsFor('c-live')).toBe(2);
    expect(within(card('Monsoon offers')).getByText('5')).toBeTruthy();
    expect(within(card('Monsoon offers')).queryByText(/didn’t load/)).toBeNull();
  });

  it('skips the tick while the tab is hidden', async () => {
    vi.useFakeTimers();
    mocks.listAgencyCampaignsPage.mockResolvedValue(listing([RUNNING]));
    renderPage();
    await settle('Monsoon offers', '5');

    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });

    expect(statsCallsFor('c-live')).toBe(1);
  });

  it('stops polling once the page unmounts', async () => {
    vi.useFakeTimers();
    mocks.listAgencyCampaignsPage.mockResolvedValue(listing([RUNNING]));
    const { unmount } = renderPage();
    await settle('Monsoon offers', '5');

    unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });

    expect(statsCallsFor('c-live')).toBe(1);
  });

  it('re-reads everything when the window regains focus, even with nothing moving', async () => {
    mocks.listAgencyCampaignsPage.mockResolvedValue(listing([PAUSED]));
    mocks.getAgencyCampaignStats.mockResolvedValue(stats({ attempts_live: 0, agents_live: 0 }));
    renderPage();
    await waitFor(() => expect(statsCallsFor('c-paused')).toBe(1));

    mocks.listAgencyCampaignsPage.mockResolvedValue(listing([{ ...PAUSED, status: 'running' }]));
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });

    await waitFor(() => expect(within(card('Gold loan pilot')).getByText('Running')).toBeTruthy());
    await waitFor(() => expect(statsCallsFor('c-paused')).toBeGreaterThanOrEqual(2));
  });
});

describe('AgencyCampaignsPage — the list', () => {
  it('summarises the account and narrows the list by tab', async () => {
    mocks.listAgencyCampaignsPage.mockResolvedValue(listing([DONE, DRAFT, RUNNING]));
    renderPage();
    expect(await screen.findByText('3 campaigns · 1 active · 1 draft · 1 finished')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /Drafts/ }));
    const list = screen.getByRole('list', { name: 'All campaigns' });
    expect(within(list).getByText('Diwali leads')).toBeTruthy();
    expect(within(list).queryByText('Spring renewals')).toBeNull();
    expect(within(list).getByText('09:00–18:00 · Mon–Fri')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Drafts/ }).getAttribute('aria-pressed')).toBe('true');
  });

  it('says nothing is dialing when no campaign is active', async () => {
    mocks.listAgencyCampaignsPage.mockResolvedValue(listing([DRAFT]));
    renderPage();
    expect(await screen.findByText('Nothing is dialing right now')).toBeTruthy();
    expect(mocks.getAgencyCampaignStats).not.toHaveBeenCalled();
  });

  it('offers a search above six campaigns, and says when nothing matches', async () => {
    const many = Array.from({ length: 7 }, (_, i) => ({
      id: `c-${i}`,
      name: `Campaign ${i}`,
      status: 'draft',
    }));
    mocks.listAgencyCampaignsPage.mockResolvedValue(listing(many));
    renderPage();

    const search = await screen.findByRole('searchbox', { name: 'Search campaigns by name' });
    fireEvent.change(search, { target: { value: 'campaign 3' } });
    const list = screen.getByRole('list', { name: 'All campaigns' });
    expect(within(list).getAllByRole('link')).toHaveLength(1);

    fireEvent.change(search, { target: { value: 'zzz' } });
    expect(screen.getByText('No campaigns match “zzz”.')).toBeTruthy();
  });

  it('has no search box for a short list', async () => {
    mocks.listAgencyCampaignsPage.mockResolvedValue(listing([DRAFT, DONE]));
    renderPage();
    await screen.findByRole('list', { name: 'All campaigns' });
    expect(screen.queryByRole('searchbox')).toBeNull();
  });

  it('counts the account’s real total and loads older campaigns on request', async () => {
    const first = Array.from({ length: 100 }, (_, i) => ({ id: `n-${i}`, name: `New ${i}`, status: 'completed' }));
    const older = [{ id: 'o-1', name: 'Oldest campaign', status: 'completed' }];
    mocks.listAgencyCampaignsPage.mockImplementation(async (_t: string, _a: string, offset: number) =>
      offset === 0 ? listing(first, 101) : listing(older, 101),
    );
    renderPage();

    expect(await screen.findByText('101 campaigns · latest 100 shown')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Show older campaigns' }));

    await waitFor(() => expect(screen.getByText('Oldest campaign')).toBeTruthy());
    expect(mocks.listAgencyCampaignsPage).toHaveBeenLastCalledWith('tenant-1', 'account-1', 100, 100);
    expect(screen.queryByRole('button', { name: 'Show older campaigns' })).toBeNull();
  });

  it('gives an old paused campaign its card, and pages the history without counting it', async () => {
    const first = Array.from({ length: 100 }, (_, i) => ({ id: `n-${i}`, name: `New ${i}`, status: 'completed' }));
    const oldPaused: AgencyCampaign = { id: 'o-paused', name: 'Last year pilot', status: 'paused' };
    mocks.listAgencyCampaignsPage.mockImplementation(async (_t: string, _a: string, offset: number) =>
      offset === 0 ? listing(first, 250) : listing([], 250),
    );
    mocks.listAgencyCampaigns.mockResolvedValue([oldPaused]);
    renderPage();

    expect(await screen.findByRole('article', { name: 'Last year pilot' })).toBeTruthy();
    expect(mocks.listAgencyCampaigns).toHaveBeenCalledWith('tenant-1', 'account-1', ['running', 'stopping', 'paused']);
    expect(screen.queryByText('Nothing is dialing right now')).toBeNull();
    expect(screen.getByText('250 campaigns · 1 active · latest 100 shown')).toBeTruthy();

    // The next page starts after the 100 history rows, not the 101 on screen.
    fireEvent.click(screen.getByRole('button', { name: 'Show older campaigns' }));
    await waitFor(() =>
      expect(mocks.listAgencyCampaignsPage).toHaveBeenLastCalledWith('tenant-1', 'account-1', 100, 100),
    );
  });

  it('never puts a draft on a card, even if the active read returned one', async () => {
    const first = Array.from({ length: 100 }, (_, i) => ({ id: `n-${i}`, name: `New ${i}`, status: 'completed' }));
    mocks.listAgencyCampaignsPage.mockResolvedValue(listing(first, 150));
    mocks.listAgencyCampaigns.mockResolvedValue([{ id: 'o-draft', name: 'Old draft', status: 'draft' }]);
    renderPage();

    expect(await screen.findByText('Nothing is dialing right now')).toBeTruthy();
    expect(screen.queryByText('Old draft')).toBeNull();
  });

  it('re-reads a row on an older page that has left the active set since it was loaded', async () => {
    vi.useFakeTimers();
    const first = Array.from({ length: 100 }, (_, i) => ({ id: `n-${i}`, name: `New ${i}`, status: 'completed' }));
    const older: AgencyCampaign = { id: 'o-1', name: 'Old pilot', status: 'paused' };
    mocks.listAgencyCampaignsPage.mockImplementation(async (_t: string, _a: string, offset: number) =>
      offset === 0 ? listing([RUNNING, ...first.slice(1)], 101) : listing([older], 101),
    );
    mocks.listAgencyCampaigns.mockResolvedValue([RUNNING, older]);
    renderPage();
    await vi.waitFor(() => expect(screen.getByRole('article', { name: 'Old pilot' })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Show older campaigns' }));
    await vi.waitFor(() => expect(mocks.listAgencyCampaignsPage).toHaveBeenCalledTimes(2));

    // It is stopped elsewhere: the active read no longer has it.
    mocks.listAgencyCampaigns.mockResolvedValue([RUNNING]);
    mocks.getAgencyCampaign.mockResolvedValue({ ...older, status: 'stopped', ended_at: '2026-10-10T00:00:00Z' });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });

    await vi.waitFor(() => expect(screen.queryByRole('article', { name: 'Old pilot' })).toBeNull());
    expect(mocks.getAgencyCampaign).toHaveBeenCalledTimes(1);
    expect(mocks.getAgencyCampaign).toHaveBeenCalledWith('o-1', 'tenant-1', 'account-1');
    expect(screen.getByText('Old pilot')).toBeTruthy();
  });
});

describe('AgencyCampaignsPage — the rail', () => {
  beforeEach(() => {
    mocks.listAgencyCampaignsPage.mockResolvedValue(listing([DRAFT]));
  });

  it('gives an account admin the Team door, through the platform home', async () => {
    renderPage();
    const team = await screen.findByRole('link', { name: /Team/ });
    // `/app`, not `/app/team`: the agency shell may name the platform zone only
    // through `WorkspaceExit`, and the platform home sends a `user.invite`
    // holder to Team.
    expect(team.getAttribute('href')).toBe('/app');
    expect(screen.getByRole('link', { name: /Analytics/ }).getAttribute('href')).toBe('/agency/analytics');
  });

  it('gives a viewer no Team door, since they cannot invite', async () => {
    mocks.useTenant.mockReturnValue(tenant({ role: 'viewer' }));
    renderPage();
    await screen.findByRole('link', { name: /Analytics/ });
    expect(screen.queryByRole('link', { name: /Team/ })).toBeNull();
    expect(screen.queryByRole('link', { name: /New campaign/ })).toBeNull();
  });
});
