import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

/**
 * The invite hand-off panel — the screen that says nobody emailed anyone.
 *
 * ── The defect this pins ────────────────────────────────────────────────────
 * `POST /users/invite` writes a membership and, for a new address, a stub user
 * whose `firebase_uid` is `pending_<uuid>`; The API adopts that stub on the
 * invitee's first Firebase sign-in, matched BY EMAIL. **Nothing sends that invite**
 * — the API has a Mailjet transport for bulk-dispatch mail, but no transactional
 * path was ever wired to it. The modal nevertheless said "Send Invite" and
 * "Sending...", then closed, so a supervisor had every reason to believe an email
 * was on its way and the invitee waited for one that never came.
 *
 * These tests hold the two halves of the fix in place: the wording no longer
 * claims to send, and the panel that follows carries the two things somebody has
 * to pass on by hand.
 *
 * ── Why the `agent` case is tested separately ──────────────────────────────
 * Every other role's landing is `/app`, reached through `/login`. An `agent` is
 * hierarchy level 5 and inherits no navigation, so their link points at the Agency
 * Dialer's own sign-in page instead — `/agency/login`, which has no Sign Up tab on
 * it. That last part is why the branch is worth a test of its own rather than
 * being read as a cosmetic difference: `POST /auth/session` provisions a
 * brand-new tenant for an address the API does not recognise, and an invite is
 * activated by matching the address the invitee signs in with, so an agent who
 * signs UP from an invite link lands in a private empty tenant while the
 * membership sits unclaimed.
 *
 * The link used to be `/login?next=%2Fdialer`, and an earlier revision of this
 * header described that rule. The `next` is gone: the agency door defaults to
 * `/agency`, which resolves the persona from the RBAC role, so the landing lives
 * in one place instead of being copied into every link that points at sign-in.
 */

const mocks = vi.hoisted(() => ({
  useTeam: vi.fn(),
  useAccounts: vi.fn(),
  usePermission: vi.fn(),
  useTenant: vi.fn(),
  useGovernance: vi.fn(),
  useFeatureFlags: vi.fn(),
  inviteUser: vi.fn(),
  updateUserRole: vi.fn(),
  removeUserMembership: vi.fn(),
  trackSetupEvent: vi.fn(),
  reload: vi.fn(),
}));

vi.mock('../../hooks/useTeam', () => ({ useTeam: mocks.useTeam }));
vi.mock('../../hooks/useAccounts', () => ({ useAccounts: mocks.useAccounts }));
vi.mock('../../hooks/usePermission', () => ({ usePermission: mocks.usePermission }));
vi.mock('../../contexts/TenantContext', () => ({ useTenant: mocks.useTenant }));
vi.mock('../../contexts/GovernanceContext', () => ({ useGovernance: mocks.useGovernance }));
vi.mock('../../contexts/FeatureFlagsContext', () => ({ useFeatureFlags: mocks.useFeatureFlags }));
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

import TeamPage, { inviteSignInUrl } from '../../pages/team/TeamPage';

/** Drive the modal from the Invite button through to a settled hand-off panel. */
async function invite(role: string, email: string) {
  render(<MemoryRouter><TeamPage /></MemoryRouter>);

  fireEvent.click(screen.getAllByText('Invite Member')[0]!);
  fireEvent.change(screen.getByLabelText('Email'), { target: { value: email } });
  fireEvent.change(screen.getByLabelText('Role'), { target: { value: role } });
  fireEvent.click(screen.getByRole('button', { name: 'Create Invite' }));

  await waitFor(() => {
    expect(screen.getByRole('button', { name: 'Done' })).toBeTruthy();
  });
}

beforeEach(() => {
  mocks.useTeam.mockReturnValue({ members: [], loading: false, error: null, reload: mocks.reload });
  mocks.useAccounts.mockReturnValue({ accounts: [] });
  mocks.usePermission.mockReturnValue(true);
  mocks.useTenant.mockReturnValue({ tenantId: 'tenant-1', role: 'tenant_admin' });
  /*
    The dialer ON by default, so the `agent` cases below read the sentence they
    were written for and the gated variants are asked for explicitly.
  */
  mocks.useGovernance.mockReturnValue({ isEnabled: () => true, loading: false });
  mocks.useFeatureFlags.mockReturnValue({ isEnabled: () => true, status: 'ready' });
  /*
    The 201 body, as the API actually sends it. `undefined` was what this mock
    returned while the client discarded the response, and it is a shape the API has
    never produced — a fixture that describes nothing cannot pin anything.
  */
  mocks.inviteUser.mockResolvedValue({
    user: { id: 'u-9', email: 'newbie@example.com' },
    invite_email: { sent: false, reason: 'not_implemented' },
    sign_in_url: null,
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('inviteSignInUrl', () => {
  it('sends an agent to the agency door', () => {
    /* Not `/login?next=/dialer`, which is what this used to be. An `agent` never
       wants the generic sign-in door: a Sign Up tab there would put them in a
       private empty tenant of their own — `POST /auth/session` provisions one for
       an address the API does not recognise — while the membership their supervisor
       created sits unclaimed. */
    expect(inviteSignInUrl('agent', 'https://app.example.com'))
      .toBe('https://app.example.com/agency/login');
  });

  it('no longer pins the landing path in the link', () => {
    /* The agency door defaults to `/agency`, which is `AgencyHomeRedirect`, which
       resolves the persona from the RBAC role. So the destination lives in one
       place instead of being copied into every link that points at sign-in — and
       a supervisor who follows an agent's link is routed to their campaigns rather
       than to an agent home that would be empty for them. */
    expect(inviteSignInUrl('agent', 'https://x.test')).not.toContain('next=');
  });

  it.each(['account_admin', 'operator', 'viewer'] as const)(
    'leaves %s on the primary door',
    (role) => {
      /* A supervisor is `account_admin` or above and legitimately administers in
         `/app` — team, credits, invoices, settings. Sending every `account_admin`
         invite to the agency door would be wrong for the majority of tenants,
         which have no dialer at all. */
      expect(inviteSignInUrl(role, 'https://app.example.com'))
        .toBe('https://app.example.com/login');
    },
  );

  it('agrees with the API, which computes the same rule from its own base URL', () => {
    /* The rule is duplicated between the server's invite mailer and this client,
       which cannot import each other, and the only thing keeping
       them honest is that both suites assert the same strings. A divergence should
       show up as two suites disagreeing rather than as an agent quietly landing on
       the wrong page.

       The two signatures are NOT the same width, and that is why this case names
       the roles it does. The API takes a `MembershipRole` — all six — because it
       serves the link for whatever membership was written. This copy takes
       `InviteUserInput['role']`, which is the four roles `POST /users/invite`
       accepts (`types/team.ts`); `tenant_admin` and `tenant_owner` are not
       invitable through this UI and are not expressible here. So the API's suite
       covers those two and this one cannot, which is a coverage asymmetry rather
       than a gap: the branch under test is `agent` vs everything else, and
       "everything else" is exercised on both sides. */
    expect(inviteSignInUrl('agent', 'https://app.example.com'))
      .toBe('https://app.example.com/agency/login');
    expect(inviteSignInUrl('account_admin', 'https://app.example.com'))
      .toBe('https://app.example.com/login');
  });
});

describe('the invite modal does not claim to send anything', () => {
  it('labels the submit button as creating, not sending', () => {
    render(<MemoryRouter><TeamPage /></MemoryRouter>);
    fireEvent.click(screen.getAllByText('Invite Member')[0]!);

    expect(screen.getByRole('button', { name: 'Create Invite' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Send Invite' })).toBeNull();
  });

  it('says outright that no email went out', async () => {
    await invite('viewer', 'newbie@example.com');

    expect(screen.getByText(/we didn’t email them/i)).toBeTruthy();
  });

  it('stays open on success so the hand-off cannot be missed', async () => {
    /* The modal used to close here. Dismissing the one screen that explains the
       supervisor is now the delivery mechanism would lose the whole fix. */
    await invite('viewer', 'newbie@example.com');

    expect(screen.getByRole('button', { name: 'Done' })).toBeTruthy();
  });
});

describe('the hand-off panel carries what has to be passed on', () => {
  it('shows the invited address, since sign-in is matched on it', async () => {
    await invite('viewer', 'newbie@example.com');

    /* Rendered twice — once in the lead sentence, once as a copyable field. Both
       are the point: the sentence explains it, the field is what gets pasted. */
    expect(screen.getAllByText('newbie@example.com').length).toBeGreaterThan(0);
  });

  it('shows a plain sign-in link for a non-agent', async () => {
    await invite('operator', 'op@example.com');

    /* `endsWith('/login')` alone would also match `/agency/login`, so the agency
       door is excluded explicitly — the whole point of this case is that a
       non-agent does NOT get it. */
    const field = screen.getByText(
      (text) => text.endsWith('/login') && !text.endsWith('/agency/login'),
    );
    expect(field).toBeTruthy();
  });

  it('shows an agency-door link for an agent', async () => {
    await invite('agent', 'agent@example.com');

    expect(screen.getByText((text) => text.includes('/agency/login'))).toBeTruthy();
  });

  it('explains the dialer link only for an agent', async () => {
    await invite('agent', 'agent@example.com');

    expect(screen.getByText(/straight to the dialer/i)).toBeTruthy();
  });

  it('does not explain a dialer link to a role that has no dialer link', async () => {
    await invite('viewer', 'v@example.com');

    expect(screen.queryByText(/straight to the dialer/i)).toBeNull();
    expect(screen.queryByTestId('agent-dialer-gated-note')).toBeNull();
  });
});

describe('the panel reads what the API said about the email', () => {
  /**
   * The response used to be discarded, and that gave the panel an expiry date it
   * could not see: The API ships `invite_email` and `sign_in_url` for exactly this
   * hand-off, so once a transport is wired up the panel would have gone on
   * insisting "we didn't email them" about an email that had just been sent.
   */
  it('drops the hand-off entirely once the API reports the invite sent', async () => {
    mocks.inviteUser.mockResolvedValue({
      invite_email: { sent: true },
      sign_in_url: 'https://app.example.com/login',
    });

    await invite('viewer', 'newbie@example.com');

    expect(screen.getByTestId('invite-emailed')).toBeTruthy();
    expect(screen.queryByTestId('invite-handoff')).toBeNull();
    expect(screen.queryByText(/we didn’t email them/i)).toBeNull();
    /*
      And no link to pass on. Telling somebody to send a link that has already
      been sent produces a second, confusing message to the invitee — and an
      instruction the product knows to be unnecessary reads as one it cannot be
      trusted about elsewhere.
    */
    expect(screen.queryByText('Sign-in link')).toBeNull();
    // The address stays: sign-in is matched on it, and a typo is the one failure
    // the supervisor can still fix.
    expect(screen.getAllByText('newbie@example.com').length).toBeGreaterThan(0);
  });

  it('keeps the hand-off when the API reports it could not send', async () => {
    mocks.inviteUser.mockResolvedValue({
      invite_email: { sent: false, reason: 'not_configured' },
      sign_in_url: null,
    });

    await invite('viewer', 'newbie@example.com');

    expect(screen.getByTestId('invite-handoff')).toBeTruthy();
    expect(screen.getByText('Sign-in link')).toBeTruthy();
  });

  it('does not crash on a body that is not there at all', async () => {
    /**
     * `apiFetch` answers `undefined` for a 204. A `.` into that inside the render
     * would take the page down AFTER the membership had been written — the one
     * moment the supervisor most needs to be told what happened.
     */
    mocks.inviteUser.mockResolvedValue(undefined);

    await invite('viewer', 'newbie@example.com');

    expect(screen.getByTestId('invite-handoff')).toBeTruthy();
  });

  it('keeps the hand-off against an API that says nothing at all', async () => {
    /**
     * An older server, or one mid-deploy. Read as "not sent", which is the safe
     * direction to be wrong in: a hand-off nobody needed, rather than a hidden one
     * somebody did.
     */
    mocks.inviteUser.mockResolvedValue({ user: { id: 'u-9', email: 'newbie@example.com' } });

    await invite('viewer', 'newbie@example.com');

    expect(screen.getByTestId('invite-handoff')).toBeTruthy();
  });

  it('prefers the link the API served over the one derived from the browser', async () => {
    /**
     * Both compute the same rule from different inputs — the API from its
     * configured `CONSOLE_BASE_URL`, this client from `window.location.origin`. The
     * browser's origin is whatever deployment the supervisor is on, so a preview
     * build would otherwise hand out a preview link to a real new colleague.
     */
    mocks.inviteUser.mockResolvedValue({
      invite_email: { sent: false, reason: 'not_implemented' },
      sign_in_url: 'https://app.example.test/agency/login',
    });

    await invite('agent', 'agent@example.com');

    expect(screen.getByText('https://app.example.test/agency/login')).toBeTruthy();
    // And not the locally derived one, which under happy-dom is a localhost origin.
    expect(screen.queryByText((text) => text.startsWith('http://localhost'))).toBeNull();
  });

  it('falls back to the local derivation when the API has no base URL', async () => {
    // `sign_in_url: null` means the API has no `CONSOLE_BASE_URL`. The client's own
    // derivation is then the only link that exists, and the panel is the only
    // thing that works at all.
    mocks.inviteUser.mockResolvedValue({
      invite_email: { sent: false, reason: 'not_configured' },
      sign_in_url: null,
    });

    await invite('agent', 'agent@example.com');

    expect(screen.getByText((text) => text.endsWith('/agency/login'))).toBeTruthy();
  });
});

describe('the dialer promise is conditional on the gates that decide it', () => {
  /**
   * `/dialer` is gated on `RequireCapability capability="agency"` AND `RequireFlag
   * flag="agency_dialer_enabled"`. The panel used to promise flatly that the
   * link "takes them straight to the dialer" while reading neither, so a
   * supervisor at a tenant with the dialer off was told in the product's own
   * voice that the link would work — and the person they emailed hit an
   * unavailable screen on their first ever sign-in.
   */
  it('promises the dialer only when both gates are on', async () => {
    await invite('agent', 'agent@example.com');

    expect(screen.getByTestId('agent-dialer-note')).toBeTruthy();
    expect(screen.queryByTestId('agent-dialer-gated-note')).toBeNull();
  });

  it('names the requirement instead when the capability is off', async () => {
    mocks.useGovernance.mockReturnValue({
      isEnabled: (capability: string) => capability !== 'agency',
      loading: false,
    });

    await invite('agent', 'agent@example.com');

    const note = screen.getByTestId('agent-dialer-gated-note');
    expect(note.textContent).toMatch(/isn’t switched on/i);
    // Names who can fix it: this is a request the supervisor may be able to make
    // and cannot make blind.
    expect(note.textContent).toMatch(/administrator/i);
    expect(screen.queryByTestId('agent-dialer-note')).toBeNull();
  });

  it('names the requirement when the flag is off', async () => {
    mocks.useFeatureFlags.mockReturnValue({
      isEnabled: (flag: string) => flag !== 'agency_dialer_enabled',
      status: 'ready',
    });

    await invite('agent', 'agent@example.com');

    expect(screen.getByTestId('agent-dialer-gated-note')).toBeTruthy();
    expect(screen.queryByTestId('agent-dialer-note')).toBeNull();
  });

  it.each([
    ['governance', { governance: true, flags: false }],
    ['flags', { governance: false, flags: true }],
  ])('does not promise the dialer while %s is still loading', async (_label, which) => {
    /**
     * Fail-closed while unknown, which is the right direction here: the
     * pessimistic sentence names a remedy, and the optimistic one is the one that
     * can be wrong in front of an invitee. Note `GovernanceContext.isEnabled`
     * fails OPEN on its own (`map[capability] !== false`), so waiting for
     * `loading` is what makes the composite closed rather than the capability
     * check doing it.
     */
    mocks.useGovernance.mockReturnValue({ isEnabled: () => true, loading: which.governance });
    mocks.useFeatureFlags.mockReturnValue({
      isEnabled: () => true,
      status: which.flags ? 'loading' : 'ready',
    });

    await invite('agent', 'agent@example.com');

    expect(screen.getByTestId('agent-dialer-gated-note')).toBeTruthy();
  });

  it('says nothing about the dialer to a role whose link is not the dialer', async () => {
    mocks.useGovernance.mockReturnValue({ isEnabled: () => false, loading: false });

    await invite('viewer', 'v@example.com');

    // Neither sentence — a viewer's link is `/login` and the dialer is nothing to
    // do with them, gated or not.
    expect(screen.queryByTestId('agent-dialer-note')).toBeNull();
    expect(screen.queryByTestId('agent-dialer-gated-note')).toBeNull();
  });
});

describe('the member list is refreshed without waiting for the panel', () => {
  it('reloads on success rather than on dismiss', async () => {
    /* So the new pending row is already in place when the supervisor closes the
       panel — the list would otherwise be a modal-dismiss out of date. */
    await invite('viewer', 'newbie@example.com');

    expect(mocks.reload).toHaveBeenCalled();
  });
});

describe('a failed invite shows no hand-off at all', () => {
  it('keeps the form and its error instead', async () => {
    mocks.inviteUser.mockRejectedValueOnce(new Error('already a member'));

    render(<MemoryRouter><TeamPage /></MemoryRouter>);
    fireEvent.click(screen.getAllByText('Invite Member')[0]!);
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'dupe@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create Invite' }));

    await waitFor(() => {
      expect(screen.getByText(/already a member/i)).toBeTruthy();
    });

    expect(screen.queryByRole('button', { name: 'Done' })).toBeNull();
    expect(screen.queryByText(/we didn’t email them/i)).toBeNull();
    /* And nothing was created, so nothing should have been reloaded. */
    expect(mocks.reload).not.toHaveBeenCalled();
  });
});
