import type { InboundRefusal } from '../../api/inbound';
import type {
  AgencyInboundErrorCode,
  AgencyInboundMissedCall,
  AgencyInboundMissedListQuery,
  AgencyInboundMissedReason,
  AgencyInboundStickyMode,
  AgencyInboundClipSlot,
} from '../../types/inbound';

/**
 * Inbound calls' words (British English). Keyed by the wire's codes, so a code added to the
 * contract fails to compile here until it has words.
 */

export const INBOUND_REFUSAL_COPY: Record<AgencyInboundErrorCode, string> = {
  inbound_disabled: 'Inbound calls aren’t turned on for this account.',
  inbound_route_invalid: 'Some settings need fixing. They’re marked below.',
  inbound_route_not_found: 'This route no longer exists. Someone may have deleted it.',
  inbound_route_name_taken: 'Another route in this account already has that name. Choose another.',
  inbound_number_not_found: 'One of the numbers can’t be used by this account any more. Remove it and save again.',
  inbound_number_not_linked: 'One of the numbers isn’t linked to inbound calls. Contact support to have it linked.',
  inbound_number_in_use: 'One of the numbers already answers another route. Remove it there first, or choose another number.',
  inbound_missed_call_not_found: 'This missed call isn’t yours to handle, or it no longer exists.',
  inbound_call_live: 'An inbound call is in progress or still needs its outcome. Save the outcome first.',
  inbound_call_not_found: 'We can’t find that call any more — it may already be closed.',
  inbound_call_not_dispositionable: 'This call can’t take an outcome: it hasn’t ended, or nobody spoke to the caller.',
  inbound_disposition_invalid: 'That outcome can’t be saved. Check the outcome, its note and its callback time.',
  inbound_outcome_already_saved: 'This call’s outcome is already saved.',
};

/** A refusal in the console's words, naming the number when there is one. */
export function inboundRefusalCopy(refusal: InboundRefusal, numberLabel?: (id: string) => string | null): string {
  if (refusal.code === 'unknown') return refusal.message;
  const base = INBOUND_REFUSAL_COPY[refusal.code];
  const label = refusal.phoneNumberId ? numberLabel?.(refusal.phoneNumberId) : null;
  return label ? `${base} (${label})` : base;
}

export const MISSED_REASON_LABELS: Record<AgencyInboundMissedReason, string> = {
  closed: 'Out of hours',
  abandoned_in_queue: 'Hung up while waiting',
  overflow: 'Waited too long',
  overflow_no_capacity: 'All lines busy',
  failed: 'Couldn’t be answered',
};

export const STICKY_MODE_LABELS: Record<AgencyInboundStickyMode, { label: string; hint: string }> = {
  loose: {
    label: 'Prefer their agent',
    hint: 'Offer the caller to the agent who last dealt with them for a short wait, then to the team.',
  },
  strict: {
    label: 'Only their agent',
    hint: 'Hold the caller for their agent until the longest wait; if nobody answers, the follow-up is theirs.',
  },
  off: { label: 'Off', hint: 'Every caller goes to the team, longest idle agent first.' },
};

/**
 * Each clip slot's label, hint, and what the "no recording" choice means for callers: the three
 * messages a call is answered with are then spoken by the carrier in a standard voice (the server's
 * fixed words); the others are simply not played.
 */
export const CLIP_SLOT_LABELS: Record<AgencyInboundClipSlot, { label: string; hint: string; none: string }> = {
  greeting: {
    label: 'Greeting',
    hint: 'Played as soon as the call is answered, before a recorded message. Not played before a standard spoken message.',
    none: 'No greeting',
  },
  recording_notice: { label: 'Recording notice', hint: 'Played before an agent joins, when calls are recorded.', none: 'No notice' },
  hold: { label: 'Hold music', hint: 'Looped while the caller waits for an agent.', none: 'No hold music' },
  closed: {
    label: 'Closed',
    hint: 'Played out of hours and on holidays. Standard: “Thank you for calling. We can’t take your call right now. Please try again later.”',
    none: 'Standard spoken message',
  },
  busy: {
    label: 'All lines busy',
    hint: 'Played when the route already has as many calls as it takes. Standard: “… All our lines are busy at the moment. We’ll call you back as soon as we can.”',
    none: 'Standard spoken message',
  },
  callback: {
    label: 'We’ll call you back',
    hint: 'Played before the call ends with a callback follow-up. Standard: “… Everyone is busy at the moment. We’ll call you back as soon as we can.”',
    none: 'Standard spoken message',
  },
};

/** Where a Missed row stands with its assignee, in words. */
export function assigneeLabel(call: Pick<AgencyInboundMissedCall, 'assignee_user_id' | 'assignee_name'>, userId: string | null): string {
  if (!call.assignee_user_id) return 'The account';
  if (call.assignee_user_id === userId) return 'You';
  return call.assignee_name ?? 'Former member';
}

export interface MissedFiltersDraft {
  status: 'open' | 'handled';
  /** '' (everyone), 'me', 'unassigned', or a user id. Supervisors only. */
  assignee: string;
  reason: '' | AgencyInboundMissedReason;
  /** Local dates, `YYYY-MM-DD`, both inclusive. */
  from: string;
  to: string;
}

export const EMPTY_MISSED_FILTERS: MissedFiltersDraft = { status: 'open', assignee: '', reason: '', from: '', to: '' };

/** The list query for the filters: local dates become instants (`to` exclusive, the next midnight). */
export function missedQueryFromDraft(draft: MissedFiltersDraft): AgencyInboundMissedListQuery {
  const query: AgencyInboundMissedListQuery = { status: draft.status };
  if (draft.assignee) query.assignee = draft.assignee;
  if (draft.reason) query.reason = draft.reason;
  if (draft.from) query.from = new Date(`${draft.from}T00:00:00`).toISOString();
  if (draft.to) {
    const end = new Date(`${draft.to}T00:00:00`);
    end.setDate(end.getDate() + 1);
    query.to = end.toISOString();
  }
  return query;
}
