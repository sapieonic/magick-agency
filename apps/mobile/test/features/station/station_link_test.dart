import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:magick_agency_agent/core/station/station_view.dart';
import 'package:magick_agency_agent/features/station/station_copy.dart';

import 'station_harness.dart';

void main() {
  StationView onCall({StationLink link = StationLink.open, DateTime? deadline}) => station(
    link: link,
    phase: AgentPhase.onCall,
    call: call(bridgedAt: t0.subtract(const Duration(minutes: 4, seconds: 51))),
    reconnectDeadline: deadline,
  );

  group('reconnecting', () {
    testWidgets('mid-call: Call problem (10), red, the call kept until the deadline, what to do, controls dimmed', (tester) async {
      final h = await pumpStation(tester, onCall(link: StationLink.reconnecting, deadline: t0.add(const Duration(seconds: 6))));
      expect(find.byKey(const Key('band-tone-problem')), findsOneWidget);
      expect(find.text(StationCopy.callProblem), findsOneWidget);
      expect(find.text('Call is kept for 0:06'), findsOneWidget);
      expect(find.text(StationCopy.stepSaySorry), findsOneWidget);
      // The "On call" band gives way to the line's.
      expect(find.byKey(const Key('band-on-call')), findsNothing);
      // The customer card stays.
      expect(find.text('Priya Raman'), findsOneWidget);

      final dim = tester.widget<AnimatedOpacity>(
        find.ancestor(of: find.byKey(const Key('control-mute')), matching: find.byType(AnimatedOpacity)).first,
      );
      expect(dim.opacity, lessThan(1));
      await tester.tap(find.byKey(const Key('control-mute')), warnIfMissed: false);
      expect(h.actions.calls, isEmpty);

      await h.advance(const Duration(seconds: 2));
      expect(find.text('Call is kept for 0:04'), findsOneWidget);
      // Past the deadline it stops at zero, never negative.
      await h.advance(const Duration(seconds: 10));
      expect(find.text('Call is kept for 0:00'), findsOneWidget);
    });

    testWidgets('idle: Internet problem (09), what to do, and no Try again now while it is still trying', (tester) async {
      await pumpStation(tester, station(link: StationLink.reconnecting));
      expect(find.byKey(const Key('idle-reconnecting')), findsOneWidget);
      expect(find.text(StationCopy.internetProblem), findsOneWidget);
      expect(find.text(StationCopy.stepCheckInternet), findsOneWidget);
      expect(find.byKey(const Key('reconnect')), findsNothing);
      expect(find.text(StationCopy.nextCallComing), findsNothing);
    });

    testWidgets('back to open: the on-call band and live controls return', (tester) async {
      final h = await pumpStation(tester, onCall(link: StationLink.reconnecting, deadline: t0.add(const Duration(seconds: 8))));
      await h.setView(onCall());
      expect(find.byKey(const Key('band-on-call')), findsOneWidget);
      expect(find.byKey(const Key('call-problem-steps')), findsNothing);
      await tester.tap(find.byKey(const Key('control-mute')));
      expect(h.actions.calls, ['setMuted']);
    });
  });

  group('disconnected', () {
    testWidgets('idle: Internet problem, calls are stopped, Try again now', (tester) async {
      final h = await pumpStation(tester, station(link: StationLink.disconnected));
      expect(find.byKey(const Key('idle-disconnected')), findsOneWidget);
      expect(find.text(StationCopy.internetStopped), findsOneWidget);
      await tester.tap(find.byKey(const Key('reconnect')));
      expect(h.actions.calls, ['reconnect']);
    });

    testWidgets('mid-call it is Call problem, and Try again now reconnects', (tester) async {
      final h = await pumpStation(tester, onCall(link: StationLink.disconnected));
      expect(find.text(StationCopy.callProblem), findsOneWidget);
      expect(find.text(StationCopy.internetProblem), findsNothing);
      await tester.ensureVisible(find.byKey(const Key('reconnect')));
      await tester.tap(find.byKey(const Key('reconnect')));
      expect(h.actions.calls, ['reconnect']);
    });

    testWidgets('Need help with no internet: call your supervisor to your desk (AS5)', (tester) async {
      final h = await pumpStation(tester, onCall(link: StationLink.disconnected), needHelp: true);
      await tester.tap(find.byKey(const Key('need-help')));
      await settle(tester);
      expect(h.actions.calls, isNot(contains('raiseHelp')));
      expect(find.byKey(const Key('help-offline')), findsOneWidget);
      expect(find.textContaining(StationCopy.offlineHelp), findsOneWidget);
    });
  });

  testWidgets('another device (12): its own screen, "Use this phone" takes the work back', (tester) async {
    final h = await pumpStation(tester, onCall(link: StationLink.superseded));
    expect(find.byKey(const Key('band-tone-quiet')), findsOneWidget);
    expect(find.text(StationCopy.otherDeviceTitle), findsOneWidget);
    expect(find.text(StationCopy.otherDeviceSubtitle), findsOneWidget);
    expect(find.byKey(const Key('hang-up')), findsNothing);
    // No Need help, no ⋮ More here.
    expect(find.byKey(const Key('station-more')), findsNothing);
    await tester.tap(find.byKey(const Key('use-this-phone')));
    expect(h.actions.calls, ['useThisDevice']);
    await tester.tap(find.text(StationCopy.backToWork));
    await settle(tester);
    expect(find.text('campaigns-home'), findsOneWidget);
    expect(h.actions.calls, ['useThisDevice', 'dismiss'], reason: 'the station that moved is forgotten here');
  });

  testWidgets('work ended: back to the work list', (tester) async {
    final h = await pumpStation(tester, station(link: StationLink.sessionGone));
    expect(find.text(StationCopy.workEnded), findsOneWidget);
    expect(find.text(StationCopy.workEndedDetail), findsOneWidget);
    await tester.tap(find.byKey(const Key('back-to-campaigns')));
    await settle(tester);
    expect(find.text('campaigns-home'), findsOneWidget);
    expect(h.actions.calls, ['dismiss']);
  });

  testWidgets('a slow line is one line under the band while it is still open', (tester) async {
    final h = await pumpStation(tester, station(weak: true));
    expect(find.byKey(const Key('weak-connection')), findsOneWidget);
    await h.setView(station());
    expect(find.byKey(const Key('weak-connection')), findsNothing);
  });

  testWidgets('connecting, fatal and not-here each have a way off', (tester) async {
    final h = await pumpStation(tester, station(link: StationLink.connecting));
    expect(find.text(StationCopy.connecting), findsOneWidget);
    expect(find.byKey(const Key('leave')), findsOneWidget);
    await h.setView(station(fatal: 'You aren’t staffed on this campaign.'));
    expect(find.text(StationCopy.cannotStart), findsOneWidget);
    expect(find.text('You aren’t staffed on this campaign.'), findsOneWidget);
    expect(find.byKey(const Key('fatal-back')), findsOneWidget);
    await h.setView(null);
    expect(find.text(StationCopy.notHereTitle), findsOneWidget);
    expect(find.text(StationCopy.backToWork), findsOneWidget);
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
    expect(find.text(StationCopy.elsewhereTitle('Q4 Card Renewals')), findsOneWidget);
    expect(find.text(StationCopy.openIt), findsOneWidget);
  });
}
