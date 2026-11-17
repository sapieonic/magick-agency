import 'package:agency_wire/agency_wire.dart' show FeatureFlags;
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:magick_agency_agent/core/flags/feature_flags.dart';
import 'package:magick_agency_agent/core/session/session_store.dart';
import 'package:magick_agency_agent/core/softphone/softphone_view.dart';
import 'package:magick_agency_agent/core/station/station_view.dart';
import 'package:magick_agency_agent/features/station/station_providers.dart';

import '../softphone/softphone_harness.dart' show pumpSoftphone, readyView;
import 'station_harness.dart';

/// The agent's standing line (docs/listening.md LS2): while the account allows supervisors to
/// listen (`agency_live_listen_enabled`, client-exposed), the station header and the soft phone
/// have a "Monitoring and recording" info button whose sheet says "Calls may be listened to by a
/// supervisor for quality and training.", and the first time an agent opens either on this phone
/// for an account, a notice says it in place until they tap Got it. Copy only: no wire change, no
/// live indicator.
void main() {
  const line = 'Calls may be listened to by a supervisor for quality and training.';
  const scope = 'u-1:t-1:a-1';
  const seenKey = 'listen.agent_notice_seen:$scope';
  const firstDetail = 'You can read this again at any time under Monitoring and recording, the i button at the top of the screen.';
  const firstDetailOnCall = 'You can read this again under Monitoring and recording, the i button at the top of the screen between calls.';

  test('follows the contract’s client flag', () {
    // The key is agency_wire's, pinned there against the contract's platform.json fixture.
    expect(FeatureFlags.liveListenEnabled, 'agency_live_listen_enabled');
    for (final on in [true, false]) {
      final container = ProviderContainer(overrides: [featureFlagProvider(FeatureFlags.liveListenEnabled).overrideWithValue(on)]);
      addTearDown(container.dispose);
      expect(container.read(stationListenNoticeProvider), on);
    }
  });

  testWidgets('no info button while listening is off', (tester) async {
    await pumpStation(tester, station(), listenScope: scope);
    expect(find.byKey(const Key('station-info')), findsNothing);
    expect(find.byKey(const Key('listen-first-notice')), findsNothing);
    expect(find.text(line), findsNothing);
  });

  testWidgets('with listening on, the header’s Monitoring and recording button opens the sheet with the line', (tester) async {
    await pumpStation(tester, station(), listenNotice: true);
    expect(find.byKey(const Key('station-info')), findsOneWidget);
    expect(find.byTooltip('Monitoring and recording'), findsOneWidget);
    await tester.tap(find.byKey(const Key('station-info')));
    await settle(tester);
    expect(find.byKey(const Key('station-info-sheet')), findsOneWidget);
    expect(find.text('Monitoring and recording'), findsWidgets);
    expect(find.text(line), findsOneWidget);
  });

  testWidgets('offline and while a call is coming through too: wherever the header shows', (tester) async {
    final h = await pumpStation(tester, station(phase: AgentPhase.offline), listenNotice: true);
    expect(find.byKey(const Key('station-info')), findsOneWidget);
    await h.setView(station(phase: AgentPhase.reserved));
    expect(find.text('A call is coming through'), findsWidgets);
    expect(find.byKey(const Key('station-info')), findsOneWidget);
  });

  group('the one-time notice', () {
    testWidgets('on the station the first time, until Got it, and remembered on this phone', (tester) async {
      final store = MemoryStore();
      await pumpStation(tester, station(), listenNotice: true, listenScope: scope, store: store);
      final notice = find.byKey(const Key('listen-first-notice'));
      expect(notice, findsOneWidget);
      expect(find.descendant(of: notice, matching: find.text(line)), findsOneWidget);
      await tester.tap(find.descendant(of: notice, matching: find.text('Got it')));
      await settle(tester);
      expect(find.byKey(const Key('listen-first-notice')), findsNothing);
      expect(store.values[seenKey], true);
    });

    testWidgets('on a call too, the first time, without sending the agent to a button the call has not got', (tester) async {
      await pumpStation(tester, station(phase: AgentPhase.onCall), listenNotice: true, listenScope: scope);
      final notice = find.byKey(const Key('listen-first-notice'));
      expect(notice, findsOneWidget);
      // The call's band has no info button: the notice says where it is between calls.
      expect(find.byKey(const Key('station-info')), findsNothing);
      expect(find.descendant(of: notice, matching: find.text(firstDetailOnCall)), findsOneWidget);
      expect(find.descendant(of: notice, matching: find.text(firstDetail)), findsNothing);
    });

    testWidgets('waiting, it points at the button the header has', (tester) async {
      await pumpStation(tester, station(), listenNotice: true, listenScope: scope);
      expect(find.byKey(const Key('station-info')), findsOneWidget);
      expect(find.descendant(of: find.byKey(const Key('listen-first-notice')), matching: find.text(firstDetail)), findsOneWidget);
    });

    testWidgets('not again once seen', (tester) async {
      await pumpStation(tester, station(), listenNotice: true, listenScope: scope, store: MemoryStore({seenKey: true}));
      expect(find.byKey(const Key('listen-first-notice')), findsNothing);
      // The info button is still there.
      expect(find.byKey(const Key('station-info')), findsOneWidget);
    });

    testWidgets('at 200% text on 360×640 it lays out with no overflow, waiting and on a call', (tester) async {
      for (final (phase, detail) in [(AgentPhase.available, firstDetail), (AgentPhase.onCall, firstDetailOnCall)]) {
        await pumpStation(tester, station(phase: phase), textScale: 2, size: const Size(360, 640), listenNotice: true, listenScope: scope);
        expect(tester.takeException(), isNull, reason: phase.name);
        expect(find.byKey(const Key('listen-first-notice')), findsOneWidget);
        expect(find.text(detail), findsOneWidget, reason: phase.name);
      }
    });

    testWidgets('nothing with nobody to remember it for', (tester) async {
      await pumpStation(tester, station(), listenNotice: true);
      expect(find.byKey(const Key('listen-first-notice')), findsNothing);
    });

    test('per agent and account: another agent, or another account, is told too', () async {
      final store = MemoryStore({seenKey: true});
      for (final (other, shown) in [(scope, false), ('u-2:t-1:a-1', true), ('u-1:t-1:a-2', true)]) {
        final container = ProviderContainer(
          overrides: [
            stationListenNoticeProvider.overrideWithValue(true),
            listenNoticeScopeProvider.overrideWithValue(other),
            keyValueStoreProvider.overrideWithValue(store),
          ],
        );
        addTearDown(container.dispose);
        final sub = container.listen(listenFirstNoticeProvider, (_, _) {});
        addTearDown(sub.close);
        await Future<void>.delayed(Duration.zero);
        expect(container.read(listenFirstNoticeProvider), shown, reason: other);
      }
    });

    test('off with listening off, whatever was stored', () async {
      final container = ProviderContainer(
        overrides: [
          stationListenNoticeProvider.overrideWithValue(false),
          listenNoticeScopeProvider.overrideWithValue(scope),
          keyValueStoreProvider.overrideWithValue(MemoryStore()),
        ],
      );
      addTearDown(container.dispose);
      final sub = container.listen(listenFirstNoticeProvider, (_, _) {});
      addTearDown(sub.close);
      await Future<void>.delayed(Duration.zero);
      expect(container.read(listenFirstNoticeProvider), false);
    });
  });

  group('the soft phone', () {
    for (final surface in SoftphoneSurface.values) {
      testWidgets('${surface.name}: the Monitoring and recording button, and the notice the first time', (tester) async {
        final store = MemoryStore();
        await pumpSoftphone(tester, readyView(), surface: surface, listenNotice: true, listenScope: scope, store: store);
        expect(find.byKey(const Key('softphone-listen-info')), findsOneWidget);
        expect(find.byKey(const Key('listen-first-notice')), findsOneWidget);
        await tester.tap(find.text('Got it'));
        await tester.pumpAndSettle();
        expect(find.byKey(const Key('listen-first-notice')), findsNothing);
        expect(store.values[seenKey], true);
        await tester.tap(find.byKey(const Key('softphone-listen-info')));
        await tester.pumpAndSettle();
        expect(find.byKey(const Key('station-info-sheet')), findsOneWidget);
        expect(find.text(line), findsOneWidget);
      });
    }

    testWidgets('at 200% text on 360×640 the button and the notice lay out with no overflow', (tester) async {
      for (final surface in SoftphoneSurface.values) {
        await pumpSoftphone(tester, readyView(), surface: surface, textScale: 2, size: const Size(360, 640), listenNotice: true, listenScope: scope);
        expect(tester.takeException(), isNull, reason: surface.name);
        expect(find.byKey(const Key('listen-first-notice')), findsOneWidget);
      }
    });

    testWidgets('neither while listening is off', (tester) async {
      await pumpSoftphone(tester, readyView(), listenScope: scope);
      expect(find.byKey(const Key('softphone-listen-info')), findsNothing);
      expect(find.byKey(const Key('listen-first-notice')), findsNothing);
    });
  });
}
