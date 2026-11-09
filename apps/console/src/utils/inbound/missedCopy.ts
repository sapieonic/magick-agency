import type { AgencyInboundClosedCause, AgencyInboundMissedCall } from '../../types/inbound';
import type { InboundRefusal } from '../../api/inbound';
import { INBOUND_REFUSAL_COPY, MISSED_REASON_LABELS } from './inboundCopy';

/**
 * The Missed list's words for who a row is with and how it was handled, beyond the route editor's
 * copy (`inboundCopy.ts`): why a closed call was closed, a departed assignee, a row closed because
 * the customer was reached, reopening one, and a reassign's refusals. British English.
 */

/**
 * "Nobody free to answer", in one meaning wherever it is shown (the Missed list's reason, its page
 * guide, the inbound summary): the `overflow` outcome.
 */
export const NOBODY_FREE_MEANING =
  'the caller waited as long as the line allows, the queue was full, or nobody in the team could take calls';

/**
 * Why a `closed` row was closed when it was not the opening hours (0030's `closed_cause`): each is
 * answered with the closed message, but only `hours` is "Out of hours".
 */
export const CLOSED_CAUSE_LABELS: Record<Exclude<AgencyInboundClosedCause, 'hours'>, string> = {
  switched_off: 'Inbound switched off',
  no_route: 'Number not on a route',
  credential_inactive: 'Phone line not active',
};

/** Why a row was missed: the reason's label, or for a closed call the cause when it was not the hours. */
export function missedReasonLabel(call: Pick<AgencyInboundMissedCall, 'reason' | 'closed_cause'>): string {
  if (call.reason === 'closed' && call.closed_cause && call.closed_cause !== 'hours') return CLOSED_CAUSE_LABELS[call.closed_cause];
  return MISSED_REASON_LABELS[call.reason];
}

/** Who a row is assigned to, for a supervisor: "You", a name, "Former member", or the account. */
export function missedAssigneeLabel(
  call: Pick<AgencyInboundMissedCall, 'assignee_user_id' | 'assignee_name' | 'assignee_departed'>,
  userId: string | null,
): string {
  if (!call.assignee_user_id) return 'The account';
  if (call.assignee_departed) return 'Former member';
  if (call.assignee_user_id === userId) return 'You';
  return call.assignee_name ?? 'Former member';
}

/** The sub-line under "Former member": who it was, when the name is still known. */
export function departedAssigneeNote(call: Pick<AgencyInboundMissedCall, 'assignee_departed' | 'assignee_name'>): string | null {
  if (!call.assignee_departed) return null;
  return call.assignee_name ? `${call.assignee_name} no longer works in this account. Reassign it.` : 'No longer works in this account. Reassign it.';
}

/** How a handled row was handled, and by whom. */
export function missedHandledLabel(
  call: Pick<AgencyInboundMissedCall, 'handled_reason' | 'handled_by_user_id' | 'handled_by_name'>,
  userId: string | null,
): string {
  const who = call.handled_by_user_id === null
    ? null
    : call.handled_by_user_id === userId ? 'you' : (call.handled_by_name ?? 'a former member');
  if (call.handled_reason === 'reached') {
    return who ? `Customer reached by ${who}` : 'Customer reached';
  }
  if (!who) return 'Closed automatically';
  return who === 'you' ? 'You' : who.charAt(0).toUpperCase() + who.slice(1);
}

/** The second line under a reached row: why it closed without anyone marking it. */
export const MISSED_REACHED_NOTE = 'Closed on its own: an agent spoke to the customer after this call.';

/** A Reopen that did not go through. */
export function reopenRefusalCopy(refusal: InboundRefusal): string {
  if (refusal.code === 'inbound_missed_call_not_found') return 'This missed call isn’t yours to reopen, or it no longer exists. Refresh the list.';
  return 'We couldn’t reopen this call. Try again in a moment.';
}

/** A reassign that did not go through, in the supervisor's terms. */
export function reassignRefusalCopy(refusal: InboundRefusal): string {
  switch (refusal.code) {
    case 'inbound_assignee_invalid':
    case 'inbound_missed_call_handled':
      return INBOUND_REFUSAL_COPY[refusal.code];
    case 'inbound_missed_call_not_found':
      return 'This missed call is no longer here. Refresh the list.';
    default:
      return 'We couldn’t reassign this call. Try again in a moment.';
  }
}
