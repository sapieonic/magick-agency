import type { AgencySoftphoneErrorCode } from '../../types/softphone';
import type { SoftphoneRefusal } from '../../api/softphone';

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
  wrong_session_kind: 'That isn’t possible from the soft phone.',
  not_on_softphone: 'You’re not on the soft phone yet. Wait for the switch to finish.',
  manual_call_live: 'Finish this call and save its outcome first.',
  outcome_pending: 'Save the outcome of your last call before you dial again.',
  concurrency_limit: 'All lines are busy right now. Try again in a moment.',
  station_unavailable: 'Your phone isn’t connected yet. Wait until it says Connected, then try again.',
  dial_failed: 'The call couldn’t be placed just now, and nothing was dialled. Try again in a moment.',
  call_not_found: 'We can’t find that call.',
  call_settled: 'This call’s outcome is already saved.',
  disposition_invalid: 'That outcome can’t be saved. Check the outcome, its note and its callback time.',
  fields_invalid: 'Some call details need fixing.',
  settings_invalid: 'Some settings need fixing.',
};

/** The line to show for a refusal: ours for a known code, the server's otherwise. */
export function refusalCopy(refusal: SoftphoneRefusal): string {
  if (refusal.code === 'unknown') return refusal.message;
  return SOFTPHONE_REFUSAL_COPY[refusal.code];
}
