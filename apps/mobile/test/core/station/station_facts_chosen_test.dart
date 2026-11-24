import 'package:agency_wire/agency_wire.dart' as wire;
import 'package:fake_async/fake_async.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:magick_agency_agent/core/station/contact_context.dart';
import 'package:magick_agency_agent/core/station/station_view.dart';
import 'package:magick_agency_agent/core/station/station_view_mapper.dart';
import 'package:magick_agency_agent/features/station/logic/facts.dart' show detailsOtherFields;

import '../inbound/inbound_fixtures.dart' show contractSample, stationFrame;
import 'controller_harness.dart';
import 'fixtures.dart' show bootstrapJson;

/// AS19 through the real station core: the campaign's chosen facts (`session.json`
/// `bootstrap_facts_chosen`, `station.json` `reserved_facts_chosen`) reach the view with their
/// names, keys, highlight and types; the script's keys are the campaign's; a column read as a phone
/// number is hidden in Details too when the campaign hides numbers. Whether the campaign chose its
/// facts is the bootstrap's `context_display.facts` being a list, even an empty one (R8).
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

  test('AS20: More details reach the view in the server\'s order, named by their columns', () {
    fakeAsync((async) {
      final app = App(async);
      app.routes['POST /proxy/agency/sessions'] = (_) => json(200, bootstrap());
      app.start();
      app.frame(reserved());
      final more = app.view!.call!.facts!.more!;
      expect([for (final t in more) t.column], ['Due Date', 'Branch', 'Office Phone']);
      expect([for (final t in more) t.kind], [FactKind.date, FactKind.text, FactKind.phone]);
      expect(more.every((t) => t.label == t.column && t.key == null && !t.highlight), isTrue);
      app.dispose();
    });
  });

  test('AS20: the place\'s column is the place role\'s, by the domain\'s rule; Details lists it first', () {
    fakeAsync((async) {
      final app = App(async);
      app.routes['POST /proxy/agency/sessions'] = (_) => json(200, bootstrap());
      app.start();
      app.frame(reserved());
      final call = app.view!.call!;
      expect(call.placeColumn, 'City');
      expect([for (final f in detailsOtherFields(call)) '${f.label}=${f.value}'].first, 'City=Nashik');
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
      // The heroes are the name role's column, then the facts' columns (AS19), as configured: the
      // name and all four facts (R2, `heroCapFor`), so no surface drops the fourth.
      expect([for (final f in call.heroFields) f.label], ['Customer Name', 'Amount Due', 'Tenure (months)', 'Alt Phone', 'Auto Debit']);
      expect(call.heroesConfigured, isTrue);
      app.dispose();
    });
  });

  test('a type this build does not know is text; a tile is named by its label, else its column', () {
    final facts = StationViewMapper.factsOf(wire.CustomerFacts.fromJson({
      'tiles': [
        {'column': 'Branch', 'type': 'colour', 'raw': 'Pune', 'value': null},
        {'column': 'EMI 2', 'label': 'Second EMI', 'key': 'emi_2', 'type': 'money', 'raw': '1500', 'value': '1500.00'},
      ],
    }))!;
    expect(facts.tiles.first.kind, FactKind.text);
    expect([for (final t in facts.tiles) t.label], ['Branch', 'Second EMI']);
    expect(facts.chosen, isFalse, reason: 'the tiles never decide it; the campaign does');
  });

  Map<String, Object?> chosenEmpty() {
    final boot = bootstrap();
    boot['context_display'] = {...(boot['context_display']! as Map<String, Object?>), 'facts': <Object?>[]};
    return boot;
  }

  test('an empty choice (`facts: []`) is still chosen: no tiles, and the script says "not given"', () {
    fakeAsync((async) {
      final app = App(async);
      app.routes['POST /proxy/agency/sessions'] = (_) => json(200, chosenEmpty());
      app.start();
      final frame = reserved();
      (frame['attempt']! as Map<String, Object?>)['facts'] = {'name': 'Sunita Patil', 'tiles': <Object?>[]};
      app.frame(frame);
      final call = app.view!.call!;
      expect(call.factsChosen, isTrue);
      expect(call.facts!.tiles, isEmpty);
      expect(app.view!.script!.placeholders, ['name', 'place', 'agent_name', 'campaign_name']);
      app.dispose();
    });
  });

  test('a chosen campaign\'s call with no panel from the server is still chosen, with no tiles', () {
    fakeAsync((async) {
      final app = App(async);
      app.routes['POST /proxy/agency/sessions'] = (_) => json(200, chosenEmpty());
      app.start();
      final frame = reserved();
      (frame['attempt']! as Map<String, Object?>).remove('facts');
      app.frame(frame);
      final call = app.view!.call!;
      expect(call.factsChosen, isTrue);
      expect(call.facts!.tiles, isEmpty);
      expect(call.customerName, isNull, reason: 'the name is the server\'s only, never the guess');
      app.dispose();
    });
  });

  test('labelled tiles on a campaign whose bootstrap has no facts list are the BE-6 card', () {
    fakeAsync((async) {
      final app = App(async);
      final boot = bootstrap();
      boot['context_display'] = {...(boot['context_display']! as Map<String, Object?>)}..remove('facts');
      app.routes['POST /proxy/agency/sessions'] = (_) => json(200, boot);
      app.start();
      app.frame(reserved());
      final call = app.view!.call!;
      expect(call.facts!.tiles.first.label, 'Amount due', reason: 'still named by the server\'s label');
      expect(call.factsChosen, isFalse);
      app.dispose();
    });
  });

  // The domain's hero rule (S1, S2, `heroColumnsFor`): with chosen facts and no name role, the name
  // is guessed by the one name guess (never a fact's column), then the facts; nothing else is.
  test('with chosen facts and no name role, the heroes are the guessed name then the facts\' columns, nothing more', () {
    final display = wire.ContextDisplay(facts: const [wire.FactField(column: 'Loan No', label: 'Loan', key: 'loan')]);
    final resolved = resolveContextFields({'Name': 'Asha', 'Amount': '500', 'Loan No': 'L-1'}, display);
    expect([for (final f in resolved.hero) f.label], ['Name', 'Loan No']);
    final none = resolveContextFields({'Name': 'Asha', 'Amount': '500'}, wire.ContextDisplay(facts: const []));
    expect([for (final f in none.hero) f.label], ['Name'], reason: 'an empty choice is still the operator\'s choice: no amount guessed');
    final factIsName = resolveContextFields(
      {'Name': 'Asha', 'Amount': '500'},
      wire.ContextDisplay(facts: const [wire.FactField(column: 'Name', label: 'Who', key: 'who')]),
    );
    expect([for (final f in factIsName.hero) f.label], ['Name'], reason: 'the guess never takes a fact\'s column, nor repeats it');
    expect(heroesWereConfigured(wire.ContextDisplay(facts: const [])), isTrue);
    expect(heroesWereConfigured(wire.ContextDisplay()), isFalse);
  });

  test('a fact\'s blank label falls back to its column for "not given"; a fact with no key has no name (S5)', () {
    final labels = StationViewMapper.factLabelsOf(
      wire.ContextDisplay.fromJson({
        'facts': [
          {'column': 'Branch', 'label': '  ', 'key': 'branch'},
          {'column': 'EMI 2', 'label': 7, 'key': 'emi_2'},
          {'column': 'Loan No', 'label': ' Loan ', 'key': 'loan'},
          {'column': 'Notes', 'label': 'Notes', 'key': ''},
        ],
      }),
    );
    expect(labels, {'branch': 'Branch', 'emi_2': 'EMI 2', 'loan': 'Loan'});
  });

  test('the legacy keys are every known script placeholder, in the contract\'s order', () {
    expect(legacyScriptPlaceholders, ['name', 'place', 'amount_due', 'due_date', 'agent_name', 'campaign_name']);
    expect(legacyScriptPlaceholders, wire.ContextDisplay().scriptPlaceholders, reason: 'the wire\'s own legacy set');
  });

  test('the hero cap is the domain\'s: the name and four facts with chosen facts (R2), else four', () {
    final row = {'Name': 'Asha', 'A': '1', 'B': '2', 'C': '3', 'D': '4', 'E': '5'};
    final chosen = wire.ContextDisplay(facts: [for (final c in ['A', 'B', 'C', 'D', 'E']) wire.FactField(column: c, label: c, key: c.toLowerCase())]);
    expect([for (final f in resolveContextFields(row, chosen).hero) f.label], ['Name', 'A', 'B', 'C', 'D']);
    final legacy = wire.ContextDisplay(hero: const ['Name', 'A', 'B', 'C', 'D', 'E']);
    expect([for (final f in resolveContextFields(row, legacy).hero) f.label], ['Name', 'A', 'B', 'C']);
  });

  test('a chosen campaign\'s call is named to the phone (CallKit) as the card heads it: the server\'s name, never the guess', () {
    String? calledName(Map<String, Object?>? facts) {
      String? out;
      fakeAsync((async) {
        final app = App(async);
        app.routes['POST /proxy/agency/sessions'] = (_) => json(200, bootstrap());
        app.start();
        app.readyFrame('available');
        final frame = reserved();
        final attempt = frame['attempt']! as Map<String, Object?>;
        attempt['context'] = {...attempt['context']! as Map<String, Object?>, 'Name': 'Guessed Name'};
        if (facts == null) {
          attempt.remove('facts');
        } else {
          attempt['facts'] = facts;
        }
        app.frame(frame);
        final started = app.engine.startedCalls.last;
        // No name: the phone shows the number (the handle).
        out = started.displayName == started.handle ? 'the number' : started.displayName;
        app.dispose();
      });
      return out;
    }

    expect(calledName({'name': 'Sunita Patil', 'tiles': <Object?>[]}), 'Sunita Patil');
    expect(calledName(null), 'the number', reason: 'no name from the server: the number, never a guess from the columns');
  });

  group('an inbound caller matched on a campaign (AS19 S1, S3)', () {
    // The matched contact: named by the campaign's role (a column no guess would take), with an
    // alternate number the campaign reads as a phone number.
    const row = {'Holder': 'Sunita Patil', 'Name': 'Not this', 'Amount Due': '12500', 'Alt Phone': '9876543210', 'City': 'Nashik'};
    Map<String, Object?> chosenDisplay() => {
          'roles': {'name': 'Holder', 'place': 'City'},
          'facts': [
            {'column': 'Alt Phone', 'label': 'Other number', 'key': 'alt_phone'},
            {'column': 'Amount Due', 'label': 'Amount due', 'key': 'amount_due', 'highlight': true},
          ],
          'types': {'Amount Due': 'money', 'Alt Phone': 'phone'},
        };
    Map<String, Object?> legacyDisplay() => {
          'hero': ['Name', 'Alt Phone'],
          'types': {'Alt Phone': 'phone'},
        };

    InboundCallView offered({required Map<String, Object?> display, bool masked = false}) {
      late InboundCallView out;
      fakeAsync((async) {
        final app = App(async);
        app.routes['POST /proxy/agency/sessions'] = (_) => json(200, {...bootstrapJson(), if (masked) 'phone_display': 'masked'});
        app.start();
        app.readyFrame('available');
        final frame = stationFrame('inbound_call_offered');
        final match = (frame['call']! as Map<String, Object?>)['match']! as Map<String, Object?>;
        match['context'] = row;
        match['context_display'] = display;
        app.frame(frame);
        out = app.view!.inbound!;
        app.dispose();
      });
      return out;
    }

    test('the name is the name role\'s, by the domain\'s rule, never a column that looks like one', () {
      expect(offered(display: chosenDisplay()).displayName, 'Sunita Patil');
      expect(offered(display: {...legacyDisplay(), 'roles': {'name': 'Holder'}}).displayName, 'Sunita Patil');
    });

    test('a legacy caller the rule cannot name is named by the legacy card\'s guess (Borrower Name); a chosen one is not', () {
      ({String? card, String callKit}) named(Map<String, Object?> display) {
        late ({String? card, String callKit}) out;
        fakeAsync((async) {
          final app = App(async);
          app.routes['POST /proxy/agency/sessions'] = (_) => json(200, bootstrapJson());
          app.start();
          app.readyFrame('available');
          final frame = stationFrame('inbound_call_offered');
          final match = (frame['call']! as Map<String, Object?>)['match']! as Map<String, Object?>;
          match['context'] = {'Loan No': 'HL-4471', 'Borrower Name': 'Sunita Patil', 'City': 'Nashik'};
          match['context_display'] = display;
          app.frame(frame);
          out = (card: app.view!.inbound!.displayName, callKit: app.engine.startedCalls.last.displayName);
          app.dispose();
        });
        return out;
      }

      final legacy = named({'hero': ['Loan No']});
      expect(legacy.card, 'Sunita Patil');
      expect(legacy.callKit, 'Sunita Patil');
      final chosen = named({'facts': <Object?>[]});
      expect(chosen.card, isNull);
      expect(chosen.callKit, isNot('Sunita Patil'));
    });

    test('a chosen campaign\'s caller gets the chosen card: names, types, the highlight first, the place by its role', () {
      final facts = offered(display: chosenDisplay()).facts!;
      expect(facts.chosen, isTrue);
      expect(facts.name, 'Sunita Patil');
      expect(facts.place, 'Nashik');
      expect([for (final t in facts.tiles) t.label], ['Amount due', 'Other number']);
      expect([for (final t in facts.tiles) t.kind], [FactKind.money, FactKind.phone]);
      expect([for (final t in facts.tiles) t.parsed], ['12500', '9876543210']);
      expect(facts.tiles.first.highlight, isTrue);
    });

    test('a campaign that did not choose has no chosen card: the hero fields, as before', () {
      final call = offered(display: legacyDisplay());
      expect(call.facts, isNull);
      expect([for (final f in call.heroFields) f.label], ['Name', 'Alt Phone']);
    });

    for (final chosen in [true, false]) {
      test('${chosen ? 'chosen' : 'legacy'}: a phone-typed column is hidden in the hero fields and Details when the station hides numbers', () {
        final display = chosen ? chosenDisplay() : legacyDisplay();
        final hidden = offered(display: display, masked: true);
        final all = [...hidden.heroFields, ...hidden.otherFields];
        expect(all.firstWhere((f) => f.label == 'Alt Phone').value, '98••• ••210');
        expect(all.any((f) => f.value.contains('43210')), isFalse);
        final shown = offered(display: display);
        expect([...shown.heroFields, ...shown.otherFields].firstWhere((f) => f.label == 'Alt Phone').value, '9876543210');
      });
    }
  });
}
