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

  softphoneTest('a refused dial is agency_softphone_call_refused, shaped as the console’s, never the number', (h) {
    h.openWith();
    h.refuse('POST $callsPath', 'outcome_pending', extra: {'call': manualCallJson({'id': 'mc-old', 'state': 'ended'})});
    h.run(h.actions.dial());
    expect(sink.names, ['agency_softphone_call_refused']);
    expect(sink.last('agency_softphone_call_refused'), {'code': 'outcome_pending', 'tagged': false});
    expect('${sink.events}', isNot(contains('9820461733')));
  });

  softphoneTest('a tagged dial says so', (h) {
    h.openWith();
    h.actions.setTag('camp-1');
    h.refuse('POST $callsPath', 'contact_in_flight', extra: {'campaign_id': 'camp-1', 'contact_id': 'c-1'});
    h.run(h.actions.dial());
    expect(sink.last('agency_softphone_call_refused'), {'code': 'contact_in_flight', 'tagged': true});
  });

  softphoneTest('a dial with no answer is agency_softphone_dial_failed', (h) {
    h.openWith();
    h.routes['POST $callsPath'] = (_) => throw http.ClientException('offline');
    h.run(h.actions.dial());
    expect(sink.names, ['agency_softphone_dial_failed']);
    expect(sink.last('agency_softphone_dial_failed'), containsPair('overrides', 'none'));
    expect(sink.last('agency_softphone_dial_failed').containsKey('code'), isFalse);
  });

  softphoneTest('a dial answered with a call already failed (the carrier refused it) is that call’s end', (h) {
    h.openWith();
    h.reply('POST $callsPath', manualCallJson({'state': 'ended', 'outcome': 'failed', 'end_reason': 'telephony_init_failed', 'ended_at': '2026-10-30T10:00:00.500Z'}), status: 201);
    h.run(h.actions.dial());
    expect(sink.names, ['agency_softphone_call_placed', 'agency_softphone_call_ended']);
    expect(sink.last('agency_softphone_call_ended'), containsPair('outcome', 'failed'));
    expect(sink.last('agency_softphone_call_ended'), containsPair('end_reason', 'telephony_init_failed'));
  });

  softphoneTest('a dial placed and still ringing: placed, as the console’s, and nothing else yet', (h) {
    h.openWith();
    h.reply('POST $callsPath', manualCallJson(), status: 201);
    h.run(h.actions.dial());
    expect(sink.names, ['agency_softphone_call_placed']);
    expect(sink.last('agency_softphone_call_placed'),
        {'tagged': false, 'overrides': 'none', 'entry': 'typed', 'surface': 'softphone_page'});
  });

  softphoneTest('placed says how the number got on the pad, as the console’s `entry`: a Missed call’s Call back', (h) {
    h.openWith(number: '');
    h.actions.callBack('+918765432109', campaignId: 'camp-1');
    h.reply('POST $callsPath', manualCallJson(), status: 201);
    h.run(h.actions.dial());
    expect(sink.last('agency_softphone_call_placed'),
        {'tagged': true, 'overrides': 'none', 'entry': 'inbound_callback', 'surface': 'softphone_page'});
  });

  softphoneTest('a Call back number edited on the pad (a backspace) is the agent\'s own: `typed`', (h) {
    h.openWith(number: '');
    h.actions.callBack('+918765432109', campaignId: 'camp-1');
    h.actions.backspace();
    h.reply('POST $callsPath', manualCallJson(), status: 201);
    h.run(h.actions.dial());
    expect(sink.last('agency_softphone_call_placed'), containsPair('entry', 'typed'));
  });

  softphoneTest('a pasted number is `pasted`', (h) {
    h.openWith(number: '');
    h.actions.pasteNumber('tel:+919820461733');
    h.reply('POST $callsPath', manualCallJson(), status: 201);
    h.run(h.actions.dial());
    expect(sink.last('agency_softphone_call_placed'), containsPair('entry', 'pasted'));
  });
}
