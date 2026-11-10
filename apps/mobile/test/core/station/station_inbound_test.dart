import 'dart:async';
import 'dart:convert';

import 'package:agent_audio/agent_audio.dart' as audio;
import 'package:fake_async/fake_async.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:magick_agency_agent/core/inbound/inbound_copy.dart';
import 'package:magick_agency_agent/core/station/station_view.dart';
import 'package:magick_agency_agent/features/station/station_screen.dart' show StationStage, stationStageOf;

import '../inbound/inbound_fixtures.dart';
import 'controller_harness.dart';

/// Inbound calls on the station core (`docs/inbound.md` §6), driven only by the frames the
/// server sends: the contract's own samples (`station.json`), on the harness's session. No
/// `agent_state` is played to move the screen: the call moves it.

const _call = '/proxy/agency/inbound/calls/$fixtureCallId';
const _breakPath = '/proxy/agency/sessions/sess-1/break';

/// On duty and waiting, then an inbound offer.
App _offered(FakeAsync async) {
  final app = App(async)..start();
  app.readyFrame('available');
  app.frame(stationFrame('inbound_call_offered'));
  return app;
}

/// Drops the socket and lets it reconnect; the test plays the new `ready`.
void _reconnect(App app, {String state = 'available'}) {
  final first = app.socket;
  first.serverClose(1006);
  app.async.elapse(const Duration(seconds: 5));
  expect(identical(app.socket, first), isFalse);
  app.readyFrame(state);
}

void main() {
  group('one call, from offer to settled', () {
    test('offer → connected → ended → settled: the phase, the audio, the notification and the shell follow the call', () {
      fakeAsync((async) {
        final app = App(async)..start();
        app.readyFrame('available');
        expect(app.view!.phase, AgentPhase.available);

        app.frame(stationFrame('inbound_call_offered'));
        var v = app.view!;
        expect(v.phase, AgentPhase.reserved);
        expect(v.inbound!.stage, InboundStage.offered);
        expect(v.inbound!.displayName, 'Rahul Deshpande');
        expect(v.inbound!.stickyIsYou, isTrue);
        expect(v.inbound!.routeName, 'Pune customer line');
        expect(v.inbound!.recording, isTrue);
        expect(v.inbound!.connectsAt, isNotNull);
        expect(v.inbound!.priorAttempts, hasLength(2));
        expect(v.call, isNull);
        expect(stationStageOf(v, 'camp-1'), StationStage.inboundOffered);
        expect(app.signals.callActive, isTrue);
        // The microphone arms on the offer, the chime follows it, and nothing goes up yet.
        expect(app.engine.lifecycle, containsAllInOrder(['startCall', 'arm', 'chime']));
        expect(app.engine.calls, isNot(contains('uplink')));
        expect(app.engine.startedCalls.last.callId, fixtureCallId);
        expect(app.engine.startedCalls.last.displayName, 'Rahul Deshpande');
        expect(app.engine.notification!.text, inboundOfferedNotificationText);
        expect(app.engine.notification!.call, isNull, reason: 'no Hang up while only offered');

        app.frame(stationFrame('inbound_call_connected'));
        v = app.view!;
        expect(v.phase, AgentPhase.onCall);
        expect(v.inbound!.stage, InboundStage.connected);
        expect(v.inbound!.bridgedAt, isNotNull);
        expect(app.engine.lifecycle, containsAllInOrder(['arm', 'chime', 'uplink', 'connected']));
        expect(app.engine.notification!.text, inboundOnCallNotificationText);
        expect(app.engine.notification!.call, isNotNull, reason: 'Mute and Hang up once connected');
        expect(app.engine.chimes, 1);

        app.frame(stationFrame('inbound_call_outcome_owed'));
        v = app.view!;
        expect(v.phase, AgentPhase.wrapup);
        expect(v.inbound!.stage, InboundStage.outcome);
        expect(v.inbound!.outcomeDueAt, DateTime.utc(2026, 11, 2, 6, 4, 2, 500));
        expect(v.dispositions.map((d) => d.code), ['interested', 'callback', 'query_resolved', 'complaint', 'do_not_call']);
        expect(v.notes.text, 'Wants the renewal quote by email.', reason: 'the server\'s notes');
        expect(app.engine.endedCalls.last.callId, fixtureCallId);
        expect(app.engine.endedCalls.last.reason, audio.CallEndReason.remoteEnded);
        expect(app.engine.notification!.text, inboundOutcomeNotificationText);
        expect(app.signals.callActive, isTrue, reason: 'an owed outcome holds the station like a wrap-up');

        app.routes['POST $_call/disposition'] = (_) {
          final body = inboundSample('call_disposition_response');
          (body['call']! as Map<String, Object?>)['session_id'] = 'sess-1';
          return json(200, body);
        };
        app.run(app.controller.submitDisposition('interested'));
        expect(
          app.requests('POST', '$_call/disposition').single.body,
          {'code': 'interested', 'notes': 'Wants the renewal quote by email.'},
          reason: 'the notes on screen go with it',
        );
        app.frame(stationFrame('inbound_call_settled'));
        v = app.view!;
        expect(v.inbound, isNull);
        expect(v.phase, AgentPhase.available);
        expect(v.inboundNotice, isNull, reason: 'the agent saved it: nothing to explain');
        expect(app.signals.callActive, isFalse);
        expect(app.engine.chimes, 1);
        app.dispose();
      });
    });

    test('a withheld caller: "Number withheld" for CallKit, no handle, no match', () {
      fakeAsync((async) {
        final app = App(async)..start();
        app.readyFrame('available');
        app.frame(stationFrame('inbound_call_withheld'));
        final v = app.view!.inbound!;
        expect(v.withheld, isTrue);
        expect(v.matched, isFalse);
        expect(v.displayName, isNull);
        expect(v.catalogKind, InboundCatalogKind.standard);
        expect(app.engine.startedCalls.last.displayName, inboundNumberWithheld);
        expect(app.engine.startedCalls.last.handle, '');
        expect(app.engine.chimes, 1);
        app.dispose();
      });
    });

    test('a frame for another session, or one that does not read, moves nothing', () {
      fakeAsync((async) {
        final app = App(async)..start();
        app.readyFrame('available');
        app.frame(stationFrame('inbound_call_offered', sessionId: 'someone-else'));
        app.frame({'event': 'inbound_call', 'call': {'id': 'x'}});
        expect(app.view!.inbound, isNull);
        expect(app.view!.phase, AgentPhase.available);
        expect(app.engine.chimes, 0);
        app.dispose();
      });
    });
  });

  group('the chime: once per offer', () {
    test('silent on a restatement after a reconnect, and on a call already under way', () {
      fakeAsync((async) {
        final app = _offered(async);
        expect(app.engine.chimes, 1);
        _reconnect(app);
        app.frame(stationFrame('inbound_call_offered'));
        expect(app.engine.chimes, 1, reason: 'the same offer, restated');
        app.frame(stationFrame('inbound_call_connected'));
        _reconnect(app);
        app.frame(stationFrame('inbound_call_connected'));
        expect(app.engine.chimes, 1);
        app.dispose();
      });
    });

    test('a re-offer after a requeue rings again; Sounds off rings nothing', () {
      fakeAsync((async) {
        final app = _offered(async);
        app.frame(stationFrame('inbound_call_offered', call: {'state': 'queued'}));
        expect(app.view!.inbound, isNull);
        expect(app.view!.inboundNotice, inboundRequeuedCopy);
        app.frame(stationFrame('inbound_call_offered', call: {'offered_at': '2026-11-02T05:31:00.000Z'}));
        expect(app.engine.chimes, 2);
        expect(app.view!.inboundNotice, isNull, reason: 'the next call clears it');
        app.sounds = false;
        app.frame(stationFrame('inbound_call_withheld'));
        expect(app.engine.chimes, 2);
        expect(app.view!.inbound!.callId, withheldCallId);
        app.dispose();
      });
    });
  });

  group('why a call left without the agent\'s outcome (30 s)', () {
    test('the caller hung up before they were connected', () {
      fakeAsync((async) {
        final app = _offered(async);
        app.frame(stationFrame('inbound_call_offered', call: {
          'state': 'ended',
          'outcome': 'abandoned_in_queue',
          'connects_at': null,
          'ended_at': '2026-11-02T05:30:15.000Z',
          'settled_at': '2026-11-02T05:30:15.000Z',
        }));
        expect(app.view!.inbound, isNull);
        expect(app.view!.phase, AgentPhase.available);
        expect(app.view!.inboundNotice, inboundHungUpEarlyCopy);
        expect(app.engine.endedCalls.last.callId, fixtureCallId);
        async.elapse(const Duration(seconds: 29));
        expect(app.view!.inboundNotice, inboundHungUpEarlyCopy);
        async.elapse(const Duration(seconds: 2));
        expect(app.view!.inboundNotice, isNull);
        app.dispose();
      });
    });
  });

  group('a reconnect', () {
    test('ready keeps the call; a restating frame means nothing is read', () {
      fakeAsync((async) {
        final app = _offered(async);
        app.frame(stationFrame('inbound_call_connected'));
        _reconnect(app, state: 'on_call');
        expect(app.view!.inbound!.stage, InboundStage.connected, reason: 'ready keeps it');
        app.frame(stationFrame('inbound_call_connected'));
        async.elapse(const Duration(minutes: 1));
        expect(app.requests('GET', _call), isEmpty);
        app.dispose();
      });
    });

    test('no restatement: the call is asked for; an offer the server no longer holds went back to the queue', () {
      fakeAsync((async) {
        final app = _offered(async);
        app.routes['GET $_call'] = (_) => json(404, inboundSample('refusal_call_not_found'));
        _reconnect(app);
        expect(app.view!.inbound, isNotNull, reason: 'the 2 s grace for the frame');
        async.elapse(const Duration(seconds: 3));
        expect(app.requests('GET', _call), hasLength(1));
        expect(app.view!.inbound, isNull);
        expect(app.view!.inboundNotice, inboundRequeuedCopy);
        expect(app.signals.callActive, isFalse);
        expect(app.engine.endedCalls.last.callId, fixtureCallId);
        app.dispose();
      });
    });

    test('no restatement, owed outcome: the server\'s copy is adopted (it settled meanwhile)', () {
      fakeAsync((async) {
        final app = _offered(async);
        app.frame(stationFrame('inbound_call_outcome_owed'));
        var reads = 0;
        app.routes['GET $_call'] = (_) => ++reads == 1
            ? json(503, {'error': 'Service Unavailable', 'message': 'down'})
            : json(200, {'call': inboundCallJson('inbound_call_settled')});
        _reconnect(app, state: 'wrapup');
        async.elapse(const Duration(seconds: 10));
        expect(reads, 2, reason: 'a failed read is asked again');
        expect(app.view!.inbound, isNull);
        expect(app.view!.inboundNotice, isNull, reason: 'its outcome was saved');
        app.dispose();
      });
    });

    test('answered as another session\'s: retired', () {
      fakeAsync((async) {
        final app = _offered(async);
        app.frame(stationFrame('inbound_call_connected'));
        app.routes['GET $_call'] = (_) => json(200, {'call': inboundCallJson('inbound_call_connected', sessionId: 'other')});
        _reconnect(app, state: 'on_call');
        async.elapse(const Duration(seconds: 3));
        expect(app.view!.inbound, isNull);
        app.dispose();
      });
    });

    test('mid-call the 8 s the server holds a connected call; none while only offered', () {
      fakeAsync((async) {
        final app = _offered(async);
        app.socket.serverClose(1006);
        expect(app.view!.reconnectDeadline, isNull);
        async.elapse(const Duration(seconds: 5));
        app.readyFrame('reserved');
        app.frame(stationFrame('inbound_call_connected'));
        app.socket.serverClose(1006);
        expect(app.view!.reconnectDeadline, app.now().add(const Duration(seconds: 8)));
        app.dispose();
      });
    });
  });

  group('"Your customer is waiting"', () {
    test('set by the frame, cleared by its cleared frame', () {
      fakeAsync((async) {
        final app = _offered(async);
        app.frame(stationFrame('inbound_call_connected'));
        app.frame(stationFrame('customer_waiting'));
        final w = app.view!.customerWaiting!;
        expect(w.callId, fixtureCallId);
        expect(w.name, 'Rahul Deshpande');
        app.frame(stationFrame('customer_waiting_cleared'));
        expect(app.view!.customerWaiting, isNull);
        app.dispose();
      });
    });

    test('cleared when the station leaves the call, and by a ready', () {
      fakeAsync((async) {
        final app = _offered(async);
        app.frame(stationFrame('inbound_call_connected'));
        app.frame(stationFrame('customer_waiting'));
        app.frame(stationFrame('inbound_call_outcome_owed'));
        expect(app.view!.customerWaiting, isNotNull, reason: 'still writing it up');
        app.frame(stationFrame('inbound_call_settled'));
        expect(app.view!.customerWaiting, isNull);
        app.frame(stationFrame('customer_waiting'));
        app.readyFrame('available');
        expect(app.view!.customerWaiting, isNull);
        app.dispose();
      });
    });
  });

  group('leaving the app during an inbound call', () {
    for (final (stage, frames, state) in [
      ('offered', <String>[], 'reserved'),
      ('on the call', ['inbound_call_connected'], 'on_call'),
      ('owing the outcome', ['inbound_call_connected', 'inbound_call_outcome_owed'], 'wrapup'),
    ]) {
      test('$stage: device_away is QUEUED, the socket stays, pings go on; back in the app it is cancelled', () {
        fakeAsync((async) {
          final app = _offered(async);
          for (final f in frames) {
            app.frame(stationFrame(f));
          }
          expect(app.signals.callActive, isTrue, reason: stage);
          app.routes['POST $_breakPath'] = (_) => json(200, stateBody(state, breakReason: 'device_away', pending: 'break'));
          app.routes['POST $_breakPath/cancel'] = (_) => json(200, stateBody(state));
          final pings = app.socket.pings.length;
          app.lifecycle.hide();
          async.flushMicrotasks();
          expect(app.requests('POST', _breakPath).single.body, {'reason': 'device_away'});
          expect(app.view!.queuedBreak?.code, 'device_away');
          app.socket.serverPong();
          async.elapse(const Duration(seconds: 12));
          expect(app.socket.pings.length, greaterThan(pings));
          // The audio stays for a call on the line (an owed outcome has none left to keep).
          if (state != 'wrapup') expect(app.engine.calls, isNot(contains('stop')));
          expect(app.view!.link, StationLink.open);
          expect(app.view!.inbound, isNotNull, reason: '$stage: the call is still on the station');
          app.lifecycle.show();
          async.flushMicrotasks();
          expect(app.requests('POST', '$_breakPath/cancel'), hasLength(1));
          app.dispose();
        });
      });
    }

    test('owing the outcome: the save-by notification carries outcome_due_at', () {
      fakeAsync((async) {
        final app = _offered(async);
        app.frame(stationFrame('inbound_call_connected'));
        app.frame(stationFrame('inbound_call_outcome_owed'));
        app.routes['POST $_breakPath'] = (_) => json(200, stateBody('wrapup', breakReason: 'device_away', pending: 'break'));
        app.lifecycle.hide();
        async.flushMicrotasks();
        expect(app.requests('POST', _breakPath), hasLength(1));
        expect(app.notifier.calls.last, 'wrapup:2026-11-02T06:04:02.500Z');
        app.dispose();
      });
    });
  });

  group('actions', () {
    test('Hang up only once connected; the system\'s too', () {
      fakeAsync((async) {
        final app = _offered(async);
        app.routes['POST $_call/hangup'] = (_) => json(200, {'call': inboundCallJson('inbound_call_connected')});
        app.run(app.controller.hangUp());
        expect(app.requests('POST', '$_call/hangup'), isEmpty, reason: 'offered: the caller would be cut off unheard');
        app.frame(stationFrame('inbound_call_connected'));
        app.engine.emitEvent(const audio.CallSystemAction(kind: audio.CallActionKind.end, source: audio.CallActionSource.notification));
        async.flushMicrotasks();
        expect(app.requests('POST', '$_call/hangup'), hasLength(1));
        app.frame(stationFrame('inbound_call_outcome_owed'));
        expect(app.engine.endedCalls.last.reason, audio.CallEndReason.local);
        app.dispose();
      });
    });

    test('a refused hang-up says so and keeps the call', () {
      fakeAsync((async) {
        final app = _offered(async);
        app.frame(stationFrame('inbound_call_connected'));
        app.routes['POST $_call/hangup'] = (_) => json(503, {'error': 'Service Unavailable', 'message': 'down'});
        app.run(app.controller.hangUp());
        expect(app.view!.inbound!.hangupFailure, startsWith('We couldn’t end the call'));
        expect(app.view!.inbound!.stage, InboundStage.connected);
        app.dispose();
      });
    });

    test('notes autosave 700 ms after the last keystroke, kept under inbound:<id> until sent', () {
      fakeAsync((async) {
        final app = _offered(async);
        app.frame(stationFrame('inbound_call_connected'));
        app.routes['PATCH $_call'] = (_) => json(200, {'call': inboundCallJson('inbound_call_connected', overrides: {'notes': 'Asked about'})});
        app.controller.updateNotes('Asked');
        async.elapse(const Duration(milliseconds: 400));
        app.controller.updateNotes('Asked about');
        async.elapse(const Duration(milliseconds: 600));
        expect(app.requests('PATCH', _call), isEmpty);
        async.elapse(const Duration(milliseconds: 200));
        expect(app.requests('PATCH', _call).single.body, {'notes': 'Asked about'});
        expect(app.run(app.store.read('inbound:$fixtureCallId')), 'Asked about');
        expect(app.view!.notes.status, NotesStatus.saved);
        app.dispose();
      });
    });

    test('the outcome: cleared notes go as \'\', untouched ones are left out', () {
      fakeAsync((async) {
        final app = _offered(async);
        app.frame(stationFrame('inbound_call_connected'));
        app.frame(stationFrame('inbound_call_outcome_owed'));
        app.routes['PATCH $_call'] = (_) => json(200, {'call': inboundCallJson('inbound_call_outcome_owed')});
        app.routes['POST $_call/disposition'] = (_) => json(400, inboundSample('refusal_disposition_note_required'));
        app.controller.updateNotes('');
        app.run(app.controller.submitDisposition('interested'));
        expect(app.requests('POST', '$_call/disposition').single.body, {'code': 'interested', 'notes': ''});
        expect(app.requests('PATCH', _call), isEmpty, reason: 'the outcome carries the notes: the save waits on it');
        async.elapse(const Duration(seconds: 2));
        expect(
          app.requests('PATCH', _call).single.body,
          {'notes': ''},
          reason: 'the outcome was refused, so it carried nothing: the clear goes by the notes\' own route',
        );
        expect(app.view!.actionError, 'This outcome needs a note.');
        app.dispose();
      });
    });

    test('unknown_code: the pad is rebuilt from allowed_codes', () {
      fakeAsync((async) {
        final app = _offered(async);
        app.frame(stationFrame('inbound_call_outcome_owed', call: {
          'disposition_catalog': [
            {'code': 'interested', 'label': 'Interested'},
            {'code': 'gone', 'label': 'Gone'},
          ],
        }));
        app.routes['POST $_call/disposition'] = (_) => json(400, inboundSample('refusal_disposition_unknown_code'));
        app.run(app.controller.submitDisposition('gone'));
        expect(app.view!.dispositions.map((d) => d.code), ['interested', 'callback', 'query_resolved', 'complaint', 'do_not_call']);
        expect(app.view!.actionError, 'The outcome list for this call changed. Pick one of these.');
        expect(app.view!.dispositionSaved, isNull);
        app.dispose();
      });
    });

    test('Save is refused while the caller is on the line; Mark DNC names the scope', () {
      fakeAsync((async) {
        final app = _offered(async);
        app.frame(stationFrame('inbound_call_connected'));
        app.run(app.controller.submitDisposition('interested'));
        expect(app.requests('POST', '$_call/disposition'), isEmpty);
        expect(app.view!.actionError, inboundSaveCallLiveCopy);
        app.routes['POST $_call/dnc'] = (_) => json(200, inboundSample('call_dnc_response'));
        app.run(app.controller.markDnc(attemptId: fixtureCallId));
        expect(app.requests('POST', '$_call/dnc').single.body, <String, Object?>{});
        expect(app.view!.dncOutcome, '+91 87654 32109 is on the Do Not Call list for Q4 Renewals — Pune.');
        app.dispose();
      });
    });
  });

  group('the server\'s own order (agent_state around the call frames)', () {
    test('reserved, offer, on_call, connected, wrapup, owed, available, settled: the screen follows the call at every frame', () {
      fakeAsync((async) {
        final app = App(async)..start();
        app.readyFrame('available');
        const expected = <String, (AgentPhase, StationStage)>{
          // Reserved for a caller not named yet: a neutral screen, never the campaign's ringing pop.
          'reserved': (AgentPhase.reserved, StationStage.incoming),
          'offered': (AgentPhase.reserved, StationStage.inboundOffered),
          'on_call': (AgentPhase.reserved, StationStage.inboundOffered),
          'connected': (AgentPhase.onCall, StationStage.inboundOnCall),
          'wrapup': (AgentPhase.onCall, StationStage.inboundOnCall),
          'owed': (AgentPhase.wrapup, StationStage.inboundOutcome),
          // The agent is returned a moment before the settled call lands: the outcome screen stays.
          'available': (AgentPhase.wrapup, StationStage.inboundOutcome),
          'settled': (AgentPhase.available, StationStage.available),
        };
        for (final (:step, :frame) in realInboundCallFrames()) {
          app.frame(frame);
          final v = app.view!;
          expect((v.phase, stationStageOf(v, 'camp-1')), expected[step], reason: step);
          if (step == 'reserved') {
            expect(v.call, isNull);
            expect(v.inbound, isNull);
            expect(app.signals.callActive, isTrue, reason: 'reserved holds the station');
            expect(app.engine.startedCalls, isEmpty, reason: 'nobody to name to CallKit yet');
            expect(app.engine.chimes, 0);
          }
          if (step == 'offered') expect(app.engine.chimes, 1);
        }
        expect(app.engine.chimes, 1);
        expect(app.engine.endedCalls.last.callId, fixtureCallId);
        expect(app.view!.inboundNotice, isNull, reason: 'its outcome was saved');
        expect(app.signals.callActive, isFalse);
        app.dispose();
      });
    });

    test('saving the outcome: the agent is returned and the settled call sent before the answer', () {
      fakeAsync((async) {
        final app = App(async)..start();
        app.readyFrame('available');
        final frames = realInboundCallFrames();
        for (final (:step, :frame) in frames.take(6)) {
          app.frame(frame);
          expect(app.view!.actionError, isNull, reason: step);
        }
        expect(stationStageOf(app.view, 'camp-1'), StationStage.inboundOutcome);
        app.routes['POST $_call/disposition'] = (_) {
          // The server's order: `returnAgent` (agent_state available), then the settled call,
          // then the HTTP answer.
          for (final (step: _, :frame) in frames.skip(6)) {
            app.socket.serverText(jsonEncode(frame));
          }
          final body = inboundSample('call_disposition_response');
          (body['call']! as Map<String, Object?>)['session_id'] = 'sess-1';
          return json(200, body);
        };
        app.run(app.controller.submitDisposition('interested'));
        final v = app.view!;
        expect(v.phase, AgentPhase.available);
        expect(stationStageOf(v, 'camp-1'), StationStage.available);
        expect(v.inbound, isNull);
        expect(v.actionError, isNull);
        expect(v.inboundNotice, isNull);
        expect(app.engine.endedCalls.last.reason, audio.CallEndReason.remoteEnded);
        app.dispose();
      });
    });
  });

  group('a call the station let go of stays gone', () {
    test('a hang-up answered late, after the call ended and a campaign call arrived, brings nothing back', () {
      fakeAsync((async) {
        final app = _offered(async);
        app.frame(stationFrame('inbound_call_connected'));
        final answer = Completer<http.Response>();
        app.routes['POST $_call/hangup'] = (_) => answer.future;
        unawaited(app.controller.hangUp());
        async.flushMicrotasks();
        expect(app.requests('POST', '$_call/hangup'), hasLength(1));
        // The answer is slow; the server's frames are not: the call ends, its outcome is saved
        // (by a supervisor), the agent is returned, and the dialler reserves them for a campaign call.
        app.frame(agentStateFrameJson('wrapup', '2026-11-02T05:34:02.500Z'));
        app.frame(stationFrame('inbound_call_outcome_owed'));
        app.frame(agentStateFrameJson('available', '2026-11-02T05:35:40.118Z'));
        app.frame(stationFrame('inbound_call_settled'));
        app.reserved('att-9');
        expect(stationStageOf(app.view, 'camp-1'), StationStage.reserved);
        // The hang-up's answer: the call as read when the hang-up was issued.
        answer.complete(json(200, {'call': inboundCallJson('inbound_call_connected')}));
        async.flushMicrotasks();
        var v = app.view!;
        expect(v.inbound, isNull, reason: 'the copy the campaign call replaced is not adopted back');
        expect(v.call?.attemptId, 'att-9');
        expect(stationStageOf(v, 'camp-1'), StationStage.reserved);
        // What the agent does goes to the campaign call on screen.
        app.bridged('att-9');
        app.controller.updateNotes('Asha wants a quote');
        async.elapse(const Duration(seconds: 2));
        expect(app.requests('PATCH', _call), isEmpty);
        expect(app.requests('POST', '/proxy/agency/attempts/att-9/notes'), isNotEmpty);
        // And once that call is over, the old inbound call does not come back either.
        app.releasedFrame('att-9', requiresDisposition: false);
        app.agentStateFrame('available', since: '2026-11-02T05:40:00.000Z');
        v = app.view!;
        expect(v.inbound, isNull);
        expect(stationStageOf(v, 'camp-1'), StationStage.available);
        app.dispose();
      });
    });
  });

  group('a reconnect check refused for another reason', () {
    test('403 and 401 keep the copy and ask again on the backoff (401 through the token refresh); not_found retires it', () {
      fakeAsync((async) {
        final app = _offered(async);
        app.frame(stationFrame('inbound_call_connected'));
        var reads = 0;
        app.routes['GET $_call'] = (_) {
          reads++;
          if (reads == 1) return json(403, {'error': 'Forbidden', 'message': 'no'});
          if (reads <= 3) return json(401, {'error': 'Unauthorized', 'message': 'expired'});
          return json(404, inboundSample('refusal_call_not_found'));
        };
        _reconnect(app, state: 'on_call');
        async.elapse(const Duration(seconds: 3));
        expect(reads, 1);
        expect(app.view!.inbound, isNotNull, reason: 'a 403 says nothing about the call');
        async.elapse(const Duration(seconds: 4));
        expect(reads, 3, reason: 'asked again after 4 s; the 401 is retried once with a fresh token');
        expect(app.view!.inbound, isNotNull);
        async.elapse(const Duration(seconds: 8));
        expect(reads, 4);
        expect(app.view!.inbound, isNull, reason: 'the server says it no longer holds it');
        app.dispose();
      });
    });
  });

  group('notes', () {
    test('a refused outcome sends the last keystrokes by the notes\' own route', () {
      fakeAsync((async) {
        final app = _offered(async);
        app.frame(stationFrame('inbound_call_connected'));
        app.frame(stationFrame('inbound_call_outcome_owed'));
        app.routes['PATCH $_call'] = (_) => json(200, {
              'call': inboundCallJson('inbound_call_outcome_owed', overrides: {'notes': 'Wants a quote by Friday'}),
            });
        app.routes['POST $_call/disposition'] = (_) => json(503, {'error': 'Service Unavailable', 'message': 'down'});
        app.controller.updateNotes('Wants a quote by Friday');
        async.elapse(const Duration(milliseconds: 300));
        app.run(app.controller.submitDisposition('interested'));
        expect(app.requests('POST', '$_call/disposition').single.body, {'code': 'interested', 'notes': 'Wants a quote by Friday'});
        async.elapse(const Duration(seconds: 1));
        expect(app.requests('PATCH', _call).single.body, {'notes': 'Wants a quote by Friday'});
        expect(app.view!.notes.status, NotesStatus.saved, reason: 'never left at saving');
        app.dispose();
      });
    });

    test('leaving the station sends the notes typed in the last moments, not only stores them', () {
      fakeAsync((async) {
        final app = _offered(async);
        app.frame(stationFrame('inbound_call_connected'));
        app.frame(stationFrame('inbound_call_outcome_owed'));
        app.routes['PATCH $_call'] = (_) => json(200, {'call': inboundCallJson('inbound_call_outcome_owed')});
        app.routes['POST /proxy/agency/sessions/sess-1/leave'] = (_) => json(200, stateBody('offline'));
        app.controller.updateNotes('Call back after 6');
        async.elapse(const Duration(milliseconds: 200));
        app.run(app.controller.leave());
        async.elapse(const Duration(milliseconds: 100));
        expect(app.requests('PATCH', _call).single.body, {'notes': 'Call back after 6'});
        expect(app.run(app.store.read('inbound:$fixtureCallId')), 'Call back after 6');
        app.dispose();
      });
    });

    test('4404 sends them too', () {
      fakeAsync((async) {
        final app = _offered(async);
        app.frame(stationFrame('inbound_call_connected'));
        app.routes['PATCH $_call'] = (_) => json(200, {'call': inboundCallJson('inbound_call_connected')});
        app.controller.updateNotes('Asked about the renewal');
        async.elapse(const Duration(milliseconds: 200));
        app.socket.serverClose(4404);
        async.elapse(const Duration(milliseconds: 100));
        expect(app.requests('PATCH', _call).single.body, {'notes': 'Asked about the renewal'});
        app.dispose();
      });
    });
  });

  group('after an inbound call', () {
    test('"why it left" clears on the next call of any kind: a campaign call too', () {
      fakeAsync((async) {
        final app = _offered(async);
        app.frame(stationFrame('inbound_call_offered', call: {'state': 'queued'}));
        expect(app.view!.inboundNotice, inboundRequeuedCopy);
        app.reserved('att-1');
        expect(app.view!.inboundNotice, isNull);
        async.elapse(const Duration(seconds: 31));
        expect(app.view!.inboundNotice, isNull);
        app.dispose();
      });
    });

    test('a retired copy tells CallKit its own end, never an earlier campaign call\'s release', () {
      fakeAsync((async) {
        final app = App(async)..start();
        app.readyFrame('available');
        app.reserved('att-1');
        app.releasedFrame('att-1', requiresDisposition: false, reason: 'no_answer');
        app.agentStateFrame('available', since: '2026-11-02T05:29:00.000Z');
        expect(app.engine.endedCalls.last.reason, audio.CallEndReason.unanswered);
        app.frame(stationFrame('inbound_call_offered'));
        app.frame(stationFrame('inbound_call_connected'));
        app.routes['GET $_call'] = (_) => json(404, inboundSample('refusal_call_not_found'));
        _reconnect(app, state: 'on_call');
        async.elapse(const Duration(seconds: 3));
        expect(app.view!.inbound, isNull);
        expect(app.engine.endedCalls.last.callId, fixtureCallId);
        expect(app.engine.endedCalls.last.reason, audio.CallEndReason.remoteEnded);
        app.dispose();
      });
    });

    test('an offered frame landing after an answer already past the offer does not chime', () {
      fakeAsync((async) {
        final app = App(async)..start();
        app.readyFrame('reserved');
        // An HTTP answer can overtake a frame on the socket: the call is already connected.
        app.controller.adoptInboundCall(inboundCall('inbound_call_connected'));
        app.frame(stationFrame('inbound_call_offered'));
        expect(app.engine.chimes, 0, reason: 'the held copy is past its offer: nothing is ringing');
        expect(app.view!.inbound!.stage, InboundStage.connected);
        app.dispose();
      });
    });
  });
}
