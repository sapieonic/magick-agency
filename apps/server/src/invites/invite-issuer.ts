import { membershipInviteRepository } from '../db/repositories/membership-invite.repository.js';
import { tenantRepository } from '@magick-agency/db/repositories/tenant.repository';
import { userRepository } from '@magick-agency/db/repositories/user.repository';
import { mintInviteToken } from '../notifications/invite-token.js';
import {
  inviteSignInUrl,
  sendInviteEmail,
  type InviteEmailResult,
} from '../notifications/invite-mailer.js';
import { inviteEmailsTotal } from '@magick-agency/observability/metrics/platform';
import { createChildLogger } from '@magick-agency/observability';
import type { MembershipRole } from '@magick-agency/db/models/membership.model';
import type { MembershipInviteRecord } from '../db/models/membership-invite.model.js';

const log = createChildLogger({ component: 'invite-issuer' });

/**
 * Issue an invitation: mint the token, write the row, send the mail.
 *
 * ── Why this is one function and not inline in each route ──────────────────
 * Two routes issue invitations — `POST /users/invite` (the first one) and
 * `POST /invites/resend` (every one after) — and they must produce IDENTICAL
 * artefacts: the same token shape, the same TTL, the same join URL, the same
 * template, the same counter increment. A resend that differed in any of those
 * would be a second, subtly different onboarding path that only shows up when a
 * customer uses it, which is precisely the case where somebody is already having
 * trouble.
 *
 * ── What it deliberately does NOT do ───────────────────────────────────────
 * It writes no audit row. The audit actor is a property of the REQUEST
 * (`requestAuditActor` distinguishes a human from a platform API key from a
 * background write), and threading a `FastifyRequest` into this module to
 * recover it would drag the whole HTTP layer into a unit that is otherwise
 * testable with two repository doubles. Each route writes its own
 * `user.invite_sent` row from what this returns.
 *
 * ── A mailed link is claimable by the person it was mailed to, always ──────
 * Worth stating because the reverse was true for one commit and is the sort of
 * thing that gets re-derived: `POST /users/invite` reuses an EXISTING `users`
 * row when the address is already known, so this function mints tokens for
 * invitees whose `firebase_uid` is already real, not only for `pending_` stubs.
 * That is not a token that cannot be redeemed — the claim's bind predicate
 * admits a row already carrying the CLAIMANT's own uid
 * (`AdoptIdentityOptions`), so the rightful owner spends the invite and is
 * signed in, while a different identity is still refused. Issuance therefore
 * needs no "is this row already bound" branch, and adding one would refuse the
 * ordinary "add an agent who already has a login" invite at the point where the
 * supervisor is told it worked.
 *
 * It also does not swallow database errors. Minting and persisting are the parts
 * that can genuinely fail, and the CALLER is the one that knows whether a
 * failure here is fatal: `POST /users/invite` has already written a membership
 * and must still answer 201 (its own try/catch guarantees that), while
 * `POST /invites/resend` has written nothing and should answer 500 so the
 * supervisor knows to press the button again. Collapsing both into a returned
 * reason here would make the second one lie.
 */
export interface IssueInviteInput {
  membershipId: string;
  tenantId: string;
  email: string;
  role: MembershipRole;
  /** The supervisor issuing it. Recorded on the row and named in the email. */
  invitedBy?: string | null;
}

export interface IssuedInvite {
  /**
   * The row, or `null` for a role that gets no token.
   *
   * `null` is not a failure: only an `agent` invite mints one today (see
   * `invite-mailer.ts`'s scope note), and a `viewer` invite has never had a
   * claim flow to bind. Writing an unusable row for them would put a table full
   * of tokens nothing can redeem in front of the next reader.
   */
  invite: MembershipInviteRecord | null;
  /**
   * The link, as it goes on the response's `sign_in_url` AND into the email.
   *
   * One value, resolved once, for both: an email whose link disagrees with the
   * one the supervisor is looking at on screen is unfalsifiable from a bug
   * report.
   */
  signInUrl: string | null;
  inviteEmail: InviteEmailResult;
}

/**
 * Whether this role gets a token-bound invitation at all.
 *
 * A predicate rather than an inline `=== 'agent'` at three call sites, because
 * the whole feature is scoped by it and a future workspace-onboarding page is
 * expected to widen it. Everything downstream — the row, the join URL, the mail
 * — hangs off this one answer, so widening it is a one-line change here rather
 * than a hunt for the places that assumed `agent`.
 */
export function roleGetsTokenInvite(role: MembershipRole): boolean {
  return role === 'agent';
}

export async function issueInvite(input: IssueInviteInput): Promise<IssuedInvite> {
  const { role, tenantId } = input;

  if (!roleGetsTokenInvite(role)) {
    // No token, no row, and `inviteSignInUrl` answers `/login` — today's exact
    // behaviour for every non-agent role, unchanged. The mailer still runs
    // because it is what reports `not_implemented`, and that reason is what the
    // customer UI reads to decide whether to keep showing the hand-off panel.
    const signInUrl = await inviteSignInUrl(role);
    const inviteEmail = await sendOrReportFailure({ email: input.email, role, tenantId, signInUrl });
    return { invite: null, signInUrl, inviteEmail };
  }

  const minted = await mintInviteToken();

  /**
   * The row is written BEFORE the mail is sent, and the order is the decision.
   *
   * A token that has been mailed but not stored is unredeemable — the recipient
   * holds a link that resolves to nothing, and neither they nor the supervisor
   * can tell that from a typo'd address. A token that has been stored but not
   * mailed is merely unused: `POST /invites/resend` revokes it and issues
   * another, and `GET /invites/:token` would answer honestly if it ever were
   * clicked. One of those two failures is recoverable and the other is not.
   *
   * ── The revoke belongs to the WRITE, not to the resend route ──────────────
   * `createSupersedingOutstanding` revokes whatever was outstanding for the
   * membership in the same transaction as the insert. The resend route used to
   * revoke separately, one autocommit statement earlier, which let two
   * concurrent resends both revoke before either inserted and leave two live
   * links. Doing it here means "one live token per membership" holds for every
   * issuing path — including a future third one — rather than for the routes
   * that remembered. On a first invite the revoke matches nothing, which is the
   * correct no-op rather than a reason to branch.
   *
   * It can throw `LiveInviteConflictError` when a concurrent issue won the
   * membership's live slot. That is not swallowed here, for the reason given in
   * this module's header: `POST /invites/resend` turns it into a 409 that names
   * what happened, while `POST /users/invite`'s guard reports the mail unsent
   * and keeps its 201. Nothing is mailed on that path, because the send is below
   * this line.
   */
  const invite = await membershipInviteRepository.createSupersedingOutstanding({
    membership_id: input.membershipId,
    tenant_id: tenantId,
    email: input.email,
    role,
    token_hash: minted.tokenHash,
    expires_at: minted.expiresAt,
    invited_by: input.invitedBy ?? null,
  });

  // Neither name may fail the invite, so both are resolved together and each
  // resolver answers `null` rather than raising — see `resolveTenantName`.
  const [tenantName, inviterName] = await Promise.all([
    resolveTenantName(tenantId),
    resolveInviterName(input.invitedBy),
  ]);

  const signInUrl = await inviteSignInUrl(role, minted.token);
  const inviteEmail = await sendOrReportFailure({
    email: input.email,
    role,
    tenantId,
    signInUrl,
    tenantName,
    inviterName,
    expiresAt: minted.expiresAt,
  });

  return { invite, signInUrl, inviteEmail };
}

/**
 * Send, count, and CONTAIN a rejection here rather than letting it escape.
 *
 * ── Why the send is guarded when the caller already guards everything ──────
 * `POST /users/invite` wraps this whole module in a try/catch, so a rejection
 * would not fail the request either way. What it WOULD do is take
 * `signInUrl` down with it: the route sets that field from what this function
 * returns, so a throw past this point leaves `sign_in_url: null` on a response
 * where the URL had already been resolved successfully. The supervisor then
 * loses the link they need in order to hand it over by hand — which is the
 * fallback the whole `sent: false` contract exists to enable, and it is the one
 * thing that still works when mail does not.
 *
 * `sendInviteEmail` is documented as total and is guarded anyway, for the reason
 * the invite route gives about guarding it: totality is a promise made in a
 * docstring, and this is a place where breaking it costs something specific.
 *
 * The counters are incremented HERE, on every path, so an outcome cannot be
 * unrecorded — including this one, which is exactly the arm somebody would
 * forget.
 */
async function sendOrReportFailure(
  input: Parameters<typeof sendInviteEmail>[0],
): Promise<InviteEmailResult> {
  let result: InviteEmailResult;
  try {
    result = await sendInviteEmail(input);
  } catch (err) {
    log.error(
      { err, tenantId: input.tenantId, role: input.role },
      'Invite mailer rejected despite being documented total; reported as failed',
    );
    result = { sent: false, reason: 'failed' };
  }
  countInviteEmail(input.role, result);
  return result;
}

/**
 * The one place an invite-mail outcome is counted, so the next issuing route
 * cannot forget an arm of it.
 */
function countInviteEmail(role: MembershipRole, result: InviteEmailResult): void {
  const label = result.sent ? 'sent' : result.reason;
  inviteEmailsTotal.inc({ role, result: label });
}

/**
 * The organisation's name for the email's supporting line.
 *
 * Failures are SWALLOWED and reported as `null`, which the template renders as a
 * generic fallback. That is the right trade and worth stating: this is one word
 * of context in one sentence, and an invited agent's only route into the product
 * must not be blocked by a `tenants` lookup. The same reasoning
 * `resolveGovernanceSafe` uses for login.
 */
async function resolveTenantName(tenantId: string): Promise<string | null> {
  try {
    return (await tenantRepository.findById(tenantId))?.name ?? null;
  } catch (err) {
    log.warn({ err, tenantId }, 'Could not resolve tenant name for an invite email');
    return null;
  }
}

/**
 * Who to name as the inviter, or `null`.
 *
 * `display_name` only — never the email address as a fallback. Naming a
 * supervisor's address to somebody who is not yet a member of anything would
 * disclose it outside the tenant, and the template already has a sentence for
 * the unnamed case ("You have been set up as…") that reads correctly rather than
 * inventing an actor.
 */
async function resolveInviterName(invitedBy?: string | null): Promise<string | null> {
  if (!invitedBy) return null;
  try {
    return (await userRepository.findById(invitedBy))?.display_name ?? null;
  } catch (err) {
    log.warn({ err }, 'Could not resolve inviter name for an invite email');
    return null;
  }
}
