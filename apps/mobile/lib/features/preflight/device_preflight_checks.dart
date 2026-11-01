import 'dart:io' show Platform;
import 'dart:typed_data';

import 'package:agent_audio/agent_audio.dart';
import 'package:battery_plus/battery_plus.dart';
import 'package:connectivity_plus/connectivity_plus.dart';
import 'package:permission_handler/permission_handler.dart' as ph;

import '../../core/api/api_client.dart';
import '../../core/api/api_error.dart';
import '../../core/telemetry/log.dart';
import 'preflight_checks.dart';

/// The phone's answers to the pre-flight checks: `permission_handler` for the
/// microphone, the voice engine's loopback and route, `connectivity_plus` plus a
/// timed round trip and upload to the API, and `battery_plus`.
///
/// Facts only; grading is `preflight_checks.dart`'s. Every method settles on its own
/// (failures become the "could not tell" sample, never an exception), so one stuck
/// sensor cannot hold up the other rows.
class DevicePreflightChecks implements PreflightChecks {
  DevicePreflightChecks({
    required this._audio,
    required this._api,
    Connectivity? connectivity,
    Battery? battery,
    bool? isAndroid,
  })  : _connectivity = connectivity ?? Connectivity(),
        _battery = battery ?? Battery(),
        _isAndroid = isAndroid ?? Platform.isAndroid;

  final AgentAudio _audio;
  final ApiClient _api;
  final Connectivity _connectivity;
  final Battery _battery;
  final bool _isAndroid;

  static final _log = Log('preflight');

  /// The upload probe's size: big enough that the transfer, not the round trip,
  /// dominates on a 4G uplink, small enough to cost nothing on a metered plan.
  static const probeBytes = 32 * 1024;

  /// Speech quieter than this (dBFS, after voice processing) reads as "barely heard":
  /// voice processing puts a normal voice at about −35…−20.
  static const quietSpeechDbfs = -35.0;

  static MicPermission _mic(ph.PermissionStatus s) => switch (s) {
        ph.PermissionStatus.granted || ph.PermissionStatus.limited || ph.PermissionStatus.provisional =>
          MicPermission.granted,
        ph.PermissionStatus.permanentlyDenied => MicPermission.permanentlyDenied,
        ph.PermissionStatus.restricted => MicPermission.restricted,
        ph.PermissionStatus.denied => MicPermission.denied,
      };

  @override
  Future<MicPermission> microphone() async => _mic(await ph.Permission.microphone.status);

  @override
  Future<MicPermission> requestMicrophone() async => _mic(await ph.Permission.microphone.request());

  @override
  Future<SoundCheckSample> soundCheck() async {
    try {
      if (!await ph.Permission.microphone.isGranted) return const SoundCheckSample(ran: false);
      // Only on an engine nobody is using: a station that is already armed or on a
      // call owns the microphone, and the loopback must not touch it.
      final phase = _audio.phase;
      if (phase != AgentAudioPhase.idle && phase != AgentAudioPhase.prepared) return const SoundCheckSample(ran: false);
      final warmedHere = phase == AgentAudioPhase.idle;
      if (warmedHere) await _audio.prepare(format: AgentAudioFormat.alaw8);
      try {
        // No play-back: the agent was asked to speak, not to listen to themselves.
        final r = await _audio.loopbackTest(playBack: false);
        return SoundCheckSample(
          ran: true,
          heardBack: r.voiceDetected,
          quiet: r.voiceDetected && r.speechLevelDbfs < quietSpeechDbfs,
        );
      } finally {
        // Leave the engine as found: the station prepares it again when it opens.
        if (warmedHere) await _audio.release();
      }
    } on Object catch (e) {
      _log.warn('Sound check could not run', {'error': '$e'});
      return const SoundCheckSample(ran: false);
    }
  }

  @override
  Future<AudioRouteSample> audioRoute() async {
    try {
      final r = await _audio.currentRoute();
      if (r == null) return const AudioRouteSample(kind: RouteKind.earpiece, name: 'Phone');
      final kind = switch (r.kind) {
        AudioRouteKind.earpiece => RouteKind.earpiece,
        AudioRouteKind.speaker => RouteKind.speaker,
        AudioRouteKind.wired => RouteKind.wired,
        AudioRouteKind.bluetooth => RouteKind.bluetooth,
      };
      final name = r.name.isNotEmpty
          ? r.name
          : switch (kind) {
              RouteKind.speaker => 'Speaker',
              RouteKind.wired => 'Headset',
              RouteKind.bluetooth => 'Bluetooth headset',
              RouteKind.earpiece => 'Phone',
            };
      return AudioRouteSample(kind: kind, name: name);
    } on Object catch (e) {
      _log.warn('Audio route unknown', {'error': '$e'});
      return const AudioRouteSample(kind: RouteKind.earpiece, name: 'Phone');
    }
  }

  @override
  Future<NetworkSample> network() async {
    List<ConnectivityResult> links;
    try {
      links = await _connectivity.checkConnectivity();
    } on Object {
      links = const [];
    }
    if (links.isNotEmpty && links.every((l) => l == ConnectivityResult.none)) {
      return const NetworkSample(online: false);
    }
    final transport = links.contains(ConnectivityResult.wifi)
        ? 'Wi-Fi'
        : links.contains(ConnectivityResult.ethernet)
            ? 'Ethernet'
            : links.contains(ConnectivityResult.mobile)
                ? 'Mobile data'
                : null;

    // Round trip: the public client config, the cheapest read the server has. Any HTTP
    // answer proves the server is reachable; only a transport failure means offline.
    final rtt = Stopwatch()..start();
    try {
      await _api.getPublic('/client-config', timeout: const Duration(seconds: 5));
    } on ApiNetworkError {
      return NetworkSample(online: false, transport: transport);
    } on ApiError {
      // Reachable.
    }
    final latencyMs = (rtt..stop()).elapsedMilliseconds;

    return NetworkSample(
      online: true,
      transport: transport,
      latencyMs: latencyMs,
      uploadKbps: await _uploadKbps(latencyMs),
    );
  }

  /// Times an upload to the API's probe. Null when it could not be measured (an older
  /// server without the probe, a refusal, a timeout): the grade then says "may stutter"
  /// rather than inventing a number.
  Future<double?> _uploadKbps(int latencyMs) async {
    final body = Uint8List(probeBytes);
    final sw = Stopwatch()..start();
    try {
      await _api.post('/client-config/uplink-probe', body: body, scoped: false, timeout: const Duration(seconds: 8));
    } on Object catch (e) {
      _log.info('Upload probe not measured', {'error': '$e'});
      return null;
    }
    // The round trip is not upload time; take it off, so a fast uplink behind a slow
    // ping is not under-reported.
    final ms = (sw.elapsedMilliseconds - latencyMs).clamp(1, 1 << 30);
    return probeBytes * 8 / ms; // bits per millisecond = kbps
  }

  @override
  Future<BatterySample> battery() async {
    final level = await _battery.batteryLevel;
    final state = await _battery.batteryState;
    return BatterySample(
      level: level.clamp(0, 100),
      charging: state == BatteryState.charging || state == BatteryState.full,
    );
  }

  @override
  Future<BatteryOptimisationSample> batteryOptimisation() async {
    if (!_isAndroid) return const BatteryOptimisationSample(applies: false);
    try {
      return BatteryOptimisationSample(applies: true, exempt: await _audio.isIgnoringBatteryOptimizations());
    } on Object {
      return const BatteryOptimisationSample(applies: false);
    }
  }

  @override
  Future<void> openAppSettings() async {
    await ph.openAppSettings();
  }

  @override
  Future<void> requestBatteryExemption() async {
    await _audio.requestIgnoreBatteryOptimizations();
  }
}
