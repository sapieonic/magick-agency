import { Navigate } from 'react-router-dom';
import { useTenant } from '../contexts/TenantContext';
import { useGovernance } from '../contexts/GovernanceContext';
import { useFeatureFlags } from '../contexts/FeatureFlagsContext';
import { hasPermission } from '../utils/permissions';
import { isDedicatedAgent } from '../utils/agencyPersona';
import { DialerUnavailable } from '../components/agency/DialerUnavailable';
import { LoadingSpinner } from '../components/common/LoadingSpinner';

/**
 * `/app`'s index — the platform zone's landing page.
 *
 * There is no AI dashboard in this console, so this index is not one. The `/app`
 * shell survives as the PLATFORM zone — team, notifications, call summaries —
 * that `AgencyLayout`'s deliberate exit ("Team & settings"; `WorkspaceExit`)
 * leads to (the agency, platform and super-admin zones). So this index must NOT redirect into
 * `/agency`: that would bounce the exit straight back into the workspace it
 * leaves, which is exactly why `HomeRedirect` refuses to make its
 * decision here (see its docstring). It lands on a platform page instead:
 *
 *  - a dedicated `agent` (level 5) with the dialer off → `DialerUnavailable`,
 *    the one sentence explaining that exact state;
 *  - anyone who can manage the team (`user.invite`) → Team;
 *  - everyone else → Notifications, the one page every role has (it is
 *    ungated: it manages the caller's own subscriptions).
 */
export function AppHomeRedirect() {
  const { role, accountResolution } = useTenant();
  const { isEnabled: capabilityEnabled, loading: governanceLoading } = useGovernance();
  const { isEnabled: flagEnabled, status: flagStatus } = useFeatureFlags();

  // `role` is `undefined` while the membership resolves; deciding then would send a
  // team admin to Notifications for good. Wait, as `AgencyHomeRedirect` does.
  if (role === undefined && accountResolution === 'loading') return <LoadingSpinner />;

  if (isDedicatedAgent(role)) {
    if (governanceLoading || flagStatus === 'loading') return <LoadingSpinner />;
    if (!capabilityEnabled('agency') || !flagEnabled('agency_dialer_enabled')) {
      return <DialerUnavailable />;
    }
  }

  return (
    <Navigate to={hasPermission(role, 'user.invite') ? '/app/team' : '/app/notifications'} replace />
  );
}

export default AppHomeRedirect;
