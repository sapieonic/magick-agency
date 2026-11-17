import type { MembershipRecord } from '@magick-agency/db/models/membership.model';

/**
 * Which of a user's memberships in this tenant a request acts under.
 *
 * With `X-Account-Id`: that account's own row, else the tenant-wide row (which
 * reaches every account). Without it: the tenant-wide row, else the OLDEST
 * account-scoped row (`created_at`, then `id`).
 *
 * ── Why "oldest" and not `memberships[0]` ───────────────────────────────────
 * The fallback used to be `memberships[0]`, and `findByUserAndTenant` had no
 * `ORDER BY`, so for a user holding two account-scoped memberships and no
 * tenant-wide one, Postgres heap order picked the account — and therefore the
 * role, and every account-scoped filter downstream. It could change between
 * requests and across a membership-cache refresh: an ingest job created under
 * account A was stamped A, and the same person polling it a little later could
 * resolve to B and get a 404 for their own import. The rule is applied here in
 * code as well as in the SQL because an array already in the membership cache
 * was written before the SQL gained its ORDER BY, and because a cached copy
 * comes back through JSON with `created_at` as a string.
 *
 * "Oldest" is a deterministic choice, not a semantic one — nothing ranks one
 * account over another. A client that means a specific account sends
 * `X-Account-Id`; this only guarantees the answer does not flip underneath one
 * that does not.
 */
export function selectMembership(
  memberships: MembershipRecord[],
  accountId: string | undefined,
): MembershipRecord | undefined {
  if (accountId) {
    return memberships.find((m) => m.account_id === accountId)
      ?? memberships.find((m) => m.account_id === null);
  }
  const tenantWide = memberships.find((m) => m.account_id === null);
  if (tenantWide) return tenantWide;
  const createdAt = (m: MembershipRecord): number => {
    const t = m.created_at ? new Date(m.created_at).getTime() : Number.NaN;
    return Number.isNaN(t) ? Number.POSITIVE_INFINITY : t;
  };
  return [...memberships].sort(
    (a, b) => createdAt(a) - createdAt(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  )[0];
}
