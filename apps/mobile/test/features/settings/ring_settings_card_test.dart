import 'dart:convert';

import 'package:agency_wire/agency_wire.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:magick_agency_agent/app/providers.dart';
import 'package:magick_agency_agent/app/theme/app_theme.dart';
import 'package:magick_agency_agent/app/theme/tokens.dart';
import 'package:magick_agency_agent/core/api/api_client.dart';
import 'package:magick_agency_agent/core/api/client_identity.dart';
import 'package:magick_agency_agent/core/auth/app_gate.dart';
import 'package:magick_agency_agent/core/ring/ring_channel.dart';
import 'package:magick_agency_agent/core/ring/ring_overrides.dart';
import 'package:magick_agency_agent/core/ring/ring_registration.dart';
import 'package:magick_agency_agent/core/session/session_store.dart';
import 'package:magick_agency_agent/core/station/station_device.dart';
import 'package:magick_agency_agent/features/settings/ring_settings_card.dart';

import '../../core/inbound/inbound_fixtures.dart' show pushSample;
import '../../core/ring/fake_ring_channel.dart';
import '../../core/ring/ring_harness.dart' show RingGate, devicePath, ready, ringDeviceId;
import '../../core/station/controller_harness.dart' show FakeLifecycle, FakeTokens, testEnv;

/// Me → Inbound calls (Mode B): shown only where the account allows ringing; the toggle, the
/// checklist with its fixes, the miss rule and the test ring.
void main() {
  late FakeRingChannel channel;
  late Map<String, Object?> status;
  late List<http.Request> requests;

  /// The device routes answer 503 while true.
  var failStatus = false;

  /// The device routes answer after a second while true.
  var slow = false;

  setUp(() {
    failStatus = false;
    slow = false;
    channel = FakeRingChannel();
    status = pushSample('device_status_ringing');
    requests = [];
  });

  /// [platform]: the ringing platform (null: one that does not ring, read for its status only,
  /// as iOS).
  Future<void> pump(WidgetTester tester, {PushPlatform? platform = PushPlatform.android, bool statusOnly = false, bool settle = true}) async {
    final client = MockClient((request) async {
      requests.add(request);
      final key = '${request.method} ${request.url.path}';
      if (slow) await Future<void>.delayed(const Duration(seconds: 1));
      if (failStatus) return http.Response('{"error":"Service Unavailable"}', 503, headers: {'content-type': 'application/json'});
      if (key == 'PATCH $devicePath') {
        final on = (jsonDecode(request.body) as Map)['ring_enabled'];
        status = {...status, 'device': {...(status['device']! as Map<String, Object?>), 'ring_enabled': on}};
      }
      if (key == 'POST $devicePath/test-ring') return http.Response('{}', 202, headers: {'content-type': 'application/json'});
      return http.Response(jsonEncode(status), 200, headers: {'content-type': 'application/json'});
    });
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          envProvider.overrideWithValue(testEnv),
          idTokenSourceProvider.overrideWithValue(FakeTokens()),
          clientIdentityProvider.overrideWithValue(ClientIdentity.test),
          httpClientProvider.overrideWithValue(client),
          requestScopeProvider.overrideWithValue(RequestScope()
            ..tenantId = 'ten-1'
            ..accountId = 'acc-1'),
          appGateProvider.overrideWith(() => RingGate(ready)),
          ringChannelProvider.overrideWithValue(channel),
          ringPlatformProvider.overrideWithValue(platform),
          ringStatusOnlyProvider.overrideWithValue(statusOnly),
          ringLifecycleSourceProvider.overrideWithValue(FakeLifecycle()),
          stationDeviceIdsProvider.overrideWithValue(
            StationDeviceIds(() => MemoryStore({StationDeviceIds.storeKey: ringDeviceId})),
          ),
          ...ringOverrides,
        ],
        child: MaterialApp(
          theme: buildTheme(AppTokens.dark, Brightness.dark),
          home: const Scaffold(body: SingleChildScrollView(child: RingSettingsSection())),
        ),
      ),
    );
    if (settle) await tester.pumpAndSettle();
  }

  testWidgets('the account does not allow ringing: no card', (tester) async {
    status['account_allows_ring'] = false;
    await pump(tester);
    expect(find.byKey(const Key('ring-settings')), findsNothing);
    expect(find.text('Ring this phone for inbound calls'), findsNothing);
  });

  testWidgets('the card: the toggle, why, the checklist with a fix for what needs one, and the miss rule', (tester) async {
    channel.list = const RingChecklist({
      RingChecklistItem.notifications: true,
      RingChecklistItem.fullScreen: false,
      RingChecklistItem.batteryExempt: false,
      RingChecklistItem.microphone: true,
      RingChecklistItem.phoneAccount: true,
      RingChecklistItem.dndAllowsCalls: true,
    });
    await pump(tester);
    expect(find.text('INBOUND CALLS'), findsOneWidget);
    expect(find.text('Ring this phone for inbound calls'), findsOneWidget);
    for (final label in ['Notifications', 'Full-screen calls', 'Battery optimisation', 'Microphone', 'Phone calling permission', 'Do Not Disturb']) {
      expect(find.text(label), findsOneWidget, reason: label);
    }
    expect(
      find.text(
        'If you miss two inbound calls, this phone stops ringing until you open the app again, so callers aren’t kept '
        'waiting for you.',
      ),
      findsOneWidget,
    );
    expect(find.text('Fix'), findsNWidgets(2));
    final fix = find.descendant(of: find.byKey(const Key('ring-check-battery_exempt')), matching: find.text('Fix'));
    await tester.ensureVisible(fix);
    await tester.tap(fix);
    await tester.pump();
    expect(channel.calls, contains('openSettings:battery_exempt'));
  });

  testWidgets('the toggle opts out with PATCH, and back in', (tester) async {
    await pump(tester);
    final toggle = find.byKey(const Key('ring-toggle'));
    expect(tester.widget<SwitchListTile>(toggle).value, isTrue);
    await tester.tap(toggle);
    await tester.pumpAndSettle();
    final patch = requests.where((r) => r.method == 'PATCH').single;
    expect(jsonDecode(patch.body), {'ring_enabled': false});
    expect(tester.widget<SwitchListTile>(toggle).value, isFalse);
    expect(find.byKey(const Key('ring-test')), findsNothing, reason: 'nothing to test while off');
    await tester.tap(toggle);
    await tester.pumpAndSettle();
    expect(tester.widget<SwitchListTile>(toggle).value, isTrue);
  });

  testWidgets('"Send a test ring": waiting, then the success native reports', (tester) async {
    await pump(tester);
    await tester.ensureVisible(find.byKey(const Key('ring-test')));
    await tester.tap(find.byKey(const Key('ring-test')));
    await tester.pumpAndSettle();
    expect(requests.where((r) => r.url.path == '$devicePath/test-ring'), hasLength(1));
    expect(find.text('Waiting for the test ring…'), findsOneWidget);
    channel.emit(const RingTestReceived());
    await tester.pumpAndSettle();
    expect(find.text('Your phone rang. Ringing works on this phone.'), findsOneWidget);
  });

  testWidgets('a test ring that reached the phone but could not be shown says to check notifications', (tester) async {
    await pump(tester);
    await tester.ensureVisible(find.byKey(const Key('ring-test')));
    await tester.tap(find.byKey(const Key('ring-test')));
    await tester.pumpAndSettle();
    channel.emit(const RingTestReceived(shown: false));
    await tester.pumpAndSettle();
    expect(find.text('The test ring reached this phone, but it couldn’t show the call. Check notifications.'), findsOneWidget);
    expect(find.text('Your phone rang. Ringing works on this phone.'), findsNothing);
  });

  testWidgets('no push on this phone: the toggle is off-limits and the card says why', (tester) async {
    channel.token = null;
    await pump(tester);
    expect(tester.widget<SwitchListTile>(find.byKey(const Key('ring-toggle'))).onChanged, isNull);
    expect(find.text('Won’t ring: push messages aren’t available on this phone'), findsOneWidget);
    expect(find.text('Ringing can’t be turned on here.'), findsOneWidget);
  });

  testWidgets('the headline: ready when leaving the app rings this phone', (tester) async {
    await pump(tester);
    expect(find.text('Ready: this phone rings when you leave the app'), findsOneWidget);
  });

  testWidgets('the headline: won\'t ring, and the first thing in the way', (tester) async {
    channel.list = const RingChecklist({
      RingChecklistItem.notifications: false,
      RingChecklistItem.fullScreen: true,
      RingChecklistItem.batteryExempt: true,
      RingChecklistItem.microphone: false,
      RingChecklistItem.phoneAccount: true,
      RingChecklistItem.dndAllowsCalls: true,
    });
    await pump(tester);
    expect(find.text('Won’t ring: notifications are off'), findsOneWidget);
  });

  testWidgets('the headline: off on this phone says so', (tester) async {
    status = {...status, 'device': {...(status['device']! as Map<String, Object?>), 'ring_enabled': false}};
    await pump(tester);
    expect(find.text('Won’t ring: ringing is turned off on this phone'), findsOneWidget);
  });

  testWidgets('loading, then a failed load says so with Try again, which loads again', (tester) async {
    failStatus = true;
    slow = true;
    await pump(tester, settle: false);
    await tester.pump();
    expect(find.byKey(const Key('ring-loading')), findsOneWidget);
    expect(find.text('Loading this phone’s ringing settings…'), findsOneWidget);
    await tester.pump(const Duration(seconds: 2));
    await tester.pumpAndSettle();
    slow = false;
    expect(find.text('Couldn’t load this phone’s ringing settings.'), findsOneWidget);
    failStatus = false;
    await tester.tap(find.byKey(const Key('ring-retry')));
    await tester.pumpAndSettle();
    expect(find.text('Ring this phone for inbound calls'), findsOneWidget);
  });

  testWidgets('a phone that does not ring yet (iOS): the card says so where the account rings phones', (tester) async {
    await pump(tester, platform: null, statusOnly: true);
    expect(find.text('Ringing for inbound calls isn’t available on this phone yet.'), findsOneWidget);
    expect(find.text('Ring this phone for inbound calls'), findsNothing);
    expect(requests.where((r) => r.method == 'PUT'), isEmpty, reason: 'nothing registered');
  });

  testWidgets('a phone that does not ring yet, on an account that does not ring phones: no card', (tester) async {
    status['account_allows_ring'] = false;
    await pump(tester, platform: null, statusOnly: true);
    expect(find.byKey(const Key('ring-settings')), findsNothing);
  });
}
