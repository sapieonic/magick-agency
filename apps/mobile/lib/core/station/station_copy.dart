import 'package:agency_wire/agency_wire.dart';
import 'package:meta/meta.dart';

import '../api/api_error.dart';
import 'station_view.dart' show NotesStatus, ReleaseTone;

/// The station's words, kept identical to the console's so both clients speak alike:
/// `stationCopy.ts`, `agencyDncCopy.ts`,
/// `agencyDispositionForm.ts`, `agencyNotes.ts`, `BreakMenu`, `DispositionPad`,
/// `SoftphoneJoinScreen` and the presence/break handlers. Plain, from the
/// agent's side, and never a raw code.

// ─── Release ────────────────────────────────────────────────────────────────

@immutable
final class ReleaseCopy {
  const ReleaseCopy(this.headline, this.subtext, this.tone);
  final String headline;
  final String subtext;
  final ReleaseTone tone;
}

// The station's own words for why a call ended (AS15): keyed on the reason, never the server's
// `message`. The headline is the band's word on What happened?; the subtext one plain sentence.
const Map<ReleaseReason, ReleaseCopy> _releaseCopy = {
  ReleaseReason.completed: ReleaseCopy('What happened?', 'The call ended. Choose what happened.', ReleaseTone.neutral),
  ReleaseReason.agentHangup: ReleaseCopy('What happened?', 'You ended the call.', ReleaseTone.neutral),
  ReleaseReason.remoteHangup: ReleaseCopy('What happened?', 'The customer hung up.', ReleaseTone.neutral),
  ReleaseReason.noAnswer: ReleaseCopy('No answer', 'Nobody picked up. We will try again later.', ReleaseTone.neutral),
  ReleaseReason.busy: ReleaseCopy('Line busy', 'The line was busy. We will try again later.', ReleaseTone.neutral),
  ReleaseReason.failed: ReleaseCopy('Did not connect', 'The call did not go through. We will try again later.', ReleaseTone.neutral),
  ReleaseReason.invalid: ReleaseCopy('Wrong number', 'This number cannot be called. We will not call it again.', ReleaseTone.neutral),
  ReleaseReason.abandoned: ReleaseCopy(
    'Did not connect',
    'The customer picked up, but we could not put them through to you.',
    ReleaseTone.warning,
  ),
  ReleaseReason.agentDisconnected: ReleaseCopy('The call was cut', 'Your internet dropped during the call.', ReleaseTone.danger),
  ReleaseReason.reservationExpired: ReleaseCopy('Did not connect', 'The call went to someone else. You do not need to do anything.', ReleaseTone.neutral),
  ReleaseReason.campaignPaused: ReleaseCopy(
    'Calls stopped',
    'Your supervisor has stopped calls for now.',
    ReleaseTone.warning,
  ),
  ReleaseReason.campaignStopped: ReleaseCopy(
    'Calls ended',
    'Your supervisor has ended calls on this list. You can finish work for today.',
    ReleaseTone.warning,
  ),
  ReleaseReason.supervisorReleased: ReleaseCopy(
    'Your supervisor ended this call',
    'Ask your supervisor if you are not sure why.',
    ReleaseTone.warning,
  ),
  ReleaseReason.orphaned: ReleaseCopy('The call ended', 'Something went wrong on our side. It was not you.', ReleaseTone.neutral),
  ReleaseReason.inboundCall: ReleaseCopy(
    'The customer called us',
    'They called while we were calling them, so this call was stopped. You do not need to do anything.',
    ReleaseTone.neutral,
  ),
};

/// The station's words for a release. A reason this build does not know (expected traffic after a
/// server deploy) gets a plain line, never the server's sentence.
ReleaseCopy releaseCopy(ReleaseReason reason) =>
    _releaseCopy[reason] ?? const ReleaseCopy('The call ended', 'The call ended.', ReleaseTone.neutral);

bool isKnownReleaseReason(ReleaseReason reason) => _releaseCopy.containsKey(reason);

/// A call that ended while the internet was down (`ready.missed_release`), said once it is back:
/// the console's `missedReleaseLine`, one sentence keyed on the reason.
String missedReleaseCopy(ReleaseReason reason) => switch (reason) {
      ReleaseReason.remoteHangup => 'While your internet was down, the customer hung up.',
      ReleaseReason.agentDisconnected => 'While your internet was down, the call was cut.',
      ReleaseReason.noAnswer ||
      ReleaseReason.busy ||
      ReleaseReason.failed ||
      ReleaseReason.invalid ||
      ReleaseReason.abandoned ||
      ReleaseReason.reservationExpired =>
        'While your internet was down, the last call did not connect.',
      _ => 'While your internet was down, the last call ended.',
    };

// ─── States and breaks ──────────────────────────────────────────────────────

const Map<AgentState, String> agentStateLabels = {
  AgentState.offline: 'Offline',
  AgentState.available: 'Available',
  AgentState.reserved: 'Reserved',
  AgentState.onCall: 'On a call',
  AgentState.wrapup: 'Wrapping up',
  AgentState.onBreak: 'On break',
};

String agentStateLabel(AgentState state, [String? raw]) => agentStateLabels[state] ?? (raw ?? 'Unknown');

/// What the agent is doing on another list, in the station's words (the console's `DOING_WORDS`):
/// "You are on Renewals, on a call."
const Map<AgentState, String> joinDoingWords = {
  AgentState.offline: 'not started yet',
  AgentState.available: 'ready for calls',
  AgentState.reserved: 'with a call coming',
  AgentState.onCall: 'on a call',
  AgentState.wrapup: 'choosing what happened',
  AgentState.onBreak: 'on a break',
};

String joinDoing(AgentState state) => joinDoingWords[state] ?? 'working';

/// Labels for the server's reserved break codes, which no campaign lists.
const deviceAwayBreakLabel = 'Away';

/// Mode B's `away_ring`: away, and this phone rings for inbound callers. The app's one label for
/// it, the same as the away notification's title (the console's supervisor floor has its own).
const awayRingBreakLabel = 'Away · this phone rings for inbound calls';
const softPhoneBreakLabel = 'Soft phone';
const phoneCallBreakLabel = 'Phone call';

/// IQ51: the pause for a cellular call did not go through (asked again a few times first).
const phoneCallPauseFailedCopy =
    'We couldn’t pause you for your phone call. Take a break, or a customer may be put through while you’re on it.';

const breakRejectedCopy = 'You cannot take that break now. Choose another.';
const breakFailedCopy = 'The break did not start. Try again.';
const breakAlreadyStartedCopy = 'Your break already started.';
const cancelBreakFailedCopy = 'The break could not be cancelled. Try again.';
const presenceFailedCopy = 'That did not go through. Try again in a moment.';

/// Any action that failed in a way nothing more specific covers.
const actionFailedCopy = 'That did not go through. Try again in a moment.';

/// An action that got no answer: the internet, most likely.
const noInternetCopy = 'That did not go through. Check your internet and try again.';

/// A failed action in the station's words: no internet, an ended sign-in (the app's own line), else
/// [fallback]. Never the server's sentence (AS15): it writes for logs and supervisors.
String stationErrorCopy(Object error, [String fallback = actionFailedCopy]) => switch (error) {
      ApiNetworkError() => noInternetCopy,
      ApiUnauthorized() => error.userMessage,
      _ => fallback,
    };

/// Start calls again (or Ready after a break) refused: `POST /sessions/:id/available`, keyed on the
/// server's code (the console's `presenceRefusedLine`).
String presenceRefusedCopy(String? code) => switch (code) {
      'attempt_not_dispositionable' => 'Save what happened on your last call first.',
      'inbound_call_live' => 'Finish the customer’s call first.',
      'manual_call_live' => 'Finish your call on the soft phone and save it first.',
      'session_ended' || 'no_station' => 'Your work was closed. Open today’s work again.',
      'campaign_not_running' => 'Calls are stopped for this work right now.',
      'state_changing' => 'One moment. Try again.',
      'dial_failed' => 'Calls could not start just now. Try again in a moment.',
      _ => presenceFailedCopy,
    };

/// Save refused, by code (the console's `saveRefusedLine`). The answer the agent chose stays.
String saveRefusedCopy(String? code) => switch (code) {
      'unknown_disposition_code' => 'This list changed. Choose one of these.',
      'note_required' => 'Write a note for this one.',
      'datetime_required' => 'Choose when to call again.',
      'invalid_callback_at' => 'That time has passed. Choose when to call again.',
      'attempt_not_dispositionable' => 'This call was closed, so it cannot be saved now.',
      'already_dispositioned' => 'What happened is already saved for this call.',
      'not_your_attempt' => 'This call has moved on. It is not yours to save.',
      'session_ended' => 'Your work was closed. Open today’s work again.',
      _ => 'Not saved. Try again.',
    };

/// Finish work refused: the work is still open.
const leaveFailedCopy = 'Your work is still open. Try again.';

/// Finish work refused, keyed on the code: a call still on, else [leaveFailedCopy].
String leaveRefusedCopy(String? code) => switch (code) {
      'agent_on_live_call' || 'inbound_call_live' || 'manual_call_live' => 'Finish your call first. Leaving now would cut the customer off.',
      _ => leaveFailedCopy,
    };

// ─── Join ───────────────────────────────────────────────────────────────────

bool conflictIsMidCall(AgentState state) =>
    state == AgentState.reserved || state == AgentState.onCall || state == AgentState.wrapup;

String joinConflictRemedy(String campaignName, AgentState state) => conflictIsMidCall(state)
    ? 'Finish the call on $campaignName first, then come back here.'
    : 'Leave $campaignName first, then come back here.';

enum SwitchStage { resume, leave, rejoin }

/// The one-press switch from another list failed (the console's `switchFailedLine`): reaching that
/// list, leaving it, or opening this one after leaving it. Says what is true now; never the
/// server's sentence.
String switchFailureCopy(SwitchStage stage, String campaignName) => switch (stage) {
      SwitchStage.resume => 'We could not reach $campaignName. Nothing changed. Try again.',
      SwitchStage.leave => '$campaignName is still open. Nothing changed. Try again.',
      SwitchStage.rejoin => 'You left $campaignName, but this work did not open. Go back and open it again.',
    };

/// A server older than the conflict's `session_id` / `account_id`: the app
/// cannot tell which session to leave, or in which account.
String leaveOtherUnknownCopy(String campaignName) =>
    'We cannot close $campaignName from here. Finish work where it is open (the computer or your other phone), then come back here.';

/// Why today's work did not open (`POST /sessions` refused or failed), keyed on the server's code,
/// then its status; never the server's sentence (AS15; the console's `joinRefusedLine`).
/// [placeName] is the other account a `session_in_other_tenant` refusal names, a name and not a
/// sentence. [status] null: no answer (no internet).
String joinRefusedCopy({String? code, int? status, String? placeName}) {
  final place = placeName?.trim();
  switch (code) {
    case 'not_staffed':
      return notStaffedCopy;
    case 'session_in_other_tenant':
      return place != null && place.isNotEmpty
          ? 'You are working in $place. Finish work there first, then come back here.'
          : 'You are working in another account. Finish work there first, then come back here.';
    case 'session_on_other_campaign':
      return 'You are working on another list. Finish work there first, then come back here.';
    case 'feature_disabled':
      return featureDisabledCopy;
    case 'account_scope_required':
      return 'Open your work again from your home screen.';
    case 'station_token_unavailable' || 'dial_failed':
      return 'Calls could not start just now. Go back and try again in a moment.';
    case 'campaign_not_running':
      return 'Calls are stopped for this work right now. Ask your supervisor.';
  }
  if (status == 404) return 'This work was not found. Ask your supervisor.';
  if (status == 403) return 'You cannot open this work. Ask your supervisor.';
  if (status == null) return 'Check your internet. Then go back and try again.';
  return joinFailedCopy;
}

const notStaffedCopy = 'You are not on this work. Ask your supervisor to add you.';
const featureDisabledCopy = 'Calls are turned off for your team. Ask your supervisor.';
const joinFailedCopy = 'We could not open your work just now. Go back and try again.';

/// OS3: the station is open on another device, and this phone did not take it (an automatic
/// resume). [holder] is the app that last attached it.
String stationOnOtherDeviceCopy(ClientKind? holder) => switch (holder) {
      ClientKind.web => 'Your work is open on a computer. Work there, or press Start work to bring it to this phone.',
      ClientKind.mobile => 'Your work is open on another phone. Work there, or press Start work to bring it to this phone.',
      _ => 'Your work is open on another device. Work there, or press Start work to bring it to this phone.',
    };

const softphoneCallPendingCopy = 'Your soft phone has a call that is not finished. Hang up and save it there, then come back.';

const softphoneStillOpenCopy = 'Your soft phone is still open. Try again.';

const softphoneJoinFailedCopy = 'The soft phone is closed, but your work did not open. Go back and open it again.';

// ─── The soft phone, as the session host says it ────────────────────────────

/// The on-duty notification of a soft-phone session (Android), and its lines
/// for either kind of session while on the soft phone.
const softphoneNotificationTitle = 'Soft phone';
const softphoneReadyNotificationText = 'Ready to dial';
const softphoneCallingNotificationText = 'Calling…';
const softphoneOnCallNotificationText = 'On a call';
const softphoneOutcomeNotificationText = 'Outcome needed';

/// The console's `SOFTPHONE_REFUSAL_COPY` lines the host's own actions can meet.
const softphoneManualCallLiveCopy = 'Finish this call and save its outcome first.';
const softphoneOutcomePendingCopy = 'Save the outcome of your last call before you dial again.';
const softphoneDisabledCopy = 'The soft phone is turned off for this account. Ask your supervisor.';

/// `dial_failed` on the switch or the return: the agent state store did not
/// take the write, and nothing was being dialled (the console's `status` context).
const softphoneStatusFailedCopy = 'Couldn’t change your status just now; nothing changed. Try again.';

/// The switch, cancel or return asked of something that is not a campaign station here.
const softphoneNoStationCopy = 'That works only at a campaign station on this phone.';

/// Reopening a soft-phone session the server ended found the agent elsewhere.
const softphoneOnCampaignCopy = 'You’re still at a campaign station.';
const softphoneElsewhereCopy = 'Your soft phone is open in another account.';

/// A queued switch the agent tried to withdraw had already applied.
const softphoneSwitchAlreadyAppliedCopy = 'You’re already on the soft phone.';

/// The line for a refused switch to the soft phone, its withdrawal or the
/// return to the campaign: ours for the codes whose meaning the status context
/// fixes, else the server's sentence, else a plain retry.
String softphoneStatusRefusalCopy(SoftphoneErrorCode code, String? serverSentence) => switch (code) {
      SoftphoneErrorCode.dialFailed => softphoneStatusFailedCopy,
      SoftphoneErrorCode.manualCallLive => softphoneManualCallLiveCopy,
      SoftphoneErrorCode.outcomePending => softphoneOutcomePendingCopy,
      SoftphoneErrorCode.softphoneDisabled => softphoneDisabledCopy,
      _ => serverSentence ?? actionFailedCopy,
    };

// ─── Call actions ───────────────────────────────────────────────────────────

/// End call refused or failed: `POST /attempts/:id/hangup`, keyed on the code (the console's
/// `hangupFailedLine`). The call is still on.
String hangupFailureCopy(Object error) {
  final code = error is ApiHttpError ? error.code : null;
  if (code == AgencyErrorCode.notYourAttempt.wire) return 'This call has moved on. You cannot end it from here.';
  if (code == AgencyErrorCode.attemptNotLive.wire) return 'We cannot end this call from here. Ask the customer to hang up.';
  if (error is ApiNetworkError) return 'The call did not end. Check your internet. You are still on the call.';
  return 'The call did not end. You are still on the call. Try again.';
}

/// Don't call again refused or failed, keyed on the code (the console's `dncFailedLine`). Nothing
/// was changed.
String dncFailureCopy(Object error) {
  final code = error is ApiHttpError ? error.code : null;
  if (code == AgencyErrorCode.notYourAttempt.wire) return 'This call has moved on. Nothing was changed.';
  if (code == 'unknown_attempt') return 'That call has already ended. Nothing was changed.';
  return 'That did not go through. Nothing was changed. Try again.';
}

/// Don't call again went through (campaign scope only: the agent role cannot reach the
/// workspace-wide list). In the station's words, and never the number (AS9: the campaign may mask
/// it): the console's `dncDoneLine`. [recorded] false: the number could not go on the list, so
/// only this customer is stopped and a supervisor should check the number.
String dncDoneCopy({required bool recorded}) => recorded
    ? 'Done. We will not call this number again.'
    : 'We will not call this customer again from this list. Ask your supervisor to check the number.';

String dncOutcomeCopy(DncResponse response) => dncDoneCopy(recorded: response.dncRecorded);

/// A saved outcome that stops calling (DS8) whose number could not go on the list
/// (`dnc_recorded: false`): only this customer is stopped (the console's `savedLine` tail).
const suppressOutcomeNotListedCopy = 'We will not call this customer again. Ask your supervisor to check the number.';

const dncNeedsCallCopy = 'You can do this on a call, or while you choose what happened.';

/// Mark DNC confirmed for a call that is no longer the live one.
const dncCallChangedCopy = 'That call has ended. Nothing was marked.';

// ─── The station link ───────────────────────────────────────────────────────

/// 1008: the server refuses this app's station connection outright.
const upgradeRefusedCopy =
    'This version of the app can’t connect to the station any more. Update the app, then go on duty again.';

/// Leave with no connection: the station was closed on this phone only.
const leftOfflineCopy =
    'You’ve left the station on this phone. You’re offline, so the server will take you off duty on its own in a few seconds.';

// ─── Disposition ────────────────────────────────────────────────────────────

enum DispositionBlock {
  noSelection,
  noteRequired,
  datetimeRequired,
  callbackInPast,
  promiseRequired,
  promiseDateInvalid,
  promiseAmountInvalid,
}

const Map<DispositionBlock, String> dispositionBlockCopy = {
  DispositionBlock.noSelection: 'Pick a disposition to save this call.',
  DispositionBlock.noteRequired: 'This disposition needs a note.',
  DispositionBlock.datetimeRequired: 'This disposition needs a callback time.',
  DispositionBlock.callbackInPast: 'That time has already passed. Pick when we should call back.',
  DispositionBlock.promiseRequired: 'This outcome needs the date the customer promised to pay.',
  DispositionBlock.promiseDateInvalid: 'Pick a promised date from today up to 30 days ahead.',
  DispositionBlock.promiseAmountInvalid: 'Enter the amount as a number, with up to two decimal places and no commas.',
};

const catalogChangedCopy = "This campaign's outcomes changed. Pick one of these.";
const dispositionLostCopy = "The last call's disposition wasn't saved.";
const noCallForDispositionCopy = 'There is no call to save an outcome for.';

// ─── Wrap-up redial ─────────────────────────────────────────────────────────

const redialNotAllowedCopy = 'You cannot call this number again now. Choose what happened.';
const redialLimitReachedCopy = 'No more tries left for this number. Choose what happened.';
const redialAlreadySavedCopy = 'What happened is already saved for this call.';
const redialBlockedDncCopy = 'We must not call this number. Choose what happened.';
const redialBlockedHoursCopy = 'It is too late or too early to call this customer. Choose what happened.';
const redialFailedCopy = 'That did not go through. Try again, or choose what happened.';

/// No usable answer to the redial (no network, a timeout, a server error): it may have been
/// placed all the same, so this never says it failed. The console's words.
const redialUncertainCopy = 'No answer yet. The call may still start. If it does not, try again or choose what happened.';

/// The redial was placed, and its call has not reached the phone in time.
const redialNotArrivedCopy = 'The call has not come through yet. If no call starts, choose what happened.';

/// The Redial was for a wrap-up that is no longer the one on screen.
const redialCallChangedCopy = 'That call has moved on. Nothing was called.';

/// Why a redial was refused (`POST /sessions/:id/redial`), keyed on the code (the console's
/// `redialRefusedLine`); never the server's sentence (AS15).
String redialRefusalCopy(AgencyErrorCode? code) => switch (code) {
      AgencyErrorCode.redialNotAllowed || AgencyErrorCode.redialBlocked => redialNotAllowedCopy,
      AgencyErrorCode.redialLimitReached => redialLimitReachedCopy,
      AgencyErrorCode.dispositionAlreadySubmitted || AgencyErrorCode.alreadyDispositioned => redialAlreadySavedCopy,
      AgencyErrorCode.redialBlockedDnc => redialBlockedDncCopy,
      AgencyErrorCode.redialBlockedCallingHours => redialBlockedHoursCopy,
      _ => redialFailedCopy,
    };

String alreadyRecordedCopy(String? label) =>
    label != null ? 'This call is already recorded as $label.' : 'This call already has a different outcome recorded.';

/// `snake_case` → "Snake case", for a code the catalog has no label for.
String humaniseCode(String code) {
  final spaced = code.replaceAll(RegExp(r'[_-]+'), ' ').replaceAll(RegExp(r'\s+'), ' ').trim();
  if (spaced.isEmpty) return code;
  return spaced[0].toUpperCase() + spaced.substring(1);
}

// ─── Notes ──────────────────────────────────────────────────────────────────

/// The notes status line. `saved` is "Saved HH:mm" and needs the time, so the
/// UI formats it; everything else is here.
const Map<NotesStatus, String> notesStatusCopy = {
  NotesStatus.idle: 'Notes save as you type.',
  NotesStatus.saving: 'Saving…',
  NotesStatus.retrying: 'Not saved yet — trying again. Still on this device.',
  NotesStatus.failed: 'Not saved to the server. Still on this device — keep the app open.',
  NotesStatus.closed: 'Notes are closed for this call.',
};

// ─── Lifecycle notifications ────────────────────────────────────────────────

const pausedNotificationTitle = 'You’re paused';
const pausedNotificationBody = "You're paused. Open the app to take calls again.";

/// Paused on leaving the app, though ringing is on for this phone: it won't ring, and [why].
String pausedNoRingBody(String why) => 'You’re paused, and this phone won’t ring for inbound calls: $why. Open the app to take calls again.';

/// "Stop ringing" on the away notification (this absence only).
const pausedRingingStoppedBody = 'Ringing stopped. You’re paused. Open the app to take calls again.';
const wrapupNotificationTitle = 'Wrap-up';

/// The owed-outcome notice for a soft-phone call (its body is [wrapupNotificationBody]'s).
const softphoneOutcomeNotificationTitle = 'Soft phone · outcome needed';
String wrapupNotificationBody(String hhmm) => 'Save the outcome by $hhmm';
