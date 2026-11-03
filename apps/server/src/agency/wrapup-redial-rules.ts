/**
 * Wrap-up redial: the pure rules (no I/O). Who may redial from a wrap-up, and how many
 * redials are left. The flow that acts on them is `wrapup-redial.ts`; the dialer reads
 * {@link wrapupRedialRemaining} when it opens a wrap-up.
 */
import {
  AGENCY_WRAPUP_REDIAL_LIMIT,
  type AgencyActionErrorCode,
} from '@magick-agency/contracts/agency';
import type { AgencyCallAttemptRecord, AgencyCampaignRecord } from '../db/models/agency.model.js';

/**
 * Redials left from a wrap-up, or null when redial is not offered there: the campaign
 * does not allow it, or no outcome is owed (a campaign with an empty disposition catalog
 * releases the customer when the call ends, so there is no one held to redial).
 *
 * `redialNumber` is the wrapped-up attempt's place in its chain: 0 for a paced dial, 1
 * and 2 for redials. The limit counts redials per ORIGINAL call, so the second redial's
 * wrap-up offers none.
 */
export function wrapupRedialRemaining(
  campaign: Pick<AgencyCampaignRecord, 'allow_wrapup_redial'>,
  outcomeOwed: boolean,
  redialNumber: number,
): number | null {
  if (!campaign.allow_wrapup_redial || !outcomeOwed) return null;
  return Math.max(0, AGENCY_WRAPUP_REDIAL_LIMIT - redialNumber);
}

/** A refusal: the action error code and the sentence the agent sees. */
export interface RedialRefusal {
  code: AgencyActionErrorCode;
  message: string;
}

export const REDIAL_MESSAGES = {
  campaign_off: 'Redial is not turned on for this campaign. Save the outcome.',
  campaign_not_running: 'The campaign is not running, so the customer cannot be redialled. Save the outcome.',
  not_your_call: 'This call is not yours to redial.',
  not_in_wrapup: 'You are not in wrap-up for this call any more.',
  not_redialable: 'Only a call that connected can be redialled. Save the outcome.',
  not_held: 'This customer is no longer held for your outcome, so they cannot be redialled.',
  limit: `You have already redialled this customer ${AGENCY_WRAPUP_REDIAL_LIMIT} times. Save the outcome.`,
  disposition_submitted: 'The outcome for this call is already saved.',
  dnc: 'This number is on a do-not-call list, so it cannot be redialled. Save the outcome.',
  calling_hours: "It is outside this customer's calling hours, so they cannot be redialled now. Save the outcome.",
  phone_invalid: 'This number is not a valid phone number, so it cannot be redialled. Save the outcome.',
  dnc_unavailable: 'The do-not-call list cannot be checked right now, so the customer cannot be redialled. Try again, or save the outcome.',
  no_caller_id: 'This campaign has no caller ID to dial from. Save the outcome.',
  no_station: 'Your station is not connected, so the customer cannot be redialled.',
} as const;

/**
 * The checks on the wrapped-up attempt and its campaign that need nothing live (no
 * wrap-up entry, no Redis, no gates), in the order the agent is told about them. Null:
 * the attempt may be redialled as far as its row and its campaign can say.
 *
 * - the campaign allows it and is running (a paused or stopped campaign places no calls);
 * - the attempt is this session's, ended, and still owes its write-up;
 * - it is a call that connected (bridged), or itself a redial (which owes the
 *   conversation's outcome whatever its own);
 * - the limit is not used up.
 */
export function redialRefusalForAttempt(
  attempt: Pick<AgencyCallAttemptRecord, 'reserved_agent_id' | 'state' | 'disposition_code' | 'bridged_at' | 'redial_number'>,
  campaign: Pick<AgencyCampaignRecord, 'allow_wrapup_redial' | 'status'>,
  sessionId: string,
): RedialRefusal | null {
  if (attempt.reserved_agent_id !== sessionId) return { code: 'redial_not_allowed', message: REDIAL_MESSAGES.not_your_call };
  if (!campaign.allow_wrapup_redial) return { code: 'redial_not_allowed', message: REDIAL_MESSAGES.campaign_off };
  if (attempt.disposition_code !== null) {
    return { code: 'disposition_already_submitted', message: REDIAL_MESSAGES.disposition_submitted };
  }
  if (attempt.state !== 'ended') return { code: 'redial_not_allowed', message: REDIAL_MESSAGES.not_in_wrapup };
  if (attempt.bridged_at === null && attempt.redial_number === 0) {
    return { code: 'redial_not_allowed', message: REDIAL_MESSAGES.not_redialable };
  }
  if (attempt.redial_number >= AGENCY_WRAPUP_REDIAL_LIMIT) {
    return { code: 'redial_limit_reached', message: REDIAL_MESSAGES.limit };
  }
  if (campaign.status !== 'running') return { code: 'redial_not_allowed', message: REDIAL_MESSAGES.campaign_not_running };
  return null;
}
