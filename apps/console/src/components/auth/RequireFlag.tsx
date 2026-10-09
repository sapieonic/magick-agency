import { useEffect, type ReactNode } from 'react';
import { trackFeatureGateUnavailable } from '../../analytics/events';
import { useFeatureFlags } from '../../contexts/FeatureFlagsContext';
import { useTenant } from '../../contexts/TenantContext';
import { LoadingSpinner } from '../common/LoadingSpinner';
import { AccountUnavailable } from '../common/AccountUnavailable';
import { CapabilityUnavailable } from '../common/CapabilityUnavailable';

/**
 * Route guard for a client-exposed feature flag. Sibling to `RequireCapability`
 * (governance) — the two compose by nesting when a screen must satisfy BOTH.
 * While the flag map is still loading it shows a spinner (avoids a flash), then
 * renders a NEUTRAL IN-PLACE screen (URL preserved — never a redirect) once the
 * flag has resolved to off. Fail-safe CLOSED: an errored/absent flag hides the
 * screen (matching the API's default-off posture and `useFeatureFlags` semantics).
 */
export default function RequireFlag({
  flag,
  children,
}: {
  flag: string;
  children: ReactNode;
}) {
  const { isEnabled, status } = useFeatureFlags();
  const { accountId, accountResolution, accountError, reloadAccounts } = useTenant();
  const unavailable = status !== 'loading' && !isEnabled(flag);

  useEffect(() => {
    if (!unavailable) return;
    // Only the two agency flags a route is gated on are tracked.
    if (flag !== 'agency_dialer_enabled' && flag !== 'agency_call_analysis') return;

    trackFeatureGateUnavailable({
      gate_type: 'feature_flag',
      gate: flag,
    });
  }, [flag, unavailable]);

  /**
   * **Checked before the spinner, and that order is the whole fix.**
   *
   * An account that could not be resolved is not a slow account. The flag map has
   * nothing to wait for — it never fires a request without an `accountId` — so
   * the spinner below would be permanent, which is exactly what an `agent` (role
   * level 5, below `account.read`'s `viewer` floor) got on every sign-in: a 403
   * from `GET /accounts`, swallowed, and a spinner with no error and no console
   * message.
   *
   * Distinct from `CapabilityUnavailable` further down on purpose. "Not part of
   * your plan" is a confident, wrong explanation for a failed request, and it
   * sends the user to argue about billing over what is usually a permissions or
   * network problem.
   *
   * **The second clause is not decoration.** Resolution can settle without
   * producing an account — a tenant with genuinely zero accounts, or a `'degraded'`
   * fallback whose narrowed list came back empty — and in both cases the tenant
   * effect will not fire again, so nothing will ever set `accountId`. Those used to
   * spin forever; now that `FeatureFlagsContext` correctly reports `'error'` for
   * them, without this clause they would land on the plan-gate copy instead, which
   * is the same wrong explanation one layer along. `'degraded'` **with** an account
   * falls through deliberately: the user can work, and the caveat belongs on the
   * account switcher, not across the whole page.
   */
  if (accountResolution === 'error' || (accountResolution !== 'loading' && accountId === null)) {
    return <AccountUnavailable detail={accountError} onRetry={reloadAccounts} />;
  }

  if (status === 'loading') {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '60vh' }}>
        <LoadingSpinner size="lg" />
      </div>
    );
  }

  if (unavailable) {
    return <CapabilityUnavailable />;
  }

  return <>{children}</>;
}
