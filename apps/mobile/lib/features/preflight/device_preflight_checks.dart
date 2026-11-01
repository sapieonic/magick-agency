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
    this.uploadTimeout = const Duration(seconds: 8),
    Future<bool> Function()? microphoneGranted,
  })  : _connectivity = connectivity ?? Connectivity(),
        _battery = battery ?? Battery(),
        _isAndroid = isAndroid ?? Platform.isAndroid,
        _microphoneGranted = microphoneGranted ?? (() => ph.Permission.microphone.isGranted);

  final AgentAudio _audio;
  final ApiClient _api;
  final Connectivity _connectivity;
  final Battery _battery;
  final bool _isAndroid;
  final Future<bool> Function() _microphoneGranted;

  /// Sound checks in flight ("Check again" can start one before the last ends).
  int _soundChecks = 0;

  /// Pre-flight prepared the engine and nothing has taken it since: the last sound
  /// check out puts it back to idle. Cleared by [handOverAudio], so an engine the
  /// station has prepared (or armed) is never released from here.
  bool _warmedHere = false;

  /// How long the upload probe may take. Not finishing in time is itself a
  /// measurement: fewer than [probeBytes] in this long (see [_uploadKbps]).
  final Duration uploadTimeout;

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
      if (!await _microphoneGranted()) return const SoundCheckSample(ran: false);
      // Only on an engine nobody is using: a station that is already armed or on a
      // call owns the microphone, and the loopback must not touch it.
      final phase = _audio.phase;
      if (phase != AgentAudioPhase.idle && phase != AgentAudioPhase.prepared) return const SoundCheckSample(ran: false);
      _soundChecks++;
      try {
        if (phase == AgentAudioPhase.idle) {
          // Before the await: a hand-over while this prepares must still clear it.
          _warmedHere = true;
          await _audio.prepare(format: AgentAudioFormat.alaw8);
        }
        // No play-back: the agent was asked to speak, not to listen to themselves.
        final r = await _audio.loopbackTest(playBack: false);
        return SoundCheckSample(
          ran: true,
          heardBack: r.voiceDetected,
          quiet: r.voiceDetected && r.speechLevelDbfs < quietSpeechDbfs,
        );
      } finally {
        _soundChecks--;
        await _putBack();
      }
    } on Object catch (e) {
      _log.warn('Sound check could not run', {'error': '$e'});
      return const SoundCheckSample(ran: false);
    }
  }

  /// Leaves the engine as pre-flight found it, when that is still ours to do: the last
  /// sound check is out, pre-flight warmed it, it has not been handed over, and it is
  /// still only prepared. Lifecycle calls run in order, so a release sent after the
  /// station's own `prepare` would leave the station's first call silent.
  Future<void> _putBack() async {
    if (_soundChecks > 0 || !_warmedHere) return;
    _warmedHere = false;
    if (_audio.phase != AgentAudioPhase.prepared) return;
    await _audio.release();
  }

  @override
  void handOverAudio() {
    if (_warmedHere) _log.info('Voice engine handed over during the sound check');
    _warmedHere = false;
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
    // Read twice and time the second: the first also pays for DNS and the TCP and TLS
    // handshakes on an idle connection, which a call's media (one long-lived socket)
    // does not, and would mark good 4G "Weak".
    var latencyMs = 0;
    for (var i = 0; i < 2; i++) {
      final rtt = Stopwatch()..start();
      try {
        await _api.getPublic('/client-config', timeout: const Duration(seconds: 5));
      } on ApiNetworkError {
        return NetworkSample(online: false, transport: transport);
      } on ApiError {
        // Reachable.
      }
      latencyMs = (rtt..stop()).elapsedMilliseconds;
    }

    return NetworkSample(
      online: true,
      transport: transport,
      latencyMs: latencyMs,
      uploadKbps: await _uploadKbps(latencyMs),
    );
  }

  /// Times an upload to the API's probe.
  ///
  /// A probe that runs out of time WAS measured: fewer than [probeBytes] went up in
  /// [uploadTimeout], so the uplink is below that ceiling (32 kbps for 32 KB in 8 s),
  /// and the ceiling is reported, which blocks like any figure under 64 kbps. Null only
  /// when there is no figure at all (an older server without the probe, a refusal, a
  /// dropped connection): the grade then says "may stutter" rather than inventing one.
  Future<double?> _uploadKbps(int latencyMs) async {
    final body = Uint8List(probeBytes);
    final sw = Stopwatch()..start();
    try {
      await _api.post('/client-config/uplink-probe', body: body, scoped: false, timeout: uploadTimeout);
    } on Object catch (e) {
      if (e is ApiNetworkError && e.timedOut) {
        final ceiling = (probeBytes * 8 / uploadTimeout.inMilliseconds).floorToDouble();
        _log.info('Upload probe ran out of time', {'below_kbps': ceiling});
        return ceiling;
      }
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
