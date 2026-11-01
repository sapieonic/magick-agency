import 'dart:convert';
import 'dart:typed_data';

import 'package:fake_async/fake_async.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:magick_agency_agent/core/telemetry/call_telemetry.dart';
import 'package:magick_agency_agent/core/telemetry/telemetry.dart';

import '../softphone/manual_calls.dart';
import '../station/controller_harness.dart';
import 'fake_telemetry_sink.dart';

/// The station controller feeds the call events: the frames that start and
/// end a call, and every audio frame in and out, counted on the way.
void main() {
  late FakeTelemetrySink sink;

  setUp(() {
    CallTelemetry.resetInstance();
    sink = installFakeTelemetry();
  });
  tearDown(Telemetry.uninstall);

  final alaw = Uint8List(160);
  Map<String, Object?> jsonMedia() => {
        'event': 'media',
        'media': {'payload': base64.encode(Uint8List(640))},
      };

  test('a campaign call: connected, then ended with the frames this phone received and sent', () {
    fakeAsync((async) {
      final app = App(async)..start();
      app.onCall('att-1');
      for (var i = 0; i < 3; i++) {
        app.socket.serverBinary(alaw);
      }
      app.frame(jsonMedia());
      app.engine
        ..emitUplink(alaw)
        ..emitUplink(alaw);
      async.flushMicrotasks();
      app.releasedFrame('att-1');

      expect(sink.names, ['agency_attempt_bridged', 'agency_attempt_released']);
      expect(sink.last('agency_attempt_bridged'), containsPair('campaign_id', 'camp-1'));
      final released = sink.last('agency_attempt_released');
      expect(released, containsPair('campaign_id', 'camp-1'));
      expect(released, containsPair('reason', 'remote_hangup'));
      expect(released, containsPair('was_bridged', true));
      expect(released, containsPair('media_binary_in', 3));
      expect(released, containsPair('media_json_in', 1));
      expect(released, containsPair('media_sent', 2));
      expect(app.socket.sentBinary, 2, reason: 'counted, and still sent');
      app.dispose();
    });
  });

  test('a mic frame the closed socket could not take is counted as unsent', () {
    fakeAsync((async) {
      final app = App(async)..start();
      app.onCall('att-1');
      app.socket.serverClose(1006);
      app.engine.emitUplink(alaw);
      async.flushMicrotasks();
      app.readyFrame('on_call');
      app.releasedFrame('att-1');
      expect(sink.last('agency_attempt_released'), containsPair('media_unsent', 1));
      app.dispose();
    });
  });

  test('a soft-phone call the station follows: connected and ended from its manual_call frames', () {
    fakeAsync((async) {
      final app = App(async)..start();
      app.readyFrame('available');
      app.manualCallFrame(manualCallJson({'session_id': 'sess-1', 'state': 'ringing'}));
      app.manualCallFrame(manualCallJson({
        'session_id': 'sess-1',
        'state': 'bridged',
        'bridged_at': '2026-10-30T10:00:11.000Z',
        'updated_at': '2026-10-30T10:00:11.000Z',
      }));
      app.socket.serverBinary(alaw);
      app.manualCallFrame(manualCallJson({
        'session_id': 'sess-1',
        'state': 'ended',
        'outcome': 'connected',
        'end_reason': 'remote_hangup',
        'bridged_at': '2026-10-30T10:00:11.000Z',
        'ended_at': '2026-10-30T10:00:40.000Z',
        'talk_seconds': 29,
        'updated_at': '2026-10-30T10:00:40.000Z',
      }));

      expect(sink.names, ['agency_softphone_call_bridged', 'agency_softphone_call_ended']);
      final ended = sink.last('agency_softphone_call_ended');
      expect(ended, containsPair('outcome', 'connected'));
      expect(ended, containsPair('talk_seconds', 29));
      expect(ended, containsPair('media_binary_in', 1));
      app.dispose();
    });
  });
}
