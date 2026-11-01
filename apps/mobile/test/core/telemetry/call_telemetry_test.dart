import 'package:agency_wire/agency_wire.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:magick_agency_agent/core/telemetry/call_telemetry.dart';
import 'package:magick_agency_agent/core/telemetry/telemetry.dart';

import '../softphone/manual_calls.dart';
import 'fake_telemetry_sink.dart';

/// `call_connected` / `call_ended`: once per call, for both kinds, each end
/// with what the phone saw of the audio.
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

  ReleasedFrame released(String id, {String reason = 'remote_hangup', bool requiresDisposition = true}) =>
      ReleasedFrame(attemptId: id, reason: ReleaseReason.fromWire(reason), reasonRaw: reason, requiresDisposition: requiresDisposition, message: '');

  group('campaign calls', () {
    test('reserved → bridged → released: connected, then ended with its time on the line and its audio', () {
      calls.campaignReserved('att-1');
      calls.campaignBridged('att-1');
      calls.media
        ..binaryIn = 1500
        ..sent = 1490
        ..unsent = 3;
      clock = clock.add(const Duration(seconds: 31));
      calls.campaignReleased(released('att-1'));

      expect(sink.names, ['call_connected', 'call_ended']);
      expect(sink.last('call_connected'), {'kind': 'campaign'});
      expect(sink.last('call_ended'), {
        'kind': 'campaign',
        'reason': 'remote_hangup',
        'connected': true,
        'requires_disposition': true,
        'connected_s': 31,
        'media_binary_in': 1500,
        'media_json_in': 0,
        'media_sent': 1490,
        'media_unsent': 3,
      });
    });

    test('a call that never connected ends without a time; the next call counts from zero', () {
      calls.campaignReserved('att-1');
      calls.media.binaryIn = 40;
      calls.campaignReleased(released('att-1', reason: 'no_answer', requiresDisposition: false));
      expect(sink.last('call_ended')['connected'], isFalse);
      expect(sink.last('call_ended').containsKey('connected_s'), isFalse);

      calls.campaignReserved('att-2');
      calls.campaignReleased(released('att-2'));
      expect(sink.last('call_ended')['media_binary_in'], 0);
    });

    test('a repeated bridged frame (a reconnect replays it) is one connect', () {
      calls.campaignReserved('att-1');
      calls.campaignBridged('att-1');
      calls.campaignBridged('att-1');
      expect(sink.names, ['call_connected']);
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

    test('placed here, then the station follows it: connected once, ended once, with the outcome', () {
      calls.manualPlaced(queued);
      calls.manualChanged(queued);
      calls.manualChanged(bridged);
      calls.media
        ..binaryIn = 1700
        ..jsonIn = 2
        ..sent = 1690;
      calls.manualChanged(ended);
      calls.manualChanged(ended);

      expect(sink.names, ['call_connected', 'call_ended']);
      expect(sink.last('call_connected'), {'kind': 'softphone'});
      expect(sink.last('call_ended'), {
        'kind': 'softphone',
        'outcome': 'connected',
        'end_reason': 'remote_hangup',
        'state': 'ended',
        'connected': true,
        'talk_s': 34,
        'dnc_overridden': false,
        'hours_overridden': false,
        'media_binary_in': 1700,
        'media_json_in': 2,
        'media_sent': 1690,
        'media_unsent': 0,
      });
    });

    test('a dial that failed at once (the carrier refused it) is reported from the dial’s own answer', () {
      final failed = manualCall({'state': 'ended', 'outcome': 'failed', 'end_reason': 'telephony_init_failed', 'ended_at': '2026-10-30T10:00:00.500Z'});
      calls.manualPlaced(failed);
      expect(sink.names, ['call_ended']);
      expect(sink.last('call_ended')['outcome'], 'failed');
      expect(sink.last('call_ended')['end_reason'], 'telephony_init_failed');
      expect(sink.last('call_ended')['connected'], isFalse);
    });

    test('the station’s frame can beat the dial’s answer, in either state: still one end', () {
      final failed = manualCall({'state': 'ended', 'outcome': 'failed', 'ended_at': '2026-10-30T10:00:00.500Z'});
      calls.manualChanged(failed); // the frame, first: not known to be ours yet
      expect(sink.events, isEmpty);
      calls.manualPlaced(failed); // the dial's answer
      calls.manualChanged(failed);
      expect(sink.names, ['call_ended']);

      calls.manualChanged(manualCall({'id': 'mc-2'}));
      calls.manualChanged(manualCall({'id': 'mc-2', 'state': 'ended', 'outcome': 'no_answer', 'ended_at': '2026-10-30T10:00:30.000Z'}));
      calls.manualPlaced(manualCall({'id': 'mc-2', 'state': 'ended', 'outcome': 'no_answer', 'ended_at': '2026-10-30T10:00:30.000Z'}));
      expect(sink.names, ['call_ended', 'call_ended']);
    });

    test('a call already over when first seen (a restart after it ended) was the last run’s to report', () {
      calls.manualChanged(ended);
      calls.manualChanged(ended);
      expect(sink.events, isEmpty);
    });

    test('a call already connected when first seen (a restart mid-call): its end is reported, its connect is not', () {
      calls.manualChanged(bridged);
      calls.manualChanged(ended);
      expect(sink.names, ['call_ended']);
    });

    test('a new call starts its audio count from zero', () {
      calls.manualPlaced(queued);
      calls.media.binaryIn = 99;
      calls.manualPlaced(manualCall({'id': 'mc-2'}));
      calls.manualChanged(manualCall({'id': 'mc-2', 'state': 'ended', 'outcome': 'no_answer', 'ended_at': '2026-10-30T10:00:30.000Z'}));
      expect(sink.last('call_ended')['media_binary_in'], 0);
    });
  });
}
