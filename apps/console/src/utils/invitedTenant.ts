import type { SessionResponse } from '../types/auth';
import type { AgencyInvite } from '../types/invite';

/**
 * Which tenant a just-claimed invitation belongs to, read off the session the
 * claim answered with — or `null` when the session cannot say.
 *
 * ── The defect this answers ────────────────────────────────────────────────
 * The claim adopts a whole session (`POST /auth/session`'s body, every tenant the
 * person belongs to), and `TenantContext` then picks the active tenant the way it
 * always does: the one stored in `localStorage` if it is still valid, otherwise
 * the first in the list. For a first-time invitee that is the right answer by
 * construction — they have one tenant. For somebody who ALREADY works in another
 * workspace — an operator invited into a second company, an agent staffed by a
 * second agency, the `auth/email-already-in-use` path the join form turns into a
 * sign-in — it is the wrong one: their stored workspace is still valid, so they
 * finish joining the new one and land back in the old, with nothing on screen
 * saying the invitation they just accepted worked at all.
 *
 * ── Why it is inferred, and why it gives up rather than guesses ───────────
 * The wire does not name the tenant. `GET /invites/:token` carries `tenant_name`
 * and never an id — the server refuses to hand a raw tenant UUID to an
 * unauthenticated caller — and the claim's body is the session's, which is
 * unscoped by design. So the answer is assembled from what the two do carry: the
 * tenants in which this person holds an ACTIVE membership in the invited role,
 * narrowed by name when the invitation had one. A claim activates exactly that
 * membership, so the invited tenant is always among the candidates; the question
 * is only whether it is alone.
 *
 * When it is not — the same person already an operator at two workspaces both
 * called "Acme", or a nameless invitation into a second tenant where they hold
 * the same role — this returns `null` and the context's ordinary choice stands.
 * Picking one of two indistinguishable workspaces would be a coin toss presented
 * as an answer, and the tenant switcher is one click away from the right one.
 * A one-tenant session needs no inference at all, and is answered first.
 */
export function invitedTenantId(
  session: Pick<SessionResponse, 'tenants' | 'memberships'>,
  invite: Pick<AgencyInvite, 'role' | 'tenant_name'>,
): string | null {
  const tenants = Array.isArray(session.tenants) ? session.tenants : [];
  const memberships = Array.isArray(session.memberships) ? session.memberships : [];

  if (tenants.length === 1) return tenants[0]!.id;

  const holding = new Set(
    memberships
      .filter((m) => m.status === 'active' && m.role === invite.role)
      .map((m) => m.tenant_id),
  );
  const candidates = tenants.filter(
    (t) => holding.has(t.id) && (invite.tenant_name === null || t.name === invite.tenant_name),
  );

  return candidates.length === 1 ? candidates[0]!.id : null;
}
