import 'package:flutter_test/flutter_test.dart';
import 'package:magick_agency_agent/features/performance/logic/stats_windows.dart';

import 'support.dart';

/// `2026-10-12T00:00` on the IST wall clock, as an instant.
DateTime istAt(int y, int m, int d, [int h = 0, int min = 0]) =>
    DateTime.utc(y, m, d, h, min).subtract(const Duration(hours: 5, minutes: 30));

DateTime edtAt(int y, int m, int d, [int h = 0, int min = 0]) =>
    DateTime.utc(y, m, d, h, min).add(const Duration(hours: 4));

void main() {
  group('windowRange (weeks start Monday, reader\'s calendar)', () {
    // Wednesday 14 Oct 2026, 10:30 IST.
    final now = istAt(2026, 10, 14, 10, 30);

    test('today, this week, this month end at now', () {
      expect(windowRange(StatsWindow.today, now, calendar: ist), StatsRange(istAt(2026, 10, 14), now));
      expect(windowRange(StatsWindow.week, now, calendar: ist), StatsRange(istAt(2026, 10, 12), now));
      expect(windowRange(StatsWindow.month, now, calendar: ist), StatsRange(istAt(2026, 10, 1), now));
    });

    test('last week and last month are closed and end where the current period starts', () {
      final lastWeek = windowRange(StatsWindow.lastWeek, now, calendar: ist);
      final lastMonth = windowRange(StatsWindow.lastMonth, now, calendar: ist);
      expect(lastWeek, StatsRange(istAt(2026, 10, 5), istAt(2026, 10, 12)));
      expect(lastMonth, StatsRange(istAt(2026, 9, 1), istAt(2026, 10, 1)));
      // They tile with their to-date siblings: no dial in both, none in neither.
      expect(lastWeek.to, windowRange(StatsWindow.week, now, calendar: ist).from);
      expect(lastMonth.to, windowRange(StatsWindow.month, now, calendar: ist).from);
    });

    test('on a Monday just after midnight, today and this week coincide', () {
      final monday = istAt(2026, 10, 12, 0, 1);
      expect(windowRange(StatsWindow.today, monday, calendar: ist).from, istAt(2026, 10, 12));
      expect(windowRange(StatsWindow.week, monday, calendar: ist).from, istAt(2026, 10, 12));
      expect(windowRange(StatsWindow.lastWeek, monday, calendar: ist), StatsRange(istAt(2026, 10, 5), istAt(2026, 10, 12)));
    });

    test('on a Sunday the week began six days earlier (not that morning)', () {
      final sunday = istAt(2026, 10, 18, 23, 59);
      expect(windowRange(StatsWindow.week, sunday, calendar: ist).from, istAt(2026, 10, 12));
    });

    test('a week that starts in the previous month', () {
      final thu = istAt(2026, 10, 1, 9);
      expect(windowRange(StatsWindow.week, thu, calendar: ist).from, istAt(2026, 9, 28));
      expect(windowRange(StatsWindow.lastWeek, thu, calendar: ist), StatsRange(istAt(2026, 9, 21), istAt(2026, 9, 28)));
    });

    test('a 1st that is a Monday: all three to-date windows start together', () {
      final firstMonday = istAt(2027, 2, 1, 8);
      final starts = {
        for (final w in primaryWindows) windowRange(w, firstMonday, calendar: ist).from,
      };
      expect(starts, {istAt(2027, 2, 1)});
    });

    test('month ends: last month from 31 March is February, from January is last December', () {
      expect(
        windowRange(StatsWindow.lastMonth, istAt(2026, 3, 31, 22), calendar: ist),
        StatsRange(istAt(2026, 2, 1), istAt(2026, 3, 1)),
      );
      expect(
        windowRange(StatsWindow.lastMonth, istAt(2027, 1, 15), calendar: ist),
        StatsRange(istAt(2026, 12, 1), istAt(2027, 1, 1)),
      );
      // A leap February.
      expect(windowRange(StatsWindow.month, istAt(2028, 2, 29, 12), calendar: ist).from, istAt(2028, 2, 1));
    });

    test('the same instant falls in different weeks east and west of Greenwich', () {
      // Monday 08:30 in India is still Sunday 23:00 in New York.
      final instant = DateTime.utc(2026, 10, 12, 3);
      expect(windowRange(StatsWindow.week, instant, calendar: ist).from, istAt(2026, 10, 12));
      expect(windowRange(StatsWindow.week, instant, calendar: edt).from, edtAt(2026, 10, 5));
      expect(windowRange(StatsWindow.today, instant, calendar: edt).from, edtAt(2026, 10, 11));
    });

    test('the device calendar uses local midnights', () {
      final now = DateTime(2026, 10, 14, 10, 30);
      expect(windowRange(StatsWindow.today, now).from, DateTime(2026, 10, 14));
      expect(windowRange(StatsWindow.week, now).from, DateTime(2026, 10, 12));
    });

    test('labels are the console\'s and only to-date windows are in progress', () {
      expect(StatsWindow.values.map((w) => w.label), ['Today', 'This week', 'Last week', 'This month', 'Last month']);
      expect(StatsWindow.values.where((w) => w.inProgress), primaryWindows);
    });
  });

  group('windowRangeReadout', () {
    test('one day, with its zone', () {
      expect(windowRangeReadout(istAt(2026, 10, 14), istAt(2026, 10, 14, 10, 30), calendar: ist),
          '14 Oct 2026 · IST (UTC+05:30)');
    });

    test('the exclusive end is not shown as a day of the range', () {
      expect(windowRangeReadout(istAt(2026, 10, 5), istAt(2026, 10, 12), calendar: ist),
          '5 Oct – 11 Oct 2026 · IST (UTC+05:30)');
    });

    test('both years only when the range straddles one', () {
      expect(windowRangeReadout(istAt(2026, 12, 28), istAt(2027, 1, 4), calendar: ist),
          '28 Dec 2026 – 3 Jan 2027 · IST (UTC+05:30)');
    });

    test('an empty or inverted range has no caption', () {
      expect(windowRangeReadout(istAt(2026, 10, 5), istAt(2026, 10, 5), calendar: ist), isNull);
      expect(windowRangeReadout(istAt(2026, 10, 6), istAt(2026, 10, 5), calendar: ist), isNull);
    });

    test('west of Greenwich the days are the reader\'s', () {
      expect(windowRangeReadout(edtAt(2026, 10, 5), edtAt(2026, 10, 12), calendar: edt),
          '5 Oct – 11 Oct 2026 · EDT (UTC-04:00)');
    });
  });

  test('formatUtcOffset', () {
    expect(formatUtcOffset(Duration.zero), 'UTC');
    expect(formatUtcOffset(const Duration(hours: 5, minutes: 30)), 'UTC+05:30');
    expect(formatUtcOffset(const Duration(hours: -3, minutes: -30)), 'UTC-03:30');
  });
}
