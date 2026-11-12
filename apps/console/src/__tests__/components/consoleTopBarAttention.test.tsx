import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { board, onBoard, stats } from '../helpers/home';

/**
 * The Home badge on a phone (B28a): the sidebar is a closed drawer there, so the top bar's menu
 * button carries a dot, and says "N things need you", while the Home badge is above zero. Only
 * for a reader the sidebar offers Home, and from the badge's own board (no request of its own).
 */

const mocks = vi.hoisted(() => ({
  role: 'account_admin' as string,
  dialer: true,
  getAgencyHomeBoard: vi.fn(),
}));

// Home's acknowledgements are the signed-in reader's (`useHomeAcks`).
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'u-1' } }) }));
vi.mock('../../contexts/TenantContext', () => ({
  useTenant: () => ({ tenantId: 't-1', accountId: 'a-1', role: mocks.role }),
}));
vi.mock('../../contexts/FeatureFlagsContext', () => ({
  useFeatureFlags: () => ({ isEnabled: (f: string) => mocks.dialer && f === 'agency_dialer_enabled', status: 'ready' }),
}));
vi.mock('../../contexts/GovernanceContext', () => ({
  useGovernance: () => ({ isEnabled: (c: string) => c === 'agency', loading: false }),
}));
vi.mock('../../api/agencyHome', () => ({ getAgencyHomeBoard: mocks.getAgencyHomeBoard }));
vi.mock('../../components/layout/ProfileMenu', () => ({ ProfileMenu: () => null }));

import { ConsoleTopBar } from '../../components/layout/ConsoleTopBar';
import { PageCrumbsProvider } from '../../components/layout/PageCrumbs';
import { resetHomeAcksForTests } from '../../hooks/useHomeAcks';

async function renderBar() {
  render(
    <MemoryRouter initialEntries={['/agency/campaigns']}>
      <PageCrumbsProvider>
        <ConsoleTopBar phone />
      </PageCrumbsProvider>
    </MemoryRouter>,
  );
  await act(async () => {});
}

const menu = () => screen.getByRole('button', { name: /^Toggle menu/ });

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  resetHomeAcksForTests();
  mocks.role = 'account_admin';
  mocks.dialer = true;
  mocks.getAgencyHomeBoard.mockResolvedValue(board([
    onBoard('c1', { stats: stats({ stall: { code: 'no_carrier_capacity' } }), overdue: 2 }),
  ]));
});
afterEach(() => cleanup());

describe('the menu button’s attention dot', () => {
  it('shows a dot and says how many things need the reader while the Home badge is above zero', async () => {
    await renderBar();
    await waitFor(() => expect(screen.getByTestId('menu-attention-dot')).toBeTruthy());
    expect(menu().getAttribute('aria-label')).toBe('Toggle menu, 2 things need you');
    expect(mocks.getAgencyHomeBoard).toHaveBeenCalledTimes(1);
  });

  it('shows none when nothing needs the reader', async () => {
    mocks.getAgencyHomeBoard.mockResolvedValue(board([onBoard('c1')]));
    await renderBar();
    await waitFor(() => expect(mocks.getAgencyHomeBoard).toHaveBeenCalled());
    await act(async () => {});
    expect(screen.queryByTestId('menu-attention-dot')).toBeNull();
    expect(menu().getAttribute('aria-label')).toBe('Toggle menu');
  });

  it.each([
    ['a viewer (no Home)', () => { mocks.role = 'viewer'; }],
    ['a tenant with the dialer off', () => { mocks.dialer = false; }],
  ])('reads nothing and shows no dot for %s', async (_name, arrange) => {
    arrange();
    await renderBar();
    expect(screen.queryByTestId('menu-attention-dot')).toBeNull();
    expect(menu().getAttribute('aria-label')).toBe('Toggle menu');
    expect(mocks.getAgencyHomeBoard).not.toHaveBeenCalled();
  });
});
