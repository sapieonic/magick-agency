import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:magick_agency_agent/core/station/station_view.dart';
import 'package:magick_agency_agent/features/station/station_copy.dart';

import 'station_harness.dart';

/// Contact assignment on the waiting screen: "Nothing due now" and why, on a
/// strict or preferred campaign, and the way to My contacts.
void main() {
  group('nothing due now', () {
    testWidgets('a pool campaign (no queue) keeps the waiting words', (tester) async {
      await pumpStation(tester, station());
      expect(find.text(StationCopy.nextCallComing), findsOneWidget);
      expect(find.text(StationCopy.noCallsNow), findsNothing);
      expect(find.byKey(const Key('waiting-card')), findsOneWidget);
    });

    testWidgets('due now: the waiting words, a call is on its way', (tester) async {
      await pumpStation(tester, station(queue: const QueueView(due: true)));
      expect(find.text(StationCopy.nextCallComing), findsOneWidget);
      expect(find.text(StationCopy.noCallsNow), findsNothing);
    });

    testWidgets('each reason, with the next time today as a clock and another day with its date', (tester) async {
      // t0 is 11:20 on Sat 31 Oct, local time. The subtitle says why, in the station's words
      // (design-spec §3, 02c).
      final cases = <(QueueView, String)>[
        (const QueueView(due: false, reason: QueueIdle.queueEmpty), StationCopy.noCustomersWaiting),
        (
          QueueView(due: false, reason: QueueIdle.waitingForRetry, nextDueAt: DateTime(2026, 10, 31, 15).toUtc()),
          'Your next call is at 3:00 PM.',
        ),
        (
          QueueView(due: false, reason: QueueIdle.callbacksLater, nextDueAt: DateTime(2026, 10, 31, 16, 30).toUtc()),
          'Your next call is at 4:30 PM.',
        ),
        (
          QueueView(due: false, reason: QueueIdle.outsideCallingHours, nextDueAt: DateTime(2026, 11, 2, 9).toUtc()),
          'Calls start at 9:00 AM.',
        ),
        (const QueueView(due: false, reason: QueueIdle.other), StationCopy.callsStartLater),
      ];
      for (final (queue, words) in cases) {
        await pumpStation(tester, station(queue: queue));
        expect(find.byKey(const Key('nothing-due-card')), findsOneWidget, reason: '${queue.reason}');
        expect(find.text(StationCopy.noCallsNow), findsOneWidget);
        expect(find.text(words), findsOneWidget, reason: '${queue.reason}');
        expect(find.text(StationCopy.callsWillStart), findsOneWidget);
        // The one main action is the same.
        expect(find.byKey(const Key('take-break')), findsOneWidget);
        expect(find.text(StationCopy.nextCallComing), findsNothing);
      }
    });

    testWidgets('a paused campaign says so first', (tester) async {
      await pumpStation(tester, station(dialing: false, queue: const QueueView(due: false, reason: QueueIdle.queueEmpty)));
      expect(find.text(StationCopy.callsStoppedBySupervisor), findsOneWidget);
      expect(find.text(StationCopy.noCustomersWaiting), findsNothing);
    });

    testWidgets('02c says why calls stopped, and blames the supervisor only when they did it (on pool too, BE-5)', (tester) async {
      for (final (stopped, line) in [
        (CallsStopped.bySupervisor, 'Your supervisor has stopped calls. Stay on this screen.'),
        (CallsStopped.autoPaused, 'Calls are paused for a short while. Stay on this screen.'),
        (CallsStopped.listFinished, 'Every customer on this list has been called.'),
        (CallsStopped.notStarted, 'Calls have not started yet. Stay on this screen.'),
      ]) {
        await pumpStation(tester, station(dialing: false, stopped: stopped));
        expect(find.byKey(const Key('band-no-calls')), findsOneWidget);
        expect(find.text(line), findsOneWidget, reason: '$stopped');
        if (stopped != CallsStopped.bySupervisor) expect(find.textContaining('supervisor'), findsNothing, reason: '$stopped');
      }
    });

    testWidgets('the queue changing under the screen swaps the words', (tester) async {
      final h = await pumpStation(tester, station(queue: const QueueView(due: false, reason: QueueIdle.queueEmpty)));
      expect(find.text(StationCopy.noCallsNow), findsOneWidget);
      await h.setView(station(queue: const QueueView(due: true)));
      expect(find.text(StationCopy.nextCallComing), findsOneWidget);
      expect(find.text(StationCopy.noCallsNow), findsNothing);
    });

    testWidgets('fits a 360×640 phone at 200% text', (tester) async {
      await pumpStation(
        tester,
        station(queue: QueueView(due: false, reason: QueueIdle.callbacksLater, nextDueAt: DateTime(2026, 11, 4, 10, 30))),
        size: const Size(360, 640),
        textScale: 2,
        contactAssignment: true,
      );
      expect(tester.takeException(), isNull);
      expect(find.text(StationCopy.noCallsNow), findsOneWidget);
    });
  });

  group('My customers from ⋮ More', () {
    testWidgets('hidden while the flag is off', (tester) async {
      await pumpStation(tester, station(myContactsOffered: true));
      await openMore(tester);
      expect(find.byKey(const Key('my-contacts')), findsNothing);
    });

    testWidgets('hidden with the flag on when the campaign has no My contacts (pool, no agent retry)', (tester) async {
      await pumpStation(tester, station(), contactAssignment: true);
      await openMore(tester);
      expect(find.byKey(const Key('my-contacts')), findsNothing);
    });

    testWidgets('not in ⋮ More on a call', (tester) async {
      await pumpStation(tester, station(myContactsOffered: true, phase: AgentPhase.onCall, call: call(bridgedAt: t0)), contactAssignment: true);
      await openMore(tester);
      expect(find.byKey(const Key('my-contacts')), findsNothing);
    });

    testWidgets('shown with the flag on, and opens this campaign’s contacts', (tester) async {
      await pumpStation(tester, station(myContactsOffered: true), contactAssignment: true);
      await openMore(tester);
      expect(find.byKey(const Key('my-contacts')), findsOneWidget);
      expect(find.text(StationCopy.myCustomers), findsOneWidget);
      await tester.tap(find.byKey(const Key('my-contacts')));
      await settle(tester);
      expect(find.text('my-contacts c1'), findsOneWidget);
    });
  });
}
