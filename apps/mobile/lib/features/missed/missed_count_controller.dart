import 'dart:async';

import 'package:agency_wire/agency_wire.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/misc.dart' show Override;

import '../../core/api/api_error.dart';
import '../../core/auth/app_gate.dart';
import '../../core/flags/feature_flags.dart';
import '../../core/lifecycle/app_lifecycle.dart';
import '../../core/station/station_signals.dart';
import '../../core/telemetry/log.dart';
import 'missed_access.dart';
import 'missed_calls_api.dart';

/// Inbound calls' flag (`packages/contracts/src/flags.ts`, client-exposed).
/// The app reads it for the Missed list's notice and visibility only.
const inboundFlagKey = 'agency_inbound_enabled';

/// How long a count read on return to the app is good for (the soft phone's
/// bootstrap rule, M3): coming back within it reads nothing.
const missedCountRereadAfter = Duration(minutes: 5);

/// The console's poll of the count (`useMissedCallsCount`), while inbound is
/// on and the app is in the foreground.
const missedCountPollEvery = Duration(seconds: 60);

/// How old the list and the count may be when the Missed segment comes on
/// screen before they are read again.
const missedRereadOnEntryAfter = Duration(minutes: 1);

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
/// shell watches the access, so this is built once the agent is in); every
/// [missedCountPollEvery] while inbound is on and the app is in the foreground
/// (the console's poll; never in the background); on return to the app when
/// the last answer is older than the poll (else [missedCountRereadAfter] with
/// inbound off), or at once after a failed read; when a call settles on this
/// phone ([missedCallsSettledProvider]: a call back may have reached the
/// customer, or an inbound call been put through, and the server closes their
/// rows); when the Missed segment comes on screen with an answer older than
/// [missedRereadOnEntryAfter]; and forced after a Mark handled, a Reopen or a
/// pull to refresh of the list.
class MissedCountController extends Notifier<MissedCountState> {
  static final _log = Log('missed');

  int _epoch = 0;
  String? _workspace;
  DateTime? _answeredAt;
  bool _failed = false;
  Future<void>? _inFlight;
  bool _foreground = true;
  Timer? _poll;

  DateTime _now() => ref.read(missedClockProvider)();

  @override
  MissedCountState build() {
    _workspace = ref.watch(agentWorkspaceProvider);
    final epoch = ++_epoch;
    _answeredAt = null;
    _failed = false;
    _inFlight = null;
    _poll?.cancel();
    _poll = null;
    final lifecycle = ref.read(missedLifecycleSourceProvider);
    _foreground = lifecycle.isForeground;
    lifecycle.attach(onHide: _onHide, onShow: _onShow);
    ref.onDispose(() {
      lifecycle.detach();
      _poll?.cancel();
      _poll = null;
    });
    ref.listen<bool>(featureFlagProvider(inboundFlagKey), (_, _) => _schedulePoll());
    ref.listen<int>(missedCallsSettledProvider, (_, _) {
      if (state.reach == MissedReach.ok) unawaited(refresh());
    });
    if (_workspace != null) {
      unawaited(Future.microtask(() {
        if (epoch == _epoch && ref.mounted) unawaited(refresh());
      }));
    }
    return const MissedCountState();
  }

  /// The console polls while inbound is on; the app also only in the
  /// foreground, and not once the count has said the list is not this agent's.
  bool get _polls =>
      _foreground &&
      _workspace != null &&
      state.reach != MissedReach.forbidden &&
      ref.read(missedCountPollProvider) != null &&
      ref.read(featureFlagProvider(inboundFlagKey));

  void _schedulePoll() {
    _poll?.cancel();
    _poll = null;
    final every = ref.read(missedCountPollProvider);
    if (!ref.mounted || every == null || !_polls) return;
    final epoch = _epoch;
    _poll = Timer(every, () {
      _poll = null;
      if (ref.mounted && epoch == _epoch) unawaited(refresh());
    });
  }

  void _onHide() {
    _foreground = false;
    _poll?.cancel();
    _poll = null;
  }

  void _onShow() {
    _foreground = true;
    if (_workspace == null) return;
    final every = ref.read(missedCountPollProvider);
    unawaited(refreshIfOlderThan(_polls && every != null ? every : missedCountRereadAfter)
        .whenComplete(() {
      if (ref.mounted && _poll == null) _schedulePoll();
    }));
  }

  /// Reads the count when the last answer is [age] old or more, or the last
  /// read failed.
  Future<void> refreshIfOlderThan(Duration age) {
    final at = _answeredAt;
    if (!_failed && at != null && _now().difference(at) < age) return Future.value();
    return refresh();
  }

  /// Reads the count now. One read at a time: a second ask while one is in
  /// flight shares it. A read from an earlier workspace never lets go of
  /// this one's.
  Future<void> refresh() {
    if (_workspace == null) return Future.value();
    final inFlight = _inFlight;
    if (inFlight != null) return inFlight;
    final epoch = _epoch;
    final read = _read().whenComplete(() {
      if (epoch != _epoch) return;
      _inFlight = null;
      if (ref.mounted) _schedulePoll();
    });
    return _inFlight = read;
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

/// How often the count is polled ([missedCountPollEvery]); null polls never
/// (screen tests that are not about the poll leave no timer behind).
final missedCountPollProvider = Provider<Duration?>((ref) => missedCountPollEvery);

/// Counts the calls that settled on this phone: the hosted session's call
/// going from live (or owing its outcome) to neither, read off the station's
/// signals, the shell's seam. That covers every call the app hosts: a campaign
/// call, an inbound call put through to this agent and a soft-phone call, on
/// either host. A settled call is when the server may have closed Missed rows
/// (a customer reached, `docs/inbound.md` §7), so the count and the list are
/// read again.
class CallsSettled extends Notifier<int> {
  @override
  int build() {
    ref.listen<bool>(stationSignalsProvider.select((s) => s.callActive || s.outcomeOwed), (was, busy) {
      if (was == true && !busy) state++;
    });
    return 0;
  }
}

final missedCallsSettledProvider = NotifierProvider<CallsSettled, int>(CallsSettled.new);

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
