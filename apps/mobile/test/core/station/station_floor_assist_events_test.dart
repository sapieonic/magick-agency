import 'dart:io' show SocketException;

import 'package:fake_async/fake_async.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:magick_agency_agent/core/api/api_error.dart';
import 'package:magick_agency_agent/core/session/local_preferences.dart';
import 'package:magick_agency_agent/core/session/session_store.dart';
import 'package:magick_agency_agent/core/station/station_controller.dart';
import 'package:magick_agency_agent/core/station/station_deps.dart';
import 'package:magick_agency_agent/core/station/station_view.dart';
import 'package:magick_agency_agent/core/telemetry/floor_assist_telemetry.dart';
import 'package:magick_agency_agent/core/telemetry/telemetry.dart';

import '../inbound/inbound_fixtures.dart';
import '../softphone/manual_calls.dart' as mc;
import '../telemetry/fake_telemetry_sink.dart';
import 'controller_harness.dart';
import 'station_floor_assist_test.dart' show answered, cleared, helpBody, helpPath, message, raisedAt, raisedInstant;

/// Floor assist's half of LF39 in the station core: Need help on the Phone tab's soft-phone session
/// (the help state on the session seam, where the campaign view is null), the vibration when a
/// supervisor's message arrives, and the telemetry events (the spec's amendment 2: each raised and
/// end event at most once per request, `raised_at`).
///
/// The controller is driven only with frame orders the server sends
/// (`apps/server/src/agency/floor-assist.ts`): each request that ends sends exactly one
/// `help_cleared`; an answer sends `help_answered` then `help_cleared {answered}`; a cancel that
/// wins sends `help_cleared {cancelled}`, one that loses finds nothing open and answers
/// `help: null`; a raise that finds an older request lapsed expires it and sends its
/// `help_cleared {expired}` before the new request's reply. A frame no socket took is not resent:
/// a reconnect's `ready` states the request (or none), and a frame can be lost with the old socket
/// or land on the new one ahead of `ready`. No frame is sent twice. The once-per-request end
/// memory is reached by every answer (`answered` is sent on `help_answered`, and its
/// `help_cleared {answered}` must not send it again); the raised memory, and a second end of
/// another kind, by no real order: the unit test at the end covers those.

const _spHelpPath = '/proxy/agency/sessions/sess-sp/help';

/// The `ready` a soft-phone session's socket sends.
void _spReady(App app, {Map<String, Object?>? extra}) =>
    app.frame({'event': 'ready', 'session_id': 'sess-sp', 'state': 'break', 'break_reason': 'soft_phone', ...?extra});

/// The socket drops and the station reconnects: a new socket, and its `ready` (the request it
/// states open at [help], or none).
void _reconnect(App app, String state, {String? help}) {
  final first = app.socket;
  first.serverClose(1006);
  app.async.elapse(const Duration(seconds: 5));
  expect(identical(app.socket, first), isFalse, reason: 'reconnected');
  app.readyFrame(state, extra: {if (help != null) 'help': {'raised_at': help, 'call_id': 'call-1'}});
}

/// The soft-phone session's call one step on (`manual_call`).
Map<String, Object?> _spCall(int seconds, Map<String, Object?> over) =>
    mc.manualCallJson({'updated_at': '2026-10-30T10:00:${seconds.toString().padLeft(2, '0')}.000Z', ...over});

/// The help events sent, in order.
List<String> _help(FakeTelemetrySink sink) => [for (final n in sink.names) if (n.startsWith('agency_help_')) n];

void main() {
  late FakeTelemetrySink sink;

  setUp(() => sink = installFakeTelemetry());
  tearDown(Telemetry.uninstall);

  group('Need help on the Phone tab (a soft-phone session)', () {
    test('no campaign view, so the help state is on the session seam: raised, answered, told, dismissed', () {
      fakeAsync((async) {
        final app = App(async)..openSoftphone();
        _spReady(app);
        app.routes['POST $_spHelpPath'] = (_) => json(200, {'session_id': 'sess-sp', 'help': {'raised_at': raisedAt, 'call_id': null}});
        expect(app.view, isNull, reason: 'stationViewProvider is null for a soft-phone session');
        expect(app.container.read(sessionHelpProvider), const HelpView());
        expect(app.container.read(sessionHelpActionsProvider), same(app.controller));

        app.run(app.container.read(sessionHelpActionsProvider).raiseHelp());
        expect(app.requests('POST', _spHelpPath), hasLength(1));
        final open = app.container.read(sessionHelpProvider);
        expect([open.stage, open.raisedAt], [HelpStage.open, raisedInstant]);

        app.frame(answered(how: 'message'));
        app.frame(cleared());
        expect(app.container.read(sessionHelpProvider),
            const HelpView(notice: 'Anitha N answered with a message.', noticeTone: HelpNoticeTone.success));
        app.controller.dismissHelpNotice();
        expect(app.container.read(sessionHelpProvider), const HelpView());
        expect(app.view, isNull);

        expect(_help(sink), ['agency_help_raised', 'agency_help_answered']);
        expect(sink.last('agency_help_raised'), {'surface': 'softphone', 'on_call': false});
        expect(sink.last('agency_help_answered'), {'how': 'message', 'wait_bucket': 'under_60'});
        app.dispose();
      });
    });

    test('a soft-phone session\'s ready.help restores the request there after a reconnect, and its cancel', () {
      fakeAsync((async) {
        final app = App(async)..openSoftphone();
        _spReady(app, extra: {'help': {'raised_at': raisedAt, 'call_id': null}});
        expect(app.container.read(sessionHelpProvider).stage, HelpStage.open);
        app.routes['DELETE $_spHelpPath'] = (_) => json(200, {'session_id': 'sess-sp', 'help': null});
        app.run(app.controller.cancelHelp());
        app.frame(cleared(reason: 'cancelled'));
        expect(app.container.read(sessionHelpProvider), const HelpView());
        expect(_help(sink), ['agency_help_cancelled'], reason: 'a ready.help restating a request is not a raise');
        app.dispose();
      });
    });

    test('on the campaign station the session seam is the campaign view\'s help', () {
      fakeAsync((async) {
        final app = App(async)..start();
        app.routes['POST $helpPath'] = (_) => json(200, helpBody());
        app.onCall('a1');
        app.run(app.controller.raiseHelp());
        expect(app.container.read(sessionHelpProvider), app.view!.help);
        expect(app.container.read(sessionHelpProvider).stage, HelpStage.open);
        app.dispose();
      });
    });
  });

  group('the Need help events', () {
    test('raised once, ended once: a reconnect restating the request, then its answer (help_answered, help_cleared)', () {
      fakeAsync((async) {
        final app = App(async)..start();
        app.routes['POST $helpPath'] = (_) => json(200, helpBody());
        app.onCall('a1');
        app.run(app.controller.raiseHelp());
        expect(sink.last('agency_help_raised'), {'surface': 'station', 'on_call': true});
        _reconnect(app, 'on_call', help: raisedAt);
        expect(app.view!.help.stage, HelpStage.open);
        app.frame(answered());
        expect(_help(sink), ['agency_help_raised', 'agency_help_answered'], reason: 'sent on help_answered');
        app.frame(cleared());
        _reconnect(app, 'on_call');
        expect(_help(sink), ['agency_help_raised', 'agency_help_answered'], reason: 'its help_cleared sends nothing more');
        expect(sink.last('agency_help_answered'), {'how': 'listen', 'wait_bucket': 'under_60'});
        app.dispose();
      });
    });

    test('help_answered, then the socket drops before its help_cleared and the reconnect\'s ready has none: answered', () {
      fakeAsync((async) {
        final app = App(async)..start();
        app.routes['POST $helpPath'] = (_) => json(200, helpBody());
        app.onCall('a1');
        app.run(app.controller.raiseHelp());
        app.frame(answered(how: 'message'));
        _reconnect(app, 'on_call');
        expect(app.view!.help.stage, HelpStage.none);
        expect(_help(sink), ['agency_help_raised', 'agency_help_answered']);
        expect(sink.last('agency_help_answered'), {'how': 'message', 'wait_bucket': 'under_60'});
        app.dispose();
      });
    });

    test('a raise whose reply was lost, pressed again: the server answers with the request it opened: one raise', () {
      fakeAsync((async) {
        final app = App(async)..start();
        app.onCall('a1');
        app.routes['POST $helpPath'] = (_) => throw const SocketException('offline');
        app.run(app.controller.raiseHelp());
        app.routes['POST $helpPath'] = (_) => json(200, helpBody());
        app.run(app.controller.raiseHelp());
        app.frame(cleared(reason: 'expired'));
        expect(_help(sink), ['agency_help_refused', 'agency_help_raised', 'agency_help_expired']);
        app.dispose();
      });
    });

    test('a raise whose reply failed is not in flight: the frames about the request it opened send nothing', () {
      fakeAsync((async) {
        final app = App(async)..start();
        app.onCall('a1');
        // The proxy failed the reply; the server had opened the request all the same.
        app.routes['POST $helpPath'] = (_) => json(502, {'error': 'Bad Gateway', 'message': ''});
        app.run(app.controller.raiseHelp());
        app.frame(answered());
        app.frame(cleared());
        expect(_help(sink), ['agency_help_refused']);
        app.dispose();
      });
    });

    test('off a call on the waiting screen: on_call false; in wrap-up: on_call true', () {
      fakeAsync((async) {
        final app = App(async)..start();
        app.readyFrame('available');
        app.routes['POST $helpPath'] = (_) => json(200, helpBody());
        app.run(app.controller.raiseHelp());
        expect(sink.last('agency_help_raised'), {'surface': 'station', 'on_call': false});
        app.frame(cleared(reason: 'expired'));
        app.inWrapup('a1');
        app.routes['POST $helpPath'] = (_) => json(200, helpBody(raised: '2026-11-01T09:01:00.000Z'));
        app.run(app.controller.raiseHelp());
        expect(sink.last('agency_help_raised'), {'surface': 'station', 'on_call': true});
        expect(_help(sink), ['agency_help_raised', 'agency_help_expired', 'agency_help_raised']);
        app.dispose();
      });
    });

    test('the Phone tab: dialling and ringing are not on a call; connected and owing the outcome are', () {
      fakeAsync((async) {
        final app = App(async)..openSoftphone();
        _spReady(app);
        var n = 0;
        app.routes['POST $_spHelpPath'] = (_) =>
            json(200, {'session_id': 'sess-sp', 'help': {'raised_at': '2026-11-01T09:0$n:00.000Z', 'call_id': 'mc-1'}});
        // Raise on each step of the call, the request expiring before the next.
        bool onCallAt(Map<String, Object?> call) {
          app.manualCallFrame(call);
          app.run(app.controller.raiseHelp());
          final at = '2026-11-01T09:0$n:00.000Z';
          n++;
          app.frame(cleared(raised: at, reason: 'expired'));
          return sink.last('agency_help_raised')['on_call']! as bool;
        }

        expect(onCallAt(_spCall(1, {'state': 'dialing'})), isFalse, reason: 'dialling');
        expect(onCallAt(_spCall(2, {'state': 'ringing'})), isFalse, reason: 'ringing');
        app.frame(message('m-ringing'));
        expect(sink.last('agency_supervisor_message_shown'), {'on_call': false});
        expect(onCallAt(_spCall(5, {'state': 'bridged', 'answered_at': '2026-10-30T10:00:04.000Z', 'bridged_at': '2026-10-30T10:00:05.000Z'})),
            isTrue, reason: 'connected');
        expect(
          onCallAt(_spCall(40, {
            'state': 'ended',
            'end_reason': 'remote_hangup',
            'answered_at': '2026-10-30T10:00:04.000Z',
            'bridged_at': '2026-10-30T10:00:05.000Z',
            'ended_at': '2026-10-30T10:00:40.000Z',
            'requires_disposition': true,
            'outcome_due_at': '2026-11-01T09:30:00.000Z',
          })),
          isTrue,
          reason: 'owing its outcome',
        );
        expect(sink.last('agency_help_raised')['surface'], 'softphone');
        app.dispose();
      });
    });

    test('surface: an inbound call on screen, and the station switched to the soft phone', () {
      fakeAsync((async) {
        final app = App(async)..start();
        app.readyFrame('available');
        for (final (:step, :frame) in realInboundCallFrames()) {
          app.frame(frame);
          if (step == 'connected') break;
        }
        app.routes['POST $helpPath'] = (_) => json(200, helpBody());
        app.run(app.controller.raiseHelp());
        expect(sink.last('agency_help_raised'), {'surface': 'inbound', 'on_call': true});
        app.dispose();
      });
      fakeAsync((async) {
        final app = App(async)..start();
        app.readyFrame('available');
        app.agentStateFrame('break', breakReason: 'soft_phone');
        app.routes['POST $helpPath'] = (_) => json(200, helpBody());
        app.run(app.controller.raiseHelp());
        expect(sink.last('agency_help_raised'), {'surface': 'softphone', 'on_call': false});
        app.dispose();
      });
    });

    test('a slow raise reply: answered and cleared first, the reply opens nothing: answered, then still the raise', () {
      fakeAsync((async) {
        final app = App(async)..start();
        app.routes['POST $helpPath'] = (_) async {
          await Future<void>.delayed(const Duration(seconds: 2));
          return json(200, helpBody());
        };
        app.onCall('a1');
        final pending = app.controller.raiseHelp();
        async.flushMicrotasks();
        app.frame(answered());
        app.frame(cleared());
        async.elapse(const Duration(seconds: 2));
        app.run(pending);
        expect(_help(sink), ['agency_help_answered', 'agency_help_raised']);
        expect(sink.last('agency_help_raised'), {'surface': 'station', 'on_call': true});
        app.dispose();
      });
    });

    test('a slow raise reply after a reconnect\'s ready showed the request: the reply is the raise; the ready never is', () {
      fakeAsync((async) {
        final app = App(async)..start();
        app.routes['POST $helpPath'] = (_) async {
          await Future<void>.delayed(const Duration(seconds: 6));
          return json(200, helpBody());
        };
        app.onCall('a1');
        final pending = app.controller.raiseHelp();
        async.flushMicrotasks();
        _reconnect(app, 'on_call', help: raisedAt);
        expect(_help(sink), isEmpty, reason: 'a ready.help is never a raise');
        async.elapse(const Duration(seconds: 1));
        app.run(pending);
        app.frame(cleared(reason: 'expired'));
        expect(_help(sink), ['agency_help_raised', 'agency_help_expired']);
        app.dispose();
      });
    });

    test('an older request\'s expiry sent ahead of a new raise\'s reply: only the raise, and no expiry notice for it', () {
      // The server (floor-assist.ts, raise) expires an older open request in the raise's own
      // statement and sends its help_cleared {expired} before the new request's reply.
      fakeAsync((async) {
        final app = App(async)..start();
        const older = '2026-11-01T08:40:00.000Z';
        const newer = '2026-11-01T09:00:30.000Z';
        // A relaunch onto a request already open (A): shown, never a raise.
        app.readyFrame('on_call', extra: {'help': {'raised_at': older, 'call_id': 'call-1'}});
        expect(app.view!.help.stage, HelpStage.open);
        // The socket drops; A lapses meanwhile; the reconnect's ready has none.
        _reconnect(app, 'on_call');
        expect(app.view!.help, const HelpView());
        app.routes['POST $helpPath'] = (_) async {
          await Future<void>.delayed(const Duration(seconds: 1));
          return json(200, helpBody(raised: newer));
        };
        final pending = app.controller.raiseHelp();
        async.flushMicrotasks();
        app.frame(cleared(raised: older, reason: 'expired'));
        expect([app.view!.help.stage, app.view!.help.notice], [HelpStage.raising, null], reason: 'no expiry notice for A');
        async.elapse(const Duration(seconds: 1));
        app.run(pending);
        expect([app.view!.help.stage, app.view!.help.notice], [HelpStage.open, null]);
        expect(_help(sink), ['agency_help_raised']);
        app.dispose();
      });
    });

    test('a request that lapsed before this run saw it, expired by the raise ahead of the new reply: nothing for it, no notice', () {
      // A relaunch: the ready says none open (A lapsed, unswept); the raise expires A in its own
      // statement and sends A's help_cleared {expired} before B's reply (floor-assist.ts, raise).
      fakeAsync((async) {
        final app = App(async)..start();
        app.onCall('a1');
        const lapsed = '2026-11-01T08:44:50.000Z';
        app.routes['POST $helpPath'] = (_) async {
          await Future<void>.delayed(const Duration(seconds: 1));
          return json(200, helpBody());
        };
        final pending = app.controller.raiseHelp();
        async.flushMicrotasks();
        app.frame(cleared(raised: lapsed, reason: 'expired'));
        expect([app.view!.help.stage, app.view!.help.notice], [HelpStage.raising, null], reason: 'no expiry notice for A');
        async.elapse(const Duration(seconds: 1));
        app.run(pending);
        expect([app.view!.help.stage, app.view!.help.raisedAt, app.view!.help.notice], [HelpStage.open, raisedInstant, null]);
        expect(_help(sink), ['agency_help_raised']);
        app.dispose();
      });
    });

    test('wait_bucket is on the server-aligned clock, not this phone\'s', () {
      fakeAsync((async) {
        final app = App(async)..start();
        // The server runs 5 minutes behind this phone: a request raised as the agent pressed reads
        // over 5 minutes old on the phone's clock, and moments old on the server's.
        app.socket.serverPong(serverOffsetMs: -5 * 60 * 1000);
        app.onCall('a1');
        app.routes['POST $helpPath'] = (_) => json(200, helpBody(raised: '2026-11-01T08:55:00.000Z'));
        app.run(app.controller.raiseHelp());
        app.frame(answered(raised: '2026-11-01T08:55:00.000Z'));
        app.frame(cleared(raised: '2026-11-01T08:55:00.000Z'));
        expect(sink.last('agency_help_answered'), {'how': 'listen', 'wait_bucket': 'under_60'}, reason: 'on help_answered');
        app.routes['POST $helpPath'] = (_) => json(200, helpBody(raised: '2026-11-01T08:55:01.000Z'));
        app.routes['DELETE $helpPath'] = (_) => json(200, {'session_id': 'sess-1', 'help': null});
        app.run(app.controller.raiseHelp());
        app.run(app.controller.cancelHelp());
        app.frame(cleared(raised: '2026-11-01T08:55:01.000Z', reason: 'cancelled'));
        expect(sink.last('agency_help_cancelled'), {'wait_bucket': 'under_60'}, reason: 'on help_cleared');
        app.dispose();
      });
    });

    test('an inbound call offered (ringing) is not on a call; connected it is: raised and message_shown alike', () {
      fakeAsync((async) {
        final app = App(async)..start();
        app.readyFrame('available');
        final frames = realInboundCallFrames();
        var i = 0;
        void until(String step) {
          while (true) {
            final f = frames[i++];
            app.frame(f.frame);
            if (f.step == step) return;
          }
        }

        until('offered');
        app.routes['POST $helpPath'] = (_) => json(200, helpBody());
        app.run(app.controller.raiseHelp());
        expect(sink.last('agency_help_raised'), {'surface': 'inbound', 'on_call': false});
        app.frame(message('m-offered'));
        expect(sink.last('agency_supervisor_message_shown'), {'on_call': false});
        app.frame(cleared(reason: 'expired'));
        until('connected');
        app.routes['POST $helpPath'] = (_) => json(200, helpBody(raised: '2026-11-01T09:01:00.000Z'));
        app.run(app.controller.raiseHelp());
        expect(sink.last('agency_help_raised'), {'surface': 'inbound', 'on_call': true});
        app.frame(message('m-connected'));
        expect(sink.last('agency_supervisor_message_shown'), {'on_call': true});
        app.dispose();
      });
    });

    test('the press on the server-aligned clock: with the phone 5 minutes ahead, the frames for the raise\'s own request before its reply count', () {
      fakeAsync((async) {
        final app = App(async)..start();
        // The server runs 5 minutes behind this phone; the request is stamped as the agent pressed.
        app.socket.serverPong(serverOffsetMs: -5 * 60 * 1000);
        app.onCall('a1');
        const own = '2026-11-01T08:55:00.000Z';
        app.routes['POST $helpPath'] = (_) async {
          await Future<void>.delayed(const Duration(seconds: 1));
          return json(200, helpBody(raised: own));
        };
        final pending = app.controller.raiseHelp();
        async.flushMicrotasks();
        app.frame(answered(raised: own));
        app.frame(cleared(raised: own));
        expect(app.view!.help.notice, 'Anitha N is listening to your call.');
        async.elapse(const Duration(seconds: 1));
        app.run(pending);
        expect(_help(sink), ['agency_help_answered', 'agency_help_raised']);
        expect(sink.last('agency_help_answered'), {'how': 'listen', 'wait_bucket': 'under_60'});
        app.dispose();
      });
    });

    test('every request cancelled this session stays in scope: an earlier one\'s late help_cleared {cancelled} still counts', () {
      fakeAsync((async) {
        final app = App(async)..start();
        app.onCall('a1');
        const r1 = '2026-11-01T09:00:20.000Z';
        const r2 = '2026-11-01T09:00:40.000Z';
        app.routes['DELETE $helpPath'] = (_) => json(200, {'session_id': 'sess-1', 'help': null});
        app.routes['POST $helpPath'] = (_) => json(200, helpBody(raised: r1));
        app.run(app.controller.raiseHelp());
        app.run(app.controller.cancelHelp());
        app.routes['POST $helpPath'] = (_) => json(200, helpBody(raised: r2));
        app.run(app.controller.raiseHelp());
        app.run(app.controller.cancelHelp());
        // The socket is slower than the replies: both clears land after both cancels answered.
        app.frame(cleared(raised: r1, reason: 'cancelled'));
        app.frame(cleared(raised: r2, reason: 'cancelled'));
        expect(_help(sink), ['agency_help_raised', 'agency_help_raised', 'agency_help_cancelled', 'agency_help_cancelled']);
        app.dispose();
      });
    });

    test('a 2xx raise or cancel reply this build cannot read: refused, other; the screen as before', () {
      fakeAsync((async) {
        final app = App(async)..start();
        app.onCall('a1');
        app.routes['POST $helpPath'] = (_) => json(200, 'accepted');
        app.run(app.controller.raiseHelp());
        expect(sink.last('agency_help_refused'), {'action': 'raise', 'code': 'other'});
        expect(app.view!.help, const HelpView(), reason: 'nothing opened, nothing said: the next ready restates it');
        app.routes['POST $helpPath'] = (_) => json(200, helpBody());
        app.run(app.controller.raiseHelp());
        app.routes['DELETE $helpPath'] = (_) => json(200, 'done');
        app.run(app.controller.cancelHelp());
        expect(sink.last('agency_help_refused'), {'action': 'cancel', 'code': 'other'});
        expect(app.view!.help, const HelpView(), reason: 'taken as help: null, as before');
        expect(_help(sink), ['agency_help_refused', 'agency_help_raised', 'agency_help_refused']);
        app.dispose();
      });
    });

    test('no sign-in token offline (Firebase cannot mint): refused, network', () {
      fakeAsync((async) {
        final app = App(async)..start();
        app.onCall('a1');
        app.tokens.throws = StateError('network-request-failed');
        app.run(app.controller.raiseHelp());
        expect(sink.last('agency_help_refused'), {'action': 'raise', 'code': 'network'});
        expect(app.requests('POST', helpPath), isEmpty, reason: 'the request never left');
        app.dispose();
      });
    });

    test('the cancel won: cancelled once, whether its help_cleared lands before or after the reply', () {
      for (final frameFirst in [false, true]) {
        fakeAsync((async) {
          final app = App(async)..start();
          app.routes['POST $helpPath'] = (_) => json(200, helpBody(raised: '2026-11-01T08:57:00.000Z'));
          app.routes['DELETE $helpPath'] = (_) async {
            await Future<void>.delayed(const Duration(seconds: 1));
            return json(200, {'session_id': 'sess-1', 'help': null});
          };
          app.onCall('a1');
          app.run(app.controller.raiseHelp());
          final pending = app.controller.cancelHelp();
          async.flushMicrotasks();
          if (frameFirst) app.frame(cleared(raised: '2026-11-01T08:57:00.000Z', reason: 'cancelled'));
          async.elapse(const Duration(seconds: 1));
          app.run(pending);
          if (!frameFirst) app.frame(cleared(raised: '2026-11-01T08:57:00.000Z', reason: 'cancelled'));
          expect(_help(sink), ['agency_help_raised', 'agency_help_cancelled'], reason: 'frame first: $frameFirst');
          expect(sink.last('agency_help_cancelled'), {'wait_bucket': '1_5m'}, reason: 'three minutes, on the server\'s clock');
          app.dispose();
        });
        Telemetry.uninstall();
        sink = installFakeTelemetry();
      }
    });

    test('a cancel pressed, a reconnect\'s ready clearing the request, its help_cleared {cancelled} before the reply: cancelled', () {
      fakeAsync((async) {
        final app = App(async)..start();
        app.routes['POST $helpPath'] = (_) => json(200, helpBody());
        app.routes['DELETE $helpPath'] = (_) async {
          await Future<void>.delayed(const Duration(seconds: 8));
          return json(200, {'session_id': 'sess-1', 'help': null});
        };
        app.onCall('a1');
        app.run(app.controller.raiseHelp());
        final pending = app.controller.cancelHelp();
        async.flushMicrotasks();
        _reconnect(app, 'on_call');
        expect(app.view!.help.stage, HelpStage.cancelling, reason: 'the cancel is still out');
        app.frame(cleared(reason: 'cancelled'));
        expect(_help(sink), ['agency_help_raised', 'agency_help_cancelled'], reason: 'in scope from the press');
        async.elapse(const Duration(seconds: 3));
        app.run(pending);
        expect(app.view!.help, const HelpView());
        expect(_help(sink), ['agency_help_raised', 'agency_help_cancelled']);
        app.dispose();
      });
    });

    test('a cancel that lost the race, in every order: answered once, never cancelled', () {
      // Where the frames land against the cancel's reply: both before, the answer before, both after.
      for (final order in ['both-before', 'answer-before', 'both-after']) {
        fakeAsync((async) {
          final app = App(async)..start();
          app.routes['POST $helpPath'] = (_) => json(200, helpBody());
          app.routes['DELETE $helpPath'] = (_) async {
            await Future<void>.delayed(const Duration(seconds: 1));
            return json(200, {'session_id': 'sess-1', 'help': null});
          };
          app.onCall('a1');
          app.run(app.controller.raiseHelp());
          final pending = app.controller.cancelHelp();
          async.flushMicrotasks();
          if (order != 'both-after') app.frame(answered(how: 'message'));
          if (order == 'both-before') app.frame(cleared());
          async.elapse(const Duration(seconds: 1));
          app.run(pending);
          if (order == 'both-after') app.frame(answered(how: 'message'));
          if (order != 'both-before') app.frame(cleared());
          expect(_help(sink), ['agency_help_raised', 'agency_help_answered'], reason: order);
          expect(sink.last('agency_help_answered'), {'how': 'message', 'wait_bucket': 'under_60'}, reason: order);
          app.dispose();
        });
        Telemetry.uninstall();
        sink = installFakeTelemetry();
      }
    });

    test('help_answered lost with the old socket, help_cleared {answered} ahead of the new ready: how unknown; the wait in its bucket', () {
      fakeAsync((async) {
        final app = App(async)..start();
        app.routes['POST $helpPath'] = (_) => json(200, helpBody(raised: '2026-11-01T08:52:00.000Z'));
        app.onCall('a1');
        app.run(app.controller.raiseHelp());
        final first = app.socket;
        first.serverClose(1006);
        async.elapse(const Duration(seconds: 5));
        expect(identical(app.socket, first), isFalse);
        app.frame(cleared(raised: '2026-11-01T08:52:00.000Z'));
        app.readyFrame('on_call');
        expect(_help(sink), ['agency_help_raised', 'agency_help_answered']);
        expect(sink.last('agency_help_answered'), {'how': 'unknown', 'wait_bucket': '5_15m'});
        app.dispose();
      });
    });

    test('the session ending sends nothing', () {
      fakeAsync((async) {
        final app = App(async)..start();
        app.routes['POST $helpPath'] = (_) => json(200, helpBody());
        app.onCall('a1');
        app.run(app.controller.raiseHelp());
        app.frame(cleared(reason: 'session_ended'));
        expect(app.view!.help, const HelpView());
        expect(_help(sink), ['agency_help_raised']);
        app.dispose();
      });
    });

    test('refusals of the raise and the cancel, each in its closed code', () {
      fakeAsync((async) {
        final app = App(async)..start();
        app.onCall('a1');
        final cases = <(Reply, String)>[
          ((_) => json(403, {'error': 'Forbidden', 'code': 'floor_assist_disabled', 'message': 'x'}), 'floor_assist_disabled'),
          ((_) => json(409, {'error': 'Conflict', 'code': 'help_not_on_call', 'message': 'x'}), 'help_not_on_call'),
          ((_) => json(409, {'error': 'Conflict', 'code': 'session_ended', 'message': 'x'}), 'session_ended'),
          ((_) => json(404, {'error': 'Not Found', 'message': 'Session not found'}), 'not_found'),
          ((_) => json(500, {'error': 'Internal Server Error', 'message': ''}), 'other'),
          ((_) => json(400, {'error': 'Bad Request', 'code': 'account_scope_required', 'message': 'Choose an account.'}), 'other'),
          ((_) => throw const SocketException('offline'), 'network'),
        ];
        for (final (reply, code) in cases) {
          app.routes['POST $helpPath'] = reply;
          app.run(app.controller.raiseHelp());
          expect(sink.last('agency_help_refused'), {'action': 'raise', 'code': code});
        }
        app.routes['POST $helpPath'] = (_) => json(200, helpBody());
        app.run(app.controller.raiseHelp());
        app.routes['DELETE $helpPath'] = (_) => throw const SocketException('offline');
        app.run(app.controller.cancelHelp());
        expect(sink.last('agency_help_refused'), {'action': 'cancel', 'code': 'network'});
        expect(sink.names.where((n) => n == 'agency_help_refused'), hasLength(cases.length + 1));
        app.dispose();
      });
    });
  });

  group('a supervisor\'s message', () {
    // Each id once: the server sends a message once (a frame no socket took is not resent); a resent
    // id is the pure state's to ignore (station_floor_assist_test.dart, "each id once").
    test('agency_supervisor_message_shown per id, on_call only: never its text, sender or id; Dismiss sends nothing', () {
      fakeAsync((async) {
        final app = App(async)..start();
        app.readyFrame('available');
        app.frame(message('m1'));
        expect(sink.last('agency_supervisor_message_shown'), {'on_call': false});
        app.onCall('a1');
        app.frame(message('m2', text: 'Call +919876543210 back', from: 'Ravi K'));
        expect(sink.names.where((n) => n == 'agency_supervisor_message_shown'), hasLength(2));
        expect(sink.last('agency_supervisor_message_shown'), {'on_call': true});
        app.container.read(dismissSupervisorMessageProvider)('m1');
        expect(sink.names.where((n) => n == 'agency_supervisor_message_shown'), hasLength(2));
        app.dispose();
      });
    });

    test('one vibration on arrival, with Vibration on; none with it off', () {
      fakeAsync((async) {
        final app = App(async)..start();
        app.readyFrame('available');
        app.frame(message('m1'));
        expect(app.vibrations, 1);
        async.elapse(StationController.messageBuzzQuiet);
        app.haptics = false;
        app.frame(message('m2'));
        expect(app.vibrations, 1, reason: 'Me → Vibration off');
        expect(app.container.read(supervisorMessagesProvider), hasLength(2), reason: 'still shown');
        app.dispose();
      });
    });

    test('Dismiss bringing the next up does not vibrate again; on a call, a vibration and never a tone', () {
      fakeAsync((async) {
        final app = App(async)..start();
        app.onCall('a1');
        app.frame(message('m1'));
        async.elapse(const Duration(seconds: 5));
        app.frame(message('m2'));
        expect(app.vibrations, 2, reason: 'on a call too: a vibration, never a sound');
        app.container.read(dismissSupervisorMessageProvider)('m1');
        expect(app.container.read(supervisorMessagesProvider).single.id, 'm2');
        app.container.read(dismissSupervisorMessageProvider)('m2');
        expect(app.vibrations, 2);
        expect(app.engine.chimes, 0, reason: 'no tone');
        app.dispose();
      });
    });

    test('a new session starts a new burst: a message just after the last session\'s vibrates', () {
      fakeAsync((async) {
        final app = App(async)..start();
        app.routes['POST /proxy/agency/sessions/sess-1/leave'] = (_) => json(200, stateBody('offline'));
        app.readyFrame('available');
        app.frame(message('m1'));
        app.run(app.controller.leave());
        app.start();
        app.readyFrame('available');
        app.frame(message('m2'));
        expect(app.vibrations, 2, reason: 'within ${StationController.messageBuzzQuiet.inSeconds} s, but another session');
        app.dispose();
      });
    });

    test('a burst (several arriving together) vibrates once; the next after a quiet gap vibrates again', () {
      fakeAsync((async) {
        final app = App(async)..start();
        app.readyFrame('available');
        app.frame(message('m1'));
        async.elapse(const Duration(milliseconds: 300));
        app.frame(message('m2'));
        async.elapse(const Duration(milliseconds: 300));
        app.frame(message('m3'));
        expect(app.vibrations, 1);
        async.elapse(StationController.messageBuzzQuiet);
        app.frame(message('m4'));
        expect(app.vibrations, 2);
        app.dispose();
      });
    });
  });

  group('the vibration seams\' defaults', () {
    testWidgets('one HapticFeedback.vibrate (a vibration, no sound), gated by Me → Vibration as stored', (tester) async {
      final calls = <MethodCall>[];
      tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(SystemChannels.platform, (call) async {
        calls.add(call);
        return null;
      });
      addTearDown(() => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(SystemChannels.platform, null));
      final c = ProviderContainer(overrides: [
        keyValueStoreProvider.overrideWithValue(MemoryStore({LocalPreferencesNotifier.hapticsKey: false})),
      ]);
      addTearDown(c.dispose);
      expect(c.read(stationHapticsProvider)(), isTrue, reason: 'on until the stored answer is read');
      await tester.pump();
      expect(c.read(stationHapticsProvider)(), isFalse);
      c.read(stationVibrateProvider)();
      await tester.pump();
      expect([for (final m in calls) (m.method, m.arguments)], [('HapticFeedback.vibrate', null)]);
      expect(calls.where((m) => m.method == 'SystemSound.play'), isEmpty);
    });
  });

  group('FloorAssistTelemetry', () {
    test('wait buckets as the console\'s secondsInStateBucket', () {
      String b(int s) => FloorAssistTelemetry.waitBucket(Duration(seconds: s));
      expect([b(-3), b(0), b(59), b(60), b(299), b(300), b(899), b(900), b(5000)],
          ['under_60', 'under_60', 'under_60', '1_5m', '1_5m', '5_15m', '5_15m', 'over_15m', 'over_15m']);
    });

    // The once-per-request memories, where no real frame order reaches them in the controller.
    test('each end once per request, whichever is reported first; raised once per request', () {
      final t = FloorAssistTelemetry();
      final at = DateTime.utc(2026, 11, 1, 9);
      t.answered(at, null, now: at);
      t.cancelled(at, now: at);
      t.expired(at);
      t.raised(at, surface: HelpSurface.station, onCall: true);
      t.raised(at, surface: HelpSurface.station, onCall: true);
      expect(sink.names, ['agency_help_answered', 'agency_help_raised']);
      expect(FloorAssistTelemetry.refusalCode(const ApiUnauthorized()), 'other');
    });
  });
}
