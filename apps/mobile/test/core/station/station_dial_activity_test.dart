import 'package:agency_wire/agency_wire.dart';
import 'package:fake_async/fake_async.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:magick_agency_agent/core/station/station_controller.dart';
import 'package:magick_agency_agent/core/station/station_state.dart';
import 'package:magick_agency_agent/core/station/station_view.dart';
import 'package:magick_agency_agent/core/station/station_view_mapper.dart';
import 'package:magick_agency_agent/features/station/station_screen.dart' show StationStage, stationStageOf;

import '../inbound/inbound_fixtures.dart';
import 'controller_harness.dart';
import 'fixtures.dart';

/// Late binding's hidden dials: the dialer rings a customer for an idle agent and shows them
/// nothing unless the customer answers. The `dial_activity` frame and the `ready` snapshot say
/// a dial is ringing and how many in a row went unanswered; the station holds "dialling"
/// through the gap between one dial and the next ([StationController.dialGapHold]).
///
/// Driven only by the sequences the server sends:
/// * not answered: `dial_activity {ringing, n}` → ~30 s → `dial_activity {!ringing, n+1}` →
///   `agent_state available` → 0.3–2 s → `dial_activity {ringing, n+1}`;
/// * answered: `dial_activity {ringing, n}` → `reserved` → `bridged` → `released` → wrap-up →
///   `agent_state available` (no frame resets the count: `reserved` does, server-side);
/// * cancelled by the customer ringing in (a station with `caps=inbound`):
///   `dial_activity {!ringing, n}` → `agent_state reserved` → `inbound_call` (offered);
/// * a break queued mid-ring: `dial_activity {!ringing, n+1}` → `agent_state break`;
/// * reconnect: `ready` with or without `dial_activity`; mid-ring, `ready {state: available,
///   dial_activity: {ringing, n}}` with no `active_attempt` (never `reserved`).

const _ringing = DialActivity(ringing: true, unansweredInARow: 0);

void _dial(App app, {required bool ringing, required int unanswered, String campaignId = 'camp-1'}) => app.frame({
      'event': 'dial_activity',
      'campaign_id': campaignId,
      'ringing': ringing,
      'unanswered_in_a_row': unanswered,
    });

/// The station's dial-gap hold timer, while one is pending.
Iterable<FakeTimer> _holds(FakeAsync async) =>
    async.pendingTimers.where((t) => t.duration == StationController.dialGapHold);

/// Lets [d] pass with the socket healthy: the server answers each heartbeat, as it does.
void _wait(App app, Duration d) {
  var left = d;
  while (left > Duration.zero) {
    final step = left < const Duration(seconds: 2) ? left : const Duration(seconds: 2);
    app.async.elapse(step);
    left -= step;
    if (app.socket.pings.isNotEmpty) app.socket.serverPong();
    app.async.flushMicrotasks();
  }
}

/// One hidden dial that rang out: its two frames and the `agent_state` that follows.
void _rangOut(App app, {required int before}) {
  _dial(app, ringing: true, unanswered: before);
  _wait(app, const Duration(seconds: 30));
  _dial(app, ringing: false, unanswered: before + 1);
  app.agentStateFrame('available');
}

void main() {
  group('reducer', () {
    test('a dial_activity action states it; the same again changes nothing; it moves nothing else', () {
      final before = stationReducer(StationState.initial, AgentStateAction(agentState(AgentState.available)));
      final s = stationReducer(before, const DialActivityAction(_ringing));
      expect(s.dialActivity, _ringing);
      expect(identical(stationReducer(s, const DialActivityAction(_ringing)), s), isTrue);
      expect(s.agentState, before.agentState);
      expect(s.effectiveState, AgentState.available);
      expect(s.live, isNull);
    });

    test('reserved clears it: the server reset the count and sends no frame to say so', () {
      final s = stationReducer(StationState.initial, const DialActivityAction(DialActivity(ringing: true, unansweredInARow: 4)));
      expect(stationReducer(s, ReservedAction(attempt('a1'))).dialActivity, isNull);
    });

    test('ready is a snapshot: it states it, one without it clears it, and a live attempt clears it', () {
      final held = stationReducer(StationState.initial, const DialActivityAction(DialActivity(ringing: false, unansweredInARow: 3)));
      final frame = StationFrame.decode(
        '{"event":"ready","session_id":"sess-1","state":"available","dial_activity":{"ringing":true,"unanswered_in_a_row":2}}',
      ) as ReadyFrame;
      expect(stationReducer(held, ReadyAction(frame)).dialActivity, const DialActivity(ringing: true, unansweredInARow: 2));
      expect(stationReducer(held, ReadyAction(ready())).dialActivity, isNull);
      expect(
        stationReducer(held, ReadyAction(ready(state: AgentState.onCall, active: activeAttempt('a1', bridgedAt: DateTime.utc(2026))))).dialActivity,
        isNull,
      );
    });
  });

  group('mapper', () {
    StationState available(DialActivity a, {bool dialing = true}) {
      var s = stationReducer(StationState.initial, const ConnectionAction(StationConnection.open));
      s = stationReducer(s, AgentStateAction(agentState(AgentState.available)));
      if (!dialing) s = stationReducer(s, const CampaignStateAction(dialing: false));
      return stationReducer(s, DialActivityAction(a));
    }

    DialActivityView? of(StationState s, {bool held = false}) => StationViewMapper.dialActivityOf(s, gapHeld: held);

    test('ringing, or held: dialling; the count is carried; count 0 and not dialling: nothing to say', () {
      expect(of(available(_ringing)), const DialActivityView(dialling: true, unansweredInARow: 0));
      const ended = DialActivity(ringing: false, unansweredInARow: 2);
      expect(of(available(ended), held: true), const DialActivityView(dialling: true, unansweredInARow: 2));
      expect(of(available(ended)), const DialActivityView(dialling: false, unansweredInARow: 2));
      expect(of(available(const DialActivity(ringing: false, unansweredInARow: 0)), held: true),
          const DialActivityView(dialling: true, unansweredInARow: 0));
      expect(of(available(const DialActivity(ringing: false, unansweredInARow: 0))), isNull);
    });

    test('only while available with the socket open, the campaign dialling and no call on screen', () {
      expect(of(available(_ringing, dialing: false)), isNull);
      expect(of(stationReducer(available(_ringing), const ConnectionAction(StationConnection.reconnecting))), isNull);
      final onBreak = stationReducer(available(_ringing), AgentStateAction(agentState(AgentState.onBreak)));
      expect(of(onBreak), isNull);
      // A `reserved` clears the activity in the reducer; even one held beside a call shows nothing.
      final reserved = stationReducer(available(_ringing), ReservedAction(attempt('a1')));
      expect(of(stationReducer(reserved, const DialActivityAction(_ringing))), isNull);
    });
  });

  group('controller', () {
    test('a hidden dial ringing: "dialling", count 0; an early-binding station never sees one', () {
      fakeAsync((async) {
        final app = App(async)..start();
        app.readyFrame('available');
        expect(app.view!.dialActivity, isNull);
        _dial(app, ringing: true, unanswered: 0);
        expect(app.view!.dialActivity, const DialActivityView(dialling: true, unansweredInARow: 0));
        expect(app.view!.phase, AgentPhase.available);
        expect(app.view!.call, isNull);
        app.dispose();
      });
    });

    test('not answered: held through the gap, the next dial carries on, then the count once nothing follows', () {
      fakeAsync((async) {
        final app = App(async)..start();
        app.readyFrame('available');
        _rangOut(app, before: 0);
        // Ended unanswered: still "dialling" for the hold, and now one unanswered.
        expect(app.view!.dialActivity, const DialActivityView(dialling: true, unansweredInARow: 1));
        expect(_holds(async), hasLength(1));
        async.elapse(const Duration(milliseconds: 1500));
        // The next dial, inside the hold: no flicker to "Waiting", and the hold is no longer needed.
        _dial(app, ringing: true, unanswered: 1);
        expect(app.view!.dialActivity, const DialActivityView(dialling: true, unansweredInARow: 1));
        expect(_holds(async), isEmpty);

        // The next one rings out too, and nothing follows it.
        _wait(app, const Duration(seconds: 30));
        _dial(app, ringing: false, unanswered: 2);
        app.agentStateFrame('available');
        async.elapse(StationController.dialGapHold - const Duration(milliseconds: 1));
        expect(app.view!.dialActivity!.dialling, isTrue);
        async.elapse(const Duration(milliseconds: 1));
        expect(app.view!.dialActivity, const DialActivityView(dialling: false, unansweredInARow: 2));
        expect(_holds(async), isEmpty);
        app.dispose();
      });
    });

    test('the last due dial rings out: the queue\'s nothing-due ends the hold at once; a ringing dial still outranks it', () {
      fakeAsync((async) {
        final app = App(async)..start();
        app.readyFrame('available');
        // A strict or preferred campaign: the tick that dials for the agent has stated something due.
        app.frame({'event': 'queue', 'campaign_id': 'camp-1', 'due': true, 'reason': null, 'next_due_at': null});
        // The server's order: the dial's close, the release's `agent_state`, then the next
        // pacing tick's `queue` frame, which says nothing is left.
        _rangOut(app, before: 0);
        expect(app.view!.dialActivity, const DialActivityView(dialling: true, unansweredInARow: 1));
        expect(_holds(async), hasLength(1));
        app.frame({'event': 'queue', 'campaign_id': 'camp-1', 'due': false, 'reason': 'queue_empty', 'next_due_at': null});

        // At once, not after the hold: nothing is being dialled and no call is coming.
        expect(_holds(async), isEmpty);
        expect(app.view!.dialActivity, const DialActivityView(dialling: false, unansweredInARow: 1));
        expect(app.view!.queue!.nothingDue, isTrue);
        async.elapse(StationController.dialGapHold);
        expect(app.view!.dialActivity, const DialActivityView(dialling: false, unansweredInARow: 1));

        // Something falls due and a dial rings: "dialling" again.
        app.frame({'event': 'queue', 'campaign_id': 'camp-1', 'due': true, 'reason': null, 'next_due_at': null});
        _dial(app, ringing: true, unanswered: 1);
        expect(app.view!.dialActivity, const DialActivityView(dialling: true, unansweredInARow: 1));
        app.dispose();
      });
    });

    test('answered: reserved clears it at once, and the next dial counts from 0', () {
      fakeAsync((async) {
        final app = App(async)..start();
        app.readyFrame('available');
        _rangOut(app, before: 0);
        async.elapse(const Duration(seconds: 1));
        _dial(app, ringing: true, unanswered: 1);
        app.reserved('a1');
        expect(app.view!.dialActivity, isNull);
        expect(app.controller.stationState.dialActivity, isNull);
        expect(app.view!.phase, AgentPhase.reserved);
        app.bridged('a1');
        app.releasedFrame('a1');
        app.agentStateFrame('wrapup');
        app.wrapupFrame('a1');
        expect(app.view!.dialActivity, isNull);
        app.agentStateFrame('available');
        // No frame reset the count, and none is shown: the server's count restarted at `reserved`.
        expect(app.view!.dialActivity, isNull);
        _dial(app, ringing: true, unanswered: 0);
        expect(app.view!.dialActivity, const DialActivityView(dialling: true, unansweredInARow: 0));
        app.dispose();
      });
    });

    test('a reserved during the gap drops the hold at once', () {
      fakeAsync((async) {
        final app = App(async)..start();
        app.readyFrame('available');
        _dial(app, ringing: true, unanswered: 0);
        _wait(app, const Duration(seconds: 30));
        _dial(app, ringing: false, unanswered: 1);
        expect(_holds(async), hasLength(1));
        app.reserved('a1');
        expect(_holds(async), isEmpty);
        expect(app.view!.dialActivity, isNull);
        app.dispose();
      });
    });

    test('the count, one and then several', () {
      fakeAsync((async) {
        final app = App(async)..start();
        app.readyFrame('available');
        for (var n = 0; n < 3; n++) {
          _rangOut(app, before: n);
          _wait(app, StationController.dialGapHold);
          expect(app.view!.dialActivity, DialActivityView(dialling: false, unansweredInARow: n + 1));
        }
        app.dispose();
      });
    });

    test('reconnect: ready states it, and a ready without it clears it', () {
      fakeAsync((async) {
        final app = App(async)..start();
        app.frame(stationFrame('ready_dial_activity')..['session_id'] = 'sess-1');
        expect(app.view!.dialActivity, const DialActivityView(dialling: true, unansweredInARow: 2));

        final first = app.socket;
        first.serverClose(1006);
        expect(app.view!.dialActivity, isNull, reason: 'not shown while the socket is down');
        async.elapse(const Duration(seconds: 5));
        expect(identical(app.socket, first), isFalse);
        app.readyFrame('available');
        expect(app.view!.dialActivity, isNull);
        expect(app.controller.stationState.dialActivity, isNull);
        app.dispose();
      });
    });

    test('a socket drop during the gap drops the hold', () {
      fakeAsync((async) {
        final app = App(async)..start();
        app.readyFrame('available');
        _rangOut(app, before: 0);
        expect(_holds(async), hasLength(1));
        app.socket.serverClose(1006);
        expect(_holds(async), isEmpty);
        app.dispose();
      });
    });

    test('a paused campaign never shows it, and pausing drops the hold', () {
      fakeAsync((async) {
        final app = App(async)..start();
        app.readyFrame('available');
        _dial(app, ringing: true, unanswered: 0);
        _wait(app, const Duration(seconds: 30));
        _dial(app, ringing: false, unanswered: 1);
        expect(_holds(async), hasLength(1));
        app.frame({
          'event': 'campaign_state',
          'campaign_id': 'camp-1',
          'status': 'paused',
          'reason': 'paused_by_supervisor',
          'dialing': false,
          'message': 'Paused.',
        });
        expect(app.view!.dialActivity, isNull);
        expect(_holds(async), isEmpty);
        app.frame({
          'event': 'campaign_state',
          'campaign_id': 'camp-1',
          'status': 'running',
          'reason': 'resumed',
          'dialing': true,
          'message': 'Running.',
        });
        // Running again: the count is still the server's, and the hold is not back.
        expect(app.view!.dialActivity, const DialActivityView(dialling: false, unansweredInARow: 1));
        app.dispose();
      });
    });

    test('leaving available drops the hold; the count is kept for the return', () {
      fakeAsync((async) {
        final app = App(async)..start();
        app.readyFrame('available');
        _rangOut(app, before: 0);
        expect(_holds(async), hasLength(1));
        app.agentStateFrame('break', breakReason: 'tea');
        expect(app.view!.phase, AgentPhase.onBreak);
        expect(app.view!.dialActivity, isNull);
        expect(_holds(async), isEmpty);
        app.agentStateFrame('available');
        expect(app.view!.dialActivity, const DialActivityView(dialling: false, unansweredInARow: 1));
        app.dispose();
      });
    });

    test('a dial the customer cancelled by ringing in: no dialling, the inbound call on screen, the count kept', () {
      fakeAsync((async) {
        final app = App(async)..start();
        // Inbound frames reach only a station that declared it can take them.
        expect(app.socket.url.queryParameters['caps'], 'inbound');
        app.readyFrame('available');
        _dial(app, ringing: true, unanswered: 2);
        // The server's order: the dial's close (not counted), then the inbound connector's
        // reservation and, synchronously, the offer (`inbound-connector.ts`).
        _dial(app, ringing: false, unanswered: 2);
        app.frame(agentStateFrameJson('reserved', '2026-11-02T05:30:14.200Z'));
        expect(app.view!.dialActivity, isNull);
        expect(_holds(async), isEmpty, reason: 'reserved for a caller: no "Dialling" held over it');
        expect(stationStageOf(app.view, 'camp-1'), StationStage.incoming);
        app.frame(stationFrame('inbound_call_offered'));
        expect(app.view!.inbound!.stage, InboundStage.offered);
        expect(stationStageOf(app.view, 'camp-1'), StationStage.inboundOffered);
        expect(app.view!.dialActivity, isNull);
        expect(_holds(async), isEmpty);
        // An inbound call does not reset the count, server-side or here.
        expect(app.controller.stationState.dialActivity, const DialActivity(ringing: false, unansweredInARow: 2));
        // Nothing says "Dialling" at any point after the dial closed.
        async.elapse(StationController.dialGapHold * 2);
        expect(app.view!.dialActivity, isNull);
        app.dispose();
      });
    });

    test('a break queued mid-ring: the dial closes, the break starts, no dialling and no hold', () {
      fakeAsync((async) {
        final app = App(async)..start();
        app.readyFrame('available');
        _dial(app, ringing: true, unanswered: 1);
        _wait(app, const Duration(seconds: 30));
        // The server's order: the dial's close, then the queued break applied (no `available`).
        _dial(app, ringing: false, unanswered: 2);
        app.agentStateFrame('break', breakReason: 'tea');
        final v = app.view!;
        expect(v.phase, AgentPhase.onBreak);
        expect(v.onBreak!.code, 'tea');
        expect(v.dialActivity, isNull);
        expect(stationStageOf(v, 'camp-1'), StationStage.onBreak);
        expect(_holds(async), isEmpty);
        async.elapse(StationController.dialGapHold * 2);
        expect(app.view!.phase, AgentPhase.onBreak);
        expect(app.view!.dialActivity, isNull);
        // Back from the break: the count is the server's, nothing is dialling yet.
        app.agentStateFrame('available');
        expect(app.view!.dialActivity, const DialActivityView(dialling: false, unansweredInARow: 2));
        expect(_holds(async), isEmpty);
        app.dispose();
      });
    });

    test('reconnect mid-ring: the server\'s ready {available, dial_activity ringing} says "Dialling", with the count', () {
      fakeAsync((async) {
        final app = App(async)..start();
        app.readyFrame('available');
        _rangOut(app, before: 1);
        _wait(app, const Duration(seconds: 1));
        _dial(app, ringing: true, unanswered: 2);

        final first = app.socket;
        first.serverClose(1006);
        expect(app.view!.dialActivity, isNull, reason: 'not shown while the socket is down');
        async.elapse(const Duration(seconds: 5));
        expect(identical(app.socket, first), isFalse);
        // Exactly what the server sends while a hidden dial rings: `available`, no attempt.
        final ready = stationFrame('ready_dial_activity')..['session_id'] = 'sess-1';
        expect(ready['state'], 'available');
        expect(ready.containsKey('active_attempt'), isFalse);
        app.frame(ready);
        final v = app.view!;
        expect(v.phase, AgentPhase.available);
        expect(v.call, isNull);
        expect(stationStageOf(v, 'camp-1'), StationStage.available, reason: 'never "A call is coming through"');
        expect(v.dialActivity, const DialActivityView(dialling: true, unansweredInARow: 2));

        // The dial then rings out as any other: held, then the count.
        _wait(app, const Duration(seconds: 20));
        _dial(app, ringing: false, unanswered: 3);
        app.agentStateFrame('available');
        expect(app.view!.dialActivity, const DialActivityView(dialling: true, unansweredInARow: 3));
        async.elapse(StationController.dialGapHold);
        expect(app.view!.dialActivity, const DialActivityView(dialling: false, unansweredInARow: 3));
        app.dispose();
      });
    });

    test('a frame for another campaign is ignored; one that does not read is dropped, never fatal', () {
      fakeAsync((async) {
        final app = App(async)..start();
        app.readyFrame('available');
        _dial(app, ringing: true, unanswered: 0, campaignId: 'camp-other');
        expect(app.view!.dialActivity, isNull);
        app.frame({'event': 'dial_activity', 'campaign_id': 'camp-1', 'unanswered_in_a_row': 1});
        expect(app.view!.dialActivity, isNull);
        expect(app.view!.fatal, isNull);
        app.dispose();
      });
    });

    test('early binding: a whole call with no dial_activity frames never shows any', () {
      fakeAsync((async) {
        final app = App(async)..start();
        app.readyFrame('available');
        final seen = <DialActivityView?>[];
        app.reserved('a1');
        seen.add(app.view!.dialActivity);
        app.frame({'event': 'countdown', 'attempt_id': 'a1', 'seconds_remaining': 2});
        seen.add(app.view!.dialActivity);
        app.bridged('a1');
        app.releasedFrame('a1');
        app.agentStateFrame('wrapup');
        app.wrapupFrame('a1');
        seen.add(app.view!.dialActivity);
        app.agentStateFrame('available');
        seen.add(app.view!.dialActivity);
        expect(seen, everyElement(isNull));
        expect(app.views.whereType<StationView>().map((v) => v.dialActivity), everyElement(isNull));
        expect(_holds(async), isEmpty);
        app.dispose();
      });
    });

    group('"Available for" dates the whole wait', () {
      const t0 = '2026-11-01T09:00:00.000Z';
      const t1 = '2026-11-01T09:00:42.000Z';
      final gap = DateTime.parse(t1).difference(DateTime.parse(t0));

      // After a hidden dial rings out the server's release restates `available` with the `since`
      // the agent was last shown (`releaseAgent` keeps the session's `state_since` when a dial
      // they never saw returns them to the `available` they were in), so the app adopts it as
      // it adopts every `since`, and the timer runs on. (No heartbeat is answered between: a
      // pong moves the clock offset `phaseSince` is corrected by, which is not the point here.)
      test('late binding: hidden dials that ring out restate the since; the timer runs on', () {
        fakeAsync((async) {
          final app = App(async)..start();
          app.readyFrame('available');
          app.agentStateFrame('available', since: t0);
          final since0 = app.view!.phaseSince!;
          for (var n = 0; n < 3; n++) {
            _dial(app, ringing: true, unanswered: n);
            _dial(app, ringing: false, unanswered: n + 1);
            app.agentStateFrame('available', since: t0);
            expect(app.view!.phase, AgentPhase.available);
            expect(app.view!.phaseSince, since0, reason: 'the agent never left the waiting screen');
          }
          app.dispose();
        });
      });

      test('early binding: an unanswered call was shown, so the wait restarts after it', () {
        fakeAsync((async) {
          final app = App(async)..start();
          app.readyFrame('available');
          app.agentStateFrame('available', since: t0);
          final since0 = app.view!.phaseSince!;
          app.reserved('a1');
          app.releasedFrame('a1', requiresDisposition: false, reason: 'no_answer');
          app.agentStateFrame('available', since: t1);
          expect(app.view!.phase, AgentPhase.available);
          expect(app.view!.phaseSince, since0.add(gap));
          app.dispose();
        });
      });

      test('late binding answered: the call shown restarts it; so do an inbound call and a break', () {
        fakeAsync((async) {
          final app = App(async)..start();
          app.readyFrame('available');
          app.agentStateFrame('available', since: t0);
          final since0 = app.view!.phaseSince!;
          // Answered hidden dial: reserved → bridged → released → wrap-up → available.
          _dial(app, ringing: true, unanswered: 0);
          app.reserved('a1');
          app.bridged('a1');
          app.releasedFrame('a1');
          app.agentStateFrame('wrapup');
          app.wrapupFrame('a1');
          app.agentStateFrame('available', since: t1);
          expect(app.view!.phaseSince, since0.add(gap));

          // An inbound caller, the server's order (`realInboundCallFrames`), then a hidden dial
          // that rings out: its release restates the `available` the inbound call returned to.
          app.agentStateFrame('available', since: t0);
          final inbound = realInboundCallFrames();
          for (final (step: _, :frame) in inbound) {
            app.frame(frame);
          }
          expect(app.view!.phase, AgentPhase.available);
          final afterInbound = app.view!.phaseSince!;
          expect(afterInbound, isNot(since0));
          _dial(app, ringing: true, unanswered: 0);
          _dial(app, ringing: false, unanswered: 1);
          app.agentStateFrame('available', since: inbound.firstWhere((f) => f.step == 'available').frame['since']! as String);
          expect(app.view!.phaseSince, afterInbound, reason: 'the wait after the inbound call goes on');

          // A break between: the wait after it is a new one.
          app.agentStateFrame('break', breakReason: 'tea', since: t0);
          app.agentStateFrame('available', since: t1);
          expect(app.view!.phaseSince, since0.add(gap));
          app.dispose();
        });
      });
    });

    test('closing the station cancels the hold', () {
      fakeAsync((async) {
        final app = App(async)..start();
        app.readyFrame('available');
        _rangOut(app, before: 0);
        expect(_holds(async), hasLength(1));
        app.dispose();
        expect(_holds(async), isEmpty);
      });
    });
  });
}
