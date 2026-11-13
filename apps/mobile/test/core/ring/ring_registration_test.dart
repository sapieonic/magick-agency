import 'package:agency_wire/agency_wire.dart' show PushDeviceStatus;
import 'package:fake_async/fake_async.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:magick_agency_agent/core/auth/app_gate.dart';
import 'package:magick_agency_agent/core/ring/ring_channel.dart';
import 'package:magick_agency_agent/core/ring/ring_registration.dart';
import 'package:magick_agency_agent/core/ring/station_ring.dart';

import '../inbound/inbound_fixtures.dart' show pushSample;
import 'ring_harness.dart';

/// The push device's registration (Mode B): PUT once the gate is ready, on a new token and on
/// a return unless a recent PUT stands; opt-in by PATCH (the Me card); DELETE on sign-out; the test
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

  test('a new token registers again; so does a return to the app once the last register is 6 h old', () {
    fakeAsync((async) {
      final h = RingHarness(async, gate: ready)..start();
      expect(h.requests('PUT', devicePath), hasLength(1));
      h.channel.token = 'fcm-token-2';
      h.emit(const RingTokenChanged('fcm-token-2'));
      expect(h.requests('PUT', devicePath).last.body, containsPair('fcm_token', 'fcm-token-2'));
      async.elapse(RingRegistration.registerFreshFor);
      h.lifecycle.show();
      async.flushMicrotasks();
      expect(h.requests('PUT', devicePath), hasLength(3));
      h.dispose();
    });
  });

  test('a return soon after a register, nothing changed: no PUT, the status kept, the checklist read again', () {
    fakeAsync((async) {
      final h = RingHarness(async, gate: ready)..start();
      final status = h.settings.status;
      async.elapse(const Duration(hours: 5, minutes: 59));
      h.channel.list = const RingChecklist({RingChecklistItem.notifications: false});
      h.lifecycle.show();
      async.flushMicrotasks();
      expect(h.requests('PUT', devicePath), hasLength(1));
      expect(h.requests('GET', devicePath), isEmpty);
      expect(h.settings.status, status);
      expect(h.channel.named('checklist'), hasLength(2));
      expect(h.settings.ringOn, isFalse, reason: 'leaving the app reads the checklist as it is now');
      h.dispose();
    });
  });

  test('a return after the opt-in changed, or after a status saying the server lost the device, registers again', () {
    fakeAsync((async) {
      final h = RingHarness(async, gate: ready)..start();
      h.registration.setOptIn(false);
      async.flushMicrotasks();
      h.lifecycle.show();
      async.flushMicrotasks();
      expect(h.requests('PUT', devicePath), hasLength(2), reason: 'the opt-in changed since the last PUT');
      h.lifecycle.show();
      async.flushMicrotasks();
      expect(h.requests('PUT', devicePath), hasLength(2));
      h.status = pushSample('device_status_unregistered');
      h.registration.readStatus();
      async.flushMicrotasks();
      h.lifecycle.show();
      async.flushMicrotasks();
      expect(h.requests('PUT', devicePath), hasLength(3), reason: 'the server no longer holds it');
      h.dispose();
    });
  });

  test('a new agent on the same phone registers at once', () {
    fakeAsync((async) {
      final h = RingHarness(async, gate: ready)..start();
      h.setGate(const GateReady(userId: 'u2', displayName: 'Ravi S', email: 'ravi@example.test', tenantId: 'ten-1', accountId: 'acc-1', accountName: 'Chennai'));
      expect(h.requests('PUT', devicePath), hasLength(2));
      h.dispose();
    });
  });

  test('the station\'s status read on return reuses the return\'s own register (in flight or answered); '
      'with no register sent, it reads', () {
    fakeAsync((async) {
      final h = RingHarness(async, gate: ready)..start();
      async.elapse(RingRegistration.registerFreshFor);
      h.lifecycle.show();
      PushDeviceStatus? read;
      h.registration.readStatus().then((s) => read = s);
      async.flushMicrotasks();
      expect(h.requests('PUT', devicePath), hasLength(2));
      expect(h.requests('GET', devicePath), isEmpty, reason: 'the PUT in flight answers it');
      expect(read, isNotNull);
      h.registration.readStatus();
      async.flushMicrotasks();
      expect(h.requests('GET', devicePath), isEmpty, reason: 'the PUT answered since this return');
      h.lifecycle.show();
      async.flushMicrotasks();
      expect(h.requests('PUT', devicePath), hasLength(2), reason: 'nothing changed: no PUT');
      h.registration.readStatus();
      async.flushMicrotasks();
      expect(h.requests('GET', devicePath), hasLength(1), reason: 'nothing asked since this return');
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

  test('opt-in by PATCH, from the Me card', () {
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
      expect(h.requests('PATCH', devicePath).last.body, {'ring_enabled': true});
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
