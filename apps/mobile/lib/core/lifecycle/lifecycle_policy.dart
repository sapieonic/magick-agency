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
/// any reason (including `device_away`) needs nothing.
AwayAction awayActionFor(AgentState state, {required String? pendingBreakCode}) => switch (state) {
      AgentState.available || AgentState.offline => AwayAction.pauseNow,
      AgentState.reserved || AgentState.onCall || AgentState.wrapup =>
        pendingBreakCode == null ? AwayAction.queuePause : AwayAction.none,
      AgentState.onBreak || AgentState.unknown => AwayAction.none,
    };

/// The local notification the agent should see while away.
enum AwayNotice { none, paused, wrapupDeadline }

AwayNotice awayNoticeFor(
  AgentState state, {
  required bool foreground,
  required String? breakCode,
  required bool pauseRequested,
  required DateTime? wrapupDeadline,
}) {
  if (foreground) return AwayNotice.none;
  if (state == AgentState.wrapup) return wrapupDeadline != null ? AwayNotice.wrapupDeadline : AwayNotice.none;
  if (state == AgentState.onBreak && breakCode == ReservedBreakCode.deviceAway.wire) return AwayNotice.paused;
  if ((state == AgentState.available || state == AgentState.offline) && pauseRequested) return AwayNotice.paused;
  return AwayNotice.none;
}

/// App-level pings run while the app is on screen or a call or wrap-up is
/// live. Stopping them while away lets the server's mobile grace pause the
/// agent even if the `device_away` request never lands.
bool appPingsWanted({required bool foreground, required AgentState state}) => foreground || isCallPhase(state);

/// A dropped socket is retried at once only when someone needs it: the app is
/// on screen, or a call or wrap-up is live. Otherwise it waits for the return.
bool keepAliveWanted({required bool foreground, required AgentState state}) => foreground || isCallPhase(state);

/// The screen stays awake while on duty and on screen, never otherwise.
bool wakeLockWanted({required bool onDuty, required bool foreground}) => onDuty && foreground;
