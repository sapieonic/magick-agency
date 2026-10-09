import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

/**
 * `/verify-email` carries the destination, and why it has to.
 *
 * ── The two ways this page stranded agency staff ───────────────────────────
 * It navigated to `/` unconditionally, which was right while there was one
 * sign-in page and one shell. With the Agency Dialer's own door it broke twice:
 *
 *  1. **After verifying.** `/` is `HomeRedirect`, whose predicate for agency-only
 *     tenants is strict enough that its own docstring says it "fires rarely". So a
 *     SUPERVISOR who signed in at `/agency/login` and passed through here landed
 *     on `/app` — the shell they had declined by choosing the agency door. (An
 *     agent was rescued by `AgentLanding`; a supervisor is not a dedicated agent.)
 *  2. **After signing out.** `logout()` clears `pendingEmailVerification`, which
 *     fires the guard, which went to `/` — `RequireAuth` with no user, i.e.
 *     `/login?next=%2F`: the primary app's page with its Sign Up tab, handed to
 *     exactly the person the agency door exists to keep off it. That one matters
 *     most, because signing up there is what puts an invited agent in a stray
 *     tenant while their real membership goes unclaimed.
 *
 * Both are fixed by one value, since `loginPathReturningTo` picks the door from
 * the destination. `/` stays the default, so the primary door is unchanged.
 */

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  resendVerificationEmail: vi.fn(),
  completeEmailVerification: vi.fn(),
  logout: vi.fn(),
}));

vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  return { ...actual, useNavigate: () => mocks.navigate };
});

const authState = { pendingEmailVerification: true };

vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({
    firebaseUser: { email: 'agent@agency.test' },
    resendVerificationEmail: mocks.resendVerificationEmail,
    completeEmailVerification: mocks.completeEmailVerification,
    logout: mocks.logout,
    ...authState,
  }),
}));

import VerifyEmailPage from '../../pages/auth/VerifyEmailPage';

function renderAt(entry = '/verify-email') {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <VerifyEmailPage />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  authState.pendingEmailVerification = true;
  mocks.completeEmailVerification.mockResolvedValue({ is_new: false });
});

afterEach(() => cleanup());

describe('where verification sends somebody afterwards', () => {
  it('honours a carried destination', async () => {
    renderAt('/verify-email?next=%2Fagency');
    fireEvent.click(screen.getByRole('button', { name: /verified my email/i }));

    await waitFor(() =>
      expect(mocks.navigate).toHaveBeenCalledWith('/agency', { replace: true }),
    );
  });

  it('still defaults to / for the primary door, which carries nothing', async () => {
    // `/` is `HomeRedirect` — the entitlement decision. Unchanged behaviour.
    renderAt();
    fireEvent.click(screen.getByRole('button', { name: /verified my email/i }));

    await waitFor(() => expect(mocks.navigate).toHaveBeenCalledWith('/', { replace: true }));
  });

  it('sends a new session to the carried destination too — there is no onboarding', async () => {
    // Agency has no `/onboarding` and no sign-up (path 4
    // of `/auth/session` refuses with `no_membership`), so even an
    // `is_new: true` payload goes to `returnTo`.
    mocks.completeEmailVerification.mockResolvedValue({ is_new: true });
    renderAt('/verify-email?next=%2Fstation');
    fireEvent.click(screen.getByRole('button', { name: /verified my email/i }));

    await waitFor(() =>
      expect(mocks.navigate).toHaveBeenCalledWith('/station', { replace: true }),
    );
    expect(mocks.navigate).not.toHaveBeenCalledWith('/onboarding', expect.anything());
  });

  it('validates the carried value like any other ?next=', () => {
    // It is in the URL, so anyone can put anything in it. `safeReturnPath` rejects
    // off-site targets and this falls back to the default.
    authState.pendingEmailVerification = false;
    renderAt('/verify-email?next=%2F..%2F%2Fevil.example');

    expect(mocks.navigate).toHaveBeenCalledWith('/', { replace: true });
  });
});

describe('the sign-out exit', () => {
  it('lands on the carried destination, so the door is chosen from it', () => {
    /*
      Sign-out is not its own navigation: `logout()` clears
      `pendingEmailVerification`, which fires the guard at the top of the
      component. This asserts that guard's destination, which is what decides
      whether the agent is handed back to `/agency/login` or to `/login`.
    */
    authState.pendingEmailVerification = false;
    renderAt('/verify-email?next=%2Fstation%3Fcampaign%3Dcamp-1');

    expect(mocks.navigate).toHaveBeenCalledWith('/station?campaign=camp-1', { replace: true });
  });

  it('falls back to / when nothing was carried', () => {
    authState.pendingEmailVerification = false;
    renderAt();

    expect(mocks.navigate).toHaveBeenCalledWith('/', { replace: true });
  });
});
