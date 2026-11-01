import 'package:collection/collection.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

/// The station as the screens see it: the seam between the station core
/// (socket, reducer, audio, lifecycle) and the station UI.
///
/// The core turns wire frames into a [StationView]; the UI renders it and
/// calls [StationActions]. Nothing here depends on `agency_wire`, so the UI is
/// built and tested against plain values. Every type is immutable with value
/// equality, so `ref.watch(stationViewProvider.select(...))` rebuilds a widget
/// only when its slice actually changed.
///
/// Times are already on the SERVER clock mapped to this device (the core
/// applies the pong offset), so the UI can compare them to `DateTime.now()`.

/// The socket, from the agent's side.
enum StationLink {
  /// Joining the campaign / opening the socket for the first time.
  connecting,
  open,

  /// Lost and retrying. Mid-call the server holds the call for [StationView.reconnectDeadline].
  reconnecting,

  /// Gave up retrying; the agent can press Reconnect.
  disconnected,

  /// 4409: another device or window took this station.
  superseded,

  /// 4404 or the session was left: rejoin the campaign.
  sessionGone,
}

/// The agent's state, as the server's `agent_state` frames state it.
enum AgentPhase { offline, available, reserved, onCall, wrapup, onBreak }

enum ReleaseTone { neutral, warning, danger }

@immutable
class BreakOption {
  const BreakOption({required this.code, required this.label});
  final String code;
  final String label;

  @override
  bool operator ==(Object other) => other is BreakOption && other.code == code && other.label == label;
  @override
  int get hashCode => Object.hash(code, label);
}

/// The break the agent is on, or has queued for after this call.
@immutable
class BreakInfo {
  const BreakInfo({required this.code, required this.label, this.since});

  final String code;
  final String label;

  /// When the break started (null for a queued break).
  final DateTime? since;

  /// The reserved `device_away` break: the app paused the agent because it
  /// left the foreground. The UI shows "Paused · you left the app", not a break.
  bool get isDeviceAway => code == 'device_away';

  @override
  bool operator ==(Object other) => other is BreakInfo && other.code == code && other.label == label && other.since == since;
  @override
  int get hashCode => Object.hash(code, label, since);
}

/// One contact field for the screen pop.
@immutable
class ContactField {
  const ContactField({required this.key, required this.label, required this.value});
  final String key;
  final String label;

  /// Display text; empty when the roster had no value.
  final String value;

  @override
  bool operator ==(Object other) => other is ContactField && other.key == key && other.label == label && other.value == value;
  @override
  int get hashCode => Object.hash(key, label, value);
}

@immutable
class PriorAttempt {
  const PriorAttempt({required this.at, required this.outcomeLabel, this.notes, this.sameCampaign = true, this.campaignName});
  final DateTime at;
  final String outcomeLabel;
  final String? notes;
  final bool sameCampaign;
  final String? campaignName;

  @override
  bool operator ==(Object other) =>
      other is PriorAttempt &&
      other.at == at &&
      other.outcomeLabel == outcomeLabel &&
      other.notes == notes &&
      other.sameCampaign == sameCampaign &&
      other.campaignName == campaignName;
  @override
  int get hashCode => Object.hash(at, outcomeLabel, notes, sameCampaign, campaignName);
}

/// The call on screen: from `reserved` until the agent leaves wrap-up.
@immutable
class CallView {
  const CallView({
    required this.attemptId,
    required this.phoneE164,
    required this.attemptNumber,
    required this.callerId,
    required this.campaignName,
    required this.heroFields,
    required this.heroesConfigured,
    required this.otherFields,
    required this.priorAttempts,
    this.displayName,
    this.countdownSeconds,
    this.bridgedAt,
    this.recording = false,
  });

  final String attemptId;
  final String phoneE164;
  final int attemptNumber;
  final String callerId;
  final String campaignName;

  /// Best guess at the person's name for the headline (a hero field that
  /// looks like a name), else null and the UI leads with the number.
  final String? displayName;

  /// Up to four pinned fields (`context_display.hero`, else a heuristic).
  final List<ContactField> heroFields;

  /// False when the heroes were guessed: the UI says "auto-selected".
  final bool heroesConfigured;

  /// The rest, in `order` then roster order, minus hidden ones.
  final List<ContactField> otherFields;
  final List<PriorAttempt> priorAttempts;

  /// The 3-2-1 before the dial connects (early binding only), else null.
  final int? countdownSeconds;

  /// Set once the customer is on the line; the talk timer counts from it.
  final DateTime? bridgedAt;
  final bool recording;

  bool get isBridged => bridgedAt != null;

  static const _eq = ListEquality<Object>();

  @override
  bool operator ==(Object other) =>
      other is CallView &&
      other.attemptId == attemptId &&
      other.phoneE164 == phoneE164 &&
      other.attemptNumber == attemptNumber &&
      other.callerId == callerId &&
      other.campaignName == campaignName &&
      other.displayName == displayName &&
      other.heroesConfigured == heroesConfigured &&
      _eq.equals(other.heroFields, heroFields) &&
      _eq.equals(other.otherFields, otherFields) &&
      _eq.equals(other.priorAttempts, priorAttempts) &&
      other.countdownSeconds == countdownSeconds &&
      other.bridgedAt == bridgedAt &&
      other.recording == recording;

  @override
  int get hashCode => Object.hash(attemptId, countdownSeconds, bridgedAt, recording, heroFields.length, otherFields.length);
}

/// Why the last call ended, in the console's words (`agencyReleaseCopy.ts`).
@immutable
class ReleaseView {
  const ReleaseView({required this.headline, required this.detail, required this.tone, required this.requiresDisposition});
  final String headline;
  final String detail;
  final ReleaseTone tone;
  final bool requiresDisposition;

  @override
  bool operator ==(Object other) =>
      other is ReleaseView && other.headline == headline && other.detail == detail && other.tone == tone && other.requiresDisposition == requiresDisposition;
  @override
  int get hashCode => Object.hash(headline, detail, tone, requiresDisposition);
}

enum WrapupHold { none, dispositionRequired, supervisor }

@immutable
class WrapupView {
  const WrapupView({
    required this.endsAt,
    required this.secondsTotal,
    required this.hold,
    required this.dispositionSubmitted,
    required this.autoReturn,
  });

  /// When wrap-up ends on its own; null when it has no timer (held).
  final DateTime? endsAt;
  final int secondsTotal;
  final WrapupHold hold;
  final bool dispositionSubmitted;
  final bool autoReturn;

  @override
  bool operator ==(Object other) =>
      other is WrapupView &&
      other.endsAt == endsAt &&
      other.secondsTotal == secondsTotal &&
      other.hold == hold &&
      other.dispositionSubmitted == dispositionSubmitted &&
      other.autoReturn == autoReturn;
  @override
  int get hashCode => Object.hash(endsAt, secondsTotal, hold, dispositionSubmitted, autoReturn);
}

/// One outcome on the disposition grid.
@immutable
class DispositionOption {
  const DispositionOption({
    required this.code,
    required this.label,
    this.requiresNote = false,
    this.requiresCallbackTime = false,
    this.isSuccess = false,
    this.suppresses = false,
  });

  final String code;
  final String label;
  final bool requiresNote;
  final bool requiresCallbackTime;
  final bool isSuccess;

  /// Saving it adds the number to Do Not Call.
  final bool suppresses;

  @override
  bool operator ==(Object other) =>
      other is DispositionOption &&
      other.code == code &&
      other.label == label &&
      other.requiresNote == requiresNote &&
      other.requiresCallbackTime == requiresCallbackTime &&
      other.isSuccess == isSuccess &&
      other.suppresses == suppresses;
  @override
  int get hashCode => Object.hash(code, label, requiresNote, requiresCallbackTime, isSuccess, suppresses);
}

enum NotesStatus { idle, saving, saved, retrying, failed, closed }

@immutable
class NotesView {
  const NotesView({this.text = '', this.status = NotesStatus.idle, this.changedElsewhere = false, this.savedAt});
  final String text;
  final NotesStatus status;

  /// When the server last accepted the notes, on this device's clock ("Saved 14:32").
  final DateTime? savedAt;

  /// A supervisor edited the notes on the server since the agent typed.
  final bool changedElsewhere;

  @override
  bool operator ==(Object other) => other is NotesView && other.text == text && other.status == status && other.changedElsewhere == changedElsewhere && other.savedAt == savedAt;
  @override
  int get hashCode => Object.hash(text, status, changedElsewhere, savedAt);
}

enum AudioRouteKind { earpiece, speaker, wired, bluetooth }

@immutable
class AudioRouteOption {
  const AudioRouteOption({required this.id, required this.kind, required this.name});
  final String id;
  final AudioRouteKind kind;

  /// "Phone", "Speaker", or the headset's name ("boAt Airdopes 141").
  final String name;

  @override
  bool operator ==(Object other) => other is AudioRouteOption && other.id == id && other.kind == kind && other.name == name;
  @override
  int get hashCode => Object.hash(id, kind, name);
}

/// [serviceStopped]: Android would not start the on-duty foreground service (the app
/// was in the background at join, or a permission is missing). The microphone works
/// while the app is on screen, but the phone may cut it the moment the agent leaves.
enum MicProblem { none, permissionDenied, noDevice, busy, lost, serviceStopped }

/// Why the phone took the audio away mid-call.
enum AudioInterruption { none, phoneCall, otherApp }

@immutable
class AudioView {
  const AudioView({
    this.muted = false,
    this.route,
    this.routes = const [],
    this.micProblem = MicProblem.none,
    this.interruption = AudioInterruption.none,
  });

  final bool muted;
  final AudioRouteOption? route;
  final List<AudioRouteOption> routes;
  final MicProblem micProblem;
  final AudioInterruption interruption;

  static const _eq = ListEquality<AudioRouteOption>();

  @override
  bool operator ==(Object other) =>
      other is AudioView &&
      other.muted == muted &&
      other.route == route &&
      _eq.equals(other.routes, routes) &&
      other.micProblem == micProblem &&
      other.interruption == interruption;
  @override
  int get hashCode => Object.hash(muted, route, routes.length, micProblem, interruption);
}

/// What happened while the station could not reach the agent ("While you
/// were away: the customer hung up").
@immutable
class MissedReleaseView {
  const MissedReleaseView({required this.headline, required this.detail});
  final String headline;
  final String detail;

  @override
  bool operator ==(Object other) => other is MissedReleaseView && other.headline == headline && other.detail == detail;
  @override
  int get hashCode => Object.hash(headline, detail);
}

/// An action in flight, so its button shows progress and cannot double-fire.
enum StationBusy { none, goingAvailable, takingBreak, cancellingBreak, endingBreak, hangingUp, savingDisposition, markingDnc, leaving }

@immutable
class StationView {
  const StationView({
    required this.campaignId,
    required this.campaignName,
    this.sessionId,
    this.link = StationLink.connecting,
    this.phase = AgentPhase.offline,
    this.phaseSince,
    this.campaignDialing = true,
    this.campaignMessage,
    this.onBreak,
    this.queuedBreak,
    this.breakOptions = const [],
    this.call,
    this.release,
    this.wrapup,
    this.dispositions = const [],
    this.dispositionSaved,
    this.notes = const NotesView(),
    this.audio = const AudioView(),
    this.missedRelease,
    this.reconnectDeadline,
    this.reconnectWindow,
    this.dncOutcome,
    this.weakConnection = false,
    this.busy = StationBusy.none,
    this.actionError,
    this.fatal,
  });

  final String campaignId;
  final String campaignName;
  final String? sessionId;
  final StationLink link;
  final AgentPhase phase;

  /// When [phase] started (break timers, "Available for 01:42").
  final DateTime? phaseSince;

  /// False while the campaign is paused or not dialling: "no calls will come through".
  final bool campaignDialing;
  final String? campaignMessage;

  final BreakInfo? onBreak;
  final BreakInfo? queuedBreak;
  final List<BreakOption> breakOptions;

  final CallView? call;
  final ReleaseView? release;
  final WrapupView? wrapup;
  final List<DispositionOption> dispositions;

  /// The code saved for the call on screen, once the server accepted it.
  final String? dispositionSaved;
  final NotesView notes;
  final AudioView audio;
  final MissedReleaseView? missedRelease;

  /// Mid-call reconnect: the server ends the call if the socket is not back by then.
  final DateTime? reconnectDeadline;

  /// The whole mid-call reconnect window ([reconnectDeadline] minus the drop time), so a
  /// countdown can be drawn to scale. Null with no deadline.
  final Duration? reconnectWindow;

  /// The follow-up line after Mark DNC for the call on screen, in the console's words
  /// (what the server confirmed it recorded). Null until a mark succeeds.
  final String? dncOutcome;

  /// Pings are arriving late (≥ 2 missed): show "Weak connection".
  final bool weakConnection;
  final StationBusy busy;

  /// The last refused action, in the server's or the console's words.
  final String? actionError;

  /// The station cannot open at all (join refused); shown full-screen with a way back.
  final String? fatal;

  /// The call screen must be in front: reserved, on a call or in wrap-up.
  bool get callActive => phase == AgentPhase.reserved || phase == AgentPhase.onCall || phase == AgentPhase.wrapup;

  static const _eqB = ListEquality<BreakOption>();
  static const _eqD = ListEquality<DispositionOption>();

  @override
  bool operator ==(Object other) =>
      other is StationView &&
      other.campaignId == campaignId &&
      other.campaignName == campaignName &&
      other.sessionId == sessionId &&
      other.link == link &&
      other.phase == phase &&
      other.phaseSince == phaseSince &&
      other.campaignDialing == campaignDialing &&
      other.campaignMessage == campaignMessage &&
      other.onBreak == onBreak &&
      other.queuedBreak == queuedBreak &&
      _eqB.equals(other.breakOptions, breakOptions) &&
      other.call == call &&
      other.release == release &&
      other.wrapup == wrapup &&
      _eqD.equals(other.dispositions, dispositions) &&
      other.dispositionSaved == dispositionSaved &&
      other.notes == notes &&
      other.audio == audio &&
      other.missedRelease == missedRelease &&
      other.reconnectDeadline == reconnectDeadline &&
      other.reconnectWindow == reconnectWindow &&
      other.dncOutcome == dncOutcome &&
      other.weakConnection == weakConnection &&
      other.busy == busy &&
      other.actionError == actionError &&
      other.fatal == fatal;

  @override
  int get hashCode => Object.hashAll([campaignId, sessionId, link, phase, phaseSince, call, wrapup, busy, audio, notes, actionError]);
}

/// Everything the station screens can ask for. Each returns when the server
/// answered; refusals land in [StationView.actionError] (and the future
/// completes normally), so a screen never needs try/catch for expected cases.
abstract interface class StationActions {
  Future<void> goAvailable();
  Future<void> takeBreak(String code);
  Future<void> cancelQueuedBreak();
  Future<void> endBreak();
  Future<void> hangUp();
  Future<void> setMuted(bool muted);
  Future<void> setRoute(AudioRouteOption route);

  /// Debounced and saved by the core; call on every keystroke.
  void updateNotes(String text);
  Future<void> submitDisposition(String code, {String? notes, DateTime? callbackAt});
  Future<void> markDnc({String? reason});
  Future<void> leave();
  Future<void> reconnect();

  /// After 4409: take the station back on this device.
  Future<void> useThisDevice();
  void dismissActionError();
  void dismissMissedRelease();
}

/// How starting a station ended. The preflight screen shows the conflicts as
/// choices ("Leave X and join here") and the rest as a message.
sealed class StationStart {
  const StationStart();
}

final class StationStarted extends StationStart {
  const StationStarted();
}

/// `409 session_on_other_campaign`: live on another campaign (maybe in a
/// sibling account). [canLeave] is false while a call is live there.
@immutable
final class StationElsewhere extends StationStart {
  const StationElsewhere({
    required this.sessionId,
    required this.campaignId,
    required this.campaignName,
    required this.stateLabel,
    required this.canLeave,
    this.accountId,
    this.accountName,
  });
  final String sessionId;
  final String campaignId;
  final String campaignName;
  final String stateLabel;
  final bool canLeave;
  final String? accountId;
  final String? accountName;
}

/// `409 session_on_softphone`: the soft phone is open (the app has no soft
/// phone in v1, so the agent closes it here or on the web).
@immutable
final class StationOnSoftphone extends StationStart {
  const StationOnSoftphone({required this.sessionId, this.accountId, this.accountName});
  final String sessionId;
  final String? accountId;
  final String? accountName;
}

/// Anything else that stops the station opening (`not_staffed`, a paused or
/// stopped campaign, the dialer switched off, offline), in words for the agent.
@immutable
final class StationRefused extends StationStart {
  const StationRefused(this.message, {this.code});
  final String message;
  final String? code;
}

/// Opens and closes stations. Separate from [StationActions] because it is
/// used before a station exists (the preflight screen's "Go on duty").
abstract interface class StationLauncher {
  /// Joins (or rehydrates) the campaign's session, starts the on-duty
  /// foreground service and the audio pre-warm, and opens the socket.
  Future<StationStart> start(String campaignId, {required String campaignName});

  /// Leaves [other] (refused while a call is live there), then starts.
  Future<StationStart> leaveOtherAndStart(StationElsewhere other, String campaignId, {required String campaignName});

  /// Closes the agent's soft-phone session (refused, as a [StationRefused] in the
  /// console's words, while it has an unsettled call), then starts.
  Future<StationStart> closeSoftphoneAndStart(StationOnSoftphone softphone, String campaignId, {required String campaignName});
}

final stationLauncherProvider = Provider<StationLauncher>(
  (ref) => throw UnimplementedError('stationLauncherProvider is provided by the station core'),
);

/// The live station, or null when the agent is not at one. Overridden by the
/// station core.
final stationViewProvider = Provider<StationView?>((ref) => null);

final stationActionsProvider = Provider<StationActions>(
  (ref) => throw UnimplementedError('stationActionsProvider is provided by the station core'),
);
