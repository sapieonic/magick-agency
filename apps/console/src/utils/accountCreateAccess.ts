import { hasPermission } from './permissions';
import type { Membership } from '../types/auth';

/**
 * Whether the signed-in person may create accounts in `tenantId`, by the server's two
 * rules for `POST /accounts` (decision AA1): the `account.create` role (tenant admin or
 * owner) on a TENANT-WIDE membership.
 *
 *  - `allowed`: an active tenant-wide seat carries the role;
 *  - `account_scoped`: the role is held, but only on a seat scoped to one account, which
 *    the server refuses (`tenant_wide_membership_required`): say why rather than offer a
 *    button that can only fail;
 *  - `not_permitted`: no seat carries the role.
 */
export type AccountCreateAccess = 'allowed' | 'account_scoped' | 'not_permitted';

export function accountCreateAccess(
  memberships: ReadonlyArray<Pick<Membership, 'tenant_id' | 'account_id' | 'role' | 'status'>>,
  tenantId: string | null,
): AccountCreateAccess {
  const mine = memberships.filter((m) => m.tenant_id === tenantId && m.status === 'active');
  if (mine.some((m) => m.account_id === null && hasPermission(m.role, 'account.create'))) return 'allowed';
  if (mine.some((m) => hasPermission(m.role, 'account.create'))) return 'account_scoped';
  return 'not_permitted';
}
