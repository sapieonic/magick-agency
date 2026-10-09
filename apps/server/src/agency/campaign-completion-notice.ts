import { createChildLogger } from '@magick-agency/observability';
import { agencyCampaignNotificationsTotal } from '@magick-agency/observability/metrics/platform';
import type { AgencyCampaignRecord } from '../db/models/agency.model.js';
import { sendAgencyCampaignCompletionEmail } from '../notifications/agency-campaign-completion.js';

const log = createChildLogger({ component: 'agency-campaign-completion-notice' });

/**
 * ─── THE CAMPAIGN-COMPLETION NOTICE, IN PROCESS (E10) ───────────────────────
 *
 * PORT NOTE (magick-agency): a hop collapse with no core half. Master's receiving
 * handler is `POST /webhooks/core/agency-campaign-completed`
 * (`magick-master/src/api/routes/webhook-core.routes.ts:1058-1215` @a1f0756a), and its
 * own doc says **nothing posts there**: core's pacing engine wins the terminal
 * transition in `PacingEngine.maybeFinalize` and "what core has to add is one
 * dispatcher call inside that method's `if (updated)` block". In one process that
 * call is `PacingEngine.registerCompletionNotifier`, and this is the handler body it
 * reaches — master's, minus the transport:
 *
 *  - **Kept:** the notifier call with the same fields, awaited so the outcome is
 *    known; `agencyCampaignNotificationsTotal` incremented with `sent` or the
 *    returned reason; the `threw` arm, counted separately from the notifier's own
 *    `failed`, and never rethrown.
 *  - **Gone:** HMAC, body validation (`agencyCampaignCompletedSchema`: the payload is
 *    built here from a campaign row, never parsed off a wire), the HTTP response, the
 *    `webhook_requests_total` / `webhook_processing_duration_seconds` series (they
 *    describe a webhook, and there is none), the span.
 *
 * ── The payload ──────────────────────────────────────────────────────────────
 *
 * Master's warning that `account_id` "must be MASTER'S account UUID, not
 * `campaign.account_id`" was about core's column, whose default was the literal
 * `'default'`. Here `agency_campaigns.account_id` IS the account's UUID (BASELINE.md,
 * "Every type change"), so the campaign row's value is the right one and is sent.
 *
 * Sent: the four required facts, the campaign name, `completed_at` (the row's
 * `ended_at`, which `transitionStatus` stamps from the target status since migration
 * 108) and `contacts_total` (on the row). NOT sent: `contacts_completed`, `attempts`,
 * `connects` — they would need three more reads on the leader's finalize path, and the
 * notifier's contract is that "an absent count is omitted rather than defaulted",
 * because "0 connected" would be a claim about the campaign and a wrong one.
 */
export async function notifyAgencyCampaignFinished(
  campaign: AgencyCampaignRecord,
  status: 'completed' | 'stopped',
): Promise<void> {
  try {
    const result = await sendAgencyCampaignCompletionEmail({
      tenantId: campaign.tenant_id,
      accountId: campaign.account_id,
      campaignId: campaign.id,
      status,
      campaignName: campaign.name,
      completedAt: campaign.ended_at ? campaign.ended_at.toISOString() : null,
      contactsTotal: campaign.contacts_total,
    });
    // Master: "a 2xx that told nobody has to be countable, or a revoked Mailjet key
    // stops every agency supervisor's notice with every dashboard green."
    const notificationResult = result.sent ? 'sent' : result.reason;
    agencyCampaignNotificationsTotal.inc({ tenant_id: campaign.tenant_id, result: notificationResult });
    log.info(
      { campaignId: campaign.id, tenantId: campaign.tenant_id, status, notified: result.sent,
        ...(result.sent ? { recipients: result.recipients } : { reason: result.reason }) },
      'Agency campaign completion notice handled',
    );
  } catch (err) {
    // The notifier is total, so this is reached only if something OUTSIDE it throws.
    // Labelled `threw` so it is not folded into the notifier's own `failed`.
    agencyCampaignNotificationsTotal.inc({ tenant_id: campaign.tenant_id, result: 'threw' });
    log.error({ err, campaignId: campaign.id }, 'Agency campaign completion notification threw');
  }
}
