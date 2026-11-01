import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:magick_agency_agent/core/auth/app_gate.dart';
import 'package:magick_agency_agent/core/auth/fake_auth_service.dart';
import 'package:magick_agency_agent/core/session/local_preferences.dart';
import 'package:magick_agency_agent/core/session/session_store.dart';
import 'package:magick_agency_agent/core/station/station_signals.dart';
import 'package:magick_agency_agent/core/telemetry/log.dart';
import 'package:magick_agency_agent/features/settings/me_screen.dart';
import 'package:magick_agency_agent/features/settings/notification_preferences.dart';

import '../../core/auth/support/harness.dart';

Map<String, Object?> event(String key, {bool enabled = true, String cadence = 'immediate', String? frequency}) => {
      'key': key,
      'label': key == 'agency.campaign.completed' ? 'Campaign finished' : 'Weekly summary',
      'description': 'When it happens.',
      'category': key.startsWith('agency') ? 'agency' : 'digests',
      'cadence': cadence,
      'channel': 'email',
      'enabled': enabled,
      'frequency': frequency,
      'default_enabled': true,
      'default_frequency': cadence == 'digest' ? 'weekly' : null,
      'is_default': true,
    };

/// The Me list is lazy: lower sections are built once scrolled to.
Future<void> scrollTo(WidgetTester tester, Finder finder) =>
    tester.scrollUntilVisible(finder, 200, scrollable: find.byType(Scrollable).first);

void main() {
  late Harness h;

  Future<ProviderContainer> started(WidgetTester tester) async {
    final c = ProviderContainer.test(overrides: h.overrides);
    await tester.runAsync(() => startGate(c));
    return c;
  }

  setUp(() {
    h = Harness(auth: FakeAuthService(signedIn: meera));
    h.server.json('GET', '/notifications/preferences', {
      'events': [event('agency.campaign.completed')],
    });
    h.server.json('PUT', '/notifications/preferences', {'preferences': <Object?>[]});
  });

  testWidgets('who and where: name, address, account', (tester) async {
    final c = await started(tester);
    await pumpScreen(tester, c, const MeScreen());
    expect(find.text('Meera K'), findsOneWidget);
    expect(find.text('meera.k@acmecollect.in'), findsOneWidget);
    expect(find.text('Chennai'), findsOneWidget);
    expect(find.text('Acme Collections'), findsOneWidget);
    // One account: nothing to switch to.
    expect(find.text('Switch account'), findsNothing);
  });

  testWidgets('several accounts: Switch account opens the switcher', (tester) async {
    h.server.standard(
      memberships: [membershipJson('t1', accountId: 'a1'), membershipJson('t1', accountId: 'a2')],
      accounts: {'t1': [accountJson('a1', 'Chennai', 't1'), accountJson('a2', 'Pune', 't1')]},
    );
    await tester.runAsync(() => SessionStore(h.store).writeLastAccount(const LastAccount(tenantId: 't1', accountId: 'a1')));
    final c = await started(tester);
    await pumpScreen(tester, c, const MeScreen());
    await tapVisible(tester, find.text('Switch account'));
    await tester.pumpAndSettle();
    expect(find.text('Pune'), findsOneWidget);
  });

  testWidgets('an email preference saves at once, as a one-entry patch', (tester) async {
    final c = await started(tester);
    await pumpScreen(tester, c, const MeScreen());
    expect(find.text('Agency dialer'), findsOneWidget);
    expect(find.text('Campaign finished'), findsOneWidget);
    await tapVisible(tester, find.byType(Switch).first);
    await tester.pumpAndSettle();
    final put = h.server.calls('PUT', '/notifications/preferences').single;
    expect(jsonDecode(put.body), {
      'preferences': [
        {'event_key': 'agency.campaign.completed', 'enabled': false, 'channel': 'email'},
      ],
    });
    expect(put.headers['x-tenant-id'], 't1');
    expect(c.read(notificationPreferencesProvider).value!.single.enabled, isFalse);
  });

  testWidgets('a refused save puts the switch back and says why', (tester) async {
    h.server.offline('PUT', '/notifications/preferences');
    final c = await started(tester);
    await pumpScreen(tester, c, const MeScreen());
    await tapVisible(tester, find.byType(Switch).first);
    await tester.pumpAndSettle();
    expect(c.read(notificationPreferencesProvider).value!.single.enabled, isTrue);
    expect(find.byType(SnackBar), findsOneWidget);
  });

  testWidgets('a digest offers its frequency', (tester) async {
    h.server.json('GET', '/notifications/preferences', {
      'events': [event('usage.digest', cadence: 'digest', frequency: 'weekly')],
    });
    final c = await started(tester);
    await pumpScreen(tester, c, const MeScreen());
    expect(find.text('Summaries'), findsOneWidget);
    await tapVisible(tester, find.text('Every day'));
    await tester.pumpAndSettle();
    final body = jsonDecode(h.server.calls('PUT', '/notifications/preferences').single.body) as Map<String, Object?>;
    expect((body['preferences']! as List<Object?>).single, {
      'event_key': 'usage.digest',
      'enabled': true,
      'channel': 'email',
      'frequency': 'daily',
    });
  });

  testWidgets('no events: nothing to configure', (tester) async {
    h.server.json('GET', '/notifications/preferences', {'events': <Object?>[]});
    final c = await started(tester);
    await pumpScreen(tester, c, const MeScreen());
    expect(find.text('Nothing to configure'), findsOneWidget);
  });

  testWidgets('sound and vibration are kept on the phone', (tester) async {
    final c = await started(tester);
    await pumpScreen(tester, c, const MeScreen());
    await scrollTo(tester, find.text('Vibration'));
    await tapVisible(tester, find.text('Vibration'));
    await tester.pumpAndSettle();
    expect(c.read(localPreferencesProvider).haptics, isFalse);
    expect(h.store.values[LocalPreferencesNotifier.hapticsKey], false);
    expect(h.server.calls('PUT', '/notifications/preferences'), isEmpty);
  });

  testWidgets('diagnostics: version, X-Client, and recent logs to the clipboard', (tester) async {
    String? copied;
    tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(SystemChannels.platform, (call) async {
      if (call.method == 'Clipboard.setData') copied = (call.arguments as Map<Object?, Object?>)['text'] as String?;
      return null;
    });
    addTearDown(() => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(SystemChannels.platform, null));
    Log('test').info('call to +91 98400 12345 ended');
    final c = await started(tester);
    await pumpScreen(tester, c, const MeScreen());
    await scrollTo(tester, find.text('Copy recent logs'));
    expect(find.text('1.4.0 (42)'), findsOneWidget);
    expect(find.text(testIdentity.header), findsOneWidget);
    await tapVisible(tester, find.text('Copy recent logs'));
    await tester.pumpAndSettle();
    expect(copied, contains('call to <tel …45> ended'));
    expect(copied, isNot(contains('98400')));
    expect(find.textContaining('log lines'), findsOneWidget);
  });

  testWidgets('sign out asks first, then signs out', (tester) async {
    final c = await started(tester);
    await pumpScreen(tester, c, const MeScreen());
    await scrollTo(tester, find.widgetWithText(OutlinedButton, 'Sign out'));
    await tapVisible(tester, find.widgetWithText(OutlinedButton, 'Sign out'));
    await tester.pumpAndSettle();
    expect(find.text('Sign out?'), findsOneWidget);
    await tester.tap(find.widgetWithText(TextButton, 'Cancel'));
    await tester.pumpAndSettle();
    expect(c.read(appGateProvider), isA<GateReady>());
    await tapVisible(tester, find.widgetWithText(OutlinedButton, 'Sign out'));
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(TextButton, 'Sign out'));
    await tester.pumpAndSettle();
    expect(c.read(appGateProvider), const GateSignedOut());
  });

  testWidgets('sign out is blocked on duty, with the reason', (tester) async {
    final c = await started(tester);
    c.read(testSignalsProvider.notifier).set(const StationSignals(onDuty: true, campaignId: 'c1'));
    await pumpScreen(tester, c, const MeScreen());
    await scrollTo(tester, find.widgetWithText(OutlinedButton, 'Sign out'));
    final button = tester.widget<OutlinedButton>(find.widgetWithText(OutlinedButton, 'Sign out'));
    expect(button.onPressed, isNull);
    expect(find.text('You’re still on duty — leave the station first, or a call could be sent to an empty screen.'), findsOneWidget);
  });

  test('signOutBlockedReason: the call wording wins over the duty wording', () {
    expect(signOutBlockedReason(const StationSignals()), isNull);
    expect(signOutBlockedReason(const StationSignals(onDuty: true, callActive: true)),
        'Finish this call first — this call is still on your screen.');
  });

  test('categoryLabel: known names, else title-cased', () {
    expect(categoryLabel('agency'), 'Agency dialer');
    expect(categoryLabel('team_updates'), 'Team updates');
  });
}
