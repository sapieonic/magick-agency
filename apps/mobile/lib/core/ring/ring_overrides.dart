import 'package:agency_wire/agency_wire.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/misc.dart' show Override;

import '../auth/app_gate.dart' show pushDeviceTeardownProvider;
import 'ring_answer_coordinator.dart';
import 'ring_channel.dart';
import 'ring_registration.dart';
import 'ring_rules.dart' show RingBlocker;
import 'station_ring.dart';

/// Starts Mode B's services for the app's life: the push device's registration and the ring
/// answer coordinator. The root widget watches it; the default (tests, a build without Mode B)
/// starts nothing.
final ringServicesProvider = Provider<void>((ref) {});

/// What the Me card reads: this phone's ringing settings, or null where Mode B is not plugged
/// in (the card is not shown).
final ringSettingsProvider = Provider<RingSettings?>((ref) => null);

/// What `main.dart` adds to its `ProviderScope` overrides to plug Mode B in: the station's
/// seam ([stationRingProvider]), the push device's removal on sign-out
/// ([pushDeviceTeardownProvider]) and the services ([ringServicesProvider]).
final List<Override> ringOverrides = [
  stationRingProvider.overrideWith(_RegistrationStationRing.new),
  pushDeviceTeardownProvider.overrideWith(
    (ref) => () => ref.read(ringRegistrationProvider.notifier).unregister(),
  ),
  ringSettingsProvider.overrideWith((ref) => ref.watch(ringRegistrationProvider)),
  ringServicesProvider.overrideWith((ref) {
    // Listened to, not watched: they live as long as the app, and their changes rebuild nothing.
    ref.listen(ringRegistrationProvider, (_, _) {});
    ref.listen(ringAnswerCoordinatorProvider, (_, _) {});
  }),
];

final class _RegistrationStationRing implements StationRing {
  _RegistrationStationRing(this._ref);

  final Ref _ref;

  @override
  bool get ringOn => _ref.read(ringRegistrationProvider).ringOn;

  @override
  RingBlocker? get fallbackBlocker => _ref.read(ringRegistrationProvider).fallbackBlocker;

  @override
  Future<PushDeviceStatus?> readStatus() => _ref.read(ringRegistrationProvider.notifier).readStatus();

  @override
  RingChannel get channel => _ref.read(ringChannelProvider);
}
