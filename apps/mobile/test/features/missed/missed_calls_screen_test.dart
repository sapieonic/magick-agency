import 'package:agency_wire/agency_wire.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/misc.dart' show Override;
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:magick_agency_agent/app/routes.dart';
import 'package:magick_agency_agent/app/theme/app_theme.dart';
import 'package:magick_agency_agent/app/theme/tokens.dart';
import 'package:magick_agency_agent/core/softphone/softphone_view.dart';
import 'package:magick_agency_agent/core/station/station_signals.dart';
import 'package:magick_agency_agent/features/calls/calls_screen.dart';
import 'package:magick_agency_agent/features/missed/missed_calls_copy.dart';
import 'package:magick_agency_agent/features/missed/missed_calls_list.dart';

import '../../core/auth/support/harness.dart' show testSignalsProvider;
import '../calls/softphone_support.dart' show FakeSoftphoneCallsApi, softphoneCallsOverrides;
import '../softphone/softphone_harness.dart' show FakeSoftphoneActions;
import 'support.dart';

/// The Missed list on screen: each row's words (every reason, a withheld
/// caller, DNC, a voicemail), the notices, Mark handled and Reopen, and Call
/// back handing the number to the soft phone without dialling it.
void main() {
  late FakeMissedCallsApi api;
  late FakeSoftphoneActions actions;

  const phoneOn = SoftphoneAvailability(visible: true, startAllowed: true, loaded: true);

  setUp(() {
    api = FakeMissedCallsApi();
    actions = FakeSoftphoneActions();
  });

  List<Override> overrides({
    SoftphoneAvailability availability = phoneOn,
    bool inboundOn = true,
    SoftphoneView view = const SoftphoneView(),
  }) =>
      [
        ...missedOverrides(api, inboundOn: inboundOn),
        softphoneAvailabilityProvider.overrideWithValue(availability),
        softphoneActionsProvider.overrideWithValue(actions),
        softphoneViewProvider.overrideWithValue(view),
        stationSignalsProvider.overrideWith((ref) => ref.watch(testSignalsProvider)),
      ];

  /// The list at `/calls`, with stand-ins where Call back may go.
  Future<void> open(
    WidgetTester tester,
    List<InboundMissedCall> rows, {
    SoftphoneAvailability availability = phoneOn,
    bool inboundOn = true,
    SoftphoneView view = const SoftphoneView(),
    StationSignals? signals,
  }) async {
    await setPhoneSize(tester);
    tester.view.physicalSize = const Size(1080, 12000); // every row built
    api.autoPage = missedPage(rows);
    final router = GoRouter(
      initialLocation: Routes.calls,
      routes: [
        GoRoute(path: Routes.calls, builder: (_, _) => const Scaffold(body: MissedCallsList())),
        GoRoute(path: Routes.phone, builder: (_, s) => Scaffold(body: Text('at ${s.uri}'))),
        GoRoute(path: Routes.stationPattern, builder: (_, s) => Scaffold(body: Text('at ${s.uri}'))),
      ],
    );
    addTearDown(router.dispose);
    final container = ProviderContainer.test(overrides: overrides(availability: availability, inboundOn: inboundOn, view: view));
    if (signals != null) container.read(testSignalsProvider.notifier).set(signals);
    await tester.pumpWidget(UncontrolledProviderScope(
      container: container,
      child: MaterialApp.router(theme: buildTheme(AppTokens.dark, Brightness.dark), routerConfig: router),
    ));
    await flush(tester);
    await flush(tester);
  }

  Finder inRow(String id, Finder f) => find.descendant(of: find.byKey(ValueKey('missed-row-$id')), matching: f);
  String textOf(WidgetTester tester, String id, String key) =>
      tester.widget<Text>(inRow(id, find.byKey(Key(key)))).data!;

  group('rows', () {
    testWidgets('why each call was missed, in the console’s words', (tester) async {
      await open(tester, [
        missed('hours'),
        missed('off', {'closed_cause': 'switched_off'}),
        missed('noroute', {'closed_cause': 'no_route'}),
        missed('line', {'closed_cause': 'credential_inactive'}),
        missed('queue', {'reason': 'abandoned_in_queue', 'closed_cause': null}),
        missed('free', {'reason': 'overflow', 'closed_cause': null}),
        missed('busy', {'reason': 'overflow_no_capacity', 'closed_cause': null}),
        missed('failed', {'reason': 'failed', 'closed_cause': null}),
        missed('new', {'reason': 'something_new', 'closed_cause': null}),
      ]);
      final reasons = {
        for (final id in ['hours', 'off', 'noroute', 'line', 'queue', 'free', 'busy', 'failed', 'new'])
          id: tester.widget<Text>(find.descendant(of: inRow(id, find.byKey(const Key('missed-reason'))), matching: find.byType(Text))).data,
      };
      expect(reasons, {
        'hours': 'Out of hours',
        'off': 'Inbound switched off',
        'noroute': 'Number not on a route',
        'line': 'Phone line not active',
        'queue': 'Hung up while waiting',
        'free': 'Nobody free to answer',
        'busy': 'All lines busy',
        'failed': 'Couldn’t be answered',
        'new': 'something_new',
      });
    });

    testWidgets('the caller, when and what they rang, the campaign and its booked callback', (tester) async {
      await open(tester, [
        missed('m1', {'callback_due_at': '2026-10-14T06:30:00.000Z'}),
        missed('m2', {'matched_campaign_id': null, 'matched_campaign_name': null, 'route_name': null}),
      ]);
      expect(textOf(tester, 'm1', 'missed-caller'), '+91 87654 32109');
      // Times in this device's zone, as the row reads them.
      final arrived = MissedCopy.whenAt(DateTime.utc(2026, 10, 14, 4, 12, 5), fixedNow);
      final due = MissedCopy.whenAt(DateTime.utc(2026, 10, 14, 6, 30), fixedNow);
      expect(arrived, startsWith('Today, '));
      expect(textOf(tester, 'm1', 'missed-meta'), '$arrived · Rang +91 20712 34500 · Pune customer line');
      expect(textOf(tester, 'm1', 'missed-campaign'), 'Q4 Renewals · Callback booked for $due');
      expect(textOf(tester, 'm2', 'missed-campaign'), 'Not matched');
      expect(textOf(tester, 'm2', 'missed-meta'), '$arrived · Rang +91 20712 34500');
    });

    testWidgets('a withheld caller: "Number withheld", and Call back disabled with the reason', (tester) async {
      await open(tester, [missed('w', {'from_e164': null})]);
      expect(textOf(tester, 'w', 'missed-caller'), 'Number withheld');
      final button = tester.widget<ButtonStyleButton>(inRow('w', find.byKey(const Key('missed-call-back'))));
      expect(button.onPressed, isNull);
      expect(inRow('w', find.text('The caller withheld their number.')), findsOneWidget);
    });

    testWidgets('DNC is badged; a voicemail says so and where to hear it', (tester) async {
      await open(tester, [
        missed('dnc', {'caller_dnc': true}),
        missed('vm', {'has_voicemail': true, 'voicemail_url': '/inbound/missed/vm/voicemail'}),
        missed('plain'),
      ]);
      expect(inRow('dnc', find.byKey(const Key('missed-dnc'))), findsOneWidget);
      expect(inRow('plain', find.byKey(const Key('missed-dnc'))), findsNothing);
      expect(inRow('vm', find.text('Left a voicemail · Listen on the console')), findsOneWidget);
      expect(inRow('plain', find.byKey(const Key('missed-voicemail'))), findsNothing);
    });

    testWidgets('handled rows: who and when, the reached note, and Reopen (no Call back, no Mark handled)', (tester) async {
      await open(tester, [
        handledCopy(missed('mine')),
        missed('reached', {
          'status': 'handled',
          'handled_reason': 'reached',
          'handled_by_user_id': 'u9',
          'handled_by_name': 'Arjun',
          'handled_at': '2026-10-14T04:40:00.000Z',
        }),
      ]);
      String at(int h, int m) => MissedCopy.whenAt(DateTime.utc(2026, 10, 14, h, m), fixedNow);
      expect(textOf(tester, 'mine', 'missed-handled'), 'You · ${at(4, 30)}');
      expect(textOf(tester, 'reached', 'missed-handled'), 'Customer reached by Arjun · ${at(4, 40)}');
      expect(inRow('reached', find.byKey(const Key('missed-reached'))), findsOneWidget);
      expect(inRow('mine', find.byKey(const Key('missed-reopen'))), findsOneWidget);
      expect(inRow('mine', find.byKey(const Key('missed-call-back'))), findsNothing);
      expect(inRow('mine', find.byKey(const Key('missed-mark-handled'))), findsNothing);
    });
  });

  group('Call back', () {
    testWidgets('hands the number and the matched campaign to the soft phone and opens it; never dials', (tester) async {
      await open(tester, [missed('m1')], view: const SoftphoneView(screen: SoftphoneScreenActive()));
      await tester.tap(inRow('m1', find.byKey(const Key('missed-call-back'))));
      await tester.pumpAndSettle();
      expect(actions.calls, ['callBack']);
      expect(actions.args['callBack'], ['+918765432109', 'camp-1']);
      expect(actions.count('dial'), 0);
      expect(find.text('at /phone'), findsOneWidget);
      expect(find.byKey(const Key('missed-call-back-waits')), findsNothing, reason: 'the pad is filled at once');
    });

    testWidgets('with the soft phone not open yet, the agent is told the number will be ready', (tester) async {
      await open(tester, [missed('m1')]);
      await tester.tap(inRow('m1', find.byKey(const Key('missed-call-back'))));
      await tester.pumpAndSettle();
      expect(find.text('at /phone'), findsOneWidget);
      expect(find.byKey(const Key('missed-call-back-waits')), findsOneWidget);
      expect(actions.count('dial'), 0);
    });

    testWidgets('a campaign station on the soft phone (SP7): it goes to the station, where the pad is', (tester) async {
      await open(
        tester,
        [missed('m1')],
        signals: const StationSignals(onDuty: true, onBreak: true, campaignId: 'c1', onSoftphone: true),
      );
      await tester.tap(inRow('m1', find.byKey(const Key('missed-call-back'))));
      await tester.pumpAndSettle();
      expect(find.text('at /home/station/c1'), findsOneWidget);
      expect(find.byKey(const Key('missed-call-back-waits')), findsNothing);
      expect(actions.count('dial'), 0);
    });

    testWidgets('not offered where the soft phone is not on (hidden, or finish mode), and the note says why', (tester) async {
      await open(tester, [missed('m1')], availability: const SoftphoneAvailability(visible: true, loaded: true));
      expect(find.byKey(const Key('missed-call-back')), findsNothing);
      expect(find.byKey(const Key('missed-no-softphone')), findsOneWidget);
      expect(find.byKey(const Key('missed-mark-handled')), findsOneWidget);
    });
  });

  testWidgets('inbound switched off: the console’s notice above the rows still to finish', (tester) async {
    await open(tester, [missed('m1')], inboundOn: false);
    expect(find.byKey(const Key('missed-inbound-off')), findsOneWidget);
    expect(find.byKey(const Key('missed-row-m1')), findsOneWidget);
  });

  testWidgets('Mark handled takes the row off the list; a refusal stays on the row', (tester) async {
    await open(tester, [missed('m1'), missed('m2')]);
    await tester.tap(inRow('m1', find.byKey(const Key('missed-mark-handled'))));
    await flush(tester);
    expect(api.handled, ['m1']);
    expect(find.byKey(const Key('missed-row-m1')), findsNothing);

    api.handledAnswer = inboundRefusal('inbound_missed_call_not_found');
    await tester.tap(inRow('m2', find.byKey(const Key('missed-mark-handled'))));
    await flush(tester);
    expect(find.byKey(const Key('missed-row-m2')), findsOneWidget);
    expect(inRow('m2', find.text('This missed call isn’t yours to handle, or it no longer exists.')), findsOneWidget);
  });

  testWidgets('the Handled tab asks for handled rows; Reopen takes one off it', (tester) async {
    await open(tester, [missed('m1')]);
    api.autoPage = missedPage([handledCopy(missed('h1'))]);
    await tester.tap(find.byKey(const Key('missed-tab-handled')));
    await flush(tester);
    expect(api.queries.last.toQuery()['status'], 'handled');
    await tester.tap(inRow('h1', find.byKey(const Key('missed-reopen'))));
    await flush(tester);
    expect(api.reopened, ['h1']);
    expect(find.byKey(const Key('missed-row-h1')), findsNothing);
    expect(find.byKey(const Key('missed-empty')), findsOneWidget);
    expect(find.text('No handled missed calls'), findsOneWidget);
  });

  testWidgets('the reason filter goes on the query', (tester) async {
    await open(tester, [missed('m1')]);
    await tester.tap(find.byKey(const Key('missed-filter-reason')));
    await tester.pumpAndSettle();
    await tester.tap(find.text('All lines busy').last);
    await tester.pumpAndSettle();
    expect(api.queries.last.toQuery(), {'status': 'open', 'reason': 'overflow_no_capacity', 'limit': '50'});
    await tester.tap(find.byKey(const Key('missed-filter-reason')));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Any reason').last);
    await tester.pumpAndSettle();
    expect(api.queries.last.toQuery(), {'status': 'open', 'limit': '50'});
  });

  group('on My calls', () {
    late FakeSoftphoneCallsApi soft;

    setUp(() => soft = FakeSoftphoneCallsApi());

    Future<void> openCalls(WidgetTester tester, {bool inboundOn = true}) async {
      await setPhoneSize(tester);
      await tester.pumpWidget(harness(const CallsScreen(), [
        ...softphoneCallsOverrides(soft),
        ...missedOverrides(api, inboundOn: inboundOn, base: false),
        softphoneActionsProvider.overrideWithValue(actions),
      ]));
      await flush(tester);
      await flush(tester);
    }

    testWidgets('a third segment, short labels, with the open count as a badge', (tester) async {
      api.autoPage = missedPage([missed('m1')]);
      await openCalls(tester);
      expect(find.text('Campaign'), findsOneWidget);
      expect(find.text('Soft phone'), findsOneWidget);
      expect(find.text('Missed'), findsOneWidget);
      final badge = tester.widget<Badge>(find.byKey(const Key('calls-view-missed-badge')));
      expect(badge.isLabelVisible, isTrue);
      expect((badge.label! as Text).data, '3');

      await tester.tap(find.byKey(const Key('calls-view-missed')));
      await flush(tester);
      expect(find.byKey(const Key('missed-row-m1')), findsOneWidget);
      expect(find.text('Showing 1 call'), findsOneWidget);
    });

    testWidgets('no segment where the list is hidden (a 403 on the count)', (tester) async {
      api.countAnswer = forbidden;
      await openCalls(tester);
      expect(find.byKey(const Key('calls-view-missed')), findsNothing);
      expect(find.text('Campaign calls'), findsOneWidget, reason: 'two segments keep their long labels');
    });
  });
}
