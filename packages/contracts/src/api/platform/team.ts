import type { Membership, User } from './auth';

/**
 * A row from `GET /tenants/:id/members` — the whole point of the reshape in
 * `api/tenants.ts` is to turn the wire's flat, `user`-nested shape into this.
 *
 * ── What `invite_state` means (pending vs signed-up status after inviting an
 * agent) ──────────────────────────────
 * ONE rule, applied to every role: `'pending'` iff the person has never
 * completed Firebase sign-in — their stored identity is still the placeholder
 * stub the public API layer writes when it invites an address it has never seen — and
 * `'active'` otherwise. It is therefore a fact about the PERSON, rendered on
 * each of their membership rows, and the public API layer's super-admin `is_pending` flag
 * answers the same question from the same check, so the two surfaces cannot
 * disagree about one user.
 *
 * **It does not say whether this person has ever opened THIS workspace.**
 * Somebody who already had a login reads `'active'` from the moment
 * they are invited here. That is correct under the field's own wording
 * (pending vs signed up) and it is the whole of what the field claims — an
 * earlier revision derived it per-membership from an invite-claim record
 * instead, and that labelled four kinds of genuinely working member `pending`
 * forever. Do not reintroduce a per-workspace reading of this value, and do not
 * word UI copy as though a `'pending'` badge were about an unopened invitation.
 *
 * It nonetheless lives on `membership` rather than on `user`, for two reasons
 * that survive the semantic change: the wire puts it there (a top-level sibling
 * of `role` and `status`, which is what lets the rest-spread in
 * `listTenantMembers` carry it through), and `user` is where `firebase_uid`
 * lives — the raw `pending_<uuid>` stub this field exists to answer *for*,
 * without the browser ever being handed it.
 *
 * ── Optional, and the two readers disagree about what absence means ────────
 * Additive the same way `InviteUserResult`'s fields are: an older public API layer sends
 * nothing. There is deliberately no single default. The BADGE renders a neutral
 * placeholder and claims neither state, because either default would be a
 * positive claim on no evidence; `inviteNotKnownJoined` treats
 * absent as "not known to have joined" so the Resend control stays offered,
 * because defaulting it the other way would remove the only remedy for an
 * expired invitation from every agent at once. Both docstrings explain their
 * own direction; the asymmetry is intended and should not be collapsed.
 *
 * Only two values exist and there is no third — do not add an "unknown" branch
 * on the strength of a hypothetical one.
 */
export interface TenantMember {
  membership: Membership & { invite_state?: 'active' | 'pending' };
  user: User;
}

/**
 * The roles these two routes accept, mirroring the public API layer's validators — NOT the
 * whole `Role` union. `tenant_owner` is absent because ownership transfers are
 * not an invite or a role change, and the public API layer rejects it on both.
 *
 * `agent` is accepted on both (Agency Dialer): a supervisor staffing a dialer
 * campaign creates one the ordinary way. See `TeamPage`'s pickers for why it is
 * offered now when it deliberately was not before.
 */
export interface InviteUserInput {
  email: string;
  role: 'account_admin' | 'operator' | 'viewer' | 'agent';
  account_id?: string;
}

export interface UpdateRoleInput {
  role: 'tenant_admin' | 'account_admin' | 'operator' | 'viewer' | 'agent';
}

/**
 * Whether the public API layer actually told the invitee, and why not when it did not.
 *
 * A discriminated union rather than a boolean plus an optional string, because
 * the three reasons go to three different people: `not_configured` is an
 * operator's (no `platformEmail` block), `not_implemented` is ours (configured,
 * transport still a TODO), and `failed` is the mail provider's. Collapsing them
 * would send all three to the same place.
 *
 * `reason` is declared as a widened `string` on the failure arm on purpose:
 * the public API layer may add one, and a client that has to be redeployed to keep parsing a
 * response is a client that breaks on an additive server change. Nothing here
 * branches on the value — only on `sent`.
 */
export type InviteEmailResult =
  | { sent: true }
  | { sent: false; reason: string };

/**
 * `POST /users/invite` — the 201 body.
 *
 * ── Why this is read at all, when it used to be discarded ──────────────────
 * The hand-off panel tells the supervisor that nobody emailed the invitee and
 * hands them the link to pass on themselves. That is true today and it is a
 * sentence with an expiry date: the public API layer shipped `invite_email` and `sign_in_url`
 * for exactly this hand-off (PR #221), so the moment a transport is wired up the
 * panel would go on insisting "we didn't email them" about an email that had just
 * been sent. Reading the response is what makes the panel stop saying it.
 *
 * Every field is optional because a public API layer that predates those keys is a public API layer
 * this client still has to work against — an absent `invite_email` is treated as
 * "not sent", which is both the current truth and the safe direction to be wrong
 * in: it shows a hand-off nobody needed rather than hiding one somebody did.
 */
export interface InviteUserResult {
  user?: { id: string; email: string };
  /*
    Every field optional, and the callers also tolerate the whole body being
    absent: `apiFetch` answers `undefined` for a 204, and a `.` into that inside a
    render would take the page down after the membership had already been written.
  */
  /** Absent on an older public API layer. Treated as `{ sent: false }`. */
  invite_email?: InviteEmailResult;
  /**
   * The link the public API layer would put in the email, or `null` when it has no
   * `CONSOLE_BASE_URL` to build one from — the KEY is always present on a public API layer
   * that has it, because a sometimes-absent key is indistinguishable from one a
   * client forgot to read.
   *
   * Preferred over the client's own derivation when non-null: it is the same
   * product rule (the agency door for an `agent` only) computed from the server's
   * configured base rather than from `window.location.origin`, so a supervisor on
   * a preview deployment hands out a link to the real app rather than to the
   * preview. The local derivation stays as the fallback and is the only thing that
   * works with no `CONSOLE_BASE_URL` at all.
   */
  sign_in_url?: string | null;
}

/**
 * `POST /invites/resend` — the 200 body.
 *
 * The public API layer answers with the same two fields `POST /users/invite` does, minus the
 * user: it is the same act (mint a binding credential and try to mail it), run a
 * second time. Shaped as a `Pick` rather than restated so the two cannot drift —
 * a supervisor reading "we emailed them" after a resend and after a first invite
 * has to be reading the same fact.
 */
export type ResendInviteResult = Pick<InviteUserResult, 'invite_email' | 'sign_in_url'>;

/**
 * `GET /tenants/:id/members` — the WIRE shape, before the console's
 * `listTenantMembers` reshapes it into {@link TenantMember}.
 *
 * One row per ACTIVE membership, the membership's own fields spread at the top level,
 * `user` reduced to four named fields (never `firebase_uid`, which can hold a
 * `pending_<uuid>` stub), and `invite_state` derived from that stub. Floor
 * `tenant.read`. An account-scoped caller sees only their account's rows (and
 * not the tenant-wide ones); a tenant-wide caller sees the whole roster.
 */
export interface TenantMembersResponse {
  members: Array<
    Membership & {
      user: Pick<User, 'id' | 'email' | 'display_name' | 'avatar_url'> | null;
      invite_state: 'active' | 'pending';
    }
  >;
}
