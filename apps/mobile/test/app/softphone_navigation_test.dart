import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:magick_agency_agent/app/providers.dart';
import 'package:magick_agency_agent/app/router.dart';
import 'package:magick_agency_agent/app/routes.dart';
import 'package:magick_agency_agent/app/shell.dart';
import 'package:magick_agency_agent/core/api/client_identity.dart';
import 'package:magick_agency_agent/core/auth/firebase_token_source.dart';
import 'package:magick_agency_agent/core/env.dart';
import 'package:magick_agency_agent/core/softphone/softphone_controller.dart';
import 'package:magick_agency_agent/core/softphone/softphone_host.dart';
import 'package:magick_agency_agent/core/softphone/softphone_view.dart';
import 'package:magick_agency_agent/core/station/station_controller.dart';
import 'package:magick_agency_agent/core/station/station_signals.dart';
import 'package:magick_agency_agent/features/missed/missed_access.dart';
import 'package:magick_agency_agent/features/missed/missed_count_controller.dart';
import 'package:magick_agency_agent/features/preflight/preflight_checks.dart';
import 'package:magick_agency_agent/main.dart';

import '../core/auth/support/harness.dart';
import 'shell_harness.dart';

/// The soft phone in the app's navigation: the Phone tab, and the hosted
/// session's hold generalised to both session kinds.

// A soft-phone session (kind `softphone`): always on its `soft_phone` break.
const spIdle = StationSignals(onDuty: true, onBreak: true, sessionKind: StationSessionKind.softphone);
const spLive = StationSignals(onDuty: true, onBreak: true, sessionKind: StationSessionKind.softphone, callActive: true);
const spOwed = StationSignals(onDuty: true, onBreak: true, sessionKind: StationSessionKind.softphone, outcomeOwed: true);

// A campaign station switched to the soft phone (SP7).
const campSp = StationSignals(onDuty: true, onBreak: true, campaignId: 'c1', onSoftphone: true);
const campSpLive = StationSignals(onDuty: true, onBreak: true, campaignId: 'c1', onSoftphone: true, callActive: true);
const campSpOwed = StationSignals(onDuty: true, onBreak: true, campaignId: 'c1', onSoftphone: true, outcomeOwed: true);

const campAvailable = StationSignals(onDuty: true, campaignId: 'c1');

/// Every route a ready agent can be sent to, an invite link and the gate's own
/// paths included.
final everyRoute = [
  Routes.splash,
  Routes.signIn,
  Routes.accounts,
  Routes.home,
  Routes.phone,
  Routes.performance,
  Routes.calls,
  Routes.me,
  Routes.station('c1'),
  Routes.station('c2'),
  Routes.preflight('c1'),
  Routes.preflight('c2'),
  Routes.myContacts('c1'),
  Routes.myContacts('c2'),
  Routes.invite('tok'),
];

void main() {
  group('the hold, for both session kinds', () {
    for (final (name, signals) in [('live', spLive), ('owed', spOwed)]) {
      test('a soft-phone call $name: every route, an invite included, leads to the Phone tab', () {
        for (final route in everyRoute) {
          for (final visible in [true, false]) {
            expect(
              appRedirect(ready, signals, route, phoneVisible: visible),
              route == Routes.phone ? isNull : Routes.phone,
              reason: '$route (Phone tab visible: $visible)',
            );
          }
        }
      });
    }

    for (final (name, signals) in [('live', campSpLive), ('owed', campSpOwed)]) {
      test('a soft-phone call $name on a campaign station: every route leads to that station, its pre-flight too', () {
        for (final route in everyRoute) {
          expect(
            appRedirect(ready, signals, route, phoneVisible: true),
            route == Routes.station('c1') ? isNull : Routes.station('c1'),
            reason: route,
          );
        }
      });
    }

    test('an idle soft-phone session holds nothing', () {
      for (final route in everyRoute) {
        expect(appRedirect(ready, spIdle, route, phoneVisible: true), gateRedirect(ready, route), reason: route);
      }
      // Even before a state frame has said it is on its break.
      const unconfirmed = StationSignals(onDuty: true, sessionKind: StationSessionKind.softphone);
      for (final route in everyRoute) {
        expect(appRedirect(ready, unconfirmed, route, phoneVisible: true), gateRedirect(ready, route), reason: route);
      }
    });

    test('an idle campaign station on the soft phone holds nothing (it is a break)', () {
      for (final route in everyRoute) {
        expect(appRedirect(ready, campSp, route, phoneVisible: true), gateRedirect(ready, route), reason: route);
      }
    });

    test('available on a campaign: the station holds, Phone included; its own pre-flight stays open', () {
      expect(appRedirect(ready, campAvailable, Routes.phone, phoneVisible: true), Routes.station('c1'));
      expect(appRedirect(ready, campAvailable, Routes.preflight('c1'), phoneVisible: true), isNull);
      expect(appRedirect(ready, campAvailable, Routes.preflight('c2'), phoneVisible: true), Routes.station('c1'));
    });

    test('available on a campaign: its own My contacts stays open, until a call takes the screen', () {
      expect(appRedirect(ready, campAvailable, Routes.myContacts('c1')), isNull);
      // Another campaign's contacts cannot be called from this station.
      expect(appRedirect(ready, campAvailable, Routes.myContacts('c2')), Routes.station('c1'));
      // The call My contacts placed (or any call) takes the agent to the station.
      const ringing = StationSignals(onDuty: true, campaignId: 'c1', callActive: true);
      expect(appRedirect(ready, ringing, Routes.myContacts('c1')), Routes.station('c1'));
      // Off duty, or on a break: the agent moves freely, My contacts included.
      expect(appRedirect(ready, const StationSignals(), Routes.myContacts('c2')), isNull);
      expect(
        appRedirect(ready, const StationSignals(onDuty: true, onBreak: true, campaignId: 'c1'), Routes.myContacts('c2')),
        isNull,
      );
    });

    test('homeRouteOf: the station for a campaign session, the Phone tab for a soft-phone one', () {
      expect(homeRouteOf(campSp), Routes.station('c1'));
      expect(homeRouteOf(spIdle), Routes.phone);
      expect(homeRouteOf(const StationSignals()), isNull);
    });
  });

  group('/phone while the Phone tab is hidden', () {
    test('goes home; stays when shown, or when the soft-phone session lives there', () {
      expect(appRedirect(ready, const StationSignals(), Routes.phone), Routes.home);
      expect(appRedirect(ready, const StationSignals(), Routes.phone, phoneVisible: true), isNull);
      expect(appRedirect(ready, spIdle, Routes.phone), isNull);
      expect(appRedirect(ready, campSp, Routes.phone), Routes.home);
      // Only /phone: the rest of the app is unaffected.
      expect(appRedirect(ready, const StationSignals(), Routes.me), isNull);
    });

    testWidgets('a deep link to /phone opens the campaign list instead', (tester) async {
      final c = shellContainer();
      addTearDown(c.dispose);
      await pumpShell(tester, c, initial: Routes.phone);
      expect(find.text('at /home'), findsOneWidget);
    });

    testWidgets('the tab going away while on it sends the agent home (the router listens to it)', (tester) async {
      final c = shellContainer();
      addTearDown(c.dispose);
      c.read(testAvailabilityProvider.notifier).set(phoneShown);
      await pumpShell(tester, c, initial: Routes.phone);
      expect(find.text('at /phone'), findsOneWidget);

      c.read(testAvailabilityProvider.notifier).set(SoftphoneAvailability.hidden);
      await tester.pumpAndSettle();
      expect(find.text('at /home'), findsOneWidget);
      expect(tabLabels(tester), ['Station', 'Performance', 'My calls', 'Me']);
    });
  });

  group('the tabs', () {
    late ProviderContainer c;
    setUp(() {
      c = shellContainer();
      addTearDown(c.dispose);
    });

    int selected(WidgetTester tester) => tester.widget<NavigationBar>(find.byType(NavigationBar)).selectedIndex;

    test('the branch behind each tab', () {
      expect(shellTabBranches(phone: true), [0, 1, 2, 3, 4]);
      expect(shellTabBranches(phone: false), [0, 2, 3, 4]);
    });

    testWidgets('four tabs while hidden: each opens its own branch, and the selection follows it', (tester) async {
      await pumpShell(tester, c);
      expect(tabLabels(tester), ['Station', 'Performance', 'My calls', 'Me']);

      for (final (label, path, index) in [('Performance', '/performance', 1), ('My calls', '/calls', 2), ('Me', '/me', 3), ('Station', '/home', 0)]) {
        await tester.tap(find.text(label));
        await tester.pumpAndSettle();
        expect(find.text('at $path'), findsOneWidget, reason: label);
        expect(selected(tester), index, reason: label);
      }
    });

    testWidgets('five tabs while shown, Phone second', (tester) async {
      c.read(testAvailabilityProvider.notifier).set(phoneShown);
      await pumpShell(tester, c);
      expect(tabLabels(tester), ['Station', 'Phone', 'Performance', 'My calls', 'Me']);

      for (final (label, path, index) in [('Phone', '/phone', 1), ('Performance', '/performance', 2), ('My calls', '/calls', 3), ('Me', '/me', 4)]) {
        await tester.tap(find.text(label));
        await tester.pumpAndSettle();
        expect(find.text('at $path'), findsOneWidget, reason: label);
        expect(selected(tester), index, reason: label);
      }
    });

    testWidgets('the tab appearing keeps the agent where they are, and the selection on it', (tester) async {
      await pumpShell(tester, c, initial: Routes.me);
      expect(selected(tester), 3);
      c.read(testAvailabilityProvider.notifier).set(phoneShown);
      await tester.pumpAndSettle();
      expect(find.text('at /me'), findsOneWidget);
      expect(selected(tester), 4);
    });

    testWidgets('a soft-phone session keeps its tab even before availability has answered', (tester) async {
      c.read(testSignalsProvider.notifier).set(spIdle);
      await pumpShell(tester, c, initial: Routes.phone);
      expect(find.text('at /phone'), findsOneWidget);
      expect(tabLabels(tester), contains('Phone'));
    });
  });

  group('the shell with a soft-phone session', () {
    late ProviderContainer c;
    setUp(() {
      c = shellContainer()..read(testAvailabilityProvider.notifier).set(phoneShown);
      addTearDown(c.dispose);
    });

    testWidgets('a live call hides the bar and takes the screen from any tab', (tester) async {
      c.read(testSignalsProvider.notifier).set(spIdle);
      await pumpShell(tester, c, initial: Routes.performance);
      expect(find.byType(NavigationBar), findsOneWidget);

      c.read(testSignalsProvider.notifier).set(spLive);
      await tester.pumpAndSettle();
      expect(find.text('at /phone'), findsOneWidget);
      expect(find.byType(NavigationBar), findsNothing);
    });

    testWidgets('an owed outcome: the bar shows, every tab but Phone disabled with the reason, and a tap goes nowhere', (tester) async {
      c.read(testSignalsProvider.notifier).set(spOwed);
      await pumpShell(tester, c, initial: Routes.phone);
      expect(find.byType(NavigationBar), findsOneWidget);
      expect(tabEnabled(tester, 'Phone'), isTrue);
      for (final label in ['Station', 'Performance', 'My calls', 'Me']) {
        expect(tabEnabled(tester, label), isFalse, reason: label);
      }
      expect(find.byTooltip(AppShell.owedReason), findsNWidgets(4));
      expect(AppShell.owedReason, 'Save this call’s outcome to open this');

      await tester.tap(find.text('Me'), warnIfMissed: false);
      await tester.pumpAndSettle();
      expect(find.text('at /phone'), findsOneWidget);
    });

    testWidgets('an invite link while the outcome is owed opens the Phone tab', (tester) async {
      c.read(testSignalsProvider.notifier).set(spOwed);
      final router = await pumpShell(tester, c, initial: Routes.phone);
      router.go(Routes.invite('tok'));
      await tester.pumpAndSettle();
      expect(find.text('at /phone'), findsOneWidget);
    });

    testWidgets('idle: every tab is open, and Station opens the campaign list', (tester) async {
      c.read(testSignalsProvider.notifier).set(spIdle);
      await pumpShell(tester, c, initial: Routes.phone);
      for (final label in ['Station', 'Phone', 'Performance', 'My calls', 'Me']) {
        expect(tabEnabled(tester, label), isTrue, reason: label);
      }
      await tester.tap(find.text('Station'));
      await tester.pumpAndSettle();
      expect(find.text('at /home'), findsOneWidget);
    });

    testWidgets('saving the outcome frees the tabs again', (tester) async {
      c.read(testSignalsProvider.notifier).set(spOwed);
      await pumpShell(tester, c, initial: Routes.phone);
      c.read(testSignalsProvider.notifier).set(spIdle);
      await tester.pumpAndSettle();
      expect(tabEnabled(tester, 'Me'), isTrue);
      expect(find.byTooltip(AppShell.owedReason), findsNothing);
    });
  });

  group('the shell with a campaign station', () {
    late ProviderContainer c;
    setUp(() {
      c = shellContainer()..read(testAvailabilityProvider.notifier).set(phoneShown);
      addTearDown(c.dispose);
    });

    testWidgets('available: Phone is disabled with the held reason, like the other tabs', (tester) async {
      c.read(testSignalsProvider.notifier).set(campAvailable);
      await pumpShell(tester, c, initial: Routes.station('c1'));
      expect(tabEnabled(tester, 'Phone'), isFalse);
      expect(find.byTooltip(AppShell.heldReason), findsNWidgets(4));
      await tester.tap(find.text('Phone'), warnIfMissed: false);
      await tester.pumpAndSettle();
      expect(find.text('at /home/station/c1'), findsOneWidget);
    });

    testWidgets('on the soft phone: the Phone tab opens that station', (tester) async {
      c.read(testSignalsProvider.notifier).set(campSp);
      await pumpShell(tester, c, initial: Routes.me);
      await tester.tap(find.text('Phone'));
      await tester.pumpAndSettle();
      expect(find.text('at /home/station/c1'), findsOneWidget);
    });

    testWidgets('on an ordinary break: the Phone tab opens the Phone screen (which offers the switch)', (tester) async {
      c.read(testSignalsProvider.notifier).set(const StationSignals(onDuty: true, onBreak: true, campaignId: 'c1'));
      await pumpShell(tester, c, initial: Routes.me);
      await tester.tap(find.text('Phone'));
      await tester.pumpAndSettle();
      expect(find.text('at /phone'), findsOneWidget);
    });

    testWidgets('an owed outcome on the station: Station and Phone (both lead there) open, the rest disabled', (tester) async {
      c.read(testSignalsProvider.notifier).set(campSpOwed);
      await pumpShell(tester, c, initial: Routes.me);
      expect(find.text('at /home/station/c1'), findsOneWidget);
      expect(tabEnabled(tester, 'Station'), isTrue);
      expect(tabEnabled(tester, 'Phone'), isTrue);
      for (final label in ['Performance', 'My calls', 'Me']) {
        expect(tabEnabled(tester, label), isFalse, reason: label);
      }
      expect(find.byTooltip(AppShell.owedReason), findsNWidgets(3));
    });

    testWidgets('a soft-phone call live on the station hides the bar; an invite link goes back to it', (tester) async {
      c.read(testSignalsProvider.notifier).set(campSpLive);
      final router = await pumpShell(tester, c, initial: Routes.station('c1'));
      expect(find.byType(NavigationBar), findsNothing);
      router.go(Routes.invite('tok'));
      await tester.pumpAndSettle();
      expect(find.text('at /home/station/c1'), findsOneWidget);
    });
  });

  group('the app wiring (main.dart)', () {
    final overrides = appOverrides(env: Env.fromDefines(), identity: ClientIdentity.test, idTokens: const NoIdTokenSource());
    final origins = {for (final o in overrides) o.origin};

    test('the soft-phone core is plugged in: its view, its actions and the Phone tab’s availability', () {
      for (final o in softphoneOverrides) {
        expect(overrides, contains(same(o)));
      }
      expect(origins, containsAll([softphoneViewProvider, softphoneActionsProvider, softphoneAvailabilityProvider]));
    });

    test('the Missed list’s count is plugged in behind its seam', () {
      for (final o in missedCallsOverrides) {
        expect(overrides, contains(same(o)));
      }
      expect(origins, contains(missedCallsAccessProvider));
    });

    test('the station core hosts the soft phone, and the pre-flight checks the soft phone asks are provided', () {
      for (final o in stationOverrides) {
        expect(overrides, contains(same(o)));
      }
      expect(origins, containsAll([softphoneHostActionsProvider, softphoneHostViewProvider, stationSignalsProvider]));
      expect(origins, contains(preflightChecksProvider));
      expect(origins, containsAll([envProvider, clientIdentityProvider, idTokenSourceProvider]));
    });
  });
}
