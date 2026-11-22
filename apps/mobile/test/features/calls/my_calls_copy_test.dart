import 'package:agency_wire/agency_wire.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:magick_agency_agent/features/calls/my_calls_copy.dart';

import 'support.dart';

/// My calls in words (docs/call-log.md §7): the console's `myCalls.ts`, on the app's cards.
void main() {
  // 10:30 IST on 14 Oct; the device's zone in tests is UTC, so times read in UTC.
  final now = DateTime.utc(2026, 10, 14, 5);

  test('the chips, in their order and words', () {
    expect(MyCallsTypeFilter.values.map(MyCallsCopy.chip), ['To follow up', 'All', 'Dialler', 'Soft phone', 'Inbound']);
  });

  test('the type line says the type and what only it has', () {
    expect(MyCallsCopy.typeLine(myCall('a')), 'Dialler · Try 1');
    expect(MyCallsCopy.typeLine(myCall('a', {'attempt_number': 2, 'redial': true})), 'Dialler · Try 2 · redial');
    expect(MyCallsCopy.typeLine(myCall('a', {'type': 'soft_phone', 'attempt_number': null})), 'Soft phone');
    expect(
      MyCallsCopy.typeLine(myCall('a', {
        'type': 'soft_phone',
        'callback_of': {'inbound_call_id': 'm1', 'arrived_at': '2026-10-14T04:12:00.000Z'},
      })),
      'Soft phone · Call back',
    );
    expect(MyCallsCopy.typeLine(missedRow('m')), 'Inbound · missed');
    expect(MyCallsCopy.typeLine(myCall('a', {'type': 'inbound', 'outcome': 'answered'})), 'Inbound');
    expect(MyCallsCopy.typeLine(myCall('a', {'type': 'video'})), 'video');
  });

  test('who: the name, else the number as the agent may see it', () {
    expect(MyCallsCopy.who(myCall('a')), 'Anjali Verma');
    expect(MyCallsCopy.who(myCall('a', {'customer_name': null})), '+91 98400 10001');
    // A number the server hid is shown exactly as it arrived.
    expect(MyCallsCopy.who(missedRow('m')), '98••• ••730');
    expect(MyCallsCopy.number(missedRow('m')), '98••• ••730');
    expect(MyCallsCopy.who(missedRow('m', {'phone': null, 'phone_masked': false})), 'Number withheld');
  });

  test('when: the time today in capitals, the day too on another day', () {
    expect(MyCallsCopy.when(DateTime.utc(2026, 10, 14, 15, 42), now), '3:42 PM');
    expect(MyCallsCopy.when(DateTime.utc(2026, 10, 13, 9, 5), now), '13 Oct, 9:05 AM');
  });

  test('the meta line: campaign, the outcome or what happened, talk time', () {
    expect(MyCallsCopy.meta(myCall('a')), 'Diwali EMI Collections · Call later · 3:02');
    expect(
      MyCallsCopy.meta(myCall('a', {'disposition_code': 'will_pay', 'disposition_label': 'Will pay', 'promise_date': '2026-11-25', 'talk_seconds': 252})),
      'Diwali EMI Collections · Will pay · 25 Nov · 4:12',
    );
    // No outcome saved: what the line did.
    expect(
      MyCallsCopy.meta(myCall('a', {'outcome': 'no_answer', 'disposition_code': null, 'disposition_label': null, 'talk_seconds': null})),
      'Diwali EMI Collections · No answer',
    );
    expect(
      MyCallsCopy.meta(myCall('a', {'campaign_id': null, 'campaign_name': null, 'disposition_code': null, 'talk_seconds': null, 'outcome': 'busy'})),
      'No campaign · Busy',
    );
    // A code the campaign's list no longer has reads as the code.
    expect(MyCallsCopy.outcome(myCall('a', {'disposition_code': 'old', 'disposition_label': null})), 'old');
    expect(MyCallsCopy.outcome(myCall('a', {'disposition_code': 'no_disposition', 'disposition_label': null})), 'No outcome chosen');
  });

  test('a missed call says why, with the wait when the caller queued', () {
    expect(MyCallsCopy.meta(missedRow('m')), 'General enquiries · nobody free to answer · waited 1:40');
    expect(
      MyCallsCopy.meta(missedRow('m', {
        'wait_seconds': 52,
        'follow_up': {'status': 'open', 'reason': 'abandoned_in_queue', 'closed_cause': null, 'handled_reason': null},
      })),
      'General enquiries · hung up while waiting · 0:52',
    );
    expect(
      MyCallsCopy.missedWhy(missedRow('m', {
        'queued': false,
        'follow_up': {'status': 'open', 'reason': 'closed', 'closed_cause': 'hours', 'handled_reason': null},
      })),
      'out of hours',
    );
    expect(
      MyCallsCopy.calledBack(missedRow('m', {'called_back': {'call_id': 's1', 'at': '2026-10-14T15:31:00.000Z'}}), now),
      'Called back 3:31 PM',
    );
  });

  test('what happened on a soft-phone call that never dialled, one still on, and a dial the customer\'s call stopped', () {
    expect(MyCallsCopy.happened(myCall('a', {'type': 'soft_phone', 'dialed_at': null, 'outcome': 'failed'})), 'Not dialled');
    expect(MyCallsCopy.happened(myCall('a', {'type': 'soft_phone', 'state': 'connected', 'outcome': null})), 'On a call now');
    expect(MyCallsCopy.happened(myCall('a', {'outcome': 'canceled', 'disposition_code': 'inbound_call'})), 'Stopped: customer rang us');
    expect(MyCallsCopy.happened(myCall('a', {'type': 'inbound', 'outcome': 'answered'})), 'Answered');
    expect(MyCallsCopy.happened(myCall('a', {'outcome': 'something_new'})), 'something_new');
  });

  test('a callback due: "Due 4:00 PM", or late by how long, and when it was booked for', () {
    final soon = callbackDue('k1', DateTime.utc(2026, 10, 14, 16));
    final late = callbackDue('k2', DateTime.utc(2026, 10, 14, 2, 45));
    expect(MyCallsCopy.dueLine(soon, now), 'Due 4:00 PM');
    expect(MyCallsCopy.dueLine(late, now), 'Late by 2 hours');
    expect(MyCallsCopy.bookedLine(late, now), 'Diwali EMI Collections · you booked it for 2:45 AM');
  });

  test('the empty words: nobody is waiting, under To follow up', () {
    expect(MyCallsCopy.empty(MyCallsTypeFilter.toFollowUp).title, 'Nobody is waiting for a call from you.');
    expect(MyCallsCopy.empty(MyCallsTypeFilter.all).title, 'No calls yet');
    expect(MyCallsCopy.countLine(1, more: false), 'Showing 1 call');
    expect(MyCallsCopy.countLine(50, more: true), 'Showing 50 calls — there are more');
  });
}
