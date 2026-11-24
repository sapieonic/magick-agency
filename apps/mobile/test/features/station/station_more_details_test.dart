import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:magick_agency_agent/core/station/station_view.dart';
import 'package:magick_agency_agent/features/station/logic/facts.dart';
import 'package:magick_agency_agent/features/station/parts/more_details_card.dart';
import 'package:magick_agency_agent/features/station/parts/on_call_view.dart';
import 'package:magick_agency_agent/features/station/station_copy.dart';

import 'station_harness.dart';

/// AS20 on the phone: More details under the card on Call coming and On call, the server's
/// `facts.more` minus what the card draws; closed at first with a count; a push down on the page
/// while its end is on screen opens a step at a time (one per drag and per pause), "Show all" and
/// "Hide" (its open state read out); a phone number hidden as the campaign hides numbers; the same
/// call keeps how far it was opened; only Call coming and On call take a push on a page that fits;
/// Mute and Speaker stay above it at large text; the header fits a narrow phone at large text;
/// Details lists the line under the name, then the server's More details, when the server sends them.
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

  // One drag, and a frame: the fake clock does not move, so the next drag is within the pause.
  Future<void> dragOnce(WidgetTester tester) async {
    await tester.drag(find.byType(SingleChildScrollView).first, const Offset(0, -400));
    await tester.pump();
  }

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

    test('Details puts the line under the name first, in full, from the roster column that holds it', () {
      final facts = FactsView(name: 'Sunita Patil', place: 'Value 2', tiles: [amount], chosen: true, more: [rows[0], more('Field 2', 'Value 2')]);
      expect([for (final f in detailsOtherFields(call(facts: facts))) '${f.label}=${f.value}'], ['Field 2=Value 2', 'Loan No=LN-4471']);
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
      await dragOnce(tester);
      expect(labelsShown(tester), ['Loan No', 'Alt mobile', 'Tenure', 'Branch']);
      expect(find.text(StationCopy.moreDetailsShown(4, 6)), findsOneWidget);
      await dragOnce(tester);
      expect(labelsShown(tester), hasLength(moreDetailsStep), reason: 'within the pause');
      await tester.pump(moreDetailsPause);
      await pushDown(tester);
      expect(labelsShown(tester), hasLength(6));
      expect(find.byKey(const Key('more-details-hint')), findsNothing);
      expect(find.text(StationCopy.moreDetailsHide), findsOneWidget);
    });

    testWidgets('a push while its end is off screen opens nothing', (tester) async {
      await pumpStation(tester, station(phase: AgentPhase.reserved, call: call(facts: chosen(rows), priorAttempts: const [])), size: const Size(390, 520));
      final view = find.byType(SingleChildScrollView).first;
      final position = tester.state<ScrollableState>(find.descendant(of: view, matching: find.byType(Scrollable)).first).position;
      await tester.drag(view, const Offset(0, -60));
      await tester.pump();
      // The page really moved down, and More details' end is still below the visible part.
      expect(position.pixels, greaterThan(0));
      expect(tester.getRect(find.byKey(const Key('more-details-card'))).bottom, greaterThan(tester.getRect(view).bottom));
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

    testWidgets('after Hide a push opens nothing until Show all; drawn again it is still held', (tester) async {
      await pumpStation(tester, station(phase: AgentPhase.reserved, call: call(facts: chosen(rows), priorAttempts: const [])), size: const Size(390, 2400));
      await tester.tap(find.byKey(const Key('more-details-toggle')));
      await settle(tester);
      await tester.tap(find.byKey(const Key('more-details-toggle')));
      await settle(tester);
      await pushDown(tester);
      expect(labelsShown(tester), isEmpty);
      await pumpStation(
        tester,
        station(phase: AgentPhase.onCall, call: call(facts: chosen(rows), priorAttempts: const [], bridgedAt: DateTime(2026, 11, 24, 10))),
        size: const Size(390, 2400),
      );
      await pushDown(tester);
      expect(labelsShown(tester), isEmpty);
      await tester.tap(find.byKey(const Key('more-details-toggle')));
      await settle(tester);
      expect(labelsShown(tester), hasLength(6));
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

    testWidgets('one long, slow drag opens one step, however long the finger stays down', (tester) async {
      await pumpStation(tester, station(phase: AgentPhase.reserved, call: call(facts: chosen(rows), priorAttempts: const [])), size: const Size(390, 2400));
      await tester.timedDrag(find.byType(SingleChildScrollView).first, const Offset(0, -1200), const Duration(seconds: 2));
      await tester.pump();
      expect(labelsShown(tester), hasLength(moreDetailsStep));
    });

    testWidgets('the toggle tells a screen reader whether the list is open', (tester) async {
      final semantics = tester.ensureSemantics();
      await pumpStation(tester, station(phase: AgentPhase.reserved, call: call(facts: chosen(rows), priorAttempts: const [])), size: const Size(390, 2400));
      final toggle = find.byKey(const Key('more-details-toggle'));
      expect(tester.getSemantics(toggle), isSemantics(isButton: true, hasExpandedState: true, isExpanded: false));
      await tester.tap(toggle);
      await settle(tester);
      expect(tester.getSemantics(toggle), isSemantics(isButton: true, hasExpandedState: true, isExpanded: true));
      semantics.dispose();
    });

    testWidgets('at large text on a narrow phone the header fits: the button goes under the title', (tester) async {
      await pumpStation(
        tester,
        station(phase: AgentPhase.reserved, call: call(facts: chosen(rows), priorAttempts: const [])),
        size: const Size(320, 2400),
        textScale: 2,
      );
      expect(tester.takeException(), isNull);
      final title = tester.getRect(find.byKey(const Key('more-details-title')));
      final toggle = tester.getRect(find.byKey(const Key('more-details-toggle')));
      expect(title.width, greaterThan(150));
      expect(toggle.top, greaterThanOrEqualTo(title.bottom));
    });

    testWidgets('only the screens with More details take a push on a page that fits', (tester) async {
      ScrollPhysics? physics() => tester.widget<SingleChildScrollView>(find.byType(SingleChildScrollView).first).physics;
      await pumpStation(tester, station(phase: AgentPhase.reserved, call: call(facts: chosen(rows), priorAttempts: const [])));
      expect(physics(), isA<AlwaysScrollableScrollPhysics>());
      await pumpStation(tester, station(phase: AgentPhase.available));
      expect(physics(), isNull);
    });

    testWidgets('at large text On call, Mute and Speaker sit above More details, which never pushes them away', (tester) async {
      await pumpStation(
        tester,
        station(phase: AgentPhase.onCall, call: call(facts: chosen(rows), priorAttempts: const [], bridgedAt: DateTime(2026, 11, 24, 10))),
        size: const Size(360, 640),
        textScale: 2,
      );
      final controls = tester.getRect(find.byType(ControlRow).first);
      final card = tester.getRect(find.byKey(const Key('more-details-card')));
      expect(controls.bottom, lessThanOrEqualTo(card.top));
    });

    testWidgets('no card when there is nothing more, or from an older server', (tester) async {
      await pumpStation(tester, station(phase: AgentPhase.reserved, call: call(facts: chosen(const []))));
      expect(find.byKey(const Key('more-details-card')), findsNothing);
      await pumpStation(tester, station(phase: AgentPhase.reserved, call: call(facts: chosen(null))));
      expect(find.byKey(const Key('more-details-card')), findsNothing);
    });
  });
}
