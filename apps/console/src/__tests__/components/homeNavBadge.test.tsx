import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { board, onBoard, stats } from '../helpers/home';

/**
 * The sidebar's Home entry (B28): its badge counts the dangers and warnings on the Home page's
 * list (never a waiting campaign, never the missed calls the Inbound badge carries), in its own
 * tone beside the missed-calls count; a reader who fails Home's gate gets neither the entry nor
 * any read; on Home the sidebar reads nothing itself and shows the count the page published;
 * away from Home it reads on its own unless that count is fresh, and restamps it on every read.
 */

const mocks = vi.hoisted(() => ({
  role: 'account_admin' as string | undefined,
  getAgencyHomeBoard: vi.fn(),
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
vi.mock('../../api/agencyHome', () => ({ getAgencyHomeBoard: mocks.getAgencyHomeBoard }));
vi.mock('../../api/agencyCampaigns', () => ({ getAgencyCampaign: vi.fn() }));
vi.mock('../../api/inbound', () => ({ getMissedInboundCount: mocks.getMissedInboundCount }));
vi.mock('../../components/common/Logo', () => ({ Logo: () => <span /> }));
vi.mock('../../brand', () => ({ brand: { name: 'TestBrand' } }));

import { ConsoleSidebar } from '../../components/layout/ConsoleSidebar';
import { resetMissedCallsCountForTests } from '../../hooks/useMissedCallsCount';
import { homeAttentionAge, publishHomeAttentionCount, resetHomeAttentionCountForTests } from '../../hooks/useHomeAttentionCount';
import { HOME_SLOW_MS } from '../../hooks/useHomeBoard';

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
  mocks.getAgencyHomeBoard.mockResolvedValue(board([
    onBoard('c1', { stats: stats({ stall: { code: 'no_carrier_capacity' } }), overdue: 4 }),
    onBoard('c2', { overdue: 4 }),
    onBoard('c3', { stats: stats({ stall: { code: 'outside_calling_hours', contacts_waiting: 9, next_window_opens_at: null } }) }),
  ]));
});
afterEach(() => cleanup());

describe('the Home entry and its badge', () => {
  it('counts the conditions away from Home, in the attention tone, with words for a screen reader', async () => {
    await renderAt('/agency/campaigns');
    // c1's stall and two campaigns' overdue callbacks; not c3 (only waiting for its hours) and
    // not the two open missed calls (the Inbound badge beside it counts those).
    const badge = await screen.findByTestId('sidebar-attention-badge');
    await waitFor(() => expect(badge.textContent).toBe('3, 3 need your attention'));
    expect(screen.getByTestId('sidebar-missed-badge').textContent).toContain('2');
    expect(badge.className).toMatch(/navBadgeAttention/);
    expect(screen.getByTestId('sidebar-missed-badge').className).not.toMatch(/navBadgeAttention/);
    expect(screen.getByTestId('console-nav-home').getAttribute('aria-current')).toBeNull();
  });

  it.each(['viewer', 'operator'] as const)('is not offered to a %s, who reads no campaign for it', async (role) => {
    mocks.role = role;
    await renderAt('/agency/campaigns');
    expect(screen.queryByTestId('console-nav-home')).toBeNull();
    expect(screen.queryByTestId('sidebar-attention-badge')).toBeNull();
    expect(mocks.getAgencyHomeBoard).not.toHaveBeenCalled();
  });

  it('on Home reads nothing itself and shows the count the page published', async () => {
    await renderAt('/agency/home');
    expect(screen.getByTestId('console-nav-home').getAttribute('aria-current')).toBe('page');
    expect(screen.queryByTestId('sidebar-attention-badge')).toBeNull();
    act(() => publishHomeAttentionCount('t-1/a-1', 2));
    expect(screen.getByTestId('sidebar-attention-badge').textContent).toBe('2, 2 need your attention');
    expect(mocks.getAgencyHomeBoard).not.toHaveBeenCalled();
  });

  it('away from Home skips its read while the published count is fresh', async () => {
    publishHomeAttentionCount('t-1/a-1', 1);
    await renderAt('/agency/dnc');
    expect(screen.getByTestId('sidebar-attention-badge').textContent).toBe('1, 1 needs your attention');
    expect(mocks.getAgencyHomeBoard).not.toHaveBeenCalled();
  });

  it('shows no badge when nothing needs attention', async () => {
    mocks.getAgencyHomeBoard.mockResolvedValue(board([onBoard('c1')]));
    mocks.getMissedInboundCount.mockResolvedValue({ open: 0, open_capped: false, has_rows: true });
    await renderAt('/agency/campaigns');
    await waitFor(() => expect(mocks.getAgencyHomeBoard).toHaveBeenCalled());
    await act(async () => {});
    expect(screen.queryByTestId('sidebar-attention-badge')).toBeNull();
  });

  it('shows no badge when only missed calls are open: the Inbound badge has them', async () => {
    mocks.getAgencyHomeBoard.mockResolvedValue(board([onBoard('c1')]));
    await renderAt('/agency/campaigns');
    await waitFor(() => expect(mocks.getAgencyHomeBoard).toHaveBeenCalled());
    await act(async () => {});
    expect(screen.getByTestId('sidebar-missed-badge')).toBeTruthy();
    expect(screen.queryByTestId('sidebar-attention-badge')).toBeNull();
  });

  it('away from Home restamps the shared count on every read, even when it has not changed', async () => {
    vi.useFakeTimers();
    try {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
      await renderAt('/agency/campaigns');
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(mocks.getAgencyHomeBoard).toHaveBeenCalledTimes(1);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(HOME_SLOW_MS);
      });
      expect(mocks.getAgencyHomeBoard).toHaveBeenCalledTimes(2);
      expect(homeAttentionAge('t-1/a-1')).toBeLessThan(1_000);
    } finally {
      vi.useRealTimers();
    }
  });
});
