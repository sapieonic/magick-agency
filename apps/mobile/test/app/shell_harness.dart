import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/misc.dart' show Override;
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:magick_agency_agent/app/router.dart';
import 'package:magick_agency_agent/app/routes.dart';
import 'package:magick_agency_agent/app/shell.dart';
import 'package:magick_agency_agent/app/theme/app_theme.dart';
import 'package:magick_agency_agent/app/theme/tokens.dart';
import 'package:magick_agency_agent/core/auth/app_gate.dart';
import 'package:magick_agency_agent/core/softphone/softphone_view.dart';
import 'package:magick_agency_agent/core/station/station_signals.dart';

import '../core/auth/support/harness.dart';

/// The app's router (its redirect and refresh) and shell over stand-in
/// screens, routed as `router.dart` routes them: the same five branches in the
/// same order, so the shell's branch indexes are the app's.

Widget at(GoRouterState s) => Scaffold(body: Text('at ${s.uri}'));

const ready = GateReady(userId: 'u1', displayName: 'Meera', email: null, tenantId: 't1', accountId: 'a1', accountName: 'Chennai');

class TestGate extends AppGateNotifier {
  @override
  AppGate build() => ready;
  void put(AppGate gate) => state = gate;
}

/// The Phone tab's availability, as the test sets it (hidden by default).
class TestAvailability extends Notifier<SoftphoneAvailability> {
  @override
  SoftphoneAvailability build() => SoftphoneAvailability.hidden;
  void set(SoftphoneAvailability a) => state = a;
}

final testAvailabilityProvider = NotifierProvider<TestAvailability, SoftphoneAvailability>(TestAvailability.new);

const phoneShown = SoftphoneAvailability(visible: true, startAllowed: true, loaded: true);

/// A container with the test's signals, gate and availability, and [extra].
ProviderContainer shellContainer({List<Override> extra = const []}) => ProviderContainer.test(overrides: [
      stationSignalsProvider.overrideWith((ref) => ref.watch(testSignalsProvider)),
      appGateProvider.overrideWith(TestGate.new),
      softphoneAvailabilityProvider.overrideWith((ref) => ref.watch(testAvailabilityProvider)),
      ...extra,
    ]);

Future<GoRouter> pumpShell(WidgetTester tester, ProviderContainer c, {String initial = Routes.home}) async {
  final routerProvider = Provider<GoRouter>(
    (ref) => buildAppRouter(
      ref,
      initialLocation: initial,
      routes: [
        for (final path in [Routes.splash, Routes.signIn, Routes.accounts, Routes.updateRequired, Routes.invitePattern, Routes.preflightPattern])
          GoRoute(path: path, builder: (_, s) => at(s)),
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
            StatefulShellBranch(routes: [GoRoute(path: Routes.phone, builder: (_, s) => at(s))]),
            StatefulShellBranch(routes: [GoRoute(path: Routes.performance, builder: (_, s) => at(s))]),
            StatefulShellBranch(routes: [GoRoute(path: Routes.calls, builder: (_, s) => at(s))]),
            StatefulShellBranch(routes: [GoRoute(path: Routes.me, builder: (_, s) => at(s))]),
          ],
        ),
      ],
    ),
  );
  final router = c.read(routerProvider);
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

/// The tab labels, in order.
List<String> tabLabels(WidgetTester tester) =>
    [for (final d in tester.widgetList<NavigationDestination>(find.byType(NavigationDestination))) d.label];
