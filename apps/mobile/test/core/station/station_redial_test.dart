import 'dart:async';
import 'dart:io' show SocketException;

import 'package:agency_wire/agency_wire.dart';
import 'package:fake_async/fake_async.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:magick_agency_agent/core/station/station_copy.dart';
import 'package:magick_agency_agent/core/station/station_state.dart';
import 'package:magick_agency_agent/core/station/station_view.dart';
import 'package:magick_agency_agent/core/telemetry/call_telemetry.dart';
import 'package:magick_agency_agent/core/telemetry/telemetry.dart';
import 'package:magick_agency_agent/features/station/station_screen.dart' show StationStage, stationStageOf;

import '../telemetry/fake_telemetry_sink.dart';

import 'controller_harness.dart';
import 'fixtures.dart';

/// Wrap-up redial: the agent redials the customer from the wrap-up screen,
/// before the outcome is saved (`POST /sessions/:id/redial`), and the redial's
/// call arrives on the station like any other.

const _redialPath = '/proxy/agency/sessions/sess-1/redial';

Map<String, Object?> _wrapup(String id, {int? remaining, String? endsAt = '2026-11-01T09:01:00.000Z'}) => {
      'attempt_id': id,
      'ends_at': endsAt,
      'seconds_total': 30,
      'auto_return': true,
      'requires_disposition': true,
      'disposition_submitted': false,
      'held_reason': null,
      'redial_remaining': ?remaining,
    };

Map<String, Object?> _redialInfo(String of, int number, int remaining) =>
    {'of_attempt_id': of, 'number': number, 'remaining': remaining};

Map<String, Object?> _redialResponse({String id = 'att-2', String of = 'att-1', int number = 1, int remaining = 1}) => {
      'session_id': 'sess-1',
      'attempt_id': id,
      'redial_of_attempt_id': of,
      'redial_number': number,
      'redial_remaining': remaining,
    };

extension on App {
  /// A call that ended, in a wrap-up that offers [remaining] redials.
  void inRedialWrapup(String id, {int? remaining = 2}) {
    inWrapup(id);
    frame({'event': 'wrapup', 'wrapup': _wrapup(id, remaining: remaining)});
  }

  void reservedRedial(String id, {required String of, int number = 1, int remaining = 1}) =>
      frame({'event': 'reserved', 'attempt': {...attemptJson(id), 'redial': _redialInfo(of, number, remaining)}});
}

void main() {
  group('stationReducer: wrap-up redial', () {
    final at = DateTime.utc(2026, 8, 11, 10);

    test('the wrap-up anchor carries the redial count, null when not offered', () {
      final offered = WrapupState.fromJson(_wrapup('att-1', remaining: 2));
      expect(openWrapup(offered, 0, at).redialRemaining, 2);
      expect(openWrapup(WrapupState.fromJson(_wrapup('att-1')), 0, at).redialRemaining, isNull);
      expect(openWrapup(offered, 0, at), isNot(openWrapup(WrapupState.fromJson(_wrapup('att-1', remaining: 0)), 0, at)));
    });

    test('a wrap-up for another attempt drops the panel held for the call it redialled', () {
      final a1 = attempt('att-1');
      var s = [
        ReservedAction(a1),
        ReleasedAction(released('att-1'), at: at, retain: a1),
        WrapupAction(openWrapup(WrapupState.fromJson(_wrapup('att-1', remaining: 2)), 0, at)),
      ].fold(StationState.initial, stationReducer);
      expect(s.retainedAttempt, a1);
      // The same attempt's wrap-up, stated again, keeps it.
      s = stationReducer(s, WrapupAction(openWrapup(WrapupState.fromJson(_wrapup('att-1', remaining: 1)), 0, at)));
      expect(s.retainedAttempt, a1);
      // A redial that failed before `reserved`: its own wrap-up, no panel.
      s = stationReducer(s, WrapupAction(openWrapup(WrapupState.fromJson(_wrapup('att-2', remaining: 1)), 0, at)));
      expect(s.retainedAttempt, isNull);
      expect(s.currentAttemptId, 'att-2', reason: 'the notes and the outcome go to the redial, never the closed call');
    });
  });

  group('the controller', () {
    test('Redial is offered with the count; a tap sends the call on screen and holds the pad until it rings', () {
      fakeAsync((async) {
        final app = App(async)..start();
        app.inRedialWrapup('att-1');
        expect(app.view!.wrapup!.redialRemaining, 2);
        expect(app.view!.wrapup!.offersRedial, isTrue);

        app.routes['POST $_redialPath'] = (_) => json(200, _redialResponse());
        app.run(app.controller.redial(attemptId: 'att-1'));
        expect(app.requests('POST', _redialPath).single.body, {'attempt_id': 'att-1'});
        expect(app.view!.actionError, isNull);
        expect(app.view!.busy, StationBusy.redialing, reason: 'the wrap-up is over once the call is placed');

        // The outcome cannot be saved for the call being redialled, nor a second redial sent.
        app.run(app.controller.submitDisposition('interested'));
        app.run(app.controller.redial(attemptId: 'att-1'));
        expect(app.sent.where((s) => s.path.endsWith('/disposition')), isEmpty);
        expect(app.requests('POST', _redialPath), hasLength(1));

        app.reservedRedial('att-2', of: 'att-1');
        expect(app.view!.busy, StationBusy.none);
        expect(app.view!.phase, AgentPhase.reserved);
        expect(app.view!.call!.attemptId, 'att-2');
        expect(app.view!.call!.redialNumber, 1);
        expect(app.view!.call!.redialLimit, 2);
        expect(app.view!.wrapup, isNull);

        app.bridged('att-2');
        expect(app.view!.call!.isRedial, isTrue);
        app.releasedFrame('att-2');
        app.agentStateFrame('wrapup');
        app.frame({'event': 'wrapup', 'wrapup': _wrapup('att-2', remaining: 1)});
        expect(app.controller.stationState.currentAttemptId, 'att-2');
        expect(app.view!.wrapup!.redialRemaining, 1);
        expect(app.view!.call!.redialNumber, 1, reason: 'the wrap-up still says which call this was');
        app.dispose();
      });
    });

    test('a redial moves the station by its own frames: ringing, on call, its own wrap-up; never the old wrap-up', () {
      fakeAsync((async) {
        final app = App(async)..start();
        app.inRedialWrapup('att-1');
        expect(stationStageOf(app.view, 'camp-1'), StationStage.wrapup);
        app.routes['POST $_redialPath'] = (_) => json(200, _redialResponse());
        app.run(app.controller.redial(attemptId: 'att-1'));

        // No `agent_state` on the dial path: the wire still says `wrapup`.
        app.reservedRedial('att-2', of: 'att-1');
        expect(app.controller.stationState.agentState, AgentState.wrapup);
        expect(stationStageOf(app.view, 'camp-1'), StationStage.reserved);
        expect(app.view!.wrapup, isNull, reason: 'no outcome pad for a call that is ringing');
        expect(app.view!.call!.attemptId, 'att-2');
        expect(app.signals.callActive, isTrue);
        expect(app.engine.notification!.text, 'Connecting a call');

        app.bridged('att-2');
        expect(stationStageOf(app.view, 'camp-1'), StationStage.onCall);
        expect(app.view!.wrapup, isNull);
        expect(app.engine.notification!.text, 'On a call');
        // Not the wrap-up the agent tapped for: a Redial sent now is refused here.
        app.run(app.controller.redial(attemptId: 'att-2'));
        expect(app.requests('POST', _redialPath), hasLength(1));

        app.releasedFrame('att-2');
        expect(stationStageOf(app.view, 'camp-1'), StationStage.wrapup);
        app.agentStateFrame('wrapup');
        app.frame({'event': 'wrapup', 'wrapup': _wrapup('att-2', remaining: 1)});
        expect(stationStageOf(app.view, 'camp-1'), StationStage.wrapup);
        expect(app.view!.call!.attemptId, 'att-2');
        app.dispose();
      });
    });

    test('a redial whose call beat the answer to the station holds nothing', () {
      fakeAsync((async) {
        final app = App(async)..start();
        app.inRedialWrapup('att-1');
        final answer = Completer<http.Response>();
        app.routes['POST $_redialPath'] = (_) => answer.future;
        final redial = app.controller.redial(attemptId: 'att-1');
        async.flushMicrotasks();
        expect(app.view!.busy, StationBusy.redialing);
        app.reservedRedial('att-2', of: 'att-1');
        answer.complete(json(200, _redialResponse()));
        app.run(redial);
        expect(app.view!.busy, StationBusy.none);
        expect(app.view!.call!.attemptId, 'att-2');
        app.dispose();
      });
    });

    test('limit reached: said plainly, the button shows none left, and the outcome can still be saved', () {
      fakeAsync((async) {
        final app = App(async)..start();
        app.inRedialWrapup('att-1', remaining: 1);
        app.routes['POST $_redialPath'] = (_) => json(409, {
              'error': 'Conflict',
              'code': 'redial_limit_reached',
              'message': 'You have already redialled this customer twice. Save the outcome.',
            });
        app.run(app.controller.redial(attemptId: 'att-1'));
        expect(app.view!.actionError, redialLimitReachedCopy);
        expect(app.view!.wrapup!.redialRemaining, 0);
        expect(app.view!.busy, StationBusy.none);
        expect(app.view!.phase, AgentPhase.wrapup);

        app.routes['POST /proxy/agency/attempts/att-1/disposition'] = (_) => json(200, {
              'campaign_id': 'camp-1',
              'attempt_id': 'att-1',
              'contact_id': 'c-att-1',
              'disposition_code': 'interested',
              'contact_state': 'completed',
              'agent_state': 'wrapup',
            });
        app.run(app.controller.submitDisposition('interested'));
        expect(app.view!.dispositionSaved, 'interested');

        // The next frame's count is the authority again.
        app.frame({'event': 'wrapup', 'wrapup': _wrapup('att-1', remaining: 1)});
        expect(app.view!.wrapup!.redialRemaining, 1);
        app.dispose();
      });
    });

    test('not allowed hides Redial; a blocked dial keeps it and says why', () {
      fakeAsync((async) {
        final app = App(async)..start();
        app.inRedialWrapup('att-1');
        app.routes['POST $_redialPath'] =
            (_) => json(409, {'error': 'Conflict', 'code': 'redial_blocked_dnc', 'message': 'On the DNC list.'});
        app.run(app.controller.redial(attemptId: 'att-1'));
        expect(app.view!.actionError, redialBlockedDncCopy);
        expect(app.view!.wrapup!.redialRemaining, 2);

        app.routes['POST $_redialPath'] =
            (_) => json(409, {'error': 'Conflict', 'code': 'redial_blocked', 'message': 'Your station is not connected.'});
        app.run(app.controller.redial(attemptId: 'att-1'));
        expect(app.view!.actionError, 'Your station is not connected.');

        app.routes['POST $_redialPath'] =
            (_) => json(409, {'error': 'Conflict', 'code': 'redial_not_allowed', 'message': 'x'});
        app.run(app.controller.redial(attemptId: 'att-1'));
        expect(app.view!.actionError, redialNotAllowedCopy);
        expect(app.view!.wrapup!.redialRemaining, isNull);
        expect(app.view!.wrapup!.offersRedial, isFalse);
        app.dispose();
      });
    });

    test('a refusal after the server reopened the wrap-up: the fresh frame\'s count stands', () {
      fakeAsync((async) {
        final app = App(async)..start();
        app.inRedialWrapup('att-1');
        final answer = Completer<http.Response>();
        app.routes['POST $_redialPath'] = (_) => answer.future;
        final redial = app.controller.redial(attemptId: 'att-1');
        async.flushMicrotasks();
        // The server took the wrap-up, could not go on, reopened it with a fresh window, then refused.
        app.frame({'event': 'wrapup', 'wrapup': _wrapup('att-1', remaining: 2, endsAt: '2026-11-01T09:02:00.000Z')});
        answer.complete(json(409, {'error': 'Conflict', 'code': 'redial_not_allowed', 'message': 'x'}));
        app.run(redial);
        expect(app.view!.actionError, redialNotAllowedCopy);
        expect(app.view!.wrapup!.redialRemaining, 2);
        expect(app.view!.wrapup!.endsAt, DateTime.utc(2026, 11, 1, 9, 2));
        app.dispose();
      });
    });

    test('once placed, the wrap-up\'s clock is gone (the server stopped it): no digits, no hold, no save-by notice', () {
      fakeAsync((async) {
        final app = App(async)..start();
        app.inRedialWrapup('att-1');
        expect(app.view!.wrapup!.endsAt, isNotNull);
        app.routes['POST $_redialPath'] = (_) => json(200, _redialResponse());
        app.run(app.controller.redial(attemptId: 'att-1'));
        expect(app.view!.busy, StationBusy.redialing);
        expect(app.view!.wrapup!.endsAt, isNull);
        expect(app.view!.wrapup!.hold, WrapupHold.none);
        app.routes['POST /proxy/agency/sessions/sess-1/break'] =
            (_) => json(200, stateBody('wrapup', breakReason: 'device_away', pending: 'break'));
        app.lifecycle.hide();
        async.flushMicrotasks();
        expect(app.notifier.calls.where((c) => c.startsWith('wrapup:')), isEmpty);
        app.dispose();
      });
    });

    test('no usable answer: the pad opens again, and the copy never says the redial failed', () {
      fakeAsync((async) {
        final app = App(async)..start();
        app.inRedialWrapup('att-1');
        app.routes['POST $_redialPath'] = (_) => throw const SocketException('down');
        app.run(app.controller.redial(attemptId: 'att-1'));
        expect(app.view!.actionError, redialUncertainCopy);
        expect(app.view!.busy, StationBusy.none);
        expect(app.view!.wrapup!.redialRemaining, 2);

        app.routes['POST $_redialPath'] = (_) => json(503, {'error': 'Service Unavailable', 'message': 'Try later.'});
        app.run(app.controller.redial(attemptId: 'att-1'));
        expect(app.view!.actionError, redialUncertainCopy);
        app.dispose();
      });
    });

    test('a placed redial whose call never reaches the station gives the pad back after 10 s', () {
      fakeAsync((async) {
        final app = App(async)..start();
        app.inRedialWrapup('att-1');
        app.routes['POST $_redialPath'] = (_) => json(200, _redialResponse());
        app.run(app.controller.redial(attemptId: 'att-1'));
        async.elapse(const Duration(seconds: 9));
        expect(app.view!.busy, StationBusy.redialing);
        async.elapse(const Duration(seconds: 2));
        expect(app.view!.busy, StationBusy.none);
        expect(app.view!.actionError, redialNotArrivedCopy);
        expect(app.view!.wrapup!.endsAt, isNotNull);
        app.dispose();
      });
    });

    test('a placed redial whose call arrives in time leaves nothing behind to fire', () {
      fakeAsync((async) {
        final app = App(async)..start();
        app.inRedialWrapup('att-1');
        app.routes['POST $_redialPath'] = (_) => json(200, _redialResponse());
        app.run(app.controller.redial(attemptId: 'att-1'));
        app.reservedRedial('att-2', of: 'att-1');
        async.elapse(const Duration(seconds: 30));
        expect(app.view!.actionError, isNull);
        expect(app.view!.phase, AgentPhase.reserved);
        app.dispose();
      });
    });

    test('a tap for a wrap-up no longer on screen redials nothing', () {
      fakeAsync((async) {
        final app = App(async)..start();
        app.inRedialWrapup('att-1');
        app.run(app.controller.redial(attemptId: 'att-0'));
        expect(app.requests('POST', _redialPath), isEmpty);
        expect(app.view!.actionError, redialCallChangedCopy);

        // On a call, there is no wrap-up to redial from.
        app.agentStateFrame('available');
        app.onCall('att-3');
        app.run(app.controller.redial());
        expect(app.requests('POST', _redialPath), isEmpty);
        app.dispose();
      });
    });

    test('a redial that fails before it rings opens its own wrap-up, keyed to the redial', () {
      fakeAsync((async) {
        final app = App(async)..start();
        app.inRedialWrapup('att-1');
        app.routes['POST $_redialPath'] = (_) => json(200, _redialResponse());
        app.run(app.controller.redial(attemptId: 'att-1'));
        app.releasedFrame('att-2', reason: 'failed');
        app.frame({'event': 'wrapup', 'wrapup': _wrapup('att-2', remaining: 1)});
        expect(app.controller.stationState.currentAttemptId, 'att-2');
        expect(app.view!.busy, StationBusy.none);
        expect(app.view!.wrapup!.redialRemaining, 1);
        app.dispose();
      });
    });

    test('a drop while the redial is on its way frees Reconnect', () {
      fakeAsync((async) {
        final app = App(async)..start();
        app.inRedialWrapup('att-1');
        app.routes['POST $_redialPath'] = (_) => json(200, _redialResponse());
        app.run(app.controller.redial(attemptId: 'att-1'));
        expect(app.view!.busy, StationBusy.redialing);
        app.socket.serverClose(1006);
        async.flushMicrotasks();
        expect(app.view!.link, isNot(StationLink.open));
        expect(app.view!.busy, StationBusy.none);
        app.dispose();
      });
    });

    test('a reconnect restores the live redial and the wrap-up count', () {
      fakeAsync((async) {
        final app = App(async)..start();
        app.readyFrame('on_call', extra: {
          'active_attempt': {
            ...app.attemptJson('att-2'),
            'redial': _redialInfo('att-1', 2, 0),
            'bridged_at': '2026-11-01T09:00:10.000Z',
            'state': 'bridged',
          },
        });
        expect(app.view!.phase, AgentPhase.onCall);
        expect(app.view!.call!.redialNumber, 2);
        expect(app.view!.call!.redialLimit, 2);

        app.readyFrame('wrapup', extra: {'active_wrapup': _wrapup('att-2', remaining: 0)});
        expect(app.view!.phase, AgentPhase.wrapup);
        expect(app.view!.wrapup!.redialRemaining, 0);
        app.dispose();
      });
    });
  });

  group('the notes draft carries into the redial', () {
    void notesRoute(App app, String id) => app.routes['POST /proxy/agency/attempts/$id/notes'] = (r) => json(200, {
          'attempt_id': id,
          'notes': (r.body! as Map)['notes'],
          'updated_at': '2026-11-01T09:00:30.000Z',
        });
    void dispositionRoute(App app, String id) => app.routes['POST /proxy/agency/attempts/$id/disposition'] = (_) => json(200, {
          'campaign_id': 'camp-1',
          'attempt_id': id,
          'contact_id': 'c-$id',
          'disposition_code': 'interested',
          'contact_state': 'completed',
          'agent_state': 'wrapup',
        });
    List<Sent> notesWrites(App app) => app.sent.where((r) => r.path.endsWith('/notes')).toList();

    /// The redial rings, connects, ends, and opens its own wrap-up.
    void redialToWrapup(App app) {
      app.reservedRedial('att-2', of: 'att-1');
      app.bridged('att-2');
      app.releasedFrame('att-2');
      app.agentStateFrame('wrapup');
      app.frame({'event': 'wrapup', 'wrapup': _wrapup('att-2', remaining: 1)});
    }

    test('saved notes: shown on the redial\'s call and wrap-up, sent with its outcome, no request of their own', () {
      fakeAsync((async) {
        final app = App(async)..start();
        app.inRedialWrapup('att-1');
        notesRoute(app, 'att-1');
        app.controller.updateNotes('Wants EMI options');
        async.elapse(const Duration(seconds: 3));
        expect(notesWrites(app), hasLength(1), reason: 'saved to the first call before the redial');

        app.routes['POST $_redialPath'] = (_) => json(200, _redialResponse());
        app.run(app.controller.redial(attemptId: 'att-1'));
        app.reservedRedial('att-2', of: 'att-1');
        expect(app.view!.notes.text, 'Wants EMI options');

        redialToWrapup(app);
        expect(app.controller.stationState.currentAttemptId, 'att-2');
        expect(app.view!.notes.text, 'Wants EMI options');
        async.elapse(const Duration(seconds: 5));
        expect(notesWrites(app), hasLength(1), reason: 'the server copied them onto the redial; nothing is re-sent');

        dispositionRoute(app, 'att-2');
        app.run(app.controller.submitDisposition('interested'));
        expect(app.requests('POST', '/proxy/agency/attempts/att-2/disposition').single.body,
            {'disposition_code': 'interested', 'notes': 'Wants EMI options'});
        app.dispose();
      });
    });

    test('notes typed inside the debounce are saved to the call before the redial is asked for, so the copy holds them', () {
      fakeAsync((async) {
        final app = App(async)..start();
        app.inRedialWrapup('att-1');
        notesRoute(app, 'att-1');
        notesRoute(app, 'att-2');
        app.controller.updateNotes('Call after 6');
        // Redial inside the 2 s debounce.
        app.routes['POST $_redialPath'] = (_) => json(200, _redialResponse());
        app.run(app.controller.redial(attemptId: 'att-1'));
        expect(
          [for (final r in app.sent) if (r.path.endsWith('/notes') || r.path == _redialPath) r.path],
          ['/proxy/agency/attempts/att-1/notes', _redialPath],
          reason: 'the server copies the call\'s saved notes onto the redial when it places it',
        );
        expect(notesWrites(app).single.body, {'notes': 'Call after 6'});
        app.reservedRedial('att-2', of: 'att-1');
        async.elapse(const Duration(seconds: 5));
        expect(notesWrites(app), hasLength(1), reason: 'the redial already holds them: nothing is re-sent');
        expect(app.view!.notes.text, 'Call after 6');

        app.bridged('att-2');
        app.controller.updateNotes('Call after 6, prefers Marathi');
        async.elapse(const Duration(seconds: 3));
        expect(notesWrites(app).last.path, '/proxy/agency/attempts/att-2/notes');
        expect(notesWrites(app).last.body, {'notes': 'Call after 6, prefers Marathi'});
        app.dispose();
      });
    });

    test('a notes save still unanswered after 2 s: the redial goes, and the text is saved to the redial too', () {
      fakeAsync((async) {
        final app = App(async)..start();
        app.inRedialWrapup('att-1');
        final late = Completer<http.Response>();
        app.routes['POST /proxy/agency/attempts/att-1/notes'] = (_) => late.future;
        notesRoute(app, 'att-2');
        app.controller.updateNotes('Call after 6');
        app.routes['POST $_redialPath'] = (_) => json(200, _redialResponse());
        final redial = app.controller.redial(attemptId: 'att-1');
        async.elapse(const Duration(seconds: 1));
        expect(app.requests('POST', _redialPath), isEmpty, reason: 'waiting for the save');
        expect(app.view!.busy, StationBusy.redialing);
        async.elapse(const Duration(seconds: 2));
        app.run(redial);
        expect(app.requests('POST', _redialPath), hasLength(1), reason: 'the wait is bounded');
        // The save lands after the server made its copy: the copy may not hold it.
        late.complete(json(200, {'attempt_id': 'att-1', 'notes': 'Call after 6', 'updated_at': '2026-11-01T09:00:30.000Z'}));
        async.flushMicrotasks();
        app.reservedRedial('att-2', of: 'att-1');
        expect(app.view!.notes.text, 'Call after 6');
        async.elapse(const Duration(seconds: 3));
        expect(app.requests('POST', '/proxy/agency/attempts/att-2/notes').single.body, {'notes': 'Call after 6'});
        app.dispose();
      });
    });

    test('the redial\'s own wrap-up before the answer naming it (it failed before it rang): the field opens on the draft', () {
      fakeAsync((async) {
        final app = App(async)..start();
        app.inRedialWrapup('att-1');
        notesRoute(app, 'att-1');
        app.controller.updateNotes('Asked for a callback');
        async.elapse(const Duration(seconds: 3));
        final answer = Completer<http.Response>();
        app.routes['POST $_redialPath'] = (_) => answer.future;
        final redial = app.controller.redial(attemptId: 'att-1');
        async.flushMicrotasks();
        // The redial failed at once: its wrap-up reaches the station first.
        app.releasedFrame('att-2', reason: 'failed');
        app.frame({'event': 'wrapup', 'wrapup': _wrapup('att-2', remaining: 1)});
        expect(app.controller.stationState.currentAttemptId, 'att-2');
        answer.complete(json(200, _redialResponse()));
        app.run(redial);
        expect(app.view!.notes.text, 'Asked for a callback');
        expect(app.view!.busy, StationBusy.none);
        dispositionRoute(app, 'att-2');
        app.run(app.controller.submitDisposition('interested'));
        expect((app.requests('POST', '/proxy/agency/attempts/att-2/disposition').single.body! as Map)['notes'],
            'Asked for a callback');
        app.dispose();
      });
    });

    test('a redial that fails before it rings opens its wrap-up on the draft', () {
      fakeAsync((async) {
        final app = App(async)..start();
        app.inRedialWrapup('att-1');
        app.controller.updateNotes('Asked for a callback');
        app.routes['POST $_redialPath'] = (_) => json(200, _redialResponse());
        app.run(app.controller.redial(attemptId: 'att-1'));
        app.releasedFrame('att-2', reason: 'failed');
        app.frame({'event': 'wrapup', 'wrapup': _wrapup('att-2', remaining: 1)});
        expect(app.controller.stationState.currentAttemptId, 'att-2');
        expect(app.view!.notes.text, 'Asked for a callback');
        dispositionRoute(app, 'att-2');
        app.run(app.controller.submitDisposition('interested'));
        expect((app.requests('POST', '/proxy/agency/attempts/att-2/disposition').single.body! as Map)['notes'],
            'Asked for a callback');
        app.dispose();
      });
    });

    test('a call the dialer placed starts with empty notes', () {
      fakeAsync((async) {
        final app = App(async)..start();
        app.inWrapup('att-1');
        notesRoute(app, 'att-1');
        app.controller.updateNotes('First customer');
        async.elapse(const Duration(seconds: 3));
        dispositionRoute(app, 'att-1');
        app.run(app.controller.submitDisposition('interested'));
        app.agentStateFrame('available');
        app.reserved('att-2');
        async.flushMicrotasks();
        expect(app.view!.notes.text, '');
        app.dispose();
      });
    });

    test('back onto the redial after a restart: the draft is read from the phone', () {
      fakeAsync((async) {
        final app = App(async);
        app.store.entries['att-1'] = (notes: 'Typed before the app was killed', at: app.now());
        app.start();
        app.readyFrame('on_call', extra: {
          'active_attempt': {
            ...app.attemptJson('att-2'),
            'redial': _redialInfo('att-1', 1, 1),
            'bridged_at': '2026-11-01T09:00:10.000Z',
            'state': 'bridged',
          },
        });
        async.flushMicrotasks();
        expect(app.view!.notes.text, 'Typed before the app was killed');
        app.dispose();
      });
    });

    test('text the redial already has wins over the carry on a reconnect', () {
      fakeAsync((async) {
        final app = App(async)..start();
        app.inRedialWrapup('att-1');
        notesRoute(app, 'att-1');
        notesRoute(app, 'att-2');
        app.controller.updateNotes('First');
        async.elapse(const Duration(seconds: 3));
        app.routes['POST $_redialPath'] = (_) => json(200, _redialResponse());
        app.run(app.controller.redial(attemptId: 'att-1'));
        app.reservedRedial('att-2', of: 'att-1');
        app.bridged('att-2');
        app.controller.updateNotes('First, then more on the redial');
        async.elapse(const Duration(seconds: 3));
        app.readyFrame('on_call', extra: {
          'active_attempt': {
            ...app.attemptJson('att-2'),
            'redial': _redialInfo('att-1', 1, 1),
            'bridged_at': '2026-11-01T09:00:10.000Z',
            'state': 'bridged',
          },
        });
        expect(app.view!.notes.text, 'First, then more on the redial');
        async.flushMicrotasks();
        expect(app.store.entries['att-2']?.notes, 'First, then more on the redial',
            reason: 'the phone\'s copy of the redial is never set back to the first call\'s');
        app.dispose();
      });
    });
  });

  group('telemetry (the console\'s event names)', () {
    late FakeTelemetrySink sink;
    setUp(() {
      CallTelemetry.resetInstance();
      sink = installFakeTelemetry();
    });
    tearDown(Telemetry.uninstall);

    test('pressed, with the count shown; refused, with the code', () {
      fakeAsync((async) {
        final app = App(async)..start();
        app.inRedialWrapup('att-1');
        app.routes['POST $_redialPath'] =
            (_) => json(409, {'error': 'Conflict', 'code': 'redial_blocked_calling_hours', 'message': 'x'});
        app.run(app.controller.redial(attemptId: 'att-1'));
        expect(sink.last('agency_redial_requested'), {'campaign_id': 'camp-1', 'redial_remaining': 2});
        expect(sink.last('agency_redial_refused'), {'campaign_id': 'camp-1', 'code': 'redial_blocked_calling_hours'});

        app.routes['POST $_redialPath'] = (_) => json(200, _redialResponse());
        app.run(app.controller.redial(attemptId: 'att-1'));
        expect(sink.names.where((n) => n == 'agency_redial_requested'), hasLength(2));
        expect(sink.names.where((n) => n == 'agency_redial_refused'), hasLength(1));
        app.dispose();
      });
    });

    test('a failure with no refusal is counted too, with no code', () {
      fakeAsync((async) {
        final app = App(async)..start();
        app.inRedialWrapup('att-1');
        app.routes['POST $_redialPath'] = (_) => throw const SocketException('down');
        app.run(app.controller.redial(attemptId: 'att-1'));
        // No code: the key is left out (the sink drops nulls), as PostHog reads a null.
        expect(sink.last('agency_redial_refused'), {'campaign_id': 'camp-1'});

        app.routes['POST $_redialPath'] = (_) => throw StateError('unforeseen');
        app.run(app.controller.redial(attemptId: 'att-1'));
        expect(sink.names.where((n) => n == 'agency_redial_requested'), hasLength(2));
        expect(sink.names.where((n) => n == 'agency_redial_refused'), hasLength(2));
        expect(app.view!.actionError, redialUncertainCopy);
        expect(app.view!.busy, StationBusy.none);
        app.dispose();
      });
    });
  });

  group('copy', () {
    test('every redial refusal has words, never a raw code', () {
      expect(redialRefusalCopy(AgencyErrorCode.redialNotAllowed, 's'), redialNotAllowedCopy);
      expect(redialRefusalCopy(AgencyErrorCode.redialLimitReached, 's'), redialLimitReachedCopy);
      expect(redialRefusalCopy(AgencyErrorCode.dispositionAlreadySubmitted, 's'), redialAlreadySavedCopy);
      expect(redialRefusalCopy(AgencyErrorCode.redialBlockedDnc, 's'), redialBlockedDncCopy);
      expect(redialRefusalCopy(AgencyErrorCode.redialBlockedCallingHours, 's'), redialBlockedHoursCopy);
      expect(redialRefusalCopy(AgencyErrorCode.redialBlocked, 'No caller ID.'), 'No caller ID.');
      expect(redialRefusalCopy(AgencyErrorCode.redialBlocked, null), redialFailedCopy);
      expect(redialRefusalCopy(AgencyErrorCode.unknown, null), redialFailedCopy);
      expect(redialRefusalCopy(null, 'Server words.'), 'Server words.');
    });
  });
}
