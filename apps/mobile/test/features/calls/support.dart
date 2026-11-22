import 'dart:async';

import 'package:agency_wire/agency_wire.dart';
import 'package:flutter_riverpod/misc.dart' show Override;
import 'package:magick_agency_agent/core/api/api_error.dart';
import 'package:magick_agency_agent/features/calls/my_calls_controller.dart';

import '../missed/support.dart';

export '../missed/support.dart';

/// Test doubles for My calls.

/// One row of `GET /proxy/agency/my-calls` as the server sends it: a dialler
/// call that connected, on a campaign that shows numbers; [over] replaces fields.
Map<String, Object?> myCallJson(String id, [Map<String, Object?> over = const {}]) => {
      'type': 'dialler',
      'id': id,
      'created_at': '2026-10-14T04:40:00.000Z',
      'campaign_id': 'camp-1',
      'campaign_name': 'Diwali EMI Collections',
      'contact_id': 'k-$id',
      'customer_name': 'Anjali Verma',
      'phone': '+919840010001',
      'phone_masked': false,
      'state': 'ended',
      'outcome': 'connected',
      'disposition_code': 'call_later',
      'disposition_label': 'Call later',
      'auto_disposition_code': null,
      'callback_at': null,
      'promise_date': null,
      'promise_amount': null,
      'talk_seconds': 182,
      'notes': null,
      'attempt_number': 1,
      'redial': false,
      'dialed_at': '2026-10-14T04:40:02.000Z',
      'requires_disposition': false,
      'callback_of': null,
      'wait_seconds': null,
      'queued': false,
      'voicemail_seconds': null,
      'follow_up': null,
      'called_back': null,
      ...over,
    };

MyCallRow myCall(String id, [Map<String, Object?> over = const {}]) => MyCallRow.fromJson(myCallJson(id, over));

/// A missed call still to follow up, on a campaign that hides numbers.
MyCallRow missedRow(String id, [Map<String, Object?> over = const {}]) => myCall(id, {
      'type': 'inbound',
      'customer_name': null,
      'contact_id': null,
      'campaign_id': 'camp-2',
      'campaign_name': 'General enquiries',
      'phone': '98••• ••730',
      'phone_masked': true,
      'outcome': 'overflow',
      'disposition_code': null,
      'disposition_label': null,
      'talk_seconds': null,
      'attempt_number': null,
      'dialed_at': null,
      'wait_seconds': 100,
      'queued': true,
      'follow_up': {'status': 'open', 'reason': 'overflow', 'closed_cause': null, 'handled_reason': null},
      ...over,
    });

MyCallbackDue callbackDue(String contact, DateTime dueAt, {String? name = 'Anjali Verma'}) => MyCallbackDue(
      contactId: contact,
      campaignId: 'camp-1',
      campaignName: 'Diwali EMI Collections',
      customerName: name,
      dueAt: dueAt,
      overdue: dueAt.isBefore(fixedNow),
    );

MyCallsPage myCallsPage(
  List<MyCallRow> rows, {
  String? next,
  MyCallsCounts? counts = const MyCallsCounts(toFollowUp: 0, missedOpen: 0, callbacksDue: 0),
  List<MyCallbackDue>? callbacks,
}) =>
    MyCallsPage(rows: rows, nextCursor: next, limit: myCallsPageSize, counts: counts, callbacksDue: callbacks);

/// A scripted `/my-calls`: every request waits until the test answers it,
/// unless [auto] answers by chip.
class FakeMyCallsApi implements MyCallsApi {
  final List<MyCallsQuery> queries = [];
  final List<Completer<MyCallsPage>> pending = [];

  /// When set, every request answers at once with what it returns.
  MyCallsPage Function(MyCallsQuery query)? auto;

  @override
  Future<MyCallsPage> myCalls(MyCallsQuery query) {
    queries.add(query);
    final answer = auto;
    if (answer != null) return Future.value(answer(query));
    final c = Completer<MyCallsPage>();
    pending.add(c);
    return c.future;
  }

  Map<String, String> q(int i) => queries[i].toQuery();

  void answer(int i, MyCallsPage p) => pending[i].complete(p);

  void fail(int i, [ApiError e = const ApiNetworkError('offline')]) => pending[i].completeError(e);
}

/// My calls' providers over [api], with the Missed list's over [missed].
List<Override> myCallsOverrides(FakeMyCallsApi api, FakeMissedCallsApi missed, {bool inboundOn = true}) => [
      ...missedOverrides(missed, inboundOn: inboundOn),
      myCallsApiProvider.overrideWithValue(api),
    ];
