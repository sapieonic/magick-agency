import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen, cleanup, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { board, onBoard, stats } from '../helpers/home';

/**
 * Live floor (B28a, LF1; Home until the redesign, at Home's URL): the gate, the header and its
 * campaign filter, the tiles, Needs you now, the campaign cards with Pause and Resume, the agents'
 * chips, their links and states, the request bound, and the count it shares with the sidebar badge.
 */

const mocks = vi.hoisted(() => ({
  role: 'account_admin' as string | undefined,
  getAgencyHomeBoard: vi.fn(),
  getAgencyGroupedStats: vi.fn(),
  missed: { available: false, count: null as null | { open: number; open_capped: boolean; has_rows: boolean } },
  userId: 'u-1',
  getAgencyCampaign: vi.fn(),
  transitionAgencyCampaign: vi.fn(),
  getAgencyFloor: vi.fn(),
  showToast: vi.fn(),
  showErrorToast: vi.fn(),
}));

vi.mock('../../contexts/TenantContext', () => ({
  useTenant: () => ({ role: mocks.role, tenantId: 't-1', accountId: 'a-1', accounts: [{ id: 'a-1', name: 'Pune Collections' }] }),
}));
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: mocks.userId } }) }));
vi.mock('../../api/agencyHome', () => ({ getAgencyHomeBoard: mocks.getAgencyHomeBoard }));
vi.mock('../../api/agencyStats', () => ({ getAgencyGroupedStats: mocks.getAgencyGroupedStats }));
vi.mock('../../api/agencyCampaigns', () => ({
  getAgencyCampaign: mocks.getAgencyCampaign,
  transitionAgencyCampaign: mocks.transitionAgencyCampaign,
}));
vi.mock('@magick-agency/web-ui/contexts/ToastContext', () => ({
  useToast: () => ({ showToast: mocks.showToast, showErrorToast: mocks.showErrorToast }),
}));
// Phase 2's reads fail here unless a test says otherwise: these cases pin the page on the board
// alone (`HomePage.floor.test.tsx` covers the floor and the promises). A case that needs an
// all-clear reads an empty floor (`floorRead`): with the floor unread, breaks are unchecked.
vi.mock('../../api/agencyFloor', () => ({
  getAgencyFloor: mocks.getAgencyFloor,
  getAgencyPromisesSummary: () => Promise.reject(new Error('not in this file')),
}));
vi.mock('../../hooks/useMissedCallsAccess', () => ({
  useMissedCallsAccess: () => ({ ...mocks.missed, inboundOn: true, settled: true }),
}));

import HomePage from '../../pages/agency/HomePage';
import { homeAcksKey, resetHomeAcksForTests } from '../../hooks/useHomeAcks';
import { HOME_BOARD_ERROR, HOME_FAST_MS, useHomeBadgeCount } from '../../hooks/useHomeBoard';

function Where() {
  return <div data-testid="where">{useLocation().pathname}</div>;
}

/** The page's query, where the campaign filter is kept. */
function Search() {
  return <div data-testid="search">{useLocation().search}</div>;
}

/** The sidebar badge's count, read from the board Home reads; offered, as in the sidebar, only past Home's gate. */
function Badge() {
  return mocks.role === 'account_admin' ? <BadgeCount /> : null;
}

function BadgeCount() {
  const { count } = useHomeBadgeCount('t-1', 'a-1', mocks.role, { available: mocks.missed.available, count: mocks.missed.count });
  return <div data-testid="shared-count">{String(count)}</div>;
}

/** The floor answers, with nobody on it: nothing on a break, so the breaks are checked. */
function floorRead() {
  mocks.getAgencyFloor.mockImplementation(async () => ({ agents: [], totals: { on_shift: 0, assigned: 0 }, as_of: new Date().toISOString() }));
}

function renderHome(entry = '/agency/home') {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/agency/home" element={<><HomePage /><Badge /><Search /></>} />
        <Route path="*" element={<Where />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  resetHomeAcksForTests();
  mocks.role = 'account_admin';
  mocks.userId = 'u-1';
  mocks.missed = { available: false, count: null };
  mocks.getAgencyHomeBoard.mockResolvedValue(board([], { any_campaign: true }));
  mocks.getAgencyGroupedStats.mockResolvedValue({ rows: [], total_groups: 0 });
  mocks.getAgencyFloor.mockRejectedValue(new Error('not in this file'));
});
afterEach(() => cleanup());

describe('the gate', () => {
  it.each(['viewer', 'operator', 'agent'] as const)('sends a %s back to /agency, reading nothing', async (role) => {
    mocks.role = role;
    renderHome();
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('/agency'));
    expect(mocks.getAgencyHomeBoard).not.toHaveBeenCalled();
    expect(mocks.getAgencyGroupedStats).not.toHaveBeenCalled();
  });

  it('waits while the role is unresolved', () => {
    mocks.role = undefined;
    renderHome();
    expect(screen.queryByTestId('where')).toBeNull();
    expect(mocks.getAgencyHomeBoard).not.toHaveBeenCalled();
  });
});

describe('Needs you now', () => {
  it('lists each condition with its action linking to the exact tab, and shares the count without the missed calls', async () => {
    mocks.getAgencyHomeBoard.mockResolvedValue(board([
      onBoard('c1', { name: 'Q4 collections', stats: stats({ agents_live: 2, abandoned_24h: 3, answered_24h: 100 }), overdue: 7 }),
      onBoard('c2', {
        status: 'paused',
        name: 'Card follow-up',
        stats: stats({ stall: { code: 'auto_paused_abandonment', measured_pct: 3.4, ceiling_pct: 3, paused_at: '2026-11-11T09:12:00Z' } }),
      }),
    ]));
    mocks.missed = { available: true, count: { open: 3, open_capped: false, has_rows: true } };

    renderHome();

    const list = await screen.findByTestId('home-attention');
    const link = (id: string) => within(screen.getByTestId(`home-attention-${id}`)).getByRole('link');
    expect(link('callbacks-overdue:c1').getAttribute('href')).toBe('/agency/campaigns/c1/callbacks');
    expect(link('stall:c2').getAttribute('href')).toBe('/agency/campaigns/c2/health');
    expect(link('abandonment:c1').getAttribute('href')).toBe('/agency/campaigns/c1/health');
    expect(link('missed').getAttribute('href')).toBe('/agency/inbound/missed');
    expect(within(list).getAllByRole('listitem')).toHaveLength(4);
    expect(screen.getByText(/^Each item clears itself once it’s fixed/)).toBeTruthy();
    expect(screen.getByText('7 callbacks overdue')).toBeTruthy();
    // Four rows; the badge counts three: the missed calls are the Inbound badge's.
    await waitFor(() => expect(screen.getByTestId('shared-count').textContent).toBe('3'));
  });

  it('shows a campaign that is only waiting apart, muted, and leaves it out of the count', async () => {
    floorRead();
    mocks.getAgencyHomeBoard.mockResolvedValue(board([
      onBoard('c1', { name: 'Night shift', stats: stats({ stall: { code: 'outside_calling_hours', contacts_waiting: 40, next_window_opens_at: null } }) }),
    ]));
    renderHome();
    const waiting = await screen.findByTestId('home-waiting');
    expect(within(waiting).getByText('For your information')).toBeTruthy();
    expect(within(waiting).getByText('Outside calling hours')).toBeTruthy();
    expect(screen.queryByTestId('home-attention')).toBeNull();
    expect(screen.getByTestId('home-attention-empty').textContent).toContain('Nothing needs you right now');
    await waitFor(() => expect(screen.getByTestId('shared-count').textContent).toBe('0'));
  });

  it('says nothing needs you when nothing does', async () => {
    floorRead();
    mocks.getAgencyHomeBoard.mockResolvedValue(board([onBoard('c1')]));
    renderHome();
    expect((await screen.findByTestId('home-attention-empty')).textContent).toContain('Nothing needs you right now');
    await waitFor(() => expect(screen.getByTestId('shared-count').textContent).toBe('0'));
  });

  it.each([
    ['failed', () => mocks.getAgencyFloor.mockRejectedValue(new Error('network'))],
    ['was refused', () => mocks.getAgencyFloor.mockRejectedValue(Object.assign(new Error('forbidden'), { statusCode: 403 }))],
  ])('never gives an all-clear while the floor read %s: the breaks were not checked', async (_, floor) => {
    floor();
    mocks.getAgencyHomeBoard.mockResolvedValue(board([onBoard('c1')]));
    renderHome();
    const note = await screen.findByTestId('home-attention-breaks-unknown');
    await waitFor(() => expect(note.textContent).toBe('Nothing on your campaigns needs you, but agents’ breaks couldn’t be checked.'));
    expect(screen.queryByTestId('home-attention-empty')).toBeNull();
  });

  it('never gives an all-clear while the floor is still being read', async () => {
    mocks.getAgencyFloor.mockImplementation(() => new Promise(() => {}));
    mocks.getAgencyHomeBoard.mockResolvedValue(board([onBoard('c1')]));
    renderHome();
    expect((await screen.findByTestId('home-attention-breaks-unknown')).textContent)
      .toBe('Nothing on your campaigns needs you. Agents’ breaks are still being checked.');
    expect(screen.queryByTestId('home-attention-empty')).toBeNull();
  });
});

describe('the page', () => {
  it('is called Live floor, with today’s date and time', async () => {
    renderHome();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Live floor');
    const clock = screen.getByTestId('live-floor-clock');
    expect(clock.textContent).toMatch(/^[A-Z][a-z]{2} \d{1,2} [A-Z][a-z]{2}·\d{2}:\d{2} [ap]m$/);
    expect(clock.getAttribute('datetime')).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('shows the agents on the floor across campaigns as chips, and links each campaign’s Agents tab', async () => {
    mocks.getAgencyHomeBoard.mockResolvedValue(board([
      onBoard('c1', {
        name: 'Diwali renewals',
        stats: stats({ agents_live: 4, agents_by_state: { offline: 0, available: 1, reserved: 1, on_call: 1, wrapup: 1, break: 0 } }),
      }),
      onBoard('c2', { status: 'paused', stats: stats({ agents_live: 2, agents_by_state: { offline: 0, available: 0, reserved: 0, on_call: 0, wrapup: 0, break: 2 } }) }),
    ]));
    renderHome();
    const floor = await screen.findByTestId('home-floor');
    expect(within(floor).getAllByRole('link').map((a) => [a.textContent, a.getAttribute('href')])).toEqual([
      ['Diwali renewals', '/agency/campaigns/c1/agents'],
      ['Campaign c2', '/agency/campaigns/c2/agents'],
    ]);
    expect(screen.getByTestId('home-chip-all').textContent).toBe('All 6');
    expect(screen.getByTestId('home-chip-on_call').textContent).toBe('On a call 2');
    expect(screen.getByTestId('home-chip-available').textContent).toBe('Ready 1');
    expect(screen.getByTestId('home-chip-wrapup').textContent).toBe('Choosing outcome 1');
    expect(screen.getByTestId('home-chip-break').textContent).toBe('Break 2');
    // Need help cannot be raised yet: marked coming soon, with no count.
    expect(screen.getByTestId('home-chip-help').textContent).toBe('Need helpComing soon');
    expect(screen.getByText('Open a campaign’s Agents tab to see each agent:')).toBeTruthy();
    expect(screen.getByTestId('kpi-agents').textContent).toBe('Agents working6on the floor now');
  });

  it('says so when nothing is active, and offers the new-campaign button', async () => {
    renderHome();
    expect((await screen.findByTestId('home-floor-empty')).textContent).toContain('No campaign is running or paused');
    expect(screen.getByTestId('home-floor-none').textContent).toContain('nobody is on the floor');
    expect(screen.getByRole('link', { name: /New campaign/ }).getAttribute('href')).toBe('/agency/campaigns/new');
  });

  it('shows the get-started card for an account with no campaigns at all', async () => {
    mocks.getAgencyHomeBoard.mockResolvedValue(board([], { any_campaign: false }));
    renderHome();
    expect(await screen.findByText('Launch your first campaign')).toBeTruthy();
    expect(screen.queryByTestId('home-floor')).toBeNull();
    expect(screen.queryByTestId('home-agent-chips')).toBeNull();
    // One button, on the card: the header's is left out.
    expect(screen.getAllByRole('link', { name: /New campaign/ })).toHaveLength(1);
  });

  it('says so in its own words, with a retry, when the board does not load: never the server’s text', async () => {
    floorRead();
    mocks.getAgencyHomeBoard.mockRejectedValue(new Error('Route GET:/proxy/agency/home not found'));
    renderHome();
    expect(await screen.findByText(HOME_BOARD_ERROR)).toBeTruthy();
    expect(screen.queryByText(/Route GET|not found/)).toBeNull();

    mocks.getAgencyHomeBoard.mockResolvedValue(board([onBoard('c1')]));
    fireEvent.click(screen.getByRole('button', { name: /Retry/ }));
    expect(await screen.findByTestId('home-attention-empty')).toBeTruthy();
    expect(screen.queryByText(HOME_BOARD_ERROR)).toBeNull();
  });

  it('still shows today’s tiles when the board does not load: they are their own read', async () => {
    mocks.getAgencyHomeBoard.mockRejectedValue(new Error('nope'));
    mocks.getAgencyGroupedStats.mockResolvedValue({
      rows: [{ key: { campaign_id: 'a' }, attempts: 12, connected: 4, successes: 1, talk_seconds: 60, wrapup_seconds: 0 }],
      total_groups: 1,
    });
    renderHome();
    await screen.findByText(HOME_BOARD_ERROR);
    await waitFor(() => expect(screen.getByTestId('kpi-calls').textContent).toBe('Calls today12dialled since midnight'));
    // The board's tiles say nothing rather than a zero they never read.
    expect(screen.getByTestId('kpi-agents').textContent).toBe('Agents working—');
  });
});

describe('the tiles', () => {
  it('sums the board’s late callbacks, in the danger tone, linking to Callbacks', async () => {
    mocks.getAgencyHomeBoard.mockResolvedValue(board([onBoard('c1', { overdue: 3 }), onBoard('c2', { overdue: 1 })]));
    renderHome();
    const tile = await screen.findByTestId('kpi-late-callbacks');
    await waitFor(() => expect(tile.textContent).toBe('Late callbacks4promised time has passed'));
    expect(tile.getAttribute('href')).toBe('/agency/callbacks');
    expect(tile.getAttribute('aria-label')).toBe('Late callbacks: 4. Open Callbacks');
    expect(tile.querySelector('[data-tone="danger"]')).not.toBeNull();
  });

  it('is not in the danger tone with none late', async () => {
    mocks.getAgencyHomeBoard.mockResolvedValue(board([onBoard('c1')]));
    renderHome();
    const tile = await screen.findByTestId('kpi-late-callbacks');
    await waitFor(() => expect(tile.textContent).toContain('Late callbacks0'));
    expect(tile.querySelector('[data-tone="danger"]')).toBeNull();
  });

  it('says what share of dials were answered, and withholds it under 25 dials', async () => {
    mocks.getAgencyGroupedStats.mockResolvedValue({
      rows: [{ key: { campaign_id: 'a' }, attempts: 24, connected: 6, successes: 1, talk_seconds: 60, wrapup_seconds: 0 }],
      total_groups: 1,
    });
    renderHome();
    await waitFor(() => expect(screen.getByTestId('kpi-reached').textContent).toBe('Customers reached6Too few dials yet for a share'));
  });
});

describe('the campaign filter', () => {
  const two = () => board([
    onBoard('c1', { name: 'Q4 collections', overdue: 2, stats: stats({ agents_live: 3, attempts_live: 2 }) }),
    onBoard('c2', { name: 'Card follow-up', status: 'paused', overdue: 1, stats: stats({ agents_live: 1 }) }),
  ]);
  const grouped = {
    rows: [
      { key: { campaign_id: 'c1' }, attempts: 100, connected: 30, successes: 5, talk_seconds: 600, wrapup_seconds: 0 },
      { key: { campaign_id: 'c2' }, attempts: 40, connected: 10, successes: 2, talk_seconds: 300, wrapup_seconds: 0 },
    ],
    total_groups: 2,
  };

  it('narrows every part to one campaign, keeps the choice in the URL, and says what it leaves out', async () => {
    mocks.getAgencyHomeBoard.mockResolvedValue(two());
    mocks.getAgencyGroupedStats.mockResolvedValue(grouped);
    renderHome();
    const filter = await screen.findByRole('combobox', { name: 'Show campaign' });
    expect(within(filter).getAllByRole('option').map((o) => o.textContent)).toEqual(['All campaigns', 'Q4 collections', 'Card follow-up']);
    await waitFor(() => expect(screen.getByTestId('kpi-calls').textContent).toContain('140'));

    fireEvent.change(filter, { target: { value: 'c2' } });
    expect(screen.getByTestId('search').textContent).toBe('?campaign=c2');
    expect(screen.getByTestId('kpi-calls').textContent).toContain('40');
    expect(screen.getByTestId('kpi-agents').textContent).toContain('1');
    expect(screen.getByTestId('kpi-late-callbacks').textContent).toContain('Late callbacks1');
    expect(screen.queryByTestId('home-campaign-c1')).toBeNull();
    expect(screen.getByTestId('home-campaign-c2')).toBeTruthy();
    expect(screen.queryByTestId('home-attention-callbacks-overdue:c1')).toBeNull();
    expect(screen.getByTestId('home-attention-callbacks-overdue:c2')).toBeTruthy();
    expect(screen.getByTestId('home-attention-elsewhere').textContent).toContain('1 more thing on other campaigns or the account.');

    fireEvent.click(within(screen.getByTestId('home-attention-elsewhere')).getByRole('button', { name: 'Show all campaigns' }));
    expect(screen.getByTestId('search').textContent).toBe('');
    expect(screen.getByTestId('home-campaign-c1')).toBeTruthy();
  });

  it('leaves what the reader put aside out of what it says the filter leaves out', async () => {
    mocks.getAgencyHomeBoard.mockResolvedValue(two());
    renderHome();
    fireEvent.click(within(await screen.findByTestId('home-attention-callbacks-overdue:c2')).getByRole('button', { name: /Got it/ }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Show campaign' }), { target: { value: 'c1' } });
    expect(screen.getByTestId('home-attention-callbacks-overdue:c1')).toBeTruthy();
    expect(screen.queryByTestId('home-attention-elsewhere')).toBeNull();
  });

  it('survives a reload (the query), and shows everything for a campaign no longer active', async () => {
    mocks.getAgencyHomeBoard.mockResolvedValue(two());
    const first = renderHome('/agency/home?campaign=c1');
    expect(await screen.findByTestId('home-campaign-c1')).toBeTruthy();
    expect(screen.queryByTestId('home-campaign-c2')).toBeNull();
    expect((screen.getByRole('combobox', { name: 'Show campaign' }) as HTMLSelectElement).value).toBe('c1');
    first.unmount();

    renderHome('/agency/home?campaign=gone');
    expect(await screen.findByTestId('home-campaign-c1')).toBeTruthy();
    expect(screen.getByTestId('home-campaign-c2')).toBeTruthy();
    expect((screen.getByRole('combobox', { name: 'Show campaign' }) as HTMLSelectElement).value).toBe('');
  });
});

describe('the campaign cards', () => {
  it('show status, calls live and how much of the list is done', async () => {
    mocks.getAgencyHomeBoard.mockResolvedValue(board([
      onBoard('c1', {
        name: 'Nov collections',
        stats: stats({ attempts_live: 4, contacts_total: 1240, contacts_completed: 500, contacts_suppressed: 20, contacts_exhausted: 40 }),
      }),
    ]));
    renderHome();
    const card = await screen.findByTestId('home-campaign-c1');
    expect(within(card).getByRole('link', { name: 'Nov collections' }).getAttribute('href')).toBe('/agency/campaigns/c1');
    expect(card.textContent).toContain('Running');
    expect(card.textContent).toContain('4 calls live');
    expect(card.textContent).not.toMatch(/lines/);
    expect(card.textContent).toContain('List done: 45%');
    expect(card.textContent).toContain('560 of 1,240 customers');
    expect(within(card).getByRole('progressbar', { name: 'List done, Nov collections' }).getAttribute('aria-valuenow')).toBe('45');
  });

  it('pause a running campaign with the header’s call, and read the board again', async () => {
    mocks.getAgencyHomeBoard.mockResolvedValue(board([onBoard('c1', { name: 'Q4' })]));
    mocks.transitionAgencyCampaign.mockResolvedValue({ id: 'c1', status: 'paused' });
    renderHome();
    const card = await screen.findByTestId('home-campaign-c1');
    const calls = mocks.getAgencyHomeBoard.mock.calls.length;
    fireEvent.click(within(card).getByRole('button', { name: 'Pause Q4' }));
    await waitFor(() => expect(mocks.transitionAgencyCampaign).toHaveBeenCalledWith('c1', 'pause', 't-1', 'a-1'));
    await waitFor(() => expect(mocks.getAgencyHomeBoard.mock.calls.length).toBeGreaterThan(calls));
    expect(mocks.showToast).toHaveBeenCalledWith('Campaign status: Paused.', 'success');
    // Pause asks for no confirmation, as on the campaign header.
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('resume a paused one, re-reading it first as the header does', async () => {
    mocks.getAgencyHomeBoard.mockResolvedValue(board([onBoard('c2', { name: 'Card', status: 'paused' })]));
    mocks.getAgencyCampaign.mockResolvedValue({ id: 'c2', status: 'paused' });
    mocks.transitionAgencyCampaign.mockResolvedValue({ id: 'c2', status: 'running' });
    renderHome();
    fireEvent.click(within(await screen.findByTestId('home-campaign-c2')).getByRole('button', { name: 'Resume Card' }));
    await waitFor(() => expect(mocks.transitionAgencyCampaign).toHaveBeenCalledWith('c2', 'resume', 't-1', 'a-1'));
    expect(mocks.getAgencyCampaign).toHaveBeenCalledWith('c2', 't-1', 'a-1');
  });

  it('offer neither while a campaign is stopping', async () => {
    mocks.getAgencyHomeBoard.mockResolvedValue(board([onBoard('c3', { status: 'stopping' })]));
    renderHome();
    const card = await screen.findByTestId('home-campaign-c3');
    expect(within(card).queryByRole('button')).toBeNull();
  });
});

describe('the request bound', () => {
  it('reads the board in one request, and says when the server capped it', async () => {
    mocks.getAgencyHomeBoard.mockResolvedValue(board(Array.from({ length: 25 }, (_, i) => onBoard(`c${i}`)), { active_total: 30 }));
    renderHome();
    await screen.findByTestId('home-cap-note');
    expect(mocks.getAgencyHomeBoard).toHaveBeenCalledTimes(1);
    expect(mocks.getAgencyHomeBoard).toHaveBeenCalledWith('t-1', 'a-1');
    expect(screen.getByTestId('home-cap-note').textContent).toContain('first 25 of 30 active campaigns');
  });
});

describe('the count it shares with the badge', () => {
  it('comes from Home’s own reads: one request every 10 s with the badge mounted, never one of its own', async () => {
    vi.useFakeTimers();
    try {
      mocks.getAgencyHomeBoard.mockResolvedValue(board([onBoard('c1', { overdue: 2 })]));
      renderHome();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(screen.getByTestId('shared-count').textContent).toBe('1');
      for (let i = 0; i < 6; i += 1) {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(HOME_FAST_MS);
        });
      }
      expect(mocks.getAgencyHomeBoard).toHaveBeenCalledTimes(7);
      expect(screen.getByTestId('shared-count').textContent).toBe('1');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('when Home cannot refresh', () => {
  async function tick(ms: number) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  }

  it('says so with the last time it could, offers Retry, and never says nothing needs you', async () => {
    vi.useFakeTimers();
    try {
      floorRead();
      mocks.getAgencyHomeBoard.mockResolvedValue(board([onBoard('c1')]));
      renderHome();
      await tick(0);
      expect(screen.getByTestId('home-attention-empty')).toBeTruthy();
      mocks.getAgencyHomeBoard.mockRejectedValue(new Error('network'));
      await tick(HOME_FAST_MS * 2);
      expect(screen.queryByTestId('home-stale')).toBeNull();
      await tick(HOME_FAST_MS);
      expect(screen.getByTestId('home-stale').textContent).toMatch(/^Couldn’t refresh\. Last updated \d{1,2}:\d{2}/);
      expect(screen.queryByTestId('home-attention-empty')).toBeNull();
      expect(screen.getByTestId('home-attention-unknown').textContent).toContain('the last time Live floor could check');
      mocks.getAgencyHomeBoard.mockResolvedValue(board([onBoard('c1')]));
      fireEvent.click(within(screen.getByTestId('home-stale')).getByRole('button', { name: /Retry/ }));
      await tick(0);
      expect(screen.queryByTestId('home-stale')).toBeNull();
      expect(screen.getByTestId('home-attention-empty')).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('marks a campaign whose figures the server could not read this time', async () => {
    vi.useFakeTimers();
    try {
      mocks.getAgencyHomeBoard.mockResolvedValue(board([onBoard('c1', { overdue: 2 })]));
      renderHome();
      await tick(0);
      expect(screen.queryByTestId('home-floor-stale')).toBeNull();
      mocks.getAgencyHomeBoard.mockResolvedValue(board([onBoard('c1', { stats: null, overdue: null })]));
      await tick(HOME_FAST_MS);
      expect(screen.getByTestId('home-floor-stale').textContent).toBe('Not refreshed');
      expect(within(screen.getByTestId('home-attention-callbacks-overdue:c1')).getByText('Not refreshed')).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('Got it (acknowledged rows)', () => {
  const twoCampaigns = (overdue: number) => board([
    onBoard('c1', { name: 'Q4 collections', overdue }),
    onBoard('c2', { name: 'Card follow-up', stats: stats({ stall: { code: 'no_carrier_capacity' } }) }),
  ]);

  it('hides a row and takes it off the badge, keeps it behind "N acknowledged · Show", and remembers it for the account', async () => {
    mocks.getAgencyHomeBoard.mockResolvedValue(twoCampaigns(1));
    renderHome();
    const row = await screen.findByTestId('home-attention-callbacks-overdue:c1');
    await waitFor(() => expect(screen.getByTestId('shared-count').textContent).toBe('2'));
    fireEvent.click(within(row).getByRole('button', { name: 'Got it: Q4 collections, 1 callback overdue' }));
    expect(screen.queryByTestId('home-attention-callbacks-overdue:c1')).toBeNull();
    expect(screen.getByTestId('home-attention-stall:c2')).toBeTruthy();
    await waitFor(() => expect(screen.getByTestId('shared-count').textContent).toBe('1'));
    const toggle = within(screen.getByTestId('home-acknowledged')).getByRole('button', { name: '1 acknowledged · Show' });
    expect(screen.queryByTestId('home-acknowledged-list')).toBeNull();
    fireEvent.click(toggle);
    const list = screen.getByTestId('home-acknowledged-list');
    expect(within(list).getByText('1 callback overdue')).toBeTruthy();
    expect(within(list).queryByRole('button', { name: /Got it/ })).toBeNull();
    expect(toggle.textContent).toBe('1 acknowledged · Hide');
    const stored = JSON.parse(window.localStorage.getItem(homeAcksKey('u-1', 't-1', 'a-1'))!);
    expect(stored.acks['callbacks-overdue:c1']).toEqual({ kind: 'callbacks-overdue', tone: 'danger', count: 1 });
  });

  it('brings the row back, and onto the badge, when it gets worse', async () => {
    vi.useFakeTimers();
    try {
      mocks.getAgencyHomeBoard.mockResolvedValue(twoCampaigns(2));
      renderHome();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      fireEvent.click(within(screen.getByTestId('home-attention-callbacks-overdue:c1')).getByRole('button', { name: /Got it/ }));
      expect(screen.getByTestId('shared-count').textContent).toBe('1');
      // Fewer: still aside.
      mocks.getAgencyHomeBoard.mockResolvedValue(twoCampaigns(1));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(HOME_FAST_MS);
      });
      expect(screen.queryByTestId('home-attention-callbacks-overdue:c1')).toBeNull();
      // More than when it was put aside: back.
      mocks.getAgencyHomeBoard.mockResolvedValue(twoCampaigns(3));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(HOME_FAST_MS);
      });
      expect(screen.getByTestId('home-attention-callbacks-overdue:c1')).toBeTruthy();
      expect(screen.getByTestId('shared-count').textContent).toBe('2');
    } finally {
      vi.useRealTimers();
    }
  });

  it('says nothing new needs you when everything is put aside', async () => {
    floorRead();
    mocks.getAgencyHomeBoard.mockResolvedValue(board([onBoard('c1', { overdue: 1 })]));
    renderHome();
    fireEvent.click(within(await screen.findByTestId('home-attention-callbacks-overdue:c1')).getByRole('button', { name: /Got it/ }));
    expect(screen.getByTestId('home-attention-empty').textContent).toContain('Nothing new needs you right now');
  });

  it('is the signed-in reader’s own: another person on this browser still sees the row', async () => {
    mocks.getAgencyHomeBoard.mockResolvedValue(board([onBoard('c1', { overdue: 1 })]));
    const first = renderHome();
    fireEvent.click(within(await screen.findByTestId('home-attention-callbacks-overdue:c1')).getByRole('button', { name: /Got it/ }));
    expect(screen.queryByTestId('home-attention-callbacks-overdue:c1')).toBeNull();
    first.unmount();

    mocks.userId = 'u-2';
    const second = renderHome();
    expect(await screen.findByTestId('home-attention-callbacks-overdue:c1')).toBeTruthy();
    second.unmount();

    mocks.userId = 'u-1';
    renderHome();
    await waitFor(() => expect(screen.getByTestId('home-acknowledged')).toBeTruthy());
    expect(screen.queryByTestId('home-attention-callbacks-overdue:c1')).toBeNull();
  });

  it('offers no "Got it" on more than 99 missed calls: a capped count cannot grow to bring it back', async () => {
    mocks.missed = { available: true, count: { open: 99, open_capped: true, has_rows: true } };
    renderHome();
    const row = await screen.findByTestId('home-attention-missed');
    expect(within(row).queryByRole('button', { name: /Got it/ })).toBeNull();
    expect(within(row).getByRole('link', { name: /Open missed calls/ })).toBeTruthy();
  });

  it('works without storage (a private window): the row is put aside for this page', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('QuotaExceededError'); });
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('SecurityError'); });
    try {
      mocks.getAgencyHomeBoard.mockResolvedValue(board([onBoard('c1', { overdue: 1 })]));
      renderHome();
      fireEvent.click(within(await screen.findByTestId('home-attention-callbacks-overdue:c1')).getByRole('button', { name: /Got it/ }));
      expect(screen.queryByTestId('home-attention-callbacks-overdue:c1')).toBeNull();
      expect(screen.getByTestId('home-acknowledged')).toBeTruthy();
    } finally {
      setItem.mockRestore();
      getItem.mockRestore();
    }
  });
});

describe('Today so far (the tiles)', () => {
  it('links to Analytics by its name, which is where it goes', async () => {
    mocks.getAgencyGroupedStats.mockResolvedValue({ rows: [], total_groups: 0 });
    renderHome();
    const link = await screen.findByRole('link', { name: 'Open Analytics' });
    expect(link.getAttribute('href')).toBe('/agency/analytics');
  });

  it('sums one grouped read from local midnight, by campaign', async () => {
    mocks.getAgencyGroupedStats.mockResolvedValue({
      rows: [
        { key: { campaign_id: 'a' }, attempts: 1200, connected: 400, successes: 30, talk_seconds: 3600, wrapup_seconds: 0 },
        { key: { campaign_id: 'b' }, attempts: 18, connected: 6, successes: 1, talk_seconds: 300, wrapup_seconds: 0 },
      ],
      total_groups: 2,
    });
    renderHome();
    await waitFor(() => expect(screen.getByTestId('kpi-calls').textContent).toBe('Calls today1,218dialled since midnight'));
    // 406 conversations of 1,218 dials.
    expect(screen.getByTestId('kpi-reached').textContent).toBe('Customers reached40633.3% of dials answered');
    // 31 successes of 406 conversations, and what a success is.
    expect(screen.getByTestId('kpi-outcome').textContent).toBe('Successes31Success rate 7.6% of conversations');
    expect(screen.getByText(/A success is a call whose outcome the campaign marks ‘Counts as a success’/)).toBeTruthy();
    expect(mocks.getAgencyGroupedStats).toHaveBeenCalledTimes(1);
    expect(mocks.getAgencyGroupedStats.mock.calls[0]![0]).toMatchObject({ group_by: ['campaign'], limit: 1000 });
  });

  it('prints no numbers when the read fails', async () => {
    mocks.getAgencyGroupedStats.mockRejectedValue(new Error('nope'));
    renderHome();
    expect(await screen.findByText('Today’s numbers didn’t load.')).toBeTruthy();
    expect(screen.getByTestId('kpi-calls').textContent).toBe('Calls today—dialled since midnight');
    expect(screen.getByTestId('kpi-outcome').textContent).toBe('Successes—');
  });
});

describe('Needs you now, as Live floor shows it', () => {
  it('orders what stopped a campaign first, then late callbacks, then warnings (LF9)', async () => {
    mocks.getAgencyHomeBoard.mockResolvedValue(board([
      onBoard('c1', { stats: stats({ stall: { code: 'no_agents_available', agents_on_shift: 0, on_break_by_reason: {}, on_call: 0, last_dial_at: null } }), overdue: 2 }),
      onBoard('c2', { stats: stats({ stall: { code: 'dnc_unavailable', tenant_wide: true } }) }),
    ]));
    renderHome();
    const list = await screen.findByTestId('home-attention');
    expect(within(list).getAllByRole('listitem').map((li) => li.getAttribute('data-testid'))).toEqual([
      'home-attention-stall:c2',
      'home-attention-callbacks-overdue:c1',
      'home-attention-stall:c1',
    ]);
    expect(screen.getByTestId('home-attention-count').textContent).toBe('3, 3');
  });

  it('groups the campaigns on the default calling hours into one row, whose Review lists each to its settings', async () => {
    const hours = { calling_hours_default: true, record_calls: false, calling_window_start: '09:00', calling_window_end: '20:00', calling_days: [1, 2, 3, 4, 5] };
    mocks.getAgencyHomeBoard.mockResolvedValue(board([
      onBoard('c1', { name: 'Q4', settings: hours }),
      onBoard('c2', { name: 'Gold', settings: hours }),
    ]));
    renderHome();
    const row = await screen.findByTestId('home-attention-calling-hours-default');
    expect(screen.queryByTestId('home-attention-calling-hours-default:c1')).toBeNull();
    expect(within(screen.getByTestId('home-waiting')).getByText('2 campaigns still use the default calling hours')).toBeTruthy();
    const review = within(row).getByRole('button', { name: /Review/ });
    expect(review.getAttribute('aria-expanded')).toBe('false');
    expect(screen.getByTestId('home-review-calling-hours-default').hidden).toBe(true);
    fireEvent.click(review);
    expect(review.getAttribute('aria-expanded')).toBe('true');
    const list = screen.getByTestId('home-review-calling-hours-default');
    expect(review.getAttribute('aria-controls')).toBe(list.id);
    expect(within(list).getAllByRole('link').map((a) => [a.textContent, a.getAttribute('href')])).toEqual([
      ['Q4', '/agency/campaigns/c1/settings#calling-hours'],
      ['Gold', '/agency/campaigns/c2/settings#calling-hours'],
    ]);
    // Information: the badge does not count it.
    await waitFor(() => expect(screen.getByTestId('shared-count').textContent).toBe('0'));
  });

  it('offers "Give to free agents" on late callbacks whose agent is away, as a disabled control that is coming soon', async () => {
    const away = onBoard('c1', { name: 'Gold' });
    away.allocation = { ...away.allocation!, callbacks_overdue: 4, callbacks_overdue_absent_owner: 4 };
    mocks.getAgencyHomeBoard.mockResolvedValue(board([away, onBoard('c2', { overdue: 2 })]));
    renderHome();
    const row = await screen.findByTestId('home-attention-callbacks-overdue:c1');
    const give = within(row).getByRole('button', { name: 'Give to free agents' });
    expect(give.getAttribute('aria-disabled')).toBe('true');
    const described = document.getElementById(give.getAttribute('aria-describedby')!)!.textContent;
    expect(described).toBe('Give the 4 late callbacks whose agent is away to agents who are free now. Coming soon.');
    expect(within(row).getByText('Coming soon')).toBeTruthy();
    // The existing way to the fix stays beside it.
    expect(within(row).getByRole('link', { name: /Open callbacks/ }).getAttribute('href')).toBe('/agency/campaigns/c1/callbacks');
    // Not on late callbacks whose owners are here.
    expect(within(screen.getByTestId('home-attention-callbacks-overdue:c2')).queryByRole('button', { name: 'Give to free agents' })).toBeNull();
  });
});
