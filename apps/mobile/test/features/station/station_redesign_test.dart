import 'package:agency_wire/agency_wire.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
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

import '../contacts/support.dart' show FakeMyContactsApi, contact;
import '../performance/support.dart' show FakePerformanceApi, stats, totals;
import 'station_harness.dart';

/// The redesign's own pieces (AS1–AS15, phase 0): which screen a state is, Start work in one press,
/// the reads Ready shows beside the live view, and the pictures and chips What happened? and Which
/// break? use until the server sends its own.
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
    testWidgets('My day and the call-later list are read again each time the agent is back to Ready', (tester) async {
      var reads = 0;
      final h = await pumpStation(
        tester,
        station(phase: AgentPhase.wrapup, call: call(), release: hungUpRelease, wrapup: wrapup()),
        onMyDayRead: () => reads++,
      );
      expect(reads, 0, reason: 'What happened? shows no My day');
      await h.setView(station());
      final first = reads;
      expect(first, greaterThanOrEqualTo(1));
      await h.setView(station(phase: AgentPhase.reserved, call: call(attemptId: 'a2')));
      await h.setView(station());
      expect(reads, greaterThan(first), reason: 'read again on the return');
    });

    test('My day: today\'s connected calls, talk time and dials on this campaign, from today\'s own stats', () async {
      final api = FakePerformanceApi()..autoAnswer = (q) => stats(from: q.from, to: q.to, t: totals(attempts: 97, connected: 42, talk: 6720.4));
      final now = DateTime(2026, 10, 31, 11, 20);
      final container = ProviderContainer(
        overrides: [performanceApiProvider.overrideWithValue(api), statsClockProvider.overrideWithValue(() => now)],
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
          myContactsApiProvider.overrideWithValue(api),
          contactAssignmentEnabledProvider.overrideWithValue(true),
          statsClockProvider.overrideWithValue(() => now),
        ],
      );
      addTearDown(container.dispose);
      final items = await container.read(stationCallLaterProvider((campaignId: 'c1', offered: true)).future);
      expect(items.map((i) => i.at), [DateTime(2026, 10, 31, 15), DateTime(2026, 10, 31, 18)]);
      expect(items.first.name, '+919840010003', reason: 'no hero value: the number');
      expect(items.last.name, 'Asha Rao');
      expect(api.queries.single.buckets, [MyContactBucket.callback]);
    });

    test('no call-later read where My contacts does not serve it', () async {
      final api = FakeMyContactsApi();
      for (final (flag, offered) in [(false, true), (true, false)]) {
        final container = ProviderContainer(
          overrides: [myContactsApiProvider.overrideWithValue(api), contactAssignmentEnabledProvider.overrideWithValue(flag)],
        );
        addTearDown(container.dispose);
        expect(await container.read(stationCallLaterProvider((campaignId: 'c1', offered: offered)).future), isEmpty);
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
