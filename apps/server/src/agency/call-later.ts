/**
 * Who booked a contact's call-later, and what the agent's panel says about a call-later coming due
 * (agent station BE-3, BE-4; ruling AS8: routing is unchanged, the booker is only recorded). Pure.
 *
 *  - {@link callbackBookerOf}: the disposition route's decision for the contact's
 *    `callback_booked_by_user_id` / `callback_booked_at` (0057), written by
 *    `AgencyContactRepository.releaseFromDisposition` in the same statement as the contact.
 *  - {@link attemptCallbackOf}: `AgencyReservedAttempt.callback` from the claimed contact, built
 *    with the rest of the panel (`dialer/live-attempt.ts` `buildPanel`).
 *
 * What clears the booker is the contact's next settled call: `chargeAttempt` (a placed dialler
 * call), `settleFromManual` (a placed soft-phone call that held the contact) and
 * `settleFromInbound` (the customer reached on an inbound call), the same writes that clear an
 * inbound callback's `callback_source`. A dial that never went out (`unclaim`) and an our-fault
 * redial (`chargeOurFaultAttempt`) keep it, as they keep `callback_source`.
 */
import type { AgencyAttemptCallback, AgencyDisposition } from '@magick-agency/contracts/agency';
import type { AgencyContactRecord } from '../db/models/agency.model.js';
import { promiseFollowUpDays } from './promise-to-pay.js';

/**
 * What the disposition's contact write does with the booker (`releaseFromDisposition`):
 *  - `{ kind: 'mine', userId }`: stamp it, now (the agent whose own outcome, or promise follow-up,
 *    booked the call-later);
 *  - `{ kind: 'on_behalf' }`: a supervisor filed a call-later for the agent. Nothing is stamped; a
 *    booker already on the contact is kept only while its due time does not move (a re-filing from
 *    the attempt history), and cleared when the supervisor moved it;
 *  - `null`: nothing booked: cleared.
 * Never stamped on a contact the write does not leave `pending`, nor a DNC-suppressed one.
 */
export type CallbackBooker = { kind: 'mine'; userId: string } | { kind: 'on_behalf' } | null;

/**
 * BE-3: the booker a disposition writes. A call-later is booked when the outcome's decision is
 * `callback_scheduled` and it came from the entry's own time (`requires_datetime`) or a promise's
 * follow-up (PT2: `followUpBooked`). It is the agent's own only when the agent who took the call
 * (`reservedUserId`) filed it themselves: a supervisor's on-behalf save never stamps a booker.
 */
export function callbackBookerOf(input: {
  decisionReason: string;
  entry: Pick<AgencyDisposition, 'requires_datetime'>;
  followUpBooked: boolean;
  onBehalf: boolean;
  reservedUserId: string | null;
}): CallbackBooker {
  const booked = input.decisionReason === 'callback_scheduled'
    && (input.entry.requires_datetime === true || input.followUpBooked);
  if (!booked) return null;
  if (input.onBehalf) return { kind: 'on_behalf' };
  return input.reservedUserId ? { kind: 'mine', userId: input.reservedUserId } : null;
}

/** The contact columns {@link attemptCallbackOf} reads. */
export type CallLaterContact = Pick<AgencyContactRecord,
  'last_outcome' | 'last_disposition' | 'next_attempt_at' | 'callback_source' | 'callback_booked_by_user_id'>;

/**
 * BE-4: the panel's `callback` for a dial of `contact` (as claimed: its `next_attempt_at` is the
 * time it was due), or undefined when the dial is not a call-later coming due. The same test as
 * `isCallbackSql`: an inbound callback (`callback_source`), or the last outcome a callback code of
 * the campaign's catalog on a call that connected.
 *
 *  - `source`: `inbound` for an inbound callback (whoever booked anything before it, the customer
 *    rang in since); else `outcome` for an entry with `requires_datetime`, `promise` for a promise's
 *    follow-up (PT2).
 *  - `booked_by_me`: the contact's recorded booker is the agent the dial is for. Never for an inbound
 *    one, nor without a known agent (`agentUserId`).
 *  - A wrap-up redial (`redial`) carries none: it continues the call it redials.
 */
export function attemptCallbackOf(input: {
  contact: CallLaterContact;
  catalog: readonly AgencyDisposition[] | null | undefined;
  agentUserId: string | null | undefined;
  redial: boolean;
}): AgencyAttemptCallback | undefined {
  const { contact } = input;
  if (input.redial) return undefined;
  const due = contact.next_attempt_at instanceof Date ? contact.next_attempt_at : new Date(contact.next_attempt_at);
  if (Number.isNaN(due.getTime())) return undefined;
  if (contact.callback_source != null) {
    return { due_at: due.toISOString(), booked_by_me: false, source: 'inbound' };
  }
  if (contact.last_outcome !== 'connected' || !contact.last_disposition || !Array.isArray(input.catalog)) return undefined;
  const entry = input.catalog.find((d) => !!d && typeof d === 'object' && d.code === contact.last_disposition);
  if (!entry) return undefined;
  const source = entry.requires_datetime === true ? 'outcome' : promiseFollowUpDays(entry) !== null ? 'promise' : null;
  if (!source) return undefined;
  const bookedByMe = !!input.agentUserId && contact.callback_booked_by_user_id === input.agentUserId;
  return { due_at: due.toISOString(), booked_by_me: bookedByMe, source };
}
