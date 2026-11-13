import 'package:agency_wire/agency_wire.dart';

import '../api/api_client.dart';
import '../api/api_error.dart';
import '../api/decode_body.dart';

/// This install's push device (Mode B, `packages/contracts/src/agency/push-devices.ts`), over
/// [ApiClient]. The `:deviceId` is the station device id (OS3), so the device the server may ring
/// for a session is the one holding its station (IQ60). Firebase Bearer; the agent's own devices
/// only.
///
/// ```text
/// GET    /proxy/agency/push-devices/:deviceId            → PushDeviceStatus
/// PUT    /proxy/agency/push-devices/:deviceId            → PushDeviceStatus  (register or refresh)
/// PATCH  /proxy/agency/push-devices/:deviceId            → PushDeviceStatus  (opt in or out)
/// DELETE /proxy/agency/push-devices/:deviceId            → 204               (sign-out)
/// POST   /proxy/agency/push-devices/:deviceId/test-ring  → 202               (one per 10 s)
/// ```
///
/// Errors are the client's [ApiError]s; an answer that does not decode is an [ApiDecodeError].
/// The push token goes in the PUT body only, and is never logged (the client logs paths, never
/// bodies).
final class PushDeviceApi {
  PushDeviceApi(this._client, {this._onUnauthorized});

  final ApiClient _client;

  /// Told about every [ApiUnauthorized] before it is rethrown (the app gate decides).
  final void Function(ApiUnauthorized error)? _onUnauthorized;

  static const base = '/proxy/agency/push-devices';
  static String path(String deviceId) => '$base/${Uri.encodeComponent(deviceId)}';
  static String testRingPath(String deviceId) => '${path(deviceId)}/test-ring';

  Future<PushDeviceStatus> status(String deviceId) async =>
      _decode(path(deviceId), await _guard(() => _client.get(path(deviceId))));

  Future<PushDeviceStatus> register(String deviceId, PushDevicePutRequest request) async =>
      _decode(path(deviceId), await _guard(() => _client.put(path(deviceId), body: request.toJson())));

  Future<PushDeviceStatus> setRingEnabled(String deviceId, bool enabled) async => _decode(
        path(deviceId),
        await _guard(() => _client.patch(path(deviceId), body: PushDevicePatchRequest(ringEnabled: enabled).toJson())),
      );

  /// Bounded: it runs on the way to signing out.
  Future<void> remove(String deviceId, {Duration timeout = const Duration(seconds: 3)}) async {
    await _guard(() => _client.delete(path(deviceId), timeout: timeout));
  }

  Future<void> testRing(String deviceId) async {
    await _guard(() => _client.post(testRingPath(deviceId), body: const <String, Object?>{}));
  }

  Future<Object?> _guard(Future<Object?> Function() send) async {
    try {
      return await send();
    } on ApiUnauthorized catch (e) {
      _onUnauthorized?.call(e);
      rethrow;
    }
  }

  static PushDeviceStatus _decode(String path, Object? body) => decodeBody(path, body, PushDeviceStatus.fromJson);
}
