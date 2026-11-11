import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { campaign, stats } from '../helpers/home';

/**
 * Home (B28): the gate, the three sections, their links and states, the request bound, and the
 * count it shares with the sidebar badge.
 */

const mocks = vi.hoisted(() => ({
  role: 'account_admin' as string | undefined,
  listAgencyCampaigns: vi.fn(),
  listAgencyCampaignsPage: vi.fn(),
  getAgencyCampaignStats: vi.fn(),
  getInsightsAllocation: vi.fn(),
  getAgencyGroupedStats: vi.fn(),
  missed: { available: false, count: null as null | { open: number; open_capped: boolean; has_rows: boolean } },
}));

vi.mock('../../contexts/TenantContext', () => ({
  useTenant: () => ({ role: mocks.role, tenantId: 't-1', accountId: 'a-1', accounts: [{ id: 'a-1', name: 'Pune Collections' }] }),
}));
vi.mock('../../api/agencyCampaigns', () => ({
  listAgencyCampaigns: mocks.listAgencyCampaigns,
  listAgencyCampaignsPage: mocks.listAgencyCampaignsPage,
  getAgencyCampaignStats: mocks.getAgencyCampaignStats,
  getAgencyCampaign: vi.fn(),
}));
vi.mock('../../api/agencyInsights', () => ({ getInsightsAllocation: mocks.getInsightsAllocation }));
vi.mock('../../api/agencyStats', () => ({ getAgencyGroupedStats: mocks.getAgencyGroupedStats }));
vi.mock('../../hooks/useMissedCallsAccess', () => ({
  useMissedCallsAccess: () => ({ ...mocks.missed, inboundOn: true, settled: true }),
}));

import HomePage from '../../pages/agency/HomePage';
import { resetHomeAttentionCountForTests, useHomeAttentionCount } from '../../hooks/useHomeAttentionCount';

function Where() {
  return <div data-testid="where">{useLocation().pathname}</div>;
}

function Badge() {
  return <div data-testid="shared-count">{String(useHomeAttentionCount('t-1/a-1'))}</div>;
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

const allocation = (overdue: number) => ({ totals: { callbacks_overdue: overdue } });

beforeEach(() => {
  vi.clearAllMocks();
  resetHomeAttentionCountForTests();
  mocks.role = 'account_admin';
  mocks.missed = { available: false, count: null };
  mocks.listAgencyCampaigns.mockResolvedValue([]);
  mocks.listAgencyCampaignsPage.mockResolvedValue({ campaigns: [], total: 3 });
  mocks.getAgencyCampaignStats.mockResolvedValue(stats());
  mocks.getInsightsAllocation.mockResolvedValue(allocation(0));
  mocks.getAgencyGroupedStats.mockResolvedValue({ rows: [], total_groups: 0 });
});
afterEach(() => cleanup());

describe('the gate', () => {
  it.each(['viewer', 'operator', 'agent'] as const)('sends a %s back to /agency, reading nothing', async (role) => {
    mocks.role = role;
    renderHome();
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('/agency'));
    expect(mocks.listAgencyCampaigns).not.toHaveBeenCalled();
    expect(mocks.getAgencyGroupedStats).not.toHaveBeenCalled();
  });

  it('waits while the role is unresolved', () => {
    mocks.role = undefined;
    renderHome();
    expect(screen.queryByTestId('where')).toBeNull();
    expect(mocks.listAgencyCampaigns).not.toHaveBeenCalled();
  });
});

describe('Needs your attention', () => {
  it('lists each condition with its action linking to the exact tab, and shares the count', async () => {
    mocks.listAgencyCampaigns.mockResolvedValue([campaign('c1', 'running', 'Q4 collections'), campaign('c2', 'paused', 'Card follow-up')]);
    mocks.getAgencyCampaignStats.mockImplementation(async (id: string) =>
      id === 'c1'
        ? stats({ agents_live: 2, abandoned_24h: 3, answered_24h: 100 })
        : stats({ stall: { code: 'auto_paused_abandonment', measured_pct: 3.4, ceiling_pct: 3, paused_at: '2026-11-11T09:12:00Z' } }));
    mocks.getInsightsAllocation.mockImplementation(async (id: string) => allocation(id === 'c1' ? 7 : 0));
    mocks.missed = { available: true, count: { open: 3, open_capped: false, has_rows: true } };

    renderHome();

    const list = await screen.findByTestId('home-attention');
    const link = (id: string) => within(screen.getByTestId(`home-attention-${id}`)).getByRole('link');
    expect(link('callbacks:c1').getAttribute('href')).toBe('/agency/campaigns/c1/callbacks');
    expect(link('stall:c2').getAttribute('href')).toBe('/agency/campaigns/c2/health');
    expect(link('abandonment:c1').getAttribute('href')).toBe('/agency/campaigns/c1/health');
    expect(link('missed').getAttribute('href')).toBe('/agency/inbound/missed');
    expect(within(list).getAllByRole('listitem')).toHaveLength(4);
    expect(screen.getByText('Each item clears itself once it’s fixed')).toBeTruthy();
    expect(screen.getByText('7 callbacks overdue')).toBeTruthy();
    await waitFor(() => expect(screen.getByTestId('shared-count').textContent).toBe('4'));
  });

  it('says nothing needs you when nothing does', async () => {
    mocks.listAgencyCampaigns.mockResolvedValue([campaign('c1')]);
    renderHome();
    expect((await screen.findByTestId('home-attention-empty')).textContent).toContain('Nothing needs you right now');
    await waitFor(() => expect(screen.getByTestId('shared-count').textContent).toBe('0'));
  });
});

describe('Floor right now', () => {
  it('has a row per running campaign linking to its Agents tab', async () => {
    mocks.listAgencyCampaigns.mockResolvedValue([campaign('c1', 'running', 'Diwali renewals'), campaign('c2', 'paused')]);
    mocks.getAgencyCampaignStats.mockImplementation(async (id: string) =>
      stats(id === 'c1'
        ? { agents_live: 4, agents_by_state: { offline: 0, available: 1, reserved: 0, on_call: 2, wrapup: 1, break: 0 } }
        : {}));
    renderHome();
    const table = await screen.findByTestId('home-floor');
    const links = within(table).getAllByRole('link');
    expect(links.map((a) => [a.textContent, a.getAttribute('href')])).toEqual([['Diwali renewals', '/agency/campaigns/c1/agents']]);
    expect(screen.getByTestId('home-summary').textContent).toBe('1 campaign running · 4 agents on the floor');
  });

  it('says so when nothing is running, and offers the new-campaign button', async () => {
    mocks.listAgencyCampaigns.mockResolvedValue([]);
    renderHome();
    expect((await screen.findByTestId('home-floor-empty')).textContent).toContain('No campaign is running');
    expect(screen.getByRole('link', { name: /New campaign/ }).getAttribute('href')).toBe('/agency/campaigns/new');
  });

  it('shows the get-started card for an account with no campaigns at all', async () => {
    mocks.listAgencyCampaignsPage.mockResolvedValue({ campaigns: [], total: 0 });
    renderHome();
    expect(await screen.findByText('Launch your first campaign')).toBeTruthy();
    expect(screen.queryByTestId('home-floor')).toBeNull();
    // One button, on the card: the header's is left out.
    expect(screen.getAllByRole('link', { name: /New campaign/ })).toHaveLength(1);
  });

  it('shows the error with a retry when the campaigns do not load', async () => {
    mocks.listAgencyCampaigns.mockRejectedValue(new Error('Could not reach the server'));
    renderHome();
    expect(await screen.findByText(/Could not reach the server/)).toBeTruthy();
  });
});

describe('the request bound', () => {
  it('reads the active statuses once and per-campaign data for 25 campaigns at most', async () => {
    mocks.listAgencyCampaigns.mockResolvedValue(Array.from({ length: 30 }, (_, i) => campaign(`c${i}`)));
    renderHome();
    await screen.findByTestId('home-cap-note');
    expect(mocks.listAgencyCampaigns).toHaveBeenCalledTimes(1);
    expect(mocks.listAgencyCampaigns).toHaveBeenCalledWith('t-1', 'a-1', ['running', 'stopping', 'paused']);
    expect(mocks.getAgencyCampaignStats).toHaveBeenCalledTimes(25);
    expect(mocks.getInsightsAllocation).toHaveBeenCalledTimes(25);
    expect(screen.getByTestId('home-cap-note').textContent).toContain('first 25 of 30 active campaigns');
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
