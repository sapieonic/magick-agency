import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:magick_agency_agent/core/station/station_view.dart';
import 'package:magick_agency_agent/features/station/station_copy.dart';

import 'station_harness.dart';

/// AS19 on the inbound call (S3, S4, S12): a caller matched on a campaign that chose its card's
/// facts gets the chosen card, as a campaign call and the console's inbound card do (the
/// supervisor's names, values by type, a phone fact hidden by the station's number setting); a
/// nameless one is "Customer" with the number under it; the summary's facts follow the same rules;
/// and Details stays open as the caller connects. The view comes from the station core
/// (`station_facts_chosen_test.dart` covers how it is built); these render it.
void main() {
  const amount = FactTileView(
    label: 'Amount due',
    column: 'Amount Due',
    raw: '12500',
    kind: FactKind.money,
    parsed: '12500',
    key: 'amount_due',
    highlight: true,
    amountDue: true,
  );
  const alt = FactTileView(
    label: 'Other number',
    column: 'Alt Phone',
    raw: '9876543210',
    kind: FactKind.phone,
    parsed: '9876543210',
    key: 'alt_phone',
  );

  InboundCallView caller({
    InboundStage stage = InboundStage.offered,
    String? name = 'Sunita Patil',
    FactsView? facts = const FactsView(name: 'Sunita Patil', place: 'Nashik', tiles: [amount, alt], chosen: true),
    String callId = 'ib-1',
  }) =>
      InboundCallView(
        callId: callId,
        stage: stage,
        fromE164: '+918765432109',
        toE164: '+912071234500',
        routeName: 'Pune customer line',
        displayName: name,
        callerDnc: false,
        recording: false,
        waitedSeconds: 12,
        campaignName: 'EMI — Nashik',
        campaignId: 'c-nashik',
        contactState: 'Waiting to be called',
        heroFields: const [
          ContactField(key: 'Customer Name', label: 'Customer Name', value: 'Sunita Patil'),
          ContactField(key: 'Amount Due', label: 'Amount Due', value: '12500'),
          ContactField(key: 'Alt Phone', label: 'Alt Phone', value: '98••• ••210'),
        ],
        heroesConfigured: true,
        catalogKind: InboundCatalogKind.campaign,
        connectsAt: stage == InboundStage.offered ? t0.add(const Duration(seconds: 2)) : null,
        bridgedAt: stage == InboundStage.offered ? null : t0,
        facts: facts,
      );

  StationView on(InboundCallView call, {bool maskPhone = false}) => StationView(
        campaignId: 'c1',
        campaignName: 'Q4 Card Renewals',
        sessionId: 's1',
        link: StationLink.open,
        phase: switch (call.stage) {
          InboundStage.offered => AgentPhase.reserved,
          InboundStage.connected => AgentPhase.onCall,
          InboundStage.outcome => AgentPhase.wrapup,
        },
        breakOptions: breaks,
        dispositions: dispositions,
        inbound: call,
        maskPhone: maskPhone,
      );

  testWidgets('a chosen campaign\'s caller: the chosen card\'s grid, not the hero fields', (tester) async {
    await pumpStation(tester, on(caller()));
    expect(find.byKey(const Key('fact-grid')), findsOneWidget);
    final grid = find.byKey(const Key('fact-grid'));
    expect(find.descendant(of: grid, matching: find.text('Amount due')), findsOneWidget);
    expect(find.descendant(of: grid, matching: find.text('₹12,500')), findsOneWidget);
    expect(find.descendant(of: grid, matching: find.text('+91 98765 43210')), findsOneWidget);
    expect(find.text('Alt Phone'), findsNothing, reason: 'the supervisor\'s name, not the column');
  });

  testWidgets('the station hides numbers: the phone fact is hidden on the card and in its sheet', (tester) async {
    await pumpStation(tester, on(caller(), maskPhone: true));
    expect(find.descendant(of: find.byKey(const Key('fact-grid')), matching: find.text('98••• ••210')), findsOneWidget);
    expect(find.textContaining('43210'), findsNothing);
    await tester.ensureVisible(find.byKey(const Key('fact-tile-1')));
    await tester.longPress(find.byKey(const Key('fact-tile-1')));
    await settle(tester);
    expect(find.descendant(of: find.byKey(const Key('fact-sheet')), matching: find.text('98••• ••210')), findsOneWidget);
    expect(find.textContaining('43210'), findsNothing);
  });

  testWidgets('a campaign that did not choose shows the hero fields, as before', (tester) async {
    await pumpStation(tester, on(caller(facts: null)));
    expect(find.byKey(const Key('fact-grid')), findsNothing);
    expect(find.text('Alt Phone'), findsOneWidget);
    expect(find.text('98••• ••210'), findsOneWidget, reason: 'hidden by the core, as it came');
  });

  testWidgets('a chosen campaign\'s nameless caller is "Customer", with the number and the first fact under it, and the place', (tester) async {
    await pumpStation(
      tester,
      on(caller(name: null, facts: const FactsView(place: 'Nashik', tiles: [amount], chosen: true)), maskPhone: true),
    );
    expect(tester.widget<Text>(find.byKey(const Key('inbound-caller'))).data, StationCopy.customer);
    // S4, the console's compact line: the number, then the first fact with a value; no "Inbound call".
    expect(tester.widget<Text>(find.byKey(const Key('inbound-caller-line'))).data, '87••• ••109 · Amount due: ₹12,500');
    final place = tester.widget<Text>(find.byKey(const Key('inbound-caller-place')));
    expect(place.data, 'Nashik');
    expect(place.maxLines, 1);
    expect(place.overflow, TextOverflow.ellipsis);
    // A campaign that did not choose leads with the number, as before.
    await pumpStation(tester, on(caller(name: null, facts: null)));
    expect(tester.widget<Text>(find.byKey(const Key('inbound-caller'))).data, '+91 87654 32109');
    expect(tester.widget<Text>(find.byKey(const Key('inbound-caller-line'))).data, InboundCopy.inboundCall);
    expect(find.byKey(const Key('inbound-caller-place')), findsNothing);
  });

  testWidgets('a nameless caller\'s line skips an empty fact, a hidden number hidden; with no fact it is the number alone (S4)', (tester) async {
    const empty = FactTileView(label: 'Due date', column: 'Due Date', raw: '', kind: FactKind.date, key: 'due_date');
    await pumpStation(
      tester,
      on(caller(name: null, facts: const FactsView(tiles: [empty, alt], chosen: true)), maskPhone: true),
    );
    expect(tester.widget<Text>(find.byKey(const Key('inbound-caller-line'))).data, '87••• ••109 · Other number: 98••• ••210');
    expect(find.textContaining('43210'), findsNothing);
    await pumpStation(tester, on(caller(name: null, facts: const FactsView(tiles: [empty], chosen: true))));
    expect(tester.widget<Text>(find.byKey(const Key('inbound-caller-line'))).data, '+91 87654 32109');
    // A named caller keeps "<number> · Inbound call".
    await pumpStation(tester, on(caller()));
    expect(tester.widget<Text>(find.byKey(const Key('inbound-caller-line'))).data, '+91 87654 32109 · ${InboundCopy.inboundCall}');
  });

  testWidgets('on the call, the summary\'s facts are the chosen card\'s, by type, a hidden number hidden', (tester) async {
    await pumpStation(tester, on(caller(stage: InboundStage.connected), maskPhone: true));
    final summary = find.byKey(const Key('inbound-summary'));
    expect(find.descendant(of: summary, matching: find.text('Amount due ₹12,500')), findsOneWidget);
    expect(find.descendant(of: summary, matching: find.text('Other number 98••• ••210')), findsOneWidget);
    expect(find.textContaining('43210'), findsNothing);
  });

  testWidgets('Details stays open as the caller connects, and closes when the call leaves (S12)', (tester) async {
    final h = await pumpStation(tester, on(caller(stage: InboundStage.connected)));
    await tester.tap(find.byKey(const Key('control-details')));
    await settle(tester);
    expect(find.byKey(const Key('inbound-details-sheet')), findsOneWidget);
    await h.setView(on(caller(stage: InboundStage.outcome)));
    await settle(tester);
    expect(find.byKey(const Key('inbound-details-sheet')), findsOneWidget, reason: 'the same caller, now What happened?');
    await h.setView(station(phase: AgentPhase.available));
    await settle(tester);
    expect(find.byKey(const Key('inbound-details-sheet')), findsNothing);
    expect(tester.takeException(), isNull);
  });
}
