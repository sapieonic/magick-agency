import 'dart:async';

import 'package:agency_wire/agency_wire.dart';
import 'package:flutter_riverpod/misc.dart' show Override;
import 'package:magick_agency_agent/core/api/api_error.dart';
import 'package:magick_agency_agent/core/softphone/softphone_view.dart';
import 'package:magick_agency_agent/features/calls/softphone/softphone_calls_controller.dart';

import '../../core/softphone/manual_calls.dart' as fixtures;
import '../../core/softphone/manual_calls.dart';
import 'support.dart';

export '../../core/softphone/manual_calls.dart';
export 'support.dart';

/// A soft-phone list row: settled, logged to the test campaign, with an outcome.
ManualCallListRow softRow(
  int n, {
  Map<String, Object?> over = const {},
}) =>
    ManualCallListRow.fromJson(manualCallJson({
      'id': 'mc-$n',
      'destination_e164': '+9198204${(10000 + n).toString().padLeft(5, '0')}',
      'state': 'ended',
      'outcome': 'connected',
      'end_reason': 'completed',
      'disposition_code': 'interested',
      'disposition_source': 'campaign',
      'tag': {'campaign_id': 'camp-1', 'campaign_name': 'Home Loan Renewals'},
      'talk_seconds': 221,
      'settled_at': '2026-10-30T10:05:00.000Z',
      'analysis_status': null,
      ...over,
    }));

ManualCallsPage softPage(Iterable<int> ids, {String? next}) =>
    KeysetPage(rows: [for (final i in ids) softRow(i)], nextCursor: next, limit: softphoneCallsPageSize);

ManualCallsPage softRows(List<ManualCallListRow> rows, {String? next}) =>
    KeysetPage(rows: rows, nextCursor: next, limit: softphoneCallsPageSize);

/// A call detail as `GET /softphone/calls/:id` answers an agent: `media: null`.
ManualCallDetail softDetail({
  Map<String, Object?> call = const {},
  String availability = 'available',
  String? byName,
  Map<String, Object?> overrides = const {},
  Map<String, Object?>? media,
}) =>
    ManualCallDetail.fromJson({
      'call': manualCallJson({
        'state': 'ended',
        'outcome': 'connected',
        'disposition_code': 'interested',
        'disposition_source': 'campaign',
        'tag': {'campaign_id': 'camp-1', 'campaign_name': 'Home Loan Renewals'},
        'talk_seconds': 221,
        'settled_at': '2026-10-30T10:05:00.000Z',
        ...call,
      }),
      'dispositioned_by_name': byName,
      'overrides': {'dnc_note': null, 'dnc_entry_id': null, 'dnc_entry': null, 'hours_note': null, ...overrides},
      'media': media,
      'call_availability': availability,
    });

/// A scripted soft-phone calls API. List reads wait for the test to answer;
/// the segment's `limit=1` probe answers at once from [probeRows] (recorded
/// apart in [probes]); the bootstrap and the detail answer at once.
class FakeSoftphoneCallsApi implements SoftphoneCallsApi {
  final List<ManualCallsQuery> queries = [];
  final List<Completer<ManualCallsPage>> pending = [];
  final List<ManualCallsQuery> probes = [];

  /// What the probe finds, per agent user id (none by default).
  Map<String, List<ManualCallListRow>> probeRows = {};
  Object? probeError;

  SoftphoneBootstrap? bootstrapAnswer = fixtures.bootstrap();
  int bootstrapReads = 0;

  final Map<String, ManualCallDetail> details = {};
  Object? detailError;
  final List<String> detailReads = [];

  @override
  Future<ManualCallsPage> listCalls(ManualCallsQuery query) {
    if (query.limit == 1 && query.cursor == null) {
      probes.add(query);
      if (probeError != null) return Future.error(probeError!);
      return Future.value(softRows(probeRows[query.agentUserId] ?? const []));
    }
    queries.add(query);
    final c = Completer<ManualCallsPage>();
    pending.add(c);
    return c.future;
  }

  @override
  Future<ManualCallDetail> callDetail(String callId) async {
    detailReads.add(callId);
    if (detailError != null) throw detailError!;
    return details[callId] ?? softDetail(call: {'id': callId});
  }

  @override
  Future<SoftphoneBootstrap> bootstrap() async {
    bootstrapReads++;
    final b = bootstrapAnswer;
    if (b == null) throw const ApiNetworkError('offline');
    return b;
  }

  Map<String, String> q(int i) => queries[i].toQuery();

  void answer(int i, ManualCallsPage p) => pending[i].complete(p);

  void fail(int i, [ApiError e = const ApiNetworkError('offline')]) => pending[i].completeError(e);
}

/// The calls tab's overrides plus the soft phone's: [visible] is the Phone tab's visibility.
List<Override> softphoneCallsOverrides(
  FakeSoftphoneCallsApi soft, {
  FakeAttemptsApi? attempts,
  FakePerformanceApi? perf,
  bool visible = true,
}) =>
    [
      ...callsOverrides(attempts ?? FakeAttemptsApi(), perf ?? FakePerformanceApi()),
      softphoneCallsApiProvider.overrideWithValue(soft),
      softphoneAvailabilityProvider.overrideWithValue(
        visible ? const SoftphoneAvailability(visible: true, startAllowed: true, loaded: true) : SoftphoneAvailability.hidden,
      ),
    ];
