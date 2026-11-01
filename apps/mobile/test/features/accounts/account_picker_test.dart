import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:magick_agency_agent/core/auth/app_gate.dart';
import 'package:magick_agency_agent/core/auth/fake_auth_service.dart';
import 'package:magick_agency_agent/core/session/session_store.dart';
import 'package:magick_agency_agent/core/station/station_signals.dart';
import 'package:magick_agency_agent/features/accounts/account_picker_screen.dart';
import 'package:magick_agency_agent/features/accounts/account_switcher.dart';

import '../../core/auth/support/harness.dart';

void main() {
  late Harness h;

  Future<ProviderContainer> started(WidgetTester tester) async {
    final c = ProviderContainer.test(overrides: h.overrides);
    await tester.runAsync(() => startGate(c));
    return c;
  }

  setUp(() {
    h = Harness(auth: FakeAuthService(signedIn: meera));
    h.server.standard(
      memberships: [membershipJson('t1', accountId: 'a1'), membershipJson('t1', accountId: 'a2')],
      accounts: {
        't1': [accountJson('a1', 'Chennai', 't1'), accountJson('a2', 'Pune', 't1')],
      },
    );
  });

  testWidgets('lists the accounts; a tap picks one and remembers it', (tester) async {
    final c = await started(tester);
    await pumpScreen(tester, c, const AccountPickerScreen());
    expect(find.text('Choose an account'), findsOneWidget);
    expect(find.text('Chennai'), findsOneWidget);
    expect(find.text('Pune'), findsOneWidget);
    await tapVisible(tester, find.text('Pune'));
    await tester.pump();
    await tester.pump();
    expect(c.read(appGateProvider), isA<GateReady>().having((g) => g.accountName, 'name', 'Pune'));
    expect(await tester.runAsync(() => SessionStore(h.store).readLastAccount()), const LastAccount(tenantId: 't1', accountId: 'a2'));
  });

  testWidgets('no accounts: says what to do, and Try again reads them again', (tester) async {
    h.server.standard(accounts: {'t1': []});
    final c = await started(tester);
    await pumpScreen(tester, c, const AccountPickerScreen());
    expect(find.text('No account to work in yet'), findsOneWidget);
    h.server.standard();
    await tapVisible(tester, find.text('Try again'));
    await tester.pump();
    await tester.pump();
    expect(c.read(appGateProvider), isA<GateReady>());
  });

  testWidgets('sign out is always there', (tester) async {
    final c = await started(tester);
    await pumpScreen(tester, c, const AccountPickerScreen());
    await tapVisible(tester, find.text('Sign out'));
    await tester.pump();
    await tester.pump();
    expect(c.read(appGateProvider), const GateSignedOut());
  });

  group('switcher sheet', () {
    Future<ProviderContainer> ready(WidgetTester tester) async {
      await tester.runAsync(() => SessionStore(h.store).writeLastAccount(const LastAccount(tenantId: 't1', accountId: 'a1')));
      final c = await started(tester);
      await pumpScreen(
        tester,
        c,
        Builder(builder: (context) => Scaffold(body: TextButton(onPressed: () => showAccountSwitcher(context), child: const Text('open')))),
      );
      await tester.tap(find.text('open'));
      await tester.pumpAndSettle();
      return c;
    }

    testWidgets('switches, and closes', (tester) async {
      final c = await ready(tester);
      expect(find.text('Switch account'), findsOneWidget);
      await tester.tap(find.text('Pune'));
      await tester.pumpAndSettle();
      expect(c.read(appGateProvider), isA<GateReady>().having((g) => g.accountId, 'account', 'a2'));
      expect(find.text('Switch account'), findsNothing);
    });

    testWidgets('on duty: the reason, and no switching', (tester) async {
      final c = await ready(tester);
      c.read(testSignalsProvider.notifier).set(const StationSignals(onDuty: true, campaignId: 'c1'));
      await tester.pumpAndSettle();
      expect(find.text('You’re on duty in this account. Leave the station before switching.'), findsOneWidget);
      await tester.tap(find.text('Pune'));
      await tester.pumpAndSettle();
      expect(c.read(appGateProvider), isA<GateReady>().having((g) => g.accountId, 'account', 'a1'));
    });
  });

  test('switchBlockedReason: a call first, then duty', () {
    expect(switchBlockedReason(const StationSignals()), isNull);
    expect(switchBlockedReason(const StationSignals(onDuty: true, callActive: true)), startsWith('Finish this call first'));
    expect(switchBlockedReason(const StationSignals(onDuty: true)), contains('Leave the station'));
  });
}
