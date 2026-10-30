import type { AppConfig } from '../config/schema.js';
import { createChildLogger } from '@magick-agency/observability';
import type { MembershipRole } from '@magick-agency/db/models/membership.model';
import { renderInviteEmailForRole } from './templates/invite-email.js';

const log = createChildLogger({ component: 'invite-mailer' });

/**
 * Config, resolved on first use rather than on import.
 *
 * ── This is not a style preference; a static import here breaks test suites ──
 * `src/config/index.ts` runs `loadConfig()` at module scope and calls
 * `process.exit(1)` when the Zod schema does not parse, and its first line is
 * `import 'dotenv/config'` against a `.env` that is gitignored and untracked. So
 * ANY module that imports it statically drags a process-killing side effect into
 * the import graph of everything that reaches that module: because the Zod
 * schema is imported transitively by many tests, a missing `.env` fails unit
 * tests, not just `npm run dev`.
 *
 * `user.routes.ts` imports this file, and `test/integration/api/user.routes.test.ts`
 * imports that. Before this file existed nothing in that graph reached config, so
 * the suite ran without one; a static import turned it into
 * `Error: process.exit unexpectedly called with "1"` at
 * `invite-mailer.ts:1:1`, with no reference to mail anywhere in the failure.
 *
 * Deliberately still `config` and not `process.env`: `consoleBaseUrl` is
 * `z.string().url().optional()`, so reading the variable directly would drop the
 * URL validation and let a malformed base URL through to a link handed to a new
 * hire. The validation is kept and only the moment it runs moves.
 *
 * **The same rule binds the TRANSPORT import below**, and that is easy to lose:
 * `mailjet.client.ts` imports config *statically*, so a static
 * `import { sendEmail } from './mailjet.client.js'` here would reintroduce
 * exactly the failure this lazy resolve exists to prevent — by a second route,
 * through a module whose name gives no hint that it touches config. The send
 * therefore uses a dynamic `import()` inside {@link sendInviteEmail}.
 *
 * Cached, so a request path does not pay the resolution twice and so the
 * `process.exit` on genuinely bad config still happens exactly once — at the
 * first send rather than at boot. Boot-time validation is unaffected: `index.ts`
 * imports config directly, so a real deployment still fails fast.
 */
let cachedConfig: AppConfig | undefined;
async function appConfig(): Promise<AppConfig> {
  if (!cachedConfig) {
    ({ config: cachedConfig } = await import('../config/index.js'));
  }
  return cachedConfig;
}

/**
 * The invite email, for every role.
 *
 * ── What it is for ─────────────────────────────────────────────────────────
 * `POST /users/invite` writes a membership and, for an unknown address, a stub
 * user whose `firebase_uid` is `pending_<uuid>`. Without a mail, the invited
 * person would have to arrive at the app on their own and sign in with exactly
 * the address that was typed — and an invited agent with no Google account would
 * have no way in at all: `/agency/login` deliberately has no signup, and Firebase
 * password-reset cannot mint a credential for a user that does not exist. An
 * invited operator or admin was in the same position one page over, and was
 * told nothing at all.
 *
 * This file sends a real email carrying a real token
 * (`src/notifications/invite-token.ts`), and the token — not an email match — is
 * what binds the invitee's Firebase identity to the membership when they claim it
 * at `POST /invites/:token/claim`. So signing in with a different address does
 * not orphan the membership.
 *
 * ── The transport is MAILJET ───────────────────────────────────────────────
 * `mailjet.client.ts` is the transport the agency campaign-completion notice
 * also uses, is bounded in time (`MAILJET_TIMEOUT_MS`), and reports rather than
 * throws. Changing transport means swapping it inside {@link sendInviteEmail},
 * below the config guard; nothing else on this path changes.
 *
 * ── Scope: every role, each to its own claim page ──────────────────────────
 * This was `agent`-only, and every other role reported `not_implemented` with a
 * `sign_in_url` of `/login` — not out of caution but for want of a destination:
 * the only page built for somebody with no account yet was the agency one, and
 * mailing an admin a link into a sign-in page they had no credential for would
 * have been the same dead end one role over. That page now exists for the
 * workspace too (`/join/:token`), so every role is mailed a token-bound link
 * ({@link inviteSignInUrl}) and an invitation worded for what they are joining
 * (`templates/invite-email.ts`): the dialer for an `agent`, the workspace for
 * everyone else. There is no role gate in this module any more; whether a role
 * gets a token at all is `roleGetsTokenInvite`'s single answer, one layer up.
 *
 * ── Never throws, never delays ─────────────────────────────────────────────
 * The membership IS the outcome of an invite; the email is an accelerant. So this
 * function is total — every failure is a returned `reason`, never a rejection —
 * and the route awaits it only because the answer goes on the response. The
 * transport carries its own timeout because undici's default headers timeout is
 * 300s, and an invite must not sit behind a mail provider for five minutes. `mailjet.client.ts` bounds
 * every request at `MAILJET_TIMEOUT_MS` (10s) and reports an abort as a refusal,
 * which is what keeps `POST /users/invite` answering 201 on a hung provider.
 */

/** What the caller learns. A discriminated union, so a reason cannot be dropped. */
export type InviteEmailResult =
  /**
   * Sent, and (when the transport can say) the provider's id for it.
   *
   * Mailjet CANNOT say: `sendEmail` reports a boolean, having already logged the
   * `MessageUUID`s it got back. So this is `null` on today's transport; the
   * field stays on the union as the place for an id from a transport that
   * returns one.
   */
  | { sent: true; messageId: string | null }
  /**
   * No `mailjet` config block, so there is no transport — or the join link could
   * not be built, which is the same KIND of fault (a missing setting) and is
   * reported the same way so an operator is not sent to inspect a mail provider
   * that is working perfectly.
   */
  | { sent: false; reason: 'not_configured' }
  /**
   * The role has no invitation at all. **No role produces this today, and this
   * module never does.**
   *
   * It is reported only by `issueInvite`, for a role `roleGetsTokenInvite`
   * refuses — and that predicate answers `true` for every role now that each one
   * has a claim page. The arm stays on the union because the predicate stays a
   * switch: narrowing it again must not leave the refused role a choice between
   * a mail into a sign-in page with a Sign Up tab (the stray-tenant door the
   * token exists to close) and a reason that blames the operator's config. The
   * wire contract keeps tolerating it for a rolling deploy either way
   * (`packages/contracts/src/api/platform/team.ts`).
   */
  | { sent: false; reason: 'not_implemented' }
  /** The transport was attempted and refused or threw. Logged; never thrown. */
  | { sent: false; reason: 'failed' };

export interface SendInviteEmailInput {
  /** The invited address, exactly as typed — it is who the mail goes to. */
  email: string;
  /**
   * Their role in the new membership. Decides WHICH invitation they receive —
   * its subject, its steps and the role named in it — never whether there is one.
   */
  role: MembershipRole;
  /** Whose workspace they were invited to. For attribution and logging. */
  tenantId: string;
  /**
   * Where to send them, from {@link inviteSignInUrl}. `null` when the server
   * cannot build one (no `CONSOLE_BASE_URL`), which is itself a reason not to send: an
   * invite email whose only job is to carry a link, without the link, is worse
   * than no email.
   */
  signInUrl: string | null;
  /**
   * The organisation's name, for the supporting line ("…at Acme Collections").
   *
   * Optional, and it FALLS BACK rather than failing: the invite route resolves it from
   * `tenants` on the invite path, and a lookup that returns nothing must not be
   * the reason an invitee never receives their only way in. The template treats it
   * as context rather than as the headline, so a generic value still reads.
   */
  tenantName?: string | null;
  /**
   * Who invited them, if the invite route can name them. `null` renders a sentence with no
   * actor rather than inventing one — see the template.
   */
  inviterName?: string | null;
  /** When the link stops working. Shown in the small print of both parts. */
  expiresAt?: Date | null;
}

/** The console's primary sign-in page. */
const LOGIN_PATH = '/login';

/**
 * The Agency Dialer's own sign-in page in the console.
 *
 * Same identity system, a different entrance. Retained as the fallback for an
 * `agent` invite with no token — see {@link inviteSignInUrl}.
 */
const AGENCY_LOGIN_PATH = '/agency/login';

/**
 * The invitation CLAIM page for an `agent`: where their token-bearing link lands.
 *
 * A page for somebody who has no account yet. It reads the token, renders
 * `GET /invites/:token`'s answer ("this invitation is for you@…, as an Agent at
 * Acme"), takes them through Firebase sign-in, and posts
 * `POST /invites/:token/claim` — which binds whatever identity they arrive with
 * to the membership the TOKEN names.
 */
const AGENCY_JOIN_PATH = '/agency/join';

/**
 * The invitation CLAIM page for every other role — the same three steps against
 * the same two endpoints, outside the agency shell, and finishing in `/app`.
 *
 * Public in the console's router for the reason the agency one is: the reader
 * has no session yet. Both pages call the same role-agnostic endpoints, and the
 * console sends on a token that arrives at the other page's door — but the door
 * this function picks is the one that needs no redirect.
 */
const WORKSPACE_JOIN_PATH = '/join';

/**
 * The URL an invite should carry.
 *
 * ── A JOIN page for every role that carries a token ────────────────────────
 * `/agency/join/:token` for an `agent`, `/join/:token` for everyone else. Both
 * are claim pages for somebody with no account yet; they differ in the shell
 * around them and where the claimed person lands.
 *
 * An `agent` is hierarchy level 5 and inherits no navigation at all
 * (`packages/contracts/src/rbac.ts`), so dropping them on the app shell gives
 * them a page with nothing on it.
 *
 * `/agency/login` alone is not enough either: an invited agent with no Google
 * account has nothing to click there, because it deliberately has no signup and
 * Firebase password-reset cannot mint a credential for a user that does not
 * exist. `/agency/join/:token` is that door, and the token is what makes it safe
 * to have one — the claim binds to the membership the token names, so no
 * sign-up on this path can create a tenant or orphan a membership.
 *
 * **Without a token an `agent` still gets `/agency/login`.** Not dead code: it is
 * what a caller with no token to offer must fall back to, and it is the strictly
 * safer of the two wrong answers — a page with no signup on it, rather than a
 * claim page with nothing to claim.
 *
 * ── Every other role's claim page lands them in the shell ──────────────────
 * A supervisor is `account_admin` or above and legitimately administers in
 * `/app` — team, settings — so `/join/:token` finishes there and they reach the
 * dialer from its nav entry. Supervisors are first-class AT the agency door and
 * it routes them correctly; the invite link is simply not where that is decided.
 *
 * It used to be the bare `/login`, and that was the defect: an invited operator
 * with no account met a sign-in page with no signup on it and a credential they
 * did not have — the dead end `/agency/join/:token` removed for agents, left in
 * place for everyone else. **Without a token they still get `/login`** — the
 * fallback for a caller with nothing to claim, as `/agency/login` is for an
 * agent.
 *
 * ── The console's copy of this rule is BEHIND, and that is fine ────────────
 * `inviteSignInUrl` in `apps/console/src/pages/team/TeamPage.tsx` is the same
 * rule computed from `window.location.origin`, and it cannot produce a join URL
 * at all — it has no token, which is a server fact minted per invite. What keeps
 * that from mattering is that **the console prefers the `sign_in_url` the server
 * returns over its own derivation**, so in any deployment with
 * `CONSOLE_BASE_URL` set this side is the only one that decides. The console's
 * copy is reached only when that variable is unset, and it then produces
 * `/agency/login` or `/login` — the same fallbacks this function produces
 * without a token. The two therefore agree in every reachable state.
 *
 * ── What does NOT catch a drift, despite looking like it should ────────────
 * The server and console suites assert the same literal strings, and that does
 * NOT make a divergence surface: the literals are hand-written in each app's
 * tests against that app's own source, so changing this function and updating
 * the server test leaves both suites green while the two copies disagree. There
 * is no shared fixture and no contract test across this seam; the safeguard is
 * this paragraph, not the test suites.
 *
 * Returns `null` when no base URL is configured, rather than guessing an origin.
 */
export async function inviteSignInUrl(
  role: MembershipRole,
  token?: string | null,
  baseUrl?: string,
): Promise<string | null> {
  // `baseUrl` short-circuits the lazy resolve, so a caller that already holds the
  // origin — and every test of the URL rule itself — never touches config at all.
  const origin = baseUrl ?? (await appConfig()).consoleBaseUrl;
  if (!origin) return null;
  // Trailing slashes are stripped so a `CONSOLE_BASE_URL` with one does not produce
  // `https://app.example.com//login`, which some routers 404 and others redirect.
  const trimmed = origin.replace(/\/+$/, '');
  const isAgent = role === 'agent';
  // `encodeURIComponent` even though `base64url` emits nothing that needs it: the
  // alphabet is a property of `invite-token.ts` and this function must not
  // silently depend on it. Change it there and this still emits a valid path.
  if (token) {
    return `${trimmed}${isAgent ? AGENCY_JOIN_PATH : WORKSPACE_JOIN_PATH}/${encodeURIComponent(token)}`;
  }
  return `${trimmed}${isAgent ? AGENCY_LOGIN_PATH : LOGIN_PATH}`;
}

/** The fallback expiry sentence when a caller passes no `expiresAt`. */
const FALLBACK_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Send the invite email.
 *
 * Total: never throws, whatever the input or the configuration. Callers put the
 * result on their response and carry on.
 */
export async function sendInviteEmail(input: SendInviteEmailInput): Promise<InviteEmailResult> {
  /**
   * No ROLE gate, and its absence is the fix rather than an omission.
   *
   * There used to be one here, ahead of the transport gate, answering
   * `not_implemented` for every non-`agent` role whatever the configuration. It
   * was the half of the defect production showed: invited operators and admins
   * were never mailed at all. Every role has a claim page and an invitation of
   * its own now, so the two guards below — a transport, and a link to put in it
   * — are the only reasons a mail does not leave, and they mean the same thing
   * for every role.
   */
  const config = await appConfig();

  if (!config.mailjet) {
    // `debug`, not `warn`: this is the configured-off state of an optional
    // subsystem, and warning on the expected path trains operators to ignore the
    // log.
    log.debug(
      { tenantId: input.tenantId, role: input.role },
      'Invite email skipped: no mailjet block configured',
    );
    return { sent: false, reason: 'not_configured' };
  }

  if (!input.signInUrl) {
    // Configured, but there is nothing to put in the mail. Reported as
    // `not_configured` rather than `failed` because the missing thing is a
    // setting (`CONSOLE_BASE_URL`), not a transport fault — and `failed` would
    // send an operator looking at the mail provider.
    log.warn(
      { tenantId: input.tenantId },
      'Invite email skipped: CONSOLE_BASE_URL is unset, so no sign-in link could be built',
    );
    return { sent: false, reason: 'not_configured' };
  }

  try {
    // The role picks the invitation and supplies its label — the dialer's for an
    // `agent`, the workspace's for everyone else (`templates/invite-email.ts`).
    const { subject, textBody, htmlBody } = renderInviteEmailForRole(input.role, {
      brandName: config.brand.name,
      accentColor: config.brand.accent,
      logoUrl: config.brand.logoUrl ?? null,
      joinUrl: input.signInUrl,
      email: input.email,
      // Falls back rather than refusing: a tenant name the route could not resolve
      // must not be the reason an invitee never receives their only way in.
      tenantName: input.tenantName?.trim() || 'your team',
      inviterName: input.inviterName?.trim() || null,
      // Same reasoning. The row's real `expires_at` is what the claim enforces;
      // this is only the sentence a recipient reads, and the default TTL is the
      // honest approximation when the caller did not pass the row's value.
      expiresAt: input.expiresAt ?? new Date(Date.now() + FALLBACK_TTL_MS),
    });

    /**
     * Dynamic, for the reason the config resolver above states: `mailjet.client.ts`
     * imports config STATICALLY, so a static import of it here would put
     * `process.exit(1)`-on-bad-config back into `user.routes.ts`'s import graph
     * through a module whose name gives no hint that it would.
     */
    const { sendEmail } = await import('./mailjet.client.js');
    const delivered = await sendEmail({
      to: [{ email: input.email }],
      subject,
      textBody,
      htmlBody,
    });

    if (!delivered) {
      // `sendEmail` reports a refusal, a non-2xx and its own 10s timeout all as
      // `false`, having logged the distinguishing detail itself. `failed` is the
      // honest verdict for all three: something at the transport went wrong, and
      // it is not the operator's configuration.
      log.warn(
        { tenantId: input.tenantId, role: input.role },
        'Invite email refused by the transport',
      );
      return { sent: false, reason: 'failed' };
    }

    // Never the invited address: `input.email` is personal data, and a typo'd
    // stranger's address is exactly the thing that would end up in a log line.
    log.info({ tenantId: input.tenantId, role: input.role }, 'Invite email sent');
    // See the `messageId` note on the result union — Mailjet's client reports a
    // boolean, so there is no id to carry today.
    return { sent: true, messageId: null };
  } catch (err) {
    // The transport is documented never to throw, and this catch is here anyway
    // for the same reason `POST /users/invite` wraps this whole function: the
    // rendering above CAN throw, and totality is a promise this module makes to a
    // route that has already written a membership. Structural beats trusting a
    // callee's word.
    log.error(
      { err, tenantId: input.tenantId, role: input.role },
      'Invite email threw; reported as failed',
    );
    return { sent: false, reason: 'failed' };
  }
}
