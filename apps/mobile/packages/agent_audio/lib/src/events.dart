import 'package:flutter/foundation.dart';

import 'types.dart';
import 'util.dart';

/// Everything the native side reports outside a method call's result. Decoded from the
/// event channel's maps by [AudioEvent.decode]; the map schema is listed in README.md.
@immutable
sealed class AudioEvent {
  const AudioEvent();

  /// Decodes one event-channel message. Unknown or malformed messages decode to `null`, so
  /// a newer native build never breaks an older Dart one.
  static AudioEvent? decode(Object? raw) {
    if (raw is! Map) return null;
    final m = raw.cast<Object?, Object?>();
    switch (m['type']) {
      case 'route':
        final current = m['current'];
        final available = m['available'];
        return AudioRouteChanged(
          current: current is Map ? AudioRoute.fromMap(current.cast<Object?, Object?>()) : null,
          available: available is List
              ? List.unmodifiable(
                  available.whereType<Map<Object?, Object?>>().map(AudioRoute.fromMap),
                )
              : const [],
          reason: enumByName(RouteChangeReason.values, m['reason'], RouteChangeReason.other),
        );
      case 'interruption':
        final reason = enumByName(InterruptionReason.values, m['reason'], InterruptionReason.other);
        return m['phase'] == 'ended'
            ? AudioInterruptionEnded(reason: reason, shouldResume: boolOr(m['shouldResume']))
            : AudioInterruptionBegan(reason: reason);
      case 'noisy':
        return const AudioBecomingNoisy();
      case 'error':
        return AudioErrorEvent(
          code: AgentAudioErrorCode.fromWire(m['code']),
          message: m['message'] as String? ?? '',
          recovered: boolOr(m['recovered']),
        );
      case 'level':
        return InputLevel(doubleOr(m['dbfs'], InputLevel.floorDbfs));
      case 'jitter':
        return JitterStats(
          depthFrames: intOr(m['depth']),
          targetFrames: intOr(m['target']),
          underruns: intOr(m['underruns']),
          concealedFrames: intOr(m['concealed']),
          silentFrames: intOr(m['silent']),
          overflowDrops: intOr(m['overflowDrops']),
          latencyDrops: intOr(m['latencyDrops']),
          receivedFrames: intOr(m['received']),
          playedFrames: intOr(m['played']),
          uplinkDrops: intOr(m['uplinkDrops']),
        );
      case 'callAction':
        final action = m['action'];
        if (action != 'end' && action != 'mute') return null;
        return CallSystemAction(
          kind: action == 'end' ? CallActionKind.end : CallActionKind.mute,
          callId: m['callId'] as String?,
          muted: m['muted'] as bool?,
          source: enumByName(CallActionSource.values, m['source'], CallActionSource.callKit),
        );
      case 'session':
        return AudioSessionActivation(active: boolOr(m['active']));
      case 'callReset':
        return const CallSystemReset();
      case 'service':
        // Only the stop is reported; a start is the result of `startOnDutyService`.
        return m['running'] == false ? const OnDutyServiceStopped() : null;
    }
    return null;
  }
}

enum RouteChangeReason {
  /// A headset or Bluetooth device appeared and audio moved to it.
  newDevice,

  /// The device in use went away (unplugged, out of range); audio moved to [AudioRouteChanged.current].
  deviceRemoved,

  /// The app asked for this route.
  requested,

  other,
}

/// The current route and what else is available. Sent on every change and once when the
/// engine is prepared. Audio never moves to the loudspeaker on its own: when a headset goes,
/// it falls back to wired, then the earpiece (speaker only on devices without one).
final class AudioRouteChanged extends AudioEvent {
  const AudioRouteChanged({required this.current, required this.available, required this.reason});

  final AudioRoute? current;
  final List<AudioRoute> available;
  final RouteChangeReason reason;

  @override
  bool operator ==(Object other) =>
      other is AudioRouteChanged &&
      other.current == current &&
      listEquals(other.available, available) &&
      other.reason == reason;

  @override
  int get hashCode => Object.hash(current, Object.hashAll(available), reason);

  @override
  String toString() => 'AudioRouteChanged($current, $available, ${reason.name})';
}

enum InterruptionReason {
  /// A cellular call is ringing or active.
  phoneCall,

  /// Another app took audio focus (Android).
  focusLoss,

  /// The OS is feeding the app silence instead of the mic (Android 10+ capture policy).
  microphoneSilenced,

  /// The system interrupted the session (iOS: Siri, alarm, another app's session).
  system,

  other,
}

/// Audio stopped for a reason outside the app. The engine keeps its phase; capture or
/// playback may be silent until [AudioInterruptionEnded].
final class AudioInterruptionBegan extends AudioEvent {
  const AudioInterruptionBegan({required this.reason});

  final InterruptionReason reason;

  @override
  bool operator ==(Object other) => other is AudioInterruptionBegan && other.reason == reason;

  @override
  int get hashCode => reason.hashCode;

  @override
  String toString() => 'AudioInterruptionBegan(${reason.name})';
}

/// The interruption is over. When [shouldResume] the plugin has already restarted audio.
final class AudioInterruptionEnded extends AudioEvent {
  const AudioInterruptionEnded({required this.reason, required this.shouldResume});

  final InterruptionReason reason;
  final bool shouldResume;

  @override
  bool operator ==(Object other) =>
      other is AudioInterruptionEnded && other.reason == reason && other.shouldResume == shouldResume;

  @override
  int get hashCode => Object.hash(reason, shouldResume);

  @override
  String toString() => 'AudioInterruptionEnded(${reason.name}, resume: $shouldResume)';
}

/// A wired or Bluetooth headset was disconnected. Audio has moved (see the
/// [AudioRouteChanged] that follows); the app tells the agent where it went.
final class AudioBecomingNoisy extends AudioEvent {
  const AudioBecomingNoisy();

  @override
  bool operator ==(Object other) => other is AudioBecomingNoisy;

  @override
  int get hashCode => (AudioBecomingNoisy).hashCode;
}

/// Something failed outside a method call (the capture device was lost, media services
/// reset). [recovered] is true when the plugin rebuilt the pipeline itself.
final class AudioErrorEvent extends AudioEvent {
  const AudioErrorEvent({required this.code, required this.message, this.recovered = false});

  final AgentAudioErrorCode code;
  final String message;
  final bool recovered;

  @override
  bool operator ==(Object other) =>
      other is AudioErrorEvent && other.code == code && other.message == message && other.recovered == recovered;

  @override
  int get hashCode => Object.hash(code, message, recovered);

  @override
  String toString() => 'AudioErrorEvent(${code.wireName}, $message, recovered: $recovered)';
}

/// Microphone level, about 10 per second while metering is on
/// ([AgentAudio.setInputLevelMetering]).
final class InputLevel extends AudioEvent {
  const InputLevel(this.dbfs);

  static const double floorDbfs = -100;

  /// RMS level of the last 100 ms in dBFS (0 is full scale, [floorDbfs] is silence).
  final double dbfs;

  /// 0..1 for a meter: −60 dBFS and below is empty, 0 dBFS is full.
  double get normalized => dbfs <= -60 ? 0 : (dbfs >= 0 ? 1 : (dbfs + 60) / 60);

  @override
  bool operator ==(Object other) => other is InputLevel && other.dbfs == dbfs;

  @override
  int get hashCode => dbfs.hashCode;

  @override
  String toString() => 'InputLevel($dbfs dBFS)';
}

/// Downlink playout health, once per second while the engine runs. Counters are
/// cumulative since [AgentAudio.armMicrophone].
final class JitterStats extends AudioEvent {
  const JitterStats({
    required this.depthFrames,
    required this.targetFrames,
    required this.underruns,
    required this.concealedFrames,
    required this.silentFrames,
    required this.overflowDrops,
    required this.latencyDrops,
    required this.receivedFrames,
    required this.playedFrames,
    required this.uplinkDrops,
  });

  static const int frameMs = 20;

  final int depthFrames;
  final int targetFrames;

  /// Times the buffer ran dry mid-playout.
  final int underruns;
  final int concealedFrames;
  final int silentFrames;

  /// Frames dropped because a burst overfilled the buffer.
  final int overflowDrops;

  /// Frames dropped to bring delay back down after a burst.
  final int latencyDrops;
  final int receivedFrames;
  final int playedFrames;

  /// Uplink frames dropped because the platform thread fell behind.
  final int uplinkDrops;

  int get depthMs => depthFrames * frameMs;
  int get targetMs => targetFrames * frameMs;

  @override
  bool operator ==(Object other) =>
      other is JitterStats &&
      other.depthFrames == depthFrames &&
      other.targetFrames == targetFrames &&
      other.underruns == underruns &&
      other.concealedFrames == concealedFrames &&
      other.silentFrames == silentFrames &&
      other.overflowDrops == overflowDrops &&
      other.latencyDrops == latencyDrops &&
      other.receivedFrames == receivedFrames &&
      other.playedFrames == playedFrames &&
      other.uplinkDrops == uplinkDrops;

  @override
  int get hashCode => Object.hash(depthFrames, targetFrames, underruns, concealedFrames, silentFrames,
      overflowDrops, latencyDrops, receivedFrames, playedFrames, uplinkDrops);

  @override
  String toString() => 'JitterStats(depth ${depthMs}ms, target ${targetMs}ms, underruns $underruns, '
      'concealed $concealedFrames, silent $silentFrames, overflow $overflowDrops, trimmed $latencyDrops, '
      'rx $receivedFrames, played $playedFrames, uplinkDrops $uplinkDrops)';
}

enum CallActionKind {
  /// The agent ended the call from the system UI (CallKit, lock screen, notification).
  end,

  /// The agent toggled mute from the system UI; see [CallSystemAction.muted].
  mute,
}

enum CallActionSource { callKit, notification }

/// The agent acted on the call outside the app's UI. For [CallActionKind.mute] the plugin
/// has already applied [muted] to the uplink; the app updates its own state to match. For
/// [CallActionKind.end] the app hangs up through the API as if the agent pressed Hang up.
final class CallSystemAction extends AudioEvent {
  const CallSystemAction({required this.kind, required this.source, this.callId, this.muted});

  final CallActionKind kind;
  final CallActionSource source;

  /// The id given to [AgentAudio.startCall] (CallKit), or null (Android notification).
  final String? callId;
  final bool? muted;

  @override
  bool operator ==(Object other) =>
      other is CallSystemAction &&
      other.kind == kind &&
      other.source == source &&
      other.callId == callId &&
      other.muted == muted;

  @override
  int get hashCode => Object.hash(kind, source, callId, muted);

  @override
  String toString() => 'CallSystemAction(${kind.name}, ${source.name}, $callId, muted: $muted)';
}

/// iOS: CallKit activated or deactivated the audio session. Audio flows only while active.
final class AudioSessionActivation extends AudioEvent {
  const AudioSessionActivation({required this.active});

  final bool active;

  @override
  bool operator ==(Object other) => other is AudioSessionActivation && other.active == active;

  @override
  int get hashCode => active.hashCode;

  @override
  String toString() => 'AudioSessionActivation($active)';
}

/// iOS: CallKit reset its provider (rare; e.g. the call service restarted). Every call the
/// plugin reported is gone and audio has stopped; the app ends its current call.
final class CallSystemReset extends AudioEvent {
  const CallSystemReset();

  @override
  bool operator ==(Object other) => other is CallSystemReset;

  @override
  int get hashCode => (CallSystemReset).hashCode;
}

/// Android: the on-duty foreground service stopped without the app asking (the system or the
/// agent stopped it). Until it runs again, Android may cut the microphone when the app leaves
/// the screen; start it again with [AgentAudio.startOnDutyService] while the app is on screen.
final class OnDutyServiceStopped extends AudioEvent {
  const OnDutyServiceStopped();

  @override
  bool operator ==(Object other) => other is OnDutyServiceStopped;

  @override
  int get hashCode => (OnDutyServiceStopped).hashCode;

  @override
  String toString() => 'OnDutyServiceStopped()';
}
