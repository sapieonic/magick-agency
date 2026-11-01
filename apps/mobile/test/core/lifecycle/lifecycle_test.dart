import 'dart:async';

import 'package:agency_wire/agency_wire.dart';
import 'package:fake_async/fake_async.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:magick_agency_agent/core/lifecycle/lifecycle_policy.dart';
import 'package:magick_agency_agent/core/station/station_view.dart';

import '../station/controller_harness.dart';

const _breakPath = '/proxy/agency/sessions/sess-1/break';

void main() {
  group('policy', () {
    test('away action per phase', () {
      expect(awayActionFor(AgentState.available, pendingBreakCode: null), AwayAction.pauseNow);
      expect(awayActionFor(AgentState.offline, pendingBreakCode: null), AwayAction.pauseNow);
      for (final s in [AgentState.reserved, AgentState.onCall, AgentState.wrapup]) {
        expect(awayActionFor(s, pendingBreakCode: null), AwayAction.queuePause, reason: s.wire);
        expect(awayActionFor(s, pendingBreakCode: 'tea'), AwayAction.none, reason: 'a queued break already pauses them');
      }
      expect(awayActionFor(AgentState.onBreak, pendingBreakCode: null), AwayAction.none);
    });

    test('notices: paused, or the wrap-up deadline, only while away', () {
      final deadline = DateTime.utc(2026, 11, 1, 11, 28);
      AwayNotice notice(AgentState s, {bool fg = false, String? code, bool asked = false, DateTime? at}) =>
          awayNoticeFor(s, foreground: fg, breakCode: code, pauseRequested: asked, wrapupDeadline: at);
      expect(notice(AgentState.available, asked: true), AwayNotice.paused);
      expect(notice(AgentState.available, asked: true, fg: true), AwayNotice.none);
      expect(notice(AgentState.onBreak, code: 'device_away'), AwayNotice.paused);
      expect(notice(AgentState.onBreak, code: 'tea'), AwayNotice.none);
      expect(notice(AgentState.wrapup, at: deadline), AwayNotice.wrapupDeadline);
      expect(notice(AgentState.wrapup), AwayNotice.none);
      expect(notice(AgentState.onCall), AwayNotice.none);
    });

    test('pings, keep-alive and the wake lock', () {
      expect(appPingsWanted(foreground: false, state: AgentState.available), isFalse);
      expect(appPingsWanted(foreground: false, state: AgentState.wrapup), isTrue);
      expect(appPingsWanted(foreground: true, state: AgentState.onBreak), isTrue);
      expect(keepAliveWanted(foreground: false, state: AgentState.onBreak), isFalse);
      expect(wakeLockWanted(onDuty: true, foreground: true), isTrue);
      expect(wakeLockWanted(onDuty: true, foreground: false), isFalse);
      expect(wakeLockWanted(onDuty: false, foreground: true), isFalse);
    });

    test('a soft-phone session is never paused, whatever its state reads', () {
      for (final s in AgentState.values) {
        expect(awayActionFor(s, pendingBreakCode: null, softphoneSession: true), AwayAction.none, reason: s.wire);
      }
    });

    test('a soft-phone call live or owed keeps pings and keep-alive on in the background, as a call does', () {
      expect(appPingsWanted(foreground: false, state: AgentState.onBreak, manualCall: true), isTrue);
      expect(keepAliveWanted(foreground: false, state: AgentState.onBreak, manualCall: true), isTrue);
      expect(appPingsWanted(foreground: false, state: AgentState.onBreak), isFalse);
    });

    test('an owed soft-phone outcome is the wrap-up notice away, and only away', () {
      final due = DateTime.utc(2026, 11, 1, 11, 28);
      expect(
        awayNoticeFor(AgentState.onBreak, foreground: false, breakCode: 'soft_phone', pauseRequested: false, wrapupDeadline: null, outcomeDueAt: due),
        AwayNotice.wrapupDeadline,
      );
      expect(
        awayNoticeFor(AgentState.onBreak, foreground: true, breakCode: 'soft_phone', pauseRequested: false, wrapupDeadline: null, outcomeDueAt: due),
        AwayNotice.none,
      );
      expect(
        awayNoticeFor(AgentState.onBreak, foreground: false, breakCode: 'soft_phone', pauseRequested: false, wrapupDeadline: null),
        AwayNotice.none,
      );
    });

    test('the wake lock: an idle soft phone lets the screen sleep', () {
      expect(wakeLockWanted(onDuty: true, foreground: true, idleSoftphone: true), isFalse);
      expect(wakeLockWanted(onDuty: true, foreground: true, idleSoftphone: false), isTrue);
    });
  });

  group('leaving the app', () {
    test('available: device_away is the FIRST request, pings stop, the agent is told, the screen may sleep', () {
      fakeAsync((async) {
        final app = App(async)..start();
        app.readyFrame('available');
        app.agentStateFrame('available');
        app.routes['POST $_breakPath'] = (_) => json(200, stateBody('break', breakReason: 'device_away'));
        final before = app.sent.length;
        final pingsBefore = app.socket.pings.length;

        app.lifecycle.hide();
        async.flushMicrotasks();
        expect(app.sent[before].path, _breakPath);
        expect(app.sent[before].body, {'reason': 'device_away'});
        expect(app.notifier.calls.last, 'paused');
        expect(app.wakeLock.on, isFalse);
        async.elapse(const Duration(seconds: 60));
        expect(app.socket.pings.length, pingsBefore, reason: 'no app pings while away and not on a call');

        // The station confirms; then the agent comes back.
        app.agentStateFrame('break', breakReason: 'device_away');
        expect(app.view!.onBreak!.isDeviceAway, isTrue);
        app.lifecycle.show();
        expect(app.notifier.calls.last, 'cancel');
        expect(app.wakeLock.on, isTrue);
        expect(app.socket.pings.length, pingsBefore + 1, reason: 'a ping at once on return');
        expect(app.requests('POST', _breakPath), hasLength(1));
        app.dispose();
      });
    });

    test('a socket that died while away comes back on return, and ready + the HTTP answer show the pause', () {
      fakeAsync((async) {
        final app = App(async)..start();
        app.readyFrame('available');
        app.agentStateFrame('available');
        app.routes['POST $_breakPath'] = (_) => json(200, stateBody('break', breakReason: 'device_away'));
        app.lifecycle.hide();
        async.flushMicrotasks();
        // The OS suspended the app; the socket dropped. No retry while away.
        app.socket.serverClose(4408);
        async.elapse(const Duration(minutes: 3));
        expect(app.connector.attempts, 1);

        app.lifecycle.show();
        async.flushMicrotasks();
        expect(app.connector.attempts, 2);
        app.readyFrame('break');
        final onBreak = app.view!.onBreak!;
        expect(onBreak.isDeviceAway, isTrue);
        expect(onBreak.label, 'Away');
        expect(onBreak.since, DateTime.utc(2026, 11, 1, 9));
        app.dispose();
      });
    });

    test('a pause that fails is asked for again while away, and stops once it lands', () {
      fakeAsync((async) {
        final app = App(async)..start();
        app.readyFrame('available');
        app.agentStateFrame('available');
        var replies = <Reply>[
          (_) => json(409, {'code': 'state_changing', 'message': 'Try again.'}),
          (_) => json(503, {'message': 'down'}),
          (_) => json(200, stateBody('break', breakReason: 'device_away')),
        ];
        app.routes['POST $_breakPath'] = (r) => replies.removeAt(0)(r);
        app.lifecycle.hide();
        async.flushMicrotasks();
        expect(app.requests('POST', _breakPath), hasLength(1));
        async.elapse(const Duration(seconds: 1));
        expect(app.requests('POST', _breakPath), hasLength(2));
        async.elapse(const Duration(seconds: 2));
        expect(app.requests('POST', _breakPath), hasLength(3));
        async.elapse(const Duration(minutes: 1));
        expect(app.requests('POST', _breakPath), hasLength(3), reason: 'landed: no more asks');
        expect(app.socket.closed, isFalse, reason: 'it landed, so the station stays open');
        replies = [];
        app.dispose();
      });
    });

    test('a pause that never lands: within 10 s the station socket is closed, and opens again on return', () {
      fakeAsync((async) {
        final app = App(async)..start();
        app.readyFrame('available');
        app.agentStateFrame('available');
        app.routes['POST $_breakPath'] = (_) => json(503, {'message': 'down'});
        final first = app.socket;
        app.lifecycle.hide();
        async.flushMicrotasks();
        async.elapse(const Duration(seconds: 9));
        expect(first.closed, isFalse);
        async.elapse(const Duration(seconds: 1));
        // The server's close handler now takes the agent out of the pool.
        expect(first.closed, isTrue);
        expect(first.closedWith, 1000);
        final asked = app.requests('POST', _breakPath).length;
        expect(asked, greaterThan(1));
        async.elapse(const Duration(minutes: 5));
        expect(app.connector.attempts, 1, reason: 'nothing reconnects while away');
        expect(app.requests('POST', _breakPath), hasLength(asked), reason: 'nor asks again');
        expect(app.notifier.calls.last, 'paused');

        app.lifecycle.show();
        async.flushMicrotasks();
        expect(app.connector.attempts, 2);
        app.readyFrame('offline');
        expect(app.view!.phase, AgentPhase.offline);
        app.dispose();
      });
    });

    test('a pause refused outright closes the station at once', () {
      fakeAsync((async) {
        final app = App(async)..start();
        app.readyFrame('available');
        app.routes['POST $_breakPath'] = (_) => json(400, {'code': 'bad_request', 'message': 'no'});
        app.lifecycle.hide();
        async.flushMicrotasks();
        expect(app.requests('POST', _breakPath), hasLength(1));
        expect(app.socket.closed, isTrue);
        app.dispose();
      });
    });

    test('back before the bound with the pause never confirmed: available is said again, so the agent really rings', () {
      fakeAsync((async) {
        final app = App(async)..start();
        app.readyFrame('available');
        app.agentStateFrame('available');
        app.routes['POST $_breakPath'] = (_) => json(503, {'message': 'down'});
        app.routes['POST /proxy/agency/sessions/sess-1/available'] = (_) => json(200, stateBody('available'));
        app.lifecycle.hide();
        async.flushMicrotasks();
        async.elapse(const Duration(milliseconds: 1500));
        app.lifecycle.show();
        async.flushMicrotasks();
        expect(app.requests('POST', '/proxy/agency/sessions/sess-1/available'), hasLength(1));
        expect(app.socket.closed, isFalse);
        final asked = app.requests('POST', _breakPath).length;
        async.elapse(const Duration(seconds: 30));
        expect(app.requests('POST', _breakPath), hasLength(asked), reason: 'back: no more asks');
        app.dispose();
      });
    });

    test('back after a pause that landed: nothing is re-asserted (the agent resumes from the Away card)', () {
      fakeAsync((async) {
        final app = App(async)..start();
        app.readyFrame('available');
        app.agentStateFrame('available');
        app.routes['POST $_breakPath'] = (_) => json(200, stateBody('break', breakReason: 'device_away'));
        app.lifecycle.hide();
        async.flushMicrotasks();
        app.lifecycle.show();
        async.flushMicrotasks();
        expect(app.requests('POST', '/proxy/agency/sessions/sess-1/available'), isEmpty);
        app.dispose();
      });
    });

    test('on a call: the call keeps running, pings continue, the pause is queued and cancelled on return', () {
      fakeAsync((async) {
        final app = App(async)..start();
        app.onCall('att-1');
        app.routes['POST $_breakPath'] = (_) => json(200, stateBody('on_call', breakReason: 'device_away', pending: 'break'));
        app.routes['POST $_breakPath/cancel'] = (_) => json(200, stateBody('on_call'));
        final pings = app.socket.pings.length;
        app.lifecycle.hide();
        async.flushMicrotasks();
        expect(app.requests('POST', _breakPath).single.body, {'reason': 'device_away'});
        expect(app.view!.queuedBreak?.code, 'device_away');
        expect(app.notifier.calls, isNot(contains('paused')));
        app.socket.serverPong();
        async.elapse(const Duration(seconds: 10));
        expect(app.socket.pings.length, greaterThan(pings), reason: 'the call is live: pings continue');
        expect(app.engine.calls, isNot(contains('stop')), reason: 'the audio keeps running');

        app.lifecycle.show();
        async.flushMicrotasks();
        expect(app.requests('POST', '$_breakPath/cancel'), hasLength(1));
        expect(app.view!.queuedBreak, isNull);
        app.dispose();
      });
    });

    test('a pause asked for at once that the server queued (a call came in) is cancelled on return too', () {
      fakeAsync((async) {
        final app = App(async)..start();
        app.readyFrame('available');
        app.agentStateFrame('available');
        final answer = Completer<http.Response>();
        app.routes['POST $_breakPath'] = (_) => answer.future;
        app.routes['POST $_breakPath/cancel'] = (_) => json(200, stateBody('on_call'));
        app.lifecycle.hide();
        async.flushMicrotasks();
        // A call was reserved while the pause was on its way: the server queues it.
        app.reserved('att-1');
        app.agentStateFrame('reserved');
        answer.complete(json(200, stateBody('reserved', breakReason: 'device_away', pending: 'break')));
        async.flushMicrotasks();
        expect(app.view!.queuedBreak?.code, 'device_away');
        app.lifecycle.show();
        async.flushMicrotasks();
        expect(app.requests('POST', '$_breakPath/cancel'), hasLength(1));
        app.dispose();
      });
    });

    test('a queued pause still in flight when the agent comes back is cancelled when it lands', () {
      fakeAsync((async) {
        final app = App(async)..start();
        app.onCall('att-1');
        final answer = Completer<http.Response>();
        app.routes['POST $_breakPath'] = (_) => answer.future;
        app.routes['POST $_breakPath/cancel'] = (_) => json(200, stateBody('on_call'));
        app.lifecycle.hide();
        async.flushMicrotasks();
        app.lifecycle.show();
        async.flushMicrotasks();
        expect(app.requests('POST', '$_breakPath/cancel'), isEmpty, reason: 'nothing queued yet to cancel');
        answer.complete(json(200, stateBody('on_call', breakReason: 'device_away', pending: 'break')));
        async.flushMicrotasks();
        expect(app.requests('POST', '$_breakPath/cancel'), hasLength(1));
        expect(app.view!.queuedBreak, isNull);
        app.dispose();
      });
    });

    test('on a call: a queued pause that failed is asked for again on the next change', () {
      fakeAsync((async) {
        final app = App(async)..start();
        app.onCall('att-1');
        app.routes['POST $_breakPath'] = (_) => json(503, {'message': 'down'});
        app.lifecycle.hide();
        async.flushMicrotasks();
        expect(app.requests('POST', _breakPath), hasLength(1));
        app.routes['POST $_breakPath'] = (_) => json(200, stateBody('wrapup', breakReason: 'device_away', pending: 'break'));
        app.releasedFrame('att-1');
        async.flushMicrotasks();
        expect(app.requests('POST', _breakPath), hasLength(2));
        app.agentStateFrame('wrapup');
        app.wrapupFrame('att-1');
        async.flushMicrotasks();
        expect(app.requests('POST', _breakPath), hasLength(2), reason: 'once it landed, not again');
        app.dispose();
      });
    });

    test('in wrap-up: the deadline notification, on this device’s clock', () {
      fakeAsync((async) {
        final app = App(async)..start();
        app.inWrapup('att-1');
        app.routes['POST $_breakPath'] = (_) => json(200, stateBody('wrapup', breakReason: 'device_away', pending: 'break'));
        app.lifecycle.hide();
        async.flushMicrotasks();
        expect(app.requests('POST', _breakPath), hasLength(1));
        expect(app.notifier.calls.last, 'wrapup:2026-11-01T09:01:00.000Z');
        // The queued pause applies after wrap-up, while still away.
        app.agentStateFrame('break', breakReason: 'device_away');
        expect(app.notifier.calls.last, 'paused');
        app.lifecycle.show();
        expect(app.notifier.calls.last, 'cancel');
        app.dispose();
      });
    });

    test('a queued break of the agent’s own already pauses them: no device_away mid-call', () {
      fakeAsync((async) {
        final app = App(async)..start();
        app.onCall('att-1');
        app.agentStateFrame('on_call', pending: 'break', pendingReason: 'tea');
        app.lifecycle.hide();
        async.flushMicrotasks();
        expect(app.requests('POST', _breakPath), isEmpty);
        app.dispose();
      });
    });

    test('on a break of another reason: nothing is sent', () {
      fakeAsync((async) {
        final app = App(async)..start();
        app.readyFrame('break');
        app.agentStateFrame('break', breakReason: 'tea');
        app.lifecycle.hide();
        async.elapse(const Duration(seconds: 30));
        expect(app.requests('POST', _breakPath), isEmpty);
        expect(app.notifier.calls, isNot(contains('paused')));
        expect(app.view!.onBreak!.isDeviceAway, isFalse);
        app.dispose();
      });
    });

    test('while away, becoming available (a queue that did not hold) pauses again at once', () {
      fakeAsync((async) {
        final app = App(async)..start();
        app.onCall('att-1');
        app.routes['POST $_breakPath'] = (_) => json(200, stateBody('on_call'));
        app.lifecycle.hide();
        async.flushMicrotasks();
        expect(app.requests('POST', _breakPath), hasLength(1));
        app.releasedFrame('att-1', requiresDisposition: false);
        app.agentStateFrame('available', since: '2026-11-01T09:05:00.000Z');
        async.flushMicrotasks();
        expect(app.requests('POST', _breakPath), hasLength(2));
        expect(app.notifier.calls.last, 'paused');
        app.dispose();
      });
    });

    test('offline but joined counts as waiting: paused at once', () {
      fakeAsync((async) {
        final app = App(async)..start();
        app.readyFrame('offline');
        app.lifecycle.hide();
        async.flushMicrotasks();
        expect(app.requests('POST', _breakPath), hasLength(1));
        expect(app.view!.phase, AgentPhase.offline);
        app.dispose();
      });
    });
  });
}
