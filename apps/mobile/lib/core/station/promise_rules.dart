/// Promise to pay (decisions PT1–PT14): the app's port of the shared rules
/// (`packages/domain/src/promise-to-pay.ts`) and of how a promise is printed
/// (the console's `utils/format/promise.ts`). The server is the authority; the
/// app checks first so an agent is never left pressing a Save that will fail.
library;

/// How far ahead a promised date may be (`AGENCY_PROMISE_MAX_DAYS_AHEAD`).
const promiseMaxDaysAhead = 180;

/// Digits before the decimal point (`AGENCY_PROMISE_AMOUNT_MAX_INTEGER_DIGITS`).
const promiseAmountMaxIntegerDigits = 12;

const _months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

String _two(int n) => n.toString().padLeft(2, '0');

/// `YYYY-MM-DD` for a calendar day (only its year, month and day are read).
String promiseDayString(DateTime day) => '${day.year.toString().padLeft(4, '0')}-${_two(day.month)}-${_two(day.day)}';

/// A `YYYY-MM-DD` string as a real calendar date (a UTC midnight), or null.
/// `2026-02-30` is null, never rolled into March.
DateTime? parsePromiseDay(String? value) {
  if (value == null) return null;
  final m = RegExp(r'^(\d{4})-(\d{2})-(\d{2})$').firstMatch(value);
  if (m == null) return null;
  final y = int.parse(m.group(1)!);
  final mo = int.parse(m.group(2)!);
  final d = int.parse(m.group(3)!);
  if (mo < 1 || mo > 12 || d < 1) return null;
  final t = DateTime.utc(y, mo, d);
  if (t.year != y || t.month != mo || t.day != d) return null;
  return t;
}

/// The client half of the date rule: within one day either side of the
/// agent's own today, because the server judges the CUSTOMER's today, which
/// the app is not given. A customer a day behind can still promise "today".
bool promiseDayAllowed(DateTime day, DateTime now) {
  final local = now.toLocal();
  final today = DateTime.utc(local.year, local.month, local.day);
  final target = DateTime.utc(day.year, day.month, day.day);
  final ahead = target.difference(today).inDays;
  return ahead >= -1 && ahead <= promiseMaxDaysAhead + 1;
}

/// The amount as its exact two-place decimal string (`12500` → `12500.00`),
/// or null when it is not one: negative, three places, a separator, letters.
/// Never parsed through a double.
String? normalisePromiseAmount(String raw) {
  final m = RegExp(r'^(\d{1,' '$promiseAmountMaxIntegerDigits' r'})(?:\.(\d{1,2}))?$').firstMatch(raw.trim());
  if (m == null) return null;
  final whole = m.group(1)!.replaceFirst(RegExp(r'^0+(?=\d)'), '');
  final frac = (m.group(2) ?? '').padRight(2, '0');
  return '$whole.$frac';
}

/// `18 Nov 2026` for a `YYYY-MM-DD` string; the raw value otherwise.
String formatPromiseDate(String date) {
  final d = parsePromiseDay(date);
  if (d == null) return date;
  return '${d.day} ${_months[d.month - 1]} ${d.year}';
}

/// `12,500` / `1,25,000` / `12,500.50`: grouped the Indian way (`en-IN`, the
/// console's locale), with no currency symbol (none is configured), from the
/// digits themselves.
String formatPromiseAmount(String amount) {
  final m = RegExp(r'^(\d+)(?:\.(\d{1,2}))?$').firstMatch(amount.trim());
  if (m == null) return amount;
  final whole = m.group(1)!;
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
  return frac == '00' ? grouped : '$grouped.$frac';
}

/// `Promised 18 Nov 2026 · 12,500`, or without the amount.
String formatPromise(String date, String? amount) {
  final head = 'Promised ${formatPromiseDate(date)}';
  return amount == null || amount.trim().isEmpty ? head : '$head · ${formatPromiseAmount(amount)}';
}
