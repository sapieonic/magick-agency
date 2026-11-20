import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart' show SemanticsNode;
import 'package:flutter_test/flutter_test.dart';
import 'package:magick_agency_agent/core/station/station_view.dart';
import 'package:magick_agency_agent/features/station/station_copy.dart';

import 'station_harness.dart';

/// Late binding's hidden dials on the waiting screen ([StationView.dialActivity]): "Dialling a
/// customer…" while one rings, the unanswered count under the headline, and today's screen
/// when there is nothing to say. The console's words (`agencyStationIdle.ts`).
void main() {
  group('hidden dials on the waiting screen', () {
    testWidgets('ringing: dialling, with the console’s hint, and no contact at all', (tester) async {
      await pumpStation(tester, station(dialActivity: const DialActivityView(dialling: true, unansweredInARow: 0)));
      expect(find.byKey(const Key('dialling-card')), findsOneWidget);
      expect(find.text('Dialling a customer…'), findsOneWidget);
      expect(find.text(StationCopy.nextCallComing), findsNothing);
      expect(find.byKey(const Key('unanswered-line')), findsNothing);
      // Still Ready: the band and the action are Ready's.
      expect(find.byKey(const Key('band-ready')), findsOneWidget);
      expect(find.byKey(const Key('take-break')), findsOneWidget);
    });

    testWidgets('the count, singular and plural, while dialling and while plainly waiting', (tester) async {
      await pumpStation(tester, station(dialActivity: const DialActivityView(dialling: true, unansweredInARow: 1)));
      expect(find.text('Dialling a customer…'), findsOneWidget);
      expect(find.text('No answer from the last number'), findsOneWidget);

      await pumpStation(tester, station(dialActivity: const DialActivityView(dialling: false, unansweredInARow: 3)));
      expect(find.text(StationCopy.nextCallComing), findsOneWidget);
      expect(find.text('No answer from the last 3 numbers'), findsOneWidget);
      expect(find.text('Dialling a customer…'), findsNothing);
    });

    testWidgets('no dial activity: exactly today’s screen', (tester) async {
      await pumpStation(tester, station());
      expect(find.byKey(const Key('waiting-card')), findsOneWidget);
      expect(find.text(StationCopy.nextCallComing), findsOneWidget);
      expect(find.byKey(const Key('unanswered-line')), findsNothing);
      expect(find.text('Dialling a customer…'), findsNothing);
    });

    testWidgets('ringing wins over "Nothing due now"; the count does not join the nothing-due words', (tester) async {
      const nothing = QueueView(due: false, reason: QueueIdle.queueEmpty);
      await pumpStation(
        tester,
        station(queue: nothing, dialActivity: const DialActivityView(dialling: true, unansweredInARow: 2)),
      );
      expect(find.text('Dialling a customer…'), findsOneWidget);
      expect(find.text(StationCopy.noCallsNow), findsNothing);
      expect(find.text('No answer from the last 2 numbers'), findsOneWidget);

      await pumpStation(
        tester,
        station(queue: nothing, dialActivity: const DialActivityView(dialling: false, unansweredInARow: 2)),
      );
      expect(find.text(StationCopy.noCallsNow), findsOneWidget);
      expect(find.byKey(const Key('unanswered-line')), findsNothing);
    });

    testWidgets('a paused campaign keeps its words, whatever the activity says', (tester) async {
      await pumpStation(
        tester,
        station(dialing: false, dialActivity: const DialActivityView(dialling: true, unansweredInARow: 2)),
      );
      expect(find.text(StationCopy.callsStoppedBySupervisor), findsOneWidget);
      expect(find.text('Dialling a customer…'), findsNothing);
      expect(find.byKey(const Key('unanswered-line')), findsNothing);
    });

    testWidgets('the status line is a polite live region only while dialling, not on the fall back to waiting', (
      tester,
    ) async {
      final semantics = tester.ensureSemantics();
      final h = await pumpStation(tester, station());
      SemanticsNode node() => tester.getSemantics(find.byKey(const Key('state-headline')));
      expect(node().flagsCollection.isLiveRegion, isFalse);

      await h.setView(station(dialActivity: const DialActivityView(dialling: true, unansweredInARow: 0)));
      expect(node().flagsCollection.isLiveRegion, isTrue);
      expect(node().label, 'Dialling a customer…');

      // A gap past the hold with a count to show: waiting again, and not read out, or every
      // dial would announce "Waiting for a call" and then "Dialling a customer…".
      await h.setView(station(dialActivity: const DialActivityView(dialling: false, unansweredInARow: 1)));
      expect(node().flagsCollection.isLiveRegion, isFalse);
      expect(node().label, StationCopy.nextCallComing);

      // The next dial starts a new run: read out again.
      await h.setView(station(dialActivity: const DialActivityView(dialling: true, unansweredInARow: 1)));
      expect(node().flagsCollection.isLiveRegion, isTrue);
      expect(node().label, 'Dialling a customer…');
      semantics.dispose();
    });

    testWidgets('dialling with a count fits a 360×640 phone at 200% text', (tester) async {
      final views = [
        station(phaseSince: t0, dialActivity: const DialActivityView(dialling: true, unansweredInARow: 12)),
        station(phaseSince: t0, dialActivity: const DialActivityView(dialling: false, unansweredInARow: 12)),
      ];
      final h = await pumpStation(tester, station(phaseSince: t0), size: const Size(360, 640), textScale: 2);
      for (final v in views) {
        final errors = <FlutterErrorDetails>[];
        final old = FlutterError.onError;
        FlutterError.onError = errors.add;
        await h.setView(v);
        await tester.pump();
        FlutterError.onError = old;
        expect(errors, isEmpty, reason: errors.map((e) => e.toString()).join('\n'));
        expect(tester.takeException(), isNull);
        expect(find.text('No answer from the last 12 numbers'), findsOneWidget);
        // The count line is under the headline, whole, and on screen once scrolled to (at 200% the
        // band scrolls with the content).
        await tester.ensureVisible(find.byKey(const Key('unanswered-line')));
        await tester.pump();
        final r = tester.getRect(find.byKey(const Key('unanswered-line')));
        expect(r.top >= 0 && r.bottom <= 640 && r.left >= 0 && r.right <= 360, isTrue, reason: '$r');
        expect(r.top, greaterThan(tester.getRect(find.byKey(const Key('state-headline'))).top));
      }
    });
  });
}
