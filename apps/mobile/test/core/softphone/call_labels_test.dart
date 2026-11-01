import 'package:flutter_test/flutter_test.dart';
import 'package:magick_agency_agent/core/softphone/call_labels.dart';
import 'package:magick_agency_agent/core/softphone/softphone_view.dart';
import 'package:magick_agency_agent/features/performance/logic/en_in_format.dart';

import 'manual_calls.dart';

/// The console's `softphoneCallLabels.test.ts` tables, plus the outcome line
/// and the number layout. Calendar days are the device's: every instant here is
/// built in local time, so the tables hold in any zone the suite runs in.
void main() {
  group('recentCallWhen', () {
    final now = DateTime(2026, 10, 30, 15);

    test('says Today for a call earlier today', () {
      final call = DateTime(2026, 10, 30, 0, 5);
      expect(recentCallWhen(call, now), 'Today, ${EnIn.clockTime(call)}');
    });

    test('says Yesterday for one the calendar day before, however few hours ago', () {
      final call = DateTime(2026, 10, 29, 23, 55);
      expect(recentCallWhen(call, now), 'Yesterday, ${EnIn.clockTime(call)}');
    });

    test('gives the date for anything older, and the year once it is not this one', () {
      expect(recentCallWhen(DateTime(2026, 10, 28, 9), now), startsWith('28 Oct, '));
      expect(recentCallWhen(DateTime(2025, 12, 31, 9), now), startsWith('31 Dec 2025, '));
    });

    test('counts calendar days across a month boundary', () {
      expect(recentCallWhen(DateTime(2026, 10, 31, 22), DateTime(2026, 11, 1, 8)), startsWith('Yesterday, '));
    });

    test('a UTC instant is read on this device\'s calendar', () {
      final local = DateTime(2026, 10, 30, 9);
      expect(recentCallWhen(local.toUtc(), now), recentCallWhen(local, now));
    });
  });

  group('catalogForCall', () {
    final tagged = manualCall({
      'tag': {'campaign_id': 'camp-1', 'campaign_name': 'Home Loan Renewals'},
    });

    test('a taggable campaign\'s catalog for a tagged call; the untagged one otherwise', () {
      final boot = bootstrap();
      expect(catalogForCall(tagged, boot), boot.taggableCampaigns.single.dispositionCatalog);
      expect(catalogForCall(manualCall(), boot), boot.untagged.dispositionCatalog);
      expect(catalogForCall(tagged, null), isNull);
    });

    test('falls back to call_campaign for the call it describes, and to nothing for another', () {
      final boot = bootstrap({
        'taggable_campaigns': <Object?>[],
        'call_campaign': {...campaignJson, 'status': 'completed'},
      });
      expect(catalogForCall(tagged, boot), boot.callCampaign!.dispositionCatalog);
      final other = manualCall({
        'tag': {'campaign_id': 'camp-9', 'campaign_name': 'Other'},
      });
      expect(catalogForCall(other, boot), isNull);
    });

    test('an outcome saved against the soft phone\'s catalog is read there, even on a tagged call', () {
      final boot = bootstrap();
      final saved = manualCall({
        'tag': {'campaign_id': 'camp-1', 'campaign_name': 'Home Loan Renewals'},
        'disposition_source': 'softphone',
      });
      expect(catalogForCall(saved, boot), boot.untagged.dispositionCatalog);
    });
  });

  group('manualCallOutcome', () {
    final catalog = bootstrap().untagged.dispositionCatalog;

    test('the saved outcome in its catalog\'s words, else the raw code', () {
      final saved = manualCallOutcome(
        manualCall({'state': 'ended', 'disposition_code': 'resolved', 'settled_at': '2026-10-30T10:05:00Z'}),
        catalog,
      );
      expect(saved, (text: 'Query resolved', kind: SoftphoneOutcomeKind.saved));
      expect(manualCallOutcome(manualCall({'disposition_code': 'gone_code'}), catalog).text, 'gone_code');
    });

    test('owed, live, and what the line did', () {
      expect(
        manualCallOutcome(manualCall({'state': 'ended', 'requires_disposition': true}), catalog),
        (text: 'No outcome yet', kind: SoftphoneOutcomeKind.awaiting),
      );
      expect(manualCallOutcome(manualCall({'state': 'ringing'}), catalog).kind, SoftphoneOutcomeKind.live);
      expect(
        manualCallOutcome(manualCall({'state': 'ended', 'outcome': 'no_answer', 'settled_at': '2026-10-30T10:01:00Z'}), catalog),
        (text: 'No answer', kind: SoftphoneOutcomeKind.line),
      );
      expect(manualCallOutcome(manualCall({'state': 'ended', 'settled_at': '2026-10-30T10:01:00Z'}), catalog).text, 'Not classified');
    });
  });

  test('loggedToLabel names the campaign, or none', () {
    expect(loggedToLabel(manualCall()), 'Not logged to a campaign');
    expect(
      loggedToLabel(manualCall({
        'tag': {'campaign_id': 'c', 'campaign_name': 'Q4 Renewals'},
      })),
      'Q4 Renewals',
    );
  });

  test('formatDialNumber lays a number out for reading and leaves the rest as typed', () {
    expect(formatDialNumber('+919820461733'), '+91 98204 61733');
    expect(formatDialNumber('+91 98204 61733'), '+91 98204 61733');
    expect(formatDialNumber('+14155550100'), '+1 415 555 0100');
    expect(formatDialNumber('9820461733'), '98204 61733');
    expect(formatDialNumber('+442071234567'), '+442071234567');
    expect(formatDialNumber(null), '');
    expect(formatDialNumber(''), '');
  });
}
