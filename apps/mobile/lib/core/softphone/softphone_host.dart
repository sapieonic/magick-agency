import 'package:agency_wire/agency_wire.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../station/station_view.dart' show AgentPhase, AudioRouteOption, AudioView, StationLink;

/// The seam between the session host and the soft-phone controller.
///
/// The server allows one live session per agent per tenant, so the app keeps
/// ONE host (the station controller) holding one session, of kind `campaign` or
/// `softphone`, with one socket, one audio engine and one on-duty service. The
/// soft-phone controller never touches the socket or the microphone (as the
/// console's `useSoftphone` never does): it reads [SoftphoneHostView] and asks
/// [SoftphoneHostActions] for anything that belongs to the session.
///
/// How a `manual_call` frame reaches the screen:
/// `socket → host (ManualCallFrame.manualCall) → reducer merge (newerCall, the
/// frame winning a tie) → SoftphoneHostView.call → soft-phone controller →
/// SoftphoneView`. HTTP answers (`POST /calls`, hang-up, outcome, PATCH, a
/// refusal's `call`) flow back through [SoftphoneHostActions.adoptManualCall], so
/// the router's hold and the audio target never depend on the soft-phone
/// controller being alive.
///
/// Everything here may use `agency_wire` (the controller is core, not UI).

/// The hosted session as the soft phone needs it. Null (the provider's value)
/// when the host holds no session.
@immutable
class SoftphoneHostView {
  const SoftphoneHostView({
    required this.sessionId,
    required this.kind,
    this.accountId,
    this.campaignId,
    this.campaignName,
    this.link = StationLink.connecting,
    this.everOpened = false,
    this.phase = AgentPhase.offline,
    this.onSoftphone = false,
    this.switchQueued = false,
    this.call,
    this.clockOffsetMs = 0,
    this.audio = const AudioView(),
    this.ringMuted = false,
    this.reconnectDeadline,
    this.hangupFailure,
  });

  /// The live session's id.
  final String sessionId;

  /// `softphone` (opened from the Phone tab) or `campaign` (a station, which
  /// may be switched to the soft phone).
  final SessionKind kind;

  /// The account the session was opened in: every soft-phone request about it
  /// (bootstrap, calls, close) is sent with this account. Null only before the
  /// host knows it.
  final String? accountId;

  /// The campaign of a `campaign` session (the SP7 preset tag); null for `softphone`.
  final String? campaignId;
  final String? campaignName;

  /// The socket. The soft phone re-reads its bootstrap when this returns to
  /// [StationLink.open] after the first open (a call that settled while the
  /// socket was away sends no frame into the new one).
  final StationLink link;

  /// The socket has been open at least once in this session, so a later
  /// [StationLink.open] is a reconnect.
  final bool everOpened;

  /// The agent's state as the socket's frames state it. A soft-phone session
  /// is always [AgentPhase.onBreak].
  final AgentPhase phase;

  /// `break/soft_phone`: the session can dial. Always true for a `softphone`
  /// session once the socket said so; for a `campaign` session, after the switch applied.
  final bool onSoftphone;

  /// A switch to the soft phone is queued behind a call or wrap-up
  /// (`pending_state: break`, `pending_break_reason: soft_phone`).
  final bool switchQueued;

  /// The session's manual call: the newest copy from the frames and the
  /// adopted HTTP answers. Kept while unsettled; a settled copy is kept too
  /// until the next dial replaces it (so the controller sees it settle).
  final ManualCall? call;

  /// Subtract from a server instant to put it on this device's clock (`server_clock.dart`).
  final int clockOffsetMs;

  /// The host's audio: microphone mute, route and routes, microphone problems.
  final AudioView audio;

  /// The ringback is muted for the current call ([SoftphoneHostActions.setRingMuted]).
  /// Resets to false whenever the call id changes.
  final bool ringMuted;

  /// An answered manual call whose socket dropped: the server ends it if the
  /// socket is not back by then (device clock). Null while ringing (the server
  /// ends a ringing call at once) and while connected.
  final DateTime? reconnectDeadline;

  /// A hang-up from the system controls ([SoftphoneHostActions.hangUpManual]:
  /// CallKit, the notification) that failed while the call stays on the line,
  /// in words ready to show ("We couldn’t end the call — …"). The host owns it
  /// because those controls never pass through the soft phone; the soft phone
  /// shows it as its own hang-up failure. Null once the call is no longer on
  /// the line, or when the next hang-up starts.
  final String? hangupFailure;

  /// A soft-phone call is on the line.
  bool get callLive => call?.isLive ?? false;

  /// The session's call ended and owes its outcome.
  bool get outcomeOwed => call?.owesOutcome ?? false;

  @override
  bool operator ==(Object other) =>
      other is SoftphoneHostView &&
      other.sessionId == sessionId &&
      other.kind == kind &&
      other.accountId == accountId &&
      other.campaignId == campaignId &&
      other.campaignName == campaignName &&
      other.link == link &&
      other.everOpened == everOpened &&
      other.phase == phase &&
      other.onSoftphone == onSoftphone &&
      other.switchQueued == switchQueued &&
      other.call == call &&
      other.clockOffsetMs == clockOffsetMs &&
      other.audio == audio &&
      other.ringMuted == ringMuted &&
      other.reconnectDeadline == reconnectDeadline &&
      other.hangupFailure == hangupFailure;

  @override
  int get hashCode => Object.hash(
    sessionId,
    kind,
    accountId,
    campaignId,
    link,
    everOpened,
    phase,
    onSoftphone,
    switchQueued,
    call,
    clockOffsetMs,
    audio,
    ringMuted,
    reconnectDeadline,
    hangupFailure,
  );
}

// ─── Results ────────────────────────────────────────────────────────────────

/// How [SoftphoneHostActions.openSoftphone] ended.
@immutable
sealed class SoftphoneOpenResult {
  const SoftphoneOpenResult();
}

/// The soft-phone session is open (or this account's was rehydrated) and the
/// host is connecting its socket.
final class SoftphoneOpened extends SoftphoneOpenResult {
  const SoftphoneOpened({required this.sessionId, required this.created});
  final String sessionId;

  /// 201 (a new session) rather than 200 (rehydrated). Informational; false
  /// when the host could not tell.
  final bool created;
}

/// 409 `session_on_campaign`: live on a campaign (maybe in a sibling account).
/// The remedy is the switch on that session, never a second session.
final class SoftphoneOpenOnCampaign extends SoftphoneOpenResult {
  const SoftphoneOpenOnCampaign(this.refusal);
  final SoftphoneSessionOnCampaignRefusal refusal;
}

/// 409 `session_on_softphone`: the agent's soft-phone session is in another
/// account of the tenant. Close it there ([SoftphoneHostActions.closeSoftphone]
/// with its ids), or switch account.
final class SoftphoneOpenElsewhere extends SoftphoneOpenResult {
  const SoftphoneOpenElsewhere(this.refusal);
  final SessionOnSoftphoneRefusal refusal;
}

/// 403 `softphone_disabled`: off for the account and nothing here to rehydrate.
final class SoftphoneOpenDisabled extends SoftphoneOpenResult {
  const SoftphoneOpenDisabled();
}

/// Anything else (offline, a 5xx, a refusal this build does not name), in words.
final class SoftphoneOpenRefused extends SoftphoneOpenResult {
  const SoftphoneOpenRefused(this.message, {this.code, this.retryable = true});
  final String message;

  /// The body's soft-phone code when it had one.
  final SoftphoneErrorCode? code;

  /// Offline or a server fault: Retry may help.
  final bool retryable;
}

/// How [SoftphoneHostActions.closeSoftphone] ended (a port of the console's
/// `closeSoftphoneSession` outcome).
@immutable
sealed class SoftphoneCloseResult {
  const SoftphoneCloseResult();
}

/// Left, or already gone (`session_ended`, 404). The hosted session, when it
/// was the one closed, is torn down locally too.
final class SoftphoneClosed extends SoftphoneCloseResult {
  const SoftphoneClosed();
}

/// A call there is live or owes its outcome, so nothing was closed. [call] is
/// the call when the bootstrap or the refusal named it.
final class SoftphoneCloseCallPending extends SoftphoneCloseResult {
  const SoftphoneCloseCallPending({this.call});
  final ManualCall? call;
}

/// No session was named and the bootstrap had none either.
final class SoftphoneCloseNoSession extends SoftphoneCloseResult {
  const SoftphoneCloseNoSession();
}

/// `leave` refused for another reason; the soft phone is still open.
/// [message] is ready to show ("Your soft phone is still open — …").
final class SoftphoneCloseFailed extends SoftphoneCloseResult {
  const SoftphoneCloseFailed(this.message);
  final String message;
}

/// How a switch to the soft phone, its withdrawal, or the return ended (SP7).
@immutable
sealed class SoftphoneSwitchResult {
  const SoftphoneSwitchResult();
}

/// Applied now: on the soft phone (switch), back on the campaign (return), or
/// the queued switch withdrawn (cancel).
final class SoftphoneSwitchApplied extends SoftphoneSwitchResult {
  const SoftphoneSwitchApplied();
}

/// The switch was queued behind a call or wrap-up; the `agent_state` frame
/// that applies it moves the station onto the soft phone.
final class SoftphoneSwitchQueued extends SoftphoneSwitchResult {
  const SoftphoneSwitchQueued();
}

/// Refused. [message] is ready to show. For `manual_call_live` the host has
/// already adopted [call] (the return is blocked by it); `dial_failed` means
/// nothing changed, try again.
final class SoftphoneSwitchRefused extends SoftphoneSwitchResult {
  const SoftphoneSwitchRefused(this.message, {this.code, this.call});
  final String message;
  final SoftphoneErrorCode? code;
  final ManualCall? call;
}

// ─── Actions ────────────────────────────────────────────────────────────────

/// What the soft-phone controller may ask of the session host. Implemented by
/// the station controller. None of these throw for an expected refusal: the
/// result says what happened.
abstract interface class SoftphoneHostActions {
  /// Opens (or rehydrates) the agent's soft-phone session in the current
  /// account (`POST /softphone/sessions`), mints a station token when the URL
  /// carries none, starts the on-duty service and audio, and opens the socket.
  /// With the flag off the server rehydrates an existing session only.
  Future<SoftphoneOpenResult> openSoftphone();

  /// Closes a soft-phone session: the hosted one when [sessionId] is null,
  /// else the one named (a refusal's, in [accountId]). Reads the bootstrap in
  /// the session's own account first and refuses while its call is live or
  /// owed; otherwise `leave` with that account. 404 / `session_ended` is closed.
  Future<SoftphoneCloseResult> closeSoftphone({String? sessionId, String? accountId});

  /// Switches the hosted campaign session to the soft phone
  /// (`POST /sessions/:id/softphone`): applied, or queued while reserved, on a
  /// call or in wrap-up.
  Future<SoftphoneSwitchResult> switchToSoftphone();

  /// Withdraws a queued switch (the station's `break/cancel`).
  Future<SoftphoneSwitchResult> cancelSwitch();

  /// Back to the campaign (`POST /sessions/:id/softphone/return`). Refused
  /// `manual_call_live` while a call is live or owed (the host retires its
  /// copy and adopts the refusal's).
  Future<SoftphoneSwitchResult> returnToCampaign();

  /// An HTTP answer's copy of the call: merged with `newerCall` (`call_state.dart`), the frame's
  /// copy winning a tie.
  void adoptManualCall(ManualCall call);

  /// Drops the held call if its [ManualCall.versionKey] is still [versionKey]:
  /// the bootstrap said the session has no call, and a newer frame that
  /// arrived since the bootstrap was asked for is kept.
  void retireManualCall(String versionKey);

  /// Mutes or unmutes the ringback for the current call (Mute while ringing).
  /// Not the microphone.
  void setRingMuted(bool muted);

  /// The matched contact's name for the call [callId], as the soft phone
  /// reads it. Advisory: CallKit cannot rename a call once it is reported,
  /// and the host reports a call before the soft phone hears of it, so the
  /// station host names the call itself from the row and ignores this.
  void setCallDisplayName(String callId, String? name);

  /// Hangs up the live manual call (`POST /softphone/calls/:id/hangup`) for the
  /// system controls (CallKit, the notification), which act at once. The
  /// in-app button goes through the soft-phone controller instead.
  Future<void> hangUpManual();

  /// The microphone's mute.
  Future<void> setMuted(bool muted);
  Future<void> setRoute(AudioRouteOption route);

  /// Reconnects the socket; on a gone soft-phone session (4404), reopens it.
  Future<void> reconnect();

  /// After 4409: takes the session back on this device.
  Future<void> useThisDevice();

  /// Forgets a session that is over on this phone. Nothing is sent.
  Future<void> dismiss();
}

/// The hosted session as the soft phone sees it, or null when the host holds
/// none. Overridden by the station core (`stationOverrides`).
final softphoneHostViewProvider = Provider<SoftphoneHostView?>((ref) => null);

/// Overridden by the station core (`stationOverrides`).
final softphoneHostActionsProvider = Provider<SoftphoneHostActions>(
  (ref) => throw UnimplementedError('softphoneHostActionsProvider is provided by the station core'),
);
