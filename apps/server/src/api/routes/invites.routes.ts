import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../../config/index.js';
import { verifyIdToken } from '../../auth/firebase.js';
import { sessionMiddleware, invalidateUserCache } from '../../auth/session.middleware.js';
import { tenantContextMiddleware } from '../middleware/tenant-context.middleware.js';
import { requirePermission } from '../../rbac/rbac.middleware.js';
import { canManageRole } from '@magick-agency/contracts/rbac';
import { buildSessionPayload } from '../../auth/session-payload.js';
import {
  LiveInviteConflictError,
  membershipInviteRepository,
} from '../../db/repositories/membership-invite.repository.js';
import { membershipRepository } from '@magick-agency/db/repositories/membership.repository';
import { tenantRepository } from '@magick-agency/db/repositories/tenant.repository';
import { userRepository } from '@magick-agency/db/repositories/user.repository';
import { redisCache } from '../../cache/redis-cache.js';
import { hashInviteToken, isInviteExpired } from '../../notifications/invite-token.js';
import { agencyProductName } from '../../notifications/templates/agent-invite.template.js';
import { issueInvite } from '../../invites/invite-issuer.js';
import { claimInviteSchema, resendInviteSchema } from '../validators/invite.validator.js';
import { platformAuditLogger } from '../../audit/platform/audit-logger.js';
import { requestAuditActor, resolvedUserAuditActor } from '../../audit/platform/audit-actor.js';
import {
  inviteClaimsTotal,
  type InviteClaimResult,
} from '@magick-agency/observability/metrics/platform';
import { createChildLogger } from '@magick-agency/observability';
import type { MembershipInviteRecord } from '../../db/models/membership-invite.model.js';
import type { MembershipRole } from '@magick-agency/db/models/membership.model';

const log = createChildLogger({ component: 'invite-routes' });

/**
 * `/invites` — the token-bound invitation claim flow.
 *
 * ── The two GET/POST routes are PUBLIC, and that is the entire point ────────
 * There is no `sessionMiddleware` and no `tenantContextMiddleware` on this
 * plugin. There cannot be: the caller is somebody who has **no account, no
 * session and no tenant** — that is the state an invitation exists to end. The
 * token IS the credential, and it is the only one available at this moment.
 *
 * Consequences that are easy to get wrong, and each is handled below:
 *
 *  - **No `request.tenantId`.** Every lookup here derives its tenant from the
 *    INVITE ROW, never from a header. A header on this plugin would be an
 *    unauthenticated caller nominating which tenant to act in.
 *  - **No RBAC.** The token's authority is bounded by exactly one thing: the
 *    membership it names. It cannot grant anything else, because nothing here
 *    reads a role from the request.
 *  - **Rate limits are the only abuse control.** See {@link PUBLIC_INVITE_RATE_LIMIT}.
 *
 * `POST /invites/resend` is the exception and carries its own full auth chain as
 * per-route `preHandler`s rather than plugin-wide hooks. It lives in this file
 * anyway because it is the same subject — it revokes and re-mints the tokens the
 * two public routes read — and splitting it into `user.routes.ts` would put the
 * revoke/mint rule two files away from the claim rule it has to agree with.
 *
 * ── Registered at `/invites`, with NO `/api` prefix ────────────────────────
 * There is no global prefix, so the console composes these as
 * `${API_BASE}/invites/...`. The join link the email carries points at the
 * console's `/agency/join/:token` page, which is a page and not these endpoints —
 * the page then calls them. Confusing the two produces a link that 404s in a
 * browser and an endpoint nothing reaches.
 *
 * ── Why a claim can never provision anything ───────────────────────────────
 * `POST /auth/session` path 4 refuses an identity it does not recognise rather
 * than provisioning one, and a claim must not become a second way in that does:
 * an invited agent who landed in a private empty tenant of their own would leave
 * the membership somebody made for them sitting unclaimed.
 *
 * The claim route below therefore resolves its user through
 * `invite.membership_id → memberships.user_id` and calls NOTHING that
 * provisions. There is no branch here that can create a tenant, an account or a
 * credit row, and `test/unit/api/routes/invites.routes.test.ts` asserts that as
 * a property rather than trusting the reading.
 */

/**
 * The dedicated IP bucket for the two unauthenticated routes.
 *
 * ── Why the global limit is not enough ─────────────────────────────────────
 * `registerRateLimit` keys on `request.ip` with one shared `max` across every
 * route in the service (`RATE_LIMIT_MAX`, calibrated for ordinary authenticated
 * traffic). These two routes need a much tighter one for a reason none of the
 * others have: **they are the only endpoints in this service where an
 * unauthenticated caller can probe a credential.** `GET /invites/:token` reports
 * whether a token exists and what it is for; a wide-open version of it is an
 * offline-free oracle for walking the token space.
 *
 * The token itself is 256 bits from a CSPRNG, so walking it is not actually
 * feasible — the bucket is defence in depth, and its more realistic job is the
 * mundane one: the claim route calls Firebase's token verification on every
 * request, so an uncapped POST turns an unauthenticated endpoint into an
 * outbound-request amplifier against a third party we are rate-limited by.
 *
 * 20/minute per IP is deliberately generous for a human (the claim page makes
 * one GET and one POST) and deliberately useless for enumeration. It is applied
 * per-route through `@fastify/rate-limit`'s route `config`, the same mechanism
 * `POST /super-admin/login` uses.
 *
 * Note it is NOT applied to `POST /invites/resend`: that route is authenticated,
 * RBAC-gated at `user.invite`, and tenant-scoped, so the global bucket plus
 * those three gates is the same posture every other authenticated write has.
 *
 * ── Always live ────────────────────────────────────────────────────────────
 * There is no switch that turns rate limiting off: `registerRateLimit` is always
 * registered, at app scope in `app.ts`, so this bucket is always live. These route
 * configs inherit the limiter's IP `keyGenerator` (`rate-limit.app-scope.test.ts`
 * pins 20/minute per IP).
 */
const PUBLIC_INVITE_RATE_LIMIT = {
  rateLimit: {
    max: 20,
    timeWindow: '1 minute',
    keyGenerator: (request: FastifyRequest) => request.ip,
  },
} as const;

/**
 * What state an invitation is in, from a reader's point of view.
 *
 * Four values, and the distinctions are the product: a person holding a link
 * that does not work needs to know WHICH kind of not-working it is, because the
 * remedy differs every time — sign in (`claimed`), ask for a new one
 * (`expired`), check your inbox for a newer mail (`revoked`), or check you
 * copied the whole link (`not_found`). A single "invalid" collapses four
 * different next steps into a dead end.
 */
type InviteStatus = 'pending' | 'claimed' | 'expired' | 'revoked';

/**
 * Read the state of an invite row.
 *
 * ── The precedence is REVOKED, then CLAIMED, then EXPIRED ──────────────────
 * The three are not mutually exclusive on a row — a claimed invite also passes
 * its expiry eventually, and a resend can revoke one that was already expired —
 * so the order decides what a reader is told, and each position is a decision:
 *
 *  - `revoked` first because it is the only one with a live next step attached
 *    ("a newer invitation was sent"). Telling somebody their link expired when a
 *    working one is sitting in their inbox sends them to their supervisor
 *    instead of to their mail.
 *  - `claimed` next because it is terminal and unambiguous: the membership is
 *    already bound, and the answer is "sign in", not "ask again".
 *  - `expired` last, since it is the only one that is a function of the clock
 *    rather than of something somebody did.
 *
 * Shared by the GET and the claim so the page a person is reading and the
 * request its button makes cannot disagree.
 *
 * ── What it CANNOT see, and why both callers read the membership too ───────
 * This function is a pure read of the invite row. Whether the MEMBERSHIP the
 * invite names is still active lives in another table that offboarding revokes
 * without touching this one — so "shared function, therefore no disagreement"
 * was only ever true of the three columns below. Both routes make the same
 * tenant-scoped `findByIdInTenant` read and both answer `revoked` on a miss;
 * that pair is what actually makes the page and its button agree, and dropping
 * it from either side reopens a `pending` page whose claim answers 409.
 */
function inviteStatus(invite: MembershipInviteRecord): InviteStatus {
  if (invite.revoked_at) return 'revoked';
  if (invite.claimed_at) return 'claimed';
  if (isInviteExpired(new Date(invite.expires_at))) return 'expired';
  return 'pending';
}

/**
 * The product an invitation is for, as the claim page's heading.
 *
 * Composed the same way the email composes it, from the same function, so the
 * page and the mail that led to it name the same thing. A non-`agent` role
 * cannot reach here today (no row is written for one — see `invite-issuer.ts`),
 * and the branch is written rather than assumed so the widening is one line.
 */
function inviteProductName(role: MembershipRole): string {
  return role === 'agent' ? agencyProductName(config.brand.name) : config.brand.name;
}

/**
 * The one place a claim outcome is counted.
 *
 * `InviteClaimResult` rather than `string`, so the "closed enum" the metric's
 * docstring promises is a compiler guarantee instead of a comment. A new refusal
 * arm added here without a line in that enum stops the build, which is the only
 * mechanism that keeps a label list and a dashboard from drifting apart —
 * `identity_already_bound` shipped unlisted for exactly as long as the parameter
 * was a bare string.
 */
function countClaim(result: InviteClaimResult): void {
  inviteClaimsTotal.inc({ result });
}

/**
 * The ONE external body both address-shaped identity refusals answer with.
 *
 * ── Why `cross_tenant_identity` does not get its own wire status ───────────
 * It fires exactly when the invited row holds an active membership in a tenant
 * that is not this invitation's. Reporting that distinctly turns this route
 * into a membership oracle: anyone can sign up (path 4 makes every signup a
 * `tenant_owner`), invite an arbitrary address into their OWN tenant, claim
 * their own link, and read the answer — a distinct status means "this address
 * is a member somewhere else", a success means it is not. That is a
 * platform-wide customer-enumeration primitive, and this work exists to close a
 * takeover rather than to trade it for one.
 *
 * So the distinction is kept where it is useful and cannot be probed — the
 * `warn` log naming the tenant and membership, and `invite_claims_total`'s
 * label — and dropped from the response. `identity_already_bound` already
 * answered the neighbouring question, so collapsing into it adds no signal that
 * was not there before; the combined answer is strictly vaguer than either arm
 * was alone.
 *
 * The copy has to be true of both, and is: in both cases this link cannot bind
 * the identity presenting it, and in both the remedy is the address the
 * invitation was sent to. `identity_in_use` is deliberately NOT folded in — it
 * is about the CALLER's own Firebase account already being another user here,
 * which the caller can see for themselves and which says nothing about the
 * invited address.
 */
const BOUND_ADDRESS_CONFLICT = {
  error: 'Conflict',
  message:
    'This invitation is already set up for a different sign-in. Sign in with the '
    + 'invited email address, or ask whoever invited you for a new invitation.',
  status: 'identity_already_bound',
} as const;

export async function inviteRoutes(app: FastifyInstance): Promise<void> {
  /**
   * GET /invites/:token — what is this invitation? (PUBLIC)
   *
   * Rendered by the console's `/agency/join/:token` page before any sign-in, so the
   * recipient can see who invited them and to what before they hand over an
   * identity. That is not decoration: an invitation that asks somebody to
   * authenticate without first saying what they are joining is indistinguishable
   * from a phishing mail, and this is the one page in the product that a person
   * reaches by clicking a link in an email.
   *
   * ── What it discloses, and why that is the right amount ────────────────────
   * The invited ADDRESS, the role, the tenant name, the inviter's display name
   * and the expiry — to a caller who already holds a 256-bit token that was
   * mailed to that address. Nothing here is reachable without it, and every
   * field is something the recipient needs in order to recognise the invitation
   * as genuine. Deliberately NOT disclosed: the membership id, the account, the
   * user id, or anything about the tenant beyond its name.
   *
   * A miss is 404 with a `status`; a non-pending invite is **200** with a
   * `status` and no `invite` object. The split is deliberate — 200 means "this
   * token is real and here is its state", which is exactly what a page needs in
   * order to render a useful message, and 404 means "no such token", which is
   * also what a mistyped link produces.
   *
   * "Non-pending" includes an invite whose MEMBERSHIP has been revoked, which
   * `inviteStatus` cannot see: the read below is the same one the claim makes,
   * and it is what stops this page rendering an invitation whose button already
   * answers 409.
   *
   * ── One state this page deliberately does NOT anticipate ──────────────────
   * A `users` row that is a stub SEVERAL workspaces are waiting on renders as
   * `pending` here and is refused `cross_tenant_identity` by the claim (see
   * `AdoptIdentityOptions.confineStubToTenantId`). That is the disagreement the
   * membership read above exists to remove, and it is tolerated here for a
   * reason the membership case does not have: answering it would tell whoever
   * holds the token — including the attacker this refusal exists for, who minted
   * their own invitation — that the address is known to another workspace. That
   * is an oracle, on an unauthenticated route, for the one question the guard is
   * about. The cost is one wasted click for the honest case, whose remedy (sign
   * in with the invited address) the 409's own message names.
   *
   * Do not read "honest case" as "rare". `memberships.status` defaults to
   * `active` and `membershipRepository.create` does not override it, so merely
   * INVITING an address makes it an active member — no claim required. Anyone
   * who can sign up can therefore put any address into this state on demand,
   * which blocks token-claims for it in every other workspace until the person
   * proves the address through `POST /auth/session`. That is a nuisance rather
   * than a lockout (path 2 has no confinement and is entitled to activate the
   * shared stub), and it is inherent to confining at the bind: an
   * attacker-planted membership and a legitimate one are the same row. Worth
   * knowing before anyone reasons about how often this 409 should appear.
   */
  app.get<{ Params: { token: string } }>('/:token', {
    config: PUBLIC_INVITE_RATE_LIMIT,
  }, async (request: FastifyRequest<{ Params: { token: string } }>, reply: FastifyReply) => {
    const invite = await membershipInviteRepository.findByTokenHash(
      hashInviteToken(request.params.token),
    );
    if (!invite) return reply.code(404).send({ status: 'not_found' });

    const status = inviteStatus(invite);
    if (status !== 'pending') return reply.send({ status });

    /**
     * The SAME tenant-scoped membership read the claim does, and the GET has to
     * do it too — this is the one axis on which the two could disagree.
     *
     * `inviteStatus` reads the invite row and nothing else, and offboarding
     * (`DELETE /users/:id/membership`) sets `memberships.status = 'revoked'`
     * while touching nothing in `membership_invites`. So a recipient whose
     * membership had been revoked was answered `200 { status: 'pending', invite:
     * {...} }` here — the page rendered, the button worked — and then a 409 from
     * the claim saying "a newer one may have been sent. Check your inbox". That
     * is the wrong remedy pointed at the wrong person: nobody resent anything,
     * they were removed, and the newer mail they are told to look for does not
     * exist.
     *
     * It also stops the page being readable at all in that state. Without this,
     * an unauthenticated holder of a leftover token keeps reading the tenant
     * name and the inviter's display name for a workspace somebody removed them
     * from, for as long as the token has left to live.
     *
     * `revoked` rather than a fourth status, and with NO `invite` object,
     * matching the claim's own answer: the invitation is genuinely no longer
     * valid, and the two endpoints must not describe one row two ways.
     */
    const membership = await membershipRepository.findByIdInTenant(
      invite.membership_id,
      invite.tenant_id,
    );
    if (!membership) {
      return reply.send({ status: 'revoked' satisfies InviteStatus });
    }

    // Resolved separately rather than joined, because neither lookup may fail the
    // page: `inviter_name` is typed `string | null` on the contract for exactly
    // this reason, and `tenant_name` answers `null` rather than inventing a name
    // or leaking the raw tenant UUID at an unauthenticated caller. The page reads
    // as a thinner invitation, not a broken one — which is the right trade, since
    // the LINK is the payload and this copy is what surrounds it.
    const [tenant, inviter] = await Promise.all([
      tenantRepository.findById(invite.tenant_id),
      invite.invited_by ? userRepository.findById(invite.invited_by) : Promise.resolve(null),
    ]);

    return reply.send({
      status: 'pending',
      invite: {
        email: invite.email,
        role: invite.role,
        tenant_name: tenant?.name ?? null,
        // `display_name` only, never the address: naming a supervisor's email to
        // somebody who is not yet a member of anything would disclose it outside
        // the tenant.
        inviter_name: inviter?.display_name ?? null,
        product_name: inviteProductName(invite.role),
        expires_at: invite.expires_at,
      },
    });
  });

  /**
   * POST /invites/:token/claim — bind this Firebase identity to the membership.
   * (PUBLIC)
   *
   * Answers **exactly** the body `POST /auth/session` returns on success —
   * `{ user, tenants, memberships, settings, is_new: false }`, built by the
   * shared `buildSessionPayload` — so the console reuses its existing
   * `SessionResponse` type as it is and the claimed agent is simply signed in.
   * A second response type for this one screen is a second thing to keep in step
   * with a login flow that will keep changing.
   *
   * ── The user is resolved by MEMBERSHIP, never by email ─────────────────────
   * `invite.membership_id → memberships.user_id`. `users.email` carries only a
   * non-unique index, so an email lookup is not
   * even a unique operation — the by-address lookups have to pick one of
   * several possible rows, and they each do so by an
   * explicit rule (`findByEmail` orders the unflagged row first,
   * `findByProvenEmail` refuses flagged rows) rather than taking whichever row
   * Postgres hands back. Matching on the address is precisely the mechanism
   * whose failure this feature exists to remove.
   *
   * ── An UNVERIFIED Firebase email still BINDS, but no longer names the row ──
   * `decoded.email_verified` is deliberately not required for the bind: the
   * token's authority is over the MEMBERSHIP, and requiring verification as well
   * would block a legitimate agent behind a verification mail — the common shape
   * of that block being an email/password Firebase account created on this very
   * page seconds earlier, which has not been verified yet by construction.
   *
   * What the old reasoning got wrong is the ADDRESS. It ran: verification proves
   * the person controls that inbox, and possession of a token delivered to that
   * inbox proves the same thing one step earlier. True only while the INVITER is
   * somebody else — and `POST /users/invite` returns the raw join link in its own
   * 201 body, so an attacker can register an unverified Firebase account for
   * `victim@corp.test`, invite that address into their own tenant as an `agent`,
   * and claim their own link. `adoptEmail` then keyed a signed-in row under an
   * address they do not control, and `users.email` is the lookup for
   * `POST /users/invite` and both super-admin provisioning paths.
   *
   * So an unverified claim adopts NO address and marks the row
   * `users.email_unverified`, which bars it from being reused by address while
   * leaving it an ordinary account. See `AdoptIdentityOptions.adoptEmail`,
   * `userRepository.findByProvenEmail`.
   *
   * ── A DIFFERENT address still binds, and the mismatch is AUDITED ───────────
   * When the addresses differ, the claim proceeds: the token is the authority,
   * and the person who received the mail is entitled to use whatever identity
   * they have. Refusing here would recreate the original defect one layer up —
   * an agent whose only Google account is personal would be locked out exactly
   * as they were before.
   *
   * What that costs is that `memberships` and `users` afterwards contain no
   * trace of the discrepancy: the row simply names an identity. So the mismatch
   * is written into `platform_audit_log` (`email_matched: false`, with both
   * addresses), which is the only place the question "who actually walked
   * through this door" can be answered later. That row is not optional
   * bookkeeping — it is the compensating control that makes accepting the
   * mismatch safe.
   *
   * ── It never provisions ───────────────────────────────────────────────────
   * Nothing on this path creates a tenant, an account or a membership. See the
   * module header.
   */
  app.post<{ Params: { token: string } }>('/:token/claim', {
    config: PUBLIC_INVITE_RATE_LIMIT,
  }, async (request: FastifyRequest<{ Params: { token: string } }>, reply: FastifyReply) => {
    const parsed = claimInviteSchema.safeParse(request.body);
    if (!parsed.success) {
      countClaim('bad_request');
      return reply.code(400).send({ error: 'Bad Request', details: parsed.error.issues });
    }

    /**
     * The invite is looked up BEFORE the Firebase token is verified, and the
     * order is deliberate rather than incidental.
     *
     * Verification is an outbound call to a third party; the lookup is one
     * indexed equality on this database. Verifying first would make every
     * request carrying a junk token — the ones a scanner produces — into an
     * outbound request against a service we are rate-limited by, on an
     * unauthenticated endpoint. Nothing is disclosed by the reversed order that
     * `GET /invites/:token` does not already disclose to the same caller, and
     * both are behind the same IP bucket.
     */
    const invite = await membershipInviteRepository.findByTokenHash(
      hashInviteToken(request.params.token),
    );
    if (!invite) {
      countClaim('not_found');
      return reply.code(404).send({ status: 'not_found' });
    }

    const status = inviteStatus(invite);
    if (status !== 'pending') {
      countClaim(status === 'claimed' ? 'already_claimed' : status);
      return reply.code(409).send({
        error: 'Conflict',
        message: INVITE_CONFLICT_MESSAGES[status],
        status,
      });
    }

    let decoded;
    try {
      decoded = await verifyIdToken(parsed.data.id_token);
    } catch (err) {
      // Deliberately opaque, and deliberately not distinguished from an expired
      // one: on a public endpoint the difference between "malformed" and
      // "expired" is only useful to somebody testing tokens. The real detail is
      // in the log.
      log.warn({ err, inviteId: invite.id }, 'Invite claim rejected: Firebase token invalid');
      countClaim('unauthorized');
      return reply.code(401).send({ error: 'Unauthorized', message: 'Invalid or expired sign-in token' });
    }

    /**
     * The membership, read TENANT-SCOPED off the INVITE's own `tenant_id` — the
     * boundary in the same statement as the lookup, never in an `if` downstream
     * of it, so a row that has somehow been re-pointed cannot carry a claim into
     * a different tenant.
     *
     * It is also the offboarding check. `findByIdInTenant` matches only
     * `status = 'active'`, and `DELETE /users/:id/membership` revokes rather than
     * deletes while touching nothing in this table — so without this read, an
     * invitation for somebody who was removed between the invite and the claim
     * would bind an identity to a membership that grants nothing. Answered as
     * `revoked`, which is true of the invitation as much as of the membership and
     * is the one message the recipient can act on.
     */
    const membership = await membershipRepository.findByIdInTenant(
      invite.membership_id,
      invite.tenant_id,
    );
    if (!membership) {
      countClaim('revoked');
      return reply.code(409).send({
        error: 'Conflict',
        message: INVITE_CONFLICT_MESSAGES.revoked,
        status: 'revoked' satisfies InviteStatus,
      });
    }

    /**
     * Read BEFORE the bind, for one reason: `invalidateUserCache` needs the
     * user's OLD `firebase_uid` to evict `cache:user:fb:<uid>`.
     *
     * That key is keyed on the value the row carried a moment ago — for a stub
     * that is `pending_<uuid>` — and nothing else in this service will ever evict
     * it, because nothing else will ever look a user up by a `pending_` uid
     * again. Reading the row after the bind gives the NEW uid and leaves the old
     * key behind forever; `sessionMiddleware` caches for 20 minutes, so the
     * consequence is bounded but real.
     */
    const beforeBind = await userRepository.findById(membership.user_id);

    const claimed = await membershipInviteRepository.claimWithIdentity({
      inviteId: invite.id,
      userId: membership.user_id,
      /**
       * The INVITE's tenant, not the membership's — they are the same value
       * (the membership was read tenant-scoped off exactly this column), and
       * naming the invite is what says which of the two is the authority. It
       * is what the bind is confined to: a claim may activate the workspace its
       * token names and no other. See
       * `AdoptIdentityOptions.confineStubToTenantId`.
       */
      tenantId: invite.tenant_id,
      identity: decoded,
    });

    if (!claimed.ok && claimed.reason === 'already_claimed') {
      // The loser of a concurrent double-claim. Exactly one caller can win the
      // conditional UPDATE — see the repository.
      countClaim('already_claimed');
      return reply.code(409).send({
        error: 'Conflict',
        message: INVITE_CONFLICT_MESSAGES.claimed,
        status: 'claimed' satisfies InviteStatus,
      });
    }

    if (!claimed.ok && claimed.reason === 'expired') {
      /**
       * The token's TTL lapsed between this handler's `inviteStatus` check and
       * the conditional UPDATE — across `verifyIdToken`, an outbound call to
       * Firebase, and the membership read.
       *
       * The check above is what answers the ordinary expired link; this arm
       * exists because that check cannot be the one that DECIDES. Expiry is the
       * only one of the three refusals that arrives with nobody acting, so a
       * JavaScript read taken two awaits earlier is exactly the wrong place to
       * hold it — `expires_at > NOW()` is in the statement beside
       * `claimed_at IS NULL` for the same reason that predicate is.
       */
      countClaim('expired');
      return reply.code(409).send({
        error: 'Conflict',
        message: INVITE_CONFLICT_MESSAGES.expired,
        status: 'expired' satisfies InviteStatus,
      });
    }

    if (!claimed.ok && claimed.reason === 'revoked') {
      /**
       * A `POST /invites/resend` revoked this token between the read at the top
       * of this handler and the write just above.
       *
       * Reported as `revoked` rather than folded into the arm above: the
       * repository says which half of `claimed_at IS NULL AND revoked_at IS NULL`
       * failed, so a superseded link is not answered *"This invitation has
       * already been used. Sign in to continue"* — advice that would be wrong
       * twice over for somebody who has no account yet and a working link
       * already in their inbox. `InviteStatus` carries four values because these
       * remedies differ; this race is the one that reaches the third.
       */
      countClaim('revoked');
      return reply.code(409).send({
        error: 'Conflict',
        message: INVITE_CONFLICT_MESSAGES.revoked,
        status: 'revoked' satisfies InviteStatus,
      });
    }

    if (!claimed.ok && claimed.reason === 'identity_already_bound') {
      /**
       * The membership's user row is already bound to a real Firebase account
       * that is NOT the one claiming, so this claim would rebind an account
       * somebody else can already sign in as. Refused inside the UPDATE's
       * `WHERE` — see {@link AdoptIdentityOptions}.
       *
       * ── Narrower than it reads, and the difference is the whole fix ────────
       * An invitee who already has a login here and claims with THAT identity
       * does not arrive here at all: the bind predicate admits a row already
       * carrying the incoming uid, spends the invitation and signs them in. Only
       * a claim against somebody ELSE's identity lands on this arm. The ordinary
       * "add an agent who already has a login" invite does not, so this sentence
       * never reaches the very person the mail was addressed to.
       *
       * Two situations still arrive here and the response cannot tell them
       * apart, so the message speaks only to the honest one:
       *
       *  - The invitee has two Firebase accounts and is claiming with the one
       *    the row does not name — the remedy is to sign in with the other, or
       *    to have the invitation reissued to the address they actually use.
       *  - Somebody is attempting to take an account over by inviting an address
       *    they do not control and claiming the token themselves. Telling them
       *    anything more specific would confirm that the address has an account.
       *
       * Logged at `warn` with the membership, because the second reading is worth
       * being able to find: a burst of these against different memberships in one
       * tenant is the signature of the takeover attempt, not of ordinary use —
       * and it is a cleaner signal than it was, now that the commonest honest
       * case no longer lands here.
       *
       * The invitation is left OUTSTANDING (the repository rolled the claim
       * back). For the honest reading nothing needs spending; for the hostile one
       * burning the link would let an attacker deny a real invitee their invite.
       */
      log.warn(
        {
          inviteId: invite.id,
          tenantId: invite.tenant_id,
          membershipId: invite.membership_id,
        },
        'Invite claim refused: the invited user row is bound to a different Firebase account',
      );
      countClaim('identity_already_bound');
      return reply.code(409).send(BOUND_ADDRESS_CONFLICT);
    }

    if (!claimed.ok && claimed.reason === 'cross_tenant_identity') {
      /**
       * The invited `users` row is a STUB that is ALSO another workspace's
       * pending member, so binding an identity to it would sign the claimant
       * into a tenant this invitation says nothing about.
       *
       * ── Why this is not `identity_already_bound` in another coat ───────────
       * That arm fires when the row is already SOMEBODY's and the claimant is
       * not them. This one fires when the row is still nobody's — which is
       * precisely why `onlyUnclaimedStub` admits it, and precisely what made the
       * takeover work: `POST /users/invite` reuses a `users` row whenever the
       * address is already known, so an attacker who invites a still-unclaimed
       * address into their OWN tenant as an `agent` is handed a live token for
       * somebody else's pending owner row, and `buildSessionPayload` lists every
       * active membership on it. `AdoptIdentityOptions.confineStubToTenantId`
       * carries the chain in full.
       *
       * ── The honest reading, and why the message points at signing in ───────
       * Two workspaces can legitimately invite one address before anybody has
       * signed in — a consultant joining two customers in the same week. The
       * remedy for them is the path that proves the ADDRESS rather than the one
       * that proves a token: `POST /auth/session` requires a VERIFIED Firebase
       * email (`sessionLinkEmail`) and is therefore entitled to activate the
       * shared stub across every tenant waiting on it, which is the outcome they
       * actually want. So the message says sign in, not resend — a resend mints
       * a new token against the same row and lands here again.
       *
       * ── What this refusal DOES disclose, stated plainly ───────────────────
       * The prose is careful not to say that the address is known to another
       * workspace — but `status: 'cross_tenant_identity'` is a machine-readable
       * name for exactly that fact, and so is the metric label. Anyone who can
       * sign up (which is everyone) can invite an arbitrary address into their
       * own tenant, claim their own link, and read the discriminator: this arm
       * means the address holds an active membership in some tenant that is not
       * theirs; a success means it does not. That is a platform-wide
       * customer-enumeration oracle and it should not be described as absent.
       *
       * Kept anyway, deliberately. Collapsing the wire `status` alone closes
       * nothing, because the message text differs too; closing it properly means
       * making this arm byte-identical to another, which hands the honest
       * consultant above the wrong remedy for a state they hit through no fault
       * of their own. The bounds that make that trade defensible: each probe
       * costs an invite in the attacker's own tenant (audited, and visible in
       * their own member list), the public claim route is on its own 20/minute
       * IP bucket, `identity_already_bound` has answered the neighbouring
       * question since before this guard existed, and the alternative to
       * refusing at all is the takeover this arm exists to stop. Revisit if the
       * invite surface ever becomes cheaper to drive than it is today.
       *
       * Logged at `warn` with the tenant and membership, because the hostile
       * reading is the one worth being able to find: this is a cleaner takeover
       * signal than `identity_already_bound`, which the ordinary two-Firebase-
       * accounts case also reaches.
       *
       * The invitation is left OUTSTANDING (the repository rolled the claim
       * back) — same reasoning as the other two identity arms: on the honest
       * reading nothing needs spending, and on the hostile one burning the link
       * would let an attacker deny a real invitee their invitation.
       */
      log.warn(
        {
          inviteId: invite.id,
          tenantId: invite.tenant_id,
          membershipId: invite.membership_id,
        },
        'Invite claim refused: the invited user row is also pending in another tenant',
      );
      countClaim('cross_tenant_identity');
      // Same body as `identity_already_bound` — deliberately. See
      // BOUND_ADDRESS_CONFLICT.
      return reply.code(409).send(BOUND_ADDRESS_CONFLICT);
    }

    if (!claimed.ok) {
      /**
       * `identity_in_use` — the Firebase account already belongs to a DIFFERENT
       * `users` row here, so binding it would violate `users.firebase_uid`'s
       * unique constraint.
       *
       * Reachable precisely because the mismatched-address case is allowed: a
       * person claiming with a personal Google account that already has its own
       * workspace on this platform produces exactly this state. The invitation
       * is deliberately left OUTSTANDING (the repository's transaction rolled
       * the claim back), because the remedy is for them to sign in with the
       * other identity or for a supervisor to invite that address instead —
       * neither of which is helped by burning the link.
       *
       * One of the `status` values beyond the four `InviteStatus` carries
       * (`identity_already_bound`, `identity_in_use`, `cross_tenant_identity`),
       * and they are a deliberate addition: the alternative was a masked 500
       * ("contact support and quote this request id") for a state the person
       * can resolve in one action. A client that only knows the four renders
       * its generic conflict message, which is a strictly better outcome than
       * the mask.
       */
      log.warn(
        { inviteId: invite.id, tenantId: invite.tenant_id },
        'Invite claim refused: that Firebase identity is already bound to another user',
      );
      countClaim('identity_in_use');
      return reply.code(409).send({
        error: 'Conflict',
        message:
          'That sign-in already belongs to a different account here. Sign in with it directly, '
          + 'or ask for an invitation to be sent to that address.',
        status: 'identity_in_use',
      });
    }

    const user = claimed.user;

    /**
     * Both caches, and the second one is easy to forget.
     *
     * `invalidateUserCache` drops `cache:user:id:` and `cache:user:fb:<OLD uid>`
     * — the old uid, because the row was keyed under `pending_<uuid>` until a
     * moment ago and nothing else will ever evict that key.
     *
     * `cache:membership:<user>:<tenant>` is the key `tenantContextMiddleware`
     * reads to resolve a caller's role, and `POST /users/invite` drops it for
     * the same reason: the membership row existed before this request and may
     * already be cached against a user whose identity has just changed
     * underneath it.
     */
    await invalidateUserCache(user.id, beforeBind?.firebase_uid ?? null);
    await redisCache.del(`cache:membership:${user.id}:${invite.tenant_id}`);

    const emailMatched = normaliseEmail(decoded.email) === normaliseEmail(invite.email);

    platformAuditLogger.log({
      tenant_id: invite.tenant_id,
      ...(membership.account_id ? { account_id: membership.account_id } : {}),
      // The actor is the CLAIMANT, resolved from the invite — `request.user` does
      // not exist on a public route, so this is the one audited write in the
      // service whose principal was established by a token rather than by
      // `sessionMiddleware`.
      //
      // `resolvedUserAuditActor` rather than a bare `actor_type: 'human'`
      // literal, and that is not ceremony: an asserted literal is exactly the
      // shape `test/unit/audit/audit-actor-call-sites.test.ts` refuses, because
      // it compiles while being wrong. It also keeps the key check in front of
      // this row — an API key cannot reach this handler today (no middleware
      // sets `apiKeyTenantId` here), and if one ever could this degrades to an
      // honest `api_key` row instead of stamping a claimant that is not one.
      ...resolvedUserAuditActor(request, user.id),
      action: 'user.invite_claimed',
      resource_type: 'membership_invite',
      resource_id: invite.id,
      details: {
        membership_id: membership.id,
        role: invite.role,
        /**
         * The compensating control for accepting a mismatched address — see the
         * route docstring. Both addresses are recorded, not just the flag: "the
         * addresses differed" without saying WHICH one arrived is unanswerable
         * in the dispute this row exists for, and the claimant's address is
         * already stored on `users.email` for the same person.
         */
        email_matched: emailMatched,
        invited_email: invite.email,
        claimed_email: decoded.email ?? null,
        firebase_email_verified: decoded.email_verified ?? false,
      },
      ip_address: request.ip,
    });

    countClaim('claimed');
    log.info(
      { inviteId: invite.id, tenantId: invite.tenant_id, userId: user.id, emailMatched },
      'Invitation claimed',
    );

    return reply.send(await buildSessionPayload(user, user.id));
  });

  /**
   * POST /invites/resend — revoke the outstanding tokens and issue a new one.
   *
   * ── Authenticated, unlike the two routes above ────────────────────────────
   * Full chain as per-route `preHandler`s, because this plugin has no
   * plugin-wide auth hooks (it cannot — see the module header) and this route
   * must not inherit their absence. `sessionMiddleware` → `tenantContextMiddleware`
   * → `requirePermission('user.invite')`, which is the same chain
   * `POST /users/invite` runs, because it is the same act: it mints a credential
   * that binds an identity to a membership.
   *
   * ── Tenant-scoped in the STATEMENT, not in an `if` ────────────────────────
   * `membership_id` is caller-supplied. The membership is fetched through a
   * tenant-scoped lookup, so a membership in another tenant and a nonexistent
   * one are one `null` and one 404 — indistinguishable, by construction rather
   * than by a convention somebody has to maintain.
   *
   * ── Role-gated on the TARGET membership's role ────────────────────────────
   * `canManageRole`, mirroring `POST /users/invite`'s check on the role it is
   * about to create — a caller must not be able to mint a binding credential for
   * a membership they could not have handed out. See the check itself for why it
   * answers 403 where the two lookups above answer 404.
   *
   * ── Revoke, THEN mint — in ONE transaction, one layer down ────────────────
   * Both halves happen inside
   * `membershipInviteRepository.createSupersedingOutstanding`, reached through
   * `issueInvite`. Revoking on its own connection and then inserting would let
   * two concurrent resends both revoke before either inserted — leaving two live
   * links, which is the one thing a resend exists to prevent. The
   * partial unique index is the half that holds when the transaction alone
   * cannot (see the repository method), and its refusal reaches this route as
   * `LiveInviteConflictError`.
   *
   * A recipient holding the superseded mail gets `revoked` from
   * `GET /invites/:token` — "a newer invitation was sent" — rather than a link
   * that silently binds them from a stale email.
   */
  app.post('/resend', {
    preHandler: [
      sessionMiddleware,
      tenantContextMiddleware,
      requirePermission('user.invite'),
    ],
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = resendInviteSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Bad Request', details: parsed.error.issues });
    }

    const membership = await membershipRepository.findByIdInTenant(
      parsed.data.membership_id,
      request.tenantId!,
    );
    if (!membership) {
      return reply.code(404).send({ error: 'Not Found', message: 'Membership not found' });
    }

    /**
     * An account-scoped caller may only resend for a membership in THEIR OWN
     * account — the same check `POST /users/invite` applies to the account it is
     * invited into, and for the same reason: `requirePermission` proves the
     * caller's ROLE and never looks at which account their own membership is
     * scoped to. 404 rather than 403, matching the cross-tenant answer above, so
     * a sibling account's membership id and a nonexistent one stay
     * indistinguishable.
     */
    const callerAccountId = request.membership?.account_id ?? null;
    if (callerAccountId !== null && membership.account_id !== callerAccountId) {
      return reply.code(404).send({ error: 'Not Found', message: 'Membership not found' });
    }

    /**
     * The caller must be able to have CREATED this membership's role, exactly as
     * `POST /users/invite` requires before it writes one.
     *
     * Without it, any holder of `user.invite` could resend for any membership in
     * their tenant and receive a fresh identity-binding link in the response
     * body — minting a credential for a role they could not have handed out.
     * Because of `AdoptIdentityOptions.onlyUnclaimedStub` that link cannot
     * rebind a row somebody already signs in as, so this is a privilege gap
     * rather than a takeover; it is closed here because "I can re-issue the
     * credential" and "I can create the membership" should be the same authority.
     *
     * ── `canManageRole`, not `canManageExistingRole` ─────────────────────────
     * The strictly-higher comparison, not the one `PUT /:id/role` and
     * `DELETE /:id/membership` use. Their equal-role exception exists so a
     * `tenant_owner` can step a co-owner DOWN — a de-escalation, and there is no
     * role above `tenant_owner` to authorise it. Re-issuing a binding credential
     * is the opposite shape, so it takes the same strict test as creating the
     * membership did. In practice nothing is refused today (only `agent`, the
     * lowest role, is issued a token at all — see `roleGetsTokenInvite`); the
     * gate matters the moment that widens, which is a one-line change one file
     * away.
     *
     * ── 403 here, where the two checks above answer 404 ──────────────────────
     * Deliberate, and it does not weaken the "foreign tenant and nonexistent are
     * one indistinguishable 404" property: both of those refusals happen FIRST,
     * so reaching this line already means the id names a live membership inside
     * the caller's own tenant and account scope — a row the same caller can
     * already read through `GET /users`. There is nothing left for a 404 to
     * conceal, and a 403 is the answer that tells a supervisor to ask someone
     * senior rather than to go hunting for a mistyped id.
     */
    // Fails closed without a membership rather than relying on
    // `requirePermission` having run first.
    if (!request.membership || !canManageRole(request.membership.role, membership.role)) {
      return reply.code(403).send({
        error: 'Forbidden',
        message: 'Cannot resend an invitation for a role equal to or above your own',
      });
    }

    const user = await userRepository.findById(membership.user_id);
    if (!user) {
      return reply.code(404).send({ error: 'Not Found', message: 'Membership not found' });
    }

    /**
     * The revoke rides inside `issueInvite`'s row write (see the route
     * docstring), so the only thing left here is the one outcome that write can
     * refuse.
     *
     * `LiveInviteConflictError` means a concurrent resend won the membership's
     * live-token slot — in practice a double-click, or two supervisors on the
     * same ticket. Answered 409 with what actually happened rather than left to
     * `errorMaskHook`, which would rewrite a `23505` into "contact support and
     * quote this request id" for a state that needs no support at all: the mail
     * the caller was asking for has just been sent by the request that beat
     * theirs, and the newest link is the live one. Nothing was mailed by this
     * request — the send sits below the row write inside `issueInvite` — so the
     * recipient receives exactly one message.
     *
     * No audit row: `user.invite_sent` records that an invitation went out, and
     * this request issued nothing. The winner writes its own row.
     */
    let issued: Awaited<ReturnType<typeof issueInvite>>;
    try {
      issued = await issueInvite({
        membershipId: membership.id,
        tenantId: request.tenantId!,
        email: user.email,
        role: membership.role,
        invitedBy: request.user?.id ?? null,
      });
    } catch (err) {
      if (err instanceof LiveInviteConflictError) {
        log.warn(
          { tenantId: request.tenantId, membershipId: membership.id },
          'Resend lost the live-token slot to a concurrent issue; reported as a conflict',
        );
        return reply.code(409).send({
          error: 'Conflict',
          message:
            'Another invitation for this member was just issued. The newest link is the '
            + 'one that works — check the inbox before sending again.',
        });
      }
      throw err;
    }

    platformAuditLogger.log({
      tenant_id: request.tenantId!,
      ...(membership.account_id ? { account_id: membership.account_id } : {}),
      ...requestAuditActor(request),
      action: 'user.invite_sent',
      resource_type: 'membership_invite',
      // `null` for a role that mints no token — the act still happened and is
      // still worth a row, and a resource_id that names nothing is more honest
      // than one that names the membership and reads as a membership change.
      ...(issued.invite ? { resource_id: issued.invite.id } : {}),
      details: {
        membership_id: membership.id,
        role: membership.role,
        resend: true,
        email_sent: issued.inviteEmail.sent,
        ...(issued.inviteEmail.sent ? {} : { email_reason: issued.inviteEmail.reason }),
      },
      ip_address: request.ip,
    });

    return reply.send({
      invite_email: issued.inviteEmail.sent
        ? { sent: true }
        : { sent: false, reason: issued.inviteEmail.reason },
      sign_in_url: issued.signInUrl,
    });
  });
}

/**
 * What a person holding a link that no longer works is told.
 *
 * Written out per status rather than as one "this invitation is no longer
 * valid", because each of the three has a different next step and the message is
 * the only place that difference reaches the reader — the route already answers
 * the same 409 for all three.
 */
const INVITE_CONFLICT_MESSAGES: Record<Exclude<InviteStatus, 'pending'>, string> = {
  claimed: 'This invitation has already been used. Sign in to continue.',
  expired: 'This invitation has expired. Ask whoever invited you to send a new one.',
  revoked:
    'This invitation is no longer valid — a newer one may have been sent. Check your inbox, '
    + 'or ask whoever invited you to send another.',
};


/**
 * Compare two addresses for the audit flag only — never for resolution.
 *
 * Case-folded and trimmed because "Alice@Example.com" and "alice@example.com"
 * are the same inbox everywhere that matters, and recording a mismatch for a
 * capitalisation difference would make the flag noise that a reader learns to
 * ignore. This is emphatically NOT an identity check: nothing in this file
 * resolves a user from an address, and the value of this comparison is entirely
 * that it goes in an audit row.
 */
function normaliseEmail(email: string | null | undefined): string {
  return (email ?? '').trim().toLowerCase();
}
