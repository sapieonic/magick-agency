import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:magick_agency_agent/core/station/station_view.dart';
import 'package:magick_agency_agent/features/station/station_copy.dart';
import 'package:magick_agency_agent/features/station/widgets/action_buttons.dart';

import 'station_harness.dart';

/// Promise to pay (PT1–PT3, PT9) on the station screen: the wrap-up's promise
/// picker (date chips, amount, what saving does) and the save it feeds, and
/// the contact's promise shown when the agent reaches them.
void main() {
  const options = [
    DispositionOption(code: 'interested', label: 'Interested', isSuccess: true),
    DispositionOption(code: 'ptp', label: 'Promised to pay', requiresPromise: true),
    DispositionOption(code: 'ptp_f', label: 'Promised, call after', requiresPromise: true, promiseFollowUpDays: 3),
  ];

  StationView wrap() => station(
    phase: AgentPhase.wrapup,
    call: call(bridgedAt: t0.subtract(const Duration(minutes: 3))),
    release: hungUpRelease,
    wrapup: wrapup(),
    dispositionOptions: options,
  );

  testWidgets('a promise outcome asks for the date, then sends it with the amount', (tester) async {
    final h = await pumpStation(tester, wrap(), now: DateTime(2026, 10, 31, 11, 20));
    expect(find.byKey(const Key('promise-picker')), findsNothing);
    // Picking it opens the follow-up sheet (design-spec §4): the date is needed, the amount is not.
    await tester.tap(find.byKey(const Key('outcome-ptp')));
    await settle(tester);
    expect(find.byKey(const Key('follow-up-sheet')), findsOneWidget);
    expect(find.byKey(const Key('promise-picker')), findsOneWidget);
    expect(find.text('Saving a promise doesn’t book a call.'), findsOneWidget);
    expect(tester.widget<MainActionButton>(find.byKey(const Key('follow-up-ok'))).onPressed, isNull);

    await tester.ensureVisible(find.byKey(const Key('promise-Tomorrow')));
    await tester.tap(find.byKey(const Key('promise-Tomorrow')));
    await tester.pump();
    await tester.enterText(find.byKey(const Key('promise-amount')), '12500');
    await tester.pump();
    expect(find.text('Promised 1 Nov 2026 · 12,500'), findsOneWidget);
    await tester.ensureVisible(find.byKey(const Key('follow-up-ok')));
    await tester.tap(find.byKey(const Key('follow-up-ok')));
    await settle(tester);
    // One summary row: "Will pay on Sun 1 Nov · 12,500 · Change".
    expect(find.text('Will pay on Sun 1 Nov · 12,500'), findsOneWidget);

    await tester.tap(find.byKey(const Key('save-outcome')));
    await tester.pump();
    expect(h.actions.args['submitDisposition'], ['ptp', null, null, '2026-11-01', '12500.00']);
  });

  testWidgets('a bad amount blocks the save, with the reason beside it', (tester) async {
    final h = await pumpStation(tester, wrap(), now: DateTime(2026, 10, 31, 11, 20));
    await tester.tap(find.byKey(const Key('outcome-ptp')));
    await settle(tester);
    await tester.ensureVisible(find.byKey(const Key('promise-Today')));
    await tester.tap(find.byKey(const Key('promise-Today')));
    await tester.pump();
    await tester.enterText(find.byKey(const Key('promise-amount')), '1.005');
    await tester.pump();
    expect(find.text(StationCopy.amountNotRight), findsOneWidget);
    expect(tester.widget<MainActionButton>(find.byKey(const Key('follow-up-ok'))).onPressed, isNull);
    await tester.ensureVisible(find.byKey(const Key('follow-up-back')));
    await tester.tap(find.byKey(const Key('follow-up-back')));
    await settle(tester);
    await tester.tap(find.byKey(const Key('save-outcome')));
    await tester.pump();
    expect(h.actions.args['submitDisposition'], isNull);
  });

  testWidgets('the date picker reaches 31 days ahead, as the rule does (a customer a day ahead)', (tester) async {
    await pumpStation(tester, wrap(), now: DateTime(2026, 10, 31, 11, 20));
    await tester.tap(find.byKey(const Key('outcome-ptp')));
    await settle(tester);
    await tester.ensureVisible(find.byKey(const Key('promise-pick')));
    await tester.tap(find.byKey(const Key('promise-pick')));
    await tester.pumpAndSettle();
    final dialog = tester.widget<DatePickerDialog>(find.byType(DatePickerDialog));
    expect(dialog.firstDate, DateTime(2026, 10, 30));
    expect(dialog.lastDate, DateTime(2026, 12, 1));
  });

  testWidgets('a follow-up outcome says when we call again', (tester) async {
    await pumpStation(tester, wrap(), now: DateTime(2026, 10, 31, 11, 20));
    await tester.tap(find.byKey(const Key('outcome-ptp_f')));
    await settle(tester);
    expect(find.text('We’ll call again 3 days after this date, in calling hours.'), findsOneWidget);
  });

  testWidgets('the contact\'s promise is under their name, and on the attempt that recorded it', (tester) async {
    await pumpStation(
      tester,
      station(
        phase: AgentPhase.onCall,
        call: call(
          bridgedAt: t0.subtract(const Duration(seconds: 40)),
          promise: const PromiseView(text: 'Promised 18 Nov 2026 · 12,500', state: PromiseStanding.dueToday),
          priorAttempts: [
            PriorAttempt(
              at: DateTime(2026, 11, 10, 9, 30),
              outcomeLabel: 'Promised to pay',
              promise: 'Promised 18 Nov 2026 · 12,500',
            ),
          ],
        ),
      ),
    );
    expect(find.byKey(const Key('contact-promise')), findsOneWidget);
    expect(find.text('Due today'), findsOneWidget);
  });
}
