import { AGENCY_OVERRIDE_NOTE_MAX, AGENCY_OVERRIDE_NOTE_MIN } from '@magick-agency/contracts/agency';
import type {
  AgencyContactOverride,
  AgencyMyContact,
  AgencyAgentRetryBlock,
  AgencyAgentRetryErrorCode,
  AgencyMyContactBucket,
} from '@magick-agency/contracts/api/agency/assignment';
import type { AgencyAgentState } from '../types/agency';
import { errorCode } from './agencyErrors';
import { formatSpineTimestamp } from './agencySpineCopy';
import { plural } from './format/number';

/**
 * The agent's own contacts: refusal copy for every code their routes answer,
 * why a contact cannot be retried, and the rules that decide whether "Call" and
 * "Retry not reached" are offered.
 *
 * `Record`s over the whole unions (like `softphone/refusalCopy.ts`), so a code
 * added to the contract without copy fails the type check rather than reaching
 * an agent as the server's raw sentence.
 */

export const AGENT_RETRY_REFUSAL_COPY: Record<AgencyAgentRetryErrorCode, string> = {
  assignment_disabled: 'My contacts is turned off for this account. Ask your supervisor.',
  not_staffed: 'You’re no longer on this campaign. Ask your supervisor to add you back.',
  agent_retry_disabled: 'This campaign doesn’t let agents retry their own contacts.',
  contact_not_found: 'That contact isn’t yours any more — it may have been reassigned. Refresh the list.',
  contact_not_retryable: 'That contact can’t be called or retried right now.',
  contact_in_flight: 'This customer is already on a call. Wait for it to finish.',
  campaign_not_running: 'The campaign isn’t running, so nothing can be dialled.',
  agent_not_available: 'Go available first — calls are placed only while you’re waiting for one.',
  outside_calling_hours: 'The campaign is outside its calling hours.',
  override_note_invalid: `The note needs ${AGENCY_OVERRIDE_NOTE_MIN} to ${AGENCY_OVERRIDE_NOTE_MAX} characters.`,
  dnc_listed: 'This number is on the Do Not Call list. It can’t be called.',
  dnc_unavailable:
    'We couldn’t check the Do Not Call list just now, so nothing was dialled. Try again in a moment.',
  no_caller_id: 'The campaign has no caller ID to dial from. Tell your supervisor.',
  no_station: 'Your station isn’t connected. Wait for it to reconnect, then try again.',
  dial_failed: 'The call couldn’t be placed. The contact is still yours — try again.',
  feature_disabled: 'Calling is turned off for this account. Ask your admin.',
};

/** Why one contact cannot be retried by its agent now. */
export const RETRY_BLOCK_COPY: Record<AgencyAgentRetryBlock, string> = {
  retry_disabled: 'This campaign doesn’t allow agent retry',
  not_retryable: 'Not a contact you missed',
  rounds_used: 'Already retried as many times as allowed',
  cooldown: 'Cooling down after the last attempt',
  suppressed: 'Do not call — never retried',
};

/** A refusal in the agent's words, with its detail filled in where the body carries one. */
export function agentRetryRefusal(err: unknown, fallback: string): string {
  const code = errorCode(err) as AgencyAgentRetryErrorCode | null;
  if (code === null || !(code in AGENT_RETRY_REFUSAL_COPY)) {
    return err instanceof Error && err.message ? err.message : fallback;
  }
  const details = detailsOf(err);
  if (code === 'outside_calling_hours' && typeof details?.['next_open_at'] === 'string') {
    return `${AGENT_RETRY_REFUSAL_COPY[code]} It opens again ${formatSpineTimestamp(details['next_open_at'])}.`;
  }
  if (code === 'contact_not_retryable') {
    const blocked = details?.['blocked'];
    if (typeof blocked === 'string' && blocked in RETRY_BLOCK_COPY) {
      const reason = RETRY_BLOCK_COPY[blocked as AgencyAgentRetryBlock];
      const at = typeof details?.['available_at'] === 'string'
        ? ` — try after ${formatSpineTimestamp(details['available_at'])}`
        : '';
      return `${AGENT_RETRY_REFUSAL_COPY[code]} ${reason}${at}.`;
    }
  }
  return AGENT_RETRY_REFUSAL_COPY[code];
}

function detailsOf(err: unknown): Record<string, unknown> | null {
  if (!err || typeof err !== 'object') return null;
  const body = (err as { details?: unknown }).details;
  if (!body || typeof body !== 'object') return null;
  const details = (body as { details?: unknown }).details;
  return details && typeof details === 'object' ? (details as Record<string, unknown>) : null;
}

/** The buckets the agent's filter offers, in the order an agent works them. */
export const MY_CONTACT_FILTER_BUCKETS: readonly AgencyMyContactBucket[] = [
  'callback',
  'pending',
  'not_reached',
  'reached',
  'exhausted',
  'suppressed',
];

/** The override badge on a row: what the agent may still do with this contact. */
export function overrideBadge(override: AgencyContactOverride | null): string | null {
  if (!override) return null;
  const parts: string[] = [];
  if (override.extra_attempts > 0) {
    parts.push(plural(override.extra_attempts, 'extra attempt'));
  }
  if (override.retry_delay) parts.push('may call early');
  if (override.calling_hours) parts.push('may call outside hours');
  return parts.length > 0 ? `Override: ${parts.join(', ')}` : null;
}

/**
 * Whether "Call" can be pressed for this contact now, and why not when it cannot.
 * Mirrors the server's manual-call rule (CA7): a retry-eligible contact, a
 * contact due now, or an open contact holding an unspent "call early" override.
 * The server re-checks every part; this only keeps a button from promising a
 * call it will refuse.
 */
export type CallGate = { ok: true } | { ok: false; reason: string };

export function contactCallGate(
  contact: AgencyMyContact,
  station: { sessionId: string | null; agentState: AgencyAgentState; dialing: boolean },
  now: number,
): CallGate {
  if (!station.sessionId) return { ok: false, reason: 'Your station isn’t connected yet.' };
  if (!station.dialing) return { ok: false, reason: 'The campaign isn’t running.' };
  if (station.agentState !== 'available') {
    return { ok: false, reason: 'Go available to call a contact.' };
  }
  if (contact.bucket === 'suppressed') return { ok: false, reason: RETRY_BLOCK_COPY.suppressed };
  if (contact.bucket === 'in_progress') return { ok: false, reason: 'Already on a call.' };
  if (contact.retry.eligible) return { ok: true };
  if (contact.state === 'pending') {
    const due = Date.parse(contact.next_attempt_at);
    if (!Number.isNaN(due) && due <= now) return { ok: true };
    if (contact.override?.retry_delay) return { ok: true };
    return { ok: false, reason: `Not due until ${formatSpineTimestamp(contact.next_attempt_at)}` };
  }
  const blocked = contact.retry.blocked;
  if (blocked === 'cooldown' && contact.retry.available_at) {
    return { ok: false, reason: `${RETRY_BLOCK_COPY.cooldown} — until ${formatSpineTimestamp(contact.retry.available_at)}` };
  }
  return { ok: false, reason: blocked ? RETRY_BLOCK_COPY[blocked] : RETRY_BLOCK_COPY.not_retryable };
}

/** "Retry not reached (N)" is offered when nothing is due and there is something to retry. */
export function showRetryNotReached(summary: {
  due_now: number;
  retry: { allowed: boolean; eligible: number };
}): boolean {
  return summary.retry.allowed && summary.due_now === 0 && summary.retry.eligible > 0;
}
