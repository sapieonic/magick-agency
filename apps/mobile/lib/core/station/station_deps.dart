import 'package:agency_wire/agency_wire.dart' show StationFrame;
import 'package:agent_audio/agent_audio.dart';
import 'package:connectivity_plus/connectivity_plus.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../audio/audio_engine.dart';
import '../auth/app_gate.dart';
import '../lifecycle/app_lifecycle.dart';
import 'notes_autosave.dart';
import 'station_transport.dart';

/// The station core's outside world, one provider each, so tests swap any of
/// them for a fake. `main.dart` needs none of these: the defaults are the real ones.

final stationConnectorProvider = Provider<StationConnector>((ref) => const IoStationConnector());

/// The OS network monitor: the current state first, then every change.
abstract interface class NetworkMonitor {
  Stream<List<ConnectivityResult>> changes();
}

final class ConnectivityNetworkMonitor implements NetworkMonitor {
  ConnectivityNetworkMonitor([Connectivity? connectivity]) : _connectivity = connectivity ?? Connectivity();

  final Connectivity _connectivity;

  @override
  Stream<List<ConnectivityResult>> changes() async* {
    try {
      yield await _connectivity.checkConnectivity();
    } catch (_) {
      // No baseline: the first change becomes it.
    }
    yield* _connectivity.onConnectivityChanged;
  }
}

final networkMonitorProvider = Provider<NetworkMonitor>((ref) => ConnectivityNetworkMonitor());

final notesStoreProvider = Provider<NotesStore>((ref) => SecureNotesStore());

final stationNotifierProvider = Provider<StationNotifier>((ref) => LocalStationNotifier());

final wakeLockProvider = Provider<WakeLock>((ref) => const WakelockPlusLock());

final appLifecycleSourceProvider = Provider<AppLifecycleSource>((ref) => FlutterAppLifecycleSource());

/// The one voice engine for the process (the plugin keeps native state).
final audioEngineProvider = Provider<AudioEngine>((ref) {
  final plugin = AgentAudio();
  ref.onDispose(plugin.dispose);
  return PluginAudioEngine(plugin);
});

/// The present, injectable so timing rules are tested on a fake clock.
final stationNowProvider = Provider<DateTime Function()>((ref) => DateTime.now);

/// The text-frame decoder. Injectable so a test can count calls and prove the
/// binary media path never reaches it.
final stationFrameDecoderProvider = Provider<StationFrame Function(String)>((ref) => StationFrame.decode);

/// Where the station reports a sign-in that has expired: the app gate, which
/// signs out only once no call or wrap-up is live.
final stationUnauthorizedSinkProvider = Provider<void Function(Object error)>(
  (ref) => (error) => ref.read(appGateProvider.notifier).reportError(error),
);
