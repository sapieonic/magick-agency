/**
 * Who may do what with a report (docs/reports.md "Who may run what", RP4, RP5). The request-time
 * checks read the caller's resolved membership (`request.membership`, as `requirePermission`
 * does); the checks about OTHER people (an agent subject, a subscription's recipients, the
 * requester at send time) read `memberships` here.
 *
 * A membership reaches an account when it is tenant-wide (`account_id IS NULL`) or names that
 * account. A person's role on an account is the highest role among their ACTIVE memberships that
 * reach it: a tenant admin holds `agency.supervise` on every account of the tenant, an account
 * admin only on their own.
 */
import { hasPermission, ROLE_HIERARCHY, type Permission } from '@magick-agency/contracts/rbac';
import { membershipRepository } from '@magick-agency/db/repositories/membership.repository';
import type { MembershipRecord, MembershipRole } from '@magick-agency/db/models/membership.model';

type MembershipRef = Pick<MembershipRecord, 'account_id' | 'role' | 'status'>;

/** Does this membership reach `accountId` (tenant-wide, or that account)? */
export function reachesAccount(membership: Pick<MembershipRecord, 'account_id'>, accountId: string): boolean {
  return membership.account_id === null || membership.account_id === accountId;
}

/** The highest role among the ACTIVE memberships that reach `accountId`; null when none does. */
export function roleOnAccount(memberships: readonly MembershipRef[], accountId: string): MembershipRole | null {
  let best: MembershipRole | null = null;
  for (const m of memberships) {
    if (m.status !== 'active' || !reachesAccount(m, accountId)) continue;
    if (best === null || ROLE_HIERARCHY[m.role] > ROLE_HIERARCHY[best]) best = m.role;
  }
  return best;
}

/**
 * The users among `userIds` who hold `permission` on `accountId` right now (active membership
 * reaching the account, role at the permission's floor). One query for the set; ids that are not
 * UUIDs, or not in the tenant, are simply absent.
 */
export async function usersWithPermissionOnAccount(
  userIds: readonly string[],
  tenantId: string,
  accountId: string,
  permission: Permission,
): Promise<Set<string>> {
  const rows = await membershipRepository.findAnyByUsersAndTenant(userIds, tenantId);
  const byUser = new Map<string, MembershipRecord[]>();
  for (const row of rows) {
    const list = byUser.get(row.user_id) ?? [];
    list.push(row);
    byUser.set(row.user_id, list);
  }
  const out = new Set<string>();
  for (const [userId, memberships] of byUser) {
    if (hasPermission(roleOnAccount(memberships, accountId), permission)) out.add(userId);
  }
  return out;
}

/**
 * Was `userId` ever a member of the tenant whose membership reaches `accountId` (any status)? The
 * subject check of a supervisor's agent report: a departed agent's review is still the dispute
 * case a supervisor reads it for (the agent record's rule, `findAnyByUserAndTenant`), but an
 * agent of another account of the tenant is not this account's to report on.
 */
export async function isMemberOfAccountEver(userId: string, tenantId: string, accountId: string): Promise<boolean> {
  const rows = await membershipRepository.findAnyByUserAndTenant(userId, tenantId);
  return rows.some((m) => reachesAccount(m, accountId));
}
