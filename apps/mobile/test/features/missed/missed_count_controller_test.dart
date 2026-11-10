import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:magick_agency_agent/core/api/api_error.dart';
import 'package:magick_agency_agent/features/missed/missed_access.dart';
import 'package:magick_agency_agent/features/missed/missed_count_controller.dart';

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
}
