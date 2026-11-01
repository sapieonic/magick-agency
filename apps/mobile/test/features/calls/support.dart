import 'dart:async';

import 'package:agency_wire/agency_wire.dart';
import 'package:flutter_riverpod/misc.dart' show Override;
import 'package:magick_agency_agent/core/api/api_error.dart';
import 'package:magick_agency_agent/features/calls/calls_controller.dart';

import '../performance/support.dart';

export '../performance/support.dart';

AttemptRow attempt(
  int n, {
  String campaign = 'c1',
  AttemptOutcome? outcome = AttemptOutcome.connected,
  String? code = 'Callback',
  String? notes,
  double? talk = 221,
  DateTime? created,
  bool onBehalf = false,
}) =>
    AttemptRow(
      id: 'a$n',
      campaignId: campaign,
      contactId: 'k$n',
      attemptNumber: 2,
      phoneE164: '+9198400${(10000 + n).toString().padLeft(5, '0')}',
      callerId: '+918000000000',
      state: AttemptState.ended,
      outcome: outcome,
      dispositionCode: code,
      notes: notes,
      dispositionedOnBehalf: onBehalf,
      talkSeconds: talk,
      createdAt: created ?? DateTime.utc(2026, 10, 14, 4, 30).subtract(Duration(minutes: n)),
    );

AttemptsPage page(Iterable<int> ids, {String? next}) =>
    KeysetPage(rows: [for (final i in ids) attempt(i)], nextCursor: next, limit: attemptsPageSize);

/// A scripted `/my-attempts`: every request waits until the test answers it.
class FakeAttemptsApi implements AttemptsApi {
  String workspace = 't1:a1';
  final List<AttemptsQuery> queries = [];
  final List<Completer<AttemptsPage>> pending = [];

  @override
  String get workspaceKey => workspace;

  @override
  Future<AttemptsPage> myAttempts(AttemptsQuery query) {
    queries.add(query);
    final c = Completer<AttemptsPage>();
    pending.add(c);
    return c.future;
  }

  Map<String, String> q(int i) => queries[i].toQuery();

  void answer(int i, AttemptsPage p) => pending[i].complete(p);

  void fail(int i, [ApiError e = const ApiNetworkError('offline')]) => pending[i].completeError(e);
}

List<Override> callsOverrides(FakeAttemptsApi api, FakePerformanceApi perf) => [
      ...perfOverrides(perf),
      attemptsApiProvider.overrideWithValue(api),
    ];
