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
import '../telemetry/fake_telemetry_sink.dart';
import 'controller_harness.dart';
import 'station_floor_assist_test.dart' show answered, cleared, helpBody, helpPath, message, raisedAt, raisedInstant;

/// Floor assist's half of LF39 in the station core: Need help on the Phone tab's soft-phone session
/// (the help state on the session seam, where the campaign view is null), the vibration when a
/// supervisor's message arrives, and the telemetry events, each Need help event at most once per
/// request (`raised_at`). The controller is driven only with the frame sequences the server sends
/// (`apps/server/src/agency/floor-assist.ts`): every request that ends sends one `help_cleared`;
/// an answer sends `help_answered` then `help_cleared {answered}`; a cancel that wins sends
/// `help_cleared {cancelled}`, one that loses finds nothing open and answers `help: null`.

const _spHelpPath = '/proxy/agency/sessions/sess-sp/help';

/// The `ready` a soft-phone session's socket sends.
void _spReady(App app, {Map<String, Object?>? extra}) =>
    app.frame({'event': 'ready', 'session_id': 'sess-sp', 'state': 'break', 'break_reason': 'soft_phone', ...?extra});

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
    test('raised once: the repeated frames, a ready restating it and a duplicate help_cleared add nothing', () {
      fakeAsync((async) {
        final app = App(async)..start();
        app.routes['POST $helpPath'] = (_) => json(200, helpBody());
        app.onCall('a1');
        app.run(app.controller.raiseHelp());
        expect(sink.last('agency_help_raised'), {'surface': 'station', 'on_call': true});
        // A reconnect restates it; then the answer, its frames twice, and a stale snapshot.
        app.readyFrame('on_call', extra: {'help': {'raised_at': raisedAt, 'call_id': 'call-1'}});
        app.frame(answered());
        app.frame(answered());
        app.frame(cleared());
        app.frame(cleared());
        app.readyFrame('on_call', extra: {'help': {'raised_at': raisedAt, 'call_id': 'call-1'}});
        app.frame(cleared());
        expect(_help(sink), ['agency_help_raised', 'agency_help_answered']);
        expect(sink.last('agency_help_answered'), {'how': 'listen', 'wait_bucket': 'under_60'});
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

    test('a slow raise reply: answered and cleared first, the reply opens nothing: still the raise, and answered once', () {
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
        app.frame(cleared());
        expect(_help(sink), ['agency_help_answered', 'agency_help_raised']);
        expect(sink.last('agency_help_raised'), {'surface': 'station', 'on_call': true});
        app.dispose();
      });
    });

    test('a slow raise reply after a reconnect\'s ready showed the request: the reply is the raise; the ready never is', () {
      fakeAsync((async) {
        final app = App(async)..start();
        app.routes['POST $helpPath'] = (_) async {
          await Future<void>.delayed(const Duration(seconds: 2));
          return json(200, helpBody());
        };
        app.onCall('a1');
        final pending = app.controller.raiseHelp();
        async.flushMicrotasks();
        app.readyFrame('on_call', extra: {'help': {'raised_at': raisedAt, 'call_id': 'call-1'}});
        expect(_help(sink), isEmpty, reason: 'a ready.help is never a raise');
        async.elapse(const Duration(seconds: 2));
        app.run(pending);
        app.frame(cleared(reason: 'expired'));
        expect(_help(sink), ['agency_help_raised', 'agency_help_expired']);
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
          app.frame(cleared(raised: '2026-11-01T08:57:00.000Z', reason: 'cancelled'));
          expect(_help(sink), ['agency_help_raised', 'agency_help_cancelled'], reason: 'frame first: $frameFirst');
          expect(sink.last('agency_help_cancelled'), {'wait_bucket': '1_5m'}, reason: 'three minutes, on the server\'s clock');
          app.dispose();
        });
        Telemetry.uninstall();
        sink = installFakeTelemetry();
      }
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

    test('answered with no help_answered seen: how unknown; the wait in its bucket', () {
      fakeAsync((async) {
        final app = App(async)..start();
        app.routes['POST $helpPath'] = (_) => json(200, helpBody(raised: '2026-11-01T08:52:00.000Z'));
        app.onCall('a1');
        app.run(app.controller.raiseHelp());
        app.frame(cleared(raised: '2026-11-01T08:52:00.000Z'));
        expect(sink.last('agency_help_answered'), {'how': 'unknown', 'wait_bucket': '5_15m'});
        app.dispose();
      });
    });

    test('nothing for the session ending, a clear about another request, or a clear with nothing held', () {
      fakeAsync((async) {
        final app = App(async)..start();
        app.routes['POST $helpPath'] = (_) => json(200, helpBody());
        app.onCall('a1');
        // Nothing shown, no raise in flight: remembered only.
        app.frame(cleared(raised: '2026-11-01T08:40:00.000Z', reason: 'expired'));
        app.run(app.controller.raiseHelp());
        app.frame(cleared(raised: '2026-11-01T08:40:00.000Z', reason: 'answered'));
        app.frame(answered(raised: '2026-11-01T08:40:00.000Z'));
        app.frame(cleared(reason: 'session_ended'));
        app.frame(cleared(reason: 'answered'));
        expect(_help(sink), ['agency_help_raised'], reason: 'the session_ended clear ended it; a late answered clear is stale');
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
    test('agency_supervisor_message_shown once per id, on_call only: never its text, sender or id', () {
      fakeAsync((async) {
        final app = App(async)..start();
        app.readyFrame('available');
        app.frame(message('m1'));
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

    test('once per id: a resent frame, and Dismiss bringing the next up, do not vibrate again', () {
      fakeAsync((async) {
        final app = App(async)..start();
        app.onCall('a1');
        app.frame(message('m1'));
        async.elapse(const Duration(seconds: 5));
        app.frame(message('m2'));
        expect(app.vibrations, 2, reason: 'on a call too: a vibration, never a sound');
        async.elapse(const Duration(seconds: 5));
        app.frame(message('m1'));
        app.container.read(dismissSupervisorMessageProvider)('m1');
        expect(app.container.read(supervisorMessagesProvider).single.id, 'm2');
        app.container.read(dismissSupervisorMessageProvider)('m2');
        expect(app.vibrations, 2);
        expect(app.engine.chimes, 0, reason: 'no tone');
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

    test('each end once per request, whichever is reported first', () {
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
