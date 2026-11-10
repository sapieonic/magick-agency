import 'dart:async';

import 'package:agency_wire/agency_wire.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/misc.dart' show Override;

import '../../core/api/api_error.dart';
import '../../core/auth/app_gate.dart';
import '../../core/flags/feature_flags.dart';
import '../../core/lifecycle/app_lifecycle.dart';
import '../../core/telemetry/log.dart';
import 'missed_access.dart';
import 'missed_calls_api.dart';

/// Inbound calls' flag (`packages/contracts/src/flags.ts`, client-exposed).
/// The app reads it for the Missed list's notice and visibility only.
const inboundFlagKey = 'agency_inbound_enabled';

/// How long a count read on return to the app is good for (the soft phone's
/// bootstrap rule, M3): coming back within it reads nothing.
const missedCountRereadAfter = Duration(minutes: 5);

/// What `GET /inbound/missed/count` has answered in this workspace.
enum MissedReach {
  /// Not answered yet, or only failed (no network): the list stays hidden.
  unknown,

  /// 200: the agent holds `agency.inbound.read`.
  ok,

  /// 403 (no `agency.inbound.read`), or 404 (a server without the route):
  /// hidden. The app keeps no role matrix of its own.
  forbidden,
}

@immutable
class MissedCountState {
  const MissedCountState({this.reach = MissedReach.unknown, this.count});

  final MissedReach reach;

  /// The last answer; kept through a failed read (a badge that vanished on a
  /// blip would say nothing true, the console's rule).
  final InboundMissedCountResponse? count;

  @override
  bool operator ==(Object other) => other is MissedCountState && other.reach == reach && other.count == count;

  @override
  int get hashCode => Object.hash(reach, count);
}

/// The Missed list's count, per workspace. Read when a workspace starts (the
/// shell watches the access, so this is built once the agent is in), on return
/// to the app at most every [missedCountRereadAfter] (or at once after a
/// failed read), and forced after a Mark handled, a Reopen or a pull to
/// refresh of the list. The console polls every minute while inbound is on;
/// the app reads on these events only (a follow-up list, not a live queue).
class MissedCountController extends Notifier<MissedCountState> {
  static final _log = Log('missed');

  int _epoch = 0;
  String? _workspace;
  DateTime? _answeredAt;
  bool _failed = false;
  Future<void>? _inFlight;

  DateTime _now() => ref.read(missedClockProvider)();

  @override
  MissedCountState build() {
    _workspace = ref.watch(agentWorkspaceProvider);
    final epoch = ++_epoch;
    _answeredAt = null;
    _failed = false;
    _inFlight = null;
    final lifecycle = ref.read(missedLifecycleSourceProvider);
    lifecycle.attach(onHide: () {}, onShow: _onShow);
    ref.onDispose(lifecycle.detach);
    if (_workspace != null) {
      unawaited(Future.microtask(() {
        if (epoch == _epoch && ref.mounted) unawaited(refresh());
      }));
    }
    return const MissedCountState();
  }

  void _onShow() {
    if (_workspace == null) return;
    final at = _answeredAt;
    if (!_failed && at != null && _now().difference(at) < missedCountRereadAfter) return;
    unawaited(refresh());
  }

  /// Reads the count now. One read at a time: a second ask while one is in
  /// flight shares it.
  Future<void> refresh() {
    if (_workspace == null) return Future.value();
    return _inFlight ??= _read().whenComplete(() => _inFlight = null);
  }

  Future<void> _read() async {
    final epoch = _epoch;
    try {
      final count = await ref.read(missedCallsApiProvider).count();
      if (!ref.mounted || epoch != _epoch) return;
      _answeredAt = _now();
      _failed = false;
      state = MissedCountState(reach: MissedReach.ok, count: count);
    } on Exception catch (e) {
      if (!ref.mounted || epoch != _epoch) return;
      reportToGate(ref, e);
      if (e is ApiHttpError && (e.status == 403 || e.status == 404)) {
        _answeredAt = _now();
        _failed = false;
        state = const MissedCountState(reach: MissedReach.forbidden);
        return;
      }
      _failed = true;
      if (e is! ApiNetworkError) _log.warn('Reading the missed calls count failed', {'error': e.toString()});
    }
  }
}

final missedCountControllerProvider =
    NotifierProvider<MissedCountController, MissedCountState>(MissedCountController.new);

/// Its own app-lifecycle source: one source keeps one listener.
final missedLifecycleSourceProvider = Provider<AppLifecycleSource>((ref) => FlutterAppLifecycleSource());

/// The clock the return-to-app rule reads; tests pin it.
final missedClockProvider = Provider<DateTime Function()>((ref) => DateTime.now);

/// The access as the count and the flag decide it (the console's
/// `useMissedCallsAccess`): the count answered (the permission), and either
/// inbound is on or the agent has rows to read (the kill switch leaves the
/// follow-ups of calls that came in before it to be worked).
MissedCallsAccess missedAccessOf(MissedCountState count, {required bool inboundOn}) {
  if (count.reach != MissedReach.ok) return MissedCallsAccess(inboundOn: inboundOn);
  final answer = count.count;
  final visible = inboundOn || (answer?.hasRows ?? false);
  return MissedCallsAccess(visible: visible, inboundOn: inboundOn, badge: visible ? (answer?.badge ?? '') : '');
}

/// What `main.dart` adds to its `ProviderScope` overrides to plug the count
/// into the seam the shell and My calls read.
final List<Override> missedCallsOverrides = [
  missedCallsAccessProvider.overrideWith(
    (ref) => missedAccessOf(
      ref.watch(missedCountControllerProvider),
      inboundOn: ref.watch(featureFlagProvider(inboundFlagKey)),
    ),
  ),
];
