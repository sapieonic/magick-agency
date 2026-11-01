import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:magick_agency_agent/app/routes.dart';
import 'package:magick_agency_agent/app/theme/app_theme.dart';
import 'package:magick_agency_agent/app/theme/tokens.dart';
import 'package:magick_agency_agent/core/station/station_view.dart';
import 'package:magick_agency_agent/features/preflight/preflight_checks.dart';
import 'package:magick_agency_agent/features/preflight/preflight_copy.dart';
import 'package:magick_agency_agent/features/preflight/preflight_screen.dart';

/// Each check is a completer the test resolves when it wants.
class FakeChecks implements PreflightChecks {
  final mic = Completer<MicPermission>();
  final sound = Completer<SoundCheckSample>();
  final route = Completer<AudioRouteSample>();
  final net = Completer<NetworkSample>();
  final bat = Completer<BatterySample>();
  final saver = Completer<BatteryOptimisationSample>();
  MicPermission afterRequest = MicPermission.granted;
  int settingsOpened = 0;
  int runs = 0;

  /// What happened to the voice engine and the station, in order.
  final List<String> log;

  FakeChecks([List<String>? log]) : log = log ?? [];

  void allGood() {
    mic.complete(MicPermission.granted);
    sound.complete(const SoundCheckSample(ran: true, heardBack: true));
    route.complete(const AudioRouteSample(kind: RouteKind.bluetooth, name: 'boAt Airdopes 141'));
    net.complete(const NetworkSample(online: true, transport: '4G', latencyMs: 46, uploadKbps: 1800));
    bat.complete(const BatterySample(level: 34, charging: false));
    saver.complete(const BatteryOptimisationSample(applies: true));
  }

  @override
  Future<MicPermission> microphone() {
    runs++;
    return mic.future;
  }

  @override
  Future<MicPermission> requestMicrophone() async => afterRequest;
  @override
  Future<SoundCheckSample> soundCheck() => sound.future;
  @override
  Future<AudioRouteSample> audioRoute() => route.future;
  @override
  Future<NetworkSample> network() => net.future;
  @override
  Future<BatterySample> battery() => bat.future;
  @override
  Future<BatteryOptimisationSample> batteryOptimisation() => saver.future;
  @override
  Future<void> openAppSettings() async => settingsOpened++;
  @override
  Future<void> requestBatteryExemption() async {}
  @override
  void handOverAudio() => log.add('handOverAudio');
}

class FakeLauncher implements StationLauncher {
  FakeLauncher(this.outcomes, [List<String>? calls]) : calls = calls ?? [];
  final List<StationStart> outcomes;
  final List<String> calls;
  String? lastName;

  StationStart _next() => outcomes.isEmpty ? const StationStarted() : outcomes.removeAt(0);

  @override
  Future<StationStart> start(String campaignId, {required String campaignName}) async {
    calls.add('start:$campaignId');
    lastName = campaignName;
    return _next();
  }

  @override
  Future<StationStart> leaveOtherAndStart(StationElsewhere other, String campaignId, {required String campaignName}) async {
    calls.add('leaveOtherAndStart:${other.campaignId}->$campaignId');
    return _next();
  }

  @override
  Future<StationStart> closeSoftphoneAndStart(StationOnSoftphone softphone, String campaignId, {required String campaignName}) async {
    calls.add('closeSoftphoneAndStart:$campaignId');
    return _next();
  }
}

Future<void> settle(WidgetTester tester) async {
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 500));
}

Future<void> pumpPreflight(
  WidgetTester tester,
  FakeChecks checks,
  StationLauncher launcher, {
  double textScale = 1,
  Size size = const Size(390, 844),
}) async {
  tester.view.devicePixelRatio = 3;
  tester.view.physicalSize = size * 3;
  addTearDown(tester.view.reset);
  final router = GoRouter(
    initialLocation: preflightLocation('c1', 'Q4 Card Renewals'),
    routes: [
      GoRoute(
        path: Routes.preflightPattern,
        builder: (_, s) => PreflightScreen(campaignId: s.pathParameters['campaignId']!),
      ),
      GoRoute(
        path: Routes.home,
        builder: (_, _) => const Scaffold(body: Text('campaigns-home')),
        routes: [
          GoRoute(
            path: 'station/:campaignId',
            builder: (_, s) => Scaffold(body: Text('station-${s.pathParameters['campaignId']}')),
          ),
        ],
      ),
    ],
  );
  addTearDown(router.dispose);
  await tester.pumpWidget(
    ProviderScope(
      overrides: [preflightChecksProvider.overrideWithValue(checks), stationLauncherProvider.overrideWithValue(launcher)],
      child: MaterialApp.router(
        theme: buildTheme(AppTokens.dark, Brightness.dark),
        routerConfig: router,
        builder: (context, child) => MediaQuery(
          data: MediaQuery.of(context).copyWith(textScaler: TextScaler.linear(textScale)),
          child: child!,
        ),
      ),
    ),
  );
  await tester.pump();
}

EmberButtonFinder get goOnDuty => find.byKey(const Key('go-on-duty'));
typedef EmberButtonFinder = Finder;

bool dutyEnabled(WidgetTester tester) =>
    tester.widget<FilledButton>(find.descendant(of: goOnDuty, matching: find.byWidgetPredicate((w) => w is FilledButton))).onPressed !=
    null;

void main() {
  group('grading', () {
    test('network: offline and < 64 kbps up block; slow warns; good is good', () {
      expect(gradeNetwork(const NetworkSample(online: false)).status, CheckStatus.fail);
      final noAnswer = gradeNetwork(const NetworkSample(online: true, transport: '4G', noAnswer: true));
      expect(noAnswer.status, CheckStatus.fail);
      expect(noAnswer.detail, isNot(PreflightCopy.offline));
      expect(noAnswer.detail, startsWith('Too slow for calls'));
      expect(gradeNetwork(const NetworkSample(online: true, latencyMs: 40, uploadKbps: 41)).status, CheckStatus.fail);
      expect(gradeNetwork(const NetworkSample(online: true, latencyMs: 40, uploadKbps: 64)).status, CheckStatus.warn);
      expect(gradeNetwork(const NetworkSample(online: true, latencyMs: 450, uploadKbps: 2000)).status, CheckStatus.warn);
      expect(gradeNetwork(const NetworkSample(online: true, latencyMs: 40)).status, CheckStatus.warn);
      final good = gradeNetwork(const NetworkSample(online: true, transport: '4G', latencyMs: 46, uploadKbps: 1800));
      expect(good.status, CheckStatus.ok);
      expect(good.detail, '4G · 46 ms · 1.8 Mbps up');
    });

    test('microphone: denied blocks with Allow; permanently denied sends to Settings', () {
      expect(gradeMicrophone(MicPermission.granted).status, CheckStatus.ok);
      expect(gradeMicrophone(MicPermission.denied).fix, CheckFix.allowMicrophone);
      expect(gradeMicrophone(MicPermission.permanentlyDenied).fix, CheckFix.openSettings);
      expect(gradeMicrophone(MicPermission.restricted).status, CheckStatus.fail);
    });

    test('battery and battery saver only ever warn; iOS has no saver row', () {
      expect(gradeBattery(const BatterySample(level: 15, charging: false)).status, CheckStatus.warn);
      expect(gradeBattery(const BatterySample(level: 34, charging: false)).detail, 'Plug in for a long shift');
      expect(gradeBattery(const BatterySample(level: 15, charging: true)).status, CheckStatus.ok);
      expect(gradeBattery(const BatterySample(level: 80, charging: false)).status, CheckStatus.ok);
      expect(gradeBatteryOptimisation(const BatteryOptimisationSample(applies: false)), isNull);
      expect(gradeBatteryOptimisation(const BatteryOptimisationSample(applies: true, exempt: false))!.status, CheckStatus.warn);
    });

    test('sound check and headset are advice', () {
      expect(gradeSoundCheck(const SoundCheckSample(ran: true, heardBack: true), micAllowed: false).status, CheckStatus.warn);
      expect(gradeSoundCheck(const SoundCheckSample(ran: true, heardBack: true, quiet: true), micAllowed: true).status, CheckStatus.warn);
      expect(gradeRoute(const AudioRouteSample(kind: RouteKind.earpiece, name: 'Phone')).status, CheckStatus.warn);
    });

    test('duty blocks only on a pending or failed blocking check', () {
      final ok = {for (final c in PreflightCheck.values) c: const CheckResult(status: CheckStatus.ok, title: 't', detail: 'd')};
      expect(dutyBlock(ok), isNull);
      expect(dutyBlock({...ok, PreflightCheck.battery: const CheckResult(status: CheckStatus.warn, title: 't', detail: 'd')}), isNull);
      expect(dutyBlock({...ok, PreflightCheck.headset: const CheckResult(status: CheckStatus.fail, title: 't', detail: 'd')}), isNull);
      expect(dutyBlock({...ok, PreflightCheck.network: const CheckResult.pending('t')}), DutyBlock.checking);
      expect(dutyBlock({...ok, PreflightCheck.microphone: gradeMicrophone(MicPermission.denied)}), DutyBlock.microphone);
      expect(dutyBlock({...ok, PreflightCheck.network: gradeNetwork(const NetworkSample(online: false))}), DutyBlock.network);
      expect(dutyBlock({...ok, PreflightCheck.network: gradeUnavailable(PreflightCheck.network)}), DutyBlock.network);
    });
  });

  group('screen', () {
    testWidgets('rows settle independently; Go on duty waits for the blocking checks only', (tester) async {
      final checks = FakeChecks();
      await pumpPreflight(tester, checks, FakeLauncher([]));
      expect(find.text('Ready to take calls?'), findsOneWidget);
      expect(find.text('Q4 Card Renewals'), findsOneWidget);
      // Five rows checking; the sound check asks the agent to speak while it listens.
      expect(find.text('Checking…'), findsNWidgets(5));
      expect(find.text('Say hello — we’re listening to your mic…'), findsOneWidget);
      expect(dutyEnabled(tester), isFalse);

      checks.bat.complete(const BatterySample(level: 34, charging: false));
      await settle(tester);
      expect(find.text('Battery 34%'), findsOneWidget);
      expect(find.text('Plug in for a long shift'), findsOneWidget);
      expect(find.text('Checking…'), findsNWidgets(4));

      checks.mic.complete(MicPermission.granted);
      checks.net.complete(const NetworkSample(online: true, transport: '4G', latencyMs: 46, uploadKbps: 1800));
      await settle(tester);
      // Warnings and checks still running elsewhere do not hold the button.
      expect(dutyEnabled(tester), isTrue);
      expect(find.text('4G · 46 ms · 1.8 Mbps up'), findsOneWidget);
    });

    testWidgets('a denied microphone blocks, says why, and Allow re-checks', (tester) async {
      final checks = FakeChecks();
      await pumpPreflight(tester, checks, FakeLauncher([]));
      checks.mic.complete(MicPermission.denied);
      checks.net.complete(const NetworkSample(online: true, latencyMs: 40, uploadKbps: 900));
      await settle(tester);
      expect(dutyEnabled(tester), isFalse);
      expect(find.text('Allow the microphone to take calls.'), findsOneWidget);
      await tester.tap(find.text('Allow'));
      await settle(tester);
      expect(checks.runs, 2);
    });

    testWidgets('too little upload blocks; a weak battery only warns', (tester) async {
      final checks = FakeChecks();
      await pumpPreflight(tester, checks, FakeLauncher([]));
      checks.mic.complete(MicPermission.granted);
      checks.net.complete(const NetworkSample(online: true, latencyMs: 40, uploadKbps: 40));
      checks.bat.complete(const BatterySample(level: 9, charging: false));
      await settle(tester);
      expect(dutyEnabled(tester), isFalse);
      expect(find.text('You need a working connection to take calls.'), findsOneWidget);
    });

    testWidgets('a check that hangs times out instead of holding the screen', (tester) async {
      final checks = FakeChecks();
      await pumpPreflight(tester, checks, FakeLauncher([]));
      checks.mic.complete(MicPermission.granted);
      await tester.pump(PreflightScreen.checkTimeout + const Duration(seconds: 1));
      await settle(tester);
      expect(find.text('We couldn’t reach Magick Agency.'), findsOneWidget);
      expect(dutyEnabled(tester), isFalse);
      expect(find.byKey(const Key('check-again')), findsOneWidget);
    });

    testWidgets('started: goes to the station, passing the campaign name', (tester) async {
      final checks = FakeChecks()..allGood();
      final launcher = FakeLauncher([const StationStarted()]);
      await pumpPreflight(tester, checks, launcher);
      await settle(tester);
      await tester.tap(goOnDuty);
      await settle(tester);
      expect(launcher.calls, ['start:c1']);
      expect(launcher.lastName, 'Q4 Card Renewals');
      expect(find.text('station-c1'), findsOneWidget);
    });

    testWidgets('Go on duty while the sound check is still listening waits for it, then hands the engine over', (tester) async {
      final log = <String>[];
      final checks = FakeChecks(log);
      final launcher = FakeLauncher([const StationStarted()], log);
      await pumpPreflight(tester, checks, launcher);
      checks.mic.complete(MicPermission.granted);
      checks.net.complete(const NetworkSample(online: true, transport: '4G', latencyMs: 46, uploadKbps: 1800));
      await settle(tester);
      expect(dutyEnabled(tester), isTrue); // the sound check never blocks on its own

      await tester.tap(goOnDuty);
      await settle(tester);
      // Busy, saying why, and the station not started while the engine is borrowed.
      expect(find.text('Finishing the sound check…'), findsOneWidget);
      expect(dutyEnabled(tester), isFalse);
      expect(log, isEmpty);

      checks.sound.complete(const SoundCheckSample(ran: true, heardBack: true));
      await settle(tester);
      expect(log, ['handOverAudio', 'start:c1']);
      expect(find.text('station-c1'), findsOneWidget);
    });

    testWidgets('a sound check that hangs holds Go on duty only until its deadline', (tester) async {
      final log = <String>[];
      final checks = FakeChecks(log);
      await pumpPreflight(tester, checks, FakeLauncher([const StationStarted()], log));
      checks.mic.complete(MicPermission.granted);
      checks.net.complete(const NetworkSample(online: true, transport: '4G', latencyMs: 46, uploadKbps: 1800));
      await settle(tester);
      await tester.tap(goOnDuty);
      await settle(tester);
      expect(log, isEmpty);
      await tester.pump(PreflightScreen.checkTimeout);
      await settle(tester);
      // Handed over first: the late loopback must leave the station's engine alone.
      expect(log, ['handOverAudio', 'start:c1']);
    });

    testWidgets('elsewhere: offers to leave the other station and join here', (tester) async {
      final checks = FakeChecks()..allGood();
      const other = StationElsewhere(
        sessionId: 's9',
        campaignId: 'c9',
        campaignName: 'Personal Loan Top-up',
        stateLabel: 'Available',
        canLeave: true,
        accountName: 'Acme Chennai',
      );
      final launcher = FakeLauncher([other, const StationStarted()]);
      await pumpPreflight(tester, checks, launcher);
      await settle(tester);
      await tester.tap(goOnDuty);
      await settle(tester);
      expect(find.text('You’re still at another station'), findsOneWidget);
      expect(find.textContaining('You’re joined to Personal Loan Top-up in Acme Chennai — available.'), findsOneWidget);
      await tester.tap(find.byKey(const Key('switch-station')));
      await settle(tester);
      expect(find.text('Leave that station?'), findsOneWidget);
      await tester.tap(find.text('Leave & join here'));
      await settle(tester);
      expect(launcher.calls, ['start:c1', 'leaveOtherAndStart:c9->c1']);
      expect(find.text('station-c1'), findsOneWidget);
    });

    testWidgets('elsewhere mid-call: no switch, finish there first', (tester) async {
      final checks = FakeChecks()..allGood();
      final launcher = FakeLauncher([
        const StationElsewhere(sessionId: 's9', campaignId: 'c9', campaignName: 'Diwali Offers', stateLabel: 'On call', canLeave: false),
      ]);
      await pumpPreflight(tester, checks, launcher);
      await settle(tester);
      await tester.tap(goOnDuty);
      await settle(tester);
      expect(find.byKey(const Key('switch-station')), findsNothing);
      expect(find.textContaining('Finish what you’re doing on Diwali Offers'), findsOneWidget);
    });

    testWidgets('soft phone: closes it and joins when the launcher can', (tester) async {
      final checks = FakeChecks()..allGood();
      final launcher = FakeLauncher([const StationOnSoftphone(sessionId: 'sp1'), const StationStarted()]);
      await pumpPreflight(tester, checks, launcher);
      await settle(tester);
      await tester.tap(goOnDuty);
      await settle(tester);
      expect(find.text('You’re on the soft phone'), findsOneWidget);
      await tester.tap(find.byKey(const Key('close-softphone')));
      await settle(tester);
      expect(launcher.calls, ['start:c1', 'closeSoftphoneAndStart:c1']);
      expect(find.text('station-c1'), findsOneWidget);
    });

    testWidgets('soft phone with an unsettled call: closing is refused in the server\'s words', (tester) async {
      final checks = FakeChecks()..allGood();
      final launcher = FakeLauncher([
        const StationOnSoftphone(sessionId: 'sp1'),
        const StationRefused('Finish the call on the soft phone first.', code: 'call_in_progress'),
      ]);
      await pumpPreflight(tester, checks, launcher);
      await settle(tester);
      await tester.tap(goOnDuty);
      await settle(tester);
      await tester.tap(find.byKey(const Key('close-softphone')));
      await settle(tester);
      expect(launcher.calls, ['start:c1', 'closeSoftphoneAndStart:c1']);
      expect(find.text('Finish the call on the soft phone first.'), findsOneWidget);
      expect(find.text('station-c1'), findsNothing);
    });

    testWidgets('refused: the message and a way back', (tester) async {
      final checks = FakeChecks()..allGood();
      final launcher = FakeLauncher([
        const StationRefused('You aren’t staffed on this campaign. Ask your supervisor.', code: 'not_staffed'),
      ]);
      await pumpPreflight(tester, checks, launcher);
      await settle(tester);
      await tester.tap(goOnDuty);
      await settle(tester);
      expect(find.text('Can’t open the station'), findsOneWidget);
      expect(find.text('You aren’t staffed on this campaign. Ask your supervisor.'), findsOneWidget);
      await tester.tap(find.byKey(const Key('back-to-campaigns')));
      await settle(tester);
      expect(find.text('campaigns-home'), findsOneWidget);
    });

    testWidgets('a launcher that throws reads as a refusal, not a crash', (tester) async {
      final checks = FakeChecks()..allGood();
      await pumpPreflight(tester, checks, _ThrowingLauncher());
      await settle(tester);
      await tester.tap(goOnDuty);
      await settle(tester);
      expect(find.text('Couldn’t open the station. Check your connection and try again.'), findsOneWidget);
    });

    testWidgets('Back while joining does nothing; the join lands on the station', (tester) async {
      tester.view.devicePixelRatio = 3;
      tester.view.physicalSize = const Size(390, 844) * 3;
      addTearDown(tester.view.reset);
      final checks = FakeChecks()..allGood();
      final launcher = _HeldLauncher();
      final router = GoRouter(
        initialLocation: Routes.home,
        routes: [
          GoRoute(
            path: Routes.preflightPattern,
            builder: (_, s) => PreflightScreen(campaignId: s.pathParameters['campaignId']!),
          ),
          GoRoute(
            path: Routes.home,
            builder: (_, _) => const Scaffold(body: Text('campaigns-home')),
            routes: [
              GoRoute(
                path: 'station/:campaignId',
                builder: (_, s) => Scaffold(body: Text('station-${s.pathParameters['campaignId']}')),
              ),
            ],
          ),
        ],
      );
      addTearDown(router.dispose);
      await tester.pumpWidget(
        ProviderScope(
          overrides: [preflightChecksProvider.overrideWithValue(checks), stationLauncherProvider.overrideWithValue(launcher)],
          child: MaterialApp.router(theme: buildTheme(AppTokens.dark, Brightness.dark), routerConfig: router),
        ),
      );
      unawaited(router.push(preflightLocation('c1', 'Q4 Card Renewals')));
      await settle(tester);
      expect(find.byType(BackButton), findsOneWidget);

      await tester.tap(goOnDuty);
      await settle(tester);
      expect(find.text('Joining…'), findsOneWidget);
      // No back arrow while joining, and the system back is held.
      expect(find.byType(BackButton), findsNothing);
      await tester.binding.handlePopRoute();
      await settle(tester);
      expect(find.text('Joining…'), findsOneWidget);
      expect(find.text('campaigns-home'), findsNothing);

      launcher.result.complete(const StationStarted());
      await settle(tester);
      expect(find.text('station-c1'), findsOneWidget);
    });

    testWidgets('200% text on 360×640: no overflow, Go on duty reachable', (tester) async {
      final checks = FakeChecks()..allGood();
      await pumpPreflight(tester, checks, FakeLauncher([]), textScale: 2, size: const Size(360, 640));
      await settle(tester);
      expect(tester.takeException(), isNull);
      final r = tester.getRect(goOnDuty);
      expect(r.bottom, lessThanOrEqualTo(640));
    });
  });
}

/// A launcher whose answer the test gives when it wants.
class _HeldLauncher implements StationLauncher {
  Completer<StationStart> result = Completer<StationStart>();

  @override
  Future<StationStart> start(String campaignId, {required String campaignName}) => result.future;
  @override
  Future<StationStart> leaveOtherAndStart(StationElsewhere other, String campaignId, {required String campaignName}) => result.future;
  @override
  Future<StationStart> closeSoftphoneAndStart(StationOnSoftphone softphone, String campaignId, {required String campaignName}) =>
      result.future;
}

class _ThrowingLauncher implements StationLauncher {
  @override
  Future<StationStart> start(String campaignId, {required String campaignName}) => Future.error(StateError('socket'));
  @override
  Future<StationStart> leaveOtherAndStart(StationElsewhere other, String campaignId, {required String campaignName}) =>
      Future.error(StateError('socket'));
  @override
  Future<StationStart> closeSoftphoneAndStart(StationOnSoftphone softphone, String campaignId, {required String campaignName}) =>
      Future.error(StateError('socket'));
}
