import type { AgencySoftphoneErrorCode } from '../../types/softphone';
import type { SoftphoneRefusal } from '../../api/softphone';
import { DISPOSITION_BLOCK_COPY } from '../agencyDispositionForm';

/**
 * The console's sentence for every soft-phone refusal code.
 *
 * A `Record` over the whole union, so a code added to the contract without copy
 * here fails the type check rather than reaching an agent as the server's raw
 * sentence. The structured refusals (DNC, calling hours, a contact the campaign
 * is calling, a campaign session) also get a dialog or a screen of their own;
 * this is the line they fall back to when shown inline.
 */
export const SOFTPHONE_REFUSAL_COPY: Record<AgencySoftphoneErrorCode, string> = {
  softphone_disabled: 'The soft phone is turned off for this account. Ask your supervisor.',
  invalid_number: 'That doesn’t look like a phone number we can call. Check it and try again.',
  caller_id_not_allowed: 'You can’t call from that number. Pick another caller ID.',
  campaign_not_taggable: 'You can’t log calls to that campaign. Pick another, or don’t log this call.',
  dnc_listed: 'This number is on the Do Not Call list.',
  dnc_unavailable:
    'We couldn’t check the Do Not Call list just now, so the call wasn’t placed. Try again in a moment.',
  outside_calling_hours: 'This campaign is outside its calling hours.',
  override_note_invalid: 'The note needs 10 to 500 characters.',
  contact_in_flight:
    'The campaign is calling this customer right now. Wait for that call to finish, then try again.',
  session_on_campaign: 'You’re still at a campaign station.',
  session_on_softphone: 'You’re on the soft phone. Close it before joining a campaign.',
  session_not_found: 'Your soft-phone session has ended. Reload the page to open it again.',
  wrong_session_kind: 'That works only at a campaign station. Close the soft phone, then join the campaign from My campaigns.',
  not_on_softphone: 'You’re not on the soft phone yet. Wait for the switch to finish.',
  manual_call_live: 'Finish this call and save its outcome first.',
  outcome_pending: 'Save the outcome of your last call before you dial again.',
  concurrency_limit: 'All lines are busy right now. Try again in a moment.',
  station_unavailable: 'Your phone isn’t connected yet. Wait until it says Connected, then try again.',
  dial_failed: 'The call couldn’t be placed just now, and nothing was dialled. Try again in a moment.',
  call_not_found: 'We can’t find that call any more — it may already be closed. Reload the page to see where it stands.',
  call_settled: 'This call’s outcome is already saved.',
  disposition_invalid: 'That outcome can’t be saved. Check the outcome, its note and its callback time.',
  fields_invalid: 'Some call details need fixing. The fields are marked in Call details.',
  settings_invalid: 'Some settings need fixing.',
  contact_assigned_elsewhere: 'This number belongs to another agent on this campaign.',
  // Not retryable: the carrier account needs fixing, which only support can do (PL15).
  carrier_account_unavailable:
    'This caller ID’s carrier account can’t place calls: it needs attention, so nothing was dialled. '
    + 'Contact support, or pick a caller ID on another carrier.',
  customer_on_inbound_call:
    'This customer is on a call to us right now. Wait for that call to finish, then try again.',
};

/**
 * What the refused request was doing, where one code means different things.
 *
 * `call` (the default): placing or finishing a call, which is what the table above
 * is written for. `status`: the station's switch to the soft phone and Return to
 * campaign (`POST /sessions/:id/softphone[/return]`). Those answer `dial_failed`
 * when the agent state store did not take the write (docs/softphone.md §6), and
 * nothing was being dialled: the agent's status is what did not change, so the
 * call sentence would describe a call they never tried to place.
 */
export type SoftphoneRefusalContext = 'call' | 'status';

/** The promise refusals (`disposition_invalid`'s `reason`, PT8), as the pad words its own checks. */
export const PROMISE_REFUSAL_COPY: Readonly<Record<string, string>> = {
  promise_required: DISPOSITION_BLOCK_COPY.promise_required,
  invalid_promise_date: 'That promised date can’t be used: it is before the customer’s today or too far ahead. Pick another date.',
  invalid_promise_amount: DISPOSITION_BLOCK_COPY.promise_amount_invalid,
  promise_not_expected: 'This outcome doesn’t record a promise to pay. Pick the promise outcome, or clear the promised date.',
  // PT13: a tagged call with no claimed roster contact (the pad hides promise entries there).
  promise_needs_contact:
    'A promise to pay can’t be saved on this call: the number isn’t an open contact on the campaign’s list. Pick another outcome and put the promise in the note.',
};

/** The `status` context's sentences, for the codes whose meaning it changes. */
export const SOFTPHONE_STATUS_REFUSAL_COPY: Partial<Record<AgencySoftphoneErrorCode, string>> = {
  dial_failed: 'Couldn’t change your status just now; nothing changed. Try again.',
};

/** The line to show for a refusal: ours for a known code, the server's otherwise. */
export function refusalCopy(refusal: SoftphoneRefusal, context: SoftphoneRefusalContext = 'call'): string {
  if (refusal.code === 'unknown') return refusal.message;
  // A promise to pay the server refused (PT8): its reason, in the pad's own words.
  if (refusal.code === 'disposition_invalid' && 'reason' in refusal && refusal.reason) {
    const promise = PROMISE_REFUSAL_COPY[refusal.reason];
    if (promise) return promise;
  }
  return (context === 'status' ? SOFTPHONE_STATUS_REFUSAL_COPY[refusal.code] : undefined)
    ?? SOFTPHONE_REFUSAL_COPY[refusal.code];
}
