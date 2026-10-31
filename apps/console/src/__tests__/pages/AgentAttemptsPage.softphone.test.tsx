import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, act, fireEvent, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const mocks = vi.hoisted(() => ({
  useTenant: vi.fn(),
  getMyAttempts: vi.fn(),
  getAgentAttempts: vi.fn(),
  getMyCampaigns: vi.fn(),
  getMyStats: vi.fn(),
  getAgentStats: vi.fn(),
  getSoftphoneBootstrap: vi.fn(),
  listManualCalls: vi.fn(),
  flags: new Set<string>(),
}));
vi.mock('../../contexts/TenantContext', () => ({ useTenant: mocks.useTenant }));
vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'u-1', display_name: 'Priya Nair', email: 'p@x', avatar_url: null } }),
}));
vi.mock('../../contexts/FeatureFlagsContext', () => ({
  useFeatureFlags: () => ({ isEnabled: (flag: string) => mocks.flags.has(flag) }),
}));
vi.mock('../../api/agencyStats', () => ({
  getMyAttempts: mocks.getMyAttempts,
  getAgentAttempts: mocks.getAgentAttempts,
  getMyCampaigns: mocks.getMyCampaigns,
  getMyStats: mocks.getMyStats,
  getAgentStats: mocks.getAgentStats,
}));
vi.mock('../../api/softphone', () => ({
  getSoftphoneBootstrap: mocks.getSoftphoneBootstrap,
  listManualCalls: mocks.listManualCalls,
}));

import { AgentAttemptsPage } from '../../pages/agency/AgentAttemptsPage';
import { BOOTSTRAP, manualCall } from '../helpers/softphone';

/**
 * "My calls" includes the agent's soft-phone calls (`docs/softphone.md` §7) as
 * a second tab: a manual call is not an attempt, so interleaving them would make
 * every column mean two things.
 */

beforeEach(() => {
  Object.values(mocks).forEach((m) => (typeof m === 'function' && 'mockReset' in m ? m.mockReset() : undefined));
  mocks.useTenant.mockReturnValue({ tenantId: 't-1', accountId: 'a-1', role: 'agent', accountResolution: 'ready', accountError: null, reloadAccounts: vi.fn() });
  mocks.getMyAttempts.mockResolvedValue({ rows: [], next_cursor: null, limit: 50 });
  mocks.getMyCampaigns.mockResolvedValue([]);
  mocks.getSoftphoneBootstrap.mockResolvedValue(BOOTSTRAP);
  mocks.listManualCalls.mockResolvedValue({
    rows: [manualCall({ state: 'ended', outcome: 'connected', disposition_code: 'resolved', disposition_source: 'softphone', settled_at: 'x' })],
    next_cursor: null,
    limit: 50,
  });
});
afterEach(cleanup);

async function renderPage(entry = '/dialer/attempts') {
  render(
    <MemoryRouter initialEntries={[entry]}>
      <AgentAttemptsPage />
    </MemoryRouter>,
  );
  await act(async () => {});
}

describe('My calls — soft-phone calls', () => {
  it('has no tabs while the soft phone is off', async () => {
    await renderPage();
    expect(screen.queryByRole('tablist')).toBeNull();
    expect(mocks.listManualCalls).not.toHaveBeenCalled();
  });

  it('adds a Soft-phone calls tab with the flag on, scoped to the agent', async () => {
    mocks.flags = new Set(['agency_softphone_enabled']);
    await renderPage();
    const tabs = screen.getAllByRole('tab').map((t) => t.textContent);
    expect(tabs).toEqual(['Campaign calls', 'Soft-phone calls']);
    expect(screen.getByTestId('my-calls-tab-campaign').getAttribute('aria-selected')).toBe('true');
    await act(async () => {
      fireEvent.click(screen.getByTestId('my-calls-tab-softphone'));
    });
    expect(mocks.listManualCalls.mock.calls[0]![0]).toMatchObject({ agent_user_id: 'u-1', limit: 50 });
    expect(screen.getByTestId('softphone-row-mc-1').textContent).toMatch(/Query resolved/);
    // The agent's own list has no Agent column and no agent filter.
    expect(screen.queryByTestId('filter-agent')).toBeNull();
  });

  it('opens on the soft-phone tab from ?view=softphone, and arrows move between tabs', async () => {
    mocks.flags = new Set(['agency_softphone_enabled']);
    await renderPage('/dialer/attempts?view=softphone');
    expect(screen.getByTestId('my-calls-tab-softphone').getAttribute('aria-selected')).toBe('true');
    await act(async () => {
      fireEvent.keyDown(screen.getByTestId('my-calls-tab-softphone'), { key: 'ArrowLeft' });
    });
    expect(screen.getByTestId('my-calls-tab-campaign').getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(screen.getByTestId('my-calls-tab-campaign'));
  });
});
