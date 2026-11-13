import 'dart:async';

import 'package:agency_wire/agency_wire.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'ring_channel.dart';
import 'ring_rules.dart' show RingBlocker;

/// What the station core needs of Mode B, behind one seam so the station is tested with a fake
/// and runs unchanged where nothing rings (the default: [StationRing.none]). The ring layer
/// overrides it (`ringOverrides`).
abstract interface class StationRing {
  /// Leaving the app asks `away_ring` rather than `device_away` ([ringAvailable]).
  bool get ringOn;

  /// Why leaving the app will not ring this phone though the agent turned ringing on for it
  /// ([RingSettings.fallbackBlocker]); null when it rings, or was not expected to.
  RingBlocker? get fallbackBlocker;

  /// What native tells Dart (the station counts the misses while away).
  Stream<RingEvent> get events;

  /// The ongoing "Away · this phone rings for inbound calls" notification, for the absence that
  /// began at [since] (server clock) in [sessionId]: native drops a `ring_off` for an earlier one.
  void showAwayNotification(bool on, {DateTime? since, String? sessionId});

  /// A push offer's audio bound on the station.
  void reportBound(String callId);

  /// A push offer left the station, or its call ended.
  void reportEnded(String callId, RingEndReason reason);

  /// A call answered from a ring is on the station ([on]) until its outcome is saved or it leaves:
  /// the app stays over the lock screen meanwhile ([RingChannel.holdOverLockScreen]).
  void holdOverLockScreen(bool on);

  /// The device's status read again, for why the server ended `away_ring` (null when unknown).
  Future<PushDeviceStatus?> readStatus();

  /// The `ring_off` native took while away ([RingChannel.takeRingOff]), once.
  Future<RingOffRecord?> takeRingOff();

  /// The away notification's "Stop ringing" not yet cleared ([RingChannel.peekStopRinging]), left in place.
  Future<RingStopRequest?> peekStopRinging();

  /// "Stop ringing" is done with: `device_away` applied ([RingChannel.clearStopRinging]).
  void clearStopRinging();

  /// The server clock offset the station measured, for native to time a ring on the server's
  /// clock ([RingChannel.setServerClock]).
  void setServerClock({required int offsetMs, required DateTime measuredAt});

  /// The app's task to the back ([RingChannel.moveTaskToBack]).
  void moveTaskToBack();

  static const StationRing none = _NoRing();
}

final class _NoRing implements StationRing {
  const _NoRing();

  @override
  bool get ringOn => false;

  @override
  RingBlocker? get fallbackBlocker => null;

  @override
  Stream<RingEvent> get events => const Stream<RingEvent>.empty();

  @override
  void showAwayNotification(bool on, {DateTime? since, String? sessionId}) {}

  @override
  void reportBound(String callId) {}

  @override
  void reportEnded(String callId, RingEndReason reason) {}

  @override
  void holdOverLockScreen(bool on) {}

  @override
  Future<PushDeviceStatus?> readStatus() async => null;

  @override
  Future<RingOffRecord?> takeRingOff() async => null;

  @override
  Future<RingStopRequest?> peekStopRinging() async => null;

  @override
  void clearStopRinging() {}

  @override
  void setServerClock({required int offsetMs, required DateTime measuredAt}) {}

  @override
  void moveTaskToBack() {}
}

final stationRingProvider = Provider<StationRing>((ref) => StationRing.none);

/// Something Mode B has to tell the agent wherever they are in the app: why their phone stopped
/// ringing for inbound calls, or that a call they answered from a ring is gone. Shown by the
/// shell until dismissed or replaced.
class RingNotice extends Notifier<String?> {
  @override
  String? build() => null;

  void show(String text) => state = text;
  void dismiss() => state = null;
}

final ringNoticeProvider = NotifierProvider<RingNotice, String?>(RingNotice.new);
