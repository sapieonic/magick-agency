import { describe, it, expect } from 'vitest';
import { ROLES } from '@magick-agency/contracts/rbac';
import {
  INVITE_ROLE_LABELS,
  inviteProductName,
  inviteRoleLabel,
  renderInviteEmailForRole,
} from '../../../src/notifications/templates/invite-email.js';
import { renderAgentInviteEmail } from '../../../src/notifications/templates/agent-invite.template.js';
import { renderWorkspaceInviteEmail } from '../../../src/notifications/templates/workspace-invite.template.js';

/**
 * Which invitation each role receives (`src/notifications/templates/invite-email.ts`).
 *
 * The one place the role decides the COPY: the mailer renders through it and
 * `GET /invites/:token` answers `product_name` from it. Every case sweeps the
 * contract's `ROLES`, so a role added there is decided here before it reaches
 * anybody's inbox.
 */

const INPUT = {
  brandName: 'Magick Agency',
  joinUrl: 'https://app.example.com/join/tok_abc123',
  email: 'someone@example.com',
  tenantName: 'Acme Collections',
  inviterName: 'Priya Sharma',
  expiresAt: new Date('2026-01-08T00:00:00Z'),
};

describe('role labels', () => {
  it('match the console claim page, word for word', () => {
    /**
     * `ROLE_LABELS` in `apps/console/src/utils/agencyInviteJoinCopy.ts`, copied
     * here by hand on purpose: nothing links the two apps, so this literal is the
     * cross-check. "Tenant admin" in the mail and "Workspace admin" on the page
     * would be two names for one thing at the moment somebody decides whether the
     * invitation is genuine.
     */
    expect(INVITE_ROLE_LABELS).toEqual({
      agent: 'Agent',
      viewer: 'Viewer',
      operator: 'Operator',
      account_admin: 'Account admin',
      tenant_admin: 'Workspace admin',
      tenant_owner: 'Workspace owner',
    });
  });

  it.each(ROLES)('gives %s a non-empty label', (role) => {
    expect(inviteRoleLabel(role)).toMatch(/\S/);
  });
});

describe('inviteProductName', () => {
  it.each(ROLES)('names what %s is joining', (role) => {
    // The dialer for an agent, who lands on it and nowhere else; the brand's
    // workspace for everyone else, who lands in `/app`.
    expect(inviteProductName(role, 'Magick Agency'))
      .toBe(role === 'agent' ? 'Magick Agency Dialer' : 'Magick Agency');
  });

  it.each(ROLES)('is the product the subject of %s\'s mail names', (role) => {
    // The page and the mail compose the name from one function; this is the
    // proof that the mail actually uses it.
    const { subject } = renderInviteEmailForRole(role, INPUT);
    const product = inviteProductName(role, INPUT.brandName);
    expect(subject.endsWith(product)).toBe(true);
  });
});

describe('renderInviteEmailForRole', () => {
  it('renders the AGENT invitation for an agent, labelled Agent', () => {
    expect(renderInviteEmailForRole('agent', INPUT))
      .toEqual(renderAgentInviteEmail({ ...INPUT, roleLabel: 'Agent' }));
  });

  it.each(ROLES.filter((role) => role !== 'agent'))(
    'renders the WORKSPACE invitation for %s, with its own label',
    (role) => {
      expect(renderInviteEmailForRole(role, INPUT))
        .toEqual(renderWorkspaceInviteEmail({ ...INPUT, roleLabel: INVITE_ROLE_LABELS[role] }));
    },
  );
});
