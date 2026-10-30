import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

/**
 * The workspace invite page, `/join/:token`.
 *
 * ── What it is for, and so what is worth pinning ───────────────────────────
 * Invite emails used to go to agents only, because every other role had nowhere
 * to land: the agent's page is written for a station, and `/login` has no signup
 * and does not bind a mismatched address to the waiting membership. This page is
 * that landing, for every non-agent role, and it runs the agent page's claim —
 * `useInviteClaim` and `InviteJoinScreen` are shared — so the properties pinned
 * here are the ones that make it the WORKSPACE's page, plus enough of the shared
 * flow to prove it is actually wired through on this door:
 *
 *  1. **Workspace copy.** The role, the product and the workspace come from the
 *     invitation; nothing on the page mentions a station, a dialer or a
 *     supervisor, and its sign-in links go to `/login?next=/app`, not the agency
 *     door — and not bare `/login`, whose fallback is the dialer's `/agency`.
 *  2. **The claim lands on `/app`, with `replace`.** The token is spent the
 *     instant it succeeds.
 *  3. **The claim lands in the INVITED workspace.** Somebody who already belongs
 *     to another one must not finish joining and be put back in the old one.
 *  4. **An agent's invitation is forwarded to `/agency/join/:token`.** Neither
 *     door ever renders an invitation that belongs on the other.
 *  5. **Its own funnel.** `workspace_invite_*`, never `agency_invite_*`.
 *  6. **Admin seats need the invited address (decision B25).** For an invitation
 *     the server marks `requires_matching_address`, a Google account on another
 *     address gets "must be accepted with <address>" and is signed out — never
 *     "use this account anyway" — and the server's own `address_required` 409
 *     lands on the same screen.
 */

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  getInvite: vi.fn(),
  establishInviteCredential: vi.fn(),
  claimInvite: vi.fn(),
  logout: vi.fn(),
  setActiveTenantId: vi.fn(),
  trackWorkspaceInviteViewed: vi.fn(),
  trackWorkspaceInviteClaimAttempted: vi.fn(),
  trackWorkspaceInviteClaimSucceeded: vi.fn(),
  trackWorkspaceInviteClaimFailed: vi.fn(),
  trackWorkspaceInviteAddressMismatch: vi.fn(),
}));

vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  return { ...actual, useNavigate: () => mocks.navigate };
});

vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({
    establishInviteCredential: mocks.establishInviteCredential,
    claimInvite: mocks.claimInvite,
    logout: mocks.logout,
  }),
}));

vi.mock('../../contexts/TenantContext', () => ({
  useTenant: () => ({ setActiveTenantId: mocks.setActiveTenantId }),
}));

/**
 * `InviteUnavailableError` and `InviteIdentityInUseError` stay REAL: the claim
 * branches on `instanceof`, and a stand-in class would take the wrong branch.
 */
vi.mock('../../api/invites', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/invites')>();
  return { ...actual, getInvite: mocks.getInvite };
});

/**
 * ONLY the workspace family. The agency family is deliberately absent from this
 * mock: vitest throws on access to an export a factory did not define, so if this
 * page ever reported to `agency_invite_*` the suite would fail on the first event
 * rather than quietly counting operators in the agent funnel.
 */
vi.mock('../../analytics/events', () => ({
  trackWorkspaceInviteViewed: mocks.trackWorkspaceInviteViewed,
  trackWorkspaceInviteClaimAttempted: mocks.trackWorkspaceInviteClaimAttempted,
  trackWorkspaceInviteClaimSucceeded: mocks.trackWorkspaceInviteClaimSucceeded,
  trackWorkspaceInviteClaimFailed: mocks.trackWorkspaceInviteClaimFailed,
  trackWorkspaceInviteAddressMismatch: mocks.trackWorkspaceInviteAddressMismatch,
}));

import { InviteAddressRequiredError, InviteIdentityInUseError, InviteUnavailableError } from '../../api/invites';
import JoinPage from '../../pages/auth/JoinPage';
import type { AgencyInvite } from '../../types/invite';

const TOKEN = 'tok_ws_123';

/**
 * Every sign-in link on this page: the workspace door, coming back to `/app`.
 * Written out rather than read from `JOIN_DOORS`, so a door pointed somewhere
 * else fails here instead of being echoed back.
 */
const WORKSPACE_SIGN_IN = '/login?next=%2Fapp';

const INVITE: AgencyInvite = {
  email: 'omar@acme.com',
  role: 'operator',
  tenant_name: 'Acme Collections',
  inviter_name: 'Dana Lee',
  // The brand's name, which is what the server sends for a non-agent invite.
  product_name: 'Acme Workspace',
  expires_at: '2026-11-06T09:00:00.000Z',
  requires_matching_address: false,
};

/** A session answer for a first-time invitee: one tenant, the invited one. */
const SESSION = {
  user: { id: 'u1' },
  tenants: [{ id: 'tenant-acme', name: 'Acme Collections' }],
  memberships: [{ tenant_id: 'tenant-acme', role: 'operator', status: 'active' }],
  is_new: false,
  settings: {},
};

function renderAt(token = TOKEN) {
  return render(
    <MemoryRouter initialEntries={[`/join/${token}`]}>
      <Routes>
        <Route path="/join/:token" element={<JoinPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

async function renderInvitation(invite: AgencyInvite = INVITE) {
  mocks.getInvite.mockResolvedValue({ status: 'pending', invite });
  const view = renderAt();
  await screen.findByRole('button', { name: /continue with google/i });
  return view;
}

async function fillPassword(value: string) {
  fireEvent.click(screen.getByRole('button', { name: 'Create a password instead' }));
  const field = await screen.findByLabelText('Choose a password');
  fireEvent.change(field, { target: { value } });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.claimInvite.mockResolvedValue(SESSION);
  mocks.logout.mockResolvedValue(undefined);
  mocks.establishInviteCredential.mockResolvedValue({ email: INVITE.email });
});

afterEach(() => cleanup());

describe('reading a workspace invitation', () => {
  it('names the product, the role, the workspace and who sent it', async () => {
    await renderInvitation();

    // `product_name` is the server's — the brand for a non-agent — rendered as given.
    expect(screen.getByRole('heading', { level: 1 }).textContent)
      .toBe('You have been added to Acme Workspace');
    expect(screen.getByText(/has set you up as operator at/i)).toBeTruthy();
    expect(screen.getByText('Dana Lee')).toBeTruthy();
    expect(screen.getByText('Acme Collections')).toBeTruthy();
    expect(screen.getByText('omar@acme.com')).toBeTruthy();
    expect(screen.getByText('Workspace invitation')).toBeTruthy();
  });

  it('labels an account admin as one', async () => {
    await renderInvitation({ ...INVITE, role: 'account_admin', inviter_name: null });

    expect(screen.getByText(/you have been set up as account admin at/i)).toBeTruthy();
  });

  it('labels a new workspace owner as one, and reports the role as itself', async () => {
    /*
      A super admin's tenant create invites the owner, with no inviter (a super
      admin is not a user). The funnel used to report `role: null` here, on the
      belief that no invite could grant ownership.
    */
    await renderInvitation({ ...INVITE, role: 'tenant_owner', inviter_name: null });

    expect(screen.getByText(/you have been set up as workspace owner at/i)).toBeTruthy();
    expect(mocks.trackWorkspaceInviteViewed).toHaveBeenCalledWith({
      status: 'pending',
      role: 'tenant_owner',
      has_inviter: false,
    });
  });

  it('promises a workspace, never a station', async () => {
    /*
      The whole reason this is a second page rather than the agency one with a
      different URL: an operator told "Your station opens" and "Your supervisor
      decides which lists you work" is being told about a product they will not
      open. The steps, the eyebrow and every sentence on the card are checked.
    */
    await renderInvitation();

    const steps = screen.getByRole('complementary', { name: /what happens next/i });
    expect(steps.textContent).toMatch(/the workspace you were invited to opens/i);
    expect(document.body.textContent).not.toMatch(/station|dialer|supervisor|campaign/i);
  });

  it('points "Sign in instead" at the workspace door, not the agency one', async () => {
    await renderInvitation();

    expect(screen.getByRole('link', { name: /sign in instead/i }).getAttribute('href')).toBe(WORKSPACE_SIGN_IN);
  });

  it('shows the workspace eyebrow on the skeleton too, before anything is known', async () => {
    mocks.getInvite.mockReturnValue(new Promise(() => { /* never settles */ }));
    renderAt();

    expect(screen.getByText(/opening your invitation/i)).toBeTruthy();
    expect(screen.getByText('Workspace invitation')).toBeTruthy();
    expect(screen.queryByText('Agency Dialer')).toBeNull();
  });
});

describe('claiming with email and password', () => {
  it('creates the credential, claims with the token and lands on /app', async () => {
    await renderInvitation();
    await fillPassword('correct horse battery');
    fireEvent.click(screen.getByRole('button', { name: 'Create my sign-in' }));

    await waitFor(() =>
      expect(mocks.establishInviteCredential).toHaveBeenCalledWith({
        method: 'create',
        email: 'omar@acme.com',
        password: 'correct horse battery',
      }),
    );
    expect(mocks.claimInvite).toHaveBeenCalledWith(TOKEN);
    /*
      `/app`, and `replace`: the token is spent the instant the claim succeeds, so
      a pushed entry would leave "already used" one back-press away.
    */
    expect(mocks.navigate).toHaveBeenCalledWith('/app', { replace: true });
    expect(mocks.trackWorkspaceInviteClaimSucceeded).toHaveBeenCalledWith({
      method: 'create',
      address_matched: true,
    });
  });

  it('keeps the invited address read-only', async () => {
    await renderInvitation();
    await fillPassword('');

    const field = screen.getByLabelText('Your address') as HTMLInputElement;
    expect(field.value).toBe('omar@acme.com');
    expect(field.readOnly).toBe(true);
  });

  it('refuses a weak password before the network', async () => {
    await renderInvitation();
    await fillPassword('omar12345');
    fireEvent.click(screen.getByRole('button', { name: 'Create my sign-in' }));

    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/your own address/i));
    expect(mocks.establishInviteCredential).not.toHaveBeenCalled();
    expect(mocks.trackWorkspaceInviteClaimFailed).toHaveBeenCalledWith({
      method: 'create',
      reason: 'weak_password',
    });
  });

  it('turns an address that already has a password into a sign-in, and claims with it', async () => {
    // Somebody who already works in another workspace: the claim attaches THIS
    // membership to the account they have.
    mocks.establishInviteCredential.mockRejectedValueOnce(
      Object.assign(new Error('already in use'), { code: 'auth/email-already-in-use' }),
    );
    await renderInvitation();
    await fillPassword('correct horse battery');
    fireEvent.click(screen.getByRole('button', { name: 'Create my sign-in' }));

    const field = await screen.findByLabelText('Your password');
    expect(screen.getByRole('alert').textContent).toMatch(/already has a password/i);
    fireEvent.change(field, { target: { value: 'their-old-password' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in and join' }));

    await waitFor(() => expect(mocks.navigate).toHaveBeenCalledWith('/app', { replace: true }));
    expect(mocks.establishInviteCredential).toHaveBeenLastCalledWith({
      method: 'sign_in',
      email: 'omar@acme.com',
      password: 'their-old-password',
    });
  });
});

describe('Continue with Google', () => {
  it('claims and lands on /app when the address matches', async () => {
    await renderInvitation();
    fireEvent.click(screen.getByRole('button', { name: /continue with google/i }));

    await waitFor(() => expect(mocks.claimInvite).toHaveBeenCalledWith(TOKEN));
    expect(mocks.navigate).toHaveBeenCalledWith('/app', { replace: true });
    expect(mocks.trackWorkspaceInviteClaimAttempted).toHaveBeenCalledWith({ method: 'google' });
    expect(mocks.trackWorkspaceInviteClaimSucceeded).toHaveBeenCalledWith({
      method: 'google',
      address_matched: true,
    });
  });
});

describe('the Google address mismatch', () => {
  const withMismatch = async () => {
    mocks.establishInviteCredential.mockResolvedValue({ email: 'omar.personal@gmail.com' });
    const view = await renderInvitation();
    fireEvent.click(screen.getByRole('button', { name: /continue with google/i }));
    await screen.findByText(/that is a different address/i);
    return view;
  };

  it('stops before claiming and shows both addresses', async () => {
    await withMismatch();

    expect(screen.getByText('omar.personal@gmail.com')).toBeTruthy();
    expect(mocks.claimInvite).not.toHaveBeenCalled();
    expect(mocks.navigate).not.toHaveBeenCalled();
    expect(mocks.trackWorkspaceInviteAddressMismatch).toHaveBeenCalledWith({ outcome: 'shown' });
  });

  it('claims only after the confirmation, and records that it was not a match', async () => {
    await withMismatch();
    fireEvent.click(screen.getByRole('button', { name: 'Use this account' }));

    await waitFor(() => expect(mocks.claimInvite).toHaveBeenCalledWith(TOKEN));
    expect(mocks.navigate).toHaveBeenCalledWith('/app', { replace: true });
    expect(mocks.trackWorkspaceInviteClaimSucceeded).toHaveBeenCalledWith({
      method: 'google',
      address_matched: false,
    });
  });

  it('declining signs out and returns to the two options', async () => {
    await withMismatch();
    fireEvent.click(screen.getByRole('button', { name: 'Use a different account' }));

    await waitFor(() => expect(mocks.logout).toHaveBeenCalled());
    expect(mocks.claimInvite).not.toHaveBeenCalled();
    expect(await screen.findByRole('button', { name: /continue with google/i })).toBeTruthy();
    expect(mocks.trackWorkspaceInviteClaimFailed).toHaveBeenCalledWith({
      method: 'google',
      reason: 'mismatch_declined',
    });
  });

  it('keeps the way out — and points the sign-in remedy at /login?next=/app — on identity_in_use', async () => {
    /*
      The confirmed Google account already belongs to a different user row here.
      The invitation is untouched, so the mismatch screen (with its sign-out) must
      stay, and the server's "sign in with it directly" needs something to press —
      on THIS door, the workspace's sign-in page.
    */
    mocks.claimInvite.mockRejectedValue(
      new InviteIdentityInUseError(
        'That sign-in already belongs to a different account here. Sign in with it directly.',
      ),
    );
    await withMismatch();
    fireEvent.click(screen.getByRole('button', { name: 'Use this account' }));

    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toMatch(/already belongs to a different account/i),
    );
    expect(screen.getByRole('button', { name: 'Use a different account' })).toBeTruthy();
    expect(screen.getByRole('link', { name: /go to sign in/i }).getAttribute('href')).toBe(WORKSPACE_SIGN_IN);
    expect(mocks.trackWorkspaceInviteClaimFailed).toHaveBeenCalledWith({
      method: 'google',
      reason: 'identity_in_use',
    });
    expect(mocks.navigate).not.toHaveBeenCalled();
  });

  it('leaves nothing signed in when the visitor walks away mid-join', async () => {
    const { unmount } = await withMismatch();
    unmount();

    await waitFor(() => expect(mocks.logout).toHaveBeenCalled());
  });
});

describe('an invitation that must be accepted with the invited address (decision B25)', () => {
  /*
    From `account_admin` up the server refuses a claim from any account but the
    invited address, because a forwarded mail would otherwise hand over a seat that
    can invite people and supervise calls. The page must not offer "use this
    account anyway" for those — it says which address is needed, signs the other
    account out, and offers the way back to the options. Below that line the
    ordinary mismatch (the describe above) is unchanged.
  */
  const ADMIN: AgencyInvite = { ...INVITE, role: 'account_admin', requires_matching_address: true };

  const withRequiredMismatch = async (invite: AgencyInvite = ADMIN) => {
    mocks.establishInviteCredential.mockResolvedValue({ email: 'omar.personal@gmail.com' });
    const view = await renderInvitation(invite);
    fireEvent.click(screen.getByRole('button', { name: /continue with google/i }));
    await screen.findByTestId('address-required');
    return view;
  };

  it.each(['account_admin', 'tenant_admin', 'tenant_owner'] as const)(
    'a %s invitation names the address it needs and offers no way to continue with the other',
    async (role) => {
      await withRequiredMismatch({ ...ADMIN, role });

      const screenText = screen.getByTestId('address-required').textContent ?? '';
      expect(screen.getByRole('heading', { name: /use the address this invitation was sent to/i })).toBeTruthy();
      expect(screenText).toMatch(/this invitation must be accepted with omar@acme\.com/i);
      expect(screenText).toMatch(/you signed in as omar\.personal@gmail\.com, so we have signed you out of it/i);
      expect(screenText).toMatch(/password form is already set to it/i);
      // THE point: nothing on the page can claim with the other account.
      expect(screen.queryByRole('button', { name: 'Use this account' })).toBeNull();
      expect(screen.queryByText(/that is a different address/i)).toBeNull();
      expect(screen.queryByRole('button', { name: /continue with google/i })).toBeNull();
      expect(mocks.claimInvite).not.toHaveBeenCalled();
      expect(mocks.navigate).not.toHaveBeenCalled();
    },
  );

  it('signs the refused account out straight away, once', async () => {
    const { unmount } = await withRequiredMismatch();

    expect(mocks.logout).toHaveBeenCalledTimes(1);
    // Nothing is left for the leave-the-page cleanup to drop.
    unmount();
    await act(async () => {});
    expect(mocks.logout).toHaveBeenCalledTimes(1);
  });

  it('reports the refusal as a failed claim, and not as a mismatch the visitor could answer', async () => {
    await withRequiredMismatch();

    expect(mocks.trackWorkspaceInviteClaimFailed).toHaveBeenCalledWith({
      method: 'google',
      reason: 'address_required',
    });
    expect(mocks.trackWorkspaceInviteAddressMismatch).not.toHaveBeenCalled();
    // No address in any event.
    for (const call of [
      ...mocks.trackWorkspaceInviteClaimFailed.mock.calls,
      ...mocks.trackWorkspaceInviteClaimAttempted.mock.calls,
    ]) {
      expect(JSON.stringify(call)).not.toContain('@');
    }
  });

  it('"Try again" waits for the sign-out, then returns to the two options', async () => {
    let finishSignOut: () => void = () => {};
    mocks.logout.mockReturnValue(new Promise<void>((resolve) => { finishSignOut = resolve; }));
    await withRequiredMismatch();

    fireEvent.click(screen.getByRole('button', { name: 'Try again with that address' }));
    expect(await screen.findByRole('button', { name: 'Signing out…' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /continue with google/i })).toBeNull();

    await act(async () => { finishSignOut(); });

    expect(await screen.findByRole('button', { name: /continue with google/i })).toBeTruthy();
    expect(screen.queryByTestId('address-required')).toBeNull();
    expect(mocks.logout).toHaveBeenCalledTimes(1);
  });

  it('then claims normally with the invited address', async () => {
    await withRequiredMismatch();
    fireEvent.click(screen.getByRole('button', { name: 'Try again with that address' }));
    await screen.findByRole('button', { name: /continue with google/i });

    mocks.establishInviteCredential.mockResolvedValue({ email: 'Omar@Acme.com' });
    fireEvent.click(screen.getByRole('button', { name: /continue with google/i }));

    await waitFor(() => expect(mocks.claimInvite).toHaveBeenCalledWith(TOKEN));
    expect(mocks.navigate).toHaveBeenCalledWith('/app', { replace: true });
    expect(mocks.trackWorkspaceInviteClaimSucceeded).toHaveBeenCalledWith({
      method: 'google',
      address_matched: true,
    });
  });

  it('takes the rule from the invitation, not from the role it names', async () => {
    // The server decides on the membership's CURRENT role, which can differ from
    // the role the invitation was issued for. So the field is what counts: an
    // invitation still labelled `operator` whose seat is now an admin's gets the
    // required screen…
    await withRequiredMismatch({ ...INVITE, role: 'operator', requires_matching_address: true });
    expect(screen.queryByRole('button', { name: 'Use this account' })).toBeNull();
    cleanup();

    // …and an admin-labelled one the server says is flexible gets the ordinary
    // confirmation.
    mocks.establishInviteCredential.mockResolvedValue({ email: 'omar.personal@gmail.com' });
    await renderInvitation({ ...ADMIN, requires_matching_address: false });
    fireEvent.click(screen.getByRole('button', { name: /continue with google/i }));
    expect(await screen.findByRole('button', { name: 'Use this account' })).toBeTruthy();
  });

  describe('when the server refuses anyway (409 address_required)', () => {
    /*
      The page did not know: a server that does not send the field (read as
      `false`), or a role changed after the page loaded. The server is the control,
      and its refusal must land on the same screen — not as a generic error under
      a confirmation whose button can only fail again.
    */
    const refusal = () => new InviteAddressRequiredError(
      'This invitation must be accepted with omar@acme.com. Sign out of the account you used and sign in with that address.',
      'omar@acme.com',
    );

    it('after "Use this account": shows the required screen and signs the account out', async () => {
      mocks.claimInvite.mockRejectedValue(refusal());
      mocks.establishInviteCredential.mockResolvedValue({ email: 'omar.personal@gmail.com' });
      await renderInvitation({ ...ADMIN, requires_matching_address: false });
      fireEvent.click(screen.getByRole('button', { name: /continue with google/i }));
      fireEvent.click(await screen.findByRole('button', { name: 'Use this account' }));

      await screen.findByTestId('address-required');
      expect(screen.getByTestId('address-required').textContent)
        .toMatch(/must be accepted with omar@acme\.com.*you signed in as omar\.personal@gmail\.com/i);
      expect(screen.queryByRole('button', { name: 'Use this account' })).toBeNull();
      expect(screen.queryByRole('alert')).toBeNull();
      expect(mocks.logout).toHaveBeenCalledTimes(1);
      expect(mocks.navigate).not.toHaveBeenCalled();
      expect(mocks.trackWorkspaceInviteClaimFailed).toHaveBeenCalledWith({
        method: 'google',
        reason: 'address_required',
      });
    });

    it('from the password path: the same screen, without an address it never learned', async () => {
      mocks.claimInvite.mockRejectedValue(new InviteAddressRequiredError('Refused.', null));
      mocks.establishInviteCredential.mockResolvedValue({ email: null });
      await renderInvitation(ADMIN);
      await fillPassword('correct horse battery');
      fireEvent.click(screen.getByRole('button', { name: 'Create my sign-in' }));

      await screen.findByTestId('address-required');
      const text = screen.getByTestId('address-required').textContent ?? '';
      // Falls back to the invitation's own address when the 409 named none.
      expect(text).toMatch(/must be accepted with omar@acme\.com/i);
      expect(text).toMatch(/we have signed you out of the account you used/i);
      expect(mocks.logout).toHaveBeenCalledTimes(1);
      expect(mocks.trackWorkspaceInviteClaimFailed).toHaveBeenCalledWith({
        method: 'create',
        reason: 'address_required',
      });
    });
  });
});

describe('each terminal status gets its own workspace screen', () => {
  const cases = [
    { status: 'expired' as const, matches: /this invitation has expired/i, advice: /ask whoever invited you/i, signIn: false },
    { status: 'claimed' as const, matches: /already been used/i, advice: /the account you created/i, signIn: true },
    { status: 'revoked' as const, matches: /no longer valid/i, advice: /withdrawn/i, signIn: false },
    { status: 'not_found' as const, matches: /cannot find that invitation/i, advice: /copy the whole link/i, signIn: false },
    {
      status: 'identity_already_bound' as const,
      matches: /you are already set up/i,
      advice: /this address already has an account/i,
      signIn: true,
    },
  ];

  it.each(cases)('$status says what happened, in a workspace’s words', async ({ status, matches, advice, signIn }) => {
    mocks.getInvite.mockResolvedValue({ status });
    renderAt();

    expect(await screen.findByText(matches)).toBeTruthy();
    expect(screen.getByText(advice)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/station|supervisor/i);
    expect(screen.queryByRole('button', { name: /continue with google/i })).toBeNull();

    const link = screen.queryByRole('link', { name: /go to sign in/i });
    if (signIn) expect(link?.getAttribute('href')).toBe(WORKSPACE_SIGN_IN);
    else expect(link).toBeNull();

    expect(mocks.trackWorkspaceInviteViewed).toHaveBeenCalledWith({
      status,
      role: null,
      has_inviter: false,
    });
  });

  it('switches to the status screen when the invite goes terminal mid-claim', async () => {
    mocks.claimInvite.mockRejectedValue(new InviteUnavailableError('revoked'));
    await renderInvitation();
    fireEvent.click(screen.getByRole('button', { name: /continue with google/i }));

    expect(await screen.findByText(/no longer valid/i)).toBeTruthy();
    expect(mocks.navigate).not.toHaveBeenCalled();
    expect(mocks.trackWorkspaceInviteClaimFailed).toHaveBeenCalledWith({
      method: 'google',
      reason: 'invite_unavailable',
    });
  });

  it('offers a retry when the lookup itself failed', async () => {
    mocks.getInvite.mockRejectedValueOnce(new Error('Failed to fetch'));
    renderAt();

    expect(await screen.findByText(/could not open your invitation/i)).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toMatch(/failed to fetch/i);
    expect(screen.getByText('Workspace invitation')).toBeTruthy();
    expect(mocks.trackWorkspaceInviteViewed).toHaveBeenCalledWith({
      status: 'unreachable',
      role: null,
      has_inviter: false,
    });

    mocks.getInvite.mockResolvedValue({ status: 'pending', invite: INVITE });
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));

    expect(await screen.findByRole('button', { name: /continue with google/i })).toBeTruthy();
  });
});

describe('an agent invitation opened here', () => {
  /**
   * The agent's link is `/agency/join/:token`; this page is for everyone else.
   * An agent invitation opened here would be told it is joining a workspace and
   * land on `/app`, an empty shell for a level-5 role. Forwarded instead, before
   * anything renders, with `replace` so the back button does not return to a page
   * whose only behaviour is to leave.
   */
  it('forwards to /agency/join/:token without rendering or reporting it', async () => {
    const agentInvite = { ...INVITE, role: 'agent' as const, product_name: 'Acme Dialer' };
    mocks.getInvite.mockResolvedValue({ status: 'pending', invite: agentInvite });
    renderAt();

    await waitFor(() => expect(mocks.navigate).toHaveBeenCalledTimes(1));
    expect(mocks.navigate).toHaveBeenCalledWith(`/agency/join/${TOKEN}`, {
      replace: true,
      state: { inviteHandoff: { token: TOKEN, invite: agentInvite } },
    });
    expect(screen.queryByRole('button', { name: /continue with google/i })).toBeNull();
    // The agency page reports the view; this funnel never saw an agent.
    expect(mocks.trackWorkspaceInviteViewed).not.toHaveBeenCalled();
  });

  it('encodes the token it re-files, rather than truncating it', async () => {
    const odd = 'tok?with#bits';
    mocks.getInvite.mockResolvedValue({ status: 'pending', invite: { ...INVITE, role: 'agent' } });
    render(
      <MemoryRouter initialEntries={[`/join/${encodeURIComponent(odd)}`]}>
        <Routes>
          <Route path="/join/:token" element={<JoinPage />} />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() => expect(mocks.navigate).toHaveBeenCalled());
    expect(mocks.navigate.mock.calls[0]?.[0]).toBe(`/agency/join/${encodeURIComponent(odd)}`);
  });
});

describe('an invitation forwarded from the agency page', () => {
  it('renders without reading the token a second time', async () => {
    render(
      <MemoryRouter
        initialEntries={[{ pathname: `/join/${TOKEN}`, state: { inviteHandoff: { token: TOKEN, invite: INVITE } } }]}
      >
        <Routes>
          <Route path="/join/:token" element={<JoinPage />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByRole('button', { name: /continue with google/i })).toBeTruthy();
    expect(mocks.getInvite).not.toHaveBeenCalled();
    expect(mocks.trackWorkspaceInviteViewed).toHaveBeenCalledTimes(1);
    expect(mocks.trackWorkspaceInviteViewed).toHaveBeenCalledWith({
      status: 'pending',
      role: 'operator',
      has_inviter: true,
    });
  });

  it('does not trust a forwarded invitation whose role belongs on the other door', async () => {
    /*
      A state entry that does not fit is ignored and the page reads the token
      itself. Taking it would let a stale or hand-built entry render an agent's
      invitation here — and, the other way round, would be the one way the two
      pages could bounce a visitor between them.
    */
    mocks.getInvite.mockResolvedValue({ status: 'pending', invite: INVITE });
    render(
      <MemoryRouter
        initialEntries={[
          {
            pathname: `/join/${TOKEN}`,
            state: { inviteHandoff: { token: TOKEN, invite: { ...INVITE, role: 'agent' } } },
          },
        ]}
      >
        <Routes>
          <Route path="/join/:token" element={<JoinPage />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByRole('button', { name: /continue with google/i })).toBeTruthy();
    expect(mocks.getInvite).toHaveBeenCalledWith(TOKEN);
    expect(mocks.navigate).not.toHaveBeenCalled();
  });
});

describe('which workspace the claim lands in', () => {
  /**
   * The claim adopts a session listing every tenant the person belongs to, and
   * `TenantContext` restores whichever one this browser last had open. Somebody
   * who already works elsewhere would accept this invitation and be put back in
   * their old workspace, with nothing to say the invitation had worked.
   */
  const claimAndLand = async () => {
    await renderInvitation();
    fireEvent.click(screen.getByRole('button', { name: /continue with google/i }));
    await waitFor(() => expect(mocks.navigate).toHaveBeenCalledWith('/app', { replace: true }));
  };

  it('selects the invited tenant for a first-time invitee', async () => {
    await claimAndLand();

    expect(mocks.setActiveTenantId).toHaveBeenCalledWith('tenant-acme');
  });

  it('selects the invited tenant for somebody who already belongs to another workspace', async () => {
    mocks.claimInvite.mockResolvedValue({
      ...SESSION,
      tenants: [
        { id: 'tenant-home', name: 'Home Co' },
        { id: 'tenant-acme', name: 'Acme Collections' },
      ],
      memberships: [
        { tenant_id: 'tenant-home', role: 'tenant_owner', status: 'active' },
        { tenant_id: 'tenant-acme', role: 'operator', status: 'active' },
      ],
    });
    await claimAndLand();

    expect(mocks.setActiveTenantId).toHaveBeenCalledWith('tenant-acme');
    // Selected BEFORE leaving, so `/app` opens in it rather than flashing the old one.
    expect(mocks.setActiveTenantId.mock.invocationCallOrder[0]!)
      .toBeLessThan(mocks.navigate.mock.invocationCallOrder[0]!);
  });

  it('leaves the choice alone when two workspaces fit equally', async () => {
    // A coin toss presented as an answer would be worse than the switcher.
    mocks.claimInvite.mockResolvedValue({
      ...SESSION,
      tenants: [
        { id: 'tenant-a', name: 'Acme Collections' },
        { id: 'tenant-b', name: 'Acme Collections' },
      ],
      memberships: [
        { tenant_id: 'tenant-a', role: 'operator', status: 'active' },
        { tenant_id: 'tenant-b', role: 'operator', status: 'active' },
      ],
    });
    await claimAndLand();

    expect(mocks.setActiveTenantId).not.toHaveBeenCalled();
  });

  it('does not switch anything for a visitor who left before the claim landed', async () => {
    let release: (() => void) | undefined;
    mocks.claimInvite.mockReturnValue(new Promise((resolve) => { release = () => resolve(SESSION); }));
    const { unmount } = await renderInvitation();
    fireEvent.click(screen.getByRole('button', { name: /continue with google/i }));
    await waitFor(() => expect(mocks.claimInvite).toHaveBeenCalled());

    unmount();
    await act(async () => { release?.(); });

    expect(mocks.trackWorkspaceInviteClaimSucceeded).toHaveBeenCalled();
    expect(mocks.setActiveTenantId).not.toHaveBeenCalled();
    expect(mocks.navigate).not.toHaveBeenCalled();
    expect(mocks.logout).not.toHaveBeenCalled();
  });
});

describe('what analytics may see of this page', () => {
  it('excludes the invitation card from autocapture', async () => {
    // The same `ph-no-capture` boundary as the agency page, because it is the same
    // card: the invitee's address, the inviter's name and the workspace's name.
    await renderInvitation();

    const card = document.querySelector('.ph-no-capture');
    expect(card).not.toBeNull();
    for (const pii of [INVITE.email, INVITE.inviter_name!, INVITE.tenant_name!]) {
      expect(screen.getAllByText(pii).every((el) => card!.contains(el))).toBe(true);
    }
  });

  it('reports the view with the role and nothing that identifies anybody', async () => {
    await renderInvitation();

    expect(mocks.trackWorkspaceInviteViewed).toHaveBeenCalledWith({
      status: 'pending',
      role: 'operator',
      has_inviter: true,
    });
  });
});
