import { Navigate } from 'react-router-dom';
import { useTenant } from '../contexts/TenantContext';
import { useGovernance } from '../contexts/GovernanceContext';
import { useFeatureFlags } from '../contexts/FeatureFlagsContext';
import { isDedicatedAgent } from '../utils/agencyPersona';
import { dialerOn } from '../utils/consoleNav';
import { DialerUnavailable } from '../components/agency/DialerUnavailable';
import { LoadingSpinner } from '@magick-agency/web-ui/components/LoadingSpinner';

/**
 * `/app` — the console's home decision, kept at the URL the workspace invite, the session
 * expiry and the catch-all have always landed on.
 *
 * `/app` used to be a second shell (team and settings). Its pages moved to the Settings hub
 * (decision B28, `LegacyAppRedirect`), and this index now sends a reader to where their work
 * is:
 *
 *  - a dedicated `agent` (level 5) with the dialer off → `DialerUnavailable`, inside the
 *    console shell (which has a sign-out). With the dialer on, `AgentLanding` has already
 *    sent them to `/dialer`;
 *  - anyone else, with the dialer on (the `agency` capability and `agency_dialer_enabled`) →
 *    `/agency`, whose own index picks the page by persona;
 *  - anyone else with the dialer off → `/settings`, since `/agency` would only refuse them.
 *
 * It never goes to `/` or back to `/app`, so it cannot loop with `HomeRedirect`.
 */
export function AppHomeRedirect() {
  const { role, accountResolution } = useTenant();
  const { isEnabled: capabilityEnabled, loading: governanceLoading } = useGovernance();
  const { isEnabled: flagEnabled, status: flagStatus } = useFeatureFlags();

  // `role` is `undefined` while the membership resolves; deciding then would misroute an agent.
  if (role === undefined && accountResolution === 'loading') return <LoadingSpinner />;
  if (governanceLoading || flagStatus === 'loading') return <LoadingSpinner />;

  const on = dialerOn({ isFlagEnabled: flagEnabled, isCapabilityEnabled: capabilityEnabled });
  if (isDedicatedAgent(role) && !on) return <DialerUnavailable />;
  return <Navigate to={on ? '/agency' : '/settings'} replace />;
}

export default AppHomeRedirect;
