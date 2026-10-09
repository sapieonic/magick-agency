import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';

/**
 * A deep link must survive the sign-in it triggers.
 *
 * ── The defect ─────────────────────────────────────────────────────────────
 * `RequireAuth` redirected an unauthenticated visitor to `/login` and threw the
 * requested URL away; `LoginPage` then navigated unconditionally to `/app`. So
 * every deep link into the product worked only for someone already signed in —
 * which is precisely the case a shareable entry point like `/dialer` cannot
 * afford, because the morning it matters is the agent's first sign-in of the day.
 *
 * ── And it must arrive at the RIGHT sign-in page ───────────────────────────
 * Since the Agency Dialer got a door of its own, carrying the path is only half
 * the job: an agent bounced off `/station` has to come back through
 * `/agency/login`, not through the primary app's page with its Sign Up tab and
 * its free-credits banner. `RequireAuth` does not choose that itself — it hands
 * the requested path to `loginPathReturningTo`, which picks the door from the
 * destination — so what these cases pin is that the destination survives the
 * handoff intact and reaches the door the surface belongs to.
 */

const mocks = vi.hoisted(() => ({ useAuth: vi.fn() }));

vi.mock('../../contexts/AuthContext', () => ({ useAuth: mocks.useAuth }));

import RequireAuth from '../../components/auth/RequireAuth';

function Where() {
  const location = useLocation();
  return <div data-testid="where">{`${location.pathname}${location.search}`}</div>;
}

function renderAt(entry: string) {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route
          path="/dialer"
          element={
            <RequireAuth>
              <div data-testid="protected">the dialer</div>
            </RequireAuth>
          }
        />
        {/* Guarded too, so a `/station?campaign=…` entry actually reaches
            `RequireAuth` instead of falling through to the catch-all below. */}
        <Route
          path="/station"
          element={
            <RequireAuth>
              <div data-testid="protected">the console</div>
            </RequireAuth>
          }
        />
        {/* A platform surface, so the other branch of the door rule is
            exercised by a route rather than only by the util's own suite. */}
        <Route
          path="/app/settings"
          element={
            <RequireAuth>
              <div data-testid="protected">settings</div>
            </RequireAuth>
          }
        />
        <Route path="*" element={<Where />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.useAuth.mockReturnValue({ user: null, loading: false, pendingEmailVerification: false });
});

afterEach(() => cleanup());

describe('RequireAuth — the return path', () => {
  it('carries the requested path into the agency door as ?next=', async () => {
    // `/dialer` is an agency surface, so the door is `/agency/login`: the page an
    // agent is meant to see, with no signup on it to fall into.
    renderAt('/dialer');

    await waitFor(() =>
      expect(screen.getByTestId('where').textContent).toBe('/agency/login?next=%2Fdialer'),
    );
    expect(screen.queryByTestId('protected')).toBeNull();
  });

  it('sends a platform surface to the primary door instead', async () => {
    // The other branch, asserted here rather than left to the util's suite: this
    // is the pairing that would break silently if the door predicate ever grew to
    // swallow everything.
    renderAt('/app/settings');

    await waitFor(() =>
      expect(screen.getByTestId('where').textContent).toBe('/login?next=%2Fapp%2Fsettings'),
    );
    expect(screen.queryByTestId('protected')).toBeNull();
  });

  it('carries the query string too, which for /station IS the destination', async () => {
    // `/station` without `?campaign=` lands on the console's "No campaign
    // selected." refusal, so a return path that drops the query is a different
    // destination rather than a slightly lossy one.
    renderAt('/station?campaign=camp-1');

    await waitFor(() =>
      expect(screen.getByTestId('where').textContent).toBe(
        '/agency/login?next=%2Fstation%3Fcampaign%3Dcamp-1',
      ),
    );
  });

  it('renders the protected content for a signed-in user, untouched', () => {
    mocks.useAuth.mockReturnValue({
      user: { uid: 'u1' },
      loading: false,
      pendingEmailVerification: false,
    });

    renderAt('/dialer');

    expect(screen.getByTestId('protected')).toBeTruthy();
  });

  it('sends an unverified user to /verify-email WITHOUT a return path', async () => {
    /**
     * Deliberately no `?next=`: this branch is a signed-in user with an unverified
     * address, so there is nothing to come back to yet — verification restarts the
     * flow. Carrying one here would be a destination nobody can act on.
     */
    mocks.useAuth.mockReturnValue({
      user: { uid: 'u1' },
      loading: false,
      pendingEmailVerification: true,
    });

    renderAt('/dialer');

    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('/verify-email'));
  });

  it('shows a spinner while auth is still resolving, and redirects nowhere', () => {
    // Redirecting during `loading` would bounce every signed-in user to /login on
    // every cold load.
    mocks.useAuth.mockReturnValue({ user: null, loading: true, pendingEmailVerification: false });

    renderAt('/dialer');

    expect(screen.queryByTestId('where')).toBeNull();
    expect(screen.queryByTestId('protected')).toBeNull();
  });
});
