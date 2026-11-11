import 'dart:async';

import 'package:agency_wire/agency_wire.dart';
import 'package:fake_async/fake_async.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:magick_agency_agent/core/api/api_error.dart';
import 'package:magick_agency_agent/core/station/station_signals.dart';
import 'package:magick_agency_agent/features/missed/missed_access.dart';
import 'package:magick_agency_agent/features/missed/missed_count_controller.dart';

import '../../core/auth/support/harness.dart' show testSignalsProvider;
import 'support.dart';

/// Where the Missed list shows (the console's `useMissedCallsAccess`, with the
/// count's answer standing in for the role check the app does not keep), its
/// badge, and when the count is read.
void main() {
  late FakeMissedCallsApi api;
  late TestLifecycle lifecycle;
  late TestClock clock;

  setUp(() {
    api = FakeMissedCallsApi();
    lifecycle = TestLifecycle();
    clock = TestClock();
  });

  ProviderContainer containerWith({bool inboundOn = true}) {
    final c = ProviderContainer.test(
      overrides: missedOverrides(api, inboundOn: inboundOn, lifecycle: lifecycle, clock: clock),
    );
    // Listened, as the shell listens in the app.
    c.listen(missedCallsAccessProvider, (_, _) {});
    return c;
  }

  Future<void> settle() => pumpEventQueue();

  group('the visibility rule', () {
    test('the count answers and inbound is on: shown, with the badge', () async {
      final c = containerWith();
      expect(c.read(missedCallsAccessProvider), const MissedCallsAccess(inboundOn: true), reason: 'hidden until the count answers');
      await settle();
      expect(c.read(missedCallsAccessProvider), const MissedCallsAccess(visible: true, inboundOn: true, badge: '3'));
      expect(api.countReads, 1);
    });

    test('inbound on and nothing ever missed: shown (an empty list), no badge', () async {
      api.countAnswer = countOf(0, hasRows: false);
      final c = containerWith();
      await settle();
      expect(c.read(missedCallsAccessProvider), const MissedCallsAccess(visible: true, inboundOn: true));
    });

    test('inbound off with rows to finish: shown, under the notice', () async {
      api.countAnswer = countOf(0, hasRows: true);
      final c = containerWith(inboundOn: false);
      await settle();
      expect(c.read(missedCallsAccessProvider), const MissedCallsAccess(visible: true));
    });

    test('inbound off and no rows: hidden', () async {
      api.countAnswer = countOf(0, hasRows: false);
      final c = containerWith(inboundOn: false);
      await settle();
      expect(c.read(missedCallsAccessProvider).visible, isFalse);
    });

    test('a 403 (no agency.inbound.read) hides it, whatever the flag says', () async {
      api.countAnswer = forbidden;
      final c = containerWith();
      await settle();
      expect(c.read(missedCallsAccessProvider).visible, isFalse);
      expect(c.read(missedCountControllerProvider).reach, MissedReach.forbidden);
    });

    test('no answer (offline) keeps it hidden, and a failed re-read keeps the last answer', () async {
      api.countAnswer = const ApiNetworkError('offline');
      final c = containerWith();
      await settle();
      expect(c.read(missedCallsAccessProvider).visible, isFalse);

      api.countAnswer = countOf(2);
      lifecycle.show(); // a failed read is read again on the next return, however soon
      await settle();
      expect(c.read(missedCallsAccessProvider).badge, '2');

      api.countAnswer = const ApiNetworkError('offline');
      await c.read(missedCountControllerProvider.notifier).refresh();
      expect(c.read(missedCallsAccessProvider), const MissedCallsAccess(visible: true, inboundOn: true, badge: '2'));
    });

    test('past the server’s cap the badge says 100+', () async {
      api.countAnswer = countOf(100, capped: true);
      final c = containerWith();
      await settle();
      expect(c.read(missedCallsAccessProvider).badge, '100+');
    });
  });

  group('when the count is read', () {
    test('on return to the app at most every five minutes', () async {
      final c = containerWith();
      await settle();
      expect(api.countReads, 1);

      clock.now = clock.now.add(const Duration(minutes: 4));
      lifecycle.show();
      await settle();
      expect(api.countReads, 1, reason: 'back within five minutes: nothing read');

      clock.now = clock.now.add(const Duration(minutes: 2));
      api.countAnswer = countOf(5);
      lifecycle.show();
      await settle();
      expect(api.countReads, 2);
      expect(c.read(missedCallsAccessProvider).badge, '5');
    });

    test('a workspace change starts from hidden and reads the new account’s count', () async {
      final c = containerWith();
      await settle();
      expect(c.read(missedCallsAccessProvider).badge, '3');

      api.countAnswer = countOf(7);
      c.read(testWorkspaceProvider.notifier).set('u1:t1:a2');
      expect(c.read(missedCallsAccessProvider), const MissedCallsAccess(inboundOn: true));
      await settle();
      expect(api.countReads, 2);
      expect(c.read(missedCallsAccessProvider).badge, '7');
    });

    test('signed out: nothing is read', () async {
      final c = ProviderContainer.test(overrides: missedOverrides(api, lifecycle: lifecycle, clock: clock));
      c.read(testWorkspaceProvider.notifier).set(null);
      c.listen(missedCallsAccessProvider, (_, _) {});
      await settle();
      lifecycle.show();
      await settle();
      expect(api.countReads, 0);
    });

    test('two asks at once share one read', () async {
      final c = containerWith();
      await settle();
      final n = c.read(missedCountControllerProvider.notifier);
      await Future.wait([n.refresh(), n.refresh()]);
      expect(api.countReads, 2);
    });
  });

  group('kept fresh mid-shift', () {
    /// On a fake clock, with the console's poll and the station's signals the test sets.
    ProviderContainer polled(FakeAsync async, {bool inboundOn = true}) {
      final c = ProviderContainer(overrides: [
        ...missedOverrides(api, inboundOn: inboundOn, lifecycle: lifecycle, clock: clock, poll: missedCountPollEvery),
        stationSignalsProvider.overrideWith((ref) => ref.watch(testSignalsProvider)),
      ]);
      c.listen(missedCallsAccessProvider, (_, _) {});
      async.flushMicrotasks();
      return c;
    }

    void later(FakeAsync async, Duration d) {
      clock.now = clock.now.add(d);
      async.elapse(d);
    }

    test('polled every minute while inbound is on and the app is in front, never in the background', () {
      fakeAsync((async) {
        final c = polled(async);
        expect(api.countReads, 1);
        later(async, const Duration(seconds: 59));
        expect(api.countReads, 1);
        api.countAnswer = countOf(4);
        later(async, const Duration(seconds: 1));
        expect(api.countReads, 2);
        expect(c.read(missedCallsAccessProvider).badge, '4', reason: 'a row assigned mid-shift shows');
        later(async, missedCountPollEvery);
        expect(api.countReads, 3);

        lifecycle.hide();
        later(async, const Duration(minutes: 10));
        expect(api.countReads, 3, reason: 'no poll in the background');

        lifecycle.show();
        async.flushMicrotasks();
        expect(api.countReads, 4, reason: 'back after more than a poll: read at once');
        later(async, missedCountPollEvery);
        expect(api.countReads, 5);
        c.dispose();
      });
    });

    test('with inbound off it is not polled (the console’s rule)', () {
      fakeAsync((async) {
        api.countAnswer = countOf(1);
        final c = polled(async, inboundOn: false);
        later(async, const Duration(minutes: 10));
        expect(api.countReads, 1);
        c.dispose();
      });
    });

    test('a 403 stops the poll', () {
      fakeAsync((async) {
        api.countAnswer = forbidden;
        final c = polled(async);
        later(async, const Duration(minutes: 10));
        expect(api.countReads, 1);
        c.dispose();
      });
    });

    test('a call settling on this phone (campaign, inbound or soft phone) reads it again', () {
      fakeAsync((async) {
        final c = polled(async);
        final signals = c.read(testSignalsProvider.notifier);
        signals.set(const StationSignals(onDuty: true, callActive: true, onBreak: true, sessionKind: StationSessionKind.softphone));
        async.elapse(Duration.zero);
        expect(api.countReads, 1, reason: 'a call starting reads nothing');
        signals.set(const StationSignals(onDuty: true, outcomeOwed: true, onBreak: true, sessionKind: StationSessionKind.softphone));
        async.elapse(Duration.zero);
        expect(api.countReads, 1, reason: 'owing its outcome is not settled: the server closes the row on the outcome');
        api.countAnswer = countOf(2);
        signals.set(const StationSignals(onDuty: true, onBreak: true, sessionKind: StationSessionKind.softphone));
        async.elapse(Duration.zero);
        expect(api.countReads, 2);
        expect(c.read(missedCallsAccessProvider).badge, '2');

        // An inbound call put through on a campaign station, through its wrap-up.
        signals.set(const StationSignals(onDuty: true, callActive: true, campaignId: 'c1'));
        async.elapse(Duration.zero);
        signals.set(const StationSignals(onDuty: true, campaignId: 'c1'));
        async.elapse(Duration.zero);
        expect(api.countReads, 3);
        c.dispose();
      });
    });

    test('an earlier workspace’s read ending never lets go of this one’s', () async {
      final oldRead = Completer<InboundMissedCountResponse>();
      api.countAnswer = oldRead.future;
      final c = containerWith();
      await settle();
      expect(api.countReads, 1);

      final newRead = Completer<InboundMissedCountResponse>();
      api.countAnswer = newRead.future;
      c.read(testWorkspaceProvider.notifier).set('u1:t1:a2');
      c.read(missedCallsAccessProvider);
      await settle();
      expect(api.countReads, 2);

      oldRead.complete(countOf(9));
      await settle();
      final again = c.read(missedCountControllerProvider.notifier).refresh();
      expect(api.countReads, 2, reason: 'the new workspace’s read is still in flight: shared');
      newRead.complete(countOf(7));
      await again;
      expect(c.read(missedCallsAccessProvider).badge, '7');
    });
  });
}
