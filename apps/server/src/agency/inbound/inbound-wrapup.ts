import { AGENCY_INBOUND_OUTCOME_LAPSE_MS } from '@magick-agency/contracts/agency';
import type { AgencyCampaignRecord } from '../../db/models/agency.model.js';

/**
 * ─── HOW LONG AN ANSWERED INBOUND CALL'S OUTCOME WAITS (docs/inbound.md §6) ───────────────
 *
 * An inbound call's wrap-up follows the outbound wrap-up's auto-return rule (`wrapup-manager.ts`)
 * for the call's matched campaign: with `wrapup_auto_return` on and a `wrapup_seconds` window,
 * the outcome lapses `wrapup_seconds` after the call ended (`no_disposition`, as the reaper closes
 * an outbound wrap-up's attempt after its window) and the agent is returned; with auto-return off,
 * or `wrapup_seconds = 0` ("no timer"), the agent stays until they save it. A caller who matched
 * no campaign takes the account default, which is the default every new campaign of the account
 * starts with ({@link INBOUND_DEFAULT_WRAPUP}: there is no account-level wrap-up setting).
 * {@link AGENCY_INBOUND_OUTCOME_LAPSE_MS} (30 minutes) stays as the backstop: no outcome waits
 * longer, whatever the campaign says.
 *
 * One rule, read in two places that must agree: the panel's `outcome_due_at`
 * (`inbound-call-wire.ts`) and the lapse sweep's SQL (`agencyInboundCallRepository.lapseUnsettled`,
 * which is passed {@link INBOUND_DEFAULT_WRAPUP} and the backstop).
 */

/** The auto-return rule of an inbound call's wrap-up: the outbound wrap-up's two campaign settings. */
export interface InboundWrapupRule {
  wrapupSeconds: number;
  autoReturn: boolean;
}

/**
 * The account default (no campaign matched): the column defaults of `agency_campaigns`
 * (`wrapup_seconds` 30, `wrapup_auto_return` true), pinned to them by an integration test.
 */
export const INBOUND_DEFAULT_WRAPUP: Readonly<InboundWrapupRule> = Object.freeze({ wrapupSeconds: 30, autoReturn: true });

/** The rule for a call matched to `campaign` (null: unmatched, or the campaign row is gone). */
export function inboundWrapupRule(
  campaign: Pick<AgencyCampaignRecord, 'wrapup_seconds' | 'wrapup_auto_return'> | null,
): InboundWrapupRule {
  if (!campaign) return { ...INBOUND_DEFAULT_WRAPUP };
  return { wrapupSeconds: campaign.wrapup_seconds, autoReturn: campaign.wrapup_auto_return };
}

/** How long after the call ended its outcome lapses, in ms: the auto-return window, never past the backstop. */
export function inboundOutcomeWindowMs(rule: InboundWrapupRule, backstopMs: number = AGENCY_INBOUND_OUTCOME_LAPSE_MS): number {
  if (!rule.autoReturn || !(rule.wrapupSeconds > 0)) return backstopMs;
  return Math.min(rule.wrapupSeconds * 1000, backstopMs);
}
