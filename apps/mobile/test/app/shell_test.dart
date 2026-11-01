import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:magick_agency_agent/app/app.dart';
import 'package:magick_agency_agent/app/router.dart';
import 'package:magick_agency_agent/app/routes.dart';
import 'package:magick_agency_agent/app/shell.dart';
import 'package:magick_agency_agent/core/auth/app_gate.dart';
import 'package:magick_agency_agent/core/station/station_signals.dart';
import 'package:magick_agency_agent/core/station/station_view.dart';
import 'package:magick_agency_agent/core/station/station_view_mapper.dart';

import '../core/auth/support/harness.dart';
import 'shell_harness.dart';

const available = StationSignals(onDuty: true, campaignId: 'c1');
const onBreak = StationSignals(onDuty: true, onBreak: true, campaignId: 'c1');

void main() {
  late ProviderContainer c;

  setUp(() {
    c = shellContainer();
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

  group('the station rules hold on every route', () {
    const onCall = StationSignals(onDuty: true, callActive: true, campaignId: 'c1');
    final invite = Routes.invite('tok');

    testWidgets('an invite link while on a call opens the call, with the tab bar hidden', (tester) async {
      c.read(testSignalsProvider.notifier).set(onCall);
      final router = await pumpShell(tester, c, initial: Routes.station('c1'));
      router.go(invite);
      await tester.pumpAndSettle();
      expect(find.text('at /home/station/c1'), findsOneWidget);
      expect(find.byType(NavigationBar), findsNothing);
    });

    testWidgets('an invite link while available keeps the agent on the station', (tester) async {
      c.read(testSignalsProvider.notifier).set(available);
      final router = await pumpShell(tester, c, initial: Routes.station('c1'));
      router.go(invite);
      await tester.pumpAndSettle();
      expect(find.text('at /home/station/c1'), findsOneWidget);
    });

    testWidgets('an invite link on a break opens the invitation', (tester) async {
      c.read(testSignalsProvider.notifier).set(onBreak);
      final router = await pumpShell(tester, c, initial: Routes.station('c1'));
      router.go(invite);
      await tester.pumpAndSettle();
      expect(find.text('at /agency/join/tok'), findsOneWidget);
    });

    testWidgets('a call already live when the shell is built: straight to the call', (tester) async {
      c.read(testSignalsProvider.notifier).set(onCall);
      await pumpShell(tester, c);
      expect(find.text('at /home/station/c1'), findsOneWidget);
      expect(find.byType(NavigationBar), findsNothing);
    });

    testWidgets('back to the campaign list while on a call goes back to the call', (tester) async {
      c.read(testSignalsProvider.notifier).set(onCall);
      final router = await pumpShell(tester, c, initial: Routes.station('c1'));
      router.go(Routes.home);
      await tester.pumpAndSettle();
      expect(find.text('at /home/station/c1'), findsOneWidget);
    });

    testWidgets('a call arriving while the agent is on another tab takes the screen', (tester) async {
      c.read(testSignalsProvider.notifier).set(onBreak);
      await pumpShell(tester, c, initial: Routes.performance);
      expect(find.text('at /performance'), findsOneWidget);
      c.read(testSignalsProvider.notifier).set(onCall);
      await tester.pumpAndSettle();
      expect(find.text('at /home/station/c1'), findsOneWidget);
      expect(find.byType(NavigationBar), findsNothing);
    });

    testWidgets('on a break, the Station tab opens the station, not the campaign list', (tester) async {
      c.read(testSignalsProvider.notifier).set(onBreak);
      await pumpShell(tester, c, initial: Routes.me);
      await tester.tap(find.text('Station'));
      await tester.pumpAndSettle();
      expect(find.text('at /home/station/c1'), findsOneWidget);
    });

    testWidgets('pre-flight finishing the join stays open; any other pre-flight does not', (tester) async {
      c.read(testSignalsProvider.notifier).set(const StationSignals());
      final router = await pumpShell(tester, c, initial: Routes.preflight('c1'));
      c.read(testSignalsProvider.notifier).set(available);
      await tester.pumpAndSettle();
      expect(find.text('at /preflight/c1'), findsOneWidget);
      router.go(Routes.preflight('c2'));
      await tester.pumpAndSettle();
      expect(find.text('at /home/station/c1'), findsOneWidget);
    });

    testWidgets('the disabled tabs say why', (tester) async {
      c.read(testSignalsProvider.notifier).set(available);
      await pumpShell(tester, c, initial: Routes.station('c1'));
      expect(find.byTooltip(AppShell.heldReason), findsNWidgets(3));
      c.read(testSignalsProvider.notifier).set(onBreak);
      await tester.pumpAndSettle();
      expect(find.byTooltip(AppShell.heldReason), findsNothing);
    });

    test('appRedirect: the gate\'s own screens come first; the station only once ready', () {
      expect(appRedirect(const GateUpdateRequired(storeUrl: null, minSupported: '9.0.0'), onCall, Routes.home), Routes.updateRequired);
      expect(appRedirect(const GateUpdateRequired(storeUrl: null, minSupported: '9.0.0'), onCall, Routes.updateRequired), isNull);
      expect(appRedirect(const GateSignedOut(), available, Routes.signIn), isNull);
      expect(appRedirect(ready, available, Routes.signIn), Routes.station('c1'));
      expect(appRedirect(ready, available, Routes.station('c1')), isNull);
      expect(appRedirect(ready, onBreak, Routes.me), isNull);
      expect(appRedirect(ready, const StationSignals(), Routes.me), isNull);
      expect(appRedirect(ready, onCall, Routes.preflight('c1')), Routes.station('c1'));
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
