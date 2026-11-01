import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'preflight_copy.dart';

/// The pre-flight checks: what the phone measures ([PreflightChecks], built by
/// the integrator on `agent_audio`, `permission_handler`, `battery_plus`,
/// `connectivity_plus` and a timed upload to the API) and how the screen
/// grades it (the pure functions below).
///
/// The split keeps the policy here, unit-tested without a phone: an
/// implementation reports facts ("41 kbps up"), never verdicts ("too slow").

enum MicPermission { granted, denied, permanentlyDenied, restricted }

@immutable
class SoundCheckSample {
  const SoundCheckSample({required this.ran, this.heardBack = false, this.quiet = false});

  /// False when the loopback could not run (no permission, the mic is busy).
  final bool ran;

  /// The loopback heard the agent's voice back.
  final bool heardBack;

  /// Heard, but barely: a covered mic or a headset mic far from the mouth.
  final bool quiet;
}

enum RouteKind { earpiece, speaker, wired, bluetooth }

@immutable
class AudioRouteSample {
  const AudioRouteSample({required this.kind, required this.name});
  final RouteKind kind;

  /// "Phone", "Speaker", or the headset's name.
  final String name;
}

@immutable
class NetworkSample {
  const NetworkSample({required this.online, this.transport, this.latencyMs, this.uploadKbps});

  final bool online;

  /// "Wi-Fi", "4G", "5G"…, when the OS says.
  final String? transport;

  /// Round trip to the API.
  final int? latencyMs;

  /// Measured by a timed upload to the API: what the uplink of a call needs,
  /// which a ping alone does not show.
  final double? uploadKbps;
}

@immutable
class BatterySample {
  const BatterySample({required this.level, required this.charging});

  /// 0–100.
  final int level;
  final bool charging;
}

@immutable
class BatteryOptimisationSample {
  const BatteryOptimisationSample({required this.applies, this.exempt = true});

  /// False on iOS (no such setting): the row is not shown.
  final bool applies;

  /// The app is excluded from the OEM battery saver.
  final bool exempt;
}

/// What the phone can tell the pre-flight screen. Each call should finish on
/// its own within a few seconds; the screen also times them out.
abstract interface class PreflightChecks {
  Future<MicPermission> microphone();

  /// Asks for the microphone (the system prompt), returning the new state.
  Future<MicPermission> requestMicrophone();

  /// A short loopback: play a tone, record it back.
  Future<SoundCheckSample> soundCheck();
  Future<AudioRouteSample> audioRoute();
  Future<NetworkSample> network();
  Future<BatterySample> battery();
  Future<BatteryOptimisationSample> batteryOptimisation();

  /// Opens this app's page in Settings (a permanently denied microphone).
  Future<void> openAppSettings();

  /// Asks to be excluded from battery optimisation (Android).
  Future<void> requestBatteryExemption();
}

/// Wired by the integrator. Throws until then, so a missing wiring fails loudly.
final preflightChecksProvider = Provider<PreflightChecks>(
  (ref) => throw UnimplementedError('preflightChecksProvider is provided by the app'),
);

// ── Grading ──────────────────────────────────────────────────────────────

enum CheckStatus { pending, ok, warn, fail }

/// What a row can offer to fix itself.
enum CheckFix { none, allowMicrophone, openSettings, allowBackground }

@immutable
class CheckResult {
  const CheckResult({required this.status, required this.title, required this.detail, this.pill, this.fix = CheckFix.none});

  const CheckResult.pending(this.title) : status = CheckStatus.pending, detail = PreflightCopy.checking, pill = null, fix = CheckFix.none;

  final CheckStatus status;
  final String title;
  final String detail;

  /// The word on the right ("OK", "Good", "Check"); defaults by status.
  final String? pill;
  final CheckFix fix;

  @override
  bool operator ==(Object other) =>
      other is CheckResult &&
      other.status == status &&
      other.title == title &&
      other.detail == detail &&
      other.pill == pill &&
      other.fix == fix;
  @override
  int get hashCode => Object.hash(status, title, detail, pill, fix);
}

/// The rows, in screen order.
enum PreflightCheck { microphone, soundCheck, headset, network, battery, batterySaver }

/// Below this the uplink cannot carry G.711 (64 kbps) plus framing, so a
/// call would break up: it blocks going on duty.
const minUploadKbps = 64.0;

/// Below this, or above [slowLatencyMs], calls may stutter: a warning.
const comfortableUploadKbps = 256.0;
const slowLatencyMs = 300;

/// Checks whose failure stops "Go on duty": no microphone, no usable network.
/// Everything else is advice.
const blockingChecks = {PreflightCheck.microphone, PreflightCheck.network};

CheckResult gradeMicrophone(MicPermission p) => switch (p) {
  MicPermission.granted => const CheckResult(status: CheckStatus.ok, title: PreflightCopy.mic, detail: PreflightCopy.micAllowed),
  MicPermission.denied => const CheckResult(
    status: CheckStatus.fail,
    title: PreflightCopy.mic,
    detail: PreflightCopy.micDenied,
    fix: CheckFix.allowMicrophone,
  ),
  MicPermission.permanentlyDenied || MicPermission.restricted => const CheckResult(
    status: CheckStatus.fail,
    title: PreflightCopy.mic,
    detail: PreflightCopy.micBlocked,
    fix: CheckFix.openSettings,
  ),
};

CheckResult gradeSoundCheck(SoundCheckSample s, {required bool micAllowed}) {
  if (!micAllowed) return const CheckResult(status: CheckStatus.warn, title: PreflightCopy.sound, detail: PreflightCopy.soundNeedsMic);
  if (!s.ran) return const CheckResult(status: CheckStatus.warn, title: PreflightCopy.sound, detail: PreflightCopy.soundCouldNotRun);
  if (!s.heardBack) return const CheckResult(status: CheckStatus.warn, title: PreflightCopy.sound, detail: PreflightCopy.soundNotHeard);
  if (s.quiet) return const CheckResult(status: CheckStatus.warn, title: PreflightCopy.sound, detail: PreflightCopy.soundQuiet);
  return const CheckResult(status: CheckStatus.ok, title: PreflightCopy.sound, detail: PreflightCopy.soundOk);
}

CheckResult gradeRoute(AudioRouteSample r) => switch (r.kind) {
  RouteKind.bluetooth => CheckResult(
    status: CheckStatus.ok,
    title: PreflightCopy.headset,
    detail: PreflightCopy.routeDetail(r.name, PreflightCopy.bluetooth),
  ),
  RouteKind.wired => CheckResult(
    status: CheckStatus.ok,
    title: PreflightCopy.headset,
    detail: PreflightCopy.routeDetail(r.name, PreflightCopy.wired),
  ),
  RouteKind.earpiece ||
  RouteKind.speaker => const CheckResult(status: CheckStatus.warn, title: PreflightCopy.headset, detail: PreflightCopy.noHeadset),
};

CheckResult gradeNetwork(NetworkSample n) {
  if (!n.online) return const CheckResult(status: CheckStatus.fail, title: PreflightCopy.network, detail: PreflightCopy.offline);
  final up = n.uploadKbps;
  final rtt = n.latencyMs;
  final parts = [?n.transport, if (rtt != null) '$rtt ms', if (up != null) PreflightCopy.upload(up)];
  final measured = parts.join(' · ');
  if (up != null && up < minUploadKbps) {
    return CheckResult(status: CheckStatus.fail, title: PreflightCopy.network, detail: PreflightCopy.tooSlow(measured));
  }
  if (up == null || (rtt != null && rtt > slowLatencyMs) || up < comfortableUploadKbps) {
    return CheckResult(
      status: CheckStatus.warn,
      title: PreflightCopy.network,
      detail: PreflightCopy.mayStutter(measured),
      pill: PreflightCopy.pillWeak,
    );
  }
  return CheckResult(status: CheckStatus.ok, title: PreflightCopy.network, detail: measured, pill: PreflightCopy.pillGood);
}

CheckResult gradeBattery(BatterySample b) {
  final title = PreflightCopy.batteryTitle(b.level);
  if (b.charging) return CheckResult(status: CheckStatus.ok, title: title, detail: PreflightCopy.charging);
  if (b.level <= 20) return CheckResult(status: CheckStatus.warn, title: title, detail: PreflightCopy.batteryLow);
  if (b.level < 50) return CheckResult(status: CheckStatus.warn, title: title, detail: PreflightCopy.plugIn);
  return CheckResult(status: CheckStatus.ok, title: title, detail: PreflightCopy.batteryFine);
}

/// Null when the setting does not exist on this phone (iOS): no row.
CheckResult? gradeBatteryOptimisation(BatteryOptimisationSample s) {
  if (!s.applies) return null;
  if (s.exempt) return const CheckResult(status: CheckStatus.ok, title: PreflightCopy.batterySaver, detail: PreflightCopy.saverOk);
  return const CheckResult(
    status: CheckStatus.warn,
    title: PreflightCopy.batterySaver,
    detail: PreflightCopy.saverOn,
    fix: CheckFix.allowBackground,
  );
}

/// A check that threw or ran out of time. A blocking check that cannot be
/// measured blocks (we cannot say the agent will be heard); the rest warn.
CheckResult gradeUnavailable(PreflightCheck check) {
  final title = switch (check) {
    PreflightCheck.microphone => PreflightCopy.mic,
    PreflightCheck.soundCheck => PreflightCopy.sound,
    PreflightCheck.headset => PreflightCopy.headset,
    PreflightCheck.network => PreflightCopy.network,
    PreflightCheck.battery => PreflightCopy.battery,
    PreflightCheck.batterySaver => PreflightCopy.batterySaver,
  };
  return switch (check) {
    PreflightCheck.network => const CheckResult(status: CheckStatus.fail, title: PreflightCopy.network, detail: PreflightCopy.unreachable),
    PreflightCheck.microphone => const CheckResult(
      status: CheckStatus.fail,
      title: PreflightCopy.mic,
      detail: PreflightCopy.micUnknown,
      fix: CheckFix.allowMicrophone,
    ),
    _ => CheckResult(status: CheckStatus.warn, title: title, detail: PreflightCopy.couldNotCheck),
  };
}

/// Why "Go on duty" is unavailable, or null when it is available.
///
/// Pending blocking checks hold the button (they take a second or two);
/// warnings never do.
enum DutyBlock { checking, microphone, network }

DutyBlock? dutyBlock(Map<PreflightCheck, CheckResult> results) {
  for (final c in blockingChecks) {
    final r = results[c];
    if (r == null || r.status == CheckStatus.pending) return DutyBlock.checking;
  }
  if (results[PreflightCheck.microphone]!.status == CheckStatus.fail) return DutyBlock.microphone;
  if (results[PreflightCheck.network]!.status == CheckStatus.fail) return DutyBlock.network;
  return null;
}
