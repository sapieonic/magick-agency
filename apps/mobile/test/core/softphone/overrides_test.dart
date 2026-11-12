import 'package:agency_wire/agency_wire.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:magick_agency_agent/core/softphone/overrides.dart';
import 'package:magick_agency_agent/core/softphone/softphone_view.dart';
import 'package:magick_agency_agent/features/performance/logic/stats_windows.dart';

/// The console's override tables (`softphoneFields.test.ts` "override notes",
/// `softphoneOverrides.timezone.test.ts`), with the app's reading of the next
/// opening: how long until it plus this phone's clock, read here in a fixed
/// IST zone so the suite reads the same wherever it runs.
void main() {
  const ist = FixedOffsetCalendar(Duration(hours: 5, minutes: 30), 'IST');
  const la = FixedOffsetCalendar(Duration(hours: -8), 'PST');

  Map<String, String> factsOf(SoftphoneOverridePrompt p) => {for (final f in p.facts) f.label: f.value};

  group('override notes', () {
    test('need 10–500 characters after trimming, counted as the server counts them', () {
      expect(overrideNoteBlock('   short   '), OverrideNoteBlock.tooShort);
      expect(overrideNoteBlock('Customer asked for this'), isNull);
      // Characters (code points): an emoji is one, not two UTF-16 units.
      expect(overrideNoteLength('12345678😀'), 9);
      expect(overrideNoteBlock('12345678😀'), OverrideNoteBlock.tooShort);
      expect(overrideNoteBlock('${'x' * 499}😀'), isNull);
      expect(overrideNoteBlock('${'x' * 500}😀'), OverrideNoteBlock.tooLong);
      expect(overrideNoteBlock('x' * 501), OverrideNoteBlock.tooLong);
      expect(overrideNoteBlockCopy[OverrideNoteBlock.tooShort], contains('10 characters'));
    });

    test('keep the first override when the second refusal arrives', () {
      final first = withOverride(const ManualCallOverridesRequest(), SoftphoneOverrideKind.dnc, '  Customer called us back first ');
      expect(
        withOverride(first, SoftphoneOverrideKind.hours, 'They asked for a call now'),
        const ManualCallOverridesRequest(dncNote: 'Customer called us back first', hoursNote: 'They asked for a call now'),
      );
    });
  });

  group('the calling-hours prompt says when the window opens', () {
    // 03:30 UTC = 09:00 in Kolkata, Monday 2 Nov 2026.
    SoftphoneOutsideHoursRefusal hours({String? nextOpenAt = '2026-11-02T03:30:00.000Z', String source = 'contact'}) =>
        SoftphoneOutsideHoursRefusal.fromJson({
          'code': 'outside_calling_hours',
          'message': 'Outside calling hours',
          'window': {
            'start': '09:00:00',
            'end': '20:00',
            'days': [1, 2, 3, 4, 5],
            'timezone': 'Asia/Kolkata',
          },
          'timezone_source': source,
          'next_open_at': nextOpenAt,
        });
    // Sun 1 Nov 2026, 22:00 IST.
    final now = DateTime.utc(2026, 11, 1, 16, 30);

    test('describes the window as the server states it, whose zone it is, and the next opening', () {
      final p = describeHoursRefusal(hours(), campaignName: 'Home Loan Renewals', now: now, calendar: ist);
      expect(p.kind, SoftphoneOverrideKind.hours);
      expect(p.title, 'Home Loan Renewals is outside its calling hours');
      final facts = factsOf(p);
      expect(facts['Calling hours'], '09:00–20:00, Mon–Fri');
      expect(facts['Timezone'], 'Asia/Kolkata — the customer’s, from the roster');
      expect(facts['Opens again'], 'In 11 h — Mon 2 Nov, 09:00 your time');
      expect(p.confirmLabel, 'Call anyway');
      expect(p.consequence, contains('logged with your name'));
    });

    test('reads the next opening on this phone’s clock, wherever the phone is', () {
      final facts = factsOf(describeHoursRefusal(hours(), campaignName: null, now: now, calendar: la));
      // Mon 2 Nov 03:30 UTC is Sun 1 Nov 19:30 in Los Angeles.
      expect(facts['Opens again'], 'In 11 h — Sun 1 Nov, 19:30 your time');
    });

    test('says so when the window never opens, and when the zone is the campaign’s default', () {
      final p = describeHoursRefusal(hours(nextOpenAt: null, source: 'campaign_default'), now: now, calendar: ist);
      expect(p.title, 'This campaign is outside its calling hours');
      final facts = factsOf(p);
      expect(facts['Opens again'], contains('Never'));
      expect(facts['Timezone'], contains('campaign’s default'));
    });

    test('says how long in plain words', () {
      final at = DateTime.utc(2026, 11, 1, 12);
      expect(timeUntil(at, at.subtract(const Duration(seconds: 30))), 'in under a minute');
      expect(timeUntil(at, at.subtract(const Duration(minutes: 25))), 'in 25 min');
      expect(timeUntil(at, at.subtract(const Duration(hours: 3, minutes: 20))), 'in 3 h 20 min');
      expect(timeUntil(at, at.subtract(const Duration(days: 1, hours: 6))), 'in 1 day 6 h');
      expect(timeUntil(at, at.subtract(const Duration(days: 2))), 'in 2 days');
      expect(timeUntil(at, at.add(const Duration(minutes: 1))), 'any moment now');
    });
  });

  group('the DNC prompt says exactly what matched', () {
    SoftphoneDncListedRefusal dnc({String scope = 'campaign', String? reason = 'Asked not to be called'}) =>
        SoftphoneDncListedRefusal.fromJson({
          'code': 'dnc_listed',
          'message': 'Listed',
          'entry': {'id': 'dnc-1', 'scope': scope, 'reason': reason, 'created_at': '2026-10-12T09:00:00.000Z'},
        });

    test('names the number, the scope, the reason and the date', () {
      final p = describeDncRefusal(dnc(), number: '+919820461733', campaignName: 'Home Loan Renewals', calendar: ist);
      expect(p.kind, SoftphoneOverrideKind.dnc);
      final facts = factsOf(p);
      expect(facts['Number'], '+91 98204 61733');
      expect(facts['Listed for'], 'The campaign Home Loan Renewals');
      expect(facts['Reason'], 'Asked not to be called');
      expect(facts['Added'], '12 Oct 2026');
      expect(p.consequence, contains('logged with your name'));
      expect(p.title, 'This number is on the Do Not Call list');
    });

    test('says when no reason was recorded, and a workspace-wide entry as such', () {
      final facts = factsOf(describeDncRefusal(dnc(scope: 'tenant', reason: null), number: '+919820461733', calendar: ist));
      expect(facts['Listed for'], 'Every campaign and account in this organisation');
      expect(facts['Reason'], 'No reason was recorded');
    });

    test('a campaign entry an untagged call met is one of the account’s campaigns', () {
      expect(dncEntryReach(DncEntryScope.campaign, null), 'One of this account’s campaigns');
      expect(dncEntryReach(DncEntryScope.account, 'Ignored'), 'This account');
    });
  });

  group('days, as the campaign screens print them', () {
    test('the shortest honest phrase', () {
      expect(describeIsoDays([1, 2, 3, 4, 5]), 'Mon–Fri');
      expect(describeIsoDays([1, 2, 3, 4, 5, 6, 7]), 'Every day');
      expect(describeIsoDays([6, 7]), 'Sat, Sun');
      expect(describeIsoDays([5, 1, 3, 3]), 'Mon, Wed, Fri');
      expect(describeIsoDays([0, 9]), isNull);
      expect(describeIsoDays(const []), isNull);
    });

    test('HH:MM:SS → HH:MM, anything else as sent', () {
      expect(hhmm('09:00:00'), '09:00');
      expect(hhmm('9am'), '9am');
    });
  });
}
