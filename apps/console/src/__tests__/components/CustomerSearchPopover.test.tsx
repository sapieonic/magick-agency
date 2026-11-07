import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

/**
 * "Search a number" in the agency shell's top bar (`docs/customer-history.md` §5):
 * present for every role holding `agency.customer_history.read`, opening the full
 * box (helper text included) in a panel, closed by Escape with focus back on the
 * button, Tab kept inside while open, and the panel out of analytics' reach.
 */

const mocks = vi.hoisted(() => ({
  useTenant: vi.fn(),
  memberships: [] as unknown[],
}));

vi.mock('../../contexts/TenantContext', () => ({ useTenant: mocks.useTenant }));
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => ({ memberships: mocks.memberships }) }));
vi.mock('../../analytics/useProductSurface', () => ({ useProductSurface: vi.fn() }));
vi.mock('../../components/layout/AgencySidebar', () => ({ AgencySidebar: () => <nav data-testid="sidebar" /> }));
vi.mock('../../components/layout/TenantSwitcher', () => ({ TenantSwitcher: () => null }));
vi.mock('../../components/layout/AccountSwitcher', () => ({ AccountSwitcher: () => null }));
vi.mock('../../api/customerHistory', () => ({
  searchCustomers: vi.fn(),
  getCustomerSearchOptions: vi.fn().mockResolvedValue({ default_country_code: '+91' }),
}));

import { AgencyLayout } from '../../components/layout/AgencyLayout';

function renderLayout() {
  render(
    <MemoryRouter initialEntries={['/agency/campaigns']}>
      <AgencyLayout />
    </MemoryRouter>,
  );
}

beforeEach(() => {
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
});
