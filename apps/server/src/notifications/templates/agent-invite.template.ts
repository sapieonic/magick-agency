import {
  DEFAULT_BRAND_ACCENT,
  renderInviteEmail,
  type InviteEmailInput,
  type RenderedEmail,
} from './invite-email.layout.js';

/**
 * The agent invitation email: somebody joining a calling floor.
 *
 * Only the COPY lives here — the subject and the three steps. The document
 * around it (the Outlook-proof layout, the button, the escaping, the written
 * plain-text part) is `invite-email.layout.ts`, shared with the workspace
 * invitation every other role receives, so the two cannot drift apart in the
 * parts that are about mail clients rather than about the reader.
 *
 * ── The output is pinned, byte for byte ─────────────────────────────────────
 * This was one file before the workspace invitation existed, and the move into
 * the shared layout changed no byte of what an agent receives. The template
 * suite pins that with a digest, so a change to the agent mail is a decision
 * somebody makes with the digest in front of them, not a side effect of
 * improving the other invitation.
 */

export { DEFAULT_BRAND_ACCENT };
export type { RenderedEmail };

/** What the agent invitation renders from — the shared input, under its historical name. */
export type AgentInviteEmailInput = InviteEmailInput;

/**
 * The product noun, composed rather than hard-coded.
 *
 * "Agency Dialer" is the shipped name everywhere in this product, including the
 * console. Only the BRAND half
 * is a variable, so a white-labelled deployment renames the company and not the
 * product. Inventing a different noun here would put a name in the invitee's
 * first-ever contact with us that appears nowhere in the app they then open.
 */
export function agencyProductName(brandName: string): string {
  // Decision B17: a brand that already ends in "Agency" — the default,
  // `Magick Agency` — gets "Dialer" alone, so the noun reads "Magick Agency
  // Dialer" and not "Magick Agency Agency Dialer". Every other brand gets
  // "<brand> Agency Dialer".
  if (/\bagency$/i.test(brandName.trim())) return `${brandName.trim()} Dialer`;
  return `${brandName} Agency Dialer`;
}

/**
 * The three steps between clicking the button and taking a call.
 *
 * They exist because an agent's first impression of this product is otherwise a
 * sign-in page and then a station with nothing on it: an `agent` is hierarchy
 * level 5 and inherits no navigation at all, so there is nothing for them to
 * explore their way into. Naming the three things that will happen is what turns
 * "why is this empty" into "my supervisor has not staffed me yet".
 */
const WHAT_HAPPENS_NEXT: ReadonlyArray<readonly [string, string]> = [
  ['Set up your sign-in', 'Choose how you sign in — this link is what connects it to your place on the team.'],
  ['Your station opens', 'The dialer screen you take calls from, ready to go.'],
  ['The campaigns you are staffed on appear', 'Your supervisor decides which ones; they show up as they are assigned.'],
];

/** Render the agent invitation. Escaping and layout: see `renderInviteEmail`. */
export function renderAgentInviteEmail(input: AgentInviteEmailInput): RenderedEmail {
  return renderInviteEmail(input, {
    subject: `You've been added to the ${agencyProductName(input.brandName)}`,
    steps: WHAT_HAPPENS_NEXT,
  });
}
