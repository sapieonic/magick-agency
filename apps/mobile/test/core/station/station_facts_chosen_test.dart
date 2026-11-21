import 'package:agency_wire/agency_wire.dart' as wire;
import 'package:fake_async/fake_async.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:magick_agency_agent/core/station/contact_context.dart';
import 'package:magick_agency_agent/core/station/station_view.dart';
import 'package:magick_agency_agent/core/station/station_view_mapper.dart';

import '../inbound/inbound_fixtures.dart' show contractSample;
import 'controller_harness.dart';

/// AS19 through the real station core: the campaign's chosen facts (`session.json`
/// `bootstrap_facts_chosen`, `station.json` `reserved_facts_chosen`) reach the view with their
/// names, keys, highlight and types; the script's keys are the campaign's; a column read as a phone
/// number is hidden in Details too when the campaign hides numbers.
void main() {
  Map<String, Object?> bootstrap() => {
        ...contractSample('session.json', 'bootstrap_facts_chosen'),
        'session_id': 'sess-1',
        'campaign_id': 'camp-1',
        'station_ws_url': '/proxy/agency/station?token=boot',
      };

  Map<String, Object?> reserved() {
    final frame = contractSample('station.json', 'reserved_facts_chosen');
    (frame['attempt']! as Map<String, Object?>)['campaign_id'] = 'camp-1';
    return frame;
  }

  test('the chosen facts reach the card: the label as the name, the key, the highlight, the new types', () {
    fakeAsync((async) {
      final app = App(async);
      app.routes['POST /proxy/agency/sessions'] = (_) => json(200, bootstrap());
      app.start();
      app.frame(reserved());
      final facts = app.view!.call!.facts!;
      expect(facts.chosen, isTrue);
      expect([for (final t in facts.tiles) t.label], ['Amount due', 'Tenure (months)', 'Other number', 'Auto debit on']);
      expect([for (final t in facts.tiles) t.column], ['Amount Due', 'Tenure (months)', 'Alt Phone', 'Auto Debit']);
      expect([for (final t in facts.tiles) t.key], ['amount_due', 'tenure_months', 'alt_phone', 'auto_debit']);
      expect([for (final t in facts.tiles) t.kind], [FactKind.money, FactKind.number, FactKind.phone, FactKind.yesNo]);
      expect([for (final t in facts.tiles) t.highlight], [true, false, false, false]);
      expect(facts.tiles.first.amountDue, isTrue, reason: 'the role rides along, for the Full / Half chips');
      app.dispose();
    });
  });

  test('the script may use the campaign\'s keys: the fixed four, then each fact\'s', () {
    fakeAsync((async) {
      final app = App(async);
      app.routes['POST /proxy/agency/sessions'] = (_) => json(200, bootstrap());
      app.start();
      final script = app.view!.script!;
      expect(script.placeholders, ['name', 'place', 'agent_name', 'campaign_name', 'amount_due', 'tenure_months', 'alt_phone', 'auto_debit']);
      expect(script.factLabels, containsPair('alt_phone', 'Other number'));
      app.dispose();
    });
  });

  test('a campaign without chosen facts keeps the legacy keys, and its tiles are not chosen', () {
    fakeAsync((async) {
      final app = App(async);
      app.routes['POST /proxy/agency/sessions'] = (_) => json(200, {
            ...contractSample('session.json', 'bootstrap_agent_station'),
            'session_id': 'sess-1',
            'campaign_id': 'camp-1',
            'station_ws_url': '/proxy/agency/station?token=boot',
          });
      app.start();
      expect(app.view!.script!.placeholders, legacyScriptPlaceholders);
      final frame = contractSample('station.json', 'reserved_call_later');
      (frame['attempt']! as Map<String, Object?>)['campaign_id'] = 'camp-1';
      app.frame(frame);
      final facts = app.view!.call!.facts!;
      expect(facts.chosen, isFalse);
      expect([for (final t in facts.tiles) t.label], [for (final t in facts.tiles) t.column], reason: 'named by the column');
      app.dispose();
    });
  });

  test('Details hides a column read as a phone number when the campaign hides numbers (AS9)', () {
    fakeAsync((async) {
      final app = App(async);
      app.routes['POST /proxy/agency/sessions'] = (_) => json(200, bootstrap());
      app.start();
      app.frame(reserved());
      final call = app.view!.call!;
      final all = [...call.heroFields, ...call.otherFields];
      expect(all.firstWhere((f) => f.label == 'Alt Phone').value, '98••• ••210');
      expect(all.any((f) => f.value.contains('43210')), isFalse);
      // The heroes are the name role's column, then the facts' columns (AS19), as configured.
      expect([for (final f in call.heroFields) f.label], ['Customer Name', 'Amount Due', 'Tenure (months)', 'Alt Phone']);
      expect(call.heroesConfigured, isTrue);
      app.dispose();
    });
  });

  test('a type this build does not know is text; a tile with neither label nor key is the BE-6 tile', () {
    final facts = StationViewMapper.factsOf(wire.CustomerFacts.fromJson({
      'tiles': [
        {'column': 'Branch', 'type': 'colour', 'raw': 'Pune', 'value': null},
        {'column': 'EMI 2', 'label': 'Second EMI', 'key': 'emi_2', 'type': 'money', 'raw': '1500', 'value': '1500.00'},
      ],
    }))!;
    expect(facts.tiles.first.kind, FactKind.text);
    expect(facts.tiles.first.chosen, isFalse);
    expect(facts.tiles.last.chosen, isTrue);
    expect(facts.chosen, isTrue);
  });

  test('with chosen facts and no name role, the heroes are the facts\' columns and nothing is guessed', () {
    final display = wire.ContextDisplay(facts: const [wire.FactField(column: 'Loan No', label: 'Loan', key: 'loan')]);
    final resolved = resolveContextFields({'Name': 'Asha', 'Amount': '500', 'Loan No': 'L-1'}, display);
    expect([for (final f in resolved.hero) f.label], ['Loan No']);
    final none = resolveContextFields({'Name': 'Asha', 'Amount': '500'}, wire.ContextDisplay(facts: const []));
    expect(none.hero, isEmpty, reason: 'an empty choice is still the operator\'s choice');
    expect(heroesWereConfigured(wire.ContextDisplay(facts: const [])), isTrue);
    expect(heroesWereConfigured(wire.ContextDisplay()), isFalse);
  });
}
