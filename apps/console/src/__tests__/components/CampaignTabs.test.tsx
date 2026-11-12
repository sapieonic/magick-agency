import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CampaignTabs, tabBadge } from '../../components/agency/CampaignTabs';

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
  mocks.getAgencyCampaignStats.mockResolvedValue({ agents: [agent('a', 'available'), agent('b', 'on_call'), agent('c', 'offline')] });
  mocks.getInsightsAllocation.mockResolvedValue({ totals: { callbacks_overdue: 14 } });
});
afterEach(cleanup);

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
