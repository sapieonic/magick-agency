import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:magick_agency_agent/core/station/station_view.dart';

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
    await tester.tap(find.byKey(const Key('outcome-ptp')));
    await tester.pump();
    expect(find.byKey(const Key('promise-picker')), findsOneWidget);
    expect(find.text('This outcome needs the date the customer promised to pay.'), findsOneWidget);
    expect(find.text('Saving a promise doesn’t book a call.'), findsOneWidget);

    await tester.ensureVisible(find.byKey(const Key('promise-Tomorrow')));
    await tester.tap(find.byKey(const Key('promise-Tomorrow')));
    await tester.pump();
    await tester.enterText(find.byKey(const Key('promise-amount')), '12500');
    await tester.pump();
    expect(find.text('Promised 1 Nov 2026 · 12,500'), findsOneWidget);

    await tester.ensureVisible(find.byKey(const Key('save-outcome')));
    await tester.tap(find.byKey(const Key('save-outcome')));
    await tester.pump();
    expect(h.actions.args['submitDisposition'], ['ptp', null, null, '2026-11-01', '12500.00']);
  });

  testWidgets('a bad amount blocks the save, with the reason beside it', (tester) async {
    final h = await pumpStation(tester, wrap(), now: DateTime(2026, 10, 31, 11, 20));
    await tester.tap(find.byKey(const Key('outcome-ptp')));
    await tester.pump();
    await tester.ensureVisible(find.byKey(const Key('promise-Today')));
    await tester.tap(find.byKey(const Key('promise-Today')));
    await tester.pump();
    await tester.enterText(find.byKey(const Key('promise-amount')), '1.005');
    await tester.pump();
    expect(find.text('Enter the amount as a number, with up to two decimal places and no commas.'), findsOneWidget);
    await tester.ensureVisible(find.byKey(const Key('save-outcome')));
    await tester.tap(find.byKey(const Key('save-outcome')));
    await tester.pump();
    expect(h.actions.args['submitDisposition'], isNull);
  });

  testWidgets('a follow-up outcome says when we call again', (tester) async {
    await pumpStation(tester, wrap(), now: DateTime(2026, 10, 31, 11, 20));
    await tester.tap(find.byKey(const Key('outcome-ptp_f')));
    await tester.pump();
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
