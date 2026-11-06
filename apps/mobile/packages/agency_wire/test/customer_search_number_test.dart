// The search box's number rule, held to the ONE table the console's preview
// and the server run too (packages/contracts/fixtures/agent/customer-search-numbers.json,
// run by packages/domain/test/unit/agency/customer-search-number.test.ts).
// A case added to the table runs here with no change to this file.

import 'package:agency_wire/agency_wire.dart';
import 'package:test/test.dart';

import 'support/fixtures.dart';

/// [c] in the table's shape (group keys are JSON strings there).
Map<String, Object?> countryAsJson(SearchCountry c) => {
  'iso': c.iso,
  'name': c.name,
  'callingCode': c.callingCode,
  'minNationalLength': c.minNationalLength,
  'maxNationalLength': c.maxNationalLength,
  'numberLabel': c.numberLabel,
  'groups': {for (final e in c.groups.entries) '${e.key}': e.value},
};

/// The country case [c] runs in: a listed ISO, or (`"country": null`) the
/// platform default its `defaultCallingCode` names, one the picker does not
/// list. A typo fails rather than falling back to a default.
SearchCountry caseCountry(Map<String, Object?> c) {
  final iso = c['country'] as String?;
  if (iso != null) {
    final listed = searchCountryByIso(iso);
    expect(listed, isNotNull, reason: '$iso is not a listed country');
    return listed!;
  }
  final code = c['defaultCallingCode']! as String;
  final own = platformDefaultSearchCountry(code);
  expect(own.unlisted, isTrue, reason: '$code is a listed calling code');
  return own;
}

void main() {
  final table = loadFixtureFile('customer-search-numbers.json');
  final countries = (table['countries']! as List<Object?>).cast<Map<String, Object?>>();
  final cases = (table['cases']! as List<Object?>).cast<Map<String, Object?>>();

  test('the Dart country list is the table\'s, in the picker\'s order', () {
    expect([for (final c in searchCountries) countryAsJson(c)], countries);
  });

  test('the table has cases for every refusal and every listed country', () {
    expect(cases, isNotEmpty);
    final refusals = {for (final c in cases) c['error']}..remove(null);
    expect(refusals, {
      for (final e in CustomerSearchNumberError.values)
        if (!e.isUnknown) e.wire,
    });
  });

  group('every case of the table', () {
    for (final (i, c) in cases.indexed) {
      final input = c['input']! as String;
      final where = c['country'] ?? c['defaultCallingCode'];
      test('#$i "$input" ($where)', () {
        final result = parseSearchNumber(input, caseCountry(c));
        if (c.containsKey('error')) {
          expect(result, isA<SearchNumberRefused>());
          final refused = result as SearchNumberRefused;
          expect(refused.code.wire, c['error']);
          expect(refused.message, c['message']);
        } else {
          expect(result, isA<SearchNumberOk>(), reason: result is SearchNumberRefused ? result.message : null);
          final ok = result as SearchNumberOk;
          expect(ok.e164, c['e164']);
          expect(ok.formatted, c['formatted']);
          expect(ok.countryIso, c['countryIso']);
          // The display form is the formatter's, so the echo and the preview agree.
          expect(formatSearchNumber(ok.e164), ok.formatted);
        }
      });
    }
  });

  group('resolveSearchCountry', () {
    test('a listed ISO code, in any case', () {
      expect(resolveSearchCountry('gb', '+91').iso, 'GB');
      expect(resolveSearchCountry('US', '91').iso, 'US');
    });

    test('no ISO code, or one the picker does not list: the platform default', () {
      expect(resolveSearchCountry(null, '+91').iso, 'IN');
      expect(resolveSearchCountry('', '+44').iso, 'GB');
      expect(resolveSearchCountry('ZZ', '+971').iso, 'AE');
    });

    test('an unlisted default calling code is a country of its own, never India', () {
      for (final code in ['27', '+27']) {
        final own = resolveSearchCountry(null, code);
        expect(own.unlisted, isTrue);
        expect(own.iso, '');
        expect(own.name, '+27');
        expect(own.callingCode, '27');
        expect(own.numberLabel, '+27 number');
        expect(own.groups, isEmpty);
      }
      expect(resolveSearchCountry('', '+27').callingCode, '27');
      // A picked listed country still wins.
      expect(resolveSearchCountry('IN', '+27').iso, 'IN');
      expect(resolveSearchCountry(null, '+91').unlisted, isFalse);
    });

    test('a default that is not a calling code at all: India', () {
      for (final code in ['', '+', '0', '044', '1234', 'abc']) {
        expect(resolveSearchCountry(null, code).iso, 'IN', reason: code);
      }
    });
  });

  test('the table has cases for an unlisted platform default', () {
    final unlisted = [for (final c in cases) if (c['country'] == null) c];
    expect(unlisted.where((c) => c.containsKey('e164')).length, greaterThanOrEqualTo(3));
    expect({for (final c in unlisted) c['error']}..remove(null), {'too_short', 'invalid_for_country'});
  });

  test('searchCountryOptions: the unlisted default first, then the listed countries', () {
    expect(searchCountryOptions('+91'), same(searchCountries));
    final options = searchCountryOptions('+27');
    expect([for (final c in options) c.name], ['+27', for (final c in searchCountries) c.name]);
    expect(options.first, platformDefaultSearchCountry('+27'));
  });

  test('an unlisted default: 7 to 15 digits in all, as the roster ingest checks E.164', () {
    final za = platformDefaultSearchCountry('+27');
    expect(parseSearchNumber('2712345', za), const SearchNumberOk(e164: '+2712345', formatted: '+2712345'));
    expect((parseSearchNumber('271234', za) as SearchNumberRefused).code, CustomerSearchNumberError.tooShort);
    expect(
      (parseSearchNumber('2782123456789012', za) as SearchNumberRefused).code,
      CustomerSearchNumberError.invalidForCountry,
    );
    expect(
      searchNumberErrorMessage(CustomerSearchNumberError.invalidForCountry, za),
      "This doesn't look like a valid +27 number. Check the digits, or pick another country.",
    );
  });

  test('the invalid-number message names the country, or a phone number', () {
    expect(
      searchNumberErrorMessage(CustomerSearchNumberError.invalidForCountry, searchCountryByIso('SG')),
      "This doesn't look like a valid Singapore number. Check the digits, or pick another country.",
    );
    expect(
      searchNumberErrorMessage(CustomerSearchNumberError.invalidForCountry, null),
      "This doesn't look like a valid phone number. Check the digits, or pick another country.",
    );
  });

  test('formatSearchNumber: no listed country unchanged; a length with no groups after the code', () {
    expect(formatSearchNumber('+99912345678'), '+99912345678');
    // UAE groups 8 and 9 digits; 7 has no groups.
    expect(formatSearchNumber('+9712345678'), '+971 2345678');
  });
}
