import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:magick_agency_agent/app/theme/tokens.dart';
import 'package:magick_agency_agent/core/station/script_fill.dart';
import 'package:magick_agency_agent/core/station/station_view.dart';
import 'package:magick_agency_agent/features/station/logic/facts.dart';
import 'package:magick_agency_agent/features/station/logic/format.dart';
import 'package:magick_agency_agent/features/station/parts/script_cards.dart' show scriptValuesFor;
import 'package:magick_agency_agent/features/station/station_copy.dart';

import 'station_harness.dart';

/// AS19 on the phone: the campaign's chosen facts on the customer card (a 2 × 2 grid, the
/// highlight first and the full row, a lone last tile the full width, values by type, "—" when
/// empty, press and hold for the full value, no Last call tile, "Customer" when the server has no
/// name), one phone rule everywhere a phone fact shows, and the script filled from the facts' keys
/// with "`<name> not given`" for a missing value, which read aloud skips; a campaign without chosen
/// facts leaves a missing value out, as before.
void main() {
  FactTileView fact(
    String label,
    String raw, {
    FactKind kind = FactKind.text,
    String? parsed,
    String? column,
    String? key,
    bool highlight = false,
    bool amountDue = false,
  }) =>
      FactTileView(
        label: label,
        column: column ?? label,
        raw: raw,
        kind: kind,
        parsed: parsed,
        key: key ?? label.toLowerCase().replaceAll(RegExp('[^a-z0-9]+'), '_'),
        highlight: highlight,
        amountDue: amountDue,
      );

  final amount = fact('Amount due', '₹1,25,000.00', kind: FactKind.money, parsed: '125000.00', column: 'Amount Due', key: 'amount_due', highlight: true, amountDue: true);
  final tenure = fact('Tenure', '24', kind: FactKind.number, parsed: '24', column: 'Tenure (months)', key: 'tenure_months');
  final alt = fact('Other number', '098765 43210', kind: FactKind.phone, parsed: '09876543210', column: 'Alt Phone', key: 'alt_phone');
  final debit = fact('Auto debit on', 'Haan', kind: FactKind.yesNo, parsed: 'yes', column: 'Auto Debit', key: 'auto_debit');

  FactsView facts(List<FactTileView> tiles, {String? name = 'Sunita Patil'}) =>
      FactsView(name: name, place: 'Nashik', tiles: tiles, chosen: true);

  group('values by type (AS19, as the console)', () {
    test('money: ₹ with Indian grouping, paise only when not zero', () {
      expect(factText(amount), '₹1,25,000');
      expect(factText(fact('Dues', '1,25,000.5', kind: FactKind.money, parsed: '125000.50')), '₹1,25,000.50');
    });

    test('number: Indian grouping, decimals as written unless all zero', () {
      expect(formatIndianNumber('125000'), '1,25,000');
      expect(formatIndianNumber('12345678.25'), '1,23,45,678.25');
      expect(formatIndianNumber('125000.00'), '1,25,000');
      expect(formatIndianNumber('007'), '7');
      expect(factText(fact('Count', '1,25,000', kind: FactKind.number, parsed: '125000')), '1,25,000');
    });

    test('date: "20 Nov", the year added when it is not this year', () {
      final now = DateTime(2026, 11, 21);
      final due = fact('Due', '20/11/2026', kind: FactKind.date, parsed: '2026-11-20');
      expect(factText(due, now: now), '20 Nov');
      expect(factText(fact('Due', '20/11/2027', kind: FactKind.date, parsed: '2027-11-20'), now: now), '20 Nov 2027');
      expect(formatFactDate('2025-01-05', now: now), '5 Jan 2025');
      expect(formatFactDate('2025-01-05'), '5 Jan', reason: 'without a clock (the BE-6 card) as before');
    });

    test('phone: formatted; hidden as the customer\'s number is when the campaign hides numbers', () {
      expect(factText(alt), '+91 98765 43210');
      expect(factText(alt, masked: true), '98••• ••210');
      // A value the server could not read is shown as uploaded, but a hidden number never shows a digit.
      final odd = fact('Other number', '98765-4321 ext 2', kind: FactKind.phone);
      expect(factText(odd), '98765-4321 ext 2');
      expect(factText(odd, masked: true), isNot(contains('4321')));
      expect(factText(fact('Other number', 'none', kind: FactKind.phone), masked: true), '•••');
    });

    test('yes / no as Yes or No; unreadable shows the raw value; empty is "—"', () {
      expect(factText(debit), 'Yes');
      expect(factText(fact('Auto debit', 'nahi', kind: FactKind.yesNo, parsed: 'no')), 'No');
      expect(factText(fact('Auto debit', 'maybe', kind: FactKind.yesNo)), 'maybe');
      expect(factText(fact('Dues', 'Rs twelve', kind: FactKind.money)), 'Rs twelve');
      expect(factText(fact('Branch', '  ')), '—');
      expect(factText(fact('Dues', '', kind: FactKind.money)), '—');
    });

    test('a value as uploaded is shown without the spaces around it, as the console shows it', () {
      expect(factText(fact('Branch', '  Pune  ')), 'Pune');
      expect(factText(fact('Dues', ' Rs twelve ', kind: FactKind.money)), 'Rs twelve');
      expect(factText(fact('Auto debit', ' maybe\t', kind: FactKind.yesNo)), 'maybe');
      expect(factText(fact('Other number', ' 98765-4321 ext 2 ', kind: FactKind.phone)), '98765-4321 ext 2');
    });

    test('the highlighted fact is drawn first, whatever its place in the list', () {
      final h = fact('Branch', 'Pune', highlight: true);
      expect(cardFactTiles(facts([tenure, h, debit])).map((t) => t.label), ['Branch', 'Tenure', 'Auto debit on']);
    });
  });

  group('the one phone rule (AS19 R6, the console tests the same table)', () {
    const table = <(String, String, String)>[
      ('9876543210', '+91 98765 43210', '98••• ••210'),
      ('919876543210', '+91 98765 43210', '98••• ••210'),
      ('+919876543210', '+91 98765 43210', '98••• ••210'),
      ('09876543210', '+91 98765 43210', '98••• ••210'),
      ('1234567890', '1234567890', '12••• ••890'),
      ('+14155550123', '+14155550123', '14••• ••123'),
    ];
    for (final (parsed, full, masked) in table) {
      test('$parsed → $full / $masked', () {
        expect(formatFactPhone(parsed), full);
        expect(maskFactPhone(parsed), masked);
        final f = fact('Other number', parsed, kind: FactKind.phone, parsed: parsed);
        expect(factText(f), full);
        expect(factText(f, masked: true), masked);
      });
    }

    test('a number the server could not read is hidden the same way, on its digits; a short one shows none', () {
      expect(factText(fact('Other number', '98765-4321 ext 2', kind: FactKind.phone), masked: true), '98••• ••212');
      expect(factText(fact('Other number', 'ext 12', kind: FactKind.phone), masked: true), '•••');
    });

    testWidgets('the tile, its sheet and a screen reader say the number by the rule', (tester) async {
      final handle = tester.ensureSemantics();
      final plain = fact('Other number', '9876543210', kind: FactKind.phone, parsed: '9876543210', column: 'Alt Phone', key: 'alt_phone');
      await pumpStation(tester, station(phase: AgentPhase.reserved, call: call(facts: facts([tenure, plain]), priorAttempts: const [])));
      final tile = find.byKey(const Key('fact-tile-1'));
      expect(find.descendant(of: tile, matching: find.text('+91 98765 43210')), findsOneWidget);
      expect(tester.getSemantics(tile).label, 'Other number: +91 98765 43210');
      await tester.longPress(tile);
      await settle(tester);
      expect(tester.widget<Text>(find.byKey(const Key('fact-sheet-value'))).data, '+91 98765 43210');
      await tester.tap(find.byKey(const Key('fact-sheet-ok')));
      await settle(tester);

      await pumpStation(tester, station(phase: AgentPhase.reserved, call: call(facts: facts([tenure, plain]), priorAttempts: const []), maskPhone: true));
      expect(tester.getSemantics(find.byKey(const Key('fact-tile-1'))).label, 'Other number: 98••• ••210');
      handle.dispose();
    });

    test('the script says the number by the rule', () {
      final plain = fact('Other number', '919876543210', kind: FactKind.phone, parsed: '919876543210', key: 'alt_phone');
      final v = scriptValuesFor(call(facts: facts([plain])), agentName: null, campaignName: '');
      expect(shownScript(fillScriptRuns('Call {alt_phone}', const ['alt_phone'], v)), 'Call +91 98765 43210');
    });
  });

  group('the card\'s grid', () {
    Rect rect(WidgetTester tester, String key) => tester.getRect(find.byKey(Key(key)));

    testWidgets('the tile\'s name is the fact\'s label, not the column', (tester) async {
      await pumpStation(tester, station(phase: AgentPhase.reserved, call: call(facts: facts([amount, tenure, alt, debit]))));
      expect(find.byKey(const Key('fact-grid')), findsOneWidget);
      expect(find.text('Other number'), findsOneWidget);
      expect(find.text('Alt Phone'), findsNothing);
      expect(find.text('Tenure'), findsOneWidget);
    });

    testWidgets('the highlight comes first and takes the full row; the rest two to a row', (tester) async {
      await pumpStation(tester, station(phase: AgentPhase.reserved, call: call(facts: facts([tenure, alt, amount]), priorAttempts: const [])));
      final grid = rect(tester, 'fact-grid');
      final first = rect(tester, 'fact-tile-0');
      expect(find.descendant(of: find.byKey(const Key('fact-tile-0')), matching: find.text('₹1,25,000')), findsOneWidget);
      expect(first.width, moreOrLessEquals(grid.width), reason: 'the full row');
      expect(first.top, moreOrLessEquals(grid.top));
      final a = rect(tester, 'fact-tile-1');
      final b = rect(tester, 'fact-tile-2');
      expect(a.top, moreOrLessEquals(b.top), reason: 'side by side');
      expect(a.width, lessThan(grid.width / 2));
      expect(a.height, moreOrLessEquals(b.height), reason: 'a text tile and a figure tile match');
      expect(a.top, greaterThan(first.bottom));
    });

    testWidgets('a lone last tile takes the full width', (tester) async {
      final plainAmount = fact('Amount due', '₹1,25,000.00', kind: FactKind.money, parsed: '125000.00');
      await pumpStation(tester, station(phase: AgentPhase.reserved, call: call(facts: facts([plainAmount, tenure, alt]), priorAttempts: const [])));
      final grid = rect(tester, 'fact-grid');
      expect(rect(tester, 'fact-tile-0').width, lessThan(grid.width / 2));
      expect(rect(tester, 'fact-tile-2').width, moreOrLessEquals(grid.width));
    });

    testWidgets('no Last call tile beside chosen facts, even with a cell free (Last calls has its own card)', (tester) async {
      await pumpStation(tester, station(phase: AgentPhase.reserved, call: call(facts: facts([amount, tenure, alt]))));
      expect(find.byKey(const Key('fact-tile-2')), findsOneWidget);
      expect(find.byKey(const Key('last-call-tile')), findsNothing);
      expect(find.text(StationCopy.lastCall), findsNothing);
      await pumpStation(tester, station(phase: AgentPhase.reserved, call: call(facts: facts([amount]))));
      expect(find.byKey(const Key('last-call-tile')), findsNothing);
    });

    testWidgets('an empty choice shows no tiles, not the BE-6 card', (tester) async {
      await pumpStation(tester, station(phase: AgentPhase.reserved, call: call(facts: facts(const []))));
      expect(find.byKey(const Key('fact-grid')), findsNothing);
      expect(find.byKey(const Key('last-call-tile')), findsNothing);
      // The BE-6 card would draw the last call's date in a tile.
      expect(find.text(StationCopy.lastCall), findsNothing);
    });

    testWidgets('the heading is the server\'s name, else "Customer", with the number under it; never the guess', (tester) async {
      await pumpStation(tester, station(phase: AgentPhase.reserved, call: call(name: 'Priya Raman', facts: facts([tenure], name: null))));
      expect(tester.widget<Text>(find.byKey(const Key('call-headline'))).data, StationCopy.customer);
      expect(find.text('Priya Raman'), findsNothing);
      expect(find.descendant(of: find.byKey(const Key('customer-phone')), matching: find.text('+91 98400 12345')), findsOneWidget);
      await pumpStation(tester, station(phase: AgentPhase.reserved, call: call(name: 'Priya Raman', facts: facts([tenure]))));
      expect(tester.widget<Text>(find.byKey(const Key('call-headline'))).data, 'Sunita Patil');
      expect(find.byKey(const Key('customer-phone')), findsOneWidget);
    });

    testWidgets('a campaign without chosen facts is headed as before: the guessed name, else the number', (tester) async {
      await pumpStation(tester, station(phase: AgentPhase.reserved, call: call(name: 'Priya Raman', facts: const FactsView())));
      expect(tester.widget<Text>(find.byKey(const Key('call-headline'))).data, 'Priya Raman');
      await pumpStation(tester, station(phase: AgentPhase.reserved, call: call(name: null, facts: const FactsView())));
      expect(tester.widget<Text>(find.byKey(const Key('call-headline'))).data, '+91 98400 12345');
      expect(find.byKey(const Key('customer-phone')), findsNothing);
    });

    testWidgets('an empty value shows "—", muted, and keeps its tile', (tester) async {
      final branch = fact('Branch', '');
      await pumpStation(tester, station(phase: AgentPhase.reserved, call: call(facts: facts([tenure, branch]), priorAttempts: const [])));
      final dash = find.descendant(of: find.byKey(const Key('fact-tile-1')), matching: find.text('—'));
      expect(dash, findsOneWidget);
      const t = AppTokens.light;
      expect(tester.widget<Text>(dash).style?.color, t.textMuted);
    });

    testWidgets('a hidden number is hidden on the tile and in its sheet', (tester) async {
      await pumpStation(tester, station(phase: AgentPhase.reserved, call: call(facts: facts([tenure, alt]), priorAttempts: const []), maskPhone: true));
      expect(find.text('98••• ••210'), findsOneWidget);
      expect(find.textContaining('43210'), findsNothing);
      await tester.longPress(find.byKey(const Key('fact-tile-1')));
      await settle(tester);
      expect(find.byKey(const Key('fact-sheet')), findsOneWidget);
      expect(find.descendant(of: find.byKey(const Key('fact-sheet')), matching: find.text('98••• ••210')), findsOneWidget);
      expect(find.textContaining('43210'), findsNothing);
      expect(find.textContaining('98765'), findsNothing);
    });

    testWidgets('press and hold: the name, the full value, "From column: X", and OK closes it', (tester) async {
      final long = fact('Address', '14, Shivaji Nagar, near the old bus stand, Nashik Road, Nashik 422101', column: 'Full Address');
      await pumpStation(tester, station(phase: AgentPhase.reserved, call: call(facts: facts([tenure, long]), priorAttempts: const [])), size: const Size(320, 700));
      // On the tile: one line, cut with "…".
      final onTile = tester.widget<Text>(find.descendant(of: find.byKey(const Key('fact-tile-1')), matching: find.byKey(const Key('fact-value'))));
      expect(onTile.maxLines, 1);
      expect(onTile.overflow, TextOverflow.ellipsis);
      await tester.longPress(find.byKey(const Key('fact-tile-1')));
      await settle(tester);
      final sheet = find.byKey(const Key('fact-sheet'));
      expect(find.descendant(of: sheet, matching: find.text('Address')), findsOneWidget);
      expect(find.descendant(of: sheet, matching: find.text(long.raw)), findsOneWidget);
      expect(find.descendant(of: sheet, matching: find.text('From column: Full Address')), findsOneWidget);
      expect(tester.widget<Text>(find.byKey(const Key('fact-sheet-value'))).maxLines, isNull, reason: 'the full value wraps');
      await tester.tap(find.byKey(const Key('fact-sheet-ok')));
      await settle(tester);
      expect(sheet, findsNothing);
      // A plain tap still opens Details, as before.
      await tester.tap(find.byKey(const Key('fact-tile-0')));
      await settle(tester);
      expect(find.byKey(const Key('details-sheet')), findsOneWidget);
    });

    testWidgets('figures shrink to fit, never below 65 %, before they are cut', (tester) async {
      final big = fact('Loan', '1234567890123', kind: FactKind.number, parsed: '1234567890123');
      await pumpStation(tester, station(phase: AgentPhase.reserved, call: call(facts: facts([tenure, big]), priorAttempts: const [])), size: const Size(320, 700));
      final small = tester.widget<Text>(find.descendant(of: find.byKey(const Key('fact-tile-1')), matching: find.byKey(const Key('fact-value'))));
      final base = tester.widget<Text>(find.descendant(of: find.byKey(const Key('fact-tile-0')), matching: find.byKey(const Key('fact-value'))));
      expect(small.data, '12,34,56,78,90,123');
      expect(small.style!.fontSize!, lessThan(base.style!.fontSize!));
      expect(small.style!.fontSize!, greaterThanOrEqualTo(base.style!.fontSize! * 0.65 - 0.01));
      expect(small.maxLines, 1);
    });

    testWidgets('screen readers hear the name and value, and how to see it in full', (tester) async {
      final handle = tester.ensureSemantics();
      await pumpStation(tester, station(phase: AgentPhase.reserved, call: call(facts: facts([amount, tenure]), priorAttempts: const [])));
      final node = tester.getSemantics(find.byKey(const Key('fact-tile-1')));
      expect(node.label, 'Tenure: 24');
      expect(node.hint, StationCopy.factHoldHint);
      expect(node.getSemanticsData().hasAction(SemanticsAction.longPress), isTrue);
      expect(tester.getSemantics(find.byKey(const Key('fact-tile-0'))).label, 'Amount due: ₹1,25,000');
      handle.dispose();
    });

    for (final (b, s) in [(Brightness.light, StateTokens.light), (Brightness.dark, StateTokens.dark)]) {
      testWidgets('the highlight is in the call colour, ${b.name} (AS14)', (tester) async {
        await pumpStation(tester, station(phase: AgentPhase.onCall, call: call(bridgedAt: t0, facts: facts([amount, tenure]))), brightness: b);
        final box = tester.widget<DecoratedBox>(
          find.descendant(of: find.byKey(const Key('fact-tile-0')), matching: find.byType(DecoratedBox)).first,
        );
        expect((box.decoration as BoxDecoration).color, s.onCall.soft);
        final label = tester.widget<Text>(find.descendant(of: find.byKey(const Key('fact-tile-0')), matching: find.text('Amount due')));
        expect(label.style?.color, s.onCall.deep);
        expect(tester.takeException(), isNull);
      });
    }

    testWidgets('at large text the tiles stack, one under the other', (tester) async {
      await pumpStation(tester, station(phase: AgentPhase.reserved, call: call(facts: facts([tenure, debit]), priorAttempts: const [])), textScale: 1.6);
      expect(rect(tester, 'fact-tile-1').top, greaterThan(rect(tester, 'fact-tile-0').bottom));
      expect(tester.takeException(), isNull);
    });

    testWidgets('BE-6 tiles (no label, no key) look as they did: three in a row, no grid', (tester) async {
      const legacy = FactsView(
        name: 'Sunita Patil',
        tiles: [
          FactTileView(label: 'Amount Due', raw: '₹12,500.00', kind: FactKind.money, parsed: '12500.00', amountDue: true),
          FactTileView(label: 'Loan No', raw: 'LN-88213', kind: FactKind.text),
          FactTileView(label: 'Branch', raw: '', kind: FactKind.text),
        ],
      );
      await pumpStation(tester, station(phase: AgentPhase.reserved, call: call(facts: legacy)));
      expect(find.byKey(const Key('fact-grid')), findsNothing);
      expect(find.text('₹12,500'), findsOneWidget);
      expect(find.text('LN-88213'), findsOneWidget);
      expect(find.text('—'), findsNothing, reason: 'an empty BE-6 tile is left out, as before');
      final last = tester.getRect(find.byKey(const Key('last-call-tile')));
      expect(tester.getRect(find.text('₹12,500')).top, lessThan(last.bottom), reason: 'one row');
      await tester.longPress(find.text('LN-88213'));
      await settle(tester);
      expect(find.byKey(const Key('fact-sheet')), findsNothing);
    });
  });

  group('the script with the campaign\'s keys (AS19)', () {
    const placeholders = ['name', 'place', 'agent_name', 'campaign_name', 'amount_due', 'emi_2', 'alt_phone', 'branch'];

    test('keys with digits fill; a missing value is "<name> not given"; read aloud skips it', () {
      final c = call(
        facts: facts([
          amount,
          fact('Second EMI', '2,500', kind: FactKind.money, parsed: '2500.00', key: 'emi_2'),
          fact('Branch', '', key: 'branch'),
        ]),
      );
      final v = scriptValuesFor(c, agentName: 'Ravi Kumar', campaignName: 'EMI', factLabels: const {'alt_phone': 'Other number'});
      expect(v.chosen, isTrue);
      final runs = fillScriptRuns('{name}: {amount_due}, then {emi_2}. Branch {branch}. Call {alt_phone}. {unknown_1}', placeholders, v);
      expect(shownScript(runs), 'Sunita Patil: ₹1,25,000, then ₹2,500. Branch Branch not given. Call Other number not given. {unknown_1}');
      expect(runs.whereType<NotGivenRun>().map((r) => r.label), ['Branch', 'Other number']);
      expect(spokenScript(runs), 'Sunita Patil: ₹1,25,000, then ₹2,500. Branch. Call. {unknown_1}');
    });

    test('name and place say "Name not given" and "Place not given"; the agent\'s and the work\'s names drop out', () {
      final runs = fillScriptRuns('Hi {name} from {place}, {agent_name} here for {campaign_name}.', placeholders, const ScriptValues(chosen: true));
      expect(shownScript(runs), 'Hi Name not given from Place not given,  here for .');
      expect(runs.whereType<NotGivenRun>().map((r) => r.label), ['Name', 'Place']);
      expect(spokenScript(runs), 'Hi from, here for.');
    });

    test('{name} is the server\'s name only: the guess from the hero fields never fills it', () {
      final v = scriptValuesFor(call(name: 'Priya Raman', facts: facts([tenure], name: null)), agentName: null, campaignName: '');
      expect(shownScript(fillScriptRuns('Hi {name}.', placeholders, v)), 'Hi Name not given.');
    });

    test('a campaign without chosen facts leaves a missing value out, as before, never "not given"', () {
      const legacy = FactsView(
        tiles: [FactTileView(label: 'Amount Due', raw: '₹12,500.00', kind: FactKind.money, parsed: '12500.00', amountDue: true)],
      );
      final v = scriptValuesFor(call(name: null, facts: legacy), agentName: null, campaignName: '');
      expect(v.chosen, isFalse);
      final runs = fillScriptRuns('Hi {name} from {place}, {agent_name} here. {amount_due} by {due_date}.', legacyScriptPlaceholders, v);
      expect(runs.whereType<NotGivenRun>(), isEmpty);
      expect(shownScript(runs), 'Hi  from ,  here. ₹12,500 by .');
    });

    test('read aloud is cleaned up as the console does it: line breaks and runs of spaces one space, none before a mark', () {
      const runs = [SaidRun('Namaste \n Sunita ,  your EMI\t\tis due  !'), NotGivenRun('Branch'), SaidRun(' \nThank you .')];
      expect(spokenScript(runs), 'Namaste Sunita, your EMI is due! Thank you.');
    });

    test('a key the campaign does not have, or written with spaces, stays as written', () {
      final runs = fillScriptRuns('{emi_3} and { name }', placeholders, const ScriptValues(name: 'Asha', chosen: true));
      expect(shownScript(runs), '{emi_3} and { name }');
    });

    test('a hidden number stays hidden in the script', () {
      final v = scriptValuesFor(call(facts: facts([alt])), agentName: null, campaignName: '', masked: true);
      expect(shownScript(fillScriptRuns('Call {alt_phone}', placeholders, v)), 'Call 98••• ••210');
    });

    testWidgets('on screen: "not given" muted, and the opening line read aloud without it', (tester) async {
      const script = ScriptView(
        opening: 'Namaste {name}, your branch is {branch} and the EMI is {emi_2}.',
        steps: ['Confirm {emi_2} at {branch}.'],
        placeholders: placeholders,
      );
      final tiles = facts([fact('Second EMI', '2500', kind: FactKind.money, parsed: '2500', key: 'emi_2'), fact('Branch', '', key: 'branch')]);
      final h = await pumpStation(tester, station(phase: AgentPhase.reserved, call: call(facts: tiles), script: script));
      final line = tester.widget<RichText>(find.descendant(of: find.byKey(const Key('script-opening-line')), matching: find.byType(RichText)));
      expect(line.text.toPlainText(), '“Namaste Sunita Patil, your branch is Branch not given and the EMI is ₹2,500.”');
      TextSpan? notGiven;
      line.text.visitChildren((s) {
        if (s is TextSpan && s.text == 'Branch not given') notGiven = s;
        return true;
      });
      expect(notGiven?.style?.color, AppTokens.light.textMuted);
      await tester.tap(find.byKey(const Key('read-aloud-opening')));
      await tester.pump();
      expect(h.readAloud.said, ['Namaste Sunita Patil, your branch is and the EMI is ₹2,500.']);
      await h.setView(station(phase: AgentPhase.onCall, call: call(bridgedAt: t0, facts: tiles), script: script));
      expect(find.text('Confirm ₹2,500 at Branch not given.'), findsOneWidget);
    });
  });
}
