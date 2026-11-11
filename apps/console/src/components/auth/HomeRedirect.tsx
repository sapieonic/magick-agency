import { Navigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { useFeatureFlags } from '../../contexts/FeatureFlagsContext';
import { useGovernance } from '../../contexts/GovernanceContext';
import { LoadingSpinner } from '@magick-agency/web-ui/components/LoadingSpinner';

/**
 * Where the app root goes: `/agency` when the agency dialer is switched on for
 * the account (`agency_dialer_enabled`), otherwise `/app`, whose index
 * (`AppHomeRedirect`) tells a dedicated agent the dialer is off and sends anyone
 * else to Settings. Both are inside the one console shell (decision B28).
 *
 * ── Fail safe, and which way "safe" points ─────────────────────────────────
 * A wrong redirect strands a paying customer outside the workspace they opened; a
 * missing one leaves them on `/app`, which still has the shell and its navigation. So only positive
 * knowledge redirects. `/agency` is gated on `agency_dialer_enabled`, so
 * redirecting without it would land the reader on a plan-gate refusal with no
 * shell around it. `useFeatureFlags` fails closed, which makes that free.
 *
 * ── The wait needed a bound of its own ────────────────────────────────────
 * Governance and the flags are waited for, because deciding on an empty map is
 * deciding `/app` every time. **But `status === 'loading'` is not bounded.** With
 * no tenant at all, `TenantContext`'s auto-select effect returns early on an empty
 * `tenants` list, so `activeTenantId` stays `null`; the account effect then parks
 * `accountResolution` at `'loading'`, and `FeatureFlagsContext` maps that to
 * `status === 'loading'` for the life of the session. A signed-in user with no
 * tenant (their only membership revoked; provisioned but never assigned) would
 * meet a bare full-viewport spinner with no top bar and so no way to sign out.
 *
 * Hence the bound: **no tenant means nothing to decide about**, so this lands on
 * `/settings` (Profile, which needs no tenant), inside the console shell, whose
 * top bar has a sign-out in it. Not `/app`: its index waits on the same flags.
 * `tenants` comes from `useAuth` rather than from `TenantContext` because
 * `tenantId === null` is equally the state of a cold entry, for the one render
 * before the auto-select effect fires. `RequireAuth` renders this component only
 * after auth settles with a user, and `tenants` is written in the same state
 * update as that user, so an empty list here is final rather than early.
 *
 * The bound is deliberately LOCAL. Reporting `'error'` from the context when there
 * is no tenant is the general answer, and was rejected: `status` has many
 * consumers, and flipping a permanent `'loading'` into `'error'` turns spinners
 * into error UI across the app. This component is the only consumer that can
 * strand somebody with no way out, so the bound belongs here.
 *
 * A spinner is honest for the remaining, genuinely in-flight case: this route
 * renders no content of its own either way, so waiting costs nothing and avoids
 * a flash of the wrong shell.
 *
 * ── This is a ROUTING decision, not an enforcement one ─────────────────────
 * Nothing here gates access. `RequireCapability` still fails open on purpose and
 * must keep doing so; the API's 403 is the real enforcement.
 *
 * ── Why the root and not `/app`'s index route ──────────────────────────────
 * `/app` is where the workspace invite and the catch-all land, and its index
 * keeps the dedicated agent's dialer-off notice. Deciding here, once, on arrival,
 * keeps the two from contradicting each other.
 */

export function HomeRedirect() {
  const { tenants } = useAuth();
  const { loading } = useGovernance();
  const { isEnabled, status } = useFeatureFlags();

  /**
   * No tenant, so no entitlement question — and, crucially, nothing that will
   * ever finish resolving. See the bound in the docstring: without this, a
   * signed-in user with no tenant membership waits on a `status` that stays
   * `'loading'` for the whole session, on a page with no way to sign out.
   */
  if (tenants.length === 0) {
    return <Navigate to="/settings" replace />;
  }

  if (loading || status === 'loading') {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh' }}>
        <LoadingSpinner size="lg" />
      </div>
    );
  }

  const agencyOnly = isEnabled('agency_dialer_enabled');

  return <Navigate to={agencyOnly ? '/agency' : '/app'} replace />;
}

export default HomeRedirect;
