import 'dart:async';

import 'package:agency_wire/agency_wire.dart' show FeatureFlags;
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:permission_handler/permission_handler.dart' as ph;

import '../../core/auth/app_gate.dart';
import '../../core/flags/feature_flags.dart';
import '../../core/session/session_store.dart';

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

/// Whether the station offers Need help on a call and in wrap-up (floor assist, LF4): the
/// client-exposed flag [FeatureFlags.floorAssistEnabled] (LF11). Off while the flag map loads or
/// failed, so the control never flickers on. A supervisor's message is shown whatever it says: the
/// server sends one only while it is on.
final stationNeedHelpProvider = Provider<bool>(
  (ref) => ref.watch(featureFlagProvider(FeatureFlags.floorAssistEnabled)),
);

/// Whose one-time listening notice it is: the signed-in agent and their account
/// ([agentWorkspaceProvider], `user:tenant:account`), or null with nobody signed in to one. Per
/// account, because the flag is: an agent told in one account is told again in another that turns
/// listening on. A provider so widget tests need no sign-in.
final listenNoticeScopeProvider = Provider<String?>((ref) => ref.watch(agentWorkspaceProvider));

/// Whether the station and the soft phone show the one-time notice that a supervisor may listen
/// (docs/listening.md LS2): listening is on, an agent is signed in to an account, and they have not
/// tapped Got it for it on this phone. Off until the stored answer is read, so it never flashes up
/// for an agent who already dismissed it. Kept in [keyValueStoreProvider]; a value that did not
/// save shows it again next time, which errs the right way.
final listenFirstNoticeProvider = NotifierProvider<ListenFirstNoticeNotifier, bool>(ListenFirstNoticeNotifier.new);

class ListenFirstNoticeNotifier extends Notifier<bool> {
  static const keyPrefix = 'listen.agent_notice_seen';

  String? _scope;

  @override
  bool build() {
    final on = ref.watch(stationListenNoticeProvider);
    final scope = ref.watch(listenNoticeScopeProvider);
    _scope = on ? scope : null;
    if (_scope == null) return false;
    unawaited(_load(_scope!));
    return false;
  }

  KeyValueStore get _kv => ref.read(keyValueStoreProvider);

  Future<void> _load(String scope) async {
    final seen = await _kv.getBool('$keyPrefix:$scope');
    if (!ref.mounted || _scope != scope) return;
    state = seen != true;
  }

  /// Got it: gone now, and not shown again for this agent and account on this phone.
  Future<void> dismiss() async {
    final scope = _scope;
    state = false;
    if (scope != null) await _kv.setBool('$keyPrefix:$scope', true);
  }
}

/// The signed-in agent's name, for the station's top bar and "Namaste, Sunita" (the app gate's
/// [GateReady.displayName]); null before the gate is ready. A provider so widget tests need no
/// sign-in.
final stationAgentNameProvider = Provider<String?>((ref) {
  final gate = ref.watch(appGateProvider);
  if (gate is! GateReady) return null;
  final name = gate.displayName.trim();
  return name.isEmpty ? null : name;
});

/// How the agent chose to work on Start of day (design-spec §3, "How will you work?").
enum WorkMode {
  /// Calls come to me: the station goes ready.
  callsComeToMe,

  /// I dial the number: the station switches to the soft phone (SP7).
  iDial,
}

/// "Start work", pressed on Start of day before the station existed: the join runs first, and once
/// the station's socket is open it goes on in [WorkMode] by itself, so the agent presses once
/// (design-spec §2: Start work → Ready). Spent on the first open of that campaign's station,
/// whatever the agent's state is then: a station rejoined on a break or mid-call is left as it is.
final startWorkIntentProvider = NotifierProvider<StartWorkIntent, ({String campaignId, WorkMode mode})?>(StartWorkIntent.new);

class StartWorkIntent extends Notifier<({String campaignId, WorkMode mode})?> {
  @override
  ({String campaignId, WorkMode mode})? build() => null;

  void set(String campaignId, WorkMode mode) => state = (campaignId: campaignId, mode: mode);

  /// The intent for [campaignId], once; null when there is none for it.
  WorkMode? take(String campaignId) {
    final s = state;
    if (s == null || s.campaignId != campaignId) return null;
    state = null;
    return s.mode;
  }
}
