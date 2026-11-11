import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';

/**
 * The Settings hub (decision B28): the sub-nav grouped by who a setting affects, each entry
 * gated as before, an empty group hidden, the "Applies to" line, the campaign-settings hint,
 * `/settings` opening the first entry, the new Profile and appearance page, and every old
 * `/app/<page>` URL landing on its `/settings/<page>` twin with the rest of the URL kept.
 */

const mocks = vi.hoisted(() => ({
  role: 'account_admin' as string | undefined,
  theme: 'dark' as 'dark' | 'light',
  toggleTheme: vi.fn(),
}));

vi.mock('../../contexts/TenantContext', () => ({
  useTenant: () => ({
    role: mocks.role,
    accountId: 'a-1',
    accounts: [{ id: 'a-1', name: 'Pune Collections' }],
    activeTenant: { id: 't-1', name: 'Acme Finance' },
  }),
}));
vi.mock('../../contexts/FeatureFlagsContext', () => ({
  useFeatureFlags: () => ({ isEnabled: () => true, status: 'ready' }),
}));
vi.mock('../../contexts/GovernanceContext', () => ({ useGovernance: () => ({ isEnabled: () => true, loading: false }) }));
vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ user: { display_name: 'Priya Shah', email: 'priya@example.com', avatar_url: null } }),
}));
vi.mock('../../contexts/ThemeContext', () => ({
  useTheme: () => ({ theme: mocks.theme, toggleTheme: mocks.toggleTheme }),
}));

import SettingsLayout from '../../pages/settings/SettingsLayout';
import SettingsIndexRedirect from '../../pages/settings/SettingsIndexRedirect';
import ProfileSettingsPage from '../../pages/settings/ProfileSettingsPage';
import LegacyAppRedirect from '../../pages/LegacyAppRedirect';

function Where() {
  const { pathname, search, hash } = useLocation();
  return <div data-testid="where">{`${pathname}${search}${hash}`}</div>;
}

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/settings" element={<SettingsLayout />}>
          <Route index element={<SettingsIndexRedirect />} />
          <Route path="profile" element={<ProfileSettingsPage />} />
          <Route path="*" element={<Where />} />
        </Route>
        <Route path="/app">
          <Route index element={<Where />} />
          <Route path="*" element={<LegacyAppRedirect />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

const where = () => screen.getByTestId('where').textContent;

beforeEach(() => {
  mocks.role = 'account_admin';
  mocks.theme = 'dark';
  mocks.toggleTheme.mockClear();
});
afterEach(() => cleanup());

describe('the sub-nav', () => {
  it('groups an account admin’s settings by who they affect, naming the account', () => {
    renderAt('/settings/team');
    const groups = screen.getAllByTestId(/^settings-group-/);
    expect(groups.map((g) => within(g).getByRole('heading').textContent)).toEqual([
      'You',
      'This account · Pune Collections',
      'People and access',
    ]);
    expect(within(groups[0]!).getAllByRole('link').map((a) => a.textContent)).toEqual([
      'Profile and appearance',
      'Email notifications',
    ]);
    expect(within(groups[1]!).getAllByRole('link').map((a) => a.getAttribute('href'))).toEqual([
      '/settings/softphone',
      '/settings/inbound',
      '/settings/call-summaries',
    ]);
    expect(screen.getByTestId('settings-nav-team').getAttribute('aria-current')).toBe('page');
  });

  it('hides a group with nothing in it', () => {
    mocks.role = 'viewer';
    renderAt('/settings/notifications');
    expect(screen.queryByTestId('settings-group-tenant')).toBeNull();
    expect(screen.getByTestId('settings-group-you')).toBeTruthy();
  });

  it('points campaign settings at the campaign', () => {
    renderAt('/settings/team');
    expect(screen.getByText(/Caller IDs, calling hours and retries belong to one campaign/)).toBeTruthy();
  });

  it('never says "Notifications" on its own: it is Email notifications', () => {
    renderAt('/settings/team');
    expect(screen.getByTestId('settings-nav-notifications').textContent).toBe('Email notifications');
  });
});

describe('Applies to', () => {
  it.each([
    ['/settings/notifications', 'only you'],
    ['/settings/inbound/r-1', 'Pune Collections'],
    ['/settings/accounts', 'all of Acme Finance'],
  ])('%s applies to %s', (path, scope) => {
    renderAt(path);
    expect(screen.getByTestId('settings-applies-to').textContent).toBe(`Applies to: ${scope}`);
  });
});

describe('/settings and Profile and appearance', () => {
  it('opens the first entry, Profile and appearance', () => {
    renderAt('/settings');
    expect(screen.getByTestId('profile-email').textContent).toBe('priya@example.com');
    expect(screen.getByTestId('settings-nav-profile').getAttribute('aria-current')).toBe('page');
  });

  it('shows the name and email without offering to edit them, and switches the theme', () => {
    renderAt('/settings/profile');
    expect(screen.getByTestId('profile-name').textContent).toBe('Priya Shah');
    expect(screen.queryByRole('textbox')).toBeNull();
    const dark = screen.getByTestId('profile-theme-dark') as HTMLInputElement;
    expect(dark.checked).toBe(true);
    fireEvent.click(screen.getByTestId('profile-theme-light'));
    expect(mocks.toggleTheme).toHaveBeenCalledTimes(1);
  });
});

describe('the old /app URLs', () => {
  it.each([
    ['/app/team', '/settings/team'],
    ['/app/accounts', '/settings/accounts'],
    ['/app/notifications', '/settings/notifications'],
    ['/app/call-summaries', '/settings/call-summaries'],
    ['/app/softphone', '/settings/softphone'],
    ['/app/inbound', '/settings/inbound'],
    ['/app/inbound/new', '/settings/inbound/new'],
    ['/app/inbound/r-42', '/settings/inbound/r-42'],
  ])('%s lands on %s', (from, to) => {
    renderAt(from);
    expect(where()).toBe(to);
  });

  it('keeps the query and the hash', () => {
    renderAt('/app/notifications?event=usage.digest#top');
    expect(where()).toBe('/settings/notifications?event=usage.digest#top');
  });

  it('sends a path that was never a page here to /app, the home decision', () => {
    renderAt('/app/calls/dialer/history/1');
    expect(where()).toBe('/app');
  });
});
