import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:magick_agency_agent/core/station/script_fill.dart';
import 'package:magick_agency_agent/core/station/station_view.dart';
import 'package:magick_agency_agent/features/station/logic/format.dart';
import 'package:magick_agency_agent/features/station/parts/ringing_view.dart' show factText, factTilesInOrder;
import 'package:magick_agency_agent/features/station/station_copy.dart';

import 'station_harness.dart';

/// Phases 1–2's data on the station's screens (stream F's fields, AS18): the customer's facts and
/// a booked call-later's tag on the card (BE-4, BE-6), the script (BE-8), the masked number (AS9)
/// and the supervisor's tile pictures (BE-13). Each is optional: without it the screen is phase 0's.
void main() {
  const facts = FactsView(
    name: 'Sunita Patil',
    place: 'Nashik',
    tiles: [
      FactTileView(label: 'Customer Name', raw: 'Sunita Patil', kind: FactKind.text),
      FactTileView(label: 'Loan No', raw: 'LN-88213', kind: FactKind.text),
      FactTileView(label: 'Due Date', raw: '20/11/2026', kind: FactKind.date, parsed: '2026-11-20', dueDate: true),
      FactTileView(label: 'Amount Due', raw: '₹12,500.00', kind: FactKind.money, parsed: '12500.00', amountDue: true),
    ],
  );
  const script = ScriptView(
    opening: 'Namaste {name}, I am {agent_name} calling from {campaign_name}.',
    steps: [
      'Tell them the amount due: {amount_due}, due on {due_date}.',
      'Ask when they can pay.',
      'If they agree, confirm the date and the amount.',
      'Thank {name} and end the call.',
    ],
  );

  group('formats', () {
    test('a masked number keeps the first two and last three digits (AS9)', () {
      expect(maskPhone('+919840012345'), '98••• ••345');
      expect(maskPhone('+447700900123'), '44••• ••123');
      expect(maskPhone('+12'), '•••');
      expect(stationPhone('+919840012345', masked: false), '+91 98400 12345');
    });

    test('money as ₹ with Indian grouping, no decimals unless they are not zero; dates as "20 Nov"', () {
      expect(formatRupees('12500.00'), '₹12,500');
      expect(formatRupees('125000.50'), '₹1,25,000.50');
      expect(formatRupees('950'), '₹950');
      expect(formatRupees('n/a'), 'n/a');
      expect(formatFactDate('2026-11-20'), '20 Nov');
      expect(formatFactDate('2026-13-01'), '2026-13-01');
    });

    test('fact tiles: amount due, then due date, then the rest; never the name\'s column; untyped as written', () {
      final tiles = factTilesInOrder(facts);
      expect(tiles.map((t) => t.label), ['Amount Due', 'Due Date', 'Loan No']);
      expect(tiles.map(factText), ['₹12,500', '20 Nov', 'LN-88213']);
      // A money column the server could not read is shown as uploaded.
      expect(factText(const FactTileView(label: 'Dues', raw: 'Rs twelve', kind: FactKind.money)), 'Rs twelve');
    });

    test('script placeholders by the contract\'s rule: unknown ones stay, missing values drop out', () {
      const v = (name: 'Sunita', place: null, amountDue: '₹12,500', dueDate: null, agentName: 'Ravi', campaignName: 'EMI');
      expect(fillScript('Namaste {name}, {agent_name} here. {amount_due} by {due_date}. {loan}', v),
          'Namaste Sunita, Ravi here. ₹12,500 by . {loan}');
    });
  });

  group('the customer card', () {
    testWidgets('the server\'s facts: name, place, ₹ amount due and the due date, then the last call', (tester) async {
      await pumpStation(tester, station(phase: AgentPhase.reserved, call: call(facts: facts)));
      expect(find.text('Sunita Patil'), findsOneWidget);
      expect(find.text('Nashik'), findsOneWidget);
      expect(find.text('₹12,500'), findsOneWidget);
      expect(find.text('20 Nov'), findsOneWidget);
      expect(find.text('28 Oct'), findsOneWidget, reason: 'the last call takes the third tile');
      expect(find.text('LN-88213'), findsNothing, reason: 'three tiles on the phone');
      // The hero fields are not read when the server sent facts.
      expect(find.text('Chennai'), findsNothing);
    });

    testWidgets('a booked call-later coming due is tagged above the name (BE-4)', (tester) async {
      await pumpStation(
        tester,
        station(phase: AgentPhase.reserved, call: call(callback: CallLaterTag(dueAt: DateTime(2026, 10, 31, 15), bookedByMe: true))),
      );
      expect(find.text('Call later · You said you will call at 3:00 PM'), findsOneWidget);
      expect(
        tester.getRect(find.byKey(const Key('call-later-tag'))).bottom,
        lessThanOrEqualTo(tester.getRect(find.byKey(const Key('call-headline'))).top),
      );
      await pumpStation(
        tester,
        station(phase: AgentPhase.reserved, call: call(callback: CallLaterTag(dueAt: DateTime(2026, 10, 31, 15), bookedByMe: false))),
      );
      expect(find.text('Call later · Booked for 3:00 PM'), findsOneWidget);
    });

    testWidgets('a ringing call with a countdown keeps its facts and its tag (the card drops only the countdown)', (tester) async {
      final tag = CallLaterTag(dueAt: DateTime(2026, 10, 31, 15), bookedByMe: true);
      await pumpStation(tester, station(phase: AgentPhase.reserved, call: call(countdown: 25, facts: facts, callback: tag)));
      expect(find.text('Sunita Patil'), findsWidgets);
      expect(find.text('₹12,500'), findsOneWidget);
      expect(find.text('Call later · You said you will call at 3:00 PM'), findsOneWidget);
      expect(find.text('Chennai'), findsNothing, reason: 'the facts, not the hero fields');
    });

    testWidgets('no tag and the hero fields from a server older than the fields', (tester) async {
      await pumpStation(tester, station(phase: AgentPhase.reserved, call: call()));
      expect(find.byKey(const Key('call-later-tag')), findsNothing);
      expect(find.text('Chennai'), findsOneWidget);
    });
  });

  group('the masked number (AS9)', () {
    testWidgets('on the card, and in the band when there is no name', (tester) async {
      await pumpStation(tester, station(phase: AgentPhase.reserved, call: call(), maskPhone: true));
      expect(find.text('98••• ••345'), findsOneWidget);
      expect(find.textContaining('98400 12345'), findsNothing);
      await pumpStation(tester, station(phase: AgentPhase.onCall, call: call(name: null, bridgedAt: t0), maskPhone: true));
      expect(find.text('98••• ••345'), findsWidgets);
      expect(find.textContaining('98400 12345'), findsNothing);
    });

    testWidgets('on the Don\'t call again sheet', (tester) async {
      await pumpStation(
        tester,
        station(phase: AgentPhase.wrapup, call: call(), release: hungUpRelease, wrapup: wrapup(), maskPhone: true),
      );
      await tester.tap(find.byKey(const Key('outcome-dnc')));
      await tester.pump();
      await tester.tap(find.byKey(const Key('save-outcome')));
      await settle(tester);
      expect(find.text('Priya Raman · 98••• ••345'), findsOneWidget);
    });

    testWidgets('in full where the campaign shows it in full', (tester) async {
      await pumpStation(tester, station(phase: AgentPhase.reserved, call: call()));
      expect(find.text('+91 98400 12345'), findsOneWidget);
    });
  });

  group('the script (BE-8)', () {
    testWidgets('Call coming: "First, say this", filled for this customer and agent', (tester) async {
      await pumpStation(tester, station(phase: AgentPhase.reserved, call: call(facts: facts), script: script));
      expect(find.text(StationCopy.firstSayThis), findsOneWidget);
      expect(find.text('“Namaste Sunita Patil, I am Sunita calling from Q4 Card Renewals.”'), findsOneWidget);
    });

    testWidgets('On call: the current step and the next two, "0 of 4 done"; a tap moves on', (tester) async {
      await pumpStation(tester, station(phase: AgentPhase.onCall, call: call(bridgedAt: t0, facts: facts), script: script));
      expect(find.text(StationCopy.whatToSay), findsOneWidget);
      expect(find.text('0 of 4 done'), findsOneWidget);
      expect(find.text('Tell them the amount due: ₹12,500, due on 20 Nov.'), findsOneWidget);
      expect(find.byKey(const Key('script-step-3')), findsNothing, reason: 'the current step and the next two');
      await tester.tap(find.byKey(const Key('script-step-0')));
      await tester.pump();
      expect(find.text('1 of 4 done'), findsOneWidget);
      expect(find.byKey(const Key('script-step-0')), findsNothing);
      expect(find.text('Thank Sunita Patil and end the call.'), findsOneWidget);
      // A tap further down marks everything before it done too.
      await tester.tap(find.byKey(const Key('script-step-3')));
      await tester.pump();
      expect(find.text('4 of 4 done'), findsOneWidget);
      expect(find.text(StationCopy.allStepsDone), findsOneWidget);
      // AS2: the script when there is one, not Last calls; the note stays.
      expect(find.text(StationCopy.lastCalls), findsNothing);
      expect(find.byKey(const Key('notes-field')), findsOneWidget);
    });

    testWidgets('a new call starts the steps afresh', (tester) async {
      final h = await pumpStation(tester, station(phase: AgentPhase.onCall, call: call(bridgedAt: t0), script: script));
      await tester.tap(find.byKey(const Key('script-step-0')));
      await tester.pump();
      expect(find.text('1 of 4 done'), findsOneWidget);
      await h.setView(station(phase: AgentPhase.onCall, call: call(bridgedAt: t0, attemptId: 'a2'), script: script));
      expect(find.text('0 of 4 done'), findsOneWidget);
    });

    testWidgets('without a script: no opening, no steps (04c)', (tester) async {
      await pumpStation(tester, station(phase: AgentPhase.reserved, call: call()));
      expect(find.byKey(const Key('script-opening')), findsNothing);
      await pumpStation(tester, station(phase: AgentPhase.onCall, call: call(bridgedAt: t0)));
      expect(find.byKey(const Key('script-steps')), findsNothing);
      expect(find.text(StationCopy.lastCalls), findsOneWidget);
    });
  });

  group('read aloud (AS13)', () {
    testWidgets('each What happened? tile reads its label, without picking it', (tester) async {
      final h = await pumpStation(tester, station(phase: AgentPhase.wrapup, call: call(), release: hungUpRelease, wrapup: wrapup()));
      await tester.tap(find.byKey(const Key('read-aloud-callback')));
      await tester.pump();
      expect(h.readAloud.said, ['Callback']);
      expect(find.byIcon(Icons.check_circle), findsNothing, reason: 'reading a tile does not pick it');
      expect(find.byKey(const Key('read-aloud-dnc')), findsOneWidget);
    });

    testWidgets('the opening line reads the filled line before the call connects; nothing reads once it is live',
        (tester) async {
      final h = await pumpStation(tester, station(phase: AgentPhase.reserved, call: call(facts: facts), script: script));
      await tester.tap(find.byKey(const Key('read-aloud-opening')));
      await tester.pump();
      expect(h.readAloud.said, ['Namaste Sunita Patil, I am Sunita calling from Q4 Card Renewals.']);
      // The customer is on the line: the phone's speaker could reach them through the microphone.
      await h.setView(station(phase: AgentPhase.reserved, call: call(facts: facts, bridgedAt: t0), script: script));
      expect(find.byKey(const Key('script-opening')), findsOneWidget);
      expect(find.byKey(const Key('read-aloud-opening')), findsNothing);
      await h.setView(station(phase: AgentPhase.onCall, call: call(bridgedAt: t0, facts: facts), script: script));
      expect(find.byKey(const Key('script-steps')), findsOneWidget);
      expect(find.byIcon(Icons.volume_up_outlined), findsNothing);
    });

    testWidgets('every change of screen stops what is being read', (tester) async {
      final h = await pumpStation(tester, station(phase: AgentPhase.reserved, call: call(facts: facts), script: script));
      await tester.tap(find.byKey(const Key('read-aloud-opening')));
      await tester.pump();
      final before = h.readAloud.stops;
      await h.setView(station(phase: AgentPhase.onCall, call: call(bridgedAt: t0, facts: facts), script: script));
      expect(h.readAloud.stops, before + 1, reason: 'Call coming → On call');
      await h.setView(station(phase: AgentPhase.wrapup, call: call(facts: facts), release: hungUpRelease, wrapup: wrapup()));
      expect(h.readAloud.stops, before + 2, reason: 'On call → What happened?');
      await h.setView(station(phase: AgentPhase.wrapup, call: call(facts: facts), release: hungUpRelease, wrapup: wrapup(), notes: const NotesView(text: 'x')));
      expect(h.readAloud.stops, before + 2, reason: 'the same screen does not stop it');
    });

    testWidgets('a phone with no text-to-speech engine or language shows no speaker (hidden, not disabled)', (tester) async {
      await pumpStation(tester, station(phase: AgentPhase.wrapup, call: call(), release: hungUpRelease, wrapup: wrapup()), readAloudAvailable: false);
      expect(find.byKey(const Key('outcome-callback')), findsOneWidget);
      expect(find.byIcon(Icons.volume_up_outlined), findsNothing);
      await pumpStation(tester, station(phase: AgentPhase.reserved, call: call(facts: facts), script: script), readAloudAvailable: false);
      expect(find.byKey(const Key('script-opening')), findsOneWidget);
      expect(find.byIcon(Icons.volume_up_outlined), findsNothing);
    });
  });

  group('the supervisor\'s tile pictures (BE-13)', () {
    testWidgets('an outcome\'s and a break\'s own picture replace the guesses', (tester) async {
      await pumpStation(
        tester,
        station(
          phase: AgentPhase.wrapup,
          call: call(),
          release: hungUpRelease,
          wrapup: wrapup(),
          dispositionOptions: const [
            DispositionOption(code: 'vm', label: 'Voicemail', icon: TilePicture.voicemail),
            DispositionOption(code: 'x', label: 'Other'),
          ],
        ),
      );
      expect(find.byIcon(Icons.voicemail), findsOneWidget);
      expect(find.byIcon(Icons.radio_button_unchecked), findsOneWidget, reason: 'no picture chosen: the guess');
      await pumpStation(tester, station(breakOptions: const [BreakOption(code: 'p', label: 'Namaz', icon: TilePicture.prayer)]));
      await tester.tap(find.byKey(const Key('take-break')));
      await settle(tester);
      expect(find.byIcon(Icons.self_improvement), findsOneWidget);
    });
  });
}