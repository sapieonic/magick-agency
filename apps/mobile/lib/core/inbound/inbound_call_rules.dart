import 'package:agency_wire/agency_wire.dart';

/// An inbound call on the agent's station (`docs/inbound.md` §6), as the station core reads
/// it: a port of the console's `utils/inbound/inboundCall.ts`.
///
/// ── One row, replaced whole ──────────────────────────────────────────────────
/// Every change of the call arrives as an `inbound_call` frame carrying the WHOLE call, and the
/// call routes answer with the same row, as the soft phone's `manual_call` does. So nothing is
/// patched: the station holds the newest copy it has seen from any source, and
/// [newerInboundCall] is the one rule for "newest". The row has no `updated_at`, so "newest" is
/// read off the call's own progress.

/// What the station shows for the call:
///
///  * [offered]: the panel is up and audio binds at `connects_at` (IB1: panel before audio);
///  * [connected]: audio both ways;
///  * [outcome]: the call ended after it was answered and owes its outcome.
///
/// Null (from [inboundPhase]): nothing to show. Settled (outcome saved, lapsed, or ended before
/// it was answered), or no longer this station's (a requeued call is `queued` again).
enum InboundPhase { offered, connected, outcome }

InboundPhase? inboundPhase(InboundCall? call) {
  if (call == null || call.settledAt != null) return null;
  switch (call.state) {
    case InboundCallState.offered:
      return InboundPhase.offered;
    case InboundCallState.connected:
      return InboundPhase.connected;
    case InboundCallState.ended:
      // An unbridged end is settled by the server in the same write; a copy that says
      // otherwise owes nothing all the same: nobody spoke to the caller.
      return call.bridgedAt != null ? InboundPhase.outcome : null;
    default:
      return null;
  }
}

/// The call still holds the station: offered, connected, or ended owing its outcome.
bool isInboundOnStation(InboundCall? call) => inboundPhase(call) != null;

/// On the line: offered or connected.
bool isInboundLive(InboundCall? call) {
  final phase = inboundPhase(call);
  return phase == InboundPhase.offered || phase == InboundPhase.connected;
}

/// The agent state the call puts the station in, as the console's rail reads it: offered is
/// `reserved`, connected `on_call`, an owed outcome `wrapup`; null when the call holds nothing.
AgentState? inboundAgentState(InboundCall? call) => switch (inboundPhase(call)) {
      InboundPhase.offered => AgentState.reserved,
      InboundPhase.connected => AgentState.onCall,
      InboundPhase.outcome => AgentState.wrapup,
      null => null,
    };

/// How far one offer of a call has got. An offer goes `offered` → `connected` → `ended`, or
/// `offered` → `queued` (requeued: the station was lost before audio bound), or `offered` →
/// `ended` (the caller hung up first); `queued` and `connected` never follow each other within
/// one offer, so they share a rank.
int _progress(InboundCallState state) => switch (state) {
      InboundCallState.arrived || InboundCallState.greeting || InboundCallState.unknown => 0,
      InboundCallState.offered => 1,
      InboundCallState.queued || InboundCallState.connected => 2,
      InboundCallState.ended => 3,
    };

/// The newer of two copies of "the station's inbound call".
///
/// Different calls: the later offer (`offered_at`) wins: a new offer always replaces the call
/// before it. The same call: a later offer of it (a re-offer after a requeue) wins; within one
/// offer, a settled copy beats an unsettled one (settling never reverses), then the copy further
/// along. On a tie [a] wins, so pass the frame's copy first: the frame is the authority, and the
/// HTTP answer to a hang-up is read the instant the hang-up is issued.
InboundCall? newerInboundCall(InboundCall? a, InboundCall? b) {
  if (a == null) return b;
  if (b == null) return a;
  final aOffer = a.offeredAt;
  final bOffer = b.offeredAt;
  if (a.id != b.id) return bOffer.isAfter(aOffer) ? b : a;
  if (bOffer != aOffer) return bOffer.isAfter(aOffer) ? b : a;
  if (a.isSettled != b.isSettled) return b.isSettled ? b : a;
  return _progress(b.state) > _progress(a.state) ? b : a;
}

/// One snapshot of a call, for "the server said THIS copy is over" (the console's
/// `snapshotKey`): a copy retired by it leaves, and a newer one (another state, another offer)
/// does not.
String inboundSnapshotKey(InboundCall call) =>
    '${call.id}@${call.offeredAt.toUtc().toIso8601String()}@${call.stateRaw}@${call.settledAt?.toUtc().toIso8601String() ?? ''}';

/// An HTTP answer the station must not adopt: a copy of a call the station let go of
/// ([retired]: retired or dropped copies) that is no further along than the copy let go of (the
/// same snapshot, an earlier offer, or the same offer no further on). A later offer of the call,
/// or a copy further on (settled, say), is news and is adopted.
bool isInboundStale(InboundCall answer, Iterable<InboundCall> retired) =>
    retired.any((r) => r.id == answer.id && identical(newerInboundCall(r, answer), r));

/// One offer of a call: the chime rings once per key (a restatement is silent, a re-offer
/// after a requeue rings again).
String inboundOfferKey(InboundCall call) => '${call.id}@${call.offeredAt.toUtc().toIso8601String()}';

/// Why an inbound call left the station without the agent's outcome, said for
/// `inboundNoticeDuration` (the console's `notice`).
enum InboundLeftReason {
  /// It ended before the caller was connected: they hung up first.
  hungUpEarly,

  /// Answered, then closed without an outcome because its window ran out.
  windowEnded,

  /// Answered, then closed without an outcome before its window ran out: a supervisor.
  closedBySupervisor,

  /// Offered, then back in the queue (the station was away when audio was due to bind).
  requeued,
}

/// Why [last] (the copy that left the station) left without the agent's outcome, or null when
/// it left with one (or for no reason worth a word). [now] is on the server's clock;
/// [dueAt] is the window's end as the copy held before it said it (a settled row need not
/// carry it any more).
InboundLeftReason? inboundLeftReason(InboundCall last, DateTime now, {DateTime? dueAt}) {
  if (last.isSettled && last.bridgedAt == null) return InboundLeftReason.hungUpEarly;
  if (last.isSettled && last.dispositionCode == null) {
    final due = last.outcomeDueAt ?? dueAt;
    return due != null && !now.isBefore(due) ? InboundLeftReason.windowEnded : InboundLeftReason.closedBySupervisor;
  }
  if (last.state == InboundCallState.queued) return InboundLeftReason.requeued;
  return null;
}

/// When an offer still on offer here, with nothing settling it, has lost the frame that would
/// have (the station's backstop): [staleAfter] past the moment its audio was due to bind, or
/// null when nothing here can tell.
///
///  * A station offer (Mode A) binds at `connects_at`: stale [staleAfter] after it.
///  * A push offer (Mode B, IQ66) has no `connects_at`: it binds once the app has accepted and
///    its station has attached, inside [inboundAcceptGrace] of `accepted_at` (the server lapses it
///    `accept_lapsed` after that). Stale [staleAfter] past the grace, never sooner: a slow cold
///    start on mobile data is still inside it. Not accepted yet (no `accepted_at`): not this
///    station's to retire on a guess.
DateTime? inboundOfferStaleAt(InboundCall call, Duration staleAfter) {
  if (inboundPhase(call) != InboundPhase.offered) return null;
  final connectsAt = call.connectsAt;
  if (connectsAt != null) return connectsAt.add(staleAfter);
  final acceptedAt = call.acceptedAt;
  if (call.isPushOffer && acceptedAt != null) return acceptedAt.add(inboundAcceptGrace).add(staleAfter);
  return null;
}
