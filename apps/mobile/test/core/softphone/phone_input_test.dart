import 'package:flutter_test/flutter_test.dart';
import 'package:magick_agency_agent/core/softphone/phone_input.dart';

/// The console's `softphonePhoneInput.test.ts` tables.
void main() {
  group('normalisePastedNumber: what a paste drags in, cleaned', () {
    const table = {
      '+91 98204 61733': '+919820461733',
      '+91-98204-61733': '+919820461733',
      '(+91) 98204 61733': '+919820461733',
      'tel:+919820461733': '+919820461733',
      '0091 98204 61733': '+919820461733',
      '098204 61733': '+919820461733',
      '022 2659 4410': '+912226594410',
      '  +44 20 7946 0958 ': '+442079460958',
      // A bracketed trunk 0 after the country code is not part of the number.
      '+44 (0)20 7946 0018': '+442079460018',
      '+91 (0) 98204 61733': '+919820461733',
      '+44 20 (0)7946 0018': '+4420079460018',
    };
    table.forEach((raw, expected) {
      test('$raw → $expected', () => expect(normalisePastedNumber(raw, '+91'), expected));
    });

    test('leaves a bare national number for the server, which knows the account’s region', () {
      expect(normalisePastedNumber('98204 61733', '+91'), '9820461733');
    });

    test('reads the trunk 0 in the account’s own country code, with or without its +', () {
      expect(normalisePastedNumber('020 7946 0958', '44'), '+442079460958');
      expect(normalisePastedNumber('020 7946 0958', '+44'), '+442079460958');
    });

    test('keeps a plus only in first place', () {
      expect(normalisePastedNumber('+91+98204', '+91'), '+9198204');
    });

    test('reads a TEL: scheme in any case', () {
      expect(normalisePastedNumber('TEL:+919820461733', '+91'), '+919820461733');
    });
  });

  group('typing into the number', () {
    test('keeps digits, * and #, and a + only first', () {
      expect(sanitiseDialInput('98a20-4'), '98204');
      expect(sanitiseDialInput('1+2'), '12');
      expect(sanitiseDialInput('+12*#'), '+12*#');
    });

    test('caps the length rather than growing without bound', () {
      expect(sanitiseDialInput('1' * 40), hasLength(20));
    });

    test('appends a key, ignores anything that is not one, and only starts with +', () {
      expect(appendDialKey('98', '2'), '982');
      expect(appendDialKey('98', 'x'), '98');
      expect(appendDialKey('', '+'), '+');
      expect(appendDialKey('9', '+'), '9');
      expect(deleteLastDialChar('982'), '98');
      expect(deleteLastDialChar(''), '');
    });

    test('every pad key is a dial character, and 0 carries the +', () {
      for (final k in dialKeys) {
        expect(isDialChar(k), isTrue, reason: k);
      }
      expect(dialKeyLetters['0'], '+');
      expect(dialKeyLetters['7'], 'PQRS');
    });
  });

  group('dialBlockReason: when Call is refused before it is sent', () {
    test('names every reason', () {
      expect(dialBlockReason(''), DialBlockReason.empty);
      expect(dialBlockReason('12345'), DialBlockReason.tooShort);
      expect(dialBlockReason('+1234567890123456'), DialBlockReason.tooLong);
      expect(dialBlockReason('98204*61733'), DialBlockReason.notANumber);
      expect(dialBlockReason('9820461733'), isNull);
      expect(dialBlockReason('+919820461733'), isNull);
    });

    test('every reason has its sentence', () {
      for (final r in DialBlockReason.values) {
        expect(dialBlockCopy[r], isNotEmpty, reason: r.name);
      }
    });
  });

  group('formatDialNumber: display only (re-exported from call_labels)', () {
    test('groups an Indian mobile the way it is read aloud', () {
      expect(formatDialNumber('+919820461733'), '+91 98204 61733');
      expect(formatDialNumber('9820461733'), '98204 61733');
    });

    test('leaves what it cannot recognise unchanged', () {
      expect(formatDialNumber('+442079460958'), '+442079460958');
      expect(formatDialNumber(null), '');
    });
  });

  group('the trunk "(0)" written after a country code, on paste', () {
    const table = {
      '+44 (0)20 7946 0018': '+442079460018',
      '+91 (0) 98204 61733': '+919820461733',
      '+44(0)20 7946 0018': '+442079460018',
      '(+44) (0)20 7946 0018': '+442079460018',
      '0044 (0)20 7946 0018': '+442079460018',
    };
    table.forEach((raw, expected) {
      test('$raw → $expected', () => expect(normalisePastedNumber(raw, '+91'), expected));
    });

    test('leaves a bracketed area code alone: only a lone (0) is the trunk prefix', () {
      expect(normalisePastedNumber('+44 (020) 7946 0018', '+91'), '+4402079460018');
    });
  });

  group('normaliseTypedNumber: a typed number, read after the country-code chip', () {
    test('drops a typed trunk 0, so "098204 61733" reads +91 98204 61733 and not +91 0…', () {
      expect(normaliseTypedNumber(sanitiseDialInput('098204 61733')), '9820461733');
      expect(normaliseTypedNumber('022'), '22');
    });

    test('reads a typed 00 as the international prefix, as a paste does', () {
      expect(normaliseTypedNumber('0044'), '+44');
      expect(normaliseTypedNumber('00'), '+');
      expect(normalisePastedNumber('0044 20 7946 0958', '+91'), normaliseTypedNumber('00442079460958'));
    });

    test('keeps a lone 0 until the next key says which it is', () {
      expect(normaliseTypedNumber('0'), '0');
    });

    test('leaves everything else as typed', () {
      expect(normaliseTypedNumber('9820461733'), '9820461733');
      expect(normaliseTypedNumber('+919820461733'), '+919820461733');
      expect(normaliseTypedNumber('+44020'), '+44020');
      expect(normaliseTypedNumber(''), '');
    });

    test('applies key by key on the pad: 0, 9 → 9; 0, 0, 4, 4 → +44', () {
      expect(appendDialKey(appendDialKey('', '0'), '9'), '9');
      var value = '';
      for (final key in ['0', '0', '4', '4']) {
        value = appendDialKey(value, key);
      }
      expect(value, '+44');
    });
  });
}
