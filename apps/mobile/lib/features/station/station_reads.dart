import 'dart:async';

import 'package:agency_wire/agency_wire.dart';
import 'package:collection/collection.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/providers.dart';
import '../../core/api/api_client.dart';
import '../../core/api/api_error.dart' show ApiUnauthorized;
import '../../core/api/decode_body.dart';
import '../../core/auth/app_gate.dart' show agentWorkspaceProvider, reportToGate;
import '../../core/flags/feature_flags.dart' show contactAssignmentEnabledProvider;
import '../../core/station/station_view.dart' show AgentPhase, InboundCallView, stationViewProvider;
import '../contacts/my_contacts_api.dart';
import '../performance/logic/stats_windows.dart';
import '../performance/performance_api.dart';
import '../performance/performance_controller.dart' show localCalendarProvider, statsClockProvider;

/// The two reads the station's Ready, Start of day and Finish work screens show beside the live
/// view (design-spec §5.1, §5.2, §5.7), as plain values the screens render.
///
/// The agent's own day is `GET /proxy/agency/my-day` (BE-1 to BE-3): the target, Will pay and the
/// call-laters this agent booked, with who will make them (AS8). A server older than it (404), or a
/// read that fails, falls back to what every server has: the agent's own `/my-stats` for today and,
/// where the campaign has a My contacts, its booked call-laters. A field the answer does not carry
/// means its tile or line is not shown.

/// My day, as the Ready screen's three tiles show it.
@immutable
class MyDayView {
  const MyDayView({required this.callsToday, required this.talkSeconds, required this.dialled, this.target, this.willPay, this.dayEnd});

  /// Connected calls today on this campaign (AS6: a target counts conversations).
  final int callsToday;
  final int talkSeconds;

  /// Numbers dialled for the agent today: the third tile when there is no Will pay.
  final int dialled;

  /// The campaign's daily target in connected calls (AS6, BE-2): "/ 120" and the bar; null without
  /// one.
  final int? target;

  /// Outcomes today that recorded a pay date (AS7, BE-1): the third tile; null on a campaign that
  /// records none, or from a server without my-day.
  final int? willPay;

  /// When the day these numbers count ends: my-day's `day_end` (the campaign's next midnight);
  /// null from the fallback read (the phone's own midnight).
  final DateTime? dayEnd;

  @override
  bool operator ==(Object other) =>
      other is MyDayView &&
      other.dayEnd == dayEnd &&
      other.callsToday == callsToday &&
      other.talkSeconds == talkSeconds &&
      other.dialled == dialled &&
      other.target == target &&
      other.willPay == willPay;
  @override
  int get hashCode => Object.hash(callsToday, talkSeconds, dialled, target, willPay);
}

/// `GET /proxy/agency/my-day?campaign_id=` (BE-1).
class MyDayApi {
  MyDayApi(this._api);

  final ApiClient _api;

  static const path = '/proxy/agency/my-day';

  Future<MyDay> read(String campaignId) async {
    final body = await _api.get(path, query: MyDayQuery(campaignId: campaignId).toQuery());
    return decodeBody(path, body, MyDay.fromJson);
  }
}

final myDayApiProvider = Provider<MyDayApi>((ref) => MyDayApi(ref.watch(apiClientProvider)));

/// The agent's day on this campaign from the server's own read, or null when there is none to have
/// (an older server's 404, a failed read): the station then reads what every server has.
///
/// Scoped to the signed-in agent ([agentWorkspaceProvider]): a new sign-in, or another account,
/// reads afresh and never sees the previous agent's numbers. A 401 goes to the app gate, as every
/// feature's does (it decides about signing out), and is not hidden behind the fallback.
final stationMyDayReadProvider = FutureProvider.family<MyDay?, String>((ref, campaignId) async {
  ref.watch(agentWorkspaceProvider);
  try {
    return await ref.read(myDayApiProvider).read(campaignId);
  } on ApiUnauthorized catch (e) {
    reportToGate(ref, e);
    rethrow;
  } catch (_) {
    return null;
  }
}, retry: _noRetry);

/// The station reads again on its own times ([StationReadsRefresher]); a failed read is not retried
/// in between (a 401 would be reported to the gate again and again).
Duration? _noRetry(int _, Object _) => null;

/// [read], with a 401 handed to the app gate first.
Future<T> _reportingToGate<T>(Ref ref, Future<T> Function() read) async {
  try {
    return await read();
  } catch (e) {
    reportToGate(ref, e);
    rethrow;
  }
}

/// My day's three tiles: my-day's when the server has it, else today's `/my-stats` on this
/// phone's calendar (no target, no Will pay). Read again each time Ready opens again
/// ([refreshStationReads]); the last answer stays on screen while it is read.
final stationMyDayProvider = FutureProvider.family<MyDayView?, String>((ref, campaignId) async {
  ref.watch(agentWorkspaceProvider);
  final day = await ref.watch(stationMyDayReadProvider(campaignId).future);
  if (day != null) {
    final target = day.target;
    return MyDayView(
      callsToday: day.calls,
      talkSeconds: day.talkSeconds,
      dialled: day.dialed,
      target: target != null && target.metric == MyDayTargetMetric.calls && target.value > 0 ? target.value : null,
      willPay: day.willPay,
      dayEnd: day.dayEnd,
    );
  }
  final now = ref.read(statsClockProvider)();
  final range = windowRange(StatsWindow.today, now, calendar: ref.read(localCalendarProvider));
  final stats = await _reportingToGate(
    ref,
    () => ref.read(performanceApiProvider).myStats(AgentStatsQuery(from: range.from, to: range.to, campaignId: campaignId)),
  );
  final t = stats.totals;
  return MyDayView(callsToday: t.connected, talkSeconds: t.talkSeconds.round(), dialled: t.attempts);
}, retry: _noRetry);

/// One call-later the agent has today, as the Ready list shows it.
@immutable
class CallLaterItem {
  const CallLaterItem({required this.at, required this.name, this.overdue = false});

  /// When it falls due (the booked time), on this device's clock.
  final DateTime at;

  /// Who: their name (from the fallback read, the contact's first hero value). Empty when nobody
  /// is named: the list then says "Customer", never the number.
  final String name;

  /// Its time has passed and it has not been made yet.
  final bool overdue;

  @override
  bool operator ==(Object other) => other is CallLaterItem && other.at == at && other.name == name && other.overdue == overdue;
  @override
  int get hashCode => Object.hash(at, name, overdue);
}

/// The agent's call-later list, and who will make them.
@immutable
class CallLaterList {
  const CallLaterList({this.items = const [], this.today, this.comesToMe, this.leftGoesToPool});

  static const none = CallLaterList();

  /// Soonest first.
  final List<CallLaterItem> items;

  /// Due from now to the end of the campaign's day (my-day's count); null from the fallback read,
  /// where [items] is the day's list.
  final int? today;

  /// The server says these come to this agent (AS8, `comes_to_me`); null from the fallback read,
  /// where the station judges it by whether the campaign assigns contacts.
  final bool? comesToMe;

  /// One left at Finish work goes to another agent (`left_today_goes_to: pool`); false: it waits
  /// for this agent; null when the server did not say.
  final bool? leftGoesToPool;

  /// How many are still due today (an overdue one is not counted, as my-day's own `today`).
  int get todayCount => today ?? items.where((i) => !i.overdue).length;

  static const _eq = ListEquality<CallLaterItem>();

  @override
  bool operator ==(Object other) =>
      other is CallLaterList &&
      _eq.equals(other.items, items) &&
      other.today == today &&
      other.comesToMe == comesToMe &&
      other.leftGoesToPool == leftGoesToPool;
  @override
  int get hashCode => Object.hash(items.length, today, comesToMe, leftGoesToPool);
}

/// What the station asks [stationCallLaterProvider] for: the campaign, and whether today's My
/// contacts serves it (for the fallback read).
typedef CallLaterKey = ({String campaignId, bool offered});

/// The call-laters this agent booked on this campaign (my-day's `call_later`, BE-3, on every
/// assignment mode). From a server without my-day, today's My contacts read
/// (`GET /proxy/agency/my-contacts?bucket=callback`) where it serves (contact assignment on for the
/// account and the campaign has a My contacts: [StationView.myContactsOffered]), only those due
/// before the end of today on this phone's calendar; nothing otherwise.
final stationCallLaterProvider = FutureProvider.family<CallLaterList, CallLaterKey>((ref, key) async {
  ref.watch(agentWorkspaceProvider);
  final day = await ref.watch(stationMyDayReadProvider(key.campaignId).future);
  if (day != null) {
    final later = day.callLater;
    return CallLaterList(
      items: List.unmodifiable([
        for (final r in later.rows) CallLaterItem(at: r.dueAt.toLocal(), name: r.customerName?.trim() ?? '', overdue: r.overdue),
      ]),
      today: later.today,
      comesToMe: later.comesToMe,
      leftGoesToPool: switch (later.leftTodayGoesTo) {
        CallLaterLeftGoesTo.pool => true,
        CallLaterLeftGoesTo.waitsForMe => false,
        CallLaterLeftGoesTo.unknown => null,
      },
    );
  }
  if (!key.offered || !ref.watch(contactAssignmentEnabledProvider)) return CallLaterList.none;
  final now = ref.read(statsClockProvider)();
  final page = await _reportingToGate(
    ref,
    () => ref.read(myContactsApiProvider).list(
          MyContactsQuery(campaignId: key.campaignId, buckets: const [MyContactBucket.callback], limit: 50),
        ),
  );
  final endOfDay = DateTime(now.year, now.month, now.day).add(const Duration(days: 1));
  return CallLaterList(
    items: page.rows
        .where((c) => c.bucket == MyContactBucket.callback && c.nextAttemptAt.toLocal().isBefore(endOfDay))
        .map((c) {
          final hero = c.hero.firstWhereOrNull((h) => h.value.trim().isNotEmpty)?.value.trim();
          // Never the number: the list says "Customer" for one with no name.
          return CallLaterItem(at: c.nextAttemptAt.toLocal(), name: hero ?? '');
        })
        .sorted((a, b) => a.at.compareTo(b.at))
        .toList(growable: false),
  );
}, retry: _noRetry);

/// AS8: whether a call-later booked on this station comes back to this agent. my-day's
/// `comes_to_me` when the server sends it; else whether the campaign assigns contacts
/// ([StationView.assignsContacts]: `strict` or `preferred` yes, `pool` no), as the console decides
/// (`AgentConsolePage`'s `assigns`). Never the `queue` frame: since BE-5 it comes on `pool` too.
bool watchComesToMe(WidgetRef ref) {
  final key = ref.watch(
    stationViewProvider.select((v) => v == null ? null : (campaignId: v.campaignId, offered: v.myContactsOffered)),
  );
  final assigns = ref.watch(stationViewProvider.select((v) => v?.assignsContacts ?? false));
  if (key == null) return false;
  return ref.watch(stationCallLaterProvider(key)).value?.comesToMe ?? assigns;
}

/// AS8 for an inbound caller matched to another campaign than this station's: whether that campaign
/// assigns contacts, from its My contacts summary (the console's `useMatchedComesToMe`). False when
/// it cannot be read: "Another agent may get the call" is never a false promise.
final matchedAssignsContactsProvider = FutureProvider.family<bool, String>((ref, campaignId) async {
  ref.watch(agentWorkspaceProvider);
  try {
    final summary = await ref.read(myContactsApiProvider).summary(campaignId);
    return summary.assignmentModeRaw != AssignmentMode.pool.wire;
  } catch (e) {
    reportToGate(ref, e);
    return false;
  }
}, retry: _noRetry);

/// Who makes a call-later booked for an inbound caller (AS8): true, it comes to this agent (the
/// matched campaign is `strict` or `preferred`); false, another agent may (`pool`, or not known yet);
/// null, the caller is on no list, so nobody calls back by themselves.
bool? watchInboundComesToMe(WidgetRef ref, InboundCallView call) {
  final id = call.campaignId;
  if (!call.matched || id == null) return null;
  final own = ref.watch(stationViewProvider.select((v) => v != null && v.campaignId == id ? v.assignsContacts : null));
  if (own != null) return own;
  return ref.watch(matchedAssignsContactsProvider(id)).value ?? false;
}

/// Reads My day and the call-later list again; what was shown stays until the new answer lands.
/// [StationReadsRefresher] calls it when the my-day contract says to.
void refreshStationReads(WidgetRef ref, String campaignId, {required bool callLaterOffered}) {
  ref.invalidate(stationMyDayReadProvider(campaignId));
  ref.invalidate(stationMyDayProvider(campaignId));
  ref.invalidate(stationCallLaterProvider((campaignId: campaignId, offered: callLaterOffered)));
}

/// Keeps My day and the call-later list fresh, as the my-day contract says the station reads it
/// (`packages/contracts/src/api/agency/my-day.ts`): on join (a new session), on every `ready` frame
/// (the first, and one after each reconnect: [StationView.readyCount]), after each saved outcome,
/// every 60 s while Ready, and again when Ready opens after a call or a break. It also reads again
/// at the end of the campaign's day (my-day's `day_end`; the phone's midnight from a server without
/// my-day), so a screen left open past midnight shows the new day. Draws nothing.
class StationReadsRefresher extends ConsumerStatefulWidget {
  const StationReadsRefresher({super.key, required this.campaignId});

  final String campaignId;

  /// While Ready, the reads are made again this often.
  static const readyPeriod = Duration(seconds: 60);

  /// Past the day's end, so the server's clock is surely on the new day.
  static const pastMidnight = Duration(seconds: 5);

  @override
  ConsumerState<StationReadsRefresher> createState() => _StationReadsRefresherState();
}

class _StationReadsRefresherState extends ConsumerState<StationReadsRefresher> {
  Timer? _ready;
  Timer? _midnight;

  @override
  void initState() {
    super.initState();
    ref.listenManual<({String? session, int ready})?>(
      stationViewProvider.select((v) => v == null || v.campaignId != widget.campaignId ? null : (session: v.sessionId, ready: v.readyCount)),
      (prev, next) {
        // A new session (the join) or another `ready` frame: read again. Not before the first.
        if (next == null || prev == null || next == prev || next.ready == 0) return;
        _refresh();
      },
    );
    ref.listenManual<String?>(stationViewProvider.select((v) => v?.dispositionSaved), (prev, next) {
      if (next != null && prev == null) _refresh();
    });
    ref.listenManual<AgentPhase?>(
      stationViewProvider.select((v) => v == null || v.campaignId != widget.campaignId ? null : v.phase),
      (prev, next) {
        if (next == AgentPhase.available) {
          // Back to Ready after a call or a break.
          if (prev != null && prev != AgentPhase.available) _refresh();
          _ready ??= Timer.periodic(StationReadsRefresher.readyPeriod, (_) => _refresh());
        } else {
          _ready?.cancel();
          _ready = null;
        }
      },
      fireImmediately: true,
    );
    // Read on join, and the day's end from the answer.
    ref.listenManual<AsyncValue<MyDayView?>>(stationMyDayProvider(widget.campaignId), (_, next) {
      if (next.hasValue || next.hasError) _scheduleMidnight(next.value?.dayEnd);
    }, fireImmediately: true);
  }

  void _scheduleMidnight(DateTime? dayEnd) {
    _midnight?.cancel();
    final now = ref.read(statsClockProvider)();
    final local = now.toLocal();
    final end = dayEnd ?? DateTime(local.year, local.month, local.day + 1);
    var wait = end.difference(now) + StationReadsRefresher.pastMidnight;
    // A day that already ended (a stale answer): read again soon, never in a tight loop.
    if (wait < StationReadsRefresher.pastMidnight) wait = StationReadsRefresher.pastMidnight;
    _midnight = Timer(wait, _refresh);
  }

  void _refresh() {
    if (!mounted) return;
    final v = ref.read(stationViewProvider);
    if (v == null || v.campaignId != widget.campaignId) return;
    refreshStationReads(ref, v.campaignId, callLaterOffered: v.myContactsOffered);
  }

  @override
  void dispose() {
    _ready?.cancel();
    _midnight?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => const SizedBox.shrink();
}
