import 'package:agency_wire/agency_wire.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/providers.dart';
import '../api/api_client.dart';
import '../api/api_error.dart';
import '../station/station_deps.dart';
import '../station/station_device.dart';

/// The soft phone's routes (`/proxy/agency/softphone/*` and the SP7 switch on
/// `/proxy/agency/sessions/:id/softphone`), over [ApiClient], decoded into
/// `agency_wire` types.
///
/// Errors are the client's [ApiError]s: a refusal is an [ApiHttpError] whose
/// body reads through `ErrorBody.fromJson(error.body)` and its soft-phone
/// accessors (`softphoneCode`, `dncListed`, `callPending`, …). A body that does
/// not decode is an [ApiDecodeError].
///
/// Every method takes an optional `accountId`: the soft phone's session may be
/// in a sibling account of the workspace the app is in (one live session per
/// agent, across tenants since OS1), and every route about it is scoped to its own account,
/// so such a request goes out on a client scoped to that account. Null, or the
/// current account, uses the usual client. `leave` and the station token stay
/// in `StationApi`.
final class SoftphoneApi {
  SoftphoneApi(this._client, {required this._scopedTo, this._onUnauthorized, this._device});

  final ApiClient _client;

  /// This install's device fields (OS3), or null to send none (reads only; tests).
  final StationDeviceFields? _device;

  /// A client scoped to another account of the same tenant.
  final ApiClient Function(String accountId) _scopedTo;

  /// Told about every [ApiUnauthorized] before it is rethrown (the app gate
  /// decides when to sign out).
  final void Function(ApiUnauthorized error)? _onUnauthorized;

  static const _base = '/proxy/agency';

  /// How long a dial may take to answer. The server bridges the agent's leg
  /// before it answers, so this is longer than the default; on a timeout the
  /// call MAY have been placed, and the caller must not retry.
  static const placeCallTimeout = Duration(seconds: 20);

  /// The account the client is scoped to now.
  String? get accountId => _client.scope.accountId;

  ApiClient _via(String? accountId) =>
      accountId == null || accountId.isEmpty || accountId == _client.scope.accountId ? _client : _scopedTo(accountId);

  Future<T> _guard<T>(Future<T> Function() send) async {
    try {
      return await send();
    } on ApiUnauthorized catch (e) {
      _onUnauthorized?.call(e);
      rethrow;
    }
  }

  // ── Reads ──

  /// `GET /softphone/bootstrap`: the flag, the taggable campaigns, the field
  /// set, the agent's live session in the tenant and (in this account) its call.
  Future<SoftphoneBootstrap> bootstrap({String? accountId}) async {
    const path = '$_base/softphone/bootstrap';
    final body = await _guard(() => _via(accountId).get(path));
    return _decode(path, body, SoftphoneBootstrap.fromJson);
  }

  /// `GET /softphone/calls`: the agent's own calls, newest first.
  Future<ManualCallsPage> listCalls(ManualCallsQuery query, {String? accountId}) async {
    const path = '$_base/softphone/calls';
    final body = await _guard(() => _via(accountId).get(path, query: query.toQuery()));
    return _decode(path, body, decodeManualCallsPage);
  }

  /// `GET /softphone/calls/:id`.
  Future<ManualCallDetail> callDetail(String callId, {String? accountId}) async {
    final path = '$_base/softphone/calls/${Uri.encodeComponent(callId)}';
    final body = await _guard(() => _via(accountId).get(path));
    return _decode(path, body, ManualCallDetail.fromJson);
  }

  // ── The session ──

  /// `POST /softphone/sessions`: 201 opened, 200 rehydrated. The client kind
  /// (which picks the intervals served) travels in `X-Client`; the body is the
  /// device fields (OS3): [takeOver] on the agent's own open, never on an
  /// automatic resume.
  Future<SoftphoneSessionResponse> openSession({String? accountId, bool takeOver = true}) async {
    const path = '$_base/softphone/sessions';
    final device = await _device?.call(takeOver: takeOver);
    final body = await _guard(() => _via(accountId).post(path, body: device?.toJson()));
    return _decode(path, body, SoftphoneSessionResponse.fromJson);
  }

  /// `POST /sessions/:id/softphone` (SP7): applied, or queued behind a call
  /// (`pending_state: break`, `break_reason: soft_phone`).
  Future<SessionStateResponse> switchToSoftphone(String sessionId, {String? accountId}) async {
    final path = '$_base/sessions/${Uri.encodeComponent(sessionId)}/softphone';
    final body = await _guard(() => _via(accountId).post(path));
    return _decode(path, body, SessionStateResponse.fromJson);
  }

  /// `POST /sessions/:id/softphone/return`: back to `available`, or a queued
  /// switch withdrawn. 409 `manual_call_live` (with the call) while one is
  /// live or owed.
  Future<SessionStateResponse> returnToCampaign(String sessionId, {String? accountId}) async {
    final path = '$_base/sessions/${Uri.encodeComponent(sessionId)}/softphone/return';
    final body = await _guard(() => _via(accountId).post(path));
    return _decode(path, body, SessionStateResponse.fromJson);
  }

  // ── Calls ──

  /// `POST /softphone/calls` → 201 the call. **Never retried**, here or by the
  /// caller: on a timeout the call may have been placed, and the `manual_call`
  /// frame (or the bootstrap) is the authority.
  Future<ManualCall> placeCall(ManualCallCreateRequest request, {String? accountId}) async {
    const path = '$_base/softphone/calls';
    final body = await _guard(
      () => _via(accountId).post(path, body: request.toJson(), timeout: placeCallTimeout),
    );
    return _decode(path, body, ManualCall.fromJson);
  }

  /// `PATCH /softphone/calls/:id`: fields and notes while live or owed.
  Future<ManualCall> updateCall(String callId, ManualCallUpdateRequest request, {String? accountId}) async {
    final path = '$_base/softphone/calls/${Uri.encodeComponent(callId)}';
    final body = await _guard(() => _via(accountId).patch(path, body: request.toJson()));
    return _decode(path, body, ManualCall.fromJson);
  }

  /// `POST /softphone/calls/:id/hangup`: the row as read right after the
  /// hang-up was issued, which may still be live (the frame says when it ends).
  Future<ManualCall> hangup(String callId, {String? accountId}) async {
    final path = '$_base/softphone/calls/${Uri.encodeComponent(callId)}/hangup';
    final body = await _guard(() => _via(accountId).post(path));
    return _decode(path, body, ManualCall.fromJson);
  }

  /// `POST /softphone/calls/:id/disposition`: save the outcome.
  Future<ManualCallDispositionResponse> disposition(
    String callId,
    ManualCallDispositionRequest request, {
    String? accountId,
  }) async {
    final path = '$_base/softphone/calls/${Uri.encodeComponent(callId)}/disposition';
    final body = await _guard(() => _via(accountId).post(path, body: request.toJson()));
    return _decode(path, body, ManualCallDispositionResponse.fromJson);
  }

  /// `POST /softphone/calls/:id/dnc`: campaign scope when tagged, else the account.
  Future<ManualCallDncResponse> markDnc(String callId, ManualCallDncRequest request, {String? accountId}) async {
    final path = '$_base/softphone/calls/${Uri.encodeComponent(callId)}/dnc';
    final body = await _guard(() => _via(accountId).post(path, body: request.toJson()));
    return _decode(path, body, ManualCallDncResponse.fromJson);
  }

  static T _decode<T>(String path, Object? body, T Function(Map<String, Object?>) fromJson) {
    if (body is! Map<String, Object?>) throw ApiDecodeError(path, 'expected an object');
    try {
      return fromJson(body);
    } on FormatException catch (e) {
      throw ApiDecodeError(path, e);
    }
  }
}

/// The structured soft-phone refusal of [error], or null for anything that is
/// not an HTTP answer with a soft-phone code.
ErrorBody? softphoneRefusalOf(Object error) {
  if (error is! ApiHttpError) return null;
  final body = ErrorBody.fromJson(error.body);
  return body.softphoneCode == SoftphoneErrorCode.unknown ? null : body;
}

/// The one [SoftphoneApi] for the app, on the app's client, reporting an
/// expired sign-in to the app gate as the station does.
final softphoneApiProvider = Provider<SoftphoneApi>((ref) {
  final client = ref.watch(apiClientProvider);
  return SoftphoneApi(
    client,
    scopedTo: (accountId) => ApiClient(
      http: ref.read(httpClientProvider),
      env: ref.read(envProvider),
      tokens: ref.read(idTokenSourceProvider),
      identity: ref.read(clientIdentityProvider),
      scope: RequestScope()
        ..tenantId = client.scope.tenantId
        ..accountId = accountId,
    ),
    onUnauthorized: (error) => ref.read(stationUnauthorizedSinkProvider)(error),
    // OS3: an open through this instance names this install too (it never sends a body without it).
    device: ref.read(stationDeviceIdsProvider).fields,
  );
});
