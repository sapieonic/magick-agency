import 'package:agency_wire/agency_wire.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:magick_agency_agent/core/api/api_error.dart';
import 'package:magick_agency_agent/core/auth/app_gate.dart' show agentWorkspaceProvider, appGateProvider;
import 'package:magick_agency_agent/core/flags/feature_flags.dart' show contactAssignmentEnabledProvider;
import 'package:magick_agency_agent/core/station/station_view.dart';
import 'package:magick_agency_agent/features/contacts/my_contacts_api.dart';
import 'package:magick_agency_agent/features/performance/performance_api.dart';
import 'package:magick_agency_agent/features/performance/performance_controller.dart' show statsClockProvider;
import 'package:magick_agency_agent/features/station/logic/disposition_form.dart';
import 'package:magick_agency_agent/features/station/parts/sheets.dart' show breakIcon;
import 'package:magick_agency_agent/features/station/parts/wrapup_view.dart' show outcomeIcon;
import 'package:magick_agency_agent/features/station/station_providers.dart';
import 'package:magick_agency_agent/features/station/station_reads.dart';
import 'package:magick_agency_agent/features/station/station_screen.dart';

import '../../core/inbound/inbound_fixtures.dart' show contractSample;
import '../contacts/support.dart' show FakeMyContactsApi, contact, summaryOf;
import '../performance/support.dart' show FakePerformanceApi, RecordingGate, stats, testWorkspaceProvider, totals;
import 'station_harness.dart';

/// The redesign's own pieces (AS1–AS15, phase 0): which screen a state is, Start work in one press,
/// the reads Ready shows beside the live view, and the pictures and chips What happened? and Which
/// break? use until the server sends its own.
/// The signed-in agent the reads are scoped to (`agentWorkspaceProvider`).
final _workspace = agentWorkspaceProvider.overrideWithValue('u1:t1:a1');

void main() {
  group('one state, one screen (stationStageOf)', () {
    test('the line down with nothing on screen to keep is Internet problem (09)', () {
      for (final link in [StationLink.reconnecting, StationLink.disconnected]) {
        for (final phase in [AgentPhase.offline, AgentPhase.available]) {
          expect(stationStageOf(station(link: link, phase: phase), 'c1'), StationStage.internetProblem, reason: '$link $phase');
        }
        expect(
          stationStageOf(station(link: link, phase: AgentPhase.onBreak, onBreak: const BreakInfo(code: 'tea', label: 'Tea')), 'c1'),
          StationStage.internetProblem,
        );
      }
    });

    test('a call keeps its own screen (Call problem), and so does the app\'s own pause and the soft phone', () {
      expect(stationStageOf(station(link: StationLink.reconnecting, phase: AgentPhase.onCall, call: call(bridgedAt: t0)), 'c1'), StationStage.onCall);
      expect(
        stationStageOf(station(link: StationLink.reconnecting, phase: AgentPhase.wrapup, call: call(), wrapup: wrapup()), 'c1'),
        StationStage.wrapup,
      );
      expect(
        stationStageOf(
          station(link: StationLink.reconnecting, phase: AgentPhase.onBreak, onBreak: const BreakInfo(code: 'device_away', label: 'Away')),
          'c1',
        ),
        StationStage.away,
      );
      expect(
        stationStageOf(
          station(link: StationLink.reconnecting, phase: AgentPhase.onBreak, onBreak: const BreakInfo(code: 'soft_phone', label: 'Soft phone')),
          'c1',
        ),
        StationStage.softphone,
      );
      expect(stationStageOf(station(link: StationLink.connecting), 'c1'), StationStage.connecting);
      expect(stationStageOf(station(link: StationLink.superseded), 'c1'), StationStage.superseded);
    });
  });

  group('Start work in one press', () {
    testWidgets('pressed before the join: once the station is open and not taking calls, it goes ready, once', (tester) async {
      final h = await pumpStation(tester, station(link: StationLink.connecting, phase: AgentPhase.offline));
      h.container.read(startWorkIntentProvider.notifier).set('c1', WorkMode.callsComeToMe);
      await h.setView(station(phase: AgentPhase.offline));
      expect(h.actions.calls, ['goAvailable']);
      // Spent: a later reopen does not go ready by itself.
      await h.setView(station(link: StationLink.reconnecting, phase: AgentPhase.offline));
      await h.setView(station(phase: AgentPhase.offline));
      expect(h.actions.count('goAvailable'), 1);
      expect(h.container.read(startWorkIntentProvider), isNull);
    });

    testWidgets('"I dial the number": the station switches to the soft phone instead', (tester) async {
      final h = await pumpStation(tester, station(link: StationLink.connecting, phase: AgentPhase.offline), availability: softphoneOn);
      h.container.read(startWorkIntentProvider.notifier).set('c1', WorkMode.iDial);
      await h.setView(station(phase: AgentPhase.offline));
      expect(h.host.calls, ['switchToSoftphone']);
      expect(h.actions.calls, isNot(contains('goAvailable')));
    });

    testWidgets('a station that opens on a break or on a call is left as it is, and the press is spent', (tester) async {
      final h = await pumpStation(tester, station(link: StationLink.connecting, phase: AgentPhase.offline));
      h.container.read(startWorkIntentProvider.notifier).set('c1', WorkMode.callsComeToMe);
      await h.setView(station(phase: AgentPhase.onBreak, onBreak: BreakInfo(code: 'tea', label: 'Tea', since: t0)));
      expect(h.actions.calls, isEmpty);
      expect(h.container.read(startWorkIntentProvider), isNull);
    });

    testWidgets('another campaign\'s press is not this station\'s', (tester) async {
      final h = await pumpStation(tester, station(link: StationLink.connecting, phase: AgentPhase.offline));
      h.container.read(startWorkIntentProvider.notifier).set('c9', WorkMode.callsComeToMe);
      await h.setView(station(phase: AgentPhase.offline));
      expect(h.actions.calls, isEmpty);
      expect(h.container.read(startWorkIntentProvider)?.campaignId, 'c9');
    });
  });

  group('the reads beside the live view', () {
    testWidgets('read as the my-day contract says: on join, every ready frame, each saved outcome, back to Ready, '
        'and every 60 s while Ready only', (tester) async {
      var reads = 0;
      final h = await pumpStation(
        tester,
        station(phase: AgentPhase.wrapup, call: call(), release: hungUpRelease, wrapup: wrapup()),
        onMyDayRead: () => reads++,
      );
      expect(reads, 1, reason: 'on join, whatever the screen');
      Future<void> expectRead(String why, Future<void> Function() step) async {
        final before = reads;
        await step();
        await tester.pump();
        expect(reads, greaterThan(before), reason: why);
      }

      await expectRead('a saved outcome', () => h.setView(station(phase: AgentPhase.wrapup, call: call(), release: hungUpRelease, wrapup: wrapup(), dispositionSaved: 'interested')));
      await expectRead('back to Ready', () => h.setView(station()));
      await expectRead('a ready frame (a reconnect)', () => h.setView(station(readyCount: 2)));
      await expectRead('60 s on Ready', () => h.advance(const Duration(seconds: 61)));
      await h.setView(station(phase: AgentPhase.onBreak, onBreak: const BreakInfo(code: 'tea', label: 'Tea'), readyCount: 2));
      await tester.pump();
      final onBreak = reads;
      await h.advance(const Duration(minutes: 3));
      expect(reads, onBreak, reason: 'not every minute while on a break');
    });

    testWidgets('read again past the end of the campaign\'s day (my-day\'s day_end), else the phone\'s midnight', (tester) async {
      var reads = 0;
      // 23:59:00 on the phone; the campaign's day ends at 23:59:30.
      final now = DateTime(2026, 10, 31, 23, 59);
      final h = await pumpStation(
        tester,
        station(phase: AgentPhase.onBreak, onBreak: const BreakInfo(code: 'tea', label: 'Tea')),
        now: now,
        myDay: MyDayView(callsToday: 3, talkSeconds: 60, dialled: 9, dayEnd: now.add(const Duration(seconds: 30))),
        onMyDayRead: () => reads++,
      );
      expect(reads, 1);
      await h.advance(const Duration(seconds: 30));
      expect(reads, 1, reason: 'not before the day ends');
      await h.advance(const Duration(seconds: 6));
      await tester.pump();
      expect(reads, 2, reason: 'just past the day\'s end');

      // A server without my-day: the phone's own midnight.
      var fallbackReads = 0;
      final h2 = await pumpStation(
        tester,
        station(phase: AgentPhase.onBreak, onBreak: const BreakInfo(code: 'tea', label: 'Tea')),
        now: now,
        myDay: const MyDayView(callsToday: 3, talkSeconds: 60, dialled: 9),
        onMyDayRead: () => fallbackReads++,
      );
      expect(fallbackReads, 1);
      await h2.advance(const Duration(seconds: 59));
      expect(fallbackReads, 1);
      await h2.advance(const Duration(seconds: 6));
      await tester.pump();
      expect(fallbackReads, 2, reason: 'past the phone\'s midnight');
    });

    test('my-day (BE-1 to BE-3): the target, Will pay and the call-laters this agent booked, with who makes them', () async {
      final stats = FakePerformanceApi();
      final contacts = FakeMyContactsApi();
      final myDay = FakeMyDayApi.answering(MyDay.fromJson(contractSample('reads.json', 'my_day')));
      final container = ProviderContainer(
        overrides: [
          _workspace,
          myDayApiProvider.overrideWithValue(myDay),
          performanceApiProvider.overrideWithValue(stats),
          myContactsApiProvider.overrideWithValue(contacts),
          contactAssignmentEnabledProvider.overrideWithValue(true),
        ],
      );
      addTearDown(container.dispose);
      final day = await container.read(stationMyDayProvider('c1').future);
      expect(day, MyDayView(callsToday: 42, talkSeconds: 6720, dialled: 131, target: 120, willPay: 12, dayEnd: DateTime.utc(2026, 11, 20, 18, 30)));
      final later = await container.read(stationCallLaterProvider((campaignId: 'c1', offered: false)).future);
      expect(later.items.map((i) => (i.name, i.overdue)), [('Sunita Patil', true), ('', false), ('Imran Shaikh', false)]);
      expect([later.today, later.todayCount, later.comesToMe, later.leftGoesToPool], [2, 2, true, false]);
      // One read serves both, and the old reads are not made.
      expect(myDay.reads, ['c1']);
      expect(stats.statsQueries, isEmpty);
      expect(contacts.queries, isEmpty);
    });

    test('the reads are the signed-in agent\'s: another sign-in reads afresh, never the last agent\'s numbers', () async {
      final api = FakeMyDayApi.answering(MyDay.fromJson(contractSample('reads.json', 'my_day')));
      final container = ProviderContainer(
        overrides: [
          agentWorkspaceProvider.overrideWith((ref) => ref.watch(testWorkspaceProvider)),
          myDayApiProvider.overrideWithValue(api),
        ],
      );
      addTearDown(container.dispose);
      container.listen(stationMyDayProvider('c1'), (_, _) {});
      container.listen(stationCallLaterProvider((campaignId: 'c1', offered: false)), (_, _) {});
      expect((await container.read(stationMyDayProvider('c1').future))!.callsToday, 42);
      expect(api.reads, ['c1']);
      // Another agent signs in on this phone; their day is not 42 calls.
      api.answer = MyDay.fromJson({...contractSample('reads.json', 'my_day'), 'calls': 3});
      container.read(testWorkspaceProvider.notifier).set('u2:t1:a1');
      expect((await container.read(stationMyDayProvider('c1').future))!.callsToday, 3);
      expect((await container.read(stationCallLaterProvider((campaignId: 'c1', offered: false)).future)).today, isNotNull);
      expect(api.reads, ['c1', 'c1'], reason: 'one read per agent, both lists from it');
    });

    test('a 401 from the reads goes to the app gate, as every feature\'s does, and is not hidden by the fallback', () async {
      final api = FakeMyDayApi.failing(const ApiUnauthorized());
      final stats = FakePerformanceApi();
      final container = ProviderContainer(
        overrides: [
          appGateProvider.overrideWith(RecordingGate.new),
          _workspace,
          myDayApiProvider.overrideWithValue(api),
          performanceApiProvider.overrideWithValue(stats),
        ],
      );
      addTearDown(container.dispose);
      await expectLater(container.read(stationMyDayProvider('c1').future), throwsA(isA<ApiUnauthorized>()));
      await Future<void>.delayed(Duration.zero);
      final gate = container.read(appGateProvider.notifier) as RecordingGate;
      expect(gate.reported, [isA<ApiUnauthorized>()]);
      expect(stats.statsQueries, isEmpty, reason: 'no fallback read behind a 401');

      // The fallback's own 401 too (a server without my-day).
      final c2 = ProviderContainer(
        overrides: [
          appGateProvider.overrideWith(RecordingGate.new),
          _workspace,
          myDayApiProvider.overrideWithValue(FakeMyDayApi.notFound()),
          performanceApiProvider.overrideWithValue(FakePerformanceApi()..autoAnswer = (_) => throw const ApiUnauthorized()),
        ],
      );
      addTearDown(c2.dispose);
      await expectLater(c2.read(stationMyDayProvider('c1').future), throwsA(isA<ApiUnauthorized>()));
      await Future<void>.delayed(Duration.zero);
      expect((c2.read(appGateProvider.notifier) as RecordingGate).reported, [isA<ApiUnauthorized>()]);
    });

    test('my-day on a pool campaign with no target: no bar, and another agent may make them', () async {
      final container = ProviderContainer(
        overrides: [
          _workspace,myDayApiProvider.overrideWithValue(FakeMyDayApi.answering(MyDay.fromJson(contractSample('reads.json', 'my_day_pool_no_target'))))],
      );
      addTearDown(container.dispose);
      final day = await container.read(stationMyDayProvider('c1').future);
      expect(day!.target, isNull);
      final later = await container.read(stationCallLaterProvider((campaignId: 'c1', offered: false)).future);
      expect(later.comesToMe, isFalse);
    });

    test('My day from a server without my-day: today\'s connected calls, talk time and dials, from today\'s own stats', () async {
      final api = FakePerformanceApi()..autoAnswer = (q) => stats(from: q.from, to: q.to, t: totals(attempts: 97, connected: 42, talk: 6720.4));
      final now = DateTime(2026, 10, 31, 11, 20);
      final container = ProviderContainer(
        overrides: [
          _workspace,
          performanceApiProvider.overrideWithValue(api),
          statsClockProvider.overrideWithValue(() => now),
          myDayApiProvider.overrideWithValue(FakeMyDayApi.notFound()),
        ],
      );
      addTearDown(container.dispose);
      final day = await container.read(stationMyDayProvider('c1').future);
      expect(day, const MyDayView(callsToday: 42, talkSeconds: 6720, dialled: 97));
      expect(day!.target, isNull, reason: 'none until the server sends one (BE-2)');
      expect(day.willPay, isNull, reason: 'none until the server sends one (BE-1, AS7)');
      expect(api.statsQueries.single.campaignId, 'c1');
      expect(api.statsQueries.single.from, DateTime(2026, 10, 31));
    });

    test('the call-later list: today\'s booked calls only, soonest first, by name or number', () async {
      final now = DateTime(2026, 10, 31, 11, 20);
      final api = FakeMyContactsApi()
        ..autoPage = KeysetPage(
          rows: [
            contact(1, bucket: MyContactBucket.callback, next: DateTime(2026, 10, 31, 18).toUtc()),
            contact(2, bucket: MyContactBucket.callback, next: DateTime(2026, 11, 1, 10).toUtc()),
            contact(3, bucket: MyContactBucket.callback, next: DateTime(2026, 10, 31, 15).toUtc(), hero: const []),
          ],
          limit: 50,
        );
      final container = ProviderContainer(
        overrides: [
          _workspace,
          myContactsApiProvider.overrideWithValue(api),
          contactAssignmentEnabledProvider.overrideWithValue(true),
          statsClockProvider.overrideWithValue(() => now),
          myDayApiProvider.overrideWithValue(FakeMyDayApi.notFound()),
        ],
      );
      addTearDown(container.dispose);
      final items = await container.read(stationCallLaterProvider((campaignId: 'c1', offered: true)).future);
      expect(items.items.map((i) => i.at), [DateTime(2026, 10, 31, 15), DateTime(2026, 10, 31, 18)]);
      expect(items.items.first.name, '', reason: 'no hero value: never the number ("Customer")');
      expect(items.items.last.name, 'Asha Rao');
      expect(items.comesToMe, isNull, reason: 'the station judges it by the campaign\'s routing');
      expect(api.queries.single.buckets, [MyContactBucket.callback]);
    });

    test('an inbound caller matched to another campaign: its routing from its summary (AS8), false when unread', () async {
      final api = FakeMyContactsApi();
      for (final (answer, expected) in <(Object, bool)>[
        (summaryOf(mode: AssignmentMode.strict), true),
        (summaryOf(mode: AssignmentMode.preferred), true),
        (summaryOf(mode: AssignmentMode.pool), false),
        (const ApiNetworkError('offline'), false),
      ]) {
        api.summaryAnswer = answer;
        final container = ProviderContainer(overrides: [_workspace, myContactsApiProvider.overrideWithValue(api)]);
        addTearDown(container.dispose);
        expect(await container.read(matchedAssignsContactsProvider('c9').future), expected, reason: '$answer');
      }
      expect(api.summaries, ['c9', 'c9', 'c9', 'c9']);
    });

    test('no call-later read where My contacts does not serve it', () async {
      final api = FakeMyContactsApi();
      for (final (flag, offered) in [(false, true), (true, false)]) {
        final container = ProviderContainer(
          overrides: [
            _workspace,
            myContactsApiProvider.overrideWithValue(api),
            contactAssignmentEnabledProvider.overrideWithValue(flag),
            myDayApiProvider.overrideWithValue(FakeMyDayApi.notFound()),
          ],
        );
        addTearDown(container.dispose);
        expect((await container.read(stationCallLaterProvider((campaignId: 'c1', offered: offered)).future)).items, isEmpty);
      }
      expect(api.queries, isEmpty);
    });
  });

  group('pictures and chips until the server sends its own', () {
    test('an outcome\'s picture follows what it does (design-spec §5.4)', () {
      expect(outcomeIcon(const DispositionOption(code: 'd', label: 'Don’t call again', suppresses: true)), Icons.block);
      expect(outcomeIcon(const DispositionOption(code: 'p', label: 'Will pay', requiresPromise: true, isSuccess: true)), Icons.currency_rupee);
      expect(outcomeIcon(const DispositionOption(code: 'c', label: 'Call later', requiresCallbackTime: true)), Icons.schedule);
      expect(outcomeIcon(const DispositionOption(code: 's', label: 'Sold', isSuccess: true)), Icons.thumb_up_outlined);
      expect(outcomeIcon(const DispositionOption(code: 'n', label: 'No one spoke')), Icons.radio_button_unchecked);
    });

    test('a break\'s picture is guessed from its code or name, a cup when nothing fits', () {
      expect(breakIcon(const BreakOption(code: 'lunch', label: 'Lunch')), Icons.restaurant_outlined);
      expect(breakIcon(const BreakOption(code: 'b2', label: 'Washroom')), Icons.wc);
      expect(breakIcon(const BreakOption(code: 'mtg', label: 'Team meeting')), Icons.groups_outlined);
      expect(breakIcon(const BreakOption(code: 'training', label: 'Training')), Icons.school_outlined);
      expect(breakIcon(const BreakOption(code: 'tea', label: 'Tea')), Icons.free_breakfast_outlined);
      expect(breakIcon(const BreakOption(code: 'x', label: 'Prayer')), Icons.free_breakfast_outlined);
    });

    test('Call when? chips: Today 6:00 PM only while it is more than an hour away', () {
      final morning = stationCallbackPresets(DateTime(2026, 10, 31, 11, 20));
      expect(morning.map((p) => p.choice), [
        CallbackChoice.inOneHour,
        CallbackChoice.todayEvening,
        CallbackChoice.tomorrowMorning,
        CallbackChoice.tomorrowEvening,
      ]);
      expect(morning[1].at, DateTime(2026, 10, 31, 18));
      final late = stationCallbackPresets(DateTime(2026, 10, 31, 17, 0));
      expect(late.map((p) => p.choice), isNot(contains(CallbackChoice.todayEvening)));
      // The soft phone's and the inbound panel's chips are unchanged.
      expect(callbackPresets(DateTime(2026, 10, 31, 11, 20)).map((p) => p.choice), isNot(contains(CallbackChoice.todayEvening)));
    });
  });
}

/// `GET /proxy/agency/my-day`, scripted: an answer, or an older server's 404.
class FakeMyDayApi implements MyDayApi {
  FakeMyDayApi.answering(MyDay this.answer)
      : status = null,
        error = null;
  FakeMyDayApi.notFound()
      : answer = null,
        status = 404,
        error = null;
  FakeMyDayApi.failing(Object this.error)
      : answer = null,
        status = null;

  MyDay? answer;
  final int? status;
  final Object? error;
  final reads = <String>[];

  @override
  Future<MyDay> read(String campaignId) async {
    reads.add(campaignId);
    if (error != null) throw error!;
    final a = answer;
    if (a != null) return a;
    throw ApiHttpError(status: status!, code: null, message: 'Not Found', body: const {'error': 'Not Found'}, requestId: null);
  }
}
