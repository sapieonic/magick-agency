import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:magick_agency_agent/app/routes.dart';
import 'package:magick_agency_agent/app/theme/app_theme.dart';
import 'package:magick_agency_agent/app/theme/tokens.dart';
import 'package:magick_agency_agent/core/softphone/softphone_host.dart';
import 'package:magick_agency_agent/core/softphone/softphone_view.dart';
import 'package:magick_agency_agent/core/station/station_signals.dart';
import 'package:magick_agency_agent/core/station/station_view.dart';
import 'package:magick_agency_agent/features/missed/missed_access.dart';
import 'package:magick_agency_agent/features/missed/missed_calls_copy.dart';
import 'package:magick_agency_agent/features/missed/missed_on_duty.dart';

import '../../core/auth/support/harness.dart' show testSignalsProvider;
import '../../core/softphone/fake_softphone_host.dart' show FakeSoftphoneHost;
import '../softphone/softphone_harness.dart' show FakeSoftphoneActions;
import '../station/station_harness.dart' as st;
import 'support.dart';

/// IQ48: the Missed list on duty on a campaign. The station's waiting and wrap-up screens say
/// how many customers are waiting to be called back, with a tap to the list; the list opens in
/// a sheet over the station that moves the agent nowhere and closes when another call arrives.
void main() {
  const three = MissedCallsAccess(visible: true, inboundOn: true, badge: '3');

  group('the line', () {
    test('its words: the count as the badge says it', () {
      expect(MissedCopy.toCallBack('1'), '1 customer to call back');
      expect(MissedCopy.toCallBack('3'), '3 customers to call back');
      expect(MissedCopy.toCallBack('100+'), '100+ customers to call back');
      expect(MissedCopy.toCallBackLabel('3'), '3 customers to call back. Opens your missed calls.');
    });

    Future<List<BuildContext>> pumpWaiting(WidgetTester tester, MissedCallsAccess access, {StationView? view}) async {
      final opened = <BuildContext>[];
      await st.pumpStation(tester, view ?? st.station(), extra: [
        missedCallsAccessProvider.overrideWithValue(access),
        missedOnDutyOpenerProvider.overrideWithValue(opened.add),
      ]);
      return opened;
    }

    testWidgets('waiting: "3 customers to call back", and a tap opens the list', (tester) async {
      final handle = tester.ensureSemantics();
      final opened = await pumpWaiting(tester, three);
      expect(find.text('3 customers to call back'), findsOneWidget);
      expect(find.bySemanticsLabel('3 customers to call back. Opens your missed calls.'), findsOneWidget);
      expect(tester.getSize(find.byKey(const Key('missed-to-call-back'))).height, greaterThanOrEqualTo(48));
      await tester.tap(find.byKey(const Key('missed-to-call-back')));
      expect(opened, hasLength(1));
      handle.dispose();
    });

    testWidgets('wrap-up: the same line, under the outcome', (tester) async {
      await pumpWaiting(
        tester,
        three,
        view: st.station(phase: AgentPhase.wrapup, call: st.call(), release: st.hungUpRelease, wrapup: st.wrapup()),
      );
      await tester.scrollUntilVisible(find.byKey(const Key('missed-to-call-back')), 200, scrollable: find.byType(Scrollable).first);
      expect(find.text('3 customers to call back'), findsOneWidget);
    });

    testWidgets('none open, the count not known, or not the agent\'s to read: nothing', (tester) async {
      for (final access in [
        const MissedCallsAccess(visible: true, inboundOn: true),
        MissedCallsAccess.hidden,
        const MissedCallsAccess(inboundOn: true, badge: '3'),
      ]) {
        await pumpWaiting(tester, access);
        expect(find.byKey(const Key('missed-to-call-back')), findsNothing, reason: '$access');
      }
    });

    testWidgets('a call on screen: not on the call screens', (tester) async {
      await pumpWaiting(tester, three, view: st.station(phase: AgentPhase.onCall, call: st.call(bridgedAt: st.t0)));
      expect(find.byKey(const Key('missed-to-call-back')), findsNothing);
    });
  });

  group('the sheet over the station', () {
    late FakeMissedCallsApi api;
    late ProviderContainer container;
    late NotifierProvider<st.ViewHolder, StationView?> holder;
    late FakeSoftphoneHost host;
    late FakeSoftphoneActions actions;

    Future<void> pumpSheet(WidgetTester tester, StationView view) async {
      await setPhoneSize(tester);
      api = FakeMissedCallsApi()..autoPage = missedPage([missed('m1')]);
      holder = NotifierProvider<st.ViewHolder, StationView?>(() => st.ViewHolder(view));
      host = FakeSoftphoneHost();
      actions = FakeSoftphoneActions();
      container = ProviderContainer.test(overrides: [
        ...missedOverrides(api),
        stationViewProvider.overrideWith((ref) => ref.watch(holder)),
        stationSignalsProvider.overrideWith((ref) => ref.watch(testSignalsProvider)),
        softphoneAvailabilityProvider.overrideWithValue(st.softphoneOn),
        softphoneActionsProvider.overrideWithValue(actions),
        softphoneViewProvider.overrideWithValue(const SoftphoneView()),
        softphoneHostActionsProvider.overrideWithValue(host),
      ]);
      container.read(testSignalsProvider.notifier).set(const StationSignals(onDuty: true, campaignId: 'camp-1'));
      final router = GoRouter(
        initialLocation: Routes.station('camp-1'),
        routes: [
          GoRoute(
            path: Routes.stationPattern,
            builder: (context, s) => Scaffold(
              body: Column(
                children: [
                  Text('at ${s.uri}'),
                  Builder(
                    builder: (context) => TextButton(
                      key: const Key('open'),
                      onPressed: () => showMissedCallsOnDuty(context),
                      child: const Text('open'),
                    ),
                  ),
                ],
              ),
            ),
          ),
        ],
      );
      addTearDown(router.dispose);
      await tester.pumpWidget(UncontrolledProviderScope(
        container: container,
        child: MaterialApp.router(theme: buildTheme(AppTokens.dark, Brightness.dark), routerConfig: router),
      ));
      await tester.tap(find.byKey(const Key('open')));
      await tester.pumpAndSettle();
    }

    Future<void> setView(WidgetTester tester, StationView? v) async {
      container.read(holder.notifier).set(v);
      await tester.pumpAndSettle();
    }

    final sheet = find.byKey(const Key('missed-on-duty-sheet'));

    testWidgets('the agent\'s rows, with nothing asked of the station; Close closes it', (tester) async {
      await pumpSheet(tester, st.station());
      expect(sheet, findsOneWidget);
      expect(find.byKey(const ValueKey('missed-row-m1')), findsOneWidget);
      expect(host.log, isEmpty, reason: 'opening the list switches, pauses and leaves nothing');
      await tester.tap(find.byKey(const Key('missed-on-duty-close')));
      await tester.pumpAndSettle();
      expect(sheet, findsNothing);
      expect(find.text('at /home/station/camp-1'), findsOneWidget);
    });

    testWidgets('the Team view opens on duty too, and Claim works there', (tester) async {
      await pumpSheet(tester, st.station());
      await tester.tap(find.byKey(const Key('missed-scope-team')));
      await tester.pumpAndSettle();
      expect(api.queries.last.assignee, 'unassigned');
      await tester.tap(find.byKey(const Key('missed-claim')));
      await tester.pumpAndSettle();
      expect(api.claimed, ['m1']);
      expect(sheet, findsOneWidget, reason: 'a claim keeps the agent where they are');
    });

    testWidgets('a call reaching the agent closes it: the call takes the screen', (tester) async {
      await pumpSheet(tester, st.station());
      await setView(tester, st.station(phase: AgentPhase.reserved, call: st.call()));
      expect(sheet, findsNothing);
    });

    testWidgets('opened in a wrap-up: stays through it and after, closes for the next call', (tester) async {
      final wrap = st.station(phase: AgentPhase.wrapup, call: st.call(), release: st.hungUpRelease, wrapup: st.wrapup());
      await pumpSheet(tester, wrap);
      expect(sheet, findsOneWidget);
      await setView(tester, st.station());
      expect(sheet, findsOneWidget, reason: 'the outcome saved: back to waiting');
      await setView(tester, st.station(phase: AgentPhase.reserved, call: st.call(attemptId: 'a2')));
      expect(sheet, findsNothing);
    });

    testWidgets('Call back closes it, switches the campaign to the soft phone, and stays on the station', (tester) async {
      await pumpSheet(tester, st.station());
      await tester.tap(find.byKey(const Key('missed-call-back')));
      await tester.pumpAndSettle();
      expect(sheet, findsNothing);
      expect(actions.calls, ['callBack']);
      expect(host.log, ['switch']);
      expect(find.text('at /home/station/camp-1'), findsOneWidget);
    });
  });
}
