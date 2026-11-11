import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * The Settings hub (decision B28): the sub-nav grouped by who a setting affects, each entry
 * gated as before, an empty group hidden, the "Applies to" line (truthful for a seat scoped to
 * one account), the campaign-settings pointer, `/settings` reopening the last page visited, the
 * phone's one-picker sub-nav, the Profile and appearance page, and every old `/app/<page>` URL
 * landing on its `/settings/<page>` twin with the rest of the URL kept.
 */

const mocks = vi.hoisted(() => ({
  role: 'account_admin' as string | undefined,
  theme: 'dark' as 'dark' | 'light',
  toggleTheme: vi.fn(),
  flagsOff: new Set<string>(),
  memberships: [] as Array<{ tenant_id: string; account_id: string | null; role: string; status: string }>,
}));

vi.mock('../../contexts/TenantContext', () => ({
  useTenant: () => ({
    role: mocks.role,
    tenantId: 't-1',
    accountId: 'a-1',
    accounts: [{ id: 'a-1', name: 'Pune Collections' }],
    activeTenant: { id: 't-1', name: 'Acme Finance' },
  }),
}));
vi.mock('../../contexts/FeatureFlagsContext', () => ({
  useFeatureFlags: () => ({ isEnabled: (f: string) => !mocks.flagsOff.has(f), status: 'ready' }),
}));
vi.mock('../../contexts/GovernanceContext', () => ({ useGovernance: () => ({ isEnabled: () => true, loading: false }) }));
vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'u-1', display_name: 'Priya Shah', email: 'priya@example.com', avatar_url: null },
    memberships: mocks.memberships,
  }),
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
  mocks.flagsOff = new Set();
  mocks.memberships = [];
  localStorage.clear();
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

  it('points campaign settings at the campaign, with a link to Campaigns', () => {
    renderAt('/settings/team');
    const hint = screen.getByTestId('settings-campaign-hint');
    expect(hint.textContent).toMatch(/Caller IDs, calling hours and retries belong to one campaign/);
    expect(within(hint).getByRole('link', { name: 'Campaigns' }).getAttribute('href')).toBe('/agency/campaigns');
  });

  it('says nothing about campaigns to a tenant without the dialer', () => {
    mocks.flagsOff = new Set(['agency_dialer_enabled']);
    renderAt('/settings/team');
    expect(screen.queryByTestId('settings-campaign-hint')).toBeNull();
    expect(screen.queryByText(/belong to one campaign/)).toBeNull();
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

describe('Applies to, by the reader’s seat', () => {
  it('says the account, not the tenant, for people and access on a seat scoped to one account', () => {
    mocks.memberships = [{ tenant_id: 't-1', account_id: 'a-1', role: 'account_admin', status: 'active' }];
    renderAt('/settings/team');
    expect(screen.getByTestId('settings-applies-to').textContent).toBe('Applies to: Pune Collections');
  });

  it('says the tenant for a tenant-wide seat', () => {
    mocks.memberships = [{ tenant_id: 't-1', account_id: null, role: 'account_admin', status: 'active' }];
    renderAt('/settings/team');
    expect(screen.getByTestId('settings-applies-to').textContent).toBe('Applies to: all of Acme Finance');
  });
});

describe('where /settings opens', () => {
  it('opens Team for someone who manages people, the first time', () => {
    renderAt('/settings');
    expect(where()).toBe('/settings/team');
  });

  it('opens Profile and appearance for someone with no Team', () => {
    mocks.role = 'viewer';
    renderAt('/settings');
    expect(screen.getByTestId('profile-email').textContent).toBe('priya@example.com');
    expect(screen.getByTestId('settings-nav-profile').getAttribute('aria-current')).toBe('page');
  });

  it('reopens the page visited last', () => {
    renderAt('/settings/inbound');
    cleanup();
    renderAt('/settings');
    expect(where()).toBe('/settings/inbound');
  });

  it('passes over a last page the reader may no longer open', () => {
    renderAt('/settings/inbound');
    cleanup();
    mocks.flagsOff = new Set(['agency_inbound_enabled']);
    renderAt('/settings');
    expect(where()).toBe('/settings/team');
  });

  it('remembers per person', () => {
    renderAt('/settings/inbound');
    expect(Object.keys(localStorage)).toEqual(['magick.settings.last:u-1']);
  });

  it('works with storage that throws', () => {
    const own = Object.getOwnPropertyDescriptor(window, 'localStorage');
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('blocked');
      },
    });
    try {
      renderAt('/settings/inbound');
      cleanup();
      renderAt('/settings');
      expect(where()).toBe('/settings/team');
    } finally {
      if (own) Object.defineProperty(window, 'localStorage', own);
      else delete (window as { localStorage?: Storage }).localStorage;
    }
  });
});

describe('on a phone', () => {
  it('offers the sub-nav as one picker, which opens the page chosen', () => {
    renderAt('/settings/team');
    const picker = screen.getByLabelText('Settings page') as HTMLSelectElement;
    expect(picker.value).toBe('team');
    expect([...picker.querySelectorAll('optgroup')].map((g) => g.label)).toEqual([
      'You',
      'This account · Pune Collections',
      'People and access',
    ]);
    fireEvent.change(picker, { target: { value: 'inbound' } });
    expect(where()).toBe('/settings/inbound');
  });

  it('shows the picker instead of the full sub-nav at phone width, and only there', () => {
    const css = readFileSync(resolve(__dirname, '../../pages/settings/SettingsLayout.module.css'), 'utf-8');
    expect(css).toMatch(/\.compact \{\s*display: none;/);
    const phone = css.slice(css.indexOf('@media (max-width: 768px)'));
    expect(phone).toMatch(/\.compact \{\s*display: flex;/);
    expect(phone).toMatch(/\.full \{\s*display: none;/);
  });
});

describe('Profile and appearance', () => {
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

describe('"Find a setting"', () => {
  const filter = () => screen.getByLabelText('Find a setting') as HTMLInputElement;
  const entries = () => screen.queryAllByTestId(/^settings-nav-/).map((a) => a.textContent);

  it('filters the sub-nav by the words ⌘K finds settings by', () => {
    renderAt('/settings/team');
    // The default caller ID, and "What callers hear" on inbound routes.
    fireEvent.change(filter(), { target: { value: 'caller' } });
    expect(entries()).toEqual(['Soft phone', 'Inbound routing']);
    fireEvent.change(filter(), { target: { value: 'default caller' } });
    expect(entries()).toEqual(['Soft phone']);
    fireEvent.change(filter(), { target: { value: 'IVR' } });
    expect(entries()).toEqual(['Inbound routing']);
    fireEvent.change(filter(), { target: { value: 'dark mode' } });
    expect(entries()).toEqual(['Profile and appearance']);
  });

  it('drops a group with nothing left in it', () => {
    renderAt('/settings/team');
    fireEvent.change(filter(), { target: { value: 'invite' } });
    expect(screen.getAllByTestId(/^settings-group-/).map((g) => g.dataset.testid)).toEqual(['settings-group-tenant']);
  });

  it('never shows an entry the reader is not offered', () => {
    mocks.role = 'viewer';
    renderAt('/settings/profile');
    fireEvent.change(filter(), { target: { value: 'invite' } });
    expect(entries()).toEqual([]);
  });

  it('says when nothing matches, and announces the count', () => {
    renderAt('/settings/team');
    fireEvent.change(filter(), { target: { value: 'zzzz' } });
    expect(screen.getByTestId('settings-filter-empty').textContent).toBe('No setting matches “zzzz”.');
    expect(filter().getAttribute('aria-describedby')).toBeTruthy();
    expect(document.getElementById(filter().getAttribute('aria-describedby')!)!.textContent).toBe('0 settings found');
  });

  it('shows everything again when cleared, or on Escape', () => {
    renderAt('/settings/team');
    const all = entries();
    fireEvent.change(filter(), { target: { value: 'invite' } });
    expect(entries()).toEqual(['Team']);
    fireEvent.keyDown(filter(), { key: 'Escape' });
    expect(filter().value).toBe('');
    expect(entries()).toEqual(all);
  });
});
