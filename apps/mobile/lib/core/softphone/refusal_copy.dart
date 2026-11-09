import 'package:agency_wire/agency_wire.dart';

import '../api/api_error.dart';

/// The app's sentence for every soft-phone refusal code (a port of the
/// console's `utils/softphone/refusalCopy.ts`).
///
/// One entry per [SoftphoneErrorCode] but `unknown` (a test holds every code to
/// a sentence), so a code added to the contract without copy here is caught
/// rather than reaching an agent as the server's raw sentence. The structured
/// refusals (DNC, calling hours, a contact the campaign is calling, a campaign
/// session) also get a prompt or a screen of their own; this is the line they
/// fall back to when shown inline.
///
/// The console's words, with the app's ways out where the console names a page
/// ("Reload the page" becomes the soft phone or My calls).
const Map<SoftphoneErrorCode, String> softphoneRefusalCopy = {
  SoftphoneErrorCode.softphoneDisabled: 'The soft phone is turned off for this account. Ask your supervisor.',
  SoftphoneErrorCode.invalidNumber: 'That doesn’t look like a phone number we can call. Check it and try again.',
  SoftphoneErrorCode.callerIdNotAllowed: 'You can’t call from that number. Pick another caller ID.',
  SoftphoneErrorCode.campaignNotTaggable:
      'You can’t log calls to that campaign. Pick another, or don’t log this call.',
  SoftphoneErrorCode.dncListed: 'This number is on the Do Not Call list.',
  SoftphoneErrorCode.dncUnavailable:
      'We couldn’t check the Do Not Call list just now, so the call wasn’t placed. Try again in a moment.',
  SoftphoneErrorCode.outsideCallingHours: 'This campaign is outside its calling hours.',
  SoftphoneErrorCode.overrideNoteInvalid: 'The note needs 10 to 500 characters.',
  SoftphoneErrorCode.contactInFlight:
      'The campaign is calling this customer right now. Wait for that call to finish, then try again.',
  SoftphoneErrorCode.sessionOnCampaign: 'You’re still at a campaign station.',
  SoftphoneErrorCode.sessionOnSoftphone: 'You’re on the soft phone. Close it before joining a campaign.',
  SoftphoneErrorCode.sessionNotFound: 'Your soft-phone session has ended. Open the soft phone again to make calls.',
  SoftphoneErrorCode.wrongSessionKind:
      'That works only at a campaign station. Close the soft phone, then join the campaign from My campaigns.',
  SoftphoneErrorCode.notOnSoftphone: 'You’re not on the soft phone yet. Wait for the switch to finish.',
  SoftphoneErrorCode.manualCallLive: 'Finish this call and save its outcome first.',
  SoftphoneErrorCode.outcomePending: 'Save the outcome of your last call before you dial again.',
  SoftphoneErrorCode.concurrencyLimit: 'All lines are busy right now. Try again in a moment.',
  SoftphoneErrorCode.stationUnavailable:
      'Your phone isn’t connected yet. Wait until it says Connected, then try again.',
  SoftphoneErrorCode.dialFailed:
      'The call couldn’t be placed just now, and nothing was dialled. Try again in a moment.',
  SoftphoneErrorCode.callNotFound:
      'We can’t find that call any more — it may already be closed. Check My calls to see where it stands.',
  SoftphoneErrorCode.callSettled: 'This call’s outcome is already saved.',
  SoftphoneErrorCode.dispositionInvalid:
      'That outcome can’t be saved. Check the outcome, its note and its callback time.',
  SoftphoneErrorCode.fieldsInvalid: 'Some call details need fixing. The fields are marked in Call details.',
  SoftphoneErrorCode.settingsInvalid: 'Some settings need fixing.',
  // Contact assignment: a strict campaign's contact that is another agent's.
  SoftphoneErrorCode.contactAssignedElsewhere: 'This number belongs to another agent on this campaign.',
  // Not retryable: the carrier account needs fixing, which only support can do.
  SoftphoneErrorCode.carrierAccountUnavailable:
      'This caller ID’s carrier account can’t place calls: it needs attention, so nothing was dialled. '
      'Contact support, or pick a caller ID on another carrier.',
  SoftphoneErrorCode.customerOnInboundCall:
      'This customer is on a call to us right now. Wait for that call to finish, then try again.',
};

/// What the refused request was doing, where one code means different things.
///
/// [call] (the default): placing or finishing a call, which the table above is
/// written for. [status]: the station's switch to the soft phone and Return to
/// campaign. Those answer `dial_failed` when the agent state store did not take
/// the write, and nothing was being dialled: the agent's status is what did not
/// change, so the call sentence would describe a call they never tried to place.
enum SoftphoneRefusalContext { call, status }

/// The [SoftphoneRefusalContext.status] sentences, for the codes whose meaning it changes.
const Map<SoftphoneErrorCode, String> softphoneStatusRefusalCopy = {
  SoftphoneErrorCode.dialFailed: 'Couldn’t change your status just now; nothing changed. Try again.',
};

const _fallback = 'That didn’t work. Try again.';

/// The line to show for a refusal: ours for a known code, the server's otherwise.
String refusalCopy(ErrorBody refusal, {SoftphoneRefusalContext context = SoftphoneRefusalContext.call}) {
  final code = refusal.softphoneCode;
  if (code == SoftphoneErrorCode.unknown) return refusal.message.isNotEmpty ? refusal.message : _fallback;
  return (context == SoftphoneRefusalContext.status ? softphoneStatusRefusalCopy[code] : null) ??
      softphoneRefusalCopy[code] ??
      (refusal.message.isNotEmpty ? refusal.message : _fallback);
}

/// The refusal body of [error] when the server answered, else null.
ErrorBody? refusalBodyOf(Object error) => error is ApiHttpError ? ErrorBody.fromJson(error.body) : null;

/// Any failure of a soft-phone request, in words: a refusal through
/// [refusalCopy], anything else (offline, a timeout, an unreadable answer, a
/// refusal without a soft-phone code) as the API layer words it.
String softphoneErrorCopy(Object error, {SoftphoneRefusalContext context = SoftphoneRefusalContext.call}) {
  final body = refusalBodyOf(error);
  if (body != null && body.softphoneCode != SoftphoneErrorCode.unknown) return refusalCopy(body, context: context);
  if (error is ApiError) return error.userMessage;
  return _fallback;
}
