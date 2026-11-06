import { formatPhone } from '@magick-agency/web-ui/format';
import { getErrorMessage } from '@magick-agency/web-ui/errors';
import {
  AGENCY_CALLER_ID_DEDICATED_CODE,
  type AgencyAgentCallerIdErrorCode,
} from '@magick-agency/contracts/api/agency/agent-caller-id';
import { errorBody, errorCode } from './agencyErrors';
import { joinAnd } from './agencyCampaignConfigForm';

/**
 * The words for dedicated caller IDs (decisions DN1–DN10): the Agents tab's
 * "Caller ID" control, the settings page's refusal to drop a dedicated number,
 * and the agent's line in My contacts.
 *
 * The refusal vocabulary is a `Record` over the contract's whole union, as
 * `ASSIGNMENT_REFUSAL_COPY` is, so a code added there without copy fails the
 * type check instead of reaching a supervisor as a wire token.
 */

/** What a staffed agent without a dedicated number dials from. */
export const SHARED_ROTATION_LABEL = 'Shared rotation';

/** DN3: every usable number is dedicated, so the rotation shares all of them. */
export const ALL_DEDICATED_WARNING =
  'Every caller ID is dedicated, so contacts without one share them.';

/**
 * A dedicated number that is no longer one of the campaign's caller IDs
 * (`in_campaign: false`): the dial path ignores it and uses the rotation.
 */
export const STALE_CALLER_ID_FLAG =
  'No longer one of this campaign’s caller IDs, so their calls use the shared rotation.';

/**
 * A refusal's `details` (`AgencyAgentCallerIdErrorResponse`, and the campaign
 * PATCH's `caller_id_dedicated`), or `null` when it carries none.
 */
function refusalDetails(err: unknown): Record<string, unknown> | null {
  const details = (errorBody(err) as { details?: unknown } | null)?.details;
  return details && typeof details === 'object' && !Array.isArray(details)
    ? (details as Record<string, unknown>)
    : null;
}

/** Refusals of the dedicated caller ID routes, in the console's words. */
export const AGENT_CALLER_ID_REFUSAL_COPY: Record<AgencyAgentCallerIdErrorCode, string> = {
  assignment_disabled: 'Contact assignment is turned off for this account.',
  caller_id_invalid: 'That isn’t a caller ID this campaign can use. Pick one from the list.',
  campaign_not_found: 'This campaign no longer exists, or isn’t in this account.',
  agent_not_staffed: 'This agent is no longer on this campaign. Refresh the list.',
  caller_id_not_in_campaign:
    'That number is no longer one of this campaign’s caller IDs. Refresh and pick another.',
  caller_id_taken: 'That number is already dedicated to another agent on this campaign.',
};

/**
 * A refusal of a set or clear, in the console's words: ours for a known code,
 * naming the holder of a taken number when the server says who; the server's
 * message otherwise.
 */
export function agentCallerIdRefusal(err: unknown, fallback: string): string {
  const code = errorCode(err);
  if (code === 'caller_id_taken') {
    const holder = refusalDetails(err)?.['agent_name'];
    if (typeof holder === 'string' && holder.trim().length > 0) {
      return `That number is already dedicated to ${holder.trim()}. Pick another, or clear theirs first.`;
    }
  }
  if (code && code in AGENT_CALLER_ID_REFUSAL_COPY) {
    return AGENT_CALLER_ID_REFUSAL_COPY[code as AgencyAgentCallerIdErrorCode];
  }
  return getErrorMessage(err, fallback);
}

/**
 * The numbers a campaign PATCH refused to drop (`409 caller_id_dedicated`,
 * `details.caller_ids`), or `null` when the error is anything else. An empty list
 * means the refusal named none.
 */
export function dedicatedCallerIdsOf(err: unknown): string[] | null {
  if (errorCode(err) !== AGENCY_CALLER_ID_DEDICATED_CODE) return null;
  const listed = refusalDetails(err)?.['caller_ids'];
  return Array.isArray(listed) ? listed.filter((n): n is string => typeof n === 'string') : [];
}

/** The settings page's answer to `409 caller_id_dedicated`, naming the numbers. */
export function callerIdDedicatedMessage(numbers: readonly string[]): string {
  if (numbers.length === 0) {
    return 'A number you removed is dedicated to an agent. Clear it on the Agents tab first.';
  }
  const named = joinAnd(numbers.map(formatPhone));
  return numbers.length === 1
    ? `${named} is dedicated to an agent. Clear it on the Agents tab first.`
    : `${named} are dedicated to agents. Clear them on the Agents tab first.`;
}

/**
 * The agent's line in My contacts when they have a dedicated number. Their
 * contacts, not all their calls: the number follows the contact's owner (DN2),
 * so pool contacts they take use the rotation and untagged soft-phone calls
 * never use it.
 */
export function myCallerIdLine(callerId: string): string {
  return `Calls to your contacts on this campaign go from ${formatPhone(callerId)}.`;
}
