import type { MembershipRole } from '@magick-agency/db/models/membership.model';
import type { InviteEmailInput, RenderedEmail } from './invite-email.layout.js';
import { agencyProductName, renderAgentInviteEmail } from './agent-invite.template.js';
import { renderWorkspaceInviteEmail, workspaceProductName } from './workspace-invite.template.js';

/**
 * Which invitation a role receives, and the two words it is described with.
 *
 * The one place the role decides the COPY. `invite-mailer.ts` renders through
 * {@link renderInviteEmailForRole}, and `GET /invites/:token` answers
 * `product_name` from {@link inviteProductName} — so the email and the claim
 * page it links to name the same product and the same role, by construction
 * rather than by two branches somebody keeps in step.
 *
 * Pure: no config, no clock. The brand arrives as a parameter, as it does for
 * the templates.
 */

/**
 * The role as copy, for the "set you up as …" sentence.
 *
 * ── These must match the console's labels exactly ─────────────────────────
 * The claim page renders `roleLabel(invite.role)` from
 * `apps/console/src/utils/agencyInviteJoinCopy.ts` (`ROLE_LABELS`), and the
 * person reading it has just come from this mail. "Tenant admin" in the inbox
 * and "Workspace admin" on the page is two names for one thing at the exact
 * moment somebody is deciding whether this is genuine. Nothing enforces the
 * match across the two apps — the same seam the join-URL rule in
 * `invite-mailer.ts` describes — so this paragraph is the safeguard: change one,
 * change the other.
 *
 * A `Record` over `MembershipRole`, so a new role fails the build here rather
 * than rendering as a blank in somebody's first email from us.
 */
export const INVITE_ROLE_LABELS: Readonly<Record<MembershipRole, string>> = {
  agent: 'Agent',
  viewer: 'Viewer',
  operator: 'Operator',
  account_admin: 'Account admin',
  tenant_admin: 'Workspace admin',
  tenant_owner: 'Workspace owner',
};

export function inviteRoleLabel(role: MembershipRole): string {
  return INVITE_ROLE_LABELS[role];
}

/**
 * The product an invitation is for: the Agency Dialer for an `agent`, the
 * workspace (the brand) for everyone else.
 *
 * An `agent` lands on the dialer and nowhere else — they inherit no navigation —
 * so the dialer is what they must recognise. Every other role lands in `/app`,
 * which is the brand's workspace whether or not the tenant has a dialer.
 */
export function inviteProductName(role: MembershipRole, brandName: string): string {
  return role === 'agent' ? agencyProductName(brandName) : workspaceProductName(brandName);
}

/** Render the invitation `role` receives. The label is supplied here, never by a caller. */
export function renderInviteEmailForRole(
  role: MembershipRole,
  input: Omit<InviteEmailInput, 'roleLabel'>,
): RenderedEmail {
  const withLabel: InviteEmailInput = { ...input, roleLabel: inviteRoleLabel(role) };
  return role === 'agent' ? renderAgentInviteEmail(withLabel) : renderWorkspaceInviteEmail(withLabel);
}
