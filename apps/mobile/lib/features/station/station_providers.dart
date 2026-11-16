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

/// Live call listening's flag (`packages/contracts/src/flags.ts`, client-exposed): the account
/// allows supervisors to listen in (docs/listening.md LS1). The app reads it for the station's
/// standing line only (LS2); nothing here listens, and no wire type changes.
const liveListenFlagKey = 'agency_live_listen_enabled';

/// Whether the station tells the agent that a supervisor may listen: the info button in its
/// header and the line in the sheet it opens. Off while the flag map loads or failed.
final stationListenNoticeProvider = Provider<bool>((ref) => ref.watch(featureFlagProvider(liveListenFlagKey)));
