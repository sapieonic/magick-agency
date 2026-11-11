import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, act, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * The console's one sidebar (decision B28): the context block, the four work sections gated as
 * the pages they group, Settings and the version at the foot, and the active state across every
 * URL a section groups. It replaced the agency and `/app` sidebars, so their per-role
 * assertions are carried over here: an agent is offered nothing, Accounts is for the roles that
 * can create one, Reports and Soft-phone calls follow their flags, nothing shows without the
 * dialer, and the version is the console's.
 */

const mocks = vi.hoisted(() => ({
  role: 'account_admin' as string | undefined,
  flags: new Set<string>(),
  caps: new Set<string>(),
  tenants: [{ id: 't-1', name: 'Acme Finance', slug: 'acme' }] as Array<{ id: string; name: string; slug: string }>,
  accounts: [{ id: 'a-1', name: 'Pune Collections' }] as Array<{ id: string; name: string }>,
  getMissedInboundCount: vi.fn(),
}));

vi.mock('../../contexts/TenantContext', () => ({
  useTenant: () => ({
    role: mocks.role,
    tenantId: 't-1',
    accountId: 'a-1',
    activeTenant: mocks.tenants[0],
    accounts: mocks.accounts,
    accountResolution: 'ready',
    setActiveTenantId: vi.fn(),
    setActiveAccountId: vi.fn(),
    reloadAccounts: vi.fn(),
  }),
}));
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => ({ tenants: mocks.tenants }) }));
vi.mock('../../contexts/FeatureFlagsContext', () => ({
  useFeatureFlags: () => ({ isEnabled: (f: string) => mocks.flags.has(f), status: 'ready' }),
}));
vi.mock('../../contexts/GovernanceContext', () => ({
  useGovernance: () => ({ isEnabled: (c: string) => mocks.caps.has(c), loading: false }),
}));
vi.mock('../../api/inbound', () => ({ getMissedInboundCount: mocks.getMissedInboundCount }));
vi.mock('../../components/common/Logo', () => ({ Logo: () => <span data-testid="logo" /> }));
vi.mock('../../brand', () => ({ brand: { name: 'TestBrand' } }));

import { ConsoleSidebar } from '../../components/layout/ConsoleSidebar';
import { resetMissedCallsCountForTests } from '../../hooks/useMissedCallsCount';

const DIALER = ['agency_dialer_enabled', 'agency_inbound_enabled', 'agency_reports_enabled', 'agency_softphone_enabled'];

/** `null` is an unresolved role (a default parameter would swallow `undefined`). */
async function renderAt(path = '/agency/campaigns', role: string | null = 'account_admin') {
  mocks.role = role ?? undefined;
  const view = render(
    <MemoryRouter initialEntries={[path]}>
      <ConsoleSidebar />
    </MemoryRouter>,
  );
  await act(async () => {});
  return view;
}

const nav = () => screen.getByRole('navigation', { name: 'Main' });
const navLabels = () => within(nav()).queryAllByRole('link').map((a) => (a.textContent ?? '').replace(/\d.*$/, '').trim());
const href = (testId: string) => screen.getByTestId(testId).getAttribute('href');
const isActive = (testId: string) => screen.getByTestId(testId).getAttribute('aria-current') === 'page';

beforeEach(() => {
  vi.clearAllMocks();
  resetMissedCallsCountForTests();
  mocks.flags = new Set(DIALER);
  mocks.caps = new Set(['agency']);
  mocks.tenants = [{ id: 't-1', name: 'Acme Finance', slug: 'acme' }];
  mocks.accounts = [{ id: 'a-1', name: 'Pune Collections' }];
  mocks.getMissedInboundCount.mockResolvedValue({ open: 4, open_capped: false, has_rows: true });
});
afterEach(() => cleanup());

describe('the work sections', () => {
  it('offers a supervisor Home, Campaigns, Inbound, Reports and Do Not Call, in that order', async () => {
    await renderAt();
    expect(navLabels()).toEqual(['Home', 'Campaigns', 'Inbound', 'Reports', 'Do Not Call']);
    expect(href('console-nav-home')).toBe('/agency/home');
    expect(href('console-nav-campaigns')).toBe('/agency/campaigns');
    expect(href('console-nav-inbound')).toBe('/agency/inbound/missed');
    expect(href('console-nav-reports')).toBe('/agency/analytics');
    expect(href('console-nav-dnc')).toBe('/agency/dnc');
  });

  it('offers an agent nothing to work on, which is why an agent is never routed here', async () => {
    await renderAt('/agency/campaigns', 'agent');
    expect(navLabels()).toEqual([]);
  });

  it('offers nothing while the role is unresolved', async () => {
    await renderAt('/agency/campaigns', null);
    expect(navLabels()).toEqual([]);
  });

  it('offers no work section, and asks for no missed-calls count, without the dialer', async () => {
    mocks.caps = new Set();
    await renderAt('/settings/profile');
    expect(navLabels()).toEqual([]);
    cleanup();
    mocks.caps = new Set(['agency']);
    mocks.flags = new Set(DIALER.filter((f) => f !== 'agency_dialer_enabled'));
    await renderAt('/settings/profile');
    expect(navLabels()).toEqual([]);
    expect(mocks.getMissedInboundCount).not.toHaveBeenCalled();
  });

  it('has no New campaign entry, no workspace switch, no Team & settings and no page filter', async () => {
    await renderAt();
    expect(screen.queryByText(/New campaign/)).toBeNull();
    expect(screen.queryByText(/Switch to Magick Agency|Take dialler calls/)).toBeNull();
    expect(screen.queryByText(/Team & settings/)).toBeNull();
    expect(screen.queryByLabelText('Search navigation')).toBeNull();
    expect(screen.queryByText('ADMIN')).toBeNull();
  });
});

describe('Settings and the version, pinned at the foot', () => {
  it.each(['agent', 'viewer', 'account_admin', 'tenant_owner'])('shows Settings to %s', async (role) => {
    await renderAt('/agency/campaigns', role);
    expect(href('console-nav-settings')).toBe('/settings');
  });

  it("shows the console's package.json version, for any role, with or without destinations", async () => {
    const { version } = JSON.parse(readFileSync(resolve(__dirname, '../../../package.json'), 'utf-8')) as { version: string };
    expect(version).toMatch(/^\d+\.\d+\.\d+/);
    expect(__APP_VERSION__).toBe(version);
    await renderAt('/agency/campaigns', 'agent');
    expect(screen.getByTestId('app-version').textContent).toBe(`v${version}`);
  });
});

describe('the active entry covers every page a section groups', () => {
  it.each([
    ['/agency/campaigns', 'console-nav-campaigns'],
    ['/agency/campaigns/c-1/overview', 'console-nav-campaigns'],
    ['/agency/softphone', 'console-nav-campaigns'],
    ['/agency/inbound/summary', 'console-nav-inbound'],
    ['/agency/analytics', 'console-nav-reports'],
    ['/agency/reports/run-1', 'console-nav-reports'],
    ['/agency/dnc', 'console-nav-dnc'],
    ['/settings/team', 'console-nav-settings'],
  ])('%s highlights %s and nothing else', async (path, testId) => {
    await renderAt(path);
    const all = ['campaigns', 'inbound', 'reports', 'dnc', 'settings'].map((id) => `console-nav-${id}`);
    for (const id of all) expect(isActive(id)).toBe(id === testId);
  });
});

describe('the missed-calls badge on Inbound', () => {
  it('shows the open count, says it to a screen reader, and counts the account for a supervisor', async () => {
    await renderAt();
    const inbound = screen.getByTestId('console-nav-inbound');
    expect(within(inbound).getByTestId('sidebar-missed-badge').textContent).toBe('4, 4 to follow up');
    expect(mocks.getMissedInboundCount).toHaveBeenCalledWith('t-1', 'a-1', {});
  });

  it('counts only their own rows for a viewer', async () => {
    await renderAt('/agency/campaigns', 'viewer');
    expect(mocks.getMissedInboundCount).toHaveBeenCalledWith('t-1', 'a-1', { assignee: 'me' });
  });

  it('shows 99+ past the cap, and no badge with nothing open', async () => {
    mocks.getMissedInboundCount.mockResolvedValue({ open: 100, open_capped: true, has_rows: true });
    await renderAt();
    expect(screen.getByTestId('sidebar-missed-badge').textContent).toBe('99+, more than 99 to follow up');
    cleanup();
    resetMissedCallsCountForTests();
    mocks.getMissedInboundCount.mockResolvedValue({ open: 0, open_capped: false, has_rows: true });
    await renderAt();
    expect(screen.getByTestId('console-nav-inbound')).toBeTruthy();
    expect(screen.queryByTestId('sidebar-missed-badge')).toBeNull();
  });

  it('keeps Inbound with inbound off while there are rows, and drops it when there are none', async () => {
    mocks.flags = new Set(DIALER.filter((f) => f !== 'agency_inbound_enabled'));
    await renderAt();
    expect(navLabels()).toContain('Inbound');
    cleanup();
    resetMissedCallsCountForTests();
    mocks.getMissedInboundCount.mockResolvedValue({ open: 0, open_capped: false, has_rows: false });
    await renderAt();
    expect(navLabels()).not.toContain('Inbound');
  });
});

describe('the context block', () => {
  it('shows one tenant and one account as plain labels, with no dropdown', async () => {
    await renderAt();
    const block = screen.getByTestId('sidebar-context');
    expect(block.textContent).toContain('Acme Finance');
    expect(block.textContent).toContain('Pune Collections');
    expect(within(block).queryAllByRole('button')).toHaveLength(0);
  });

  it('opens the existing switchers when there is more than one to choose from', async () => {
    mocks.tenants = [
      { id: 't-1', name: 'Acme Finance', slug: 'acme' },
      { id: 't-2', name: 'Other', slug: 'other' },
    ];
    mocks.accounts = [
      { id: 'a-1', name: 'Pune Collections' },
      { id: 'a-2', name: 'Mumbai Cards' },
    ];
    await renderAt();
    const buttons = within(screen.getByTestId('sidebar-context')).getAllByRole('button');
    expect(buttons.map((b) => b.textContent)).toEqual(['Acme Finance', 'Pune Collections']);
    expect(buttons.every((b) => b.getAttribute('aria-haspopup') === 'listbox')).toBe(true);
  });
});
