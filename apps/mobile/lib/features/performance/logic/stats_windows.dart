import 'package:meta/meta.dart';

import 'en_in_format.dart';

/// The agent stats windows, matching the console's `agentWindows.ts`: the
/// three to-date periods plus the two completed ones, cut on the READER's
/// calendar, weeks starting Monday.
///
/// A window is identified by its NAME, never by its range: on a Monday
/// `today` and `week` are the same range, and anything keyed on `from` would
/// collapse them (the console's own documented defect). The result cache is
/// keyed on [StatsWindow] for that reason.
enum StatsWindow {
  today('Today'),
  week('This week'),
  lastWeek('Last week'),
  month('This month'),
  lastMonth('Last month');

  const StatsWindow(this.label);

  /// In the product's voice (`AGENT_STATS_WINDOW_LABELS`).
  final String label;

  /// To-date windows end at `now` and are still filling up.
  bool get inProgress => this == today || this == week || this == month;
}

/// The three offered as segments; the completed two live in a menu.
const primaryWindows = [StatsWindow.today, StatsWindow.week, StatsWindow.month];
const secondaryWindows = [StatsWindow.lastWeek, StatsWindow.lastMonth];

/// `[from, to)`: `to` is EXCLUSIVE, as on every one of these reads.
@immutable
class StatsRange {
  const StatsRange(this.from, this.to);

  final DateTime from;
  final DateTime to;

  @override
  bool operator ==(Object other) => other is StatsRange && other.from == from && other.to == to;

  @override
  int get hashCode => Object.hash(from, to);

  @override
  String toString() => 'StatsRange(${from.toUtc().toIso8601String()}, ${to.toUtc().toIso8601String()})';
}

/// The reader's calendar: how an instant reads on their wall clock and which
/// instant a wall-clock midnight is.
///
/// An interface rather than bare `DateTime(y, m, d)` so the window math can
/// be tested in zones other than the test machine's (Dart cannot switch the
/// process zone at run time). The app uses [DeviceCalendar].
abstract interface class LocalCalendar {
  /// The wall-clock fields of [instant] in this zone, as a UTC-flagged
  /// `DateTime` whose fields ARE the wall clock (only the fields are read).
  DateTime wall(DateTime instant);

  /// The instant of local midnight starting day `y-m-d`. Out-of-range days
  /// and months roll over, as `DateTime`'s constructor does.
  DateTime midnight(int year, int month, int day);

  /// How the zone is named in a caption (the console names the IANA zone;
  /// Dart has no tz database, so this is the platform name and offset).
  String zoneLabel(DateTime instant);
}

/// The device's own zone, as `date-fns` uses the browser's.
class DeviceCalendar implements LocalCalendar {
  const DeviceCalendar();

  @override
  DateTime wall(DateTime instant) {
    final l = instant.toLocal();
    return DateTime.utc(l.year, l.month, l.day, l.hour, l.minute, l.second, l.millisecond);
  }

  @override
  DateTime midnight(int year, int month, int day) => DateTime(year, month, day);

  @override
  String zoneLabel(DateTime instant) {
    final l = instant.toLocal();
    final offset = formatUtcOffset(l.timeZoneOffset);
    final name = l.timeZoneName;
    // Some platforms already name the zone by its offset ("GMT+05:30").
    if (name.isEmpty || name.contains('+') || name.contains('-') || name == 'UTC' || name == 'GMT') {
      return offset;
    }
    return '$name ($offset)';
  }
}

/// A zone with a fixed UTC offset; used by tests to pin the window math
/// outside UTC, both east and west of Greenwich.
class FixedOffsetCalendar implements LocalCalendar {
  const FixedOffsetCalendar(this.offset, [this.name]);

  final Duration offset;
  final String? name;

  @override
  DateTime wall(DateTime instant) => instant.toUtc().add(offset);

  @override
  DateTime midnight(int year, int month, int day) => DateTime.utc(year, month, day).subtract(offset);

  @override
  String zoneLabel(DateTime instant) =>
      name == null ? formatUtcOffset(offset) : '$name (${formatUtcOffset(offset)})';
}

/// `UTC+05:30`, `UTC-05:00`, `UTC`.
String formatUtcOffset(Duration offset) {
  if (offset == Duration.zero) return 'UTC';
  final sign = offset.isNegative ? '-' : '+';
  final minutes = offset.inMinutes.abs();
  final hh = (minutes ~/ 60).toString().padLeft(2, '0');
  final mm = (minutes % 60).toString().padLeft(2, '0');
  return 'UTC$sign$hh:$mm';
}

/// The range for [window], anchored on [now] and the reader's [calendar]
/// (`windowRange` + `periodRange`).
///
/// * to-date windows end at `now`;
/// * `lastWeek` / `lastMonth` END where the current period starts, so they
///   tile perfectly with their to-date siblings (no `endOf*`, whose last
///   millisecond a half-open range would drop).
///
/// Callers read `now` ONCE and pass it to every range they build, so a dial
/// on a boundary is in exactly one window.
StatsRange windowRange(StatsWindow window, DateTime now, {LocalCalendar calendar = const DeviceCalendar()}) {
  final w = calendar.wall(now);
  final today = calendar.midnight(w.year, w.month, w.day);
  // ISO weekday: Monday = 1. An agency week is a working week.
  final mondayDay = w.day - (w.weekday - DateTime.monday);
  final thisWeek = calendar.midnight(w.year, w.month, mondayDay);
  final thisMonth = calendar.midnight(w.year, w.month, 1);
  return switch (window) {
    StatsWindow.today => StatsRange(today, now),
    StatsWindow.week => StatsRange(thisWeek, now),
    StatsWindow.month => StatsRange(thisMonth, now),
    StatsWindow.lastWeek => StatsRange(calendar.midnight(w.year, w.month, mondayDay - 7), thisWeek),
    StatsWindow.lastMonth => StatsRange(calendar.midnight(w.year, w.month - 1, 1), thisMonth),
  };
}

/// The dates and zone the figures were measured over (`windowRangeReadout`):
/// `16 Oct 2026 · IST (UTC+05:30)` or `12 Oct – 18 Oct 2026 · …`, with both
/// years only when they differ. `to` is exclusive, so the last day shown is
/// the instant before it. Null for an empty or inverted range.
String? windowRangeReadout(DateTime from, DateTime to, {LocalCalendar calendar = const DeviceCalendar()}) {
  final end = to.subtract(const Duration(milliseconds: 1));
  if (end.isBefore(from)) return null;
  final s = calendar.wall(from);
  final e = calendar.wall(end);
  final zone = calendar.zoneLabel(end);
  final sameDay = s.year == e.year && s.month == e.month && s.day == e.day;
  if (sameDay) return '${EnIn.dayMonth(s)} ${e.year} · $zone';
  final startLabel = s.year == e.year ? EnIn.dayMonth(s) : '${EnIn.dayMonth(s)} ${s.year}';
  return '$startLabel – ${EnIn.dayMonth(e)} ${e.year} · $zone';
}

/// How far back these figures reach (`AGENT_HISTORY_REACH_NOTE`).
const historyReachNote =
    'These are the windows we show — the furthest back is last month. To find older calls, open My calls and pick the days you want.';
