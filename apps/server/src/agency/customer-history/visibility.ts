/**
 * Who sees what in a customer-history answer (`docs/customer-history.md` CH2, CH8). A LEAF: no I/O.
 *
 *  - **Visible accounts (CH2).** A caller with a tenant-level membership (`account_id IS NULL`)
 *    sees every account of the tenant that is not deleted; otherwise the accounts of their active
 *    account memberships. The caller's role in an account is the higher of their tenant-level role
 *    and their role in that account.
 *  - **Notes and call fields (CH8)** need `agency.campaigns.read` in the call's account, or the
 *    call is the caller's own.
 *  - **The call page** (recording, transcript, analysis) needs `agency.supervise` in the call's account.
 *  - **Who added a DNC entry and why** need `agency.dnc.read` in the entry's account; for a
 *    tenant-wide entry, in the caller's highest role.
 */
import { hasPermission, ROLE_HIERARCHY, type MembershipRole } from '@magick-agency/contracts/rbac';

interface VisibilityMembership {
  account_id: string | null;
  role: MembershipRole;
  status?: string;
}

interface VisibleAccount {
  id: string;
  name: string | null;
  role: MembershipRole;
}

export interface CustomerHistoryViewer {
  userId: string;
  /** Visible accounts, keyed by id, with the caller's effective role in each. */
  accounts: ReadonlyMap<string, VisibleAccount>;
  /** The caller's highest role in the tenant (a tenant-wide DNC entry's role, the audit's `role`). */
  highestRole: MembershipRole;
}

const higher = (a: MembershipRole | null, b: MembershipRole | null): MembershipRole | null => {
  if (!a) return b;
  if (!b) return a;
  return ROLE_HIERARCHY[a] >= ROLE_HIERARCHY[b] ? a : b;
};

/** A membership that counts: active, or read without a status. */
const isActive = (m: VisibilityMembership): boolean => m.status === undefined || m.status === 'active';

/** Whether the memberships hold a tenant-level (all accounts) one. */
export function isTenantWide(memberships: readonly VisibilityMembership[]): boolean {
  return memberships.some((m) => m.account_id === null && isActive(m));
}

/** The account ids the caller's account-scoped memberships name (when not tenant-wide). */
export function membershipAccountIds(memberships: readonly VisibilityMembership[]): string[] {
  return [...new Set(memberships
    .filter((m) => m.account_id !== null && isActive(m))
    .map((m) => m.account_id as string))];
}

/**
 * The viewer: each visible account with the caller's effective role there. `accounts` is what the
 * account lookup returned (every account of the tenant for a tenant-wide caller, else the
 * membership's accounts in this tenant, deleted ones already dropped); an account with no role
 * (unreachable: the lookup was driven by the memberships) is left out.
 */
export function buildViewer(
  userId: string,
  memberships: readonly VisibilityMembership[],
  accounts: ReadonlyArray<{ id: string; name: string | null }>,
): CustomerHistoryViewer {
  const active = memberships.filter(isActive);
  let tenantRole: MembershipRole | null = null;
  const byAccount = new Map<string, MembershipRole>();
  for (const m of active) {
    if (m.account_id === null) tenantRole = higher(tenantRole, m.role);
    else byAccount.set(m.account_id, higher(byAccount.get(m.account_id) ?? null, m.role)!);
  }
  const visible = new Map<string, VisibleAccount>();
  let highest: MembershipRole | null = tenantRole;
  for (const a of accounts) {
    const role = higher(tenantRole, byAccount.get(a.id) ?? null);
    if (!role) continue;
    visible.set(a.id, { id: a.id, name: a.name, role });
    highest = higher(highest, role);
  }
  return { userId, accounts: visible, highestRole: highest ?? 'agent' };
}

/** The caller's role for a row of `accountId`; a tenant-wide row (null) takes the highest role. */
function roleFor(viewer: CustomerHistoryViewer, accountId: string | null): MembershipRole | null {
  if (accountId === null) return viewer.highestRole;
  return viewer.accounts.get(accountId)?.role ?? null;
}

/** Notes and call fields: `agency.campaigns.read` in the call's account, or the caller's own call. */
export function canSeeCallNotes(viewer: CustomerHistoryViewer, accountId: string, agentUserId: string | null): boolean {
  if (agentUserId !== null && agentUserId === viewer.userId) return true;
  return hasPermission(roleFor(viewer, accountId), 'agency.campaigns.read');
}

/** The call page (recording, transcript, analysis): `agency.supervise` in the call's account. */
export function canOpenCallPage(viewer: CustomerHistoryViewer, accountId: string): boolean {
  return hasPermission(roleFor(viewer, accountId), 'agency.supervise');
}

/** Who added a DNC entry and why: `agency.dnc.read` at the entry's level. */
export function canSeeDncDetail(viewer: CustomerHistoryViewer, accountId: string | null): boolean {
  return hasPermission(roleFor(viewer, accountId), 'agency.dnc.read');
}
