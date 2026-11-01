import 'package:agency_wire/agency_wire.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:magick_agency_agent/features/calls/logic/attempt_filters.dart';

import 'support.dart';

void main() {
  // Wed 14 Oct 2026, 10:30 IST.
  final now = fixedNow;

  group('AttemptFilters.toQuery', () {
    test('a fresh list asks for today, inclusive, on the reader\'s calendar', () {
      final q = AttemptFilters.initial.toQuery(limit: 50, now: now, calendar: ist).toQuery();
      expect(q, {
        'limit': '50',
        'from': '2026-10-13T18:30:00.000Z', // 14 Oct 00:00 IST
        'to': '2026-10-14T18:29:59.999Z', // 14 Oct 23:59:59.999 IST
      });
    });

    test('a day range includes its last day', () {
      const f = AttemptFilters(days: DayRange(CalendarDate(2026, 9, 28), CalendarDate(2026, 10, 2)));
      final q = f.toQuery(limit: 50, now: now, calendar: ist).toQuery();
      expect(q['from'], '2026-09-27T18:30:00.000Z');
      expect(q['to'], '2026-10-02T18:29:59.999Z');
    });

    test('a range ending on the last day of a month rolls into the next correctly', () {
      final r = attemptDateRange(const CalendarDate(2026, 2, 28), const CalendarDate(2026, 2, 28), calendar: edt);
      expect(r.from, DateTime.utc(2026, 2, 28, 4));
      expect(r.to, DateTime.utc(2026, 3, 1, 4).subtract(const Duration(milliseconds: 1)));
    });

    test('outcomes go comma-joined in a stable order; campaign, phone and cursor as given', () {
      const f = AttemptFilters(
        outcomes: {AttemptOutcome.busy, AttemptOutcome.connected},
        campaignId: 'c1',
        phone: '12345',
      );
      final q = f.toQuery(cursor: 'abc', limit: 50, now: now, calendar: ist).toQuery();
      expect(q, {'cursor': 'abc', 'limit': '50', 'campaign_id': 'c1', 'outcome': 'connected,busy', 'phone': '12345'});
    });

    test('any day sends no window', () {
      final q = const AttemptFilters().toQuery(limit: 50, now: now, calendar: ist).toQuery();
      expect(q.keys, ['limit']);
    });
  });

  group('what counts as filtered (the console\'s rule: phone counts)', () {
    test('nothing applied', () {
      expect(const AttemptFilters().isFiltered, isFalse);
      expect(const AttemptFilters().groupCount, 0);
    });

    test('each group counts once', () {
      const f = AttemptFilters(
        days: TodayOnly(),
        outcomes: {AttemptOutcome.busy, AttemptOutcome.failed},
        campaignId: 'c1',
        phone: '98400',
      );
      expect(f.isFiltered, isTrue);
      expect(f.groupCount, 4);
      expect(const AttemptFilters(phone: '1').isFiltered, isTrue);
    });
  });

  test('value equality, so an unchanged filter set is not a new query', () {
    expect(
      const AttemptFilters(outcomes: {AttemptOutcome.busy, AttemptOutcome.failed}, phone: '1'),
      const AttemptFilters(outcomes: {AttemptOutcome.failed, AttemptOutcome.busy}, phone: '1'),
    );
    expect(const AttemptFilters(days: TodayOnly()), isNot(const AttemptFilters()));
    expect(AttemptFilters.initial.copyWith(campaignId: 'c').copyWith(clearCampaign: true), AttemptFilters.initial);
  });

  group('the number search', () {
    test('trimmed; empty is no search', () {
      expect(normalisePhone('  98400 '), '98400');
      expect(normalisePhone('   '), isNull);
    });

    test('a term with no digit is refused here instead of by a 400', () {
      expect(phoneSearchProblem('abc'), isNotNull);
      expect(phoneSearchProblem('+'), isNotNull);
      expect(phoneSearchProblem(''), isNull);
      expect(phoneSearchProblem('+91 98400'), isNull);
    });
  });

  test('chip labels', () {
    expect(dayFilterLabel(const AnyDay()), 'Any day');
    expect(dayFilterLabel(const TodayOnly()), 'Today');
    expect(dayFilterLabel(const DayRange(CalendarDate(2026, 10, 12), CalendarDate(2026, 10, 12))), '12 Oct');
    expect(dayFilterLabel(const DayRange(CalendarDate(2026, 10, 12), CalendarDate(2026, 10, 18))), '12 Oct – 18 Oct');
  });
}
