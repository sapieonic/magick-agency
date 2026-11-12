import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';

/**
 * Which account an invite from Team puts somebody in.
 *
 * The defect: the Account field was "optional" and started on "Tenant-level", and the
 * server reads an absent `account_id` as a seat in EVERY account. An owner inviting one
 * account's supervisor who forgot the field handed them the whole workspace. Every role
 * the invite offers is an account's role, so nothing is sent until an account (or "All
 * accounts", picked on purpose) is chosen.
 */

const mocks = vi.hoisted(() => ({
  useAuth: vi.fn(),
  useTenant: vi.fn(),
  useAccounts: vi.fn(),
  inviteUser: vi.fn(),
  trackSetupEvent: vi.fn(),
}));

vi.mock('../../contexts/AuthContext', () => ({ useAuth: mocks.useAuth }));
vi.mock('../../contexts/TenantContext', () => ({ useTenant: mocks.useTenant }));
vi.mock('../../hooks/useAccounts', () => ({ useAccounts: mocks.useAccounts }));
vi.mock('../../api/users', () => ({ inviteUser: mocks.inviteUser }));
vi.mock('../../analytics/events', () => ({ trackSetupEvent: mocks.trackSetupEvent }));
vi.mock('../../contexts/GovernanceContext', () => ({
  useGovernance: () => ({ isEnabled: () => true, loading: false }),
}));
vi.mock('../../contexts/FeatureFlagsContext', () => ({
  useFeatureFlags: () => ({ isEnabled: () => true, status: 'ready' }),
}));

import { InviteModal } from '../../pages/team/InviteModal';
import { ALL_ACCOUNTS, inviteAccountId, inviterScope } from '../../pages/team/inviteScope';

const TENANT = 'tenant-1';

function seat(accountId: string | null) {
  return { tenant_id: TENANT, account_id: accountId, role: 'tenant_admin', status: 'active' as const };
}

type Seat = ReturnType<typeof seat>;

function mockScope(memberships: Seat[], currentAccountId: string | null) {
  mocks.useAuth.mockReturnValue({ memberships });
  mocks.useTenant.mockReturnValue({
    tenantId: TENANT,
    accountId: currentAccountId,
    accounts: [{ id: 'acct-1', name: 'Default' }],
  });
}

const modal = () => <InviteModal onClose={vi.fn()} onInvited={vi.fn()} onCreated={vi.fn()} />;

function setup({ memberships = [seat(null)], currentAccountId = 'acct-1' as string | null } = {}) {
  mockScope(memberships, currentAccountId);
  mocks.useAccounts.mockReturnValue({
    accounts: [{ id: 'acct-1', name: 'Default' }, { id: 'acct-2', name: 'Renewals' }],
  });
  const view = render(modal());
  fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'sup@example.com' } });
  fireEvent.change(screen.getByLabelText('Role'), { target: { value: 'account_admin' } });
  return view;
}

const submitButton = () => screen.getByRole('button', { name: 'Send invite' }) as HTMLButtonElement;

beforeEach(() => {
  mocks.inviteUser.mockResolvedValue({ invite_email: { sent: true } });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('InviteModal — the account is always an explicit choice', () => {
  it('starts with no account chosen, and cannot be sent like that', () => {
    setup();

    expect((screen.getByLabelText('Account') as HTMLSelectElement).value).toBe('');
    expect(submitButton().disabled).toBe(true);

    // Enter in the email field submits the form directly, past the disabled button.
    fireEvent.submit(screen.getByLabelText('Email').closest('form')!);
    expect(mocks.inviteUser).not.toHaveBeenCalled();
  });

  it('offers no field labelled optional and no "Tenant-level" default', () => {
    setup();
    expect(screen.queryByLabelText(/optional/i)).toBeNull();
    expect(screen.queryByRole('option', { name: 'Tenant-level' })).toBeNull();
  });

  it('sends the account that was picked', async () => {
    setup();
    fireEvent.change(screen.getByLabelText('Account'), { target: { value: 'acct-2' } });
    fireEvent.click(submitButton());

    await waitFor(() => expect(mocks.inviteUser).toHaveBeenCalledTimes(1));
    expect(mocks.inviteUser).toHaveBeenCalledWith(TENANT, {
      email: 'sup@example.com', role: 'account_admin', account_id: 'acct-2',
    });
    expect(mocks.trackSetupEvent).toHaveBeenCalledWith('team_invite_sent', { role: 'account_admin', account_scoped: true });
  });

  it('leaves the account out only when "All accounts" is picked on purpose', async () => {
    setup();
    fireEvent.change(screen.getByLabelText('Account'), { target: { value: ALL_ACCOUNTS } });
    fireEvent.click(submitButton());

    await waitFor(() => expect(mocks.inviteUser).toHaveBeenCalledTimes(1));
    expect(mocks.inviteUser).toHaveBeenCalledWith(TENANT, {
      email: 'sup@example.com', role: 'account_admin', account_id: undefined,
    });
  });

  it('holds an account-scoped inviter to their own account, filled in, with no "All accounts"', async () => {
    /* The server refuses a scoped inviter anything else (`accountScopeMismatch`). */
    setup({ memberships: [seat('acct-1')] });

    expect(screen.queryByRole('option', { name: /All accounts/ })).toBeNull();
    expect(screen.queryByRole('option', { name: 'Renewals' })).toBeNull();
    expect((screen.getByLabelText('Account') as HTMLSelectElement).value).toBe('acct-1');

    fireEvent.click(submitButton());
    await waitFor(() => expect(mocks.inviteUser).toHaveBeenCalledTimes(1));
    expect(mocks.inviteUser.mock.calls[0]![1]).toMatchObject({ account_id: 'acct-1' });
  });

  it('holds a scoped inviter to their one account even before an account is in view', async () => {
    /* `null` is also "tenant-wide": read as that, the form offered every account and "All
       accounts" to someone the server refuses each of them to. */
    setup({ memberships: [seat('acct-1')], currentAccountId: null });

    expect(screen.queryByRole('option', { name: /All accounts/ })).toBeNull();
    expect(screen.queryByRole('option', { name: 'Renewals' })).toBeNull();
    expect((screen.getByLabelText('Account') as HTMLSelectElement).value).toBe('acct-1');
    fireEvent.click(submitButton());
    await waitFor(() => expect(mocks.inviteUser).toHaveBeenCalledTimes(1));
    expect(mocks.inviteUser.mock.calls[0]![1]).toMatchObject({ account_id: 'acct-1' });
  });

  it('offers no account, and says why, when it cannot tell which account a scoped inviter is held to', () => {
    setup({ memberships: [seat('acct-1'), seat('acct-2')], currentAccountId: 'acct-1' });

    const select = screen.getByLabelText('Account') as HTMLSelectElement;
    expect(select.disabled).toBe(true);
    expect(screen.queryByRole('option', { name: /All accounts/ })).toBeNull();
    expect(screen.queryByRole('option', { name: 'Renewals' })).toBeNull();
    expect(screen.getByText(/can’t tell which one it may use/)).toBeTruthy();
    expect(submitButton().disabled).toBe(true);
    fireEvent.submit(screen.getByLabelText('Email').closest('form')!);
    expect(mocks.inviteUser).not.toHaveBeenCalled();
  });

  it('follows the scope when it resolves while the modal is open', async () => {
    /* Seeded once, the choice stayed '' after the scope resolved: no option matched it and
       Send stayed disabled. */
    const { rerender } = setup({ memberships: [], currentAccountId: null });
    expect(submitButton().disabled).toBe(true);

    mockScope([seat('acct-1')], 'acct-1');
    rerender(modal());

    expect((screen.getByLabelText('Account') as HTMLSelectElement).value).toBe('acct-1');
    expect(submitButton().disabled).toBe(false);
    fireEvent.click(submitButton());
    await waitFor(() => expect(mocks.inviteUser).toHaveBeenCalledTimes(1));
    expect(mocks.inviteUser.mock.calls[0]![1]).toMatchObject({ account_id: 'acct-1' });
  });
});

describe('inviteScope', () => {
  it('maps a choice to the account_id to send, and nothing picked to null', () => {
    expect(inviteAccountId('')).toBeNull();
    expect(inviteAccountId(ALL_ACCOUNTS)).toBeUndefined();
    expect(inviteAccountId('acct-2')).toBe('acct-2');
  });

  const tenant = { kind: 'tenant' };
  const account = (accountId: string) => ({ kind: 'account', accountId });
  const unknown = { kind: 'unknown' };

  it('reads a tenant-wide inviter as unrestricted, unless they also hold the account in view', () => {
    expect(inviterScope([seat(null)], TENANT, 'acct-1')).toEqual(tenant);
    expect(inviterScope([seat(null)], TENANT, null)).toEqual(tenant);
    expect(inviterScope([seat(null), seat('acct-1')], TENANT, 'acct-1')).toEqual(account('acct-1'));
    expect(inviterScope([seat(null), seat('acct-2')], TENANT, 'acct-1')).toEqual(tenant);
  });

  it('never reads an inviter with no tenant-wide row as unrestricted', () => {
    expect(inviterScope([seat('acct-1')], TENANT, 'acct-1')).toEqual(account('acct-1'));
    // No account in view yet: their one account, not "tenant-wide".
    expect(inviterScope([seat('acct-1')], TENANT, null)).toEqual(account('acct-1'));
    expect(inviterScope([seat('acct-1'), seat('acct-1')], TENANT, null)).toEqual(account('acct-1'));
    // The invite carries no account header, so the server holds a two-account inviter to
    // their OLDEST row, whatever is in view: the page cannot say which.
    expect(inviterScope([seat('acct-1'), seat('acct-2')], TENANT, 'acct-1')).toEqual(unknown);
    expect(inviterScope([seat('acct-1'), seat('acct-2')], TENANT, null)).toEqual(unknown);
    expect(inviterScope([], TENANT, 'acct-1')).toEqual(unknown);
  });

  it('ignores inactive seats and other tenants', () => {
    expect(inviterScope([{ ...seat(null), status: 'revoked' as const }, seat('acct-1')], TENANT, null)).toEqual(account('acct-1'));
    expect(inviterScope([{ ...seat(null), tenant_id: 'tenant-2' }, seat('acct-1')], TENANT, null)).toEqual(account('acct-1'));
    expect(inviterScope([{ ...seat(null), status: 'revoked' as const }], TENANT, 'acct-1')).toEqual(unknown);
  });
});
