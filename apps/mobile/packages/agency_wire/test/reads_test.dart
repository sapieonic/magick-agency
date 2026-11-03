import 'package:agency_wire/agency_wire.dart';
import 'package:test/test.dart';

import 'support/fixtures.dart';

void main() {
  test('my-assignments: null names and unknown statuses are kept, not dropped', () {
    final a = MyAssignments.fromJson(fixture('reads.json', 'my_assignments')).assignments;
    expect(a, hasLength(3));
    expect(a[0].campaignStatus, CampaignStatus.running);
    expect(a[1].campaignName, isNull);
    expect(a[1].campaignStatus, isNull);
    expect(a[2].campaignStatus, CampaignStatus.unknown);
    expect(a[2].campaignStatusRaw, 'archived_by_ops');
    expect(MyAssignments.fromJson(fixture('reads.json', 'my_assignments_empty')).assignments, isEmpty);
  });

  test('my-campaigns reads `assignments`, with ended staffings', () {
    final h = StaffingHistory.fromJson(fixture('reads.json', 'my_campaigns')).assignments;
    expect(h.map((e) => e.active), [true, false]);
    expect(h[1].unassignedAt, DateTime.utc(2026, 9, 30, 12));
  });

  group('my-stats', () {
    test('totals, rates, talk and wrap-up, daily buckets', () {
      final s = AgentStats.fromJson(fixture('reads.json', 'my_stats'));
      expect(s.bucket, StatsBucketUnit.day);
      expect(s.totals.attempts, 212);
      expect(s.totals.connectRatePct, closeTo(41.04, 0.01));
      expect(s.totals.successRatePct, closeTo(21.84, 0.01));
      expect(s.totals.talkSeconds, 15672.4);
      expect(s.totals.wrapupSeconds, 2610);
      expect(s.totals.ahtSeconds, closeTo(210.14, 0.01));
      expect(s.totals.occupancy!.secondsIn(AgentState.onBreak), 21318);
      expect(s.totals.occupancy!.isUnmeasured, isFalse);
      expect(s.buckets.map((b) => b.bucketStart.toString()), ['2026-10-27', '2026-10-28']);
      expect(s.buckets.first.bucketStart.toLocalDateTime(), DateTime(2026, 10, 27));
      expect(s.byCampaign.map((r) => r.attempts).reduce((a, b) => a + b), s.totals.attempts);
      expect(s.isEmpty, isFalse);
    });

    test('null rates mean not measured, and all-zero occupancy is unmeasured', () {
      final s = AgentStats.fromJson(fixture('reads.json', 'my_stats_unmeasured'));
      expect(s.totals.connectRatePct, isNull);
      expect(s.totals.successRatePct, isNull);
      expect(s.totals.ahtSeconds, isNull);
      expect(s.totals.occupancy!.isUnmeasured, isTrue);
      expect(s.isEmpty, isTrue);
    });

    test('occupancy may be absent (a server older than the event log)', () {
      final json = fixture('reads.json', 'my_stats');
      final totals = Map.of(json['totals']! as Map<String, Object?>)..remove('occupancy');
      expect(AgentStats.fromJson({...json, 'totals': totals}).totals.occupancy, isNull);
    });

    test('a bucket label is a calendar day, never an instant', () {
      expect(CalendarDate.parse('2026-01-05'), const CalendarDate(2026, 1, 5));
      expect(() => CalendarDate.parse('2026-01-05T00:00:00Z'), throwsA(isA<WireFormatException>()));
      expect(const CalendarDate(2026, 1, 5).compareTo(const CalendarDate(2025, 12, 31)), greaterThan(0));
    });

    test('query', () {
      final q = AgentStatsQuery(
        from: DateTime.parse('2026-10-27T00:00:00+05:30'),
        to: DateTime.parse('2026-11-02T00:00:00+05:30'),
      );
      expect(q.toQuery(), {'from': '2026-10-26T18:30:00.000Z', 'to': '2026-11-01T18:30:00.000Z', 'bucket': 'day'});
    });
  });

  group('my-attempts', () {
    test('a keyset page of attempt rows', () {
      final p = decodeAttemptsPage(fixture('reads.json', 'my_attempts'));
      expect(p.rows, hasLength(2));
      expect(p.hasMore, isTrue);
      expect(p.limit, 50);
      final r = p.rows.first;
      expect(r.outcome, AttemptOutcome.connected);
      expect(r.talkSeconds, 136.45);
      expect(r.callbackAt, DateTime.utc(2026, 11, 3, 12, 30));
      expect(r.agentName, isNull);
      expect(p.rows[1].bridgedAt, isNull);
      expect(p.rows[1].webrtcCallId, isNull);
      // Wrap-up redial (0008): the chain link, absent from a row an older server sent.
      expect(r.redialOfAttemptId, 'd3c2b1a0-9e8f-4d7c-8b6a-5f4e3d2c1b0a');
      expect(r.redialNumber, 1);
      expect(p.rows[1].redialOfAttemptId, isNull);
      expect(p.rows[1].redialNumber, isNull);
    });

    test('the last page has no cursor', () {
      final p = decodeAttemptsPage(fixture('reads.json', 'my_attempts_last_page'));
      expect(p.rows, isEmpty);
      expect(p.hasMore, isFalse);
    });

    test('query', () {
      expect(const AttemptsQuery(cursor: 'abc', limit: 25).toQuery(), {'cursor': 'abc', 'limit': '25'});
      expect(const AttemptsQuery().toQuery(), isEmpty);
    });

    test('query: outcomes comma-joined under one key, phone as given, empty ones left out', () {
      expect(
        const AttemptsQuery(outcomes: [AttemptOutcome.connected, AttemptOutcome.noAnswer], phone: '+919840012345').toQuery(),
        {'outcome': 'connected,no_answer', 'phone': '+919840012345'},
      );
      expect(const AttemptsQuery(outcomes: [], phone: '').toQuery(), isEmpty);
      expect(
        const AttemptsQuery(outcomes: [AttemptOutcome.connected], phone: '98400'),
        const AttemptsQuery(outcomes: [AttemptOutcome.connected], phone: '98400'),
      );
      expect(
        const AttemptsQuery(outcomes: [AttemptOutcome.connected]) == const AttemptsQuery(outcomes: [AttemptOutcome.noAnswer]),
        isFalse,
      );
    });
  });
}
