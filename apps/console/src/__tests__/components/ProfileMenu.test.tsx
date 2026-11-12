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

import { ProfileMenu } from '../../components/layout/ProfileMenu';

const TENANT_ID = '48b8ec3c-a84d-4a81-8b30-c03c8b54dfb4';
const ACCOUNT_ID = 'aa11bb22-cc33-dd44-ee55-ff6677889900';

const logout = vi.fn();
const toggleTheme = vi.fn();

function renderTopBar({
  tenantId = TENANT_ID as string | null,
  accountId = ACCOUNT_ID as string | null,
} = {}) {
  mocks.useAuth.mockReturnValue({
    user: { display_name: 'Test Supervisor', email: 'supervisor@example.com', avatar_url: null },
    logout,
  });
  mocks.useTenant.mockReturnValue({ tenantId, accountId });
  mocks.useTheme.mockReturnValue({ theme: 'dark', toggleTheme });
  return render(
    <MemoryRouter>
      <ProfileMenu />
    </MemoryRouter>,
  );
}

function openMenu() {
  fireEvent.click(screen.getByText('Test Supervisor'));
}

describe('ProfileMenu — tenant/account IDs', () => {
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
    // There is no `Settings` item; the theme and `Sign out` are left.
    expect(screen.getByText('Sign out')).toBeTruthy();
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

describe('ProfileMenu — who, theme and sign out', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('shows the name and email, and the initials as the avatar', () => {
    renderTopBar();
    expect(screen.getByTestId('profile-menu-trigger').textContent).toContain('TS');
    openMenu();
    const menu = screen.getByTestId('profile-menu');
    expect(menu.textContent).toContain('Test Supervisor');
    expect(menu.textContent).toContain('supervisor@example.com');
  });

  it('switches the theme from the menu', () => {
    renderTopBar();
    openMenu();
    const item = screen.getByTestId('profile-menu-theme');
    expect(item.textContent).toBe('Switch to light mode');
    fireEvent.click(item);
    expect(toggleTheme).toHaveBeenCalledTimes(1);
  });

  it('signs out from the menu', async () => {
    renderTopBar();
    openMenu();
    fireEvent.click(screen.getByText('Sign out'));
    await waitFor(() => expect(logout).toHaveBeenCalledTimes(1));
  });

  it('closes on Escape and gives focus back to the trigger', () => {
    renderTopBar();
    openMenu();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByTestId('profile-menu')).toBeNull();
    expect(document.activeElement).toBe(screen.getByTestId('profile-menu-trigger'));
  });

  it('is a disclosure, not a menu: expanded state and the panel it controls, no popup role claimed', () => {
    renderTopBar();
    const trigger = screen.getByTestId('profile-menu-trigger');
    expect(trigger.getAttribute('aria-haspopup')).toBeNull();
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(trigger.getAttribute('aria-controls')).toBeNull();
    openMenu();
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(trigger.getAttribute('aria-controls')).toBe(screen.getByTestId('profile-menu').id);
    expect(screen.getByTestId('profile-menu').getAttribute('role')).toBeNull();
  });

  it('closes when focus moves out of it, and stays open while it moves within', () => {
    const outside = document.createElement('button');
    document.body.appendChild(outside);
    try {
      renderTopBar();
      openMenu();
      const theme = screen.getByTestId('profile-menu-theme');
      fireEvent.blur(screen.getByTestId('profile-menu-trigger'), { relatedTarget: theme });
      expect(screen.getByTestId('profile-menu')).toBeTruthy();
      fireEvent.blur(theme, { relatedTarget: outside });
      expect(screen.queryByTestId('profile-menu')).toBeNull();
    } finally {
      outside.remove();
    }
  });

  it('leaves an Escape another layer took (search above it) alone', () => {
    // The layer above handles the Escape first and marks it handled.
    const above = (e: KeyboardEvent) => e.preventDefault();
    document.addEventListener('keydown', above, { capture: true });
    try {
      renderTopBar();
      openMenu();
      fireEvent.keyDown(document.body, { key: 'Escape' });
      expect(screen.getByTestId('profile-menu')).toBeTruthy();
    } finally {
      document.removeEventListener('keydown', above, { capture: true });
    }
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(screen.queryByTestId('profile-menu')).toBeNull();
  });
});
