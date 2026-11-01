import 'dart:math' as math;

import 'package:agency_wire/agency_wire.dart';
import 'package:meta/meta.dart';

import 'en_in_format.dart';

/// The day-by-day series behind the chart, matching the console's
/// `buckets.ts` and `AgentBucketChart.tsx` (`niceCeiling`, the label
/// thinning, the single-bucket rule), plus the one thing the phone adds:
/// marking the bars that can be partial days.

/// Whether a bar covers a whole day.
enum BucketCoverage {
  whole,

  /// The first or last bar of a window: the window starts and ends on the
  /// reader's clock while each bar is cut on its campaign's, so the edge
  /// days can be partly outside the window.
  edge,

  /// The last day of a to-date window: still filling up.
  soFar,
}

@immutable
class SeriesPoint {
  const SeriesPoint({
    required this.start,
    required this.label,
    required this.title,
    required this.attempts,
    required this.connected,
    this.coverage = BucketCoverage.whole,
  });

  final CalendarDate start;

  /// Day of the month, for the axis.
  final String label;

  /// `16 Oct`, for the tap label and the accessible summary.
  final String title;
  final int attempts;
  final int connected;
  final BucketCoverage coverage;

  bool get partial => coverage != BucketCoverage.whole;

  @override
  bool operator ==(Object other) =>
      other is SeriesPoint &&
      other.start == start &&
      other.label == label &&
      other.title == title &&
      other.attempts == attempts &&
      other.connected == connected &&
      other.coverage == coverage;

  @override
  int get hashCode => Object.hash(start, label, title, attempts, connected, coverage);
}

@immutable
class BucketSeries {
  BucketSeries(List<SeriesPoint> points, {required this.max})
      : points = List.unmodifiable(points);

  final List<SeriesPoint> points;

  /// The tallest bar's value; at least 1, so nothing divides by zero.
  final int max;

  /// A one-bucket range is not a chart: a single column is a stat tile
  /// wearing axes, and the tiles already show it.
  bool get drawable => points.length >= 2;

  int get top => niceCeiling(max);

  bool get hasPartial => points.any((p) => p.partial);

  @override
  bool operator ==(Object other) => other is BucketSeries && other.max == max && _listEq(other.points, points);

  @override
  int get hashCode => Object.hash(max, Object.hashAll(points));
}

bool _listEq<T>(List<T> a, List<T> b) {
  if (a.length != b.length) return false;
  for (var i = 0; i < a.length; i++) {
    if (a[i] != b[i]) return false;
  }
  return true;
}

/// The axis label and title for a bucket day; a date that rolls over (e.g.
/// `2026-02-30`) is shown as sent rather than relabelled (`bucketLabels`).
({String label, String title}) bucketLabels(CalendarDate d) {
  final dt = DateTime.utc(d.year, d.month, d.day);
  if (dt.year != d.year || dt.month != d.month || dt.day != d.day) {
    final raw = d.toString();
    return (label: raw, title: raw);
  }
  return (label: '${d.day}', title: EnIn.dayMonth(dt));
}

/// The series in the server's order (never re-sorted: the bars must sum to
/// the totals, which is the one thing a reader can check them against).
///
/// [firstDay] and [lastDay] are the window's first and last days on the
/// READER's calendar; [inProgress] is whether the window ends at `now`. A bar
/// at or before the first day is an [BucketCoverage.edge]; a bar at or after
/// the last day is [BucketCoverage.soFar] in a to-date window and an edge in
/// a completed one. Bars in between are whole days. Without the two days
/// (tests, or a caller that cannot say) every bar is whole.
BucketSeries bucketSeries(
  List<AgentStatsBucket> buckets, {
  CalendarDate? firstDay,
  CalendarDate? lastDay,
  bool inProgress = false,
}) {
  var max = 0;
  final points = <SeriesPoint>[];
  for (final b in buckets) {
    final labels = bucketLabels(b.bucketStart);
    var coverage = BucketCoverage.whole;
    if (lastDay != null && b.bucketStart.compareTo(lastDay) >= 0) {
      coverage = inProgress ? BucketCoverage.soFar : BucketCoverage.edge;
    } else if (firstDay != null && b.bucketStart.compareTo(firstDay) <= 0) {
      coverage = BucketCoverage.edge;
    }
    points.add(SeriesPoint(
      start: b.bucketStart,
      label: labels.label,
      title: labels.title,
      attempts: b.attempts,
      connected: b.connected,
      coverage: coverage,
    ));
    max = math.max(max, math.max(b.attempts, b.connected));
  }
  return BucketSeries(points, max: math.max(max, 1));
}

/// The axis top, rounded up to a clean EVEN number, never below 2, on the
/// 1/2/3/4/5/6/8/10 ladder (`niceCeiling`): three labelled gridlines at 0,
/// half and top must each read as a whole number.
int niceCeiling(int max) {
  if (max <= 2) return 2;
  var magnitude = 1;
  while (magnitude * 10 <= max) {
    magnitude *= 10;
  }
  for (final step in const [1, 2, 3, 4, 5, 6, 8, 10]) {
    final candidate = step * magnitude;
    if (candidate >= max && (magnitude > 1 || candidate.isEven)) return candidate;
  }
  return 10 * magnitude;
}

/// Plot geometry for [count] groups in a plot [width] wide. Pure, so the
/// scaling is unit-tested without a canvas.
@immutable
class ChartLayout {
  factory ChartLayout({required double width, required int count}) {
    final band = count == 0 ? width : width / count;
    final bar = math.min(maxBar, math.max(2.0, (band - barGap) / 2 - 2));
    return ChartLayout._(width, count, band, bar);
  }

  const ChartLayout._(this.width, this.count, this.bandWidth, this.barWidth);

  /// The spec's ceiling: a wider band keeps its leftover as air.
  static const double maxBar = 24;

  /// The gap between the two touching bars of a group.
  static const double barGap = 2;

  /// Below this many logical pixels per label, labels thin out.
  static const double minLabelSpacing = 22;

  final double width;
  final int count;
  final double bandWidth;
  final double barWidth;

  double get groupWidth => barWidth * 2 + barGap;

  /// Left edge of group [i]'s first bar, relative to the plot's left.
  double groupStart(int i) => i * bandWidth + (bandWidth - groupWidth) / 2;

  /// Centre of group [i].
  double groupCentre(int i) => groupStart(i) + groupWidth / 2;

  /// The group under [dx] (plot-relative), clamped to the series.
  int indexAt(double dx) {
    if (count == 0) return -1;
    return (dx / bandWidth).floor().clamp(0, count - 1);
  }

  /// Every n-th day label is drawn, so labels never collide.
  int get labelEvery => math.max(1, (count * minLabelSpacing / math.max(width, 1)).ceil());

  /// A bar's height for [value] against [top] in a plot [height] tall.
  static double barHeight(int value, int top, double height) => top <= 0 ? 0 : value / top * height;
}

/// Under the chart (`BUCKET_TIMEZONE_NOTE`).
const bucketTimezoneNote =
    'Each day is counted in its own campaign’s local time. If you work campaigns in '
    'different time zones, two days here can overlap — the totals are still exact, '
    'because every call belongs to one day only.';

/// Instead of a chart for a one-day range (`SINGLE_BUCKET_NOTE`).
const singleBucketNote = 'A day-by-day chart needs more than one day. Switch to this week or this month to see one.';

/// Beside the faded bars.
const partialBucketNote =
    'Faded bars can be part-days: the first and last days of the period are cut on your clock, '
    'and today is still going.';

/// The accessible summary of the whole chart (the console's `<title>`).
String chartSummary(BucketSeries s) =>
    'Dials and conversations by day, ${s.points.length} days, up to ${EnIn.count(s.top)} calls a day.';

/// One group's label (the console's per-bar `<title>`), plus the part-day
/// note the phone adds.
String pointSummary(SeriesPoint p) {
  final base = '${p.title}: ${EnIn.count(p.attempts)} dials, ${EnIn.count(p.connected)} conversations';
  return switch (p.coverage) {
    BucketCoverage.whole => base,
    BucketCoverage.edge => '$base (may be a part-day)',
    BucketCoverage.soFar => '$base (still going)',
  };
}
