import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { TenantMember } from '../../types/team';

/**
 * Resending an invitation — the one-way door this closes.
 *
 * ── Why it is worth a test file rather than a line ────────────────────────
 * Invitations expire (seven days). The API's join page then tells the agent to
 * "ask your supervisor to send a new one" — and until this control existed, the
 * supervisor could not: `POST /users/invite` answers `409 User already has a
 * membership in this context` for the same address, so re-inviting is not a
 * recovery, and the only remaining move was to DELETE the membership and rebuild
 * it. The API shipped `POST /invites/resend` for exactly this and this repo had no
 * caller for it, which made the dead end certain rather than possible.
 *
 * The property under test is therefore not "a button renders". It is that the
 * recovery exists, that it is offered where it can actually work, and that it
 * says only what the API's answer supports.
 */

const mocks = vi.hoisted(() => ({
  useTeam: vi.fn(),
  useAccounts: vi.fn(),
  usePermission: vi.fn(),
  useTenant: vi.fn(),
  inviteUser: vi.fn(),
  updateUserRole: vi.fn(),
  removeUserMembership: vi.fn(),
  resendInvite: vi.fn(),
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
vi.mock('../../api/invites', () => ({ resendInvite: mocks.resendInvite }));
vi.mock('../../analytics/events', () => ({ trackSetupEvent: vi.fn() }));

import TeamPage from '../../pages/team/TeamPage';

/**
 * `inviteState` defaults to `'pending'` because that is the only case this
 * file's flows (asking, sending, reading the API's answer) are about — the
 * narrowing added by `invite_state` itself is covered by the cases below that
 * pass `'active'`/`'absent'` explicitly, alongside the pre-existing role and
 * permission narrowings this file already tests.
 *
 * `'absent'` is its own literal rather than `undefined`, because `undefined`
 * passed to a defaulted parameter is indistinguishable from omitting the
 * argument — it would silently become `'pending'` instead of describing an
 * older server that never sends the field at all. (The same literal appears in
 * `TeamPage.actionsMenu.test.tsx`, where its `makeMember` takes an options
 * object and it is only a NAME for leaving the key out.)
 *
 * The member's `firebase_uid` is the API's `pending_<uuid>` placeholder because
 * that stub is precisely what `invite_state: 'pending'` reports — this file's
 * default member is somebody who has never completed Firebase sign-in.
 */
function makeMember(
  role: TenantMember['membership']['role'],
  inviteState: 'active' | 'pending' | 'absent' = 'pending',
): TenantMember {
  return {
    membership: {
      id: 'mem-1',
      tenant_id: 'tenant-1',
      user_id: 'user-1',
      account_id: null,
      role,
      status: 'active',
      invited_by: null,
      created_at: '2026-06-07T00:00:00.000Z',
      updated_at: '2026-06-07T00:00:00.000Z',
      ...(inviteState === 'absent' ? {} : { invite_state: inviteState }),
    },
    user: {
      id: 'user-1',
      firebase_uid: 'pending_9f0',
      email: 'priya@acme.com',
      display_name: null,
      avatar_url: null,
      status: 'active',
      created_at: '2026-06-07T00:00:00.000Z',
      updated_at: '2026-06-07T00:00:00.000Z',
    },
  };
}

/** Render the page with one member and a chosen permission set. */
function renderTeam(
  role: TenantMember['membership']['role'],
  allowed = ['user.update_role', 'user.remove', 'user.invite'],
  inviteState: 'active' | 'pending' | 'absent' = 'pending',
) {
  mocks.useTeam.mockReturnValue({
    members: [makeMember(role, inviteState)],
    loading: false,
    error: null,
    reload: mocks.reload,
  });
  mocks.usePermission.mockImplementation((p: string) => allowed.includes(p));
  return render(
    <MemoryRouter>
      <TeamPage />
    </MemoryRouter>,
  );
}

function openMenu() {
  fireEvent.click(screen.getByRole('button', { name: 'Member actions' }));
}

beforeEach(() => {
  mocks.useAccounts.mockReturnValue({ accounts: [] });
  mocks.useTenant.mockReturnValue({ tenantId: 'tenant-1', role: 'tenant_admin' });
  mocks.resendInvite.mockResolvedValue({ invite_email: { sent: true }, sign_in_url: null });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('resending an invitation', () => {
  it('is offered for a pending agent, whose invitation is the only one the API mints a token for', () => {
    /*
      Two conditions, not one: `invite_state` is the API's own answer to "has
      this person signed up" (this member defaults to `pending` — see
      `makeMember`), and the role is still required on top of it because
      `roleGetsTokenInvite` mints a token for an `agent` and nobody else — a
      pending `viewer` (below) has not signed up either, but resending to one
      would be a button that cannot produce a claimable link.
    */
    renderTeam('agent');
    openMenu();

    expect(screen.getByRole('menuitem', { name: /Resend Invite/i })).toBeTruthy();
  });

  it('is not offered for a role that gets no token, even while pending', () => {
    renderTeam('viewer');
    openMenu();

    expect(screen.queryByRole('menuitem', { name: /Resend Invite/i })).toBeNull();
  });

  it('is not offered without the permission the API enforces on the route', () => {
    // `user.invite`, the same permission `POST /invites/resend` requires. A menu
    // item behind a looser check would 403 on arrival.
    renderTeam('agent', ['user.update_role', 'user.remove'], 'pending');
    openMenu();

    expect(screen.queryByRole('menuitem', { name: /Resend Invite/i })).toBeNull();
  });

  it('is not offered for an agent who has already signed up', () => {
    /*
      `invite_state: 'active'` means the person has completed Firebase sign-in,
      so the commonest reason to resend — they never got, or have lost, the
      link that creates their login — cannot apply to them.

      This is a UI judgement rather than a backend constraint: The API's `POST
      /invites/resend` has no refusal for an already-joined membership and
      would mint and mail a fresh link quite happily. Withholding the control
      keeps a supervisor from sending a "set yourself up" email to somebody who
      already has an account, at the cost noted in `invitationIsResendable` —
      an agent with a login who has never opened THIS workspace also reads
      `active`, and is not offered one either.
    */
    renderTeam('agent', undefined, 'active');
    openMenu();

    expect(screen.queryByRole('menuitem', { name: /Resend Invite/i })).toBeNull();
  });

  it('is STILL offered for an agent when `invite_state` is absent (older server build)', () => {
    /*
      The asymmetry that makes `inviteNotKnownJoined` a separate export from
      the badge's own handling. The badge can decline to answer and render a
      neutral placeholder; a predicate cannot — it must return a boolean, and
      it must not return the one meaning "joined", because "no field" is what an older server
      sends — a rollback, or a browser holding a cached SPA against a
      redeployed one — and treating it as `'active'` would remove Resend from
      every agent on the platform at once, silently, with nothing on screen to
      explain it. Resend is the only remedy for an expired or never-sent
      invitation, and it was offered to every agent before this ticket, so
      absent must keep behaving exactly as it did.
    */
    renderTeam('agent', undefined, 'absent');
    openMenu();

    expect(screen.getByRole('menuitem', { name: /Resend Invite/i })).toBeTruthy();
  });

  it('asks before it sends, because sending INVALIDATES the link they already have', async () => {
    /*
      the API revokes the outstanding token before minting a new one, so pressing
      this breaks a link that may be sitting unread in the agent's inbox. A
      supervisor who meant to press "Change Role" must not discover that by having
      broken it.
    */
    renderTeam('agent');
    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: /Resend Invite/i }));

    expect(await screen.findByText(/any earlier link stops working/i)).toBeTruthy();
    expect(mocks.resendInvite).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Send invitation' }));

    await waitFor(() =>
      expect(mocks.resendInvite).toHaveBeenCalledWith('tenant-1', 'mem-1'),
    );
  });

  it('reports what the API said about the email, rather than assuming', async () => {
    renderTeam('agent');
    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: /Resend Invite/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Send invitation' }));

    const told = await screen.findByTestId('resend-emailed');
    expect(told.textContent).toMatch(/we’ve emailed/i);
    expect(screen.queryByTestId('resend-handoff')).toBeNull();
  });

  it('hands over the link when the API did not send it', async () => {
    mocks.resendInvite.mockResolvedValue({
      invite_email: { sent: false, reason: 'not_configured' },
      sign_in_url: 'https://app.example.com/agency/join/tok_abc',
    });
    renderTeam('agent');
    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: /Resend Invite/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Send invitation' }));

    expect(await screen.findByTestId('resend-handoff')).toBeTruthy();
    expect(screen.getByText('https://app.example.com/agency/join/tok_abc')).toBeTruthy();
  });

  it('says so rather than substituting a link the API could not build', async () => {
    /*
      The useful link carries the freshly minted TOKEN, which only the API has ever
      seen — there is no client-side derivation for it. Offering the sign-in page
      instead would be a URL that looks like the invitation and claims nothing.
    */
    mocks.resendInvite.mockResolvedValue({
      invite_email: { sent: false, reason: 'not_configured' },
      sign_in_url: null,
    });
    renderTeam('agent');
    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: /Resend Invite/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Send invitation' }));

    expect(await screen.findByTestId('resend-no-link')).toBeTruthy();
    expect(screen.queryByText(/agency\/login/)).toBeNull();
  });

  it('keeps the failure on the panel instead of closing over it', async () => {
    mocks.resendInvite.mockRejectedValue(new Error('Membership not found'));
    renderTeam('agent');
    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: /Resend Invite/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Send invitation' }));

    expect(await screen.findByText('Membership not found')).toBeTruthy();
    // Still pressable: a resend that failed is one worth trying again.
    expect(screen.getByRole('button', { name: 'Send invitation' })).toBeTruthy();
  });
});
