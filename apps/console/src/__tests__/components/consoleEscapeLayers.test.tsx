import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

/**
 * Escape closes only the topmost layer of the console shell (B28), with the real profile menu and
 * the real search: the search opened (⌘K) over an open profile menu takes the first Escape and
 * leaves the menu open; the second closes the menu.
 */

const mocks = vi.hoisted(() => ({ listAgencyCampaignsPage: vi.fn() }));

vi.mock('../../hooks/usePostHogIdentify', () => ({ usePostHogIdentify: () => {} }));
vi.mock('../../analytics/useProductSurface', () => ({ useProductSurface: () => {} }));
vi.mock('../../contexts/TenantContext', () => ({
  useTenant: () => ({ role: 'account_admin', tenantId: 'tenant-1', accountId: 'account-1', accounts: [] }),
}));
vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ user: { display_name: 'Test Supervisor', email: 's@example.com', avatar_url: null }, logout: vi.fn() }),
}));
vi.mock('../../contexts/ThemeContext', () => ({ useTheme: () => ({ theme: 'light', toggleTheme: vi.fn() }) }));
vi.mock('../../contexts/FeatureFlagsContext', () => ({
  useFeatureFlags: () => ({ isEnabled: () => false, status: 'ready' }),
}));
vi.mock('../../contexts/GovernanceContext', () => ({
  useGovernance: () => ({ isEnabled: () => false, loading: false }),
}));
vi.mock('../../hooks/useMissedCallsAccess', () => ({
  useMissedCallsAccess: () => ({ available: false, inboundOn: false, count: null, settled: true }),
}));
vi.mock('../../components/layout/ConsoleSidebar', () => ({ ConsoleSidebar: () => null }));
vi.mock('../../api/agencyCampaigns', () => ({ listAgencyCampaignsPage: mocks.listAgencyCampaignsPage }));

import { ConsoleLayout } from '../../components/layout/ConsoleLayout';

function renderShell() {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  return render(
    <MemoryRouter initialEntries={['/settings/profile']}>
      <Routes>
        <Route element={<ConsoleLayout />}>
          <Route path="*" element={<div>Page</div>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

const profile = () => screen.getByTestId('profile-menu-trigger');
const searchInput = () => within(screen.getByRole('dialog', { name: 'Search' })).getByRole('combobox');

beforeEach(() => {
  mocks.listAgencyCampaignsPage.mockResolvedValue({ campaigns: [], total: 0 });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('Escape closes only the topmost layer', () => {
  it('search over the open profile menu: the first Escape closes the search, the second the menu', async () => {
    renderShell();
    profile().focus();
    fireEvent.click(profile());
    expect(profile().getAttribute('aria-expanded')).toBe('true');

    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'k', ctrlKey: true });
    // The search takes focus a moment after it opens; the menu under it stays open meanwhile.
    await waitFor(() => expect(document.activeElement).toBe(searchInput()));
    expect(profile().getAttribute('aria-expanded')).toBe('true');

    fireEvent.change(searchInput(), { target: { value: 'team' } });
    fireEvent.keyDown(searchInput(), { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Search' })).toBeNull();
    expect(profile().getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement).toBe(profile());

    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    expect(profile().getAttribute('aria-expanded')).toBe('false');
  });
});
