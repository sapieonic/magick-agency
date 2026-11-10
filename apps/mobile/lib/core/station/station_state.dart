import 'package:agency_wire/agency_wire.dart';
import 'package:meta/meta.dart';

import '../inbound/inbound_call_rules.dart';
import '../lifecycle/lifecycle_policy.dart' show isCallPhase;
import '../softphone/call_state.dart' show newerCall;

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
///   transition, and `ready` carries no `since`; a phone whose socket died
///   while it was in the background (the common mobile case) would otherwise
///   show a break timer anchored to a state it left long ago. A `ready` on
///   break then states its own `break_reason` when the server sends one, and
///   [SessionStateAction] fills the rest back in from the HTTP answer of the
///   request that caused the transition.
/// * `wrapup` for a different attempt than the panel retained drops that
///   panel (as `ready` already does). A wrap-up redial that fails before it
///   connects can open a wrap-up on the redial's attempt without a `reserved`
///   first; the panel held for the call it redialled must not keep the notes
///   and the outcome keyed to that closed call.
/// * `queue` (contact assignment): the agent's own queue on a `strict` or
///   `preferred` campaign, from the bootstrap, the `ready` snapshot and the
///   `queue` frame. Nothing else moves it, and it moves nothing else.
/// * `inboundCall` and `customerWaiting` (inbound calls, `docs/inbound.md` §6):
///   the console keeps them in its own hooks beside the reducer; here they sit
///   in it, so the phase can follow an inbound call as it follows a campaign
///   one (`effectiveState`).

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
    this.redialRemaining,
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

  /// Wrap-up redials left, as the frame stated it: null when redial is not
  /// offered, 0 when the limit is used up.
  final int? redialRemaining;

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
      other.dispositionSubmitted == dispositionSubmitted &&
      other.redialRemaining == redialRemaining;

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
        redialRemaining,
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
    redialRemaining: wrapup.redialRemaining,
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
    this.queue,
    this.inboundCall,
    this.customerWaiting,
    this.retiredInbound = const [],
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

  /// The session's soft-phone call: the newest copy seen, from a
  /// `manual_call` frame or an adopted HTTP answer (`newerCall`, the frame
  /// winning a tie). Kept once settled until the next dial replaces it, so the
  /// soft phone sees it settle. Cleared only with the session.
  final ManualCall? manualCall;

  /// The agent's own queue (contact assignment): due, or nothing due and why.
  /// Null on a `pool` campaign (and from a server older than the feature).
  final QueueState? queue;

  /// The station's inbound call: the newest copy seen, from an `inbound_call`
  /// frame or an adopted HTTP answer (`newerInboundCall`, the frame winning a
  /// tie). Kept once it leaves the station (settled, requeued) until a newer
  /// one replaces it, a campaign call arrives or a reconcile retires it; only
  /// a copy on the station (`isInboundOnStation`) moves anything.
  final InboundCall? inboundCall;

  /// "Your customer is waiting": a caller sticky to this agent waits for them
  /// while they are busy. Cleared by the server's `cleared: true` for that
  /// caller, and as a backstop by an offer, a `ready` (re-sent while they
  /// wait) and the station leaving reserved / on a call / wrap-up.
  final CustomerWaitingFrame? customerWaiting;

  /// The inbound copies the station let go of without a newer copy replacing them: retired
  /// (the server said this station no longer holds it) or dropped (a campaign `reserved`
  /// arrived over it). The console's `staleKeys`: a frame of one of these snapshots is ignored,
  /// and an HTTP answer no further along than one (`isInboundStale`) is never adopted, so a
  /// late PATCH, hang-up or GET answer cannot bring a call back that the station let go of.
  /// Newest last, at most [retiredInboundLimit].
  final List<InboundCall> retiredInbound;

  /// How many let-go copies [retiredInbound] keeps.
  static const retiredInboundLimit = 8;

  /// The inbound call when it holds the station (offered, connected, owing its
  /// outcome), else null.
  InboundCall? get inboundOnStation => isInboundOnStation(inboundCall) ? inboundCall : null;

  /// The inbound call when it is the call on screen: on the station and no campaign attempt
  /// live beside it. [effectiveState] reads the same precedence (a live attempt first), so the
  /// phase, the screen and where notes, the outcome, DNC and hang-up go always agree.
  InboundCall? get inboundOnScreen => live == null ? inboundOnStation : null;

  /// The attempt the station holds now (live, retained for wrap-up, or the
  /// wrap-up's own). What notes and the disposition are keyed by.
  String? get currentAttemptId => live?.attemptId ?? retainedAttempt?.attemptId ?? wrapup?.attemptId;

  /// The agent's state as everything on this phone reads it (the screen, the
  /// shell's signals, the away rules, the notification): the call decides
  /// ahead of [agentState], as the console's rail does.
  ///
  /// The server sends no `agent_state` for `reserved` or `on_call` on the dial
  /// path: a campaign call (paced or a wrap-up redial) arrives as `reserved`,
  /// `bridged` and `released` frames while [agentState] still says what it
  /// said before (`available`, or `wrapup` for a redial). So:
  /// * a live attempt: `on_call` once bridged, `reserved` until then;
  /// * no live attempt but a call still owing its outcome (the panel retained
  ///   by a `released` that requires a disposition) or a wrap-up anchor:
  ///   `wrapup`, until `agent_state` (the one authority for wrap-up ending,
  ///   which clears both) says otherwise. It covers the moment between
  ///   `released` and the `agent_state` that follows it;
  /// * an inbound call on the station: `reserved` while offered, `on_call`
  ///   once connected, `wrapup` while its outcome is owed (the server states
  ///   `agent_state` for these too, but the call is what moves first, and a
  ///   reconnect restates the call after `ready`);
  /// * otherwise [agentState].
  AgentState get effectiveState {
    final call = live;
    if (call != null) return call.bridgedAt != null ? AgentState.onCall : AgentState.reserved;
    final inbound = inboundAgentState(inboundCall);
    if (inbound != null) return inbound;
    if (retainedAttempt != null || wrapup != null) return AgentState.wrapup;
    return agentState;
  }

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
    Object? queue = _keep,
    Object? inboundCall = _keep,
    Object? customerWaiting = _keep,
    List<InboundCall>? retiredInbound,
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
        manualCall: identical(manualCall, _keep) ? this.manualCall : manualCall as ManualCall?,
        queue: identical(queue, _keep) ? this.queue : queue as QueueState?,
        inboundCall: identical(inboundCall, _keep) ? this.inboundCall : inboundCall as InboundCall?,
        customerWaiting:
            identical(customerWaiting, _keep) ? this.customerWaiting : customerWaiting as CustomerWaitingFrame?,
        retiredInbound: retiredInbound ?? this.retiredInbound,
      );

  /// [call] let go of: kept in [retiredInbound] (bounded), and no longer held.
  StationState _letGoInbound(InboundCall call) {
    final kept = [...retiredInbound, call];
    return _with(
      inboundCall: null,
      retiredInbound: List.unmodifiable(
        kept.length > retiredInboundLimit ? kept.sublist(kept.length - retiredInboundLimit) : kept,
      ),
    );
  }

  @override
  String toString() => 'StationState($connection, $agentState, live: ${live?.attemptId}, '
      'retained: ${retainedAttempt?.attemptId}, wrapup: ${wrapup?.attemptId}, release: ${release?.reasonRaw}, '
      'pendingBreak: $pendingBreakCode, missedPings: $missedPings, manual: $manualCall, queue: $queue, '
      'inbound: $inboundCall, waiting: ${customerWaiting?.inboundCallId})';
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
/// [breakReason]: why the agent is on break, when [frame] is `break`: the
/// frame's own `break_reason`, or the caller's fallback (the bootstrap's) when
/// a server older than the field sent none.
final class ReadyAction extends StationAction {
  const ReadyAction(this.frame, {this.wrapup, this.breakReason});
  final ReadyFrame frame;
  final WrapupAnchor? wrapup;
  final String? breakReason;
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

/// A `manual_call` frame's row (the frame's typed call; a frame whose row did
/// not read is never dispatched). The frame is the authority: it wins a tie.
final class ManualCallAction extends StationAction {
  const ManualCallAction(this.call);
  final ManualCall call;
}

/// An HTTP answer's copy of the session's call (`POST /calls`, the hang-up,
/// the outcome, `PATCH`, a refusal's `call`). Merged by `newerCall` with the
/// copy already held, which wins a tie: the answer to a hang-up is read the
/// instant it is issued and may still say `ringing` after the frame said `ended`.
final class ManualCallAdoptAction extends StationAction {
  const ManualCallAdoptAction(this.call);
  final ManualCall call;
}

/// The bootstrap said the session has no call: drops the held copy, but only
/// if it is still the copy named by [versionKey] (`ManualCall.versionKey`,
/// `id@updated_at`). A newer frame that arrived after the bootstrap was asked
/// for is kept (the console's `staleKeys`).
final class ManualCallRetireAction extends StationAction {
  const ManualCallRetireAction(this.versionKey);
  final String versionKey;
}

/// The HTTP answer to a session transition (`break`, `available`,
/// `break/cancel`). Reconciliation only: it never changes the state, it only
/// supplies the `since` (and a break reason) a `ready` snapshot may lack, and
/// only while the station is in that same state and knows no anchor of its own.
final class SessionStateAction extends StationAction {
  const SessionStateAction(this.response);
  final SessionStateResponse response;
}

/// The agent's own queue as the bootstrap or a `queue` frame states it
/// (contact assignment). The `ready` snapshot states it through [ReadyAction].
final class QueueAction extends StationAction {
  const QueueAction(this.queue);
  final QueueState queue;
}

/// An `inbound_call` frame's call (a frame whose call did not read is never
/// dispatched). The frame is the authority: it wins a tie.
final class InboundCallAction extends StationAction {
  const InboundCallAction(this.call);
  final InboundCall call;
}

/// An HTTP answer's copy of the station's inbound call (`GET`, `PATCH`, the
/// hang-up, the outcome). Merged by `newerInboundCall` with the copy held,
/// which wins a tie.
final class InboundCallAdoptAction extends StationAction {
  const InboundCallAdoptAction(this.call);
  final InboundCall call;
}

/// The server no longer holds the call for this station (`inbound_call_not_found`,
/// or answered as another session's): drops the held copy, but only if it is
/// still the snapshot named by [snapshotKey] (`inboundSnapshotKey`), so a
/// newer frame that arrived meanwhile is kept. The copy dropped is remembered
/// ([StationState.retiredInbound], the console's `staleKeys`), so no late answer
/// about it is adopted.
final class InboundCallRetireAction extends StationAction {
  const InboundCallRetireAction(this.snapshotKey);
  final String snapshotKey;
}

/// A `customer_waiting` frame.
final class CustomerWaitingAction extends StationAction {
  const CustomerWaitingAction(this.frame);
  final CustomerWaitingFrame frame;
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
  final next = _reduce(state, action);
  // "Your customer is waiting" belongs to the call it waits behind: once the
  // station leaves reserved / on a call / wrap-up, the caller is the agent's
  // next offer (or gone), and the server says which.
  if (next.customerWaiting != null && isCallPhase(state.effectiveState) && !isCallPhase(next.effectiveState)) {
    return next._with(customerWaiting: null);
  }
  return next;
}

/// A new inbound offer reaching the station replaces whatever is on it, as a
/// campaign `reserved` does: the agent was reserved for it from `available`
/// (or from a wrap-up, by the release hook), so anything held is over.
StationState _offerArrived(StationState state) => state._with(
      release: null,
      releasedAt: null,
      retainedAttempt: null,
      wrapup: null,
      missedRelease: null,
      live: null,
      customerWaiting: null,
    );

StationState _inboundCall(StationState state, InboundCall? newer) {
  if (identical(newer, state.inboundCall) || newer == state.inboundCall) return state;
  final held = state.inboundCall;
  final offered = newer != null &&
      inboundPhase(newer) == InboundPhase.offered &&
      (held == null || inboundOfferKey(held) != inboundOfferKey(newer));
  final base = offered ? _offerArrived(state) : state;
  return base._with(inboundCall: newer);
}

StationState _reduce(StationState state, StationAction action) {
  switch (action) {
    case ConnectionAction(:final connection):
      return connection == state.connection ? state : state._with(connection: connection);

    case MissedPingsAction(:final count):
      return count == state.missedPings ? state : state._with(missedPings: count);

    case ReadyAction(:final frame, wrapup: final anchor, :final breakReason):
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
        // The agent's own queue, replaced like every other field: absent on a
        // `pool` campaign, so a snapshot without it clears it.
        queue: frame.queue,
        // Re-sent after `ready` while the caller still waits.
        customerWaiting: null,
      );
      // `inboundCall` is kept: `ready` does not carry it, and the server
      // restates a call it still holds right after (else the station asks).
      if (frame.state != previous) {
        // Mobile addition: these described the state that was left.
        next = next._with(agentStateSince: null, breakReasonCode: null);
      }
      // The break's reason, when the server states it: what tells a pause for
      // leaving the app (`device_away`) from a break the agent chose, even
      // after the app was killed and remembers nothing of its own.
      if (frame.state == AgentState.onBreak && breakReason != null) next = next._with(breakReasonCode: breakReason);
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
      if (identical(anchor, state.wrapup)) return state;
      // Mobile addition: a panel held for another attempt belongs to a call
      // this wrap-up is not about (a redial that failed before `reserved`).
      final held = state.retainedAttempt;
      return held != null && held.attemptId != anchor.attemptId
          ? state._with(wrapup: anchor, retainedAttempt: null)
          : state._with(wrapup: anchor);

    case ReservedAction(:final attempt):
      // A new reservation always wins: whatever is on screen belongs to a call
      // that is over (an inbound copy still held included, and let go of for good: a late
      // answer about it must not put it back beside this call).
      final heldInbound = state.inboundCall;
      return (heldInbound == null ? state : state._letGoInbound(heldInbound))._with(
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
      return identical(newer, state.manualCall) || newer == state.manualCall ? state : state._with(manualCall: newer);

    case ManualCallAdoptAction(:final call):
      // The held copy goes first: an HTTP answer never displaces an equal-stamped frame.
      final newer = newerCall(state.manualCall, call);
      return identical(newer, state.manualCall) || newer == state.manualCall ? state : state._with(manualCall: newer);

    case ManualCallRetireAction(:final versionKey):
      final held = state.manualCall;
      return held == null || held.versionKey != versionKey ? state : state._with(manualCall: null);

    case InboundCallAction(:final call):
      // A snapshot the station let go of stays gone (the console's `staleKeys`).
      final key = inboundSnapshotKey(call);
      if (state.retiredInbound.any((r) => inboundSnapshotKey(r) == key)) return state;
      // The frame's copy goes first so it wins a tie: the frame is the authority.
      return _inboundCall(state, newerInboundCall(call, state.inboundCall));

    case InboundCallAdoptAction(:final call):
      // An answer read before the station let the call go is never news.
      if (isInboundStale(call, state.retiredInbound)) return state;
      // The held copy goes first: an HTTP answer never displaces an equal frame.
      return _inboundCall(state, newerInboundCall(state.inboundCall, call));

    case InboundCallRetireAction(:final snapshotKey):
      final held = state.inboundCall;
      return held == null || inboundSnapshotKey(held) != snapshotKey ? state : state._letGoInbound(held);

    case CustomerWaitingAction(:final frame):
      if (frame.cleared) {
        final shown = state.customerWaiting;
        return shown == null || shown.inboundCallId != frame.inboundCallId ? state : state._with(customerWaiting: null);
      }
      return frame == state.customerWaiting ? state : state._with(customerWaiting: frame);

    case QueueAction(:final queue):
      return queue == state.queue ? state : state._with(queue: queue);

    case SessionStateAction(:final response):
      if (response.state != state.agentState || state.agentStateSince != null) return state;
      return state._with(
        agentStateSince: response.since,
        breakReasonCode: response.state == AgentState.onBreak ? response.breakReason : state.breakReasonCode,
      );
  }
}
