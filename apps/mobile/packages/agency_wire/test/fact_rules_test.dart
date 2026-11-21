// AS19 S5: the card's rules (the domain's, in Dart), against the shared cases
// (packages/contracts/fixtures/agent/fact-rules.json) the TypeScript
// originals run too (packages/domain/test/unit/agency/fact-rules.test.ts).
// Every case of every table but unique_fact_labels (the console's editor).

import 'dart:convert';

import 'package:agency_wire/agency_wire.dart';
import 'package:test/test.dart';

import 'support/fixtures.dart';

List<Map<String, Object?>> _cases(Object? table) => (table! as List<Object?>).cast<Map<String, Object?>>();

ContextDisplay? _display(Object? raw) => raw == null ? null : ContextDisplay.fromJson(raw as Map<String, Object?>);

List<String> _strings(Object? raw) => (raw! as List<Object?>).cast<String>();

String _title(Object? value) {
  final text = jsonEncode(value);
  return text.length > 110 ? '${text.substring(0, 107)}...' : text;
}

Object? _piece(ScriptPiece p) => switch (p) {
  ScriptText(:final text) => {'kind': 'text', 'text': text},
  ScriptKey(:final key) => {'kind': 'key', 'key': key},
  ScriptUnknown(:final token) => {'kind': 'unknown', 'token': token},
};

void main() {
  final rules = loadFixtureFile('fact-rules.json');

  group('the phone rule (R6, S3)', () {
    for (final c in _cases(rules['phone'])) {
      test(jsonEncode(c['value']), () {
        final value = c['value']! as String;
        expect(formatFactPhone(value), c['full']);
        expect(maskFactPhone(value), c['masked']);
      });
    }
  });

  group('the parse rule', () {
    final parse = rules['parse']! as Map<String, Object?>;
    final now = DateTime.parse(parse['now']! as String);
    for (final c in _cases(parse['cases'])) {
      test('${jsonEncode(c['raw'])} as ${c['type']}', () {
        final type = ContextFieldType.fromWire(c['type']! as String);
        expect(parseContextFact(c['raw']! as String, type, now: now), c['value']);
      });
    }
  });

  group('scriptPieces', () {
    for (final c in _cases(rules['script_pieces'])) {
      test(jsonEncode(c['text']), () {
        final pieces = scriptPieces(c['text']! as String, _strings(c['allowed']).toSet());
        expect(pieces.map(_piece).toList(), c['pieces']);
      });
    }
  });

  group('scriptPlaceholders (the domain\'s scriptPlaceholdersFor)', () {
    for (final c in _cases(rules['script_placeholders'])) {
      test(_title(c['display']), () {
        expect(_display(c['display'])!.scriptPlaceholders, c['placeholders']);
      });
    }
  });

  group('configuredHeroes (the domain\'s configuredHeroNames)', () {
    for (final c in _cases(rules['configured_heroes'])) {
      test(_title(c['display']), () {
        final display = _display(c['display']);
        expect(configuredHeroNames(display), c['heroes']);
        expect(display?.configuredHeroes ?? const <String>[], c['heroes']);
      });
    }
  });

  group('heroColumnsFor', () {
    for (final c in _cases(rules['hero_columns'])) {
      test(_title([c['context'], c['display']]), () {
        final heroes = heroColumnsFor(
          c['context']! as Map<String, Object?>,
          _display(c['display']),
          columnOrder: c['column_order'] == null ? null : _strings(c['column_order']),
          max: c['max'] as int?,
          fallbackToFirstColumns: c['fallback_to_first_columns'] as bool? ?? true,
        );
        expect(heroes, c['heroes']);
      });
    }

    test('the caps: the legacy four, and the name plus every fact (R2)', () {
      expect(maxHeroFields, factFieldsMax);
      expect(heroCapFor(ContextDisplay.fromJson({'facts': <Object?>[]})), 1 + factFieldsMax);
      expect(heroCapFor(null), maxHeroFields);
    });
  });

  group('the name and place guess (S1)', () {
    test('the lists are the domain\'s', () {
      expect(nameGuessColumns, ['name', 'full_name', 'customer_name', 'first_name']);
      expect(placeGuessColumns, ['city', 'town', 'place', 'location', 'district', 'village']);
    });
    for (final c in _cases(rules['guess_columns'])) {
      test(_title(c), () {
        final Object source = c['columns'] == null ? c['row']! as Map<String, Object?> : _strings(c['columns']);
        final hidden = c['hidden'] == null ? const <String>[] : _strings(c['hidden']);
        final exclude = c['exclude'] == null ? const <String>[] : _strings(c['exclude']);
        expect(guessNameColumn(source, hidden: hidden, exclude: exclude), c['name']);
        expect(guessPlaceColumn(source, hidden: hidden, exclude: exclude), c['place']);
      });
    }
  });

  group('customerNameFrom and the place (S1, S2)', () {
    for (final c in _cases(rules['customer'])) {
      test(_title([c['context'], c['display']]), () {
        final context = c['context']! as Map<String, Object?>;
        final display = _display(c['display']);
        expect(customerNameFrom(context, display), c['name']);
        expect(customerNameColumn(context, display), c['name_column']);
        expect(customerPlaceFrom(context, display), c['place']);
        expect(customerPlaceColumn(context, display), c['place_column']);
      });
    }
  });

  group('chosenFactTiles (S6)', () {
    for (final c in _cases(rules['chosen_fact_tiles'])) {
      test(_title(c['display']), () {
        final tiles = chosenFactTiles(
          c['context']! as Map<String, Object?>,
          _display(c['display']),
          now: DateTime.parse(c['now']! as String),
        );
        final expected = _cases(c['tiles']).map(FactTile.fromJson).toList();
        expect(tiles, expected);
      });
    }
  });
}
