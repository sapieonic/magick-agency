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
 * What each role can do, in a line, shown where a role is picked (the invite and Change role).
 * Read from the contract's `PERMISSION_MATRIX`, not from what the names suggest, and pinned to it
 * by `teamRoles.test.ts`: every claim a line makes is checked against the permissions the role
 * holds.
 *
 * Viewer and Operator read the same because they are the same (decision AA7): no permission
 * floors at `operator`, and taking calls (`agency.station.connect`) floors at `agent`, so both
 * can take calls and neither can change anything. They are described, not merged.
 */
export const ROLE_DESCRIPTIONS: Record<Role, string> = {
  tenant_owner: 'Everything an admin does, and can change or remove admins.',
  tenant_admin: 'Everything a supervisor does, and can create accounts, change people’s roles and remove them.',
  account_admin: 'Runs campaigns and live calls, edits the account’s settings and the Do Not Call list, and invites people. Can take calls too.',
  operator: 'The same as Viewer: sees campaigns, results and the Do Not Call list, and can take calls. Can’t change campaigns or settings.',
  viewer: 'Sees campaigns, results and the Do Not Call list, and can take calls. Can’t change campaigns or settings.',
  agent: 'Takes calls, follows up their own missed calls and can look up a customer’s past calls. Sees nothing else.',
};

export function getRoleDescription(role: Role): string {
  return ROLE_DESCRIPTIONS[role] ?? '';
}

/**
 * `account_admin` where a role is picked: "Supervisor", the console's word for
 * whoever runs an account, with the access level beside it so nobody picks it
 * thinking it is a dialler-only seat (it can also invite people and change
 * settings for the account). Lists say just "Supervisor" (`config.ts` `ROLES`).
 */
export const SUPERVISOR_PICK_LABEL = 'Supervisor (account admin)';

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
  { value: 'account_admin', label: SUPERVISOR_PICK_LABEL },
  { value: 'operator', label: 'Operator' },
  { value: 'viewer', label: 'Viewer' },
  { value: 'agent', label: 'Agent' },
];

export const CHANGE_ROLES: Array<{ value: Role; label: string }> = [
  { value: 'tenant_admin', label: 'Admin' },
  { value: 'account_admin', label: SUPERVISOR_PICK_LABEL },
  { value: 'operator', label: 'Operator' },
  { value: 'viewer', label: 'Viewer' },
  { value: 'agent', label: 'Agent' },
];
