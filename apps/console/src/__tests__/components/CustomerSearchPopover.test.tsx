import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

/**
 * "Search a number" in the console shell's top bar (`docs/customer-history.md` §5):
 * present for every role holding `agency.customer_history.read`, opening the full
 * box (helper text included) in a panel, closed by Escape with focus back on the
 * button, Tab kept inside while open, and the panel out of analytics' reach.
 */

const mocks = vi.hoisted(() => ({
  useTenant: vi.fn(),
  memberships: [] as unknown[],
  dialerOn: true,
}));

vi.mock('../../contexts/TenantContext', () => ({ useTenant: mocks.useTenant }));
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => ({ memberships: mocks.memberships }) }));
vi.mock('../../contexts/FeatureFlagsContext', () => ({
  useFeatureFlags: () => ({ isEnabled: (f: string) => mocks.dialerOn && f === 'agency_dialer_enabled', status: 'ready' }),
}));
vi.mock('../../contexts/GovernanceContext', () => ({
  useGovernance: () => ({ isEnabled: (c: string) => mocks.dialerOn && c === 'agency', loading: false }),
}));
vi.mock('../../components/layout/ProfileMenu', () => ({ ProfileMenu: () => null }));
vi.mock('../../api/customerHistory', () => ({
  searchCustomers: vi.fn(),
  getCustomerSearchOptions: vi.fn().mockResolvedValue({ default_country_code: '+91' }),
}));

import { ConsoleTopBar } from '../../components/layout/ConsoleTopBar';

function renderLayout(path = '/agency/campaigns') {
  render(
    <MemoryRouter initialEntries={[path]}>
      <ConsoleTopBar />
    </MemoryRouter>,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

beforeEach(() => {
  mocks.dialerOn = true;
  mocks.useTenant.mockReturnValue({ tenantId: 't', accountId: 'a', accounts: [], role: 'account_admin' });
});

describe('the top bar search', () => {
  it('opens the full box, with its helper text, and closes on Escape', () => {
    renderLayout();
    const trigger = screen.getByTestId('customer-search-trigger');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByLabelText('Phone number')).toBeNull();

    fireEvent.click(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByLabelText('Phone number')).toBeTruthy();
    expect(screen.getByText(/Type the full mobile number/)).toBeTruthy();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByLabelText('Phone number')).toBeNull();
  });

  it('returns focus to the button on Escape', () => {
    renderLayout();
    const trigger = screen.getByTestId('customer-search-trigger');
    fireEvent.click(trigger);
    const field = screen.getByLabelText('Phone number');
    field.focus();
    expect(document.activeElement).toBe(field);

    fireEvent.keyDown(field, { key: 'Escape' });
    expect(screen.queryByLabelText('Phone number')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('points aria-controls at the panel only while it exists', () => {
    renderLayout();
    const trigger = screen.getByTestId('customer-search-trigger');
    expect(trigger.hasAttribute('aria-controls')).toBe(false);
    fireEvent.click(trigger);
    const id = trigger.getAttribute('aria-controls');
    expect(id).toBeTruthy();
    expect(document.getElementById(id!)).toBe(screen.getByTestId('customer-search-panel'));
  });

  it('keeps Tab inside the open panel, both ways', () => {
    renderLayout();
    fireEvent.click(screen.getByTestId('customer-search-trigger'));
    const panel = screen.getByTestId('customer-search-panel');
    const focusable = panel.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    expect(first).not.toBe(last);

    last.focus();
    fireEvent.keyDown(last, { key: 'Tab' });
    expect(document.activeElement).toBe(first);

    fireEvent.keyDown(first, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(last);
  });

  it('marks the panel ph-no-capture: everything in it is a phone number', () => {
    renderLayout();
    fireEvent.click(screen.getByTestId('customer-search-trigger'));
    const panel = screen.getByTestId('customer-search-panel');
    expect(panel.classList.contains('ph-no-capture')).toBe(true);
    expect(screen.getByLabelText('Phone number').closest('.ph-no-capture')).not.toBeNull();
  });

  it.each(['agent', 'viewer', 'operator', 'account_admin', 'tenant_owner'])('is offered to %s (CH1)', (role) => {
    mocks.useTenant.mockReturnValue({ tenantId: 't', accountId: 'a', accounts: [], role });
    renderLayout();
    expect(screen.getByTestId('customer-search-trigger')).toBeTruthy();
  });

  it('is not offered before a role resolves', () => {
    mocks.useTenant.mockReturnValue({ tenantId: 't', accountId: 'a', accounts: [], role: undefined });
    renderLayout();
    expect(screen.queryByTestId('customer-search-trigger')).toBeNull();
  });

  it('is not offered when there is no account to search from', () => {
    mocks.useTenant.mockReturnValue({ tenantId: 't', accountId: null, accounts: [], role: 'account_admin' });
    renderLayout();
    expect(screen.queryByTestId('customer-search-trigger')).toBeNull();
  });

  it('is offered on Settings pages too, the shell being one', () => {
    renderLayout('/settings/notifications');
    expect(screen.getByTestId('customer-search-trigger')).toBeTruthy();
  });

  it('is not offered without the dialer, whose account the search reads', () => {
    mocks.dialerOn = false;
    renderLayout('/settings/notifications');
    expect(screen.queryByTestId('customer-search-trigger')).toBeNull();
  });

  it('keeps the panel on screen between the phone breakpoint and a wide window', () => {
    // At 800px the 560px panel opens from a trigger near x 391 and would run to
    // 951; it is pulled back to 16px clear of the right edge.
    vi.spyOn(document.documentElement, 'clientWidth', 'get').mockReturnValue(800);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      left: 391,
      right: 951,
      top: 64,
      bottom: 400,
      width: 560,
      height: 336,
      x: 391,
      y: 64,
      toJSON: () => ({}),
    } as DOMRect);
    renderLayout();
    fireEvent.click(screen.getByTestId('customer-search-trigger'));
    expect(screen.getByTestId('customer-search-panel').style.marginLeft).toBe('-167px');
  });
});
