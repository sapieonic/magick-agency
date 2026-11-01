import 'package:agency_wire/agency_wire.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:magick_agency_agent/app/theme/app_theme.dart';
import 'package:magick_agency_agent/app/theme/tokens.dart';
import 'package:magick_agency_agent/features/performance/logic/bucket_series.dart';
import 'package:magick_agency_agent/features/performance/widgets/bucket_chart.dart';

import 'support.dart';

Widget _wrap(Widget child) => MaterialApp(
      theme: buildTheme(AppTokens.dark, Brightness.dark),
      home: Scaffold(body: SingleChildScrollView(padding: const EdgeInsets.all(16), child: child)),
    );

void main() {
  final series = bucketSeries(
    [bucket('2026-10-12', 40, 12), bucket('2026-10-13', 50, 20), bucket('2026-10-14', 52, 22)],
    firstDay: const CalendarDate(2026, 10, 12),
    lastDay: const CalendarDate(2026, 10, 14),
    inProgress: true,
  );

  testWidgets('screen readers get a summary and one node per day', (tester) async {
    final handle = tester.ensureSemantics();
    await tester.pumpWidget(_wrap(BucketChart(series: series)));
    expect(find.bySemanticsLabel('Dials and conversations by day, 3 days, up to 60 calls a day.'), findsOneWidget);
    final labels = <String>[];
    void walk(SemanticsNode n) {
      if (n.label.isNotEmpty) labels.add(n.label);
      n.visitChildren((c) {
        walk(c);
        return true;
      });
    }

    walk(tester.getSemantics(find.byKey(const Key('bucket-chart'))));
    expect(
      labels,
      containsAll(<String>[
        '12 Oct: 40 dials, 12 conversations (may be a part-day)',
        '13 Oct: 50 dials, 20 conversations',
        '14 Oct: 52 dials, 22 conversations (still going)',
      ]),
    );
    handle.dispose();
  });

  testWidgets('tapping a day labels it; tapping it again clears the label', (tester) async {
    await tester.pumpWidget(_wrap(BucketChart(series: series)));
    final rect = tester.getRect(find.byKey(const Key('bucket-chart')));
    final plotLeft = rect.left + BucketChartPainter.padLeft;
    final plotWidth = rect.width - BucketChartPainter.padLeft - BucketChartPainter.padRight;
    final lastDay = Offset(plotLeft + plotWidth * 5 / 6, rect.center.dy);
    await tester.tapAt(lastDay);
    await tester.pump();
    expect(find.text('14 Oct: 52 dials, 22 conversations (still going)'), findsOneWidget);
    await tester.tapAt(lastDay);
    await tester.pump();
    expect(find.text('Tap a day to see its numbers.'), findsOneWidget);
  });

  testWidgets('the numbers are one tap away, with part-days marked', (tester) async {
    await tester.pumpWidget(_wrap(BucketChart(series: series)));
    expect(find.byKey(const Key('bucket-chart-table')), findsNothing);
    await tester.tap(find.text('Show the numbers'));
    await tester.pump();
    expect(find.byKey(const Key('bucket-chart-table')), findsOneWidget);
    expect(find.text('12 Oct *'), findsOneWidget);
    expect(find.text('13 Oct'), findsOneWidget);
    expect(find.text('Hide the numbers'), findsOneWidget);
  });

  testWidgets('a single day explains itself instead of drawing one column', (tester) async {
    await tester.pumpWidget(_wrap(BucketChart(series: bucketSeries([bucket('2026-10-14', 3, 1)]))));
    expect(find.text(singleBucketNote), findsOneWidget);
    expect(find.byKey(const Key('bucket-chart')), findsNothing);
  });

  test('the painter repaints only when what it draws changes', () {
    BucketChartPainter painter(int? selected, BucketSeries s) => BucketChartPainter(
          series: s,
          selected: selected,
          dials: AppTokens.dark.accent,
          conversations: AppTokens.dark.ember,
          grid: AppTokens.dark.border,
          axis: AppTokens.dark.borderStrong,
          highlight: AppTokens.dark.bgTertiary,
          tickStyle: const TextStyle(),
          valueStyle: const TextStyle(),
          textScaler: TextScaler.noScaling,
        );
    final same = bucketSeries([bucket('2026-10-12', 40, 12), bucket('2026-10-13', 50, 20), bucket('2026-10-14', 52, 22)],
        firstDay: const CalendarDate(2026, 10, 12), lastDay: const CalendarDate(2026, 10, 14), inProgress: true);
    expect(painter(null, series).shouldRepaint(painter(null, same)), isFalse);
    expect(painter(1, series).shouldRepaint(painter(null, series)), isTrue);
    expect(painter(1, series).indexAt(BucketChartPainter.padLeft + 1, 340), 0);
    expect(columnPath(0, 0, 10, 0), isNull);
    expect(columnPath(0, 0, 10, 2)!.getBounds(), const Rect.fromLTWH(0, 0, 10, 2));
  });
}
