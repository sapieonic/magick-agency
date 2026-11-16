import 'package:agency_wire/agency_wire.dart' show FeatureFlags;
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:permission_handler/permission_handler.dart' as ph;

import '../../core/flags/feature_flags.dart';

/// The clock the station screens read. [StationView] times are already mapped
/// onto this device's clock by the core, so the real thing is `DateTime.now`;
/// tests override it with a fixed or stepping clock.
final stationClockProvider = Provider<DateTime Function()>((ref) => DateTime.now);

/// Opens this app's page in the phone's Settings (the microphone banner's
/// remedy). A provider so widget tests do not reach a platform channel.
final stationOpenSettingsProvider = Provider<Future<void> Function()>(
  (ref) => () async {
    await ph.openAppSettings();
  },
);

/// Whether the station tells the agent that a supervisor may listen: the info button in its
/// header and the line in the sheet it opens. Behind live call listening's client flag
/// ([FeatureFlags.liveListenEnabled], docs/listening.md LS1, LS2); nothing here listens. Off
/// while the flag map loads or failed.
final stationListenNoticeProvider = Provider<bool>(
  (ref) => ref.watch(featureFlagProvider(FeatureFlags.liveListenEnabled)),
);
