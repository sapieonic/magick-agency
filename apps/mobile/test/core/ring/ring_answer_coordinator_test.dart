import 'dart:async';

import 'package:fake_async/fake_async.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:magick_agency_agent/core/auth/app_gate.dart';
import 'package:magick_agency_agent/core/ring/ring_channel.dart';
import 'package:magick_agency_agent/core/ring/ring_copy.dart';
import 'package:magick_agency_agent/core/ring/station_ring.dart';

import '../inbound/inbound_fixtures.dart' show pushSample;
import '../station/controller_harness.dart' show Sent;
import 'ring_harness.dart';

/// Answering from a ring (IQ71): the gate resolves, the answered ring is taken (`pendingAnswer`
/// on a cold start, `ringAnswered` while running), `POST …/ring/accept {offer_token, device_id}`,
/// then the station resumes on the answer. One retry on a failure that says nothing about the
/// call; then the agent is told and native ends the call.

const _callId = '7d2b9e4f-6a1c-4e3d-8b5a-2f9c0e1d7a64';
const _acceptPath = '/proxy/agency/inbound/calls/$_callId/ring/accept';
const _answer = RingAnswer(callId: _callId, offerToken: 'q0Vx3b9KcT1mN7zR2aW5yE', sessionId: 'sess-1');

void main() {
  RingHarness harness(FakeAsync async, {bool signedIn = true}) {
    final h = RingHarness(async, gate: signedIn ? ready : const GateLoading());
    h.routes['POST $_acceptPath'] = (_) => jsonReply(200, pushSample('ring_accept_response'));
    return h;
  }

  test('a cold start: once the gate is ready, the pending answer is accepted with this device, and the station resumes', () {
    fakeAsync((async) {
      final h = harness(async, signedIn: false);
      h.channel.pending = _answer;
      h.start();
      expect(h.requests('POST', _acceptPath), isEmpty, reason: 'the accept needs the sign-in and scope');
      h.setGate(ready);
      final accept = h.requests('POST', _acceptPath).single;
      expect(accept.body, {'offer_token': 'q0Vx3b9KcT1mN7zR2aW5yE', 'device_id': ringDeviceId});
      expect(accept.headers['authorization'], 'Bearer tok');
      expect(h.resumed.single.call.id, _callId);
      expect(h.channel.named('pendingAnswer'), hasLength(1));
      expect(h.channel.named('reportEnded'), isEmpty);
      h.dispose();
    });
  });

  test('two answers before the gate is ready: the first is reported ended, only the second is accepted', () {
    fakeAsync((async) {
      final h = harness(async, signedIn: false);
      const other = RingAnswer(callId: 'call-0', offerToken: 'old-token', sessionId: 'sess-1');
      h.start();
      h.emit(const RingAnswered(other));
      h.emit(const RingAnswered(_answer));
      expect(h.channel.named('reportEnded'), ['reportEnded:call-0:accept_failed'], reason: 'native lets the replaced call go');
      h.setGate(ready);
      expect(h.requests('POST', _acceptPath), hasLength(1));
      expect(h.requests('POST', '/proxy/agency/inbound/calls/call-0/ring/accept'), isEmpty);
      expect(h.resumed.single.call.id, _callId);
      h.dispose();
    });
  });

  test('a cold start from "Stop ringing": once the gate is ready, the station pauses that session (device_away)', () {
    fakeAsync((async) {
      final h = harness(async, signedIn: false);
      h.channel.stop = const RingStopRequest(sessionId: 'sess-1');
      h.start();
      expect(h.station.calls, isEmpty);
      h.setGate(ready);
      expect(h.station.calls, ['stopRinging:sess-1']);
      expect(h.requests('POST', _acceptPath), isEmpty);
      expect(h.channel.named('peekStopRinging'), hasLength(1));
      expect(h.channel.named('clearStopRinging'), isEmpty, reason: 'read, not taken: cleared once device_away applied');
      h.dispose();
    });
  });

  test('a cold start whose "Stop ringing" names no session: nothing to pause, so it is let go', () {
    fakeAsync((async) {
      final h = harness(async, signedIn: false);
      h.channel.stop = const RingStopRequest();
      h.start();
      h.setGate(ready);
      expect(h.station.calls, isEmpty);
      expect(h.channel.named('clearStopRinging'), hasLength(1));
      h.dispose();
    });
  });

  test('answered with the app running: accepted at once', () {
    fakeAsync((async) {
      final h = harness(async)..start();
      h.emit(const RingAnswered(_answer));
      expect(h.requests('POST', _acceptPath), hasLength(1));
      expect(h.resumed, hasLength(1));
      h.dispose();
    });
  });

  test('the same answer delivered twice (ringAnswered, then pendingAnswer) is accepted once', () {
    fakeAsync((async) {
      final h = harness(async, signedIn: false);
      h.start();
      h.emit(const RingAnswered(_answer));
      h.channel.pending = _answer;
      h.setGate(ready);
      expect(h.requests('POST', _acceptPath), hasLength(1));
      h.emit(const RingAnswered(_answer));
      expect(h.requests('POST', _acceptPath), hasLength(1));
      expect(h.resumed, hasLength(1));
      h.dispose();
    });
  });

  test('an answered call that could not be taken: native\'s accept_lapsed is not a "Missed inbound call"', () {
    fakeAsync((async) {
      final h = harness(async)..start();
      h.routes['POST $_acceptPath'] = (_) => jsonReply(404, pushSample('refusal_no_push_device')..['code'] = 'ring_not_offered');
      h.emit(const RingAnswered(_answer));
      h.emit(RingEnded(_callId, 'accept_lapsed'));
      expect(h.channel.named('showMissedRing'), isEmpty);
      h.dispose();
    });
  });

  test('a failure that says nothing about the call is retried once, then succeeds', () {
    fakeAsync((async) {
      final h = harness(async)..start();
      var n = 0;
      h.routes['POST $_acceptPath'] = (_) => ++n == 1 ? jsonReply(503, {'error': 'Service Unavailable'}) : jsonReply(200, pushSample('ring_accept_response'));
      h.emit(const RingAnswered(_answer));
      async.elapse(const Duration(seconds: 2));
      expect(h.requests('POST', _acceptPath), hasLength(2));
      expect(h.resumed, hasLength(1));
      expect(h.container.read(ringNoticeProvider), isNull);
      h.dispose();
    });
  });

  test('two failures: "This call stopped ringing or someone else took it." and native ends the call', () {
    fakeAsync((async) {
      final h = harness(async)..start();
      h.routes['POST $_acceptPath'] = (_) => jsonReply(503, {'error': 'Service Unavailable'});
      h.emit(const RingAnswered(_answer));
      async.elapse(const Duration(seconds: 2));
      expect(h.requests('POST', _acceptPath), hasLength(2), reason: 'one retry, no more');
      expect(h.resumed, isEmpty);
      expect(h.container.read(ringNoticeProvider), RingCopy.acceptFailed);
      expect(h.container.read(ringNoticeProvider), 'This call stopped ringing or someone else took it.');
      expect(h.channel.named('reportEnded'), ['reportEnded:$_callId:accept_failed']);
      h.dispose();
    });
  });

  test('the server says the ring is gone (ring_not_offered): no retry', () {
    fakeAsync((async) {
      final h = harness(async)..start();
      h.routes['POST $_acceptPath'] = (_) => jsonReply(404, pushSample('refusal_no_push_device')..['code'] = 'ring_not_offered');
      h.emit(const RingAnswered(_answer));
      async.elapse(const Duration(seconds: 2));
      expect(h.requests('POST', _acceptPath), hasLength(1));
      expect(h.channel.named('reportEnded'), ['reportEnded:$_callId:accept_failed']);
      expect(h.container.read(ringNoticeProvider), RingCopy.acceptFailed);
      h.dispose();
    });
  });

  group('already_accepted: this phone\'s own station attached first (N5)', () {
    Object alreadyAccepted(Sent _) =>
        jsonReply(409, pushSample('refusal_no_push_device')..['code'] = 'already_accepted');

    test('the station holds the call: it goes on, no notice, native not told to end it', () {
      fakeAsync((async) {
        final h = harness(async)..start();
        h.routes['POST $_acceptPath'] = alreadyAccepted;
        h.station.holds.add(_callId);
        h.emit(const RingAnswered(_answer));
        async.elapse(const Duration(seconds: 2));
        expect(h.requests('POST', _acceptPath), hasLength(1));
        expect(h.station.calls, ['hold:$_callId', 'holdsCall:$_callId', 'release:$_callId']);
        expect(h.channel.named('reportEnded'), isEmpty);
        expect(h.container.read(ringNoticeProvider), isNull);
        h.dispose();
      });
    });

    test('the call reaches the station inside the window (its frame after the 409): it goes on', () {
      fakeAsync((async) {
        final h = harness(async)..start();
        h.routes['POST $_acceptPath'] = alreadyAccepted;
        h.station.holdsAfter = (callId: _callId, after: const Duration(seconds: 2));
        h.emit(const RingAnswered(_answer));
        async.elapse(const Duration(seconds: 6));
        expect(h.channel.named('reportEnded'), isEmpty);
        expect(h.container.read(ringNoticeProvider), isNull);
        h.dispose();
      });
    });

    test('the station never shows the call: another device took it, and the agent is told', () {
      fakeAsync((async) {
        final h = harness(async)..start();
        h.routes['POST $_acceptPath'] = alreadyAccepted;
        h.emit(const RingAnswered(_answer));
        async.elapse(const Duration(seconds: 4));
        expect(h.channel.named('reportEnded'), isEmpty, reason: 'still inside the window');
        async.elapse(const Duration(seconds: 2));
        expect(h.requests('POST', _acceptPath), hasLength(1), reason: 'a refusal: no retry');
        expect(h.channel.named('reportEnded'), ['reportEnded:$_callId:accept_failed']);
        expect(h.container.read(ringNoticeProvider), RingCopy.acceptFailed);
        expect(h.station.calls.last, 'release:$_callId');
        h.dispose();
      });
    });
  });

  test('the station is held for the accept from the answer until it resumes', () {
    fakeAsync((async) {
      final h = harness(async)..start();
      h.emit(const RingAnswered(_answer));
      expect(h.station.calls, ['hold:$_callId', 'resume:$_callId']);
      h.dispose();
    });
  });

  group('hung up on the phone while it connects (the "Connecting the call…" notification, a headset)', () {
    test('after the accept went through: the station hangs the call up once it binds', () {
      fakeAsync((async) {
        final h = harness(async)..start();
        h.emit(const RingAnswered(_answer));
        expect(h.resumed, hasLength(1));
        h.emit(RingEnded(_callId, 'declined'));
        expect(h.station.calls.last, 'hangUp:$_callId');
        h.emit(RingEnded(_callId, 'declined'));
        expect(h.station.calls.where((c) => c.startsWith('hangUp')), hasLength(1), reason: 'once');
        h.dispose();
      });
    });

    test('the decline beat the accept: the refused accept is not "someone else took it"', () {
      fakeAsync((async) {
        final h = harness(async)..start();
        final reply = Completer<Object?>();
        h.routes['POST $_acceptPath'] = (_) => reply.future;
        h.emit(const RingAnswered(_answer));
        h.emit(RingEnded(_callId, 'declined'));
        reply.complete(jsonReply(404, pushSample('refusal_no_push_device')..['code'] = 'ring_not_offered'));
        async.elapse(const Duration(seconds: 2));
        expect(h.channel.named('reportEnded'), ['reportEnded:$_callId:accept_failed']);
        expect(h.container.read(ringNoticeProvider), isNull);
        h.dispose();
      });
    });

    test('a ring declined before it was answered is only a decline', () {
      fakeAsync((async) {
        final h = harness(async)..start();
        h.emit(RingEnded(_callId, 'declined'));
        expect(h.station.calls, isEmpty);
        h.dispose();
      });
    });
  });

  test('a ring that rang out is a missed ring: native posts "Missed inbound call"; a decline is not', () {
    fakeAsync((async) {
      final h = harness(async)..start();
      h.emit(RingEnded(_callId, 'expired'));
      expect(h.channel.named('showMissedRing'), hasLength(1));
      h.emit(RingEnded('call-2', 'declined'));
      h.emit(RingEnded('call-3', 'busy_on_phone'));
      h.emit(RingEnded('call-4', 'answered_elsewhere'));
      expect(h.channel.named('showMissedRing'), hasLength(1));
      h.emit(RingEnded('call-5', 'accept_lapsed'));
      expect(h.channel.named('showMissedRing'), hasLength(2));
      h.dispose();
    });
  });
}
