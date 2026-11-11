import 'package:agency_wire/agency_wire.dart';

/// What leaving and returning to the app does to the station, as pure rules.
///
/// The product rule: waiting for calls needs the app on screen. A phone that
/// leaves the foreground while `available` must never be handed a customer,
/// so the app pauses the agent at once with the reserved `device_away` break.
/// A call or wrap-up keeps running in the background (the audio session,
/// CallKit and the Android on-duty service keep the process alive), and the
/// same break is QUEUED so the agent is paused after the call rather than made
/// available while away.
///
/// The soft phone: a soft-phone session is never in the dialing pool (it is
/// always on the `soft_phone` break), so nothing is ever paused for it. Its
/// call is not a campaign call phase (the agent state stays `break`), so the
/// rules that keep a call alive in the background are also asked about the
/// manual call: live, or ended and owing its outcome (wrap-up's twin).

/// Whether a `device_away` pause that had lasted [pausedFor] when the agent
/// came back returns them on its own, as if they had pressed "Resume taking
/// calls" (IQ50): back within the wire's [deviceAwayReturnGrace]
/// (`DEVICE_AWAY_RETURN_GRACE_MS`, the window the server also counts them as
/// able to take a waiting caller); a longer absence still needs the tap. The
/// away card says the same (`StationCopy.awayAutoReturnHint`). Only the app's
/// own pause asked for at once qualifies, never a break of another reason or
/// one queued behind a call: the station controller decides that.
bool autoReturnsFromAway(Duration pausedFor) => pausedFor < deviceAwayReturnGrace;

/// What to ask the server for while the app is in the background.
enum AwayAction {
  none,

  /// `available` or `offline`: break now, before anything else.
  pauseNow,

  /// Reserved, on a call or in wrap-up: the break is queued for after the call.
  queuePause,
}

bool isCallPhase(AgentState state) =>
    state == AgentState.reserved || state == AgentState.onCall || state == AgentState.wrapup;

/// The away action for [state] while backgrounded. A break the agent already
/// queued pauses them after the call anyway, so it is left alone; a break of
/// any reason (including `device_away`) needs nothing. A [softphoneSession]
/// needs nothing ever, whatever its state reads (before its first `ready` it
/// reads `offline`): it can never be handed a customer.
AwayAction awayActionFor(AgentState state, {required String? pendingBreakCode, bool softphoneSession = false}) {
  if (softphoneSession) return AwayAction.none;
  return switch (state) {
    AgentState.available || AgentState.offline => AwayAction.pauseNow,
    AgentState.reserved || AgentState.onCall || AgentState.wrapup =>
      pendingBreakCode == null ? AwayAction.queuePause : AwayAction.none,
    AgentState.onBreak || AgentState.unknown => AwayAction.none,
  };
}

/// The local notification the agent should see while away.
enum AwayNotice { none, paused, wrapupDeadline }

/// [outcomeDueAt]: a soft-phone call ended and owes its outcome by then (device
/// clock). Away, the agent is told the same "Save the outcome by 11:28" as for
/// a wrap-up.
AwayNotice awayNoticeFor(
  AgentState state, {
  required bool foreground,
  required String? breakCode,
  required bool pauseRequested,
  required DateTime? wrapupDeadline,
  DateTime? outcomeDueAt,
}) {
  if (foreground) return AwayNotice.none;
  if (state == AgentState.wrapup) return wrapupDeadline != null ? AwayNotice.wrapupDeadline : AwayNotice.none;
  if (outcomeDueAt != null) return AwayNotice.wrapupDeadline;
  if (state == AgentState.onBreak && breakCode == ReservedBreakCode.deviceAway.wire) return AwayNotice.paused;
  if ((state == AgentState.available || state == AgentState.offline) && pauseRequested) return AwayNotice.paused;
  return AwayNotice.none;
}

/// App-level pings run while the app is on screen or a call or wrap-up is
/// live, a soft-phone call ([manualCall]: live or owing its outcome)
/// included. Stopping them while away lets the `available` lease lapse; it
/// does not close the station (the OS still answers the server's protocol
/// pings), so a `device_away` pause that never lands is retried and then the
/// socket is closed by the station controller.
bool appPingsWanted({required bool foreground, required AgentState state, bool manualCall = false}) =>
    foreground || isCallPhase(state) || manualCall;

/// A dropped socket is retried at once only when someone needs it: the app is
/// on screen, or a call or wrap-up is live, or a soft-phone call is live or
/// owes its outcome. Otherwise it waits for the return.
bool keepAliveWanted({required bool foreground, required AgentState state, bool manualCall = false}) =>
    foreground || isCallPhase(state) || manualCall;

/// The screen stays awake while on duty and on screen, never otherwise. An
/// [idleSoftphone] (a soft-phone session with no call live or owed) lets it
/// sleep: nothing arrives there unasked, unlike a campaign station.
bool wakeLockWanted({required bool onDuty, required bool foreground, bool idleSoftphone = false}) =>
    onDuty && foreground && !idleSoftphone;
