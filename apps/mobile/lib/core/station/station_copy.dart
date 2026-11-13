import 'package:agency_wire/agency_wire.dart';
import 'package:meta/meta.dart';

import '../api/api_error.dart';
import 'station_view.dart' show NotesStatus, ReleaseTone;

/// The station's words, kept identical to the console's so both clients speak alike:
/// `agencyReleaseCopy.ts`, `agencyJoinConflict.ts`, `agencyDncCopy.ts`,
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

const Map<ReleaseReason, ReleaseCopy> _releaseCopy = {
  ReleaseReason.completed: ReleaseCopy('Wrap-up', 'Call ended. Pick a disposition.', ReleaseTone.neutral),
  ReleaseReason.agentHangup: ReleaseCopy('Wrap-up', 'You ended the call.', ReleaseTone.neutral),
  ReleaseReason.remoteHangup: ReleaseCopy('Wrap-up', 'The customer hung up.', ReleaseTone.neutral),
  ReleaseReason.noAnswer: ReleaseCopy('No answer', "Nobody picked up. We'll try again later.", ReleaseTone.neutral),
  ReleaseReason.busy: ReleaseCopy('Line busy', "The line was engaged. We'll try again later.", ReleaseTone.neutral),
  ReleaseReason.failed:
      ReleaseCopy("Couldn't connect", "The call didn't go through. We'll try again later.", ReleaseTone.neutral),
  ReleaseReason.invalid: ReleaseCopy(
    'Number not usable',
    "This number can't be dialled, so it's been taken off the list.",
    ReleaseTone.neutral,
  ),
  ReleaseReason.abandoned: ReleaseCopy(
    'Call dropped before you got it',
    "The customer answered but we couldn't connect you. This is logged.",
    ReleaseTone.warning,
  ),
  ReleaseReason.agentDisconnected: ReleaseCopy(
    'Call lost — your connection dropped',
    "Check your network. You'll need to go available again.",
    ReleaseTone.danger,
  ),
  ReleaseReason.reservationExpired: ReleaseCopy(
    'Call released',
    'The call was reassigned before it went out. Nothing to do.',
    ReleaseTone.neutral,
  ),
  ReleaseReason.campaignPaused: ReleaseCopy(
    'Campaign paused',
    'A supervisor paused the campaign. No new calls for now.',
    ReleaseTone.warning,
  ),
  ReleaseReason.campaignStopped: ReleaseCopy(
    'Campaign stopped',
    'This campaign has finished. You can leave the station.',
    ReleaseTone.warning,
  ),
  ReleaseReason.supervisorReleased: ReleaseCopy(
    'A supervisor ended this call',
    "The call was taken off you. Ask your supervisor if you're unsure.",
    ReleaseTone.warning,
  ),
  ReleaseReason.orphaned: ReleaseCopy(
    'Call recovered',
    'Something went wrong on our side and the call was cleaned up. Nothing you did.',
    ReleaseTone.neutral,
  ),
  ReleaseReason.inboundCall: ReleaseCopy(
    'The customer rang us',
    'They called in while we were ringing them, so this call was cancelled. Nothing to do.',
    ReleaseTone.neutral,
  ),
};

/// Copy for a release, falling back to the server's own sentence for a reason
/// this build does not know (expected traffic after a server deploy).
ReleaseCopy releaseCopy(ReleaseReason reason, String message) =>
    _releaseCopy[reason] ??
    ReleaseCopy('Call ended', message.trim().isEmpty ? 'The call ended.' : message.trim(), ReleaseTone.neutral);

bool isKnownReleaseReason(ReleaseReason reason) => _releaseCopy.containsKey(reason);

/// The one-line account of a release no wrap-up explained: the server's sentence.
String releaseAccount(String message) => message.trim().isEmpty ? 'The call ended.' : message.trim();

/// Prefix for a release the socket was away for.
const missedReleasePrefix = 'While you were away';

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

const breakRejectedCopy = 'That break reason is no longer available. Pick another.';
const breakFailedCopy = 'That break could not be started.';
const breakAlreadyStartedCopy = 'Your break already started.';
const cancelBreakFailedCopy = "Couldn't cancel. Try again.";
const presenceFailedCopy = 'That didn’t go through. Try again in a moment.';

/// Any action that failed in a way nothing more specific covers.
const actionFailedCopy = 'That didn’t go through. Try again in a moment.';

// ─── Join ───────────────────────────────────────────────────────────────────

bool conflictIsMidCall(AgentState state) =>
    state == AgentState.reserved || state == AgentState.onCall || state == AgentState.wrapup;

String joinConflictRemedy(String campaignName, AgentState state) => conflictIsMidCall(state)
    ? 'Finish what you’re doing on $campaignName, leave that station, then come back here.'
    : 'Leave $campaignName first, then come back here.';

enum SwitchStage { resume, leave, rejoin }

String switchFailureCopy(SwitchStage stage, String campaignName, String? detail) => switch (stage) {
      SwitchStage.resume => detail != null
          ? 'Couldn’t reach $campaignName to leave it — $detail'
          : 'Couldn’t reach $campaignName to leave it. Try again.',
      SwitchStage.leave => detail != null ? '$campaignName is still open — $detail' : '$campaignName is still open. Try again.',
      SwitchStage.rejoin => detail != null
          ? 'Left $campaignName, but couldn’t join this campaign — $detail'
          : 'Left $campaignName, but couldn’t join this campaign. Try again.',
    };

/// A server older than the conflict's `session_id` / `account_id`: the app
/// cannot tell which session to leave, or in which account.
String leaveOtherUnknownCopy(String campaignName) =>
    'We can’t close $campaignName from here. Leave it where it’s open (the console or your other phone), then come back here.';

const notStaffedCopy = 'You’re not on this campaign’s team. Ask your supervisor to add you.';
const featureDisabledCopy = 'Calling is switched off for your organisation right now. Ask your supervisor.';
const joinFailedCopy = 'Could not join the campaign.';

/// OS3: the station is open on another device, and this phone did not take it (an automatic
/// resume). [holder] is the app that last attached it.
String stationOnOtherDeviceCopy(ClientKind? holder) => switch (holder) {
      ClientKind.web => 'Your station is open in the console. Use it there, or go on duty here to move it to this phone.',
      ClientKind.mobile => 'Your station is open on another phone. Use it there, or go on duty here to move it to this phone.',
      _ => 'Your station is open on another device. Use it there, or go on duty here to move it to this phone.',
    };

/// OS1: the agent is live in another organisation; nothing here can end it.
const sessionInOtherTenantCopy =
    'You’re live in another organisation. Leave your station there first: you can be on only one station at a time.';

const softphoneCallPendingCopy =
    'Your soft phone has a call that isn’t finished. Hang up and save its outcome there, then come back to join.';

String softphoneStillOpenCopy(String? detail) =>
    detail != null && detail.isNotEmpty ? 'Your soft phone is still open — $detail' : 'Your soft phone is still open. Try again.';

String softphoneJoinFailedCopy(String? detail) => detail != null && detail.isNotEmpty
    ? 'Closed the soft phone, but couldn’t join this campaign — $detail'
    : 'Closed the soft phone, but couldn’t join this campaign. Try again.';

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

/// The human detail of a failure, or null when there is none worth quoting.
String? errorDetail(Object error) => switch (error) {
      ApiHttpError(:final message) when message.isNotEmpty => message,
      ApiError() => error.userMessage,
      _ => null,
    };

String hangupFailureCopy(Object error) {
  final code = error is ApiHttpError ? error.code : null;
  if (code == AgencyErrorCode.notYourAttempt.wire) return 'This call has moved on — it isn’t yours to end any more.';
  if (code == AgencyErrorCode.attemptNotLive.wire) {
    return 'We can’t reach this call to end it. Ask the customer to hang up, then use Wrap-up.';
  }
  final detail = errorDetail(error);
  return detail != null ? 'Couldn’t end the call: $detail. You are still connected.' : 'Couldn’t end the call. You are still connected.';
}

String dncFailureCopy(Object error) {
  final code = error is ApiHttpError ? error.code : null;
  if (code == AgencyErrorCode.notYourAttempt.wire) return 'This call has moved on — it isn’t yours to mark any more.';
  if (code == 'unknown_attempt') return 'That call has already ended. Nothing was marked.';
  final detail = errorDetail(error);
  return detail != null ? 'Couldn’t mark Do Not Call: $detail' : 'Couldn’t mark Do Not Call. Nothing was changed.';
}

/// Campaign scope only: the agent role cannot reach the workspace-wide list.
String dncOutcomeCopy(DncResponse response) => response.dncRecorded
    ? '${response.phoneE164} won’t be dialled again by this campaign. It’s on this campaign’s Do Not Call list.'
    : '${response.phoneE164} won’t be dialled again by this campaign’s current contacts. We’re still adding it to '
        'this campaign’s Do Not Call list — until that lands a new upload could bring the number back, so check the list.';

const dncNeedsCallCopy = 'Available while you are on a call';

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

enum DispositionBlock { noSelection, noteRequired, datetimeRequired, callbackInPast }

const Map<DispositionBlock, String> dispositionBlockCopy = {
  DispositionBlock.noSelection: 'Pick a disposition to save this call.',
  DispositionBlock.noteRequired: 'This disposition needs a note.',
  DispositionBlock.datetimeRequired: 'This disposition needs a callback time.',
  DispositionBlock.callbackInPast: 'That time has already passed. Pick when we should call back.',
};

const catalogChangedCopy = "This campaign's outcomes changed. Pick one of these.";
const dispositionFailedCopy = 'That disposition could not be saved.';
const dispositionLostCopy = "The last call's disposition wasn't saved.";
const noCallForDispositionCopy = 'There is no call to save an outcome for.';

// ─── Wrap-up redial ─────────────────────────────────────────────────────────

const redialNotAllowedCopy = 'Redial isn’t available for this call. Save the outcome.';
const redialLimitReachedCopy = 'You’ve used all the redials for this call. Save the outcome.';
const redialAlreadySavedCopy = 'This call’s outcome is already saved, so it can’t be redialled.';
const redialBlockedDncCopy = 'This number is on a Do Not Call list, so it can’t be redialled. Save the outcome.';
const redialBlockedHoursCopy =
    'It’s outside this customer’s calling hours, so they can’t be redialled now. Save the outcome.';
const redialFailedCopy = 'Couldn’t redial this customer. Save the outcome, or try again.';

/// No usable answer to the redial (no network, a timeout, a server error): it
/// may have been placed all the same, so this never says it failed. The
/// console's words.
const redialUncertainCopy =
    'No answer from the server, so the redial may still go through. If no call starts, try again or save the outcome.';

/// The redial was placed, and its call has not reached the station in time.
const redialNotArrivedCopy = 'The redial hasn’t reached your station yet. If no call starts, save the outcome.';

/// The Redial was for a wrap-up that is no longer the one on screen.
const redialCallChangedCopy = 'That call has moved on. Nothing was redialled.';

/// Why a redial was refused (`POST /sessions/:id/redial`). Ours for the codes
/// whose meaning is fixed; the server's sentence for `redial_blocked` (it says
/// which check failed) and anything else; a plain line when it sent none.
String redialRefusalCopy(AgencyErrorCode? code, String? serverSentence) => switch (code) {
      AgencyErrorCode.redialNotAllowed => redialNotAllowedCopy,
      AgencyErrorCode.redialLimitReached => redialLimitReachedCopy,
      AgencyErrorCode.dispositionAlreadySubmitted || AgencyErrorCode.alreadyDispositioned => redialAlreadySavedCopy,
      AgencyErrorCode.redialBlockedDnc => redialBlockedDncCopy,
      AgencyErrorCode.redialBlockedCallingHours => redialBlockedHoursCopy,
      AgencyErrorCode.redialBlocked => serverSentence ?? redialFailedCopy,
      _ => serverSentence ?? redialFailedCopy,
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

const notesChangedElsewhereCopy = 'These notes were also changed elsewhere.';

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
