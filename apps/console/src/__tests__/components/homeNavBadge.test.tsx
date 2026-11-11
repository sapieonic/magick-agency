import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { campaign, stats } from '../helpers/home';

/**
 * The sidebar's Home entry (B28): its badge counts what needs the supervisor (the Home page's
 * list), in its own tone beside the missed-calls count; a reader who fails Home's gate gets
 * neither the entry nor any read; on Home the sidebar reads nothing itself and shows the count
 * the page published; away from Home it reads on its own unless that count is fresh.
 */

const mocks = vi.hoisted(() => ({
  role: 'account_admin' as string | undefined,
  listAgencyCampaigns: vi.fn(),
  listAgencyCampaignsPage: vi.fn(),
  getAgencyCampaignStats: vi.fn(),
  getInsightsAllocation: vi.fn(),
  getMissedInboundCount: vi.fn(),
}));

vi.mock('../../contexts/TenantContext', () => ({
  useTenant: () => ({
    role: mocks.role,
    tenantId: 't-1',
    accountId: 'a-1',
    activeTenant: { id: 't-1', name: 'Acme', slug: 'acme' },
    accounts: [{ id: 'a-1', name: 'Pune' }],
    accountResolution: 'ready',
    setActiveTenantId: vi.fn(),
    setActiveAccountId: vi.fn(),
    reloadAccounts: vi.fn(),
  }),
}));
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => ({ tenants: [{ id: 't-1', name: 'Acme', slug: 'acme' }] }) }));
vi.mock('../../contexts/FeatureFlagsContext', () => ({
  useFeatureFlags: () => ({ isEnabled: (f: string) => f === 'agency_dialer_enabled' || f === 'agency_inbound_enabled', status: 'ready' }),
}));
vi.mock('../../contexts/GovernanceContext', () => ({
  useGovernance: () => ({ isEnabled: (c: string) => c === 'agency', loading: false }),
}));
vi.mock('../../api/agencyCampaigns', () => ({
  listAgencyCampaigns: mocks.listAgencyCampaigns,
  listAgencyCampaignsPage: mocks.listAgencyCampaignsPage,
  getAgencyCampaignStats: mocks.getAgencyCampaignStats,
  getAgencyCampaign: vi.fn(),
}));
vi.mock('../../api/agencyInsights', () => ({ getInsightsAllocation: mocks.getInsightsAllocation }));
vi.mock('../../api/inbound', () => ({ getMissedInboundCount: mocks.getMissedInboundCount }));
vi.mock('../../components/common/Logo', () => ({ Logo: () => <span /> }));
vi.mock('../../brand', () => ({ brand: { name: 'TestBrand' } }));

import { ConsoleSidebar } from '../../components/layout/ConsoleSidebar';
import { resetMissedCallsCountForTests } from '../../hooks/useMissedCallsCount';
import { publishHomeAttentionCount, resetHomeAttentionCountForTests } from '../../hooks/useHomeAttentionCount';

async function renderAt(path: string) {
  render(
    <MemoryRouter initialEntries={[path]}>
      <ConsoleSidebar />
    </MemoryRouter>,
  );
  await act(async () => {});
}

beforeEach(() => {
  vi.clearAllMocks();
  resetMissedCallsCountForTests();
  resetHomeAttentionCountForTests();
  mocks.role = 'account_admin';
  mocks.getMissedInboundCount.mockResolvedValue({ open: 2, open_capped: false, has_rows: true });
  mocks.listAgencyCampaigns.mockResolvedValue([campaign('c1'), campaign('c2')]);
  mocks.listAgencyCampaignsPage.mockResolvedValue({ campaigns: [], total: 2 });
  mocks.getAgencyCampaignStats.mockImplementation(async (id: string) =>
    stats(id === 'c1' ? { stall: { code: 'no_carrier_capacity' } } : {}));
  mocks.getInsightsAllocation.mockResolvedValue({ totals: { callbacks_overdue: 4 } });
});
afterEach(() => cleanup());

describe('the Home entry and its badge', () => {
  it('counts the conditions away from Home, in the attention tone, with words for a screen reader', async () => {
    await renderAt('/agency/campaigns');
    // c1's stall, two campaigns' overdue callbacks, the open missed calls.
    const badge = await screen.findByTestId('sidebar-attention-badge');
    await waitFor(() => expect(badge.textContent).toBe('4, 4 need your attention'));
    expect(badge.className).toMatch(/navBadgeAttention/);
    expect(screen.getByTestId('sidebar-missed-badge').className).not.toMatch(/navBadgeAttention/);
    expect(screen.getByTestId('console-nav-home').getAttribute('aria-current')).toBeNull();
  });

  it.each(['viewer', 'operator'] as const)('is not offered to a %s, who reads no campaign for it', async (role) => {
    mocks.role = role;
    await renderAt('/agency/campaigns');
    expect(screen.queryByTestId('console-nav-home')).toBeNull();
    expect(screen.queryByTestId('sidebar-attention-badge')).toBeNull();
    expect(mocks.listAgencyCampaigns).not.toHaveBeenCalled();
  });

  it('on Home reads nothing itself and shows the count the page published', async () => {
    await renderAt('/agency/home');
    expect(screen.getByTestId('console-nav-home').getAttribute('aria-current')).toBe('page');
    expect(screen.queryByTestId('sidebar-attention-badge')).toBeNull();
    act(() => publishHomeAttentionCount('t-1/a-1', 2));
    expect(screen.getByTestId('sidebar-attention-badge').textContent).toBe('2, 2 need your attention');
    expect(mocks.listAgencyCampaigns).not.toHaveBeenCalled();
  });

  it('away from Home skips its read while the published count is fresh', async () => {
    publishHomeAttentionCount('t-1/a-1', 1);
    await renderAt('/agency/dnc');
    expect(screen.getByTestId('sidebar-attention-badge').textContent).toBe('1, 1 needs your attention');
    expect(mocks.listAgencyCampaigns).not.toHaveBeenCalled();
  });

  it('shows no badge when nothing needs attention', async () => {
    mocks.getAgencyCampaignStats.mockResolvedValue(stats());
    mocks.getInsightsAllocation.mockResolvedValue({ totals: { callbacks_overdue: 0 } });
    mocks.getMissedInboundCount.mockResolvedValue({ open: 0, open_capped: false, has_rows: true });
    await renderAt('/agency/campaigns');
    await waitFor(() => expect(mocks.getInsightsAllocation).toHaveBeenCalled());
    await act(async () => {});
    expect(screen.queryByTestId('sidebar-attention-badge')).toBeNull();
  });
});
