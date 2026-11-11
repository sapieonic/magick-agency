import 'dart:async';

import 'package:agency_wire/agency_wire.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api/api_error.dart';
import '../../core/auth/app_gate.dart';
import '../../core/telemetry/log.dart';
import 'missed_calls_api.dart';
import 'missed_calls_copy.dart';
import 'missed_count_controller.dart';

/// "My calls" → "Missed calls": the agent's own Missed rows (Mine), and the
/// account's rows nobody owns (Team, IQ49), claimed one at a time. Mine: (`assignee=me`:
/// the server forces it without `agency.supervise`, and a supervisor using the
/// app sees their own too), newest first, keyset-paged, To
/// follow up or Handled, with a reason filter, and per row Mark handled or
/// Reopen (a port of the console's `MissedCallsList` in an agent's view).
///
/// The same rules as the other lists: the filters live here and
/// [MissedCallsController.applyFilters] is the only way to change them, always
/// from the first page; a generation counter drops a page that belongs to a
/// query no longer on screen; everything is keyed on [agentWorkspaceProvider].

/// One page, the console's size.
const missedCallsPageSize = 50;

/// Whose rows the list shows: the agent's own, or the account's that nobody
/// owns (the Team view, IQ49: an unmatched or withheld caller nobody answered),
/// which any agent who sees the account may claim.
enum MissedScope { mine, team }

/// The applied filters: whose rows ([scope]), To follow up (`open`) or
/// Handled, and the reason. The Team view lists open rows only: a handled row
/// has nothing left to claim, so its status is always `open`.
@immutable
class MissedFilters {
  const MissedFilters({this.scope = MissedScope.mine, this._status = InboundFollowUpStatus.open, this.reason});

  static const initial = MissedFilters();

  final MissedScope scope;
  final InboundFollowUpStatus _status;
  final InboundMissedReason? reason;

  bool get team => scope == MissedScope.team;

  /// The status asked for: the tab's in Mine, always open in Team.
  InboundFollowUpStatus get status => team ? InboundFollowUpStatus.open : _status;

  bool get open => status == InboundFollowUpStatus.open;

  /// A filter beyond the status tab (the console counts the same).
  bool get isFiltered => reason != null;

  MissedFilters withScope(MissedScope scope) => MissedFilters(scope: scope, status: _status, reason: reason);
  MissedFilters withStatus(InboundFollowUpStatus status) => MissedFilters(scope: scope, status: status, reason: reason);
  MissedFilters withReason(InboundMissedReason? reason) => MissedFilters(scope: scope, status: _status, reason: reason);

  /// Mine is always the caller's own rows (without an assignee the server
  /// widens a supervisor's list to the whole account); Team is the
  /// account's unassigned rows.
  InboundMissedQuery toQuery({String? cursor}) => InboundMissedQuery(
        status: status,
        assignee: team ? InboundMissedQuery.assigneeUnassigned : InboundMissedQuery.assigneeMe,
        reason: reason,
        cursor: cursor,
        limit: missedCallsPageSize,
      );

  @override
  bool operator ==(Object other) =>
      other is MissedFilters && other.scope == scope && other.status == status && other.reason == reason;

  @override
  int get hashCode => Object.hash(scope, status, reason);
}

enum MissedListStatus { loading, ready, error }

@immutable
class MissedCallsState {
  MissedCallsState({
    this.filters = MissedFilters.initial,
    this.status = MissedListStatus.loading,
    List<InboundMissedCall> rows = const [],
    this.nextCursor,
    this.error,
    this.loadingMore = false,
    this.moreError,
    this.refreshing = false,
    this.marking,
    this.reopening,
    this.claiming,
    Set<String> taken = const {},
    this.rowError,
  })  : rows = List.unmodifiable(rows),
        taken = Set.unmodifiable(taken);

  /// The APPLIED filters.
  final MissedFilters filters;
  final MissedListStatus status;
  final List<InboundMissedCall> rows;
  final String? nextCursor;

  /// A failed first page; with [status] `ready`, a failed refresh over rows still on screen.
  final String? error;
  final bool loadingMore;
  final String? moreError;
  final bool refreshing;

  /// The row a Mark handled is in flight for (one at a time, the console's
  /// rule). Kept through a reload: only the action that set it clears it.
  final String? marking;

  /// The row a Reopen is in flight for; kept through a reload, as [marking].
  final String? reopening;

  /// The Team row a Claim is in flight for (one at a time).
  final String? claiming;

  /// Team rows a Claim was refused for because they are no longer there to
  /// claim (someone else took it, it was handled, or it is gone): they stay
  /// on screen with the refusal, Claim off, until the next read drops them.
  final Set<String> taken;

  /// The last row action's refusal, shown on its row.
  final ({String id, String message})? rowError;

  bool get hasMore => nextCursor != null;

  MissedCallsState copyWith({
    MissedListStatus? status,
    List<InboundMissedCall>? rows,
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
    String? reopening,
    bool clearReopening = false,
    String? claiming,
    bool clearClaiming = false,
    Set<String>? taken,
    ({String id, String message})? rowError,
    bool clearRowError = false,
  }) =>
      MissedCallsState(
        filters: filters,
        status: status ?? this.status,
        rows: rows ?? this.rows,
        nextCursor: clearCursor ? null : (nextCursor ?? this.nextCursor),
        error: clearError ? null : (error ?? this.error),
        loadingMore: loadingMore ?? this.loadingMore,
        moreError: clearMoreError ? null : (moreError ?? this.moreError),
        refreshing: refreshing ?? this.refreshing,
        marking: clearMarking ? null : (marking ?? this.marking),
        reopening: clearReopening ? null : (reopening ?? this.reopening),
        claiming: clearClaiming ? null : (claiming ?? this.claiming),
        taken: taken ?? this.taken,
        rowError: clearRowError ? null : (rowError ?? this.rowError),
      );

  @override
  bool operator ==(Object other) =>
      other is MissedCallsState &&
      other.filters == filters &&
      other.status == status &&
      identical(other.rows, rows) &&
      other.nextCursor == nextCursor &&
      other.error == error &&
      other.loadingMore == loadingMore &&
      other.moreError == moreError &&
      other.refreshing == refreshing &&
      other.marking == marking &&
      other.reopening == reopening &&
      other.claiming == claiming &&
      setEquals(other.taken, taken) &&
      other.rowError == rowError;

  @override
  int get hashCode => Object.hash(filters, status, identityHashCode(rows), nextCursor, error, loadingMore, moreError,
      refreshing, marking, reopening, claiming, Object.hashAllUnordered(taken), rowError);
}

/// How a row action ended: what to announce, or the refusal (also on the row).
@immutable
final class MissedActionResult {
  const MissedActionResult({required this.ok, required this.message});
  final bool ok;
  final String message;
}

class MissedCallsController extends Notifier<MissedCallsState> {
  static final _log = Log('missed');

  int _generation = 0;
  String? _workspace;
  bool _requested = false;

  /// When the first page on screen was read, and whether a call has settled
  /// on this phone since (the server may have closed a row as reached).
  DateTime? _loadedAt;
  bool _settledSince = false;

  /// Which Mark handled / Reopen owns [MissedCallsState.marking] /
  /// [MissedCallsState.reopening]: an action clears the flag only while it
  /// still owns it (never one set after a reload or in another workspace).
  int _actionSeq = 0;
  int? _markingAction;
  int? _reopeningAction;
  int? _claimingAction;

  MissedCallsApi get _api => ref.read(missedCallsApiProvider);
  DateTime _now() => ref.read(missedClockProvider)();

  @override
  MissedCallsState build() {
    _workspace = ref.watch(agentWorkspaceProvider);
    _generation++;
    _requested = false;
    _loadedAt = null;
    _settledSince = false;
    _markingAction = null;
    _reopeningAction = null;
    _claimingAction = null;
    ref.listen<int>(missedCallsSettledProvider, (_, _) => _settledSince = true);
    return MissedCallsState();
  }

  /// Ensure a first page exists (a workspace switch).
  Future<void> ensureLoaded() {
    final current = state;
    if (_requested && current.status != MissedListStatus.error) return Future.value();
    return _loadFirst(current.filters, keepRows: false);
  }

  /// The segment came on screen (shown, or its tab came back to the front):
  /// the first page if there is none; otherwise the rows read again when they
  /// are [missedRereadOnEntryAfter] old or a call has settled since, and the
  /// badge's count when it is that old. Agents keep the app open all shift,
  /// and rows close by themselves (a customer reached) or arrive (assigned).
  Future<void> entered() {
    final current = state;
    if (!_requested || current.status == MissedListStatus.error) return ensureLoaded();
    final count = ref.read(missedCountControllerProvider.notifier).refreshIfOlderThan(missedRereadOnEntryAfter);
    final loadedAt = _loadedAt;
    final stale = current.status == MissedListStatus.ready &&
        !current.refreshing &&
        (_settledSince || loadedAt == null || _now().difference(loadedAt) >= missedRereadOnEntryAfter);
    if (!stale) return count;
    return Future.wait([count, _loadFirst(current.filters, keepRows: current.rows.isNotEmpty)]);
  }

  /// Replace the applied filters and read the first page. A no-op when
  /// nothing changed and a page is already on screen.
  Future<void> applyFilters(MissedFilters filters) {
    if (filters == state.filters && state.status != MissedListStatus.error && _requested) return Future.value();
    return _loadFirst(filters, keepRows: false);
  }

  /// Pull to refresh: the first page again (the old rows stay until it
  /// lands), and the badge's count with it.
  Future<void> reload({bool keepRows = false}) => Future.wait([
        _loadFirst(state.filters, keepRows: keepRows && state.rows.isNotEmpty),
        ref.read(missedCountControllerProvider.notifier).refresh(),
      ]);

  Future<void> _loadFirst(MissedFilters filters, {required bool keepRows}) async {
    if (_workspace == null) return;
    _requested = true;
    _settledSince = false;
    final mine = ++_generation;
    state = keepRows
        ? state.copyWith(refreshing: true, loadingMore: false, clearMoreError: true)
        : MissedCallsState(filters: filters, marking: state.marking, reopening: state.reopening, claiming: state.claiming);
    try {
      final page = await _api.list(filters.toQuery());
      if (!ref.mounted || mine != _generation) return;
      _loadedAt = _now();
      state = MissedCallsState(
        filters: filters,
        status: MissedListStatus.ready,
        rows: page.rows,
        nextCursor: page.nextCursor,
        marking: state.marking,
        reopening: state.reopening,
        claiming: state.claiming,
      );
    } on Exception catch (e) {
      if (!ref.mounted || mine != _generation) return;
      reportToGate(ref, e);
      final message = _message(e, MissedCopy.loadFailed);
      state = keepRows
          ? state.copyWith(refreshing: false, error: message)
          : MissedCallsState(
              filters: filters,
              status: MissedListStatus.error,
              error: message,
              marking: state.marking,
              reopening: state.reopening,
              claiming: state.claiming,
            );
    }
  }

  /// Append the next page; safe to call repeatedly.
  Future<void> loadMore() async {
    final s = state;
    if (s.status != MissedListStatus.ready || s.nextCursor == null || s.loadingMore || s.moreError != null || s.refreshing) {
      return;
    }
    final mine = _generation;
    state = s.copyWith(loadingMore: true);
    try {
      final page = await _api.list(s.filters.toQuery(cursor: s.nextCursor));
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
      state = state.copyWith(loadingMore: false, moreError: _message(e, MissedCopy.moreFailed));
    }
  }

  Future<void> retryMore() {
    if (state.moreError == null) return Future.value();
    state = state.copyWith(clearMoreError: true);
    return loadMore();
  }

  /// Mark handled: off the To follow up list (onto Handled), the badge re-read.
  Future<MissedActionResult> markHandled(InboundMissedCall call) async {
    if (state.marking != null) return const MissedActionResult(ok: false, message: MissedCopy.marking);
    final action = _markingAction = ++_actionSeq;
    state = state.copyWith(marking: call.id, clearRowError: true);
    final mine = _generation;
    bool owns() => ref.mounted && _markingAction == action;
    try {
      final updated = await _api.markHandled(call.id);
      if (!ref.mounted) return MissedActionResult(ok: true, message: MissedCopy.markedAnnouncement(call));
      if (owns()) {
        _markingAction = null;
        state = state.copyWith(clearMarking: true);
      }
      if (mine == _generation) _settleRow(call.id, updated, keep: !state.filters.open);
      unawaited(ref.read(missedCountControllerProvider.notifier).refresh());
      return MissedActionResult(ok: true, message: MissedCopy.markedAnnouncement(call));
    } on Exception catch (e) {
      final message = MissedCopy.handledRefusal(e);
      if (!ref.mounted) return MissedActionResult(ok: false, message: message);
      _refused('mark handled', e);
      if (owns()) {
        _markingAction = null;
        state = state.copyWith(clearMarking: true, rowError: (id: call.id, message: message));
      }
      return MissedActionResult(ok: false, message: message);
    }
  }

  /// Reopen: off the Handled list, back to To follow up; the badge re-read.
  Future<MissedActionResult> reopen(InboundMissedCall call) async {
    if (state.reopening != null) return const MissedActionResult(ok: false, message: MissedCopy.reopening);
    final action = _reopeningAction = ++_actionSeq;
    state = state.copyWith(reopening: call.id, clearRowError: true);
    final mine = _generation;
    bool owns() => ref.mounted && _reopeningAction == action;
    try {
      final updated = await _api.reopen(call.id);
      if (!ref.mounted) return MissedActionResult(ok: true, message: MissedCopy.reopenedAnnouncement(call));
      if (owns()) {
        _reopeningAction = null;
        state = state.copyWith(clearReopening: true);
      }
      if (mine == _generation) _settleRow(call.id, updated, keep: state.filters.status != InboundFollowUpStatus.handled);
      unawaited(ref.read(missedCountControllerProvider.notifier).refresh());
      return MissedActionResult(ok: true, message: MissedCopy.reopenedAnnouncement(call));
    } on Exception catch (e) {
      final message = MissedCopy.reopenRefusal(e);
      if (!ref.mounted) return MissedActionResult(ok: false, message: message);
      _refused('reopen', e);
      if (owns()) {
        _reopeningAction = null;
        state = state.copyWith(clearReopening: true, rowError: (id: call.id, message: message));
      }
      return MissedActionResult(ok: false, message: message);
    }
  }

  /// Claim (IQ49): a Team row becomes the agent's own. It leaves the Team
  /// view (it is on Mine's To follow up now) and the badge is re-read. A
  /// refusal is said on the row; one that says the row is no longer there to
  /// claim (someone else took it, it was handled, it is gone) also turns its
  /// Claim off until the next read drops it.
  Future<MissedActionResult> claim(InboundMissedCall call) async {
    if (state.claiming != null) return const MissedActionResult(ok: false, message: MissedCopy.claiming);
    final action = _claimingAction = ++_actionSeq;
    state = state.copyWith(claiming: call.id, clearRowError: true);
    final mine = _generation;
    bool owns() => ref.mounted && _claimingAction == action;
    try {
      final updated = await _api.claim(call.id);
      if (!ref.mounted) return MissedActionResult(ok: true, message: MissedCopy.claimedAnnouncement(call));
      if (owns()) {
        _claimingAction = null;
        state = state.copyWith(clearClaiming: true);
      }
      if (mine == _generation) _settleRow(call.id, updated, keep: !state.filters.team);
      unawaited(ref.read(missedCountControllerProvider.notifier).refresh());
      return MissedActionResult(ok: true, message: MissedCopy.claimedAnnouncement(call));
    } on Exception catch (e) {
      final message = MissedCopy.claimRefusal(e);
      if (!ref.mounted) return MissedActionResult(ok: false, message: message);
      _refused('claim', e);
      if (owns()) {
        _claimingAction = null;
        state = state.copyWith(
          clearClaiming: true,
          rowError: (id: call.id, message: message),
          taken: MissedCopy.claimGone(e) && mine == _generation ? {...state.taken, call.id} : null,
        );
      }
      return MissedActionResult(ok: false, message: message);
    }
  }

  /// The row replaced by the server's copy, or dropped from a view it no
  /// longer matches (the console's `runRowAction`).
  void _settleRow(String id, InboundMissedCall updated, {required bool keep}) {
    final rows = keep
        ? [for (final r in state.rows) r.id == id ? updated : r]
        : [for (final r in state.rows) if (r.id != id) r];
    state = state.copyWith(rows: rows);
  }

  void _refused(String action, Exception e) {
    reportToGate(ref, e);
    // A refusal with a code is the agent's to read; anything else is worth a look.
    final coded = e is ApiHttpError && e.code != null && !e.isServerError;
    if (!coded && e is! ApiNetworkError && e is! ApiUnauthorized) {
      _log.warn('A missed call’s $action failed', {'error': e.toString()});
    }
  }

  static String _message(Object e, String fallback) => e is ApiError ? e.userMessage : fallback;
}

final missedCallsControllerProvider =
    NotifierProvider<MissedCallsController, MissedCallsState>(MissedCallsController.new);
