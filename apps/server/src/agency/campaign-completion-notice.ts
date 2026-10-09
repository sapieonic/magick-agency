import { createChildLogger } from '@magick-agency/observability';
import { agencyCampaignNotificationsTotal } from '@magick-agency/observability/metrics/platform';
import type { AgencyCampaignRecord } from '../db/models/agency.model.js';
import { sendAgencyCampaignCompletionEmail } from '../notifications/agency-campaign-completion.js';

const log = createChildLogger({ component: 'agency-campaign-completion-notice' });

/**
 * ─── THE CAMPAIGN-COMPLETION NOTICE, IN PROCESS ─────────────────────────────
 *
 * The pacing engine's leader wins the terminal transition in
 * `PacingEngine.maybeFinalize`, and inside that method's `if (updated)` block it
 * calls the notifier registered through `PacingEngine.registerCompletionNotifier`
 * (wired in `runtime.ts`). This is that notifier:
 *
 *  - the email call, awaited so the outcome is known;
 *  - `agencyCampaignNotificationsTotal` incremented with `sent` or the returned
 *    reason;
 *  - a `threw` arm, counted separately from the notifier's own `failed`, and never
 *    rethrown.
 *
 * The payload is built here from a campaign row, never parsed off a wire, so there
 * is no body validation, signature or HTTP response.
 *
 * ── The payload ──────────────────────────────────────────────────────────────
 *
 * `agency_campaigns.account_id` IS the account's UUID (`packages/db/BASELINE.md`,
 * "Every type change"), so the campaign row's value is the right one and is sent.
 *
 * Sent: the four required facts, the campaign name, `completed_at` (the row's
 * `ended_at`, which `transitionStatus` stamps from the target status) and
 * `contacts_total` (on the row). NOT sent: `contacts_completed`, `attempts`,
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
    // A send that told nobody has to be countable, or a revoked Mailjet key stops
    // every agency supervisor's notice with every dashboard green.
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
