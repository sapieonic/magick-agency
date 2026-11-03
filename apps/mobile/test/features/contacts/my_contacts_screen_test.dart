import 'package:agency_wire/agency_wire.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:magick_agency_agent/core/station/station_view.dart';
import 'package:magick_agency_agent/features/contacts/my_contacts_copy.dart';
import 'package:magick_agency_agent/features/contacts/my_contacts_screen.dart';

import 'support.dart';

void main() {
  late FakeMyContactsApi api;

  final rows = [
    contact(1, eligible: true, hero: const [HeroField(name: 'Name', value: 'Asha Rao'), HeroField(name: 'Loan', value: 'LN-2201')]),
    contact(2, bucket: MyContactBucket.callback, grant: grant(extra: 3, early: true)),
    contact(3, bucket: MyContactBucket.reached, state: ContactState.completed, blocked: AgentRetryBlock.notRetryable),
    contact(4, grant: grant(hours: true), next: fixedNow.subtract(const Duration(minutes: 5))),
  ];

  setUp(() {
    api = FakeMyContactsApi()..autoPage = contactsPage(rows);
  });

  Future<ProviderContainer> pump(WidgetTester tester, {bool flag = true, StationView? station, double textScale = 1, Size? size}) async {
    // Tall by default, so every row of the short list is built (the list is lazy).
    tester.view.physicalSize = (size ?? const Size(390, 1800)) * 3;
    tester.view.devicePixelRatio = 3;
    addTearDown(tester.view.reset);
    await tester.pumpWidget(
      harness(
        const MyContactsScreen(campaignId: 'c1'),
        [
          ...contactsOverrides(api, flag: flag),
          if (station != null) stationHolder.overrideWith(() => StationHolder(station)),
        ],
        textScale: textScale,
      ),
    );
    await tester.pumpAndSettle();
    return ProviderScope.containerOf(tester.element(find.byType(MyContactsScreen)));
  }

  testWidgets('with the flag off it says so and reads nothing', (tester) async {
    await pump(tester, flag: false);
    expect(find.byKey(const Key('my-contacts-off')), findsOneWidget);
    expect(api.summaries, isEmpty);
    expect(api.queries, isEmpty);
  });

  testWidgets('the counts, the queue, and every contact with its number, hero fields and override', (tester) async {
    await pump(tester);
    expect(find.text('${MyContactsCopy.total}: 30'), findsOneWidget);
    expect(find.text('${MyContactsCopy.dueNow}: 0'), findsOneWidget);
    for (final label in ['Pending 12', 'Callbacks 2', 'Not reached 5', 'Reached 7', 'Exhausted 3', 'DNC 1']) {
      expect(find.text(label), findsOneWidget, reason: label);
    }
    expect(find.text('On a call 0'), findsNothing, reason: 'shown only when someone is on a call');
    expect(find.byKey(const Key('summary-queue')), findsOneWidget);
    expect(find.textContaining('Nothing due now. Your contacts are scheduled for another try.'), findsOneWidget);
    expect(find.text('+91 98400 10001'), findsOneWidget);
    expect(find.text('Asha Rao · LN-2201'), findsOneWidget);
    expect(find.byKey(const Key('override-k2')), findsOneWidget);
    expect(find.text('+3 tries · Call early'), findsOneWidget);
    expect(find.byKey(const Key('my-contacts-end')), findsOneWidget);
  });

  testWidgets('Call shows only on contacts that may be called, while on duty and available here', (tester) async {
    await pump(tester);
    expect(find.byKey(const Key('call-k1')), findsOneWidget, reason: 'retry eligible');
    expect(find.byKey(const Key('call-k2')), findsOneWidget, reason: 'may call early');
    expect(find.byKey(const Key('call-k3')), findsNothing, reason: 'reached');
    expect(find.byKey(const Key('call-k4')), findsOneWidget, reason: 'due now');
    expect(find.byKey(const Key('call-gate')), findsNothing);
  });

  testWidgets('a paused campaign: no Call, and the screen says why', (tester) async {
    await pump(tester, station: onStation(dialing: false));
    expect(find.byKey(const Key('call-k1')), findsNothing);
    expect(find.byKey(const Key('call-k4')), findsNothing);
    expect(find.text(MyContactsCopy.callNeedsRunning), findsOneWidget);
  });

  testWidgets('off duty: no Call, and the screen says how to get one', (tester) async {
    await pump(tester, station: onStation(phase: AgentPhase.onBreak));
    expect(find.byKey(const Key('call-k1')), findsNothing);
    expect(find.text(MyContactsCopy.callNeedsAvailable), findsOneWidget);
  });

  testWidgets('Call places the call and says so', (tester) async {
    await pump(tester);
    await tester.tap(find.byKey(const Key('call-k1')));
    await tester.pumpAndSettle();
    expect(api.calls.single.$1, 'k1');
    expect(find.text(MyContactsCopy.callPlaced), findsOneWidget);
  });

  testWidgets('outside hours with the override: the note is asked for, checked, and sent', (tester) async {
    api.callAnswers.add(noteWanted());
    await pump(tester);
    await tester.tap(find.byKey(const Key('call-k4')));
    await tester.pumpAndSettle();
    expect(find.text(MyContactsCopy.noteTitle), findsOneWidget);
    expect(find.textContaining('“promise_to_pay”'), findsOneWidget);
    final confirm = find.byKey(const Key('override-note-confirm'));
    expect(tester.widget<FilledButton>(confirm).onPressed, isNull);
    await tester.enterText(find.byKey(const Key('override-note')), 'short');
    await tester.pump();
    expect(find.text(MyContactsCopy.noteTooShort), findsOneWidget);
    await tester.enterText(find.byKey(const Key('override-note')), 'Customer asked for a call after 9pm.');
    await tester.pump();
    await tester.tap(confirm);
    await tester.pumpAndSettle();
    expect(api.calls, hasLength(2));
    expect(api.calls[1].$2.overrideNote, 'Customer asked for a call after 9pm.');
    expect(find.text(MyContactsCopy.callPlaced), findsOneWidget);
  });

  testWidgets('a refused call is said in the app’s words', (tester) async {
    api.callAnswers.add(refusal('dnc_listed'));
    await pump(tester);
    await tester.tap(find.byKey(const Key('call-k1')));
    await tester.pumpAndSettle();
    expect(find.text('This number is on the Do Not Call list. It can’t be called.'), findsOneWidget);
  });

  testWidgets('Retry not reached (N) asks first, then reopens them', (tester) async {
    await pump(tester);
    expect(find.text(MyContactsCopy.retryAll(3)), findsOneWidget);
    await tester.tap(find.byKey(const Key('retry-all')));
    await tester.pumpAndSettle();
    expect(find.text(MyContactsCopy.retryTitle), findsOneWidget);
    expect(api.retries, isEmpty, reason: 'nothing until confirmed');
    await tester.tap(find.byKey(const Key('retry-confirm')));
    await tester.pumpAndSettle();
    expect(api.retries.single.all, isTrue);
    expect(find.text('Reopened 3 contacts. They’ll be dialled in turn.'), findsOneWidget);
  });

  testWidgets('no Retry not reached and no picking while something is due', (tester) async {
    api.summaryAnswer = summaryOf(dueNow: 2);
    await pump(tester);
    expect(find.byKey(const Key('retry-all')), findsNothing);
    expect(find.byKey(const Key('select-k1')), findsNothing, reason: 'the console offers retry once nothing is due');
    expect(find.text(MyContactsCopy.selectHint), findsNothing);
  });

  testWidgets('retry is off: no picking and no retry', (tester) async {
    api.summaryAnswer = summaryOf(retryAllowed: false);
    await pump(tester);
    expect(find.byKey(const Key('retry-all')), findsNothing);
    expect(find.byKey(const Key('select-k1')), findsNothing);
  });

  testWidgets('picking contacts offers Retry selected (k) for just those', (tester) async {
    await pump(tester);
    expect(find.byKey(const Key('select-k2')), findsNothing, reason: 'only an eligible contact can be picked');
    await tester.tap(find.byKey(const Key('select-k1')));
    await tester.pump();
    expect(find.text(MyContactsCopy.retrySelected(1)), findsOneWidget);
    expect(find.byKey(const Key('retry-all')), findsNothing);
    await tester.tap(find.byKey(const Key('retry-selected')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('retry-confirm')));
    await tester.pumpAndSettle();
    expect(api.retries.single.contactIds, ['k1']);
  });

  testWidgets('a bucket chip filters the list; All clears it', (tester) async {
    await pump(tester);
    await tester.tap(find.byKey(const Key('bucket-callback')));
    await tester.pumpAndSettle();
    expect(api.queries.last.toQuery()['bucket'], 'callback');
    await tester.tap(find.byKey(const Key('bucket-all')));
    await tester.pumpAndSettle();
    expect(api.queries.last.toQuery().containsKey('bucket'), isFalse);
  });

  testWidgets('a count filters to its bucket', (tester) async {
    await pump(tester);
    await tester.tap(find.byKey(const Key('count-exhausted')));
    await tester.pumpAndSettle();
    expect(api.queries.last.toQuery()['bucket'], 'exhausted');
  });

  testWidgets('the number search applies after a pause, as digits', (tester) async {
    await pump(tester);
    await tester.enterText(find.byKey(const Key('contacts-phone-search')), '98400 1');
    await tester.pump(const Duration(milliseconds: 200));
    final before = api.queries.length;
    await tester.pump(const Duration(milliseconds: 300));
    await tester.pumpAndSettle();
    expect(api.queries.length, before + 1);
    expect(api.queries.last.toQuery()['phone'], '984001');
    await tester.enterText(find.byKey(const Key('contacts-phone-search')), 'abc');
    await tester.pump();
    expect(find.text(MyContactsCopy.searchProblem), findsOneWidget);
  });

  testWidgets('fits a 360×640 phone at 200% text', (tester) async {
    await pump(tester, size: const Size(360, 640), textScale: 2);
    expect(tester.takeException(), isNull);
    expect(find.text(MyContactsCopy.title), findsOneWidget);
  });
}
