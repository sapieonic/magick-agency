import 'dart:async';

import 'package:agency_wire/agency_wire.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api/api_error.dart';
import '../../core/auth/app_gate.dart';
import '../../core/station/station_view.dart';
import '../../core/telemetry/telemetry.dart';
import '../performance/performance_controller.dart' show statsClockProvider;
import 'my_contacts_api.dart';
import 'my_contacts_copy.dart';

/// "My contacts" on one campaign (contact assignment): the agent's counts,
/// their contacts keyset-paged with a bucket filter and a number search,
/// "Retry not reached", and calling one contact now.
///
/// The filters live HERE and [MyContactsController.applyFilters] is the only
/// way to change them; it always restarts from the first page (the cursor
/// reset rule My calls follows). A generation counter drops any page that
/// belongs to a query no longer on screen.

/// One page, the console's size for its own lists.
const myContactsPageSize = 50;

/// The applied filters: buckets (none = every bucket) and the number search.
@immutable
class MyContactsFilters {
  MyContactsFilters({Set<MyContactBucket> buckets = const {}, this.phone}) : buckets = Set.unmodifiable(buckets);

  static final initial = MyContactsFilters();

  final Set<MyContactBucket> buckets;

  /// What the agent typed; the query sends its digits.
  final String? phone;

  bool get isFiltered => buckets.isNotEmpty || (phone != null && phone!.isNotEmpty);

  MyContactsFilters withBuckets(Set<MyContactBucket> buckets) => MyContactsFilters(buckets: buckets, phone: phone);
  MyContactsFilters withPhone(String? phone) =>
      MyContactsFilters(buckets: buckets, phone: phone == null || phone.trim().isEmpty ? null : phone.trim());

  MyContactsQuery toQuery(String campaignId, {String? cursor}) => MyContactsQuery(
        campaignId: campaignId,
        // In the contract's order, so the same filter is the same query.
        buckets: [for (final b in MyContactBucket.values) if (buckets.contains(b)) b],
        phone: phone,
        cursor: cursor,
        limit: myContactsPageSize,
      );

  @override
  bool operator ==(Object other) =>
      other is MyContactsFilters && setEquals(other.buckets, buckets) && other.phone == phone;

  @override
  int get hashCode => Object.hash(Object.hashAllUnordered(buckets), phone);
}

enum MyContactsStatus { loading, ready, error }

@immutable
class MyContactsState {
  MyContactsState({
    MyContactsFilters? filters,
    this.status = MyContactsStatus.loading,
    List<MyContact> rows = const [],
    this.nextCursor,
    this.error,
    this.loadingMore = false,
    this.moreError,
    this.refreshing = false,
    this.summary,
    this.summaryError,
    Set<String> selected = const {},
    this.retrying = false,
    this.callingId,
  })  : filters = filters ?? MyContactsFilters.initial,
        rows = List.unmodifiable(rows),
        selected = Set.unmodifiable(selected);

  /// The APPLIED filters (never a draft being typed).
  final MyContactsFilters filters;
  final MyContactsStatus status;
  final List<MyContact> rows;
  final String? nextCursor;

  /// A failed first page, in the agent's words; with [status] `ready`, a
  /// failed refresh over rows still on screen.
  final String? error;
  final bool loadingMore;
  final String? moreError;
  final bool refreshing;

  /// The counts, or null until the first read lands.
  final MyContactsSummary? summary;
  final String? summaryError;

  /// Contacts picked for "Retry selected": ids of retry-eligible rows.
  final Set<String> selected;

  /// A retry request is in flight.
  final bool retrying;

  /// The contact whose call request is in flight.
  final String? callingId;

  bool get hasMore => nextCursor != null;

  MyContactsState copyWith({
    MyContactsFilters? filters,
    MyContactsStatus? status,
    List<MyContact>? rows,
    String? nextCursor,
    bool clearCursor = false,
    String? error,
    bool clearError = false,
    bool? loadingMore,
    String? moreError,
    bool clearMoreError = false,
    bool? refreshing,
    MyContactsSummary? summary,
    String? summaryError,
    bool clearSummaryError = false,
    Set<String>? selected,
    bool? retrying,
    String? callingId,
    bool clearCallingId = false,
  }) =>
      MyContactsState(
        filters: filters ?? this.filters,
        status: status ?? this.status,
        rows: rows ?? this.rows,
        nextCursor: clearCursor ? null : (nextCursor ?? this.nextCursor),
        error: clearError ? null : (error ?? this.error),
        loadingMore: loadingMore ?? this.loadingMore,
        moreError: clearMoreError ? null : (moreError ?? this.moreError),
        refreshing: refreshing ?? this.refreshing,
        summary: summary ?? this.summary,
        summaryError: clearSummaryError ? null : (summaryError ?? this.summaryError),
        selected: selected ?? this.selected,
        retrying: retrying ?? this.retrying,
        callingId: clearCallingId ? null : (callingId ?? this.callingId),
      );

  @override
  bool operator ==(Object other) =>
      other is MyContactsState &&
      other.filters == filters &&
      other.status == status &&
      identical(other.rows, rows) &&
      other.nextCursor == nextCursor &&
      other.error == error &&
      other.loadingMore == loadingMore &&
      other.moreError == moreError &&
      other.refreshing == refreshing &&
      other.summary == summary &&
      other.summaryError == summaryError &&
      setEquals(other.selected, selected) &&
      other.retrying == retrying &&
      other.callingId == callingId;

  @override
  int get hashCode => Object.hash(filters, status, identityHashCode(rows), nextCursor, error, loadingMore, moreError,
      refreshing, summary, summaryError, selected.length, retrying, callingId);
}

/// Whether the agent can call one of their contacts from here: on duty on
/// this campaign's station and available (the call is dialled from that
/// session, on the campaign's normal path). [blocked] says why not.
@immutable
class ContactCallGate {
  const ContactCallGate.open(String this.sessionId) : blocked = null;
  const ContactCallGate.closed(String this.blocked) : sessionId = null;

  final String? sessionId;
  final String? blocked;

  bool get isOpen => sessionId != null;

  @override
  bool operator ==(Object other) => other is ContactCallGate && other.sessionId == sessionId && other.blocked == blocked;

  @override
  int get hashCode => Object.hash(sessionId, blocked);
}

ContactCallGate callGateOf(StationView? view, String campaignId) {
  if (view == null ||
      view.campaignId != campaignId ||
      view.sessionId == null ||
      view.fatal != null ||
      view.link == StationLink.sessionGone ||
      view.link == StationLink.superseded) {
    return const ContactCallGate.closed(MyContactsCopy.callNeedsStation);
  }
  if (view.phase != AgentPhase.available || view.callActive) {
    return const ContactCallGate.closed(MyContactsCopy.callNeedsAvailable);
  }
  return ContactCallGate.open(view.sessionId!);
}

final myContactsCallGateProvider = Provider.autoDispose.family<ContactCallGate, String>(
  (ref, campaignId) => callGateOf(ref.watch(stationViewProvider), campaignId),
);

/// Whether [c] is one the agent may call now (the server decides; this keeps
/// the button off where it would only be refused): one they can retry, one
/// that is due, or an open one whose outcome lets them call early.
bool canCallContact(MyContact c, DateTime now) {
  if (c.bucket == MyContactBucket.inProgress || c.bucket == MyContactBucket.suppressed) return false;
  if (c.retry.eligible || c.isDueAt(now)) return true;
  return c.state == ContactState.pending && (c.overrideGrant?.retryDelay ?? false);
}

/// Whether [note] is a calling-hours override note the server takes
/// (trimmed, [overrideNoteMin]–[overrideNoteMax] characters), or why not.
String? overrideNoteProblem(String note) {
  final n = note.trim().runes.length;
  if (n < overrideNoteMin) return MyContactsCopy.noteTooShort;
  if (n > overrideNoteMax) return MyContactsCopy.noteTooLong;
  return null;
}

/// How a call request ended.
sealed class ContactCallResult {
  const ContactCallResult();
}

final class ContactCallPlaced extends ContactCallResult {
  const ContactCallPlaced(this.response);
  final MyContactCallResponse response;
}

/// Outside the calling hours, and the contact holds a calling-hours override:
/// ask for the note and call again with it.
final class ContactCallNeedsNote extends ContactCallResult {
  const ContactCallNeedsNote(this.grant);
  final ContactOverride grant;
}

final class ContactCallFailed extends ContactCallResult {
  const ContactCallFailed(this.message);
  final String message;
}

/// How a retry request ended, in words.
@immutable
final class RetryResult {
  const RetryResult({required this.ok, required this.message});
  final bool ok;
  final String message;
}

class MyContactsController extends Notifier<MyContactsState> {
  MyContactsController(this.campaignId);

  final String campaignId;

  int _generation = 0;
  int _summaryGeneration = 0;
  String? _workspace;
  bool _requested = false;
  bool _viewedSent = false;

  MyContactsApi get _api => ref.read(myContactsApiProvider);
  DateTime _now() => ref.read(statsClockProvider)();

  /// Rebuilt when [agentWorkspaceProvider] changes: one agent never sees
  /// another's contacts, and pages in flight for the old one are dropped.
  @override
  MyContactsState build() {
    _workspace = ref.watch(agentWorkspaceProvider);
    _generation++;
    _summaryGeneration++;
    _requested = false;
    return MyContactsState();
  }

  /// Ensure the counts and a first page exist (screen arrival).
  Future<void> ensureLoaded() {
    final current = state;
    if (_requested && current.status != MyContactsStatus.error) return Future.value();
    return Future.wait([_loadSummary(), _loadFirst(current.filters, keepRows: false)]);
  }

  /// Replace the applied filters and read the first page. A no-op when
  /// nothing changed and a page is already on screen. Clears the selection.
  Future<void> applyFilters(MyContactsFilters filters) {
    if (filters == state.filters && state.status != MyContactsStatus.error && _requested) return Future.value();
    return _loadFirst(filters, keepRows: false);
  }

  /// Read the counts and the first page again. With [keepRows]
  /// (pull-to-refresh, after a retry) the old rows stay until the new page lands.
  Future<void> reload({bool keepRows = false}) => Future.wait([
        _loadSummary(),
        _loadFirst(state.filters, keepRows: keepRows && state.rows.isNotEmpty),
      ]);

  Future<void> _loadSummary() async {
    if (_workspace == null) return;
    final mine = ++_summaryGeneration;
    try {
      final summary = await _api.summary(campaignId);
      if (!ref.mounted || mine != _summaryGeneration) return;
      state = state.copyWith(summary: summary, clearSummaryError: true);
      if (!_viewedSent) {
        _viewedSent = true;
        Telemetry.event('agency_my_contacts_viewed', {
          'campaign_id': campaignId,
          'assignment_mode': summary.assignmentModeRaw,
          'total': summary.total,
          'due_now': summary.dueNow,
          'retry_eligible': summary.retry.eligible,
          for (final b in MyContactBucket.values)
            if (!b.isUnknown) 'count_${b.wire}': summary.counts[b],
        });
      }
    } on Exception catch (e) {
      if (!ref.mounted || mine != _summaryGeneration) return;
      reportToGate(ref, e);
      state = state.copyWith(summaryError: MyContactsCopy.error(e, now: _now(), fallback: MyContactsCopy.summaryFailed));
    }
  }

  Future<void> _loadFirst(MyContactsFilters filters, {required bool keepRows}) async {
    if (_workspace == null) return;
    _requested = true;
    final mine = ++_generation;
    state = keepRows
        ? state.copyWith(filters: filters, refreshing: true, loadingMore: false, clearMoreError: true)
        : state.copyWith(
            filters: filters,
            status: MyContactsStatus.loading,
            rows: const [],
            clearCursor: true,
            clearError: true,
            loadingMore: false,
            clearMoreError: true,
            refreshing: false,
            // The picked rows may not be on the new page.
            selected: const {},
          );
    try {
      final page = await _api.list(filters.toQuery(campaignId));
      if (!ref.mounted || mine != _generation) return;
      final visible = {for (final r in page.rows) r.id};
      state = state.copyWith(
        status: MyContactsStatus.ready,
        rows: page.rows,
        nextCursor: page.nextCursor,
        clearCursor: page.nextCursor == null,
        clearError: true,
        refreshing: false,
        // A refresh keeps only picks that are still on screen and still eligible.
        selected: {
          for (final id in state.selected)
            if (visible.contains(id) && page.rows.any((r) => r.id == id && r.retry.eligible)) id,
        },
      );
    } on Exception catch (e) {
      if (!ref.mounted || mine != _generation) return;
      reportToGate(ref, e);
      final message = MyContactsCopy.error(e, now: _now(), fallback: MyContactsCopy.loadFailed);
      state = keepRows
          ? state.copyWith(refreshing: false, error: message)
          : state.copyWith(status: MyContactsStatus.error, error: message);
    }
  }

  /// Append the next page; safe to call repeatedly.
  Future<void> loadMore() async {
    final s = state;
    if (s.status != MyContactsStatus.ready || s.nextCursor == null || s.loadingMore || s.moreError != null || s.refreshing) {
      return;
    }
    final mine = _generation;
    state = s.copyWith(loadingMore: true);
    try {
      final page = await _api.list(s.filters.toQuery(campaignId, cursor: s.nextCursor));
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
      state = state.copyWith(
        loadingMore: false,
        moreError: MyContactsCopy.error(e, now: _now(), fallback: MyContactsCopy.moreFailed),
      );
    }
  }

  Future<void> retryMore() {
    if (state.moreError == null) return Future.value();
    state = state.copyWith(clearMoreError: true);
    return loadMore();
  }

  /// Picks or unpicks [contact] for "Retry selected". Only a contact the
  /// agent can retry now can be picked.
  void toggleSelected(MyContact contact) {
    final selected = {...state.selected};
    if (!selected.remove(contact.id)) {
      if (!contact.retry.eligible) return;
      selected.add(contact.id);
    }
    state = state.copyWith(selected: selected);
  }

  void clearSelection() {
    if (state.selected.isNotEmpty) state = state.copyWith(selected: const {});
  }

  /// "Retry not reached": every eligible contact, or only the picked ones
  /// ([selectedOnly]). Then the counts and the list are read again.
  Future<RetryResult> retry({bool selectedOnly = false}) async {
    final s = state;
    if (s.retrying) return const RetryResult(ok: false, message: MyContactsCopy.retrying);
    final ids = s.selected.toList();
    if (selectedOnly && ids.isEmpty) return const RetryResult(ok: false, message: MyContactsCopy.selectHint);
    final request = selectedOnly
        ? AgentRetryRequest.selected(campaignId: campaignId, contactIds: ids)
        : AgentRetryRequest.all(campaignId: campaignId);
    final requested = selectedOnly ? ids.length : (s.summary?.retry.eligible ?? 0);
    state = s.copyWith(retrying: true);
    try {
      final response = await _api.retry(request);
      Telemetry.event('agency_agent_retry_requested', {
        'campaign_id': campaignId,
        'scope': selectedOnly ? 'selected' : 'all',
        'requested': requested,
        'outcome': 'reopened',
        'reopened': response.reopened,
        'skipped_total': response.skippedTotal,
      });
      if (!ref.mounted) return RetryResult(ok: true, message: MyContactsCopy.retryDone(response));
      state = state.copyWith(retrying: false, selected: const {});
      unawaited(reload(keepRows: true));
      return RetryResult(ok: true, message: MyContactsCopy.retryDone(response));
    } on Exception catch (e) {
      Telemetry.event('agency_agent_retry_requested', {
        'campaign_id': campaignId,
        'scope': selectedOnly ? 'selected' : 'all',
        'requested': requested,
        'outcome': 'refused',
        'code': _codeOf(e),
      });
      final message = MyContactsCopy.error(e, now: _now());
      if (!ref.mounted) return RetryResult(ok: false, message: message);
      reportToGate(ref, e);
      state = state.copyWith(retrying: false);
      // What the server knows changed under us: show it as it is now.
      if (e is ApiHttpError && e.status != 401) unawaited(reload(keepRows: true));
      return RetryResult(ok: false, message: message);
    }
  }

  /// Dials [contact] now from the agent's station session on this campaign.
  /// Outside the calling hours, a contact holding a calling-hours override
  /// answers [ContactCallNeedsNote]: call again with [overrideNote].
  Future<ContactCallResult> call(MyContact contact, {String? overrideNote}) async {
    if (state.callingId != null) return const ContactCallFailed(MyContactsCopy.calling);
    final gate = callGateOf(ref.read(stationViewProvider), campaignId);
    final sessionId = gate.sessionId;
    if (sessionId == null) return ContactCallFailed(gate.blocked!);
    final note = overrideNote?.trim();
    if (note != null) {
      final problem = overrideNoteProblem(note);
      if (problem != null) return ContactCallFailed(problem);
    }
    final grant = contact.overrideGrant;
    final event = <String, Object?>{
      'campaign_id': campaignId,
      'bucket': contact.bucketRaw,
      'override_kinds': grant == null || grant.kinds.isEmpty ? 'none' : grant.kinds.map((k) => k.wire).join(','),
      'with_note': note != null,
    };
    state = state.copyWith(callingId: contact.id);
    try {
      final response = await _api.call(
        contact.id,
        MyContactCallRequest(campaignId: campaignId, sessionId: sessionId, overrideNote: note),
      );
      Telemetry.event('agency_my_contact_call_requested', {
        ...event,
        'outcome': 'placed',
        'override_applied': response.overrideApplied.isEmpty
            ? 'none'
            : response.overrideAppliedRaw.join(','),
        'retry_round_spent': response.retryRoundSpent,
      });
      if (ref.mounted) state = state.copyWith(clearCallingId: true);
      return ContactCallPlaced(response);
    } on Exception catch (e) {
      final refusal = e is ApiHttpError ? ErrorBody.fromJson(e.body).agentRetryRefusal : null;
      Telemetry.event('agency_my_contact_call_requested', {...event, 'outcome': 'refused', 'code': _codeOf(e)});
      if (!ref.mounted) return ContactCallFailed(MyContactsCopy.error(e, now: _now()));
      reportToGate(ref, e);
      state = state.copyWith(clearCallingId: true);
      if (refusal?.code == AgentRetryErrorCode.outsideCallingHours &&
          note == null &&
          grant != null &&
          grant.callingHours) {
        return ContactCallNeedsNote(grant);
      }
      // The contact moved under us (reassigned, dialled, blocked): show it as it is now.
      if (refusal?.code == AgentRetryErrorCode.contactNotFound ||
          refusal?.code == AgentRetryErrorCode.contactNotRetryable ||
          refusal?.code == AgentRetryErrorCode.contactInFlight) {
        unawaited(reload(keepRows: true));
      }
      return ContactCallFailed(MyContactsCopy.error(e, now: _now()));
    }
  }

  /// The refusal's code for telemetry (never its message), else the failure's kind.
  static String _codeOf(Object e) => switch (e) {
        ApiHttpError(:final code) => code ?? 'http_error',
        ApiNetworkError() => 'network',
        ApiUnauthorized() => 'unauthorized',
        ApiDecodeError() => 'decode',
        _ => 'error',
      };
}

final myContactsControllerProvider =
    NotifierProvider.autoDispose.family<MyContactsController, MyContactsState, String>(MyContactsController.new);
