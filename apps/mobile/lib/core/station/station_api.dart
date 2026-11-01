import 'package:agency_wire/agency_wire.dart';

import '../api/api_client.dart';
import '../api/api_error.dart';

/// The agency routes the station uses, over [ApiClient], decoded into
/// `agency_wire` types. Errors are the client's [ApiError]s; a body that does
/// not decode is an [ApiDecodeError].
final class StationApi {
  StationApi(this._client, {required this._scopedTo, this._onUnauthorized});

  final ApiClient _client;

  /// A client scoped to another account of the same tenant.
  final ApiClient Function(String accountId) _scopedTo;

  /// Told about every [ApiUnauthorized] before it is rethrown (the app gate
  /// decides when to sign out; the station carries on with the refusal).
  final void Function(ApiUnauthorized error)? _onUnauthorized;

  Future<Object?> _post(ApiClient client, String path, {Object? body, Duration? timeout}) async {
    try {
      return await client.post(path, body: body, timeout: timeout);
    } on ApiUnauthorized catch (e) {
      _onUnauthorized?.call(e);
      rethrow;
    }
  }

  static const _base = '/proxy/agency';

  /// The account the client is scoped to now.
  String? get accountId => _client.scope.accountId;

  /// A client for [accountId] when it differs from the current scope (a session
  /// in a sibling account is left in that account), else the usual one.
  ApiClient _via(String? accountId) =>
      accountId == null || accountId.isEmpty || accountId == _client.scope.accountId ? _client : _scopedTo(accountId);

  Future<SessionBootstrap> join(String campaignId, {String? accountId}) async {
    const path = '$_base/sessions';
    final body = await _post(
      _via(accountId),
      path,
      body: CreateSessionRequest(campaignId: campaignId, clientKind: ClientKind.mobile).toJson(),
    );
    return _decode(path, body, SessionBootstrap.fromJson);
  }

  Future<StationTokenResponse> mintStationToken(String sessionId) async {
    final path = '$_base/sessions/$sessionId/station-token';
    final body = await _post(_client, path, timeout: const Duration(seconds: 8));
    return _decode(path, body, StationTokenResponse.fromJson);
  }

  /// The body is advisory (the station's frames are the authority), so one that
  /// does not decode is not a failure of the action.
  Future<SessionStateResponse?> available(String sessionId) async {
    final body = await _post(_client, '$_base/sessions/$sessionId/available');
    return _tryDecode(body, SessionStateResponse.fromJson);
  }

  Future<SessionStateResponse?> takeBreak(String sessionId, String reason, {Duration? timeout}) async {
    final body = await _post(
      _client,
      '$_base/sessions/$sessionId/break',
      body: SessionBreakRequest(reason).toJson(),
      timeout: timeout,
    );
    return _tryDecode(body, SessionStateResponse.fromJson);
  }

  Future<SessionStateResponse?> cancelBreak(String sessionId) async {
    final body = await _post(_client, '$_base/sessions/$sessionId/break/cancel');
    return _tryDecode(body, SessionStateResponse.fromJson);
  }

  Future<void> leave(String sessionId, {String? accountId}) async {
    await _post(_via(accountId), '$_base/sessions/$sessionId/leave');
  }

  Future<HangupResponse?> hangup(String attemptId) async {
    final body = await _post(_client, '$_base/attempts/$attemptId/hangup');
    return _tryDecode(body, HangupResponse.fromJson);
  }

  Future<DispositionResponse> disposition(String attemptId, DispositionRequest request) async {
    final path = '$_base/attempts/$attemptId/disposition';
    final body = await _post(_client, path, body: request.toJson());
    return _decode(path, body, DispositionResponse.fromJson);
  }

  Future<NotesResponse> saveNotes(String attemptId, String notes) async {
    final path = '$_base/attempts/$attemptId/notes';
    final body = await _post(_client, path, body: NotesRequest(notes).toJson());
    return _decode(path, body, NotesResponse.fromJson);
  }

  Future<DncResponse> markDnc(String attemptId, DncRequest request) async {
    final path = '$_base/attempts/$attemptId/dnc';
    final body = await _post(_client, path, body: request.toJson());
    return _decode(path, body, DncResponse.fromJson);
  }

  static T _decode<T>(String path, Object? body, T Function(Map<String, Object?>) fromJson) {
    if (body is! Map<String, Object?>) throw ApiDecodeError(path, 'expected an object');
    try {
      return fromJson(body);
    } on FormatException catch (e) {
      throw ApiDecodeError(path, e);
    }
  }

  static T? _tryDecode<T>(Object? body, T Function(Map<String, Object?>) fromJson) {
    if (body is! Map<String, Object?>) return null;
    try {
      return fromJson(body);
    } on FormatException {
      return null;
    }
  }
}

/// The structured body of a refusal, or null for anything that is not an HTTP answer.
ErrorBody? errorBodyOf(Object error) => error is ApiHttpError ? ErrorBody.fromJson(error.body) : null;

/// The agency error code of a refusal, or null.
AgencyErrorCode? errorCodeOf(Object error) {
  final body = errorBodyOf(error);
  if (body == null) return null;
  return body.codeRaw == null ? null : body.code;
}
