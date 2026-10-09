import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';

/**
 * `AgentLanding` — the guard that keeps a DEDICATED agent out of `AppLayout`.
 *
 * ── What this file no longer tests, and where it went ──────────────────────
 * This component used to resolve `GET /my-assignment` and build the station
 * redirect itself. That moved to `AgentHomePage` when an agent became able to hold
 * several assignments; `AgentHomePage.test.tsx` carries those cases forward.
 *
 * ── The regression this file now exists to prevent ────────────────────────
 * A revision of this component gated on `agencyPersona(role) === 'agent'`. The four
 * agent permissions floor at level 5, so that predicate is ALSO true for `viewer`
 * (10) and `operator` (20) — and it redirected them out of `/app` into `/dialer`,
 * whose `agency` capability defaults to `false`. In every tenant without the
 * dialer, those two roles got a full-viewport "not available for your account"
 * with no sidebar, no link out, and no sign-out (logout lives in `TopBar`, inside
 * `AppLayout`). Every route back re-entered this component.
 *
 * Two properties therefore have teeth here, and both are asserted per role:
 *
 *  1. only a role with NOTHING but the agent permissions may be redirected;
 *  2. nobody is redirected into a dialer that is turned off.
 *
 * Every assertion is about a resolved LOCATION or a rendered screen, never about a
 * hook having been called — a user who ends up on the wrong side of this has been
 * failed whether or not the logic ran.
 */

const mocks = vi.hoisted(() => ({
  useTenant: vi.fn(),
  useGovernance: vi.fn(),
  useFeatureFlags: vi.fn(),
}));

vi.mock('../../contexts/TenantContext', () => ({ useTenant: mocks.useTenant }));
vi.mock('../../contexts/GovernanceContext', () => ({ useGovernance: mocks.useGovernance }));
vi.mock('../../contexts/FeatureFlagsContext', () => ({ useFeatureFlags: mocks.useFeatureFlags }));

import { AgentLanding } from '../../components/agency/AgentLanding';

/** Stands in for `AppLayout` — the shell that IS the product for most roles. */
function Shell() {
  return <div data-testid="app-shell">the whole platform UI</div>;
}

function Where() {
  const location = useLocation();
  return <div data-testid="where">{`${location.pathname}${location.search}`}</div>;
}

function renderAt(entry = '/app') {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route
          path="/app"
          element={
            <AgentLanding>
              <Shell />
            </AgentLanding>
          }
        />
        <Route path="*" element={<Where />} />
      </Routes>
    </MemoryRouter>,
  );
}

/** The dialer switched fully ON — capability granted and flag enabled. */
function dialerOn() {
  mocks.useGovernance.mockReturnValue({ isEnabled: () => true, loading: false });
  mocks.useFeatureFlags.mockReturnValue({ isEnabled: () => true, status: 'ready' });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.useTenant.mockReturnValue({ role: 'agent' });
  dialerOn();
});

afterEach(() => cleanup());

describe('AgentLanding — who may be redirected', () => {
  it('sends a dedicated agent to /dialer instead of an empty shell', async () => {
    renderAt();

    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('/dialer'));
    expect(screen.queryByTestId('app-shell')).toBeNull();
  });

  /**
   * ── The lockout, per role ────────────────────────────────────────────────
   * `viewer` had NO test at all in the revision that broke it, which is how a
   * total-product regression for a standard role shipped fully green.
   */
  it.each(['viewer', 'operator'] as const)(
    'renders the shell for %s — they hold the agent permissions but own a platform',
    (role) => {
      mocks.useTenant.mockReturnValue({ role });

      renderAt();

      expect(screen.getByTestId('app-shell')).toBeTruthy();
      expect(screen.queryByTestId('where')).toBeNull();
    },
  );

  it.each(['account_admin', 'tenant_admin', 'tenant_owner'] as const)(
    'renders the shell for %s — a supervisor keeps the whole platform',
    (role) => {
      // A supervisor inherits the agent permissions too, so a predicate that
      // tested only for those would redirect them out of the product.
      mocks.useTenant.mockReturnValue({ role });

      renderAt();

      expect(screen.getByTestId('app-shell')).toBeTruthy();
    },
  );

  it('renders the shell while the role is still unresolved', () => {
    /**
     * `role` is `undefined` for the moment `TenantContext` takes to resolve a
     * membership. Deliberately not gated on: holding every user's first paint to
     * spare an agent a flash of an empty sidebar is the worse trade.
     */
    mocks.useTenant.mockReturnValue({ role: undefined });

    renderAt();

    expect(screen.getByTestId('app-shell')).toBeTruthy();
  });
});

describe('AgentLanding — nobody is sent into a dialer that is off', () => {
  /**
   * The second half of the regression. Even for a dedicated agent, redirecting
   * into a gate that will refuse produces a dead end — and `AppLayout`, empty
   * sidebar and all, is strictly better: it has a top bar, so it has a sign-out.
   */
  it('renders the shell when the agency capability is off', () => {
    mocks.useGovernance.mockReturnValue({ isEnabled: () => false, loading: false });

    renderAt();

    expect(screen.getByTestId('app-shell')).toBeTruthy();
    expect(screen.queryByTestId('where')).toBeNull();
  });

  it('renders the shell when the agency_dialer_enabled flag is off', () => {
    mocks.useFeatureFlags.mockReturnValue({ isEnabled: () => false, status: 'ready' });

    renderAt();

    expect(screen.getByTestId('app-shell')).toBeTruthy();
  });

  it('checks the specific capability and flag, not merely "something is enabled"', async () => {
    // A gate that passed on any truthy map would redirect a tenant that has, say,
    // `messaging` but not `agency`.
    mocks.useGovernance.mockReturnValue({
      isEnabled: (c: string) => c !== 'agency',
      loading: false,
    });

    renderAt();
    expect(screen.getByTestId('app-shell')).toBeTruthy();
    cleanup();

    mocks.useGovernance.mockReturnValue({ isEnabled: () => true, loading: false });
    mocks.useFeatureFlags.mockReturnValue({
      isEnabled: (f: string) => f !== 'agency_dialer_enabled',
      status: 'ready',
    });

    renderAt();
    expect(screen.getByTestId('app-shell')).toBeTruthy();
  });

  it.each([
    ['governance', () => mocks.useGovernance.mockReturnValue({ isEnabled: () => true, loading: true })],
    ['flags', () => mocks.useFeatureFlags.mockReturnValue({ isEnabled: () => true, status: 'loading' })],
  ])('waits rather than guessing while %s is still resolving', (_label, arrange) => {
    // Guessing "enabled" flashes the dialer and bounces back on a refusal. Both
    // gates resolve in one request, so a brief shell is the cheaper wrong answer.
    arrange();

    renderAt();

    expect(screen.getByTestId('app-shell')).toBeTruthy();
    expect(screen.queryByTestId('where')).toBeNull();
  });
});

describe('AgentLanding — the arrival param', () => {
  it('forwards ?left=station so the agent is not bounced back in', async () => {
    // Leave station navigates here with `?left=station`. `AgentHomePage` is where
    // that is honoured now, so dropping the param would send an agent who just
    // pressed Leave straight back into the station they left.
    renderAt('/app?left=station');

    await waitFor(() =>
      expect(screen.getByTestId('where').textContent).toBe('/dialer?left=station'),
    );
  });

  it('forwards ?left=refused, which is different news from a deliberate leave', async () => {
    renderAt('/app?left=refused');

    await waitFor(() =>
      expect(screen.getByTestId('where').textContent).toBe('/dialer?left=refused'),
    );
  });

  it('drops an unrecognised arrival value rather than passing junk along', async () => {
    // Validated here so a hand-edited or stale URL cannot travel any further than
    // this component.
    renderAt('/app?left=banana');

    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('/dialer'));
  });
});
