import { AGENCY_LOGIN_PATH, LOGIN_PATH } from '../../utils/returnPath';
import type { InviteUserInput, TenantMember } from '../../types/team';

/**
 * The Team page's invitation rules, as pure functions: whether the server has
 * told us a person signed up, which link an invitee is sent, and whether an
 * invitation can be re-issued. Re-exported from `TeamPage` for the tests that
 * import them from there.
 */

/**
 * Whether the server has NOT told us this person has signed up — either it says
 * `'pending'`, or it says nothing at all.
 *
 * The twin of the badge's absent-field handling, and it resolves the other way
 * on purpose. This
 * one gates the Resend control, where an absent field defaulting to `'active'`
 * removes it: against a server that predates `invite_state`, Resend would
 * vanish for every agent in the product at once, silently, with nothing on
 * screen to say why. Resend is the only remedy for an expired or never-sent
 * invitation, and before this ticket it was offered to every agent regardless —
 * so `!== 'active'` is exactly the pre-change behaviour when the server is
 * silent, and a narrowing only once the server has something to say.
 *
 * Written as `!== 'active'` rather than `=== 'pending'` so a third literal
 * the server might add also keeps the control rather than removing it.
 */
export function inviteNotKnownJoined(member: TenantMember): boolean {
  return member.membership.invite_state !== 'active';
}

/**
 * The link an invited person has to open, which somebody has to send them.
 *
 * ── This panel is now conditional on what the server says ──────────────────────
 * Everything below was written while `POST /users/invite` returned nothing this
 * client read. It now returns `invite_email` and `sign_in_url`, the response is retained, and **the hand-off renders only on
 * `sent: false`**. So the paragraphs below describe the state the platform is in
 * today rather than a permanent one, and the panel stops claiming nobody was
 * emailed on the day a transport is wired up rather than needing this file
 * changed again. `sign_in_url` is preferred over the derivation below whenever
 * the server has one, because the browser's origin is whatever deployment the
 * supervisor happens to be on.
 *
 * ── Why this exists at all, and what has since changed ──────────────────────
 * `POST /users/invite` writes a membership plus, for a new address, a stub user
 * whose `firebase_uid` is `pending_<uuid>`. The server adopts that stub on the
 * invitee's first Firebase sign-in, matched **by email** — which used to be the
 * entire activation mechanism, and it required the invited person to
 * independently arrive at the app and sign in with the exact address typed here.
 *
 * **"Nothing sends that invite" is no longer true, and this comment used to say
 * it flatly.** The server had the transport all along (`notifications/mailjet.client.ts`,
 * already sending bulk-dispatch completion mail) and no transactional path wired
 * to it. It now has one: an `agent` invite mints a single-use token, mails a link
 * to `/agency/join/:token`, and the claim endpoint binds whatever identity the
 * invitee arrives with to the membership the TOKEN names — so the email match is
 * not what activates them any more, and an invited agent with no Google account
 * has a way in for the first time.
 *
 * That is why the panel branches instead of asserting: `invite_email.sent` is
 * the server's own answer for this invite, on this deployment, with this
 * configuration. Every other role still gets no token and no mail (see
 * `roleGetsTokenInvite`), and a server with no `platformEmail` block still
 * answers `not_configured` — both land on the hand-off below, which is the older
 * behaviour kept for exactly the cases that still need it rather than a claim
 * about the platform.
 *
 * Where mail did not go, the honest fix is unchanged: hand the supervisor the two
 * things they need to pass on themselves, and say plainly that passing them on is
 * now their job.
 *
 * ── The agency door for an agent, and why only for an agent ────────────────
 * An `agent` is hierarchy level 5 and inherits no navigation at all, so the app
 * shell is a page with nothing on it — and `/login`, which fronts that shell,
 * sells a product they will never open and offers a Sign Up tab that would put
 * them in a private empty tenant instead of the workspace they were invited to
 * (see `AGENCY_LOGIN_PATH` in `utils/returnPath.ts`). So their link is the agency
 * door, which lands them on their station by way of `AgencyHomeRedirect`.
 *
 * This replaces a `?next=%2Fdialer` on `/login`. The destination is no longer
 * pinned here because it no longer needs to be: the agency door defaults to
 * `/agency`, which resolves the persona from the RBAC role, so the landing rule
 * lives in one place instead of being copied into every link that points at
 * sign-in.
 *
 * Only an `agent`. A supervisor is `account_admin` or above and legitimately
 * administers in `/app` — team, credits, invoices, settings — so their invite
 * lands them on the shell that has all of that, and they reach the dialer from
 * its nav entry. Sending every `account_admin` invite to the agency door would be
 * wrong for the majority of tenants, which have no dialer at all. Supervisors are
 * first-class AT the agency door — it is ungated, and an already-signed-in visitor
 * is forwarded straight on rather than shown a form, so a bookmarked
 * `/agency/login` lands a supervisor on their campaigns by way of
 * `AgencyHomeRedirect` (see `AgencyLoginPage`'s signed-in branch, which is what
 * makes that true). The invite link simply is not where that is decided.
 *
 * `window.location.origin` is read at call time rather than at module load: this
 * file is imported by unit tests under jsdom, and a module-level read would freeze
 * whatever origin the first importer happened to have.
 */
export function inviteSignInUrl(role: InviteUserInput['role'], origin: string): string {
  return `${origin}${role === 'agent' ? AGENCY_LOGIN_PATH : LOGIN_PATH}`;
}

/**
 * Whether this member's invitation can be re-issued.
 *
 * ── The one-way door this control closes ───────────────────────────────────
 * An invitation expires after seven days. The server's own copy on the join page
 * then tells the agent to "ask your supervisor to send a new one" — and until
 * this existed, the supervisor could not: `POST /users/invite` answers `409 User
 * already has a membership in this context` for the same address, so the only
 * remaining move was to delete the membership and rebuild it. `POST
 * /invites/resend` is the server's answer (it revokes any outstanding token and mints
 * a fresh one against the SAME membership), and this repo shipped no caller for
 * it, which made the dead end certain rather than possible.
 *
 * ── Why the predicate is now the role AND `invite_state`, not the role alone ─
 * It used to be the role alone, and the reason was that the members list had no
 * way to answer "has this person signed up?" at all: `GET /tenants/:id/members`
 * returned no `firebase_uid` — the field that distinguishes a `pending_<uuid>`
 * stub from an activated account — and guessing from a null `display_name`
 * would have been worse than not narrowing, since a real email/password user
 * who has signed up has one too. That gap is what `invite_state` closes: the server now answers the identity question itself, on
 * the same route, from the one rule it applies to every role — `pending` iff
 * the stored identity is still a placeholder stub, `active` otherwise.
 *
 * What that buys is narrower than it sounds, and the narrowness is why the
 * default matters. `invite_state` is a fact about the PERSON, not about this
 * workspace's invitation: somebody who already had a Magick Agency login reads
 * `active` from the moment they are invited here, so hiding Resend from them is
 * a judgement about who is likely to need it, not a statement that their
 * invitation was used. The server's `POST /invites/resend` has no refusal for an
 * already-joined membership — it would mint and mail a fresh link quite
 * happily — so this narrowing is the UI's own, and it is deliberately the only
 * place the identity signal is allowed to REMOVE a control.
 *
 * Hence `inviteNotKnownJoined` rather than `invite_state ===
 * 'pending'`: the two differ only on an absent field, and here that difference
 * is the whole control. A server that predates `invite_state` sends nothing,
 * and reading that as `'active'` would take Resend away from every agent in the
 * product at once — a silent, platform-wide regression on the only remedy for
 * an expired invitation, reachable by an ordinary rollback or by a browser
 * holding a cached SPA. Absent therefore means "still offer it", which is
 * exactly what shipped before this ticket.
 *
 * The role test is NOT made redundant by any of that and stays for its
 * original, unrelated reason: `roleGetsTokenInvite` in the server mints a token for
 * an `agent` and for nobody else, so a resend for any other role — signed up or
 * not — sends the same non-token mail a first invite would and cannot produce a
 * claimable link. `invite_state` answers "has this person signed up"; it says
 * nothing about whether resending *does* anything, which is what the role test
 * is for. Both conditions narrow different failure modes and neither
 * substitutes for the other.
 *
 * ── What is still imprecise ────────────────────────────────────────────────
 * Two things, and neither is knowable from this route. The members list is a
 * snapshot fetched on page load, so somebody who signs up between that fetch
 * and a supervisor pressing this button still reads `pending` here; and an
 * agent who has a login but has never opened THIS workspace reads `active`, so
 * the control is withheld from a person who may genuinely be waiting on a link.
 * The server's answer to the first is unchanged — the claim fails with
 * `identity_already_bound`, which the join page renders as "You are already set
 * up — sign in", one press from the fix. The second costs a supervisor a
 * support request rather than a broken invitation, which is the cheaper of the
 * two ways to be wrong here.
 */
export function invitationIsResendable(member: TenantMember): boolean {
  return (
    member.membership.role === 'agent'
    && member.membership.status === 'active'
    && inviteNotKnownJoined(member)
  );
}
