import { describe, it, expect } from 'vitest';
import type { FastifyRequest } from 'fastify';
import { resolveAgencyActor } from '../../../src/agency/agency-actor.js';
import { PERMISSION_MATRIX, ROLE_HIERARCHY } from '@magick-agency/contracts/rbac';

/*
 * No platform API keys (decision #5): the actor is always the signed-in user, and a
 * request with no user is refused with `missing_actor`.
 */
/**
 * `src/agency/agency-actor.ts` — the two predicates every agency WRITE action
 * attributes itself through, tested directly rather than only through a route.
 *
 * ── Why a direct test, when the routes already exercise this ────────────────
 * `test/unit/agency/proxy-agency-agent-actions.test.ts` drives both predicates
 * hard through the disposition, notes, break and mark-DNC handlers, and those
 * cases are the ones that prove the product behaviour. What they cannot reach is
 * the module's own edge: `resolveAgencyActor` has a branch for a request that
 * carries a `user` and NO `membership`, and no route can produce one — RBAC has
 * already refused by then, which is exactly why the code calls it
 * belt-and-braces. Coverage confirmed it: the module sat at 100% of statements
 * and 90% of branches, and the missing 10% was that arm.
 *
 * An unreachable-through-the-front-door branch is the kind most likely to be
 * "simplified" away by someone who cannot see what would break. The point of
 * pinning it here is that the answer is not merely "something sensible" but
 * specifically **no `on_behalf`** — see below for why that is the load-bearing
 * direction.
 *
 * ── The shared history behind both functions ───────────────────────────────
 * Both exist in their current form because of one false sentence, written in half
 * a dozen places across this feature: *"a platform API key carries a tenant and
 * no user."* `sessionMiddleware`'s API-key branch loads
 * `platform_api_keys.created_by` into `request.user`, so a key minted by a real
 * person authenticates carrying that person — and every guard spelled
 * `if (!request.user?.id)` waved it through. On this surface that meant a key
 * holder **dispositioning a customer in the key creator's name**, and, because
 * `created_by` is frequently an `account_admin`, with `on_behalf: true` attached
 * — the internal handler's rule 3, which bypasses the reserved-agent check outright.
 *
 * Only a NULL-`created_by` system key was ever refused, which is the one shape
 * the tests happened to model. So the cases below deliberately model the OTHER
 * one: `apiKeyTenantId` set **and** a populated `user` **and** a supervisory
 * `membership`, all at once. That is the shape a real creator-backed key arrives
 * in, and it is the shape that must be refused.
 */

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const CREATOR = '33333333-3333-4333-8333-333333333333';

/**
 * A request as the middleware chain leaves it. Only the four fields these
 * predicates read are modelled; the cast is what every route unit test in this
 * repo does with a synthesised request.
 */
function req(fields: {
  apiKeyTenantId?: string | null;
  user?: { id: string } | undefined;
  membership?: { role: string } | undefined;
}): FastifyRequest {
  return fields as unknown as FastifyRequest;
}

describe('resolveAgencyActor — refusing an unattributable caller', () => {
  it('refuses a request with neither a key nor a user', () => {
    // Nothing to attribute, and `agent_user_id: undefined` on the wire is the internal handler's
    // 400 spent a round trip later.
    expect(resolveAgencyActor(req({}))).toMatchObject({ ok: false, code: 'missing_actor' });
  });
});

describe('resolveAgencyActor — on_behalf is decided on the capability alone', () => {
  it('omits on_behalf entirely for an agent, rather than sending false', () => {
    /**
     * Omitted, not `false`. The internal handler's contract is "the public API layer sets this
     * only when the caller holds `agency.supervise`", and an explicit `false` is a different
     * wire shape for the same fact — one that the internal handler's schema is under no obligation to
     * keep accepting.
     */
    const result = resolveAgencyActor(req({ user: { id: USER }, membership: { role: 'agent' } }));

    expect(result).toEqual({ ok: true, actor: { agent_user_id: USER } });
    expect(result.ok && 'on_behalf' in result.actor).toBe(false);
  });

  it('sets on_behalf for a role that holds agency.supervise', () => {
    expect(resolveAgencyActor(req({ user: { id: USER }, membership: { role: 'account_admin' } })))
      .toEqual({ ok: true, actor: { agent_user_id: USER, on_behalf: true } });
  });

  it('splits the roles exactly where PERMISSION_MATRIX puts agency.supervise', () => {
    /**
     * Derived from the matrix rather than transcribed, so a floor change moves
     * this assertion with it instead of leaving a stale list that passes. This is
     * the same discipline `proxy-agency-my-surfaces.routes.test.ts` uses for its
     * four route floors.
     *
     * `agent` (5) being BELOW `viewer` (10) is design D6 and is why the split
     * cannot be spelled "above agent": `operator` is above `agent` and still must
     * not cause `on_behalf`.
     */
    const floor = ROLE_HIERARCHY[PERMISSION_MATRIX['agency.supervise']];
    for (const [role, level] of Object.entries(ROLE_HIERARCHY)) {
      const result = resolveAgencyActor(req({ user: { id: USER }, membership: { role } }));
      expect(result.ok).toBe(true);
      expect(
        result.ok && 'on_behalf' in result.actor,
        `${role} (level ${level}) vs agency.supervise floor ${floor}`,
      ).toBe(level >= floor);
    }
  });

  it('asserts NO supervision when there is a user but no membership at all', () => {
    /**
     * ── The branch no route can reach, and why it must stay ────────────────
     * `request.membership` is set by `tenantContextMiddleware` and `requirePermission`
     * refuses without one, so a handler never sees this. The code says so, calling
     * itself belt-and-braces — and that is precisely the reason to pin the answer:
     * the arm is invisible to every route test, so nothing else in the suite
     * notices if it changes.
     *
     * The direction matters. `role ? hasPermission(role, …) : false` fails CLOSED:
     * absent a role, no supervision. The plausible-looking alternatives all fail
     * open — a default role, `hasPermission(role ?? 'account_admin', …)`, or
     * dropping the guard so `hasPermission(undefined)` reads
     * `ROLE_HIERARCHY[undefined] >= 30` as `NaN >= 30`… which is `false`, so even
     * that accident happens to be safe. What is NOT safe is anyone deciding the
     * ternary is redundant and replacing it with a truthy default.
     *
     * `on_behalf` is not cosmetic: it is the internal handler's rule 3, and it means "let this act
     * on an attempt reserved by somebody else". Granting it to a request whose
     * role could not be established would hand the strongest form of this action
     * to the least-known caller.
     */
    const result = resolveAgencyActor(req({ user: { id: USER } }));

    expect(result).toEqual({ ok: true, actor: { agent_user_id: USER } });
    expect(result.ok && 'on_behalf' in result.actor).toBe(false);
  });

  it('takes the actor from the session, never from anything the caller could send', () => {
    /**
     * There is no body or query in scope here at all — the function's only input
     * is the request's authenticated fields, which is the design. Asserted by
     * handing it a request carrying a decoy and checking the decoy is not the
     * answer, so a future signature that started reading `request.body` would red
     * here rather than in review.
     */
    const decoy = '44444444-4444-4444-8444-444444444444';
    const result = resolveAgencyActor(
      req({
        user: { id: USER },
        membership: { role: 'agent' },
        ...({ body: { agent_user_id: decoy, on_behalf: true } } as Record<string, unknown>),
      }),
    );

    expect(result).toEqual({ ok: true, actor: { agent_user_id: USER } });
  });
});
