/**
 * `buildDedupeKey`: `agency-campaign-completion.ts` keys its delivery claim with
 * it. The agency completion notice does its own bounded per-recipient send.
 */

/**
 * The identity a delivery is deduplicated on, within `(event_key, tenant_id)`.
 *
 * Free-form by design — each event decides what "the same notification" means.
 * The campaign-completion notice uses `campaign:<campaignId>`, because a second
 * call for one campaign is the same notification about the same campaign.
 *
 * Two properties the key MUST have, and neither is enforceable here:
 * it must be stable across repeats of one logical event, and it must differ
 * between two events a recipient should genuinely receive both of.
 */
export function buildDedupeKey(...parts: Array<string | number>): string {
  return parts.map((p) => String(p)).join(':');
}
