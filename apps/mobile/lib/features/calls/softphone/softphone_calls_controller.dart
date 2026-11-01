import 'package:agency_wire/agency_wire.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/auth/app_gate.dart';
import '../../../core/softphone/softphone_api.dart';
import '../../../core/softphone/softphone_view.dart';
import '../../performance/performance_api.dart';

/// "My calls" → "Soft-phone calls": the agent's own manual calls, keyset-paged,
/// newest first (a port of the console's `SoftphoneCallsList` in its `me` scope).
///
/// The same rules as the campaign list (`AttemptsController`): the filters live
/// here, and [SoftphoneCallsController.applyFilters] is the only way to change
/// them, always from the first page (a filter change that kept the cursor would
/// append page 2 of the old query to page 1 of the new one); a generation
/// counter drops any page that belongs to a query no longer on screen; and
/// everything is keyed on [agentWorkspaceProvider], so one agent never sees
/// another's calls.
///
/// Every request names the agent (`agent_user_id`): the server lists the whole
/// account's calls to a caller with `agency.supervise`, and a supervisor using
/// the app must still see only their own here.

/// The reads this tab makes, over [SoftphoneApi] (a seam, so tests script them).
class SoftphoneCallsApi {
  SoftphoneCallsApi(this._api);

  final SoftphoneApi _api;

  Future<ManualCallsPage> listCalls(ManualCallsQuery query) => _api.listCalls(query);

  Future<ManualCallDetail> callDetail(String callId) => _api.callDetail(callId);

  /// For the names only: the outcome catalogs and the call-field labels.
  Future<SoftphoneBootstrap> bootstrap() => _api.bootstrap();
}

final softphoneCallsApiProvider = Provider<SoftphoneCallsApi>(
  (ref) => SoftphoneCallsApi(ref.watch(softphoneApiProvider)),
);

/// The signed-in agent's user id, from the workspace key (`user:tenant:account`).
/// Ids are UUIDs, so the first segment is the whole id.
String? workspaceUserId(String? workspace) {
  if (workspace == null) return null;
  final id = workspace.split(':').first;
  return id.isEmpty ? null : id;
}

/// One page, the console's size.
const softphoneCallsPageSize = 50;

/// The status filter's choices, in the console's words (`SOFTPHONE_CALL_STATUS_OPTIONS`).
const softphoneCallStatusLabels = <ManualCallListStatus, String>{
  ManualCallListStatus.live: 'On a call now',
  ManualCallListStatus.awaitingOutcome: 'Waiting for an outcome',
  ManualCallListStatus.settled: 'Done',
};

/// The applied filters: the number (digits only, a suffix match on the
/// server) and the status.
@immutable
class SoftphoneCallFilters {
  const SoftphoneCallFilters({this.phoneDigits, this.status});

  static const initial = SoftphoneCallFilters();

  /// Digits only; null for no number filter.
  final String? phoneDigits;
  final ManualCallListStatus? status;

  bool get isFiltered => phoneDigits != null || status != null;

  int get groupCount => (phoneDigits != null ? 1 : 0) + (status != null ? 1 : 0);

  SoftphoneCallFilters copyWith({
    String? phoneDigits,
    bool clearPhone = false,
    ManualCallListStatus? status,
    bool clearStatus = false,
  }) =>
      SoftphoneCallFilters(
        phoneDigits: clearPhone ? null : (phoneDigits ?? this.phoneDigits),
        status: clearStatus ? null : (status ?? this.status),
      );

  /// What a typed number becomes: its digits, or null when none remain.
  static String? digitsOf(String raw) {
    final d = raw.replaceAll(RegExp(r'\D'), '');
    return d.isEmpty ? null : d;
  }

  @override
  bool operator ==(Object other) =>
      other is SoftphoneCallFilters && other.phoneDigits == phoneDigits && other.status == status;

  @override
  int get hashCode => Object.hash(phoneDigits, status);
}

enum SoftphoneCallsStatus { loading, ready, error }

@immutable
class SoftphoneCallsState {
  SoftphoneCallsState({
    this.filters = SoftphoneCallFilters.initial,
    this.status = SoftphoneCallsStatus.loading,
    List<ManualCallListRow> rows = const [],
    this.nextCursor,
    this.error,
    this.loadingMore = false,
    this.moreError,
    this.refreshing = false,
  }) : rows = List.unmodifiable(rows);

  /// The APPLIED filters (never a number still being typed).
  final SoftphoneCallFilters filters;
  final SoftphoneCallsStatus status;
  final List<ManualCallListRow> rows;
  final String? nextCursor;

  /// A failed first page, in the agent's words; with [status] `ready`, a
  /// failed refresh over rows still on screen.
  final String? error;
  final bool loadingMore;

  /// A failed "more", apart from [error]: the rows on screen are still good.
  final String? moreError;

  /// Re-reading the first page with the old rows still on screen.
  final bool refreshing;

  bool get hasMore => nextCursor != null;

  SoftphoneCallsState copyWith({
    List<ManualCallListRow>? rows,
    String? nextCursor,
    bool clearCursor = false,
    String? error,
    bool? loadingMore,
    String? moreError,
    bool clearMoreError = false,
    bool? refreshing,
  }) =>
      SoftphoneCallsState(
        filters: filters,
        status: status,
        rows: rows ?? this.rows,
        nextCursor: clearCursor ? null : (nextCursor ?? this.nextCursor),
        error: error ?? this.error,
        loadingMore: loadingMore ?? this.loadingMore,
        moreError: clearMoreError ? null : (moreError ?? this.moreError),
        refreshing: refreshing ?? this.refreshing,
      );

  @override
  bool operator ==(Object other) =>
      other is SoftphoneCallsState &&
      other.filters == filters &&
      other.status == status &&
      identical(other.rows, rows) &&
      other.nextCursor == nextCursor &&
      other.error == error &&
      other.loadingMore == loadingMore &&
      other.moreError == moreError &&
      other.refreshing == refreshing;

  @override
  int get hashCode =>
      Object.hash(filters, status, identityHashCode(rows), nextCursor, error, loadingMore, moreError, refreshing);
}

class SoftphoneCallsController extends Notifier<SoftphoneCallsState> {
  int _generation = 0;
  String? _userId;

  /// A first page has been asked for in this workspace.
  bool _requested = false;

  /// Rebuilt whenever [agentWorkspaceProvider] changes: the rows, the cursor
  /// and the filters are dropped at once, and a page still in flight for the
  /// old workspace is thrown away (the counter moves on here, because the
  /// notifier outlives the rebuild). The screen asks for the new first page.
  @override
  SoftphoneCallsState build() {
    _userId = workspaceUserId(ref.watch(agentWorkspaceProvider));
    _generation++;
    _requested = false;
    return SoftphoneCallsState();
  }

  /// Replace the applied filters and read the first page. A no-op when
  /// nothing changed and a page is already on screen.
  Future<void> applyFilters(SoftphoneCallFilters filters) {
    if (filters == state.filters && state.status != SoftphoneCallsStatus.error && _requested) {
      return Future.value();
    }
    return _loadFirst(filters, keepRows: false);
  }

  /// Read the first page again; with [keepRows] (pull-to-refresh) the old
  /// rows stay until the new page lands.
  Future<void> reload({bool keepRows = false}) =>
      _loadFirst(state.filters, keepRows: keepRows && state.rows.isNotEmpty);

  /// Ensure a first page exists (the segment shown, a workspace switch).
  Future<void> ensureLoaded() {
    final current = state; // brings the workspace up to date first
    if (_requested && current.status != SoftphoneCallsStatus.error) return Future.value();
    return _loadFirst(current.filters, keepRows: false);
  }

  Future<void> _loadFirst(SoftphoneCallFilters filters, {required bool keepRows}) async {
    final me = _userId;
    if (me == null) return; // signed out: nobody to read for
    _requested = true;
    final mine = ++_generation;
    state = keepRows
        ? state.copyWith(refreshing: true, loadingMore: false, clearMoreError: true)
        : SoftphoneCallsState(filters: filters);

    try {
      final page = await ref.read(softphoneCallsApiProvider).listCalls(_query(me, filters, null));
      if (!ref.mounted || mine != _generation) return;
      state = SoftphoneCallsState(
        filters: filters,
        status: SoftphoneCallsStatus.ready,
        rows: page.rows,
        nextCursor: page.nextCursor,
      );
    } on Exception catch (e) {
      if (!ref.mounted || mine != _generation) return;
      reportToGate(ref, e);
      final message = errorMessage(e, 'We couldn’t load the soft-phone calls.');
      state = keepRows
          ? state.copyWith(refreshing: false, error: message)
          : SoftphoneCallsState(filters: filters, status: SoftphoneCallsStatus.error, error: message);
    }
  }

  /// Append the next page. Safe to call repeatedly: nothing while a page is in
  /// flight, after a failed "more" (until [retryMore]), or on the last page.
  Future<void> loadMore() async {
    final s = state;
    final me = _userId;
    if (me == null ||
        s.status != SoftphoneCallsStatus.ready ||
        s.nextCursor == null ||
        s.loadingMore ||
        s.moreError != null ||
        s.refreshing) {
      return;
    }
    // CAPTURED, not incremented: a continuation of the query on screen. A
    // filter change while this is in flight moves the counter on, and this
    // page is thrown away instead of being appended under the new filter.
    final mine = _generation;
    state = s.copyWith(loadingMore: true);
    try {
      final page = await ref.read(softphoneCallsApiProvider).listCalls(_query(me, s.filters, s.nextCursor));
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
      state = state.copyWith(loadingMore: false, moreError: errorMessage(e, 'We couldn’t load older calls.'));
    }
  }

  /// Clear a failed "more" and try it again.
  Future<void> retryMore() {
    if (state.moreError == null) return Future.value();
    state = state.copyWith(clearMoreError: true);
    return loadMore();
  }

  static ManualCallsQuery _query(String me, SoftphoneCallFilters filters, String? cursor) => ManualCallsQuery(
        agentUserId: me,
        cursor: cursor,
        limit: softphoneCallsPageSize,
        status: filters.status,
        phoneDigits: filters.phoneDigits,
      );
}

final softphoneCallsControllerProvider =
    NotifierProvider<SoftphoneCallsController, SoftphoneCallsState>(SoftphoneCallsController.new);

/// Whether the agent has any soft-phone call in [workspace]: one `limit=1`
/// read of their own. Keyed by the workspace, so a new workspace starts from
/// "unknown" rather than the last one's answer. A refusal (no dial permission,
/// 403) or a failed read is "none": the segment stays hidden, as the console's
/// tab is for an agent the soft phone is not on for.
final softphoneCallsProbeProvider = FutureProvider.family<bool, String>((ref, workspace) async {
  final me = workspaceUserId(workspace);
  if (me == null) return false;
  try {
    final page = await ref.read(softphoneCallsApiProvider).listCalls(ManualCallsQuery(agentUserId: me, limit: 1));
    return page.rows.isNotEmpty;
  } on Exception catch (e) {
    reportToGate(ref, e);
    return false;
  }
});

/// Whether My calls shows the "Soft-phone calls" segment: where the Phone tab
/// shows, or where the agent has soft-phone calls to look back on (the soft
/// phone turned off since, say). The probe is read only when the Phone tab is
/// hidden.
final softphoneCallsVisibleProvider = Provider<bool>((ref) {
  if (ref.watch(softphoneAvailabilityProvider.select((a) => a.visible))) return true;
  final workspace = ref.watch(agentWorkspaceProvider);
  if (workspace == null) return false;
  return ref.watch(softphoneCallsProbeProvider(workspace)).value ?? false;
});

/// The bootstrap of [workspace], for names only: each outcome code read against
/// the catalog it was saved against, and the call-field labels. Without it (a
/// failed read) a code or a field key reads as itself.
final softphoneCallsBootstrapProvider = FutureProvider.family<SoftphoneBootstrap?, String>((ref, workspace) async {
  try {
    return await ref.read(softphoneCallsApiProvider).bootstrap();
  } on Exception catch (e) {
    reportToGate(ref, e);
    return null;
  }
});

/// The bootstrap of the workspace on screen, or null while it loads or failed.
SoftphoneBootstrap? softphoneCallsBootstrapOf(WidgetRef ref) {
  final workspace = ref.watch(agentWorkspaceProvider);
  if (workspace == null) return null;
  return ref.watch(softphoneCallsBootstrapProvider(workspace)).value;
}
