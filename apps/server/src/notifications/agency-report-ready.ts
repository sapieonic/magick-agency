import { createChildLogger } from '@magick-agency/observability';
import { agencyReportsEmailsTotal } from '@magick-agency/observability/metrics/agency';
import { userRepository } from '@magick-agency/db/repositories/user.repository';
import type { Permission } from '@magick-agency/contracts/rbac';
import { config } from '../config/index.js';
import { sendEmail } from './mailjet.client.js';
import { buildDedupeKey } from './engine/deliver.js';
import { findNotificationEvent } from './engine/catalog.js';
import { renderReportReadyEmail } from './templates/agency-report-ready.template.js';
import { notificationDeliveryRepository } from '../db/repositories/notification-delivery.repository.js';
import { notificationPreferenceRepository } from '../db/repositories/notification-preference.repository.js';
import { reportSubscriptionRepository } from '../db/repositories/agency.repository.js';
import type { ReportRunRecord } from '../db/repositories/agency.repository.js';
import { usersWithPermissionOnAccount } from '../agency/reports/access.js';
import { reportSubjectName, resolveReportNames, runNameRef } from '../agency/reports/run-view.js';
import { mapWithConcurrency } from '../utils/concurrency.js';

const log = createChildLogger({ component: 'agency-report-ready-email' });

/**
 * "Your report is ready" (`agency.report.ready`, docs/reports.md RP4, RP6, RP16), sent by the
 * reports tick once per finished run (`markNotified` first: only the tick that marked the run
 * sends).
 *
 * ── Who gets it ──────────────────────────────────────────────────────────────
 *  - **an ad hoc run**: its requester, only when the request set `email_me` (RP16), and only while
 *    they still hold an active membership reaching the run's account;
 *  - **a subscription's run**: the subscription's recipients as they are NOW, each re-checked
 *    against RBAC at send time (RP4: a member with `agency.supervise` on the account). A recipient
 *    who lost that access is skipped and counted (`agency_reports_emails_total{result="skipped"}`),
 *    as is everyone when the subscription has been deleted since.
 * Then each user's own preference for the event (default on). One send per recipient, so no
 * recipient sees another's address.
 *
 * ── Once ─────────────────────────────────────────────────────────────────────
 * The delivery ledger is claimed per run and recipient (`report:<run id>`, one row per inbox)
 * before any send, failing CLOSED as the campaign-completion notice does: a missed email is
 * recoverable (the console shows the run), a duplicate is not.
 *
 * Total: never throws; every outcome is counted per recipient (`sent`, `skipped`, `failed`).
 */

export const REPORT_READY_EVENT = 'agency.report.ready' as const;

/** Per-recipient outcome counts of one run's notification. */
export interface ReportEmailCounts {
  sent: number;
  skipped: number;
  failed: number;
}

export interface ReportReadyEmailOptions {
  retentionDays: number;
}

const SEND_CONCURRENCY = 6;

function count(counts: ReportEmailCounts, result: keyof ReportEmailCounts, n = 1): void {
  if (n <= 0) return;
  counts[result] += n;
  agencyReportsEmailsTotal.inc({ result }, n);
}

/** The users this run's email is for, after the access re-check; the rest are counted skipped. */
async function eligibleRecipients(run: ReportRunRecord, counts: ReportEmailCounts): Promise<string[]> {
  if (run.account_id === null) return [];
  let candidates: string[];
  let permission: Permission;
  if (run.subscription_id !== null) {
    const subscription = await reportSubscriptionRepository.findById(run.tenant_id, run.subscription_id);
    if (!subscription) {
      count(counts, 'skipped');
      return [];
    }
    candidates = [...new Set(subscription.recipient_user_ids)];
    permission = 'agency.supervise';
  } else {
    if (!run.email_me || run.requested_by === null) return [];
    candidates = [run.requested_by];
    permission = 'agency.station.connect';
  }
  const allowed = await usersWithPermissionOnAccount(candidates, run.tenant_id, run.account_id, permission);
  const kept = candidates.filter((id) => allowed.has(id));
  if (kept.length < candidates.length) {
    log.info({ runId: run.id, dropped: candidates.length - kept.length }, 'Report email recipients without access skipped');
  }
  count(counts, 'skipped', candidates.length - kept.length);
  return kept;
}

/** Drop the users who turned the event off. A lookup failure keeps everyone (fails open). */
async function keepSubscribed(run: ReportRunRecord, userIds: string[]): Promise<string[]> {
  try {
    const event = findNotificationEvent(REPORT_READY_EVENT);
    const stored = await notificationPreferenceRepository.findForUsersAndEvent(run.tenant_id, REPORT_READY_EVENT, userIds);
    const byUser = new Map(stored.map((row) => [row.user_id, row.enabled]));
    return userIds.filter((id) => byUser.get(id) ?? event?.defaultEnabled ?? true);
  } catch (err) {
    log.error({ err, runId: run.id }, 'Report email preference lookup failed; emailing every eligible recipient');
    return userIds;
  }
}

export async function sendAgencyReportReadyEmails(
  run: ReportRunRecord,
  options: ReportReadyEmailOptions,
): Promise<ReportEmailCounts> {
  const counts: ReportEmailCounts = { sent: 0, skipped: 0, failed: 0 };
  if (run.status !== 'ready' && run.status !== 'failed') return counts;
  try {
    const eligible = await eligibleRecipients(run, counts);
    if (eligible.length === 0) return counts;
    if (!config.mailjet) {
      log.debug({ runId: run.id }, 'Report email skipped: no mailjet block configured');
      count(counts, 'skipped', eligible.length);
      return counts;
    }
    const wanted = await keepSubscribed(run, eligible);
    count(counts, 'skipped', eligible.length - wanted.length);
    if (wanted.length === 0) return counts;

    const identities = await userRepository.findIdentitiesInTenant(wanted, run.tenant_id);
    const emailByUser = new Map<string, string>();
    for (const row of identities) if (!emailByUser.has(row.id) && row.email) emailByUser.set(row.id, row.email);
    count(counts, 'skipped', wanted.filter((id) => !emailByUser.has(id)).length);
    const addresses = [...new Set([...emailByUser.values()])];
    if (addresses.length === 0) return counts;

    let claims: Array<{ id: string; recipient: string }>;
    try {
      claims = await notificationDeliveryRepository.claim({
        eventKey: REPORT_READY_EVENT,
        tenantId: run.tenant_id,
        accountId: run.account_id,
        dedupeKey: buildDedupeKey('report', run.id),
        recipients: addresses.map((a) => a.trim().toLowerCase()),
      });
    } catch (err) {
      log.error({ err, runId: run.id }, 'Report email delivery claim failed; withholding rather than risking a duplicate');
      count(counts, 'failed', addresses.length);
      return counts;
    }
    count(counts, 'skipped', addresses.length - claims.length);
    if (claims.length === 0) return counts;

    const names = await resolveReportNames(run.tenant_id, [runNameRef(run)]);
    const rendered = renderReportReadyEmail({
      tenantId: run.tenant_id,
      accountId: run.account_id,
      runId: run.id,
      kind: run.kind,
      subjectName: reportSubjectName(names, run.kind, run.subject_id),
      from: run.local_from,
      to: run.local_to,
      timezone: run.timezone,
      outcome: run.status === 'ready' ? 'ready' : 'failed',
      truncated: run.truncated,
      scheduled: run.subscription_id !== null,
      retentionDays: options.retentionDays,
      brandName: config.brand.name,
      brandAccent: config.brand.accent,
    }, config.consoleBaseUrl);

    const byLowered = new Map(addresses.map((a) => [a.trim().toLowerCase(), a]));
    const results = await mapWithConcurrency(claims, SEND_CONCURRENCY, async (claim) => {
      const ok = await sendEmail({
        to: [{ email: byLowered.get(claim.recipient) ?? claim.recipient }],
        subject: rendered.subject,
        textBody: rendered.textBody,
        htmlBody: rendered.htmlBody,
      });
      await notificationDeliveryRepository
        .recordOutcome(claim.id, ok ? 'sent' : 'failed', ok ? null : 'transport reported failure')
        .catch((err: unknown) => log.error({ err, deliveryId: claim.id, runId: run.id }, 'Report email outcome not recorded'));
      return ok;
    });
    const sent = results.filter(Boolean).length;
    count(counts, 'sent', sent);
    count(counts, 'failed', results.length - sent);
    return counts;
  } catch (err) {
    log.error({ err, runId: run.id }, 'Report email failed');
    count(counts, 'failed');
    return counts;
  }
}
