import { membershipRepository } from '@magick-agency/db/repositories/membership.repository';
import type { MembershipRecord } from '@magick-agency/db/models/membership.model';
import { hasPermission } from '@magick-agency/contracts/rbac';
import { FLAGS, getFeatureFlagService } from '../../feature-flags/index.js';
import type { ListenAccessCheck, ListenSessionHandle } from './listen-registry.js';

/**
 * LS10's question, asked of the DATABASE (never the membership cache, which a revocation's cache
 * delete may not have reached): which of these sessions may no longer go on? One may go on while
 *  - the supervisor's membership for the session's tenant and account (the one the tenant context
 *    would pick: the account's, else the tenant-wide one) is active and clears
 *    `agency.calls.listen`;
 *  - `agency_live_listen_enabled` is on for the tenant and account (LS1);
 *  - the call is recorded, or `agency_live_listen_unrecorded` is on for them (LS4).
 * Each supervisor's memberships and each account's flags are read once per pass. A read that
 * throws rejects the whole pass (the registry keeps every session: an outage is not a revocation).
 */
export interface ListenAccessDeps {
  memberships(userId: string, tenantId: string): Promise<MembershipRecord[]>;
  listenEnabled(tenantId: string, accountId: string): Promise<boolean>;
  unrecordedAllowed(tenantId: string, accountId: string): Promise<boolean>;
}

export const defaultListenAccessDeps: ListenAccessDeps = {
  memberships: (userId, tenantId) => membershipRepository.findByUserAndTenant(userId, tenantId),
  listenEnabled: (tenantId, accountId) =>
    getFeatureFlagService().isEnabled(FLAGS.agency_live_listen_enabled, { tenantId, accountId }),
  unrecordedAllowed: (tenantId, accountId) =>
    getFeatureFlagService().isEnabled(FLAGS.agency_live_listen_unrecorded, { tenantId, accountId }),
};

/** May this membership list listen in this account? (The tenant context's pick, then the floor.) */
export function membershipMayListen(memberships: MembershipRecord[], accountId: string): boolean {
  // `selectMembership`'s rule with an account named (`tenant-context.middleware.ts`): the
  // account's own membership, else the tenant-wide one.
  const m = memberships.find((x) => x.account_id === accountId) ?? memberships.find((x) => x.account_id === null);
  return !!m && m.status === 'active' && hasPermission(m.role, 'agency.calls.listen');
}

export function listenAccessCheck(deps: ListenAccessDeps = defaultListenAccessDeps): ListenAccessCheck {
  return async (sessions: readonly ListenSessionHandle[]) => {
    const members = new Map<string, Promise<MembershipRecord[]>>();
    const enabled = new Map<string, Promise<boolean>>();
    const unrecorded = new Map<string, Promise<boolean>>();
    const once = <T>(cache: Map<string, Promise<T>>, key: string, read: () => Promise<T>): Promise<T> => {
      let hit = cache.get(key);
      if (!hit) { hit = read(); cache.set(key, hit); }
      return hit;
    };
    const failing = new Set<string>();
    for (const s of sessions) {
      const account = `${s.tenantId}:${s.accountId}`;
      const [mine, on] = await Promise.all([
        once(members, `${s.listenerUserId}:${s.tenantId}`, () => deps.memberships(s.listenerUserId, s.tenantId)),
        once(enabled, account, () => deps.listenEnabled(s.tenantId, s.accountId)),
      ]);
      let ok = on && membershipMayListen(mine, s.accountId);
      if (ok && !s.recording) ok = await once(unrecorded, account, () => deps.unrecordedAllowed(s.tenantId, s.accountId));
      if (!ok) failing.add(s.listenId);
    }
    return failing;
  };
}
