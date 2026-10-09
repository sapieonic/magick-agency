import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';

/**
 * The Agency Dialer's own front door.
 *
 * ── What is actually worth pinning here ────────────────────────────────────
 * The page is a form, and a test that renders a form and asserts it has a form in
 * it is worth nothing. Three properties are load-bearing, and each of them is a
 * way this feature fails in production rather than a way the markup could change:
 *
 *  1. **No signup, ever.** `POST /auth/session` provisions a brand-new tenant for
 *     an address master does not recognise, and an invited agent's membership is
 *     activated by matching the address they sign in with. So a signup affordance
 *     on this page is not a stray control — it is the mechanism by which an agent
 *     ends up in a private empty tenant while the membership their supervisor
 *     created sits unclaimed, with nothing telling either of them.
 *  2. **The landing is `/agency`, and the persona resolves there.** `/dialer`
 *     would strand a supervisor on their own empty staffing list; `/` would send
 *     one to `/app` after they had asked, by their choice of door, for the dialer.
 *     Both personas sign in through this one form, so the destination has to be
 *     the one that branches.
 *  3. **`is_new` is a FAILURE here.** The same fact means opposite things at the
 *     two doors, and this is the only place in the app where the distinction
 *     exists.
 *
 * PORT NOTE (magick-agency): property 3's FACT changed, its rule did not. Agency
 * refuses session path 4 with 403 `no_membership` (plan §3.1) instead of
 * provisioning a tenant and answering `is_new: true`, so every case that drove
 * the diagnosis with `{ is_new: true }` drives it with that refusal instead
 * (`noMembership()`), and the Google case reads the address from Firebase's
 * current user, because a refused sign-in has no session to read it from. Two
 * cases are DELETED with the cross-link they pinned ("keeps an exit to the
 * primary app…", "offers an exit that does not depend on the network"): the
 * console has one door, and `/login` is this page. Two NEW cases at the end pin
 * the reload path (`useAuth().sessionRefusal`) and that a different 403 is not
 * mistaken for the diagnosis.
 */

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  signInEmail: vi.fn(),
  signInGoogle: vi.fn(),
  resetPassword: vi.fn(),
  logout: vi.fn(),
  trackAuthAttempted: vi.fn(),
  trackAuthSucceeded: vi.fn(),
  trackAuthFailed: vi.fn(),
  trackEmailVerificationRequired: vi.fn(),
}));

const firebase = vi.hoisted(() => ({ currentUser: null as { email: string | null } | null }));
vi.mock('firebase/auth', () => ({ getAuth: () => ({ currentUser: firebase.currentUser }) }));

vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  return { ...actual, useNavigate: () => mocks.navigate };
});

/**
 * `useAuth` is driven per-case rather than frozen, because three of the page's
 * branches are decided by auth STATE rather than by a call: the loading spinner,
 * the already-signed-in forward, and the verification bounce.
 */
const authState: {
  loading: boolean;
  error: string | null;
  user: { uid: string } | null;
  pendingEmailVerification: boolean;
  sessionRefusal: 'no_membership' | 'email_unverified' | null;
  firebaseUser: { email: string | null } | null;
} = {
  loading: false,
  error: null,
  user: null,
  pendingEmailVerification: false,
  sessionRefusal: null,
  firebaseUser: null,
};

vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({
    signInEmail: mocks.signInEmail,
    signInGoogle: mocks.signInGoogle,
    resetPassword: mocks.resetPassword,
    logout: mocks.logout,
    ...authState,
  }),
}));

vi.mock('../../analytics/events', () => ({
  trackAuthAttempted: mocks.trackAuthAttempted,
  trackAuthSucceeded: mocks.trackAuthSucceeded,
  trackAuthFailed: mocks.trackAuthFailed,
  trackEmailVerificationRequired: mocks.trackEmailVerificationRequired,
}));

import { SESSION_EXPIRED_MESSAGE } from '../../utils/session';
import { ApiError } from '../../api/client';
import AgencyLoginPage from '../../pages/agency/AgencyLoginPage';

/** Agency's answer to an address it has no user, stub or invite for (plan §3.1). */
function noMembership() {
  return new ApiError(403, {
    error: 'Forbidden',
    code: 'no_membership',
    message: 'No Magick Agency account exists for this sign-in.',
  });
}

/** A settled, already-onboarded session — the ordinary case. */
const RETURNING = {
  is_new: false,
  needs_phone: false,
  user: { email: 'agent@agency.test' },
};

/**
 * Where a `<Navigate>` landed. Needed because the signed-in branch forwards
 * declaratively rather than through the mocked `useNavigate` — `Navigate` resolves
 * the router's own hook internally, so a spy on the module export cannot see it.
 */
function Where() {
  const location = useLocation();
  return <div data-testid="where">{`${location.pathname}${location.search}`}</div>;
}

function renderAt(entry = '/agency/login') {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/agency/login" element={<AgencyLoginPage />} />
        <Route path="*" element={<Where />} />
      </Routes>
    </MemoryRouter>,
  );
}

/** Fill the form and submit it. */
function signIn(email = 'agent@agency.test', password = 'hunter2') {
  fireEvent.change(screen.getByLabelText('Email'), { target: { value: email } });
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: password } });
  fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
}

beforeEach(() => {
  vi.clearAllMocks();
  // The unrecognised-account diagnosis is remembered per tab, so it leaks between
  // cases unless cleared — and a leak here would make the seeding cases pass for
  // the wrong reason.
  sessionStorage.clear();
  Object.assign(authState, {
    loading: false,
    error: null,
    user: null,
    pendingEmailVerification: false,
    sessionRefusal: null,
    firebaseUser: null,
  });
  firebase.currentUser = null;
  mocks.signInEmail.mockResolvedValue(RETURNING);
  mocks.signInGoogle.mockResolvedValue(RETURNING);
  mocks.logout.mockResolvedValue(undefined);
});

afterEach(() => cleanup());

describe('there is no way to sign up at the agency door', () => {
  it('offers no signup affordance at all', () => {
    /*
      The hazard this closes is silent and not obviously an auth bug: master
      provisions a tenant for an unrecognised address, so an agent who reaches for
      "Sign Up" lands in an empty workspace of their own and their real membership
      is never claimed. `/login` keeps its tabs; this page must never grow them.
    */
    renderAt();

    expect(screen.queryByRole('button', { name: /sign up/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /create account/i })).toBeNull();
    expect(screen.queryByLabelText(/confirm password/i)).toBeNull();
    // The phone field exists only to serve signup.
    expect(screen.queryByLabelText(/phone/i)).toBeNull();
  });

  it('does not carry the primary door’s promotional pitch', () => {
    // Agency staff are staff, not prospects. A free-credits banner on the page an
    // agent opens at the start of every shift is noise at best.
    renderAt();

    expect(screen.queryByText(/free credits/i)).toBeNull();
    expect(screen.queryByText(/no credit card/i)).toBeNull();
  });
});

describe('where a successful sign-in lands', () => {
  it('defaults to /agency, so the persona decides the rest', async () => {
    /*
      NOT `/dialer`: a supervisor sent there arrives at their own staffing list,
      which is usually empty — the reason `AgencyHomeRedirect` branches at all. And
      NOT `/`, whose entitlement predicate is strict enough that its own docstring
      says it "fires rarely", so a supervisor at an ordinary both-products tenant
      would be sent to `/app` after asking for the dialer by choosing this door.
    */
    renderAt();
    signIn();

    await waitFor(() => expect(mocks.navigate).toHaveBeenCalledWith('/agency'));
  });

  it('honours a validated ?next= over the default', async () => {
    // A bookmarked `/station?campaign=…` has to survive the sign-in it triggers —
    // the case `RequireAuth` emits the param for.
    renderAt('/agency/login?next=%2Fstation%3Fcampaign%3Dcamp-1');
    signIn();

    await waitFor(() =>
      expect(mocks.navigate).toHaveBeenCalledWith('/station?campaign=camp-1'),
    );
  });

  it('falls back to /agency when ?next= fails the open-redirect guard', async () => {
    // The value is in the URL, so anyone can put anything in it and send that link
    // to somebody who will read our domain in the address bar and trust it.
    renderAt('/agency/login?next=%2F..%2F%2Fevil.example');
    signIn();

    await waitFor(() => expect(mocks.navigate).toHaveBeenCalledWith('/agency'));
  });

  it('sends an unverified address to /verify-email, carrying the destination', async () => {
    /*
      `signInEmail` answers null when the address is unverified. Verification is a
      step they have to finish, so the deep link is not honoured PAST it — but it
      is carried THROUGH it, which is the fix for two ways `/verify-email` used to
      strand agency staff: after verifying it sent a supervisor to `/app`, and
      after signing out it sent them to `/login`. See `VerifyEmailPage`.
    */
    mocks.signInEmail.mockResolvedValue(null);
    renderAt('/agency/login?next=%2Fdialer');
    signIn();

    await waitFor(() =>
      expect(mocks.navigate).toHaveBeenCalledWith('/verify-email?next=%2Fdialer'),
    );
  });

  it('carries the default destination through verification when nothing was asked for', async () => {
    // Without a `next` of its own the bounce would land back at `/`, which is
    // `HomeRedirect` — `/app` for a supervisor at an ordinary tenant.
    mocks.signInEmail.mockResolvedValue(null);
    renderAt();
    signIn();

    await waitFor(() =>
      expect(mocks.navigate).toHaveBeenCalledWith('/verify-email?next=%2Fagency'),
    );
  });
});

describe('a brand-new tenant means we did not recognise them', () => {
  /**
   * `is_new` on `/login` is the product working — somebody signed up. Here it can
   * only mean the address was not the invited one, and the workspace they want is
   * one corrected address away.
   */
  it('refuses to navigate into the product, and says why', async () => {
    mocks.signInEmail.mockRejectedValue(noMembership());
    renderAt();
    signIn('typo@agency.test');

    await waitFor(() => expect(screen.getByText(/don’t recognise that account/i)).toBeTruthy());
    // Not `/onboarding`, which would walk them through building a workspace they
    // already have, and not the agency surface either.
    expect(mocks.navigate).not.toHaveBeenCalled();
  });

  it('names the address it signed in with, because that IS the diagnosis', async () => {
    // Sign-in is matched on the exact invited address, so showing which one was
    // used is the difference between an actionable message and a dead end.
    mocks.signInEmail.mockRejectedValue(noMembership());
    renderAt();
    signIn('typo@agency.test');

    await waitFor(() => expect(screen.getByText('typo@agency.test')).toBeTruthy());
  });

  it('offers a way back to the form rather than stranding them', async () => {
    mocks.logout.mockResolvedValue(undefined);
    mocks.signInEmail.mockRejectedValue(noMembership());
    renderAt();
    signIn('typo@agency.test');

    await waitFor(() => expect(screen.getByText(/don’t recognise that account/i)).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Try a different account' }));

    await waitFor(() => expect(mocks.logout).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByRole('button', { name: 'Sign in' })).toBeTruthy());
  });

  it('applies the same rule to Google, which is the way in that can still hit it', async () => {
    // There is no signup form here, so an unrecognised address can only arrive
    // through the Google button.
    firebase.currentUser = { email: 'personal@gmail.test' };
    mocks.signInGoogle.mockRejectedValue(noMembership());
    renderAt();
    fireEvent.click(screen.getByRole('button', { name: /continue with google/i }));

    await waitFor(() => expect(screen.getByText('personal@gmail.test')).toBeTruthy());
    expect(mocks.navigate).not.toHaveBeenCalled();
  });
});

describe('the page serves both personas', () => {
  it('names agents and supervisors, and asks neither to self-identify', () => {
    /*
      Which persona somebody is only becomes knowable after sign-in, from the RBAC
      role on their membership. A role picker here would be asking the visitor for
      something we are about to be told authoritatively — and would be wrong
      whenever they guessed.
    */
    renderAt();

    expect(screen.getByText('Agents')).toBeTruthy();
    expect(screen.getByText('Supervisors')).toBeTruthy();
    expect(screen.queryByLabelText(/i am an?/i)).toBeNull();
    expect(screen.queryByRole('radio')).toBeNull();
  });
});

describe('the session-expiry notice', () => {
  it('renders the expiry message, not merely some alert', () => {
    /*
      The commoner entrance for agency staff: the backend's six-hour expiry, hit
      while working a station. `sessionExpiredLoginUrl` picks this door from the
      surface they were on, so the notice has to render on it.

      Asserted on the MESSAGE rather than on `getByRole('alert')` alone: the alert
      slot is shared with credential errors and `AuthContext`'s `error`, so the
      weaker assertion passed if the expiry notice were replaced by any other
      message — including none of them being the reason the user is here.
    */
    renderAt('/agency/login?session=expired');

    expect(screen.getByRole('alert').textContent).toBe(SESSION_EXPIRED_MESSAGE);
  });

  it('shows no alert on an ordinary cold open', () => {
    // Guards the case above against being vacuous.
    renderAt();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('somebody who is already signed in is forwarded, not asked again', () => {
  /**
   * The premise of this page is one URL an agency hands to staff to bookmark.
   * Without this branch that bookmark shows an empty sign-in form on the second
   * morning — and it is also what makes `TeamPage`'s claim that supervisors can
   * bookmark the door and reach their campaigns actually true.
   */
  it('forwards to the default destination', () => {
    authState.user = { uid: 'u1' };
    renderAt();

    expect(mocks.navigate).not.toHaveBeenCalled(); // it is a <Navigate>, not an effect
    expect(screen.queryByLabelText('Password')).toBeNull();
    expect(screen.getByTestId('where').textContent).toBe('/agency');
  });

  it('forwards to a carried ?next= instead', () => {
    authState.user = { uid: 'u1' };
    renderAt('/agency/login?next=%2Fstation%3Fcampaign%3Dcamp-1');

    expect(screen.getByTestId('where').textContent).toBe('/station?campaign=camp-1');
  });

  it('sends an unverified signed-in user to verification, carrying the destination', () => {
    /*
      `RequireAuth` would bounce them to `/verify-email` anyway; going straight
      there saves a hop. The `next` is what stops the trip BACK from landing on
      `/login` — see `VerifyEmailPage`.
    */
    authState.user = { uid: 'u1' };
    authState.pendingEmailVerification = true;
    renderAt('/agency/login?next=%2Fdialer');

    expect(screen.getByTestId('where').textContent).toBe('/verify-email?next=%2Fdialer');
  });

  it('waits rather than forwarding while auth is still resolving', () => {
    // A cold open has `loading: true` with `user` not yet known; forwarding on
    // that would decide on an absence.
    authState.loading = true;
    renderAt();

    expect(screen.queryByLabelText('Password')).toBeNull();
    expect(screen.queryByTestId('where')).toBeNull();
  });

  it('does NOT forward out of the unrecognised-account screen', async () => {
    /*
      That screen renders while SIGNED IN — the stray tenant is real and the user
      is authenticated into it. Forwarding on `user` alone would replace the only
      explanation they get with a capability refusal, so the ordering of the two
      branches in the component is load-bearing and this pins it.
    */
    /*
      The real sequence, and it has to be driven this way round: the form renders
      with no user, then sign-in SUCCEEDS — so `AuthContext` now has a user — and
      only then does the refusal re-render, with both `user` truthy and
      `unrecognised` set. That is the render the ordering has to survive.

      Setting `authState.user` before the form is filled instead would forward on
      the very next keystroke's re-render, which is a different (and correct)
      behaviour, not this one. So the mock writes the user as a side effect, which
      is exactly what the real `signInEmail` does.
    */
    mocks.signInEmail.mockImplementation(async () => {
      authState.user = { uid: 'u1' };
      throw noMembership();
    });
    renderAt();
    signIn('typo@agency.test');

    await waitFor(() => expect(screen.getByText(/don’t recognise that account/i)).toBeTruthy());
    expect(screen.queryByTestId('where')).toBeNull();
  });
});

describe('the unrecognised-account diagnosis survives a remount', () => {
  /**
   * The hole this closes: the diagnosis was component state only, and the
   * signed-in branch forwards whenever `user` is set and that state is null —
   * which is precisely what a reload produces. So a refresh, a back-navigation, or
   * re-opening the bookmarked `/agency/login` skipped the explanation and forwarded
   * the visitor into `/agency` as owner of the stray tenant, where the capability
   * gate meets them with a bare "not part of your plan".
   *
   * Nothing in the session can recover it: master answers the SECOND
   * `POST /auth/session` from path 1 with `is_new: false`, because by then the
   * tenant it provisioned genuinely exists. `is_new` is true exactly once.
   */
  const KEY = 'magick-agency-unrecognised';

  it('records the refusal so a reload can find it', async () => {
    mocks.signInEmail.mockRejectedValue(noMembership());
    renderAt();
    signIn('typo@agency.test');

    await waitFor(() => expect(sessionStorage.getItem(KEY)).toBe('typo@agency.test'));
  });

  it('shows the diagnosis on a cold mount, instead of forwarding a signed-in user', () => {
    /*
      The reload, reconstructed: storage carries the marker, the context has a user
      (master recognised the stray tenant's own firebase_uid), and component state
      is empty. Before the seed this rendered nothing and forwarded to `/agency`.
    */
    sessionStorage.setItem(KEY, 'typo@agency.test');
    authState.user = { uid: 'u1' };
    renderAt();

    expect(screen.getByText(/don’t recognise that account/i)).toBeTruthy();
    expect(screen.getByText('typo@agency.test')).toBeTruthy();
    expect(screen.queryByTestId('where')).toBeNull();
  });

  it('survives a mount with no address recorded', () => {
    // Google can refuse without an address to name; the marker is still the point.
    sessionStorage.setItem(KEY, '');
    authState.user = { uid: 'u1' };
    renderAt();

    expect(screen.getByText(/don’t recognise that account/i)).toBeTruthy();
    expect(screen.queryByTestId('where')).toBeNull();
  });

  it('forgets it on sign-out, so the next attempt starts clean', async () => {
    mocks.signInEmail.mockRejectedValue(noMembership());
    renderAt();
    signIn('typo@agency.test');
    await waitFor(() => expect(sessionStorage.getItem(KEY)).not.toBeNull());

    fireEvent.click(screen.getByRole('button', { name: 'Try a different account' }));

    await waitFor(() => expect(sessionStorage.getItem(KEY)).toBeNull());
  });

  it('lets the whole recovery run: diagnosis → sign out → correct address → in', async () => {
    /*
      The end-to-end journey this feature exists for, driven from a RELOAD rather
      than from a fresh sign-in — which is the state the seed made reachable at
      all. Before it, step one did not happen: the page forwarded instead.
    */
    sessionStorage.setItem(KEY, 'typo@agency.test');
    authState.user = { uid: 'u1' };
    renderAt();

    // 1. The reload lands on the diagnosis, not in the stray tenant.
    expect(screen.getByText(/don’t recognise that account/i)).toBeTruthy();

    // 2. Signing out clears both the marker and the session.
    mocks.logout.mockImplementation(async () => { authState.user = null; });
    fireEvent.click(screen.getByRole('button', { name: 'Try a different account' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Sign in' })).toBeTruthy());
    expect(sessionStorage.getItem(KEY)).toBeNull();

    // 3. The correct address gets in, and leaves nothing behind.
    signIn('agent@agency.test');
    await waitFor(() => expect(mocks.navigate).toHaveBeenCalledWith('/agency'));
    expect(sessionStorage.getItem(KEY)).toBeNull();
  });

  it('writes no marker on an ordinary successful sign-in', () => {
    // Guards the clear-on-success path against becoming the thing that SETS it.
    renderAt();
    signIn();

    return waitFor(() => {
      expect(mocks.navigate).toHaveBeenCalledWith('/agency');
      expect(sessionStorage.getItem(KEY)).toBeNull();
    });
  });

  it('degrades to today’s behaviour when storage is unavailable', async () => {
    /*
      `sessionStorage` throws rather than returning null in some privacy modes. A
      storage failure must cost the reload-survival, not the sign-in: the diagnosis
      still renders once, from component state.
    */
    const setItem = vi
      .spyOn(Storage.prototype, 'setItem')
      .mockImplementation(() => { throw new Error('storage disabled'); });
    try {
      mocks.signInEmail.mockRejectedValue(noMembership());
      renderAt();
      signIn('typo@agency.test');

      await waitFor(() => expect(screen.getByText(/don’t recognise that account/i)).toBeTruthy());
    } finally {
      setItem.mockRestore();
    }
  });
});

describe('the unrecognised-account screen cannot become a dead end', () => {
  const showUnrecognised = async () => {
    mocks.signInEmail.mockRejectedValue(noMembership());
    renderAt();
    signIn('typo@agency.test');
    await waitFor(() => expect(screen.getByText(/don’t recognise that account/i)).toBeTruthy());
  };

  it('reports a failed sign-out instead of silently doing nothing', async () => {
    /*
      `logout()` calls Firebase `signOut()`, which rejects on a network blip. With
      the await unguarded the state reset never ran, so the screen's only control
      did nothing and nothing said why — while the user sat signed into a tenant
      that is not theirs.
    */
    mocks.logout.mockRejectedValue(new Error('network request failed'));
    await showUnrecognised();

    fireEvent.click(screen.getByRole('button', { name: 'Try a different account' }));

    await waitFor(() => expect(screen.getByText(/network request failed/i)).toBeTruthy());
    // Still on the diagnosis, not blanked.
    expect(screen.getByText(/don’t recognise that account/i)).toBeTruthy();
  });

  it('reports the refusal to analytics as a failure, not a success', async () => {
    /*
      Credentials were accepted, so `trackAuthSucceeded` fires too — Firebase and
      master both did their jobs. But the funnel would otherwise count an agent who
      never reached the dialer as a completed sign-in, and this branch is the one
      the `door` dimension was added to make visible.
    */
    await showUnrecognised();

    expect(mocks.trackAuthFailed).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'unrecognised_account', door: 'agency' }),
    );
  });
});

describe('the forgot-password branch', () => {
  /**
   * Untested when this page shipped, and it is the branch an agent reaches on the
   * morning they cannot get in — i.e. the one where a dead control costs a shift.
   */
  it('prefills the address already typed, so it is not asked for twice', () => {
    renderAt();
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'agent@agency.test' } });
    fireEvent.click(screen.getByRole('button', { name: 'Forgot password?' }));

    expect((screen.getByLabelText('Email') as HTMLInputElement).value).toBe('agent@agency.test');
  });

  it('sends the reset and confirms which address it went to', async () => {
    mocks.resetPassword.mockResolvedValue(undefined);
    renderAt();
    fireEvent.click(screen.getByRole('button', { name: 'Forgot password?' }));
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'agent@agency.test' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send reset link' }));

    await waitFor(() => expect(mocks.resetPassword).toHaveBeenCalledWith('agent@agency.test'));
    // The address is the whole content of the confirmation: sign-in is matched on
    // it, so a reset sent to the wrong one is the commonest way this goes wrong.
    await waitFor(() => expect(screen.getByText('agent@agency.test')).toBeTruthy());
  });

  it('translates an unknown address into something actionable', async () => {
    mocks.resetPassword.mockRejectedValue(new Error('auth/user-not-found'));
    renderAt();
    fireEvent.click(screen.getByRole('button', { name: 'Forgot password?' }));
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'nope@agency.test' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send reset link' }));

    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toMatch(/no account found/i),
    );
  });

  it('refuses an empty address without calling the backend', async () => {
    renderAt();
    fireEvent.click(screen.getByRole('button', { name: 'Forgot password?' }));
    // `required` is bypassed by a direct submit, which is what a keyboard user does.
    fireEvent.submit(screen.getByLabelText('Email').closest('form')!);

    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect(mocks.resetPassword).not.toHaveBeenCalled();
    expect(mocks.trackAuthFailed).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'password_reset', reason: 'validation_error', door: 'agency' }),
    );
  });

  it('returns to the sign-in form', async () => {
    renderAt();
    fireEvent.click(screen.getByRole('button', { name: 'Forgot password?' }));
    fireEvent.click(screen.getByRole('button', { name: 'Back to sign in' }));

    expect(screen.getByRole('button', { name: 'Sign in' })).toBeTruthy();
  });
});

describe('analytics can tell the two doors apart', () => {
  it('tags attempts made here as the agency door', async () => {
    // Without the dimension the two front doors are indistinguishable in the
    // funnel: same events, same provider, same outcomes — and "is the agency door
    // being reached at all" cannot be reconstructed after the fact.
    renderAt();
    signIn();

    await waitFor(() =>
      expect(mocks.trackAuthAttempted).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'login', door: 'agency' }),
      ),
    );
    expect(mocks.trackAuthSucceeded).toHaveBeenCalledWith(
      expect.objectContaining({ door: 'agency' }),
    );
  });

  it('tags failures too, which is the half that matters for a funnel', async () => {
    mocks.signInEmail.mockRejectedValue(new Error('auth/wrong-password'));
    renderAt();
    signIn();

    await waitFor(() =>
      expect(mocks.trackAuthFailed).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'login', provider: 'email', door: 'agency' }),
      ),
    );
  });

  it('tags the verification wall, where agency onboarding actually stalls', async () => {
    // An invited agent told to check an inbox often simply does not come back.
    // Door-blind, this drop-off is invisible in the one dimension that separates
    // the two sign-in pages.
    mocks.signInEmail.mockResolvedValue(null);
    renderAt();
    signIn();

    await waitFor(() =>
      expect(mocks.trackEmailVerificationRequired).toHaveBeenCalledWith({
        source: 'login',
        door: 'agency',
      }),
    );
  });
});

describe('the refusal also arrives without a button press (magick-agency)', () => {
  it('renders the diagnosis from the listener’s refusal on a reload, naming the Firebase address', () => {
    // A restored credential is synced by `AuthContext`'s listener; agency's 403
    // lands on `sessionRefusal`, with no user and no `unrecognised` state yet.
    Object.assign(authState, {
      sessionRefusal: 'no_membership',
      firebaseUser: { email: 'stale@agency.test' },
    });
    renderAt();

    expect(screen.getByText(/don’t recognise that account/i)).toBeTruthy();
    expect(screen.getByText('stale@agency.test')).toBeTruthy();
    expect(screen.queryByTestId('where')).toBeNull();
  });

  it('a 403 that is NOT `no_membership` is an error on the form, not the diagnosis', async () => {
    mocks.signInEmail.mockRejectedValue(
      new ApiError(403, { error: 'Forbidden', code: 'email_unverified', message: 'Verify your email first.' }),
    );
    renderAt();
    signIn('agent@agency.test');

    await waitFor(() => expect(mocks.trackAuthFailed).toHaveBeenCalled());
    expect(screen.queryByText(/don’t recognise that account/i)).toBeNull();
    expect(mocks.trackAuthFailed).not.toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'unrecognised_account' }),
    );
  });
});
