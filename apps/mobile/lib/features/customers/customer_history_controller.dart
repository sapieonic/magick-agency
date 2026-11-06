/// Customer history (`docs/customer-history.md` §5, the agent app): search one
/// number, then read its summary and its timeline.
///
/// The number lives HERE and in the search box, never in a route (CH6): the
/// screens are `/calls/customer` and `/calls/customer/results` whatever was
/// searched, and nothing here logs it. Like the console, the last answer is
/// held in memory only; a new workspace (another account, another agent,
/// signed out) drops it.
///
/// The timeline's filters live here and [CustomerHistoryController.applyFilter]
/// is the only way to change them; it always restarts from the first page. A
/// generation counter drops any page that belongs to a search or a filter no
/// longer on screen.
library;

import 'dart:async';

import 'package:agency_wire/agency_wire.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/auth/app_gate.dart';
import '../../core/session/session_store.dart';
import 'customer_history_api.dart';
import 'customer_history_copy.dart';
import 'recent_searches.dart';

/// The platform default the picker starts on (`DEFAULT_PHONE_COUNTRY_CODE`)
/// while [customerSearchDefaultCodeProvider] loads, and when it cannot be
/// read: India.
const defaultSearchCallingCode = '+91';

/// The platform's default calling code (`GET /customers/options`, `+91`), read
/// once per workspace. A failed read is NOT kept as an answer: the provider is
/// left in error (no automatic retry), the picker stays on
/// [defaultSearchCallingCode] meanwhile, and the search box reads it again
/// when it next opens ([CustomerHistoryController.rereadDefaultIfFailed]).
final customerSearchDefaultCodeProvider = FutureProvider.family<String, String>((ref, workspace) async {
  try {
    return (await ref.read(customerHistoryApiProvider).options()).defaultCountryCode;
  } on Exception catch (e) {
    reportToGate(ref, e);
    rethrow;
  }
}, retry: (_, _) => null);

/// The timeline filters, the console's set (`CustomerTimelineFiltersBar`):
/// the channel and connected calls only (chips on the page), and the
/// campaign, the days, the outcome, the outcome code and the agent (the
/// filters sheet), each a single choice from the summary's `filter_options`.
///
/// The days are calendar days on the phone's calendar, either end open:
/// [fromDay] from its midnight, [toDay] up to the next midnight (the wire's
/// `to` is half-open), so the last day is included whole.
@immutable
class CustomerHistoryFilter {
  const CustomerHistoryFilter({
    this.channel,
    this.connectedOnly = false,
    this.campaignId,
    this.fromDay,
    this.toDay,
    this.outcome,
    this.dispositionCode,
    this.agentUserId,
  });

  static const none = CustomerHistoryFilter();

  final CustomerTimelineChannel? channel;
  final bool connectedOnly;

  /// A ROOT campaign: a retry campaign is filtered with its parent (CH7).
  final String? campaignId;
  final DateTime? fromDay;
  final DateTime? toDay;
  final AttemptOutcome? outcome;
  final String? dispositionCode;
  final String? agentUserId;

  /// How many of the sheet's filters are set (the days count once).
  int get sheetCount =>
      <Object?>[campaignId, fromDay ?? toDay, outcome, dispositionCode, agentUserId].where((v) => v != null).length;

  bool get isFiltered => channel != null || connectedOnly || sheetCount > 0;

  /// Why the days cannot be applied (the first after the last), or null.
  String? get dateProblem {
    final from = fromDay;
    final to = toDay;
    return from != null && to != null && _day(from).isAfter(_day(to)) ? CustomerHistoryCopy.dateOrder : null;
  }

  static DateTime _day(DateTime t) => DateTime(t.year, t.month, t.day);

  CustomerHistoryFilter withChannel(CustomerTimelineChannel? channel) => CustomerHistoryFilter(
    channel: channel,
    connectedOnly: connectedOnly,
    campaignId: campaignId,
    fromDay: fromDay,
    toDay: toDay,
    outcome: outcome,
    dispositionCode: dispositionCode,
    agentUserId: agentUserId,
  );

  CustomerHistoryFilter withConnectedOnly(bool on) => CustomerHistoryFilter(
    channel: channel,
    connectedOnly: on,
    campaignId: campaignId,
    fromDay: fromDay,
    toDay: toDay,
    outcome: outcome,
    dispositionCode: dispositionCode,
    agentUserId: agentUserId,
  );

  /// The request's `filters`, or null for the whole history.
  CustomerTimelineFilters? toWire() {
    if (!isFiltered) return null;
    final campaign = campaignId;
    final from = fromDay;
    final to = toDay;
    final outcome = this.outcome;
    final code = dispositionCode;
    final agent = agentUserId;
    return CustomerTimelineFilters(
      campaignIds: campaign == null ? null : [campaign],
      from: from == null ? null : _day(from),
      to: to == null ? null : DateTime(to.year, to.month, to.day + 1),
      outcomes: outcome == null ? null : [outcome],
      dispositionCodes: code == null ? null : [code],
      agentUserIds: agent == null ? null : [agent],
      connectedOnly: connectedOnly ? true : null,
      channel: channel,
    );
  }

  @override
  bool operator ==(Object other) =>
      other is CustomerHistoryFilter &&
      other.channel == channel &&
      other.connectedOnly == connectedOnly &&
      other.campaignId == campaignId &&
      other.fromDay == fromDay &&
      other.toDay == toDay &&
      other.outcome == outcome &&
      other.dispositionCode == dispositionCode &&
      other.agentUserId == agentUserId;

  @override
  int get hashCode =>
      Object.hash(channel, connectedOnly, campaignId, fromDay, toDay, outcome, dispositionCode, agentUserId);
}

@immutable
class CustomerHistoryState {
  CustomerHistoryState({
    required this.country,
    this.searching = false,
    this.searchError,
    this.result,
    this.filter = CustomerHistoryFilter.none,
    List<CustomerTimelineEntry> entries = const [],
    this.nextCursor,
    this.loadingTimeline = false,
    this.timelineError,
    this.loadingMore = false,
    this.moreError,
    this.expired = false,
    List<RecentSearch> recent = const [],
  }) : entries = List.unmodifiable(entries),
       recent = List.unmodifiable(recent);

  /// The country picked next to the box.
  final SearchCountry country;

  /// A search is in flight.
  final bool searching;

  /// Why the last search did not run or failed, in the agent's words.
  final String? searchError;

  /// The last answer: the summary and the search id the pages name.
  final CustomerSearchResponse? result;

  /// The APPLIED timeline filter.
  final CustomerHistoryFilter filter;

  /// The timeline on screen under [filter], newest first.
  final List<CustomerTimelineEntry> entries;
  final String? nextCursor;

  /// The first page under a new filter is loading.
  final bool loadingTimeline;
  final String? timelineError;
  final bool loadingMore;
  final String? moreError;

  /// The server no longer knows the search id (30 minutes, `search_expired`):
  /// the page offers to search again.
  final bool expired;

  /// The last numbers searched on this device, newest first.
  final List<RecentSearch> recent;

  bool get hasMore => nextCursor != null;

  CustomerHistoryState copyWith({
    SearchCountry? country,
    bool? searching,
    String? searchError,
    bool clearSearchError = false,
    CustomerHistoryFilter? filter,
    List<CustomerTimelineEntry>? entries,
    String? nextCursor,
    bool clearCursor = false,
    bool? loadingTimeline,
    String? timelineError,
    bool clearTimelineError = false,
    bool? loadingMore,
    String? moreError,
    bool clearMoreError = false,
    bool? expired,
    List<RecentSearch>? recent,
  }) => CustomerHistoryState(
    country: country ?? this.country,
    searching: searching ?? this.searching,
    searchError: clearSearchError ? null : (searchError ?? this.searchError),
    result: result,
    filter: filter ?? this.filter,
    entries: entries ?? this.entries,
    nextCursor: clearCursor ? null : (nextCursor ?? this.nextCursor),
    loadingTimeline: loadingTimeline ?? this.loadingTimeline,
    timelineError: clearTimelineError ? null : (timelineError ?? this.timelineError),
    loadingMore: loadingMore ?? this.loadingMore,
    moreError: clearMoreError ? null : (moreError ?? this.moreError),
    expired: expired ?? this.expired,
    recent: recent ?? this.recent,
  );
}

class CustomerHistoryController extends Notifier<CustomerHistoryState> {
  int _generation = 0;

  /// Moves on whenever the recent searches are written or the workspace
  /// changes: a read of them started before is stale and dropped.
  int _recentVersion = 0;

  /// The agent picked a country: the platform default no longer moves it.
  bool _countryPicked = false;

  /// Rebuilt whenever [agentWorkspaceProvider] changes: the answer, the
  /// filter and the pages are dropped at once, and anything in flight for the
  /// old workspace is thrown away. Signed out, the recent searches are not
  /// read (sign-out clears them from the device). The picker starts on the
  /// platform default once it is known, India until then.
  @override
  CustomerHistoryState build() {
    final workspace = ref.watch(agentWorkspaceProvider);
    _generation++;
    _recentVersion++;
    _countryPicked = false;
    var callingCode = defaultSearchCallingCode;
    if (workspace != null) {
      unawaited(_loadRecent());
      final defaultCode = customerSearchDefaultCodeProvider(workspace);
      ref.listen(defaultCode, (_, next) {
        final code = next.value;
        if (code != null) _adoptDefault(code);
      });
      callingCode = ref.read(defaultCode).value ?? callingCode;
    }
    return CustomerHistoryState(country: resolveSearchCountry(null, callingCode));
  }

  RecentSearchesStore get _recent => RecentSearchesStore(ref.read(keyValueStoreProvider));
  CustomerHistoryApi get _api => ref.read(customerHistoryApiProvider);

  Future<void> _loadRecent() async {
    final version = _recentVersion;
    final recent = await _recent.read();
    if (!ref.mounted || version != _recentVersion) return;
    state = state.copyWith(recent: recent);
  }

  void _adoptDefault(String callingCode) {
    if (!ref.mounted || _countryPicked) return;
    final country = resolveSearchCountry(null, callingCode);
    if (country != state.country) state = state.copyWith(country: country);
  }

  /// Reads the platform default again when the last read failed (and none
  /// is in flight), unless the agent picked a country. The search box calls
  /// it as it opens, so one failure does not keep India for the session.
  void rereadDefaultIfFailed() {
    final workspace = ref.read(agentWorkspaceProvider);
    if (workspace == null || _countryPicked) return;
    final defaultCode = customerSearchDefaultCodeProvider(workspace);
    final current = ref.read(defaultCode);
    if (current.hasError && !current.isLoading) ref.invalidate(defaultCode);
  }

  void pickCountry(SearchCountry country) {
    _countryPicked = true;
    if (country == state.country && state.searchError == null) return;
    state = state.copyWith(country: country, clearSearchError: true);
  }

  /// The agent changed the text: an earlier refusal no longer describes it.
  void editing() {
    if (state.searchError != null) state = state.copyWith(clearSearchError: true);
  }

  /// Searches [raw] (as typed) in the picked country. A number the shared
  /// rule refuses is not sent: the refusal is shown instead. True when an
  /// answer arrived and is now [CustomerHistoryState.result].
  Future<bool> search(String raw) async {
    if (state.searching) return false;
    final country = state.country;
    final parsed = parseSearchNumber(raw, country);
    if (parsed is SearchNumberRefused) {
      state = state.copyWith(searchError: parsed.message);
      return false;
    }
    final mine = ++_generation;
    state = state.copyWith(searching: true, clearSearchError: true);
    try {
      final answer = await _api.search(CustomerSearchRequest(value: raw.trim(), country: country.iso));
      if (!ref.mounted || mine != _generation) return false;
      state = CustomerHistoryState(
        country: country,
        result: answer,
        entries: answer.timeline.entries,
        nextCursor: answer.timeline.nextCursor,
        recent: state.recent,
      );
      unawaited(_remember(answer.key));
      return true;
    } on Exception catch (e) {
      if (!ref.mounted || mine != _generation) return false;
      reportToGate(ref, e);
      state = state.copyWith(
        searching: false,
        searchError: customerHistoryFailure(e, fallback: CustomerHistoryCopy.searchFailed, country: country),
      );
      return false;
    }
  }

  /// After `search_expired`: the same number, a new search id.
  Future<bool> searchAgain() {
    final key = state.result?.key;
    if (key == null) return Future.value(false);
    return search(key.value);
  }

  Future<void> _remember(CustomerSearchKey key) async {
    final version = ++_recentVersion;
    final recent = await _recent.remember(RecentSearch(e164: key.value, display: key.display));
    if (!ref.mounted || version != _recentVersion) return;
    state = state.copyWith(recent: recent);
  }

  Future<void> clearRecent() async {
    _recentVersion++;
    state = state.copyWith(recent: const []);
    await _recent.clear();
  }

  /// Replace the timeline filter and read its first page. A no-op when
  /// nothing changed and that page is on screen, and for days that cannot be
  /// applied ([CustomerHistoryFilter.dateProblem]).
  Future<void> applyFilter(CustomerHistoryFilter filter) async {
    final result = state.result;
    if (result == null || state.expired || filter.dateProblem != null) return;
    if (filter == state.filter && state.timelineError == null) return;
    final mine = ++_generation;
    state = state.copyWith(
      filter: filter,
      entries: const [],
      clearCursor: true,
      loadingTimeline: true,
      clearTimelineError: true,
      loadingMore: false,
      clearMoreError: true,
    );
    try {
      final page = await _api.timeline(
        CustomerTimelineRequest(searchId: result.searchId, filters: filter.toWire(), limit: customerTimelinePageSize),
      );
      if (!ref.mounted || mine != _generation) return;
      state = state.copyWith(
        entries: page.entries,
        nextCursor: page.nextCursor,
        clearCursor: page.nextCursor == null,
        loadingTimeline: false,
      );
    } on Exception catch (e) {
      if (!ref.mounted || mine != _generation) return;
      reportToGate(ref, e);
      state = state.copyWith(
        loadingTimeline: false,
        expired: isSearchExpired(e),
        timelineError: customerHistoryFailure(e, fallback: CustomerHistoryCopy.timelineFailed, timeline: true),
      );
    }
  }

  /// "Load more": the next page under the applied filter. Does nothing while
  /// a page is in flight, on the last page, or once the search has expired.
  Future<void> loadMore() async {
    final s = state;
    final result = s.result;
    if (result == null || s.nextCursor == null || s.loadingMore || s.loadingTimeline || s.expired) return;
    // CAPTURED, not incremented: a continuation of what is on screen. A new
    // search or filter moves the counter on and this page is thrown away.
    final mine = _generation;
    state = s.copyWith(loadingMore: true, clearMoreError: true);
    try {
      final page = await _api.timeline(
        CustomerTimelineRequest(
          searchId: result.searchId,
          filters: s.filter.toWire(),
          cursor: s.nextCursor,
          limit: customerTimelinePageSize,
        ),
      );
      if (!ref.mounted || mine != _generation) return;
      state = state.copyWith(
        entries: [...state.entries, ...page.entries],
        nextCursor: page.nextCursor,
        clearCursor: page.nextCursor == null,
        loadingMore: false,
      );
    } on Exception catch (e) {
      if (!ref.mounted || mine != _generation) return;
      reportToGate(ref, e);
      state = state.copyWith(
        loadingMore: false,
        expired: isSearchExpired(e),
        moreError: customerHistoryFailure(e, fallback: CustomerHistoryCopy.moreFailed, timeline: true),
      );
    }
  }
}

final customerHistoryControllerProvider =
    NotifierProvider<CustomerHistoryController, CustomerHistoryState>(CustomerHistoryController.new);
