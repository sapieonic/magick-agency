import { describe, it, expect } from 'vitest';
import {
  DEFAULT_BRAND_ACCENT,
  agencyProductName,
  renderAgentInviteEmail,
} from '../../../src/notifications/templates/agent-invite.template.js';

/**
 * The agent invitation email
 * (`src/notifications/templates/agent-invite.template.ts`).
 *
 * ── Why this file exists separately from the mailer's ──────────────────────
 * The template is a pure function of its parameters — no config, no transport,
 * no clock — precisely so the copy, the escaping and the link can be asserted
 * with a plain call. The mailer's own suite proves the SEND; this one proves the
 * DOCUMENT, which is the half a reviewer cannot check by reading a mock.
 *
 * It matters more here than for the two operational mailers next door. This is
 * the one email a person receives before they have an account, and it is an
 * invited agent's entire onboarding: a wrong link, a mangled name or a body that
 * collapses in Outlook is not a cosmetic bug, it is somebody who never arrives.
 */

const BASE = {
  brandName: 'Magick Agency',
  joinUrl: 'https://app.example.com/agency/join/tok_abc123',
  email: 'newagent@example.com',
  tenantName: 'Acme Collections',
  inviterName: 'Priya Sharma',
  roleLabel: 'Agent',
  expiresAt: new Date('2026-01-08T00:00:00Z'),
};

describe('the subject and headline', () => {
  it('is the product owner’s exact sentence', () => {
    // Pinned verbatim. The wording was specified, not derived, and a paraphrase
    // is the kind of change that lands in review as an improvement.
    // PORT NOTE (magick-agency, decision B17): the brand is `Magick Agency`, so
    // the noun is "Magick Agency Dialer" (master: "MagickVoice Agency Dialer").
    expect(renderAgentInviteEmail(BASE).subject)
      .toBe("You've been added to the Magick Agency Dialer");
  });

  it('composes the product noun from the brand — only the brand half moves', () => {
    /**
     * "Agency Dialer" is the shipped name across master's governance catalog and
     * three cusui surfaces (`RequireCapability`, `DialerUnavailable`,
     * `returnPath`). An invitee whose first contact with us names a product that
     * appears nowhere in the app they then open is worse off than one who sees
     * no branding at all — so the noun is fixed and the company name is the
     * parameter.
     */
    expect(agencyProductName('Northwind')).toBe('Northwind Agency Dialer');
    expect(renderAgentInviteEmail({ ...BASE, brandName: 'Northwind' }).subject)
      .toBe("You've been added to the Northwind Agency Dialer");
  });

  it('does not double "Agency" when the brand already ends with it (B17)', () => {
    // NEW in Magick Agency: the default brand is `Magick Agency`, and master's
    // composition would have produced "Magick Agency Agency Dialer".
    expect(agencyProductName('Magick Agency')).toBe('Magick Agency Dialer');
    expect(agencyProductName('Acme agency ')).toBe('Acme agency Dialer');
    // Only a whole trailing word counts.
    expect(agencyProductName('Travelagency')).toBe('Travelagency Agency Dialer');
  });

  it('makes the headline the subject as a sentence, in both parts', () => {
    const { htmlBody, textBody } = renderAgentInviteEmail(BASE);
    const headline = "You've been added to the Magick Agency Dialer.";

    expect(htmlBody).toContain(headline);
    expect(textBody).toContain(headline);
  });
});

describe('the supporting line', () => {
  it('names the PERSON and the ORGANISATION, with the tenant as context', () => {
    /**
     * The tenant is deliberately not the headline. "You've been added to Acme
     * Collections" tells an invitee nothing about what they have been added TO,
     * and the product is the thing they have to recognise when they land on it.
     */
    const { htmlBody, textBody } = renderAgentInviteEmail(BASE);
    const line = 'Priya Sharma has set you up as an Agent at Acme Collections.';

    expect(htmlBody).toContain(line);
    expect(textBody).toContain(line);
  });

  it('drops the actor rather than inventing one when the inviter is unknown', () => {
    /**
     * "Someone has set you up" reads like a phishing mail, which is the one
     * impression this message cannot afford. `inviter_name` is typed
     * `string | null` on the API contract for the same reason: master genuinely
     * may not be able to name them.
     */
    const { textBody } = renderAgentInviteEmail({ ...BASE, inviterName: null });

    expect(textBody).toContain('You have been set up as an Agent at Acme Collections.');
    expect(textBody).not.toContain('Someone');
  });

  it('picks the article from the role label, not from a hard-coded "an"', () => {
    // The label is a parameter so a future workspace-member invite can reuse this
    // template with `Viewer` or `Operator` without the sentence going wrong.
    expect(renderAgentInviteEmail({ ...BASE, roleLabel: 'Viewer' }).textBody)
      .toContain('as a Viewer at');
    expect(renderAgentInviteEmail({ ...BASE, roleLabel: 'Operator' }).textBody)
      .toContain('as an Operator at');
  });
});

describe('the link', () => {
  it('carries the join URL in the button, the fallback line and the text part', () => {
    /**
     * Three places, and none is redundant. The button is the primary action; the
     * copy-this-link line is what a reader falls back on when their client
     * disables the button's styling or they are reading on a device that cannot
     * click it; and the text part is what a plain-text client, a corporate
     * gateway and a screen reader in plain mode actually show.
     */
    const { htmlBody, textBody } = renderAgentInviteEmail(BASE);

    expect(htmlBody).toContain(`href="${BASE.joinUrl}"`);
    expect(htmlBody.split(BASE.joinUrl).length - 1).toBeGreaterThanOrEqual(2);
    expect(textBody).toContain(BASE.joinUrl);
  });

  it('puts the URL bare on its own line in the text part', () => {
    /**
     * That is what a plain-text client can linkify and what a person can select
     * without catching the punctuation of a surrounding sentence — a trailing
     * full stop swallowed into a copied URL is a 404 the reader cannot diagnose.
     */
    expect(renderAgentInviteEmail(BASE).textBody.split('\n')).toContain(BASE.joinUrl);
  });
});

describe('escaping', () => {
  /**
   * `tenantName` and `inviterName` are CUSTOMER-authored — typed into the team
   * page by whoever created the tenant or set their own display name. They land
   * in a document a mail client renders, and it is sent to somebody outside the
   * tenant, so a hostile value here is markup injected into a stranger's inbox.
   * The ordinary case is duller and just as broken: a company called "Smith &
   * Sons" renders as "Smith &amp;amp; Sons" if the ampersand pass runs last.
   */
  const HOSTILE = '<script>alert("x")</script> & "quoted"';

  it('escapes a hostile tenant name out of the HTML', () => {
    const { htmlBody } = renderAgentInviteEmail({ ...BASE, tenantName: HOSTILE });

    expect(htmlBody).not.toContain('<script>');
    expect(htmlBody).toContain('&lt;script&gt;');
    expect(htmlBody).toContain('&amp;');
    expect(htmlBody).toContain('&quot;quoted&quot;');
  });

  it('escapes a hostile inviter name out of the HTML', () => {
    const { htmlBody } = renderAgentInviteEmail({ ...BASE, inviterName: HOSTILE });

    expect(htmlBody).not.toContain('<script>');
    expect(htmlBody).toContain('&lt;script&gt;');
  });

  it('escapes the brand name and the logo URL too', () => {
    // The brand comes from an env var, which is not user input — but it is
    // interpolated into an `<img src>` and a text node, and "it is ours" has
    // never been a reason for a template to skip escaping.
    const { htmlBody } = renderAgentInviteEmail({
      ...BASE,
      brandName: '<b>Brand</b>',
      logoUrl: 'https://cdn.test/logo.png?a=1&b=2',
    });

    expect(htmlBody).not.toContain('<b>Brand</b>');
    expect(htmlBody).toContain('a=1&amp;b=2');
  });

  it('does not double-escape an ampersand', () => {
    // The `&` pass runs FIRST for this reason; run last, it would rewrite its own
    // replacements into `&amp;lt;`.
    expect(renderAgentInviteEmail({ ...BASE, tenantName: 'Smith & Sons' }).htmlBody)
      .toContain('Smith &amp; Sons');
    expect(renderAgentInviteEmail({ ...BASE, tenantName: 'Smith & Sons' }).htmlBody)
      .not.toContain('&amp;amp;');
  });

  it('leaves the TEXT part unescaped — it is not HTML', () => {
    // Escaping the plain-text alternative would show a reader literal `&amp;`,
    // which is the failure mode of treating one body as the other.
    expect(renderAgentInviteEmail({ ...BASE, tenantName: 'Smith & Sons' }).textBody)
      .toContain('Smith & Sons');
  });
});

describe('the plain-text alternative', () => {
  it('is substantial and stands on its own, not a stripped copy', () => {
    /**
     * Some clients, some corporate gateways and every screen reader in plain-text
     * mode show this instead of the HTML. A de-tagged copy of the HTML reads as a
     * pile of orphaned fragments, so it is written separately — and it therefore
     * has to be checked for the things it could silently lose.
     */
    const { textBody } = renderAgentInviteEmail(BASE);

    expect(textBody.trim().length).toBeGreaterThan(200);
    expect(textBody).not.toContain('<');
    expect(textBody).toContain('What happens next');
    expect(textBody).toContain('This invitation is for newagent@example.com.');
    expect(textBody).toContain('The link stops working on');
  });

  it('carries the same three steps as the HTML', () => {
    // Declared once and rendered into both, so the two cannot describe different
    // journeys. An agent whose station is empty needs to know it is because their
    // supervisor has not staffed them yet — that is what these steps are for.
    const { htmlBody, textBody } = renderAgentInviteEmail(BASE);

    for (const step of ['Set up your sign-in', 'Your station opens', 'campaigns you are staffed on']) {
      expect(textBody, step).toContain(step);
      expect(htmlBody, step).toContain(step);
    }
  });
});

describe('the small print', () => {
  it('states the invited address and the expiry in both parts', () => {
    /**
     * The address is what lets a recipient tell an invitation meant for them from
     * one forwarded by a colleague, and the expiry is what stops "I clicked it
     * last week and it did not work" from being a mystery.
     */
    const { htmlBody, textBody } = renderAgentInviteEmail(BASE);
    const expires = BASE.expiresAt.toUTCString();

    expect(htmlBody).toContain('newagent@example.com');
    expect(htmlBody).toContain(expires);
    expect(textBody).toContain('newagent@example.com');
    expect(textBody).toContain(expires);
  });
});

describe('the HTML, as a mail client will see it', () => {
  const { htmlBody } = renderAgentInviteEmail(BASE);

  it('inlines every style — Gmail strips stylesheets and <style> blocks', () => {
    expect(htmlBody).not.toContain('<style');
    expect(htmlBody).not.toContain('<link');
    expect(htmlBody).toContain('style="');
  });

  it('loads nothing external except an explicitly-supplied logo', () => {
    // No tracking pixel, no webfont, no remote CSS. Every one of those is a
    // request that a privacy-conscious client blocks and a corporate gateway
    // rewrites, and the second is why the font stack is a system stack.
    expect(htmlBody).not.toContain('<img');
    expect(htmlBody).not.toContain('@import');
    expect(renderAgentInviteEmail({ ...BASE, logoUrl: 'https://cdn.test/l.png' }).htmlBody)
      .toContain('<img src="https://cdn.test/l.png"');
  });

  it('lays out in tables with role="presentation", and pins the 600px width', () => {
    /**
     * Outlook on Windows renders with the WORD engine: it ignores `max-width`,
     * so the width has to be a `width="600"` attribute on a table, and a fixed
     * table with no full-width parent is left-aligned in several clients — hence
     * the outer 100% table with the fixed one centred inside it.
     *
     * `role="presentation"` on every layout table so assistive technology reads
     * the content instead of announcing a grid of empty data cells.
     */
    expect(htmlBody).toContain('width="600"');
    expect(htmlBody).toContain('max-width: 600px');
    const tables = htmlBody.match(/<table/g) ?? [];
    const presentation = htmlBody.match(/role="presentation"/g) ?? [];
    expect(tables.length).toBeGreaterThan(3);
    expect(presentation.length).toBe(tables.length);
  });

  it('builds the CTA as a bulletproof table button, not a styled anchor alone', () => {
    /**
     * Outlook's Word engine drops `background-color` and `padding` from a styled
     * `<a>`, which turns the single most consequential element in this mail into
     * an underlined blue word. The background goes on a `<td>` with a `bgcolor`
     * attribute AND a CSS declaration; the padding goes on the anchor.
     */
    expect(htmlBody).toMatch(/<td[^>]*bgcolor="#7c5cfc"[^>]*>\s*<a href=/);
    expect(htmlBody).toContain('padding: 13px 28px');
  });

  it('sets an explicit bgcolor and color on every container — dark-mode safety', () => {
    /**
     * Dark mode inverts anything a client decides is a background, so a
     * transparent element inherits whatever it chooses. That is how white text on
     * a white card happens. Every surface here names both, and there is no
     * reliance on a default.
     */
    expect(htmlBody).toContain('bgcolor="#f4f4f7"');
    expect(htmlBody).toContain('bgcolor="#ffffff"');
    expect(htmlBody).toContain('color: #ffffff');
    expect(htmlBody).toContain('color: #1a1a2e');
  });

  it('uses the platform accent by default and honours an override', () => {
    // The default is the same `#7c5cfc` `job-completion.ts` already links with, so
    // the two mails a customer can receive from this platform are one colour.
    expect(DEFAULT_BRAND_ACCENT).toBe('#7c5cfc');
    expect(htmlBody).toContain(DEFAULT_BRAND_ACCENT);
    expect(renderAgentInviteEmail({ ...BASE, accentColor: '#ff0055' }).htmlBody)
      .toContain('#ff0055');
  });

  it('omits the logo element entirely rather than rendering a broken image', () => {
    // There is no default logo that could be right, and a broken image in the
    // first message somebody receives from a company reads as a scam.
    expect(htmlBody).not.toContain('<img');
    expect(htmlBody).toContain('Magick Agency');
  });

  it('is pure — the same input renders byte-identically', () => {
    // No clock, no config, no randomness. That is what makes every assertion in
    // this file a statement about the template rather than about the moment.
    expect(renderAgentInviteEmail(BASE)).toEqual(renderAgentInviteEmail(BASE));
  });
});
