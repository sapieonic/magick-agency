import { KeyRound, Building2, ShieldCheck } from 'lucide-react';
import {
  trackWorkspaceInviteAddressMismatch,
  trackWorkspaceInviteClaimAttempted,
  trackWorkspaceInviteClaimFailed,
  trackWorkspaceInviteClaimSucceeded,
  trackWorkspaceInviteViewed,
} from '../../analytics/events';
import { InviteJoinScreen, type JoinStep } from '../../components/agency/join/InviteJoinScreen';
import type { InviteJoinEvents } from '../../components/agency/join/useInviteClaim';

/**
 * Where every emailed invite that is NOT for an agent lands: `/join/:token`.
 *
 * ── The defect this page removes ───────────────────────────────────────────
 * Invite emails used to go to agents only. Every other role — an operator, a
 * viewer, an account admin — got a membership and no email, because there was no
 * page for them to land on: `/agency/join/:token` is written for somebody about
 * to sit at a station, and a plain `/login` link is a dead end. It has no signup,
 * so somebody with no account cannot get past it; and somebody who signs in there
 * with Google on a different address than the invited one is not matched to the
 * waiting membership at all — `POST /auth/session` refuses them or adopts a
 * different row, and the invitation sits unclaimed with nobody told. The
 * supervisor's only recourse was the hand-off panel: copy a link, send it
 * yourself, and hope the address matches.
 *
 * Now every role gets a single-use token and an email, and this is where a
 * non-agent's token is claimed. The TOKEN is the authority, exactly as on the
 * agency page, so the address they end up signing in with does not have to match
 * the one invited — the mismatch is confirmed rather than silent, and the claim
 * binds the membership the token names.
 *
 * ── The same page as the agent's, on purpose ───────────────────────────────
 * The claim (`useInviteClaim`) and the card (`InviteJoinScreen`) are shared with
 * `AgencyJoinPage`; every hazard that page's commentary describes — the stranded
 * credential, the in-flight claim racing a sign-out, the mismatch loop, the spent
 * token one back-press away — is handled here by the same code rather than by a
 * copy of it. What this file owns is what makes it a WORKSPACE invitation: the
 * `/app` landing, the steps, and the `workspace_invite_*` funnel. The words on
 * the terminal screens and the sign-in page they point at are the door's, in
 * `components/agency/join/joinDoor.ts`.
 *
 * ── An agent's link that lands here is forwarded ───────────────────────────
 * The role decides the door, and the server picks it when it builds the email.
 * An agent invitation opened at this URL anyway — a hand-edited link, an old one
 * — is sent on to `/agency/join/:token` before anything renders, and a non-agent
 * one opened there is sent here. Neither page ever renders an invitation that
 * belongs on the other.
 *
 * ── Why this route is fully public ─────────────────────────────────────────
 * For the agency page's reasons, recorded at both routes in `App.tsx`: the
 * visitor has no session to authenticate and no tenant to resolve anything
 * against, and the token is the whole authority.
 */

/**
 * Where a claimed invite lands: the platform shell's index.
 *
 * `/app` and not `/`, for the reason `AgencyJoinPage` lands on `/dialer` rather
 * than `/agency`: the role is already known, and it is not `agent`, so the
 * entitlement decision `HomeRedirect` makes at `/` has nothing left to decide
 * that this page would want decided differently. `AppHomeRedirect` (`/app`'s
 * index) then picks the page by permission — Team for somebody who can invite,
 * Notifications for everyone else — which is the right first screen for a role
 * this page cannot see the capabilities of.
 *
 * The WORKSPACE it opens in is set by the claim, not by this path: see
 * `invitedTenantId`, which is what stops somebody who already belongs to another
 * workspace from accepting this invitation and landing back in the old one.
 */
const DESTINATION = '/app';

/**
 * What happens after they finish, in order.
 *
 * Numbered for the agency page's reason — it is a sequence, and what an invitee
 * is unsure of at this moment is what they are about to be dropped into. Written
 * for every non-agent role at once, so it promises nothing a viewer cannot do:
 * no team page, no campaigns, no station.
 */
const NEXT_STEPS: readonly JoinStep[] = [
  {
    icon: KeyRound,
    title: 'Set up your sign-in',
    desc: 'A Google account or a password — whichever you will still have in six months.',
  },
  {
    icon: Building2,
    title: 'The workspace you were invited to opens',
    desc: 'Even if you already belong to another one — that one is a switch away.',
  },
  {
    icon: ShieldCheck,
    title: 'Your role decides what you can do',
    desc: 'The role named above sets what you can see and change. Whoever invited you can adjust it later.',
  },
];

/** This page's funnel: the five `workspace_invite_*` events. */
const EVENTS: InviteJoinEvents = {
  viewed: trackWorkspaceInviteViewed,
  claimAttempted: trackWorkspaceInviteClaimAttempted,
  claimSucceeded: trackWorkspaceInviteClaimSucceeded,
  claimFailed: trackWorkspaceInviteClaimFailed,
  addressMismatch: trackWorkspaceInviteAddressMismatch,
};

export default function JoinPage() {
  return (
    <InviteJoinScreen door="workspace" destination={DESTINATION} events={EVENTS} steps={NEXT_STEPS} />
  );
}
