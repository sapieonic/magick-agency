import 'dart:async';

import 'package:agency_wire/agency_wire.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/misc.dart' show Override;
import 'package:magick_agency_agent/core/api/api_error.dart';
import 'package:magick_agency_agent/core/flags/feature_flags.dart';
import 'package:magick_agency_agent/core/station/station_view.dart';
import 'package:magick_agency_agent/features/contacts/my_contacts_api.dart';

import '../performance/support.dart';

export '../performance/support.dart';

/// Test doubles for My contacts (contact assignment).

/// `fixedNow` is 2026-10-14 05:00 UTC.
MyContact contact(
  int n, {
  MyContactBucket bucket = MyContactBucket.notReached,
  ContactState state = ContactState.pending,
  DateTime? next,
  bool eligible = false,
  AgentRetryBlock? blocked,
  ContactOverride? grant,
  List<HeroField> hero = const [HeroField(name: 'Name', value: 'Asha Rao')],
}) =>
    MyContact(
      id: 'k$n',
      campaignId: 'c1',
      phoneE164: '+9198400${(10000 + n).toString().padLeft(5, '0')}',
      bucket: bucket,
      state: state,
      attemptCount: 1,
      lastOutcome: 'no_answer',
      nextAttemptAt: next ?? fixedNow.add(const Duration(hours: 2)),
      lastAttemptAt: fixedNow.subtract(const Duration(hours: 1)),
      hero: hero,
      retry: MyContactRetry(eligible: eligible, blocked: eligible ? null : blocked, roundsUsed: 0),
      overrideGrant: grant,
    );

ContactOverride grant({int extra = 0, bool early = false, bool hours = false}) => ContactOverride(
      disposition: 'promise_to_pay',
      extraAttempts: extra,
      retryDelay: early,
      callingHours: hours,
      grantedAt: fixedNow.subtract(const Duration(days: 1)),
    );

MyContactsPage contactsPage(List<MyContact> rows, {String? next}) => KeysetPage(rows: rows, nextCursor: next, limit: 50);

MyContactsSummary summaryOf({
  int dueNow = 0,
  bool retryAllowed = true,
  int eligible = 3,
  QueueState? queue,
  AssignmentMode mode = AssignmentMode.strict,
}) =>
    MyContactsSummary(
      campaignId: 'c1',
      assignmentMode: mode,
      total: 30,
      counts: ContactBucketCounts(const {
        'pending': 12,
        'callback': 2,
        'not_reached': 5,
        'in_progress': 0,
        'reached': 7,
        'exhausted': 3,
        'suppressed': 1,
      }),
      dueNow: dueNow,
      queue: queue ?? QueueState(due: false, reason: QueueIdleReason.waitingForRetry, nextDueAt: fixedNow.add(const Duration(hours: 2))),
      unassignedOpen: 0,
      retry: MyContactsRetrySummary(allowed: retryAllowed, rounds: 1, cooldownMinutes: 30, eligible: eligible),
    );

/// A refusal of an own-contact route, as the API client raises it.
ApiHttpError refusal(String code, {int status = 409, Map<String, Object?>? details, String message = 'The server’s words'}) =>
    ApiHttpError(
      status: status,
      code: code,
      message: message,
      body: {'error': 'Conflict', 'code': code, 'message': message, 'details': ?details},
      requestId: null,
    );

/// A scripted API: list pages wait until the test answers them; the rest
/// answer with what the test set (a value, or an error to throw).
class FakeMyContactsApi implements MyContactsApi {
  final List<MyContactsQuery> queries = [];
  final List<Completer<MyContactsPage>> pending = [];
  final List<String> summaries = [];
  final List<AgentRetryRequest> retries = [];
  final List<(String, MyContactCallRequest)> calls = [];

  Object summaryAnswer = summaryOf();
  Object retryAnswer = AgentRetryResponse(reopened: 3, skipped: const [], skippedTotal: 0);
  final List<Object> callAnswers = [];

  /// When set, list requests answer at once with it (screen tests).
  MyContactsPage? autoPage;

  Future<T> _answer<T>(Object a) => switch (a) {
        final Future<T> f => f,
        final T v => Future.value(v),
        _ => Future.error(a),
      };

  @override
  Future<MyContactsSummary> summary(String campaignId) {
    summaries.add(campaignId);
    return _answer(summaryAnswer);
  }

  @override
  Future<MyContactsPage> list(MyContactsQuery query) {
    queries.add(query);
    if (autoPage != null) return Future.value(autoPage);
    final c = Completer<MyContactsPage>();
    pending.add(c);
    return c.future;
  }

  @override
  Future<AgentRetryResponse> retry(AgentRetryRequest request) {
    retries.add(request);
    return _answer(retryAnswer);
  }

  @override
  Future<MyContactCallResponse> call(String contactId, MyContactCallRequest request) {
    calls.add((contactId, request));
    return _answer(callAnswers.isEmpty ? placed(contactId) : callAnswers.removeAt(0));
  }

  Map<String, String> q(int i) => queries[i].toQuery();

  void answer(int i, MyContactsPage p) => pending[i].complete(p);

  void fail(int i, [ApiError e = const ApiNetworkError('offline')]) => pending[i].completeError(e);
}

MyContactCallResponse placed(String contactId, {List<String> applied = const []}) => MyContactCallResponse(
      attemptId: 'att-$contactId',
      contactId: contactId,
      overrideAppliedRaw: applied,
      retryRoundSpent: false,
    );

/// The station as My contacts sees it: on duty on `c1` and available, unless
/// the test sets otherwise.
class StationHolder extends Notifier<StationView?> {
  StationHolder(this.initial);
  final StationView? initial;

  @override
  StationView? build() => initial;

  void set(StationView? v) => state = v;
}

StationView onStation({
  String campaignId = 'c1',
  AgentPhase phase = AgentPhase.available,
  String? sessionId = 'sess-1',
  bool dialing = true,
}) =>
    StationView(
      campaignId: campaignId,
      campaignName: 'Renewals',
      sessionId: sessionId,
      link: StationLink.open,
      phase: phase,
      campaignDialing: dialing,
      myContactsOffered: true,
    );

/// The server's refusal of a call outside the calling hours to a contact
/// holding an unspent calling-hours override, sent without a note
/// (`my-contact-call.ts`, the `defer` arm).
ApiHttpError noteWanted() => refusal('override_note_invalid', status: 400, details: {'min': 10, 'max': 500});

final stationHolder = NotifierProvider<StationHolder, StationView?>(() => StationHolder(onStation()));

List<Override> contactsOverrides(FakeMyContactsApi api, {bool flag = true}) => [
      ...perfOverrides(FakePerformanceApi()),
      myContactsApiProvider.overrideWithValue(api),
      stationViewProvider.overrideWith((ref) => ref.watch(stationHolder)),
      contactAssignmentEnabledProvider.overrideWithValue(flag),
    ];
