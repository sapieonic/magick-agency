import 'dart:async';

import 'package:agent_audio/agent_audio.dart';
import 'package:flutter/foundation.dart';

import 'audio_engine.dart';

/// An [AudioEngine] that records what it was asked to do, for tests of the
/// station core and of screens that need a station. Lifecycle calls are
/// logged by name (`prepare`, `startCall`, `arm`, `uplink`, `connected`,
/// `endCall`, `stop`, `release`, `fgs.start` …); [fail] makes the next call
/// of a name throw.
@visibleForTesting
class FakeAudioEngine implements AudioEngine {
  final List<String> calls = [];
  final Map<String, AgentAudioException> fail = {};
  final StreamController<Uint8List> uplinkController = StreamController<Uint8List>.broadcast(sync: true);
  final StreamController<AudioEvent> eventsController = StreamController<AudioEvent>.broadcast(sync: true);

  /// Downlink frames handed to [playFrame]: counted, and the last one kept so
  /// a test can check it is the very buffer the socket delivered.
  int playedFrames = 0;
  Uint8List? lastPlayed;
  bool muted = false;
  OnDutyNotification? notification;
  final List<({String callId, String displayName, String handle})> startedCalls = [];
  final List<({String callId, CallEndReason reason})> endedCalls = [];

  Future<void> _record(String name) async {
    calls.add(name);
    final error = fail.remove(name);
    if (error != null) throw error;
  }

  /// Sends one uplink frame, as the native side would while streaming.
  void emitUplink(Uint8List frame) => uplinkController.add(frame);

  void emitEvent(AudioEvent event) => eventsController.add(event);

  @override
  Stream<Uint8List> get uplink => uplinkController.stream;

  @override
  Stream<AudioEvent> get events => eventsController.stream;

  @override
  Future<void> prepare(AgentAudioFormat format) => _record('prepare');

  @override
  Future<void> armMicrophone() => _record('arm');

  @override
  Future<void> startUplink() => _record('uplink');

  @override
  Future<void> stop({bool keepWarm = true}) {
    muted = false;
    return _record(keepWarm ? 'stop' : 'release');
  }

  @override
  Future<void> release() => stop(keepWarm: false);

  @override
  void playFrame(Uint8List frame) {
    playedFrames++;
    lastPlayed = frame;
  }

  @override
  Future<void> setMuted(bool muted) {
    this.muted = muted;
    return _record(muted ? 'mute' : 'unmute');
  }

  @override
  Future<void> setRoute(AudioRoute route) => _record('route:${route.id}');

  @override
  Future<void> startCall({required String callId, required String displayName, required String handle}) {
    startedCalls.add((callId: callId, displayName: displayName, handle: handle));
    return _record('startCall');
  }

  @override
  Future<void> reportConnected(String callId) => _record('connected');

  @override
  Future<void> endCall(String callId, {CallEndReason reason = CallEndReason.local}) {
    endedCalls.add((callId: callId, reason: reason));
    return _record('endCall');
  }

  @override
  Future<void> startOnDutyService(OnDutyNotification notification) {
    this.notification = notification;
    return _record('fgs.start');
  }

  @override
  Future<void> updateOnDutyService(OnDutyNotification notification) {
    this.notification = notification;
    return _record('fgs.update');
  }

  @override
  Future<void> stopOnDutyService() {
    notification = null;
    return _record('fgs.stop');
  }

  /// The lifecycle calls only (no notification updates or mute), in order.
  List<String> get lifecycle => calls.where((c) => !c.startsWith('fgs.update') && c != 'mute' && c != 'unmute').toList();
}
