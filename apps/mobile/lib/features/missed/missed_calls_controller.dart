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

/// "My calls" → "Missed calls": the agent's own Missed rows (the server shows
/// an agent only the rows assigned to them), newest first, keyset-paged, To
/// follow up or Handled, with a reason filter, and per row Mark handled or
/// Reopen (a port of the console's `MissedCallsList` in an agent's view).
///
/// The same rules as the other lists: the filters live here and
/// [MissedCallsController.applyFilters] is the only way to change them, always
/// from the first page; a generation counter drops a page that belongs to a
/// query no longer on screen; everything is keyed on [agentWorkspaceProvider].

/// One page, the console's size.
const missedCallsPageSize = 50;

/// The applied filters: To follow up (`open`) or Handled, and the reason.
@immutable
class MissedFilters {
  const MissedFilters({this.status = InboundFollowUpStatus.open, this.reason});

  static const initial = MissedFilters();

  final InboundFollowUpStatus status;
  final InboundMissedReason? reason;

  bool get open => status == InboundFollowUpStatus.open;

  /// A filter beyond the status tab (the console counts the same).
  bool get isFiltered => reason != null;

  MissedFilters withStatus(InboundFollowUpStatus status) => MissedFilters(status: status, reason: reason);
  MissedFilters withReason(InboundMissedReason? reason) => MissedFilters(status: status, reason: reason);

  InboundMissedQuery toQuery({String? cursor}) =>
      InboundMissedQuery(status: status, reason: reason, cursor: cursor, limit: missedCallsPageSize);

  @override
  bool operator ==(Object other) => other is MissedFilters && other.status == status && other.reason == reason;

  @override
  int get hashCode => Object.hash(status, reason);
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
    this.rowError,
  }) : rows = List.unmodifiable(rows);

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

  /// The row a Mark handled is in flight for (one at a time, the console's rule).
  final String? marking;

  /// The row a Reopen is in flight for.
  final String? reopening;

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
      other.rowError == rowError;

  @override
  int get hashCode => Object.hash(filters, status, identityHashCode(rows), nextCursor, error, loadingMore, moreError,
      refreshing, marking, reopening, rowError);
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

  MissedCallsApi get _api => ref.read(missedCallsApiProvider);

  @override
  MissedCallsState build() {
    _workspace = ref.watch(agentWorkspaceProvider);
    _generation++;
    _requested = false;
    return MissedCallsState();
  }

  /// Ensure a first page exists (the segment shown, a workspace switch).
  Future<void> ensureLoaded() {
    final current = state;
    if (_requested && current.status != MissedListStatus.error) return Future.value();
    return _loadFirst(current.filters, keepRows: false);
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
    final mine = ++_generation;
    state = keepRows
        ? state.copyWith(refreshing: true, loadingMore: false, clearMoreError: true)
        : MissedCallsState(filters: filters);
    try {
      final page = await _api.list(filters.toQuery());
      if (!ref.mounted || mine != _generation) return;
      state = MissedCallsState(
        filters: filters,
        status: MissedListStatus.ready,
        rows: page.rows,
        nextCursor: page.nextCursor,
      );
    } on Exception catch (e) {
      if (!ref.mounted || mine != _generation) return;
      reportToGate(ref, e);
      final message = _message(e, MissedCopy.loadFailed);
      state = keepRows
          ? state.copyWith(refreshing: false, error: message)
          : MissedCallsState(filters: filters, status: MissedListStatus.error, error: message);
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
    state = state.copyWith(marking: call.id, clearRowError: true);
    final mine = _generation;
    try {
      final updated = await _api.markHandled(call.id);
      if (!ref.mounted) return MissedActionResult(ok: true, message: MissedCopy.markedAnnouncement(call));
      state = state.copyWith(clearMarking: true);
      if (mine == _generation) _settleRow(call.id, updated, keep: !state.filters.open);
      unawaited(ref.read(missedCountControllerProvider.notifier).refresh());
      return MissedActionResult(ok: true, message: MissedCopy.markedAnnouncement(call));
    } on Exception catch (e) {
      final message = MissedCopy.handledRefusal(e);
      if (!ref.mounted) return MissedActionResult(ok: false, message: message);
      _refused('mark handled', e);
      state = state.copyWith(clearMarking: true, rowError: (id: call.id, message: message));
      return MissedActionResult(ok: false, message: message);
    }
  }

  /// Reopen: off the Handled list, back to To follow up; the badge re-read.
  Future<MissedActionResult> reopen(InboundMissedCall call) async {
    if (state.reopening != null) return const MissedActionResult(ok: false, message: MissedCopy.reopening);
    state = state.copyWith(reopening: call.id, clearRowError: true);
    final mine = _generation;
    try {
      final updated = await _api.reopen(call.id);
      if (!ref.mounted) return MissedActionResult(ok: true, message: MissedCopy.reopenedAnnouncement(call));
      state = state.copyWith(clearReopening: true);
      if (mine == _generation) _settleRow(call.id, updated, keep: state.filters.status != InboundFollowUpStatus.handled);
      unawaited(ref.read(missedCountControllerProvider.notifier).refresh());
      return MissedActionResult(ok: true, message: MissedCopy.reopenedAnnouncement(call));
    } on Exception catch (e) {
      final message = MissedCopy.reopenRefusal(e);
      if (!ref.mounted) return MissedActionResult(ok: false, message: message);
      _refused('reopen', e);
      state = state.copyWith(clearReopening: true, rowError: (id: call.id, message: message));
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
