/// The soft-phone screens' own labels, in one place so they can be localised
/// later.
///
/// Every sentence the core decides (refusals, the rail, block reasons, the
/// finish notices) arrives in the view already worded; this holds only what the
/// widgets say themselves. The words are the console's (`DialPad`,
/// `SoftphoneActionBar`, `OverrideDialog`, `OutcomeColumn`, `CallDetailsColumn`,
/// `SoftphonePage`) with the mobile substitutions: no keyboard hints, "on your
/// phone" for "in your browser", the Phone tab for the console's nav.
abstract final class SoftphoneCopy {
  static const title = 'Soft phone';

  // ── Header ──
  static const closeSoftphone = 'Close soft phone';
  static const closing = 'Closing…';
  static const closeConfirmTitle = 'Close the soft phone?';
  static const closeConfirmMessage = 'This ends your soft-phone session. To call again, open the soft phone from the Phone tab.';
  static const returnToCampaign = 'Return to campaign';
  static const returning = 'Returning…';
  static const recording = 'Recording';
  static const muted = 'Muted';
  static String loggingTo(String? campaign) => campaign == null ? notLogged : 'Logging to: $campaign';
  static const notLogged = 'Not logged to a campaign';
  static String bootstrapError(String message) => 'We couldn’t load the soft phone: $message';
  static const tryAgain = 'Try again';
  static const dismiss = 'Dismiss';

  // ── Status band ──
  static const reconnect = 'Reconnect';
  static const useThisPhone = 'Use this phone';

  // ── The number and the pad ──
  static const dial = 'Dial';
  static const pasteWorks = 'Paste works too';
  static const numberLabel = 'Phone number';
  static const numberHint = 'Number to call';
  static const countryCodeHint = 'Numbers without a country code are read in this one';
  static const deleteDigit = 'Delete last digit';
  static const deleteDigitHint = 'Press and hold to clear the number';
  static const keypad = 'Keypad';
  static const zeroHint = 'Press and hold for +';
  static const call = 'Call';
  static const calling = 'Calling…';

  // ── Setup ──
  static const logTo = 'Log to';
  static const fixedForThisCall = 'Fixed for this call';
  static const usesCampaign = 'Uses this campaign’s outcomes, caller IDs and summary profile';
  static const usesUntagged = 'Uses the soft phone’s own outcomes and your account’s numbers';
  static const callFrom = 'Call from';
  static const noNumbers = 'No numbers available';
  static String fromCampaignNumbers(String campaign) => 'From $campaign’s caller IDs';
  static const fromAccountNumbers = 'From the numbers assigned to your account';
  static String summarisedWith(String profile) => 'Summarised with $profile';

  // ── The call on screen ──
  static String from(String callerId) => 'From $callerId';
  static const statusDialing = 'Dialling';
  static const statusRinging = 'Ringing';
  static const statusConnected = 'Connected';
  static const statusEnded = 'Ended';

  /// SP3: what the agent must know before hanging up a ringing call whose
  /// carrier cannot stop it ringing (`SoftphoneView.warnRingingHangUp`).
  static const ringingHangupWarning =
      'This carrier cannot stop a ringing call. If you hang up now, the customer’s phone keeps ringing for a while, and if they answer they hear nothing. Hang up only when you must.';

  // ── Controls ──
  static const mute = 'Mute';
  static const muteRing = 'Mute ring';
  static const ringMuted = 'Ring muted';
  static const audio = 'Audio';
  static const audioSheetTitle = 'Where to hear the call';
  static const noRoutes = 'Only this phone is available right now.';
  static const markDnc = 'Mark DNC';
  static const markingDnc = 'Adding to Do Not Call…';
  static const onDnc = 'On Do Not Call';
  static const holdToHangUp = 'Hold to hang up';
  static const keepHolding = 'Keep holding…';
  static const endingCall = 'Ending…';
  static const hangUp = 'Hang up';
  static const hangUpHint = 'Press and hold to end the call';
  static const hangUpConfirmTitle = 'End this call?';
  static const hangUpConfirmBody = 'The customer will be disconnected.';
  static const keepCall = 'Keep the call';
  static const cancel = 'Cancel';

  // ── Mark DNC ──
  static const dncTitle = 'Add this number to Do Not Call?';
  static String dncMessage(String number, String? scope) =>
      '$number won’t be called again ${scope ?? 'from this account'}. Do this when the customer asks not to be called.';
  static const dncConfirm = 'Add to Do Not Call';

  // ── Override prompt ──
  static const dontCall = 'Don’t call';
  static String noteTooShort(int min) => 'Write at least $min characters — say why this call has to go ahead.';
  static String noteTooLong(int max) => 'Keep the note to $max characters.';
  static String noteCounter(int n, int max) => '$n / $max';
  static const required = 'required';

  // ── Contact ──
  static const onTheRoster = 'On the roster';
  static String rosterContact(String? campaign) =>
      'This number is a contact in ${campaign == null || campaign.trim().isEmpty ? 'this campaign' : campaign}.';
  static const claimed = 'Its outcome updates this contact in the campaign.';
  static const notClaimed = 'The campaign isn’t waiting on this contact, so only a Do Not Call outcome changes it.';

  // ── Call details ──
  static const callDetails = 'Call details';
  static const callDetailsHint = 'Saved with the call, shown beside the summary';
  static const choose = 'Choose…';
  static const yes = 'Yes';
  static const no = 'No';
  static const pickDate = 'Pick a date';
  static const clearDate = 'Clear date';
  static const unsupportedField = 'This app can’t edit this detail.';

  // ── Notes ──
  static const notes = 'Notes';
  static const notesRequired = 'Notes (required)';
  static const notesHint = 'What did the customer say?';

  // ── Outcome ──
  static const outcome = 'Outcome';
  static String outcomeFrom(String? campaign) => campaign == null ? 'From the soft phone’s outcome list' : 'From $campaign’s outcome list';
  static const saveOutcome = 'Save outcome';
  static const saving = 'Saving…';
  static const dialBlockedOwed = 'Dialling is blocked until this call has an outcome.';
  static String closesIn(String clock) => 'Without one, it closes in $clock.';
  static const closingNoOutcome = 'Closing with no outcome…';

  /// A callback on a call the campaign is not waiting on stays on the call.
  static const callbackNote =
      'The callback time is saved on this call. It isn’t added to a campaign’s queue, so make a note to call back yourself.';

  // ── Recent calls ──
  static const recentCalls = 'Recent calls';
  static const recentHint = 'Yours, newest first';
  static const recentLoading = 'Loading your recent calls…';
  static const recentError = 'We couldn’t load your recent calls. They’re still in My calls.';
  static const recentEmpty = 'Calls you make from the soft phone appear here, ready to redial.';
  static String redial(String number) => 'Redial $number';
  static const redialHint = 'Puts the number in the dial pad. Press Call to dial.';

  // ── The Phone tab's states ──
  static const loading = 'Loading the soft phone…';
  static const opening = 'Opening your soft phone…';
  static const closedTitle = 'Make calls from your phone';
  static const closedBody =
      'Dial any number, log the call to a campaign or not, and save its outcome. Your phone asks for the microphone first.';
  static const open = 'Open the soft phone';
  static const micDenied = 'The soft phone needs the microphone so the customer can hear you. Allow it, then open the soft phone.';
  static const micBlockedTitle = 'Your microphone is blocked';
  static const micBlockedBody = 'Allow the microphone for Magick Agency in your phone’s Settings, then open the soft phone.';
  static const openSettings = 'Open Settings';

  static String onCampaignTitle(String campaign, {String? account, required bool sameAccount}) =>
      sameAccount ? 'You’re still at the $campaign station' : 'You’re live on $campaign in ${account ?? 'another account'}';
  static String onCampaignDetail(String campaign, String state, {String? account, required bool sameAccount}) =>
      'You’re joined to $campaign${sameAccount ? '' : ' in ${account ?? 'another account'}'} — ${state.toLowerCase()}. You can only have one session at a time.';
  static const onCampaignSwitchIdle =
      'Switch that station to the soft phone. You stay on the campaign and can go back to it from the station.';
  static const onCampaignSwitchQueued =
      'Switch that station to the soft phone and it switches after this call and its wrap-up. You stay on the campaign and can go back to it from the station.';
  static const switchQueued = 'Switching after this call';
  static String onCampaignOtherAccount(String campaign, String? account) =>
      'You’re live on $campaign in ${account ?? 'another account'} — switch to that account to use the soft phone there.';
  static String switchAccountTo(String? account) => account == null ? 'Switch to that account' : 'Switch to $account';
  static const switchToSoftphone = 'Switch to soft phone';
  static const switching = 'Switching…';
  static const goToStation = 'Go to station';

  static const elsewhereTitle = 'Your soft phone is open in another account';
  static String elsewhereDetail(String? account) => account == null
      ? 'Your soft-phone session is open in another account of this organisation. You can only have one session at a time.'
      : 'Your soft-phone session is open in $account. You can only have one session at a time.';
  static const elsewhereClose = 'Close it and open the soft phone here';
  static String elsewhereCallPending(String? account) =>
      'Your soft phone ${account == null ? 'in the other account' : 'in $account'} has a call that isn’t finished, so it’s still open. Hang up and save its outcome there first.';
  static String useSoftphoneIn(String? account) =>
      account == null ? 'Use the soft phone in that account' : 'Use the soft phone in $account';

  static const offTitle = 'Not available for your account';
  static const offBody = 'The soft phone isn’t turned on for this account. Ask your supervisor if you need it.';

  static const strandedTitle = 'Your soft phone is open in another account';
  static const strandedDetail =
      'The soft phone is turned off for this account, and your soft-phone session is still open in another account of this organisation. Switch to that account to finish there, or close it here.';
  static const strandedOwed = 'Your last call there still needs its outcome. A supervisor can save it for you from Soft-phone calls.';
  static const strandedClose = 'Close the soft phone so you can join a campaign.';

  static const errorTitle = 'Can’t open the soft phone';
}
