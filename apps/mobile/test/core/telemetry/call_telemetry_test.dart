import 'package:agency_wire/agency_wire.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:magick_agency_agent/core/telemetry/call_telemetry.dart';
import 'package:magick_agency_agent/core/telemetry/telemetry.dart';

import '../inbound/inbound_fixtures.dart';
import '../softphone/manual_calls.dart';
import 'fake_telemetry_sink.dart';

/// The call events: once per call, for both kinds, shaped as the console's
/// where it has them, each end with what the phone saw of the audio.
void main() {
  late FakeTelemetrySink sink;
  late DateTime clock;
  late CallTelemetry calls;

  setUp(() {
    clock = DateTime.utc(2026, 11, 1, 9);
    sink = installFakeTelemetry();
    calls = CallTelemetry(now: () => clock);
  });
  tearDown(Telemetry.uninstall);

  ReservedAttempt attempt(String id) => ReservedAttempt.fromJson({
        'attempt_id': id,
        'campaign_id': 'camp-1',
        'campaign_name': 'Renewals',
        'contact_id': 'c-$id',
        'phone_e164': '+919876543210',
        'caller_id': '+911234567890',
        'attempt_number': 1,
        'context': <String, Object?>{},
        'prior_attempts': <Object?>[],
      });
  ReleasedFrame released(String id, {String reason = 'remote_hangup', bool requiresDisposition = true}) =>
      ReleasedFrame(attemptId: id, reason: ReleaseReason.fromWire(reason), reasonRaw: reason, requiresDisposition: requiresDisposition, message: '');

  group('campaign calls', () {
    test('reserved → bridged → released: the console’s two events, the release with its audio', () {
      calls.campaignReserved(attempt('att-1'));
      clock = clock.add(const Duration(seconds: 6));
      calls.campaignBridged('att-1');
      calls.media
        ..binaryIn = 1500
        ..sent = 1490
        ..unsent = 3;
      clock = clock.add(const Duration(seconds: 31));
      calls.campaignReleased(released('att-1'));

      expect(sink.names, ['agency_attempt_bridged', 'agency_attempt_released']);
      expect(sink.last('agency_attempt_bridged'), {'campaign_id': 'camp-1', 'ring_seconds': 6, 'from_reconnect': false});
      expect(sink.last('agency_attempt_released'), {
        'campaign_id': 'camp-1',
        'reason': 'remote_hangup',
        'requires_disposition': true,
        'was_bridged': true,
        'talk_seconds': 31,
        'missed': false,
        'media_binary_in': 1500,
        'media_json_in': 0,
        'media_sent': 1490,
        'media_unsent': 3,
      });
    });

    test('a call that never connected: no talk time; the next call counts its audio from zero', () {
      calls.campaignReserved(attempt('att-1'));
      calls.media.binaryIn = 40;
      calls.campaignReleased(released('att-1', reason: 'no_answer', requiresDisposition: false));
      expect(sink.last('agency_attempt_released'), containsPair('was_bridged', false));
      expect(sink.last('agency_attempt_released'), containsPair('talk_seconds', 0));

      calls.campaignReserved(attempt('att-2'));
      calls.campaignReleased(released('att-2'));
      expect(sink.last('agency_attempt_released')['media_binary_in'], 0);
    });

    test('a repeated bridged frame is one event; a call rejoined mid-way is from_reconnect', () {
      calls.campaignReserved(attempt('att-1'));
      calls.campaignBridged('att-1');
      calls.campaignBridged('att-1');
      expect(sink.names, ['agency_attempt_bridged']);

      calls.campaignBridged('att-9');
      expect(sink.last('agency_attempt_bridged'), {'ring_seconds': 0, 'from_reconnect': true});
    });
  });

  group('soft-phone calls', () {
    final queued = manualCall();
    final bridged = step(queued, 11, {'state': 'bridged', 'answered_at': '2026-10-30T10:00:10.000Z', 'bridged_at': '2026-10-30T10:00:11.000Z'});
    final ended = step(queued, 45, {
      'state': 'ended',
      'outcome': 'connected',
      'end_reason': 'remote_hangup',
      'answered_at': '2026-10-30T10:00:10.000Z',
      'bridged_at': '2026-10-30T10:00:11.000Z',
      'ended_at': '2026-10-30T10:00:45.000Z',
      'talk_seconds': 34,
    });
    Map<String, Object?> failedJson([String id = 'mc-1']) =>
        {'id': id, 'state': 'ended', 'outcome': 'failed', 'end_reason': 'telephony_init_failed', 'ended_at': '2026-10-30T10:00:00.500Z'};

    test('placed here, then the station follows it: bridged once, ended once, with the outcome', () {
      calls.manualPlaced(queued);
      calls.manualChanged(queued);
      calls.manualChanged(bridged);
      calls.media
        ..binaryIn = 1700
        ..jsonIn = 2
        ..sent = 1690;
      calls.manualChanged(ended);
      calls.manualChanged(ended);

      expect(sink.names, ['agency_softphone_call_bridged', 'agency_softphone_call_ended']);
      expect(sink.last('agency_softphone_call_bridged'), {'tagged': false});
      expect(sink.last('agency_softphone_call_ended'), {
        'outcome': 'connected',
        'end_reason': 'remote_hangup',
        'state': 'ended',
        'was_bridged': true,
        'talk_seconds': 34,
        'tagged': false,
        'dnc_overridden': false,
        'hours_overridden': false,
        'media_binary_in': 1700,
        'media_json_in': 2,
        'media_sent': 1690,
        'media_unsent': 0,
      });
    });

    test('a dial that failed at once (the carrier refused it) is reported from the dial’s own answer', () {
      calls.manualPlaced(manualCall(failedJson()));
      expect(sink.names, ['agency_softphone_call_ended']);
      expect(sink.last('agency_softphone_call_ended'), containsPair('outcome', 'failed'));
      expect(sink.last('agency_softphone_call_ended'), containsPair('end_reason', 'telephony_init_failed'));
      expect(sink.last('agency_softphone_call_ended'), containsPair('was_bridged', false));
    });

    test('the station’s frame can beat the dial’s answer, in either state: still one end', () {
      final failed = manualCall(failedJson());
      calls.manualChanged(failed); // the frame, first: not known to be ours yet
      expect(sink.events, isEmpty);
      calls.manualPlaced(failed); // the dial's answer
      calls.manualChanged(failed);
      expect(sink.names, ['agency_softphone_call_ended']);

      final noAnswer = manualCall({'id': 'mc-2', 'state': 'ended', 'outcome': 'no_answer', 'ended_at': '2026-10-30T10:00:30.000Z'});
      calls.manualChanged(manualCall({'id': 'mc-2'}));
      calls.manualChanged(noAnswer);
      calls.manualPlaced(noAnswer);
      expect(sink.names, ['agency_softphone_call_ended', 'agency_softphone_call_ended']);
    });

    test('a call already over when first seen (a restart after it ended) was the last run’s to report', () {
      calls.manualChanged(ended);
      calls.manualChanged(ended);
      expect(sink.events, isEmpty);
    });

    test('a call already connected when first seen (a restart mid-call): its end is reported, its bridge is not', () {
      calls.manualChanged(bridged);
      calls.manualChanged(ended);
      expect(sink.names, ['agency_softphone_call_ended']);
    });

    test('a tagged call says so', () {
      calls.manualPlaced(manualCall({...failedJson(), 'tag': {'campaign_id': 'camp-1', 'campaign_name': 'Renewals'}}));
      expect(sink.last('agency_softphone_call_ended'), containsPair('tagged', true));
    });

    test('a new call starts its audio count from zero', () {
      calls.manualPlaced(queued);
      calls.media.binaryIn = 99;
      calls.manualPlaced(manualCall({'id': 'mc-2'}));
      calls.manualChanged(manualCall({'id': 'mc-2', 'state': 'ended', 'outcome': 'no_answer', 'ended_at': '2026-10-30T10:00:30.000Z'}));
      expect(sink.last('agency_softphone_call_ended')['media_binary_in'], 0);
    });
  });

  group('inbound calls (IQ47: the names are fixed)', () {
    const reoffered = '2026-11-02T05:31:00.000Z';
    InboundCall frame(String name, [Map<String, Object?> over = const {}]) => inboundCall(name, overrides: over);

    test('offer → connected → ended: one connect, one end with its audio', () {
      final offered = frame('inbound_call_offered');
      calls.inboundOffered(offered);
      calls.inboundChanged(offered);
      clock = clock.add(const Duration(seconds: 2));
      calls.inboundChanged(frame('inbound_call_connected'));
      calls.inboundChanged(frame('inbound_call_connected'));
      calls.media
        ..binaryIn = 900
        ..sent = 880;
      calls.inboundChanged(frame('inbound_call_outcome_owed'));
      calls.inboundChanged(frame('inbound_call_settled'));

      expect(sink.names, ['agency_inbound_call_offered', 'agency_inbound_call_connected', 'agency_inbound_call_ended']);
      expect(sink.last('agency_inbound_call_connected'),
          {'route_id': offered.route!.id, 'offer_seconds': 2, 'from_reconnect': false});
      expect(sink.last('agency_inbound_call_ended'), {
        'route_id': offered.route!.id,
        'state': 'ended',
        'outcome': 'answered',
        'was_connected': true,
        'talk_seconds': 227,
        'retired': false,
        'media_binary_in': 900,
        'media_json_in': 0,
        'media_sent': 880,
        'media_unsent': 0,
      });
    });

    test('offer → requeued → offered again → connected → ended: two whole funnels, in order', () {
      calls.inboundOffered(frame('inbound_call_offered'));
      calls.inboundChanged(frame('inbound_call_offered'));
      calls.media.binaryIn = 30;
      clock = clock.add(const Duration(seconds: 3));
      calls.inboundChanged(frame('inbound_call_offered', {'state': 'queued', 'connects_at': null}));

      clock = clock.add(const Duration(seconds: 40));
      final again = frame('inbound_call_offered', {'offered_at': reoffered});
      calls.inboundOffered(again);
      calls.inboundChanged(again);
      clock = clock.add(const Duration(seconds: 2));
      calls.inboundChanged(frame('inbound_call_connected', {'offered_at': reoffered}));
      calls.inboundChanged(frame('inbound_call_outcome_owed', {'offered_at': reoffered}));

      expect(sink.names, [
        'agency_inbound_call_offered',
        'agency_inbound_call_ended',
        'agency_inbound_call_offered',
        'agency_inbound_call_connected',
        'agency_inbound_call_ended',
      ]);
      final ends = [for (final e in sink.events) if (e.$1 == 'agency_inbound_call_ended') e.$2];
      expect(ends.first, containsPair('state', 'queued'));
      expect(ends.first, containsPair('was_connected', false));
      expect(ends.first, containsPair('media_binary_in', 30));
      expect(sink.last('agency_inbound_call_connected'), containsPair('offer_seconds', 2),
          reason: 'counted from the second offer, not the first');
      expect(sink.last('agency_inbound_call_connected'), containsPair('from_reconnect', false));
      expect(ends.last, containsPair('was_connected', true));
      expect(ends.last, containsPair('media_binary_in', 0), reason: 'the second offer counts its audio from zero');
    });

    test('a re-offer the phone saw without the requeue: the first offer ends as retired before the second starts', () {
      calls.inboundChanged(frame('inbound_call_offered'));
      calls.inboundChanged(frame('inbound_call_offered', {'offered_at': reoffered}));
      calls.inboundChanged(frame('inbound_call_connected', {'offered_at': reoffered}));
      expect(sink.names, ['agency_inbound_call_ended', 'agency_inbound_call_connected']);
      expect(sink.last('agency_inbound_call_ended'), containsPair('retired', true));
      expect(sink.last('agency_inbound_call_ended'), containsPair('state', 'offered'));
    });

    test('a copy the station let go of without a settled state reports an end, once', () {
      calls.inboundChanged(frame('inbound_call_offered'));
      calls.inboundChanged(frame('inbound_call_connected'));
      calls.inboundLetGo(frame('inbound_call_connected'));
      calls.inboundLetGo(frame('inbound_call_connected'));
      expect(sink.names, ['agency_inbound_call_connected', 'agency_inbound_call_ended']);
      expect(sink.last('agency_inbound_call_ended'), containsPair('retired', true));
      expect(sink.last('agency_inbound_call_ended'), containsPair('state', 'connected'));

      // One that already ended is not ended twice.
      calls.inboundChanged(frame('inbound_call_withheld'));
      calls.inboundChanged(frame('inbound_call_withheld', {'state': 'queued'}));
      calls.inboundLetGo(frame('inbound_call_withheld', {'state': 'queued'}));
      expect(sink.names.where((n) => n == 'agency_inbound_call_ended'), hasLength(2));
    });

    test('a call already over when first seen (a restart) is not this run\'s to report', () {
      calls.inboundChanged(frame('inbound_call_settled'));
      calls.inboundLetGo(frame('inbound_call_settled'));
      expect(sink.names, isEmpty);
    });
  });
}
