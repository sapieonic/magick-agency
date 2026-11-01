import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:magick_agency_agent/core/station/station_view.dart';

import 'station_harness.dart';

void main() {
  StationView onCall({StationLink link = StationLink.open, DateTime? deadline}) => station(
    link: link,
    phase: AgentPhase.onCall,
    call: call(bridgedAt: t0.subtract(const Duration(minutes: 4, seconds: 51))),
    reconnectDeadline: deadline,
  );

  group('reconnecting', () {
    testWidgets('mid-call: ember band, a ring counting to the deadline, controls dimmed', (tester) async {
      final h = await pumpStation(tester, onCall(link: StationLink.reconnecting, deadline: t0.add(const Duration(seconds: 6))));
      expect(find.text('Reconnecting…'), findsOneWidget);
      expect(find.text('Stay on the line. The customer is still there.'), findsOneWidget);
      expect(find.byKey(const Key('reconnect-ring')), findsOneWidget);
      expect(find.text('6'), findsOneWidget);
      // The "On call" band gives way to the connection's.
      expect(find.byKey(const Key('band-on-call')), findsNothing);

      final dim = tester.widget<AnimatedOpacity>(
        find.ancestor(of: find.byKey(const Key('control-mute')), matching: find.byType(AnimatedOpacity)).first,
      );
      expect(dim.opacity, lessThan(1));
      await tester.tap(find.byKey(const Key('control-mute')), warnIfMissed: false);
      expect(h.actions.calls, isEmpty);

      await h.advance(const Duration(seconds: 2));
      expect(find.text('4'), findsOneWidget);
      // Past the deadline the ring stops at zero, never negative.
      await h.advance(const Duration(seconds: 10));
      expect(find.text('0'), findsOneWidget);
    });

    testWidgets('idle: a slim banner over the waiting screen', (tester) async {
      await pumpStation(tester, station(link: StationLink.reconnecting));
      expect(find.byKey(const Key('idle-reconnecting')), findsOneWidget);
      expect(find.text('Waiting for a call'), findsOneWidget);
    });

    testWidgets('back to open: the on-call band and live controls return', (tester) async {
      final h = await pumpStation(tester, onCall(link: StationLink.reconnecting, deadline: t0.add(const Duration(seconds: 8))));
      await h.setView(onCall());
      expect(find.byKey(const Key('band-on-call')), findsOneWidget);
      await tester.tap(find.byKey(const Key('control-mute')));
      expect(h.actions.calls, ['setMuted']);
    });
  });

  group('disconnected', () {
    testWidgets('idle: "Disconnected — you are not receiving calls" with Reconnect', (tester) async {
      final h = await pumpStation(tester, station(link: StationLink.disconnected));
      expect(find.text('Disconnected — you are not receiving calls'), findsOneWidget);
      expect(find.text('Reconnect, then go available to start taking calls.'), findsOneWidget);
      await tester.tap(find.text('Reconnect'));
      expect(h.actions.calls, ['reconnect']);
    });

    testWidgets('mid-call it says the customer cannot hear, not "not receiving calls"', (tester) async {
      final h = await pumpStation(tester, onCall(link: StationLink.disconnected));
      expect(find.text('Connection lost'), findsOneWidget);
      expect(find.text('The customer can’t hear you right now. Reconnect to get back on the call.'), findsOneWidget);
      await tester.tap(find.text('Reconnect'));
      expect(h.actions.calls, ['reconnect']);
    });
  });

  testWidgets('superseded: full screen, "Use this phone instead" reclaims', (tester) async {
    final h = await pumpStation(tester, onCall(link: StationLink.superseded));
    expect(find.text('Your station moved to another device'), findsOneWidget);
    expect(find.textContaining('You opened Q4 Card Renewals somewhere else'), findsOneWidget);
    expect(find.byKey(const Key('hang-up')), findsNothing);
    await tester.tap(find.byKey(const Key('use-this-phone')));
    expect(h.actions.calls, ['useThisDevice']);
    await tester.tap(find.text('Back to campaigns'));
    await settle(tester);
    expect(find.text('campaigns-home'), findsOneWidget);
  });

  testWidgets('session gone: rejoin from the campaign list', (tester) async {
    await pumpStation(tester, station(link: StationLink.sessionGone));
    expect(find.text('Session ended'), findsOneWidget);
    expect(find.text('Rejoin the campaign to take calls.'), findsOneWidget);
    await tester.tap(find.byKey(const Key('back-to-campaigns')));
    await settle(tester);
    expect(find.text('campaigns-home'), findsOneWidget);
  });

  testWidgets('weak connection pill while the link is open', (tester) async {
    final h = await pumpStation(tester, station(weak: true));
    expect(find.byKey(const Key('weak-connection')), findsOneWidget);
    await h.setView(station());
    expect(find.byKey(const Key('weak-connection')), findsNothing);
  });

  testWidgets('connecting, fatal and not-here each have a way off', (tester) async {
    final h = await pumpStation(tester, station(link: StationLink.connecting));
    expect(find.text('Opening your station…'), findsOneWidget);
    await h.setView(station(fatal: 'You aren’t staffed on this campaign.'));
    expect(find.text('Can’t open the station'), findsOneWidget);
    expect(find.text('You aren’t staffed on this campaign.'), findsOneWidget);
    await h.setView(null);
    expect(find.text('You’re not at this station'), findsOneWidget);
    expect(find.text('Back to campaigns'), findsOneWidget);
  });

  testWidgets('system back does not take the call screen away mid-call', (tester) async {
    final h = await pumpStation(tester, onCall());
    await tester.binding.handlePopRoute();
    await settle(tester);
    expect(find.byKey(const Key('band-on-call')), findsOneWidget);
    expect(find.text('campaigns-home'), findsNothing);
    // Between calls back works as usual.
    await h.setView(station());
    await tester.binding.handlePopRoute();
    await settle(tester);
    expect(find.text('campaigns-home'), findsOneWidget);
  });

  testWidgets('a station on another campaign offers to open it', (tester) async {
    await pumpStation(tester, station(campaignId: 'c2'));
    expect(find.text('Your station is on Q4 Card Renewals'), findsOneWidget);
    expect(find.text('Open it'), findsOneWidget);
  });
}
