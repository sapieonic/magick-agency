import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:magick_agency_agent/core/station/station_view.dart';
import 'package:magick_agency_agent/features/station/logic/facts.dart';
import 'package:magick_agency_agent/features/station/parts/more_details_card.dart';
import 'package:magick_agency_agent/features/station/station_copy.dart';

import 'station_harness.dart';

/// AS20 on the phone: More details under the card on Call coming and On call, the server's
/// `facts.more` minus what the card draws; closed at first with a count; a push down on the page
/// while its end is on screen opens a step at a time (one per pause), "Show all" and "Hide"; a
/// phone number hidden as the campaign hides numbers; the same call keeps how far it was opened;
/// Details lists the server's More details, not the raw row, when the server sends them.
void main() {
  FactTileView more(String column, String raw, {FactKind kind = FactKind.text, String? parsed}) =>
      FactTileView(label: column, column: column, raw: raw, kind: kind, parsed: parsed);

  const amount = FactTileView(
    label: 'Amount due', column: 'Amount Due', raw: '₹12,500', kind: FactKind.money, parsed: '12500', key: 'amount_due', highlight: true, amountDue: true);

  final rows = [
    more('Loan No', 'LN-4471'),
    more('Alt mobile', '98765 12345', kind: FactKind.phone, parsed: '9876512345'),
    more('Tenure', '24', kind: FactKind.number, parsed: '24'),
    more('Branch', 'Kothrud'),
    more('Product', 'Two-wheeler loan'),
    more('Agent remark', 'Prefers Marathi'),
  ];

  FactsView chosen(List<FactTileView>? more) =>
      FactsView(name: 'Sunita Patil', place: 'Nashik', tiles: [amount], chosen: true, more: more);

  tearDown(forgetMoreDetails);

  List<String> labelsShown(WidgetTester tester) => [
        for (final e in find.byWidgetPredicate((w) => w.key is ValueKey<String> && (w.key! as ValueKey<String>).value.startsWith('more-detail-')).evaluate())
          ((e.widget.key! as ValueKey<String>).value).substring('more-detail-'.length),
      ];

  Future<void> pushDown(WidgetTester tester) async {
    await tester.drag(find.byType(SingleChildScrollView).first, const Offset(0, -400));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 600));
  }

  Future<void> waitPause(WidgetTester tester) =>
      tester.runAsync(() => Future<void>.delayed(moreDetailsPause + const Duration(milliseconds: 50)));

  group('the rows (logic)', () {
    test('chosen: the server\'s order, minus the card\'s tiles (ignoring case), each column once, no empty value', () {
      final facts = FactsView(tiles: [amount], chosen: true, more: [more('AMOUNT DUE', '1'), more('Branch', 'Kothrud'), more('branch', 'x'), more('Notes', '  ')]);
      expect([for (final t in moreDetailTiles(facts, hasLastCall: false)) t.column], ['Branch']);
    });

    test('legacy: the tiles the row draws (two beside Last call, else three) are left out, the rest kept', () {
      final tiles = [for (final c in ['A', 'B', 'C', 'D']) more(c, c.toLowerCase())];
      final facts = FactsView(tiles: tiles, more: [for (final c in ['A', 'B', 'C', 'D', 'E']) more(c, c.toLowerCase())]);
      expect([for (final t in moreDetailTiles(facts, hasLastCall: true)) t.column], ['C', 'D', 'E']);
      expect([for (final t in moreDetailTiles(facts, hasLastCall: false)) t.column], ['D', 'E']);
    });

    test('none from an older server', () {
      expect(moreDetailTiles(const FactsView(tiles: [amount], chosen: true), hasLastCall: false), isEmpty);
    });

    test('Details lists the server\'s More details (a phone hidden), else the raw row as before', () {
      final withMore = call(facts: chosen([rows[0], rows[1], more('City', 'Chennai')]));
      expect([for (final f in detailsOtherFields(withMore, masked: true)) '${f.label}=${f.value}'], ['Loan No=LN-4471', 'Alt mobile=98••• ••345']);
      final older = call(facts: chosen(null));
      expect(detailsOtherFields(older), same(older.otherFields));
    });
  });

  group('the card', () {
    testWidgets('closed at first on Call coming: the title, the count and the hint, no rows', (tester) async {
      await pumpStation(tester, station(phase: AgentPhase.reserved, call: call(facts: chosen(rows), priorAttempts: const [])));
      await tester.scrollUntilVisible(find.byKey(const Key('more-details-card')), 200, scrollable: find.byType(Scrollable).first);
      expect(find.textContaining(StationCopy.moreDetailsCount(6)), findsOneWidget);
      expect(find.text(StationCopy.moreDetailsHint), findsOneWidget);
      expect(labelsShown(tester), isEmpty);
    });

    testWidgets('a push down while its end is on screen opens a step; one step per pause; then the rest', (tester) async {
      await pumpStation(tester, station(phase: AgentPhase.reserved, call: call(facts: chosen(rows), priorAttempts: const [])), size: const Size(390, 2400));
      await pushDown(tester);
      expect(labelsShown(tester), ['Loan No', 'Alt mobile', 'Tenure', 'Branch']);
      expect(find.text(StationCopy.moreDetailsShown(4, 6)), findsOneWidget);
      await pushDown(tester);
      expect(labelsShown(tester), hasLength(moreDetailsStep), reason: 'within the pause');
      await waitPause(tester);
      await pushDown(tester);
      expect(labelsShown(tester), hasLength(6));
      expect(find.byKey(const Key('more-details-hint')), findsNothing);
      expect(find.text(StationCopy.moreDetailsHide), findsOneWidget);
    });

    testWidgets('a push while its end is off screen opens nothing', (tester) async {
      final many = [for (var i = 0; i < 40; i++) more('Column $i', 'v$i')];
      await pumpStation(tester, station(phase: AgentPhase.reserved, call: call(facts: chosen(many), priorAttempts: const [])), size: const Size(390, 500));
      await tester.drag(find.byType(SingleChildScrollView).first, const Offset(0, -10));
      await tester.pump();
      expect(labelsShown(tester), isEmpty);
    });

    testWidgets('Show all opens every row and Hide closes them; a phone number hidden as the campaign hides numbers', (tester) async {
      await pumpStation(
        tester,
        station(phase: AgentPhase.reserved, call: call(facts: chosen(rows), priorAttempts: const []), maskPhone: true),
        size: const Size(390, 2400),
      );
      await tester.tap(find.byKey(const Key('more-details-toggle')));
      await settle(tester);
      expect(labelsShown(tester), hasLength(6));
      final card = find.byKey(const Key('more-details-card'));
      expect(find.descendant(of: card, matching: find.text('98••• ••345')), findsOneWidget);
      expect(find.descendant(of: card, matching: find.textContaining('12345')), findsNothing);
      await tester.tap(find.byKey(const Key('more-details-toggle')));
      await settle(tester);
      expect(labelsShown(tester), isEmpty);
    });

    testWidgets('On call keeps how far Call coming opened it; another call starts closed', (tester) async {
      await pumpStation(tester, station(phase: AgentPhase.reserved, call: call(facts: chosen(rows), priorAttempts: const [])), size: const Size(390, 2400));
      await pushDown(tester);
      await pumpStation(
        tester,
        station(phase: AgentPhase.onCall, call: call(facts: chosen(rows), priorAttempts: const [], bridgedAt: DateTime(2026, 11, 24, 10))),
        size: const Size(390, 2400),
      );
      expect(labelsShown(tester), hasLength(moreDetailsStep));
      await pumpStation(
        tester,
        station(phase: AgentPhase.onCall, call: call(attemptId: 'a2', facts: chosen(rows), priorAttempts: const [], bridgedAt: DateTime(2026, 11, 24, 10))),
        size: const Size(390, 2400),
      );
      expect(labelsShown(tester), isEmpty);
    });

    testWidgets('no card when there is nothing more, or from an older server', (tester) async {
      await pumpStation(tester, station(phase: AgentPhase.reserved, call: call(facts: chosen(const []))));
      expect(find.byKey(const Key('more-details-card')), findsNothing);
      await pumpStation(tester, station(phase: AgentPhase.reserved, call: call(facts: chosen(null))));
      expect(find.byKey(const Key('more-details-card')), findsNothing);
    });
  });
}
