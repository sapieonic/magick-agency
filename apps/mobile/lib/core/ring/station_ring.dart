import 'package:agency_wire/agency_wire.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'ring_channel.dart';
import 'ring_rules.dart' show RingBlocker;

/// What the station core needs of Mode B, behind one seam so the station is tested with a fake
/// and runs unchanged where nothing rings (the default: [StationRing.none]). The ring layer
/// overrides it (`ringOverrides`). Only what adds logic over the ring channel is here; the rest the
/// station tells native, or reads from it, on the [channel] itself.
abstract interface class StationRing {
  /// Leaving the app asks `away_ring` rather than `device_away` ([ringAvailable]).
  bool get ringOn;

  /// Why leaving the app will not ring this phone though the agent turned ringing on for it
  /// ([RingSettings.fallbackBlocker]); null when it rings, or was not expected to.
  RingBlocker? get fallbackBlocker;

  /// The device's status read again, for why the server ended `away_ring` (null when unknown).
  Future<PushDeviceStatus?> readStatus();

  /// The ring channel: native's events and everything the station tells it.
  RingChannel get channel;

  static const StationRing none = _NoRing();
}

final class _NoRing implements StationRing {
  const _NoRing();

  @override
  bool get ringOn => false;

  @override
  RingBlocker? get fallbackBlocker => null;

  @override
  Future<PushDeviceStatus?> readStatus() async => null;

  @override
  RingChannel get channel => RingChannel.none;
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
