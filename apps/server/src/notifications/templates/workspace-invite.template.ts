import {
  renderInviteEmail,
  type InviteEmailInput,
  type RenderedEmail,
} from './invite-email.layout.js';

/**
 * The workspace invitation email: every role that is not `agent` — a viewer, an
 * operator, an admin or an owner joining the workspace itself.
 *
 * ── Why it is not the agent mail with a different label ─────────────────────
 * The agent mail's subject names the dialer and its steps promise a station and
 * staffed campaigns. Sent to an `account_admin`, all three sentences are false:
 * they land in the workspace (`/app`), most tenants have no dialer at all, and
 * nobody staffs an admin onto anything. An invitation whose first line names a
 * product the reader then cannot find reads as a mistake at best and a phishing
 * mail at worst. So the copy is its own, and only the document is shared
 * (`invite-email.layout.ts`).
 *
 * ── The product it names is the BRAND, and the claim page names the same ────
 * `GET /invites/:token` answers `product_name` from `inviteProductName`
 * (`invite-email.ts`), and so does this subject — one function, so the mail and
 * the page it leads to cannot name two different things.
 */

/**
 * The product noun for a workspace invitation: the brand, alone.
 *
 * Not trimmed or decorated: it is exactly `PLATFORM_BRAND_NAME`, which is also
 * what the console's chrome shows, so the reader recognises it on arrival.
 */
export function workspaceProductName(brandName: string): string {
  return brandName;
}

/**
 * The three steps between clicking the button and being in the workspace.
 *
 * Deliberately role-neutral rather than one list per role: the honest
 * description of what a viewer and a tenant admin each see next is "whatever
 * their role opens", and a per-role list would be five promises about pages the
 * console owns and this server cannot see change. The third step says exactly
 * that, and names who can change it.
 */
const WHAT_HAPPENS_NEXT: ReadonlyArray<readonly [string, string]> = [
  ['Set up your sign-in', 'Choose how you sign in — this link is what connects it to your place in the workspace.'],
  ['Your workspace opens', 'You arrive already a member. There is nothing else to sign up for or create.'],
  ['What you see depends on your role', 'Whoever invited you chose it, and an admin on your team can change it later.'],
];

/** Render the workspace invitation. Escaping and layout: see `renderInviteEmail`. */
export function renderWorkspaceInviteEmail(input: InviteEmailInput): RenderedEmail {
  return renderInviteEmail(input, {
    subject: `You've been added to ${workspaceProductName(input.brandName)}`,
    steps: WHAT_HAPPENS_NEXT,
  });
}
