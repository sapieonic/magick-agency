import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { sessionRequestSchema } from '../validators/auth.validator.js';
import { verifyIdToken } from '../../auth/firebase.js';
import { EMAIL_UNVERIFIED_CODE, sessionLinkEmail } from '../../auth/session-email.js';
import { userRepository } from '@magick-agency/db/repositories/user.repository';
import { tenantRepository } from '@magick-agency/db/repositories/tenant.repository';
import { membershipRepository } from '@magick-agency/db/repositories/membership.repository';
import { sessionMiddleware, invalidateUserCache } from '../../auth/session.middleware.js';
import { adoptFirebaseIdentity, PENDING_UID_PREFIX } from '../../auth/firebase-identity.js';
import {
  buildSessionPayload,
  resolveSettingsSafe,
} from '../../auth/session-payload.js';
import { getPool } from '@magick-agency/db';
import { createChildLogger } from '@magick-agency/observability';
import type { SessionRefusal } from '@magick-agency/contracts/api/platform/auth';

const log = createChildLogger({ component: 'auth-routes' });

/**
 * The code path 4 answers with. Contract
 * `SessionRefusalCode` (`@magick-agency/contracts/api/platform/auth`).
 */
export const NO_MEMBERSHIP_CODE = 'no_membership' as const;
export const NO_MEMBERSHIP_MESSAGE =
  'This account has not been added to any Magick Agency workspace. Ask your workspace administrator to invite you, then sign in again.';

/**
 * `resolveSettingsSafe` (the per-account settings map) and the three-lookup
 * session body live in `src/auth/session-payload.ts`.
 *
 * They are shared with `POST /invites/:token/claim`, which has to answer
 * BYTE-IDENTICALLY to this route's success body so the SPA can reuse one
 * `SessionResponse` type for both — an invited agent finishes claiming and is
 * already signed in, with no second round trip here. A second transcription of
 * the lookups is exactly how the two would drift, and the drift would be
 * invisible: both endpoints would keep returning well-formed JSON that merely
 * disagreed about what a session contains.
 */

export async function authRoutes(app: FastifyInstance): Promise<void> {
  /**
   * POST /auth/session
   * Accept Firebase id_token → load user → return user + tenants + memberships.
   * A new identity is refused (path 4), never provisioned.
   *
   * Handles these cases:
   *   1. User found by firebase_uid → return existing session
   *   2. User found by *verified* email with pending_ UID (super-admin stub) → activate stub
   *   3. User found by *verified* email with different real UID (re-registered) → adopt new UID
   *   4. No user found → 403 `no_membership` (there is no self-serve sign-up,
   *      and path 4 never creates a tenant)
   *
   * Paths 2/3/4 that carry an email require `email_verified === true`. An
   * unverified email/password token on a UID miss is `403 email_unverified`
   * and does not fall through to path 4 — see `sessionLinkEmail`.
   */
  app.post('/session', async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = sessionRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Bad Request', details: parsed.error.issues });
    }

    const { id_token, phone_number } = parsed.data;

    // Verify Firebase token
    const decoded = await verifyIdToken(id_token);

    // ── Path 1: User found by Firebase UID ──────────────────
    const existingUser = await userRepository.findByFirebaseUid(decoded.uid);

    if (existingUser) {
      // Update phone if provided and currently placeholder
      if (phone_number && existingUser.phone_number === '0000000000') {
        await userRepository.update(existingUser.id, { phone_number });
        existingUser.phone_number = phone_number;
        await invalidateUserCache(existingUser.id, existingUser.firebase_uid);
      }
      /**
       * Repair a row this identity has now PROVED the address of.
       *
       * An invite claim binds an identity without proving the address it is
       * keyed under, and marks the row `email_unverified` so no by-address
       * reuse path will attach authority to it. The documented
       * repair is the owner proving that address — and THIS is the only branch
       * where they can, because the claim already wrote their `firebase_uid`
       * onto the row, so every sign-in of theirs resolves here and never
       * reaches `adoptFirebaseIdentity` on path 2/3.
       *
       * Without this the flag was permanent and unclearable, which broke
       * multi-workspace onboarding outright — see
       * `userRepository.clearEmailUnverifiedIfProven`, which carries the full
       * chain and the reason the address predicate lives in the statement.
       *
       * Cheap by construction: the guard is a boolean already on the row, so a
       * row that was never flagged costs one comparison and no query. The
       * write is conditional on `email_verified === true` HERE as well as in
       * SQL, because path 1 is deliberately the one arm that signs an
       * unverified token in, and an unverified token proves nothing.
       */
      if (existingUser.email_unverified && decoded.email_verified === true && decoded.email) {
        const repaired = await userRepository.clearEmailUnverifiedIfProven(
          existingUser.id,
          decoded.email,
        );
        if (repaired) {
          existingUser.email_unverified = false;
          // The row is cached for 20 minutes by `sessionMiddleware`; leaving a
          // stale flagged copy there would make the repair invisible for the
          // rest of that window on every instance.
          await invalidateUserCache(existingUser.id, existingUser.firebase_uid);
          log.info(
            { userId: existingUser.id },
            'Cleared email_unverified: the bound identity proved the row address',
          );
        }
      }

      return reply.send(await buildSessionPayload(existingUser, existingUser.id));
    }

    /**
     * UID miss. From here the email on the token is a claim about an inbox,
     * not about an identity we already bound. `sessionLinkEmail` is the gate:
     * unverified emails do not look anyone up and do not provision. Path 1
     * above is the only arm that may sign an unverified token in.
     */
    const link = sessionLinkEmail(decoded);
    if (link.status === 'unverified') {
      log.warn({ uid: decoded.uid }, 'Refused session: Firebase email is not verified');
      return reply.code(403).send({
        error: 'Forbidden',
        code: EMAIL_UNVERIFIED_CODE,
        message: 'Verify your email before signing in. Check your inbox for a verification link, then try again.',
      });
    }

    // ── Path 2 & 3: User found by verified email ────────────
    const emailUser = link.status === 'verified'
      ? await userRepository.findByEmail(link.email)
      : null;

    if (emailUser) {
      /**
       * Always adopt the new firebase_uid, fill in display_name and avatar_url
       * if missing, and move phone only off the placeholder. That rule lives in
       * `adoptFirebaseIdentity` — unchanged, but SHARED with
       * `POST /invites/:token/claim`, which has to bind an identity by exactly
       * these rules or a claimed invite would overwrite a display name the
       * person had set. `RETURNING *` replaces the follow-up
       * `findByFirebaseUid`: same row, one fewer round trip, and no window in
       * which the re-read could disagree with the write.
       *
       * ── This path adopts UNCONDITIONALLY, and what that rests on ──────────
       * No `onlyUnclaimedStub` here, deliberately: adopting a row that already
       * has a real uid is the entire point — a person re-registering under a new
       * Firebase account, and the row must follow them.
       *
       * Two things now stand behind that, and neither is enough alone:
       *
       * 1. **The email is verified.** `sessionLinkEmail` refused anything else
       *    before this lookup ran. Firebase email/password issues a token
       *    before the inbox is proven; binding a `pending_*` stub (or any
       *    existing row) on that string was account takeover of every
       *    not-yet-activated owner and invitee.
       * 2. **What happens to `users.email` on a claim, which is now two
       *    different answers.** Firebase's one-account-per-email rule keys on
       *    the FIREBASE account's email; this lookup keys on the `users.email`
       *    COLUMN, which is not unique. A mismatched invite claim that left the
       *    column holding the INVITED address while `firebase_uid` held the
       *    claimant's would let a later *verified* token for that address arrive
       *    here and take the claimed row over. `AdoptIdentityOptions.adoptEmail`
       *    closes that — but only for a claim that PROVES its address:
       *
       *    - **Verified claim** — the claimant's own address is written onto
       *      the row. A later sign-in with the INVITED address then finds
   *      nothing here and falls through to path 4, which refuses it with
   *      `no_membership`. That is correct, and it is the outcome to preserve
   *      if this lookup is ever widened.
       *    - **Unverified claim** (the common shape) — the
       *      INVITED address STAYS on the row and `email_unverified` is set
       *      instead. So this lookup still finds it, and adopting is still the
       *      right answer: whoever arrives here has proven that inbox, which
       *      is exactly the claim the flagged row could not make. The adopt
       *      CLEARS the flag, which is one of the two repairs; the other is
       *      path 1's `clearEmailUnverifiedIfProven`, for the far commoner case
       *      where the claim already wrote the person's own uid onto the row
       *      and they therefore never reach this branch again.
       *
       * What protects this lookup is therefore no longer `adoptEmail` alone —
       * for an unverified claim it writes nothing — but the flag plus
       * `findByProvenEmail`, which keeps the poisoned row out of every path
       * that attaches authority while leaving it reachable to the one caller
       * that can prove ownership of it.
       */
      const updatedUser = await adoptFirebaseIdentity(
        getPool(),
        emailUser.id,
        decoded,
        phone_number,
      );

      // The row's firebase_uid/display_name/phone just changed — drop any stale
      // cache under the id namespace and the old uid namespace.
      await invalidateUserCache(emailUser.id, emailUser.firebase_uid);

      const wasPending = emailUser.firebase_uid.startsWith(PENDING_UID_PREFIX);
      log.info(
        { userId: emailUser.id, email: decoded.email, wasPending },
        wasPending ? 'Activated pending stub user' : 'Adopted new Firebase UID for existing user',
      );

      return reply.send(await buildSessionPayload(updatedUser, emailUser.id));
    }

    // ── Path 4: Truly new user ──────────────────────
    /*
     * REFUSED: session path 4 never creates a tenant. There is no self-serve
     * sign-up: a person arrives only as a `pending_` stub a super-admin or team
     * admin created (path 2) or by claiming an invite. This branch writes NOTHING
     * — not even a `users` row — so a later invite or super-admin stub for this
     * address is matched by path 2 exactly as if this sign-in had never happened.
     */
    log.warn({ uid: decoded.uid }, 'Refused session: no user, stub or membership for this identity');
    const refusal: SessionRefusal = {
      error: 'Forbidden',
      code: NO_MEMBERSHIP_CODE,
      message: NO_MEMBERSHIP_MESSAGE,
    };
    return reply.code(403).send(refusal);
  });

  /**
   * GET /auth/me
   * Return current user + all tenants + memberships.
   */
  /**
   * The preHandler is `sessionMiddleware` alone: there are no platform API keys
   * in v1, so every caller here is a person and "me" is always a human.
   */
  app.get('/me', { preHandler: [sessionMiddleware] }, async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.user) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }

    const memberships = await membershipRepository.findAllByUserId(request.user.id);
    const tenants = await tenantRepository.listByUserId(request.user.id);
    // The per-account `settings` map over every account the memberships reach
    // (contract `MeResponse`).
    const settings = await resolveSettingsSafe(memberships);

    return reply.send({
      user: request.user,
      tenants,
      memberships,
      settings,
    });
  });
}
