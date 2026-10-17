import { randomUUID } from 'node:crypto';
import { getPool } from '@magick-agency/db';
import { withTransaction } from '@magick-agency/db/utils/transaction';
import { userRepository, type ProvenEmailResolution } from '@magick-agency/db/repositories/user.repository';
import { membershipRepository } from '@magick-agency/db/repositories/membership.repository';
import type { MembershipRecord, MembershipRole } from '@magick-agency/db/models/membership.model';
import type { UserRecord } from '@magick-agency/db/models/user.model';
import { createChildLogger } from '@magick-agency/observability';
import {
  PENDING_UID_PREFIX,
  UNVERIFIED_ADDRESS_HOLDER,
} from '../auth/firebase-identity.js';
import { issueInvite, type IssueInviteInput } from './invite-issuer.js';
import type { InviteEmailResult } from '../notifications/invite-mailer.js';

/**
 * Putting a person into a workspace: the find-or-stub of their `users` row, the
 * create-or-reactivate of their membership, and the invitation that follows — shared by
 * `POST /users/invite` (a tenant admin) and the super-admin tree (`POST /tenants`,
 * `POST /tenants/:id/users`).
 *
 * The two entry points keep their own mechanics, and on purpose:
 *  - the tenant-side invite writes through the repositories with no transaction, and closes
 *    the race with a concurrent claim INSIDE each write (`requireProvenEmail`);
 *  - the super-admin flows take row locks in one transaction (`withTransaction`): the user
 *    row through `resolveByProvenEmail({ lock: true })` and every leftover membership row
 *    `FOR UPDATE`, so the same three rules hold without the per-write guard.
 *
 * What this module does NOT do: HTTP. Every outcome is a typed result the route maps to its
 * own status and wording, every audit row (and its `requestAuditActor`) stays at the route,
 * and so does the membership-cache invalidation, which is ordered against the response.
 */

const log = createChildLogger({ component: 'membership-provisioning' });

/** A `users.firebase_uid` for a stub nobody has signed in as yet, from the SHARED prefix. */
export function pendingStubUid(): string {
  return `${PENDING_UID_PREFIX}${randomUUID()}`;
}

/**
 * The 409 for an address every `users` row of which is `email_unverified`: the identity
 * already bound to it holds the only row there is, so a fresh stub would be a second row
 * for an identity that has one (`firebase_uid` is UNIQUE, and that person's claim would
 * raise `23505`). The remedy is one the recipient can perform; `then` names the caller's
 * own next step ("send the invitation again", "add them again", ...).
 */
export function unverifiedAddressHolderBody(then: string): { error: string; code: string; message: string } {
  return {
    error: 'Conflict',
    code: UNVERIFIED_ADDRESS_HOLDER,
    message:
      'That email belongs to an account that has not verified this address. '
      + `Ask them to sign in and verify it, then ${then}.`,
  };
}

/**
 * Is this role change one that should close the user's agency staffing?
 *
 * **Only a change AWAY from `agent`, and the predicate says exactly that** rather
 * than "the roles differ", because the three other directions must not touch
 * staffing and each for its own reason:
 *
 *  - **to `agent`** (`viewer` → `agent`, say) is somebody being made an agent.
 *    They hold no staffing yet and a supervisor is about to give them some; closing
 *    on this direction would be a no-op today and would silently undo an
 *    assignment made in the same minute tomorrow.
 *  - **between two non-agent roles** (`operator` → `account_admin`) is a promotion
 *    that has nothing to do with the dialer. Supervisors and admins CAN be staffed
 *    — `POST /campaigns/:id/agents` requires only a membership, so covering a
 *    shift is expressible — and unstaffing them for an unrelated promotion would
 *    destroy a real staffing decision.
 *  - **`agent` → `agent`** is not a change at all.
 *
 * `to` is typed as `MembershipRole` rather than compared against the literal
 * string, so a future role named `agent_lead` cannot satisfy this by accident.
 * Used by `PUT /users/:id/role` and the super-admin role change alike.
 */
export function isDemotionFromAgent(from: MembershipRole, to: MembershipRole): boolean {
  return from === 'agent' && to !== 'agent';
}

/** What {@link issueInviteReportingFailure} reports. */
export interface InviteOutcome {
  signInUrl: string | null;
  inviteEmail: InviteEmailResult;
  inviteId: string | null;
}

/**
 * Issue the invitation for a membership that has ALREADY committed — and never let that
 * fail the request.
 *
 * `issueInvite` mints a token, writes a `membership_invites` row, reads the tenant and
 * inviter names, resolves the join URL and sends the mail: five things that can fail, all
 * after the membership is durable. A throw from any of them escaping as a 500 would tell
 * the caller the add failed; they retry and meet a 409 from the row the "failed" attempt
 * created. So everything to do with the invitation is inside this guard, a throw is logged
 * at ERROR and reported as `{ sent: false, reason: 'failed' }`, and the recovery is
 * `POST /invites/resend`. Anything that resolves config lazily (the join URL) must stay
 * inside it too.
 *
 * `sign_in_url: null` is the degraded value: the response already documents `null` as
 * "`CONSOLE_BASE_URL` is unset", and "could not be resolved" is the same fact from the
 * caller's side.
 */
export async function issueInviteReportingFailure(
  input: IssueInviteInput,
  invitedUserId: string,
): Promise<InviteOutcome> {
  try {
    const issued = await issueInvite(input);
    return { signInUrl: issued.signInUrl, inviteEmail: issued.inviteEmail, inviteId: issued.invite?.id ?? null };
  } catch (err) {
    log.error(
      {
        tenantId: input.tenantId,
        invitedUserId,
        err: err instanceof Error ? err.message : String(err),
      },
      'Invite issuance threw; the membership stands and the invite is reported unsent',
    );
    return { signInUrl: null, inviteEmail: { sent: false, reason: 'failed' }, inviteId: null };
  }
}

// ── POST /users/invite ──────────────────────────────────────────────────────

/** What {@link inviteMember} did. Nothing is written on any arm but `invited`. */
export type InviteMemberResult =
  | { status: 'invited'; membership: MembershipRecord; user: UserRecord }
  /** Every row for the address is `email_unverified` (before the write or during it). */
  | { status: 'unproven_conflict' }
  /** The address now resolves to a different row, or none: a claim rebound it mid-write. */
  | { status: 'address_rebound' }
  /** An active membership already exists in this context. */
  | { status: 'already_member' };

/**
 * The tenant-side invite's write: find-or-stub the user from the address resolution the
 * route already made, then create or reactivate the membership in the requested account
 * context — each write guarded by `requireProvenEmail`.
 *
 * The route resolves the address itself (`userRepository.resolveByProvenEmail`, alongside
 * its account check) and hands the resolution in, refusing `unproven_conflict` first.
 */
export async function inviteMember(input: {
  tenantId: string;
  email: string;
  role: MembershipRole;
  accountId: string | null;
  invitedBy: string | undefined;
  resolved: Exclude<ProvenEmailResolution, { status: 'unproven_conflict' }>;
}): Promise<InviteMemberResult> {
  const { tenantId, email, role, accountId } = input;
  let user = input.resolved.status === 'found' ? input.resolved.user : null;
  if (!user) {
    // Create a stub user that will be activated on first Firebase sign-in
    user = await userRepository.create({
      /**
       * The stub uid, built from the SHARED prefix rather than a literal.
       *
       * Every writer of the `pending_` convention and every reader of it now
       * resolves the one exported constant in `auth/firebase-identity.ts`.
       * The writers are {@link pendingStubUid}'s callers (this invite and
       * super-admin's two stub-user inserts, tenant create and member add); the
       * readers are `adoptFirebaseIdentity`'s `onlyUnclaimedStub` predicate,
       * `deriveMembershipInviteState`, super-admin's `is_pending`, and
       * `/auth/session`'s `wasPending` log field.
       *
       * Literals meant the places that MINT the value could drift from the
       * places that INTERPRET it, and nothing would have reported it: a
       * renamed prefix would simply have made every future invitee read as an
       * already-activated account, and `onlyUnclaimedStub` would have refused
       * every legitimate claim.
       */
      firebase_uid: pendingStubUid(),
      email,
    });
  }

  /**
   * Include leftover `revoked`/`inactive` rows. `findByUserAndTenant` filters
   * `status = 'active'`, so a departed member looked like a new invitee and
   * the INSERT then hit `idx_memberships_user_tenant_level` (or
   * `UNIQUE(user_id, tenant_id, account_id)`), which `errorMaskHook` rewrites
   * into a generic duplicate-key 500. Super-admin add has the same hole;
   * both reactivate the leftover and apply the requested role.
   */
  const existing = await membershipRepository.findAnyByUserAndTenant(user.id, tenantId);
  const matching = existing.find((m) =>
    accountId ? m.account_id === accountId : m.account_id === null,
  );
  if (matching?.status === 'active') return { status: 'already_member' };

  /**
   * `requireProvenEmail` closes the window between the address resolving
   * above and the membership landing here: a concurrent claim can rebind that
   * row in between, and attaching authority to it afterwards is the takeover
   * this route's lookup exists to stop, reached through an interleaving
   * instead of a missing check. The guard locks the user row in the same
   * statement as the write, so a row that changed hands in the meantime gets
   * no membership at all.
   *
   * The ADDRESS is what it is given, not a boolean. A claim carrying a
   * VERIFIED address that differs from the invited one rewrites `users.email`
   * to the claimant's and leaves `email_unverified` false, so a flag-only
   * recheck passed and this INSERT landed on the claimant's row — the same
   * takeover, through the one arm the flag cannot see.
   */
  const membership = matching
    ? await membershipRepository.reactivateWithRole(
      matching.id,
      role,
      tenantId,
      { requireProvenEmail: email },
    )
    : await membershipRepository.create({
      user_id: user.id,
      tenant_id: tenantId,
      account_id: accountId || null,
      role,
      invited_by: input.invitedBy,
    }, { requireProvenEmail: email });

  if (membership) return { status: 'invited', membership, user };

  /**
   * Nothing was written, and there are THREE reasons for that: a concurrent
   * reactivate won the leftover (#280's case), a concurrent claim bound the
   * row with an UNVERIFIED address (it is flagged now), or a concurrent
   * claim bound it with a VERIFIED one (the row is keyed under the
   * claimant's address now, and is no longer this address's row at all).
   * Re-read to say which — this decides only the WORDING, never whether to
   * write, so it cannot be a check that disagrees with the write it follows.
   */
  const after = await userRepository.resolveByProvenEmail(email);
  if (after.status === 'unproven_conflict') {
    log.warn(
      { tenantId },
      'Invite refused: the address was bound by a claim while this invite was being written',
    );
    return { status: 'unproven_conflict' };
  }
  /**
   * The row this invite resolved no longer answers to this address, so the
   * guard refused rather than writing onto whoever holds it now. Retrying
   * is the remedy and it genuinely works: the next lookup resolves the
   * address afresh, finding either its new rightful row or nothing, in
   * which case a fresh stub is written.
   */
  if (after.status === 'none' || after.user.id !== user.id) {
    log.warn(
      { tenantId },
      'Invite refused: the address changed hands while this invite was being written',
    );
    return { status: 'address_rebound' };
  }
  return { status: 'already_member' };
}

// ── The super-admin tree ────────────────────────────────────────────────────

/**
 * The owner's (or added member's) `users` row on a super-admin transaction: the proven
 * row for the address, locked, or a fresh `pending_` stub — or `null` when every row for
 * the address is flagged (`unproven_conflict`; the caller rolls back and refuses).
 *
 * `email_unverified = false` is not optional here, and it is the same rule
 * `POST /users/invite` applies: a `users` row can be bound to an identity that never proved
 * its address (an invite claim accepts an unverified Firebase token by design), so reusing
 * one by address hands authority to whoever claimed it. Through the REPOSITORY, on the
 * transaction's own client — a hand-copied lookup would be a second definition of the rule,
 * and a mutation dropping `AND email_unverified = false` from one copy passes every test
 * that runs its own copy. A miss writes a fresh stub beside a flagged row, which is correct:
 * they are two principals sharing a string, and `users.email` has never been unique.
 */
async function provenOrStubUser(
  client: import('pg').PoolClient,
  email: string,
  displayName: string | undefined,
): Promise<string | null> {
  const resolved = await userRepository.resolveByProvenEmail(email, { client, lock: true });
  if (resolved.status === 'unproven_conflict') return null;
  if (resolved.status === 'found') return resolved.user.id;
  const userResult = await client.query<{ id: string }>(
    `INSERT INTO users (firebase_uid, email, display_name) VALUES ($1, $2, $3) RETURNING *`,
    [pendingStubUid(), email, displayName || null],
  );
  return userResult.rows[0]!.id;
}

/** What {@link provisionTenantWithOwner} did. */
export type ProvisionTenantResult =
  | { status: 'created'; tenant: Record<string, unknown> & { id: string } }
  | { status: 'unproven_conflict' };

/**
 * `POST /super-admin/tenants`: the tenant, its `Default` account, the owner's user row
 * (proven or a `pending_` stub) and the `tenant_owner` membership, in ONE transaction.
 * An `unproven_conflict` rolls everything back — a stub made `tenant_owner` there would be
 * a membership nobody can ever claim.
 */
export async function provisionTenantWithOwner(input: {
  name: string;
  slug: string;
  ownerEmail: string;
  ownerName: string | undefined;
}): Promise<ProvisionTenantResult> {
  return withTransaction(async (client, tx) => {
    // Create tenant
    const tenantResult = await client.query<Record<string, unknown> & { id: string }>(
      `INSERT INTO tenants (name, slug) VALUES ($1, $2) RETURNING *`,
      [input.name, input.slug],
    );
    const tenant = tenantResult.rows[0]!;

    // Create default account
    await client.query(
      `INSERT INTO accounts (tenant_id, name, slug) VALUES ($1, 'Default', 'default')`,
      [tenant.id],
    );

    const userId = await provenOrStubUser(client, input.ownerEmail, input.ownerName);
    if (userId === null) {
      await tx.rollback();
      return { status: 'unproven_conflict' };
    }

    // Create tenant_owner membership
    await client.query(
      `INSERT INTO memberships (user_id, tenant_id, role) VALUES ($1, $2, 'tenant_owner')`,
      [userId, tenant.id],
    );
    return { status: 'created', tenant };
  }, { pool: getPool() });
}

/** What {@link addTenantMember} did. */
export type AddTenantMemberResult =
  | { status: 'added'; membership: Record<string, unknown> & { id: string; account_id: string | null }; userId: string }
  | { status: 'unproven_conflict' }
  | { status: 'already_member' };

/**
 * `POST /super-admin/tenants/:id/users`: find or stub the user, then create or reactivate
 * their membership in the requested context, in ONE transaction.
 *
 * Memberships are soft-deleted (offboarding sets `status = 'revoked'`); unique indexes
 * still apply, so an INSERT of the same user+tenant is 23505 rather than a 409. So every
 * leftover row for this user in this tenant is locked, then, without `accountId`:
 *  - any `active` row → they are already a member;
 *  - a tenant-level leftover (`account_id IS NULL`) → reactivated with the requested role;
 *  - otherwise a new tenant-level membership.
 * With `accountId`, the same three rules are keyed on the ACCOUNT context instead: an
 * `active` row for this account → already a member; a leftover for this account
 * (`UNIQUE(user_id, tenant_id, account_id)`) → reactivated; otherwise an account-scoped
 * INSERT. Rows for other contexts — including an active tenant-wide one — are left alone,
 * as `POST /users/invite` leaves them (one membership per account is the model).
 *
 * The caller checks the tenant and the account (scoped to the tenant) BEFORE this opens
 * the transaction, and issues the invitation after it commits.
 */
export async function addTenantMember(input: {
  tenantId: string;
  email: string;
  role: MembershipRole;
  name: string | undefined;
  accountId: string | null;
}): Promise<AddTenantMemberResult> {
  const { tenantId, role } = input;
  const contextAccountId = input.accountId;
  return withTransaction<AddTenantMemberResult>(async (client, tx) => {
    const userId = await provenOrStubUser(client, input.email, input.name);
    if (userId === null) {
      await tx.rollback();
      return { status: 'unproven_conflict' };
    }

    const existingMemberships = await client.query<{
      id: string;
      account_id: string | null;
      status: string;
    }>(
      `SELECT * FROM memberships WHERE user_id = $1 AND tenant_id = $2 FOR UPDATE`,
      [userId, tenantId],
    );
    const alreadyMember = contextAccountId === null
      ? existingMemberships.rows.some((m) => m.status === 'active')
      : existingMemberships.rows.some((m) => m.account_id === contextAccountId && m.status === 'active');
    if (alreadyMember) {
      await tx.rollback();
      return { status: 'already_member' };
    }

    const leftover = existingMemberships.rows.find((m) => m.account_id === contextAccountId);
    const membershipResult = leftover
      ? await client.query(
        `UPDATE memberships SET status = 'active', role = $1 WHERE id = $2 RETURNING *`,
        [role, leftover.id],
      )
      : contextAccountId === null
        ? await client.query(
          `INSERT INTO memberships (user_id, tenant_id, role) VALUES ($1, $2, $3) RETURNING *`,
          [userId, tenantId, role],
        )
        : await client.query(
          `INSERT INTO memberships (user_id, tenant_id, account_id, role) VALUES ($1, $2, $3, $4) RETURNING *`,
          [userId, tenantId, contextAccountId, role],
        );

    /**
     * Offboard leaves `membership_invites` alone on purpose: claim and the
     * public GET treat a non-active membership as `revoked`. Reactivating
     * that same id would make an unclaimed, unexpired token claimable again,
     * and the claim binds whatever role was just written here — not the role
     * the old mail described. Same predicate `createSupersedingOutstanding`
     * uses. It runs inside the membership write's transaction, so no window
     * exists in which the old token is live against the new role, and the
     * invitation issued after COMMIT through `createSupersedingOutstanding`
     * then finds nothing outstanding to supersede.
     */
    const membershipId = membershipResult.rows[0]?.id;
    if (membershipId) {
      await client.query(
        `UPDATE membership_invites
            SET revoked_at = NOW()
          WHERE membership_id = $1
            AND tenant_id = $2
            AND claimed_at IS NULL
            AND revoked_at IS NULL`,
        [membershipId, tenantId],
      );
    }

    return { status: 'added', membership: membershipResult.rows[0]!, userId };
  }, { pool: getPool() });
}
