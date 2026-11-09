import type { AgencyDisposition } from '@magick-agency/contracts/agency';
import type { AgencyInboundContactSettlement } from '../../db/repositories/agency.repository.js';
import type { DispositionDecision } from '../disposition-policy.js';

/**
 * ─── WHAT AN ANSWERED INBOUND CALL'S OUTCOME DOES TO ITS MATCHED CONTACT (docs/inbound.md §6) ───
 *
 * SP6, forward only, as the soft phone's outcome (docs/softphone.md §5): the customer rang US, so
 * the call is no dial of the contact (`attempt_count` is never charged) and no retry is scheduled
 * from it. The outcome is mapped here; the contact's own state decides the rest
 * (`agencyContactRepository.settleFromInbound`):
 *
 * | Outcome (`resolveDispositionDecision`)                  | Asks of the contact | pending | exhausted | in_flight / connected | completed / suppressed |
 * |---------------------------------------------------------|---------------------|---------|-----------|-----------------------|------------------------|
 * | `suppress` (DNC, written with it, B8)                   | `suppressed`        | suppressed | suppressed | suppressed          | nothing                |
 * | `terminal`, or a success code (`is_success`)            | `completed`         | completed | completed (IQ9: a success closes it) | nothing | nothing           |
 * | a callback (`requires_datetime`, time given)            | `callback` at it    | pending at the time | pending at the time (reopened, IB4, IQ9) | nothing | nothing |
 * | anything else (a retry code, a plain label), or the outcome lapsing | `none`  | unchanged (one its inbound callback reopened: back to exhausted) | unchanged (exhausted) | nothing | nothing |
 *
 * The callback time is the agent's, moved into the contact's calling window by the caller
 * (`manualDispositionDecision`, the soft phone's), so it is the decision's `nextAttemptAt`. A
 * pending inbound callback on the contact (`callback_source`) is cleared by every arm: the
 * customer got through (IQ9); one that reopened an exhausted contact (`callback_reopened`, 0029)
 * leaves it exhausted again unless the outcome itself moves it (SWE-F2). A call whose outcome
 * lapses (or a supervisor closes) settles as `none` ({@link INBOUND_LAPSE_SETTLEMENT}). A
 * DNC-suppressed contact is never moved.
 */
export function inboundContactSettlement(
  entry: Pick<AgencyDisposition, 'is_success'>,
  decision: Pick<DispositionDecision, 'reason' | 'suppressedReason'>,
  nextAttemptAt: Date | null,
): AgencyInboundContactSettlement {
  // Keyed on WHY the decision went where it did, not where: a plain label's or a spent retry's
  // decision also reads `completed` for a dial, and an inbound call is no dial (`none` for those).
  if (decision.reason === 'disposition_suppressed') return { kind: 'suppressed', reason: decision.suppressedReason ?? 'dnc' };
  if (decision.reason === 'disposition_terminal' || entry.is_success === true) return { kind: 'completed' };
  if (decision.reason === 'callback_scheduled' && nextAttemptAt) return { kind: 'callback', at: nextAttemptAt };
  return { kind: 'none' };
}

/**
 * What a reached call whose outcome never came (it lapsed, or a supervisor closed it) asks of its
 * matched contact: nothing that moves it (`none`), so the booked inbound callback is cleared, the
 * customer was spoken to, and a contact the callback reopened goes back to exhausted (SWE-F2).
 */
export const INBOUND_LAPSE_SETTLEMENT: AgencyInboundContactSettlement = Object.freeze({ kind: 'none' });
