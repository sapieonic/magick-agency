import { Navigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { useFeatureFlags } from '../../contexts/FeatureFlagsContext';
import { useGovernance } from '../../contexts/GovernanceContext';
import { SETTINGS_ENTRIES, passesGate, settingsLandingPath } from '../../utils/consoleNav';
import { readLastSettingsEntry } from '../../utils/settingsLastVisited';
import { useSettingsNav } from './useSettingsNav';

/**
 * `/settings` (the sidebar's Settings) reopens the Settings page this viewer visited last, while
 * they may still open it; otherwise Team for someone who manages people, and the first entry they
 * may open for everyone else (`settingsLandingPath`).
 *
 * A last page behind a flag or capability that has not resolved yet is waited for, rather than
 * passed over for the default; a flag read that failed is final, so with no tenant this never
 * waits for good.
 */
export default function SettingsIndexRedirect() {
  const { gate } = useSettingsNav();
  const { user } = useAuth();
  const { status: flagStatus } = useFeatureFlags();
  const { loading: governanceLoading } = useGovernance();
  const lastId = readLastSettingsEntry(user?.id);
  const last = SETTINGS_ENTRIES.find((e) => e.id === lastId);
  const resolving = flagStatus === 'loading' || governanceLoading;
  if (last && resolving && !passesGate(last.gate, gate)) return null;
  return <Navigate to={settingsLandingPath(gate, lastId) ?? '/settings/profile'} replace />;
}
