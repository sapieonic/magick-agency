import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

/**
 * "Search a number" in the agency shell's top bar (`docs/customer-history.md` §5):
 * present for every role holding `agency.customer_history.read`, opening the full
 * box (helper text included) in a panel, closed by Escape.
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
vi.mock('../../api/customerHistory', () => ({ searchCustomers: vi.fn() }));

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
