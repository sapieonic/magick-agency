import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CampaignTabs, tabBadge } from '../../components/agency/CampaignTabs';
import {
  TAB_BADGE_FRESH_MS,
  publishCampaignTabBadge,
  resetCampaignTabBadgesForTests,
} from '../../hooks/useCampaignTabBadges';

/**
 * The campaign bar on its own, as the standalone screens (Contacts, Call log,
 * Settings, History) render it: with no counts handed in. QA found the Agents
 * badge on the five Monitor tabs only, and the bar a different width per screen.
 */

const mocks = vi.hoisted(() => ({
  getAgencyCampaignStats: vi.fn(),
  getInsightsAllocation: vi.fn(),
}));
vi.mock('../../contexts/TenantContext', () => ({
  useTenant: () => ({ tenantId: 'tenant-1', accountId: 'account-1', role: 'tenant_owner' }),
}));
vi.mock('../../api/agencyCampaigns', () => ({ getAgencyCampaignStats: mocks.getAgencyCampaignStats }));
vi.mock('../../api/agencyInsights', () => ({ getInsightsAllocation: mocks.getInsightsAllocation }));

const agent = (session_id: string, state: string) => ({ session_id, agent_user_id: session_id, state });

beforeEach(() => {
  vi.clearAllMocks();
  resetCampaignTabBadgesForTests();
  // The server's on-shift count: a and b, not c, who is offline.
  mocks.getAgencyCampaignStats.mockResolvedValue({ agents_live: 2, agents: [agent('a', 'available'), agent('b', 'on_call'), agent('c', 'offline')] });
  mocks.getInsightsAllocation.mockResolvedValue({ totals: { callbacks_overdue: 14 } });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function show(props: Partial<Parameters<typeof CampaignTabs>[0]> = {}) {
  return render(
    <MemoryRouter>
      <CampaignTabs campaignId="camp-1" active="settings" role="tenant_owner" {...props} />
    </MemoryRouter>,
  );
}

describe('campaign tab bar', () => {
  it('badges Agents with the agents on shift on a screen that hands in no count, read once', async () => {
    show();
    const badge = await screen.findByTestId('campaign-tab-agents-count');
    // Three rows, one offline: two on shift, the floor's own definition.
    expect(badge.textContent).toBe('2');
    expect(mocks.getAgencyCampaignStats).toHaveBeenCalledTimes(1);
    expect(mocks.getAgencyCampaignStats).toHaveBeenCalledWith('camp-1', 'tenant-1', 'account-1');
  });

  it('takes the host’s count when it has one, and reads nothing itself', async () => {
    show({ agentsOnShift: 3, callbacksOverdue: 0 });
    expect(screen.getByTestId('campaign-tab-agents-count').textContent).toBe('3');
    await waitFor(() => expect(screen.queryByTestId('campaign-tab-callbacks-alert')).toBeNull());
    expect(mocks.getAgencyCampaignStats).not.toHaveBeenCalled();
    expect(mocks.getInsightsAllocation).not.toHaveBeenCalled();
  });

  it('shares its reads: two bars at once make one of each, and the next screen inside 30 s none', async () => {
    show();
    show({ active: 'contacts' });
    await waitFor(() => expect(screen.getAllByTestId('campaign-tab-agents-count')).toHaveLength(2));
    expect(mocks.getAgencyCampaignStats).toHaveBeenCalledTimes(1);
    expect(mocks.getInsightsAllocation).toHaveBeenCalledTimes(1);
    cleanup();

    show({ active: 'attempts' });
    expect(screen.getByTestId('campaign-tab-agents-count').textContent).toBe('2');
    expect(screen.getByTestId('campaign-tab-callbacks-alert').textContent).toBe('14');
    expect(mocks.getAgencyCampaignStats).toHaveBeenCalledTimes(1);
    expect(mocks.getInsightsAllocation).toHaveBeenCalledTimes(1);
  });

  it('reads again once the shared count is over 30 s old', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    show();
    await screen.findByTestId('campaign-tab-agents-count');
    cleanup();
    vi.setSystemTime(Date.now() + TAB_BADGE_FRESH_MS);
    show();
    await waitFor(() => expect(mocks.getAgencyCampaignStats).toHaveBeenCalledTimes(2));
  });

  it('takes a count the detail page published, and reads nothing itself', () => {
    publishCampaignTabBadge('onShift', 'tenant-1', 'account-1', 'camp-1', 5);
    publishCampaignTabBadge('overdue', 'tenant-1', 'account-1', 'camp-1', 3);
    show();
    expect(screen.getByTestId('campaign-tab-agents-count').textContent).toBe('5');
    expect(screen.getByTestId('campaign-tab-callbacks-alert').textContent).toBe('3');
    expect(mocks.getAgencyCampaignStats).not.toHaveBeenCalled();
    expect(mocks.getInsightsAllocation).not.toHaveBeenCalled();
  });

  it('gives each badged tab one accessible name, with the count said once', async () => {
    show();
    const callbacks = await screen.findByRole('link', { name: 'Callbacks, 14 overdue' });
    expect(callbacks.textContent).toBe('Callbacks14');
    expect(await screen.findByRole('link', { name: 'Agents, 2 on shift' })).toBeTruthy();
    for (const id of ['campaign-tab-agents-count', 'campaign-tab-callbacks-alert']) {
      expect(screen.getByTestId(id).getAttribute('aria-hidden')).toBe('true');
    }
    // An unbadged tab keeps its own words as its name.
    expect(screen.getByRole('link', { name: 'Settings' })).toBeTruthy();
  });

  it('shows no Agents badge when nobody is on shift, or when the rows are not known', () => {
    expect(tabBadge('agents', 0, null)).toBeNull();
    expect(tabBadge('agents', null, null)).toBeNull();
    expect(tabBadge('callbacks', null, 0)).toBeNull();
    expect(tabBadge('overview', 4, 4)).toBeNull();
  });

  it('is as wide as its tabs, never as wide as the host page, so it does not move between screens', () => {
    const css = readFileSync(resolve(__dirname, '../../components/agency/CampaignTabs.module.css'), 'utf-8');
    const tabs = /\.tabs \{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(tabs).toMatch(/width:\s*fit-content/);
    expect(tabs).toMatch(/max-width:\s*100%/);
  });
});

describe('the current tab on a bar that scrolls (a phone)', () => {
  /*
    jsdom lays nothing out, so the bar's geometry is stated: 360px wide over 640px of tabs,
    each tab 80px, in bar order; the bar's box at x = 0.
  */
  function withGeometry() {
    const box = (left: number, width: number) =>
      ({ left, right: left + width, width, top: 0, bottom: 40, height: 40, x: left, y: 0, toJSON: () => ({}) }) as DOMRect;
    const spies = [
      vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockImplementation(function (this: HTMLElement) {
        return this.tagName === 'NAV' ? 640 : 0;
      }),
      vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (this: HTMLElement) {
        return this.tagName === 'NAV' ? 360 : 0;
      }),
      vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
        if (this.tagName === 'NAV') return box(0, 360);
        const tabs = [...document.querySelectorAll('[data-testid^="campaign-tab-"]')].filter((el) => el.tagName === 'A');
        const nav = this.closest('nav') as HTMLElement;
        return box(tabs.indexOf(this) * 80 - nav.scrollLeft, 80);
      }),
    ];
    return () => spies.forEach((spy) => spy.mockRestore());
  }

  it('scrolls the bar so the current tab is in sight, centred', () => {
    const restore = withGeometry();
    try {
      show({ active: 'settings', agentsOnShift: 0, callbacksOverdue: 0 });
      const nav = screen.getByTestId('campaign-tabs');
      const tabs = [...nav.querySelectorAll('a')];
      const index = tabs.findIndex((a) => a.getAttribute('aria-current') === 'page');
      expect(index).toBeGreaterThan(4);
      expect(nav.scrollLeft).toBe(index * 80 - (360 - 80) / 2);
    } finally {
      restore();
    }
  });

  it('leaves the bar where it is when the current tab is already in sight', () => {
    const restore = withGeometry();
    try {
      show({ active: 'overview', agentsOnShift: 0, callbacksOverdue: 0 });
      expect(screen.getByTestId('campaign-tabs').scrollLeft).toBe(0);
    } finally {
      restore();
    }
  });
});
