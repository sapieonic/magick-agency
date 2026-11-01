import 'package:agency_wire/agency_wire.dart';
import 'package:meta/meta.dart';

/// The station's state and the one pure function that moves it: a port of the
/// console's `agencyStationReducer.ts`, field for field and rule for rule.
///
/// Each frame is ONE transition and the fields that move together are written
/// together, here, once. The reducer is pure: anything that needs the present
/// or the clock offset (opening a wrap-up anchor, the attempt a `released`
/// retains, the device time of a release) is computed by the caller and put in
/// the action.
///
/// Two additions the app needs and the console does not, both kept narrow:
/// * `campaignMessage`: the `campaign_state` frame's sentence while the
///   campaign is not dialling ("no calls will come through").
/// * `ready` drops `agentStateSince` / `breakReasonCode` when it reports a
///   DIFFERENT state from the one they were stated for. Those two describe a
///   transition, and `ready` carries neither; a phone whose socket died while
///   it was in the background (the common mobile case) would otherwise show a
///   break timer anchored to a state it left long ago. [SessionStateAction]
///   fills them back in from the HTTP answer of the request that caused the
///   transition.

/// The socket, as the reducer tracks it. Mirrors the console's `StationConnection`.
enum StationConnection { idle, connecting, open, reconnecting, sessionGone, superseded, disconnected }

/// An attempt the agent is on: from `reserved` until `released`.
@immutable
final class LiveAttempt {
  const LiveAttempt({required this.attempt, this.bridgedAt});

  final ReservedAttempt attempt;

  /// SERVER clock. Null while ringing; set ⇒ the customer may be speaking.
  final DateTime? bridgedAt;

  String get attemptId => attempt.attemptId;

  @override
  bool operator ==(Object other) =>
      other is LiveAttempt &&
      other.bridgedAt == bridgedAt &&
      (identical(other.attempt, attempt) || other.attempt == attempt);

  @override
  int get hashCode => Object.hash(attempt.attemptId, bridgedAt);

  @override
  String toString() => 'LiveAttempt(${attempt.attemptId}, bridgedAt: $bridgedAt)';
}

/// A wrap-up, captured ONCE when its frame arrives (port of `WrapupAnchor`).
///
/// [deadline] is already on this device's clock. [total] is the span the
/// progress bar is scaled against, captured at open: recomputing it on every
/// repaint from a shrinking remainder pins the bar at 100% and then snaps it to
/// zero while the digits beside it count down.
@immutable
final class WrapupAnchor {
  const WrapupAnchor({
    required this.attemptId,
    required this.deadline,
    required this.total,
    required this.requiresDisposition,
    required this.heldReason,
    required this.autoReturn,
    this.secondsTotal = 0,
    this.dispositionSubmitted = false,
  });

  final String attemptId;

  /// Device clock; null means no deadline (auto-return off, held, or timerless).
  final DateTime? deadline;
  final Duration? total;
  final bool requiresDisposition;
  final WrapupHoldReason? heldReason;

  /// From the frame, never the campaign config.
  final bool autoReturn;

  /// The campaign's `wrapup_seconds`, as the frame stated it (the app shows it
  /// beside a held wrap-up). Not in the console's anchor; carried so the view
  /// needs no second source.
  final int secondsTotal;

  /// As the frame stated it. The console keeps this in its submit hook.
  final bool dispositionSubmitted;

  @override
  bool operator ==(Object other) =>
      other is WrapupAnchor &&
      other.attemptId == attemptId &&
      other.deadline == deadline &&
      other.total == total &&
      other.requiresDisposition == requiresDisposition &&
      other.heldReason == heldReason &&
      other.autoReturn == autoReturn &&
      other.secondsTotal == secondsTotal &&
      other.dispositionSubmitted == dispositionSubmitted;

  @override
  int get hashCode => Object.hash(
        attemptId,
        deadline,
        total,
        requiresDisposition,
        heldReason,
        autoReturn,
        secondsTotal,
        dispositionSubmitted,
      );
}

/// Builds the anchor from the frame. Call once per `wrapup` frame (port of
/// `openWrapup`). `ends_at: null` yields no deadline and no span: "ends when
/// you act", never "expired".
WrapupAnchor openWrapup(WrapupState wrapup, int offsetMs, DateTime now) {
  final deadline = wrapup.endsAt?.subtract(Duration(milliseconds: offsetMs));
  Duration? total;
  if (deadline != null) {
    // A deadline already past when the frame lands has no span to animate.
    final span = deadline.difference(now);
    total = span > Duration.zero ? span : null;
  }
  return WrapupAnchor(
    attemptId: wrapup.attemptId,
    deadline: deadline,
    total: total,
    requiresDisposition: wrapup.requiresDisposition,
    heldReason: wrapup.heldReason,
    autoReturn: wrapup.autoReturn,
    secondsTotal: wrapup.secondsTotal,
    dispositionSubmitted: wrapup.dispositionSubmitted,
  );
}

const Object _keep = Object();

@immutable
final class StationState {
  const StationState({
    this.connection = StationConnection.idle,
    this.agentState = AgentState.offline,
    this.agentStateSince,
    this.breakReasonCode,
    this.pendingBreakCode,
    this.pendingBreakStatements = 0,
    this.missedRelease,
    this.live,
    this.retainedAttempt,
    this.wrapup,
    this.clockOffsetMs = 0,
    this.release,
    this.releasedAt,
    this.lastError,
    this.dialing = true,
    this.campaignMessage,
    this.missedPings = 0,
    this.manualCall,
  });

  static const initial = StationState();

  final StationConnection connection;
  final AgentState agentState;

  /// `agent_state.since` (server clock): the ONLY anchor for break elapsed time.
  final DateTime? agentStateSince;
  final String? breakReasonCode;
  final String? pendingBreakCode;

  /// Monotonic; moves on every frame that states the break queue.
  final int pendingBreakStatements;
  final MissedRelease? missedRelease;
  final LiveAttempt? live;
  final ReservedAttempt? retainedAttempt;
  final WrapupAnchor? wrapup;
  final int clockOffsetMs;
  final ReleasedFrame? release;

  /// Device clock: the frame carries no stamp of its own.
  final DateTime? releasedAt;
  final StationErrorFrame? lastError;
  final bool dialing;
  final String? campaignMessage;
  final int missedPings;

  /// The session's soft-phone call, as the newest `manual_call` frame stated it.
  final ManualCallFrame? manualCall;

  /// The attempt the station holds now (live, retained for wrap-up, or the
  /// wrap-up's own). What notes and the disposition are keyed by.
  String? get currentAttemptId => live?.attemptId ?? retainedAttempt?.attemptId ?? wrapup?.attemptId;

  StationState _with({
    StationConnection? connection,
    AgentState? agentState,
    Object? agentStateSince = _keep,
    Object? breakReasonCode = _keep,
    Object? pendingBreakCode = _keep,
    int? pendingBreakStatements,
    Object? missedRelease = _keep,
    Object? live = _keep,
    Object? retainedAttempt = _keep,
    Object? wrapup = _keep,
    int? clockOffsetMs,
    Object? release = _keep,
    Object? releasedAt = _keep,
    Object? lastError = _keep,
    bool? dialing,
    Object? campaignMessage = _keep,
    int? missedPings,
    Object? manualCall = _keep,
  }) =>
      StationState(
        connection: connection ?? this.connection,
        agentState: agentState ?? this.agentState,
        agentStateSince: identical(agentStateSince, _keep) ? this.agentStateSince : agentStateSince as DateTime?,
        breakReasonCode: identical(breakReasonCode, _keep) ? this.breakReasonCode : breakReasonCode as String?,
        pendingBreakCode: identical(pendingBreakCode, _keep) ? this.pendingBreakCode : pendingBreakCode as String?,
        pendingBreakStatements: pendingBreakStatements ?? this.pendingBreakStatements,
        missedRelease: identical(missedRelease, _keep) ? this.missedRelease : missedRelease as MissedRelease?,
        live: identical(live, _keep) ? this.live : live as LiveAttempt?,
        retainedAttempt: identical(retainedAttempt, _keep) ? this.retainedAttempt : retainedAttempt as ReservedAttempt?,
        wrapup: identical(wrapup, _keep) ? this.wrapup : wrapup as WrapupAnchor?,
        clockOffsetMs: clockOffsetMs ?? this.clockOffsetMs,
        release: identical(release, _keep) ? this.release : release as ReleasedFrame?,
        releasedAt: identical(releasedAt, _keep) ? this.releasedAt : releasedAt as DateTime?,
        lastError: identical(lastError, _keep) ? this.lastError : lastError as StationErrorFrame?,
        dialing: dialing ?? this.dialing,
        campaignMessage: identical(campaignMessage, _keep) ? this.campaignMessage : campaignMessage as String?,
        missedPings: missedPings ?? this.missedPings,
        manualCall: identical(manualCall, _keep) ? this.manualCall : manualCall as ManualCallFrame?,
      );

  @override
  String toString() => 'StationState($connection, $agentState, live: ${live?.attemptId}, '
      'retained: ${retainedAttempt?.attemptId}, wrapup: ${wrapup?.attemptId}, release: ${release?.reasonRaw}, '
      'pendingBreak: $pendingBreakCode, missedPings: $missedPings)';
}

// ─── Actions ────────────────────────────────────────────────────────────────

@immutable
sealed class StationAction {
  const StationAction();
}

final class ConnectionAction extends StationAction {
  const ConnectionAction(this.connection);
  final StationConnection connection;
}

final class MissedPingsAction extends StationAction {
  const MissedPingsAction(this.count);
  final int count;
}

/// [wrapup]: the anchor opened from `frame.activeWrapup`, when it carried one.
final class ReadyAction extends StationAction {
  const ReadyAction(this.frame, {this.wrapup});
  final ReadyFrame frame;
  final WrapupAnchor? wrapup;
}

final class AgentStateAction extends StationAction {
  const AgentStateAction(this.frame);
  final AgentStateFrame frame;
}

final class WrapupAction extends StationAction {
  const WrapupAction(this.anchor);
  final WrapupAnchor anchor;
}

final class ReservedAction extends StationAction {
  const ReservedAction(this.attempt);
  final ReservedAttempt attempt;
}

final class BridgedAction extends StationAction {
  const BridgedAction(this.attemptId, this.bridgedAt);
  final String attemptId;
  final DateTime bridgedAt;
}

/// [at]: this device's stamp (the frame carries none). [retain]: the attempt
/// whose panel stays up through wrap-up, read by the caller off the state as
/// of the last frame.
final class ReleasedAction extends StationAction {
  const ReleasedAction(this.frame, {required this.at, required this.retain});
  final ReleasedFrame frame;
  final DateTime at;
  final ReservedAttempt? retain;
}

final class CampaignStateAction extends StationAction {
  const CampaignStateAction({required this.dialing, this.message});
  final bool dialing;
  final String? message;
}

/// [offsetMs]: the estimator's new offset, or null when the pong carried no sample.
final class PongAction extends StationAction {
  const PongAction(this.offsetMs);
  final int? offsetMs;
}

final class ErrorAction extends StationAction {
  const ErrorAction(this.frame);
  final StationErrorFrame frame;
}

final class ManualCallAction extends StationAction {
  const ManualCallAction(this.call);
  final ManualCallFrame call;
}

/// The HTTP answer to a session transition (`break`, `available`,
/// `break/cancel`). Reconciliation only: it never changes the state, it only
/// supplies the `since` / break reason a `ready` snapshot cannot carry, and
/// only while the station is in that same state and knows no anchor of its own.
final class SessionStateAction extends StationAction {
  const SessionStateAction(this.response);
  final SessionStateResponse response;
}

// ─── The reducer ────────────────────────────────────────────────────────────

/// One authoritative statement of the break queue, from either frame that
/// makes one. Absence is how the API says the queue is empty, so the counter
/// moves even when the code does not.
({String? code, int statements}) _breakQueue(StationState state, AgentState? pending, String? reason) => (
      code: pending == AgentState.onBreak ? reason : null,
      statements: state.pendingBreakStatements + 1,
    );

StationState stationReducer(StationState state, StationAction action) {
  switch (action) {
    case ConnectionAction(:final connection):
      return connection == state.connection ? state : state._with(connection: connection);

    case MissedPingsAction(:final count):
      return count == state.missedPings ? state : state._with(missedPings: count);

    case ReadyAction(:final frame, wrapup: final anchor):
      // A full-state SNAPSHOT, not a set of additions: replace or clear, field
      // by field, and never merely add.
      final previous = state.agentState;
      final queue = _breakQueue(state, frame.pendingState, frame.pendingBreakReason);
      final active = frame.activeAttempt;
      var next = state._with(
        agentState: frame.state,
        live: active == null ? null : LiveAttempt(attempt: active, bridgedAt: active.bridgedAt),
        missedRelease: frame.missedRelease,
        pendingBreakCode: queue.code,
        pendingBreakStatements: queue.statements,
      );
      if (frame.state != previous) {
        // Mobile addition: these described the state that was left.
        next = next._with(agentStateSince: null, breakReasonCode: null);
      }
      if (frame.state == AgentState.wrapup) {
        // A deadline only when this replica still owns the timer; absent, the
        // anchor already held is kept and none is invented.
        if (frame.activeWrapup != null && anchor != null) {
          final anchored = frame.activeWrapup!.attemptId;
          final prev = state.retainedAttempt;
          next = next._with(
            wrapup: anchor,
            // A panel held for another attempt is from a call that finished
            // while the socket was away.
            retainedAttempt: prev != null && prev.attemptId != anchored ? null : prev,
          );
        }
      } else {
        next = next._with(wrapup: null, retainedAttempt: null);
        // `release` goes only when something newer accounts for the call: a
        // wrap-up that happened, the API's missed release, or a new call.
        if (previous == AgentState.wrapup || frame.missedRelease != null || active != null) {
          next = next._with(release: null, releasedAt: null);
        }
      }
      return next;

    case AgentStateAction(:final frame):
      final previous = state.agentState;
      final queue = _breakQueue(state, frame.pendingState, frame.pendingBreakReason);
      var next = state._with(
        agentState: frame.state,
        agentStateSince: frame.since,
        breakReasonCode: frame.breakReason,
        pendingBreakCode: queue.code,
        pendingBreakStatements: queue.statements,
      );
      if (frame.state != AgentState.wrapup) {
        // `agent_state` is the one authority for wrap-up ENDING.
        next = next._with(wrapup: null, retainedAttempt: null);
        // A release outlives wrap-up only when there was no wrap-up.
        if (previous == AgentState.wrapup) next = next._with(release: null, releasedAt: null);
      }
      return next;

    case WrapupAction(:final anchor):
      return identical(anchor, state.wrapup) ? state : state._with(wrapup: anchor);

    case ReservedAction(:final attempt):
      // A new reservation always wins: whatever is on screen belongs to a call that is over.
      return state._with(
        release: null,
        releasedAt: null,
        retainedAttempt: null,
        wrapup: null,
        missedRelease: null,
        live: LiveAttempt(attempt: attempt),
      );

    case BridgedAction(:final attemptId, :final bridgedAt):
      final prev = state.live;
      if (prev == null || prev.attemptId != attemptId) return state;
      return state._with(live: LiveAttempt(attempt: prev.attempt, bridgedAt: bridgedAt));

    case ReleasedAction(:final frame, :final at, :final retain):
      var next = state._with(release: frame, releasedAt: at, live: null);
      // The panel and pad stay up when there is still work to do.
      if (frame.requiresDisposition && retain != null && retain.attemptId == frame.attemptId) {
        next = next._with(retainedAttempt: retain);
      }
      return next;

    case CampaignStateAction(:final dialing, :final message):
      final shown = dialing ? null : message;
      return dialing == state.dialing && shown == state.campaignMessage
          ? state
          : state._with(dialing: dialing, campaignMessage: shown);

    case PongAction(:final offsetMs):
      final offset = offsetMs ?? state.clockOffsetMs;
      return state.missedPings == 0 && offset == state.clockOffsetMs
          ? state
          : state._with(missedPings: 0, clockOffsetMs: offset);

    case ErrorAction(:final frame):
      return identical(frame, state.lastError) ? state : state._with(lastError: frame);

    case ManualCallAction(:final call):
      // The frame's copy goes first so it wins a tie: the frame is the authority.
      final newer = newerCall(call, state.manualCall);
      return identical(newer, state.manualCall) ? state : state._with(manualCall: newer);

    case SessionStateAction(:final response):
      if (response.state != state.agentState || state.agentStateSince != null) return state;
      return state._with(
        agentStateSince: response.since,
        breakReasonCode: response.state == AgentState.onBreak ? response.breakReason : state.breakReasonCode,
      );
  }
}

/// The newer of two soft-phone call rows (port of `callState.ts` `newerCall`):
/// a different call wins by `created_at`, the same call by `updated_at`, and a
/// tie goes to the settled copy, then to [a].
ManualCallFrame? newerCall(ManualCallFrame? a, ManualCallFrame? b) {
  if (a == null) return b;
  if (b == null) return a;
  int instant(ManualCallFrame f, String key) {
    final v = f.call[key];
    return v is String ? (DateTime.tryParse(v)?.millisecondsSinceEpoch ?? 0) : 0;
  }

  if (a.id != b.id) return instant(b, 'created_at') > instant(a, 'created_at') ? b : a;
  final at = instant(a, 'updated_at');
  final bt = instant(b, 'updated_at');
  if (bt > at) return b;
  if (bt == at && b.call['settled_at'] != null && a.call['settled_at'] == null) return b;
  return a;
}
