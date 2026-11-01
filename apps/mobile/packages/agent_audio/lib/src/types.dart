import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';

import 'util.dart';

/// Channel names shared with `AgentAudioPlugin.kt` and `AgentAudioPlugin.swift`.
abstract final class AgentAudioChannels {
  static const String methods = 'magick_agency/agent_audio/methods';
  static const String events = 'magick_agency/agent_audio/events';

  /// Native → Dart, BinaryCodec: one encoded 20 ms uplink frame per message.
  static const String uplink = 'magick_agency/agent_audio/uplink';

  /// Dart → native, BinaryCodec: downlink audio, any chunking (native re-frames it).
  static const String downlink = 'magick_agency/agent_audio/downlink';
}

/// The wire format of the station socket's media, both directions.
enum AgentAudioFormat {
  /// G.711 A-law, 8 kHz mono: 160 bytes per 20 ms, sent as binary WebSocket frames.
  alaw8(wireName: 'alaw8', sampleRate: 8000, frameBytes: 160),

  /// PCM16 little-endian, 16 kHz mono: 640 bytes per 20 ms (base64 in JSON on the socket).
  pcm16(wireName: 'pcm16', sampleRate: 16000, frameBytes: 640);

  const AgentAudioFormat({required this.wireName, required this.sampleRate, required this.frameBytes});

  final String wireName;
  final int sampleRate;
  final int frameBytes;

  static const Duration frameDuration = Duration(milliseconds: 20);

  int get frameSamples => sampleRate ~/ 50;
}

/// The engine's lifecycle, mirrored natively. See [AgentAudioPhase.after].
enum AgentAudioPhase {
  /// Nothing configured. Off duty.
  idle,

  /// Audio session configured for voice and pre-warmed (`available`). No mic capture.
  prepared,

  /// Capture and playback running, uplink discarded (`reserved`). Mic indicator is on.
  armed,

  /// Uplink frames flow to Dart (`bridged`).
  streaming;

  /// The phase after [op], or throws [AgentAudioException] with
  /// [AgentAudioErrorCode.invalidState] when [op] is not allowed here. Pure, so the
  /// transition table is unit-tested; the native engines enforce the same table.
  AgentAudioPhase after(AudioOp op) {
    switch (op) {
      case AudioOp.prepare:
        if (this == idle || this == prepared) return prepared;
      case AudioOp.arm:
        if (this == prepared) return armed;
        if (this == armed || this == streaming) return this;
      case AudioOp.startUplink:
        if (this == armed || this == streaming) return streaming;
      case AudioOp.stopKeepWarm:
        return this == idle ? idle : prepared;
      case AudioOp.release:
        return idle;
      case AudioOp.loopback:
        if (this == prepared) return prepared;
    }
    throw AgentAudioException(
      this == idle ? AgentAudioErrorCode.notPrepared : AgentAudioErrorCode.invalidState,
      'Cannot ${op.name} while $name',
    );
  }
}

/// Operations that move [AgentAudioPhase].
enum AudioOp { prepare, arm, startUplink, stopKeepWarm, release, loopback }

enum AudioRouteKind { earpiece, speaker, wired, bluetooth }

/// One place audio can go. [id] is stable for the life of the device connection and is
/// what [AgentAudio.setRoute] selects by. [name] is a headset's product name (e.g. "boAt
/// Airdopes 141"); it is empty for the built-in earpiece and speaker, which the app labels by
/// [kind] in its own words.
@immutable
final class AudioRoute {
  const AudioRoute({required this.kind, required this.id, required this.name});

  factory AudioRoute.fromMap(Map<Object?, Object?> map) => AudioRoute(
        kind: enumByName(AudioRouteKind.values, map['kind'], AudioRouteKind.earpiece),
        id: map['id'] as String? ?? '',
        name: map['name'] as String? ?? '',
      );

  final AudioRouteKind kind;
  final String id;
  final String name;

  Map<String, Object?> toMap() => {'kind': kind.name, 'id': id, 'name': name};

  @override
  bool operator ==(Object other) => other is AudioRoute && other.kind == kind && other.id == id && other.name == name;

  @override
  int get hashCode => Object.hash(kind, id, name);

  @override
  String toString() => 'AudioRoute(${kind.name}, $id, $name)';
}

/// How a CallKit call ended (iOS). Android ignores it (no ConnectionService in v1).
enum CallEndReason {
  /// The agent hung up in the app: the plugin asks CallKit to end the call.
  local,

  /// The far end hung up.
  remoteEnded,

  /// The call failed to connect or dropped.
  failed,

  /// Nobody answered.
  unanswered,
}

enum AgentAudioErrorCode {
  permissionDenied('permission_denied'),
  deviceBusy('device_busy'),
  notPrepared('not_prepared'),
  invalidState('invalid_state'),
  callSystem('call_system'),
  notInForeground('not_in_foreground'),
  unsupported('unsupported'),
  lost('lost'),
  mediaServicesReset('media_services_reset'),
  unknown('unknown');

  const AgentAudioErrorCode(this.wireName);
  final String wireName;

  static AgentAudioErrorCode fromWire(Object? value) =>
      values.firstWhere((c) => c.wireName == value, orElse: () => unknown);
}

/// A failed plugin call. Every [PlatformException] from the native side is mapped to one.
@immutable
final class AgentAudioException implements Exception {
  const AgentAudioException(this.code, [this.message = '']);

  factory AgentAudioException.fromPlatform(PlatformException e) =>
      AgentAudioException(AgentAudioErrorCode.fromWire(e.code), e.message ?? '');

  final AgentAudioErrorCode code;
  final String message;

  @override
  bool operator ==(Object other) => other is AgentAudioException && other.code == code && other.message == message;

  @override
  int get hashCode => Object.hash(code, message);

  @override
  String toString() => 'AgentAudioException(${code.wireName}: $message)';
}

/// The Android on-duty notification (foreground service). All strings come from the app
/// so they are localised there.
@immutable
final class OnDutyNotification {
  const OnDutyNotification({
    required this.title,
    required this.text,
    required this.channelName,
    this.call,
  });

  final String title;
  final String text;

  /// The notification channel's name in system settings (e.g. "On duty").
  final String channelName;

  /// Set while a call is live: the notification becomes an ongoing call with a timer and
  /// Mute / Hang up actions, which arrive as [CallSystemAction] events.
  final OnDutyCall? call;

  Map<String, Object?> toMap() => {
        'title': title,
        'text': text,
        'channelName': channelName,
        'call': call?.toMap(),
      };

  @override
  bool operator ==(Object other) =>
      other is OnDutyNotification &&
      other.title == title &&
      other.text == text &&
      other.channelName == channelName &&
      other.call == call;

  @override
  int get hashCode => Object.hash(title, text, channelName, call);
}

@immutable
final class OnDutyCall {
  const OnDutyCall({
    required this.muted,
    required this.muteLabel,
    required this.unmuteLabel,
    required this.hangUpLabel,
    this.connectedAt,
  });

  final bool muted;
  final String muteLabel;
  final String unmuteLabel;
  final String hangUpLabel;

  /// Shown as a running timer when set.
  final DateTime? connectedAt;

  Map<String, Object?> toMap() => {
        'muted': muted,
        'muteLabel': muteLabel,
        'unmuteLabel': unmuteLabel,
        'hangUpLabel': hangUpLabel,
        'connectedAtMs': connectedAt?.millisecondsSinceEpoch,
      };

  @override
  bool operator ==(Object other) =>
      other is OnDutyCall &&
      other.muted == muted &&
      other.muteLabel == muteLabel &&
      other.unmuteLabel == unmuteLabel &&
      other.hangUpLabel == hangUpLabel &&
      other.connectedAt == connectedAt;

  @override
  int get hashCode => Object.hash(muted, muteLabel, unmuteLabel, hangUpLabel, connectedAt);
}
