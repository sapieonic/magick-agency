import 'dart:async';

import 'package:agency_wire/agency_wire.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/providers.dart';
import '../api/api_error.dart';
import '../auth/app_gate.dart';
import '../lifecycle/app_lifecycle.dart';
import '../station/station_device.dart';
import '../telemetry/log.dart';
import 'push_device_api.dart';
import 'ring_channel.dart';
import 'ring_copy.dart';
import 'ring_rules.dart';
import 'ring_telemetry.dart';

/// The settings card's test ring, as it goes.
enum TestRingPhase {
  idle,
  sending,
  waiting,
  received,

  /// The test ring reached the phone, but its call could not be shown (notifications off).
  notShown,
  timedOut,
  tooSoon,
  failed,
}

/// This phone's push device and what lets it ring (Mode B), as [RingRegistration] knows them.
@immutable
final class RingSettings {
  const RingSettings({
    this.supported = true,
    this.status,
    this.token,
    this.checklist,
    this.loading = false,
    this.loadFailed = false,
    this.saving = false,
    this.error,
    this.testRing = TestRingPhase.idle,
  });

  /// The platform rings (Android; iOS is contract-only for now, IQ64).
  final bool supported;

  /// The server's answer to the last register, read or opt-in change; null before the first.
  final PushDeviceStatus? status;

  /// The push token native gave; null when push is unavailable on this phone.
  final String? token;
  final RingChecklist? checklist;
  final bool loading;

  /// The last load failed and nothing is known yet.
  final bool loadFailed;

  /// An opt-in change is on its way.
  final bool saving;

  /// Why the last opt-in change failed, in the agent's words.
  final String? error;
  final TestRingPhase testRing;

  /// The agent opted in on this phone.
  bool get optIn => status?.device?.ringEnabled ?? false;

  /// Leaving the app asks `away_ring` ([ringAvailable]).
  bool get ringOn => supported && ringAvailable(status: status, optIn: optIn, token: token, checklist: checklist);

  /// The Me card shows only when the account allows ringing.
  bool get showCard => supported && (status?.accountAllowsRing ?? false);

  RingSettings copyWith({
    PushDeviceStatus? status,
    String? token,
    bool clearToken = false,
    RingChecklist? checklist,
    bool? loading,
    bool? loadFailed,
    bool? saving,
    String? error,
    bool clearError = false,
    TestRingPhase? testRing,
  }) =>
      RingSettings(
        supported: supported,
        status: status ?? this.status,
        token: clearToken ? null : (token ?? this.token),
        checklist: checklist ?? this.checklist,
        loading: loading ?? this.loading,
        loadFailed: loadFailed ?? this.loadFailed,
        saving: saving ?? this.saving,
        error: clearError ? null : (error ?? this.error),
        testRing: testRing ?? this.testRing,
      );

  @override
  bool operator ==(Object other) =>
      other is RingSettings &&
      other.supported == supported &&
      other.status == status &&
      other.token == token &&
      other.checklist == checklist &&
      other.loading == loading &&
      other.loadFailed == loadFailed &&
      other.saving == saving &&
      other.error == error &&
      other.testRing == testRing;

  @override
  int get hashCode => Object.hash(supported, status, token, checklist, loading, loadFailed, saving, error, testRing);
}

/// The platform this phone registers as, or null where ringing is not built (iOS today, IQ64).
final ringPlatformProvider = Provider<PushPlatform?>(
  (ref) => !kIsWeb && defaultTargetPlatform == TargetPlatform.android ? PushPlatform.android : null,
);

/// The registration's own lifecycle source: one source keeps one listener, so it never shares
/// the station's.
final ringLifecycleSourceProvider = Provider<AppLifecycleSource>((ref) => FlutterAppLifecycleSource());

/// Registers this phone's push device (Mode B): `PUT /push-devices/:deviceId` once the gate is
/// ready, on a new token (`token`) and on every return to the app (the checklist is read again
/// then too: the agent may have just fixed something in the system settings). The device id is
/// the station device id (OS3). Opt-in is the agent's (`PATCH`, the Me card only: the away
/// notification's "Stop ringing" is for one absence, the station's); the test ring is the card's. Signing out removes the device
/// (`DELETE`, [unregister], run by the gate while the sign-in still works).
class RingRegistration extends Notifier<RingSettings> {
  static final _log = Log('ring.registration');

  /// How long the card waits for the test ring to reach the phone.
  static const testRingTimeout = Duration(seconds: 30);

  late RingChannel _channel;
  late PushDeviceApi _api;
  PushPlatform? _platform;
  int _gen = 0;
  bool _ready = false;
  Timer? _testTimer;

  @override
  RingSettings build() {
    _platform = ref.read(ringPlatformProvider);
    if (_platform == null) return const RingSettings(supported: false);
    _channel = ref.read(ringChannelProvider);
    _api = PushDeviceApi(
      ref.read(apiClientProvider),
      onUnauthorized: (e) => ref.read(appGateProvider.notifier).reportError(e),
    );
    final events = _channel.events.listen(_onEvent);
    final lifecycle = ref.read(ringLifecycleSourceProvider);
    lifecycle.attach(onHide: () {}, onShow: () {
      if (_ready) unawaited(register());
    });
    ref.onDispose(() {
      unawaited(events.cancel());
      lifecycle.detach();
      _testTimer?.cancel();
    });
    ref.listen<AppGate>(appGateProvider, (prev, next) => _gateChanged(prev, next), fireImmediately: true);
    return const RingSettings();
  }

  void _gateChanged(AppGate? prev, AppGate next) {
    final wasReady = _ready;
    _ready = next is GateReady;
    if (!_ready) {
      _gen++;
      if (wasReady) {
        scheduleMicrotask(() {
          if (ref.mounted && !_ready) state = const RingSettings();
        });
      }
      return;
    }
    final changed = prev is! GateReady ||
        prev.userId != (next as GateReady).userId ||
        prev.accountId != next.accountId;
    if (!wasReady || changed) scheduleMicrotask(() => unawaited(register()));
  }

  void _onEvent(RingEvent event) {
    switch (event) {
      case RingTokenChanged():
        if (_ready) unawaited(register());
      case RingTestReceived(:final shown):
        if (state.testRing == TestRingPhase.waiting || state.testRing == TestRingPhase.sending) {
          _testTimer?.cancel();
          state = state.copyWith(testRing: shown ? TestRingPhase.received : TestRingPhase.notShown);
        }
      case RingAnswered() || RingEnded():
        break;
    }
  }

  String get _appBuild {
    final identity = ref.read(clientIdentityProvider);
    return '${identity.version}+${identity.build}';
  }

  Future<String> _deviceId() => ref.read(stationDeviceIdsProvider).id();

  /// Registers (or refreshes) this device and reads the checklist. Without a token (push
  /// unavailable) only reads the status, so the card can say why.
  Future<void> register() async {
    final platform = _platform;
    if (platform == null || !_ready) return;
    final gen = ++_gen;
    state = state.copyWith(loading: true);
    final deviceId = await _deviceId();
    final token = await _channel.getToken();
    final checklist = await _channel.checklist();
    if (gen != _gen || !ref.mounted) return;
    PushDeviceStatus status;
    try {
      status = token == null
          ? await _api.status(deviceId)
          : await _api.register(deviceId, PushDevicePutRequest(platform: platform, fcmToken: token, appBuild: _appBuild));
    } catch (e) {
      if (gen != _gen || !ref.mounted) return;
      _log.warn('push device register failed', {'error': e.runtimeType.toString(), 'has_token': token != null});
      state = state.copyWith(
        token: token,
        clearToken: token == null,
        checklist: checklist,
        loading: false,
        loadFailed: state.status == null,
      );
      return;
    }
    if (gen != _gen || !ref.mounted) return;
    state = state.copyWith(
      status: status,
      token: token,
      clearToken: token == null,
      checklist: checklist,
      loading: false,
      loadFailed: false,
    );
  }

  /// Opt in or out on this phone. A device the server has never seen is registered with the
  /// choice (it needs a token to be registered at all).
  Future<void> setOptIn(bool on, {String source = 'settings'}) async {
    final platform = _platform;
    if (platform == null || state.saving) return;
    final device = state.status?.device;
    if (!on && (device == null || !device.ringEnabled)) return;
    state = state.copyWith(saving: true, clearError: true);
    try {
      final deviceId = await _deviceId();
      final token = state.token;
      final PushDeviceStatus status;
      if (device == null || device.revokedAt != null) {
        if (token == null) throw StateError('no push token');
        status = await _api.register(
          deviceId,
          PushDevicePutRequest(platform: platform, fcmToken: token, appBuild: _appBuild, ringEnabled: on),
        );
      } else {
        status = await _api.setRingEnabled(deviceId, on);
      }
      if (!ref.mounted) return;
      state = state.copyWith(status: status, saving: false);
      RingTelemetry.optInChanged(on: on, source: source);
    } catch (e) {
      _log.warn('ring opt-in change failed', {'on': on, 'error': e.runtimeType.toString()});
      if (ref.mounted) state = state.copyWith(saving: false, error: RingCopy.optInFailed);
    }
  }

  /// The checklist again (after the agent fixed something in the system settings).
  Future<void> refreshChecklist() async {
    if (_platform == null) return;
    final checklist = await _channel.checklist();
    if (ref.mounted && checklist != null) state = state.copyWith(checklist: checklist);
  }

  Future<void> openSettings(RingChecklistItem item) => _channel.openSettings(item);

  /// "Send a test ring": the server sends a `test_ring` push; success is native's
  /// `testRingReceived` within [testRingTimeout].
  Future<void> sendTestRing() async {
    if (_platform == null) return;
    final phase = state.testRing;
    if (phase == TestRingPhase.sending || phase == TestRingPhase.waiting) return;
    _testTimer?.cancel();
    state = state.copyWith(testRing: TestRingPhase.sending);
    try {
      await _api.testRing(await _deviceId());
    } catch (e) {
      if (!ref.mounted || state.testRing != TestRingPhase.sending) return;
      final tooSoon = e is ApiHttpError && e.status == 429;
      _log.warn('test ring failed', {'error': e.runtimeType.toString(), 'too_soon': tooSoon});
      state = state.copyWith(testRing: tooSoon ? TestRingPhase.tooSoon : TestRingPhase.failed);
      return;
    }
    if (!ref.mounted || state.testRing != TestRingPhase.sending) return;
    state = state.copyWith(testRing: TestRingPhase.waiting);
    _testTimer = Timer(testRingTimeout, () {
      if (ref.mounted && state.testRing == TestRingPhase.waiting) state = state.copyWith(testRing: TestRingPhase.timedOut);
    });
  }

  /// The device's status read again (the station's "why it stopped ringing", on return).
  Future<PushDeviceStatus?> readStatus() async {
    if (_platform == null || !_ready) return null;
    try {
      final status = await _api.status(await _deviceId());
      if (ref.mounted) state = state.copyWith(status: status);
      return status;
    } catch (e) {
      _log.warn('push device read failed', {'error': e.runtimeType.toString()});
      return null;
    }
  }

  /// Signing out: this phone is no longer this agent's to ring. Best effort, bounded, never
  /// throws; the gate runs it while the sign-in still works.
  Future<void> unregister() async {
    if (_platform == null || !_ready) return;
    _gen++;
    try {
      await _api.remove(await _deviceId());
    } catch (e) {
      _log.warn('push device remove failed', {'error': e.runtimeType.toString()});
    }
  }
}

final ringRegistrationProvider = NotifierProvider<RingRegistration, RingSettings>(RingRegistration.new);
