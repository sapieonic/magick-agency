import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

/**
 * The Accounts page: the list, switching, and who is offered "New account".
 *
 * The offer follows the server's two rules, not the role alone: `account.create`
 * (tenant admin and owner) on a TENANT-WIDE membership. An account-scoped admin seat
 * is told why instead of shown a button the server would refuse.
 */
const mocks = vi.hoisted(() => ({
  useAuth: vi.fn(),
  useTenant: vi.fn(),
  useAccounts: vi.fn(),
  createAccount: vi.fn(),
  showToast: vi.fn(),
  reload: vi.fn(),
  reloadAccounts: vi.fn(),
  refreshSession: vi.fn(),
  setActiveAccountId: vi.fn(),
}));

vi.mock('../../contexts/AuthContext', () => ({ useAuth: mocks.useAuth }));
vi.mock('../../contexts/TenantContext', () => ({ useTenant: mocks.useTenant }));
vi.mock('../../hooks/useAccounts', () => ({ useAccounts: mocks.useAccounts }));
vi.mock('../../api/accounts', () => ({ createAccount: mocks.createAccount }));
vi.mock('@magick-agency/web-ui/contexts/ToastContext', () => ({
  useToast: () => ({ showToast: mocks.showToast, showErrorToast: vi.fn() }),
}));

import AccountsPage, { accountCreateAccess } from '../../pages/accounts/AccountsPage';

const TENANT = 'tenant-1';

function account(id: string, name: string) {
  return {
    id, tenant_id: TENANT, name, slug: name.toLowerCase(), settings: {}, status: 'active' as const,
    created_at: '2026-11-01T00:00:00.000Z', updated_at: '2026-11-01T00:00:00.000Z',
  };
}

function membership(role: string, accountId: string | null, tenantId = TENANT) {
  return {
    id: `m-${role}-${accountId}`, user_id: 'u-1', tenant_id: tenantId, account_id: accountId, role,
    status: 'active', invited_by: null, created_at: '', updated_at: '',
  };
}

function setup({
  memberships = [membership('tenant_admin', null)],
  accounts = [account('acct-1', 'Default'), account('acct-2', 'Renewals')],
  activeAccountId = 'acct-1',
}: {
  memberships?: ReturnType<typeof membership>[];
  accounts?: ReturnType<typeof account>[];
  activeAccountId?: string;
} = {}) {
  mocks.useAuth.mockReturnValue({ memberships, refreshSession: mocks.refreshSession });
  mocks.useTenant.mockReturnValue({
    tenantId: TENANT,
    accountId: activeAccountId,
    setActiveAccountId: mocks.setActiveAccountId,
    reloadAccounts: mocks.reloadAccounts,
  });
  mocks.useAccounts.mockReturnValue({ accounts, loading: false, error: null, reload: mocks.reload });
  return render(
    <MemoryRouter>
      <AccountsPage />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.refreshSession.mockResolvedValue(undefined);
  localStorage.clear();
});

afterEach(() => {
  cleanup();
});

describe('AccountsPage — the list', () => {
  it('lists every account and marks the active one Current', () => {
    setup();

    const current = screen.getByTestId('account-row-acct-1');
    expect(within(current).getByText('Default')).toBeTruthy();
    expect(within(current).getByText('Current')).toBeTruthy();
    expect(within(current).queryByRole('button', { name: /switch/i })).toBeNull();

    const other = screen.getByTestId('account-row-acct-2');
    expect(within(other).getByText('Renewals')).toBeTruthy();
    expect(within(other).queryByText('Current')).toBeNull();
  });

  it('switches the active account from a row', () => {
    setup();

    fireEvent.click(screen.getByRole('button', { name: 'Switch to Renewals' }));

    expect(mocks.setActiveAccountId).toHaveBeenCalledWith('acct-2');
  });
});

describe('AccountsPage — who may create', () => {
  it.each(['tenant_admin', 'tenant_owner'])('offers New account to a tenant-wide %s', (role) => {
    setup({ memberships: [membership(role, null)] });
    expect(screen.getByRole('button', { name: /New account/i })).toBeTruthy();
  });

  it.each(['account_admin', 'operator', 'viewer'])('offers nothing to a %s', (role) => {
    setup({ memberships: [membership(role, null)] });
    expect(screen.queryByRole('button', { name: /New account/i })).toBeNull();
    expect(screen.queryByTestId('accounts-scoped-note')).toBeNull();
  });

  it('tells an account-scoped tenant admin why there is no button', () => {
    setup({ memberships: [membership('tenant_admin', 'acct-1')] });

    expect(screen.queryByRole('button', { name: /New account/i })).toBeNull();
    expect(screen.getByTestId('accounts-scoped-note').textContent).toMatch(/covers one account/);
  });
});

describe('accountCreateAccess', () => {
  it('is allowed when ANY active tenant-wide seat carries the role, beside an account seat', () => {
    expect(accountCreateAccess([membership('agent', 'acct-1'), membership('tenant_admin', null)], TENANT)).toBe('allowed');
  });

  it('ignores another tenant and inactive memberships', () => {
    expect(accountCreateAccess([membership('tenant_owner', null, 'tenant-2')], TENANT)).toBe('not_permitted');
    expect(accountCreateAccess([{ ...membership('tenant_owner', null), status: 'revoked' }], TENANT)).toBe('not_permitted');
  });

  it('a tenant-wide seat below the floor is not permitted', () => {
    expect(accountCreateAccess([membership('account_admin', null)], TENANT)).toBe('not_permitted');
  });
});

describe('AccountsPage — creating', () => {
  function openModal() {
    fireEvent.click(screen.getByRole('button', { name: /New account/i }));
    return screen.getByRole('dialog');
  }

  it('cannot submit a blank name', () => {
    setup();
    const dialog = openModal();

    fireEvent.change(within(dialog).getByLabelText('Account name'), { target: { value: '   ' } });

    expect((within(dialog).getByRole('button', { name: /Create account/i }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('creates with the trimmed name, then refreshes the list, the switcher and the session', async () => {
    mocks.createAccount.mockResolvedValue(account('acct-3', 'Collections'));
    setup();
    const dialog = openModal();

    fireEvent.change(within(dialog).getByLabelText('Account name'), { target: { value: '  Collections ' } });
    fireEvent.click(within(dialog).getByRole('button', { name: /Create account/i }));

    await waitFor(() => expect(mocks.showToast).toHaveBeenCalledWith('Account "Collections" created', 'success'));
    expect(mocks.createAccount).toHaveBeenCalledWith(TENANT, 'Collections');
    expect(mocks.reload).toHaveBeenCalledTimes(1);
    expect(mocks.reloadAccounts).toHaveBeenCalledTimes(1);
    expect(mocks.refreshSession).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('keeps the modal open with the server\'s sentence when the name is taken', async () => {
    mocks.createAccount.mockRejectedValue(new Error('There is already an account called "Renewals" in this workspace.'));
    setup();
    const dialog = openModal();

    fireEvent.change(within(dialog).getByLabelText('Account name'), { target: { value: 'Renewals' } });
    fireEvent.click(within(dialog).getByRole('button', { name: /Create account/i }));

    expect((await screen.findByTestId('create-account-error')).textContent).toBe(
      'There is already an account called "Renewals" in this workspace.',
    );
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(mocks.reload).not.toHaveBeenCalled();
    expect(mocks.refreshSession).not.toHaveBeenCalled();
  });

  it('caps the name at the server\'s length', () => {
    setup();
    const dialog = openModal();
    expect(within(dialog).getByLabelText('Account name').getAttribute('maxlength')).toBe('100');
  });
});
