import 'package:agency_wire/agency_wire.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/auth/app_gate.dart';
import 'logic/stats_windows.dart';
import 'performance_api.dart';

/// "My performance" state: the selection (window + campaign scope) and one
/// cached result per selection, served stale-while-revalidate.
///
/// Every selection the agent has looked at keeps its last answer, so going
/// back to "This week" paints instantly from the cache and refreshes behind
/// it. Results are keyed by the window's NAME (see [StatsWindow]) and the
/// campaign, never by the range, and the whole cache is dropped when the
/// workspace or the signed-in agent changes (a campaign id belongs to one
/// tenant, the figures to one agent).

/// Injected so window math is testable with a fixed clock.
final statsClockProvider = Provider<DateTime Function()>((ref) => DateTime.now);

/// The reader's calendar; tests pin a zone with [FixedOffsetCalendar].
final localCalendarProvider = Provider<LocalCalendar>((ref) => const DeviceCalendar());

@immutable
class StatsKey {
  const StatsKey(this.window, this.campaignId);

  final StatsWindow window;
  final String? campaignId;

  @override
  bool operator ==(Object other) => other is StatsKey && other.window == window && other.campaignId == campaignId;

  @override
  int get hashCode => Object.hash(window, campaignId);

  @override
  String toString() => 'StatsKey($window, $campaignId)';
}

/// One selection's last answer and whether it is being re-read.
@immutable
class StatsSlot {
  const StatsSlot({this.stats, this.error, this.loading = false});

  static const empty = StatsSlot();

  /// The last good answer (kept through a failed refresh).
  final AgentStats? stats;

  /// The last read's failure, in the agent's words; null after a success.
  final String? error;
  final bool loading;

  /// Nothing to show yet and a read in flight: skeletons.
  bool get firstLoad => stats == null && error == null;

  /// Showing an earlier answer while a newer one is read.
  bool get refreshing => stats != null && loading;

  StatsSlot copyWith({AgentStats? stats, String? error, bool clearError = false, bool? loading}) => StatsSlot(
        stats: stats ?? this.stats,
        error: clearError ? null : (error ?? this.error),
        loading: loading ?? this.loading,
      );

  @override
  bool operator ==(Object other) =>
      other is StatsSlot && other.stats == stats && other.error == error && other.loading == loading;

  @override
  int get hashCode => Object.hash(stats, error, loading);
}

@immutable
class PerformanceState {
  PerformanceState({
    required this.workspace,
    this.window = StatsWindow.today,
    this.campaignId,
    Map<StatsKey, StatsSlot> slots = const {},
  }) : slots = Map.unmodifiable(slots);

  final String workspace;
  final StatsWindow window;

  /// The campaign scope, or null for the whole record.
  final String? campaignId;
  final Map<StatsKey, StatsSlot> slots;

  StatsKey get key => StatsKey(window, campaignId);
  StatsSlot get current => slots[key] ?? StatsSlot.empty;

  PerformanceState copyWith({StatsWindow? window, String? campaignId, bool clearCampaign = false, Map<StatsKey, StatsSlot>? slots}) =>
      PerformanceState(
        workspace: workspace,
        window: window ?? this.window,
        campaignId: clearCampaign ? null : (campaignId ?? this.campaignId),
        slots: slots ?? this.slots,
      );

  PerformanceState withSlot(StatsKey k, StatsSlot slot) => copyWith(slots: {...slots, k: slot});

  @override
  bool operator ==(Object other) =>
      other is PerformanceState &&
      other.workspace == workspace &&
      other.window == window &&
      other.campaignId == campaignId &&
      mapEquals(other.slots, slots);

  @override
  int get hashCode => Object.hash(workspace, window, campaignId, Object.hashAllUnordered(slots.entries.map((e) => Object.hash(e.key, e.value))));
}

class PerformanceController extends Notifier<PerformanceState> {
  /// The newest read per selection: an older answer landing after a newer
  /// request was made is dropped rather than painted over it.
  final Map<StatsKey, int> _generation = {};

  /// Bumped on every workspace change. The notifier outlives a rebuild, so a
  /// read for the previous workspace is told apart by this, not by
  /// `ref.mounted` (still true) or its per-selection count (restarted).
  int _epoch = 0;

  /// Rebuilt whenever [agentWorkspaceProvider] changes (another account,
  /// another agent, signed out): nothing cached belongs to the new one, and a
  /// campaign scope from the old one would point at a campaign it cannot see.
  /// The screen revalidates on the change.
  @override
  PerformanceState build() {
    final workspace = ref.watch(agentWorkspaceProvider);
    _epoch++;
    _generation.clear();
    return PerformanceState(workspace: workspace ?? '', window: stateOrNull?.window ?? StatsWindow.today);
  }

  /// Switch window and revalidate it (cached answer shows at once).
  Future<void> selectWindow(StatsWindow window) {
    if (window != state.window) state = state.copyWith(window: window);
    return revalidate();
  }

  /// Scope every figure to one campaign, or null for all of them.
  Future<void> selectCampaign(String? campaignId) {
    if (campaignId != state.campaignId) {
      state = campaignId == null ? state.copyWith(clearCampaign: true) : state.copyWith(campaignId: campaignId);
    }
    return revalidate();
  }

  /// Re-read the current selection. Completes when the read settles (for
  /// pull-to-refresh); never throws: failures land in the slot.
  Future<void> revalidate() async {
    // Signed out (or between accounts): there is nobody to read for.
    if (ref.read(agentWorkspaceProvider) == null) return;
    final api = ref.read(performanceApiProvider);
    final key = state.key;
    final epoch = _epoch;
    final mine = (_generation[key] ?? 0) + 1;
    _generation[key] = mine;
    bool stale() => !ref.mounted || epoch != _epoch || _generation[key] != mine;
    state = state.withSlot(key, state.current.copyWith(loading: true));

    // One `now` per read, so `to` is one instant (the console's rule).
    final now = ref.read(statsClockProvider)();
    final range = windowRange(key.window, now, calendar: ref.read(localCalendarProvider));
    final query = AgentStatsQuery(from: range.from, to: range.to, campaignId: key.campaignId);

    try {
      final stats = await api.myStats(query);
      if (stale()) return;
      state = state.withSlot(key, StatsSlot(stats: stats));
    } on Exception catch (e) {
      if (stale()) return;
      reportToGate(ref, e); // a 401 here is the end of the sign-in, as anywhere
      final slot = state.slots[key] ?? StatsSlot.empty;
      state = state.withSlot(key, slot.copyWith(error: errorMessage(e, 'Could not load these numbers.'), loading: false));
    }
  }
}

final performanceControllerProvider =
    NotifierProvider<PerformanceController, PerformanceState>(PerformanceController.new);
