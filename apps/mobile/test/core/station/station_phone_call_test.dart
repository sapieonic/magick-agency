import 'dart:async';

import 'package:agency_wire/agency_wire.dart' show ReservedBreakCode, deviceAwayReturnGrace;
import 'package:agent_audio/agent_audio.dart' show PhoneCallChanged;
import 'package:fake_async/fake_async.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:magick_agency_agent/core/station/away_return.dart';
import 'package:magick_agency_agent/core/station/station_controller.dart' show StationController;
import 'package:magick_agency_agent/core/station/station_copy.dart';
import 'package:magick_agency_agent/core/station/station_view.dart';

import 'controller_harness.dart';

const _breakPath = '/proxy/agency/sessions/sess-1/break';
const _availablePath = '/proxy/agency/sessions/sess-1/available';

/// IQ51: a cellular call while the agent waits for calls pauses them with the reserved
/// `phone_call` break for the length of the call, and returns them when it ends, only from a
/// pause the call itself caused. During a station call nothing changes (the audio interruption
/// is that call's). The engine's reports are driven as the plugin sends them.
void main() {
  /// Joined, waiting for calls, the pause and the return answered as the server does.
  App waiting(FakeAsync async) {
    final app = App(async)..start();
    app.readyFrame('available');
    app.agentStateFrame('available');
    app.routes['POST $_breakPath'] = (_) => json(200, stateBody('break', breakReason: ReservedBreakCode.phoneCall.wire));
    app.routes['POST $_availablePath'] = (_) => json(200, stateBody('available'));
    return app;
  }

  void phoneCall(App app, bool active) {
    app.engine.emitEvent(PhoneCallChanged(active: active));
    app.async.flushMicrotasks();
  }

  List<Object?> pauses(App app) => [for (final r in app.requests('POST', _breakPath)) (r.body as Map?)?['reason']];

  test('the reports are asked for while waiting for calls, and not during a station call', () {
    fakeAsync((async) {
      final app = waiting(async);
      expect(app.engine.phoneCallMonitoring, isTrue);
      app.reserved('att-1');
      expect(app.engine.phoneCallMonitoring, isFalse, reason: 'a call on the station: its interruption, not a pause');
      app.dispose();
    });
  });

  test('available, a cellular call starts: paused on phone_call; it ends: returned to the pool', () {
    fakeAsync((async) {
      final app = waiting(async);
      phoneCall(app, true);
      expect(pauses(app), [ReservedBreakCode.phoneCall.wire]);
      app.agentStateFrame('break', breakReason: ReservedBreakCode.phoneCall.wire, since: '2026-11-01T09:00:01.000Z');
      expect(app.view!.phase, AgentPhase.onBreak);
      expect(app.view!.onBreak!.label, phoneCallBreakLabel);
      async.elapse(const Duration(seconds: 5));
      phoneCall(app, false);
      expect(app.requests('POST', _availablePath), hasLength(1));
      // Who rang meanwhile (IQ50's rule for the phone call): from when the pause began.
      expect(
        app.container.read(awayReturnProvider),
        AwayReturn(since: DateTime.utc(2026, 11, 1, 9, 0, 1), kind: AwayKind.phoneCall, seq: 1),
      );
      app.agentStateFrame('available', since: '2026-11-01T09:00:06.000Z');
      expect(app.view!.phase, AgentPhase.available);
      expect(pauses(app), hasLength(1));
      app.dispose();
    });
  });

  test('a call already ringing when the agent becomes available pauses them too', () {
    fakeAsync((async) {
      final app = App(async)..start();
      app.routes['POST $_breakPath'] = (_) => json(200, stateBody('break', breakReason: ReservedBreakCode.phoneCall.wire));
      app.readyFrame('break');
      app.agentStateFrame('break', breakReason: 'tea');
      expect(app.engine.phoneCallMonitoring, isFalse);
      app.agentStateFrame('available', since: '2026-11-01T09:01:00.000Z');
      expect(app.engine.phoneCallMonitoring, isTrue);
      // Turning the reports on states the call in progress.
      phoneCall(app, true);
      expect(pauses(app), [ReservedBreakCode.phoneCall.wire]);
      app.dispose();
    });
  });

  test('a break taken while on the phone is never ended when the call ends', () {
    fakeAsync((async) {
      final app = waiting(async);
      phoneCall(app, true);
      app.agentStateFrame('break', breakReason: ReservedBreakCode.phoneCall.wire);
      app.agentStateFrame('break', breakReason: 'lunch', since: '2026-11-01T09:01:00.000Z');
      phoneCall(app, false);
      async.elapse(const Duration(seconds: 5));
      expect(app.requests('POST', _availablePath), isEmpty);
      expect(app.view!.onBreak!.code, 'lunch');
      expect(app.container.read(awayReturnProvider), isNull, reason: 'not the call\'s pause');
      app.dispose();
    });
  });

  test('a supervisor’s change while on the phone (made available, or offline) is not followed by a return', () {
    fakeAsync((async) {
      final app = waiting(async);
      phoneCall(app, true);
      app.agentStateFrame('break', breakReason: ReservedBreakCode.phoneCall.wire);
      app.agentStateFrame('offline', since: '2026-11-01T09:01:00.000Z');
      phoneCall(app, false);
      async.elapse(const Duration(seconds: 5));
      expect(app.requests('POST', _availablePath), isEmpty);
      app.dispose();
    });
  });

  test('the agent ends the pause themselves mid-call: not paused again for that call, nothing on its end', () {
    fakeAsync((async) {
      final app = waiting(async);
      phoneCall(app, true);
      app.agentStateFrame('break', breakReason: ReservedBreakCode.phoneCall.wire);
      app.run(app.controller.endBreak());
      app.agentStateFrame('available', since: '2026-11-01T09:01:00.000Z');
      async.elapse(const Duration(seconds: 5));
      expect(pauses(app), hasLength(1));
      phoneCall(app, false);
      expect(app.requests('POST', _availablePath), hasLength(1), reason: 'only the agent’s own');
      app.dispose();
    });
  });

  test('during a station call: no pause, whatever the phone does', () {
    fakeAsync((async) {
      final app = waiting(async);
      app.reserved('att-1');
      app.bridged('att-1');
      phoneCall(app, true);
      phoneCall(app, false);
      app.releasedFrame('att-1', requiresDisposition: false);
      async.flushMicrotasks();
      expect(app.requests('POST', _breakPath), isEmpty);
      app.dispose();
    });
  });

  test('queued behind a call reserved meanwhile: withdrawn when the cellular call ends', () {
    fakeAsync((async) {
      final app = waiting(async);
      final answer = Completer<http.Response>();
      app.routes['POST $_breakPath'] = (_) => answer.future;
      app.routes['POST $_breakPath/cancel'] = (_) => json(200, stateBody('on_call'));
      phoneCall(app, true);
      app.reserved('att-1');
      answer.complete(json(200, stateBody('reserved', breakReason: ReservedBreakCode.phoneCall.wire, pending: 'break')));
      async.flushMicrotasks();
      expect(app.view!.queuedBreak?.code, ReservedBreakCode.phoneCall.wire);
      app.bridged('att-1');
      phoneCall(app, false);
      expect(app.requests('POST', '$_breakPath/cancel'), hasLength(1));
      expect(app.view!.queuedBreak, isNull);
      expect(app.requests('POST', _availablePath), isEmpty);
      app.dispose();
    });
  });

  test('refused: asked again on a blip, then the agent is told; nothing to return from', () {
    fakeAsync((async) {
      final app = waiting(async);
      app.routes['POST $_breakPath'] = (_) => json(503, {'message': 'down'});
      phoneCall(app, true);
      async.elapse(const Duration(seconds: 10));
      expect(pauses(app), hasLength(1 + StationController.awayRetryDelays.length), reason: 'the first ask and its retries');
      expect(app.view!.actionError, phoneCallPauseFailedCopy);
      phoneCall(app, false);
      async.elapse(const Duration(seconds: 5));
      expect(app.requests('POST', _availablePath), isEmpty);
      app.dispose();
    });
  });

  test('refused outright: said at once, not asked again', () {
    fakeAsync((async) {
      final app = waiting(async);
      app.routes['POST $_breakPath'] = (_) => json(400, {'code': 'unknown_break_reason', 'message': 'no'});
      phoneCall(app, true);
      async.elapse(const Duration(seconds: 10));
      expect(pauses(app), hasLength(1));
      expect(app.view!.actionError, phoneCallPauseFailedCopy);
      app.dispose();
    });
  });

  test('the call took the screen (the app left): no away pause on top, and the return waits for the app', () {
    fakeAsync((async) {
      final app = waiting(async);
      final answer = Completer<http.Response>();
      app.routes['POST $_breakPath'] = (_) => answer.future;
      phoneCall(app, true);
      // Answered: the phone's call screen comes up over the app while the pause is on its way.
      app.lifecycle.hide();
      async.flushMicrotasks();
      expect(pauses(app), [ReservedBreakCode.phoneCall.wire], reason: 'no device_away while the call’s pause is on its way');
      answer.complete(json(200, stateBody('break', breakReason: ReservedBreakCode.phoneCall.wire)));
      async.flushMicrotasks();
      expect(pauses(app), [ReservedBreakCode.phoneCall.wire], reason: 'nor once it applied');
      app.agentStateFrame('break', breakReason: ReservedBreakCode.phoneCall.wire);
      async.elapse(const Duration(minutes: 3));
      phoneCall(app, false);
      expect(app.requests('POST', _availablePath), isEmpty, reason: 'never made available while away');
      async.elapse(const Duration(seconds: 10));
      app.lifecycle.show();
      async.flushMicrotasks();
      expect(app.requests('POST', _availablePath), hasLength(1));
      app.dispose();
    });
  });

  test('the call ended long before the app came back: left to the tap', () {
    fakeAsync((async) {
      final app = waiting(async);
      phoneCall(app, true);
      app.agentStateFrame('break', breakReason: ReservedBreakCode.phoneCall.wire);
      app.lifecycle.hide();
      async.flushMicrotasks();
      phoneCall(app, false);
      async.elapse(deviceAwayReturnGrace + const Duration(seconds: 1));
      app.lifecycle.show();
      async.flushMicrotasks();
      expect(app.requests('POST', _availablePath), isEmpty);
      expect(app.view!.onBreak!.code, ReservedBreakCode.phoneCall.wire);
      expect(app.container.read(awayReturnProvider)?.kind, AwayKind.phoneCall, reason: 'still told who rang');
      app.dispose();
    });
  });

  test('a soft-phone session is never paused for a phone call', () {
    fakeAsync((async) {
      final app = App(async)..openSoftphone();
      app.frame({'event': 'ready', 'session_id': 'sess-sp', 'state': 'break', 'break_reason': 'soft_phone'});
      expect(app.engine.phoneCallMonitoring, isFalse);
      app.dispose();
    });
  });
}
