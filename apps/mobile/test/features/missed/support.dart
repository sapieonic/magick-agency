import 'dart:async';

import 'package:agency_wire/agency_wire.dart';
import 'package:flutter_riverpod/misc.dart' show Override;
import 'package:magick_agency_agent/core/api/api_error.dart';
import 'package:magick_agency_agent/core/flags/feature_flags.dart';
import 'package:magick_agency_agent/core/lifecycle/app_lifecycle.dart';
import 'package:magick_agency_agent/features/missed/missed_calls_api.dart';
import 'package:magick_agency_agent/features/missed/missed_count_controller.dart';

import '../performance/support.dart';

export '../performance/support.dart';

/// Test doubles for the Missed list.

/// One Missed row as the server sends it (the shape of
/// `packages/contracts/fixtures/agent/inbound.json`'s `missed_page`), open,
/// matched, out of hours; [over] replaces fields.
Map<String, Object?> missedJson(String id, [Map<String, Object?> over = const {}]) => {
      'id': id,
      'account_id': 'a1',
      'route_id': 'r1',
      'route_name': 'Pune customer line',
      'to_e164': '+912071234500',
      'caller_dnc': false,
      'has_voicemail': false,
      'voicemail_url': null,
      'assignee_user_id': 'u1',
      'assignee_name': 'Meera K',
      'assignee_departed': false,
      'status': 'open',
      'handled_reason': null,
      'handled_by_user_id': null,
      'handled_by_name': null,
      'handled_at': null,
      'from_e164': '+918765432109',
      'arrived_at': '2026-10-14T04:12:05.000Z',
      'ended_at': '2026-10-14T04:12:19.400Z',
      'reason': 'closed',
      'closed_cause': 'hours',
      'outcome': 'closed',
      'matched_contact_id': 'k1',
      'matched_campaign_id': 'camp-1',
      'matched_campaign_name': 'Q4 Renewals',
      'callback_due_at': null,
      ...over,
    };

InboundMissedCall missed(String id, [Map<String, Object?> over = const {}]) =>
    InboundMissedCall.fromJson(missedJson(id, over));

/// The row as handled by the agent (`u1`).
InboundMissedCall handledCopy(InboundMissedCall call, {String reason = 'marked'}) => missed(call.id, {
      'from_e164': call.fromE164,
      'status': 'handled',
      'handled_reason': reason,
      'handled_by_user_id': 'u1',
      'handled_by_name': 'Meera K',
      'handled_at': '2026-10-14T04:30:00.000Z',
    });

InboundMissedPage missedPage(List<InboundMissedCall> rows, {String? next}) =>
    KeysetPage(rows: rows, nextCursor: next, limit: 50);

InboundMissedCountResponse countOf(int open, {bool capped = false, bool? hasRows}) =>
    InboundMissedCountResponse(open: open, openCapped: capped, hasRows: hasRows ?? open > 0);

/// A refusal of a Missed route, as the API client raises it.
ApiHttpError inboundRefusal(String code, {int status = 404, String message = 'The server’s words'}) => ApiHttpError(
      status: status,
      code: code,
      message: message,
      body: {'error': 'Not Found', 'code': code, 'message': message},
      requestId: null,
    );

const forbidden = ApiHttpError(
  status: 403,
  code: null,
  message: 'You do not have permission',
  body: {'error': 'Forbidden', 'message': 'You do not have permission'},
  requestId: null,
);

/// A scripted API: list pages wait until the test answers them (unless
/// [autoPage] is set); the rest answer with what the test set.
class FakeMissedCallsApi implements MissedCallsApi {
  final List<InboundMissedQuery> queries = [];
  final List<Completer<InboundMissedPage>> pending = [];
  final List<String> handled = [];
  final List<String> reopened = [];
  int countReads = 0;

  /// What `count()` answers: a response, or an error to throw.
  Object countAnswer = countOf(3);

  /// When set, list requests answer at once with it (screen tests).
  InboundMissedPage? autoPage;

  /// What the row actions answer; by default the row handled / reopened.
  Object? handledAnswer;
  Object? reopenAnswer;

  Future<T> _answer<T>(Object a) => switch (a) {
        final Future<T> f => f,
        final T v => Future.value(v),
        _ => Future.error(a),
      };

  @override
  Future<InboundMissedPage> list(InboundMissedQuery query) {
    queries.add(query);
    if (autoPage != null) return Future.value(autoPage);
    final c = Completer<InboundMissedPage>();
    pending.add(c);
    return c.future;
  }

  @override
  Future<InboundMissedCountResponse> count() {
    countReads++;
    return _answer(countAnswer);
  }

  @override
  Future<InboundMissedCall> markHandled(String id) {
    handled.add(id);
    return _answer(handledAnswer ?? handledCopy(missed(id)));
  }

  @override
  Future<InboundMissedCall> reopen(String id) {
    reopened.add(id);
    return _answer(reopenAnswer ?? missed(id));
  }

  void answer(int i, InboundMissedPage p) => pending[i].complete(p);

  void fail(int i, [ApiError e = const ApiNetworkError('offline')]) => pending[i].completeError(e);
}

/// An app-lifecycle source a test drives.
class TestLifecycle implements AppLifecycleSource {
  void Function()? _onShow;
  void Function()? _onHide;

  @override
  bool isForeground = true;

  @override
  void attach({required void Function() onHide, required void Function() onShow}) {
    _onShow = onShow;
    _onHide = onHide;
  }

  @override
  void detach() {
    _onShow = null;
    _onHide = null;
  }

  void show() {
    isForeground = true;
    _onShow?.call();
  }

  void hide() {
    isForeground = false;
    _onHide?.call();
  }
}

/// A clock a test moves.
class TestClock {
  DateTime now = fixedNow;
  DateTime call() => now;
}

/// The Missed list's providers over [api], with the inbound flag as [inboundOn].
List<Override> missedOverrides(
  FakeMissedCallsApi api, {
  bool inboundOn = true,
  TestLifecycle? lifecycle,
  TestClock? clock,
  bool base = true,
  Duration? poll,
}) =>
    [
      // The gate, the workspace and the clock; left out where a screen's own helper brings them.
      if (base) ...perfOverrides(FakePerformanceApi()),
      missedCallsApiProvider.overrideWithValue(api),
      featureFlagProvider(inboundFlagKey).overrideWithValue(inboundOn),
      missedLifecycleSourceProvider.overrideWithValue(lifecycle ?? TestLifecycle()),
      missedClockProvider.overrideWithValue((clock ?? TestClock()).call),
      // No poll unless a test is about it: a widget test must end with no timer pending.
      missedCountPollProvider.overrideWithValue(poll),
      ...missedCallsOverrides,
    ];
