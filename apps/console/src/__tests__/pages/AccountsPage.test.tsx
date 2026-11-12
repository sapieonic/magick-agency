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
  trackSetupEvent: vi.fn(),
  inviteUser: vi.fn(),
}));

vi.mock('../../contexts/AuthContext', () => ({ useAuth: mocks.useAuth }));
vi.mock('../../contexts/TenantContext', () => ({ useTenant: mocks.useTenant }));
vi.mock('../../hooks/useAccounts', () => ({ useAccounts: mocks.useAccounts }));
vi.mock('../../api/accounts', () => ({ createAccount: mocks.createAccount }));
vi.mock('../../analytics/events', () => ({ trackSetupEvent: mocks.trackSetupEvent }));
vi.mock('../../api/users', () => ({ inviteUser: mocks.inviteUser }));
vi.mock('../../contexts/GovernanceContext', () => ({
  useGovernance: () => ({ isEnabled: () => true, loading: false }),
}));
vi.mock('../../contexts/FeatureFlagsContext', () => ({
  useFeatureFlags: () => ({ isEnabled: () => true, status: 'ready' }),
}));
vi.mock('@magick-agency/web-ui/contexts/ToastContext', () => ({
  useToast: () => ({ showToast: mocks.showToast, showErrorToast: vi.fn() }),
}));

import AccountsPage from '../../pages/accounts/AccountsPage';
import { accountCreateAccess } from '../../utils/accountCreateAccess';
import { ApiError } from '../../api/client';
import type { Membership, Role } from '../../types/auth';

const TENANT = 'tenant-1';

function account(id: string, name: string) {
  return {
    id, tenant_id: TENANT, name, slug: name.toLowerCase(), settings: {}, status: 'active' as const,
    created_at: '2026-11-01T00:00:00.000Z', updated_at: '2026-11-01T00:00:00.000Z',
  };
}

function membership(role: Role, accountId: string | null, tenantId = TENANT): Membership {
  return {
    id: `m-${role}-${accountId}`, user_id: 'u-1', tenant_id: tenantId, account_id: accountId, role,
    status: 'active', invited_by: null, created_at: '', updated_at: '',
  };
}

function setup({
  memberships = [membership('tenant_admin', null)],
  accounts = [account('acct-1', 'Default'), account('acct-2', 'Renewals')],
  activeAccountId = 'acct-1',
  settings = {},
}: {
  memberships?: Membership[];
  accounts?: ReturnType<typeof account>[];
  activeAccountId?: string;
  settings?: Record<string, { max_concurrent_calls: number }>;
} = {}) {
  mocks.useAuth.mockReturnValue({ memberships, settings, refreshSession: mocks.refreshSession });
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

  it('shows each account\'s call limit, and says a zero one is not set yet', () => {
    setup({ settings: { 'acct-1': { max_concurrent_calls: 5 }, 'acct-2': { max_concurrent_calls: 0 } } });

    expect(within(screen.getByTestId('account-row-acct-1')).getByText('5 at once')).toBeTruthy();
    expect(within(screen.getByTestId('account-row-acct-2')).getByText('Not set yet')).toBeTruthy();
  });

  it('points at the account switcher where it is, in the sidebar', () => {
    setup();
    expect(screen.getByText(/account switcher in the sidebar/)).toBeTruthy();
    expect(screen.queryByText(/switcher at the top/)).toBeNull();
  });

  it('labels the actions column for screen readers', () => {
    setup();
    expect(screen.getByRole('columnheader', { name: 'Actions' })).toBeTruthy();
  });

  it('switches the active account from a row', () => {
    setup();

    fireEvent.click(screen.getByRole('button', { name: 'Switch to Renewals' }));

    expect(mocks.setActiveAccountId).toHaveBeenCalledWith('acct-2');
  });
});

describe('AccountsPage — who may create', () => {
  it.each<Role>(['tenant_admin', 'tenant_owner'])('offers New account to a tenant-wide %s', (role) => {
    setup({ memberships: [membership(role, null)] });
    expect(screen.getByRole('button', { name: /New account/i })).toBeTruthy();
  });

  it.each<Role>(['account_admin', 'operator', 'viewer'])('offers nothing to a %s', (role) => {
    setup({ memberships: [membership(role, null)] });
    expect(screen.queryByRole('button', { name: /New account/i })).toBeNull();
    expect(screen.queryByTestId('accounts-scoped-note')).toBeNull();
  });

  it('tells an account-scoped tenant admin why there is no button', () => {
    setup({ memberships: [membership('tenant_admin', 'acct-1')] });

    expect(screen.queryByRole('button', { name: /New account/i })).toBeNull();
    expect(screen.getByTestId('accounts-scoped-note').textContent).toMatch(/covers one account/);
  });

  it('with no accounts, offers one New account button (in the empty state) to a creator', () => {
    setup({ accounts: [] });
    expect(screen.getAllByRole('button', { name: /New account/i })).toHaveLength(1);
    expect(screen.getByText('Create an account to start running campaigns.')).toBeTruthy();
  });

  it('with no accounts, tells someone who cannot create one whom to ask', () => {
    setup({ accounts: [], memberships: [membership('account_admin', null)] });
    expect(screen.queryByRole('button', { name: /New account/i })).toBeNull();
    expect(screen.getByText(/Ask an admin with access to the whole organisation/)).toBeTruthy();
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

    await screen.findByTestId('new-account-ready');
    expect(mocks.createAccount).toHaveBeenCalledWith(TENANT, 'Collections');
    expect(mocks.reload).toHaveBeenCalledTimes(1);
    expect(mocks.reloadAccounts).toHaveBeenCalledTimes(1);
    expect(mocks.refreshSession).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(mocks.trackSetupEvent).toHaveBeenCalledWith('account_created', { account_count: 3 });
  });

  it('tells the person the new account cannot place calls yet', () => {
    setup();
    const dialog = openModal();
    expect(within(dialog).getByText(/can’t place calls until support sets its call limit/)).toBeTruthy();
  });

  it('keeps the modal open with the server\'s sentence when the name is taken', async () => {
    mocks.createAccount.mockRejectedValue(new ApiError(409, {
      error: 'Conflict', code: 'account_name_taken',
      message: 'There is already an account called "Renewals" in this organisation.',
    }));
    setup();
    const dialog = openModal();

    fireEvent.change(within(dialog).getByLabelText('Account name'), { target: { value: 'Renewals' } });
    fireEvent.click(within(dialog).getByRole('button', { name: /Create account/i }));

    expect((await screen.findByTestId('create-account-error')).textContent).toBe(
      'There is already an account called "Renewals" in this organisation.',
    );
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(mocks.reload).not.toHaveBeenCalled();
    expect(mocks.refreshSession).not.toHaveBeenCalled();
    expect(mocks.trackSetupEvent).toHaveBeenCalledWith('account_create_failed', { reason: 'name_taken' });
    expect(screen.getByLabelText('Account name').getAttribute('aria-invalid')).toBe('true');
  });

  it('pressing Enter on a blank name sends nothing', () => {
    setup();
    const dialog = openModal();
    const input = within(dialog).getByLabelText('Account name');
    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.submit(input.closest('form')!);
    expect(mocks.createAccount).not.toHaveBeenCalled();
  });

  it('reports a refusal of an account-scoped seat with its own reason', async () => {
    mocks.createAccount.mockRejectedValue(new ApiError(403, {
      error: 'Forbidden', code: 'tenant_wide_membership_required',
      message: 'Your admin access covers one account, not the whole organisation, so you cannot create accounts.',
    }));
    setup();
    const dialog = openModal();
    fireEvent.change(within(dialog).getByLabelText('Account name'), { target: { value: 'Renewals' } });
    fireEvent.click(within(dialog).getByRole('button', { name: /Create account/i }));

    expect((await screen.findByTestId('create-account-error')).textContent).toMatch(/covers one account/);
    expect(mocks.trackSetupEvent).toHaveBeenCalledWith('account_create_failed', { reason: 'not_tenant_wide' });
  });

  it('caps the name at the server\'s length', () => {
    setup();
    const dialog = openModal();
    expect(within(dialog).getByLabelText('Account name').getAttribute('maxlength')).toBe('100');
  });
});

describe('AccountsPage — after creating, invite the person who will run it', () => {
  async function createCollections() {
    mocks.createAccount.mockResolvedValue(account('acct-3', 'Collections'));
    setup();
    fireEvent.click(screen.getByRole('button', { name: /New account/i }));
    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Account name'), { target: { value: 'Collections' } });
    fireEvent.click(within(dialog).getByRole('button', { name: /Create account/i }));
    return screen.findByTestId('new-account-ready');
  }

  it('says the account is ready, what comes next, and that the reader stays where they are', async () => {
    const panel = await createCollections();

    expect(within(panel).getByRole('heading', { name: 'Collections is ready' })).toBeTruthy();
    expect(panel.textContent).toMatch(/Next, invite the person who’ll run it\. You stay in Default while you do\./);
    expect(mocks.setActiveAccountId).not.toHaveBeenCalled();
  });

  it('starts on Supervisor, with the account fixed to the new one', async () => {
    const panel = await createCollections();

    expect((within(panel).getByLabelText('Role') as HTMLSelectElement).value).toBe('account_admin');
    expect(within(panel).getByRole('option', { name: 'Supervisor (account admin)' })).toBeTruthy();
    const accountField = within(panel).getByLabelText('Account') as HTMLInputElement;
    expect(accountField.value).toBe('Collections');
    expect(accountField.readOnly).toBe(true);
  });

  it('sends the invite into the new account only, then shows the hand-off', async () => {
    mocks.inviteUser.mockResolvedValue({ invite_email: { sent: true } });
    const panel = await createCollections();

    fireEvent.change(within(panel).getByLabelText('Email'), { target: { value: ' lead@example.com ' } });
    fireEvent.click(within(panel).getByRole('button', { name: 'Send invite' }));

    await waitFor(() => expect(mocks.inviteUser).toHaveBeenCalledTimes(1));
    expect(mocks.inviteUser).toHaveBeenCalledWith(TENANT, {
      email: 'lead@example.com', role: 'account_admin', account_id: 'acct-3',
    });
    expect(mocks.trackSetupEvent).toHaveBeenCalledWith('team_invite_sent', { role: 'account_admin', account_scoped: true });
    expect(await within(panel).findByTestId('invite-emailed')).toBeTruthy();

    fireEvent.click(within(panel).getByRole('button', { name: 'Done' }));
    expect(screen.queryByTestId('new-account-ready')).toBeNull();
  });

  it('keeps the form and says why when the invite is refused', async () => {
    mocks.inviteUser.mockRejectedValue(new Error('already a member'));
    const panel = await createCollections();

    fireEvent.change(within(panel).getByLabelText('Email'), { target: { value: 'lead@example.com' } });
    fireEvent.click(within(panel).getByRole('button', { name: 'Send invite' }));

    expect((await within(panel).findByRole('alert')).textContent).toMatch(/already a member/);
    expect(within(panel).getByRole('button', { name: 'Send invite' })).toBeTruthy();
  });

  it('"Later" puts the panel away and sends nothing', async () => {
    const panel = await createCollections();

    fireEvent.click(within(panel).getByRole('button', { name: 'Later' }));

    expect(screen.queryByTestId('new-account-ready')).toBeNull();
    expect(mocks.inviteUser).not.toHaveBeenCalled();
  });
});
