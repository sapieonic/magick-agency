import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:magick_agency_agent/app/app.dart';
import 'package:magick_agency_agent/app/routes.dart';
import 'package:magick_agency_agent/app/shell.dart';
import 'package:magick_agency_agent/app/theme/app_theme.dart';
import 'package:magick_agency_agent/app/theme/tokens.dart';
import 'package:magick_agency_agent/core/station/station_signals.dart';
import 'package:magick_agency_agent/core/station/station_view.dart';
import 'package:magick_agency_agent/core/station/station_view_mapper.dart';

import '../core/auth/support/harness.dart';

const available = StationSignals(onDuty: true, campaignId: 'c1');
const onBreak = StationSignals(onDuty: true, onBreak: true, campaignId: 'c1');

Widget at(GoRouterState s) => Scaffold(body: Text('at ${s.uri}'));

/// The app's shell over stand-in tab screens, routed as `router.dart` routes it.
Future<GoRouter> pumpShell(WidgetTester tester, ProviderContainer c, {String initial = Routes.home}) async {
  final router = GoRouter(
    initialLocation: initial,
    routes: [
      StatefulShellRoute.indexedStack(
        builder: (context, state, shell) => AppShell(shell: shell),
        branches: [
          StatefulShellBranch(routes: [
            GoRoute(
              path: Routes.home,
              builder: (_, s) => at(s),
              routes: [GoRoute(path: 'station/:campaignId', builder: (_, s) => at(s))],
            ),
          ]),
          StatefulShellBranch(routes: [GoRoute(path: Routes.performance, builder: (_, s) => at(s))]),
          StatefulShellBranch(routes: [GoRoute(path: Routes.calls, builder: (_, s) => at(s))]),
          StatefulShellBranch(routes: [GoRoute(path: Routes.me, builder: (_, s) => at(s))]),
        ],
      ),
    ],
  );
  addTearDown(router.dispose);
  await tester.pumpWidget(
    UncontrolledProviderScope(
      container: c,
      child: MaterialApp.router(theme: buildTheme(AppTokens.dark, Brightness.dark), routerConfig: router),
    ),
  );
  await tester.pumpAndSettle();
  return router;
}

bool tabEnabled(WidgetTester tester, String label) =>
    tester.widget<NavigationDestination>(find.widgetWithText(NavigationDestination, label)).enabled;

void main() {
  late ProviderContainer c;

  setUp(() {
    c = ProviderContainer.test(overrides: [stationSignalsProvider.overrideWith((ref) => ref.watch(testSignalsProvider))]);
  });

  group('the tab bar while on duty', () {
    testWidgets('available on the station: the other tabs are disabled and a tap goes nowhere', (tester) async {
      c.read(testSignalsProvider.notifier).set(available);
      await pumpShell(tester, c, initial: Routes.station('c1'));

      expect(tabEnabled(tester, 'Station'), isTrue);
      for (final label in ['Performance', 'My calls', 'Me']) {
        expect(tabEnabled(tester, label), isFalse, reason: label);
      }
      await tester.tap(find.text('Me'), warnIfMissed: false);
      await tester.pumpAndSettle();
      expect(find.text('at /home/station/c1'), findsOneWidget);
    });

    testWidgets('on a break: every tab is open', (tester) async {
      c.read(testSignalsProvider.notifier).set(onBreak);
      await pumpShell(tester, c, initial: Routes.station('c1'));

      for (final label in ['Station', 'Performance', 'My calls', 'Me']) {
        expect(tabEnabled(tester, label), isTrue, reason: label);
      }
      await tester.tap(find.text('Me'));
      await tester.pumpAndSettle();
      expect(find.text('at /me'), findsOneWidget);
    });

    testWidgets('off duty (never joined, or left the station): every tab is open', (tester) async {
      await pumpShell(tester, c);
      for (final label in ['Station', 'Performance', 'My calls', 'Me']) {
        expect(tabEnabled(tester, label), isTrue, reason: label);
      }
    });

    testWidgets('a break ending while on another tab brings the agent back to the station', (tester) async {
      c.read(testSignalsProvider.notifier).set(onBreak);
      await pumpShell(tester, c, initial: Routes.me);
      expect(find.text('at /me'), findsOneWidget);

      c.read(testSignalsProvider.notifier).set(available);
      await tester.pumpAndSettle();
      expect(find.text('at /home/station/c1'), findsOneWidget);
      expect(tabEnabled(tester, 'Me'), isFalse);
    });

    testWidgets('leaving the station frees the tabs again', (tester) async {
      c.read(testSignalsProvider.notifier).set(available);
      await pumpShell(tester, c, initial: Routes.station('c1'));
      expect(tabEnabled(tester, 'Me'), isFalse);

      c.read(testSignalsProvider.notifier).set(const StationSignals());
      await tester.pumpAndSettle();
      expect(tabEnabled(tester, 'Me'), isTrue);
    });
  });

  group('signalsOf', () {
    StationView view(AgentPhase phase, {StationLink link = StationLink.open}) =>
        StationView(campaignId: 'c1', campaignName: 'Q4 Card Renewals', phase: phase, link: link);

    test('available: on duty, not on a break, so the station is held', () {
      final s = signalsOf(view(AgentPhase.available));
      expect((s.onDuty, s.onBreak, s.holdsStation), (true, false, true));
    });

    test('on a break: on duty, and the tabs are free', () {
      final s = signalsOf(view(AgentPhase.onBreak));
      expect((s.onDuty, s.onBreak, s.holdsStation), (true, true, false));
    });

    test('a session the server ended holds nothing', () {
      final s = signalsOf(view(AgentPhase.available, link: StationLink.sessionGone));
      expect(s.holdsStation, isFalse);
    });
  });

  test('themeModeFor: the agent\'s choice, else the phone\'s', () {
    expect(themeModeFor(true), ThemeMode.dark);
    expect(themeModeFor(false), ThemeMode.light);
    expect(themeModeFor(null), ThemeMode.system);
  });
}
