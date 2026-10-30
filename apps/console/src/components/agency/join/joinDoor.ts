import type { Role } from '../../../types/auth';
import type { InviteUnavailableStatus } from '../../../types/invite';
import {
  AGENCY_JOIN_PATH,
  AGENCY_LOGIN_PATH,
  JOIN_PATH,
  loginPathReturningTo,
} from '../../../utils/returnPath';
import { UNAVAILABLE_COPY, WORKSPACE_UNAVAILABLE_COPY } from '../../../utils/agencyInviteJoinCopy';

/**
 * Which of the two invite pages a visitor is on.
 *
 * ── Two doors onto one claim ───────────────────────────────────────────────
 * Every role now gets a single-use token and an email. An `agent`'s link is
 * `/agency/join/:token` (`AgencyJoinPage`), written for somebody about to sit at a
 * station; every other role's is `/join/:token` (`pages/auth/JoinPage`), written
 * for somebody joining a workspace. The claim behind both is the SAME —
 * `useInviteClaim`, against the same two public endpoints — and what differs is
 * only what each page says, where it sends somebody who needs to sign in, and
 * where it lands them afterwards. Those differences live here, keyed on the
 * door, so the cards in this folder can be told which page they are on without
 * either page re-implementing them.
 *
 * Analytics are deliberately NOT in this table: each page passes its own event
 * family to the hook. A module that imported both families would make every
 * importer depend on both, including the agency page's tests, which mock only
 * the five events that page fires.
 */
export type JoinDoor = 'agency' | 'workspace';

/**
 * The door an invite of this role belongs on — the console's half of the rule the
 * server applies when it builds the emailed link (agent → `/agency/join`,
 * everyone else → `/join`).
 *
 * Duplicated rather than shared because the two sides cannot import each other,
 * as `inviteSignInUrl` is; what keeps them honest is that a link landing on the
 * wrong door is FORWARDED rather than stranded (see `useInviteClaim`), so a
 * disagreement costs a redirect rather than an invitation.
 */
export function joinDoorFor(role: Role): JoinDoor {
  return role === 'agent' ? 'agency' : 'workspace';
}

/**
 * The page for this token on this door.
 *
 * The one place the app builds a join URL. It does not mint anything: the token
 * is the one the visitor arrived with, re-filed under the door its role belongs
 * on. Encoded for the reason `ENDPOINTS.invites` encodes it — it came out of a
 * URL somebody may have pasted, and a stray `?` or `#` would otherwise truncate
 * it into a lookup of a different, non-existent invite.
 */
export function joinPathFor(door: JoinDoor, token: string): string {
  return `${door === 'agency' ? AGENCY_JOIN_PATH : JOIN_PATH}/${encodeURIComponent(token)}`;
}

export interface JoinDoorCopy {
  /** The line under the wordmark on every card the page renders. */
  eyebrow: string;
  /**
   * Where "Go to sign in" and "Sign in instead" go, given where a claim on this
   * page lands (`destination`, the page's own) — so including where that sign-in
   * lands afterwards.
   *
   * The agency door for an agent, bare: its fallback is `/agency`, whose
   * `AgencyHomeRedirect` sends an agent on to `/dialer`. Everyone else goes to
   * `/login` CARRYING `?next=<destination>`, and the `next` is the point. `/login`
   * renders `AgencyLoginPage` too, so its own fallback is `/agency` as well —
   * which, for an operator at a tenant without the dialer, is the
   * capability-unavailable page rather than the workspace they were invited to.
   *
   * A function of the destination rather than a path written here because the
   * workspace's landing is `JoinPage`'s to name, outside the agency roots: this
   * folder is agency code by location (`agencyShellBoundary.test.ts`), and the one
   * value a sign-in here must agree with is the one a claim here navigates to.
   */
  signInPath: (destination: string) => string;
  /** The five "cannot be used" screens, in this door's words. */
  unavailable: Record<InviteUnavailableStatus, { title: string; body: string; action: 'sign_in' | 'none' }>;
}

export const JOIN_DOORS: Record<JoinDoor, JoinDoorCopy> = {
  agency: {
    eyebrow: 'Agency Dialer',
    signInPath: () => AGENCY_LOGIN_PATH,
    unavailable: UNAVAILABLE_COPY,
  },
  workspace: {
    /*
      Not the product name: the card header renders before the lookup returns, so
      it can only say what is true of every invitation on this door. The product
      the person is joining is the invite's own `product_name`, rendered in the
      title once it is known.
    */
    eyebrow: 'Workspace invitation',
    signInPath: (destination) => loginPathReturningTo(destination),
    unavailable: WORKSPACE_UNAVAILABLE_COPY,
  },
};
