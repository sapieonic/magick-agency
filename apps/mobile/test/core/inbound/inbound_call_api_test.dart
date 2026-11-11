import 'dart:convert';

import 'package:agency_wire/agency_wire.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:magick_agency_agent/core/api/api_client.dart';
import 'package:magick_agency_agent/core/api/api_error.dart';
import 'package:magick_agency_agent/core/api/client_identity.dart';
import 'package:magick_agency_agent/core/inbound/inbound_call_api.dart';
import 'package:magick_agency_agent/core/inbound/inbound_copy.dart';

import '../station/controller_harness.dart' show FakeTokens, testEnv;
import 'inbound_fixtures.dart';

http.Response _json(int status, Object body) =>
    http.Response(jsonEncode(body), status, headers: {'content-type': 'application/json'});

void main() {
  late List<http.Request> seen;
  late List<ApiUnauthorized> unauthorized;

  InboundCallApi api(Future<http.Response> Function(http.Request) handler) {
    seen = [];
    unauthorized = [];
    return InboundCallApi(
      ApiClient(
        http: MockClient((r) {
          seen.add(r);
          return handler(r);
        }),
        env: testEnv,
        tokens: FakeTokens(),
        identity: ClientIdentity.test,
        scope: RequestScope()
          ..tenantId = 'ten-1'
          ..accountId = 'acc-1',
      ),
      onUnauthorized: unauthorized.add,
    );
  }

  test('the five routes: paths, methods and bodies (the console\'s INBOUND_PATHS)', () async {
    final callBody = {'call': inboundCallJson('inbound_call_connected')};
    final a = api((r) async {
      if (r.url.path.endsWith('/disposition')) return _json(200, inboundSample('call_disposition_response'));
      if (r.url.path.endsWith('/dnc')) return _json(200, inboundSample('call_dnc_response'));
      return _json(200, callBody);
    });
    expect(await a.getCall('c 1'), isA<InboundOk<InboundCall>>());
    await a.updateNotes('c1', '');
    await a.hangup('c1');
    final saved = await a.disposition('c1', InboundCallDispositionRequest(code: 'callback', callbackAt: DateTime.utc(2026, 11, 5, 9, 30)));
    final dnc = await a.markDnc('c1', reason: '   ');
    expect([for (final r in seen) '${r.method} ${r.url.path}'], [
      'GET /proxy/agency/inbound/calls/c%201',
      'PATCH /proxy/agency/inbound/calls/c1',
      'POST /proxy/agency/inbound/calls/c1/hangup',
      'POST /proxy/agency/inbound/calls/c1/disposition',
      'POST /proxy/agency/inbound/calls/c1/dnc',
    ]);
    expect(jsonDecode(seen[1].body), {'notes': ''}, reason: 'cleared notes go as an empty string');
    expect(jsonDecode(seen[3].body), {'code': 'callback', 'callback_at': '2026-11-05T09:30:00.000Z'});
    expect(jsonDecode(seen[4].body), <String, Object?>{}, reason: 'a blank reason is left out');
    expect((saved as InboundOk<InboundCallDispositionResponse>).value.call.isSettled, isTrue);
    expect((dnc as InboundOk<InboundCallDncResponse>).value.scope, DncEntryScope.campaign);
  });

  group('refusals are typed values, never thrown', () {
    Future<InboundRefusal> refused(int status, Map<String, Object?> body) async {
      final r = await api((_) async => _json(status, body)).disposition('c1', const InboundCallDispositionRequest(code: 'x'));
      return (r as InboundRefused).refusal;
    }

    test('inbound_disposition_invalid unknown_code: the rule and the codes the catalog takes', () async {
      final r = await refused(400, inboundSample('refusal_disposition_unknown_code'));
      expect(r.code, InboundErrorCode.inboundDispositionInvalid);
      expect(r.rule, InboundDispositionRule.unknownCode);
      expect(r.allowedCodes, ['interested', 'callback', 'query_resolved', 'complaint', 'do_not_call']);
      expect(r.status, 400);
      expect(inboundDispositionRefusalCopy(r), 'The outcome list for this call changed. Pick one of these.');
    });

    test('note_required, said as the rule', () async {
      final r = await refused(400, inboundSample('refusal_disposition_note_required'));
      expect(r.rule, InboundDispositionRule.noteRequired);
      expect(r.allowedCodes, isNull);
      expect(inboundDispositionRefusalCopy(r), 'This outcome needs a note.');
    });

    test('already saved: the call is gone; after the window it reads as the lapse', () async {
      final r = await refused(409, inboundSample('refusal_outcome_already_saved'));
      expect(r.code, InboundErrorCode.inboundOutcomeAlreadySaved);
      expect(r.callGone, isTrue);
      expect(r.transient, isFalse);
      expect(inboundDispositionRefusalCopy(r), 'This call’s outcome is already saved.');
      expect(inboundDispositionRefusalCopy(r, windowEnded: true), inboundOutcomeWindowEndedCopy);
    });

    test('not found is gone; inbound_call_live names its call', () async {
      expect((await refused(404, inboundSample('refusal_call_not_found'))).callGone, isTrue);
      final live = await refused(409, inboundSample('refusal_call_live'));
      expect(live.code, InboundErrorCode.inboundCallLive);
      expect(live.inboundCallId, fixtureCallId);
    });

    test('a 5xx, a network failure or an unreadable answer is transient and says nothing of the call', () async {
      final server = await refused(503, {'error': 'Service Unavailable', 'message': 'x'});
      expect(server.transient, isTrue);
      expect(server.code, InboundErrorCode.unknown);
      expect(server.callGone, isFalse);
      final down = await api((_) async => throw http.ClientException('offline')).getCall('c1');
      expect((down as InboundRefused).refusal.transient, isTrue);
      final garbled = await api((_) async => _json(200, {'call': {'id': 1}})).getCall('c1');
      expect((garbled as InboundRefused).refusal.transient, isTrue);
      expect((garbled as InboundRefused).refusal.error, isA<ApiDecodeError>());
    });

    test('an unknown code keeps the server\'s sentence', () async {
      final r = await refused(409, {'error': 'Conflict', 'message': 'Something new.', 'code': 'inbound_brand_new'});
      expect(r.code, InboundErrorCode.unknown);
      expect(inboundRefusalSentence(r), 'Something new.');
    });
  });

  test('an expired sign-in is told to the gate, then comes back as a refusal', () async {
    final a = api((_) async => _json(401, {'error': 'Unauthorized', 'message': 'no'}));
    final r = await a.hangup('c1');
    expect(r, isA<InboundRefused<InboundCall>>());
    expect(unauthorized, hasLength(1));
  });
}
