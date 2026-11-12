import { useTenant } from '../../contexts/TenantContext';
import { useAuth } from '../../contexts/AuthContext';
import { useNavGate } from '../../hooks/useNavGate';
import { visibleSettingsGroups, type GateInput, type ScopeNames, type SettingsGroup } from '../../utils/consoleNav';

/**
 * The Settings groups this reader may open, the gate they were read with, and the names their
 * titles and scope labels use. `tenantWide` is false only when every active seat the reader
 * holds in this tenant is scoped to one account: their people-and-access settings then reach
 * that account alone.
 */
export function useSettingsNav(): { groups: SettingsGroup[]; names: ScopeNames; gate: GateInput } {
  const { activeTenant, accounts, accountId, tenantId } = useTenant();
  const { memberships } = useAuth();
  const gate = useNavGate();
  const seats = (memberships ?? []).filter((m) => m.tenant_id === tenantId && m.status === 'active');
  const names: ScopeNames = {
    accountName: accounts.find((a) => a.id === accountId)?.name ?? null,
    tenantName: activeTenant?.name ?? null,
    ...(seats.length > 0 ? { tenantWide: seats.some((m) => m.account_id === null) } : {}),
  };
  return { groups: visibleSettingsGroups(gate), names, gate };
}
