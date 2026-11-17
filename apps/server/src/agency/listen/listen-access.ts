import { membershipRepository } from '@magick-agency/db/repositories/membership.repository';
import type { MembershipRecord } from '@magick-agency/db/models/membership.model';
import { hasPermission } from '@magick-agency/contracts/rbac';
import { selectMembership } from '../../rbac/select-membership.js';
import { FLAGS, getFeatureFlagService } from '../../feature-flags/index.js';
import type { ListenAccessCheck, ListenAccessSubject, ListenAccessVerdict } from './listen-registry.js';

/**
 * LS10's question, asked of the DATABASE (never the membership cache, which a revocation's cache
 * delete may not have reached): which of these listens may no longer go on? One may go on while
 *  - the supervisor's membership for the session's tenant and account (the one the tenant context
 *    would pick: the account's, else the tenant-wide one) is active and clears
 *    `agency.calls.listen`;
 *  - `agency_live_listen_enabled` is on for the tenant and account (LS1);
 *  - the call is recorded, or `agency_live_listen_unrecorded` is on for them (LS4).
 * Each supervisor's memberships and each account's flags are read once per pass.
 *
 * A read that fails leaves the listens it was needed for UNCHECKED, never passed and never
 * revoked: the caller decides (LS16 c, d — the upgrade refuses, the immediate revocation ends
 * them, the periodic pass keeps them until the staleness cap). The flags are read through
 * {@link readListenFlags}, which reports an outage instead of resolving the registry defaults: a
 * default would end every listen on a flag-store blip (`agency_live_listen_enabled`, default off)
 * and open the LS4 policy on one (`agency_live_listen_unrecorded`, default on).
 */
export interface ListenAccessDeps {
  memberships(userId: string, tenantId: string): Promise<MembershipRecord[]>;
  /** Both flags for the account; throws when they cannot be read. */
  flags(tenantId: string, accountId: string): Promise<ListenFlags>;
}

/** The two listening flags for one account (LS1, LS4). */
export interface ListenFlags {
  /** `agency_live_listen_enabled`. */
  enabled: boolean;
  /** `agency_live_listen_unrecorded`. */
  unrecordedAllowed: boolean;
}

/**
 * Both listening flags for an account from ONE strict snapshot: rejects (`FlagReadError`) when
 * they cannot be read, rather than answering the registry defaults. The grant (the public route)
 * and the access check both read them here.
 */
export async function readListenFlags(tenantId: string, accountId: string): Promise<ListenFlags> {
  const flags = await getFeatureFlagService().strictSnapshot({ tenantId, accountId });
  return {
    enabled: flags.isEnabled(FLAGS.agency_live_listen_enabled),
    unrecordedAllowed: flags.isEnabled(FLAGS.agency_live_listen_unrecorded),
  };
}

export const defaultListenAccessDeps: ListenAccessDeps = {
  memberships: (userId, tenantId) => membershipRepository.findByUserAndTenant(userId, tenantId),
  flags: readListenFlags,
};

/**
 * May this membership list listen in this account? The tenant context's own pick
 * (`selectMembership`, shared with `tenant-context.middleware.ts`: the account's membership, else
 * the tenant-wide one), then the floor.
 */
export function membershipMayListen(memberships: MembershipRecord[], accountId: string): boolean {
  const m = selectMembership(memberships, accountId);
  return !!m && m.status === 'active' && hasPermission(m.role, 'agency.calls.listen');
}

export function listenAccessCheck(deps: ListenAccessDeps = defaultListenAccessDeps): ListenAccessCheck {
  return async (subjects: readonly ListenAccessSubject[]): Promise<ListenAccessVerdict> => {
    const members = new Map<string, Promise<MembershipRecord[]>>();
    const flags = new Map<string, Promise<ListenFlags>>();
    const once = <T>(cache: Map<string, Promise<T>>, key: string, read: () => Promise<T>): Promise<T> => {
      let hit = cache.get(key);
      if (!hit) {
        // A read that throws synchronously is a rejected read, like any other.
        hit = Promise.resolve().then(read);
        hit.catch(() => { /* awaited below, per subject */ });
        cache.set(key, hit);
      }
      return hit;
    };
    // Every distinct read starts at once; then each subject is decided in order.
    const reads = subjects.map((s) => Promise.allSettled([
      once(members, `${s.listenerUserId}:${s.tenantId}`, () => deps.memberships(s.listenerUserId, s.tenantId)),
      once(flags, `${s.tenantId}:${s.accountId}`, () => deps.flags(s.tenantId, s.accountId)),
    ]));
    const verdict: ListenAccessVerdict = { revoked: new Set(), unchecked: new Set() };
    for (const [i, s] of subjects.entries()) {
      const [mine, on] = await reads[i]!;
      // What could be read and says no is a revocation, whatever could not be read.
      const refused = (mine.status === 'fulfilled' && !membershipMayListen(mine.value, s.accountId))
        || (on.status === 'fulfilled' && (!on.value.enabled || (!s.recording && !on.value.unrecordedAllowed)));
      if (refused) verdict.revoked.add(s.listenId);
      else if (mine.status === 'rejected' || on.status === 'rejected') verdict.unchecked.add(s.listenId);
    }
    return verdict;
  };
}
