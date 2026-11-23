import 'dart:async';

import 'package:agency_wire/agency_wire.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/providers.dart';
import '../../core/api/api_client.dart';
import '../../core/api/api_error.dart';
import '../../core/api/decode_body.dart';
import '../../core/auth/app_gate.dart';
import '../missed/missed_access.dart';
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

/// Why the list did not load, in words. A 404 with no code of ours is the
/// route itself missing: a server from before My calls was one list (an app
/// installed ahead of its server, or a server rolled back), which no retry
/// cures, so it says what does. A 404 the route answers (`campaign_not_found`)
/// carries its code and reads as any refusal.
String myCallsLoadError(Object error) =>
    error is ApiHttpError && error.status == 404 && error.code == null
        ? MyCallsCopy.serverTooOld
        : errorMessage(error, MyCallsCopy.loadFailed);

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

/// The open rows a Missed badge says: `''` is none, `'100+'` the server's cap
/// (the count My calls' own `missed_open` stops at too).
int _missedBadgeOpen(String badge) => badge.isEmpty ? 0 : int.tryParse(badge.replaceAll('+', '')) ?? 0;

class MyCallsController extends Notifier<MyCallsState> {
  int _generation = 0;
  String? _workspace;
  bool _requested = false;

  /// The open Missed count moved while a first page was in flight.
  bool _countsStale = false;

  /// This controller's own Mark handled is moving the count and reloading.
  bool _markingMove = false;

  /// Rebuilt whenever the workspace changes (another account, another agent,
  /// signed out): the rows, the cursor and the chip are dropped at once, and a
  /// page in flight for the old one is thrown away.
  @override
  MyCallsState build() {
    _workspace = ref.watch(agentWorkspaceProvider);
    _generation++;
    _requested = false;
    _countsStale = false;
    _markingMove = false;
    // The To follow up badge and the shell's My calls badge count the same
    // open Missed rows. When the shell's moves (a call was just missed, or
    // one was handled from the Missed list), what is owed is read again, so
    // the two never show different numbers for long.
    ref.listen<String>(missedCallsAccessProvider.select((a) => a.badge), (prev, next) {
      // Mark handled here moves the count and reads the list again itself.
      if (prev != next && !_markingMove) unawaited(missedCountChanged());
    });
    return MyCallsState();
  }

  /// The open Missed count moved: read what is owed again. Under To follow up
  /// the list itself changed, so its first page is read again (the rows stay
  /// until it lands); under another chip only the counts are, and the rows,
  /// the cursor and the pages already loaded are left alone. While a first
  /// page is in flight, the read waits for it and then runs, since that page
  /// may have been asked for before the count moved.
  Future<void> missedCountChanged() async {
    if (_workspace == null || !_requested) return;
    final s = state;
    if (s.status == MyCallsStatus.loading || s.refreshing) {
      _countsStale = true;
      return;
    }
    if (s.status != MyCallsStatus.ready) return;
    // The page on screen already counts what the shell's badge says: nothing
    // to read (the badge's first answer after a first page, most often).
    if (s.counts != null && _missedBadgeOpen(ref.read(missedCallsAccessProvider).badge) == s.counts!.missedOpen) return;
    if (s.type == MyCallsTypeFilter.toFollowUp) return reload(keepRows: true);
    final mine = _generation;
    try {
      final page = await ref.read(myCallsApiProvider).myCalls(MyCallsQuery(type: s.type, limit: 1, includeCounts: true));
      if (!ref.mounted || mine != _generation) return;
      if (page.counts != null) state = state.copyWith(counts: page.counts);
    } on Exception catch (e) {
      // The badge keeps its last number; the next read of the list brings a new one.
      if (ref.mounted) reportToGate(ref, e);
    }
  }

  /// Ensure a first page exists (screen arrival, workspace switch).
  Future<void> ensureLoaded() {
    final current = state; // brings the workspace up to date first
    if (_requested && current.status != MyCallsStatus.error) return Future.value();
    return _loadFirst(current.type, keepRows: false, recount: false);
  }

  /// Choose a chip and read its first page. A no-op for the chip already on.
  /// What the agent owes does not depend on the chip, so the counts already
  /// held are kept and not asked for again.
  Future<void> choose(MyCallsTypeFilter type) {
    if (type == state.type && _requested && state.status != MyCallsStatus.error) return Future.value();
    return _loadFirst(type, keepRows: false, recount: false);
  }

  /// Read the first page again, and what is owed with it (pull to refresh,
  /// Retry, after Mark handled, the Missed badge moving under To follow up).
  /// With [keepRows] the old rows stay until the new page lands.
  Future<void> reload({bool keepRows = false}) =>
      _loadFirst(state.type, keepRows: keepRows && !state.isEmpty, recount: true);

  /// [recount] asks for the counts again; without it they are asked for only
  /// while none are held (the first page, or after one that failed).
  Future<void> _loadFirst(MyCallsTypeFilter type, {required bool keepRows, required bool recount}) async {
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
          .myCalls(MyCallsQuery(type: type, limit: myCallsPageSize, includeCounts: recount || counts == null));
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
      final message = myCallsLoadError(e);
      state = keepRows
          // The rows on screen are still good: keep them, say the refresh failed.
          ? state.copyWith(refreshing: false, error: message)
          : MyCallsState(type: type, status: MyCallsStatus.error, error: message, counts: counts);
    }
    if (_countsStale && ref.mounted && mine == _generation) {
      _countsStale = false;
      unawaited(missedCountChanged());
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
      _markingMove = true;
      unawaited(ref.read(missedCountControllerProvider.notifier).refresh());
      if (mine == _generation) {
        state = state.copyWith(clearMarking: true);
        unawaited(reload(keepRows: true).whenComplete(() => _markingMove = false));
      } else {
        _markingMove = false;
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

  /// The Missed row behind a To follow up card, for its Call back: the row is
  /// read by its id (the Missed list's own rule for whose row it is) at the
  /// moment it is needed, for the pad; by id, so it is found however many
  /// rows the agent has open. The number is never in My calls' own rows where
  /// the campaign hides numbers. Null (and a row error) when it cannot be read.
  Future<InboundMissedCall?> missedCallFor(MyCallRow row) async {
    state = state.copyWith(clearRowError: true);
    try {
      final call = await ref.read(missedCallsApiProvider).one(row.id);
      if (!ref.mounted) return null;
      return call;
    } on Exception catch (e) {
      if (!ref.mounted) return null;
      reportToGate(ref, e);
    }
    state = state.copyWith(rowError: (id: row.id, message: MyCallsCopy.callBackFailed));
    return null;
  }
}

final myCallsControllerProvider = NotifierProvider<MyCallsController, MyCallsState>(MyCallsController.new);
