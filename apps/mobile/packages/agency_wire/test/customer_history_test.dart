import 'package:agency_wire/agency_wire.dart';
import 'package:test/test.dart';

import 'support/fixtures.dart';

void main() {
  const file = 'customer-history.json';

  group('CustomerSearchResponse', () {
    test('the summary: contacts, totals, DNC, what is open and the filter options', () {
      final r = CustomerSearchResponse.fromJson(fixture(file, 'search_response'));
      expect(r.searchId, startsWith('chs_'));
      expect(r.key.value, '+919876543210');
      expect(r.key.display, '+91 98765 43210');
      expect(r.isEmpty, isFalse);

      final s = r.summary;
      expect(s.contacts, hasLength(2));
      final asha = s.contacts.first;
      expect(asha.campaign.retryGeneration, 1);
      expect(asha.campaigns.map((c) => c.name), ['October dues', 'October dues (retry 1)']);
      expect(asha.state, ContactState.pending);
      expect(asha.fields.map((f) => '${f.column}: ${f.value}'), ['Name: Asha Rao', 'Loan No: LN-0042']);
      expect(asha.assignedTo?.name, 'Priya Nair');
      expect(asha.uploadFileName, 'october-dues.csv');
      expect(s.contacts[1].suppressedReason, 'dnc');
      expect(s.contacts[1].assignedTo, isNull);

      expect(s.totals.calls, 4);
      expect(s.totals.connected, 2);
      expect(s.totals.lastContacted?.channel, CustomerTimelineChannel.softphone);
      expect(s.totals.lastContacted?.outcome, AttemptOutcome.connected);

      expect(s.dnc.single.scope, DncEntryScope.campaign);
      expect(s.dnc.single.campaign?.name, 'October dues');
      expect(s.open.callbacks.single.dueAt, DateTime.utc(2026, 11, 7, 5, 30));
      expect(s.open.overrides.single.extraAttempts, 2);
      expect(s.open.liveCalls.single.agent, isNull);
      expect(s.filterOptions.outcomes, [AttemptOutcome.connected, AttemptOutcome.noAnswer]);

      expect(r.timeline.entries.map((e) => e.kind), [
        CustomerTimelineKind.softphoneCall,
        CustomerTimelineKind.callback,
        CustomerTimelineKind.campaignCall,
        CustomerTimelineKind.dncMark,
        CustomerTimelineKind.rosterEntry,
      ]);
      expect(r.timeline.hasMore, isTrue);
    });

    test('nothing in the accounts the caller can see', () {
      final r = CustomerSearchResponse.fromJson(fixture(file, 'search_response_empty'));
      expect(r.isEmpty, isTrue);
      expect(r.summary.totals.lastContacted, isNull);
      expect(r.timeline.hasMore, isFalse);
    });
  });

  group('CustomerTimelineEntry', () {
    test('decodes each kind to its own type', () {
      expect(CustomerTimelineEntry.fromJson(fixture(file, 'entry_campaign_call')), isA<CustomerTimelineCampaignCall>());
      expect(CustomerTimelineEntry.fromJson(fixture(file, 'entry_softphone_call')), isA<CustomerTimelineSoftphoneCall>());
      expect(CustomerTimelineEntry.fromJson(fixture(file, 'entry_callback')), isA<CustomerTimelineCallback>());
      expect(CustomerTimelineEntry.fromJson(fixture(file, 'entry_dnc_mark')), isA<CustomerTimelineDncMark>());
      expect(CustomerTimelineEntry.fromJson(fixture(file, 'entry_roster_entry')), isA<CustomerTimelineRosterEntry>());
    });

    test('a campaign call an agent reads: notes hidden, recording expired, no call page', () {
      final c = CustomerTimelineEntry.fromJson(fixture(file, 'entry_campaign_call')) as CustomerTimelineCampaignCall;
      expect(c.notes, isNull);
      expect(c.notesHidden, isTrue);
      expect(c.recording, CustomerRecordingState.expired);
      expect(c.callPage, isNull);
      expect(c.overrideApplied, [OverrideKind.extraAttempts]);
      expect(c.redialNumber, 1);
      expect(c.talkSeconds, 95);
      expect(c.kindRaw, 'campaign_call');
    });

    test('a soft-phone call keeps its call details as sent', () {
      final c = CustomerTimelineEntry.fromJson(fixture(file, 'entry_softphone_call')) as CustomerTimelineSoftphoneCall;
      expect(c.campaign, isNull);
      expect(c.fields, {'promised_amount': 2500, 'channel': 'UPI'});
      expect(c.recording, CustomerRecordingState.available);
      expect(c.callPage?.manualCallId, c.manualCallId);
    });

    test('a callback: its source call and its status', () {
      final c = CustomerTimelineEntry.fromJson(fixture(file, 'entry_callback')) as CustomerTimelineCallback;
      expect(c.source.channel, CustomerTimelineChannel.campaign);
      expect(c.status, CustomerCallbackStatus.upcoming);
      expect(c.dialledAt, isNull);
    });

    test('`late` decodes to keptLate', () {
      final json = {...fixture(file, 'entry_callback'), 'status': 'late'};
      final c = CustomerTimelineEntry.fromJson(json) as CustomerTimelineCallback;
      expect(c.status, CustomerCallbackStatus.keptLate);
      expect(c.statusRaw, 'late');
    });

    test('a kind this build does not know is an unknown entry, never an error', () {
      final json = <String, Object?>{
        'key': 'sms:42',
        'kind': 'sms',
        'at': '2026-11-01T10:00:00.000Z',
        'account_id': null,
        'body': 'Reminder sent',
      };
      final e = CustomerTimelineEntry.fromJson(json);
      expect(e, isA<CustomerTimelineUnknownEntry>());
      expect(e.kind, CustomerTimelineKind.unknown);
      expect(e.kindRaw, 'sms');
      expect(e.at, DateTime.utc(2026, 11, 1, 10));
      expect((e as CustomerTimelineUnknownEntry).raw['body'], 'Reminder sent');
      // And a page carrying one still decodes, the known entries intact.
      final page = CustomerTimelinePage.fromJson({
        'entries': [json, fixture(file, 'entry_roster_entry')],
        'next_cursor': null,
      });
      expect(page.entries.map((e) => e.runtimeType), [CustomerTimelineUnknownEntry, CustomerTimelineRosterEntry]);
    });

    test('a malformed known kind is a WireFormatException naming the field', () {
      final json = {...fixture(file, 'entry_roster_entry')}..remove('campaign');
      expect(
        () => CustomerTimelineEntry.fromJson(json),
        throwsA(isA<WireFormatException>().having((e) => e.key, 'key', 'campaign')),
      );
    });
  });

  group('requests', () {
    test('the search sends the raw text and the picked country', () {
      expect(const CustomerSearchRequest(value: '098765-43210', country: 'IN').toJson(), {
        'by': 'phone',
        'value': '098765-43210',
        'country': 'IN',
      });
      expect(const CustomerSearchRequest(value: '+14155552671').toJson(), {'by': 'phone', 'value': '+14155552671'});
    });

    test('the search request never prints the number', () {
      expect(const CustomerSearchRequest(value: '9876543210').toString(), isNot(contains('9876543210')));
    });

    test('a timeline page leaves out what is not set', () {
      expect(const CustomerTimelineRequest(searchId: 'chs_1').toJson(), {'search_id': 'chs_1'});
      expect(
        CustomerTimelineRequest(
          searchId: 'chs_1',
          filters: CustomerTimelineFilters(channel: CustomerTimelineChannel.softphone, connectedOnly: true),
          cursor: 'c1',
          limit: 50,
        ).toJson(),
        {
          'search_id': 'chs_1',
          'filters': {'channel': 'softphone', 'connected_only': true},
          'cursor': 'c1',
          'limit': 50,
        },
      );
      expect(CustomerTimelineFilters.none.isEmpty, isTrue);
      expect(CustomerTimelineFilters.none.toJson(), isEmpty);
    });
  });

  group('CustomerHistoryRefusal', () {
    test('invalid_number carries why', () {
      final r = CustomerHistoryRefusal.fromJson(fixture(file, 'error_invalid_number'));
      expect(r.code, CustomerHistoryErrorCode.invalidNumber);
      expect(r.numberError, CustomerSearchNumberError.tooShort);
      expect(r.message, "Enter the full number. Searching by the last few digits isn't supported.");
    });

    test('search_expired', () {
      final r = CustomerHistoryRefusal.fromJson(fixture(file, 'error_search_expired'));
      expect(r.code, CustomerHistoryErrorCode.searchExpired);
      expect(r.numberError, isNull);
    });

    test('never throws, whatever the body', () {
      final r = CustomerHistoryRefusal.fromJson(const {'code': 7, 'message': null, 'retryAfter': 12});
      expect(r.code, CustomerHistoryErrorCode.unknown);
      expect(r.codeRaw, isNull);
      expect(r.message, '');
    });
  });
}
