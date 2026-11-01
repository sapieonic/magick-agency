/// Formatting for the station: clocks, dates and phone numbers.
///
/// Hand-rolled rather than `DateFormat` so the output never depends on which
/// intl locale data happens to be loaded (the station must render the same
/// text in a test, on a fresh install and after a locale change).
library;

const _months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const _weekdays = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

String _two(int n) => n.toString().padLeft(2, '0');

/// A running clock: `01:42`, `12:05`, `1:02:09`. Negative durations read as
/// zero, so a skewed clock never shows `-00:01`.
String formatClock(Duration d, {bool padMinutes = true}) {
  final total = d.isNegative ? 0 : d.inSeconds;
  final h = total ~/ 3600;
  final m = (total % 3600) ~/ 60;
  final s = total % 60;
  if (h > 0) return '$h:${_two(m)}:${_two(s)}';
  return '${padMinutes ? _two(m) : m}:${_two(s)}';
}

/// Seconds left until [until], rounded up and never negative: "3, 2, 1, 0",
/// not "2.4" and never "-1".
int secondsLeft(DateTime until, DateTime now) {
  final ms = until.difference(now).inMilliseconds;
  if (ms <= 0) return 0;
  return (ms + 999) ~/ 1000;
}

/// `18:05` in the device's zone.
String formatTime(DateTime t) {
  final l = t.toLocal();
  return '${_two(l.hour)}:${_two(l.minute)}';
}

/// `28 Oct · 18:05`.
String formatDayTime(DateTime t) {
  final l = t.toLocal();
  return '${l.day} ${_months[l.month - 1]} · ${formatTime(l)}';
}

/// `Mon, 3 Nov, 10:00 IST`: the callback the agent chose, with the zone named
/// so nobody promises a time they silently converted.
String formatCallback(DateTime t) {
  final l = t.toLocal();
  final zone = l.timeZoneName;
  return '${_weekdays[l.weekday - 1]}, ${l.day} ${_months[l.month - 1]}, ${formatTime(l)}${zone.isEmpty ? '' : ' $zone'}';
}

/// `+91 98400 12345` for Indian mobiles; anything else as given. Display only:
/// the E.164 value is what goes to the server.
String formatPhone(String e164) {
  final m = RegExp(r'^\+91(\d{5})(\d{5})$').firstMatch(e164);
  if (m != null) return '+91 ${m.group(1)} ${m.group(2)}';
  return e164;
}
