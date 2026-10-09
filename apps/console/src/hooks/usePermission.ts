import { useTenant } from '../contexts/TenantContext';
import { hasPermission, type Permission } from '../utils/permissions';

export function usePermission(permission: Permission): boolean {
  const { role } = useTenant();
  return hasPermission(role, permission);
}
