import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const mocks = vi.hoisted(() => ({
  useTeam: vi.fn(),
  useAccounts: vi.fn(),
  usePermission: vi.fn(),
  useTenant: vi.fn(),
  inviteUser: vi.fn(),
  updateUserRole: vi.fn(),
  removeUserMembership: vi.fn(),
  trackSetupEvent: vi.fn(),
}));

vi.mock('../../hooks/useTeam', () => ({ useTeam: mocks.useTeam }));
vi.mock('../../hooks/useAccounts', () => ({ useAccounts: mocks.useAccounts }));
vi.mock('../../hooks/usePermission', () => ({ usePermission: mocks.usePermission }));
vi.mock('../../contexts/TenantContext', () => ({ useTenant: mocks.useTenant }));
vi.mock('../../api/users', () => ({
  inviteUser: mocks.inviteUser,
  updateUserRole: mocks.updateUserRole,
  removeUserMembership: mocks.removeUserMembership,
}));
vi.mock('../../analytics/events', () => ({ trackSetupEvent: mocks.trackSetupEvent }));
vi.mock('../../components/common', () => ({
  PageHeader: ({ title, actions }: { title: string; actions?: React.ReactNode }) => <div><h1>{title}</h1>{actions}</div>,
  PageDescription: () => null,
  LoadingSpinner: () => null,
  ErrorAlert: () => null,
  EmptyState: ({ action }: { action?: React.ReactNode }) => <div>{action}</div>,
  ConfirmDialog: () => null,
}));

import TeamPage from '../../pages/team/TeamPage';

describe('TeamPage analytics', () => {
  beforeEach(() => {
    mocks.useTeam.mockReturnValue({ members: [], loading: false, error: null, reload: vi.fn() });
    mocks.useAccounts.mockReturnValue({ accounts: [] });
    mocks.usePermission.mockReturnValue(true);
    mocks.useTenant.mockReturnValue({ tenantId: 'tenant-1', role: 'tenant_admin' });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('tracks invite failures with the actual safe role and no invite email', async () => {
    mocks.inviteUser.mockRejectedValueOnce(new Error('invite exploded'));

    render(<MemoryRouter><TeamPage /></MemoryRouter>);

    fireEvent.click(screen.getAllByText('Invite Member')[0]!);
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'user@example.com' } });
    fireEvent.change(screen.getByLabelText('Role'), { target: { value: 'viewer' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create Invite' }));

    await waitFor(() => {
      expect(mocks.trackSetupEvent).toHaveBeenCalledWith(
        'team_invite_failed',
        { role: 'viewer', account_scoped: false, reason: 'invite_error' },
      );
    });

    const failedPayload = mocks.trackSetupEvent.mock.calls.find(
      (call: unknown[]) => call[0] === 'team_invite_failed',
    )?.[1];

    expect(failedPayload).not.toHaveProperty('email');
    expect(failedPayload).not.toHaveProperty('message');
    expect(failedPayload).not.toHaveProperty('error');
    expect(Object.values(failedPayload ?? {})).not.toContain('user@example.com');
    expect(Object.values(failedPayload ?? {})).not.toContain('invite exploded');
  });

  it('tracks successful invites with the selected safe role and no invite email', async () => {
    mocks.inviteUser.mockResolvedValueOnce(undefined);
    mocks.useAccounts.mockReturnValue({
      accounts: [{ id: 'account-2', name: 'Sales' }],
    });

    render(<MemoryRouter><TeamPage /></MemoryRouter>);

    fireEvent.click(screen.getAllByText('Invite Member')[0]!);
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'operator@example.com' } });
    fireEvent.change(screen.getByLabelText('Role'), { target: { value: 'operator' } });
    fireEvent.change(screen.getByLabelText('Account (optional)'), { target: { value: 'account-2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create Invite' }));

    await waitFor(() => {
      expect(mocks.trackSetupEvent).toHaveBeenCalledWith(
        'team_invite_sent',
        { role: 'operator', account_scoped: true },
      );
    });

    const sentPayload = mocks.trackSetupEvent.mock.calls.find(
      (call: unknown[]) => call[0] === 'team_invite_sent',
    )?.[1];

    expect(sentPayload).not.toHaveProperty('email');
    expect(sentPayload).not.toHaveProperty('account_id');
    expect(Object.values(sentPayload ?? {})).not.toContain('operator@example.com');
    expect(Object.values(sentPayload ?? {})).not.toContain('Sales');
  });
});
