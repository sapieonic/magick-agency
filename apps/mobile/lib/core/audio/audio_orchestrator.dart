import 'dart:async';
import 'dart:typed_data';

import 'package:agent_audio/agent_audio.dart' as audio;
import 'package:meta/meta.dart';

import '../station/station_view.dart';
import '../telemetry/log.dart';
import 'audio_engine.dart';

/// What the audio should be doing, derived from the station state.
@immutable
final class AudioTarget {
  const AudioTarget({this.attemptId, this.bridged = false, this.displayName = '', this.handle = '', this.endReason});

  static const idle = AudioTarget();

  /// The live attempt (reserved or on a call), or null between calls.
  final String? attemptId;
  final bool bridged;

  /// For CallKit: the contact's name, or the number.
  final String displayName;
  final String handle;

  /// How the PREVIOUS call ended, for CallKit's record of it.
  final audio.CallEndReason? endReason;
}

/// Drives the voice engine from the agent's state (the audio half of the
/// station core):
///
/// | station                   | engine                                         |
/// |---------------------------|------------------------------------------------|
/// | station opens, available  | `prepare` (pre-warm, so late binding's 1 s holds) |
/// | `reserved`                | CallKit `startCall`, then `armMicrophone`      |
/// | `bridged`                 | `startUplink`, CallKit `reportConnected`       |
/// | `released`                | CallKit `endCall`, then `stop` (kept warm)     |
/// | leave                     | `release`, stop the on-duty service            |
///
/// Lifecycle calls run strictly in order on one queue; [sync] records the
/// target at once, so back-to-back frames (`released` → `reserved`) queue
/// the right transitions without waiting for each other.
///
/// Media: uplink frames go straight from the engine's stream to [sendUplink]
/// and downlink bytes straight to [playFrame], with nothing in between.
class AudioOrchestrator {
  AudioOrchestrator({
    required this._engine,
    required this._sendUplink,
    required this._onChanged,
    required this._onSystemHangUp,
    this.format = audio.AgentAudioFormat.alaw8,
  });

  static final _log = Log('station.audio');

  final AudioEngine _engine;
  final void Function(Uint8List) _sendUplink;
  final void Function() _onChanged;
  final void Function() _onSystemHangUp;
  final audio.AgentAudioFormat format;

  StreamSubscription<Uint8List>? _uplinkSub;
  StreamSubscription<audio.AudioEvent>? _eventsSub;
  Future<void> _tail = Future<void>.value();
  String? _callId;
  bool _bridged = false;
  /// A `prepare` is queued or done (cleared when one fails).
  bool _prepared = false;
  bool _opened = false;
  bool _autoMuted = false;
  bool _guardSpeaker = false;

  /// The on-duty service (Android's foreground service) is running, or a
  /// start is queued. iOS's is a no-op that always succeeds.
  bool _serviceUp = false;
  bool _serviceStarting = false;

  /// What the agent is told while the service is not running: without it
  /// Android takes the microphone away the moment the app leaves the screen.
  MicProblem _serviceProblem = MicProblem.none;
  audio.OnDutyNotification? _notification;
  List<audio.AudioRoute> _routes = const [];
  AudioView _view = const AudioView();

  AudioView get view => _view;

  /// The attempt the engine is set up for, if any.
  String? get callId => _callId;

  /// Completes when every queued lifecycle call has run (tests).
  Future<void> get settled => _tail;

  /// The station opened (the app is on screen): start the on-duty service
  /// first (Android refuses it from the background), then pre-warm.
  void open(audio.OnDutyNotification notification) {
    if (_opened) return;
    _opened = true;
    _uplinkSub = _engine.uplink.listen(_sendUplink);
    _eventsSub = _engine.events.listen(_onEvent);
    _notification = notification;
    _startService();
    prewarm();
  }

  /// The app is back on screen: an on-duty service that could not start
  /// (Android refuses one from the background, or a permission was missing)
  /// is started now. Repeated on every return until it runs.
  void resumed() {
    if (!_opened || _serviceUp || _serviceStarting) return;
    _startService();
  }

  void _startService() {
    _serviceStarting = true;
    _enqueue('fgs.start', () async {
      try {
        final notification = _notification;
        if (!_opened || notification == null) return;
        await _engine.startOnDutyService(notification);
        if (!_opened) return;
        _serviceUp = true;
        final was = _serviceProblem;
        _serviceProblem = MicProblem.none;
        if (was != MicProblem.none && _view.micProblem == was) _setView(_copy(micProblem: MicProblem.none));
      } catch (e) {
        if (_opened) {
          _serviceUp = false;
          final code = e is audio.AgentAudioException ? e.code : audio.AgentAudioErrorCode.unknown;
          final problem = _micProblemFor(code);
          final was = _serviceProblem;
          // No dedicated wording yet: a service that is not running loses the
          // microphone in the background, which "disconnected" describes.
          _serviceProblem = problem == MicProblem.none ? MicProblem.lost : problem;
          if (_view.micProblem == MicProblem.none || _view.micProblem == was) {
            _setView(_copy(micProblem: _serviceProblem));
          }
        }
        rethrow;
      } finally {
        _serviceStarting = false;
      }
    });
  }

  /// The problem shown when nothing call-specific is wrong.
  MicProblem get _baseline => _serviceProblem;

  /// Pre-warms the session between calls (at open and at "Go available").
  void prewarm() {
    if (!_opened || _callId != null) return;
    _prepared = true;
    _enqueue('prepare', () => _engine.prepare(format));
  }

  void sync(AudioTarget target) {
    if (!_opened) return;
    final previous = _callId;
    if (target.attemptId != previous) {
      if (previous != null) {
        final reason = target.endReason ?? audio.CallEndReason.remoteEnded;
        _enqueue('endCall', () => _engine.endCall(previous, reason: reason));
        _enqueue('stop', () => _engine.stop());
        _callId = null;
        _bridged = false;
        _autoMuted = false;
        _setView(AudioView(routes: _view.routes, route: _view.route, micProblem: _persistentMicProblem()));
      }
      final next = target.attemptId;
      if (next != null) {
        _callId = next;
        _bridged = false;
        if (!_prepared) {
          _prepared = true;
          _enqueue('prepare', () => _engine.prepare(format));
        }
        // CallKit first: it activates the audio session the microphone needs.
        _enqueue(
          'startCall',
          () => _engine.startCall(callId: next, displayName: target.displayName, handle: target.handle),
          onError: (e) {
            // CallKit refused (a cellular call is up): audio still arms, and
            // the agent is told why it may be silent.
            if (e.code == audio.AgentAudioErrorCode.callSystem) {
              _setView(_copy(interruption: AudioInterruption.phoneCall));
            }
          },
        );
        _enqueue('arm', () async {
          await _engine.armMicrophone();
          if (_view.micProblem != _baseline) _setView(_copy(micProblem: _baseline));
        });
      }
    }
    if (target.attemptId != null && target.bridged && !_bridged) {
      final id = target.attemptId!;
      _bridged = true;
      _enqueue('uplink', _engine.startUplink);
      _enqueue('connected', () => _engine.reportConnected(id));
    }
  }

  /// Downlink: one frame, straight to the engine.
  void playFrame(Uint8List frame) => _engine.playFrame(frame);

  Future<void> setMuted(bool muted) async {
    _autoMuted = false;
    await _applyMute(muted);
  }

  /// Returns whether the engine took it.
  Future<bool> _applyMute(bool muted) async {
    if (muted == _view.muted) return true;
    _setView(_copy(muted: muted));
    try {
      await _engine.setMuted(muted);
      return true;
    } on audio.AgentAudioException catch (e) {
      _log.warn('mute failed', {'code': e.code.wireName});
      _setView(_copy(muted: !muted));
      return false;
    }
  }

  /// Mutes for a phone call. Marked BEFORE the engine answers, so an
  /// interruption that ends first still unmutes; unmarked if the mute failed
  /// (nothing to undo then).
  Future<void> _autoMute() async {
    _autoMuted = true;
    final ok = await _applyMute(true);
    if (!ok) _autoMuted = false;
  }

  Future<void> setRoute(AudioRouteOption option) async {
    final route = _routes.where((r) => r.id == option.id).firstOrNull;
    if (route == null) return;
    try {
      await _engine.setRoute(route);
    } on audio.AgentAudioException catch (e) {
      _log.warn('route change failed', {'code': e.code.wireName});
    }
  }

  /// Replaces the on-duty notification's text (Android); equal ones are skipped.
  void updateNotification(audio.OnDutyNotification notification) {
    if (!_opened || notification == _notification) return;
    _notification = notification;
    _enqueue('fgs.update', () => _engine.updateOnDutyService(notification));
  }

  /// Off duty: end any call, release the session, stop the on-duty service.
  Future<void> close() async {
    if (!_opened) return;
    final call = _callId;
    if (call != null) _enqueue('endCall', () => _engine.endCall(call));
    _enqueue('release', _engine.release);
    _enqueue('fgs.stop', _engine.stopOnDutyService);
    _callId = null;
    _opened = false;
    _prepared = false;
    _serviceUp = false;
    _serviceProblem = MicProblem.none;
    // Not awaited: a broadcast subscription's cancel future may belong to
    // another zone, and nothing here depends on it.
    unawaited(_uplinkSub?.cancel());
    unawaited(_eventsSub?.cancel());
    _uplinkSub = null;
    _eventsSub = null;
    await _tail;
  }

  // ─── Events ─────────────────────────────────────────────────────────────

  void _onEvent(audio.AudioEvent event) {
    switch (event) {
      case audio.AudioRouteChanged(:final current, :final available):
        _routes = available;
        if (_guardSpeaker && current?.kind == audio.AudioRouteKind.speaker) {
          // A headset went: never let the call jump to the loudspeaker silently.
          final earpiece = available.where((r) => r.kind == audio.AudioRouteKind.earpiece).firstOrNull;
          if (earpiece != null) _enqueue('route', () => _engine.setRoute(earpiece));
        }
        _guardSpeaker = false;
        final options = available.map(_option).toList(growable: false);
        _setView(_copy(
          route: current == null ? null : _option(current),
          clearRoute: current == null,
          // The same list instance while the routes are the same: widgets select on it.
          routes: _sameRoutes(options, _view.routes) ? _view.routes : List.unmodifiable(options),
        ));
      case audio.AudioBecomingNoisy():
        _guardSpeaker = true;
      case audio.AudioInterruptionBegan(:final reason):
        final kind = reason == audio.InterruptionReason.phoneCall ? AudioInterruption.phoneCall : AudioInterruption.otherApp;
        _setView(_copy(interruption: kind));
        if (kind == AudioInterruption.phoneCall && _callId != null && !_view.muted) {
          // The customer must not hear the agent's other call.
          unawaited(_autoMute());
        }
      case audio.AudioInterruptionEnded():
        _setView(_copy(interruption: AudioInterruption.none));
        if (_autoMuted) {
          _autoMuted = false;
          unawaited(setMuted(false));
        }
      case audio.AudioErrorEvent(:final code, :final recovered):
        _log.warn('audio error', {'code': code.wireName, 'recovered': recovered});
        if (!recovered) {
          final problem = _micProblemFor(code);
          if (problem != MicProblem.none) _setView(_copy(micProblem: problem));
        } else if (_view.micProblem == MicProblem.lost) {
          _setView(_copy(micProblem: _baseline));
        }
      case audio.CallSystemAction(kind: audio.CallActionKind.end, :final callId):
        if (callId == null || callId == _callId) _onSystemHangUp();
      case audio.CallSystemAction(kind: audio.CallActionKind.mute, :final muted):
        // The plugin already applied it to the uplink; mirror it.
        _autoMuted = false;
        _setView(_copy(muted: muted ?? !_view.muted));
      case audio.CallSystemReset():
        if (_callId != null) _onSystemHangUp();
      case audio.AudioSessionActivation() || audio.InputLevel() || audio.JitterStats():
        break;
    }
  }

  // ─── Plumbing ───────────────────────────────────────────────────────────

  void _enqueue(String name, Future<void> Function() op, {void Function(audio.AgentAudioException e)? onError}) {
    _tail = _tail.then((_) async {
      try {
        await op();
      } on audio.AgentAudioException catch (e) {
        _log.warn('audio $name failed', {'code': e.code.wireName});
        if (name == 'arm' || name == 'prepare' || name == 'uplink') {
          final problem = _micProblemFor(e.code);
          if (problem != MicProblem.none) _setView(_copy(micProblem: problem));
        }
        if (name == 'prepare') _prepared = false;
        onError?.call(e);
      } catch (e) {
        _log.warn('audio $name failed', {'error': e.runtimeType.toString()});
      }
    });
  }

  static bool _sameRoutes(List<AudioRouteOption> a, List<AudioRouteOption> b) {
    if (a.length != b.length) return false;
    for (var i = 0; i < a.length; i++) {
      if (a[i] != b[i]) return false;
    }
    return true;
  }

  static MicProblem _micProblemFor(audio.AgentAudioErrorCode code) => switch (code) {
        audio.AgentAudioErrorCode.permissionDenied => MicProblem.permissionDenied,
        audio.AgentAudioErrorCode.deviceBusy => MicProblem.busy,
        audio.AgentAudioErrorCode.lost => MicProblem.lost,
        audio.AgentAudioErrorCode.unsupported => MicProblem.noDevice,
        _ => MicProblem.none,
      };

  /// A denied permission outlives the call; a busy or lost device does not.
  MicProblem _persistentMicProblem() =>
      _view.micProblem == MicProblem.permissionDenied ? MicProblem.permissionDenied : _baseline;

  static AudioRouteOption _option(audio.AudioRoute r) => AudioRouteOption(
        id: r.id,
        kind: switch (r.kind) {
          audio.AudioRouteKind.earpiece => AudioRouteKind.earpiece,
          audio.AudioRouteKind.speaker => AudioRouteKind.speaker,
          audio.AudioRouteKind.wired => AudioRouteKind.wired,
          audio.AudioRouteKind.bluetooth => AudioRouteKind.bluetooth,
        },
        name: switch (r.kind) {
          audio.AudioRouteKind.earpiece => 'Phone',
          audio.AudioRouteKind.speaker => 'Speaker',
          audio.AudioRouteKind.wired => r.name.isEmpty ? 'Headphones' : r.name,
          audio.AudioRouteKind.bluetooth => r.name.isEmpty ? 'Bluetooth' : r.name,
        },
      );

  AudioView _copy({
    bool? muted,
    AudioRouteOption? route,
    bool clearRoute = false,
    List<AudioRouteOption>? routes,
    MicProblem? micProblem,
    AudioInterruption? interruption,
  }) =>
      AudioView(
        muted: muted ?? _view.muted,
        route: clearRoute ? null : (route ?? _view.route),
        routes: routes ?? _view.routes,
        micProblem: micProblem ?? _view.micProblem,
        interruption: interruption ?? _view.interruption,
      );

  void _setView(AudioView next) {
    if (next == _view) return;
    _view = next;
    _onChanged();
  }
}
