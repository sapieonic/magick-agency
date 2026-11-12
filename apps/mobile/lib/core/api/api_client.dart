import 'dart:async';
import 'dart:convert';
import 'dart:io' show SocketException, HandshakeException;
import 'dart:math';
import 'dart:typed_data';

import 'package:http/http.dart' as http;

import '../env.dart';
import '../telemetry/log.dart';
import 'api_error.dart';
import 'client_identity.dart';

/// Supplies Firebase ID tokens. `forceRefresh` asks Firebase for a new one
/// (used once after a 401, and ahead of a station reconnect).
abstract interface class IdTokenSource {
  Future<String?> idToken({bool forceRefresh = false});
}

/// The tenant and account every agency request is scoped to. The server
/// requires `X-Tenant-Id`; an agent always sends `X-Account-Id` too, so the
/// server never has to guess which membership row applies.
class RequestScope {
  String? tenantId;
  String? accountId;

  bool get isSet => tenantId != null && accountId != null;

  void clear() {
    tenantId = null;
    accountId = null;
  }
}

/// The one HTTP client for the agency API.
///
/// Every request carries a fresh Firebase bearer, the tenant/account scope,
/// `X-Client` and an `X-Request-Id` (so a masked 5xx can be traced). A 401 is
/// retried once with a forced token refresh before it becomes
/// [ApiUnauthorized]. Responses are decoded to `Object?` JSON here; callers
/// map them to `agency_wire` types.
class ApiClient {
  ApiClient({
    required this._http,
    required this._env,
    required this._tokens,
    required this._identity,
    required this._scope,
    this.defaultTimeout = const Duration(seconds: 15),
    Random? random,
  }) : _random = random ?? Random.secure();

  final http.Client _http;
  final Env _env;
  final IdTokenSource _tokens;
  final ClientIdentity _identity;
  final RequestScope _scope;
  final Random _random;
  final Duration defaultTimeout;

  static final _log = Log('api');

  RequestScope get scope => _scope;

  Future<Object?> get(String path, {Map<String, String>? query, Duration? timeout, bool scoped = true}) =>
      _send('GET', path, query: query, timeout: timeout, scoped: scoped);

  Future<Object?> post(String path, {Object? body, Duration? timeout, bool scoped = true, bool authenticated = true}) =>
      _send('POST', path, body: body, timeout: timeout, scoped: scoped, authenticated: authenticated);

  Future<Object?> put(String path, {Object? body, Duration? timeout}) => _send('PUT', path, body: body, timeout: timeout);

  Future<Object?> patch(String path, {Object? body, Duration? timeout}) => _send('PATCH', path, body: body, timeout: timeout);

  Future<Object?> delete(String path, {Duration? timeout}) => _send('DELETE', path, timeout: timeout);

  /// A public route: no bearer, no tenant scope (`/client-config`, invite lookup).
  Future<Object?> getPublic(String path, {Duration? timeout}) =>
      _send('GET', path, timeout: timeout, scoped: false, authenticated: false);

  Future<Object?> _send(
    String method,
    String path, {
    Map<String, String>? query,
    Object? body,
    Duration? timeout,
    bool scoped = true,
    bool authenticated = true,
  }) async {
    final uri = _env.apiBase.replace(path: path, queryParameters: (query == null || query.isEmpty) ? null : query);
    final requestId = _newRequestId();
    final logged = loggableApiPath(path);
    // A Uint8List goes as raw octets (the pre-flight upload probe); anything else as JSON.
    final bytesBody = body is Uint8List ? body : null;
    final encodedBody = body == null || bytesBody != null ? null : jsonEncode(body);

    Future<http.Response> attempt({required bool forceRefresh}) async {
      final headers = <String, String>{
        'accept': 'application/json',
        'x-client': _identity.header,
        'x-request-id': requestId,
        if (encodedBody != null) 'content-type': 'application/json',
        if (bytesBody != null) 'content-type': 'application/octet-stream',
      };
      if (authenticated) {
        final String? token;
        try {
          token = await _tokens.idToken(forceRefresh: forceRefresh);
        } on ApiError {
          rethrow;
        } catch (e) {
          // Firebase failing to mint (`network-request-failed`, a stalled
          // refresh) is a request that never left: every caller handles an
          // ApiNetworkError, none handles a FirebaseAuthException.
          _log.warn('$method $logged: no ID token', {'error': e.runtimeType.toString(), 'request_id': requestId});
          throw ApiNetworkError(e);
        }
        if (token == null) throw const ApiUnauthorized();
        headers['authorization'] = 'Bearer $token';
      }
      if (scoped) {
        final tenant = _scope.tenantId;
        if (tenant != null) headers['x-tenant-id'] = tenant;
        final account = _scope.accountId;
        if (account != null) headers['x-account-id'] = account;
      }
      final request = http.Request(method, uri)..headers.addAll(headers);
      if (encodedBody != null) request.body = encodedBody;
      if (bytesBody != null) request.bodyBytes = bytesBody;
      final streamed = await _http.send(request).timeout(timeout ?? defaultTimeout);
      return http.Response.fromStream(streamed).timeout(timeout ?? defaultTimeout);
    }

    final started = DateTime.now();
    http.Response response;
    try {
      response = await attempt(forceRefresh: false);
      if (response.statusCode == 401 && authenticated) {
        response = await attempt(forceRefresh: true);
      }
    } on ApiError {
      rethrow;
    } on TimeoutException catch (e) {
      _log.warn('$method $logged timed out', {'request_id': requestId});
      throw ApiNetworkError(e, timedOut: true);
    } on SocketException catch (e) {
      throw ApiNetworkError(e);
    } on HandshakeException catch (e) {
      throw ApiNetworkError(e);
    } on http.ClientException catch (e) {
      throw ApiNetworkError(e);
    }

    final ms = DateTime.now().difference(started).inMilliseconds;
    final status = response.statusCode;
    _log.debug('$method $logged → $status in ${ms}ms', {'request_id': requestId});

    final decoded = _decode(response, path);
    if (status >= 200 && status < 300) return decoded;
    if (status == 401) throw const ApiUnauthorized();

    final map = decoded is Map<String, Object?> ? decoded : const <String, Object?>{};
    final code = map['code'];
    final message = map['message'];
    final error = ApiHttpError(
      status: status,
      code: code is String ? code : null,
      message: message is String ? message : '',
      body: map,
      requestId: response.headers['x-request-id'] ?? requestId,
    );
    if (error.isServerError) {
      _log.error('$method $logged failed', {'status': status, 'request_id': error.requestId});
    }
    throw error;
  }

  Object? _decode(http.Response response, String path) {
    if (response.statusCode == 204 || response.bodyBytes.isEmpty) return null;
    final type = response.headers['content-type'] ?? '';
    if (!type.contains('json')) return null;
    try {
      return jsonDecode(utf8.decode(response.bodyBytes));
    } on FormatException catch (e) {
      throw ApiDecodeError(path, e);
    }
  }

  /// 128-bit random hex: unique enough to find one request in the logs.
  String _newRequestId() {
    final b = StringBuffer();
    for (var i = 0; i < 16; i++) {
      b.write(_random.nextInt(256).toRadixString(16).padLeft(2, '0'));
    }
    return b.toString();
  }
}
