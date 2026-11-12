import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent, within, act } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import type { AgencyHomeCampaignStats } from '@magick-agency/contracts/api/agency/home';
import { board, onBoard, stats as homeStats } from '../helpers/home';

/**
 * The Campaigns page: the list, and the landing of a viewer or an operator (B28a).
 *
 * Pinned here:
 *  - with no campaigns, the getting-started guide replaces the list, and only a
 *    role that can create is given the create action and the steps;
 *  - the Active cards read ONE board (`GET /proxy/agency/home`) per refresh and
 *    never `/stats`: with 19 running campaigns that is 2 requests at first paint
 *    and 14 a minute (list and board), where the per-campaign reads made 20 and
 *    140; past the board's 25 the section links to the Active tab;
 *  - a card shows what it showed before it read the board (calls in progress,
 *    reached of dials, waiting to dial, the line share, the list worked) beside
 *    the floor and abandonment, for a viewer too, whose board has no insights
 *    parts (null);
 *  - a campaign the board could not read keeps its card and says so; the board
 *    failing says so on every card; the list is unaffected;
 *  - the list follows a moving campaign (status, OR anyone on the floor), and a
 *    still one is left alone; a hidden tab skips the tick; unmounting stops it;
 *    a campaign starting or pausing is read at once;
 *  - the list is paginated server-side, so the header counts the account's real
 *    total and older campaigns load on request; active campaigns are read in
 *    full on their own, so an old paused one still gets its card, and the next
 *    page's offset counts only the paged history;
 *  - the filter tabs and the search box;
 *  - per role: no rail repeating the sidebar for anyone; New campaign for a role
 *    that can create; Take calls for a viewer or operator (the sidebar's gate),
 *    never for a supervisor; a viewer's and an operator's cards are links only.
 */

const mocks = vi.hoisted(() => ({
  useTenant: vi.fn(),
  listAgencyCampaignsPage: vi.fn(),
  listAgencyCampaigns: vi.fn(),
  getAgencyCampaign: vi.fn(),
  getAgencyCampaignStats: vi.fn(),
  getAgencyHomeBoard: vi.fn(),
}));

vi.mock('../../contexts/TenantContext', () => ({ useTenant: mocks.useTenant }));
vi.mock('../../api/agencyCampaigns', () => ({
  listAgencyCampaignsPage: mocks.listAgencyCampaignsPage,
  listAgencyCampaigns: mocks.listAgencyCampaigns,
  getAgencyCampaign: mocks.getAgencyCampaign,
  getAgencyCampaignStats: mocks.getAgencyCampaignStats,
}));
vi.mock('../../api/agencyHome', () => ({ getAgencyHomeBoard: mocks.getAgencyHomeBoard }));
// The dialer's flag and capability on, as they are wherever `/agency` renders.
vi.mock('../../hooks/useNavGate', () => ({
  useNavGate: () => ({
    role: mocks.useTenant().role,
    isFlagEnabled: () => true,
    isCapabilityEnabled: () => true,
    missedAvailable: false,
  }),
}));

import { AgencyCampaignsPage } from '../../pages/agency/AgencyCampaignsPage';
import type { AgencyCampaign } from '../../types/agency-campaign';

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

/** A card's stats on the board: five on the floor (three on a call, one being connected, one free). */
function floor(over: Partial<AgencyHomeCampaignStats> = {}): AgencyHomeCampaignStats {
  return homeStats({
    agents_live: 5,
    agents_by_state: { offline: 0, available: 1, reserved: 1, on_call: 3, wrapup: 0, break: 0 },
    abandoned_24h: 1,
    answered_24h: 40,
    abandonment_ceiling_pct: 3,
    ...over,
  });
}

/** A still campaign's stats on the board: nobody on its floor. */
const STILL = homeStats();

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

/** The board for these campaigns, each with `floor()` unless `by` names its stats. */
function boardOf(campaigns: AgencyCampaign[], by: Record<string, AgencyHomeCampaignStats | null> = {}) {
  return board(campaigns.map((c) =>
    onBoard(c.id, {
      name: c.name,
      status: c.status as 'running' | 'stopping' | 'paused',
      stats: c.id in by ? by[c.id]! : floor(),
    }),
  ));
}

function card(name: string): HTMLElement {
  return screen.getByRole('article', { name });
}

/** A card's metric by its label. */
function metric(name: string, label: string): string {
  const term = within(card(name)).getByText(label);
  return term.nextElementSibling?.textContent ?? '';
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.useTenant.mockReturnValue(tenant());
  mocks.listAgencyCampaigns.mockResolvedValue([]);
  mocks.getAgencyHomeBoard.mockResolvedValue(board([]));
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
    expect(screen.getByRole('heading', { name: 'Start dialling' })).toBeTruthy();
    expect(screen.getByText('Several campaigns can run at once. They share your account’s lines.')).toBeTruthy();
    expect(mocks.getAgencyHomeBoard).not.toHaveBeenCalled();
  });

  it('offers a viewer neither the create action nor steps they cannot follow', async () => {
    mocks.useTenant.mockReturnValue(tenant({ role: 'viewer' }));
    renderPage();
    expect(await screen.findByRole('heading', { name: 'No campaigns yet' })).toBeTruthy();
    expect(screen.queryByRole('link', { name: /New campaign/ })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Start dialling' })).toBeNull();
    expect(screen.getByText('Several campaigns can run at once. They share your account’s lines.')).toBeTruthy();
  });
});

describe('AgencyCampaignsPage — active campaigns', () => {
  beforeEach(() => {
    mocks.listAgencyCampaignsPage.mockResolvedValue(listing([DONE, DRAFT, RUNNING, PAUSED]));
    mocks.getAgencyHomeBoard.mockResolvedValue(boardOf([RUNNING, PAUSED], { 'c-paused': STILL }));
  });

  it('reads the board once, never /stats, and shows each card’s floor and abandonment', async () => {
    renderPage();

    await waitFor(() => expect(metric('Monsoon offers', 'Agents on the floor')).toBe('5'));
    // Someone being connected counts as on a call, as on Home's floor.
    expect(metric('Monsoon offers', 'On a call')).toBe('4');
    expect(metric('Monsoon offers', 'Available')).toBe('1');
    expect(metric('Monsoon offers', 'Abandoned (24h)')).toBe('2.5%ceiling 3%');
    expect(metric('Gold loan pilot', 'Agents on the floor')).toBe('0');

    expect(mocks.getAgencyHomeBoard).toHaveBeenCalledTimes(1);
    expect(mocks.getAgencyHomeBoard).toHaveBeenCalledWith('tenant-1', 'account-1');
    expect(mocks.getAgencyCampaignStats).not.toHaveBeenCalled();
    // Only the active campaigns have cards.
    expect(screen.getAllByTestId('active-campaign')).toHaveLength(2);
  });

  it('shows calls in progress, who was reached of the dials, what waits, the line share and the list worked', async () => {
    mocks.getAgencyHomeBoard.mockResolvedValue(boardOf([RUNNING, PAUSED], {
      'c-live': floor({
        attempts_live: 3,
        attempts_connected: 610,
        attempts_total: 1400,
        contacts_total: 1000,
        contacts_pending: 400,
        contacts_completed: 550,
        contacts_suppressed: 20,
        contacts_exhausted: 27,
        concurrency: { campaign_live: 3, fair_share: 5, account_limit: 10, account_live: 6, running_campaigns: 2 },
      }),
      'c-paused': STILL,
    }));
    renderPage();

    await waitFor(() => expect(metric('Monsoon offers', 'Calls in progress')).toBe('3'));
    expect(metric('Monsoon offers', 'Reached someone')).toBe('610of 1,400 dials');
    expect(metric('Monsoon offers', 'Waiting to dial')).toBe('400');
    const live = card('Monsoon offers');
    expect(within(live).getByTestId('campaign-lines').textContent).toBe('3 live calls · share 5 of 10 lines · 2 campaigns running');
    // 550 + 20 + 27 of 1,000: the states nothing dials again.
    const bar = within(live).getByRole('progressbar', { name: 'List worked' });
    expect(bar.getAttribute('aria-valuenow')).toBe('60');
    expect(within(live).getByText('60%')).toBeTruthy();
    expect(within(live).getByText('597 of 1,000 contacts')).toBeTruthy();

    // A payload without the counts says so rather than printing a confident 0.
    expect(metric('Gold loan pilot', 'Reached someone')).toBe('—of — dials');
    expect(metric('Gold loan pilot', 'Waiting to dial')).toBe('—');
    const still = card('Gold loan pilot');
    expect(within(still).queryByTestId('campaign-lines')).toBeNull();
    expect(within(still).getByRole('progressbar', { name: 'List worked' }).getAttribute('aria-valuetext')).toBe('Not known yet');
    expect(within(still).getByText('The contact counts didn’t load.')).toBeTruthy();
  });

  it('gives a viewer the same cards from a board without the insights parts, read with their role', async () => {
    mocks.useTenant.mockReturnValue(tenant({ role: 'viewer' }));
    const withheld = { staffing: null, overdue: null, today: null, settings: null } as const;
    mocks.getAgencyHomeBoard.mockResolvedValue(board([
      onBoard('c-live', { name: RUNNING.name, stats: floor({ attempts_live: 2, contacts_pending: 9 }), ...withheld }),
      onBoard('c-paused', { name: PAUSED.name, status: 'paused', stats: STILL, ...withheld }),
    ]));
    renderPage();

    await waitFor(() => expect(metric('Monsoon offers', 'Calls in progress')).toBe('2'));
    expect(metric('Monsoon offers', 'Agents on the floor')).toBe('5');
    expect(metric('Monsoon offers', 'Waiting to dial')).toBe('9');
    expect(screen.queryByText(/Live numbers didn’t load/)).toBeNull();
    expect(mocks.getAgencyHomeBoard).toHaveBeenCalledTimes(1);
  });

  it('withholds a rate under 25 answered calls, and marks one over the ceiling', async () => {
    mocks.getAgencyHomeBoard.mockResolvedValue(boardOf([RUNNING, PAUSED], {
      'c-live': floor({ abandoned_24h: 3, answered_24h: 50 }),
      'c-paused': floor({ abandoned_24h: 1, answered_24h: 10 }),
    }));
    renderPage();

    await waitFor(() => expect(metric('Monsoon offers', 'Abandoned (24h)')).toBe('6%ceiling 3%'));
    const over = within(card('Monsoon offers')).getByText('Abandoned (24h)').nextElementSibling as HTMLElement;
    expect(over.dataset['tone']).toBe('over');
    expect(metric('Gold loan pilot', 'Abandoned (24h)')).toBe('—Not enough calls yet');
  });

  it('keeps one card’s failed read on that card, with its sibling’s numbers intact', async () => {
    mocks.getAgencyHomeBoard.mockResolvedValue(boardOf([RUNNING, PAUSED], { 'c-live': null, 'c-paused': floor({ agents_live: 7 }) }));
    renderPage();

    await waitFor(() =>
      expect(within(card('Monsoon offers')).getByText(/Live numbers didn’t load/)).toBeTruthy(),
    );
    expect(metric('Gold loan pilot', 'Agents on the floor')).toBe('7');
    expect(within(card('Gold loan pilot')).queryByText(/Live numbers didn’t load/)).toBeNull();
    // The list is still there.
    expect(screen.getByRole('link', { name: /Diwali leads/ })).toBeTruthy();
  });

  it('says so on every card when the board cannot be read, and keeps the list', async () => {
    mocks.getAgencyHomeBoard.mockRejectedValue(new Error('boom'));
    renderPage();

    await waitFor(() => expect(screen.getAllByText(/Live numbers didn’t load/)).toHaveLength(2));
    expect(screen.getByRole('link', { name: /Diwali leads/ })).toBeTruthy();
  });

  it('shows the top diagnosis when the campaign is stalled', async () => {
    mocks.listAgencyCampaignsPage.mockResolvedValue(listing([RUNNING]));
    mocks.getAgencyHomeBoard.mockResolvedValue(boardOf([RUNNING], {
      'c-live': floor({ stall: { code: 'concurrency_saturated', limit: 10, in_use: 10 } }),
    }));
    renderPage();
    await waitFor(() =>
      expect(within(card('Monsoon offers')).getByText(/lines/i)).toBeTruthy(),
    );
  });

  it('gives the board’s 25 a card each, and links the rest to the Active tab', async () => {
    const many: AgencyCampaign[] = Array.from({ length: 27 }, (_, i) => ({ id: `r-${i}`, name: `Run ${i}`, status: 'running' }));
    mocks.listAgencyCampaignsPage.mockResolvedValue(listing(many));
    mocks.getAgencyHomeBoard.mockResolvedValue({ ...boardOf(many.slice(0, 25)), active_total: 27 });
    renderPage();

    await waitFor(() => expect(metric('Run 24', 'Agents on the floor')).toBe('5'));
    expect(screen.getAllByTestId('active-campaign')).toHaveLength(25);
    expect(screen.queryByRole('article', { name: 'Run 25' })).toBeNull();
    const more = screen.getByTestId('active-more');
    expect(more.textContent).toContain('And 2 more active campaigns.');
    fireEvent.click(within(more).getByRole('link', { name: 'See every active campaign' }));
    expect(screen.getByRole('button', { name: /^Active/ }).getAttribute('aria-pressed')).toBe('true');
  });
});

describe('AgencyCampaignsPage — refreshing', () => {
  /** Wait for a card's numbers to be RENDERED: the poll predicate reads them. */
  async function settle(name: string, value: string) {
    await vi.waitFor(() => expect(metric(name, 'Agents on the floor')).toBe(value));
  }

  async function tick(ms: number) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  }

  it('makes 2 requests at first paint and 14 a minute with 19 running campaigns (it was 20 and 140)', async () => {
    vi.useFakeTimers();
    const many: AgencyCampaign[] = Array.from({ length: 19 }, (_, i) => ({ id: `r-${i}`, name: `Run ${i}`, status: 'running' }));
    mocks.listAgencyCampaignsPage.mockResolvedValue(listing(many));
    mocks.getAgencyHomeBoard.mockResolvedValue(boardOf(many));
    renderPage();
    await settle('Run 18', '5');

    expect(mocks.listAgencyCampaignsPage).toHaveBeenCalledTimes(1);
    expect(mocks.getAgencyHomeBoard).toHaveBeenCalledTimes(1);

    await tick(60_000);
    expect(mocks.listAgencyCampaignsPage).toHaveBeenCalledTimes(7);
    expect(mocks.getAgencyHomeBoard).toHaveBeenCalledTimes(7);
    expect(mocks.getAgencyCampaignStats).not.toHaveBeenCalled();
    expect(mocks.listAgencyCampaigns).not.toHaveBeenCalled();
    expect(mocks.getAgencyCampaign).not.toHaveBeenCalled();
  });

  it('follows a paused campaign while agents are on it, and leaves the list alone once nobody is', async () => {
    vi.useFakeTimers();
    mocks.listAgencyCampaignsPage.mockResolvedValue(listing([PAUSED, DRAFT]));
    mocks.getAgencyHomeBoard.mockResolvedValue(boardOf([PAUSED], { 'c-paused': floor({ agents_live: 2 }) }));
    renderPage();
    await settle('Gold loan pilot', '2');

    await tick(10_000);
    expect(mocks.listAgencyCampaignsPage).toHaveBeenCalledTimes(2);

    // Everyone has left: the board still answers every 10 s, the list is not read again.
    mocks.getAgencyHomeBoard.mockResolvedValue(boardOf([PAUSED], { 'c-paused': STILL }));
    await tick(10_000);
    await settle('Gold loan pilot', '0');
    const lists = mocks.listAgencyCampaignsPage.mock.calls.length;
    await tick(30_000);
    expect(mocks.listAgencyCampaignsPage.mock.calls.length).toBe(lists);
  });

  it('follows a paused campaign while its calls drain with nobody on the floor (the board carries attempts_live)', async () => {
    vi.useFakeTimers();
    const draining = floor({ attempts_live: 2, agents_live: 0, agents_by_state: { offline: 0, available: 0, reserved: 0, on_call: 0, wrapup: 0, break: 0 } });
    mocks.listAgencyCampaignsPage.mockResolvedValue(listing([PAUSED, DRAFT]));
    mocks.getAgencyHomeBoard.mockResolvedValue(boardOf([PAUSED], { 'c-paused': draining }));
    renderPage();
    await vi.waitFor(() => expect(metric('Gold loan pilot', 'Calls in progress')).toBe('2'));

    await tick(10_000);
    expect(mocks.listAgencyCampaignsPage).toHaveBeenCalledTimes(2);
  });

  it('reads nothing on a timer when no campaign is active', async () => {
    vi.useFakeTimers();
    mocks.listAgencyCampaignsPage.mockResolvedValue(listing([DRAFT, DONE]));
    renderPage();
    await vi.waitFor(() => expect(screen.getByText('Nothing is dialling right now')).toBeTruthy());

    await tick(30_000);
    expect(mocks.listAgencyCampaignsPage).toHaveBeenCalledTimes(1);
    expect(mocks.getAgencyHomeBoard).not.toHaveBeenCalled();
  });

  it('keeps the last good numbers when a refresh fails', async () => {
    vi.useFakeTimers();
    mocks.listAgencyCampaignsPage.mockResolvedValue(listing([RUNNING]));
    mocks.getAgencyHomeBoard.mockResolvedValue(boardOf([RUNNING]));
    renderPage();
    await settle('Monsoon offers', '5');

    mocks.getAgencyHomeBoard.mockRejectedValue(new Error('blip'));
    await tick(10_000);

    expect(mocks.getAgencyHomeBoard).toHaveBeenCalledTimes(2);
    expect(metric('Monsoon offers', 'Agents on the floor')).toBe('5');
    expect(within(card('Monsoon offers')).queryByText(/Live numbers didn’t load/)).toBeNull();
  });

  it('skips the tick while the tab is hidden', async () => {
    vi.useFakeTimers();
    mocks.listAgencyCampaignsPage.mockResolvedValue(listing([RUNNING]));
    mocks.getAgencyHomeBoard.mockResolvedValue(boardOf([RUNNING]));
    renderPage();
    await settle('Monsoon offers', '5');

    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    await tick(30_000);

    expect(mocks.getAgencyHomeBoard).toHaveBeenCalledTimes(1);
    expect(mocks.listAgencyCampaignsPage).toHaveBeenCalledTimes(1);
  });

  it('stops polling once the page unmounts', async () => {
    vi.useFakeTimers();
    mocks.listAgencyCampaignsPage.mockResolvedValue(listing([RUNNING]));
    mocks.getAgencyHomeBoard.mockResolvedValue(boardOf([RUNNING]));
    const { unmount } = renderPage();
    await settle('Monsoon offers', '5');

    unmount();
    await tick(30_000);

    expect(mocks.getAgencyHomeBoard).toHaveBeenCalledTimes(1);
    expect(mocks.listAgencyCampaignsPage).toHaveBeenCalledTimes(1);
  });

  it('re-reads the list when the window regains focus, and the board at once when a campaign starts', async () => {
    mocks.listAgencyCampaignsPage.mockResolvedValue(listing([PAUSED]));
    mocks.getAgencyHomeBoard.mockResolvedValue(boardOf([PAUSED], { 'c-paused': STILL }));
    renderPage();
    await waitFor(() => expect(metric('Gold loan pilot', 'Agents on the floor')).toBe('0'));
    expect(mocks.getAgencyHomeBoard).toHaveBeenCalledTimes(1);

    const started = { ...PAUSED, status: 'running' };
    mocks.listAgencyCampaignsPage.mockResolvedValue(listing([started]));
    mocks.getAgencyHomeBoard.mockResolvedValue(boardOf([started], { 'c-paused': floor({ agents_live: 3 }) }));
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });

    await waitFor(() => expect(within(card('Gold loan pilot')).getByText('Running')).toBeTruthy());
    await waitFor(() => expect(metric('Gold loan pilot', 'Agents on the floor')).toBe('3'));
    expect(mocks.getAgencyHomeBoard).toHaveBeenCalledTimes(2);
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

  /** The filter is `?status=` (QA note: a reload went back to All). */
  describe('the status filter in the URL', () => {
    function LocationProbe() {
      return <output data-testid="location">{useLocation().search}</output>;
    }

    function renderAt(entry: string) {
      return render(
        <MemoryRouter initialEntries={[entry]}>
          <AgencyCampaignsPage />
          <LocationProbe />
        </MemoryRouter>,
      );
    }

    it('opens on the filter the URL names, as a reload or Back does', async () => {
      mocks.listAgencyCampaignsPage.mockResolvedValue(listing([DONE, DRAFT, RUNNING]));
      renderAt('/agency/campaigns?status=draft');
      const list = await screen.findByRole('list', { name: 'All campaigns' });
      expect(within(list).getByText('Diwali leads')).toBeTruthy();
      expect(within(list).queryByText('Spring renewals')).toBeNull();
      expect(screen.getByRole('button', { name: /Drafts/ }).getAttribute('aria-pressed')).toBe('true');
    });

    it('writes the chosen filter into the URL, and All takes it out', async () => {
      mocks.listAgencyCampaignsPage.mockResolvedValue(listing([DONE, DRAFT, RUNNING]));
      renderAt('/agency/campaigns');
      await screen.findByRole('list', { name: 'All campaigns' });

      fireEvent.click(screen.getByRole('button', { name: /Finished/ }));
      expect(screen.getByTestId('location').textContent).toBe('?status=finished');
      fireEvent.click(screen.getByRole('button', { name: /^All/ }));
      expect(screen.getByTestId('location').textContent).toBe('');
    });

    it('reads an unknown value as All', async () => {
      mocks.listAgencyCampaignsPage.mockResolvedValue(listing([DONE, DRAFT, RUNNING]));
      renderAt('/agency/campaigns?status=bogus');
      await screen.findByRole('list', { name: 'All campaigns' });
      expect(screen.getByRole('button', { name: /^All/ }).getAttribute('aria-pressed')).toBe('true');
    });
  });

  it('says nothing is dialing when no campaign is active', async () => {
    mocks.listAgencyCampaignsPage.mockResolvedValue(listing([DRAFT]));
    renderPage();
    expect(await screen.findByText('Nothing is dialling right now')).toBeTruthy();
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
    expect(screen.queryByText('Nothing is dialling right now')).toBeNull();
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

    expect(await screen.findByText('Nothing is dialling right now')).toBeTruthy();
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
    // Wait for the older page to land in the history, not just to be requested: the
    // poll finds the stale row in the history, and a poll that runs first misses it.
    // (The button is no signal: it reads "Loading…" while the request is in flight.)
    await vi.waitFor(() => expect(screen.queryByText(/Showing the latest/)).toBeNull());
    expect(mocks.listAgencyCampaignsPage).toHaveBeenCalledTimes(2);

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

describe('AgencyCampaignsPage — per role', () => {
  beforeEach(() => {
    mocks.listAgencyCampaignsPage.mockResolvedValue(listing([DRAFT, RUNNING]));
    mocks.getAgencyHomeBoard.mockResolvedValue(boardOf([RUNNING]));
  });

  it('gives a supervisor New campaign and the rules, and no rail of sidebar entries or Take calls', async () => {
    renderPage();
    await waitFor(() => expect(metric('Monsoon offers', 'Agents on the floor')).toBe('5'));
    expect(screen.getByRole('link', { name: /New campaign/ }).getAttribute('href')).toBe('/agency/campaigns/new');
    expect(screen.queryByRole('link', { name: /Take calls/ })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Shortcuts' })).toBeNull();
    expect(screen.queryByRole('link', { name: /Analytics|Do Not Call|Team/ })).toBeNull();
    expect(screen.getByRole('heading', { name: 'Good to know' })).toBeTruthy();
  });

  it.each(['viewer', 'operator'])('gives a %s their cards, read-only, and Take calls instead of New campaign', async (role) => {
    mocks.useTenant.mockReturnValue(tenant({ role }));
    renderPage();
    await waitFor(() => expect(metric('Monsoon offers', 'Agents on the floor')).toBe('5'));

    expect(screen.getByRole('link', { name: /Take calls/ }).getAttribute('href')).toBe('/dialer');
    expect(screen.queryByRole('link', { name: /New campaign/ })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Shortcuts' })).toBeNull();
    // A card is links to the campaign and nothing that acts on it.
    const live = card('Monsoon offers');
    expect(within(live).queryAllByRole('button')).toHaveLength(0);
    expect(within(live).getAllByRole('link').map((a) => a.getAttribute('href')))
      .toEqual(['/agency/campaigns/c-live', '/agency/campaigns/c-live']);
    // The board is the only live read: no per-campaign stats, no supervisor-only read.
    expect(mocks.getAgencyCampaignStats).not.toHaveBeenCalled();
  });

  it.each(['viewer', 'operator'])('gives a %s with no campaigns yet a plain empty state and Take calls', async (role) => {
    mocks.useTenant.mockReturnValue(tenant({ role }));
    mocks.listAgencyCampaignsPage.mockResolvedValue(listing([]));
    renderPage();

    expect(await screen.findByRole('heading', { name: 'No campaigns yet' })).toBeTruthy();
    expect(screen.getByText('Campaigns are set up by a supervisor. They will show here as soon as one exists.')).toBeTruthy();
    expect(screen.getByRole('link', { name: /Take calls/ }).getAttribute('href')).toBe('/dialer');
    expect(screen.queryByRole('link', { name: /New campaign|Invite agents/ })).toBeNull();
    expect(mocks.getAgencyHomeBoard).not.toHaveBeenCalled();
  });
});
