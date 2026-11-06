/// The customer-history search box's number rule: the raw text an agent
/// types (or pastes) and the country picked next to it, cleaned up to ONE
/// E.164 number, or refused with a reason that says what to do.
///
/// A hand-written port of `packages/domain/src/customer-search-number.ts`
/// (the console's live preview and the server's search run that original).
/// All three are held to one table,
/// `packages/contracts/fixtures/agent/customer-search-numbers.json`
/// (`test/customer_search_number_test.dart` runs every case of it here), so
/// the preview never promises a number the server does not search. The
/// server's answer is final: it echoes the number it searched.
///
/// Full numbers only (CH4): a number shorter than the country's national
/// length is refused with the "full number" message. Nothing here, or behind
/// it, searches by the ending of a number.
///
/// What it accepts, for the default country India (+91):
/// `98765 43210`, `9876543210`, `098765-43210`, `+91 98765 43210`,
/// `+919876543210`, `0091 98765 43210`, `91 9876543210` (the country code
/// without the `+`, only when the digits are too long for a national number
/// and the rest is a whole national number); and, as the soft phone does, a
/// bracketed trunk `(0)` directly after the country code is dropped:
/// `+44 (0)20 7946 0018` → `+442079460018`.
library;

import 'dart:math' as math;

import 'package:meta/meta.dart';

import 'enums.dart';

/// A country the picker offers.
///
/// Original: `SearchCountry`.
@immutable
final class SearchCountry {
  const SearchCountry({
    required this.iso,
    required this.name,
    required this.callingCode,
    required this.minNationalLength,
    required this.maxNationalLength,
    required this.numberLabel,
    required this.groups,
  });

  /// ISO 3166-1 alpha-2, as the search request's `country` carries it.
  final String iso;
  final String name;

  /// Digits only, no `+`.
  final String callingCode;

  /// The national significant number's length range.
  final int minNationalLength;
  final int maxNationalLength;

  /// How the "not valid" message names a number of this country.
  final String numberLabel;

  /// Digit groups for the formatted number, keyed by national length.
  final Map<int, List<int>> groups;

  @override
  bool operator ==(Object other) => other is SearchCountry && other.iso == iso;

  @override
  int get hashCode => iso.hashCode;

  @override
  String toString() => 'SearchCountry($iso)';
}

/// The countries the picker offers, in the picker's order. A number typed
/// with `+` and a calling code not listed here is still searched, held only
/// to E.164's own bounds.
///
/// Original: `SEARCH_COUNTRIES`.
const searchCountries = <SearchCountry>[
  SearchCountry(
    iso: 'IN',
    name: 'India',
    callingCode: '91',
    minNationalLength: 10,
    maxNationalLength: 10,
    numberLabel: 'Indian mobile number',
    groups: {
      10: [5, 5],
    },
  ),
  SearchCountry(
    iso: 'AE',
    name: 'United Arab Emirates',
    callingCode: '971',
    minNationalLength: 8,
    maxNationalLength: 9,
    numberLabel: 'UAE number',
    groups: {
      9: [2, 3, 4],
      8: [1, 3, 4],
    },
  ),
  SearchCountry(
    iso: 'AU',
    name: 'Australia',
    callingCode: '61',
    minNationalLength: 9,
    maxNationalLength: 9,
    numberLabel: 'Australian number',
    groups: {
      9: [3, 3, 3],
    },
  ),
  SearchCountry(
    iso: 'BD',
    name: 'Bangladesh',
    callingCode: '880',
    minNationalLength: 10,
    maxNationalLength: 10,
    numberLabel: 'Bangladeshi number',
    groups: {
      10: [4, 6],
    },
  ),
  SearchCountry(
    iso: 'GB',
    name: 'United Kingdom',
    callingCode: '44',
    minNationalLength: 9,
    maxNationalLength: 10,
    numberLabel: 'UK number',
    groups: {
      10: [2, 4, 4],
      9: [3, 3, 3],
    },
  ),
  SearchCountry(
    iso: 'LK',
    name: 'Sri Lanka',
    callingCode: '94',
    minNationalLength: 9,
    maxNationalLength: 9,
    numberLabel: 'Sri Lankan number',
    groups: {
      9: [2, 3, 4],
    },
  ),
  SearchCountry(
    iso: 'NP',
    name: 'Nepal',
    callingCode: '977',
    minNationalLength: 8,
    maxNationalLength: 10,
    numberLabel: 'Nepali number',
    groups: {
      10: [3, 7],
    },
  ),
  SearchCountry(
    iso: 'SA',
    name: 'Saudi Arabia',
    callingCode: '966',
    minNationalLength: 9,
    maxNationalLength: 9,
    numberLabel: 'Saudi number',
    groups: {
      9: [2, 3, 4],
    },
  ),
  SearchCountry(
    iso: 'SG',
    name: 'Singapore',
    callingCode: '65',
    minNationalLength: 8,
    maxNationalLength: 8,
    numberLabel: 'Singapore number',
    groups: {
      8: [4, 4],
    },
  ),
  SearchCountry(
    iso: 'US',
    name: 'United States / Canada',
    callingCode: '1',
    minNationalLength: 10,
    maxNationalLength: 10,
    numberLabel: 'US or Canadian number',
    groups: {
      10: [3, 3, 4],
    },
  ),
];

/// What [parseSearchNumber] answers.
///
/// Original: `SearchNumberResult`.
@immutable
sealed class SearchNumberResult {
  const SearchNumberResult();
}

/// The number to search.
@immutable
final class SearchNumberOk extends SearchNumberResult {
  const SearchNumberOk({required this.e164, required this.formatted, this.countryIso});

  /// The number searched, E.164 (`+919876543210`).
  final String e164;

  /// For display: `+91 98765 43210`.
  final String formatted;

  /// The country the number belongs to, when it is one the picker lists.
  final String? countryIso;

  @override
  bool operator ==(Object other) =>
      other is SearchNumberOk && other.e164 == e164 && other.formatted == formatted && other.countryIso == countryIso;

  @override
  int get hashCode => Object.hash(e164, formatted, countryIso);
}

/// The number cannot be searched; [message] says what to do.
@immutable
final class SearchNumberRefused extends SearchNumberResult {
  const SearchNumberRefused({required this.code, required this.message});

  final CustomerSearchNumberError code;
  final String message;

  @override
  bool operator ==(Object other) => other is SearchNumberRefused && other.code == code && other.message == message;

  @override
  int get hashCode => Object.hash(code, message);
}

/// E.164's own bounds for a calling code the table does not list.
const _unknownMinDigits = 8;
const _unknownMaxDigits = 15;

/// Excel's scientific notation for a long number: `9.18765E+11`, `9.19876E11`.
final _spreadsheet = RegExp(r'^\+?\d+(\.\d+)?e\+?\d+$', caseSensitive: false);

/// Digits, spaces, `+`, dashes, brackets; dots are tolerated as separators.
final _allowed = RegExp(r'^[\d\s+\-().]+$');

/// A bracketed trunk `(0)` directly after `+cc` or `00cc`, as the soft phone drops it.
final _trunkAfterCountryCode = RegExp(r'^(\s*(?:\+|00)\s*\d{1,3})\s*\(\s*0\s*\)');

final _whitespace = RegExp(r'\s');
final _nonDigit = RegExp(r'\D');
final _leadingZeros = RegExp(r'^0+');
final _leadingPlus = RegExp(r'^\+');

/// The listed country whose calling code is [callingCode] (`91` or `+91`).
SearchCountry? searchCountryForCallingCode(String callingCode) {
  final cc = callingCode.replaceFirst(_leadingPlus, '');
  for (final c in searchCountries) {
    if (c.callingCode == cc) return c;
  }
  return null;
}

/// The listed country with this ISO code, in any letter case.
SearchCountry? searchCountryByIso(String iso) {
  final upper = iso.toUpperCase();
  for (final c in searchCountries) {
    if (c.iso == upper) return c;
  }
  return null;
}

/// The message shown for a refusal: the console's and the server's words
/// (`searchNumberErrorMessage`). British English.
String searchNumberErrorMessage(CustomerSearchNumberError code, SearchCountry? country) => switch (code) {
  CustomerSearchNumberError.empty => 'Type a phone number to search.',
  CustomerSearchNumberError.invalidCharacters => 'Only digits, spaces, +, dashes and brackets are allowed.',
  CustomerSearchNumberError.spreadsheetNumber =>
    'This looks like a number Excel shortened. Copy it from the cell as text.',
  CustomerSearchNumberError.tooShort => "Enter the full number. Searching by the last few digits isn't supported.",
  CustomerSearchNumberError.invalidForCountry =>
    "This doesn't look like a valid ${country == null ? 'phone number' : country.numberLabel}. "
        'Check the digits, or pick another country.',
  // Only a code the server adds later lands here; the server's own message is shown then.
  CustomerSearchNumberError.unknown => "This number can't be searched. Check the digits and try again.",
};

SearchNumberRefused _refuse(CustomerSearchNumberError code, SearchCountry? country) =>
    SearchNumberRefused(code: code, message: searchNumberErrorMessage(code, country));

/// The listed country whose calling code begins these international digits
/// (the longest code wins).
SearchCountry? _countryOfInternational(String digits) {
  SearchCountry? best;
  for (final c in searchCountries) {
    if (digits.startsWith(c.callingCode) && (best == null || c.callingCode.length > best.callingCode.length)) {
      best = c;
    }
  }
  return best;
}

/// `+91 98765 43210`: the calling code, then the national number in the
/// country's groups. A number of no listed country is returned unchanged.
String formatSearchNumber(String e164) {
  final digits = e164.replaceFirst(_leadingPlus, '');
  final country = _countryOfInternational(digits);
  if (country == null) return e164;
  final national = digits.substring(country.callingCode.length);
  final groups = country.groups[national.length];
  if (groups == null) return '+${country.callingCode} $national';
  final parts = <String>[];
  var at = 0;
  for (final g in groups) {
    // Clamped like JavaScript's `slice`.
    final start = math.min(at, national.length);
    final end = math.min(at + g, national.length);
    parts.add(national.substring(start, end));
    at += g;
  }
  return '+${country.callingCode} ${parts.join(' ')}';
}

/// Holds international digits (calling code first, no `+`) to the country's rule.
SearchNumberResult _checkInternational(String digits) {
  final country = _countryOfInternational(digits);
  if (country == null) {
    if (digits.length < _unknownMinDigits) return _refuse(CustomerSearchNumberError.tooShort, null);
    if (digits.length > _unknownMaxDigits || digits.startsWith('0')) {
      return _refuse(CustomerSearchNumberError.invalidForCountry, null);
    }
    return SearchNumberOk(e164: '+$digits', formatted: '+$digits');
  }
  final national = digits.substring(country.callingCode.length);
  if (national.length < country.minNationalLength) return _refuse(CustomerSearchNumberError.tooShort, country);
  if (national.length > country.maxNationalLength || national.startsWith('0')) {
    return _refuse(CustomerSearchNumberError.invalidForCountry, country);
  }
  final e164 = '+$digits';
  return SearchNumberOk(e164: e164, formatted: formatSearchNumber(e164), countryIso: country.iso);
}

/// The picked country: the ISO code when the picker lists it, else the
/// country of the platform's default calling code, else India.
SearchCountry resolveSearchCountry(String? iso, String defaultCallingCode) =>
    (iso != null && iso.isNotEmpty ? searchCountryByIso(iso) : null) ??
    searchCountryForCallingCode(defaultCallingCode) ??
    searchCountries.first;

/// The raw search text and the picked country, as one E.164 number or a refusal.
SearchNumberResult parseSearchNumber(String raw, SearchCountry country) {
  final text = raw.trim();
  if (text.isEmpty) return _refuse(CustomerSearchNumberError.empty, country);
  if (_spreadsheet.hasMatch(text.replaceAll(_whitespace, ''))) {
    return _refuse(CustomerSearchNumberError.spreadsheetNumber, country);
  }
  if (!_allowed.hasMatch(text)) return _refuse(CustomerSearchNumberError.invalidCharacters, country);
  // A `+` only as the very first character.
  if (text.indexOf('+', 1) != -1) return _refuse(CustomerSearchNumberError.invalidCharacters, country);

  final withoutTrunk = text.replaceFirstMapped(_trunkAfterCountryCode, (m) => '${m[1]} ');
  final digits = withoutTrunk.replaceAll(_nonDigit, '');
  if (digits.isEmpty) return _refuse(CustomerSearchNumberError.empty, country);

  if (text.startsWith('+')) return _checkInternational(digits);
  if (digits.startsWith('00')) return _checkInternational(digits.substring(2));

  // National: a leading trunk 0 dropped.
  final national = digits.replaceFirst(_leadingZeros, '');
  if (national.isEmpty) return _refuse(CustomerSearchNumberError.tooShort, country);
  // The country code typed without `+`: only when the digits are too long to
  // be a national number and what follows the code is a whole national
  // number (`91 9876543210`).
  final afterCode = national.length - country.callingCode.length;
  if (national.length > country.maxNationalLength &&
      national.startsWith(country.callingCode) &&
      afterCode >= country.minNationalLength &&
      afterCode <= country.maxNationalLength) {
    return _checkInternational(national);
  }
  if (national.length < country.minNationalLength) return _refuse(CustomerSearchNumberError.tooShort, country);
  if (national.length > country.maxNationalLength) {
    return _refuse(CustomerSearchNumberError.invalidForCountry, country);
  }
  return _checkInternational('${country.callingCode}$national');
}
