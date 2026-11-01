import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:magick_agency_agent/core/api/api_client.dart';
import 'package:magick_agency_agent/core/api/api_error.dart';
import 'package:magick_agency_agent/core/api/client_identity.dart';
import 'package:magick_agency_agent/core/env.dart';

class _Tokens implements IdTokenSource {
  int calls = 0;
  int forced = 0;
  String? token = 't1';

  @override
  Future<String?> idToken({bool forceRefresh = false}) async {
    calls++;
    if (forceRefresh) {
      forced++;
      token = 't2';
    }
    return token;
  }
}

const _env = Env(
  flavor: 'test',
  apiOrigin: 'https://api.test',
  firebaseApiKey: '',
  firebaseProjectId: '',
  firebaseAppIdAndroid: '',
  firebaseAppIdIos: '',
  firebaseMessagingSenderId: '',
  googleIosClientId: '',
  googleServerClientId: '',
  posthogKey: '',
  posthogHost: '',
);

http.Response _json(int status, Object body, {Map<String, String> headers = const {}}) =>
    http.Response(jsonEncode(body), status, headers: {'content-type': 'application/json', ...headers});

void main() {
  late _Tokens tokens;
  late RequestScope scope;

  setUp(() {
    tokens = _Tokens();
    scope = RequestScope()
      ..tenantId = 'ten-1'
      ..accountId = 'acc-1';
  });

  ApiClient client(MockClientHandler handler) => ApiClient(
        http: MockClient(handler),
        env: _env,
        tokens: tokens,
        identity: ClientIdentity.test,
        scope: scope,
      );

  test('sends bearer, tenant scope, X-Client and a request id', () async {
    late http.Request seen;
    final api = client((req) async {
      seen = req;
      return _json(200, {'ok': true});
    });
    final body = await api.get('/proxy/agency/my-assignments', query: {'a': 'b'});

    expect(body, {'ok': true});
    expect(seen.url.toString(), 'https://api.test/proxy/agency/my-assignments?a=b');
    expect(seen.headers['authorization'], 'Bearer t1');
    expect(seen.headers['x-tenant-id'], 'ten-1');
    expect(seen.headers['x-account-id'], 'acc-1');
    expect(seen.headers['x-client'], startsWith('magick-agency-mobile/0.1.0+1 '));
    expect(seen.headers['x-request-id'], matches(RegExp(r'^[0-9a-f]{32}$')));
  });

  test('POST encodes JSON and sets content-type', () async {
    late http.Request seen;
    final api = client((req) async {
      seen = req;
      return http.Response('', 204);
    });
    final body = await api.post('/proxy/agency/sessions', body: {'campaign_id': 'c'});
    expect(body, isNull);
    expect(seen.headers['content-type'], startsWith('application/json'));
    expect(jsonDecode(seen.body), {'campaign_id': 'c'});
  });

  test('a 401 is retried once with a forced token refresh', () async {
    var n = 0;
    final api = client((req) async {
      n++;
      return req.headers['authorization'] == 'Bearer t2' ? _json(200, {'n': n}) : _json(401, {'error': 'Unauthorized'});
    });
    expect(await api.get('/auth/me'), {'n': 2});
    expect(tokens.forced, 1);
  });

  test('a second 401 becomes ApiUnauthorized', () async {
    final api = client((req) async => _json(401, {'error': 'Unauthorized'}));
    await expectLater(api.get('/auth/me'), throwsA(isA<ApiUnauthorized>()));
  });

  test('no signed-in user means ApiUnauthorized without a request', () async {
    tokens.token = null;
    var requests = 0;
    final api = client((req) async {
      requests++;
      return _json(200, {});
    });
    await expectLater(api.get('/auth/me'), throwsA(isA<ApiUnauthorized>()));
    expect(requests, 0);
  });

  test('a refusal keeps its code, message and body fields', () async {
    final api = client(
      (req) async => _json(
        409,
        {'error': 'Conflict', 'code': 'session_on_other_campaign', 'message': 'You are at another station.', 'campaign_id': 'c9'},
        headers: {'x-request-id': 'rid-1'},
      ),
    );
    try {
      await api.post('/proxy/agency/sessions', body: {});
      fail('expected a refusal');
    } on ApiHttpError catch (e) {
      expect(e.status, 409);
      expect(e.code, 'session_on_other_campaign');
      expect(e.userMessage, 'You are at another station.');
      expect(e.body['campaign_id'], 'c9');
      expect(e.requestId, 'rid-1');
    }
  });

  test('a masked 5xx without a message quotes the request id', () async {
    final api = client((req) async => _json(500, {'error': 'Internal Server Error'}, headers: {'x-request-id': 'abcdef1234'}));
    await expectLater(
      api.get('/x'),
      throwsA(isA<ApiHttpError>().having((e) => e.userMessage, 'userMessage', contains('ref abcdef12'))),
    );
  });

  test('public calls send neither bearer nor scope', () async {
    late http.Request seen;
    final api = client((req) async {
      seen = req;
      return _json(200, {});
    });
    await api.getPublic('/client-config');
    expect(seen.headers.containsKey('authorization'), isFalse);
    expect(seen.headers.containsKey('x-tenant-id'), isFalse);
    expect(tokens.calls, 0);
  });

  test('transport failures become ApiNetworkError', () async {
    final api = client((req) async => throw http.ClientException('reset'));
    await expectLater(api.get('/x'), throwsA(isA<ApiNetworkError>()));
  });

  test('a timeout becomes a timed-out ApiNetworkError', () async {
    final api = ApiClient(
      http: MockClient((req) => Future<http.Response>.delayed(const Duration(seconds: 1), () => _json(200, {}))),
      env: _env,
      tokens: tokens,
      identity: ClientIdentity.test,
      scope: scope,
      defaultTimeout: const Duration(milliseconds: 20),
    );
    await expectLater(api.get('/x'), throwsA(isA<ApiNetworkError>().having((e) => e.timedOut, 'timedOut', true)));
  });

  test('malformed JSON is a decode error, not a crash', () async {
    final api = client((req) async => http.Response('{nope', 200, headers: {'content-type': 'application/json'}));
    await expectLater(api.get('/x'), throwsA(isA<ApiDecodeError>()));
  });
}
