import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { TenantMember } from '../../types/team';

/**
 * TeamPage — a failed role change or removal is SAID, not swallowed.
 *
 * Both handlers used to `catch {}` with a comment promising that "reload will
 * show current state" — and no reload ran on the failure path, so a supervisor
 * who changed a role and got a 403 saw the menu close and nothing else, and read
 * the unchanged badge as the change not having landed YET.
 *
 * Also: a reload (after an invite, a role change, a removal) keeps the table on
 * screen instead of swapping the whole page for a spinner.
 */
const mocks = vi.hoisted(() => ({
  useTeam: vi.fn(),
  useAccounts: vi.fn(),
  usePermission: vi.fn(),
  useTenant: vi.fn(),
  inviteUser: vi.fn(),
  updateUserRole: vi.fn(),
  removeUserMembership: vi.fn(),
  reload: vi.fn(),
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
vi.mock('../../analytics/events', () => ({ trackSetupEvent: vi.fn() }));

import TeamPage from '../../pages/team/TeamPage';

function member(): TenantMember {
  return {
    membership: {
      id: 'mem-1',
      tenant_id: 'tenant-1',
      user_id: 'user-1',
      account_id: null,
      role: 'viewer',
      status: 'active',
      invited_by: null,
      created_at: '2026-06-07T00:00:00.000Z',
      updated_at: '2026-06-07T00:00:00.000Z',
      invite_state: 'active',
    },
    user: {
      id: 'user-1',
      firebase_uid: 'fb-1',
      email: 'priya@example.com',
      display_name: 'Priya',
      avatar_url: null,
      status: 'active',
      created_at: '2026-06-07T00:00:00.000Z',
      updated_at: '2026-06-07T00:00:00.000Z',
    },
  };
}

function renderPage() {
  return render(
    <MemoryRouter>
      <TeamPage />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  mocks.useTeam.mockReturnValue({
    members: [member()],
    loading: false,
    loaded: true,
    error: null,
    reload: mocks.reload,
  });
  mocks.useAccounts.mockReturnValue({ accounts: [] });
  mocks.usePermission.mockReturnValue(true);
  mocks.useTenant.mockReturnValue({ tenantId: 'tenant-1', role: 'tenant_admin' });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('TeamPage — failed member actions are reported', () => {
  it('says so when a role change is refused', async () => {
    mocks.updateUserRole.mockRejectedValue(new Error('You cannot assign that role'));
    renderPage();

    fireEvent.click(screen.getByRole('button', { name: 'Member actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /Change Role/i }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Operator' }));

    const alert = await screen.findByTestId('team-action-error');
    expect(alert.textContent).toContain('Could not change Priya’s role');
    expect(alert.textContent).toContain('You cannot assign that role');
    expect(mocks.reload).not.toHaveBeenCalled();
  });

  it('says so when a removal is refused, and closes the confirmation', async () => {
    mocks.removeUserMembership.mockRejectedValue(new Error('Membership is locked'));
    renderPage();

    fireEvent.click(screen.getByRole('button', { name: 'Member actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /^Remove$/i }));
    const dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove' }));

    const alert = await screen.findByTestId('team-action-error');
    expect(alert.textContent).toContain('Could not remove Priya');
    expect(alert.textContent).toContain('Membership is locked');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('clears the message once the next action succeeds', async () => {
    mocks.updateUserRole.mockRejectedValueOnce(new Error('nope')).mockResolvedValueOnce(undefined);
    renderPage();

    const changeTo = (name: string) => {
      fireEvent.click(screen.getByRole('button', { name: 'Member actions' }));
      fireEvent.click(screen.getByRole('menuitem', { name: /Change Role/i }));
      fireEvent.click(screen.getByRole('menuitem', { name }));
    };
    changeTo('Operator');
    await screen.findByTestId('team-action-error');
    changeTo('Operator');
    await waitFor(() => expect(mocks.reload).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId('team-action-error')).toBeNull();
  });
});

describe('TeamPage — a reload keeps the table', () => {
  it('shows the spinner only for the first load', () => {
    mocks.useTeam.mockReturnValue({
      members: [member()],
      loading: true,
      loaded: true,
      error: null,
      reload: mocks.reload,
    });
    renderPage();
    expect(screen.getByText('priya@example.com')).toBeTruthy();
  });

  it('still shows the spinner before anything has loaded', () => {
    mocks.useTeam.mockReturnValue({
      members: [],
      loading: true,
      loaded: false,
      error: null,
      reload: mocks.reload,
    });
    const { container } = renderPage();
    expect(screen.queryByRole('table')).toBeNull();
    expect(container.querySelector('[role="status"], [aria-busy="true"], svg')).toBeTruthy();
  });
});
