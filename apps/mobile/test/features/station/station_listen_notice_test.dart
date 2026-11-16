import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:magick_agency_agent/core/flags/feature_flags.dart';
import 'package:magick_agency_agent/core/station/station_view.dart';
import 'package:magick_agency_agent/features/station/station_providers.dart';

import 'station_harness.dart';

/// The agent's standing line (docs/listening.md LS2): while the account allows supervisors to
/// listen (`agency_live_listen_enabled`, client-exposed), the station header has an info button
/// whose sheet says "Calls may be listened to by a supervisor for quality and training." Copy
/// only: no wire change, no live indicator.
void main() {
  const line = 'Calls may be listened to by a supervisor for quality and training.';

  test('follows the contract’s client flag', () {
    expect(liveListenFlagKey, 'agency_live_listen_enabled');
    for (final on in [true, false]) {
      final container = ProviderContainer(overrides: [featureFlagProvider(liveListenFlagKey).overrideWithValue(on)]);
      addTearDown(container.dispose);
      expect(container.read(stationListenNoticeProvider), on);
    }
  });

  testWidgets('no info button while listening is off', (tester) async {
    await pumpStation(tester, station());
    expect(find.byKey(const Key('station-info')), findsNothing);
    expect(find.text(line), findsNothing);
  });

  testWidgets('with listening on, the header’s info button opens the sheet with the line', (tester) async {
    await pumpStation(tester, station(), listenNotice: true);
    expect(find.byKey(const Key('station-info')), findsOneWidget);
    expect(find.byTooltip('About this station'), findsOneWidget);
    await tester.tap(find.byKey(const Key('station-info')));
    await settle(tester);
    expect(find.byKey(const Key('station-info-sheet')), findsOneWidget);
    expect(find.text(line), findsOneWidget);
  });

  testWidgets('offline and while a call is coming through too: wherever the header shows', (tester) async {
    final h = await pumpStation(tester, station(phase: AgentPhase.offline), listenNotice: true);
    expect(find.byKey(const Key('station-info')), findsOneWidget);
    await h.setView(station(phase: AgentPhase.reserved));
    expect(find.text('A call is coming through'), findsWidgets);
    expect(find.byKey(const Key('station-info')), findsOneWidget);
  });
}
