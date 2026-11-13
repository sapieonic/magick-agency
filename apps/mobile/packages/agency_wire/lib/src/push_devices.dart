/// Mode B (IQ58–IQ74): ringing an away agent's phone for inbound calls. The
/// app's push devices, the data pushes the server sends them, the ring routes
/// and the away-ring refusals.
///
/// Contract: `packages/contracts/src/agency/push-devices.ts` and the ring
/// routes in `agency/inbound.ts`. Routes:
///
/// | Route | Body | Answer |
/// |---|---|---|
/// | `GET /proxy/agency/push-devices/:deviceId` | | [PushDeviceStatus] |
/// | `PUT /proxy/agency/push-devices/:deviceId` | [PushDevicePutRequest] | [PushDeviceStatus] |
/// | `PATCH /proxy/agency/push-devices/:deviceId` | [PushDevicePatchRequest] | [PushDeviceStatus] |
/// | `DELETE /proxy/agency/push-devices/:deviceId` | | 204 |
/// | `POST /proxy/agency/push-devices/:deviceId/test-ring` | | 202 |
/// | `POST /proxy/agency/inbound/calls/:id/ring/answering` | [InboundRingAnsweringRequest] | [InboundRingAnsweringResponse] |
/// | `POST /proxy/agency/inbound/calls/:id/ring/decline` | [InboundRingDeclineRequest] | [InboundRingDeclineResponse] |
/// | `POST /proxy/agency/inbound/calls/:id/ring/accept` | [InboundRingAcceptRequest] | [InboundRingAcceptResponse] |
///
/// `answering` and `decline` carry only the offer token (native code posts
/// them at the tap); `accept` needs the Firebase Bearer and the station device
/// id too. Their refusals are `InboundErrorCode`s (`ring_not_offered`,
/// `ring_expired`, `already_accepted`). `POST /sessions/:id/break
/// {reason:'away_ring'}` is refused 409 with an [AwayRingRefusalCode]
/// (`ErrorBody.awayRingCode`); the app then falls back to `device_away`.
library;

import 'package:meta/meta.dart';

import 'enums.dart';
import 'inbound.dart';
import 'json.dart';

// ─── Vocabularies ───────────────────────────────────────────────────────────

/// The platform a push device runs. The app SENDS it on register.
///
/// Contract: `AgencyPushPlatform` / `AGENCY_PUSH_PLATFORMS`.
enum PushPlatform implements WireEnum {
  android('android'),

  /// Contract only for now (IQ64): iOS does not ring yet.
  ios('ios'),
  unknown('');

  const PushPlatform(this.wire);
  @override
  final String wire;

  static final _byWire = wireIndex(values);
  static PushPlatform fromWire(String? raw) => _byWire[raw] ?? unknown;
}

/// Why the server's last push to a device failed (`last_failure_reason`).
///
/// Contract: `AgencyPushFailureReason` / `AGENCY_PUSH_FAILURE_REASONS`.
enum PushFailureReason implements WireEnum {
  /// The token is gone: the device was revoked; register again.
  unregistered('unregistered'),

  /// The carrier refused this token for good: the device was revoked;
  /// register again.
  invalid('invalid'),
  rateLimited('rate_limited'),
  unavailable('unavailable'),

  /// The deployment cannot send to the platform.
  unconfigured('unconfigured'),
  unknown('');

  const PushFailureReason(this.wire);
  @override
  final String wire;

  static final _byWire = wireIndex(values);
  static PushFailureReason fromWire(String? raw) => _byWire[raw] ?? unknown;
}

/// A ring push's `type`.
///
/// Contract: `AgencyRingPushType` / `AGENCY_RING_PUSH_TYPES`.
enum RingPushType implements WireEnum {
  /// Ring this phone for `call_id` until `ring_expires_at`.
  ring('ring'),

  /// Stop ringing `call_id` (Android only).
  ringCancel('ring_cancel'),

  /// The server ended this device's `away_ring`; say why on the next open.
  ringOff('ring_off'),

  /// The settings card's test: ring locally, no call behind it.
  testRing('test_ring'),
  unknown('');

  const RingPushType(this.wire);
  @override
  final String wire;

  static final _byWire = wireIndex(values);
  static RingPushType fromWire(String? raw) => _byWire[raw] ?? unknown;
}

/// Why the server ended an away agent's ringing (a `ring_off` push's
/// `reason`), which the app tells the agent.
///
/// Contract: `AgencyRingOffReason` / `AGENCY_RING_OFF_REASONS`.
enum RingOffReason implements WireEnum {
  /// Two missed rings in a row ([inboundRingMaxMisses]).
  ringMissed('ring_missed'),
  revoked('revoked'),
  optedOut('opted_out'),
  flagOff('flag_off'),
  maxAge('max_age'),

  /// Another device took the station over.
  takenOver('taken_over'),

  /// The session was left with this phone still parked on it (Leave from
  /// another device, or the session ended as idle by a join in another
  /// tenant).
  left('left'),
  unknown('');

  const RingOffReason(this.wire);
  @override
  final String wire;

  static final _byWire = wireIndex(values);
  static RingOffReason fromWire(String? raw) => _byWire[raw] ?? unknown;
}

/// Why `away_ring` was refused (409 on `POST /sessions/:id/break`). The app
/// falls back to `device_away` on any of them.
///
/// Contract: `AgencyAwayRingRefusalCode` / `AGENCY_AWAY_RING_REFUSAL_CODES`.
enum AwayRingRefusalCode implements WireEnum {
  /// Ringing is off for the account, or not a campaign session.
  ringNotAllowed('ring_not_allowed'),

  /// The deployment cannot send pushes to this platform.
  pushUnavailable('push_unavailable'),

  /// This device has no usable push registration.
  noPushDevice('no_push_device'),

  /// Registered, but the agent has not turned ringing on.
  ringDisabled('ring_disabled'),
  unknown('');

  const AwayRingRefusalCode(this.wire);
  @override
  final String wire;

  static final _byWire = wireIndex(values);
  static AwayRingRefusalCode fromWire(String? raw) => _byWire[raw] ?? unknown;
}

// ─── Push devices ───────────────────────────────────────────────────────────

/// One of the agent's push devices, as the routes serve it (never its tokens).
///
/// Contract: `AgencyPushDevice`.
@immutable
final class PushDevice {
  PushDevice({
    required this.deviceId,
    required this.platform,
    String? platformRaw,
    required this.pushRegistered,
    required this.appBuild,
    required this.ringEnabled,
    required this.lastSeenAt,
    this.revokedAt,
    this.lastFailureAt,
    this.lastFailureReason,
    String? lastFailureReasonRaw,
    required this.createdAt,
    required this.updatedAt,
  }) : platformRaw = platformRaw ?? platform.wire,
       lastFailureReasonRaw = lastFailureReasonRaw ?? lastFailureReason?.wire;

  factory PushDevice.fromJson(Map<String, Object?> j) {
    final platform = j.str('platform');
    final failure = j.strOrNull('last_failure_reason');
    return PushDevice(
      deviceId: j.str('device_id'),
      platform: PushPlatform.fromWire(platform),
      platformRaw: platform,
      pushRegistered: j.boolean('push_registered'),
      appBuild: j.str('app_build'),
      ringEnabled: j.boolean('ring_enabled'),
      lastSeenAt: j.time('last_seen_at'),
      revokedAt: j.timeOrNull('revoked_at'),
      lastFailureAt: j.timeOrNull('last_failure_at'),
      lastFailureReason: failure == null ? null : PushFailureReason.fromWire(failure),
      lastFailureReasonRaw: failure,
      createdAt: j.time('created_at'),
      updatedAt: j.time('updated_at'),
    );
  }

  /// The app's station device id (OS3).
  final String deviceId;
  final PushPlatform platform;
  final String platformRaw;

  /// A push address is registered for the platform.
  final bool pushRegistered;
  final String appBuild;

  /// The agent opted in to having this phone rung while away.
  final bool ringEnabled;
  final DateTime lastSeenAt;

  /// Removed, or its token reported gone: register again.
  final DateTime? revokedAt;
  final DateTime? lastFailureAt;
  final PushFailureReason? lastFailureReason;
  final String? lastFailureReasonRaw;
  final DateTime createdAt;
  final DateTime updatedAt;

  /// Usable for a ring: registered, not revoked, opted in.
  bool get canRing => pushRegistered && revokedAt == null && ringEnabled;

  @override
  bool operator ==(Object other) =>
      other is PushDevice &&
      other.deviceId == deviceId &&
      other.platformRaw == platformRaw &&
      other.pushRegistered == pushRegistered &&
      other.appBuild == appBuild &&
      other.ringEnabled == ringEnabled &&
      other.lastSeenAt == lastSeenAt &&
      other.revokedAt == revokedAt &&
      other.lastFailureAt == lastFailureAt &&
      other.lastFailureReasonRaw == lastFailureReasonRaw &&
      other.createdAt == createdAt &&
      other.updatedAt == updatedAt;

  @override
  int get hashCode => Object.hash(deviceId, platformRaw, ringEnabled, revokedAt, updatedAt);
}

/// The answer to `GET`, `PUT` and `PATCH /push-devices/:deviceId`.
///
/// Contract: `AgencyPushDeviceStatus`.
@immutable
final class PushDeviceStatus {
  const PushDeviceStatus({this.device, required this.accountAllowsRing, required this.pushConfigured});

  factory PushDeviceStatus.fromJson(Map<String, Object?> j) {
    final device = j.objOrNull('device');
    return PushDeviceStatus(
      device: device == null ? null : PushDevice.fromJson(device),
      accountAllowsRing: j.boolean('account_allows_ring'),
      pushConfigured: j.boolean('push_configured'),
    );
  }

  /// Null when this device has no row (never registered).
  final PushDevice? device;

  /// Ringing is switched on for the agent's account: show the setting.
  final bool accountAllowsRing;

  /// The deployment can send pushes to this device's platform.
  final bool pushConfigured;

  @override
  bool operator ==(Object other) =>
      other is PushDeviceStatus &&
      other.device == device &&
      other.accountAllowsRing == accountAllowsRing &&
      other.pushConfigured == pushConfigured;

  @override
  int get hashCode => Object.hash(device, accountAllowsRing, pushConfigured);
}

/// `PUT /push-devices/:deviceId`: register or refresh this device. A null
/// [ringEnabled] keeps the stored value; the platform's token is required
/// (`fcmToken` on Android, `voipToken` on iOS).
///
/// Contract: `AgencyPushDevicePutRequest`.
@immutable
final class PushDevicePutRequest {
  const PushDevicePutRequest({
    required this.platform,
    this.fcmToken,
    this.voipToken,
    required this.appBuild,
    this.ringEnabled,
  });

  final PushPlatform platform;
  final String? fcmToken;
  final String? voipToken;
  final String appBuild;
  final bool? ringEnabled;

  Map<String, Object?> toJson() {
    final json = <String, Object?>{'platform': platform.wire};
    putIfSet(json, 'fcm_token', fcmToken);
    putIfSet(json, 'voip_token', voipToken);
    json['app_build'] = appBuild;
    putIfSet(json, 'ring_enabled', ringEnabled);
    return json;
  }

  @override
  bool operator ==(Object other) =>
      other is PushDevicePutRequest &&
      other.platform == platform &&
      other.fcmToken == fcmToken &&
      other.voipToken == voipToken &&
      other.appBuild == appBuild &&
      other.ringEnabled == ringEnabled;

  @override
  int get hashCode => Object.hash(platform, fcmToken, voipToken, appBuild, ringEnabled);
}

/// `PATCH /push-devices/:deviceId`: opt in or out. Off ends this device's
/// `away_ring` ("Stop ringing").
///
/// Contract: `AgencyPushDevicePatchRequest`.
@immutable
final class PushDevicePatchRequest {
  const PushDevicePatchRequest({required this.ringEnabled});

  final bool ringEnabled;

  Map<String, Object?> toJson() => <String, Object?>{'ring_enabled': ringEnabled};

  @override
  bool operator ==(Object other) => other is PushDevicePatchRequest && other.ringEnabled == ringEnabled;

  @override
  int get hashCode => ringEnabled.hashCode;
}

// ─── Ring pushes ────────────────────────────────────────────────────────────

/// A ring push's data payload (FCM `data`: every value a string). IQ61: never
/// a name or a number; fetch the call with `GET /inbound/calls/:id` once
/// accepted.
///
/// Contract: `AgencyRingPush`.
@immutable
final class RingPush {
  RingPush({
    required this.type,
    String? typeRaw,
    this.callId,
    this.offerToken,
    this.ringExpiresAt,
    this.sessionId,
    this.reasonRaw,
    this.awaySince,
  }) : typeRaw = typeRaw ?? type.wire;

  /// Reads a payload; [RingPushType.unknown] for a type this build does not
  /// know (ignore it). Throws [WireFormatException] when a field is not a string.
  factory RingPush.fromJson(Map<String, Object?> j) {
    final type = j.str('type');
    return RingPush(
      type: RingPushType.fromWire(type),
      typeRaw: type,
      callId: j.strOrNull('call_id'),
      offerToken: j.strOrNull('offer_token'),
      ringExpiresAt: j.timeOrNull('ring_expires_at'),
      sessionId: j.strOrNull('session_id'),
      reasonRaw: j.strOrNull('reason'),
      awaySince: j.timeOrNull('away_since'),
    );
  }

  final RingPushType type;
  final String typeRaw;

  /// `ring`, `ring_cancel`.
  final String? callId;

  /// `ring`: what `…/ring/{answering,decline,accept}` take. Never log it.
  final String? offerToken;

  /// `ring`: stop ringing on its own then.
  final DateTime? ringExpiresAt;

  /// `ring`, `ring_off`.
  final String? sessionId;

  /// `ring_cancel`: an [InboundRingResult]; `ring_off`: a [RingOffReason].
  final String? reasonRaw;

  /// `ring_off`: the start of the absence it ends (the `since` of the
  /// `away_ring` the phone was told of, kept by the `device_away` that ends
  /// it). A carrier can deliver a `ring_off` late, after a new absence began:
  /// drop one older than the absence on show. Null from older servers.
  final DateTime? awaySince;

  /// A `ring_cancel`'s reason; null on any other type.
  InboundRingResult? get cancelReason =>
      type == RingPushType.ringCancel && reasonRaw != null ? InboundRingResult.fromWire(reasonRaw) : null;

  /// A `ring_off`'s reason; null on any other type.
  RingOffReason? get offReason =>
      type == RingPushType.ringOff && reasonRaw != null ? RingOffReason.fromWire(reasonRaw) : null;

  /// The payload as the server sends it (every value a string), for tests and
  /// the native hand-off.
  Map<String, Object?> toJson() {
    final json = <String, Object?>{'type': typeRaw};
    putIfSet(json, 'call_id', callId);
    putIfSet(json, 'offer_token', offerToken);
    putIfSet(json, 'ring_expires_at', ringExpiresAt == null ? null : isoUtc(ringExpiresAt!));
    putIfSet(json, 'session_id', sessionId);
    putIfSet(json, 'reason', reasonRaw);
    putIfSet(json, 'away_since', awaySince == null ? null : isoUtc(awaySince!));
    return json;
  }

  @override
  bool operator ==(Object other) =>
      other is RingPush &&
      other.typeRaw == typeRaw &&
      other.callId == callId &&
      other.offerToken == offerToken &&
      other.ringExpiresAt == ringExpiresAt &&
      other.sessionId == sessionId &&
      other.reasonRaw == reasonRaw &&
      other.awaySince == awaySince;

  @override
  int get hashCode => Object.hash(typeRaw, callId, offerToken, ringExpiresAt, sessionId, reasonRaw, awaySince);

  @override
  String toString() => 'RingPush($typeRaw, call: $callId)';
}

// ─── The ring routes ────────────────────────────────────────────────────────

/// `POST /inbound/calls/:id/ring/answering`: the agent tapped Answer; starts
/// the accept grace ([inboundAcceptGrace]).
///
/// Contract: `AgencyInboundRingAnsweringRequest`.
@immutable
final class InboundRingAnsweringRequest {
  const InboundRingAnsweringRequest({required this.offerToken});

  final String offerToken;

  Map<String, Object?> toJson() => <String, Object?>{'offer_token': offerToken};

  @override
  bool operator ==(Object other) => other is InboundRingAnsweringRequest && other.offerToken == offerToken;

  @override
  int get hashCode => offerToken.hashCode;

  @override
  String toString() => 'InboundRingAnsweringRequest(<token>)';
}

/// Contract: `AgencyInboundRingAnsweringResponse`.
@immutable
final class InboundRingAnsweringResponse {
  const InboundRingAnsweringResponse({required this.callId, required this.acceptBy});

  factory InboundRingAnsweringResponse.fromJson(Map<String, Object?> j) =>
      InboundRingAnsweringResponse(callId: j.str('call_id'), acceptBy: j.time('accept_by'));

  final String callId;

  /// When the offer lapses unless accepted and bound.
  final DateTime acceptBy;

  @override
  bool operator ==(Object other) =>
      other is InboundRingAnsweringResponse && other.callId == callId && other.acceptBy == acceptBy;

  @override
  int get hashCode => Object.hash(callId, acceptBy);
}

/// `POST /inbound/calls/:id/ring/decline`: valid until accept (N4); never a
/// miss.
///
/// Contract: `AgencyInboundRingDeclineRequest`.
@immutable
final class InboundRingDeclineRequest {
  const InboundRingDeclineRequest({required this.offerToken, required this.reason});

  final String offerToken;
  final InboundRingDeclineReason reason;

  Map<String, Object?> toJson() => <String, Object?>{'offer_token': offerToken, 'reason': reason.wire};

  @override
  bool operator ==(Object other) =>
      other is InboundRingDeclineRequest && other.offerToken == offerToken && other.reason == reason;

  @override
  int get hashCode => Object.hash(offerToken, reason);

  @override
  String toString() => 'InboundRingDeclineRequest(<token>, ${reason.wire})';
}

/// Contract: `AgencyInboundRingDeclineResponse`.
@immutable
final class InboundRingDeclineResponse {
  InboundRingDeclineResponse({required this.callId, required this.ringResult, String? ringResultRaw})
    : ringResultRaw = ringResultRaw ?? ringResult.wire;

  factory InboundRingDeclineResponse.fromJson(Map<String, Object?> j) {
    final result = j.str('ring_result');
    return InboundRingDeclineResponse(
      callId: j.str('call_id'),
      ringResult: InboundRingResult.fromWire(result),
      ringResultRaw: result,
    );
  }

  final String callId;
  final InboundRingResult ringResult;
  final String ringResultRaw;

  @override
  bool operator ==(Object other) =>
      other is InboundRingDeclineResponse && other.callId == callId && other.ringResultRaw == ringResultRaw;

  @override
  int get hashCode => Object.hash(callId, ringResultRaw);
}

/// `POST /inbound/calls/:id/ring/accept` (Firebase Bearer): take the call.
/// [deviceId] must be the device holding the session's station (OS3).
///
/// Contract: `AgencyInboundRingAcceptRequest`.
@immutable
final class InboundRingAcceptRequest {
  const InboundRingAcceptRequest({required this.offerToken, required this.deviceId});

  final String offerToken;
  final String deviceId;

  Map<String, Object?> toJson() => <String, Object?>{'offer_token': offerToken, 'device_id': deviceId};

  @override
  bool operator ==(Object other) =>
      other is InboundRingAcceptRequest && other.offerToken == offerToken && other.deviceId == deviceId;

  @override
  int get hashCode => Object.hash(offerToken, deviceId);

  @override
  String toString() => 'InboundRingAcceptRequest(<token>, $deviceId)';
}

/// The answer to `…/ring/accept`: the call as offered, and the station
/// bootstrap to attach with (`caps=inbound`); the call binds once attached.
///
/// Contract: `AgencyInboundRingAcceptResponse`.
@immutable
final class InboundRingAcceptResponse {
  const InboundRingAcceptResponse({
    required this.call,
    required this.sessionId,
    required this.campaignId,
    required this.stationWsUrl,
    required this.stationTokenExpiresAt,
  });

  factory InboundRingAcceptResponse.fromJson(Map<String, Object?> j) => InboundRingAcceptResponse(
    call: InboundCall.fromJson(j.obj('call')),
    sessionId: j.str('session_id'),
    campaignId: j.str('campaign_id'),
    stationWsUrl: j.str('station_ws_url'),
    stationTokenExpiresAt: j.time('station_token_expires_at'),
  );

  final InboundCall call;
  final String sessionId;
  final String campaignId;

  /// RELATIVE path with the single-use token appended.
  final String stationWsUrl;
  final DateTime stationTokenExpiresAt;

  @override
  bool operator ==(Object other) =>
      other is InboundRingAcceptResponse &&
      other.call == call &&
      other.sessionId == sessionId &&
      other.campaignId == campaignId &&
      other.stationWsUrl == stationWsUrl &&
      other.stationTokenExpiresAt == stationTokenExpiresAt;

  @override
  int get hashCode => Object.hash(call, sessionId, campaignId, stationWsUrl, stationTokenExpiresAt);
}
