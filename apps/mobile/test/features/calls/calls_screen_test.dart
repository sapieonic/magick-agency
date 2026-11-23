import 'package:agency_wire/agency_wire.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:magick_agency_agent/app/routes.dart';
import 'package:magick_agency_agent/app/theme/app_theme.dart';
import 'package:magick_agency_agent/app/theme/tokens.dart';
import 'package:magick_agency_agent/core/api/api_error.dart';
import 'package:magick_agency_agent/core/softphone/softphone_view.dart';
import 'package:magick_agency_agent/core/station/station_signals.dart';
import 'package:magick_agency_agent/features/calls/calls_screen.dart';

import '../../core/auth/support/harness.dart' show testSignalsProvider;
import '../softphone/softphone_harness.dart' show FakeSoftphoneActions;
import 'support.dart';

/// My calls on screen (docs/call-log.md §7): the chips with To follow up
/// first and its badge, the cards of every type, a number the server hid
/// shown as it arrived, To follow up's two parts and its actions, and that
/// Call back reads the number only when it is pressed.
void main() {
  late FakeMyCallsApi api;
  late FakeMissedCallsApi missed;
  late FakeSoftphoneActions actions;

  const phoneOn = SoftphoneAvailability(visible: true, startAllowed: true, loaded: true);
  const owed = MyCallsCounts(toFollowUp: 3, missedOpen: 2, callbacksDue: 1);

  final answered = myCall('i1', {
    'type': 'inbound',
    'customer_name': 'Sunita Deshmukh',
    'phone': '97••• ••821',
    'phone_masked': true,
    'outcome': 'answered',
    'disposition_code': 'will_pay',
    'disposition_label': 'Will pay',
    'promise_date': '2026-11-25',
    'talk_seconds': 252,
    'attempt_number': null,
    'created_at': '2026-10-14T04:42:00.000Z',
  });
  final soft = myCall('s1', {
    'type': 'soft_phone',
    'customer_name': null,
    'campaign_id': null,
    'campaign_name': null,
    'outcome': 'no_answer',
    'disposition_code': null,
    'disposition_label': null,
    'talk_seconds': null,
    'attempt_number': null,
  });
  final dial = myCall('d1', {'notes': 'Asked for the EMI letter'});

  setUp(() {
    api = FakeMyCallsApi();
    missed = missedInStep();
    actions = FakeSoftphoneActions();
    api.auto = (query) => switch (query.type) {
          MyCallsTypeFilter.toFollowUp => myCallsPage(
              [missedRow('m1'), missedRow('m2', {'phone': '+918765432109', 'phone_masked': false, 'customer_name': 'Vikram Patil'})],
              counts: owed,
              callbacks: [callbackDue('k9', DateTime.utc(2026, 10, 14, 2, 45))],
            ),
          MyCallsTypeFilter.dialler => myCallsPage([dial], counts: owed),
          _ => myCallsPage([answered, soft, dial], counts: owed),
        };
  });

  Future<void> open(
    WidgetTester tester, {
    SoftphoneAvailability availability = phoneOn,
    bool inboundOn = true,
  }) async {
    await setPhoneSize(tester);
    tester.view.physicalSize = const Size(1080, 9000); // every card built
    final router = GoRouter(
      initialLocation: Routes.calls,
      routes: [
        GoRoute(path: Routes.calls, builder: (_, _) => const CallsScreen()),
        GoRoute(path: Routes.phone, builder: (_, s) => Scaffold(body: Text('at ${s.uri}'))),
        GoRoute(path: Routes.stationPattern, builder: (_, s) => Scaffold(body: Text('at ${s.uri}'))),
      ],
    );
    addTearDown(router.dispose);
    final container = ProviderContainer.test(overrides: [
      ...myCallsOverrides(api, missed, inboundOn: inboundOn),
      softphoneAvailabilityProvider.overrideWithValue(availability),
      softphoneActionsProvider.overrideWithValue(actions),
      softphoneViewProvider.overrideWithValue(const SoftphoneView(screen: SoftphoneScreenActive())),
      stationSignalsProvider.overrideWith((ref) => ref.watch(testSignalsProvider)),
    ]);
    await tester.pumpWidget(UncontrolledProviderScope(
      container: container,
      child: MaterialApp.router(theme: buildTheme(AppTokens.dark, Brightness.dark), routerConfig: router),
    ));
    await flush(tester);
    await flush(tester);
  }

  String text(WidgetTester tester, String key) => tester.widget<Text>(find.byKey(Key(key))).data!;
  Future<void> choose(WidgetTester tester, String chip) async {
    await tester.tap(find.byKey(Key('calls-chip-$chip')));
    await flush(tester);
    await flush(tester);
  }

  testWidgets('chips in place of the segments: To follow up first with what is owed, then All and the types', (tester) async {
    await open(tester);
    final chips = tester.widgetList<ChoiceChip>(find.byType(ChoiceChip)).map((c) => (c.key! as ValueKey<String>).value).toList();
    expect(chips, ['calls-chip-to_follow_up', 'calls-chip-all', 'calls-chip-dialler', 'calls-chip-soft_phone', 'calls-chip-inbound']);
    expect(tester.widget<ChoiceChip>(find.byKey(const Key('calls-chip-all'))).selected, isTrue);
    final badge = tester.widget<Badge>(find.byKey(const Key('calls-follow-up-badge')));
    expect((badge.label! as Text).data, '3');
    expect(find.byType(SegmentedButton<Object>), findsNothing);
    expect(api.q(0), {'limit': '50', 'include_counts': '1'});
  });

  testWidgets('a card for every type: the type and time, who, then campaign, outcome and talk time', (tester) async {
    await open(tester);
    expect(text(tester, 'my-call-type-i1'), 'Inbound');
    expect(text(tester, 'my-call-who-i1'), 'Sunita Deshmukh');
    expect(text(tester, 'my-call-meta-i1'), 'Diwali EMI Collections · Will pay · 25 Nov · 4:12');
    expect(text(tester, 'my-call-type-s1'), 'Soft phone');
    expect(text(tester, 'my-call-meta-s1'), 'No campaign · No answer');
    expect(text(tester, 'my-call-type-d1'), 'Dialler · Try 1');
    expect(text(tester, 'my-call-notes-d1'), 'Asked for the EMI letter');
    expect(find.text('Showing 3 calls'), findsOneWidget);
    // No way to a recording: an agent does not hear recordings.
    expect(find.textContaining('Recording'), findsNothing);
  });

  testWidgets('a number its campaign hides is shown as it arrived; one in full is grouped', (tester) async {
    await open(tester);
    expect(text(tester, 'my-call-number-i1'), '97••• ••821');
    expect(text(tester, 'my-call-who-s1'), '+91 98400 10001');
    expect(missed.queries, isEmpty, reason: 'showing the list reads no number from anywhere else');
  });

  testWidgets('a chip reads that type', (tester) async {
    await open(tester);
    await choose(tester, 'dialler');
    // What is owed does not depend on the chip: the counts held are not asked for again.
    expect(api.queries.last.toQuery(), {'type': 'dialler', 'limit': '50'});
    expect(find.byKey(const Key('my-call-type-i1')), findsNothing);
    expect(find.byKey(const Key('my-call-type-d1')), findsOneWidget);
  });

  testWidgets('To follow up: my open missed calls with their actions, then the callbacks due', (tester) async {
    await open(tester);
    await choose(tester, 'to_follow_up');
    expect(text(tester, 'my-call-type-m1'), 'Inbound · missed');
    expect(text(tester, 'my-call-who-m1'), '98••• ••730');
    expect(text(tester, 'my-call-meta-m1'), 'General enquiries · nobody free to answer · waited 1:40');
    expect(find.byKey(const Key('my-call-back-m1')), findsOneWidget);
    expect(find.byKey(const Key('my-call-handled-m1')), findsOneWidget);
    expect(find.text('Callbacks due'), findsOneWidget);
    expect(find.text('Callback due'), findsOneWidget);
    expect(text(tester, 'my-callback-due-k9'), 'Late by 2 hours');
    expect(find.text('Diwali EMI Collections · you booked it for 2:45 AM'), findsOneWidget);
    // The Missed list (the team's calls to claim, voicemails) is one tap away.
    expect(find.byKey(const Key('calls-open-missed-list')), findsOneWidget);
  });

  testWidgets('nobody waiting: the proposal\'s words', (tester) async {
    api.auto = (_) => myCallsPage(const [], callbacks: const []);
    await open(tester);
    // Nothing is owed, but Missed calls are on, so the chip is offered.
    await choose(tester, 'to_follow_up');
    expect(find.text('Nobody is waiting for a call from you.'), findsOneWidget);
    expect(find.byKey(const Key('calls-follow-up-badge')), findsNothing);
  });

  testWidgets('Mark handled is the Missed list\'s action, and the list is read again', (tester) async {
    await open(tester);
    await choose(tester, 'to_follow_up');
    final reads = api.queries.length;
    await tester.tap(find.byKey(const Key('my-call-handled-m1')));
    await flush(tester);
    await flush(tester);
    expect(missed.handled, ['m1']);
    expect(api.queries.length, reads + 1);
  });

  testWidgets('Call back reads that Missed row by its id when pressed, hands the number to the soft phone and dials nothing', (tester) async {
    missed.oneAnswer = missed_('m1');
    await open(tester);
    await choose(tester, 'to_follow_up');
    expect(missed.read, isEmpty);
    await tester.tap(find.byKey(const Key('my-call-back-m1')));
    await tester.pumpAndSettle();
    expect(missed.read, ['m1']);
    expect(missed.queries, isEmpty, reason: 'never a page of the Missed list');
    expect(actions.calls, ['callBack'], reason: 'only the hand-off: the screen dials nothing itself');
    // The missed call's id goes with the number: the call placed is its call back (CL1).
    expect(actions.args['callBack'], ['+918765432109', 'camp-1', 'm1']);
    expect(find.text('at /phone'), findsOneWidget);
  });

  testWidgets('a Call back whose number cannot be read says so on the card and goes nowhere', (tester) async {
    missed.oneAnswer = const ApiNetworkError('offline');
    await open(tester);
    await choose(tester, 'to_follow_up');
    await tester.tap(find.byKey(const Key('my-call-back-m1')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('my-call-error-m1')), findsOneWidget);
    expect(actions.calls, isEmpty);
    expect(find.text('at /phone'), findsNothing);
  });

  testWidgets('no Call back without the soft phone; Mark handled stays', (tester) async {
    await open(tester, availability: SoftphoneAvailability.hidden);
    await choose(tester, 'to_follow_up');
    expect(find.byKey(const Key('my-call-back-m1')), findsNothing);
    expect(find.byKey(const Key('my-call-handled-m1')), findsOneWidget);
    // And no Soft phone chip where the Phone tab does not show.
    expect(find.byKey(const Key('calls-chip-soft_phone')), findsNothing);
  });

  testWidgets('without Missed calls and with nothing owed: All and Dialler only', (tester) async {
    missed.countAnswer = forbidden;
    api.auto = (_) => myCallsPage([dial]);
    await open(tester, availability: SoftphoneAvailability.hidden);
    final chips = tester.widgetList<ChoiceChip>(find.byType(ChoiceChip)).map((c) => (c.key! as ValueKey<String>).value).toList();
    expect(chips, ['calls-chip-all', 'calls-chip-dialler']);
  });

  testWidgets('a callback owed keeps To follow up, whatever Missed calls say', (tester) async {
    missed.countAnswer = forbidden;
    api.auto = (_) => myCallsPage([dial], counts: const MyCallsCounts(toFollowUp: 1, missedOpen: 0, callbacksDue: 1));
    await open(tester);
    expect(find.byKey(const Key('calls-chip-to_follow_up')), findsOneWidget);
    expect(find.byKey(const Key('calls-chip-inbound')), findsNothing);
  });

  testWidgets('a failed first page says so and can be tried again', (tester) async {
    api.auto = null;
    await open(tester);
    expect(find.byKey(const Key('calls-skeleton')), findsOneWidget);
    api.fail(0);
    await flush(tester);
    expect(find.byKey(const Key('calls-error')), findsOneWidget);
    api.auto = (_) => myCallsPage([dial]);
    await tester.tap(find.text('Try again'));
    await flush(tester);
    await flush(tester);
    expect(find.byKey(const Key('my-call-type-d1')), findsOneWidget);
  });

  testWidgets('holds together at 200% text', (tester) async {
    await setPhoneSize(tester);
    await tester.pumpWidget(harness(const CallsScreen(), [
      ...myCallsOverrides(api, missed),
      softphoneAvailabilityProvider.overrideWithValue(phoneOn),
    ], textScale: 2));
    await flush(tester);
    await flush(tester);
    expect(tester.takeException(), isNull);
    expect(find.byKey(const Key('my-call-type-i1')), findsOneWidget);
  });
}

InboundMissedCall missed_(String id) => InboundMissedCall.fromJson(missedJson(id));
