import type { Role } from '../../types/auth';
import { ROLES } from '../../config';

/**
 * How the Team page names and colours a role, and which roles its two pickers
 * offer. The ORDER and the who-may-manage-whom rule are not here: both come from
 * the contract's `ROLE_HIERARCHY` (`getRoleLevel`, `canManageRole`), the one the
 * server enforces.
 */

const ROLE_COLOR_MAP: Record<Role, string> = {
  tenant_owner: 'var(--accent)',
  tenant_admin: 'var(--info)',
  account_admin: 'var(--teal)',
  operator: 'var(--warning)',
  viewer: 'var(--text-muted)',
  agent: 'var(--text-muted)',
};

export function getRoleLabel(role: Role): string {
  return ROLES.find((r) => r.value === role)?.label ?? role;
}

export function getRoleColor(role: Role): string {
  return ROLE_COLOR_MAP[role] ?? 'var(--text-muted)';
}

/**
 * `agent` is offered here.
 *
 * It used to be display-metadata only — `ROLES` carried it so an existing
 * membership rendered as "Agent" rather than the raw string, and neither picker
 * listed it, on the reasoning that a role with no way into the product was not
 * worth handing out. That reason is spent: an `agent` now lands on their
 * assigned station when they sign in, so the role is usable by the person
 * holding it, and a supervisor staffing a dialer campaign has to be able to
 * create one without a support ticket.
 *
 * Last in both lists, and it is the only entry below `viewer`: the order runs
 * most-access to least, and `agent` (level 5) is not "a smaller viewer" but a
 * different job — it holds the four `agency.*` permissions and nothing else at
 * all. The server's validators already accept it on both routes.
 */
export const INVITE_ROLES: Array<{ value: Role; label: string }> = [
  { value: 'account_admin', label: 'Account Admin' },
  { value: 'operator', label: 'Operator' },
  { value: 'viewer', label: 'Viewer' },
  { value: 'agent', label: 'Agent' },
];

export const CHANGE_ROLES: Array<{ value: Role; label: string }> = [
  { value: 'tenant_admin', label: 'Admin' },
  { value: 'account_admin', label: 'Account Admin' },
  { value: 'operator', label: 'Operator' },
  { value: 'viewer', label: 'Viewer' },
  { value: 'agent', label: 'Agent' },
];
