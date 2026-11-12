import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen, cleanup, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { board, onBoard, stats } from '../helpers/home';

/**
 * Home (B28): the gate, the three sections, their links and states, the request bound, and the
 * count it shares with the sidebar badge.
 */

const mocks = vi.hoisted(() => ({
  role: 'account_admin' as string | undefined,
  getAgencyHomeBoard: vi.fn(),
  getAgencyGroupedStats: vi.fn(),
  missed: { available: false, count: null as null | { open: number; open_capped: boolean; has_rows: boolean } },
}));

vi.mock('../../contexts/TenantContext', () => ({
  useTenant: () => ({ role: mocks.role, tenantId: 't-1', accountId: 'a-1', accounts: [{ id: 'a-1', name: 'Pune Collections' }] }),
}));
vi.mock('../../api/agencyHome', () => ({ getAgencyHomeBoard: mocks.getAgencyHomeBoard }));
vi.mock('../../api/agencyStats', () => ({ getAgencyGroupedStats: mocks.getAgencyGroupedStats }));
vi.mock('../../hooks/useMissedCallsAccess', () => ({
  useMissedCallsAccess: () => ({ ...mocks.missed, inboundOn: true, settled: true }),
}));

import HomePage from '../../pages/agency/HomePage';
import { HOME_BOARD_ERROR, HOME_FAST_MS, useHomeBadgeCount } from '../../hooks/useHomeBoard';

function Where() {
  return <div data-testid="where">{useLocation().pathname}</div>;
}

/** The sidebar badge's count, read from the board Home reads; offered, as in the sidebar, only past Home's gate. */
function Badge() {
  return mocks.role === 'account_admin' ? <BadgeCount /> : null;
}

function BadgeCount() {
  const count = useHomeBadgeCount('t-1', 'a-1', { available: mocks.missed.available, count: mocks.missed.count });
  return <div data-testid="shared-count">{String(count)}</div>;
}

function renderHome() {
  return render(
    <MemoryRouter initialEntries={['/agency/home']}>
      <Routes>
        <Route path="/agency/home" element={<><HomePage /><Badge /></>} />
        <Route path="*" element={<Where />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.role = 'account_admin';
  mocks.missed = { available: false, count: null };
  mocks.getAgencyHomeBoard.mockResolvedValue(board([], { any_campaign: true }));
  mocks.getAgencyGroupedStats.mockResolvedValue({ rows: [], total_groups: 0 });
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

describe('Needs your attention', () => {
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
    expect(screen.getByText('Each item clears itself once it’s fixed')).toBeTruthy();
    expect(screen.getByText('7 callbacks overdue')).toBeTruthy();
    // Four rows; the badge counts three: the missed calls are the Inbound badge's.
    await waitFor(() => expect(screen.getByTestId('shared-count').textContent).toBe('3'));
  });

  it('shows a campaign that is only waiting apart, muted, and leaves it out of the count', async () => {
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
    mocks.getAgencyHomeBoard.mockResolvedValue(board([onBoard('c1')]));
    renderHome();
    expect((await screen.findByTestId('home-attention-empty')).textContent).toContain('Nothing needs you right now');
    await waitFor(() => expect(screen.getByTestId('shared-count').textContent).toBe('0'));
  });
});

describe('Floor right now', () => {
  it('has a row per running campaign linking to its Agents tab', async () => {
    mocks.getAgencyHomeBoard.mockResolvedValue(board([
      onBoard('c1', {
        name: 'Diwali renewals',
        stats: stats({ agents_live: 4, agents_by_state: { offline: 0, available: 1, reserved: 0, on_call: 2, wrapup: 1, break: 0 } }),
      }),
      onBoard('c2', { status: 'paused' }),
    ]));
    renderHome();
    const table = await screen.findByTestId('home-floor');
    const links = within(table).getAllByRole('link');
    expect(links.map((a) => [a.textContent, a.getAttribute('href')])).toEqual([['Diwali renewals', '/agency/campaigns/c1/agents']]);
    expect(screen.getByTestId('home-summary').textContent).toBe('1 campaign running · 4 agents on the floor');
  });

  it('says so when nothing is running, and offers the new-campaign button', async () => {
    renderHome();
    expect((await screen.findByTestId('home-floor-empty')).textContent).toContain('No campaign is running');
    expect(screen.getByRole('link', { name: /New campaign/ }).getAttribute('href')).toBe('/agency/campaigns/new');
  });

  it('shows the get-started card for an account with no campaigns at all', async () => {
    mocks.getAgencyHomeBoard.mockResolvedValue(board([], { any_campaign: false }));
    renderHome();
    expect(await screen.findByText('Launch your first campaign')).toBeTruthy();
    expect(screen.queryByTestId('home-floor')).toBeNull();
    // One button, on the card: the header's is left out.
    expect(screen.getAllByRole('link', { name: /New campaign/ })).toHaveLength(1);
  });

  it('says so in its own words, with a retry, when the board does not load: never the server’s text', async () => {
    mocks.getAgencyHomeBoard.mockRejectedValue(new Error('Route GET:/proxy/agency/home not found'));
    renderHome();
    expect(await screen.findByText(HOME_BOARD_ERROR)).toBeTruthy();
    expect(screen.queryByText(/Route GET|not found/)).toBeNull();

    mocks.getAgencyHomeBoard.mockResolvedValue(board([onBoard('c1')]));
    fireEvent.click(screen.getByRole('button', { name: /Retry/ }));
    expect(await screen.findByTestId('home-attention-empty')).toBeTruthy();
    expect(screen.queryByText(HOME_BOARD_ERROR)).toBeNull();
  });

  it('still shows Today so far when the board does not load: it is its own read', async () => {
    mocks.getAgencyHomeBoard.mockRejectedValue(new Error('nope'));
    mocks.getAgencyGroupedStats.mockResolvedValue({
      rows: [{ key: { campaign_id: 'a' }, attempts: 12, connected: 4, successes: 1, talk_seconds: 60, wrapup_seconds: 0 }],
      total_groups: 1,
    });
    renderHome();
    await screen.findByText(HOME_BOARD_ERROR);
    expect((await screen.findByTestId('home-today')).textContent).toContain('Across 1 campaign');
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

describe('Today so far', () => {
  it('sums one grouped read from local midnight, by campaign', async () => {
    mocks.getAgencyGroupedStats.mockResolvedValue({
      rows: [
        { key: { campaign_id: 'a' }, attempts: 1200, connected: 400, successes: 30, talk_seconds: 3600, wrapup_seconds: 0 },
        { key: { campaign_id: 'b' }, attempts: 18, connected: 6, successes: 1, talk_seconds: 300, wrapup_seconds: 0 },
      ],
      total_groups: 2,
    });
    renderHome();
    const tiles = await screen.findByTestId('home-today');
    expect(tiles.textContent).toContain('1,218');
    expect(tiles.textContent).toContain('Across 2 campaigns');
    expect(tiles.textContent).toContain('1h 5m');
    // 31 successes of 406 conversations, and what a success is.
    expect(tiles.textContent).toContain('Success rate 7.6% of conversations');
    expect(screen.getByText(/A success is a call whose outcome the campaign marks ‘Counts as a success’/)).toBeTruthy();
    expect(mocks.getAgencyGroupedStats).toHaveBeenCalledTimes(1);
    expect(mocks.getAgencyGroupedStats.mock.calls[0]![0]).toMatchObject({ group_by: ['campaign'], limit: 1000 });
  });

  it('prints no numbers when the read fails', async () => {
    mocks.getAgencyGroupedStats.mockRejectedValue(new Error('nope'));
    renderHome();
    expect(await screen.findByText('Today’s numbers didn’t load.')).toBeTruthy();
    expect(screen.queryByTestId('home-today')).toBeNull();
  });
});
