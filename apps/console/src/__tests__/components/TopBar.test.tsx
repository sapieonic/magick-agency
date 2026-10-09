import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const mocks = vi.hoisted(() => ({
  useAuth: vi.fn(),
  useTenant: vi.fn(),
  useTheme: vi.fn(),
  writeText: vi.fn(),
}));

vi.mock('../../contexts/AuthContext', () => ({ useAuth: mocks.useAuth }));
vi.mock('../../contexts/TenantContext', () => ({ useTenant: mocks.useTenant }));
vi.mock('../../contexts/ThemeContext', () => ({ useTheme: mocks.useTheme }));

// Sibling top-bar widgets have their own data dependencies, irrelevant here.
vi.mock('../../components/layout/TenantSwitcher', () => ({ TenantSwitcher: () => null }));
vi.mock('../../components/layout/AccountSwitcher', () => ({ AccountSwitcher: () => null }));

import { TopBar } from '../../components/layout/TopBar';

const TENANT_ID = '48b8ec3c-a84d-4a81-8b30-c03c8b54dfb4';
const ACCOUNT_ID = 'aa11bb22-cc33-dd44-ee55-ff6677889900';

function renderTopBar({
  tenantId = TENANT_ID as string | null,
  accountId = ACCOUNT_ID as string | null,
} = {}) {
  mocks.useAuth.mockReturnValue({
    user: { display_name: 'Manas Nilorout', email: 'manas@example.com', avatar_url: null },
    logout: vi.fn(),
  });
  mocks.useTenant.mockReturnValue({ tenantId, accountId });
  mocks.useTheme.mockReturnValue({ theme: 'dark', toggleTheme: vi.fn() });
  return render(
    <MemoryRouter>
      <TopBar />
    </MemoryRouter>,
  );
}

function openMenu() {
  fireEvent.click(screen.getByText('Manas Nilorout'));
}

describe('TopBar — tenant/account IDs in user menu', () => {
  beforeEach(() => {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: mocks.writeText },
      configurable: true,
    });
    mocks.writeText.mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('shows tenant and account IDs once the menu is open', () => {
    renderTopBar();
    // IDs are not in the DOM until the dropdown opens.
    expect(screen.queryByText('Tenant ID')).toBeNull();

    openMenu();

    expect(screen.getByText('Tenant ID')).toBeTruthy();
    expect(screen.getByText(TENANT_ID)).toBeTruthy();
    expect(screen.getByText('Account ID')).toBeTruthy();
    expect(screen.getByText(ACCOUNT_ID)).toBeTruthy();
  });

  it('copies the tenant ID to the clipboard', async () => {
    renderTopBar();
    openMenu();

    fireEvent.click(screen.getByTitle('Copy Tenant ID'));

    await waitFor(() => expect(mocks.writeText).toHaveBeenCalledWith(TENANT_ID));
  });

  it('copies the account ID to the clipboard', async () => {
    renderTopBar();
    openMenu();

    fireEvent.click(screen.getByTitle('Copy Account ID'));

    await waitFor(() => expect(mocks.writeText).toHaveBeenCalledWith(ACCOUNT_ID));
  });

  it('keeps the menu open after copying so feedback is visible', async () => {
    renderTopBar();
    openMenu();

    fireEvent.click(screen.getByTitle('Copy Tenant ID'));

    // The dropdown (and therefore the IDs) should still be present.
    await waitFor(() => expect(mocks.writeText).toHaveBeenCalled());
    expect(screen.getByText('Tenant ID')).toBeTruthy();
  });

  it('renders only the tenant ID when no account is selected', () => {
    renderTopBar({ accountId: null });
    openMenu();

    expect(screen.getByText('Tenant ID')).toBeTruthy();
    expect(screen.queryByText('Account ID')).toBeNull();
  });

  it('omits the ID section entirely when neither ID is set', () => {
    renderTopBar({ tenantId: null, accountId: null });
    openMenu();

    expect(screen.queryByText('Tenant ID')).toBeNull();
    expect(screen.queryByText('Account ID')).toBeNull();
    // The rest of the menu still renders.
    // There is no `Settings` item; `Sign Out` is the item left.
    expect(screen.getByText('Sign Out')).toBeTruthy();
  });

  it('does not close the menu when clicking inside the ID section', () => {
    renderTopBar();
    openMenu();

    // Clicking the ID value (not a button) is a click inside the menu.
    fireEvent.mouseDown(screen.getByText(TENANT_ID));
    expect(screen.getByText('Tenant ID')).toBeTruthy();
  });

  it('closes the menu on an outside click', () => {
    renderTopBar();
    openMenu();
    expect(screen.getByText('Tenant ID')).toBeTruthy();

    fireEvent.mouseDown(document.body);

    expect(screen.queryByText('Tenant ID')).toBeNull();
  });
});
