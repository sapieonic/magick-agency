import 'dart:async';

import 'package:agency_wire/agency_wire.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'ring_channel.dart';

/// What the station core needs of Mode B, behind one seam so the station is tested with a fake
/// and runs unchanged where nothing rings (the default: [StationRing.none]). The ring layer
/// overrides it (`ringOverrides`).
abstract interface class StationRing {
  /// Leaving the app asks `away_ring` rather than `device_away` ([ringAvailable]).
  bool get ringOn;

  /// What native tells Dart (the station counts the misses while away).
  Stream<RingEvent> get events;

  /// The ongoing "Away · inbound calls ring this phone" notification.
  void showAwayNotification(bool on);

  /// A push offer's audio bound on the station.
  void reportBound(String callId);

  /// A push offer left the station, or its call ended.
  void reportEnded(String callId, RingEndReason reason);

  /// The device's status read again, for why the server ended `away_ring` (null when unknown).
  Future<PushDeviceStatus?> readStatus();

  static const StationRing none = _NoRing();
}

final class _NoRing implements StationRing {
  const _NoRing();

  @override
  bool get ringOn => false;

  @override
  Stream<RingEvent> get events => const Stream<RingEvent>.empty();

  @override
  void showAwayNotification(bool on) {}

  @override
  void reportBound(String callId) {}

  @override
  void reportEnded(String callId, RingEndReason reason) {}

  @override
  Future<PushDeviceStatus?> readStatus() async => null;
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
