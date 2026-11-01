import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:magick_agency_agent/core/telemetry/call_telemetry.dart';
import 'package:magick_agency_agent/core/telemetry/telemetry.dart';

import '../softphone/fake_softphone_host.dart';
import '../softphone/manual_calls.dart';
import 'fake_telemetry_sink.dart';

/// A dial's own events, from the soft-phone core: refused (with the server's
/// code), failed (no answer, or not one the core reads), and a call the
/// carrier refused at once (`call_ended` from the dial's answer).
void main() {
  const callsPath = '/proxy/agency/softphone/calls';
  late FakeTelemetrySink sink;

  setUp(() {
    CallTelemetry.resetInstance();
    sink = installFakeTelemetry();
  });
  tearDown(Telemetry.uninstall);

  softphoneTest('a refused dial is dial_refused with the server’s code, never the number', (h) {
    h.openWith();
    h.refuse('POST $callsPath', 'outcome_pending', extra: {'call': manualCallJson({'id': 'mc-old', 'state': 'ended'})});
    h.run(h.actions.dial());
    expect(sink.names, ['dial_refused']);
    expect(sink.last('dial_refused'), {'code': 'outcome_pending', 'status': 409, 'error': 'ApiHttpError', 'overrides': false});
    expect('${sink.events}', isNot(contains('9820461733')));
  });

  softphoneTest('a dial with no answer is dial_failed', (h) {
    h.openWith();
    h.routes['POST $callsPath'] = (_) => throw http.ClientException('offline');
    h.run(h.actions.dial());
    expect(sink.names, ['dial_failed']);
    expect(sink.last('dial_failed'), containsPair('overrides', false));
    expect(sink.last('dial_failed').containsKey('code'), isFalse);
  });

  softphoneTest('a dial answered with a call already failed (the carrier refused it) is that call’s end', (h) {
    h.openWith();
    h.reply('POST $callsPath', manualCallJson({'state': 'ended', 'outcome': 'failed', 'end_reason': 'telephony_init_failed', 'ended_at': '2026-10-30T10:00:00.500Z'}), status: 201);
    h.run(h.actions.dial());
    expect(sink.names, ['call_ended']);
    expect(sink.last('call_ended'), containsPair('kind', 'softphone'));
    expect(sink.last('call_ended'), containsPair('outcome', 'failed'));
  });

  softphoneTest('a dial placed and still ringing reports nothing yet', (h) {
    h.openWith();
    h.reply('POST $callsPath', manualCallJson(), status: 201);
    h.run(h.actions.dial());
    expect(sink.events, isEmpty);
  });
}
