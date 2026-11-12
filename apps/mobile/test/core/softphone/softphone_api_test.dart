import 'dart:convert';

import 'package:agency_wire/agency_wire.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:magick_agency_agent/app/providers.dart';
import 'package:magick_agency_agent/core/api/api_error.dart';
import 'package:magick_agency_agent/core/auth/fake_auth_service.dart';
import 'package:magick_agency_agent/core/softphone/softphone_api.dart';
import 'package:magick_agency_agent/core/station/station_deps.dart';

import '../auth/support/harness.dart';
import 'manual_calls.dart';

/// Every soft-phone route: its method and path, its body or query, the
/// account it is scoped to, and what its answer decodes into.
void main() {
  late Harness h;
  late ProviderContainer c;
  late SoftphoneApi api;
  late List<Object> unauthorized;

  final sessionResponse = {
    'session_id': 'sess-sp',
    'kind': 'softphone',
    'state': 'break',
    'break_reason': 'soft_phone',
    'station_ws_url': '/proxy/agency/station/sess-sp?token=t',
    'station_token_expires_at': '2026-11-01T08:03:00.000Z',
    'intervals': {
      'heartbeat_ms': 10000,
      'heartbeat_grace_ms': 10000,
      'reservation_lease_ms': 10000,
      'countdown_ms': 3000,
      'deferred_hangup_ms': 8000,
    },
  };
  final stateResponse = {
    'campaign_id': 'camp-1',
    'session_id': 'sess-1',
    'kind': 'campaign',
    'state': 'on_call',
    'since': '2026-11-01T08:30:12.000Z',
    'pending_state': 'break',
    'break_reason': 'soft_phone',
  };

  setUp(() {
    h = Harness(auth: FakeAuthService(signedIn: meera), server: FakeServer());
    unauthorized = [];
    c = h.container(
      extra: [stationUnauthorizedSinkProvider.overrideWithValue(unauthorized.add)],
    );
    c.read(requestScopeProvider)
      ..tenantId = 't1'
      ..accountId = 'a1';
    api = c.read(softphoneApiProvider);
  });

  tearDown(() => c.dispose());

  http.Request only(String method, String path) {
    final calls = h.server.calls(method, path);
    expect(calls, hasLength(1), reason: '$method $path');
    return calls.single;
  }

  Object? bodyOf(http.Request r) => r.body.isEmpty ? null : jsonDecode(r.body);

  group('reads', () {
    test('bootstrap: GET, in the current account by default', () async {
      h.server.json('GET', '/proxy/agency/softphone/bootstrap', bootstrapJson());
      final b = await api.bootstrap();
      expect(b.softphoneEnabled, isTrue);
      final req = only('GET', '/proxy/agency/softphone/bootstrap');
      expect(req.headers['x-tenant-id'], 't1');
      expect(req.headers['x-account-id'], 'a1');
    });

    test('bootstrap in a sibling account goes out scoped to that account', () async {
      h.server.json('GET', '/proxy/agency/softphone/bootstrap', bootstrapJson());
      await api.bootstrap(accountId: 'a2');
      await api.bootstrap(accountId: 'a1');
      final reqs = h.server.calls('GET', '/proxy/agency/softphone/bootstrap');
      expect(reqs.map((r) => r.headers['x-account-id']), ['a2', 'a1']);
      expect(reqs.map((r) => r.headers['x-tenant-id']), ['t1', 't1']);
    });

    test('listCalls sends the query, always naming the agent', () async {
      h.server.json('GET', '/proxy/agency/softphone/calls', {
        'rows': [manualCallJson({'analysis_status': null})],
        'next_cursor': null,
        'limit': 8,
      });
      final page = await api.listCalls(
        const ManualCallsQuery(agentUserId: 'u-1', limit: 8, status: ManualCallListStatus.settled),
      );
      expect(page.rows.single.id, 'mc-1');
      expect(page.hasMore, isFalse);
      expect(only('GET', '/proxy/agency/softphone/calls').url.queryParameters, {
        'agent_user_id': 'u-1',
        'limit': '8',
        'status': 'settled',
      });
    });

    test('callDetail: GET by id, path-encoded', () async {
      h.server.json('GET', '/proxy/agency/softphone/calls/mc%201', {
        'call': manualCallJson(),
        'dispositioned_by_name': null,
        'overrides': {'dnc_note': null, 'dnc_entry_id': null, 'dnc_entry': null, 'hours_note': null},
        'media': null,
        'call_availability': 'never_placed',
      });
      final d = await api.callDetail('mc 1');
      expect(d.callAvailability, CallAvailability.neverPlaced);
      expect(h.server.requests.single.url.toString(), 'https://agency.test/proxy/agency/softphone/calls/mc%201');
    });
  });

  group('the session', () {
    test('openSession: POST with this install\'s device fields (OS3), taking over unless told not to', () async {
      h.server.json('POST', '/proxy/agency/softphone/sessions', sessionResponse, status: 201);
      final s = await api.openSession();
      expect(s.sessionId, 'sess-sp');
      expect(s.kind, SessionKind.softphone);
      final body = bodyOf(only('POST', '/proxy/agency/softphone/sessions'))! as Map<String, Object?>;
      expect(body['take_over'], true);
      expect(StationDevice.pattern.hasMatch(body['device_id']! as String), isTrue);
    });

    test('switchToSoftphone and returnToCampaign: POST on the session, in its account', () async {
      h.server.json('POST', '/proxy/agency/sessions/sess-1/softphone', stateResponse);
      h.server.json('POST', '/proxy/agency/sessions/sess-1/softphone/return', {
        ...stateResponse,
        'state': 'available',
        'pending_state': null,
        'break_reason': null,
      });
      final queued = await api.switchToSoftphone('sess-1', accountId: 'a2');
      expect(queued.pendingState, AgentState.onBreak);
      expect(queued.breakReason, 'soft_phone');
      final back = await api.returnToCampaign('sess-1');
      expect(back.state, AgentState.available);
      expect(only('POST', '/proxy/agency/sessions/sess-1/softphone').headers['x-account-id'], 'a2');
      expect(only('POST', '/proxy/agency/sessions/sess-1/softphone/return').headers['x-account-id'], 'a1');
    });
  });

  group('calls', () {
    test('placeCall: POST the request body and decode the call', () async {
      h.server.json('POST', '/proxy/agency/softphone/calls', manualCallJson(), status: 201);
      final call = await api.placeCall(ManualCallCreateRequest(sessionId: 'sess-sp', to: '98204 61733'));
      expect(call.id, 'mc-1');
      expect(bodyOf(only('POST', '/proxy/agency/softphone/calls')), {
        'session_id': 'sess-sp',
        'to': '98204 61733',
        'campaign_id': null,
      });
      expect(SoftphoneApi.placeCallTimeout, const Duration(seconds: 20));
    });

    test('placeCall is never retried: a dropped connection is one request and an error', () async {
      h.server.offline('POST', '/proxy/agency/softphone/calls');
      await expectLater(
        api.placeCall(ManualCallCreateRequest(sessionId: 'sess-sp', to: '1')),
        throwsA(isA<ApiNetworkError>()),
      );
      expect(h.server.calls('POST', '/proxy/agency/softphone/calls'), hasLength(1));
    });

    test('a refusal is an ApiHttpError whose body reads as the soft-phone refusal', () async {
      h.server.json('POST', '/proxy/agency/softphone/calls', {
        'error': 'Conflict',
        'message': 'This number is on the Do Not Call list.',
        'code': 'dnc_listed',
        'entry': {'id': 'e1', 'scope': 'campaign', 'reason': null, 'created_at': '2026-10-20T11:00:00.000Z'},
      }, status: 409);
      Object? caught;
      try {
        await api.placeCall(ManualCallCreateRequest(sessionId: 'sess-sp', to: '1', campaignId: 'camp-1'));
      } catch (e) {
        caught = e;
      }
      expect(caught, isA<ApiHttpError>());
      final refusal = softphoneRefusalOf(caught!)!;
      expect(refusal.softphoneCode, SoftphoneErrorCode.dncListed);
      expect(refusal.dncListed!.entry.scope, DncEntryScope.campaign);
      expect(softphoneRefusalOf(const ApiNetworkError('x')), isNull);
      expect(
        softphoneRefusalOf(const ApiHttpError(status: 500, code: null, message: '', body: {}, requestId: null)),
        isNull,
      );
    });

    test('updateCall: PATCH the details', () async {
      h.server.json('PATCH', '/proxy/agency/softphone/calls/mc-1', manualCallJson({'notes': 'hi'}));
      final call = await api.updateCall('mc-1', ManualCallUpdateRequest(notes: 'hi'));
      expect(call.notes, 'hi');
      expect(bodyOf(only('PATCH', '/proxy/agency/softphone/calls/mc-1')), {'notes': 'hi'});
    });

    test('hangup: POST with no body; the answer may still be live', () async {
      h.server.json('POST', '/proxy/agency/softphone/calls/mc-1/hangup', manualCallJson({'state': 'ringing'}));
      final call = await api.hangup('mc-1');
      expect(call.state, AttemptState.ringing);
      expect(bodyOf(only('POST', '/proxy/agency/softphone/calls/mc-1/hangup')), isNull);
    });

    test('disposition: POST the outcome', () async {
      h.server.json('POST', '/proxy/agency/softphone/calls/mc-1/disposition', {
        'call': manualCallJson({'state': 'ended', 'disposition_code': 'resolved', 'settled_at': '2026-10-30T10:05:00Z'}),
        'contact_state': null,
        'next_attempt_at': null,
        'callback_requested_at': null,
      });
      final r = await api.disposition('mc-1', ManualCallDispositionRequest(code: 'resolved', notes: ''));
      expect(r.call.isSettled, isTrue);
      expect(bodyOf(only('POST', '/proxy/agency/softphone/calls/mc-1/disposition')), {'code': 'resolved', 'notes': ''});
    });

    test('markDnc: POST the reason, never a scope', () async {
      h.server.json('POST', '/proxy/agency/softphone/calls/mc-1/dnc', {
        'call_id': 'mc-1',
        'phone_e164': '+919820461733',
        'scope': 'account',
        'dnc_recorded': true,
        'contact_state': null,
      });
      final r = await api.markDnc('mc-1', const ManualCallDncRequest(reason: 'Asked'));
      expect(r.scope, DncEntryScope.account);
      expect(bodyOf(only('POST', '/proxy/agency/softphone/calls/mc-1/dnc')), {'reason': 'Asked'});
    });
  });

  test('a body that does not decode is an ApiDecodeError', () async {
    h.server.json('GET', '/proxy/agency/softphone/bootstrap', {'softphone_enabled': 'yes'});
    await expectLater(api.bootstrap(), throwsA(isA<ApiDecodeError>()));
  });

  test('an expired sign-in is reported before it is rethrown', () async {
    h.server.json('GET', '/proxy/agency/softphone/bootstrap', {'error': 'Unauthorized'}, status: 401);
    await expectLater(api.bootstrap(), throwsA(isA<ApiUnauthorized>()));
    expect(unauthorized, [isA<ApiUnauthorized>()]);
  });
}
