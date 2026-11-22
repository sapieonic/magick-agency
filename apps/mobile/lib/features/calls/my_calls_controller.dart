import 'dart:async';

import 'package:agency_wire/agency_wire.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/providers.dart';
import '../../core/api/api_client.dart';
import '../../core/api/decode_body.dart';
import '../../core/auth/app_gate.dart';
import '../missed/missed_calls_api.dart';
import '../missed/missed_calls_copy.dart';
import '../missed/missed_count_controller.dart';
import '../performance/performance_api.dart' show errorMessage;
import 'my_calls_copy.dart';

/// My calls (`docs/call-log.md` §7): the agent's own calls of every type from
/// `GET /proxy/agency/my-calls`, keyset-paged, newest first, with the chip the
/// agent chose.
///
/// The chip lives HERE, not in the widgets (the cursor-reset rule): a chip
/// change that kept the cursor would append page 2 of the old list to page 1
/// of the new one. [MyCallsController.choose] is the only way to change it and
/// always restarts from the first page. A generation counter drops any page
/// that belongs to a list no longer on screen.

class MyCallsApi {
  MyCallsApi(this._api);

  final ApiClient _api;

  static const path = '/proxy/agency/my-calls';

  /// `GET /proxy/agency/my-calls`.
  Future<MyCallsPage> myCalls(MyCallsQuery query) async {
    final body = await _api.get(path, query: query.toQuery());
    return decodeBody(path, body, MyCallsPage.fromJson);
  }
}

final myCallsApiProvider = Provider<MyCallsApi>((ref) => MyCallsApi(ref.watch(apiClientProvider)));

/// One page, the console's size.
const myCallsPageSize = 50;

enum MyCallsStatus { loading, ready, error }

@immutable
class MyCallsState {
  MyCallsState({
    this.type = MyCallsTypeFilter.all,
    this.status = MyCallsStatus.loading,
    List<MyCallRow> rows = const [],
    List<MyCallbackDue> callbacks = const [],
    this.counts,
    this.nextCursor,
    this.error,
    this.loadingMore = false,
    this.moreError,
    this.refreshing = false,
    this.marking,
    this.rowError,
  })  : rows = List.unmodifiable(rows),
        callbacks = List.unmodifiable(callbacks);

  /// The chip that is on.
  final MyCallsTypeFilter type;
  final MyCallsStatus status;
  final List<MyCallRow> rows;

  /// Under To follow up: the callbacks the agent booked that are due.
  final List<MyCallbackDue> callbacks;

  /// What the agent still owes (the To follow up badge); kept across chips.
  final MyCallsCounts? counts;
  final String? nextCursor;
  final String? error;
  final bool loadingMore;
  final String? moreError;
  final bool refreshing;

  /// The missed call being marked handled.
  final String? marking;

  /// A row's last refusal.
  final ({String id, String message})? rowError;

  bool get hasMore => nextCursor != null;
  bool get isEmpty => rows.isEmpty && callbacks.isEmpty;

  MyCallsState copyWith({
    MyCallsStatus? status,
    List<MyCallRow>? rows,
    List<MyCallbackDue>? callbacks,
    MyCallsCounts? counts,
    String? nextCursor,
    bool clearCursor = false,
    String? error,
    bool clearError = false,
    bool? loadingMore,
    String? moreError,
    bool clearMoreError = false,
    bool? refreshing,
    String? marking,
    bool clearMarking = false,
    ({String id, String message})? rowError,
    bool clearRowError = false,
  }) =>
      MyCallsState(
        type: type,
        status: status ?? this.status,
        rows: rows ?? this.rows,
        callbacks: callbacks ?? this.callbacks,
        counts: counts ?? this.counts,
        nextCursor: clearCursor ? null : (nextCursor ?? this.nextCursor),
        error: clearError ? null : (error ?? this.error),
        loadingMore: loadingMore ?? this.loadingMore,
        moreError: clearMoreError ? null : (moreError ?? this.moreError),
        refreshing: refreshing ?? this.refreshing,
        marking: clearMarking ? null : (marking ?? this.marking),
        rowError: clearRowError ? null : (rowError ?? this.rowError),
      );
}

class MyCallsController extends Notifier<MyCallsState> {
  int _generation = 0;
  String? _workspace;
  bool _requested = false;

  /// Rebuilt whenever the workspace changes (another account, another agent,
  /// signed out): the rows, the cursor and the chip are dropped at once, and a
  /// page in flight for the old one is thrown away.
  @override
  MyCallsState build() {
    _workspace = ref.watch(agentWorkspaceProvider);
    _generation++;
    _requested = false;
    return MyCallsState();
  }

  /// Ensure a first page exists (screen arrival, workspace switch).
  Future<void> ensureLoaded() {
    final current = state; // brings the workspace up to date first
    if (_requested && current.status != MyCallsStatus.error) return Future.value();
    return _loadFirst(current.type, keepRows: false);
  }

  /// Choose a chip and read its first page. A no-op for the chip already on.
  Future<void> choose(MyCallsTypeFilter type) {
    if (type == state.type && _requested && state.status != MyCallsStatus.error) return Future.value();
    return _loadFirst(type, keepRows: false);
  }

  /// Read the first page again. With [keepRows] (pull to refresh) the old
  /// rows stay until the new page lands.
  Future<void> reload({bool keepRows = false}) => _loadFirst(state.type, keepRows: keepRows && !state.isEmpty);

  Future<void> _loadFirst(MyCallsTypeFilter type, {required bool keepRows}) async {
    // Signed out (or between accounts): there is nobody to read for.
    if (_workspace == null) return;
    _requested = true;
    final mine = ++_generation;
    final counts = state.counts;
    state = keepRows
        ? state.copyWith(refreshing: true, loadingMore: false, clearMoreError: true)
        : MyCallsState(type: type, counts: counts);
    try {
      final page = await ref
          .read(myCallsApiProvider)
          .myCalls(MyCallsQuery(type: type, limit: myCallsPageSize, includeCounts: true));
      if (!ref.mounted || mine != _generation) return;
      state = MyCallsState(
        type: type,
        status: MyCallsStatus.ready,
        rows: page.rows,
        callbacks: page.callbacksDue ?? const [],
        counts: page.counts ?? counts,
        nextCursor: page.nextCursor,
      );
    } on Exception catch (e) {
      if (!ref.mounted || mine != _generation) return;
      reportToGate(ref, e); // a 401 here is the end of the sign-in, as anywhere
      final message = errorMessage(e, MyCallsCopy.loadFailed);
      state = keepRows
          // The rows on screen are still good: keep them, say the refresh failed.
          ? state.copyWith(refreshing: false, error: message)
          : MyCallsState(type: type, status: MyCallsStatus.error, error: message, counts: counts);
    }
  }

  /// Append the next page. Safe to call repeatedly: it does nothing while a
  /// page is in flight, after a failed "more" (until [retryMore]), or on the
  /// last page.
  Future<void> loadMore() async {
    final s = state;
    if (s.status != MyCallsStatus.ready || s.nextCursor == null || s.loadingMore || s.moreError != null || s.refreshing) {
      return;
    }
    // CAPTURED, not incremented: a continuation of the list on screen.
    final mine = _generation;
    state = s.copyWith(loadingMore: true);
    try {
      final page = await ref
          .read(myCallsApiProvider)
          .myCalls(MyCallsQuery(type: s.type, limit: myCallsPageSize, cursor: s.nextCursor));
      if (!ref.mounted || mine != _generation) return;
      state = state.copyWith(
        rows: [...state.rows, ...page.rows],
        nextCursor: page.nextCursor,
        clearCursor: page.nextCursor == null,
        loadingMore: false,
      );
    } on Exception catch (e) {
      if (!ref.mounted || mine != _generation) return;
      reportToGate(ref, e);
      state = state.copyWith(loadingMore: false, moreError: errorMessage(e, MyCallsCopy.moreFailed));
    }
  }

  /// Clear a failed "more" and try it again.
  Future<void> retryMore() {
    if (state.moreError == null) return Future.value();
    state = state.copyWith(clearMoreError: true);
    return loadMore();
  }

  /// Mark handled: the Missed list's own action (`POST /inbound/missed/:id/handled`).
  /// The list and the badges are read again. A refusal is said on the row.
  Future<bool> markHandled(MyCallRow row) async {
    if (state.marking != null) return false;
    state = state.copyWith(marking: row.id, clearRowError: true);
    final mine = _generation;
    try {
      await ref.read(missedCallsApiProvider).markHandled(row.id);
      if (!ref.mounted) return true;
      unawaited(ref.read(missedCountControllerProvider.notifier).refresh());
      if (mine == _generation) {
        state = state.copyWith(clearMarking: true);
        unawaited(reload(keepRows: true));
      }
      return true;
    } on Exception catch (e) {
      if (!ref.mounted) return false;
      reportToGate(ref, e);
      if (mine == _generation) {
        state = state.copyWith(clearMarking: true, rowError: (id: row.id, message: MissedCopy.handledRefusal(e)));
      }
      return false;
    }
  }

  /// The Missed row behind a To follow up card, for its Call back: the number
  /// is read from the Missed list (the agent's own open rows) at the moment
  /// it is needed, for the pad. It is never in My calls' own rows where the
  /// campaign hides numbers. Null (and a row error) when it cannot be read.
  Future<InboundMissedCall?> missedCallFor(MyCallRow row) async {
    state = state.copyWith(clearRowError: true);
    try {
      final page = await ref.read(missedCallsApiProvider).list(
            const InboundMissedQuery(status: InboundFollowUpStatus.open, assignee: InboundMissedQuery.assigneeMe, limit: 100),
          );
      if (!ref.mounted) return null;
      for (final call in page.rows) {
        if (call.id == row.id) return call;
      }
    } on Exception catch (e) {
      if (!ref.mounted) return null;
      reportToGate(ref, e);
    }
    state = state.copyWith(rowError: (id: row.id, message: MyCallsCopy.callBackFailed));
    return null;
  }
}

final myCallsControllerProvider = NotifierProvider<MyCallsController, MyCallsState>(MyCallsController.new);
