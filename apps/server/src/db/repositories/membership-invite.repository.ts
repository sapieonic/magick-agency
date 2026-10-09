import { getPool } from '@magick-agency/db';
import {
  adoptFirebaseIdentity,
  isFirebaseUidCollision,
  PENDING_UID_PREFIX,
  UNIQUE_VIOLATION,
  type Queryable,
} from '../../auth/firebase-identity.js';
import type { DecodedFirebaseToken } from '../../auth/firebase.js';
import type {
  ClaimInviteResult,
  CreateMembershipInviteInput,
  MembershipInviteRecord,
} from '../models/membership-invite.model.js';

/**
 * Why the conditional claim UPDATE did or did not match.
 *
 * A result union rather than a boolean because the two failures owe the person
 * holding the link different sentences — see
 * {@link MembershipInviteRepository.markClaimed}.
 */
export type MarkClaimedResult =
  | { ok: true }
  | { ok: false; reason: 'already_claimed' | 'revoked' | 'expired' };

/**
 * A concurrent issue won the membership's one live-token slot.
 *
 * Thrown by {@link MembershipInviteRepository.createSupersedingOutstanding} when
 * migration 069's partial unique index refuses a second outstanding row. It is a
 * named error rather than a bare `23505` because the two callers owe their users
 * different answers and neither of them is a 500: `POST /invites/resend` answers
 * 409 with the true story (an invitation for this membership was just issued —
 * the newest link is the live one), and `POST /users/invite` folds it into its
 * existing "the membership stands, the mail did not go" arm.
 */
export class LiveInviteConflictError extends Error {
  constructor() {
    super('A newer invitation for this membership was issued concurrently');
    this.name = 'LiveInviteConflictError';
  }
}

/**
 * The partial unique index from migration 069, by name.
 *
 * Named here rather than matched as a substring because this is the value
 * Postgres reports in `constraint`, and a rename in the migration must break
 * loudly in the suite rather than quietly turn every loser of a resend race into
 * a masked 500.
 */
const LIVE_INVITE_INDEX = 'uq_membership_invites_live';

/**
 * Is this the live-token index refusing a second outstanding invite?
 *
 * ── Why a MISSING constraint name answers NO here, where
 *    `isFirebaseUidCollision` answers yes ────────────────────────────────────
 * The same statement can raise `23505` from `token_hash`'s own unique index, and
 * the two deserve opposite treatment. A `token_hash` collision is a sha256
 * collision on 32 random bytes — it does not happen, and if it somehow did, a
 * masked 500 telling the supervisor to press the button again is the honest
 * answer, since pressing it mints a different token. Reporting one as "somebody
 * just resent this" would be a plausible sentence about something that did not
 * occur. So this predicate refuses to guess: an unnamed unique violation
 * propagates as the error it is.
 */
function isLiveInviteCollision(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const { code, constraint } = err as { code?: string; constraint?: string };
  return code === UNIQUE_VIOLATION && constraint === LIVE_INVITE_INDEX;
}


/**
 * `membership_invites` (migration 069) — the token that binds a Firebase
 * identity to a membership somebody already created.
 *
 * ── Every lookup is BY HASH or BY MEMBERSHIP, and never by email ────────────
 * There is deliberately no `findByEmail` here, and adding one would reopen the
 * defect the table exists to close: `users.email` carries only a non-unique
 * index (`001_initial_schema.sql:60`), so an address is not an identity in this
 * schema. The token's hash is the only thing that resolves an invite, and the
 * membership id is the only thing that resolves a user from it.
 *
 * ── The tenant boundary is IN the statement, not downstream of it ───────────
 * {@link MembershipInviteRepository.createSupersedingOutstanding} takes a
 * `tenant_id` and puts it in the same statement as its revoke, following the
 * `findByIdInTenant` convention `user.routes.ts` argues for at length: it is
 * reachable from `POST /invites/resend` with a caller-supplied `membership_id`,
 * and a membership id travels in URLs, logs and support threads, so "the caller knew the id" is never evidence that the caller
 * may act on it. The route's own tenant-scoped membership lookup already refuses
 * a foreign id; the predicate is here as well because a check in the route is a
 * read and a write that can drift apart, and this is the statement that has to
 * hold if a second caller is ever added.
 *
 * The hash lookup has no tenant parameter because it CANNOT: the caller is an
 * unauthenticated recipient with no tenant context, and the token is what
 * establishes which tenant they are talking about.
 */
export class MembershipInviteRepository {
  /**
   * Write the row for a new invitation, revoking whatever was outstanding for
   * the membership — as ONE transaction.
   *
   * ── Two autocommit statements left two live tokens ─────────────────────────
   * `POST /invites/resend` used to call a separate `revokeOutstandingForMembership`
   * and then `issueInvite`, each on its own connection. Two supervisors pressing
   * Resend at the same moment (or one double-click, which is the realistic
   * shape) could both revoke before either inserted, and the invariant this
   * whole path states — *one live token per membership* — silently became two:
   * an older link that was supposed to have stopped working keeps binding an
   * identity from a stale email.
   *
   * ── The transaction is NOT sufficient on its own, and that is why the index
   *    exists ──────────────────────────────────────────────────────────────────
   * Under READ COMMITTED the second transaction's revoke blocks on the first's
   * row lock, re-evaluates, and matches nothing — the winner's freshly inserted
   * row was not visible to that statement's snapshot, so it is not revoked. Both
   * transactions then insert. What refuses the second one is migration 069's
   * partial unique index `uq_membership_invites_live`
   * (`membership_id WHERE claimed_at IS NULL AND revoked_at IS NULL`): the
   * invariant is stated in the schema, where a future caller cannot route around
   * it, and this method is the code half that makes the ordinary case never
   * reach it.
   *
   * The loser is answered {@link LiveInviteConflictError} rather than a raw
   * `23505`, because `errorMaskHook` turns an escaping unique violation into
   * "contact support and quote this request id" for something the caller can
   * read plainly: somebody just issued the invitation they were asking for. It
   * throws rather than returning a result arm to match this module's existing
   * contract — `issueInvite` does not swallow database errors, deliberately,
   * because its two callers owe their users different answers (see that
   * function's docstring), and this is one more of them.
   *
   * ── Revoked, not deleted, and revoked BEFORE the new one is inserted ───────
   * Deleting the old rows would make an older link answer `not_found`, which
   * reads to the recipient as "this invitation never existed" — the one message
   * that is both wrong and unactionable. `revoked` lets `GET /invites/:token`
   * say "a newer invitation was sent; check your inbox".
   *
   * Expired rows are revoked too. "Outstanding" here means unclaimed and
   * unrevoked; whether the clock has passed is the claim path's judgement, and a
   * resend must revoke an expired token as well or the old link outlives the new
   * one in the `token_hash` index — and, now, holds the one live slot the index
   * allows.
   *
   * ── `tenant_id` is in the revoke's own predicate ───────────────────────────
   * The tenant boundary in the statement itself, on the only
   * tenant-route-reachable write in this repository. `POST /invites/resend` takes `membership_id` from a request body
   * and does resolve it through a tenant-scoped membership lookup first — so
   * this predicate refuses nothing that route lets through today. It is here
   * because that is a check in one place and a write in another, and the pair
   * can drift; with the boundary in the statement, a foreign membership revokes
   * nothing whatever a future caller forgot to do.
   *
   * `POST /users/invite` reaches this with a membership created moments earlier,
   * so its revoke matches zero rows every time. It runs anyway rather than being
   * branched around: "one live token per membership" is a property of the write,
   * not of which route made it, and a second issuing path that skipped the
   * revoke is exactly how the invariant would come back apart.
   */
  async createSupersedingOutstanding(
    input: CreateMembershipInviteInput,
  ): Promise<MembershipInviteRecord> {
    const pool = getPool();
    const client = await pool.connect();
    // See `claimWithIdentity` for why a failed ROLLBACK destroys the client
    // instead of returning it to the pool.
    let rollbackFailed = false;
    try {
      await client.query('BEGIN');

      await client.query(
        `UPDATE membership_invites
            SET revoked_at = NOW()
          WHERE membership_id = $1
            AND tenant_id = $2
            AND claimed_at IS NULL
            AND revoked_at IS NULL`,
        [input.membership_id, input.tenant_id],
      );

      const result = await client.query<MembershipInviteRecord>(
        `INSERT INTO membership_invites
           (membership_id, tenant_id, email, role, token_hash, expires_at, invited_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING *`,
        [
          input.membership_id,
          input.tenant_id,
          input.email,
          input.role,
          input.token_hash,
          input.expires_at,
          input.invited_by ?? null,
        ],
      );

      await client.query('COMMIT');
      return result.rows[0]!;
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        rollbackFailed = true;
      }
      if (isLiveInviteCollision(err)) throw new LiveInviteConflictError();
      throw err;
    } finally {
      client.release(rollbackFailed ? true : undefined);
    }
  }

  /**
   * The claim path's only entry point into this table.
   *
   * Returns the row whatever its state — claimed, revoked and expired rows all
   * come back, and the ROUTE decides what each one means. Filtering them here
   * would collapse "this link was already used" into "no such link", and those
   * are two different messages to a person holding an email: one tells them to
   * sign in, the other tells them to ask for a new invitation.
   */
  async findByTokenHash(tokenHash: string): Promise<MembershipInviteRecord | null> {
    const pool = getPool();
    const result = await pool.query<MembershipInviteRecord>(
      `SELECT * FROM membership_invites WHERE token_hash = $1`,
      [tokenHash],
    );
    return result.rows[0] || null;
  }

  /**
   * Spend the invite — the CONDITIONAL half of {@link claimWithIdentity}.
   *
   * `WHERE claimed_at IS NULL AND revoked_at IS NULL` is what makes a concurrent
   * double-claim resolve to exactly one winner, and the row count is what says
   * which caller won. A read-then-write would let both callers see `claimed_at`
   * NULL and both proceed: under READ COMMITTED the second UPDATE blocks on the
   * first's row lock and then **re-evaluates its predicate against the committed
   * row**, so it matches nothing and reports 0. That re-evaluation is the whole
   * mechanism; nothing about it survives being split into a `SELECT` and an
   * unconditional `UPDATE`.
   *
   * ── EXPIRY IS IN THE PREDICATE, not only in the route's JavaScript ────────
   * `expires_at > NOW()` is the third conjunct, and it is here because the
   * route's `inviteStatus` check runs BEFORE `verifyIdToken` — an outbound call
   * to Firebase — and before the membership read. A token whose TTL lapsed
   * inside that window was read as pending, verified, and then bound by an
   * `UPDATE` electing its winner on `claimed_at IS NULL AND revoked_at IS NULL`
   * alone. The clock is the one of the three states that changes with nobody
   * acting, so it is the one a JavaScript check upstream of two awaits is least
   * able to hold.
   *
   * `NOW()` is transaction-start time, so this conjunct and the classifying
   * re-read below see the same instant and cannot disagree with each other.
   *
   * **The MEMBERSHIP's validity is deliberately NOT folded in**, though the same
   * argument formally applies to it — `DELETE /users/:id/membership` can revoke
   * the membership inside the same window. Doing it would put an `EXISTS`
   * against `memberships` inside the statement that elects the single winner: a
   * second table's rows deciding which caller wins, and a fourth arm in the
   * classifying re-read, for a race whose outcome is benign. A claim that binds
   * an identity to a revoked membership grants NOTHING — `buildSessionPayload`
   * lists tenants and memberships through status-filtered lookups and
   * `tenantContextMiddleware` resolves the role the same way, so the claimant
   * gets a session with no tenants rather than access somebody has just removed.
   * The route's tenant-scoped `findByIdInTenant` read stays where it is and
   * answers the ordinary case with the right message; this statement stays about
   * the INVITE.
   *
   * ── WHICH predicate failed, and why a boolean was not enough ───────────────
   * There are three of them and they mean different things to the person holding
   * the link. A `false` reported for both made the route answer `claimed` —
   * *"This invitation has already been used. Sign in to continue"* — to somebody
   * whose token a `POST /invites/resend` had just revoked, whose actual remedy
   * is the newer mail already in their inbox, and who has no account to sign in
   * with yet. It also filed the outcome under
   * `invite_claims_total{result="already_claimed"}`, so resend churn was
   * invisible inside what reads as double-click noise. `InviteStatus` carries
   * four values precisely because these remedies differ; the repository is where
   * the distinction is knowable, so it is made here.
   *
   * The re-read is a SECOND statement rather than a `RETURNING` or a locking CTE,
   * and that is deliberate: the single-winner property above is a property of
   * this exact `UPDATE` re-evaluating its own predicate under READ COMMITTED, and
   * folding a `SELECT … FOR UPDATE` into the same statement changes which
   * snapshot each half sees. The follow-up read is correct without touching it —
   * it runs only on the 0-row path, by which point the writer this caller lost to
   * has committed, and READ COMMITTED gives the new statement a fresh snapshot
   * that sees it.
   *
   * Precedence is REVOKED, then CLAIMED, then EXPIRED, matching `inviteStatus`
   * in `invites.routes.ts`: revocation is the one outcome with a live next step
   * attached ("a newer one is already in your inbox"), a spent invite is
   * terminal, and expiry is the only one that is a function of the clock rather
   * than of something somebody did. A row that is several at once must answer
   * with the one that has a remedy attached.
   *
   * `db` is REQUIRED. It was optional, and no caller ever omitted it — spending
   * the invite outside {@link claimWithIdentity}'s transaction is exactly the
   * claim-without-bind split that method's docstring exists to forbid, so the
   * pool fallback was an untested path whose only use would have been a bug.
   */
  async markClaimed(
    inviteId: string,
    claimedByUserId: string,
    db: Queryable,
  ): Promise<MarkClaimedResult> {
    const result = await db.query(
      `UPDATE membership_invites
          SET claimed_at = NOW(), claimed_by_user_id = $2
        WHERE id = $1
          AND claimed_at IS NULL
          AND revoked_at IS NULL
          AND expires_at > NOW()`,
      [inviteId, claimedByUserId],
    );
    if ((result.rowCount ?? 0) > 0) return { ok: true };

    const current = await db.query<{
      claimed_at: Date | null;
      revoked_at: Date | null;
      expires_at: Date | null;
    }>(
      `SELECT claimed_at, revoked_at, expires_at FROM membership_invites WHERE id = $1`,
      [inviteId],
    );
    const row = current.rows[0];
    if (row?.revoked_at) return { ok: false, reason: 'revoked' };
    if (row?.claimed_at) return { ok: false, reason: 'already_claimed' };
    if (row?.expires_at && new Date(row.expires_at).getTime() <= Date.now()) {
      return { ok: false, reason: 'expired' };
    }
    // No row at all — and the residual shape where a row matches none of the
    // three, which the shared transaction timestamp should make unreachable —
    // falls to `already_claimed` rather than `revoked` or `expired`: rows here
    // are revoked and never deleted, so a missing one is not something a
    // recipient can be told to check their inbox about or to ask again for, and
    // "this link is spent" is the only honest terminal answer left.
    return { ok: false, reason: 'already_claimed' };
  }

  /**
   * Spend the invite AND bind the identity, as one transaction.
   *
   * ── Why the two writes cannot be two statements ─────────────────────────────
   * They are one fact — *this invitation has been used by this person* — and
   * every way of splitting them is wrong in a way nobody notices:
   *
   *  - **Claim first, then bind, separately.** A bind that fails (the
   *    `firebase_uid` collision below is the realistic one) leaves the invite
   *    SPENT with nobody bound to it. The recipient is now holding a dead link
   *    for a membership they still cannot reach, and the only remedy is a
   *    supervisor noticing and resending.
   *  - **Bind first, then claim.** Both callers of a concurrent double-claim
   *    bind before either claims. If the two claims carry DIFFERENT Firebase
   *    identities — which is exactly the case a leaked token produces — the
   *    second bind silently overwrites the first, and the loser of the claim has
   *    already taken the membership over.
   *
   * Inside one transaction the conditional UPDATE still elects exactly one
   * winner (see {@link markClaimed}), and a failed bind rolls the claim back, so
   * the invite is still outstanding and the recipient can simply try again.
   *
   * ── Order within the transaction: claim, then bind ──────────────────────────
   * The claim's row lock is taken first, so the loser of a race blocks and
   * refuses BEFORE it can write anything to `users`. Binding first would have
   * both transactions write the same row and serialise on it anyway, but with
   * the wrong one able to land its write.
   */
  async claimWithIdentity(input: {
    inviteId: string;
    userId: string;
    /**
     * The INVITE's own tenant, and the only workspace this claim may activate.
     *
     * Taken from `membership_invites.tenant_id` by the route rather than from a
     * header or from the membership the route read, for the reason every other
     * tenant predicate in this file is: the boundary belongs in the same
     * statement as the write. See
     * {@link AdoptIdentityOptions.confineStubToTenantId}.
     */
    tenantId: string;
    /**
     * `email_verified` is named EXPLICITLY, and its absence here was invisible.
     *
     * It is optional on `DecodedFirebaseToken`, so a `Pick` that leaves it out
     * still type-checks against `adoptFirebaseIdentity` — and silently means
     * "unverified", which is the direction that flags every row. The claim must
     * pass the token's own answer, so the contract has to say so.
     */
    identity: Pick<DecodedFirebaseToken, 'uid' | 'name' | 'picture' | 'email' | 'email_verified'>;
  }): Promise<ClaimInviteResult> {
    const pool = getPool();
    const client = await pool.connect();
    // Set when ROLLBACK itself fails; such a client may still hold an open
    // transaction, so it is destroyed rather than returned to the pool. Same
    // guard, for the same reason, as `membershipRepository.withLastOwnerGuard`.
    let rollbackFailed = false;
    try {
      await client.query('BEGIN');

      const won = await this.markClaimed(input.inviteId, input.userId, client);
      if (!won.ok) {
        await client.query('ROLLBACK');
        // `revoked`, `already_claimed` and `expired` are carried through
        // unchanged — the route turns each into a different sentence, and
        // flattening them here would put the distinction back where it cannot be
        // recovered.
        return { ok: false, reason: won.reason };
      }

      /**
       * ── Lock the user row BEFORE the bind decides anything about it ────────
       * `confineStubToTenantId` asks whether this row carries active
       * memberships in other tenants, and a `NOT EXISTS` is a snapshot read: it
       * takes no lock on rows that do not exist yet. A concurrent
       * `POST /users/invite` resolving the same address can INSERT exactly such
       * a membership after that subquery is evaluated and before this
       * transaction commits, and the bind then lands on a row that now grants
       * the foreign membership — the takeover the predicate exists to stop,
       * reached through an interleaving.
       *
       * Taking the row lock as its own statement first is what makes the check
       * sound, and the ordering is the whole point: under READ COMMITTED each
       * statement takes a fresh snapshot, so the UPDATE below is planned AFTER
       * this lock is held and therefore sees every membership committed by an
       * invite that got there first. An invite that arrives second blocks on
       * this lock until the claim commits, and the guard on its own write
       * (`membershipRepository.create`'s `requireProvenEmail`) then finds the
       * row flagged and declines to attach anything.
       *
       * Deliberately NOT relying on the UPDATE's own row lock to do this. That
       * would leave the re-check to EvalPlanQual re-evaluating a subquery
       * against a new row version, which is subtle enough that nobody reading
       * this later should have to reason about it.
       */
      await client.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [input.userId]);

      /**
       * Both options are load-bearing security, and they close different halves
       * of the same problem — see {@link AdoptIdentityOptions} for the full
       * chain behind each.
       *
       * `onlyUnclaimedStub` keeps this from being an account takeover: the claim
       * binds an identity with no relation to the invited address, and
       * `POST /users/invite` will happily aim a membership at an EXISTING user
       * row when the address is already known, so binding is safe only against a
       * row nobody ELSE can sign in as. (A row already carrying the incoming uid
       * is bound again idempotently — that is the ordinary "invite somebody who
       * already has a login" case, not a takeover.)
       *
       * `confineStubToTenantId` closes the half `onlyUnclaimedStub` cannot see.
       * That predicate asks whether anybody has signed in as this row, and for a
       * `pending_` stub the honest answer is no — even when the stub is ALSO
       * another workspace's pending owner, which the same reuse rule makes
       * routine. Activating it then returned every active membership on the row
       * through `buildSessionPayload`, so a token minted in the attacker's own
       * tenant conferred a `tenant_owner` membership in somebody else's. A claim
       * may only ever activate the tenant its token names.
       *
       * `adoptEmail` keeps the row findable only under the identity that bound
       * it. Without it, a mismatched claim leaves `users.email` naming the
       * INVITED address while `firebase_uid` names the CLAIMANT, and
       * `POST /auth/session` path 2 — which looks up by that column and adopts
       * with no `onlyUnclaimedStub` — hands the row to whoever next presents a
       * token for the invited address.
       *
       * It runs INSIDE this transaction rather than as a follow-up statement for
       * the same reason the claim and the bind share one: a bind that landed
       * with the email write missing is precisely the swapped-identity row this
       * option exists to prevent, and a second statement afterwards can fail on
       * its own.
       */
      const user = await adoptFirebaseIdentity(
        client,
        input.userId,
        input.identity,
        null,
        {
          onlyUnclaimedStub: true,
          adoptEmail: true,
          confineStubToTenantId: input.tenantId,
        },
      );
      if (!user) {
        /*
         * THREE different states arrive here and they owe the recipient
         * different sentences, so the row is re-read to tell them apart. Inside
         * the same transaction, so the answer cannot be stale — and in ONE
         * statement, because "is this row still a stub" and "does it belong to
         * another workspace too" read against each other and two statements
         * could see a membership written in between.
         *
         * The invite is rolled back in EVERY case: an invite that could not be
         * spent must stay outstanding, or a supervisor's fix (a resend) would be
         * spent against a link the recipient never successfully used.
         */
        const current = await client.query<{
          firebase_uid: string;
          has_foreign_membership: boolean;
        }>(
          `SELECT u.firebase_uid,
                  EXISTS (
                    SELECT 1
                      FROM memberships m
                     WHERE m.user_id = u.id
                       AND m.status = 'active'
                       AND m.tenant_id <> $2
                  ) AS has_foreign_membership
             FROM users u
            WHERE u.id = $1`,
          [input.userId, input.tenantId],
        );
        await client.query('ROLLBACK');
        const row = current.rows[0];
        // The membership pointed at a user row that is no longer there. Nothing
        // to bind, so nothing to spend the invite on either.
        if (!row) return { ok: false, reason: 'already_claimed' };
        // Bound to a DIFFERENT real Firebase account — the claimant's own uid
        // would have matched both predicates' "already this identity" arm and
        // bound. Reported ahead of the confinement arm because it is the more
        // actionable of the two ("sign in with the other account"), and because
        // a row that is already somebody's is no longer a stub to confine.
        if (
          !row.firebase_uid.startsWith(PENDING_UID_PREFIX)
          && row.firebase_uid !== input.identity.uid
        ) {
          return { ok: false, reason: 'identity_already_bound' };
        }
        // A stub that several workspaces are waiting on. See
        // `AdoptIdentityOptions.confineStubToTenantId`.
        if (row.has_foreign_membership) return { ok: false, reason: 'cross_tenant_identity' };
        // Neither predicate explains it — the residual shape, which the shared
        // transaction should make unreachable. Answered as the refusal it most
        // likely is rather than as a masked 500.
        return { ok: false, reason: 'identity_already_bound' };
      }

      await client.query('COMMIT');
      return { ok: true, user };
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        rollbackFailed = true;
      }
      // The one error this layer answers rather than raises. See
      // `isFirebaseUidCollision` for why the constraint name is checked and not
      // just the SQLSTATE, and `ClaimInviteResult` for why the route needs it as
      // a distinct arm rather than as a masked 500.
      if (isFirebaseUidCollision(err)) return { ok: false, reason: 'identity_in_use' };
      throw err;
    } finally {
      client.release(rollbackFailed ? true : undefined);
    }
  }
}

export const membershipInviteRepository = new MembershipInviteRepository();
