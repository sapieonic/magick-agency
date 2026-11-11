import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:magick_agency_agent/app/theme/app_theme.dart';
import 'package:magick_agency_agent/app/theme/tokens.dart';
import 'package:magick_agency_agent/core/api/api_error.dart';
import 'package:magick_agency_agent/core/station/away_return.dart';
import 'package:magick_agency_agent/core/station/station_signals.dart';
import 'package:magick_agency_agent/features/missed/missed_access.dart';
import 'package:magick_agency_agent/features/missed/missed_calls_api.dart';
import 'package:magick_agency_agent/features/missed/missed_calls_copy.dart';
import 'package:magick_agency_agent/features/missed/missed_on_duty.dart';
import 'package:magick_agency_agent/features/missed/rang_while_away.dart';

import '../../core/auth/support/harness.dart' show testSignalsProvider;
import 'support.dart';

/// IQ50 (and IQ51's phone call): back from a pause, the station says how many of the agent's
/// own Missed rows arrived since it began, asked once per return, with the way to the list.
void main() {
  const shown = MissedCallsAccess(visible: true, inboundOn: true, badge: '3');
  const onDuty = StationSignals(onDuty: true, campaignId: 'c1');
  final pausedAt = DateTime.utc(2026, 11, 1, 9);

  late FakeMissedCallsApi api;
  late ProviderContainer c;

  ProviderContainer container({MissedCallsAccess access = shown}) {
    api = FakeMissedCallsApi();
    final c = ProviderContainer.test(overrides: [
      missedCallsApiProvider.overrideWithValue(api),
      missedCallsAccessProvider.overrideWithValue(access),
      stationSignalsProvider.overrideWith((ref) => ref.watch(testSignalsProvider)),
    ]);
    c.read(testSignalsProvider.notifier).set(onDuty);
    c.listen(rangWhileAwayProvider, (_, _) {});
    return c;
  }

  Future<void> back(AwayKind kind) async {
    c.read(awayReturnProvider.notifier).announce(pausedAt, kind);
    await pumpEventQueue();
  }

  test('the words: the count as the badge says it, away or on the phone', () {
    expect(MissedCopy.rangWhileAway('1'), '1 customer rang while you were away');
    expect(MissedCopy.rangWhileAway('3'), '3 customers rang while you were away');
    expect(MissedCopy.rangWhileAway('100+', phoneCall: true), '100+ customers rang while you were on your phone call');
  });

  test('back from the pause: the agent\'s rows since it began, asked once', () async {
    c = container();
    api.sinceAnswer = countOf(2);
    await back(AwayKind.app);
    expect(api.countSince, [pausedAt]);
    expect(c.read(rangWhileAwayProvider), const RangWhileAway(badge: '2', kind: AwayKind.app));
    await pumpEventQueue();
    expect(api.countReads, 1);
    c.dispose();
  });

  test('from a phone call: said as one', () async {
    c = container();
    api.sinceAnswer = countOf(1);
    await back(AwayKind.phoneCall);
    expect(c.read(rangWhileAwayProvider), const RangWhileAway(badge: '1', kind: AwayKind.phoneCall));
    c.dispose();
  });

  test('none rang, or the read failed: nothing said', () async {
    c = container();
    api.sinceAnswer = countOf(0, hasRows: true);
    await back(AwayKind.app);
    expect(c.read(rangWhileAwayProvider), isNull);
    api.sinceAnswer = const ApiNetworkError('offline');
    await back(AwayKind.app);
    expect(c.read(rangWhileAwayProvider), isNull);
    c.dispose();
  });

  test('the list hidden for this agent: not asked', () async {
    c = container(access: MissedCallsAccess.hidden);
    await back(AwayKind.app);
    expect(api.countReads, 0);
    c.dispose();
  });

  test('a return from before the station was built is not news', () async {
    api = FakeMissedCallsApi();
    c = ProviderContainer.test(overrides: [
      missedCallsApiProvider.overrideWithValue(api),
      missedCallsAccessProvider.overrideWithValue(shown),
      stationSignalsProvider.overrideWith((ref) => ref.watch(testSignalsProvider)),
    ]);
    c.read(awayReturnProvider.notifier).announce(pausedAt, AwayKind.app);
    c.listen(rangWhileAwayProvider, (_, _) {});
    await pumpEventQueue();
    expect(api.countReads, 0);
    c.dispose();
  });

  test('it lasts until dismissed, a call reaches the agent, or they leave', () async {
    c = container();
    api.sinceAnswer = countOf(2);
    await back(AwayKind.app);
    c.read(rangWhileAwayProvider.notifier).dismiss();
    expect(c.read(rangWhileAwayProvider), isNull);

    await back(AwayKind.app);
    expect(c.read(rangWhileAwayProvider), isNotNull);
    c.read(testSignalsProvider.notifier).set(const StationSignals(onDuty: true, campaignId: 'c1', callActive: true));
    await pumpEventQueue();
    expect(c.read(rangWhileAwayProvider), isNull, reason: 'a call takes the screen');

    c.read(testSignalsProvider.notifier).set(onDuty);
    await back(AwayKind.app);
    expect(c.read(rangWhileAwayProvider), isNotNull);
    c.read(testSignalsProvider.notifier).set(const StationSignals());
    await pumpEventQueue();
    expect(c.read(rangWhileAwayProvider), isNull, reason: 'off the station');
    c.dispose();
  });

  testWidgets('the notice: the words, the way to the list (which closes it), and Dismiss', (tester) async {
    c = container();
    final opened = <BuildContext>[];
    final scoped = ProviderContainer.test(parent: c, overrides: [missedOnDutyOpenerProvider.overrideWithValue(opened.add)]);
    api.sinceAnswer = countOf(3);
    await tester.pumpWidget(UncontrolledProviderScope(
      container: scoped,
      child: MaterialApp(
        theme: buildTheme(AppTokens.dark, Brightness.dark),
        home: const Scaffold(body: RangWhileAwayNotice()),
      ),
    ));
    expect(find.byKey(const Key('rang-while-away')), findsNothing);
    await tester.runAsync(() => back(AwayKind.app));
    await tester.pump();
    expect(find.text('3 customers rang while you were away'), findsOneWidget);
    await tester.tap(find.byKey(const Key('rang-while-away-open')));
    await tester.pump();
    expect(opened, hasLength(1));
    expect(find.byKey(const Key('rang-while-away')), findsNothing);

    await tester.runAsync(() => back(AwayKind.phoneCall));
    await tester.pump();
    expect(find.text('3 customers rang while you were on your phone call'), findsOneWidget);
    await tester.tap(find.byKey(const Key('rang-while-away-dismiss')));
    await tester.pump();
    expect(find.byKey(const Key('rang-while-away')), findsNothing);
    scoped.dispose();
    c.dispose();
  });
}
