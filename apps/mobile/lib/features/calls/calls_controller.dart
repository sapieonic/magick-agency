import 'package:agency_wire/agency_wire.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/providers.dart';
import '../../core/api/api_client.dart';
import '../performance/performance_api.dart';
import '../performance/performance_controller.dart';
import 'logic/attempt_filters.dart';

/// "My calls": the agent's own dial history, keyset-paged, newest first.
///
/// The filters live HERE, not in the widgets, and that is the cursor-reset
/// rule from the console's `useAgentAttempts`: a filter change that kept the
/// cursor would append page 2 of the old query to page 1 of the new one.
/// [AttemptsController.applyFilters] is the only way to change them, and it
/// always restarts from the first page. A generation counter drops any page
/// (first or "more") that belongs to a query no longer on screen.

class AttemptsApi {
  AttemptsApi(this._api);

  final ApiClient _api;

  /// `tenant:account`: the filters (a campaign id) never cross a switch.
  String get workspaceKey => '${_api.scope.tenantId ?? ''}:${_api.scope.accountId ?? ''}';

  /// `GET /proxy/agency/my-attempts`.
  Future<AttemptsPage> myAttempts(AttemptsQuery query) async {
    final body = await _api.get('/proxy/agency/my-attempts', query: query.toQuery());
    return decodeBody('/proxy/agency/my-attempts', body, decodeAttemptsPage);
  }
}

final attemptsApiProvider = Provider<AttemptsApi>((ref) => AttemptsApi(ref.watch(apiClientProvider)));

/// One page, the console's size, so both lists page at the same rate.
const attemptsPageSize = 50;

enum AttemptsStatus { loading, ready, error }

@immutable
class AttemptsState {
  AttemptsState({
    this.filters = AttemptFilters.initial,
    this.status = AttemptsStatus.loading,
    List<AttemptRow> rows = const [],
    this.nextCursor,
    this.error,
    this.loadingMore = false,
    this.moreError,
    this.refreshing = false,
  }) : rows = List.unmodifiable(rows);

  /// The APPLIED filters (never a draft being typed).
  final AttemptFilters filters;
  final AttemptsStatus status;
  final List<AttemptRow> rows;
  final String? nextCursor;

  /// A failed first page, in the agent's words. With [status] `ready` it is
  /// a failed refresh over rows that are still on screen.
  final String? error;
  final bool loadingMore;

  /// A failed "more": kept apart from [error] because the rows already on
  /// screen are still good.
  final String? moreError;

  /// Re-reading the first page while the old rows stay on screen
  /// (pull-to-refresh), so the list does not blank under the agent's thumb.
  final bool refreshing;

  bool get hasMore => nextCursor != null;

  AttemptsState copyWith({
    AttemptFilters? filters,
    AttemptsStatus? status,
    List<AttemptRow>? rows,
    String? nextCursor,
    bool clearCursor = false,
    String? error,
    bool clearError = false,
    bool? loadingMore,
    String? moreError,
    bool clearMoreError = false,
    bool? refreshing,
  }) =>
      AttemptsState(
        filters: filters ?? this.filters,
        status: status ?? this.status,
        rows: rows ?? this.rows,
        nextCursor: clearCursor ? null : (nextCursor ?? this.nextCursor),
        error: clearError ? null : (error ?? this.error),
        loadingMore: loadingMore ?? this.loadingMore,
        moreError: clearMoreError ? null : (moreError ?? this.moreError),
        refreshing: refreshing ?? this.refreshing,
      );

  @override
  bool operator ==(Object other) =>
      other is AttemptsState &&
      other.filters == filters &&
      other.status == status &&
      identical(other.rows, rows) &&
      other.nextCursor == nextCursor &&
      other.error == error &&
      other.loadingMore == loadingMore &&
      other.moreError == moreError &&
      other.refreshing == refreshing;

  @override
  int get hashCode => Object.hash(filters, status, identityHashCode(rows), nextCursor, error, loadingMore, moreError, refreshing);
}

class AttemptsController extends Notifier<AttemptsState> {
  int _generation = 0;
  String? _workspace;

  @override
  AttemptsState build() => AttemptsState();

  /// Replace the applied filters and read the first page. A no-op when
  /// nothing changed and a page is already on screen.
  Future<void> applyFilters(AttemptFilters filters) {
    if (filters == state.filters && state.status != AttemptsStatus.error && _workspace != null) {
      return Future.value();
    }
    return _loadFirst(filters, keepRows: false);
  }

  /// Read the first page again under the current filters. With [keepRows]
  /// (pull-to-refresh) the old rows stay until the new page lands.
  Future<void> reload({bool keepRows = false}) => _loadFirst(state.filters, keepRows: keepRows && state.rows.isNotEmpty);

  /// Ensure a first page exists (screen arrival, workspace switch).
  Future<void> ensureLoaded() {
    final key = ref.read(attemptsApiProvider).workspaceKey;
    if (_workspace != key) {
      _workspace = key;
      // A campaign id belongs to one workspace: start clean in a new one.
      return _loadFirst(AttemptFilters.initial, keepRows: false);
    }
    if (state.status == AttemptsStatus.ready) return Future.value();
    return _loadFirst(state.filters, keepRows: false);
  }

  Future<void> _loadFirst(AttemptFilters filters, {required bool keepRows}) async {
    _workspace = ref.read(attemptsApiProvider).workspaceKey;
    final mine = ++_generation;
    state = keepRows
        ? state.copyWith(filters: filters, refreshing: true, loadingMore: false, clearMoreError: true)
        : AttemptsState(filters: filters);

    try {
      final page = await ref.read(attemptsApiProvider).myAttempts(_query(filters, null));
      if (!ref.mounted || mine != _generation) return;
      state = AttemptsState(filters: filters, status: AttemptsStatus.ready, rows: page.rows, nextCursor: page.nextCursor);
    } on Exception catch (e) {
      if (!ref.mounted || mine != _generation) return;
      final message = errorMessage(e, 'We couldn’t load these calls.');
      state = keepRows
          // The rows on screen are still good: keep them, say the refresh failed.
          ? state.copyWith(refreshing: false, error: message)
          : AttemptsState(filters: filters, status: AttemptsStatus.error, error: message);
    }
  }

  /// Append the next page. Safe to call repeatedly (the list calls it as the
  /// agent nears the end): it does nothing while a page is in flight, after a
  /// failed "more" (until [retryMore]), or on the last page.
  Future<void> loadMore() async {
    final s = state;
    if (s.status != AttemptsStatus.ready || s.nextCursor == null || s.loadingMore || s.moreError != null || s.refreshing) {
      return;
    }
    // CAPTURED, not incremented: a continuation of the query on screen. A
    // filter change while this is in flight moves the counter on and this
    // page is thrown away instead of being appended under the new filter.
    final mine = _generation;
    state = s.copyWith(loadingMore: true);
    try {
      final page = await ref.read(attemptsApiProvider).myAttempts(_query(s.filters, s.nextCursor));
      if (!ref.mounted || mine != _generation) return;
      state = state.copyWith(
        rows: [...state.rows, ...page.rows],
        nextCursor: page.nextCursor,
        clearCursor: page.nextCursor == null,
        loadingMore: false,
      );
    } on Exception catch (e) {
      if (!ref.mounted || mine != _generation) return;
      state = state.copyWith(loadingMore: false, moreError: errorMessage(e, 'We couldn’t load any more calls.'));
    }
  }

  /// Clear a failed "more" and try it again.
  Future<void> retryMore() {
    if (state.moreError == null) return Future.value();
    state = state.copyWith(clearMoreError: true);
    return loadMore();
  }

  AttemptsQuery _query(AttemptFilters filters, String? cursor) => filters.toQuery(
        cursor: cursor,
        limit: attemptsPageSize,
        now: ref.read(statsClockProvider)(),
        calendar: ref.read(localCalendarProvider),
      );
}

final attemptsControllerProvider = NotifierProvider<AttemptsController, AttemptsState>(AttemptsController.new);
