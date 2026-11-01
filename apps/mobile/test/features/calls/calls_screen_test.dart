import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:magick_agency_agent/features/calls/calls_screen.dart';

import 'support.dart';

void main() {
  late FakeAttemptsApi api;
  late FakePerformanceApi perf;

  setUp(() {
    api = FakeAttemptsApi();
    perf = FakePerformanceApi(campaigns: [staffing('c1', 'Q4 Card Renewals'), staffing('c2', 'Gold upgrades')]);
  });

  Future<void> open(WidgetTester tester) async {
    await setPhoneSize(tester);
    await tester.pumpWidget(harness(const CallsScreen(), callsOverrides(api, perf)));
    await tester.pump(); // the arrival read
  }

  testWidgets('skeleton, then rows with the console\'s words, then the end of the list', (tester) async {
    await open(tester);
    expect(find.byKey(const Key('attempts-skeleton')), findsOneWidget);
    expect(api.queries, hasLength(1));
    api.answer(0, page([1, 2, 3]));
    await flush(tester);

    expect(find.text('+91 98400 10001'), findsOneWidget);
    expect(find.text('Connected'), findsNWidgets(3));
    expect(find.text('Showing 3 calls'), findsOneWidget);
    expect(find.textContaining('Q4 Card Renewals · try 2 · 3:41'), findsNWidgets(3));
    expect(find.byKey(const Key('attempts-end')), findsOneWidget);
    expect(api.queries, hasLength(1)); // last page: nothing to prefetch
  });

  testWidgets('a short page with more behind it fetches the next one straight away', (tester) async {
    await open(tester);
    api.answer(0, page([1, 2, 3, 4, 5], next: 'cur-1'));
    await flush(tester);
    expect(api.queries, hasLength(2));
    expect(api.q(1)['cursor'], 'cur-1');
    api.answer(1, page([6, 7]));
    await flush(tester);
    expect(find.text('Showing 7 calls'), findsOneWidget);
    expect(api.queries, hasLength(2));
  });

  testWidgets('a long list prefetches before the end, not at it', (tester) async {
    await open(tester);
    api.answer(0, page(List.generate(50, (i) => i), next: 'cur-1'));
    await flush(tester);
    expect(api.queries, hasLength(1)); // the end is far away

    // Scroll until the prefetch fires, and check rows were still left below.
    final list = find.byKey(const Key('attempts-list'));
    var guard = 0;
    while (api.queries.length == 1 && guard++ < 40) {
      await tester.drag(list, const Offset(0, -300));
      await tester.pump();
    }
    expect(api.queries, hasLength(2));
    expect(api.q(1)['cursor'], 'cur-1');
    expect(find.text('+91 98400 10049'), findsNothing); // the last row is not on screen yet
  });

  testWidgets('the number search waits for a pause in typing, then reads once', (tester) async {
    await open(tester);
    api.answer(0, page([1, 2]));
    await flush(tester);

    final field = find.byKey(const Key('phone-search'));
    for (final s in ['9', '98', '984', '9840']) {
      await tester.enterText(field, s);
      await tester.pump(const Duration(milliseconds: 100));
    }
    expect(api.queries, hasLength(1));
    expect(find.text('+91 98400 10001'), findsOneWidget); // the list has not moved

    await tester.pump(const Duration(milliseconds: 400));
    expect(api.queries, hasLength(2));
    expect(api.q(1)['phone'], '9840');
    expect(api.q(1).containsKey('cursor'), isFalse);
    api.answer(1, page([2]));
    await flush(tester);
    expect(find.text('Showing 1 call'), findsOneWidget);

    // No digit: said here, not sent.
    await tester.enterText(field, 'abc');
    await tester.pump(const Duration(seconds: 1));
    expect(find.textContaining('Type at least one digit'), findsOneWidget);
    expect(api.queries, hasLength(2));
  });

  testWidgets('an empty filtered list says how to widen it', (tester) async {
    await open(tester);
    api.answer(0, page([]));
    await flush(tester);
    expect(find.text('No calls match those filters'), findsOneWidget);
    expect(find.text('Widen the days or clear the filters to see every call on record.'), findsOneWidget);
  });

  testWidgets('a failed read offers a retry', (tester) async {
    await open(tester);
    api.fail(0);
    await flush(tester);
    expect(find.byKey(const Key('attempts-error')), findsOneWidget);
    await tester.tap(find.text('Try again'));
    await tester.pump();
    expect(api.queries, hasLength(2));
    api.answer(1, page([1]));
    await flush(tester);
    expect(find.text('+91 98400 10001'), findsOneWidget);
  });

  testWidgets('outcome chips apply together and restart the list', (tester) async {
    await open(tester);
    api.answer(0, page([1], next: null));
    await flush(tester);
    await tester.tap(find.byKey(const Key('filter-outcome')));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Busy'));
    await tester.tap(find.text('No answer'));
    await tester.pump();
    expect(api.queries, hasLength(1)); // nothing until Apply
    await tester.tap(find.byKey(const Key('outcome-apply')));
    await tester.pumpAndSettle();
    expect(api.q(1)['outcome'], 'no_answer,busy');
    expect(find.text('2 outcomes'), findsOneWidget);
  });

  testWidgets('the campaign chip scopes the list; Clear removes every filter', (tester) async {
    await open(tester);
    api.answer(0, page([1]));
    await flush(tester);
    await tester.ensureVisible(find.byKey(const Key('filter-campaign')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('filter-campaign')));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Gold upgrades'));
    await tester.pumpAndSettle();
    expect(api.q(1)['campaign_id'], 'c2');
    api.answer(1, page([1]));
    await flush(tester);

    await tester.ensureVisible(find.byKey(const Key('filter-clear')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('filter-clear')));
    await tester.pump();
    expect(api.q(2).keys, ['limit']);
    expect(find.text('Any day'), findsOneWidget);
  });

  testWidgets('tapping a call opens everything it carries, and no recording', (tester) async {
    await open(tester);
    api.answer(0, page([1]));
    await flush(tester);
    await tester.tap(find.text('+91 98400 10001'));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('attempt-detail')), findsOneWidget);
    expect(find.text('Where it got to'), findsOneWidget);
    await tester.dragUntilVisible(find.text('Called from'), find.byKey(const Key('attempt-detail')), const Offset(0, -200));
    expect(find.text('Called from'), findsOneWidget);
    expect(find.textContaining('Recording'), findsNothing);
  });

  testWidgets('at 200% text rows keep one height and nothing overflows', (tester) async {
    await setPhoneSize(tester);
    await tester.pumpWidget(harness(const CallsScreen(), callsOverrides(api, perf), textScale: 2));
    await tester.pump();
    api.answer(0, page([1, 2, 3]));
    await flush(tester);
    expect(tester.takeException(), isNull);
    final a = tester.getSize(find.byKey(const ValueKey('a1')));
    final b = tester.getSize(find.byKey(const ValueKey('a2')));
    expect(a.height, b.height);
  });

  testWidgets('an account switch with the tab still mounted drops the old numbers and names, then reads the new agent\'s', (tester) async {
    await open(tester);
    api.answer(0, page([1, 2, 3]));
    await flush(tester);
    expect(find.text('+91 98400 10001'), findsOneWidget);
    expect(find.textContaining('Q4 Card Renewals'), findsNWidgets(3));
    expect(perf.campaignReads, 1);

    // The shell's indexed stack keeps this screen alive; another agent signs in.
    perf.campaigns = [staffing('c1', 'Diwali Offers')];
    ProviderScope.containerOf(tester.element(find.byType(CallsScreen))).read(testWorkspaceProvider.notifier).set('u2:t1:a1');
    await flush(tester);
    expect(find.text('+91 98400 10001'), findsNothing);
    expect(find.byKey(const Key('attempts-skeleton')), findsOneWidget);
    expect(api.queries, hasLength(2));

    api.answer(1, page([5]));
    await flush(tester);
    expect(find.text('+91 98400 10005'), findsOneWidget);
    expect(perf.campaignReads, 2);
    expect(find.textContaining('Diwali Offers'), findsOneWidget);
    expect(find.textContaining('Q4 Card Renewals'), findsNothing);
  });
}
