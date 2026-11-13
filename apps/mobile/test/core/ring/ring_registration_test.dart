import 'package:fake_async/fake_async.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:magick_agency_agent/core/auth/app_gate.dart';
import 'package:magick_agency_agent/core/ring/ring_channel.dart';
import 'package:magick_agency_agent/core/ring/ring_registration.dart';
import 'package:magick_agency_agent/core/ring/station_ring.dart';

import '../inbound/inbound_fixtures.dart' show pushSample;
import 'ring_harness.dart';

/// The push device's registration (Mode B): PUT once the gate is ready, on a new token and on
/// every return; opt-in by PATCH (the Me card, "Stop ringing"); DELETE on sign-out; the test
/// ring. The device id is the station device id.
void main() {
  test('nothing before the gate is ready; then PUT with the token and this build, and the checklist read', () {
    fakeAsync((async) {
      final h = RingHarness(async)..start();
      expect(h.sent, isEmpty);
      h.setGate(ready);
      final put = h.requests('PUT', devicePath).single;
      expect(put.body, {'platform': 'android', 'fcm_token': 'fcm-token-1', 'app_build': '0.1.0+1'});
      expect(h.channel.calls, containsAll(['getToken', 'checklist']));
      expect(h.settings.optIn, isTrue);
      expect(h.settings.showCard, isTrue);
      expect(h.settings.ringOn, isTrue);
      expect(h.container.read(stationRingProvider).ringOn, isTrue, reason: 'the station reads the same');
      h.dispose();
    });
  });

  test('a new token registers again; so does every return to the app', () {
    fakeAsync((async) {
      final h = RingHarness(async, gate: ready)..start();
      expect(h.requests('PUT', devicePath), hasLength(1));
      h.channel.token = 'fcm-token-2';
      h.emit(const RingTokenChanged('fcm-token-2'));
      expect(h.requests('PUT', devicePath).last.body, containsPair('fcm_token', 'fcm-token-2'));
      h.lifecycle.show();
      async.flushMicrotasks();
      expect(h.requests('PUT', devicePath), hasLength(3));
      h.dispose();
    });
  });

  test('no push on this phone: the status is only read, and ringing is off', () {
    fakeAsync((async) {
      final h = RingHarness(async, gate: ready);
      h.channel.token = null;
      h.start();
      expect(h.requests('PUT', devicePath), isEmpty);
      expect(h.requests('GET', devicePath), hasLength(1));
      expect(h.settings.token, isNull);
      expect(h.settings.ringOn, isFalse);
      h.dispose();
    });
  });

  test('opt-in by PATCH; "Stop ringing" from the away notification turns it off', () {
    fakeAsync((async) {
      final h = RingHarness(async, gate: ready)..start();
      h.registration.setOptIn(false);
      async.flushMicrotasks();
      expect(h.requests('PATCH', devicePath).single.body, {'ring_enabled': false});
      expect(h.settings.optIn, isFalse);
      expect(h.settings.ringOn, isFalse);
      h.registration.setOptIn(true);
      async.flushMicrotasks();
      expect(h.settings.optIn, isTrue);
      h.emit(const RingStopTapped());
      expect(h.requests('PATCH', devicePath).last.body, {'ring_enabled': false});
      expect(h.settings.optIn, isFalse);
      h.dispose();
    });
  });

  test('"Stop ringing" on a cold start, before the gate is ready, waits for the registration', () {
    fakeAsync((async) {
      final h = RingHarness(async)..start();
      h.emit(const RingStopTapped());
      expect(h.requests('PATCH', devicePath), isEmpty);
      h.setGate(ready);
      expect(h.requests('PATCH', devicePath).single.body, {'ring_enabled': false});
      h.dispose();
    });
  });

  test('a device the server has never seen is registered with the choice', () {
    fakeAsync((async) {
      final h = RingHarness(async, gate: ready);
      h.status = {'device': null, 'account_allows_ring': true, 'push_configured': true};
      h.start();
      h.routes['PUT $devicePath'] = (r) => jsonReply(200, {
            'device': {
              ...(pushSample('device_status_ringing')['device']! as Map<String, Object?>),
              'ring_enabled': (r.body! as Map)['ring_enabled'] ?? false,
            },
            'account_allows_ring': true,
            'push_configured': true,
          });
      h.registration.setOptIn(true);
      async.flushMicrotasks();
      expect(h.requests('PUT', devicePath).last.body, containsPair('ring_enabled', true));
      expect(h.requests('PATCH', devicePath), isEmpty);
      expect(h.settings.optIn, isTrue);
      h.dispose();
    });
  });

  test('a failed opt-in change says so and changes nothing', () {
    fakeAsync((async) {
      final h = RingHarness(async, gate: ready)..start();
      h.routes['PATCH $devicePath'] = (_) => jsonReply(503, {'error': 'Service Unavailable'});
      h.registration.setOptIn(false);
      async.flushMicrotasks();
      expect(h.settings.optIn, isTrue);
      expect(h.settings.error, 'That change didn’t go through. Try again.');
      h.dispose();
    });
  });

  test('signing out forgets the device (DELETE) through the gate\'s hook', () {
    fakeAsync((async) {
      final h = RingHarness(async, gate: ready)..start();
      h.container.read(pushDeviceTeardownProvider)();
      async.flushMicrotasks();
      expect(h.requests('DELETE', devicePath), hasLength(1));
      h.setGate(const GateSignedOut());
      expect(h.settings.status, isNull, reason: 'nothing of the last agent is kept');
      h.dispose();
    });
  });

  group('the test ring', () {
    test('sent, then success when native says it rang', () {
      fakeAsync((async) {
        final h = RingHarness(async, gate: ready)..start();
        h.registration.sendTestRing();
        async.flushMicrotasks();
        expect(h.requests('POST', '$devicePath/test-ring'), hasLength(1));
        expect(h.settings.testRing, TestRingPhase.waiting);
        h.emit(const RingTestReceived());
        expect(h.settings.testRing, TestRingPhase.received);
        h.dispose();
      });
    });

    test('it reached the phone but could not be shown: not a success', () {
      fakeAsync((async) {
        final h = RingHarness(async, gate: ready)..start();
        h.registration.sendTestRing();
        async.flushMicrotasks();
        h.emit(const RingTestReceived(shown: false));
        expect(h.settings.testRing, TestRingPhase.notShown);
        h.dispose();
      });
    });

    test('nothing arrives in 30 s: timed out; a 429 is "too soon"', () {
      fakeAsync((async) {
        final h = RingHarness(async, gate: ready)..start();
        h.registration.sendTestRing();
        async.flushMicrotasks();
        async.elapse(const Duration(seconds: 29));
        expect(h.settings.testRing, TestRingPhase.waiting);
        async.elapse(const Duration(seconds: 2));
        expect(h.settings.testRing, TestRingPhase.timedOut);
        h.routes['POST $devicePath/test-ring'] = (_) => jsonReply(429, {'error': 'Too Many Requests'});
        h.registration.sendTestRing();
        async.flushMicrotasks();
        expect(h.settings.testRing, TestRingPhase.tooSoon);
        h.dispose();
      });
    });
  });
}
