import { describe, it, expect } from 'vitest';
import {
  renderWorkspaceInviteEmail,
  workspaceProductName,
} from '../../../src/notifications/templates/workspace-invite.template.js';
import { renderAgentInviteEmail } from '../../../src/notifications/templates/agent-invite.template.js';
import { renderInviteEmail } from '../../../src/notifications/templates/invite-email.layout.js';

/**
 * The workspace invitation email
 * (`src/notifications/templates/workspace-invite.template.ts`) — what every role
 * but `agent` receives.
 *
 * ── Why it has its own suite ───────────────────────────────────────────────
 * This mail did not exist: every non-agent invite reported `not_implemented` and
 * nobody was told. Its document is the agent mail's (`invite-email.layout.ts`),
 * and `agent-invite.template.test.ts` already proves the layout's mail-client
 * properties in depth, so the cases here prove what is NEW — the copy, the
 * workspace link, and that the escaping and the plain-text alternative reach
 * this invitation too rather than being assumed from the other one.
 */

const BASE = {
  brandName: 'Magick Agency',
  joinUrl: 'https://app.example.com/join/tok_abc123',
  email: 'new.admin@example.com',
  tenantName: 'Acme Collections',
  inviterName: 'Priya Sharma',
  roleLabel: 'Account admin',
  expiresAt: new Date('2026-01-08T00:00:00Z'),
};

describe('the subject and headline', () => {
  it('names the brand — the workspace — and not the dialer', () => {
    /**
     * An `account_admin` lands in `/app`, and most tenants have no dialer at all.
     * A subject naming the "Agency Dialer" would name a product the reader then
     * cannot find, which reads as a mistake at best and phishing at worst.
     */
    const { subject } = renderWorkspaceInviteEmail(BASE);
    expect(subject).toBe("You've been added to Magick Agency");
    expect(subject).not.toMatch(/dialer/i);
  });

  it('is the brand exactly, with no "Agency" doubling rule to apply', () => {
    // `agencyProductName`'s B17 rule exists to stop "Agency Agency Dialer"; the
    // workspace noun appends nothing, so there is nothing to double.
    expect(workspaceProductName('Northwind')).toBe('Northwind');
    expect(workspaceProductName('Magick Agency')).toBe('Magick Agency');
    expect(renderWorkspaceInviteEmail({ ...BASE, brandName: 'Northwind' }).subject)
      .toBe("You've been added to Northwind");
  });

  it('makes the headline the subject as a sentence, in both parts', () => {
    const { htmlBody, textBody } = renderWorkspaceInviteEmail(BASE);
    expect(htmlBody).toContain("You've been added to Magick Agency.");
    expect(textBody).toContain("You've been added to Magick Agency.");
  });
});

describe('the supporting line', () => {
  it.each([
    ['Viewer', 'a Viewer'],
    ['Operator', 'an Operator'],
    ['Account admin', 'an Account admin'],
    ['Workspace admin', 'a Workspace admin'],
    ['Workspace owner', 'a Workspace owner'],
  ])('names the role %s with the right article', (roleLabel, phrase) => {
    // Every workspace label, through the one sentence. The labels are the
    // console claim page's, so the mail and the page say the same thing.
    const { htmlBody, textBody } = renderWorkspaceInviteEmail({ ...BASE, roleLabel });
    const line = `Priya Sharma has set you up as ${phrase} at Acme Collections.`;
    expect(textBody).toContain(line);
    expect(htmlBody).toContain(line);
  });

  it('drops the actor rather than inventing one when the inviter is unknown', () => {
    const { textBody } = renderWorkspaceInviteEmail({ ...BASE, inviterName: null });
    expect(textBody).toContain('You have been set up as an Account admin at Acme Collections.');
    expect(textBody).not.toContain('Someone');
  });
});

describe('what happens next', () => {
  it('describes joining a workspace, in both parts, and nothing about calls', () => {
    /**
     * The agent steps promise a station and staffed campaigns; for an admin every
     * one is false. These say what is true for every workspace role: sign in, you
     * are already a member, and what you see depends on your role.
     */
    const { htmlBody, textBody } = renderWorkspaceInviteEmail(BASE);
    for (const step of ['Set up your sign-in', 'Your workspace opens', 'What you see depends on your role']) {
      expect(textBody, step).toContain(step);
      expect(htmlBody, step).toContain(step);
    }
    for (const part of [textBody, htmlBody]) {
      expect(part).not.toMatch(/station|dialer|campaign|take calls/i);
    }
  });

  it('promises nothing about who can change the role, which is false for an owner', () => {
    /**
     * The step said "an admin on your team can change it later". A
     * `tenant_owner` is mailed this same invitation (a super admin's tenant
     * create, or add-user), and nobody in their workspace outranks them, so the
     * copy has to be true for every role it is sent to rather than for most.
     */
    const { htmlBody, textBody } = renderWorkspaceInviteEmail({ ...BASE, roleLabel: 'Workspace owner' });
    for (const part of [textBody, htmlBody]) {
      expect(part).not.toMatch(/admin on your team|can change it later/i);
      expect(part).toContain('The role named above sets what you can see and change in the workspace.');
    }
  });

  it('differs from the agent mail ONLY in the subject and the steps', () => {
    /**
     * The shared layout's contract, checked from the outside: render the same
     * input both ways, take out the two things each template supplies, and what
     * is left must be identical. A template that quietly forked the document — a
     * different button, a missing footer — fails here.
     */
    const agent = renderAgentInviteEmail(BASE);
    const workspace = renderWorkspaceInviteEmail(BASE);
    const strip = (text: string, subject: string, steps: string[]) =>
      steps.reduce((acc, step) => acc.split(step).join('<STEP>'), text.split(subject).join('<SUBJECT>'));
    const agentSteps = [
      'Choose how you sign in — this link is what connects it to your place on the team.',
      'Your station opens', 'The dialer screen you take calls from, ready to go.',
      'The campaigns you are staffed on appear', 'Your supervisor decides which ones; they show up as they are assigned.',
    ];
    const workspaceSteps = [
      'Choose how you sign in — this link is what connects it to your place in the workspace.',
      'Your workspace opens', 'You arrive already a member. There is nothing else to sign up for or create.',
      'What you see depends on your role', 'The role named above sets what you can see and change in the workspace.',
    ];
    for (const part of ['textBody', 'htmlBody'] as const) {
      expect(strip(workspace[part], workspace.subject, workspaceSteps))
        .toBe(strip(agent[part], agent.subject, agentSteps));
    }
  });
});

describe('the link', () => {
  it('carries the /join URL in the button, the fallback line and the text part', () => {
    const { htmlBody, textBody } = renderWorkspaceInviteEmail(BASE);

    expect(htmlBody).toContain(`href="${BASE.joinUrl}"`);
    expect(htmlBody.split(BASE.joinUrl).length - 1).toBeGreaterThanOrEqual(2);
    expect(textBody.split('\n')).toContain(BASE.joinUrl);
  });
});

describe('escaping', () => {
  /**
   * The same customer-authored values reach this mail as the agent's, sent to
   * somebody outside the tenant — and this invitation goes to admins and owners,
   * whose inboxes are the more valuable ones to inject markup into.
   */
  const HOSTILE = '<script>alert("x")</script> & "quoted"';

  it('escapes a hostile tenant name, inviter name and brand out of the HTML', () => {
    const { htmlBody } = renderWorkspaceInviteEmail({
      ...BASE, tenantName: HOSTILE, inviterName: HOSTILE, brandName: '<b>Brand</b>',
    });

    expect(htmlBody).not.toContain('<script>');
    expect(htmlBody).not.toContain('<b>Brand</b>');
    expect(htmlBody).toContain('&lt;script&gt;');
    expect(htmlBody).toContain('&quot;quoted&quot;');
    expect(htmlBody).toContain('&lt;b&gt;Brand&lt;/b&gt;');
  });

  it('escapes the join URL into the attribute, without url-encoding it', () => {
    const { htmlBody } = renderWorkspaceInviteEmail({ ...BASE, joinUrl: 'https://x.test/join/a?b=1&c="2"' });
    expect(htmlBody).toContain('href="https://x.test/join/a?b=1&amp;c=&quot;2&quot;"');
    expect(htmlBody).not.toContain('c="2"');
  });

  it('escapes the COPY too — the subject and every step title and detail', () => {
    /**
     * Today's steps are constants with nothing to escape, which is exactly why
     * this is asserted with hostile copy fed straight to the shared layout: the
     * subject carries the brand (an env var), and the next template to supply
     * steps may interpolate something. An unescaped title would pass every case
     * that only renders the shipped copy.
     */
    const { htmlBody, textBody } = renderInviteEmail(BASE, {
      subject: 'Joined <Brand & Co>',
      steps: [['<i>title</i>', '<u>detail</u> & more']],
    });

    expect(htmlBody).not.toMatch(/<i>|<u>|<Brand/);
    expect(htmlBody).toContain('&lt;i&gt;title&lt;/i&gt;');
    expect(htmlBody).toContain('&lt;u&gt;detail&lt;/u&gt; &amp; more');
    expect(htmlBody).toContain('Joined &lt;Brand &amp; Co&gt;.');
    // The text part is not HTML, so it carries the copy as written.
    expect(textBody).toContain('1. <i>title</i> — <u>detail</u> & more');
  });

  it('does not double-escape, and leaves the TEXT part unescaped', () => {
    const { htmlBody, textBody } = renderWorkspaceInviteEmail({ ...BASE, tenantName: 'Smith & Sons' });
    expect(htmlBody).toContain('Smith &amp; Sons');
    expect(htmlBody).not.toContain('&amp;amp;');
    expect(textBody).toContain('Smith & Sons');
  });
});

describe('the plain-text alternative and the small print', () => {
  it('is substantial, carries no markup, and states the address and the expiry', () => {
    const { textBody, htmlBody } = renderWorkspaceInviteEmail(BASE);
    const expires = BASE.expiresAt.toUTCString();

    expect(textBody.trim().length).toBeGreaterThan(200);
    expect(textBody).not.toContain('<');
    expect(textBody).toContain('This invitation is for new.admin@example.com.');
    expect(textBody).toContain(`The link stops working on ${expires}.`);
    expect(htmlBody).toContain('new.admin@example.com');
    expect(htmlBody).toContain(expires);
  });

  it('is pure — the same input renders byte-identically', () => {
    expect(renderWorkspaceInviteEmail(BASE)).toEqual(renderWorkspaceInviteEmail(BASE));
  });
});
