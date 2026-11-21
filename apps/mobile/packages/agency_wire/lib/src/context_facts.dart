// A roster value read as money, a date, a number, a phone number or a yes /
// no: a port of `packages/domain/src/context-facts.ts`, the one parse rule
// behind `AgencyFactTile.value`. The server parses the panel's tiles itself;
// the app needs it only where it builds a card from a contact's columns (the
// inbound and soft-phone cards, `chosenFactTiles`). Held to the shared cases in
// `packages/contracts/fixtures/agent/fact-rules.json` (`parse`), which the
// TypeScript original runs too. When in doubt: null, and the client shows the
// raw text.

import 'agent_station.dart' show ContextFieldType;

/// The longest value read at all; anything longer is not a single amount or date.
const _maxFactChars = 64;

/// Every kind of space a spreadsheet export puts in a value (no-break, narrow no-break, thin).
final _spaces = RegExp('[\\s   ]+');

final _moneyPrefix = RegExp(r'^(?:₹|rs\.?|inr)\s*', caseSensitive: false);
final _moneySuffix = RegExp(r'\s*(?:/-|inr|only|₹)$', caseSensitive: false);

/// Indian grouping (`1,25,000`), western grouping (`125,000`), or none (`125000`).
final _moneyInteger = RegExp(r'^(?:\d{1,2}(?:,\d{2})*,\d{3}|\d{1,3}(?:,\d{3})+|\d+)$');
final _leadingZeros = RegExp(r'^0+(?=\d)');

/// [raw] with every kind of space one space, trimmed; null when empty or too long.
String? _clean(String raw) {
  final text = raw.replaceAll(_spaces, ' ').trim();
  return text.isEmpty || text.length > _maxFactChars ? null : text;
}

/// An amount's whole part and decimals as a plain decimal string, or null.
/// [decimalsRule] says how many decimals it may have.
String? _plainDecimal(String text, RegExp decimalsRule) {
  final parts = text.split('.');
  if (parts.length > 2) return null;
  final rawInteger = parts[0];
  final decimals = parts.length > 1 ? parts[1] : null;
  // A space may stand where a grouping comma would, and only there; never
  // spaces and commas in one amount.
  if (rawInteger.contains(' ') && rawInteger.contains(',')) return null;
  final integer = rawInteger.replaceAll(' ', ',');
  if (!_moneyInteger.hasMatch(integer)) return null;
  if (decimals != null && !decimalsRule.hasMatch(decimals)) return null;
  final digits = integer.replaceAll(',', '').replaceFirst(_leadingZeros, '');
  return decimals == null ? digits : '$digits.$decimals';
}

/// A money value as a plain decimal string (`"125000"`, `"12500.50"`), or
/// null when it cannot be read for certain. The domain's `parseMoneyFact`.
String? parseMoneyFact(String raw) {
  final cleaned = _clean(raw);
  if (cleaned == null) return null;
  var text = cleaned.replaceFirst(_moneyPrefix, '');
  // A suffix may come twice (`12,500/- only`); strip at most two.
  for (var i = 0; i < 2; i++) {
    text = text.replaceFirst(_moneySuffix, '');
  }
  return _plainDecimal(text.trim(), RegExp(r'^\d{1,2}$'));
}

const _months = [
  ('jan', 'january'),
  ('feb', 'february'),
  ('mar', 'march'),
  ('apr', 'april'),
  ('may', 'may'),
  ('jun', 'june'),
  ('jul', 'july'),
  ('aug', 'august'),
  ('sep', 'september'),
  ('oct', 'october'),
  ('nov', 'november'),
  ('dec', 'december'),
];

/// A month's number (1–12) from its name: the three-letter form, `Sept`, or the full name.
int? _monthNumber(String name) {
  final word = name.toLowerCase();
  for (var i = 0; i < _months.length; i++) {
    final (short, full) = _months[i];
    if (word == short || word == full || (short == 'sep' && word == 'sept')) return i + 1;
  }
  return null;
}

/// The year a date names: a four-digit one as written; a two-digit one the
/// century that puts the date nearest [now].
int _fullYear(String year, int month, int day, DateTime now) {
  if (year.length != 2) return int.parse(year);
  final yy = int.parse(year);
  final century = (now.toUtc().year ~/ 100) * 100;
  var best = century + yy;
  int? bestDistance;
  for (final candidate in [century - 100 + yy, century + yy, century + 100 + yy]) {
    final distance = (DateTime.utc(candidate, month, day).millisecondsSinceEpoch - now.millisecondsSinceEpoch).abs();
    if (bestDistance == null || distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}

/// `YYYY-MM-DD` when the calendar has that day, else null.
String? _calendarDay(int year, int month, int day) {
  if (year < 1900 || year > 2199 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  final date = DateTime.utc(year, month, day);
  if (date.year != year || date.month != month || date.day != day) return null;
  String two(int n) => n.toString().padLeft(2, '0');
  return '${year.toString().padLeft(4, '0')}-${two(month)}-${two(day)}';
}

/// A time of day after a date, with no zone.
const _timeOfDay = r'(?:[T ]\d{1,2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?(?:\s?[ap]\.?m\.?)?)?';

final _yearFirst = RegExp('^(\\d{4})[-/](\\d{1,2})[-/](\\d{1,2})$_timeOfDay\$', caseSensitive: false);
final _dayFirst = RegExp('^(\\d{1,2})[-/.](\\d{1,2})[-/.](\\d{4}|\\d{2})$_timeOfDay\$', caseSensitive: false);
final _dayFirstNamed = RegExp(
  r'^(\d{1,2})(?:st|nd|rd|th)?[\s\-/.,]+([a-z]{3,9})\.?[\s\-/.,]+(\d{4}|\d{2})$',
  caseSensitive: false,
);
final _namedFirst = RegExp(r'^([a-z]{3,9})\.?[\s\-]+(\d{1,2})(?:st|nd|rd|th)?,?[\s\-]+(\d{4})$', caseSensitive: false);

/// A date value as `YYYY-MM-DD`, or null when it cannot be read for certain.
/// Never month first with numbers. [now] (the clock by default) picks a
/// two-digit year's century. The domain's `parseDateFact`.
String? parseDateFact(String raw, {DateTime? now}) {
  final text = _clean(raw);
  if (text == null) return null;
  final at = now ?? DateTime.now();

  var m = _yearFirst.firstMatch(text);
  if (m != null) return _calendarDay(int.parse(m[1]!), int.parse(m[2]!), int.parse(m[3]!));

  m = _dayFirst.firstMatch(text);
  if (m != null) {
    final month = int.parse(m[2]!);
    final day = int.parse(m[1]!);
    return _calendarDay(_fullYear(m[3]!, month, day, at), month, day);
  }

  m = _dayFirstNamed.firstMatch(text);
  if (m != null) {
    final month = _monthNumber(m[2]!);
    final day = int.parse(m[1]!);
    return month == null ? null : _calendarDay(_fullYear(m[3]!, month, day, at), month, day);
  }

  m = _namedFirst.firstMatch(text);
  if (m != null) {
    final month = _monthNumber(m[1]!);
    return month == null ? null : _calendarDay(int.parse(m[3]!), month, int.parse(m[2]!));
  }
  return null;
}

/// A number value as a plain decimal string (`"125000"`, `"10.375"`), or
/// null. Money's grouping rule without a currency. The domain's
/// `parseNumberFact`.
String? parseNumberFact(String raw) {
  final text = _clean(raw);
  return text == null ? null : _plainDecimal(text, RegExp(r'^\d+$'));
}

const _phoneMinDigits = 6;
const _phoneMaxDigits = 15;
final _phoneBody = RegExp(r'^[\d\s\-()]+$');
final _notDigit = RegExp(r'\D');

/// A phone number as its digits, the leading `+` kept when present
/// (`"+919876543210"`), or null when it is not one. The domain's
/// `parsePhoneFact`.
String? parsePhoneFact(String raw) {
  final text = _clean(raw);
  if (text == null) return null;
  final plus = text.startsWith('+');
  final rest = plus ? text.substring(1) : text;
  if (!_phoneBody.hasMatch(rest)) return null;
  final digits = rest.replaceAll(_notDigit, '');
  if (digits.length < _phoneMinDigits || digits.length > _phoneMaxDigits) return null;
  return plus ? '+$digits' : digits;
}

const _yesWords = {'yes', 'y', 'true', '1', 'haan', 'ha'};
const _noWords = {'no', 'n', 'false', '0', 'nahi', 'nahin'};

/// A yes / no value as `"yes"` or `"no"`, or null. The domain's `parseYesNoFact`.
String? parseYesNoFact(String raw) {
  final word = raw.replaceAll(_spaces, ' ').trim().toLowerCase();
  if (_yesWords.contains(word)) return 'yes';
  if (_noWords.contains(word)) return 'no';
  return null;
}

/// [raw] read as its column's [type]; always null for text or a type this
/// build does not know (show [raw]). The domain's `parseContextFact`.
String? parseContextFact(String raw, ContextFieldType type, {DateTime? now}) => switch (type) {
  ContextFieldType.money => parseMoneyFact(raw),
  ContextFieldType.date => parseDateFact(raw, now: now),
  ContextFieldType.number => parseNumberFact(raw),
  ContextFieldType.phone => parsePhoneFact(raw),
  ContextFieldType.yesNo => parseYesNoFact(raw),
  ContextFieldType.text || ContextFieldType.unknown => null,
};
