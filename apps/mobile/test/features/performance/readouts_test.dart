import 'package:agency_wire/agency_wire.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:magick_agency_agent/features/performance/logic/en_in_format.dart';
import 'package:magick_agency_agent/features/performance/logic/readouts.dart';

import 'support.dart';

/// A campaign row with the served connect counts; [rate] defaults to
/// `humanConnects / firstDials`, as the server computes it.
AgentCampaignRow row({int attempts = 0, int connected = 0, int? firstDials, int? humanConnects, double? rate}) =>
    AgentCampaignRow(
      campaignId: 'c1',
      attempts: attempts,
      connected: connected,
      successes: 0,
      talkSeconds: 0,
      wrapupSeconds: 0,
      humanConnects: humanConnects,
      firstDials: firstDials,
      connectRatePct: rate ??
          (firstDials != null && humanConnects != null && firstDials > 0 ? humanConnects / firstDials * 100 : null),
    );

void main() {
  group('EnIn (the console\'s en-IN renderings)', () {
    test('counts use Indian grouping', () {
      expect(EnIn.count(0), '0');
      expect(EnIn.count(1234), '1,234');
      expect(EnIn.count(123456), '1,23,456');
      expect(EnIn.count(12345678), '1,23,45,678');
    });

    test('percentages: one decimal, trailing zero trimmed, JS toFixed rounding', () {
      expect(EnIn.pct(38.0281690140845), '38%');
      expect(EnIn.pct(18.04), '18%');
      expect(EnIn.pct(18.05), '18.1%');
      expect(EnIn.pct(0.25), '0.3%');
      expect(EnIn.pct(0.35), '0.3%'); // the binary 0.35 is just under the tie
      expect(EnIn.pct(99.95), '100%');
      expect(EnIn.pct(0), '0%');
    });

    test('statClock rounds to the second and rolls to hours', () {
      expect(EnIn.statClock(0), '0:00');
      expect(EnIn.statClock(59.6), '1:00');
      expect(EnIn.statClock(65), '1:05');
      expect(EnIn.statClock(10390), '2:53:10');
      expect(EnIn.statClock(-3), '0:00');
    });

    test('talk time floors, keeps minutes unbounded, and null is a dash', () {
      expect(EnIn.talkTime(null), '—');
      expect(EnIn.talkTime(0), '0:00');
      expect(EnIn.talkTime(221.9), '3:41');
      expect(EnIn.talkTime(3725), '62:05');
    });

    test('phone numbers, dates and times', () {
      expect(EnIn.phone('+919840012345'), '+91 98400 12345');
      expect(EnIn.phone('+14155550100'), '+14155550100');
      expect(EnIn.phone(null), '--');
      expect(EnIn.dayMonth(DateTime(2026, 10, 16)), '16 Oct');
      expect(EnIn.clockTime(DateTime(2026, 10, 16, 15, 5)), '03:05 pm');
      expect(EnIn.timestamp(null), '—');
      final t = DateTime(2026, 10, 16, 9, 5);
      expect(EnIn.timestamp(t), '16 Oct 2026, 09:05 am');
    });
  });

  group('headlineTrio', () {
    test('dials, connect rate, conversations, in that order', () {
      final f = headlineTrio(totals(attempts: 123456, connected: 54));
      expect(f.map((x) => x.label), ['Dials', 'Connect rate', 'Conversations']);
      expect(f.map((x) => x.value), ['1,23,456', '38%', '54']);
      expect(f.every((x) => x.known), isTrue);
    });

    test('a null connect rate is "Not measured yet", never 0%', () {
      final f = headlineTrio(totals(attempts: 0, connected: 0, connectRate: null));
      expect(f[1].value, 'Not measured yet');
      expect(f[1].known, isFalse);
      expect(f[0].value, '0'); // a real zero is a claim, and shown
      expect(f[0].known, isTrue);
    });

    test('a payload that did not load is three em dashes', () {
      final f = headlineTrio(null);
      expect(f.map((x) => x.value), ['—', '—', '—']);
      expect(f.any((x) => x.known), isFalse);
      expect(f.first.hint, 'Calls the dialer placed and handed to you, whether or not anyone picked up.');
    });
  });

  group('readouts', () {
    test('conversion: rate over conversations with the counted successes beside it', () {
      final r = conversionReadout(totals(successes: 12, successRate: 22.2222));
      expect(r, const Readout(
        value: '22.2%',
        detail: 'Calls that counted as a win, out of the ones where you spoke to someone — not out of every dial.',
        secondary: '12 counted',
        known: true,
      ));
    });

    test('conversion with no conversation yet is not measured, still counting 0', () {
      final r = conversionReadout(totals(connected: 0, successes: 0, successRate: null));
      expect(r.value, 'Not measured yet');
      expect(r.detail, 'You haven’t had a conversation to convert yet.');
      expect(r.secondary, '0 counted');
      expect(r.known, isFalse);
    });

    test('conversion that did not load', () {
      final r = conversionReadout(null);
      expect((r.value, r.detail, r.secondary), ('—', 'Your conversion rate didn’t load.', null));
    });

    test('average call is the served AHT, rounded, with total talk beside it', () {
      final r = handleTimeReadout(totals(aht: 59.6, talk: 10390));
      expect(r.value, '1:00');
      expect(r.secondary, '2:53:10 on calls in total');
      expect(r.known, isTrue);
    });

    test('average call with nothing finished is not measured', () {
      final r = handleTimeReadout(totals(aht: null, talk: 0));
      expect(r.value, 'Not measured yet');
      expect(r.detail, 'No call of yours has finished in this period, so there is nothing to average.');
      expect(r.secondary, '0:00 on calls in total');
    });

    test('wrap-up is a total, and a real zero reads 0:00', () {
      expect(wrapupReadout(totals(wrapup: 1296)).value, '21:36');
      expect(wrapupReadout(totals(wrapup: 0)).value, '0:00');
      expect(wrapupReadout(null).value, '—');
      expect(wrapupReadout(null).detail, 'Your wrap-up time didn’t load.');
    });
  });

  group('rowConnectRate (served, with the console\'s floor)', () {
    test('no first dials, a null rate or none served is a dash, not 0%', () {
      expect(rowConnectRate(row(firstDials: 0, humanConnects: 0)), '—');
      expect(rowConnectRate(row(attempts: 30, connected: 12, firstDials: 30)), '—'); // rate null
      // A server older than the field: never derived from connected / attempts.
      expect(rowConnectRate(row(attempts: 142, connected: 54)), '—');
    });

    test('under 20 first dials the rate is withheld', () {
      expect(rosterMinRateDenominator, 20);
      expect(rowConnectRate(row(firstDials: 1, humanConnects: 1)), 'Not enough calls');
      expect(rowConnectRate(row(attempts: 40, firstDials: 19, humanConnects: 10)), 'Not enough calls');
    });

    test('at the floor the served rate is shown, not connected over attempts', () {
      expect(rowConnectRate(row(firstDials: 20, humanConnects: 7)), '35%');
      // 54 / 142 would be 38%; the served rate (40 of 130 first dials) is 30.8%.
      expect(rowConnectRate(row(attempts: 142, connected: 54, firstDials: 130, humanConnects: 40)), '30.8%');
    });
  });

  group('campaign names and scope', () {
    final names = campaignNameMap([
      staffing('c-b', 'Zeta renewals'),
      staffing('c-a', 'alpha leads'),
      staffing('c-x', null),
      staffing('c-a', null), // a second stint keeps the known name
    ]);

    test('labels fall back to a shortened id, never blank', () {
      expect(campaignLabel('c-a', names), 'alpha leads');
      expect(campaignLabel('4f21ab90-1111-2222-3333-444455556666', names), 'Campaign 4f21ab90');
    });

    test('only named campaigns are offered, sorted by name', () {
      expect(scopeOptions(names).map((e) => e.key), ['c-a', 'c-b']);
    });

    test('the selector shows for a real choice or an applied scope', () {
      expect(showScope(1, null), isFalse);
      expect(showScope(2, null), isTrue);
      expect(showScope(0, 'c-x'), isTrue);
    });
  });

  test('empty range and failure wording', () {
    expect(emptyRangeLine('This week'), 'No calls reached you this week.');
    expect(failedWindowTitle('Today'), 'We couldn’t load today');
    expect(campaignsWorked(1), '1 campaign');
    expect(campaignsWorked(3), '3 campaigns');
    final s = stats(from: DateTime.utc(2026), to: DateTime.utc(2026, 1, 2), t: totals(attempts: 0));
    expect(isEmptyRange(s), isTrue);
  });
}
