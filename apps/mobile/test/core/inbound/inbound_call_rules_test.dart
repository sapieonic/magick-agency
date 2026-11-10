import 'package:agency_wire/agency_wire.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:magick_agency_agent/core/inbound/inbound_call_rules.dart';
import 'package:magick_agency_agent/core/station/station_state.dart';

import 'inbound_fixtures.dart';

void main() {
  final offered = inboundCall('inbound_call_offered');
  final connected = inboundCall('inbound_call_connected');
  final owed = inboundCall('inbound_call_outcome_owed');
  final settled = inboundCall('inbound_call_settled');
  final withheld = inboundCall('inbound_call_withheld');

  group('inboundPhase (the console\'s inboundPhase)', () {
    test('offered, connected, ended owing its outcome; nothing once settled', () {
      expect(inboundPhase(offered), InboundPhase.offered);
      expect(inboundPhase(connected), InboundPhase.connected);
      expect(inboundPhase(owed), InboundPhase.outcome);
      expect(inboundPhase(settled), isNull);
      expect(inboundPhase(null), isNull);
    });

    test('an unbridged end owes nothing, and a requeued call is no longer the station\'s', () {
      expect(inboundPhase(inboundCall('inbound_call_offered', overrides: {'state': 'ended', 'outcome': 'abandoned_in_queue'})), isNull);
      expect(inboundPhase(inboundCall('inbound_call_offered', overrides: {'state': 'queued'})), isNull);
    });

    test('the agent state each phase reads as', () {
      expect(inboundAgentState(offered), AgentState.reserved);
      expect(inboundAgentState(connected), AgentState.onCall);
      expect(inboundAgentState(owed), AgentState.wrapup);
      expect(inboundAgentState(settled), isNull);
      expect(isInboundLive(offered) && isInboundLive(connected), isTrue);
      expect(isInboundLive(owed), isFalse);
      expect(isInboundOnStation(owed), isTrue);
    });
  });

  group('newerInboundCall (the console\'s newerInboundCall)', () {
    test('null on either side', () {
      expect(newerInboundCall(null, offered), same(offered));
      expect(newerInboundCall(offered, null), same(offered));
      expect(newerInboundCall(null, null), isNull);
    });

    test('another call: the later offer wins, whatever its progress', () {
      expect(newerInboundCall(owed, withheld), same(withheld), reason: 'offered later');
      expect(newerInboundCall(withheld, owed), same(withheld));
    });

    test('the same offer: further along wins, settled beats unsettled', () {
      expect(newerInboundCall(offered, connected), same(connected));
      expect(newerInboundCall(connected, offered), same(connected), reason: 'a late offered frame never undoes the connect');
      expect(newerInboundCall(owed, connected), same(owed));
      expect(newerInboundCall(owed, settled), same(settled));
      expect(newerInboundCall(settled, owed), same(settled), reason: 'settling never reverses');
    });

    test('a re-offer after a requeue wins over the requeued copy', () {
      final requeued = inboundCall('inbound_call_offered', overrides: {'state': 'queued'});
      final reoffer = inboundCall('inbound_call_offered', overrides: {'offered_at': '2026-11-02T05:31:00.000Z'});
      expect(newerInboundCall(requeued, reoffer), same(reoffer));
      expect(newerInboundCall(offered, requeued), same(requeued), reason: 'queued is past offered within one offer');
    });

    test('a tie goes to the first: pass the frame first', () {
      final again = inboundCall('inbound_call_connected');
      expect(newerInboundCall(connected, again), same(connected));
      expect(newerInboundCall(again, connected), same(again));
    });
  });

  test('keys: a snapshot names one copy, an offer key one offer', () {
    expect(inboundSnapshotKey(offered), isNot(inboundSnapshotKey(connected)));
    expect(inboundSnapshotKey(owed), isNot(inboundSnapshotKey(settled)));
    expect(inboundOfferKey(offered), inboundOfferKey(connected));
    expect(inboundOfferKey(offered), isNot(inboundOfferKey(inboundCall('inbound_call_offered', overrides: {'offered_at': '2026-11-02T05:31:00.000Z'}))));
  });

  group('why a call left without the agent\'s outcome', () {
    final now = DateTime.utc(2026, 11, 2, 5, 40);
    test('the caller hung up before they were connected', () {
      final early = inboundCall('inbound_call_offered', overrides: {
        'state': 'ended',
        'outcome': 'abandoned_in_queue',
        'settled_at': '2026-11-02T05:30:15.000Z',
      });
      expect(inboundLeftReason(early, now), InboundLeftReason.hungUpEarly);
    });

    test('closed without one: the window ran out, or a supervisor closed it first', () {
      final closed = inboundCall('inbound_call_settled', overrides: {'disposition_code': null});
      expect(inboundLeftReason(closed, now, dueAt: DateTime.utc(2026, 11, 2, 5, 35)), InboundLeftReason.windowEnded);
      expect(inboundLeftReason(closed, now, dueAt: DateTime.utc(2026, 11, 2, 6, 4)), InboundLeftReason.closedBySupervisor);
    });

    test('back in the queue; and nothing to say when the agent saved it', () {
      expect(inboundLeftReason(inboundCall('inbound_call_offered', overrides: {'state': 'queued'}), now), InboundLeftReason.requeued);
      expect(inboundLeftReason(settled, now), isNull);
    });
  });

  group('the reducer holds the call and the waiting customer', () {
    StationState with0(List<StationAction> actions) =>
        actions.fold(StationState.initial, (s, a) => stationReducer(s, a));

    test('the phase follows the call: reserved, on a call, wrap-up, then agent_state', () {
      var s = with0([ReadyAction(ReadyFrame(sessionId: 'sess-1', state: AgentState.available))]);
      s = stationReducer(s, InboundCallAction(offered));
      expect(s.effectiveState, AgentState.reserved);
      s = stationReducer(s, InboundCallAction(connected));
      expect(s.effectiveState, AgentState.onCall);
      s = stationReducer(s, InboundCallAction(owed));
      expect(s.effectiveState, AgentState.wrapup);
      s = stationReducer(s, InboundCallAction(settled));
      expect(s.effectiveState, AgentState.available);
      expect(s.inboundCall, same(settled), reason: 'kept, off the station, until replaced');
    });

    test('an HTTP answer never displaces the frame it ties, and a stale one is ignored', () {
      var s = stationReducer(StationState.initial, InboundCallAction(connected));
      s = stationReducer(s, InboundCallAdoptAction(inboundCall('inbound_call_connected')));
      expect(s.inboundCall, same(connected));
      s = stationReducer(s, InboundCallAdoptAction(offered));
      expect(s.inboundCall, same(connected));
    });

    test('retire drops only the snapshot it names', () {
      var s = stationReducer(StationState.initial, InboundCallAction(offered));
      final key = inboundSnapshotKey(offered);
      s = stationReducer(s, InboundCallAction(connected));
      expect(stationReducer(s, InboundCallRetireAction(key)).inboundCall, same(connected), reason: 'a newer frame survives');
      expect(stationReducer(s, InboundCallRetireAction(inboundSnapshotKey(connected))).inboundCall, isNull);
    });

    test('ready keeps the call; a campaign reservation replaces it', () {
      var s = stationReducer(StationState.initial, InboundCallAction(connected));
      s = stationReducer(s, ReadyAction(ReadyFrame(sessionId: 'sess-1', state: AgentState.onCall)));
      expect(s.inboundCall, same(connected));
      s = stationReducer(
        s,
        ReservedAction(ReservedAttempt(
          attemptId: 'a1',
          campaignId: 'c',
          campaignName: 'C',
          contactId: 'k',
          phoneE164: '+919876543210',
          callerId: '+911234567890',
          attemptNumber: 1,
          context: const {},
          priorAttempts: const [],
        )),
      );
      expect(s.inboundCall, isNull);
    });

    test('customer_waiting: set, cleared by its own cleared frame only', () {
      final waiting = CustomerWaitingFrame.fromJson(stationFrame('customer_waiting'));
      final cleared = CustomerWaitingFrame.fromJson(stationFrame('customer_waiting_cleared'));
      var s = stationReducer(StationState.initial, InboundCallAction(connected));
      s = stationReducer(s, CustomerWaitingAction(waiting));
      expect(s.customerWaiting, waiting);
      final other = CustomerWaitingFrame(inboundCallId: 'other', waitingSince: DateTime.utc(2026), cleared: true);
      expect(stationReducer(s, CustomerWaitingAction(other)).customerWaiting, waiting, reason: 'another caller cleared');
      expect(stationReducer(s, CustomerWaitingAction(cleared)).customerWaiting, isNull);
    });

    test('customer_waiting backstops: an offer, a ready, and leaving the call phases', () {
      final waiting = CustomerWaitingFrame.fromJson(stationFrame('customer_waiting'));
      final busy = stationReducer(stationReducer(StationState.initial, InboundCallAction(owed)), CustomerWaitingAction(waiting));
      expect(stationReducer(busy, InboundCallAction(withheld)).customerWaiting, isNull, reason: 'an offer');
      expect(
        stationReducer(busy, ReadyAction(ReadyFrame(sessionId: 'sess-1', state: AgentState.wrapup))).customerWaiting,
        isNull,
        reason: 'ready: re-sent while they wait',
      );
      expect(stationReducer(busy, InboundCallAction(settled)).customerWaiting, isNull, reason: 'out of wrap-up');
      expect(stationReducer(busy, InboundCallAction(owed)).customerWaiting, waiting, reason: 'still in wrap-up');
    });

    test('an offer clears what a campaign call left on screen', () {
      var s = stationReducer(StationState.initial, const WrapupAction(WrapupAnchor(
        attemptId: 'a1',
        deadline: null,
        total: null,
        requiresDisposition: true,
        heldReason: null,
        autoReturn: true,
      )));
      expect(s.effectiveState, AgentState.wrapup);
      s = stationReducer(s, InboundCallAction(offered));
      expect(s.wrapup, isNull);
      expect(s.effectiveState, AgentState.reserved);
    });
  });
}
