import 'dart:async';

import 'package:agency_wire/agency_wire.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/misc.dart' show Override;
import 'package:flutter_test/flutter_test.dart';
import 'package:magick_agency_agent/app/theme/app_theme.dart';
import 'package:magick_agency_agent/app/theme/tokens.dart';
import 'package:magick_agency_agent/core/api/api_error.dart';
import 'package:magick_agency_agent/features/performance/logic/stats_windows.dart';
import 'package:magick_agency_agent/features/performance/performance_api.dart';
import 'package:magick_agency_agent/features/performance/performance_controller.dart';

/// India: the product's home zone, east of Greenwich.
const ist = FixedOffsetCalendar(Duration(hours: 5, minutes: 30), 'IST');

/// New York in October (EDT), west of Greenwich.
const edt = FixedOffsetCalendar(Duration(hours: -4), 'EDT');

AgentStatsTotals totals({
  int attempts = 142,
  int connected = 54,
  double? connectRate = 38.0281690140845,
  int successes = 12,
  double? successRate = 22.2222222,
  double talk = 10390,
  double wrapup = 1296,
  double? aht = 216.4,
  int campaigns = 2,
}) =>
    AgentStatsTotals(
      attempts: attempts,
      connected: connected,
      connectRatePct: connectRate,
      successes: successes,
      successRatePct: successRate,
      talkSeconds: talk,
      wrapupSeconds: wrapup,
      ahtSeconds: aht,
      campaigns: campaigns,
    );

AgentStatsBucket bucket(String day, int attempts, int connected) => AgentStatsBucket(
      bucketStart: CalendarDate.parse(day),
      attempts: attempts,
      connected: connected,
      successes: 0,
      talkSeconds: 0,
      wrapupSeconds: 0,
    );

AgentStats stats({
  required DateTime from,
  required DateTime to,
  AgentStatsTotals? t,
  List<AgentStatsBucket> buckets = const [],
  List<AgentCampaignRow> byCampaign = const [],
}) =>
    AgentStats(
      agentUserId: 'u1',
      bucket: StatsBucketUnit.day,
      from: from,
      to: to,
      totals: t ?? totals(),
      buckets: buckets,
      byCampaign: byCampaign,
    );

StaffingHistoryEntry staffing(String id, String? name) => StaffingHistoryEntry(
      campaignId: id,
      campaignName: name,
      campaignStatusRaw: 'running',
      assignedAt: DateTime.utc(2026, 9, 1),
      active: true,
    );

/// A scripted `/my-stats` and `/my-campaigns`. Each stats call waits on its
/// own completer, so a test decides when (and in which order) answers land.
class FakePerformanceApi implements PerformanceApi {
  FakePerformanceApi({this.campaigns = const []});

  String workspace = 't1:a1';
  List<StaffingHistoryEntry> campaigns;
  final List<AgentStatsQuery> statsQueries = [];
  final List<Completer<AgentStats>> pending = [];

  /// When set, answers immediately instead of waiting.
  AgentStats Function(AgentStatsQuery q)? autoAnswer;
  Object? campaignsError;

  @override
  String get workspaceKey => workspace;

  @override
  Future<AgentStats> myStats(AgentStatsQuery query) {
    statsQueries.add(query);
    final auto = autoAnswer;
    if (auto != null) return Future.value(auto(query));
    final c = Completer<AgentStats>();
    pending.add(c);
    return c.future;
  }

  @override
  Future<StaffingHistory> myCampaigns() async {
    if (campaignsError != null) throw campaignsError!;
    return StaffingHistory(campaigns);
  }

  void answer(int i, AgentStats s) => pending[i].complete(s);

  void fail(int i, [ApiError e = const ApiNetworkError('offline')]) => pending[i].completeError(e);
}

/// Wed 14 Oct 2026, 10:30 IST.
final fixedNow = DateTime.utc(2026, 10, 14, 5);

List<Override> perfOverrides(FakePerformanceApi api, {DateTime? now, LocalCalendar calendar = ist}) => [
      performanceApiProvider.overrideWithValue(api),
      statsClockProvider.overrideWithValue(() => now ?? fixedNow),
      localCalendarProvider.overrideWithValue(calendar),
    ];

/// The app's theme around a screen, at phone size.
Widget harness(Widget child, List<Override> overrides, {double textScale = 1}) => ProviderScope(
      overrides: overrides,
      child: MaterialApp(
        theme: buildTheme(AppTokens.dark, Brightness.dark),
        builder: (context, app) => MediaQuery(
          data: MediaQuery.of(context).copyWith(textScaler: TextScaler.linear(textScale)),
          child: app!,
        ),
        home: child,
      ),
    );

Future<void> setPhoneSize(WidgetTester tester) async {
  tester.view.physicalSize = const Size(1080, 2340);
  tester.view.devicePixelRatio = 3;
  addTearDown(tester.view.reset);
}

/// A provider change reaches the widgets one frame later (Riverpod schedules
/// the rebuild), so a scripted answer needs two frames to show.
Future<void> flush(WidgetTester tester) async {
  await tester.pump();
  await tester.pump();
}
