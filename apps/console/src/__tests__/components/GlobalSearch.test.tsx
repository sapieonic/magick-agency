import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { customerHistoryFixture } from '../helpers/customerHistory';

/**
 * The console's one search (B28), in the real shell: the top bar's field and ⌘K open the same
 * dialog; it is labelled, keyboard-driven (↑/↓ wrap, Enter opens, Escape closes and puts focus
 * back), and announces its count. Campaigns are read once as it opens and only for readers of the
 * Campaigns page. A phone number opens customer history exactly as "Search a number" did: the
 * same request, the same account header, only the search id in history state, and nothing of
 * the number within analytics' reach.
 */

const mocks = vi.hoisted(() => ({
  role: 'account_admin' as string | undefined,
  accountId: 'account-1' as string | null,
  dialerOn: true,
  phone: false,
  listAgencyCampaigns: vi.fn(),
  searchCustomers: vi.fn(),
  getCustomerSearchOptions: vi.fn(),
}));

vi.mock('../../hooks/usePostHogIdentify', () => ({ usePostHogIdentify: () => {} }));
vi.mock('../../analytics/useProductSurface', () => ({ useProductSurface: () => {} }));
vi.mock('../../contexts/TenantContext', () => ({
  useTenant: () => ({ role: mocks.role, tenantId: 'tenant-1', accountId: mocks.accountId, accounts: [] }),
}));
vi.mock('../../contexts/FeatureFlagsContext', () => ({
  useFeatureFlags: () => ({ isEnabled: (f: string) => (f === 'agency_dialer_enabled' ? mocks.dialerOn : true), status: 'ready' }),
}));
vi.mock('../../contexts/GovernanceContext', () => ({
  useGovernance: () => ({ isEnabled: () => true, loading: false }),
}));
vi.mock('../../hooks/useMissedCallsAccess', () => ({
  useMissedCallsAccess: () => ({ available: true, inboundOn: true, count: null, settled: true }),
}));
vi.mock('../../components/layout/ConsoleSidebar', () => ({ ConsoleSidebar: () => null }));
vi.mock('../../components/layout/ProfileMenu', () => ({ ProfileMenu: () => null }));
vi.mock('../../api/agencyCampaigns', () => ({ listAgencyCampaigns: mocks.listAgencyCampaigns }));
vi.mock('../../api/customerHistory', () => ({
  searchCustomers: mocks.searchCustomers,
  getCustomerSearchOptions: mocks.getCustomerSearchOptions,
}));

import { ConsoleLayout } from '../../components/layout/ConsoleLayout';
import { resetCustomerSearchDefaultCallingCode } from '../../hooks/useCustomerSearchDefaultCallingCode';
import { clearCustomerSearchAnswers, customerSearchAnswer } from '../../utils/customerHistoryStore';
import { ApiError } from '../../api/client';
import { SEARCH_CAMPAIGNS_FRESH_MS, resetSearchCampaignsCache } from '../../hooks/useSearchCampaigns';

const fixture = customerHistoryFixture();

let lastLocation: ReturnType<typeof useLocation> | null = null;
function Where() {
  lastLocation = useLocation();
  return <div data-testid="where">{`${lastLocation.pathname}${lastLocation.search}${lastLocation.hash}`}</div>;
}

function shellAt(path: string) {
  return (
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route element={<ConsoleLayout />}>
          <Route path="*" element={<Where />} />
        </Route>
      </Routes>
    </MemoryRouter>
  );
}

function renderShell(path = '/agency/campaigns') {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: query === '(max-width: 768px)' ? mocks.phone : false,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  const view = render(shellAt(path));
  return { ...view, rerenderShell: () => view.rerender(shellAt(path)) };
}

const trigger = () => screen.getByTestId('console-search-trigger');
const dialog = () => screen.getByRole('dialog', { name: 'Search' });
const input = () => within(dialog()).getByRole('combobox') as HTMLInputElement;
const type = (value: string) => fireEvent.change(input(), { target: { value } });
const key = (k: string) => fireEvent.keyDown(input(), { key: k });
const options = () => within(dialog()).queryAllByRole('option');
const where = () => screen.getByTestId('where').textContent;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.role = 'account_admin';
  mocks.accountId = 'account-1';
  mocks.dialerOn = true;
  mocks.phone = false;
  lastLocation = null;
  resetSearchCampaignsCache();
  clearCustomerSearchAnswers();
  resetCustomerSearchDefaultCallingCode();
  mocks.listAgencyCampaigns.mockResolvedValue([
    { id: 'c-1', name: 'Diwali renewals', status: 'running' },
    { id: 'c-2', name: 'Q4 collections', status: 'completed' },
  ]);
  mocks.searchCustomers.mockResolvedValue(fixture.search_response);
  mocks.getCustomerSearchOptions.mockResolvedValue({ default_country_code: '+91' });
});
afterEach(() => cleanup());

describe('the top bar’s search field', () => {
  it('says what this reader can search, with the shortcut, and opens the search', async () => {
    renderShell();
    expect(trigger().getAttribute('aria-label')).toBe('Search pages, campaigns, settings or a number');
    expect(trigger().textContent).toMatch(/K$/);
    fireEvent.click(trigger());
    expect(dialog()).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(input()));
  });

  it('leaves the number and campaigns out of its words without the dialer', () => {
    mocks.dialerOn = false;
    renderShell('/settings/profile');
    expect(trigger().getAttribute('aria-label')).toBe('Search pages and settings');
  });

  it('replaces the old "Search a number" popover', () => {
    renderShell();
    expect(screen.queryByTestId('customer-search-trigger')).toBeNull();
  });
});

describe('opening and closing', () => {
  it('Escape closes and puts focus back on the field', async () => {
    renderShell();
    trigger().focus();
    fireEvent.click(trigger());
    await waitFor(() => expect(document.activeElement).toBe(input()));
    key('Escape');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });

  it('⌘K opens it from anywhere and closes it again', () => {
    renderShell();
    fireEvent.keyDown(document, { key: 'k', metaKey: true });
    expect(dialog()).toBeTruthy();
    fireEvent.keyDown(document, { key: 'k', metaKey: true });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('a click outside closes it', () => {
    renderShell();
    fireEvent.click(trigger());
    fireEvent.click(dialog());
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('layers', () => {
  it('Escape closes only the topmost layer: search over the phone’s drawer, then the drawer', async () => {
    mocks.phone = true;
    renderShell();
    const toggle = screen.getByRole('button', { name: 'Toggle menu' });
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    fireEvent.keyDown(document, { key: 'k', metaKey: true });
    expect(dialog()).toBeTruthy();

    key('Escape');
    expect(screen.queryByRole('dialog', { name: 'Search' })).toBeNull();
    expect(toggle.getAttribute('aria-expanded')).toBe('true');

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
  });
});

describe('what was typed', () => {
  it('survives the flags resolving while search is open: the palette is never remounted', async () => {
    mocks.dialerOn = false;
    const { rerenderShell } = renderShell('/settings/profile');
    fireEvent.click(trigger());
    type('inbound');
    expect(options().map((o) => o.textContent)).toEqual(['Inbound routingSettings › This accountSetting']);
    await waitFor(() => expect(document.activeElement).toBe(input()));

    mocks.dialerOn = true;
    rerenderShell();
    expect(input().value).toBe('inbound');
    expect(document.activeElement).toBe(input());
    await waitFor(() => expect(options().map((o) => o.textContent)).toContain('Missed callsInboundPage'));
  });
});

describe('the keyboard', () => {
  it('moves with the arrows, wrapping, and opens with Enter', () => {
    renderShell();
    fireEvent.click(trigger());
    type('inbound');
    expect(options().map((o) => o.textContent)).toEqual([
      'Missed callsInboundPage',
      'Inbound summaryInboundPage',
      'Inbound routingSettings › This accountSetting',
    ]);
    expect(options()[0]!.getAttribute('aria-selected')).toBe('true');
    expect(input().getAttribute('aria-activedescendant')).toBe(options()[0]!.id);

    key('ArrowUp');
    expect(options()[2]!.getAttribute('aria-selected')).toBe('true');
    key('ArrowDown');
    key('ArrowDown');
    expect(options()[1]!.getAttribute('aria-selected')).toBe('true');
    expect(input().getAttribute('aria-activedescendant')).toBe(options()[1]!.id);

    key('Enter');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(where()).toBe('/agency/inbound/summary');
  });

  it('announces how many results there are', async () => {
    renderShell();
    fireEvent.click(trigger());
    type('inbound');
    expect(screen.getByTestId('global-search-status').textContent).toBe('3 results');
    type('zzzz');
    expect(screen.getByTestId('global-search-status').textContent).toBe('No results');
    await waitFor(() => expect(within(dialog()).getByText('Nothing matches “zzzz”')).toBeTruthy());
  });

  it('opens a setting found by its words', () => {
    renderShell();
    fireEvent.click(trigger());
    type('default caller ID');
    expect(options()[0]!.textContent).toBe('Default caller ID for soft-phone callsSettings › This account › Soft phoneSetting');
    key('Enter');
    expect(where()).toBe('/settings/softphone');
  });
});

describe('campaigns', () => {
  it('are read once as the search opens, not before and not per keystroke', async () => {
    renderShell();
    expect(mocks.listAgencyCampaigns).not.toHaveBeenCalled();
    fireEvent.click(trigger());
    type('diwali');
    await waitFor(() => expect(within(dialog()).getAllByRole('option', { name: /^Diwali renewals/ }).length).toBe(2));
    type('diwali r');
    type('q4');
    expect(mocks.listAgencyCampaigns).toHaveBeenCalledTimes(1);
    expect(mocks.listAgencyCampaigns).toHaveBeenCalledWith('tenant-1', 'account-1');
  });

  it('open the campaign, or its Settings', async () => {
    renderShell();
    fireEvent.click(trigger());
    type('diwali');
    await waitFor(() => expect(options().length).toBe(2));
    expect(options().map((o) => o.textContent)).toEqual(['Diwali renewalsCampaign', 'Diwali renewals › SettingsCampaign']);
    key('ArrowDown');
    key('Enter');
    expect(where()).toBe('/agency/campaigns/c-1/settings');
  });

  it('offer a campaign Settings section by what people type, landing on its anchor', async () => {
    renderShell();
    fireEvent.click(trigger());
    type('caller diwali');
    const option = await waitFor(() => within(dialog()).getByRole('option', { name: /^Caller IDs/ }));
    expect(option.textContent).toContain('Diwali renewals › Settings');
    fireEvent.click(option);
    expect(where()).toBe('/agency/campaigns/c-1/settings#caller-ids');
  });

  it('are never read for a reader the Campaigns page is not offered to', () => {
    mocks.role = 'agent';
    renderShell();
    fireEvent.click(trigger());
    type('diwali');
    expect(mocks.listAgencyCampaigns).not.toHaveBeenCalled();
  });

  it('are never read without the dialer or without an account', () => {
    mocks.dialerOn = false;
    renderShell('/settings/profile');
    fireEvent.click(trigger());
    type('diwali');
    cleanup();
    mocks.dialerOn = true;
    mocks.accountId = null;
    renderShell('/settings/profile');
    fireEvent.click(trigger());
    type('diwali');
    expect(mocks.listAgencyCampaigns).not.toHaveBeenCalled();
  });

  it('are kept for the session: a second open within a minute reads nothing, and shows them at once', async () => {
    renderShell();
    fireEvent.click(trigger());
    type('diwali');
    await waitFor(() => expect(options().length).toBe(2));
    key('Escape');
    fireEvent.click(trigger());
    type('diwali');
    // At once, with no "Loading campaigns…" and no second read.
    expect(options().length).toBe(2);
    expect(within(dialog()).queryByText('Loading campaigns…')).toBeNull();
    expect(mocks.listAgencyCampaigns).toHaveBeenCalledTimes(1);
  });

  it('are read again in the background when the list kept is old, showing the old list meanwhile', async () => {
    const now = vi.spyOn(Date, 'now');
    try {
      now.mockReturnValue(1_000_000);
      renderShell();
      fireEvent.click(trigger());
      type('diwali');
      await waitFor(() => expect(options().length).toBe(2));
      key('Escape');

      mocks.listAgencyCampaigns.mockResolvedValue([{ id: 'c-3', name: 'Diwali top-ups', status: 'running' }]);
      now.mockReturnValue(1_000_000 + SEARCH_CAMPAIGNS_FRESH_MS + 1);
      fireEvent.click(trigger());
      type('diwali');
      expect(options()[0]!.textContent).toBe('Diwali renewalsCampaign');
      await waitFor(() => expect(options()[0]!.textContent).toBe('Diwali top-upsCampaign'));
      expect(mocks.listAgencyCampaigns).toHaveBeenCalledTimes(2);
    } finally {
      now.mockRestore();
    }
  });

  it('are read again for another account', async () => {
    renderShell();
    fireEvent.click(trigger());
    type('diwali');
    await waitFor(() => expect(options().length).toBe(2));
    cleanup();
    mocks.accountId = 'account-2';
    renderShell();
    fireEvent.click(trigger());
    await waitFor(() => expect(mocks.listAgencyCampaigns).toHaveBeenCalledTimes(2));
    expect(mocks.listAgencyCampaigns).toHaveBeenLastCalledWith('tenant-1', 'account-2');
  });

  it('find a campaign’s own pages by the names people learnt: call log, call attempts, history', async () => {
    renderShell();
    fireEvent.click(trigger());
    type('diwali call attempts');
    const option = await waitFor(() => within(dialog()).getByRole('option', { name: /^Diwali renewals › Call log/ }));
    fireEvent.click(option);
    expect(where()).toBe('/agency/campaigns/c-1/attempts');
    fireEvent.click(trigger());
    type('diwali history');
    fireEvent.click(within(dialog()).getByRole('option', { name: /^Diwali renewals › History/ }));
    expect(where()).toBe('/agency/campaigns/c-1/activity');
  });

  it('show a campaign named in digits, with no "Enter the full number" above it', async () => {
    mocks.listAgencyCampaigns.mockResolvedValue([{ id: 'c-26', name: '2026', status: 'running' }]);
    renderShell();
    fireEvent.click(trigger());
    type('2026');
    await waitFor(() => expect(options().map((o) => o.textContent)).toContain('2026Campaign'));
    expect(screen.queryByTestId('global-search-number-note')).toBeNull();
  });

  it('say so when they could not be read', async () => {
    mocks.listAgencyCampaigns.mockRejectedValue(new Error('boom'));
    renderShell();
    fireEvent.click(trigger());
    type('diwali');
    await waitFor(() => expect(within(dialog()).getByText(/Couldn’t load campaigns/)).toBeTruthy());
  });
});

describe('a phone number', () => {
  it('is the top result, and opens customer history as "Search a number" did', async () => {
    renderShell();
    fireEvent.click(trigger());
    type('98765 43210');
    expect(options()[0]!.textContent).toBe('Calls to +91 98765 43210Customer history, across campaignsNumber');
    key('Enter');

    await waitFor(() => expect(where()).toBe('/agency/customers'));
    expect(mocks.searchCustomers).toHaveBeenCalledWith(
      { by: 'phone', value: '98765 43210', country: 'IN' },
      'tenant-1',
      'account-1',
      expect.any(AbortSignal),
    );
    // Only the search id in history state; never the number in the URL (CH6).
    expect(lastLocation!.state).toEqual({ searchId: fixture.search_response.search_id });
    expect(where()).not.toMatch(/\d{5}/);
    expect(customerSearchAnswer(fixture.search_response.search_id)).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('keeps the search open with the refusal when the server says no', async () => {
    mocks.searchCustomers.mockRejectedValue(
      new ApiError(429, 'rate_limited', "You've searched a lot of numbers in a short time. Try again in 30 seconds."),
    );
    renderShell();
    fireEvent.click(trigger());
    type('98765 43210');
    key('Enter');
    await waitFor(() => expect(screen.getByTestId('global-search-error')).toBeTruthy());
    expect(screen.getByTestId('global-search-error').getAttribute('role')).toBe('alert');
    expect(dialog()).toBeTruthy();
    expect(where()).toBe('/agency/campaigns');
  });

  it('says what is wrong with an unfinished number, and offers nothing to open for it', () => {
    renderShell();
    fireEvent.click(trigger());
    type('43210');
    expect(screen.getByTestId('global-search-number-note').textContent).toBe(
      "Enter the full number. Searching by the last few digits isn't supported.",
    );
    expect(options().some((o) => o.textContent?.startsWith('Calls to'))).toBe(false);
  });

  it('is not offered without the dialer, whose accounts the search reads', () => {
    mocks.dialerOn = false;
    renderShell('/settings/profile');
    fireEvent.click(trigger());
    type('98765 43210');
    expect(options()).toEqual([]);
    expect(screen.queryByTestId('global-search-number-note')).toBeNull();
    expect(within(dialog()).queryByText(/Type a phone number/)).toBeNull();
  });

  it('keeps the whole dialog out of analytics: a number is typed and shown in it', () => {
    renderShell();
    fireEvent.click(trigger());
    type('98765 43210');
    expect(dialog().classList.contains('ph-no-capture')).toBe(true);
  });
});
