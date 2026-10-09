import { escapeHtml } from '../escape-html.js';

/**
 * The agent invitation email.
 *
 * ── Pure, and deliberately so ───────────────────────────────────────────────
 * No config import, no repository, no clock, no transport. Everything it renders
 * arrives as a parameter, which makes the copy, the escaping and the link
 * testable with a plain function call — no Mailjet double, no `.env`, no
 * database. That matters more here than in the two notification mailers this
 * repo already has, because this is the ONE email a person receives before they
 * have an account: it is the entire onboarding, and getting the link or the
 * escaping wrong is not a cosmetic bug.
 *
 * It is separated from `invite-mailer.ts` for the reason
 * `renderAgencyCampaignCompletionEmail` is separated from its own send: *"the
 * link is the thing this file exists to get right, and a test that has to stand
 * up Mailjet to read it is a test nobody writes."*
 *
 * ── Why a real HTML email and not the two-paragraph `<div>` next door ───────
 * `job-completion.ts` and `agency-campaign-completion.ts` render a bare `<div>`
 * with a `max-width`, and that is fine for what they are: operational notices to
 * somebody who already uses the product and will read them in whatever their
 * client shows. This one is a customer-facing invitation to a person who has
 * never seen this company, sent to an inbox we know nothing about, and it has to
 * survive three renderers that disagree about almost everything:
 *
 *  - **Gmail strips `<style>` blocks and external stylesheets entirely.** So
 *    every rule here is an inline `style` attribute. There is no stylesheet in
 *    this file and there must never be one.
 *  - **Outlook on Windows renders with the WORD engine.** It ignores
 *    `max-width`, `padding` on many elements, and most positioning — hence the
 *    nested-table layout with an explicit `width="600"`, and hence the button
 *    being a `<table>` with padding on the `<td>` rather than a styled `<a>`.
 *  - **Dark mode inverts anything it thinks is a background.** So every
 *    container sets an explicit `bgcolor` AND an explicit `color`; a transparent
 *    element inherits whatever the client decides, which is how white text on a
 *    white card happens.
 *
 * ── The text part is written, not stripped ─────────────────────────────────
 * {@link renderAgentInviteEmail}'s `textBody` is a real alternative that stands
 * on its own: some clients, some corporate gateways and every screen reader in
 * "plain text" mode show it instead of the HTML, and a de-tagged copy of the
 * HTML reads as a pile of orphaned fragments. The URL appears in it bare, on its
 * own line, because that is what a text client can linkify and what a person can
 * copy.
 */

/** The platform accent — the same value `job-completion.ts` links with. */
export const DEFAULT_BRAND_ACCENT = '#7c5cfc';

/**
 * The product noun, composed rather than hard-coded.
 *
 * "Agency Dialer" is the shipped name everywhere in this platform — master's
 * governance catalog label (`src/governance/catalog.ts`), cusui's
 * `RequireCapability`, `DialerUnavailable` and `returnPath`. Only the BRAND half
 * is a variable, so a white-labelled deployment renames the company and not the
 * product. Inventing a different noun here would put a name in the invitee's
 * first-ever contact with us that appears nowhere in the app they then open.
 */
export function agencyProductName(brandName: string): string {
  // PORT NOTE (magick-agency, decision B17): a brand that already ends in
  // "Agency" — the default, `Magick Agency` — gets "Dialer" alone, so the noun
  // reads "Magick Agency Dialer" and not "Magick Agency Agency Dialer". Every
  // other brand composes exactly as master did.
  if (/\bagency$/i.test(brandName.trim())) return `${brandName.trim()} Dialer`;
  return `${brandName} Agency Dialer`;
}

export interface AgentInviteEmailInput {
  /** e.g. `Magick Agency`. Composed into the product noun, and signs the mail ("Sent by …"). */
  brandName: string;
  /** The join URL — `${origin}/agency/join/${token}`. Must be absolute. */
  joinUrl: string;
  /** The address this invitation was issued for. Shown in the small print. */
  email: string;
  /** The organisation they are joining. CONTEXT, not the headline — see below. */
  tenantName: string;
  /** Who invited them. `null` when master cannot name them; the copy adapts. */
  inviterName: string | null;
  /** Their role, in the operator's vocabulary (`Agent`), not the enum's. */
  roleLabel: string;
  /** When the link stops working. Rendered in UTC in both parts. */
  expiresAt: Date;
  /** Defaults to {@link DEFAULT_BRAND_ACCENT}. */
  accentColor?: string;
  /** Optional wordmark. Omitted entirely rather than rendered as a broken image. */
  logoUrl?: string | null;
}

export interface RenderedEmail {
  subject: string;
  textBody: string;
  htmlBody: string;
}

/**
 * The three steps between clicking the button and taking a call.
 *
 * Declared once and rendered into BOTH parts, so the two cannot describe
 * different journeys — the same reason `renderAgencyCampaignCompletionEmail`
 * declares its rows once.
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

/**
 * Render the invitation.
 *
 * Every interpolated value goes through `escapeHtml`, including ones that "come
 * from us": `tenantName` and `inviterName` are typed by customers, and a tenant
 * called `<b>` or an inviter whose display name carries an `&` would otherwise
 * break the document — or, with a hostile value, inject markup into an email
 * that a colleague opens.
 */
export function renderAgentInviteEmail(input: AgentInviteEmailInput): RenderedEmail {
  const productName = agencyProductName(input.brandName);
  const accent = input.accentColor ?? DEFAULT_BRAND_ACCENT;
  const expires = input.expiresAt.toUTCString();

  const subject = `You've been added to the ${productName}`;
  const headline = `${subject}.`;

  // The supporting line names the PERSON and the ORGANISATION, in that order.
  // The tenant is context, not the headline: "You've been added to Acme
  // Collections" tells an invitee nothing about what they have been added TO,
  // and the product is the thing they have to recognise when they land on it.
  // Without a resolvable inviter the sentence drops the actor rather than
  // inventing one — "Someone has set you up" reads like a phishing mail.
  const supporting = input.inviterName
    ? `${input.inviterName} has set you up as ${indefiniteArticle(input.roleLabel)} ${input.roleLabel} at ${input.tenantName}.`
    : `You have been set up as ${indefiniteArticle(input.roleLabel)} ${input.roleLabel} at ${input.tenantName}.`;

  const textBody = [
    headline,
    '',
    supporting,
    '',
    'Get started here:',
    // Bare, on its own line, and last in its block — that is what a plain-text
    // client can linkify and what a person can select without catching the
    // punctuation of a surrounding sentence.
    input.joinUrl,
    '',
    'What happens next',
    ...WHAT_HAPPENS_NEXT.map(([title, detail], i) => `  ${i + 1}. ${title} — ${detail}`),
    '',
    `This invitation is for ${input.email}.`,
    `The link stops working on ${expires}.`,
    '',
    `Sent by ${input.brandName}.`,
  ].join('\n');

  const e = escapeHtml;
  // `joinUrl` is escaped for the attribute (it is inside double quotes) and
  // again for the visible fallback text. It is NOT url-encoded here — the caller
  // assembles it, encoding the token as it goes.
  const href = e(input.joinUrl);

  const logoRow = input.logoUrl
    ? `<tr><td align="left" style="padding: 0 0 24px 0;"><img src="${e(input.logoUrl)}" alt="${e(input.brandName)}" width="132" style="display: block; border: 0; outline: none; text-decoration: none; height: auto; max-width: 132px;" /></td></tr>`
    : `<tr><td align="left" style="padding: 0 0 24px 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 15px; font-weight: 700; letter-spacing: -0.01em; color: ${e(accent)};">${e(input.brandName)}</td></tr>`;

  const stepRows = WHAT_HAPPENS_NEXT.map(([title, detail], i) => `
                    <tr>
                      <td valign="top" width="28" style="padding: 0 12px 14px 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 13px; font-weight: 700; line-height: 20px; color: ${e(accent)};">${i + 1}</td>
                      <td valign="top" style="padding: 0 0 14px 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 14px; line-height: 20px; color: #1a1a2e;"><span style="font-weight: 600; color: #1a1a2e;">${e(title)}</span><br /><span style="color: #5b5b6b;">${e(detail)}</span></td>
                    </tr>`).join('');

  /**
   * The document, outermost table in.
   *
   * `role="presentation"` on every layout table so assistive technology reads
   * the content rather than announcing a grid of empty data cells — these tables
   * are the only way to lay anything out in Outlook, and without the role each
   * one is announced as a table with rows and columns.
   *
   * The outer table is `width="100%"` with a fixed-width table centred inside
   * it, rather than a single `max-width` element: Outlook's Word engine ignores
   * `max-width` outright, and a bare 600px table with no full-width parent is
   * left-aligned in several clients.
   */
  const htmlBody = `
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#f4f4f7" style="width: 100%; background-color: #f4f4f7; margin: 0; padding: 0;">
  <tr>
    <td align="center" style="padding: 32px 12px;">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width: 600px; max-width: 600px;">
        <tr>
          <td bgcolor="#ffffff" style="background-color: #ffffff; border-radius: 12px; padding: 32px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
              ${logoRow}
              <tr>
                <td style="padding: 0 0 12px 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 22px; line-height: 30px; font-weight: 700; letter-spacing: -0.02em; color: #1a1a2e;">${e(headline)}</td>
              </tr>
              <tr>
                <td style="padding: 0 0 28px 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 15px; line-height: 23px; color: #5b5b6b;">${e(supporting)}</td>
              </tr>
              <tr>
                <td style="padding: 0 0 28px 0;">
                  <!--
                    The bulletproof button: a TABLE with the background on the
                    <td> and the padding on the <a>. Outlook's Word engine drops
                    background-colour and padding from a styled <a>, which turns
                    a primary call to action into an underlined blue word — the
                    single most consequential element in this mail rendered as
                    the least noticeable thing in it.
                  -->
                  <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                    <tr>
                      <td align="center" bgcolor="${e(accent)}" style="background-color: ${e(accent)}; border-radius: 8px;">
                        <a href="${href}" style="display: inline-block; padding: 13px 28px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 15px; font-weight: 600; line-height: 20px; color: #ffffff; text-decoration: none; border-radius: 8px;">Set up your sign-in</a>
                      </td>
                    </tr>
                  </table>
                </td>
              </tr>
              <tr>
                <td bgcolor="#f7f7fa" style="background-color: #f7f7fa; border-radius: 10px; padding: 20px;">
                  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                    <tr>
                      <td colspan="2" style="padding: 0 0 14px 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 11px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: #8a8a99;">What happens next</td>
                    </tr>${stepRows}
                  </table>
                </td>
              </tr>
              <tr>
                <td style="padding: 24px 0 0 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 12px; line-height: 18px; color: #8a8a99;">
                  This invitation is for ${e(input.email)}. The link stops working on ${e(expires)}.<br />
                  If the button does not work, copy this link into your browser:<br />
                  <span style="color: #8a8a99; word-break: break-all;">${href}</span>
                </td>
              </tr>
            </table>
          </td>
        </tr>
        <tr>
          <td align="center" style="padding: 20px 8px 0 8px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 11px; line-height: 17px; color: #9a9aa8;">Sent by ${e(input.brandName)}. If you were not expecting this, you can ignore it.</td>
        </tr>
      </table>
    </td>
  </tr>
</table>`.trim();

  return { subject, textBody, htmlBody };
}

/**
 * "a" or "an" for a role label.
 *
 * A vowel check rather than a hard-coded "an Agent", because the label is a
 * parameter: this template is written so a future workspace-member invite can
 * reuse it with `Viewer` or `Operator` without the sentence going wrong. Not a
 * general-purpose article rule — English has plenty of exceptions — but the
 * closed set of role labels this platform has contains none of them.
 */
function indefiniteArticle(word: string): string {
  return /^[aeiou]/i.test(word) ? 'an' : 'a';
}
