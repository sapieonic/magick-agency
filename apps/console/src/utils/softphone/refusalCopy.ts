import type { AgencySoftphoneErrorCode } from '../../types/softphone';
import type { SoftphoneRefusal } from '../../api/softphone';
import { STATION_BLOCK_COPY, STATION_COPY } from '../agency/stationCopy';

/**
 * The console's sentence for every soft-phone refusal code, in the station's words (AS15: simple
 * Indian English, none of spec §6.6's jargon; `sideViewCopy.test.ts` checks them).
 *
 * A `Record` over the whole union, so a code added to the contract without copy
 * here fails the type check rather than reaching an agent as the server's raw
 * sentence. The structured refusals (DNC, calling hours, a contact the campaign
 * is calling, a campaign session) also get a dialog or a screen of their own;
 * this is the line they fall back to when shown inline.
 */
export const SOFTPHONE_REFUSAL_COPY: Record<AgencySoftphoneErrorCode, string> = {
  softphone_disabled: 'The soft phone is turned off for this account. Ask your supervisor.',
  invalid_number: 'We cannot call this number. Check it and try again.',
  caller_id_not_allowed: 'You cannot call from that number. Choose another in Call from.',
  campaign_not_taggable: 'You cannot save calls to that work. Choose another, or Not in any work.',
  dnc_listed: 'This customer asked us not to call them.',
  dnc_unavailable: 'We could not check the do-not-call list, so we did not call. Try again in a moment.',
  outside_calling_hours: 'It is outside this work’s calling hours.',
  override_note_invalid: 'Write a note of 10 to 500 letters.',
  contact_in_flight: 'Another call to this customer is going on now. Wait for it to end, then try again.',
  session_on_campaign: 'You are still working on your calls. Finish there first.',
  session_on_softphone: 'Your soft phone is still open. Close it first.',
  session_not_found: 'Your soft phone was closed. Open the page again.',
  wrong_session_kind: 'This works only while you take calls. Close the soft phone, then open today’s work.',
  not_on_softphone: 'The soft phone is not open yet. Wait a moment.',
  manual_call_live: STATION_COPY.finishCallFirst,
  outcome_pending: STATION_COPY.finishCallFirst,
  concurrency_limit: 'All lines are busy. Try again in a moment.',
  station_unavailable: 'Your phone is not connected yet. Wait a moment, then try again.',
  dial_failed: 'The call did not go through. Nothing was dialled. Try again in a moment.',
  call_not_found: 'We cannot find this call. It may be closed already. Open the page again.',
  call_settled: 'This call is saved already.',
  disposition_invalid: 'That did not save. Check what you chose, the note and the time.',
  fields_invalid: 'Some call details need fixing. They are marked in Call details.',
  settings_invalid: 'Some settings need fixing.',
  contact_assigned_elsewhere: 'This customer belongs to another agent in this work.',
  // Not retryable: the carrier account needs fixing, which only support can do (PL15).
  carrier_account_unavailable:
    'Calls cannot go out from this number now, so nothing was dialled. Choose another number in Call from. Your supervisor can ask support to fix this one.',
  customer_on_inbound_call: 'This customer is on a call with us right now. Wait for it to end, then try again.',
};

/** The line for a refusal the console has no words for: never the server's own sentence (AS15). */
export const SOFTPHONE_UNKNOWN_REFUSAL_COPY = 'That did not go through. Try again in a moment.';

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
  promise_required: STATION_BLOCK_COPY.promise_required,
  invalid_promise_date: STATION_BLOCK_COPY.promise_date_invalid,
  invalid_promise_amount: STATION_BLOCK_COPY.promise_amount_invalid,
  promise_not_expected: 'This choice does not take a pay date. Clear the pay date, or choose the one that does.',
  // PT13: a tagged call with no claimed roster contact (the pad hides promise entries there).
  promise_needs_contact:
    'A pay date cannot be saved on this call: this number is not on the work’s list. Choose another, and write the date in the note.',
};

/** The `status` context's sentences, for the codes whose meaning it changes. */
export const SOFTPHONE_STATUS_REFUSAL_COPY: Partial<Record<AgencySoftphoneErrorCode, string>> = {
  dial_failed: 'Your status did not change. Try again.',
};

/** The line to show for a refusal: ours for a known code, a safe line of ours otherwise (AS15). */
export function refusalCopy(refusal: SoftphoneRefusal, context: SoftphoneRefusalContext = 'call'): string {
  if (refusal.code === 'unknown') return SOFTPHONE_UNKNOWN_REFUSAL_COPY;
  // A promise to pay the server refused (PT8): its reason, in the pad's own words.
  if (refusal.code === 'disposition_invalid' && 'reason' in refusal && refusal.reason) {
    const promise = PROMISE_REFUSAL_COPY[refusal.reason];
    if (promise) return promise;
  }
  return (context === 'status' ? SOFTPHONE_STATUS_REFUSAL_COPY[refusal.code] : undefined)
    ?? SOFTPHONE_REFUSAL_COPY[refusal.code];
}
