import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, act, cleanup } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { WithPageCrumbs, suppliedCrumbs } from '../helpers/pageCrumbs';
import { noLineage, workspaceStats } from '../helpers/campaignWorkspace';
import { liveCall } from '../helpers/liveCalls';

/**
 * The two Live calls pages (`docs/listening.md` §9): the account's at `/agency/live`, and a
 * campaign's Calls tab's Live view at `/agency/campaigns/:id/calls/live`, in the campaign's
 * workspace with Calls marked and "Summary | Live" above the table, amber from the campaign's own
 * average handle time.
 */

const mocks = vi.hoisted(() => ({
  listLiveCalls: vi.fn(),
  getAgencyCampaign: vi.fn(),
  getAgencyCampaignStats: vi.fn(),
  campaignLineage: vi.fn(),
}));

vi.mock('../../api/liveCalls', () => ({
  listLiveCalls: mocks.listLiveCalls,
  revealLiveCallNumber: vi.fn(),
  grantListen: vi.fn(),
}));
vi.mock('../../api/agencyCampaigns', () => ({
  getAgencyCampaign: mocks.getAgencyCampaign,
  getAgencyCampaignStats: mocks.getAgencyCampaignStats,
  campaignLineage: mocks.campaignLineage,
}));
vi.mock('../../contexts/TenantContext', () => ({
  useTenant: () => ({ tenantId: 't-1', accountId: 'a-1', role: 'account_admin' }),
}));
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'me' } }) }));
vi.mock('../../contexts/FeatureFlagsContext', () => ({
  useFeatureFlags: () => ({ isEnabled: () => true, status: 'ready' }),
}));
vi.mock('../../contexts/GovernanceContext', () => ({
  useGovernance: () => ({ isEnabled: () => true, loading: false, map: {}, refresh: vi.fn() }),
}));
vi.mock('@magick-agency/web-ui/contexts/ToastContext', () => ({
  useToast: () => ({ showToast: vi.fn(), showErrorToast: vi.fn() }),
}));

import LiveCallsPage from '../../pages/agency/live/LiveCallsPage';
import AgencyCampaignLiveCallsPage from '../../pages/agency/AgencyCampaignLiveCallsPage';
import { ListenProvider } from '../../components/listen/ListenProvider';

const NOW = new Date('2026-11-16T10:10:00Z').getTime();
const LONG = liveCall({ call_id: 'c-long', connected_at: '2026-11-16T10:00:00Z' }); // 10:00 on call
const SHORT = liveCall({ call_id: 'c-short', connected_at: '2026-11-16T10:08:00Z' }); // 2:00

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(NOW);
  Object.values(mocks).forEach((m) => m.mockReset());
  mocks.listLiveCalls.mockResolvedValue({ calls: [LONG, SHORT], as_of: new Date(NOW).toISOString() });
  mocks.getAgencyCampaign.mockResolvedValue({ id: 'camp-1', name: 'Home Loan Renewals', status: 'running' });
  mocks.getAgencyCampaignStats.mockResolvedValue(workspaceStats({ aht_seconds: 200 }));
  mocks.campaignLineage.mockResolvedValue(noLineage());
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('/agency/live', () => {
  it('is the account’s live table under an h1, with its description', async () => {
    render(
      <MemoryRouter>
        <ListenProvider>
          <LiveCallsPage />
        </ListenProvider>
      </MemoryRouter>,
    );
    await act(async () => {});
    expect(mocks.listLiveCalls).toHaveBeenCalledWith({}, 't-1', 'a-1');
    expect(screen.getByRole('heading', { level: 1, name: 'Live calls' })).toBeTruthy();
    expect(screen.getByTestId('live-calls-campaign-filter')).toBeTruthy();
  });
});

describe('/agency/campaigns/:id/calls/live', () => {
  async function renderCampaignLive() {
    render(
      <MemoryRouter initialEntries={['/agency/campaigns/camp-1/calls/live']}>
        <WithPageCrumbs>
          <ListenProvider>
            <Routes>
              <Route path="/agency/campaigns/:id/calls/live" element={<AgencyCampaignLiveCallsPage />} />
            </Routes>
          </ListenProvider>
        </WithPageCrumbs>
      </MemoryRouter>,
    );
    await act(async () => {});
    await act(async () => {});
  }

  it('reads this campaign’s calls, in its workspace, with Calls marked and Live chosen', async () => {
    await renderCampaignLive();
    expect(mocks.listLiveCalls).toHaveBeenCalledWith({ campaign_id: 'camp-1' }, 't-1', 'a-1');
    expect(screen.getByTestId('campaign-workspace')).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Home Loan Renewals');
    expect(screen.getByRole('heading', { level: 2, name: 'Live calls' })).toBeTruthy();
    expect(screen.getByTestId('campaign-tab-calls').getAttribute('aria-current')).toBe('page');
    expect(screen.getByTestId('calls-view-live').getAttribute('aria-current')).toBe('page');
    expect(screen.getByTestId('calls-view-live').textContent).toBe('Live 2');
    expect(screen.getByTestId('calls-view-calls').getAttribute('href')).toBe('/agency/campaigns/camp-1/calls');
    expect(suppliedCrumbs()).toBe('Home Loan Renewals→/agency/campaigns/camp-1 / Calls');
  });

  it('turns a call past twice the campaign’s average handle time amber', async () => {
    await renderCampaignLive();
    expect(screen.getByTestId('live-call-timer-c-long').getAttribute('data-overrun')).toBe('true');
    expect(screen.getByTestId('live-call-timer-c-short').getAttribute('data-overrun')).toBeNull();
  });
});
