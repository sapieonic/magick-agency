/// Promise to pay (decisions PT1–PT14): the app's port of the shared rules
/// (`packages/domain/src/promise-to-pay.ts`) and of how a promise is printed
/// (the console's `utils/format/promise.ts`). The server is the authority; the
/// app checks first so an agent is never left pressing a Save that will fail.
library;

/// How far ahead a promised date may be (`AGENCY_PROMISE_MAX_DAYS_AHEAD`).
/// Held to the contract's value by `promise_to_pay_test.dart`, which reads it
/// from `packages/contracts/src/agency/promise.ts`.
const promiseMaxDaysAhead = 30;

/// Digits before the decimal point (`AGENCY_PROMISE_AMOUNT_MAX_INTEGER_DIGITS`),
/// held to the contract the same way.
const promiseAmountMaxIntegerDigits = 12;

/// A promise refusal's `reason` (the station's action codes, the soft phone's
/// and inbound's `reason`, PT8 and PT13), in the console's words
/// (`utils/softphone/refusalCopy.ts`, `hooks/useInboundCall.ts`), as the pad
/// words its own checks.
const Map<String, String> promiseRefusalCopy = {
  'promise_required': promiseRequiredCopy,
  'invalid_promise_date': promiseDateRefusedCopy,
  'invalid_promise_amount': promiseAmountRefusedCopy,
  'promise_not_expected': promiseNotExpectedCopy,
  'promise_needs_contact': promiseNeedsContactCopy,
};

const promiseRequiredCopy = 'This outcome needs the date the customer promised to pay.';
const promiseDateRefusedCopy =
    'That promised date can’t be used: it is before the customer’s today or too far ahead. Pick another date.';
const promiseAmountRefusedCopy = 'Enter the amount as a number, with up to two decimal places and no commas.';
const promiseNotExpectedCopy =
    'This outcome doesn’t record a promise to pay. Pick the promise outcome, or clear the promised date.';
const promiseNeedsContactCopy =
    'A promise to pay can’t be saved on this call: the number isn’t an open contact on the campaign’s list. '
    'Pick another outcome and put the promise in the note.';

const _months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

String _two(int n) => n.toString().padLeft(2, '0');

/// `YYYY-MM-DD` for a calendar day (only its year, month and day are read).
String promiseDayString(DateTime day) => '${day.year.toString().padLeft(4, '0')}-${_two(day.month)}-${_two(day.day)}';

/// A `YYYY-MM-DD` string as a real calendar date (a UTC midnight), or null.
/// `2026-02-30` is null, never rolled into March; a year before 1970 is null,
/// as the domain module's `parsePromiseDate` has it.
DateTime? parsePromiseDay(String? value) {
  if (value == null) return null;
  final m = RegExp(r'^(\d{4})-(\d{2})-(\d{2})$').firstMatch(value);
  if (m == null) return null;
  final y = int.parse(m.group(1)!);
  final mo = int.parse(m.group(2)!);
  final d = int.parse(m.group(3)!);
  if (y < 1970 || mo < 1 || mo > 12 || d < 1) return null;
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

/// The date picker's range for the agent's [today]: exactly the days
/// [promiseDayAllowed] accepts, from the day before to [promiseMaxDaysAhead]
/// days ahead plus the one a customer ahead of the agent may still be on.
({DateTime first, DateTime last}) promisePickerBounds(DateTime today) => (
      first: DateTime(today.year, today.month, today.day - 1),
      last: DateTime(today.year, today.month, today.day + promiseMaxDaysAhead + 1),
    );

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
/// The Full chip's amount: a money fact's parsed value (a decimal string) as the agent would type
/// it, `12500` or `12500.50`; null when it is not a plain amount.
String? plainAmount(String decimal) {
  final m = RegExp(r'^(\d+)(?:\.(\d{1,2}))?$').firstMatch(decimal.trim());
  if (m == null) return null;
  final whole = m.group(1)!.replaceFirst(RegExp(r'^0+(?=\d)'), '');
  final frac = (m.group(2) ?? '').padRight(2, '0');
  return frac == '00' ? whole : '$whole.$frac';
}

/// The Half chip's amount: half of [decimal], to the paisa (rounded down), as the agent would type
/// it; null when it is not a plain amount. The console's `halfAmount`.
String? halfAmount(String decimal) {
  final plain = plainAmount(decimal);
  if (plain == null) return null;
  final parts = plain.split('.');
  final paise = BigInt.parse(parts[0]) * BigInt.from(100) + BigInt.parse(parts.length > 1 ? parts[1] : '0');
  final half = paise ~/ BigInt.two;
  final rupees = half ~/ BigInt.from(100);
  final rest = (half % BigInt.from(100)).toInt();
  return rest == 0 ? '$rupees' : '$rupees.${rest.toString().padLeft(2, '0')}';
}

String formatPromise(String date, String? amount) {
  final head = 'Promised ${formatPromiseDate(date)}';
  return amount == null || amount.trim().isEmpty ? head : '$head · ${formatPromiseAmount(amount)}';
}
