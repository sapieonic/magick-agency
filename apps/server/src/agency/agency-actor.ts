/*
 * PORT NOTE (magick-agency): decision #5 (no platform API keys). The API-key branch of
 * `resolveAgencyActor` and the `isPlatformApiKeyCaller` re-export are deleted: `request.user` is
 * always the Firebase-verified person, so a key can never reach this predicate. The comments
 * below describing the key history are master's, kept verbatim as the record of why the
 * `request.user?.id` guard alone was once unsafe. RBAC comes from `@magick-agency/contracts/rbac`.
 */
import type { FastifyRequest } from 'fastify';
import { hasPermission } from '@magick-agency/contracts/rbac';
import type { AgencyActionErrorCode } from '@magick-agency/contracts/errors';

/**
 * Who is performing an attempt-scoped agency action (`AD-P2-M-01`).
 *
 * Mirrors core's `AgencyActorFields` (`magic-voice-core/src/agency/contracts.ts`).
 * The two fields exist — rather than one opaque actor id — because **neither
 * service can enforce the ownership rule alone**:
 *
 *  - "is the reserved agent for this attempt" is a **core-side** fact. Master has
 *    no reservation state and cannot check it.
 *  - "holds a supervisory capability" is a **master-side** fact. Core cannot
 *    evaluate master's RBAC.
 *
 * So master asserts both and core enforces the rule against them, in this order:
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
 * Was this request authenticated by a PLATFORM API KEY rather than by a person?
 *
 * ── The check is the KEY, not the absence of a user ────────────────────────
 * "A platform API key carries a tenant and no user" was written in half a dozen
 * places in this feature and it is **false**. `sessionMiddleware`'s API-key branch
 * loads `platform_api_keys.created_by` and assigns it to `request.user`
 * (`session.middleware.ts`), so a key minted by a real person authenticates with
 * that person's `UserRecord` attached. Every guard spelled `if (!request.user?.id)`
 * therefore passed such a key straight through — and on a `my-*` route that means
 * answering with the KEY CREATOR's own scorecard, attempts or staffing history to
 * whoever holds the key. Only a key with a NULL `created_by` (a system key) was
 * ever refused, which is the shape the tests happened to model.
 *
 * `apiKeyTenantId` is set on that branch unconditionally and on no other, so it is
 * the fact that actually says "this is a key". Checked FIRST and independently of
 * `request.user`, because the two are not alternatives: a creator-backed key has
 * both.
 *
 * ── Why a key must be refused on a "my" surface at all ─────────────────────
 * A key proves which TENANT is calling and nothing about WHO — the same reasoning
 * `tenant-context.middleware.ts` gives for re-checking `X-Account-Id` on the
 * API-key branch. `created_by` records who minted the credential, once, possibly
 * years ago; it is provenance, not the identity of the caller holding it today.
 * Reading it as the actor turns a shared tenant credential into a personal one and
 * silently attributes one person's record to anybody with the string.
 */
// One definition, in `src/auth/api-key-caller.ts` — the predicate is now consulted
// from the RBAC middleware and six route files, not just this feature, so it moved
// to a neutral import-free module. Re-exported here so this module's surface is
// unchanged for its existing importers.

/**
 * Resolves the actor for an attempt-scoped action from the authenticated request.
 *
 * ── Why this refuses rather than forwarding an unattributed request ──────────
 * A disposition is the record of who said what about a customer, so there is no
 * anonymous one. Core answers 400 `missing_actor` when `agent_user_id` is absent,
 * and master can see that case coming: platform API-key auth proves a TENANT and
 * names no caller (`rbac.middleware.ts:13` waves such callers past RBAC entirely).
 * Refusing here rather than at core spends no proxy round trip and — because this
 * returns core's own `code` — gives the console one error shape to key off
 * regardless of which service refused.
 *
 * ── The key is refused on {@link isPlatformApiKeyCaller}, NOT on a missing user ─
 * The obvious spelling — `if (!request.user?.id)` — is what this used to be, and
 * it is wrong for the reason that predicate's docstring gives at length:
 * `sessionMiddleware` loads the key's `created_by` into `request.user`, so a key
 * minted by a person authenticates carrying that person. Under the old check such
 * a key did not answer `missing_actor`; it **dispositioned a customer in the key
 * creator's name**, and — since `created_by` is frequently an `account_admin` who
 * minted the credential — with `on_behalf: true` attached, which is core's rule 3
 * and bypasses the reserved-agent check entirely. The refusal is now the same for
 * every key, whoever minted it.
 *
 * ── Why `on_behalf` is decided on the capability alone ───────────────────────
 * Core's contract says master sets it "only when the caller holds
 * `agency.supervise` **and is not the reserved agent**". Master cannot evaluate
 * the second clause — that is precisely the fact it has to ask core about — so it
 * evaluates the first and lets core's rule *ordering* settle the rest: a
 * supervisor who *is* the reserved agent matches at rule 2 and never reaches
 * rule 3, so an `on_behalf` they did not need is inert. The alternative (asking
 * core who the reserved agent is, then posting) is two round trips racing a
 * reservation that can move between them.
 *
 * An `agent` (D6 level 5) can never cause `on_behalf` to be set: `agency.supervise`
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
  // No membership means RBAC already refused (or the caller is an API key, handled
  // above), so this is belt-and-braces: absent a role we assert no supervision.
  const supervises = role ? hasPermission(role, 'agency.supervise') : false;

  return {
    ok: true,
    // `on_behalf` is omitted rather than sent as `false` when the caller is not a
    // supervisor, matching the contract's "master sets this only when…" wording.
    actor: supervises ? { agent_user_id: userId, on_behalf: true } : { agent_user_id: userId },
  };
}
