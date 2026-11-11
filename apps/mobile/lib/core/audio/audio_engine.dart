import 'dart:typed_data';

import 'package:agent_audio/agent_audio.dart';

/// The native voice engine as the station core uses it: a facade over
/// `agent_audio` so the orchestration is tested against a fake
/// (`FakeAudioEngine`, in `test/core/audio/fake_audio_engine.dart`) and the
/// plugin stays the only thing that touches platform channels.
abstract interface class AudioEngine {
  /// Encoded 20 ms uplink frames while streaming, ready to send as they are.
  Stream<Uint8List> get uplink;

  /// Routes, interruptions, errors and system call actions.
  Stream<AudioEvent> get events;

  Future<void> prepare(AgentAudioFormat format);
  Future<void> armMicrophone();
  Future<void> startUplink();
  Future<void> stop({bool keepWarm = true});
  Future<void> release();

  /// One downlink frame. Hot path: no awaiting, no copying here.
  void playFrame(Uint8List frame);

  Future<void> setMuted(bool muted);
  Future<void> setRoute(AudioRoute route);

  /// The ringback tone while a soft-phone call rings (generated on the device,
  /// mixed into playout). [stop] clears it.
  Future<void> setRingback(bool on);

  /// The inbound chime, once (an inbound caller was offered), mixed into playout. [stop]
  /// drops one not yet played.
  Future<void> playChime();

  Future<void> startCall({required String callId, required String displayName, required String handle});
  Future<void> reportConnected(String callId);
  Future<void> endCall(String callId, {CallEndReason reason = CallEndReason.local});

  Future<void> startOnDutyService(OnDutyNotification notification);
  Future<void> updateOnDutyService(OnDutyNotification notification);
  Future<void> stopOnDutyService();

  /// [PhoneCallChanged] events on [events]: a phone call not the app's own (a
  /// cellular call) started or ended. On reports the state at once.
  Future<void> setPhoneCallMonitoring(bool enabled);
}

/// The real engine: the `agent_audio` plugin.
final class PluginAudioEngine implements AudioEngine {
  PluginAudioEngine(this._audio);

  final AgentAudio _audio;

  @override
  Stream<Uint8List> get uplink => _audio.uplink;

  @override
  Stream<AudioEvent> get events => _audio.events;

  @override
  Future<void> prepare(AgentAudioFormat format) => _audio.prepare(format: format);

  @override
  Future<void> armMicrophone() => _audio.armMicrophone();

  @override
  Future<void> startUplink() => _audio.startUplink();

  @override
  Future<void> stop({bool keepWarm = true}) => _audio.stop(keepWarm: keepWarm);

  @override
  Future<void> release() => _audio.release();

  @override
  void playFrame(Uint8List frame) => _audio.playFrame(frame);

  @override
  Future<void> setMuted(bool muted) => _audio.setMuted(muted);

  @override
  Future<void> setRoute(AudioRoute route) => _audio.setRoute(route);

  @override
  Future<void> setRingback(bool on) => _audio.setRingback(on);

  @override
  Future<void> playChime() => _audio.playChime();

  @override
  Future<void> startCall({required String callId, required String displayName, required String handle}) =>
      _audio.startCall(callId: callId, displayName: displayName, handle: handle);

  @override
  Future<void> reportConnected(String callId) => _audio.reportConnected(callId);

  @override
  Future<void> endCall(String callId, {CallEndReason reason = CallEndReason.local}) =>
      _audio.endCall(callId, reason: reason);

  @override
  Future<void> startOnDutyService(OnDutyNotification notification) => _audio.startOnDutyService(notification);

  @override
  Future<void> updateOnDutyService(OnDutyNotification notification) => _audio.updateOnDutyService(notification);

  @override
  Future<void> stopOnDutyService() => _audio.stopOnDutyService();

  @override
  Future<void> setPhoneCallMonitoring(bool enabled) => _audio.setPhoneCallMonitoring(enabled);
}
