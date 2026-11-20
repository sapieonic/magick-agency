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

/// `15:00` when [t] falls on [now]'s day (both in the device's zone), else
/// `4 Nov · 10:30`: when a contact is next due, read at a glance.
String formatDueAt(DateTime t, DateTime now) {
  final l = t.toLocal();
  final n = now.toLocal();
  return l.year == n.year && l.month == n.month && l.day == n.day ? formatTime(l) : formatDayTime(l);
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

// ── The redesign's forms (design-spec §6.6): "3:00 PM", "20 Nov", "Fri 20 Nov", "1h 52m" ──

/// `3:00 PM` in the device's zone.
String formatTime12(DateTime t) {
  final l = t.toLocal();
  final h = l.hour % 12 == 0 ? 12 : l.hour % 12;
  return '$h:${_two(l.minute)} ${l.hour < 12 ? 'AM' : 'PM'}';
}

/// `20 Nov`.
String formatDay(DateTime t) {
  final l = t.toLocal();
  return '${l.day} ${_months[l.month - 1]}';
}

/// `Fri 20 Nov`.
String formatWeekdayDay(DateTime t) {
  final l = t.toLocal();
  return '${_weekdays[l.weekday - 1]} ${formatDay(l)}';
}

/// `Fri 20 Nov at 10:00 AM`.
String formatWhen(DateTime t) => '${formatWeekdayDay(t)} at ${formatTime12(t)}';

/// `1h 52m`, `52m`, `0m`: talk time and long stretches, at a glance.
String formatHoursMinutes(Duration d) {
  final total = d.isNegative ? 0 : d.inMinutes;
  final h = total ~/ 60;
  final m = total % 60;
  return h > 0 ? '${h}h ${m}m' : '${m}m';
}

/// `98••• ••321`: the customer's number as a campaign that masks it shows it (AS9). The first two
/// and the last three digits of the national number; the rest hidden. Display only.
String maskPhone(String e164) {
  final indian = RegExp(r'^\+91(\d{10})$').firstMatch(e164);
  final digits = indian?.group(1) ?? e164.replaceAll(RegExp(r'\D'), '');
  if (digits.length < 7) return '•••';
  return '${digits.substring(0, 2)}••• ••${digits.substring(digits.length - 3)}';
}

/// The number as the station shows it: masked when the campaign says so ([masked]), else
/// `+91 98400 12345`.
String stationPhone(String e164, {required bool masked}) => masked ? maskPhone(e164) : formatPhone(e164);

/// `₹12,500`, `₹1,25,000.50`: a money fact's parsed value (a decimal string) with the rupee sign
/// and Indian grouping, no decimals unless they are not zero (design-spec §6.6); [decimal] as it
/// is when it is not a plain number.
String formatRupees(String decimal) {
  final m = RegExp(r'^(\d+)(?:\.(\d{1,2}))?$').firstMatch(decimal.trim());
  if (m == null) return decimal;
  final whole = m.group(1)!.replaceFirst(RegExp(r'^0+(?=\d)'), '');
  final frac = (m.group(2) ?? '').padRight(2, '0');
  String grouped;
  if (whole.length <= 3) {
    grouped = whole;
  } else {
    final last3 = whole.substring(whole.length - 3);
    var rest = whole.substring(0, whole.length - 3);
    final parts = <String>[];
    while (rest.length > 2) {
      parts.insert(0, rest.substring(rest.length - 2));
      rest = rest.substring(0, rest.length - 2);
    }
    if (rest.isNotEmpty) parts.insert(0, rest);
    grouped = '${parts.join(',')},$last3';
  }
  return frac == '00' ? '₹$grouped' : '₹$grouped.$frac';
}

/// `20 Nov` from a date fact's parsed `YYYY-MM-DD`; [ymd] as it is otherwise.
String formatFactDate(String ymd) {
  final m = RegExp(r'^(\d{4})-(\d{2})-(\d{2})$').firstMatch(ymd);
  if (m == null) return ymd;
  final month = int.parse(m.group(2)!);
  if (month < 1 || month > 12) return ymd;
  return '${int.parse(m.group(3)!)} ${_months[month - 1]}';
}
