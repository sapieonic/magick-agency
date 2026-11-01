import 'package:agency_wire/agency_wire.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:magick_agency_agent/features/performance/logic/bucket_series.dart';

import 'support.dart';

void main() {
  group('niceCeiling (the console\'s axis top)', () {
    test('never below 2, always even', () {
      expect([0, 1, 2, 3, 5, 7, 9].map(niceCeiling), [2, 2, 2, 4, 6, 8, 10]);
    });

    test('clean rungs on the 1/2/3/4/5/6/8/10 ladder', () {
      expect([10, 11, 37, 41, 516, 1000, 1001].map(niceCeiling), [10, 20, 40, 50, 600, 1000, 2000]);
    });
  });

  group('bucketSeries', () {
    test('keeps the server order, labels by day of month and finds the max', () {
      final s = bucketSeries([bucket('2026-10-12', 40, 12), bucket('2026-10-13', 55, 20)]);
      expect(s.points.map((p) => p.label), ['12', '13']);
      expect(s.points.map((p) => p.title), ['12 Oct', '13 Oct']);
      expect(s.max, 55);
      expect(s.top, 60);
      expect(s.drawable, isTrue);
    });

    test('one day is not a chart; an empty range still has a max of 1', () {
      expect(bucketSeries([bucket('2026-10-14', 3, 1)]).drawable, isFalse);
      final empty = bucketSeries(const []);
      expect(empty.drawable, isFalse);
      expect(empty.max, 1);
    });

    test('a date that does not exist is shown as sent', () {
      final s = bucketSeries([bucket('2026-02-30', 1, 0)]);
      expect(s.points.single.label, '2026-02-30');
    });

    test('a to-date window: the first day is an edge, today is still going', () {
      final s = bucketSeries(
        [bucket('2026-10-12', 1, 0), bucket('2026-10-13', 1, 0), bucket('2026-10-14', 1, 0)],
        firstDay: const CalendarDate(2026, 10, 12),
        lastDay: const CalendarDate(2026, 10, 14),
        inProgress: true,
      );
      expect(s.points.map((p) => p.coverage), [BucketCoverage.edge, BucketCoverage.whole, BucketCoverage.soFar]);
      expect(pointSummary(s.points.last), '14 Oct: 1 dials, 0 conversations (still going)');
      expect(s.hasPartial, isTrue);
    });

    test('a completed window: both ends are edges; a campaign-day outside the reader\'s days too', () {
      final s = bucketSeries(
        [bucket('2026-10-04', 2, 1), bucket('2026-10-05', 9, 3), bucket('2026-10-08', 9, 3), bucket('2026-10-11', 4, 2)],
        firstDay: const CalendarDate(2026, 10, 5),
        lastDay: const CalendarDate(2026, 10, 11),
      );
      expect(s.points.map((p) => p.coverage),
          [BucketCoverage.edge, BucketCoverage.edge, BucketCoverage.whole, BucketCoverage.edge]);
    });

    test('a to-date window whose last call was days ago has no "still going" bar', () {
      final s = bucketSeries(
        [bucket('2026-10-12', 1, 0), bucket('2026-10-13', 1, 0)],
        firstDay: const CalendarDate(2026, 10, 12),
        lastDay: const CalendarDate(2026, 10, 16),
        inProgress: true,
      );
      expect(s.points.map((p) => p.coverage), [BucketCoverage.edge, BucketCoverage.whole]);
    });
  });

  group('ChartLayout (scales to the window)', () {
    test('a week: bars hit the 24 px ceiling and centre in their bands', () {
      final l = ChartLayout(width: 700, count: 7);
      expect(l.bandWidth, 100);
      expect(l.barWidth, ChartLayout.maxBar);
      expect(l.groupStart(0), (100 - (24 * 2 + 2)) / 2);
      expect(l.groupCentre(3), 350);
      expect(l.labelEvery, 1);
    });

    test('a month on a phone: bars narrow, labels thin out, never below 2 px', () {
      final l = ChartLayout(width: 300, count: 31);
      expect(l.barWidth, closeWithin(2.0, 3.0));
      expect(l.labelEvery, greaterThan(1));
      expect(ChartLayout(width: 50, count: 31).barWidth, 2);
    });

    test('tap positions map to the day under the finger, clamped', () {
      final l = ChartLayout(width: 310, count: 31);
      expect(l.indexAt(0), 0);
      expect(l.indexAt(15), 1);
      expect(l.indexAt(-20), 0);
      expect(l.indexAt(5000), 30);
    });

    test('bar heights are proportional to the axis top', () {
      expect(ChartLayout.barHeight(30, 60, 120), 60);
      expect(ChartLayout.barHeight(60, 60, 120), 120);
      expect(ChartLayout.barHeight(0, 60, 120), 0);
    });
  });

  test('the accessible summaries', () {
    final s = bucketSeries([bucket('2026-10-12', 142, 54), bucket('2026-10-13', 1200, 400)]);
    expect(chartSummary(s), 'Dials and conversations by day, 2 days, up to 2,000 calls a day.');
    expect(pointSummary(s.points.first), '12 Oct: 142 dials, 54 conversations');
  });
}

Matcher closeWithin(double lo, double hi) => inInclusiveRange(lo, hi);
