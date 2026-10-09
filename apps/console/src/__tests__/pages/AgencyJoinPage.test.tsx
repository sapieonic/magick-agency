import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { StrictMode } from 'react';
import { act, createEvent, render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

/**
 * The invite landing page, `/agency/join/:token`.
 *
 * ── What is worth pinning, and what is not ─────────────────────────────────
 * The page renders a form and five outcome screens, and a test that asserts a
 * form has a form in it is worth nothing. Five properties are load-bearing, and
 * each of them is a way agency onboarding fails in production rather than a way
 * the markup could change:
 *
 *  1. **The Google address mismatch stops the flow.** This is the whole reason
 *     the page exists in the shape it does. `POST /auth/session` provisions a
 *     brand-new tenant for an address the server does not recognise, so an agent
 *     invited at a work address who presses Continue with Google and is handed
 *     their personal Gmail used to land — silently — as the owner of an empty
 *     workspace, with the real membership unclaimed and neither them nor their
 *     supervisor told anything. Nothing may be claimed until they answer, and
 *     declining must drop the credential rather than just the screen.
 *  2. **The invited address is read-only.** It is the one value that must not
 *     drift, and an editable field would reintroduce the same mismatch one
 *     keystroke at a time.
 *  3. **`navigate('/dialer', { replace: true })`.** The token is single-use and
 *     spent the instant the claim succeeds; left on the history stack, an
 *     ordinary press of the back button lands the agent on "already used"
 *     moments after it worked.
 *  4. **Every terminal status gets its own screen.** The recipient can act on
 *     exactly one of the four on their own, so a generic "invalid link" costs the
 *     other three their next step.
 *  5. **`auth/email-already-in-use` is not a failure.** It is an agent invited to
 *     a second workspace, and the form has to become a sign-in rather than a dead
 *     end under a create button.
 */

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  getInvite: vi.fn(),
  establishInviteCredential: vi.fn(),
  claimInvite: vi.fn(),
  logout: vi.fn(),
  trackAgencyInviteViewed: vi.fn(),
  trackAgencyInviteClaimAttempted: vi.fn(),
  trackAgencyInviteClaimSucceeded: vi.fn(),
  trackAgencyInviteClaimFailed: vi.fn(),
  trackAgencyInviteAddressMismatch: vi.fn(),
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

/**
 * The API module is mocked but `InviteUnavailableError` is NOT — the page
 * branches on `instanceof`, so a hand-rolled stand-in would take the wrong branch
 * and the test would be asserting against a class the page never sees.
 */
vi.mock('../../api/invites', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/invites')>();
  return { ...actual, getInvite: mocks.getInvite };
});

vi.mock('../../analytics/events', () => ({
  trackAgencyInviteViewed: mocks.trackAgencyInviteViewed,
  trackAgencyInviteClaimAttempted: mocks.trackAgencyInviteClaimAttempted,
  trackAgencyInviteClaimSucceeded: mocks.trackAgencyInviteClaimSucceeded,
  trackAgencyInviteClaimFailed: mocks.trackAgencyInviteClaimFailed,
  trackAgencyInviteAddressMismatch: mocks.trackAgencyInviteAddressMismatch,
}));

import { InviteIdentityInUseError, InviteUnavailableError } from '../../api/invites';
import AgencyJoinPage from '../../pages/agency/AgencyJoinPage';
import type { AgencyInvite } from '../../types/invite';

const TOKEN = 'tok_abc123';

const INVITE: AgencyInvite = {
  email: 'priya@acme.com',
  role: 'agent',
  tenant_name: 'Acme Collections',
  inviter_name: 'Priya Sharma',
  product_name: 'Magick Agency Dialer',
  expires_at: '2026-09-12T09:00:00.000Z',
};

/** A session answer. Only its identity matters here — `AuthContext` owns its shape. */
const SESSION = { user: { id: 'u1' }, tenants: [], memberships: [], is_new: false, governance: {} };

function renderAt(token = TOKEN) {
  return render(
    <MemoryRouter initialEntries={[`/agency/join/${token}`]}>
      <Routes>
        <Route path="/agency/join/:token" element={<AgencyJoinPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

/** Render and wait for the invitation to settle out of the skeleton. */
async function renderInvitation(invite: AgencyInvite = INVITE) {
  mocks.getInvite.mockResolvedValue({ status: 'pending', invite });
  const view = renderAt();
  await screen.findByRole('button', { name: /continue with google/i });
  return view;
}

/** Reveal the password half and fill it in. */
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

describe('reading the invitation', () => {
  it('shows a skeleton rather than a guess while the lookup is in flight', async () => {
    // Never a flash of the wrong state: the invitation and all five outcomes
    // render in the same box, so anything rendered before the answer arrives
    // would be visibly replaced a moment later.
    mocks.getInvite.mockReturnValue(new Promise(() => { /* never settles */ }));
    renderAt();

    expect(screen.getByText(/opening your invitation/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /continue with google/i })).toBeNull();
    expect(screen.queryByText(/expired/i)).toBeNull();
  });

  it('a superseded lookup cannot land on top of a newer one', async () => {
    /*
      The `alive` flag this replaced did not guard the case its own docstring
      claimed. Every `load()` closed over its OWN flag and only the effect's
      cleanup ever flipped one — while `load` is also the retry handler, where the
      returned disposer is discarded — so an older answer arriving last overwrote
      a newer one: a resolved invitation replaced by "We could not open your
      invitation", and `agency_invite_viewed` fired twice for one visit.

      Driven here through StrictMode, which is the first case the docstring cites:
      it mounts the effect twice, so two lookups are genuinely in flight at once.
      The second is the current one; the first must be unable to write, however it
      settles.
    */
    const settlers: Array<{ resolve: (v: unknown) => void; reject: (e: unknown) => void }> = [];
    mocks.getInvite.mockImplementation(
      () => new Promise((resolve, reject) => { settlers.push({ resolve, reject }); }),
    );

    render(
      <StrictMode>
        <MemoryRouter initialEntries={[`/agency/join/${TOKEN}`]}>
          <Routes>
            <Route path="/agency/join/:token" element={<AgencyJoinPage />} />
          </Routes>
        </MemoryRouter>
      </StrictMode>,
    );

    await waitFor(() => expect(settlers.length).toBe(2));

    // The newest answer lands.
    await act(async () => { settlers[1]!.resolve({ status: 'pending', invite: INVITE }); });
    expect(await screen.findByRole('button', { name: /continue with google/i })).toBeTruthy();

    // The stale one settles afterwards and is discarded.
    await act(async () => { settlers[0]!.reject(new Error('Failed to fetch')); });

    expect(screen.queryByText(/could not open your invitation/i)).toBeNull();
    expect(screen.getByRole('button', { name: /continue with google/i })).toBeTruthy();
    expect(mocks.trackAgencyInviteViewed).toHaveBeenCalledTimes(1);
  });

  it('names who added them, to what, and where', async () => {
    await renderInvitation();

    // `product_name` is the server's, rendered rather than assembled — it is
    // whitelabel-dependent and this client must not hardcode it.
    expect(screen.getByText(/Magick Agency Dialer/)).toBeTruthy();
    expect(screen.getByText('Priya Sharma')).toBeTruthy();
    expect(screen.getByText('Acme Collections')).toBeTruthy();
    expect(screen.getByText('priya@acme.com')).toBeTruthy();
  });

  it('reads without an inviter, which the server can legitimately not know', async () => {
    // A system or API invite has no person to name. The sentence has to survive
    // that rather than rendering "null has set you up as Agent".
    await renderInvitation({ ...INVITE, inviter_name: null });

    expect(screen.getByText(/you have been set up as agent at/i)).toBeTruthy();
    expect(screen.queryByText(/null/i)).toBeNull();
  });

  it('drops the workspace clause when the server could not name one', async () => {
    /*
      `tenant_name` is `string | null` on the wire — the server sends `tenant?.name ??
      null` on purpose, refusing to hand a raw tenant UUID to an unauthenticated
      caller — and the type here claimed `string`. The sentence rendered "You have
      been set up as Agent at ." with an empty `<strong>` mid-sentence, on the one
      page in the product that most has to not look like phishing. There is
      nothing honest to substitute, so the clause goes, exactly as it already does
      for a missing inviter.
    */
    await renderInvitation({ ...INVITE, tenant_name: null, inviter_name: null });

    const lede = screen.getByText(/you have been set up as agent/i);
    expect(lede.textContent?.replace(/\s+/g, ' ').trim()).toBe('You have been set up as Agent.');
    expect(lede.querySelector('strong')).toBeNull();
  });

  it('keeps the inviter when only the workspace is missing', async () => {
    await renderInvitation({ ...INVITE, tenant_name: null });

    expect(screen.getByText('Priya Sharma')).toBeTruthy();
    expect(screen.getByText(/has set you up as agent\.$/i)).toBeTruthy();
  });

  it('ranks Google first and keeps the password path one click away', async () => {
    /*
      Deliberately unequal, and deliberately not hidden: Google is the shorter road
      and needs no new secret, but the password path is the entire reason this page
      exists — an invited agent without a Google account previously had no way in
      at all — so it must not read as an advanced option.
    */
    await renderInvitation();

    expect(screen.getByRole('button', { name: /continue with google/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Create a password instead' })).toBeTruthy();
    // Nothing is revealed until asked for.
    expect(screen.queryByLabelText('Choose a password')).toBeNull();
  });
});

describe('each terminal status gets its own screen', () => {
  const cases = [
    { status: 'expired' as const, matches: /this invitation has expired/i, advice: /send a new one/i },
    { status: 'claimed' as const, matches: /already been used/i, advice: /the account you created/i },
    { status: 'revoked' as const, matches: /no longer valid/i, advice: /withdrawn/i },
    { status: 'not_found' as const, matches: /cannot find that invitation/i, advice: /copy the whole link/i },
    {
      status: 'identity_already_bound' as const,
      matches: /you are already set up/i,
      advice: /this address already has an account/i,
    },
  ];

  it.each(cases)('$status says what happened and what to do next', async ({ status, matches, advice }) => {
    /*
      Four screens rather than one "invalid link", because the recipient can act
      on exactly one of them unaided: expired needs a resend, claimed means they
      already did this, revoked was a decision somebody made, and not_found is
      overwhelmingly an email client that wrapped the link across two lines —
      which the recipient can fix alone in ten seconds if anybody tells them so.
    */
    mocks.getInvite.mockResolvedValue({ status });
    renderAt();

    expect(await screen.findByText(matches)).toBeTruthy();
    expect(screen.getByText(advice)).toBeTruthy();
    // No way to claim anything from a terminal screen.
    expect(screen.queryByRole('button', { name: /continue with google/i })).toBeNull();
  });

  it('sends an already-set-up invitee to the door rather than to their supervisor', async () => {
    /*
      The server's fifth claim outcome (`identity_already_bound`), added after this
      page was first written: the invited USER ROW already has a real Firebase
      account behind it, because the invitee signed in by some other route since
      the invitation was sent. The server refuses to rebind the row — it would be an
      account-takeover primitive on an address the claimant may not control — and
      leaves the invitation outstanding.

      Handled as a first-class outcome and not as a generic conflict, because the
      remedy is specific and it is theirs: the account exists, at that address, so
      signing in finishes the job. A generic refusal would send somebody who is
      already fully set up back to their supervisor for a new invitation that
      cannot help them.
    */
    mocks.claimInvite.mockRejectedValue(new InviteUnavailableError('identity_already_bound'));
    await renderInvitation();
    fireEvent.click(screen.getByRole('button', { name: /continue with google/i }));

    expect(await screen.findByText(/you are already set up/i)).toBeTruthy();
    expect(
      (await screen.findByRole('link', { name: /go to sign in/i })).getAttribute('href'),
    ).toBe('/agency/login');
    expect(mocks.navigate).not.toHaveBeenCalled();
  });

  it('sends a claimed invite to the agency door, which is where they now belong', async () => {
    // The only one of the four with an action the recipient can take here: the
    // workspace exists and their account exists, so they need the sign-in page.
    mocks.getInvite.mockResolvedValue({ status: 'claimed' });
    renderAt();

    const link = await screen.findByRole('link', { name: /go to sign in/i });
    expect(link.getAttribute('href')).toBe('/agency/login');
  });

  it('offers a retry when the lookup itself failed, not a supervisor to chase', async () => {
    /*
      A failed request is the one outcome that may resolve by itself, which is what
      makes a retry the right control. Telling somebody to chase a colleague over a
      five-second outage is how a working invite becomes a support ticket.
    */
    mocks.getInvite.mockRejectedValueOnce(new Error('Failed to fetch'));
    renderAt();

    expect(await screen.findByText(/could not open your invitation/i)).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toMatch(/failed to fetch/i);

    mocks.getInvite.mockResolvedValue({ status: 'pending', invite: INVITE });
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));

    expect(await screen.findByRole('button', { name: /continue with google/i })).toBeTruthy();
  });
});

describe('Continue with Google', () => {
  it('claims and lands on the station when the address matches', async () => {
    await renderInvitation();
    fireEvent.click(screen.getByRole('button', { name: /continue with google/i }));

    await waitFor(() => expect(mocks.claimInvite).toHaveBeenCalledWith(TOKEN));
    /*
      `replace`, and it is load-bearing rather than tidy. The token is spent the
      instant the claim succeeds, so a pushed entry leaves it one back-navigation
      away — and a back button after a successful join is an ordinary thing to
      press. The agent would land on "This invitation has already been used"
      moments after it worked.
    */
    expect(mocks.navigate).toHaveBeenCalledWith('/dialer', { replace: true });
  });

  it('never asks about an address that matches only in case', async () => {
    // The server matches on the exact string, but a confirmation for `PRIYA@ACME.COM`
    // would be a question with no content — it is the same mailbox, and asking
    // teaches people to click through the one question that matters.
    mocks.establishInviteCredential.mockResolvedValue({ email: 'PRIYA@Acme.com ' });
    await renderInvitation();
    fireEvent.click(screen.getByRole('button', { name: /continue with google/i }));

    await waitFor(() => expect(mocks.claimInvite).toHaveBeenCalled());
    expect(mocks.trackAgencyInviteAddressMismatch).not.toHaveBeenCalled();
  });
});

describe('the Google address mismatch', () => {
  const withMismatch = async () => {
    mocks.establishInviteCredential.mockResolvedValue({ email: 'p.sharma@gmail.com' });
    const view = await renderInvitation();
    fireEvent.click(screen.getByRole('button', { name: /continue with google/i }));
    await screen.findByText(/that is a different address/i);
    return view;
  };

  it('stops before claiming and shows both addresses', async () => {
    /*
      The single most valuable interaction on the page. Today this exact case
      passes in silence: the browser hands over the personal account it is already
      signed into, `POST /auth/session` provisions a tenant for THAT address, and
      the agent becomes the owner of an empty workspace while the membership their
      supervisor created sits unclaimed. Linking the two is a legitimate answer —
      the claim endpoint makes it one — so this does not refuse it. It refuses to
      do it quietly.
    */
    await withMismatch();

    expect(screen.getByText('p.sharma@gmail.com')).toBeTruthy();
    expect(screen.getAllByText('priya@acme.com').length).toBeGreaterThan(0);
    expect(mocks.claimInvite).not.toHaveBeenCalled();
    expect(mocks.navigate).not.toHaveBeenCalled();
  });

  it('moves focus to the question, not to an answer', async () => {
    // Landing focus on "Use this account" would put a screen-reader user on an
    // answer before they had been asked, on the one decision here that must not
    // be made by reflex.
    await withMismatch();

    expect(document.activeElement?.textContent).toMatch(/that is a different address/i);
  });

  it('claims only after the confirmation, and records that it was not a match', async () => {
    await withMismatch();
    fireEvent.click(screen.getByRole('button', { name: 'Use this account' }));

    await waitFor(() => expect(mocks.claimInvite).toHaveBeenCalledWith(TOKEN));
    expect(mocks.navigate).toHaveBeenCalledWith('/dialer', { replace: true });
    expect(mocks.trackAgencyInviteClaimSucceeded).toHaveBeenCalledWith({
      method: 'google',
      address_matched: false,
    });
  });

  it('declining SIGNS OUT, so the next attempt is not handed the same account', async () => {
    /*
      The credential goes, not just the screen. Firebase keeps the wrong Google
      account as the browser's current user, and the next popup re-selects it
      without asking — so an escape hatch that only reset component state would
      return them to this same screen and read as a page that does not work.
    */
    await withMismatch();
    fireEvent.click(screen.getByRole('button', { name: 'Use a different account' }));

    await waitFor(() => expect(mocks.logout).toHaveBeenCalled());
    expect(mocks.claimInvite).not.toHaveBeenCalled();
    // And they are back at the two options, not stranded.
    expect(await screen.findByRole('button', { name: /continue with google/i })).toBeTruthy();
  });

  it('clears the confirmation even when signing out fails', async () => {
    // `logout()` calls Firebase `signOut()`, which rejects on a network blip. The
    // only way out of this screen must not depend on the network.
    mocks.logout.mockRejectedValue(new Error('network request failed'));
    await withMismatch();
    fireEvent.click(screen.getByRole('button', { name: 'Use a different account' }));

    expect(await screen.findByRole('button', { name: /continue with google/i })).toBeTruthy();
  });

  it('keeps the way out on screen when the confirmed claim is refused', async () => {
    /*
      The server's `identity_in_use`: the Google account they confirmed already
      belongs to a DIFFERENT user row here, so the claim is refused and the
      invitation is deliberately left outstanding. This case is reachable
      precisely because this page allows a mismatched address — a personal
      account with a workspace of its own is exactly what produces it.

      The page used to clear the confirmation on any failure, which tore down
      `AddressMismatch` and with it "Use a different account" — the only control
      on the page that signs out. The visitor was returned to the two options
      still signed in as the colliding account, where Continue with Google
      re-selects it and fails identically: a loop with no exit, under advice
      ("sign in with it directly") that had nothing to press.
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
    // The sign-out is still there…
    expect(screen.getByRole('button', { name: 'Use a different account' })).toBeTruthy();
    // …and so is the other remedy the server names, as something pressable.
    expect(screen.getByRole('link', { name: /go to sign in/i }).getAttribute('href'))
      .toBe('/agency/login');
    expect(mocks.trackAgencyInviteClaimFailed).toHaveBeenCalledWith({
      method: 'google',
      reason: 'identity_in_use',
    });
    expect(mocks.navigate).not.toHaveBeenCalled();
  });

  it('leaves nothing signed in when the visitor walks away mid-join', async () => {
    /*
      The stray-tenant hazard reached by the two ordinary `<Link>`s on this page
      ("Sign in instead", and "Go to sign in" on a terminal screen). Firebase
      persists the credential in localStorage, the provider's suppression does not
      survive a page load, and `POST /auth/session` provisions a tenant for an
      address the server does not recognise — so leaving this page holding an
      unclaimed credential is the same defect the page exists to remove, one
      navigation later. Leaving signs out, exactly as declining does.
    */
    const { unmount } = await withMismatch();
    unmount();

    await waitFor(() => expect(mocks.logout).toHaveBeenCalled());
  });

  it('measures the near-miss as well as the answer', async () => {
    /*
      `shown` is emitted separately from the outcome, because the interesting third
      outcome is neither confirmed nor declined: closing the tab. Without it an
      abandoned mismatch is indistinguishable from one that never happened, and
      "how often did onboarding nearly go wrong" is the question this event exists
      to answer.
    */
    await withMismatch();
    expect(mocks.trackAgencyInviteAddressMismatch).toHaveBeenCalledWith({ outcome: 'shown' });

    fireEvent.click(screen.getByRole('button', { name: 'Use a different account' }));
    await waitFor(() =>
      expect(mocks.trackAgencyInviteAddressMismatch).toHaveBeenCalledWith({ outcome: 'declined' }),
    );
    expect(mocks.trackAgencyInviteClaimFailed).toHaveBeenCalledWith({
      method: 'google',
      reason: 'mismatch_declined',
    });
  });
});

describe('email and password', () => {
  it('pre-fills the invited address and refuses to let it be edited', async () => {
    /*
      The invited address is the one value on this page that must not drift, and
      an editable field here would reintroduce — one keystroke at a time — the very
      mismatch the token was minted to survive. `readOnly` rather than `disabled`:
      a disabled input is skipped by keyboard navigation and announced as
      unavailable, when the truth is the opposite — it is the most important value
      on the screen and it is settled.
    */
    await renderInvitation();
    await fillPassword('');

    const field = screen.getByLabelText('Your address') as HTMLInputElement;
    expect(field.value).toBe('priya@acme.com');
    expect(field.readOnly).toBe(true);
    expect(field.disabled).toBe(false);
  });

  it('puts focus in the password box the moment it reveals', async () => {
    // The page just changed under somebody and the next thing to do is type.
    // Without this a keyboard user tabs back past the Google button to reach the
    // only field that appeared.
    await renderInvitation();
    fireEvent.click(screen.getByRole('button', { name: 'Create a password instead' }));

    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByLabelText('Choose a password')),
    );
  });

  it('creates the credential and claims with it', async () => {
    await renderInvitation();
    await fillPassword('correct horse battery');
    fireEvent.click(screen.getByRole('button', { name: 'Create my sign-in' }));

    await waitFor(() =>
      expect(mocks.establishInviteCredential).toHaveBeenCalledWith({
        method: 'create',
        email: 'priya@acme.com',
        password: 'correct horse battery',
      }),
    );
    expect(mocks.claimInvite).toHaveBeenCalledWith(TOKEN);
    expect(mocks.navigate).toHaveBeenCalledWith('/dialer', { replace: true });
    // The address came from the read-only field, so it cannot fail to match.
    expect(mocks.trackAgencyInviteClaimSucceeded).toHaveBeenCalledWith({
      method: 'create',
      address_matched: true,
    });
  });

  it('says what is wrong with a password WHILE it is typed', async () => {
    /*
      The alternative is Firebase answering `auth/weak-password` after a round
      trip, which tells somebody their password is wrong without ever telling them
      what would be right. The floor is stated before the button is pressed.
    */
    await renderInvitation();
    await fillPassword('short');

    expect(screen.getByText(/3 to go/)).toBeTruthy();
    expect(screen.getByText('Too short')).toBeTruthy();
  });

  it('refuses a password containing the address, without going near the network', async () => {
    /*
      The local part is pre-filled, on screen and unchangeable, which makes "the
      bit before the @" the single likeliest password anybody types here. The one
      non-length blocker, and it earns the exception.
    */
    await renderInvitation();
    await fillPassword('priya12345');
    fireEvent.click(screen.getByRole('button', { name: 'Create my sign-in' }));

    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/your own address/i));
    expect(mocks.establishInviteCredential).not.toHaveBeenCalled();
    expect(mocks.trackAgencyInviteClaimFailed).toHaveBeenCalledWith({
      method: 'create',
      reason: 'weak_password',
    });
  });

  it('reports strength up the scale rather than only refusing', async () => {
    // A gate that only ever says no is a gate people work around. Everything above
    // the floor is advice.
    await renderInvitation();
    await fillPassword('Tr0ubad0ur&3xtra');

    expect(screen.getByText('Strong')).toBeTruthy();
  });

  it('turns email-already-in-use into a sign-in, not a dead end', async () => {
    /*
      Not a failure — an agent invited to a SECOND workspace, who already has a
      credential from the first. The claim then attaches this membership to the
      account they already have, which is exactly what the token makes possible.
    */
    mocks.establishInviteCredential.mockRejectedValueOnce(
      Object.assign(new Error('already in use'), { code: 'auth/email-already-in-use' }),
    );
    await renderInvitation();
    await fillPassword('correct horse battery');
    fireEvent.click(screen.getByRole('button', { name: 'Create my sign-in' }));

    // The form becomes a sign-in, and says why.
    expect(await screen.findByLabelText('Your password')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Sign in and join' })).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toMatch(/already has a password/i);
    expect(mocks.trackAgencyInviteClaimFailed).toHaveBeenCalledWith({
      method: 'create',
      reason: 'email_in_use',
    });
  });

  it('claims with the existing credential on the second attempt', async () => {
    mocks.establishInviteCredential.mockRejectedValueOnce(
      Object.assign(new Error('already in use'), { code: 'auth/email-already-in-use' }),
    );
    await renderInvitation();
    await fillPassword('correct horse battery');
    fireEvent.click(screen.getByRole('button', { name: 'Create my sign-in' }));

    const field = await screen.findByLabelText('Your password');
    fireEvent.change(field, { target: { value: 'their-old-password' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in and join' }));

    await waitFor(() =>
      expect(mocks.establishInviteCredential).toHaveBeenLastCalledWith({
        method: 'sign_in',
        email: 'priya@acme.com',
        password: 'their-old-password',
      }),
    );
    expect(mocks.navigate).toHaveBeenCalledWith('/dialer', { replace: true });
  });

  it('does not apply the strength rule to a password they already have', async () => {
    /*
      Applied to a sign-in the rule would lock somebody out of a workspace over a
      password they cannot change from here — a rule about future passwords
      enforced against a past one.
    */
    mocks.establishInviteCredential.mockRejectedValueOnce(
      Object.assign(new Error('already in use'), { code: 'auth/email-already-in-use' }),
    );
    await renderInvitation();
    await fillPassword('correct horse battery');
    fireEvent.click(screen.getByRole('button', { name: 'Create my sign-in' }));

    const field = await screen.findByLabelText('Your password');
    fireEvent.change(field, { target: { value: 'priya1' } }); // short AND contains the address
    fireEvent.click(screen.getByRole('button', { name: 'Sign in and join' }));

    await waitFor(() =>
      expect(mocks.establishInviteCredential).toHaveBeenLastCalledWith(
        expect.objectContaining({ method: 'sign_in', password: 'priya1' }),
      ),
    );
  });

  it('translates a Firebase failure into something a first-time user can read', async () => {
    // Firebase's own messages are written for developers ("Firebase: Error
    // (auth/wrong-password).") and this page is read by somebody who has never
    // seen the product.
    mocks.establishInviteCredential.mockRejectedValue(
      Object.assign(new Error('Firebase: Error (auth/wrong-password).'), {
        code: 'auth/wrong-password',
      }),
    );
    await renderInvitation();
    await fillPassword('correct horse battery');
    fireEvent.click(screen.getByRole('button', { name: 'Create my sign-in' }));

    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toMatch(/does not match this address/i),
    );
    expect(screen.getByRole('alert').textContent).not.toMatch(/auth\/wrong-password/);
  });
});

describe('nothing can be submitted twice', () => {
  it('disables every control while a claim is in flight', async () => {
    /*
      One `pending` value gates the whole card. Two claims from one token is the
      race that produces a 409 on the second — i.e. the agent watching their own
      successful join report itself as already used.
    */
    let release: (() => void) | undefined;
    mocks.claimInvite.mockReturnValue(new Promise((resolve) => {
      release = () => resolve(SESSION);
    }));
    await renderInvitation();
    fireEvent.click(screen.getByRole('button', { name: /continue with google/i }));

    await waitFor(() =>
      expect((screen.getByRole('button', { name: /waiting for google/i }) as HTMLButtonElement).disabled).toBe(true),
    );
    expect(
      (screen.getByRole('button', { name: 'Create a password instead' }) as HTMLButtonElement).disabled,
    ).toBe(true);

    /*
      The LINKS too, which `pending` did not reach. "Sign in instead" stayed
      clickable through an in-flight claim, and taking it unmounts the page — whose
      cleanup signs out, racing the `adoptSession` that has just bound the
      membership. What that leaves is an agent signed out, on a door telling them
      to use the account they were signed out of, holding a token that is now
      spent. The token is single-use, so it is the one failure here that cannot be
      retried.
    */
    const signInInstead = screen.getByRole('link', { name: /sign in instead/i });
    expect(signInInstead.getAttribute('aria-disabled')).toBe('true');
    const click = createEvent.click(signInInstead);
    fireEvent(signInInstead, click);
    expect(click.defaultPrevented).toBe(true);

    release?.();
    await waitFor(() => expect(mocks.navigate).toHaveBeenCalled());

    // …and it comes back the moment there is nothing in flight.
    expect(
      screen.getByRole('link', { name: /sign in instead/i }).getAttribute('aria-disabled'),
    ).toBeNull();
  });

  it('does not sign out from under a claim that is already in flight', async () => {
    /*
      The same race, through the other way off this page — a back-navigation, an
      app switch on a phone — which no disabled control can reach. The flag the
      cleanup reads is now raised when the claim is ISSUED rather than when it
      answers, so leaving mid-claim leaves the credential alone.
    */
    let release: (() => void) | undefined;
    mocks.claimInvite.mockReturnValue(new Promise((resolve) => {
      release = () => resolve(SESSION);
    }));
    const { unmount } = await renderInvitation();
    fireEvent.click(screen.getByRole('button', { name: /continue with google/i }));
    await waitFor(() => expect(mocks.claimInvite).toHaveBeenCalled());

    unmount();
    await act(async () => { release?.(); });

    expect(mocks.logout).not.toHaveBeenCalled();
    // The claim landed, and it is a real session — but nobody is on this page any
    // more, so nothing navigates them.
    expect(mocks.trackAgencyInviteClaimSucceeded).toHaveBeenCalled();
    expect(mocks.navigate).not.toHaveBeenCalled();
  });

  it('drops the credential when a claim in flight is then REFUSED', async () => {
    /*
      The other half of that flag: a refused claim spent nothing, so the credential
      is this page's to clean up again — and the cleanup has already run and
      declined to act, which makes this the last chance to drop it rather than
      leave it signed into Firebase behind a page that no longer exists.
    */
    let reject: ((err: unknown) => void) | undefined;
    mocks.claimInvite.mockReturnValue(new Promise((_resolve, rej) => {
      reject = (err) => rej(err);
    }));
    const { unmount } = await renderInvitation();
    fireEvent.click(screen.getByRole('button', { name: /continue with google/i }));
    await waitFor(() => expect(mocks.claimInvite).toHaveBeenCalled());

    unmount();
    await act(async () => { reject?.(new Error('Failed to fetch')); });

    await waitFor(() => expect(mocks.logout).toHaveBeenCalled());
  });
});

describe('leaving while a credential is being established', () => {
  /**
   * The window the unmount cleanup cannot see.
   *
   * It can only act on what exists when it runs, and `establishInviteCredential`
   * resolves after it: a popup is a place people walk away from. So the promise
   * carried on into a page that was gone — claiming and navigating somebody who
   * had left on the matching path, and on a mismatched address leaving a Firebase
   * session behind with no page left to clean it up. That is the stray-tenant
   * hazard again, reached through the one door the cleanup did not cover.
   */
  const withPendingCredential = async () => {
    let resolveCredential: ((value: { email: string | null }) => void) | undefined;
    mocks.establishInviteCredential.mockReturnValue(
      new Promise((resolve) => { resolveCredential = resolve; }),
    );
    const view = await renderInvitation();
    fireEvent.click(screen.getByRole('button', { name: /continue with google/i }));
    await waitFor(() => expect(mocks.establishInviteCredential).toHaveBeenCalled());
    return { ...view, resolve: (email: string | null) => resolveCredential?.({ email }) };
  };

  it('signs out a credential that arrives after the visitor has gone', async () => {
    const { unmount, resolve } = await withPendingCredential();
    unmount();

    await act(async () => { resolve(INVITE.email); });

    await waitFor(() => expect(mocks.logout).toHaveBeenCalled());
    // Not claimed, and above all not navigated: the visitor is somewhere else.
    expect(mocks.claimInvite).not.toHaveBeenCalled();
    expect(mocks.navigate).not.toHaveBeenCalled();
  });

  it('signs out a MISMATCHED credential that arrives after the visitor has gone', async () => {
    // The case with nothing else to catch it: no claim is attempted, so without
    // this the wrong Google account simply stays the browser's current user.
    const { unmount, resolve } = await withPendingCredential();
    unmount();

    await act(async () => { resolve('p.sharma@gmail.com'); });

    await waitFor(() => expect(mocks.logout).toHaveBeenCalled());
    expect(mocks.trackAgencyInviteAddressMismatch).not.toHaveBeenCalled();
  });
});

describe('what analytics may see of this page', () => {
  it('excludes the invitation card from autocapture', async () => {
    /*
      Autocapture, rage clicks and dead clicks are all on, and posthog-js records
      the clicked element's own text. This card renders the invitee's address, the
      inviter's name and the workspace's name — and `capture_dead_clicks` means a
      click that changes nothing, which on a page of static text is most of them,
      is captured too. The `before_send` redactor added alongside removes invite
      TOKENS and nothing else: a person's name is not token-shaped, so it went out
      regardless.

      posthog-js walks the clicked element's ANCESTORS, so the class on the card
      covers everything inside it however the markup is rearranged later —
      including the mismatch screen, which names two addresses. That the pinned
      posthog-js still honours it is asserted in
      `src/__tests__/analytics/autocaptureOptOut.test.ts`; what belongs here is
      that the PII is inside the marked subtree.
    */
    await renderInvitation();

    const card = document.querySelector('.ph-no-capture');
    expect(card).not.toBeNull();
    for (const pii of [INVITE.email, INVITE.inviter_name!, INVITE.tenant_name!]) {
      expect(screen.getAllByText(pii).every((el) => card!.contains(el))).toBe(true);
    }
  });

  it('keeps the PII-free funnel events, which the class does not touch', async () => {
    // The exclusion is about what posthog-js reads off the DOM. Every step of the
    // funnel is an explicit `capture` with properties that carry none of it, and
    // those still fire.
    await renderInvitation();
    fireEvent.click(screen.getByRole('button', { name: /continue with google/i }));

    await waitFor(() =>
      expect(mocks.trackAgencyInviteClaimAttempted).toHaveBeenCalledWith({ method: 'google' }),
    );
    expect(mocks.trackAgencyInviteViewed).toHaveBeenCalledWith({
      status: 'pending',
      role: 'agent',
      has_inviter: true,
    });
  });
});

describe('an invite that goes terminal mid-claim', () => {
  it('switches to that status’s screen rather than erroring under a dead form', async () => {
    /*
      A supervisor revoked it, it expired while the form was open, or a second tab
      claimed it first. That is a state change, not a failed request: the form can
      no longer succeed, so it stops being shown.
    */
    mocks.claimInvite.mockRejectedValue(new InviteUnavailableError('claimed'));
    await renderInvitation();
    fireEvent.click(screen.getByRole('button', { name: /continue with google/i }));

    expect(await screen.findByText(/already been used/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /continue with google/i })).toBeNull();
    expect(mocks.navigate).not.toHaveBeenCalled();
    expect(mocks.trackAgencyInviteClaimFailed).toHaveBeenCalledWith({
      method: 'google',
      reason: 'invite_unavailable',
    });
  });

  it('moves focus to the outcome, because the button that was pressed is gone', async () => {
    /*
      The whole card is replaced while somebody is mid-action, so the control they
      pressed leaves the document and focus falls to `<body>` — a screen-reader
      user is told nothing at all about a page that changed completely under them.
      `AddressMismatch` already handles its own arrival this way; this screen did
      not, and it is the one that arrives WITHOUT being asked for.
    */
    mocks.claimInvite.mockRejectedValue(new InviteUnavailableError('revoked'));
    await renderInvitation();
    fireEvent.click(screen.getByRole('button', { name: /continue with google/i }));

    await screen.findByText(/no longer valid/i);
    expect(document.activeElement?.textContent).toMatch(/no longer valid/i);
  });
});

describe('analytics', () => {
  it('reports what was behind the link, without reporting who it was for', async () => {
    /*
      The PII rule bites hardest on this page, because almost everything on it is
      exactly what must not be sent: the invited address, the address they signed
      in with, the inviter's name and the workspace's name. None of them appear in
      any property here.
    */
    await renderInvitation();

    expect(mocks.trackAgencyInviteViewed).toHaveBeenCalledWith({
      status: 'pending',
      role: 'agent',
      has_inviter: true,
    });
  });

  it('reports a terminal link too, so an unclicked funnel is distinguishable', async () => {
    mocks.getInvite.mockResolvedValue({ status: 'expired' });
    renderAt();
    await screen.findByText(/this invitation has expired/i);

    expect(mocks.trackAgencyInviteViewed).toHaveBeenCalledWith({
      status: 'expired',
      role: null,
      has_inviter: false,
    });
  });

  it('reports an unreadable lookup as its own status, not as silence', async () => {
    // A spell of failed lookups and a spell of nobody clicking look identical
    // without this.
    mocks.getInvite.mockRejectedValue(new Error('Failed to fetch'));
    renderAt();
    await screen.findByText(/could not open your invitation/i);

    expect(mocks.trackAgencyInviteViewed).toHaveBeenCalledWith({
      status: 'unreachable',
      role: null,
      has_inviter: false,
    });
  });

  it('records the attempt before it can know the outcome', async () => {
    await renderInvitation();
    fireEvent.click(screen.getByRole('button', { name: /continue with google/i }));

    await waitFor(() =>
      expect(mocks.trackAgencyInviteClaimAttempted).toHaveBeenCalledWith({ method: 'google' }),
    );
  });
});
