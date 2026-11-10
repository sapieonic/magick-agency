import 'dart:async';

import 'package:flutter/services.dart';

import 'events.dart';
import 'loopback.dart';
import 'types.dart';

/// The voice engine and call-system integration for the agent app.
///
/// One instance lives for the app's lifetime (the app's `AudioEngine` facade owns it). The
/// call lifecycle maps onto [AgentAudioPhase]:
///
/// | Agent state | Call                                | Phase after       |
/// |-------------|-------------------------------------|-------------------|
/// | available   | [prepare]                           | prepared          |
/// | reserved    | [startCall], then [armMicrophone]   | armed             |
/// | bridged     | [startUplink], [reportConnected]    | streaming         |
/// | call ended  | [endCall], then [stop]              | prepared          |
/// | off duty    | [release]                           | idle              |
///
/// Media never goes through the method channel: encoded uplink frames arrive on [uplink]
/// from a binary channel, and [playFrame] sends downlink bytes on another one, both with
/// `BinaryCodec`, so a 20 ms frame costs one platform message and no encoding.
///
/// Lifecycle calls are serialised in call order, and each is checked against
/// [AgentAudioPhase.after] before it reaches the platform. Every platform failure surfaces
/// as an [AgentAudioException].
class AgentAudio {
  AgentAudio({BinaryMessenger? messenger})
      : _messenger = messenger ?? ServicesBinding.instance.defaultBinaryMessenger {
    _methods = MethodChannel(AgentAudioChannels.methods, const StandardMethodCodec(), _messenger);
    _eventChannel = EventChannel(AgentAudioChannels.events, const StandardMethodCodec(), _messenger);
    _messenger.setMessageHandler(AgentAudioChannels.uplink, _onUplink);
  }

  final BinaryMessenger _messenger;
  late final MethodChannel _methods;
  late final EventChannel _eventChannel;

  // Synchronous: frames go straight to the socket listener without a microtask hop each.
  // Safe because frames are only added from the platform-message handler, never from a
  // listener.
  final StreamController<Uint8List> _uplink = StreamController<Uint8List>.broadcast(sync: true);

  Future<void> _tail = Future<void>.value();
  AgentAudioPhase _phase = AgentAudioPhase.idle;
  AgentAudioFormat? _format;
  bool _loopbackRunning = false;
  bool _disposed = false;

  /// The phase as of the last completed lifecycle call.
  AgentAudioPhase get phase => _phase;

  /// The format set by the last [prepare], or null when idle.
  AgentAudioFormat? get format => _format;

  /// Encoded 20 ms uplink frames, ready to send as-is: 160 bytes of A-law for
  /// [AgentAudioFormat.alaw8], 640 bytes of PCM16LE for [AgentAudioFormat.pcm16]. Frames
  /// flow only in [AgentAudioPhase.streaming]; while muted they carry silence so the far
  /// end keeps its timing. Each [Uint8List] is a fresh buffer the listener may keep.
  Stream<Uint8List> get uplink => _uplink.stream;

  /// Route changes, interruptions, errors, levels, jitter stats and call-system actions.
  late final Stream<AudioEvent> events = _eventChannel.receiveBroadcastStream().transform(
        StreamTransformer<dynamic, AudioEvent>.fromHandlers(
          handleData: (Object? raw, EventSink<AudioEvent> sink) {
            final event = AudioEvent.decode(raw);
            if (event != null) sink.add(event);
          },
        ),
      );

  /// Configures the audio session for a voice call and pre-warms it, without opening the
  /// microphone. Call at `available` so a late-bound call has audio within its 1 s budget.
  /// Calling it again with the same or another format while [AgentAudioPhase.prepared] is
  /// allowed; during a call it throws [AgentAudioErrorCode.invalidState].
  ///
  /// iOS with CallKit: configures the session category and builds the voice-processing
  /// engine; CallKit activates the session at [startCall].
  Future<void> prepare({required AgentAudioFormat format}) => _lifecycle(AudioOp.prepare, () async {
        await _invoke<void>('prepare', {'format': format.wireName});
        _format = format;
      });

  /// Starts capture and playback (`reserved`). The mic indicator turns on; uplink frames
  /// are discarded until [startUplink]. Downlink frames passed to [playFrame] play from
  /// here on. With CallKit, audio starts once CallKit activates the session (an
  /// [AudioSessionActivation] event follows).
  Future<void> armMicrophone() => _lifecycle(AudioOp.arm, () => _invoke<void>('armMicrophone'));

  /// Opens the uplink (`bridged`): encoded frames start arriving on [uplink].
  Future<void> startUplink() => _lifecycle(AudioOp.startUplink, () => _invoke<void>('startUplink'));

  /// Ends audio for this call: stops capture and playback, releases the microphone, clears
  /// the jitter buffer and unmutes. With [keepWarm] (the default, between calls) the
  /// session stays configured for the next call; without it this is [release]. Safe to
  /// call in any phase and more than once.
  Future<void> stop({bool keepWarm = true}) => _lifecycle(
        keepWarm ? AudioOp.stopKeepWarm : AudioOp.release,
        () async {
          await _invoke<void>('stop', {'keepWarm': keepWarm});
          if (!keepWarm) _format = null;
        },
      );

  /// Releases everything: audio session, focus, route and device listeners (off duty).
  Future<void> release() => stop(keepWarm: false);

  /// Queues downlink audio (normally one 20 ms frame, ~50 per second; any chunking works,
  /// the native side re-frames it). Ignored unless the engine is armed or streaming.
  ///
  /// The bytes are copied by the platform channel before this returns, so the caller may
  /// reuse [frame].
  void playFrame(Uint8List frame) {
    if (frame.isEmpty || _phase.index < AgentAudioPhase.armed.index) return;
    _messenger.send(AgentAudioChannels.downlink, ByteData.sublistView(frame));
  }

  /// Mutes or unmutes the uplink (frames keep flowing, as silence). With an active CallKit
  /// call the system's mute button follows.
  Future<void> setMuted(bool muted) => _invoke<void>('setMuted', {'muted': muted});

  /// Plays (or stops) the ringback tone while the customer's phone rings on a soft-phone
  /// call: 400 + 450 Hz, 0.4 s on, 0.2 s off, 0.4 s on, 2 s off, generated on the device and
  /// mixed into the call's playout (so any early media is still heard). See
  /// `lib/src/tone/ringback.dart` for the exact tone.
  ///
  /// The native side keeps the request: asked for before [armMicrophone], it starts with the
  /// engine; it survives an engine restart; [stop] clears it. It does not change the phase,
  /// but it is queued behind pending lifecycle calls, so a [stop] still in flight cannot
  /// clear a request made after it. Turning it on again starts a fresh ring.
  Future<void> setRingback(bool on) => _queued(() => _invoke<void>('setRingback', {'on': on}));

  /// Plays the inbound chime once (an inbound caller has been offered to the agent): the
  /// console's `inbound_ring` cue, a two-note bell rung twice, about 0.84 s, made on the device
  /// and mixed into the call's playout, never into the uplink. See `lib/src/tone/chime.dart`.
  ///
  /// Asked for before the engine runs (between [armMicrophone] and CallKit activating the
  /// session on iOS), it plays when the engine starts; [stop] drops a request not yet played
  /// and silences one playing. Asked for again while it plays, it starts over. Never during a
  /// loopback test. Like [setRingback] it does not change the phase and is queued behind
  /// pending lifecycle calls.
  Future<void> playChime() => _queued(() => _invoke<void>('playChime'));

  /// Routes available now. Earpiece is absent on devices without one.
  Future<List<AudioRoute>> routes() async {
    final raw = await _invoke<List<Object?>>('routes');
    return List.unmodifiable(
      (raw ?? const []).whereType<Map<Object?, Object?>>().map(AudioRoute.fromMap),
    );
  }

  /// The route audio is using now, or null before [prepare].
  Future<AudioRoute?> currentRoute() async {
    final raw = await _invoke<Map<Object?, Object?>>('currentRoute');
    return raw == null ? null : AudioRoute.fromMap(raw);
  }

  /// Moves audio to [route] (one of [routes]). An [AudioRouteChanged] with reason
  /// [RouteChangeReason.requested] confirms it.
  Future<void> setRoute(AudioRoute route) => _invoke<void>('setRoute', route.toMap());

  /// Turns [InputLevel] events (about 10 per second) on or off. Off by default; the
  /// pre-flight meter turns it on.
  Future<void> setInputLevelMetering(bool enabled) => _invoke<void>('setInputLevelMetering', {'enabled': enabled});

  /// Pre-flight mic and speaker check. Records [duration] through the real call pipeline
  /// (voice processing, the prepared format's codec, the jitter buffer), then, if
  /// [playBack], plays the recording through the current route. Requires
  /// [AgentAudioPhase.prepared] and leaves the engine there. Takes about twice [duration].
  Future<LoopbackResult> loopbackTest({
    Duration duration = const Duration(milliseconds: 1500),
    bool playBack = true,
  }) {
    if (_loopbackRunning) {
      return Future.error(const AgentAudioException(AgentAudioErrorCode.invalidState, 'Loopback test already running'));
    }
    return _lifecycle(AudioOp.loopback, () async {
      _loopbackRunning = true;
      try {
        final raw = await _invoke<Map<Object?, Object?>>('loopbackTest', {
          'durationMs': duration.inMilliseconds,
          'playBack': playBack,
        });
        final levels = raw?['levels'];
        return LoopbackResult.analyze(
          levels is List ? [for (final l in levels) if (l is num) l.toDouble()] : const [],
          playedBack: raw?['playedBack'] == true,
        );
      } finally {
        _loopbackRunning = false;
      }
    });
  }

  /// iOS: whether calls go through CallKit (lock-screen controls, system call UI). Default
  /// true. Pass false where CallKit is not allowed (apps distributed in mainland China);
  /// the plugin then activates the audio session itself. Takes effect for the next call.
  /// Android: no-op.
  Future<void> configureCallSystem({required bool useCallKit}) =>
      _invoke<void>('configureCallSystem', {'useCallKit': useCallKit});

  /// Reports an outgoing call to the system at `reserved`. iOS: CallKit
  /// `CXStartCallAction` + `reportOutgoingCall(startedConnectingAt:)`, kept out of Recents,
  /// no hold, grouping or DTMF. [callId] is the attempt id (a UUID is used as CallKit's
  /// UUID as-is). Throws [AgentAudioErrorCode.callSystem] if CallKit refuses the call (for
  /// example a cellular call is active). Android: no-op (the on-duty notification shows the
  /// call; see [updateOnDutyService]).
  Future<void> startCall({required String callId, required String displayName, required String handle}) {
    _requireId(callId);
    return _invoke<void>('startCall', {'callId': callId, 'displayName': displayName, 'handle': handle});
  }

  /// iOS: `reportOutgoingCall(connectedAt:)` at `bridged`. Android: no-op.
  Future<void> reportConnected(String callId) {
    _requireId(callId);
    return _invoke<void>('reportConnected', {'callId': callId});
  }

  /// iOS: ends the CallKit call ([CallEndReason.local] requests a `CXEndCallAction`, other
  /// reasons report the end to CallKit). Unknown ids are ignored. Android: no-op.
  Future<void> endCall(String callId, {CallEndReason reason = CallEndReason.local}) {
    _requireId(callId);
    return _invoke<void>('endCall', {'callId': callId, 'reason': reason.name});
  }

  /// Android: starts the on-duty foreground service (type `microphone`) with [notification].
  /// Call at "Go on duty" while the app is on screen: Android 14 refuses to start a
  /// microphone service from the background ([AgentAudioErrorCode.notInForeground]), and
  /// it needs RECORD_AUDIO granted ([AgentAudioErrorCode.permissionDenied]). The app asks
  /// for POST_NOTIFICATIONS first; without it the service still runs but its notification
  /// is hidden. iOS: no-op.
  Future<void> startOnDutyService(OnDutyNotification notification) =>
      _invoke<void>('startOnDutyService', notification.toMap());

  /// Android: replaces the notification's content (e.g. the call started, mute changed).
  /// iOS: no-op.
  Future<void> updateOnDutyService(OnDutyNotification notification) =>
      _invoke<void>('updateOnDutyService', notification.toMap());

  /// Android: stops the service and removes its notification. iOS: no-op.
  Future<void> stopOnDutyService() => _invoke<void>('stopOnDutyService');

  /// Android: whether the app is exempt from battery optimisation. iOS: always true.
  Future<bool> isIgnoringBatteryOptimizations() async =>
      await _invoke<bool>('isIgnoringBatteryOptimizations') ?? true;

  /// Android: opens the system prompt to exempt the app from battery optimisation and
  /// returns whether it could be shown. Re-check [isIgnoringBatteryOptimizations] when the
  /// app resumes. iOS: returns true without doing anything.
  Future<bool> requestIgnoreBatteryOptimizations() async =>
      await _invoke<bool>('requestIgnoreBatteryOptimizations') ?? true;

  /// Detaches from the platform channels. For tests and hot restart; the app keeps one
  /// instance for its lifetime.
  Future<void> dispose() async {
    if (_disposed) return;
    _disposed = true;
    _messenger.setMessageHandler(AgentAudioChannels.uplink, null);
    await _uplink.close();
  }

  Future<ByteData?> _onUplink(ByteData? data) async {
    if (data != null && data.lengthInBytes > 0 && !_uplink.isClosed) {
      // A view over the message buffer the engine handed us; no copy.
      _uplink.add(data.buffer.asUint8List(data.offsetInBytes, data.lengthInBytes));
    }
    return null;
  }

  /// Runs a lifecycle call after the previous ones, validating and then recording the phase
  /// transition.
  Future<T> _lifecycle<T>(AudioOp op, Future<T> Function() body) => _queued(() async {
        final to = _phase.after(op);
        final result = await body();
        _phase = to;
        return result;
      });

  /// Runs [body] after every call queued before it; a failure does not block later calls.
  Future<T> _queued<T>(Future<T> Function() body) {
    final next = _tail.then((_) => body());
    _tail = next.then<void>((_) {}, onError: (Object _) {});
    return next;
  }

  Future<T?> _invoke<T>(String method, [Map<String, Object?>? args]) async {
    try {
      return await _methods.invokeMethod<T>(method, args);
    } on PlatformException catch (e) {
      throw AgentAudioException.fromPlatform(e);
    } on MissingPluginException {
      throw AgentAudioException(AgentAudioErrorCode.unsupported, 'agent_audio is not available ($method)');
    }
  }

  static void _requireId(String callId) {
    if (callId.isEmpty) throw ArgumentError.value(callId, 'callId', 'must not be empty');
  }
}
