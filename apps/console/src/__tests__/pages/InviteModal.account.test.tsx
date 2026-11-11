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
import { ALL_ACCOUNTS, inviteAccountId, inviterScopedAccount } from '../../pages/team/inviteScope';

const TENANT = 'tenant-1';

function seat(accountId: string | null) {
  return { tenant_id: TENANT, account_id: accountId, role: 'tenant_admin', status: 'active' as const };
}

function setup({ memberships = [seat(null)], currentAccountId = 'acct-1' } = {}) {
  mocks.useAuth.mockReturnValue({ memberships });
  mocks.useTenant.mockReturnValue({
    tenantId: TENANT,
    accountId: currentAccountId,
    accounts: [{ id: 'acct-1', name: 'Default' }],
  });
  mocks.useAccounts.mockReturnValue({
    accounts: [{ id: 'acct-1', name: 'Default' }, { id: 'acct-2', name: 'Renewals' }],
  });
  render(<InviteModal onClose={vi.fn()} onInvited={vi.fn()} onCreated={vi.fn()} />);
  fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'sup@example.com' } });
  fireEvent.change(screen.getByLabelText('Role'), { target: { value: 'account_admin' } });
}

const submitButton = () => screen.getByRole('button', { name: 'Create invite' }) as HTMLButtonElement;

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
});

describe('inviteScope', () => {
  it('maps a choice to the account_id to send, and nothing picked to null', () => {
    expect(inviteAccountId('')).toBeNull();
    expect(inviteAccountId(ALL_ACCOUNTS)).toBeUndefined();
    expect(inviteAccountId('acct-2')).toBe('acct-2');
  });

  it('reads the inviter as the server does: the row for this account first, then tenant-wide', () => {
    expect(inviterScopedAccount([seat(null)], TENANT, 'acct-1')).toBeNull();
    expect(inviterScopedAccount([seat('acct-1')], TENANT, 'acct-1')).toBe('acct-1');
    expect(inviterScopedAccount([seat(null), seat('acct-1')], TENANT, 'acct-1')).toBe('acct-1');
    expect(inviterScopedAccount([seat(null), seat('acct-2')], TENANT, 'acct-1')).toBeNull();
  });

  it('ignores inactive seats and other tenants', () => {
    expect(inviterScopedAccount([{ ...seat(null), status: 'revoked' as const }], TENANT, 'acct-1')).toBe('acct-1');
    expect(inviterScopedAccount([{ ...seat(null), tenant_id: 'tenant-2' }], TENANT, 'acct-1')).toBe('acct-1');
  });
});
