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
  /// Mode B's `away_ring` is the same pause, with this phone rung for inbound callers.
  bool get isDeviceAway => code == 'device_away' || isAwayRing;

  /// Mode B's `away_ring`: paused because they left the app, and this phone rings for inbound
  /// callers meanwhile.
  bool get isAwayRing => code == 'away_ring';

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
    this.redialNumber,
    this.redialLimit,
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

  /// Set when this call is a wrap-up redial: which one ([redialNumber], 1 or
  /// 2) out of how many the call allows ([redialLimit]): "Redial 1 of 2".
  final int? redialNumber;
  final int? redialLimit;

  bool get isBridged => bridgedAt != null;
  bool get isRedial => redialNumber != null;

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
      other.recording == recording &&
      other.redialNumber == redialNumber &&
      other.redialLimit == redialLimit;

  @override
  int get hashCode =>
      Object.hash(attemptId, countdownSeconds, bridgedAt, recording, heroFields.length, otherFields.length, redialNumber);
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
    this.redialRemaining,
  });

  /// When wrap-up ends on its own; null when it has no timer (held).
  final DateTime? endsAt;
  final int secondsTotal;
  final WrapupHold hold;
  final bool dispositionSubmitted;
  final bool autoReturn;

  /// Wrap-up redial: null when it is not offered (no Redial button); 0 when
  /// the call's redials are used up (shown, disabled); more: that many left.
  final int? redialRemaining;

  /// The Redial button belongs beside the outcome pad.
  bool get offersRedial => redialRemaining != null;

  @override
  bool operator ==(Object other) =>
      other is WrapupView &&
      other.endsAt == endsAt &&
      other.secondsTotal == secondsTotal &&
      other.hold == hold &&
      other.dispositionSubmitted == dispositionSubmitted &&
      other.autoReturn == autoReturn &&
      other.redialRemaining == redialRemaining;
  @override
  int get hashCode => Object.hash(endsAt, secondsTotal, hold, dispositionSubmitted, autoReturn, redialRemaining);
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

/// Why nothing is due for the agent on a `strict` or `preferred` campaign
/// (contact assignment). [other]: a reason this build does not know.
enum QueueIdle { queueEmpty, waitingForRetry, callbacksLater, outsideCallingHours, other }

/// The agent's own queue on a `strict` or `preferred` campaign: something is
/// due now, or nothing is, why, and when the next contact falls due.
@immutable
class QueueView {
  const QueueView({required this.due, this.reason, this.nextDueAt});

  /// A contact is due for this agent now: the station waits as usual.
  final bool due;

  /// Why nothing is due; null when [due].
  final QueueIdle? reason;

  /// When the next contact falls due, on this device's clock; null when none is scheduled.
  final DateTime? nextDueAt;

  /// "Nothing due now" belongs on the waiting screen.
  bool get nothingDue => !due;

  @override
  bool operator ==(Object other) =>
      other is QueueView && other.due == due && other.reason == reason && other.nextDueAt == nextDueAt;
  @override
  int get hashCode => Object.hash(due, reason, nextDueAt);
}

/// Where an inbound call on the station is (`docs/inbound.md` §6).
enum InboundStage {
  /// Offered: the panel is up, the chime has played, and the caller's audio binds at
  /// [InboundCallView.connectsAt]. Hang up is not offered yet.
  offered,

  /// Connected: audio both ways, the talk timer runs from [InboundCallView.bridgedAt].
  connected,

  /// Ended after it was answered, owing its outcome until [InboundCallView.outcomeDueAt].
  outcome,
}

/// Why the caller is called "your customer", or whose they usually are.
enum InboundSticky { owner, lastFromNumber, lastConnected, lastDialled, other }

/// Where the outcome pad's list comes from.
enum InboundCatalogKind { campaign, route, standard }

/// An inbound caller on the station, from the offer until the outcome is saved (or the call
/// leaves without one). Times are on this device's clock.
@immutable
class InboundCallView {
  const InboundCallView({
    required this.callId,
    required this.stage,
    required this.toE164,
    required this.callerDnc,
    required this.recording,
    required this.waitedSeconds,
    required this.catalogKind,
    this.fromE164,
    this.routeName,
    this.displayName,
    this.sticky,
    this.stickyIsYou = false,
    this.campaignName,
    this.contactState,
    this.heroFields = const [],
    this.heroesConfigured = false,
    this.otherFields = const [],
    this.priorAttempts = const [],
    this.connectsAt,
    this.bridgedAt,
    this.outcomeDueAt,
    this.hangupFailure,
  });

  final String callId;
  final InboundStage stage;

  /// E.164; null when the caller withheld their number.
  final String? fromE164;

  /// The number they rang.
  final String toE164;
  final String? routeName;

  /// The matched contact's name, when the roster has one.
  final String? displayName;

  /// Null: the caller has no agent of their own.
  final InboundSticky? sticky;

  /// The caller's own agent is this one ("Your customer").
  final bool stickyIsYou;

  /// The number is on a Do Not Call list: their own call is an enquiry, taken all the same.
  final bool callerDnc;
  final bool recording;
  final int waitedSeconds;

  /// The matched contact's campaign, or null when the number matched nobody.
  final String? campaignName;

  /// The matched contact's state, in words.
  final String? contactState;

  /// The matched contact, read as the campaign pop reads its contact.
  final List<ContactField> heroFields;
  final bool heroesConfigured;
  final List<ContactField> otherFields;
  final List<PriorAttempt> priorAttempts;
  final InboundCatalogKind catalogKind;

  /// While offered: when the caller's audio binds.
  final DateTime? connectsAt;

  /// Audio both ways from here.
  final DateTime? bridgedAt;

  /// While the outcome is owed: when the call closes without one.
  final DateTime? outcomeDueAt;

  /// A hang-up that did not go through, in words; null otherwise.
  final String? hangupFailure;

  bool get withheld => fromE164 == null;
  bool get matched => campaignName != null;

  static const _eqF = ListEquality<ContactField>();
  static const _eqP = ListEquality<PriorAttempt>();

  @override
  bool operator ==(Object other) =>
      other is InboundCallView &&
      other.callId == callId &&
      other.stage == stage &&
      other.fromE164 == fromE164 &&
      other.toE164 == toE164 &&
      other.routeName == routeName &&
      other.displayName == displayName &&
      other.sticky == sticky &&
      other.stickyIsYou == stickyIsYou &&
      other.callerDnc == callerDnc &&
      other.recording == recording &&
      other.waitedSeconds == waitedSeconds &&
      other.campaignName == campaignName &&
      other.contactState == contactState &&
      _eqF.equals(other.heroFields, heroFields) &&
      other.heroesConfigured == heroesConfigured &&
      _eqF.equals(other.otherFields, otherFields) &&
      _eqP.equals(other.priorAttempts, priorAttempts) &&
      other.catalogKind == catalogKind &&
      other.connectsAt == connectsAt &&
      other.bridgedAt == bridgedAt &&
      other.outcomeDueAt == outcomeDueAt &&
      other.hangupFailure == hangupFailure;

  @override
  int get hashCode => Object.hash(callId, stage, bridgedAt, outcomeDueAt, hangupFailure, heroFields.length);
}

/// "Your customer is waiting": a caller who usually speaks to this agent rang in while they
/// were busy, and is put through to them next.
@immutable
class CustomerWaitingView {
  const CustomerWaitingView({required this.callId, required this.since, this.name, this.fromE164});

  final String callId;

  /// When they started waiting (this device's clock).
  final DateTime since;

  /// The matched contact's name, when known.
  final String? name;

  /// E.164; null when withheld.
  final String? fromE164;

  @override
  bool operator ==(Object other) =>
      other is CustomerWaitingView &&
      other.callId == callId &&
      other.since == since &&
      other.name == name &&
      other.fromE164 == fromE164;
  @override
  int get hashCode => Object.hash(callId, since, name, fromE164);
}

/// An action in flight, so its button shows progress and cannot double-fire.
///
/// [redialing] lasts from the tap until the redial's call reaches the
/// station (or is refused), not only while the request is open: the wrap-up
/// on screen is over once the server placed the call.
enum StationBusy {
  none,
  goingAvailable,
  takingBreak,
  cancellingBreak,
  endingBreak,
  hangingUp,
  savingDisposition,
  markingDnc,
  redialing,
  leaving,
}

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
    this.queue,
    this.myContactsOffered = false,
    this.inbound,
    this.customerWaiting,
    this.inboundNotice,
  });

  final String campaignId;
  final String campaignName;
  final String? sessionId;
  final StationLink link;
  final AgentPhase phase;

  /// When [phase] started (break timers, "Available for 01:42").
  final DateTime? phaseSince;

  /// False while the campaign is paused or not dialling: "no campaign calls for now" (customers
  /// who ring in can still reach the agent: the inbound router does not read campaign status).
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

  /// The agent's own queue (contact assignment): null on a `pool` campaign,
  /// where the waiting screen keeps its usual words.
  final QueueView? queue;

  /// Whether this campaign has a My contacts for the agent (contact
  /// assignment), as the join bootstrap says: it assigns contacts (not
  /// `pool`) or lets agents retry the ones they did not reach. The
  /// console's rule for its header button; the flag is checked on top.
  final bool myContactsOffered;

  /// The inbound caller on the station (offered, on the call, or owing the outcome), or null.
  /// While it is set, [call] is null, and [notes], [dispositions], [dispositionSaved] and
  /// [dncOutcome] are this call's; [phase] follows it (reserved, on a call, wrap-up).
  final InboundCallView? inbound;

  /// "Your customer is waiting", above whatever the station shows.
  final CustomerWaitingView? customerWaiting;

  /// Why an inbound call just left the station without the agent's outcome (the caller hung
  /// up first, it went back to the queue, ...), for 30 s or until the next call.
  final String? inboundNotice;

  /// The call on screen, campaign or inbound: what notes, dialogs and sheets are keyed by.
  String? get callId => call?.attemptId ?? inbound?.callId;

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
      other.fatal == fatal &&
      other.queue == queue &&
      other.myContactsOffered == myContactsOffered &&
      other.inbound == inbound &&
      other.customerWaiting == customerWaiting &&
      other.inboundNotice == inboundNotice;

  @override
  int get hashCode => Object.hashAll([campaignId, sessionId, link, phase, phaseSince, call, wrapup, busy, audio, notes, actionError, queue, inbound]);
}

/// Everything the station screens can ask for. Each returns when the server
/// answered; refusals land in [StationView.actionError] (and the future
/// completes normally), so a screen never needs try/catch for expected cases.
abstract interface class StationActions {
  Future<void> goAvailable();
  Future<void> takeBreak(String code);
  Future<void> cancelQueuedBreak();
  Future<void> endBreak();
  /// Hangs up the call on screen: a campaign attempt, or an inbound call once it is connected
  /// (never while it is only offered).
  Future<void> hangUp();
  Future<void> setMuted(bool muted);
  Future<void> setRoute(AudioRouteOption route);

  /// Debounced and saved by the core; call on every keystroke. The notes of the call on
  /// screen: a campaign attempt's, or an inbound call's.
  void updateNotes(String text);

  /// Saves the outcome of the call on screen: a campaign wrap-up's, or an inbound call's (from
  /// its own catalog, [StationView.dispositions]).
  Future<void> submitDisposition(String code, {String? notes, DateTime? callbackAt});

  /// Redials the customer of the wrap-up on screen, before its outcome is
  /// saved ([WrapupView.redialRemaining]). [attemptId] is the call the agent
  /// is looking at: when the wrap-up is another call's by then, nothing is
  /// dialled and [StationView.actionError] says so. A refusal leaves the
  /// agent in wrap-up with the outcome pad usable.
  Future<void> redial({String? attemptId});
  /// Marks the live call Do Not Call (or the inbound caller's number, on the
  /// call or owing its outcome). [attemptId] is the call the agent confirmed
  /// for: when the call is another one by then, nothing is marked and
  /// [StationView.actionError] says so.
  Future<void> markDnc({String? reason, String? attemptId});

  /// Leaves the station. [LeaveOutcome.stayed] (the refusal is in
  /// [StationView.actionError]) keeps the agent on it.
  Future<LeaveOutcome> leave();
  Future<void> reconnect();

  /// After 4409: take the station back on this device.
  Future<void> useThisDevice();

  /// The agent is leaving a station that is over on this phone (4404, 4409,
  /// or one that cannot open): forget it here. Nothing is sent.
  Future<void> dismiss();
  void dismissActionError();
  void dismissMissedRelease();
}

/// How [StationActions.leave] ended.
enum LeaveOutcome {
  /// The server took the agent off the station.
  left,

  /// The server could not be reached: the station was closed on this phone
  /// anyway (its socket closing is what takes the agent off duty server-side).
  leftOffline,

  /// Refused, or a call is live: still on the station.
  stayed,
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
  ///
  /// [takeOver] (OS3): the agent chose this phone, so the station moves here. An automatic resume
  /// passes false, and is refused (a [StationRefused] with `station_on_other_device`) when another
  /// device holds the station.
  Future<StationStart> start(String campaignId, {required String campaignName, bool takeOver = true});

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
