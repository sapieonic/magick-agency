import { useTenant } from '../../contexts/TenantContext';
import { useAuth } from '../../contexts/AuthContext';
import { useFeatureFlags } from '../../contexts/FeatureFlagsContext';
import { useGovernance } from '../../contexts/GovernanceContext';
import { visibleSettingsGroups, type GateInput, type ScopeNames, type SettingsGroup } from '../../utils/consoleNav';

/**
 * The Settings groups this reader may open, the gate they were read with, and the names their
 * titles and scope labels use. `tenantWide` is false only when every active seat the reader
 * holds in this tenant is scoped to one account: their people-and-access settings then reach
 * that account alone.
 */
export function useSettingsNav(): { groups: SettingsGroup[]; names: ScopeNames; gate: GateInput } {
  const { role, activeTenant, accounts, accountId, tenantId } = useTenant();
  const { memberships } = useAuth();
  const { isEnabled: isFlagEnabled } = useFeatureFlags();
  const { isEnabled: isCapabilityEnabled } = useGovernance();
  const seats = (memberships ?? []).filter((m) => m.tenant_id === tenantId && m.status === 'active');
  const names: ScopeNames = {
    accountName: accounts.find((a) => a.id === accountId)?.name ?? null,
    tenantName: activeTenant?.name ?? null,
    ...(seats.length > 0 ? { tenantWide: seats.some((m) => m.account_id === null) } : {}),
  };
  const gate: GateInput = { role, isFlagEnabled, isCapabilityEnabled };
  return { groups: visibleSettingsGroups(gate), names, gate };
}
