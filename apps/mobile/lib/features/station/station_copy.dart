import '../../core/station/station_view.dart';
import 'logic/disposition_form.dart';

/// Every sentence the station screen says, in one place so it can be
/// localised later.
///
/// The wording follows the web console's (`StateRail`, `agencyReleaseCopy`,
/// `agencyDncCopy`, `agencyAudioCopy`, `agencyNotes`, `agencyStationExit`,
/// `agencyDispositionForm`), so an agent who uses both reads the same
/// sentences; only what is genuinely different on a phone (Settings instead
/// of a browser permission, "the app" instead of "this tab") is changed.
abstract final class StationCopy {
  // ── Phase labels: the header pill and the screen-reader announcement ──
  static const available = 'Available';
  static const offline = 'Offline';
  static const onBreak = 'On break';
  static const ringing = 'Ringing — get ready';
  static const onCall = 'On call';
  static const wrapup = 'Wrap-up';

  /// What the polite live region says when the phase changes.
  static String announce(AgentPhase phase, {String? breakLabel, bool deviceAway = false}) => switch (phase) {
    AgentPhase.offline => 'Offline',
    AgentPhase.available => 'Available. Waiting for a call',
    AgentPhase.reserved => 'Ringing',
    AgentPhase.onCall => 'On call',
    AgentPhase.wrapup => 'Wrap-up',
    AgentPhase.onBreak => deviceAway ? 'Paused because you left the app' : breakTitle(breakLabel),
  };

  // ── Header ──
  static const running = 'Running';
  static const paused = 'Paused';
  static const weakConnection = 'Weak connection';

  // ── Waiting ──
  static const waitingHeadline = 'Waiting for a call';
  static const waitingHint = 'Keep this screen open so the next customer reaches you. Their details appear before they pick up.';
  static const pausedHeadline = 'Campaign paused — no calls will come through';
  static const pausedHint = 'Nothing will be sent to you until the campaign is running again.';
  static String availableFor(String clock) => 'Available for $clock';
  static const takeBreak = 'Take a break';
  static const leave = 'Leave';

  // ── Offline ──
  static const offlineHeadline = 'You’re not taking calls';
  static const offlineHint = 'Go available when you’re ready for the next customer.';
  static const goAvailable = 'Go available';
  static const goingAvailable = 'Going available…';

  // ── Break ──
  static String breakTitle(String? label) => label == null || label.trim().isEmpty ? 'On break' : 'On break — $label';
  static const breakHint = 'Press End break when you’re ready.';
  static String breakFor(String clock) => 'On break for $clock';
  static const endBreak = 'End break';
  static const endingBreak = 'Ending break…';

  // ── Paused because the agent left the app (device_away) ──
  static const awayPill = 'Paused · you left the app';
  static const awayHeadline = 'No calls while you were away';
  static String awayDetail(String? at) => at == null
      ? 'You switched to another app, so we paused you. No customer was connected to an empty line.'
      : 'At $at you switched to another app, so we paused you. No customer was connected to an empty line.';
  static const awayFor = 'Paused for';
  static const awayCountsAs = 'Counts as';
  static const awayCountsAsValue = 'Away (not a break)';
  static const resume = 'Resume taking calls';
  static const breakInstead = 'Take a break instead';

  // ── Break sheet ──
  static const breakSheetTitle = 'Take a break';
  static const breakSheetNow = 'You’re available, so the break starts now and no calls come through.';
  static const breakSheetQueued = 'The break starts when you finish this call.';
  static const breakSheetOnCallNote = 'On a call? The break waits until you finish.';
  static const breakUnconfigured = 'Your workspace hasn’t set up break reasons yet. Ask your supervisor.';
  static const cancel = 'Cancel';

  // ── Queued break ──
  static const breakAfterCall = 'Break after this call';
  static String breakQueued(String label) => 'Break after this call — $label';
  static const cancelQueuedBreak = 'Cancel queued break';

  // ── Ringing ──
  static const beingDialled = 'Customer is being dialled';
  static const connectingCustomer = 'Connecting the customer…';
  static String attempt(int n) => 'Attempt $n';
  static const autoSelected = 'auto-selected';
  static const autoSelectedHint = 'Picked automatically from the contact’s details.';
  static String priorAttempts(int n) => 'Prior attempts ($n)';
  static const thisCampaign = 'This campaign';
  static String moreAttempts(int n) => '+$n more in Details';
  static String otherCampaign(String? name) => name == null || name.trim().isEmpty ? 'Another campaign' : name;
  static String moreDetails(int n) => 'More details ($n)';
  static const filterFields = 'Filter fields';
  static const filterHint = 'Type to find a field…';
  static String fieldCount(int shown, int total) =>
      shown == total ? '$total field${total == 1 ? '' : 's'}' : '$shown of $total field${total == 1 ? '' : 's'}';
  static String noFieldMatches(String q) => 'No fields match “$q”.';
  static const noExtraDetails = 'No extra details were uploaded for this contact.';
  static String emptyFields(int n) => '$n empty field${n == 1 ? '' : 's'}';
  static const callingFrom = 'Calling from';

  // ── On call ──
  static const recording = 'Recording';
  static const mute = 'Mute';
  static const unmute = 'Unmute';
  static const muted = 'Muted';
  static const audio = 'Audio';
  static const audioSheetTitle = 'Where to hear the call';
  static const noRoutes = 'Only this phone is available right now.';
  static const details = 'Details';
  static const detailsTitle = 'Contact details';
  static const markDnc = 'Mark DNC';
  static const markingDnc = 'Marking…';
  static const close = 'Close';

  // ── Hang up ──
  static const holdToHangUp = 'Hold to hang up';
  static const keepHolding = 'Keep holding…';
  static const endingCall = 'Ending…';
  static const hangUp = 'Hang up';
  static const hangUpHint = 'Press and hold to end the call';
  static const hangUpConfirmTitle = 'End this call?';
  static const hangUpConfirmBody = 'The customer will be disconnected.';
  static const hangUpConfirmRinging = 'The call is still connecting. Ending it now stops the dial.';
  static const keepCall = 'Keep the call';

  // ── Mark DNC (agencyDncCopy) ──
  static const dncTitle = 'Stop calling this number?';
  static const dncAction = 'Don’t call in this campaign';
  static String dncMessage(String phone, String campaign) =>
      '$phone won’t be called again by ${campaign.trim().isEmpty ? 'this campaign' : campaign}. Other campaigns in this workspace can still reach them. You can’t undo this from the app — an admin has to remove it.';

  // ── Notes (agencyNotes) ──
  static const notes = 'Notes';
  static const notesRequired = 'Notes (required)';
  static const notesHint = 'What did the customer say?';
  static String notesStatus(NotesStatus s) => switch (s) {
    NotesStatus.idle => 'Notes save as you type.',
    NotesStatus.saving => 'Saving…',
    NotesStatus.saved => 'Saved',
    NotesStatus.retrying => 'Not saved yet — trying again. Still on this phone.',
    NotesStatus.failed => 'Not saved to the server. Still on this phone — keep the app open.',
    NotesStatus.closed => 'Notes are closed for this call.',
  };
  static const notesChangedElsewhere = 'These notes were also changed elsewhere.';

  // ── Interruptions and the microphone (agencyAudioCopy, for phones) ──
  static const phoneCallTitle = 'Your phone took another call';
  static const phoneCallSubtitle = 'The customer can’t hear you';
  static const phoneCallBody = 'A phone call came in on your SIM. Your mic was muted so the customer doesn’t hear it.';
  static const otherAppTitle = 'Another app took the audio';
  static const otherAppBody = 'Your mic was muted so the customer doesn’t hear it.';
  static String backTo(String? name) =>
      name == null || name.trim().isEmpty ? 'Back to the call (unmute)' : 'Back to ${firstName(name)} (unmute)';
  static String onCallMuted(String clock) => 'On call · $clock · your mic is muted';

  static String micHeadline(MicProblem p) => switch (p) {
    MicProblem.permissionDenied => 'Your microphone is blocked — the customer cannot hear you.',
    MicProblem.noDevice => 'No microphone was found — the customer cannot hear you.',
    MicProblem.busy => 'Your microphone is in use by another app — the customer cannot hear you.',
    MicProblem.lost => 'Your microphone disconnected — the customer cannot hear you.',
    MicProblem.none => '',
  };
  static String micRemedy(MicProblem p) => switch (p) {
    MicProblem.permissionDenied => 'Allow the microphone for Magick Agency in your phone’s Settings.',
    MicProblem.noDevice => 'Reconnect your headset, or pick the phone in Audio.',
    MicProblem.busy => 'Close the other app using it, then come back here.',
    MicProblem.lost => 'Reconnect your headset, or pick the phone in Audio.',
    MicProblem.none => '',
  };
  static const openSettings = 'Open Settings';

  // ── Wrap-up ──
  static String howDidItGo(String? who) => who == null || who.trim().isEmpty ? 'How did it go?' : 'How did it go? · $who';
  static const waitingOnDisposition = 'Waiting on a disposition';
  static const heldBySupervisor = 'Held by your supervisor';
  static const saveOutcome = 'Save outcome';
  static const savingOutcome = 'Saving…';
  static String outcomeSaved(String label) => 'Saved — $label';
  static const outcomeSavedAnnouncement = 'Outcome saved';
  static const savedReturning = 'You’ll be available again when wrap-up ends.';
  static String blockCopy(DispositionBlock b) => switch (b) {
    DispositionBlock.noSelection => 'Pick an outcome to save this call.',
    DispositionBlock.noteRequired => 'This outcome needs a note.',
    DispositionBlock.callbackRequired => 'This outcome needs a callback time.',
    DispositionBlock.callbackInPast => 'That time has already passed. Pick when we should call back.',
  };
  static const success = 'Success';
  static const stopsCalling = 'Stops calling';
  static const suppressConfirmTitle = 'Save and stop calling this number?';
  static String suppressConfirmBody(String label, String phone, String campaign) =>
      '“$label” adds $phone to the Do Not Call list for ${campaign.trim().isEmpty ? 'this campaign' : campaign}. You can’t undo this from the app — an admin has to remove it.';
  static const suppressConfirmAction = 'Save and stop calling';

  // ── Callback ──
  static const callbackTitle = 'When should we call back?';
  static String callbackChip(CallbackChoice c) => switch (c) {
    CallbackChoice.inOneHour => 'In 1 hour',
    CallbackChoice.tomorrowMorning => 'Tomorrow 10 am',
    CallbackChoice.tomorrowEvening => 'Tomorrow 6 pm',
    CallbackChoice.picked => 'Pick…',
  };
  static String callbackTimezone(String zone) =>
      'Times are in your timezone${zone.isEmpty ? '' : ' ($zone)'}. We don’t have the customer’s — say the time out loud to agree it.';
  static const callbackGroundTruth = 'Goes back to the campaign queue. It may not be you who calls.';
  static const callbackDateHelp = 'Call back on';
  static const callbackTimeHelp = 'Call back at';

  // ── Link states (StateRail) ──
  static const reconnecting = 'Reconnecting…';
  static const reconnectingMidCall = 'Stay on the line. The customer is still there.';
  static String reconnectWindow(int seconds) =>
      'Your call is held for up to $seconds second${seconds == 1 ? '' : 's'} while we reconnect you.';
  static const reconnectingIdle = 'Stay on this screen — we’re reconnecting you.';
  static const disconnected = 'Disconnected — you are not receiving calls';
  static const disconnectedDetail = 'Reconnect, then go available to start taking calls.';
  static const connectionLost = 'Connection lost';
  static const connectionLostDetail = 'The customer can’t hear you right now. Reconnect to get back on the call.';
  static const reconnect = 'Reconnect';
  static const connecting = 'Opening your station…';

  static const supersededTitle = 'Your station moved to another device';
  static String supersededBody(String campaign) =>
      'You opened ${campaign.trim().isEmpty ? 'this campaign' : campaign} somewhere else. Only one device can take calls at a time.';
  static const supersededNote = 'If a call is live, the customer hears a short gap while it moves.';
  static const useThisPhone = 'Use this phone instead';
  static const backToCampaigns = 'Back to campaigns';

  static const sessionEnded = 'Session ended';
  static const sessionEndedDetail = 'Rejoin the campaign to take calls.';

  static const fatalTitle = 'Can’t open the station';

  static const notHereTitle = 'You’re not at this station';
  static const notHereDetail = 'Start from your campaigns to take calls.';
  static String elsewhereTitle(String campaign) => 'Your station is on $campaign';
  static const openIt = 'Open it';

  // ── Missed release and errors ──
  static String whileAway(String headline) => 'While you were away: $headline';
  static const dismiss = 'Dismiss';

  // ── Leave (agencyStationExit) ──
  static const leaveBlocked = 'Finish this call first — leaving now would cut the customer off.';
  static const leaveTitle = 'Leave this station?';
  static const leaveMessage = 'You’ll stop receiving calls and your station will close.';
  static const leaveAction = 'Leave station';
  static const leaving = 'Leaving…';

  /// "Priya" from "Priya Raman": a button names the person the agent is talking to.
  static String firstName(String name) {
    final parts = name.trim().split(RegExp(r'\s+'));
    return parts.isEmpty ? name : parts.first;
  }
}
