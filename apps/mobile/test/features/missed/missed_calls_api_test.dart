import 'package:agency_wire/agency_wire.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:magick_agency_agent/app/providers.dart';
import 'package:magick_agency_agent/core/api/api_error.dart';
import 'package:magick_agency_agent/core/auth/fake_auth_service.dart';
import 'package:magick_agency_agent/features/missed/missed_calls_api.dart';
import 'package:magick_agency_agent/features/missed/missed_calls_controller.dart' show MissedFilters;
import 'package:magick_agency_agent/features/missed/missed_calls_copy.dart';

import '../../core/auth/support/harness.dart';
import 'support.dart' show missedJson;

/// The Missed routes over the real `ApiClient` and a scripted server: each
/// one's method, path, query and scope, what its answer decodes into (the
/// shapes of `packages/contracts/fixtures/agent/inbound.json`, which
/// `agency_wire` decodes itself), and the refusals the screens put in words.
void main() {
  late Harness h;
  late ProviderContainer c;
  late MissedCallsApi api;

  setUp(() {
    h = Harness(auth: FakeAuthService(signedIn: meera), server: FakeServer());
    c = h.container();
    c.read(requestScopeProvider)
      ..tenantId = 't1'
      ..accountId = 'a1';
    api = c.read(missedCallsApiProvider);
  });

  tearDown(() => c.dispose());

  http.Request only(String method, String path) {
    final calls = h.server.calls(method, path);
    expect(calls, hasLength(1), reason: '$method $path');
    return calls.single;
  }

  test('list: GET /proxy/agency/inbound/missed with the status, the agent’s own rows, the reason, cursor and limit',
      () async {
    h.server.json('GET', '/proxy/agency/inbound/missed', {
      'rows': [missedJson('m1'), missedJson('m2', {'from_e164': null, 'reason': 'overflow', 'closed_cause': null})],
      'next_cursor': 'cur-3',
      'limit': 50,
    });
    // The list's own query: `assignee=me`, or the server widens a supervisor's to the account.
    final page = await api.list(
      const MissedFilters(status: InboundFollowUpStatus.handled, reason: InboundMissedReason.overflow)
          .toQuery(cursor: 'cur-2'),
    );
    expect(page.rows.map((r) => r.id), ['m1', 'm2']);
    expect(page.rows.last.isWithheld, isTrue);
    expect(page.nextCursor, 'cur-3');
    final req = only('GET', '/proxy/agency/inbound/missed');
    expect(req.url.queryParameters,
        {'status': 'handled', 'assignee': 'me', 'reason': 'overflow', 'cursor': 'cur-2', 'limit': '50'});
    expect(req.headers['x-tenant-id'], 't1');
    expect(req.headers['x-account-id'], 'a1');
  });

  test('count: GET /proxy/agency/inbound/missed/count, and the badge caps at 100+', () async {
    h.server.json('GET', '/proxy/agency/inbound/missed/count', {'open': 100, 'open_capped': true, 'has_rows': true});
    final count = await api.count();
    expect(count.badge, '100+');
    expect(count.hasRows, isTrue);
    only('GET', '/proxy/agency/inbound/missed/count');
  });

  test('Mark handled and Reopen: POST to the row’s own path, the answer is the row', () async {
    h.server.json('POST', '/proxy/agency/inbound/missed/m%201/handled', {'call': missedJson('m 1', {'status': 'handled'})});
    h.server.json('POST', '/proxy/agency/inbound/missed/5b6c/reopen', {'call': missedJson('5b6c')});
    final handled = await api.markHandled('m 1');
    expect(handled.isOpen, isFalse);
    final reopened = await api.reopen('5b6c');
    expect(reopened.isOpen, isTrue);
    expect(h.server.requests.map((r) => '${r.method} ${r.url.path}'), [
      'POST /proxy/agency/inbound/missed/m%201/handled',
      'POST /proxy/agency/inbound/missed/5b6c/reopen',
    ]);
  });

  test('a refusal arrives as an ApiHttpError carrying the inbound code', () async {
    h.server.json(
      'POST',
      '/proxy/agency/inbound/missed/x/handled',
      {'error': 'Not Found', 'code': 'inbound_missed_call_not_found', 'message': 'Not found'},
      status: 404,
    );
    await expectLater(
      api.markHandled('x'),
      throwsA(isA<ApiHttpError>().having((e) => ErrorBody.fromJson(e.body).inboundCode, 'inboundCode',
          InboundErrorCode.inboundMissedCallNotFound)),
    );
  });

  test('a 403 on the count is an ApiHttpError the controller hides the list for', () async {
    h.server.json('GET', '/proxy/agency/inbound/missed/count', {'error': 'Forbidden', 'message': 'No'}, status: 403);
    await expectLater(api.count(), throwsA(isA<ApiHttpError>().having((e) => e.status, 'status', 403)));
  });

  test('an answer that does not read is a decode error, not a crash', () async {
    h.server.json('GET', '/proxy/agency/inbound/missed/count', {'open': 'three'});
    await expectLater(api.count(), throwsA(isA<ApiDecodeError>()));
  });

  group('refusals in words', () {
    ApiHttpError refusal(String code, {int status = 404, String message = 'Server words'}) => ApiHttpError(
          status: status,
          code: code,
          message: message,
          body: {'error': 'x', 'code': code, 'message': message},
          requestId: null,
        );

    test('Mark handled', () {
      expect(MissedCopy.handledRefusal(refusal('inbound_missed_call_not_found')),
          'This missed call isn’t yours to handle, or it no longer exists.');
      expect(MissedCopy.handledRefusal(refusal('inbound_disabled', status: 403)),
          'Inbound calls aren’t turned on for this account.');
      // A code the console has no words for: the server's sentence.
      expect(MissedCopy.handledRefusal(refusal('something_new', status: 409)), 'Server words');
      // A masked 5xx, and no answer at all.
      expect(MissedCopy.handledRefusal(refusal('internal', status: 500)),
          'We couldn’t mark this call handled. Try again in a moment.');
      expect(MissedCopy.handledRefusal(const ApiNetworkError('offline')), const ApiNetworkError('offline').userMessage);
    });

    test('Reopen', () {
      expect(MissedCopy.reopenRefusal(refusal('inbound_missed_call_not_found')),
          'This missed call isn’t yours to reopen, or it no longer exists. Refresh the list.');
      expect(MissedCopy.reopenRefusal(refusal('something_new', status: 409)),
          'We couldn’t reopen this call. Try again in a moment.');
      expect(MissedCopy.reopenRefusal(const ApiNetworkError('offline')), const ApiNetworkError('offline').userMessage);
    });
  });
}
