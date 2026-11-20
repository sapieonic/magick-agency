import 'package:agency_wire/agency_wire.dart';
import 'package:collection/collection.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/flags/feature_flags.dart' show contactAssignmentEnabledProvider;
import '../contacts/my_contacts_api.dart';
import '../performance/logic/stats_windows.dart';
import '../performance/performance_api.dart';
import '../performance/performance_controller.dart' show localCalendarProvider, statsClockProvider;

/// The two reads the station's Ready and Start of day screens show beside the live view (design-spec
/// §5.1, §5.2), as plain values the screens render. Phase 0 (BE-0) fills them from what the server
/// sends today; the agent's own my-day read (BE-1), the daily target (BE-2) and the booker's own
/// call-laters (BE-3) slot in here, and a field not there yet means its tile or line is not shown.

/// My day, as the Ready screen's three tiles show it.
@immutable
class MyDayView {
  const MyDayView({required this.callsToday, required this.talkSeconds, required this.dialled, this.target, this.willPay});

  /// Connected calls today on this campaign (AS6: a target counts conversations).
  final int callsToday;
  final int talkSeconds;

  /// Numbers dialled for the agent today: the third tile until "Will pay" is sent.
  final int dialled;

  /// The campaign's daily target in connected calls (AS6, BE-2); null until the server sends one,
  /// and the tile then shows no "/ 120" and no bar.
  final int? target;

  /// Outcomes today that recorded a pay date (AS7, BE-1); null on a campaign that records none, or
  /// until the server sends it, and the tile is not shown.
  final int? willPay;

  @override
  bool operator ==(Object other) =>
      other is MyDayView &&
      other.callsToday == callsToday &&
      other.talkSeconds == talkSeconds &&
      other.dialled == dialled &&
      other.target == target &&
      other.willPay == willPay;
  @override
  int get hashCode => Object.hash(callsToday, talkSeconds, dialled, target, willPay);
}

/// The agent's own scorecard for today on this campaign (`GET /proxy/agency/my-stats`, today's
/// window on this phone's calendar, as My performance reads it). Read again each time Ready opens
/// ([refreshStationReads]); the last answer stays on screen while it is read.
final stationMyDayProvider = FutureProvider.family<MyDayView?, String>((ref, campaignId) async {
  final now = ref.read(statsClockProvider)();
  final range = windowRange(StatsWindow.today, now, calendar: ref.read(localCalendarProvider));
  final stats = await ref.read(performanceApiProvider).myStats(
        AgentStatsQuery(from: range.from, to: range.to, campaignId: campaignId),
      );
  final t = stats.totals;
  return MyDayView(callsToday: t.connected, talkSeconds: t.talkSeconds.round(), dialled: t.attempts);
});

/// One call-later the agent has today, as the Ready list shows it.
@immutable
class CallLaterItem {
  const CallLaterItem({required this.at, required this.name});

  /// When it falls due (the booked time), on this device's clock.
  final DateTime at;

  /// Who: the contact's first hero value (their name, on most rosters), else their number.
  final String name;

  @override
  bool operator ==(Object other) => other is CallLaterItem && other.at == at && other.name == name;
  @override
  int get hashCode => Object.hash(at, name);
}

/// What the station asks [stationCallLaterProvider] for.
typedef CallLaterKey = ({String campaignId, bool offered});

/// Today's call-laters the agent holds on this campaign, soonest first: today's My contacts read
/// (`GET /proxy/agency/my-contacts?bucket=callback`), where it serves (contact assignment on for the
/// account and the campaign has a My contacts: [StationView.myContactsOffered]). Empty otherwise,
/// and the list is not shown. Only those due before the end of today on this phone's calendar.
final stationCallLaterProvider = FutureProvider.family<List<CallLaterItem>, CallLaterKey>((ref, key) async {
  if (!key.offered || !ref.watch(contactAssignmentEnabledProvider)) return const [];
  final now = ref.read(statsClockProvider)();
  final page = await ref.read(myContactsApiProvider).list(
        MyContactsQuery(campaignId: key.campaignId, buckets: const [MyContactBucket.callback], limit: 50),
      );
  final endOfDay = DateTime(now.year, now.month, now.day).add(const Duration(days: 1));
  return page.rows
      .where((c) => c.bucket == MyContactBucket.callback && c.nextAttemptAt.toLocal().isBefore(endOfDay))
      .map((c) {
        final hero = c.hero.firstWhereOrNull((h) => h.value.trim().isNotEmpty)?.value.trim();
        return CallLaterItem(at: c.nextAttemptAt.toLocal(), name: hero ?? c.phoneE164);
      })
      .sorted((a, b) => a.at.compareTo(b.at))
      .toList(growable: false);
});

/// Reads My day and the call-later list again (Ready opened, or the agent pulled to refresh); what
/// was shown stays until the new answer lands.
void refreshStationReads(WidgetRef ref, String campaignId, {required bool callLaterOffered}) {
  ref.invalidate(stationMyDayProvider(campaignId));
  ref.invalidate(stationCallLaterProvider((campaignId: campaignId, offered: callLaterOffered)));
}
