import { config } from '../config/index.js';
import { sendEmail } from './mailjet.client.js';
import { escapeHtml } from './escape-html.js';
import { createChildLogger } from '@magick-agency/observability';
import { userRepository } from '@magick-agency/db/repositories/user.repository';
import { accountRepository } from '@magick-agency/db/repositories/account.repository';
import { ROLE_HIERARCHY, PERMISSION_MATRIX } from '@magick-agency/contracts/rbac';
import { mapWithConcurrency } from '../utils/concurrency.js';
import { notificationDeliveryRepository } from '../db/repositories/notification-delivery.repository.js';
import { buildDedupeKey } from './engine/deliver.js';
import type { MembershipRole } from '@magick-agency/db/models/membership.model';

const log = createChildLogger({ component: 'agency-campaign-completion-email' });

/**
 * The UUID shape, for the shape check in {@link isAccountUnaddressable}.
 */
export const AGENCY_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * "Your campaign finished" for the agency product.
 *
 * ── Who calls it ─────────────────────────────────────────────────────────────
 * The dialer runtime, in-process: when the pacing leader wins a campaign's
 * terminal transition (`PacingEngine.maybeFinalize`), it calls
 * `notifyAgencyCampaignFinished` (`agency/campaign-completion-notice.ts`), which
 * calls {@link sendAgencyCampaignCompletionEmail} and increments
 * `agencyCampaignNotificationsTotal` with the returned reason. The delivery claim
 * below is what makes a second call for the same campaign harmless.
 *
 * ── Where the link points ────────────────────────────────────────────────────
 * An agency campaign lives at `/agency/campaigns/:id`, inside the console's
 * `AgencyLayout`, with its attempts at `/agency/campaigns/:id/attempts/:attemptId`.
 * Mailing an agency supervisor a link into the `/app` shell instead would be a
 * link that crosses shells, which is a bug even when the data it lands on is
 * correct — and an email is the worst place for one, because a link in an inbox
 * outlives every redirect we would later add to cover for it.
 *
 * Three further properties, none of them cosmetic:
 *
 *  - **Recipients are resolved, not supplied.** A campaign carries no
 *    notification list (`agency_campaigns` has no such column), so the audience
 *    is derived from membership, at the floor that already decides who may
 *    supervise agency work. See {@link resolveCampaignNotificationRecipients}.
 *  - **The numbers are optional.** Everything past the campaign's identity and
 *    its terminal status is rendered only when the caller supplied it. A row
 *    that is absent is omitted rather than shown as 0 — "0 connected" is a
 *    claim about the campaign, and a wrong one.
 *  - **One send per recipient.** A derived audience must not become a disclosed
 *    one: a single `To:` would show every supervisor the account's admin
 *    roster. See the send below.
 *
 * ── Env-gated, silently, like every optional subsystem here ──────────────────
 * `config.mailjet` absent ⇒ this is a reported no-op (`src/config/schema.ts`
 * states the convention: an entire subsystem exists only when its env block
 * parses). It never throws: the campaign's terminal status is the dialer
 * runtime's record and this mail is an accelerant, the same relationship
 * `invite-mailer.ts` documents between a membership and its invite.
 */

/** A campaign's terminal status, as the pacing engine writes it. */
export type AgencyCampaignTerminalStatus = 'completed' | 'stopped';

/**
 * What a terminal status is called in an operator's inbox.
 *
 * `stopped` is a supervisor pressing Stop and `completed` is the roster running
 * out — a distinction the subject line has to keep, because the second is the
 * ordinary end of a run and the first is somebody's decision.
 */
const STATUS_LABELS: Record<AgencyCampaignTerminalStatus, string> = {
  completed: 'Completed',
  stopped: 'Stopped',
};

/**
 * The facts a completion notice is composed from.
 *
 * Only the first four are required — they are what the pacing leader knows for
 * certain at the moment it wins the transition. Everything else is enrichment the
 * caller may not have; see the module header on why an absent count is omitted
 * rather than defaulted.
 */
export interface AgencyCampaignCompletion {
  tenantId: string;
  /**
   * The campaign's account UUID (`agency_campaigns.account_id`). A value that
   * is present and does not resolve to an account of this tenant — misshapen,
   * stale or foreign alike — narrows the audience to tenant-level memberships and is reported as
   * `account_not_addressable` when that leaves nobody; absent is the ordinary
   * tenant-wide case and is not a fault. See the result union and
   * {@link isAccountUnaddressable}.
   */
  accountId?: string | null;
  campaignId: string;
  status: AgencyCampaignTerminalStatus;
  /** Falls back to a short id — a campaign may legitimately be unnamed. */
  campaignName?: string | null;
  /** ISO 8601. */
  completedAt?: string | null;
  contactsTotal?: number | null;
  contactsCompleted?: number | null;
  attempts?: number | null;
  connects?: number | null;
}

/**
 * What the caller learns, as a discriminated union so a reason cannot be
 * dropped — the same contract `invite-mailer.ts` uses, for the same reason: a
 * boolean would collapse "nobody configured mail" into "the send failed" and
 * send an operator to look at the wrong system.
 */
export type AgencyCampaignCompletionResult =
  /** `recipients` is how many addresses were DELIVERED to, not how many resolved. */
  | { sent: true; recipients: number }
  /** No `mailjet` block, so there is no transport. The default deployment. */
  | { sent: false; reason: 'not_configured' }
  /** Nobody in the tenant is allowed to hear about it, or nobody is left. */
  | { sent: false; reason: 'no_recipients' }
  /**
   * An `accountId` arrived that does not resolve to an account of this tenant,
   * so the audience narrowed to tenant-level memberships and found none.
   *
   * "Does not resolve" is checked against the `accounts` table, tenant-scoped —
   * not merely against the uuid shape. A well-formed but stale or foreign account
   * UUID is exactly as unaddressable as a misshapen one; a shape check alone
   * would let it fall through to the audience query's `account_id IS NULL` arm
   * and report a clean delivery.
   *
   * Split out of `no_recipients` because the two send an operator to different
   * places. On the ordinary multi-account tenant, whose supervisors are all
   * account-scoped `account_admin`s, an unresolvable account leaves nobody told.
   * Reported as `no_recipients` it reads as "this account has no supervisors",
   * which is a claim about the customer rather than about the input.
   */
  | { sent: false; reason: 'account_not_addressable' }
  /** The transport was attempted and refused or threw. Logged, never thrown. */
  | { sent: false; reason: 'failed' }
  /**
   * Every recipient was already claimed for this campaign, so the notice has
   * gone out and this call is a repeat for the same campaign. A success from the
   * product's point of view.
   */
  | { sent: false; reason: 'already_notified' }
  /**
   * The delivery ledger was unwritable, so nothing was sent rather than risking
   * duplicate mail. Means the database, not the mail provider.
   */
  | { sent: false; reason: 'claim_unavailable' };

/**
 * The role floor for hearing about a campaign, derived rather than restated.
 *
 * `agency.supervise` is already the answer to "who runs agency campaigns"
 * (`account_admin`, `packages/contracts/src/rbac.ts`), so reading the matrix keeps one
 * decision in one place: if the floor ever moves, the audience moves with it and
 * there is no second constant to remember.
 *
 * The consequence worth stating: an `agent` (level 5) is NOT notified. That is
 * the design and not an omission — an agent takes calls on a campaign and does
 * not own its outcome, and the way to serve an agent is an agency-native
 * surface, never a role level.
 */
const SUPERVISE_FLOOR = ROLE_HIERARCHY[PERMISSION_MATRIX['agency.supervise']];

function canSupervise(role: string): boolean {
  const level = ROLE_HIERARCHY[role as MembershipRole];
  return level !== undefined && level >= SUPERVISE_FLOOR;
}

/**
 * How many of the per-recipient sends may be in flight at once.
 *
 * The per-recipient decision below is a disclosure property and is not up for
 * revision — but it makes the number of Mailjet requests a function of the
 * tenant's admin roster, and `findAddressableMembersInAccount` has no `LIMIT`,
 * deliberately: a cap there would silently not tell somebody who is entitled to
 * be told, which is worse than being slow. So the roster stays whole and the
 * BURST is what gets bounded: uncapped, a tenant with a hundred
 * `account_admin`s would put a hundred simultaneous outbound requests on the
 * process at once.
 *
 * Kept small because nothing is blocked on this: no reader is waiting on the
 * result, so latency is worth trading for a smaller share of the connection pool.
 *
 * Note `mapWithConcurrency` rejects on the first task rejection and starts no
 * further tasks — which matters not at all here, because `sendEmail` reports a
 * refusal as `false` and never throws. So every send is attempted, and the count
 * that left is what gets reported.
 *
 * ── WIDTH is not the same bound as TIME ────────────────────────────────────
 *
 * This constant bounds the burst, not how long the whole fan-out takes.
 * `mailjet.client.ts` bounds each request (`MAILJET_TIMEOUT_MS`) — without it
 * every request would inherit undici's process-wide **300-second** default —
 * which makes the worst case `ceil(recipients / 6) × 10s`. The pacing leader does
 * not await the notice, but `PacingEngine.stop()` drains in-flight notices only
 * up to `COMPLETION_NOTICE_DRAIN_TIMEOUT_MS`, so a fan-out still running when
 * that bound expires is not waited for.
 *
 * ── What the per-request bound does NOT fix ────────────────────────────────
 *
 * A large roster needs many rounds, and a hundred supervisors is 17 of them. So
 * the honest statement is that this fan-out belongs in durable async work, and
 * the timeout is a bound rather than a fix.
 *
 * ── What moving it needs ───────────────────────────────────────────────────
 *
 * This server has no general job queue to move it into. Doing it properly is: a
 * durable outbox written on the finalize path that returns before any Mailjet
 * call; a consumer wired into `src/index.ts` behind its own config block (the
 * convention every optional subsystem here follows) or a Postgres-ledger
 * sweeper; and the outcome counter moving to the consumer, since
 * `agencyCampaignNotificationsTotal` is currently incremented by
 * `notifyAgencyCampaignFinished`, which would no longer know the outcome. That is
 * a migration, a consumer, and a metrics move — a piece of work, not a patch, and
 * half-built it would be strictly worse than the bounded send.
 */
const SEND_CONCURRENCY = 6;

/**
 * Who gets told, from membership alone.
 *
 * Exported because it is the half of this file with a product decision in it
 * and it is worth pinning on its own: the query returns everyone addressable in
 * the account and the floor is applied HERE, above the DB layer, where the RBAC
 * constants live.
 *
 * De-duplicated on the address, not on the person: one user can hold both an
 * account-scoped and a tenant-level membership, which is two rows and one inbox.
 */
export async function resolveCampaignNotificationRecipients(
  tenantId: string,
  accountId?: string | null,
): Promise<string[]> {
  const members = await userRepository.findAddressableMembersInAccount(tenantId, accountId);
  const addresses = new Set<string>();
  for (const member of members) {
    if (canSupervise(member.role)) addresses.add(member.email);
  }
  if (addresses.size === 0) return [];

  return suppressUnsubscribed(tenantId, [...addresses]);
}

/**
 * Drop the supervisors who have turned `agency.campaign.completed` off.
 *
 * ── Why this is a filter here rather than a rewrite onto the engine ────────
 *
 * The catalog lists this event so it appears on the settings page, and a toggle
 * that changes nothing is a promise the product does not keep. What it does NOT
 * need is this module's audience logic replaced: the floor derivation above, the
 * per-recipient send, the account-addressability reasoning and the discriminated
 * result type are all load-bearing and all tested. So the subscription is
 * applied at the one point where the audience becomes a list of addresses.
 *
 * ── Fails OPEN, and that is the opposite of the digest's rule ──────────────
 *
 * A lookup failure here sends to the whole derived audience. This notice tells a
 * supervisor that a campaign they are responsible for has finished or been
 * stopped — a database blip must not silently withhold it, and the recipients
 * were entitled to it by role before preferences existed at all. Contrast the
 * digest, where a failure means nobody is mailed: a digest is a convenience and
 * its absence costs a period, while this one carries operational news.
 *
 * Addresses are matched case-insensitively but returned in their ORIGINAL
 * spelling, because the caller passes them straight to the transport and the
 * existing suite asserts on the addresses it seeded.
 */
async function suppressUnsubscribed(tenantId: string, addresses: string[]): Promise<string[]> {
  try {
    const { notificationPreferenceRepository } = await import(
      '../db/repositories/notification-preference.repository.js'
    );
    const { applyExplicitAudiencePreferences } = await import('./engine/audience.js');

    const members = await notificationPreferenceRepository.findNotifiableMembers(tenantId);
    const stored = await notificationPreferenceRepository.findForUsersAndEvent(
      tenantId,
      'agency.campaign.completed',
      members.map((m) => m.user_id),
    );

    // `applyExplicitAudiencePreferences` is the right primitive despite this
    // being a role-derived audience: at this point the audience IS a list of
    // addresses, and its "send unless every user behind this inbox declined"
    // rule is exactly what a shared supervisor alias needs.
    const kept = new Set(
      applyExplicitAudiencePreferences('agency.campaign.completed', addresses, members, stored)
        .map((r) => r.email),
    );
    return addresses.filter((address) => kept.has(address.trim().toLowerCase()));
  } catch (err) {
    log.error(
      { err, tenantId },
      'Notification preference lookup failed; notifying every supervisor',
    );
    return addresses;
  }
}

/**
 * The rendered mail, as a pure function of the facts and the console's origin.
 *
 * Separated from the send so the DESTINATION is testable without a transport,
 * a database or a config block. The link is the thing this file exists to get
 * right, and a test that has to stand up Mailjet to read it is a test nobody
 * writes.
 *
 * `appBaseUrl` absent ⇒ the mail is still sent, WITHOUT a link. That differs
 * from `inviteSignInUrl`'s rule ("an invite whose only job is to carry a link,
 * without the link, is worse than no email") and the difference is the content:
 * a completion notice already carries its news in the subject line. The link
 * accelerates the follow-up; it is not the payload.
 */
export function renderAgencyCampaignCompletionEmail(
  completion: AgencyCampaignCompletion,
  appBaseUrl?: string,
): { subject: string; textBody: string; htmlBody: string } {
  const campaignName = completion.campaignName?.trim() || completion.campaignId.slice(0, 8);
  const statusLabel = STATUS_LABELS[completion.status];
  const completedAt = completion.completedAt
    ? new Date(completion.completedAt).toUTCString()
    : 'N/A';
  const campaignUrl = agencyCampaignUrl(completion.campaignId, appBaseUrl);

  const subject = `[Sapionic] Campaign "${campaignName}" — ${statusLabel}`;

  // Declared as rows so the text and HTML bodies cannot describe different
  // campaigns, and so an absent count drops out of both at once.
  const rows: Array<[string, string]> = [['Status', statusLabel]];
  if (completion.contactsTotal !== undefined && completion.contactsTotal !== null) {
    rows.push(['Contacts', String(completion.contactsTotal)]);
  }
  if (completion.contactsCompleted !== undefined && completion.contactsCompleted !== null) {
    rows.push(['Contacts Completed', String(completion.contactsCompleted)]);
  }
  if (completion.attempts !== undefined && completion.attempts !== null) {
    rows.push(['Dial Attempts', String(completion.attempts)]);
  }
  if (completion.connects !== undefined && completion.connects !== null) {
    rows.push(['Connected Calls', String(completion.connects)]);
  }
  rows.push(['Ended At', completedAt]);

  const textBody = [
    `Campaign: ${campaignName}`,
    ...rows.map(([label, value]) => `${label}: ${value}`),
    '',
    campaignUrl ? `View campaign: ${campaignUrl}` : '',
  ].join('\n');

  const htmlBody = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 560px; margin: 0 auto; padding: 24px;">
      <h2 style="margin: 0 0 16px; color: #1a1a2e;">Campaign "${escapeHtml(campaignName)}" — ${statusLabel}</h2>
      <table style="width: 100%; border-collapse: collapse; font-size: 14px;">
        ${rows.map(([label, value]) => `<tr><td style="padding: 8px 0; color: #666;">${escapeHtml(label)}</td><td style="padding: 8px 0; font-weight: 500;">${escapeHtml(value)}</td></tr>`).join('\n        ')}
      </table>
      ${campaignUrl ? `<p style="margin-top: 20px;"><a href="${campaignUrl}" style="color: #7c5cfc; text-decoration: none; font-weight: 500;">View campaign &rarr;</a></p>` : ''}
      <p style="margin-top: 24px; font-size: 12px; color: #999;">Sent by Sapionic</p>
    </div>
  `.trim();

  return { subject, textBody, htmlBody };
}

/**
 * The one link in this file, and the reason the file exists.
 *
 * `/agency/campaigns/:id` — inside the agency shell, which is where the campaign
 * and its attempts live. **Not** `/app/...`: see the module header. Trailing
 * slashes are trimmed for the same reason `inviteSignInUrl` trims them — a
 * `CONSOLE_BASE_URL` with one produces a double slash that some routers 404.
 *
 * Returns `null` with no configured origin rather than guessing one.
 */
export function agencyCampaignUrl(campaignId: string, appBaseUrl?: string): string | null {
  if (!appBaseUrl) return null;
  return `${appBaseUrl.replace(/\/+$/, '')}/agency/campaigns/${encodeURIComponent(campaignId)}`;
}

/**
 * Is this `accountId` one this server can actually address?
 *
 * `false` for an ABSENT account id — that is the ordinary tenant-wide case and
 * not a fault. `true` only for a value that was supplied and cannot be resolved
 * to a live account of this tenant, which is the condition
 * `account_not_addressable` exists to name.
 *
 * ── Shape first, then existence, and both are load-bearing ─────────────────
 *
 * The shape check is not an optimisation. `accounts.id` is a `uuid` column, so a
 * non-uuid value reaches Postgres as `22P02` and throws — which the caller's
 * `catch` would report as `failed`, destroying exactly the distinction this
 * function exists to make. So a malformed id is answered without a query.
 *
 * The EXISTENCE check is what the shape check alone cannot do: a well-formed but
 * stale or foreign account UUID passes the shape test, and
 * `findAddressableMembersInAccount` would then match its `account_id IS NULL` arm
 * and return the tenant-wide supervisors, so the run would report **sent** — a
 * notice about a campaign in an account that does not exist here, delivered to an
 * audience nobody selected. Uuid-shaped is not the same claim as resolvable, and
 * only the second one is what the audience query needs to be true.
 *
 * Scoped to the tenant (`findByIdInTenant`, not `findById`) because a real
 * account belonging to somebody else is exactly as unaddressable here as one that
 * does not exist, and answering otherwise would let a foreign id select an
 * audience.
 *
 * A database failure throws, and the caller turns that into `failed` — the same
 * verdict a failing audience lookup gets, which is right: the audience could
 * not be determined, and that is a fault rather than a fact about the input.
 */
async function isAccountUnaddressable(
  tenantId: string,
  accountId: string | null | undefined,
): Promise<boolean> {
  if (typeof accountId !== 'string' || accountId.length === 0) return false;
  if (!AGENCY_UUID_RE.test(accountId)) return true;
  return (await accountRepository.findByIdInTenant(accountId, tenantId)) === null;
}

/**
 * Send the notice. Total — every failure is a returned reason, never a throw.
 *
 * The caller is the pacing leader's finalize path, which has already committed
 * the campaign's terminal status; a rejection here would only be noise on that
 * path for the sake of an email.
 */
export async function sendAgencyCampaignCompletionEmail(
  completion: AgencyCampaignCompletion,
): Promise<AgencyCampaignCompletionResult> {
  if (!config.mailjet) {
    // `debug`, not `warn`: this is the configured-off state of an optional
    // subsystem, and warning on the expected path trains operators to ignore
    // the log.
    log.debug(
      { tenantId: completion.tenantId, campaignId: completion.campaignId },
      'Agency campaign completion email skipped: no mailjet block configured',
    );
    return { sent: false, reason: 'not_configured' };
  }

  try {
    // An `accountId` that is present and unresolvable is a DISTINGUISHABLE
    // condition, not a fact about the tenant's staffing, so it is measured before
    // the audience rather than inferred from an empty one. See
    // `account_not_addressable` on the result union for why the two are split.
    //
    // "Unresolvable" means the ACCOUNT DOES NOT EXIST in this tenant, not merely
    // that the id is misshapen — see {@link isAccountUnaddressable}. A shape check
    // alone would let a well-formed stale or foreign UUID through, and the audience
    // query would answer from its tenant-wide arm and report the run as `sent`.
    const accountUnresolvable = await isAccountUnaddressable(
      completion.tenantId,
      completion.accountId,
    );
    if (accountUnresolvable) {
      // `warn`, unlike the two `info`/`debug` arms below: this one says the
      // notifier was handed an id it could not use, which is a bug on the calling
      // side and not a configuration state. Account-scoped supervisors were NOT
      // considered, whatever the audience below turns out to be.
      log.warn(
        {
          tenantId: completion.tenantId,
          accountId: completion.accountId,
          campaignId: completion.campaignId,
        },
        'Agency campaign completion: account_id does not resolve to an account of '
          + 'this tenant; audience narrowed to tenant-level memberships only',
      );
    }

    const recipients = await resolveCampaignNotificationRecipients(
      completion.tenantId,
      completion.accountId,
    );
    if (recipients.length === 0) {
      const reason = accountUnresolvable ? 'account_not_addressable' : 'no_recipients';
      // Not an error. A tenant whose only members are agents lands here
      // legitimately — and the reason, plus this line, is how an operator tells
      // that apart from an unusable `account_id` and from a mail fault.
      log.info(
        {
          tenantId: completion.tenantId,
          accountId: completion.accountId ?? null,
          campaignId: completion.campaignId,
          reason,
        },
        reason === 'account_not_addressable'
          ? 'Agency campaign completion email skipped: account_id did not resolve and no '
            + 'tenant-level supervisor exists, so nobody was told'
          : 'Agency campaign completion email skipped: no addressable supervisor in this account',
      );
      return { sent: false, reason };
    }

    // ── The delivery claim, failing CLOSED ───────────────────────────────
    //
    // Keyed on the CAMPAIGN, so every path that can report one campaign
    // terminal resolves to the same key and only the first one sends.
    //
    // This is the CLAIM only, not a rewrite onto the notification engine's
    // dispatch. The per-recipient send stays as it is (it is a disclosure
    // decision: a shared `To:` would show every supervisor the account's admin
    // roster), as do the partial-delivery semantics and the result union. An
    // outbox and a consumer remain the proper way to move this off the finalize
    // path (see {@link SEND_CONCURRENCY}); they are not a prerequisite for
    // idempotency.
    //
    // FAILS CLOSED, and note this is the opposite of `suppressUnsubscribed`
    // above. A preference lookup is a refinement of an audience the recipients
    // already qualified for by role, so losing it must not withhold operational news — but without the claim there
    // IS no idempotency, and sending anyway is how a repeat call becomes
    // duplicate mail. A missed notice is recoverable, since the campaign page
    // carries the same facts; a duplicate blast cannot be un-sent.
    let claims: Array<{ id: string; recipient: string }>;
    try {
      claims = await notificationDeliveryRepository.claim({
        eventKey: 'agency.campaign.completed',
        tenantId: completion.tenantId,
        accountId: completion.accountId ?? null,
        dedupeKey: buildDedupeKey('campaign', completion.campaignId),
        recipients: recipients.map((address) => address.trim().toLowerCase()),
      });
    } catch (err) {
      log.error(
        { err, tenantId: completion.tenantId, campaignId: completion.campaignId },
        'Agency campaign completion: delivery claim failed; withholding the notice '
          + 'rather than risking a duplicate',
      );
      return { sent: false, reason: 'claim_unavailable' };
    }

    if (claims.length === 0) {
      // Not an error: a repeat call for a campaign already notified is the case
      // this ledger exists for.
      log.info(
        { tenantId: completion.tenantId, campaignId: completion.campaignId },
        'Agency campaign completion email skipped: already claimed for every recipient',
      );
      return { sent: false, reason: 'already_notified' };
    }

    // Addresses are claimed lower-cased (the ledger's dedupe key is an inbox,
    // and `Alice@x.com` and `alice@x.com` are one). The send uses the ORIGINAL
    // spelling the audience resolved, which the existing suite asserts on.
    const byLowered = new Map(recipients.map((address) => [address.trim().toLowerCase(), address]));
    const claimedRecipients = claims.map((claim) => ({
      id: claim.id,
      address: byLowered.get(claim.recipient) ?? claim.recipient,
    }));

    const { subject, textBody, htmlBody } = renderAgencyCampaignCompletionEmail(
      completion,
      // The console's origin (`CONSOLE_BASE_URL`).
      config.consoleBaseUrl,
    );

    // ── One send PER recipient, not one send with everyone in `To:` ───────────
    // The list is DERIVED from `memberships`, so a single `To:` would disclose
    // the account's admin roster to every supervisor on it, including addresses
    // the reader has no other way to see.
    //
    // Per-recipient rather than BCC because `mailjet.client.ts` has no Bcc field
    // and adding one would touch the transport every other mailer shares for the
    // sake of one caller. A per-recipient send also isolates a bad address: one
    // refusal costs that inbox, not the whole notice.
    //
    // `sendEmail` reports rather than throws, so a `false` is a refused send and
    // not an exception path — both still have to reach the caller, which is why
    // each result is read instead of ignored.
    //
    // Bounded, not `Promise.all`: one send per recipient is a decision about
    // DISCLOSURE, and taking it uncapped would turn the roster's size into the
    // burst size. See {@link SEND_CONCURRENCY}. Result order matches
    // `claimedRecipients`, so the counting below holds.
    //
    // Iterating the CLAIMED rows rather than `recipients`, so an address already
    // notified by an earlier call for this campaign is not mailed again while
    // its colleagues still are.
    const delivered = await mapWithConcurrency(
      claimedRecipients,
      SEND_CONCURRENCY,
      async ({ id, address }) => {
        const ok = await sendEmail({ to: [{ email: address }], subject, textBody, htmlBody });
        // Per recipient, because this mailer sends per recipient and therefore
        // HAS a per-recipient answer to record. Never
        // awaited into the result: the mail has already gone, and a row left
        // `pending` honestly says "claimed, outcome unknown".
        await notificationDeliveryRepository
          .recordOutcome(id, ok ? 'sent' : 'failed', ok ? null : 'transport reported failure')
          .catch((err) => {
            log.error(
              { err, deliveryId: id, campaignId: completion.campaignId },
              'Failed to record agency campaign completion delivery outcome',
            );
          });
        return ok;
      },
    );
    const sentCount = delivered.filter(Boolean).length;
    // Nothing got out at all ⇒ `failed`. A PARTIAL delivery is reported as sent with the count that
    // actually left, because the alternative — calling it `failed` — would tell an
    // operator nobody was notified while supervisors are reading the mail.
    //
    // The claims are NOT released on a total failure: `sendEmail` collapses
    // timeout and error into one `false`, so a failure here does not prove the
    // message was never accepted, and re-sending on a repeat call is the
    // duplicate this ledger exists to prevent.
    if (sentCount === 0) return { sent: false, reason: 'failed' };
    if (sentCount < claimedRecipients.length) {
      log.warn(
        {
          tenantId: completion.tenantId,
          campaignId: completion.campaignId,
          resolved: recipients.length,
          claimed: claimedRecipients.length,
          delivered: sentCount,
        },
        'Agency campaign completion email partially delivered',
      );
    }

    return { sent: true, recipients: sentCount };
  } catch (err) {
    log.error(
      { err, tenantId: completion.tenantId, campaignId: completion.campaignId },
      'Failed to send agency campaign completion email',
    );
    return { sent: false, reason: 'failed' };
  }
}
