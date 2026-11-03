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
      expect(find.text('Waiting for a call'), findsOneWidget);
      expect(find.text(StationCopy.nothingDueHeadline), findsNothing);
      expect(find.byKey(const Key('waiting-card')), findsOneWidget);
    });

    testWidgets('due now: the waiting words, a call is on its way', (tester) async {
      await pumpStation(tester, station(queue: const QueueView(due: true)));
      expect(find.text('Waiting for a call'), findsOneWidget);
      expect(find.text(StationCopy.nothingDueHeadline), findsNothing);
    });

    testWidgets('each reason, with the next time today as a clock and another day with its date', (tester) async {
      // t0 is 11:20 on Sat 31 Oct, local time.
      final cases = <(QueueView, String)>[
        (const QueueView(due: false, reason: QueueIdle.queueEmpty), 'No contacts are waiting for you'),
        (
          QueueView(due: false, reason: QueueIdle.waitingForRetry, nextDueAt: DateTime(2026, 10, 31, 15).toUtc()),
          'The next one is due at 15:00.',
        ),
        (
          QueueView(due: false, reason: QueueIdle.callbacksLater, nextDueAt: DateTime(2026, 11, 4, 10, 30).toUtc()),
          'The next one is at 4 Nov · 10:30.',
        ),
        (
          QueueView(due: false, reason: QueueIdle.outsideCallingHours, nextDueAt: DateTime(2026, 11, 2, 9).toUtc()),
          'Calls resume at 2 Nov · 09:00.',
        ),
        (const QueueView(due: false, reason: QueueIdle.other), 'No calls are due for you right now.'),
      ];
      for (final (queue, words) in cases) {
        await pumpStation(tester, station(queue: queue));
        expect(find.byKey(const Key('nothing-due-card')), findsOneWidget, reason: '${queue.reason}');
        expect(find.text(StationCopy.nothingDueHeadline), findsOneWidget);
        expect(find.textContaining(words), findsOneWidget, reason: '${queue.reason}');
        expect(find.textContaining(StationCopy.nothingDueKeepOpen), findsOneWidget);
        // Still available: the pill does not change, and nothing else moved.
        expect(find.text('Available'), findsOneWidget);
        expect(find.byKey(const Key('take-break')), findsOneWidget);
        expect(find.text('Waiting for a call'), findsNothing);
      }
    });

    testWidgets('a paused campaign says so first', (tester) async {
      await pumpStation(tester, station(dialing: false, queue: const QueueView(due: false, reason: QueueIdle.queueEmpty)));
      expect(find.text('Campaign paused — no calls will come through'), findsOneWidget);
      expect(find.text(StationCopy.nothingDueHeadline), findsNothing);
    });

    testWidgets('the queue changing under the screen swaps the words', (tester) async {
      final h = await pumpStation(tester, station(queue: const QueueView(due: false, reason: QueueIdle.queueEmpty)));
      expect(find.text(StationCopy.nothingDueHeadline), findsOneWidget);
      await h.setView(station(queue: const QueueView(due: true)));
      expect(find.text('Waiting for a call'), findsOneWidget);
      expect(find.text(StationCopy.nothingDueHeadline), findsNothing);
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
      expect(find.text(StationCopy.nothingDueHeadline), findsOneWidget);
    });
  });

  group('My contacts from the waiting screen', () {
    testWidgets('hidden while the flag is off', (tester) async {
      await pumpStation(tester, station());
      expect(find.byKey(const Key('my-contacts')), findsNothing);
    });

    testWidgets('shown with the flag on, and opens this campaign’s contacts', (tester) async {
      await pumpStation(tester, station(), contactAssignment: true);
      expect(find.byKey(const Key('my-contacts')), findsOneWidget);
      await tester.ensureVisible(find.byKey(const Key('my-contacts')));
      await tester.tap(find.byKey(const Key('my-contacts')));
      await settle(tester);
      expect(find.text('my-contacts c1'), findsOneWidget);
    });
  });
}
