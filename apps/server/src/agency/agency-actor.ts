/*
 * There are no platform API keys in v1 (docs/decisions.md, "Platform API keys"):
 * `request.user` is always the Firebase-verified person, so a missing user id is the only
 * unattributed case this has to refuse. RBAC comes from `@magick-agency/contracts/rbac`.
 */
import type { FastifyRequest } from 'fastify';
import { hasPermission } from '@magick-agency/contracts/rbac';
import type { AgencyActionErrorCode } from '@magick-agency/contracts/errors';

/**
 * Who is performing an attempt-scoped agency action.
 *
 * The two fields exist — rather than one opaque actor id — because **neither
 * layer can enforce the ownership rule alone**:
 *
 *  - "is the reserved agent for this attempt" is a fact of the dialer runtime,
 *    checked by the internal handler instance (`checkActor`, `disposition.ts`).
 *    The public API layer has no reservation state and cannot check it.
 *  - "holds a supervisory capability" is an RBAC fact of the public API layer.
 *    The internal handler does not evaluate RBAC.
 *
 * So the public API layer asserts both and the internal handler enforces the rule
 * against them, in this order:
 *   1. no `agent_user_id` ⇒ 400 `missing_actor`;
 *   2. `agent_user_id` matches the reserved agent ⇒ allowed;
 *   3. mismatch **and** `on_behalf` ⇒ allowed, acting user recorded separately;
 *   4. mismatch and no `on_behalf` ⇒ 403 `not_your_attempt`.
 */
export interface AgencyActorFields {
  agent_user_id: string;
  on_behalf?: true;
}

/**
 * Resolves the actor for an attempt-scoped action from the authenticated request.
 *
 * ── Why this refuses rather than forwarding an unattributed request ──────────
 * A disposition is the record of who said what about a customer, so there is no
 * anonymous one. The internal handler answers 400 `missing_actor` when
 * `agent_user_id` is absent; refusing here with that same `code` stops the request
 * before the handler call and gives the console one error shape to key off
 * whichever layer refused.
 *
 * ── Why `on_behalf` is decided on the capability alone ───────────────────────
 * The contract says `on_behalf` is set "only when the caller holds
 * `agency.supervise` **and is not the reserved agent**". This layer cannot evaluate
 * the second clause — the reservation lives in the dialer runtime — so it
 * evaluates the first and lets the rule *ordering* settle the rest: a supervisor
 * who *is* the reserved agent matches at rule 2 and never reaches rule 3, so an
 * `on_behalf` they did not need is inert. The alternative (asking who the reserved
 * agent is, then posting) is two calls racing a reservation that can move between
 * them.
 *
 * An `agent` (level 5) can never cause `on_behalf` to be set: `agency.supervise`
 * floors at `account_admin` (30).
 */
export function resolveAgencyActor(
  request: FastifyRequest,
): { ok: true; actor: AgencyActorFields } | { ok: false; code: AgencyActionErrorCode; message: string } {
  const userId = request.user?.id;
  if (!userId) {
    return {
      ok: false,
      code: 'missing_actor',
      message:
        'This action must be attributed to a user. Sign in as the agent or a supervisor.',
    };
  }

  const role = request.membership?.role;
  // No membership means RBAC already refused, so this is belt-and-braces: absent a
  // role we assert no supervision.
  const supervises = role ? hasPermission(role, 'agency.supervise') : false;

  return {
    ok: true,
    // `on_behalf` is omitted rather than sent as `false` when the caller is not a
    // supervisor, matching the contract's "set only when…" wording.
    actor: supervises ? { agent_user_id: userId, on_behalf: true } : { agent_user_id: userId },
  };
}
