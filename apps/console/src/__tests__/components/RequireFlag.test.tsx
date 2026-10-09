import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

/**
 * RequireFlag route guard — spinner while the flag map loads, in-place
 * CapabilityUnavailable when the flag has resolved off (fail-safe CLOSED on
 * error), children when on. Mirrors GovernanceGating's RequireCapability tests.
 */
const mocks = vi.hoisted(() => ({
  useFeatureFlags: vi.fn(),
  useTenant: vi.fn(),
  trackFeatureGateUnavailable: vi.fn(),
  reloadAccounts: vi.fn(),
}));

vi.mock('../../contexts/FeatureFlagsContext', () => ({ useFeatureFlags: mocks.useFeatureFlags }));
vi.mock('../../contexts/TenantContext', () => ({ useTenant: mocks.useTenant }));
vi.mock('../../analytics/events', () => ({
  trackFeatureGateUnavailable: mocks.trackFeatureGateUnavailable,
}));

import RequireFlag from '../../components/auth/RequireFlag';

function ff(isEnabled: (k: string) => boolean, status: 'loading' | 'ready' | 'error') {
  return { isEnabled, status, flags: {}, reload: vi.fn() };
}

/**
 * The guard now reads account resolution too, because "we could not work out
 * which account you are in" and "this flag is off" are different answers that
 * used to render as the same permanent spinner.
 */
function tenant(
  accountResolution: 'loading' | 'ready' | 'degraded' | 'error',
  accountError: string | null = null,
  accountId: string | null = 'acct-1',
) {
  return { accountId, accountResolution, accountError, reloadAccounts: mocks.reloadAccounts };
}

// The default flag is `agency_call_analysis` (the `/app/call-summaries` gate).
function renderGuard(flag = 'agency_call_analysis') {
  return render(
    <MemoryRouter initialEntries={['/app/sip/connections']}>
      <RequireFlag flag={flag}><div>SIP PAGE</div></RequireFlag>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  // The ordinary case: the account resolved. Each test that cares overrides it.
  mocks.useTenant.mockReturnValue(tenant('ready'));
});

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('RequireFlag', () => {
  it('renders children when the flag is enabled', () => {
    mocks.useFeatureFlags.mockReturnValue(ff(() => true, 'ready'));
    renderGuard();
    expect(screen.getByText('SIP PAGE')).toBeTruthy();
    expect(screen.queryByText(/Not available/i)).toBeNull();
  });

  it('renders CapabilityUnavailable IN PLACE when the flag has resolved off', () => {
    mocks.useFeatureFlags.mockReturnValue(ff(() => false, 'ready'));
    renderGuard();
    expect(screen.getByText(/Not available for your account/i)).toBeTruthy();
    expect(screen.queryByText('SIP PAGE')).toBeNull();
    expect(mocks.trackFeatureGateUnavailable).toHaveBeenCalledWith({
      gate_type: 'feature_flag',
      gate: 'agency_call_analysis',
    });
  });

  it('shows a spinner while loading — never the unavailable screen (no flash-then-flip)', () => {
    mocks.useFeatureFlags.mockReturnValue(ff(() => false, 'loading'));
    renderGuard();
    expect(screen.getByRole('status')).toBeTruthy();
    expect(screen.queryByText(/Not available/i)).toBeNull();
    expect(screen.queryByText('SIP PAGE')).toBeNull();
  });

  it('fails CLOSED on error (flag map failed to load ⇒ hide the screen)', () => {
    mocks.useFeatureFlags.mockReturnValue(ff(() => false, 'error'));
    renderGuard();
    expect(screen.getByText(/Not available for your account/i)).toBeTruthy();
    expect(screen.queryByText('SIP PAGE')).toBeNull();
  });

  it('does not emit a feature-gate event for unrelated flags', () => {
    mocks.useFeatureFlags.mockReturnValue(ff(() => false, 'ready'));
    renderGuard('beta_flag');
    expect(mocks.trackFeatureGateUnavailable).not.toHaveBeenCalled();
  });

  describe('an account that could not be resolved', () => {
    /**
     * The defect this replaces, end to end: an `agent` sits at role level 5, below
     * `account.read`'s `viewer` floor, so `GET /accounts` 403s. `TenantContext`
     * swallowed it and never set an active account; `FeatureFlagsContext` never
     * fires a request without one, so it held `status: 'loading'` for the life of
     * the session; this guard renders a spinner for `'loading'`. An agent signing
     * in to take calls got a spinner with no error, no message and nothing to do.
     *
     * The route fix (`GET /accounts/mine`) removes one cause. These assert the
     * other half — that any *remaining* cause is terminal and says something.
     */
    it('renders an actionable message instead of a permanent spinner', () => {
      // The flag map is `'loading'` and always will be: there is no account for it
      // to load against. This is precisely the state that used to spin forever.
      mocks.useFeatureFlags.mockReturnValue(ff(() => false, 'loading'));
      mocks.useTenant.mockReturnValue(tenant('error', 'Forbidden'));
      renderGuard();

      expect(screen.getByText(/couldn’t open your account/i)).toBeTruthy();
      // The thing it must NOT be: the spinner it replaced.
      expect(screen.queryByRole('status')).toBeNull();
      expect(screen.queryByText('SIP PAGE')).toBeNull();
    });

    it('does NOT reuse the plan-gate copy — a failed request is not a billing problem', () => {
      // `CapabilityUnavailable` says "This feature isn't part of your current
      // plan", which is confident, calm and wrong here: nothing is turned off. It
      // sends the user to argue about billing over a permissions problem.
      mocks.useFeatureFlags.mockReturnValue(ff(() => false, 'error'));
      mocks.useTenant.mockReturnValue(tenant('error', 'Forbidden'));
      renderGuard();

      expect(screen.queryByText(/Not available for your account/i)).toBeNull();
      expect(screen.getByText(/couldn’t open your account/i)).toBeTruthy();
    });

    it('offers a retry that actually re-resolves', () => {
      mocks.useFeatureFlags.mockReturnValue(ff(() => false, 'loading'));
      mocks.useTenant.mockReturnValue(tenant('error', 'Forbidden'));
      renderGuard();

      fireEvent.click(screen.getByRole('button', { name: /try again/i }));
      expect(mocks.reloadAccounts).toHaveBeenCalledTimes(1);
    });

    it('shows the same message when resolution settled without producing an account', () => {
      /**
       * A tenant with genuinely zero accounts, or a degraded fallback whose narrowed
       * list came back empty. Resolution is not `'error'` — nothing *failed* — but
       * `accountsLoadedForTenant` is set, so nothing will ever produce an `accountId`
       * either. These used to spin forever; now that `FeatureFlagsContext` correctly
       * reports `'error'` for them, without the second clause here they would land on
       * the plan-gate copy instead, which is the same wrong explanation one layer
       * along.
       */
      mocks.useFeatureFlags.mockReturnValue(ff(() => false, 'error'));
      mocks.useTenant.mockReturnValue(tenant('ready', null, null));
      renderGuard();

      expect(screen.getByText(/couldn’t open your account/i)).toBeTruthy();
      expect(screen.queryByText(/Not available for your account/i)).toBeNull();
    });

    it('lets a DEGRADED resolution through when it did produce an account', () => {
      /**
       * The line between "incomplete" and "unusable". A degraded resolution means
       * `GET /accounts` failed for a non-permission reason and we are showing the
       * caller's own memberships — the list may be short, but the user has an account
       * and can work. The caveat belongs on the account switcher, not across the whole
       * page: blocking every screen over a possibly-missing row would be a worse
       * outcome than the narrowing it reports.
       */
      mocks.useFeatureFlags.mockReturnValue(ff(() => true, 'ready'));
      mocks.useTenant.mockReturnValue(tenant('degraded', 'Bad Gateway'));
      renderGuard();

      expect(screen.getByText('SIP PAGE')).toBeTruthy();
      expect(screen.queryByText(/couldn’t open your account/i)).toBeNull();
    });

    it('says nothing while resolution is still in flight', () => {
      // A message with a Retry button shown before the first request has answered
      // would be an error about something that has not failed.
      mocks.useFeatureFlags.mockReturnValue(ff(() => false, 'loading'));
      // No account YET, which is the whole point: `'loading'` plus a null account is
      // the ordinary first render of every sign-in and must stay a spinner.
      mocks.useTenant.mockReturnValue(tenant('loading', null, null));
      renderGuard();

      expect(screen.getByRole('status')).toBeTruthy();
      expect(screen.queryByText(/couldn’t open your account/i)).toBeNull();
    });
  });
});
