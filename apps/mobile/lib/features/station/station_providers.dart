import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:permission_handler/permission_handler.dart' as ph;

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
