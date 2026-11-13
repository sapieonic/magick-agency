// Mode B's wire types (IQ58–IQ74) beyond "the fixtures decode"
// (fixtures_test.dart): the push offer on the inbound call and its lenient
// read, the push devices, the ring pushes and their reasons, the ring routes'
// bodies, the constants against the fixtures' timestamps, and the refusal
// accessors.

import 'dart:convert';

import 'package:agency_wire/agency_wire.dart';
import 'package:test/test.dart';

import 'support/fixtures.dart';

Map<String, Object?> push(String name) => fixture('push.json', name);
Map<String, Object?> st(String name) => fixture('station.json', name);

void main() {
  group('InboundCall: the offer channel', () {
    test('a station offer says so, with no ring', () {
      final f = StationFrame.decode(jsonEncode(st('inbound_call_offered'))) as InboundCallFrame;
      final call = f.inboundCall!;
      expect(call.offerChannel, InboundOfferChannel.station);
      expect(call.isPushOffer, isFalse);
      expect(call.ringExpiresAt, isNull);
      expect(call.acceptedAt, isNull);
    });

    test('a push offer: no connects_at, answered at accepted_at, and accept answers the same call', () {
      final f = StationFrame.decode(jsonEncode(st('inbound_call_push_accepted'))) as InboundCallFrame;
      final call = f.inboundCall!;
      expect(call.state, InboundCallState.offered);
      expect(call.offerChannel, InboundOfferChannel.push);
      expect(call.isPushOffer, isTrue);
      expect(call.connectsAt, isNull);
      expect(call.acceptedAt, DateTime.utc(2026, 11, 2, 8, 2, 16, 400));
      expect(InboundRingAcceptResponse.fromJson(push('ring_accept_response')).call, call);
    });

    test('a call from a server before Mode B (no ring keys) decodes as having none', () {
      final json = Map<String, Object?>.of(st('inbound_call_offered')['call']! as Map<String, Object?>)
        ..remove('offer_channel')
        ..remove('ring_expires_at')
        ..remove('accepted_at');
      final call = InboundCall.fromJson(json);
      expect(call.offerChannel, isNull);
      expect(call.offerChannelRaw, isNull);
      expect(call.isPushOffer, isFalse);
    });

    test('an unknown channel keeps its raw value; the fields take part in equality', () {
      final base = st('inbound_call_push_accepted')['call']! as Map<String, Object?>;
      final odd = InboundCall.fromJson({...base, 'offer_channel': 'carrier_pigeon'});
      expect(odd.offerChannel, InboundOfferChannel.unknown);
      expect(odd.offerChannelRaw, 'carrier_pigeon');
      final a = InboundCall.fromJson(base);
      expect(InboundCall.fromJson({...base, 'accepted_at': null}), isNot(a));
      expect(InboundCall.fromJson({...base, 'offer_channel': 'station'}), isNot(a));
      expect(InboundCall.fromJson({...base, 'ring_expires_at': '2026-11-02T08:02:30.000Z'}), isNot(a));
      expect(InboundCall.fromJson(base), a);
    });
  });

  group('the ring constants against the fixtures', () {
    test('the ring window is 20 s and the accept grace 15 s; two misses end ringing', () {
      expect(inboundRingWindow, const Duration(seconds: 20));
      expect(inboundAcceptGrace, const Duration(seconds: 15));
      expect(inboundRingMaxMisses, 2);
      final call = InboundRingAcceptResponse.fromJson(push('ring_accept_response')).call;
      final ring = RingPush.fromJson(push('push_ring'));
      expect(ring.ringExpiresAt!.difference(call.offeredAt), inboundRingWindow);
      final answering = InboundRingAnsweringResponse.fromJson(push('ring_answering_response'));
      expect(answering.acceptBy.difference(call.acceptedAt!), inboundAcceptGrace);
    });
  });

  group('PushDeviceStatus', () {
    test('a ringing device can ring; an unregistered one has no device', () {
      final ringing = PushDeviceStatus.fromJson(push('device_status_ringing'));
      expect(ringing.device!.platform, PushPlatform.android);
      expect(ringing.device!.canRing, isTrue);
      expect(ringing.accountAllowsRing, isTrue);
      expect(PushDeviceStatus.fromJson(push('device_status_unregistered')).device, isNull);
    });

    test('a failed, opted-out device says why and cannot ring', () {
      final s = PushDeviceStatus.fromJson(push('device_status_failed_opted_out'));
      expect(s.pushConfigured, isFalse);
      expect(s.device!.canRing, isFalse);
      expect(s.device!.lastFailureReason, PushFailureReason.unavailable);
      expect(s.device!.lastFailureAt, isNotNull);
    });
  });

  group('RingPush', () {
    test('each type reads its fields; the reasons read only on their own type', () {
      final ring = RingPush.fromJson(push('push_ring'));
      expect(ring.type, RingPushType.ring);
      expect(ring.offerToken, isNotNull);
      expect(ring.cancelReason, isNull);
      expect(ring.offReason, isNull);
      final cancel = RingPush.fromJson(push('push_ring_cancel'));
      expect(cancel.type, RingPushType.ringCancel);
      expect(cancel.cancelReason, InboundRingResult.callerLeft);
      expect(cancel.offReason, isNull);
      final off = RingPush.fromJson(push('push_ring_off'));
      expect(off.offReason, RingOffReason.ringMissed);
      expect(off.cancelReason, isNull);
      expect(off.awaySince, DateTime.utc(2026, 11, 2, 7, 58, 41, 120));
      expect(ring.awaySince, isNull);
      // Older servers send no away_since.
      expect(RingPush.fromJson(const {'type': 'ring_off', 'session_id': 's', 'reason': 'max_age'}).awaySince, isNull);
      // The session left with the phone parked on it: its own reason, not a take-over.
      expect(RingPush.fromJson(const {'type': 'ring_off', 'session_id': 's', 'reason': 'left'}).offReason, RingOffReason.left);
      expect(RingPush.fromJson(push('push_test_ring')).type, RingPushType.testRing);
    });

    test('a type this build does not know decodes as unknown, to be ignored', () {
      final p = RingPush.fromJson(const {'type': 'ring_louder', 'call_id': 'c'});
      expect(p.type, RingPushType.unknown);
      expect(p.typeRaw, 'ring_louder');
    });

    test('never prints the offer token', () {
      expect(RingPush.fromJson(push('push_ring')).toString(), isNot(contains('q0Vx3b9KcT1mN7zR2aW5yE')));
      expect(const InboundRingAnsweringRequest(offerToken: 'secret').toString(), isNot(contains('secret')));
      expect(
        const InboundRingDeclineRequest(offerToken: 'secret', reason: InboundRingDeclineReason.declined).toString(),
        isNot(contains('secret')),
      );
      expect(const InboundRingAcceptRequest(offerToken: 'secret', deviceId: 'd').toString(), isNot(contains('secret')));
    });
  });

  group('the requests the app sends', () {
    test('register leaves out what is not set', () {
      expect(const PushDevicePutRequest(platform: PushPlatform.android, fcmToken: 't', appBuild: '1+2').toJson(), {
        'platform': 'android',
        'fcm_token': 't',
        'app_build': '1+2',
      });
      expect(const PushDevicePatchRequest(ringEnabled: false).toJson(), {'ring_enabled': false});
    });

    test('the away break and the decline reasons are the wire codes', () {
      expect(SessionBreakRequest.awayRing().toJson(), {'reason': 'away_ring'});
      expect(const InboundRingDeclineRequest(offerToken: 't', reason: InboundRingDeclineReason.busyOnPhone).toJson(), {
        'offer_token': 't',
        'reason': 'busy_on_phone',
      });
    });
  });

  group('refusals', () {
    test('an away-ring refusal reads through awayRingCode, and is no other family\'s code', () {
      final body = ErrorBody.fromJson(push('refusal_ring_not_allowed'));
      expect(body.awayRingCode, AwayRingRefusalCode.ringNotAllowed);
      expect(body.code, AgencyErrorCode.unknown);
      expect(body.inboundCode, InboundErrorCode.unknown);
      expect(ErrorBody.fromJson(push('refusal_no_push_device')).awayRingCode, AwayRingRefusalCode.noPushDevice);
    });

    test('the ring routes\' refusals read through inboundCode', () {
      expect(
        ErrorBody.fromJson(fixture('inbound.json', 'refusal_ring_not_offered')).inboundCode,
        InboundErrorCode.ringNotOffered,
      );
      expect(
        ErrorBody.fromJson(fixture('inbound.json', 'refusal_already_accepted')).inboundCode,
        InboundErrorCode.alreadyAccepted,
      );
      expect(
        ErrorBody.fromJson(fixture('inbound.json', 'refusal_ring_expired')).inboundCode,
        InboundErrorCode.ringExpired,
      );
      expect(
        ErrorBody.fromJson(fixture('inbound.json', 'refusal_ring_expired')).awayRingCode,
        AwayRingRefusalCode.unknown,
      );
    });
  });
}
