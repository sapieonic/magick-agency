import { KeyRound, Headset, ListChecks } from 'lucide-react';
import {
  trackAgencyInviteAddressMismatch,
  trackAgencyInviteClaimAttempted,
  trackAgencyInviteClaimFailed,
  trackAgencyInviteClaimSucceeded,
  trackAgencyInviteViewed,
} from '../../analytics/events';
import { InviteJoinScreen, type JoinStep } from '../../components/agency/join/InviteJoinScreen';
import type { InviteJoinEvents } from '../../components/agency/join/useInviteClaim';

/**
 * Where an emailed agency invite lands: `/agency/join/:token`.
 *
 * ── The defect this page removes ───────────────────────────────────────────
 * `POST /auth/session` provisions a BRAND-NEW TENANT for an address the server does
 * not recognise (the unknown-address path of the session route), and an invited
 * agent's membership is activated by matching the address they sign in with
 * against the stub row their supervisor's invite wrote. Those two facts together
 * are the whole problem: an agent who signed up, or who picked a Google account
 * on a slightly different address, landed in a private empty tenant of their own
 * while the membership waiting for them sat unclaimed — silently, with nothing
 * told to either of them. `/agency/login` answers that by having no signup at
 * all, which closes the hazard and leaves an invited agent with no Google account
 * with no way in whatsoever. This page is that way in.
 *
 * What changes is where the authority lives. The server now mints a single-use token,
 * emails it, and exposes a claim endpoint where the TOKEN is what authorizes the
 * membership. The address the agent ends up signing in with therefore no longer
 * has to match the address the invite was sent to — so the match that was failing
 * silently is no longer load-bearing, and the two places it used to fail are the
 * two interactions this page is built around:
 *
 *  1. **Email + password.** The invited address is pre-filled and READ-ONLY. It is
 *     the one value that must not drift, and locking it removes an entire class of
 *     typo failure at the exact moment somebody is typing an address for the first
 *     time. See `CredentialForm` (`components/agency/join/`).
 *  2. **Google, on a different address.** Allowed — a personal Gmail is a real
 *     answer — but never silently. `AddressMismatch` is the confirmation
 *     step, and it is the single most valuable interaction on the page: today this
 *     exact case produces a stray empty tenant and nobody is told.
 *
 * ── Why this route is fully public ─────────────────────────────────────────
 * No `RequireAuth`, no `RequireCapability`, no `RequireFlag`, and each absence is
 * deliberate rather than an oversight — see the route's own commentary in
 * `App.tsx`. The short version: the visitor has no account yet, so there is no
 * session to authenticate and no tenant to resolve entitlements against, and each
 * of those gates would turn the invite link into a redirect to a sign-in page for
 * an account that does not exist.
 *
 * ── Scope: `agent`, and what happens to anybody else ───────────────────────
 * Every invite this page serves is an agent joining a calling floor; the copy,
 * the destination and the three steps below are all specific to a station. A
 * workspace variant on this URL would be a second product on one page, so it has
 * its own: every OTHER role's invitation is emailed as `/join/:token`
 * (`pages/auth/JoinPage`). A non-agent invitation that arrives here anyway is
 * forwarded there rather than rendered, and an agent's that arrives there is
 * forwarded here — see `useInviteClaim`.
 *
 * ── Where the logic went ───────────────────────────────────────────────────
 * The claim state machine is `components/agency/join/useInviteClaim` and the card
 * is `InviteJoinScreen`, both shared with the workspace page so a fix to either
 * reaches both. What stays in this file is what makes it the AGENT's door: the
 * `/dialer` landing, the three steps, and the `agency_invite_*` funnel.
 */

/**
 * Where a claimed invite lands.
 *
 * `/dialer` rather than `/agency`, which is where `AgencyLoginPage` sends people:
 * that page serves both personas and defers to `AgencyHomeRedirect` to work out
 * which one signed in. Here there is no ambiguity — the invite says `agent`, and
 * `AgencyHomeRedirect` would resolve an agent to `/dialer` anyway. Going straight
 * there spares a newly-created account one redirect through a persona check whose
 * answer this page already has in its hands.
 */
const DESTINATION = '/dialer';

/**
 * What happens after they finish, in order.
 *
 * Numbered because it genuinely is a sequence — each step is unreachable until
 * the one above it is done — and because the thing an invited agent is most
 * uncertain about at this moment is not what to type, it is what they are about
 * to be dropped into.
 */
const NEXT_STEPS: readonly JoinStep[] = [
  {
    icon: KeyRound,
    title: 'Set up your sign-in',
    desc: 'A Google account or a password — whichever you will still have in six months.',
  },
  {
    icon: Headset,
    title: 'Your station opens',
    desc: 'One screen with the call, the customer’s details, and the outcomes you record.',
  },
  {
    icon: ListChecks,
    title: 'The campaigns you are staffed on appear',
    desc: 'Your supervisor decides which lists you work; they show up here as they are assigned.',
  },
];

/** The agent's funnel: the five `agency_invite_*` events. */
const EVENTS: InviteJoinEvents = {
  viewed: trackAgencyInviteViewed,
  claimAttempted: trackAgencyInviteClaimAttempted,
  claimSucceeded: trackAgencyInviteClaimSucceeded,
  claimFailed: trackAgencyInviteClaimFailed,
  addressMismatch: trackAgencyInviteAddressMismatch,
};

export default function AgencyJoinPage() {
  return (
    <InviteJoinScreen door="agency" destination={DESTINATION} events={EVENTS} steps={NEXT_STEPS} />
  );
}
