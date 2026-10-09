import type { DecodedFirebaseToken } from './firebase.js';
import type { UserRecord } from '@magick-agency/db/models/user.model';

/**
 * Anything that can run a statement — a `Pool` or a `PoolClient`.
 *
 * Declared structurally rather than imported from `pg` so this module can be
 * handed a pooled connection that is already inside a transaction. That is not a
 * convenience: `POST /invites/:token/claim` marks the invite claimed and binds
 * the identity in ONE transaction, so that a failure to bind cannot leave an
 * invite spent with nobody bound to it. A helper that reached for `getPool()`
 * itself could not participate in that.
 */
export interface Queryable {
  query<R = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: R[]; rowCount: number | null }>;
}

/**
 * The `firebase_uid` prefix `POST /users/invite` writes for a user who has never
 * signed in — `pending_<uuid>` (`user.routes.ts`). A row still carrying it has no
 * real Firebase account behind it and nobody can currently sign in as it.
 */
export const PENDING_UID_PREFIX = 'pending_';

/**
 * Which kind of adoption the caller is performing.
 *
 * ── `onlyUnclaimedStub` closes an account-takeover path, and it is not optional
 *    thinking for any future caller ────────────────────────────────────────────
 *
 * `POST /invites/:token/claim` binds whatever Firebase identity the visitor
 * arrives with onto the user row its membership points at, with NO relation to
 * the invited email address — deliberately, because the token is the authority
 * and an invitee may legitimately sign in with a different Google account.
 *
 * That is safe only while the row being bound is one nobody ELSE can sign in as.
 * Without this predicate the three surrounding behaviours compose into a remote
 * takeover of any account on the platform, from its email address alone:
 *
 *  1. Anyone who signs up gets `tenant_owner` of their own tenant
 *     (`auth.routes.ts` path 4), so anyone can call `POST /users/invite`.
 *  2. That route REUSES an existing `users` row when the address is already
 *     known (`user.routes.ts`, `findByProvenEmail` before the stub create) — so
 *     inviting `victim@corp.test` as an `agent` writes a membership in the
 *     ATTACKER's tenant pointing at the VICTIM's user id, and `agent` is exactly
 *     the role that mints a token.
 *  3. The 201 hands the inviter the raw join link, so the attacker holds the
 *     token without ever seeing the victim's inbox.
 *
 * Claiming it then overwrote the victim's `firebase_uid` with the attacker's own,
 * and the attacker signed in through `/auth/session` path 1 as the victim —
 * inheriting every tenant and membership they hold anywhere on the platform.
 *
 * The predicate lives in the UPDATE's `WHERE` rather than in a fetch-then-check
 * above it, so a row that stops being a stub between a read and the write cannot
 * be bound anyway: the row is locked by this statement and re-checked under that
 * lock. Note the bound of that claim — it holds for CHANGES TO THIS ROW, which
 * is the whole of what `onlyUnclaimedStub` asks about. It is not a predicate
 * lock over other tables; see `confineStubToTenantId` for where that distinction
 * bites.
 *
 * ── The third arm, `firebase_uid = $1`, and the regression that needed it ────
 * The first version of this predicate was `starts_with(firebase_uid, 'pending_')`
 * alone, which refused the ordinary "add an agent who already has a login"
 * path — the most common invite there is after the brand-new address.
 * `POST /users/invite` reuses the existing `users` row for a known address,
 * writes a NEW membership against it, and `issueInvite` still mails a join link.
 * That invitee's `firebase_uid` is already real, so claiming with THEIR OWN uid
 * failed the stub test, rolled the claim back, and answered
 * `409 identity_already_bound` — the sentence written for the hostile reading —
 * to somebody whose membership is genuinely theirs and who is holding the mail
 * we just sent.
 *
 * So the predicate is widened rather than dropped, and the three cases are:
 *
 *  - stub + any uid                     → binds (a mismatched address is still
 *                                         allowed; the token is the authority)
 *  - already bound + THAT SAME uid       → binds, idempotently. Nothing about the
 *                                         row changes hands: it is already this
 *                                         identity, so the claim spends the
 *                                         invite and returns the session.
 *  - already bound + a DIFFERENT uid     → still refused. This is the takeover
 *                                         case and the only one the arm must not
 *                                         admit.
 *
 * The distinction stays in the `WHERE` — it is deliberately NOT a route-level
 * "treat `identity_already_bound` as success", which would be a read and a write
 * that can disagree: a bind landing between the two would let the route report
 * success for a row it did not write.
 *
 * ── `adoptEmail` keeps the row findable ONLY under the identity that bound it ─
 * See {@link AdoptIdentityOptions.adoptEmail}. It exists because the two options
 * compose into an identity swap without it, and the swap is silent.
 *
 * `POST /auth/session` path 2/3 passes NEITHER option, and that is now a
 * narrower claim than it used to be. The old text here said path 2/3 was safe
 * because "the row was found BY the verified email on the token, so Firebase's
 * own one-account-per-email rule stands behind it". That reasoning does not
 * survive a mismatched claim: Firebase's rule keys on the FIREBASE account's
 * email, while path 2 keys on the `users.email` COLUMN — and a mismatched claim
 * used to leave that column holding the INVITED address while `firebase_uid`
 * held the claimant's. Anyone who could then present a *verified* Firebase
 * token for the invited address hit path 2 and took the row over.
 * `sessionLinkEmail` now refuses unverified tokens before that lookup, which
 * closes the email/password-without-inbox race; `adoptEmail` is what closes
 * the remaining verified-token case, by making the column agree with the
 * identity. Path 2/3 needs neither option because it adopts a row it found by
 * the incoming (verified) address in the first place.
 */
export interface AdoptIdentityOptions {
  /**
   * Refuse to bind a row that already carries a DIFFERENT real `firebase_uid`.
   * Pass `true` from any path where the caller's authority is a token rather
   * than proven ownership of the row's email address.
   *
   * "Different" is the operative word — a row already carrying the INCOMING uid
   * is bound again, idempotently, because nothing changes hands. See the
   * interface docstring for the three cases and for the regression that the
   * narrower stub-only form caused.
   */
  onlyUnclaimedStub?: boolean;
  /**
   * Also take the Firebase account's own email onto the row.
   *
   * ── Why a bind that does not do this is an identity SWAP ──────────────────
   * The claim path deliberately accepts a Firebase address that differs from the
   * invited one. Without this option the row afterwards keys under the INVITED
   * address while `firebase_uid` names the CLAIMANT — two different people in
   * one row — and `POST /auth/session` path 2 looks a user up by exactly that
   * column and adopts what it finds with NO `onlyUnclaimedStub`. So:
   *
   *  1. A supervisor invites `agent@work.com`; a stub row is written for it.
   *  2. The agent claims with `agent@gmail.com`. Allowed — the token is the
   *     authority — and the row now reads `email = agent@work.com`,
   *     `firebase_uid = <the gmail identity>`.
   *  3. ANYONE who later signs in with a *verified* Firebase token whose email
   *     is `agent@work.com` — the address whose inbox nobody has had to prove
   *     control of since the invite was mailed — hits path 2, and its
   *     unconditional adopt OVERWRITES `firebase_uid`. (Unverified tokens are
   *     refused by `sessionLinkEmail` before that lookup; this is the remaining
   *     case.) The agent is locked out of a membership they had already claimed,
   *     and the new token owns it.
   *
   * Writing the bound identity's own address is what removes step 3: path 2 can
   * only ever find the row under the identity that actually bound it.
   *
   * Three consequences, all deliberate:
   *
   *  - **`membership_invites.email` still holds the address as INVITED.** That
   *    is the audit record of what was offered, and it is not rewritten — the
   *    claim's `user.invite_claimed` row carries both addresses for the same
   *    reason.
   *  - **A later `/auth/session` carrying the INVITED address now finds no row
   *    and falls to path 4**, provisioning a fresh tenant for it. That is
   *    correct rather than a regression: after a mismatched claim, whoever holds
   *    `agent@work.com` is a genuinely different principal from the one that
   *    took the membership, and giving them their own empty tenant is exactly
   *    what path 4 is for. The membership they might have expected is gone
   *    because somebody else claimed the invitation that named it, which is a
   *    fact the audit row records and a resend can correct.
   *  - **`users.email` carries only a NON-UNIQUE index**,
   *    so this write can never raise a constraint
   *    error — and equally can never be relied on for uniqueness. It CAN produce
   *    two rows sharing an address (the claimant's other account, if they have
   *    one here, plus this one), which is a shape this schema already permits
   *    and which no code path may resolve an identity from. Nothing on the claim
   *    path does. The two by-address lookups are `findByEmail`
   *    (`POST /auth/session` path 2/3, which has PROVEN the address) and
   *    `findByProvenEmail` (`POST /users/invite` and both super-admin
   *    provisioning routes, which have proven nothing); each picks ONE row
   *    deterministically — `findByEmail` orders the unflagged row first,
   *    `findByProvenEmail` refuses flagged rows outright — rather than taking
   *    whichever row Postgres hands back, which is what they both used to do.
   *
   * `null`/absent/empty email leaves the column exactly as it is — a phone-auth
   * identity carries no address to write, and blanking a real one would be the
   * worse half of the same defect. It does NOT leave the row unflagged: a
   * phone-auth claim still binds an identity that can sign in as a row keyed
   * under an address it never proved, which is the same trap by a different
   * door, so `email_unverified` is set for it too. The consequence is worth
   * knowing — a phone-auth identity has no address to prove, so such a row can
   * never be repaired by `clearEmailUnverifiedIfProven` and stays out of the
   * by-address reuse paths permanently. That is the correct answer to
   * "who is this row?" and the wrong one for onboarding convenience; the
   * remedy is a support-side merge, not a weaker predicate.
   *
   * ── It adopts a VERIFIED address only, and the unverified case is FLAGGED ─
   * The claim accepts an unverified Firebase email on purpose (see the route),
   * so `adoptEmail` alone would write an address nobody has proven onto a row
   * that can now sign in. `users.email` is the reuse key for three paths that
   * hand out authority — `POST /users/invite` and super-admin
   * tenant-create/add-user — so that row becomes a trap laid under an address
   * its owner does not control. The short version: the
   * inviter reads the join link out of their own 201,
   * so "the token was delivered to that inbox" is not evidence when the inviter
   * and the claimant are the same person.
   *
   * So the write is gated on `identity.email_verified === true`, and when it is
   * not, `users.email_unverified` is set instead: the address stays as it was
   * and the reuse paths stop trusting it. This costs nothing in the ordinary
   * case, because the common unverified claim is an email/password account
   * created on the join page with the INVITED address — where adopting and not
   * adopting write the same string.
   */
  adoptEmail?: boolean;
  /**
   * Refuse to activate a STUB that carries active memberships in any tenant
   * other than this one.
   *
   * ── The cross-tenant takeover this closes, which `onlyUnclaimedStub` does
   *    not ────────────────────────────────────────────────────────────────────
   * `onlyUnclaimedStub` asks "is this row already somebody?", and answers no for
   * a `pending_` stub. That is the right question for a row ONE tenant is
   * waiting on, and the wrong one for a row SEVERAL tenants are waiting on —
   * because `POST /users/invite` reuses an existing `users` row whenever the
   * address is already known, and so does super-admin tenant-create. A stub is
   * therefore a shared object, and the memberships hanging off it can belong to
   * workspaces the token's holder has nothing to do with:
   *
   *  1. A super admin provisions tenant A with owner `victim@corp.test`, or a
   *     supervisor there invites them. Either way a `pending_` stub is written
   *     carrying a `tenant_owner` membership in A, and nobody has signed in yet.
   *  2. Anyone who signs up is `tenant_owner` of their own tenant B, so the
   *     attacker invites that same address into B as an `agent` — the role that
   *     mints a token. The reuse rule aims that membership at the VICTIM's row.
   *  3. The 201 hands the inviter the raw join link, so the attacker holds a
   *     valid token for a row they do not own, without ever seeing the inbox.
   *  4. Claiming binds the attacker's Firebase uid onto that row. The stub test
   *     passes — nobody has claimed it — so `onlyUnclaimedStub` sees nothing
   *     wrong, and `buildSessionPayload` then lists EVERY active membership on
   *     the row, tenant A's ownership included.
   *
   * The invariant this restores is that **a claim confers only what its token
   * names**. A token proves the holder was offered ONE membership; it is not
   * evidence about the address, so it cannot be allowed to activate memberships
   * somebody else created for that address in another workspace. Proving the
   * ADDRESS is what `POST /auth/session` path 2 is for — it requires a verified
   * Firebase email (`sessionLinkEmail`) and legitimately activates a shared stub
   * across every tenant waiting on it. That path is untouched here; this option
   * only narrows the path whose authority is a token.
   *
   * Note step 1 and step 2 can arrive in EITHER order — the attacker's stub can
   * exist first and a super admin's provisioning land on it afterwards — which
   * is why the check has to be here, at the moment of binding, rather than at
   * invite time where the future membership is not yet visible.
   *
   * ── The two arms that must NOT be refused ──────────────────────────────────
   *  - **`firebase_uid = $1`.** The row is ALREADY this identity, so nothing
   *    changes hands — the ordinary "invite somebody who already has a login
   *    here" case. Their own memberships across every tenant are theirs,
   *    and narrowing that would answer a conflict to the person the mail was
   *    addressed to. (A row bound to a DIFFERENT real identity is refused, by
   *    this predicate and by `onlyUnclaimedStub` alike — the difference is only
   *    which reason the caller reports, and `claimWithIdentity` prefers
   *    `identity_already_bound` there because it is the more actionable one.)
   *  - **A stub whose memberships are all in this tenant.** That is every
   *    honest invitation, including a re-invite into a second account of the
   *    same workspace.
   *
   * `status = 'active'` matches what a session actually confers:
   * `findAllByUserId` and `tenantRepository.listByUserId` are both status-
   * filtered, so a revoked membership in another tenant grants nothing and must
   * not block a legitimate claim.
   *
   * Like `onlyUnclaimedStub`, it lives in the UPDATE's `WHERE` rather than in a
   * fetch-then-check above it, so a membership that already exists cannot slip
   * past between a read and the write.
   *
   * ── The residual window, stated precisely because the `WHERE` does NOT close
   *    it ──────────────────────────────────────────────────────────────────────
   * A `WHERE` clause is not a predicate lock. Every transaction here runs at the
   * pg default READ COMMITTED (nothing in this service sets an isolation level),
   * and `NOT EXISTS` takes no lock on rows that do not yet exist — so a
   * membership INSERTED and committed by a concurrent `POST /users/invite`
   * AFTER this subquery is evaluated and BEFORE this transaction commits is not
   * seen, and the bind succeeds onto a row that ends up carrying it.
   *
   * Left open deliberately, and it is narrow in both directions: the attacker
   * controls the timing of their own claim but not of the victim-side invite, so
   * it is not steerable; and the reverse ordering — bind first, invite second —
   * is closed by the `email_unverified` flag, because the row an unverified claim
   * leaves behind is one `findByProvenEmail` refuses. Closing it properly means
   * `SELECT ... FOR UPDATE` on the `users` row in the three reuse paths, so the
   * invite holds a row lock this UPDATE must queue behind. That is a change to
   * two routes rather than to this statement, and it is not free of subtlety
   * (the re-check would then rest on EvalPlanQual re-evaluating a subquery), so
   * it wants its own change with its own test rather than riding along here.
   *
   * `null`/absent leaves the statement exactly as it was for
   * `POST /auth/session` path 2/3, which has no invite tenant to confine to and
   * is authorised by the verified address instead.
   */
  confineStubToTenantId?: string | null;
}

/**
 * Adopt a Firebase identity onto an existing `users` row.
 *
 * ── One statement, three separate rules, and each of them is deliberate ─────
 * This is the SQL `POST /auth/session` path 2/3 runs, in one shared function so
 * the invite-claim path can run the SAME rules rather than a second
 * transcription of them. The rules:
 *
 *  - **`firebase_uid` is taken, subject to {@link AdoptIdentityOptions}.** That
 *    is what "adopt" means: either a `pending_<uuid>` stub is being activated, or
 *    a person has re-registered under a new Firebase account and the row must
 *    follow them. Which of the two an adoption is allowed to be is the CALLER's
 *    declaration, not this function's guess — see `onlyUnclaimedStub`, and read
 *    its docstring before removing the predicate: it is load-bearing security,
 *    not a tidy-up.
 *  - **`display_name` and `avatar_url` are filled only if ABSENT** (`COALESCE`
 *    on the existing value, not on the incoming one). A person who has set a
 *    display name in this product must not have it silently overwritten by
 *    whatever their Google profile says this week.
 *  - **`phone_number` moves only off the placeholder.** `'0000000000'` is what
 *    signup writes when no number is supplied (`auth.routes.ts` path 4), so it
 *    means "unset" rather than a real value; a genuine number is never replaced.
 *    Passing `null` leaves the column exactly as it is, which is what the invite
 *    claim does — a claim carries no phone number to offer.
 *  - **A stub is activated only within one tenant under
 *    {@link AdoptIdentityOptions.confineStubToTenantId}.** Off by default,
 *    because `POST /auth/session` path 2/3 is authorised by a verified address
 *    rather than by a token and legitimately activates a stub every tenant
 *    waiting on it. On for the claim, where the authority names ONE membership.
 *  - **`email_unverified` records whether this bind PROVED the address.**
 *    Set only by an `adoptEmail` caller arriving without
 *    `email_verified === true`; cleared by any caller that does arrive with
 *    one, which is what lets a verified sign-in repair a row an earlier
 *    unverified claim flagged.
 *  - **`email` moves only under {@link AdoptIdentityOptions.adoptEmail}**, and
 *    only to a non-empty incoming address that Firebase reports VERIFIED. Off
 *    by default because path 2/3
 *    found the row BY that address and has nothing to write; on for the claim,
 *    where leaving the column naming the invited address turns the row into two
 *    people at once. Read that option's docstring before changing either side —
 *    it is the half that keeps a mismatched claim from being reversible by
 *    anyone who can present the invited address to `/auth/session`.
 *
 * ── Why the caller must handle `23505` ─────────────────────────────────────
 * `users.firebase_uid` is UNIQUE. If `identity.uid` already belongs to a
 * DIFFERENT row this raises `23505`, and that is reachable rather than
 * theoretical on the claim path: the claim deliberately accepts a Firebase
 * address that differs from the invited one (the token is the authority), and
 * that other address may already have an account here. This function does not
 * swallow it, because the two callers owe their users different answers — the
 * session path cannot reach it at all (it looked the row up BY that uid), and
 * the claim path turns it into a 409 that says which identity is in the way.
 *
 * Returns the updated row, so a caller needs no follow-up SELECT. `null` when
 * `userId` matches nothing; under `onlyUnclaimedStub`, when it matches a row
 * already bound to a real Firebase account OTHER than the incoming one; and
 * under `confineStubToTenantId`, when it matches a stub carrying active
 * memberships outside that tenant. A caller that passes both options and needs
 * to tell those two refusals apart must re-read the row — see
 * `membershipInviteRepository.claimWithIdentity`, which does it inside the same
 * transaction so the answer cannot be stale.
 */
export async function adoptFirebaseIdentity(
  db: Queryable,
  userId: string,
  identity: Pick<DecodedFirebaseToken, 'uid' | 'name' | 'picture' | 'email' | 'email_verified'>,
  phoneNumber?: string | null,
  options: AdoptIdentityOptions = {},
): Promise<UserRecord | null> {
  /**
   * Resolved here rather than in SQL so the statement carries ONE parameter for
   * this rather than a flag and a value that can disagree: a `NULL` means "leave
   * the column alone", which is what an absent option, a phone-auth identity and
   * an empty address all mean. `COALESCE` then needs no branch.
   */
  const addressIsProven = identity.email_verified === true && !!identity.email;
  const emailToAdopt = options.adoptEmail === true && addressIsProven ? identity.email || null : null;
  /**
   * Whether this bind leaves the row carrying an address NOBODY has proven.
   *
   * Only `adoptEmail` callers can produce that state — every other caller found
   * the row BY a verified address (`sessionLinkEmail`) — so a caller that did
   * not ask to adopt never sets the flag, and one that DID ask but arrived with
   * a verified address CLEARS it. `null` leaves the column alone, which is what
   * a phone-auth adoption and `POST /auth/session` path 2/3 both want: path 2
   * clears it through the `addressIsProven` arm instead, which is the repair
   * for a row a previous unverified claim flagged.
   *
   * ── TRUE is conditional in SQL, because only ACTIVATING A STUB can taint ───
   * `true` here is a REQUEST to flag, which the statement honours only when the
   * row it matched was still a `pending_` stub. The predicate below admits two
   * shapes, and they mean opposite things for this column. Activating a stub
   * keys a row under an address this identity has not proven — the takeover
   * the `email_unverified` flag exists to stop. Re-binding a row whose `firebase_uid` is ALREADY
   * this identity changes nothing and hands nothing over: it is the ordinary
   * second-workspace claim, and the address on that row may well have been
   * proven long ago.
   *
   * Flagging that arm unconditionally — which is what this did — let one
   * unverified claim REVOKE an established proof. A phone-auth claim was the
   * unrecoverable form: it carries no address at all, so `addressIsProven` is
   * false and this asked to flag, while `clearEmailUnverifiedIfProven` needs an
   * address to clear with and can never run. One such claim would have removed
   * that person's proven address from `POST /users/invite` and both super-admin
   * provisioning routes permanently, with nothing to say why.
   *
   * It is a `CASE` in the statement rather than a second SELECT here because
   * "was this row a stub" has to be read at the same instant as the write; a
   * read beforehand is the fetch-then-check this file closes everywhere else.
   */
  const emailUnverified = addressIsProven
    ? false
    : options.adoptEmail === true
      ? true
      : null;

  const result = await db.query<UserRecord>(
    `UPDATE users
        SET firebase_uid = $1,
            display_name = COALESCE(display_name, $2),
            avatar_url = COALESCE(avatar_url, $3),
            phone_number = CASE
              WHEN phone_number IS NULL OR phone_number = '0000000000'
              THEN COALESCE($5::text, phone_number)
              ELSE phone_number
            END,
            email = COALESCE($8::text, email),
            -- FALSE: a verified address established this row's address.
            -- NULL: not an adopting caller, so leave the column alone.
            -- TRUE: a REQUEST to flag, honoured only while this statement is
            -- ACTIVATING A STUB — that is the bind which keys a row under an
            -- unproven address. firebase_uid on the right of SET is the OLD
            -- value, so this asks what the row was BEFORE the bind. Re-binding
            -- a row that is already this identity hands nothing over and must
            -- not revoke a proof it may already carry (a phone-auth claim could
            -- never restore it). See AdoptIdentityOptions.adoptEmail, the
            -- emailUnverified note above.
            email_unverified = CASE
              WHEN $10::boolean IS NULL THEN email_unverified
              WHEN $10::boolean = false THEN false
              WHEN starts_with(firebase_uid, $7) THEN true
              ELSE email_unverified
            END,
            updated_at = NOW()
      WHERE id = $4
        AND (
          $6::boolean IS NOT TRUE
          OR starts_with(firebase_uid, $7)
          -- Already THIS identity: nothing changes hands, so the bind is
          -- idempotent rather than refused. See AdoptIdentityOptions.
          OR firebase_uid = $1
        )
        AND (
          $9::uuid IS NULL
          -- Already THIS identity: the memberships on the row are the
          -- claimant's own, in every tenant they hold one.
          OR firebase_uid = $1
          -- Otherwise this statement is ACTIVATING a stub, and a stub is a
          -- shared object: POST /users/invite and super-admin tenant-create
          -- both reuse an existing row by address. Binding it must not hand the
          -- token's holder memberships another workspace created for that
          -- address. See AdoptIdentityOptions.confineStubToTenantId.
          OR NOT EXISTS (
            SELECT 1
              FROM memberships m
             WHERE m.user_id = users.id
               AND m.status = 'active'
               AND m.tenant_id <> $9::uuid
          )
        )
      RETURNING *`,
    [
      identity.uid,
      identity.name || null,
      identity.picture || null,
      userId,
      phoneNumber || null,
      options.onlyUnclaimedStub === true,
      PENDING_UID_PREFIX,
      emailToAdopt,
      options.confineStubToTenantId ?? null,
      emailUnverified,
    ],
  );
  return result.rows[0] || null;
}

/** Postgres unique-violation SQLSTATE, raised when `firebase_uid` is taken. */
/**
 * The refusal a by-address reuse path answers when every `users` row for the
 * address is flagged `email_unverified`.
 *
 * A named code rather than a bare 409 because the remedy is specific and the
 * caller can act on it: the account holder signs in once with a verified token
 * (`/auth/session` path 1 clears the flag) and the operation works. Without it
 * the alternative was silently writing a second `users` row whose invitation
 * can never be claimed — `firebase_uid` is UNIQUE, so the one person who would
 * claim it collides with their own existing row.
 */
export const UNVERIFIED_ADDRESS_HOLDER = 'unverified_address_holder';

/**
 * The refusal a by-address reuse path answers when the row it resolved stopped
 * answering to that address before the membership could be written.
 *
 * Distinct from {@link UNVERIFIED_ADDRESS_HOLDER} because the two name
 * different people and different remedies. That one means the address resolves
 * to somebody who has not proven it, and the remedy is theirs — verify, then
 * the invitation works. This one means a claim carrying a VERIFIED address of
 * its own rewrote `users.email` mid-flight, so the row is no longer keyed under
 * the invited address at all; nobody is waiting on a verification, and the
 * remedy is simply to send the invitation again, which resolves the address
 * afresh. Telling an admin to chase a verification here would be advice about
 * the wrong person.
 */
export const ADDRESS_REBOUND_DURING_INVITE = 'address_rebound_during_invite';

export const UNIQUE_VIOLATION = '23505';

/**
 * Is this error the `firebase_uid` collision {@link adoptFirebaseIdentity}
 * documents?
 *
 * Matched on the SQLSTATE **and**, when the driver supplies one, the constraint
 * name — rather than on the SQLSTATE alone. `membership_invites.token_hash` is
 * UNIQUE too, and the claim path writes both tables in one transaction, so a
 * blanket `code === '23505'` would report a hash collision as "that Google
 * account already belongs to somebody here": a sentence that sends the reader to
 * the wrong place entirely.
 *
 * A missing `constraint` falls back to "yes". `node-pg` populates the field from
 * the server's error fields and it is present for a unique violation in
 * practice, so the fallback is for a driver or wrapper that does not forward it
 * — and in that case the identity collision is the vastly more likely of the
 * two, since the other candidate requires a sha256 collision on 32 random bytes.
 */
export function isFirebaseUidCollision(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const { code, constraint } = err as { code?: string; constraint?: string };
  return code === UNIQUE_VIOLATION && (constraint === undefined || constraint.includes('firebase_uid'));
}
