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

  setUp(() {
    channel = FakeRingChannel();
    status = pushSample('device_status_ringing');
    requests = [];
  });

  Future<void> pump(WidgetTester tester) async {
    final client = MockClient((request) async {
      requests.add(request);
      final key = '${request.method} ${request.url.path}';
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
          ringPlatformProvider.overrideWithValue(PushPlatform.android),
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
    await tester.pumpAndSettle();
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
    for (final label in ['Notifications', 'Full-screen calls', 'Battery optimisation', 'Microphone', 'Calling account', 'Do Not Disturb']) {
      expect(find.text(label), findsOneWidget, reason: label);
    }
    expect(
      find.text(
        'If you miss two calls in a row, this phone stops ringing until you open the app again, so callers aren’t kept '
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

  testWidgets('no push on this phone: the toggle is off-limits and the card says why', (tester) async {
    channel.token = null;
    await pump(tester);
    expect(tester.widget<SwitchListTile>(find.byKey(const Key('ring-toggle'))).onChanged, isNull);
    expect(find.text('This phone can’t receive rings: push messages aren’t available on it.'), findsOneWidget);
  });
}
