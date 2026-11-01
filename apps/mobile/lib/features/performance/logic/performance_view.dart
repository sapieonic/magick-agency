import 'package:agency_wire/agency_wire.dart';
import 'package:meta/meta.dart';

import 'bucket_series.dart';
import 'en_in_format.dart';
import 'readouts.dart';
import 'stats_windows.dart';

/// Everything the performance body shows for one answer, derived once per
/// payload (not per frame) by a pure function, so the screen only lays it
/// out and the derivation is unit-tested.
@immutable
class PerformanceView {
  const PerformanceView({
    required this.tiles,
    required this.conversion,
    required this.handleTime,
    required this.wrapup,
    required this.series,
    required this.rangeCaption,
    required this.emptyLine,
    required this.campaigns,
    required this.campaignsWorked,
  });

  final List<HeadlineFigure> tiles;
  final Readout conversion;
  final Readout handleTime;
  final Readout wrapup;

  /// Null before an answer has arrived.
  final BucketSeries? series;

  /// `12 Oct – 18 Oct 2026 · IST (UTC+05:30)`.
  final String? rangeCaption;

  /// "No calls reached you today." when nothing happened at all.
  final String? emptyLine;
  final List<CampaignRowView> campaigns;
  final String? campaignsWorked;
}

/// One line of the by-campaign breakdown, formatted.
@immutable
class CampaignRowView {
  const CampaignRowView({
    required this.campaignId,
    required this.name,
    required this.dials,
    required this.connectRate,
    required this.conversations,
    required this.counted,
    required this.onCalls,
  });

  final String campaignId;
  final String name;
  final String dials;

  /// The console's floored per-campaign rate ("Not enough calls" under 20).
  final String connectRate;
  final String conversations;
  final String counted;
  final String onCalls;

  @override
  bool operator ==(Object other) =>
      other is CampaignRowView &&
      other.campaignId == campaignId &&
      other.name == name &&
      other.dials == dials &&
      other.connectRate == connectRate &&
      other.conversations == conversations &&
      other.counted == counted &&
      other.onCalls == onCalls;

  @override
  int get hashCode => Object.hash(campaignId, name, dials, connectRate, conversations, counted, onCalls);
}

CalendarDate _wallDate(LocalCalendar calendar, DateTime instant) {
  final w = calendar.wall(instant);
  return CalendarDate(w.year, w.month, w.day);
}

PerformanceView buildPerformanceView({
  required StatsWindow window,
  required AgentStats? stats,
  required Map<String, String?> campaignNames,
  LocalCalendar calendar = const DeviceCalendar(),
}) {
  final totals = stats?.totals;
  if (stats == null) {
    return PerformanceView(
      tiles: headlineTrio(null),
      conversion: conversionReadout(null),
      handleTime: handleTimeReadout(null),
      wrapup: wrapupReadout(null),
      series: null,
      rangeCaption: null,
      emptyLine: null,
      campaigns: const [],
      campaignsWorked: null,
    );
  }

  final lastInstant = stats.to.subtract(const Duration(milliseconds: 1));
  final series = bucketSeries(
    stats.buckets,
    firstDay: _wallDate(calendar, stats.from),
    lastDay: lastInstant.isBefore(stats.from) ? null : _wallDate(calendar, lastInstant),
    inProgress: window.inProgress,
  );

  return PerformanceView(
    tiles: headlineTrio(totals),
    conversion: conversionReadout(totals),
    handleTime: handleTimeReadout(totals),
    wrapup: wrapupReadout(totals),
    series: series,
    rangeCaption: windowRangeReadout(stats.from, stats.to, calendar: calendar),
    emptyLine: isEmptyRange(stats) ? emptyRangeLine(window.label) : null,
    campaigns: [
      for (final row in stats.byCampaign)
        CampaignRowView(
          campaignId: row.campaignId,
          name: campaignLabel(row.campaignId, campaignNames),
          dials: EnIn.count(row.attempts),
          connectRate: rowConnectRate(row),
          conversations: EnIn.count(row.connected),
          counted: EnIn.count(row.successes),
          onCalls: EnIn.statClock(row.talkSeconds),
        ),
    ],
    campaignsWorked: campaignsWorked(stats.totals.campaigns),
  );
}
