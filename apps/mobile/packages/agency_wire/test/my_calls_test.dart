// My calls (docs/call-log.md §7): the agent's own calls of every type, as the
// app decodes them from packages/contracts/fixtures/agent/reads.json.

import 'package:agency_wire/agency_wire.dart';
import 'package:test/test.dart';

import 'support/fixtures.dart';

void main() {
  group('GET /proxy/agency/my-calls', () {
    test('decodes every type on one page, with what the agent still owes', () {
      final p = MyCallsPage.fromJson(fixture('reads.json', 'my_calls'));
      expect(p.rows.map((r) => r.type), [
        CallLogType.inbound,
        CallLogType.softPhone,
        CallLogType.inbound,
        CallLogType.softPhone,
        CallLogType.softPhone,
        CallLogType.inbound,
        CallLogType.dialler,
        CallLogType.dialler,
      ]);
      expect(p.hasMore, isTrue);
      expect(p.counts, const MyCallsCounts(toFollowUp: 5, missedOpen: 3, callbacksDue: 2));
      expect(p.callbacksDue, isNull);
    });

    test('an answered inbound call: the campaign, the customer, the outcome in its words', () {
      final r = MyCallsPage.fromJson(fixture('reads.json', 'my_calls')).rows.first;
      expect(r.campaignName, 'Diwali EMI Collections');
      expect(r.customerName, 'Sunita Deshmukh');
      expect(r.outcomeRaw, 'answered');
      expect(r.isMissed, isFalse);
      expect(r.dispositionLabel, 'Will pay');
      expect(r.promiseDate, '2026-11-25');
      expect(r.talkSeconds, 252);
      expect(r.waitSeconds, 18);
    });

    test('a number its campaign hides arrives masked, and is kept as it arrived', () {
      final rows = MyCallsPage.fromJson(fixture('reads.json', 'my_calls')).rows;
      final masked = rows.where((r) => r.phoneMasked).toList();
      expect(masked, isNotEmpty);
      for (final r in masked) {
        expect(r.phone, contains('•'));
        expect(r.phone, isNot(startsWith('+')));
      }
      final full = rows.firstWhere((r) => !r.phoneMasked);
      expect(full.phone, startsWith('+91'));
    });

    test('a call back and the missed call it rang back point at each other', () {
      final rows = MyCallsPage.fromJson(fixture('reads.json', 'my_calls')).rows;
      final back = rows[1];
      final missed = rows[2];
      expect(back.callbackOf!.inboundCallId, missed.id);
      expect(back.callbackOf!.arrivedAt, missed.createdAt);
      expect(missed.calledBack!.callId, back.id);
      expect(missed.isMissed, isTrue);
      expect(missed.isToFollowUp, isTrue);
      expect(missed.followUp!.reason, InboundMissedReason.overflow);
      expect(missed.voicemailSeconds, 22);
    });

    test('a soft-phone call that never dialled, and a dialler redial with an automatic outcome', () {
      final rows = MyCallsPage.fromJson(fixture('reads.json', 'my_calls')).rows;
      expect(rows[3].neverDialled, isFalse);
      expect(rows[4].neverDialled, isTrue);
      expect(rows[6].attemptNumber, 1);
      expect(rows[7].redial, isTrue);
      expect(rows[7].autoDispositionCode, 'no_answer');
      expect(rows[7].dispositionCode, isNull);
    });

    test('To follow up: the open missed calls, then the callbacks due', () {
      final p = MyCallsPage.fromJson(fixture('reads.json', 'my_calls_to_follow_up'));
      expect(p.rows.every((r) => r.isToFollowUp), isTrue);
      expect(p.rows.last.phone, isNull);
      expect(p.rows.last.followUp!.closedCause, InboundClosedCause.hours);
      expect(p.callbacksDue, hasLength(2));
      expect(p.callbacksDue!.first.customerName, 'Anjali Verma');
      expect(p.callbacksDue!.first.overdue, isTrue);
      expect(p.callbacksDue!.last.campaignName, isNull);
      expect(p.hasMore, isFalse);
    });

    test('a page with no counts decodes', () {
      final p = MyCallsPage.fromJson(fixture('reads.json', 'my_calls_last_page'));
      expect(p.counts, isNull);
      expect(p.rows, hasLength(1));
    });

    test('a type the app does not know is kept as unknown, with its word', () {
      final json = Map<String, Object?>.of(fixture('reads.json', 'my_calls_last_page'));
      final row = Map<String, Object?>.of((json['rows']! as List<Object?>).first! as Map<String, Object?>)..['type'] = 'video';
      json['rows'] = [row];
      final r = MyCallsPage.fromJson(json).rows.single;
      expect(r.type, CallLogType.unknown);
      expect(r.typeRaw, 'video');
    });

    test('a row with no `phone_masked` is refused, never read as unmasked', () {
      final json = Map<String, Object?>.of(fixture('reads.json', 'my_calls_last_page'));
      final row = Map<String, Object?>.of((json['rows']! as List<Object?>).first! as Map<String, Object?>)..remove('phone_masked');
      json['rows'] = [row];
      expect(() => MyCallsPage.fromJson(json), throwsA(isA<WireFormatException>()));
    });
  });

  group('the query', () {
    test('All is no type; the chips, the campaign, the cursor and the counts are sent', () {
      expect(const MyCallsQuery().toQuery(), isEmpty);
      expect(
        const MyCallsQuery(
          type: MyCallsTypeFilter.toFollowUp,
          campaignId: callsNoCampaign,
          cursor: 'c',
          limit: 30,
          includeCounts: true,
        ).toQuery(),
        {'type': 'to_follow_up', 'campaign_id': 'none', 'cursor': 'c', 'limit': '30', 'include_counts': '1'},
      );
    });

    test('the chips are in their order: To follow up first', () {
      expect(MyCallsTypeFilter.values.map((v) => v.wire), ['to_follow_up', 'all', 'dialler', 'soft_phone', 'inbound']);
    });
  });

  group('a callback due', () {
    final now = DateTime.utc(2026, 11, 22, 15, 48);
    String label(DateTime due) => callbackDueLabel(due, now, '4:00 PM');

    test('is due at a time, or late by how long (the contract\'s cases)', () {
      expect(label(DateTime.utc(2026, 11, 22, 16)), 'Due 4:00 PM');
      expect(label(now), 'Due 4:00 PM');
      expect(label(DateTime.utc(2026, 11, 22, 15, 47, 30)), 'Late by less than a minute');
      expect(label(DateTime.utc(2026, 11, 22, 15, 47)), 'Late by 1 minute');
      expect(label(DateTime.utc(2026, 11, 22, 15, 28)), 'Late by 20 minutes');
      expect(label(DateTime.utc(2026, 11, 22, 14, 48)), 'Late by 1 hour');
      expect(label(DateTime.utc(2026, 11, 22, 13, 45)), 'Late by 2 hours');
      expect(label(DateTime.utc(2026, 11, 21, 15, 48)), 'Late by 1 day');
      expect(label(DateTime.utc(2026, 11, 19, 10)), 'Late by 3 days');
    });
  });
}
