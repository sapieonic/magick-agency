import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:magick_agency_agent/features/performance/logic/bucket_series.dart';
import 'package:magick_agency_agent/features/performance/performance_screen.dart';

import 'support.dart';

void main() {
  late FakePerformanceApi api;

  final todayStats = stats(
    from: DateTime.utc(2026, 10, 13, 18, 30),
    to: fixedNow,
    t: totals(attempts: 52, connected: 20, connectRate: 38.46, successes: 4, successRate: 20, talk: 3600, aht: 200),
    buckets: [bucket('2026-10-14', 52, 20)],
  );
  final weekStats = stats(
    from: DateTime.utc(2026, 10, 11, 18, 30),
    to: fixedNow,
    buckets: [bucket('2026-10-12', 40, 12), bucket('2026-10-13', 50, 20), bucket('2026-10-14', 52, 22)],
  );

  setUp(() => api = FakePerformanceApi(campaigns: [staffing('c1', 'Q4 Card Renewals')]));

  Future<void> open(WidgetTester tester) async {
    await setPhoneSize(tester);
    await tester.pumpWidget(harness(const PerformanceScreen(), perfOverrides(api)));
    await tester.pump(); // the arrival revalidate
  }

  testWidgets('skeletons first, then the tiles and readouts in the console\'s words', (tester) async {
    await open(tester);
    expect(find.byKey(const Key('performance-skeleton')), findsOneWidget);
    expect(api.statsQueries, hasLength(1));

    api.answer(0, todayStats);
    await flush(tester);
    expect(find.byKey(const Key('performance-skeleton')), findsNothing);
    expect(find.bySemanticsLabel('Dials: 52'), findsOneWidget);
    expect(find.bySemanticsLabel('Connect rate: 38.5%'), findsOneWidget);
    expect(find.bySemanticsLabel('Conversations: 20'), findsOneWidget);
    expect(find.text('Conversion rate'), findsOneWidget);
    expect(find.text('· 4 counted'), findsOneWidget);
    expect(find.text('Average call'), findsOneWidget);
    expect(find.text('· 1:00:00 on calls in total'), findsOneWidget);
    expect(find.text('Wrap-up'), findsOneWidget);
    expect(find.text('14 Oct 2026 · IST (UTC+05:30)'), findsOneWidget);
    // One day is not a chart.
    expect(find.byKey(const Key('bucket-chart-single')), findsOneWidget);
    expect(find.text(singleBucketNote), findsOneWidget);
  });

  testWidgets('a failed first read names the window and retries', (tester) async {
    await open(tester);
    api.fail(0);
    await flush(tester);
    expect(find.text('We couldn’t load today'), findsOneWidget);
    expect(find.textContaining('offline'), findsOneWidget);

    await tester.tap(find.text('Try again'));
    await flush(tester);
    expect(api.statsQueries, hasLength(2));
    api.answer(1, todayStats);
    await flush(tester);
    expect(find.bySemanticsLabel('Dials: 52'), findsOneWidget);
  });

  testWidgets('switching window: the week draws a chart; tapping a day labels it', (tester) async {
    await open(tester);
    api.answer(0, todayStats);
    await flush(tester);

    await tester.tap(find.text('This week'));
    await flush(tester);
    expect(api.statsQueries.last.from, DateTime.utc(2026, 10, 11, 18, 30));
    expect(find.byKey(const Key('performance-skeleton')), findsOneWidget);
    api.answer(1, weekStats);
    await flush(tester);

    final chart = find.byKey(const Key('bucket-chart'));
    await tester.ensureVisible(chart);
    await flush(tester);
    expect(find.bySemanticsLabel(RegExp('Dials and conversations by day, 3 days')), findsOneWidget);
    expect(find.text(partialBucketNote), findsOneWidget);

    // Tap the middle third: 13 Oct.
    final box = tester.getRect(chart);
    await tester.tapAt(Offset(box.left + 36 + (box.width - 40) / 2, box.center.dy));
    await flush(tester);
    expect(find.text('13 Oct: 50 dials, 20 conversations'), findsOneWidget);

    // Back to Today: the cached answer is on screen while it refreshes.
    await tester.scrollUntilVisible(find.text('Today'), -200, scrollable: find.byType(Scrollable).first);
    await tester.tap(find.text('Today'));
    await flush(tester);
    expect(find.byKey(const Key('performance-refreshing')), findsOneWidget);
    expect(find.bySemanticsLabel('Dials: 52'), findsOneWidget);
    api.answer(2, todayStats);
    await flush(tester);
    expect(find.byKey(const Key('performance-refreshing')), findsNothing);
  });

  testWidgets('the completed windows are in the menu', (tester) async {
    await open(tester);
    api.answer(0, todayStats);
    await flush(tester);
    await tester.tap(find.byKey(const Key('window-more')));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Last month'));
    await tester.pumpAndSettle();
    expect(api.statsQueries.last.from, DateTime.utc(2026, 8, 31, 18, 30)); // 1 Sep IST
    expect(api.statsQueries.last.to, DateTime.utc(2026, 9, 30, 18, 30)); // 1 Oct IST
  });

  testWidgets('one campaign: no selector; two: a selector that scopes every figure', (tester) async {
    await open(tester);
    api.answer(0, todayStats);
    await flush(tester);
    expect(find.byKey(const Key('campaign-scope')), findsNothing);

    api.campaigns = [staffing('c1', 'Q4 Card Renewals'), staffing('c2', 'Gold upgrades')];
    await tester.fling(find.byType(Scrollable).first, const Offset(0, 400), 1000);
    await flush(tester);
    await tester.pump(const Duration(seconds: 1));
    api.answer(1, todayStats);
    await tester.pumpAndSettle();
    expect(find.text('All campaigns'), findsOneWidget);

    await tester.tap(find.byKey(const Key('campaign-scope')));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Gold upgrades'));
    await flush(tester);
    expect(api.statsQueries.last.campaignId, 'c2');
    api.answer(2, todayStats);
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('campaign-scope-note')), findsOneWidget);
    expect(find.text('Gold upgrades'), findsOneWidget);
  });

  testWidgets('a quiet day says so instead of a row of zeros', (tester) async {
    await open(tester);
    api.answer(0, stats(from: todayStats.from, to: fixedNow, t: totals(attempts: 0, connected: 0, connectRate: null, successes: 0, successRate: null, aht: null, talk: 0, wrapup: 0, campaigns: 0)));
    await flush(tester);
    expect(find.text('No calls reached you today.'), findsOneWidget);
    expect(find.bySemanticsLabel('Connect rate: Not measured yet'), findsOneWidget);
  });

  testWidgets('at 200% text nothing overflows', (tester) async {
    await setPhoneSize(tester);
    await tester.pumpWidget(harness(const PerformanceScreen(), perfOverrides(api), textScale: 2));
    await tester.pump();
    await tester.tap(find.text('This week'));
    await flush(tester);
    api.answer(1, weekStats);
    await flush(tester);
    final list = find.byKey(const Key('performance-list'));
    for (var i = 0; i < 12; i++) {
      await tester.drag(list, const Offset(0, -300));
      await tester.pump();
    }
    expect(tester.takeException(), isNull);
  });

  testWidgets('an account switch with the tab still mounted drops the old figures and reads the new agent\'s', (tester) async {
    await open(tester);
    api.answer(0, todayStats);
    await flush(tester);
    expect(find.bySemanticsLabel('Dials: 52'), findsOneWidget);

    ProviderScope.containerOf(tester.element(find.byType(PerformanceScreen))).read(testWorkspaceProvider.notifier).set('u1:t2:a2');
    await flush(tester);
    expect(find.bySemanticsLabel('Dials: 52'), findsNothing);
    expect(find.byKey(const Key('performance-skeleton')), findsOneWidget);
    expect(api.statsQueries, hasLength(2));
    expect(api.campaignReads, 2);

    api.answer(1, stats(from: todayStats.from, to: fixedNow, t: totals(attempts: 7)));
    await flush(tester);
    expect(find.bySemanticsLabel('Dials: 7'), findsOneWidget);
  });

  testWidgets('the campaign scope is a 48 dp target, and fits at 200% text', (tester) async {
    api.campaigns = [staffing('c1', 'Q4 Card Renewals'), staffing('c2', 'Gold upgrades — festive season top-up campaign')];
    for (final scale in [1.0, 2.0]) {
      await setPhoneSize(tester);
      await tester.pumpWidget(harness(const PerformanceScreen(), perfOverrides(api), textScale: scale));
      await flush(tester);
      final scope = find.byKey(const Key('campaign-scope'));
      expect(scope, findsOneWidget);
      expect(tester.getSize(scope).height, greaterThanOrEqualTo(48), reason: 'at ${scale}x');
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
    }
  });
}
