/**
 * PORT NOTE (magick-agency): trimmed to `buildDedupeKey`, the one export a ported
 * module reaches (`agency-campaign-completion.ts` keys its delivery claim with
 * it). Deleted, because only the credits usage-digest runner
 * (`digest/run-digests.ts`, not ported — plan §3.3, §3.5) reached them:
 * `dispatchNotification` and its `NotificationDispatchInput` /
 * `NotificationDispatchResult` / `EMPTY_RESULT`, the process-wide
 * `sendSemaphore` + `SEND_CONCURRENCY`, `outcomeStatus`, `outcomeDetail`,
 * `countSends`, and `scopeToken` (master `deliver.ts:1-59`, `78-262`). With them
 * went the imports of `config`, the delivery repository, `sendEmailWithOutcome`,
 * `notificationSendsTotal`, `createSemaphore`, the logger, `RenderedEmail` and
 * `NotificationDeliveryStatus`. The agency completion notice keeps its own
 * bounded per-recipient send, exactly as in master.
 */

/**
 * The identity a delivery is deduplicated on, within `(event_key, tenant_id)`.
 *
 * Free-form by design — each event decides what "the same notification" means.
 * A digest uses `<frequency>:<periodStart>:<scope>`, so every tick inside one
 * period resolves to the same key and only the first sends. A campaign mail uses
 * the job id, because core redelivers webhooks and a redelivery is the same
 * notification about the same campaign.
 *
 * Two properties the key MUST have, and neither is enforceable here:
 * it must be stable across redeliveries of one logical event, and it must differ
 * between two events a recipient should genuinely receive both of.
 */
export function buildDedupeKey(...parts: Array<string | number>): string {
  return parts.map((p) => String(p)).join(':');
}
