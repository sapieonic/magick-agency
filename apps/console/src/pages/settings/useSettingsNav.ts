import { useTenant } from '../../contexts/TenantContext';
import { useFeatureFlags } from '../../contexts/FeatureFlagsContext';
import { useGovernance } from '../../contexts/GovernanceContext';
import { visibleSettingsGroups, type ScopeNames, type SettingsGroup } from '../../utils/consoleNav';

/** The Settings groups this reader may open, and the names their titles and scope labels use. */
export function useSettingsNav(): { groups: SettingsGroup[]; names: ScopeNames } {
  const { role, activeTenant, accounts, accountId } = useTenant();
  const { isEnabled: isFlagEnabled } = useFeatureFlags();
  const { isEnabled: isCapabilityEnabled } = useGovernance();
  const names: ScopeNames = {
    accountName: accounts.find((a) => a.id === accountId)?.name ?? null,
    tenantName: activeTenant?.name ?? null,
  };
  return {
    groups: visibleSettingsGroups({ role, isFlagEnabled, isCapabilityEnabled }),
    names,
  };
}
